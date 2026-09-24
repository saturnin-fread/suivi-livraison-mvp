require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { Pool } = require('pg');
const { createRoutingAdapter, RoutingInputError } = require('./lib/routing');
const { calculateCrmMetrics } = require('./lib/crm-metrics');
const {
  applyCrmSchema,
  ensureOrderCrmSnapshot,
  synchronizeExistingOrders,
  withCompanyTransaction,
} = require('./lib/crm-repository');
const {
  createIpPolicy,
  createRateLimitMiddleware,
  createTokenBucket,
  createTokenPolicy,
} = require('./lib/rate-limit');
const { createRedisTokenBucket } = require('./lib/redis-rate-limit');
const {
  createExportContract,
  ExportContractError,
  DATASETS: EXPORT_DATASETS,
  OPERATIONAL_LIMITS: EXPORT_LIMITS,
} = require('./lib/crm-export-contract');
const { buildWorkbook: buildExportWorkbook } = require('./lib/crm-xlsx');
const {
  buildOperationsExportQuery,
  normalizeExportRow,
  OPERATIONS_NUMERIC_COLUMNS,
} = require('./lib/crm-operations-export');
const {
  TrackingLinkPolicyError,
  createTrackingLinkExpiration,
  evaluateTrackingLink,
  planTrackingLinkRevocation,
  planTrackingLinkRotation,
  publicTrackingLinkMessage,
} = require('./lib/tracking-link-policy');

const app = express();
const port = Number(process.env.PORT || 3000);
const demoTrackingEnabled = process.env.DEMO_TRACKING_ENABLED === 'true';
if (demoTrackingEnabled && (!process.env.DEMO_TRACKING_TOKEN || process.env.RAILWAY_ENVIRONMENT_NAME === 'production')) {
  throw new Error('DEMO_TRACKING_ENABLED est interdit en production et exige un jeton explicite ailleurs.');
}
const demoToken = demoTrackingEnabled ? process.env.DEMO_TRACKING_TOKEN : null;
const sessionDurationMs = 8 * 60 * 60 * 1000;
const editableRequestStatuses = ['À vérifier', 'Informations à compléter'];
const terminalOrderStatuses = ['Livrée', 'Retournée', 'Annulée'];
const publicTrackingPositionStatuses = ['En tournée', 'En livraison', 'Arrivée'];
const orderTransitions = {
  'En préparation': ['Confirmée', 'Annulée'],
  'Confirmée': ['Récupérée', 'Annulée'],
  'Récupérée': ['En tournée', 'Retour'],
  'En tournée': ['En livraison', 'Échec', 'Retour'],
  'En livraison': ['Arrivée', 'Échec', 'Retour'],
  'Arrivée': ['Échec', 'Retour'],
  'Échec': ['En livraison', 'Retour'],
  'Retour': ['Retournée'],
  'Livrée': [],
  'Retournée': [],
  'Annulée': [],
};
const reasonRequiredStatuses = ['Échec', 'Retour', 'Retournée', 'Annulée'];
const incidentCategories = ['client_injoignable', 'adresse', 'colis', 'paiement', 'vehicule', 'gps', 'autre'];
const paymentMethods = ['cash', 'mobile_money', 'card', 'bank_transfer', 'other'];
const paymentAdjustmentTypes = ['refund', 'additional_collection'];
const invitationRoles = ['manager', 'operator', 'driver'];
const driverVehicleTypes = ['Moto', 'Tricycle', 'Voiture', 'Vélo', 'Camionnette'];
const driverTransitionTargets = ['Récupérée', 'En tournée', 'En livraison', 'Arrivée', 'Échec', 'Retour'];
const evidenceTypes = ['photo', 'signature'];
const evidenceModes = ['off', 'optional', 'required'];
const runStatuses = ['draft', 'planned', 'active', 'completed', 'cancelled'];
const runTransitions = {
  draft: ['planned', 'cancelled'],
  planned: ['draft', 'active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1200 * 1024, files: 1, fields: 4 } });
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    })
  : null;
if (pool) pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error.message));

const traccarFleetCache = { value: null, expiresAt: 0, pending: null };

function routingEnvironmentInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new RoutingInputError('invalid_environment_option', { name });
  return parsed;
}

function buildRoutingAdapter() {
  try {
    return createRoutingAdapter({
      provider: process.env.ROUTING_PROVIDER || 'disabled',
      baseUrl: process.env.ROUTING_OSRM_URL,
      profiles: { motorcycle: process.env.ROUTING_OSRM_PROFILE || 'driving' },
      defaultProfile: 'motorcycle',
      timeoutMs: routingEnvironmentInteger('ROUTING_TIMEOUT_MS', 5000),
      cacheTtlMs: routingEnvironmentInteger('ROUTING_CACHE_TTL_MS', 300000),
      maxRouteCoordinates: routingEnvironmentInteger('ROUTING_MAX_ROUTE_COORDINATES', 50),
      maxMatrixCoordinates: routingEnvironmentInteger('ROUTING_MAX_MATRIX_COORDINATES', 25),
      maxMatchCoordinates: routingEnvironmentInteger('ROUTING_MAX_MATCH_COORDINATES', 100),
      mapDataVersion: process.env.ROUTING_MAP_DATA_VERSION,
      providerVersion: process.env.ROUTING_PROVIDER_VERSION,
    });
  } catch (error) {
    console.error('[routing] configuration disabled:', error instanceof RoutingInputError ? error.code : 'invalid_configuration');
    return createRoutingAdapter({ provider: 'disabled', profiles: { motorcycle: 'driving' }, defaultProfile: 'motorcycle' });
  }
}

const routingAdapter = buildRoutingAdapter();

function traccarConfigured() {
  return Boolean(process.env.TRACCAR_URL && process.env.TRACCAR_USER && process.env.TRACCAR_PASSWORD);
}

async function loadTraccarFleetSnapshot() {
  if (!traccarConfigured()) {
    return { status: 'not_configured', devices: [], positions: [], message: 'Le service GPS n’est pas configuré.' };
  }
  if (traccarFleetCache.value && Date.now() < traccarFleetCache.expiresAt) return traccarFleetCache.value;
  if (traccarFleetCache.pending) return traccarFleetCache.pending;
  traccarFleetCache.pending = (async () => {
    try {
      const auth = { username: process.env.TRACCAR_USER, password: process.env.TRACCAR_PASSWORD };
      const [devicesResponse, positionsResponse] = await Promise.all([
        axios.get(`${process.env.TRACCAR_URL}/api/devices`, { auth, timeout: 10000 }),
        axios.get(`${process.env.TRACCAR_URL}/api/positions`, { auth, timeout: 10000 }),
      ]);
      const value = {
        status: 'online',
        devices: Array.isArray(devicesResponse.data) ? devicesResponse.data : [],
        positions: Array.isArray(positionsResponse.data) ? positionsResponse.data : [],
        message: 'Positions GPS chargées.',
      };
      traccarFleetCache.value = value;
      traccarFleetCache.expiresAt = Date.now() + 5000;
      return value;
    } catch (error) {
      console.error('Traccar fleet snapshot error:', error.response?.status || error.message);
      const value = {
        status: 'unavailable', devices: [], positions: [],
        message: 'Les opérations restent visibles, mais les positions GPS sont temporairement indisponibles.',
      };
      traccarFleetCache.value = value;
      traccarFleetCache.expiresAt = Date.now() + 3000;
      return value;
    } finally {
      traccarFleetCache.pending = null;
    }
  })();
  return traccarFleetCache.pending;
}

// Carte identifiant GPS -> état en ligne (online/stale/offline), pour les
// pastilles des listes. Best-effort : sans GPS, tout le monde est « offline ».
async function driverOnlineByUnique() {
  if (!traccarConfigured()) return new Map();
  try {
    const snap = await loadTraccarFleetSnapshot();
    if (snap.status !== 'online') return new Map();
    const posByDevice = new Map(snap.positions.map((p) => [String(p.deviceId), p]));
    const map = new Map();
    for (const device of snap.devices) {
      const pos = posByDevice.get(String(device.id));
      const ts = pos?.fixTime || pos?.deviceTime || pos?.serverTime || device?.lastUpdate || null;
      const fresh = ts && Date.now() - new Date(ts).getTime() <= 10 * 60 * 1000;
      map.set(String(device.uniqueId), (!device || device.status === 'offline') ? 'offline' : fresh ? 'online' : 'stale');
    }
    return map;
  } catch { return new Map(); }
}

// Enrichit une ligne de liste avec l'état en ligne du livreur et l'URL de sa photo.
function decorateRowDriver(row, onlineMap) {
  return {
    driver_online: row.driver_unique_id ? (onlineMap.get(String(row.driver_unique_id)) || 'offline') : 'offline',
    driver_photo: (row.driver_has_photo && row.driver_id)
      ? `/api/app/drivers/${row.driver_id}/photo?v=${row.driver_photo_at ? new Date(row.driver_photo_at).getTime() : 0}`
      : null,
  };
}

function mapConfiguration() {
  const maxZoom = (value, fallback = 19) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 24 ? parsed : fallback;
  };
  // Satellite et libellés : par défaut sur Esri World Imagery (gratuit, sans clé),
  // surchargeable par variables d'environnement si un autre fournisseur est retenu.
  const satelliteUrl = String(process.env.MAP_SATELLITE_TILE_URL
    || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}').trim();
  const labelsUrl = String(process.env.MAP_LABELS_TILE_URL
    || 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}').trim();
  return {
    base: {
      url: String(process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
      attribution: String(process.env.MAP_TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors'),
      maxZoom: maxZoom(process.env.MAP_TILE_MAX_ZOOM),
    },
    satellite: satelliteUrl ? {
      url: satelliteUrl,
      attribution: String(process.env.MAP_SATELLITE_ATTRIBUTION
        || 'Imagerie &copy; Esri, Maxar, Earthstar Geographics'),
      maxZoom: maxZoom(process.env.MAP_SATELLITE_MAX_ZOOM),
    } : null,
    labels: labelsUrl ? {
      url: labelsUrl,
      attribution: String(process.env.MAP_LABELS_ATTRIBUTION || '&copy; Esri'),
      maxZoom: maxZoom(process.env.MAP_LABELS_MAX_ZOOM),
    } : null,
  };
}

function publicDestination(row) {
  const latitude = Number(row?.destination_lat);
  const longitude = Number(row?.destination_lng);
  if (row?.destination_lat == null || row?.destination_lng == null
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  const accuracy = Number(row.destination_accuracy);
  return {
    latitude,
    longitude,
    accuracy: row.destination_accuracy != null && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
  };
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

// Shared abuse budget backend. With REDIS_URL the token buckets live in a
// dedicated Redis so delivery-app can run several replicas without each one
// keeping a private, bypassable counter. Without it, the process-local bucket is
// used (single-replica pilot and local development). Redis is required before
// scaling horizontally — see docs/RATE_LIMITING.md and docs/DECISIONS.md.
const rateLimitRedisClient = createRateLimitRedisClient();

function createRateLimitRedisClient() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  let IORedis;
  try {
    IORedis = require('ioredis');
  } catch (error) {
    console.warn('REDIS_URL est défini mais ioredis est absent : repli sur la limitation en mémoire.', error.message);
    return null;
  }
  const client = new IORedis(url, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    keyPrefix: '',
  });
  client.on('error', (error) => {
    console.warn('Redis de limitation indisponible :', error.message);
  });
  return client;
}

function trackingLimiter(namespace, config) {
  if (rateLimitRedisClient) {
    return createRedisTokenBucket({
      client: rateLimitRedisClient,
      keyPrefix: `rl:${namespace}:`,
      capacity: config.capacity,
      refillTokens: config.refillTokens,
      refillIntervalMs: config.refillIntervalMs,
    });
  }
  return createTokenBucket(config);
}

const publicTrackingRateLimit = createRateLimitMiddleware({
  keySecret: process.env.RATE_LIMIT_KEY_SECRET || trackingTokenSecret() || undefined,
  policies: [
    createIpPolicy({
      limiter: trackingLimiter('ip', { capacity: 240, refillTokens: 240, refillIntervalMs: 60_000, maxEntries: 10_000 }),
    }),
    createTokenPolicy({
      limiter: trackingLimiter('token', { capacity: 60, refillTokens: 60, refillIntervalMs: 60_000, maxEntries: 20_000 }),
      key: (req) => req.params.token,
    }),
  ],
});
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), {
  immutable: true,
  maxAge: '30d',
}));
app.use(express.static(path.join(__dirname, 'public')));

// Empreinte d'assets : force le navigateur à recharger app.js/app.css (et les
// pages livreur) après chaque déploiement. Sans elle, les références « /app.js »
// sans version restent servies depuis le cache et l'ancienne interface persiste
// malgré une nouvelle version en ligne. Priorité au SHA du commit Railway ;
// sinon empreinte du contenu des fichiers ; sinon horodatage de démarrage.
const ASSET_VERSION = (() => {
  const fromEnv = process.env.ASSET_VERSION || process.env.RAILWAY_GIT_COMMIT_SHA;
  if (fromEnv) return String(fromEnv).slice(0, 12);
  try {
    const hash = crypto.createHash('sha1');
    for (const file of ['app.js', 'app.css', 'driver.js', 'driver.css']) {
      try { hash.update(fs.readFileSync(path.join(__dirname, 'public', file))); } catch (_) { /* fichier absent : ignoré */ }
    }
    return hash.digest('hex').slice(0, 12);
  } catch (_) {
    return String(Date.now());
  }
})();

// Sert une page HTML « coquille » en y estampillant les assets locaux
// (`/app.css`, `/app.js`, `/driver.css`, `/driver.js`) avec `?v=ASSET_VERSION`,
// et marque le document lui-même en `no-cache` pour qu'il soit toujours revalidé
// (donc la nouvelle version d'assets est prise en compte dès le déploiement).
const shellCache = new Map();
function sendShell(res, file) {
  let html = shellCache.get(file);
  if (html == null) {
    html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8')
      .replace(/(href|src)="\/(app|driver)\.(css|js)"/g, `$1="/$2.$3?v=${ASSET_VERSION}"`);
    shellCache.set(file, html);
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(html);
}
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function receiveEvidence(req, res, next) {
  evidenceUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'L’image dépasse la limite de 1,2 Mo après compression.' });
    return res.status(400).json({ error: 'Fichier de preuve invalide.' });
  });
}

function detectedImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function incidentEventHashPayload(event) {
  return canonicalJson({
    version: 1,
    incidentId: String(event.incidentId),
    eventType: event.eventType,
    body: event.body || null,
    details: event.details || {},
    actorUserId: event.actorUserId == null ? null : String(event.actorUserId),
    createdAt: new Date(event.createdAt).toISOString(),
    previousHash: event.previousHash || null,
  });
}

async function appendIncidentEvent(client, auth, incidentId, eventType, body, details, idempotencyKey) {
  const fingerprint = digest(canonicalJson({ incidentId: String(incidentId), eventType, body: body || null, details: details || {} }));
  const repeated = await client.query(
    `SELECT id, incident_id, request_fingerprint, event_hash, created_at
     FROM incident_events WHERE company_id = $1 AND idempotency_key = $2`,
    [auth.company_id, idempotencyKey]
  );
  if (repeated.rows[0]) {
    if (String(repeated.rows[0].incident_id) !== String(incidentId) || repeated.rows[0].request_fingerprint !== fingerprint) {
      throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
    }
    return { ...repeated.rows[0], alreadyCreated: true };
  }
  const previous = await client.query(
    `SELECT event_hash FROM incident_events
     WHERE company_id = $1 AND incident_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [auth.company_id, incidentId]
  );
  const timestamp = (await client.query('SELECT clock_timestamp() AS created_at')).rows[0].created_at;
  const previousHash = previous.rows[0]?.event_hash || null;
  const eventHash = digest(incidentEventHashPayload({
    incidentId, eventType, body, details, actorUserId: auth.user_id, createdAt: timestamp, previousHash,
  }));
  const inserted = await client.query(
    `INSERT INTO incident_events (
       company_id, incident_id, event_type, body, details, actor_user_id,
       idempotency_key, request_fingerprint, previous_hash, event_hash, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, event_hash, created_at`,
    [auth.company_id, incidentId, eventType, body || null, details || {}, auth.user_id,
      idempotencyKey, fingerprint, previousHash, eventHash, timestamp]
  );
  return inserted.rows[0];
}

function verifyIncidentEventChain(events) {
  let previousHash = null;
  for (const event of events) {
    if ((event.previous_hash || null) !== previousHash) return false;
    const expected = digest(incidentEventHashPayload({
      incidentId: event.incident_id,
      eventType: event.event_type,
      body: event.body,
      details: event.details,
      actorUserId: event.actor_user_id,
      createdAt: event.created_at,
      previousHash,
    }));
    if (event.event_hash !== expected) return false;
    previousHash = event.event_hash;
  }
  return true;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function passwordMatches(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function trackingTokenSecret() {
  if (process.env.TRACKING_TOKEN_SECRET) return process.env.TRACKING_TOKEN_SECRET;
  if (process.env.RAILWAY_ENVIRONMENT_NAME === 'production') return null;
  return process.env.OTP_PEPPER || process.env.SESSION_SECRET || null;
}

function trackingTokenKey() {
  const secret = trackingTokenSecret();
  if (!secret || Buffer.byteLength(secret) < 16) {
    throw Object.assign(new Error('Le coffre des liens de suivi n’est pas configuré.'), { statusCode: 503 });
  }
  return crypto.createHash('sha256').update(`tracking-token:v1:${secret}`).digest();
}

function encryptTrackingToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', trackingTokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptTrackingToken(value) {
  const [version, ivValue, tagValue, ciphertextValue, ...extra] = String(value || '').split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue || extra.length) {
    throw Object.assign(new Error('Format de lien chiffré invalide.'), { statusCode: 503 });
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', trackingTokenKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function trackingTokenStorage(token) {
  return { tokenHash: digest(token), tokenCiphertext: encryptTrackingToken(token) };
}

function encryptedOnlyTrackingTokenStorage() {
  return process.env.TRACKING_TOKEN_STORAGE_MODE === 'encrypted_only';
}

function trackingTokenFromRow(row) {
  const ciphertext = row?.tracking_token_ciphertext ?? row?.token_ciphertext;
  const legacyToken = row?.tracking_token ?? row?.token;
  if (ciphertext) return decryptTrackingToken(ciphertext);
  return legacyToken || null;
}

function trackingLinkBusinessView(row, revealToken = false) {
  if (!row) return { state: 'unavailable', path: null, expiresAt: null, version: null };
  const lifecycle = evaluateTrackingLink({
    expires_at: row.tracking_expires_at ?? row.expires_at,
    created_at: row.tracking_created_at ?? row.created_at,
    revoked_at: row.tracking_revoked_at ?? row.revoked_at,
    order_status: row.status ?? row.order_status,
  });
  let token = null;
  if (revealToken) {
    try {
      token = trackingTokenFromRow(row);
    } catch (_error) {
      token = null;
    }
  }
  return {
    state: lifecycle.state,
    path: token && !['revoked', 'expired', 'unavailable'].includes(lifecycle.state) ? `/suivi/${token}` : null,
    expiresAt: lifecycle.expiresAt,
    revokedAt: row.tracking_revoked_at ?? row.revoked_at ?? null,
    version: Number(row.tracking_link_version ?? row.version ?? 1),
  };
}

async function trackingLinkEventReplay(client, { companyId, orderId, eventType, idempotencyKey, fingerprint }) {
  const repeated = await client.query(
    `SELECT id, order_id, tracking_link_id, generation, request_fingerprint, result_version, created_at
     FROM tracking_link_events
     WHERE company_id = $1 AND event_type = $2 AND idempotency_key = $3`,
    [companyId, eventType, idempotencyKey]
  );
  const event = repeated.rows[0];
  if (!event) return null;
  if (event.request_fingerprint !== fingerprint || String(event.order_id) !== String(orderId)) {
    throw Object.assign(new Error('Cette clé d’action a déjà été utilisée pour une autre opération.'), { statusCode: 409 });
  }
  const currentResult = await client.query(
    `SELECT o.status AS order_status, t.token, t.token_ciphertext, t.expires_at, t.created_at,
            t.revoked_at, t.generation, t.version
     FROM tracking_links t JOIN orders o ON o.id = t.order_id AND o.company_id = t.company_id
     WHERE t.id = $1 AND t.company_id = $2`,
    [event.tracking_link_id, companyId]
  );
  const current = currentResult.rows[0];
  const sameGeneration = current && Number(current.generation) === Number(event.generation);
  let trackingLink = {
    state: eventType === 'revoked' ? 'revoked' : 'superseded',
    path: null,
    expiresAt: null,
    revokedAt: eventType === 'revoked' ? event.created_at : null,
    version: Number(event.result_version),
  };
  if (eventType === 'rotated' && sameGeneration) {
    trackingLink = trackingLinkBusinessView({ ...current, status: current.order_status }, true);
  }
  return { orderId: Number(event.order_id), trackingLink, alreadyApplied: true };
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  return key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9:._-]+$/.test(key) ? key : null;
}

function otpCodeFor(companyId, orderId, idempotencyKey) {
  const secret = process.env.OTP_PEPPER || process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret) throw Object.assign(new Error('La génération OTP n’est pas configurée.'), { statusCode: 503 });
  const digestBytes = crypto.createHmac('sha256', secret)
    .update(`${companyId}:${orderId}:${idempotencyKey}`)
    .digest();
  return String(digestBytes.readUInt32BE(0) % 1000000).padStart(6, '0');
}

function allowedOrderTransitions(status) {
  return orderTransitions[status] || [];
}

function optionalNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function moneyInteger(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 1000000000000 ? amount : null;
}

function validDateOnly(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

function haversineKm(first, second) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(second.lat - first.lat);
  const dLng = radians(second.lng - first.lng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function suggestGeometricStopOrder(stops) {
  if (stops.length < 2) return { stopIds: stops.map((stop) => stop.id), distanceKm: 0 };
  let best = null;
  for (const start of stops) {
    const remaining = new Map(stops.filter((stop) => stop.id !== start.id).map((stop) => [String(stop.id), stop]));
    const ordered = [start];
    let distanceKm = 0;
    while (remaining.size) {
      const current = ordered[ordered.length - 1];
      let next = null;
      let nextDistance = Number.POSITIVE_INFINITY;
      for (const candidate of remaining.values()) {
        const distance = haversineKm(current, candidate);
        if (distance < nextDistance || (distance === nextDistance && Number(candidate.id) < Number(next?.id))) {
          next = candidate;
          nextDistance = distance;
        }
      }
      ordered.push(next);
      remaining.delete(String(next.id));
      distanceKm += nextDistance;
    }
    if (!best || distanceKm < best.distanceKm) best = { stopIds: ordered.map((stop) => stop.id), distanceKm };
  }
  return best;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader(
    'Set-Cookie',
    `delivery_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionDurationMs / 1000)}${secure ? '; Secure' : ''}`
  );
}

function clearSessionCookie(req, res) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie', `delivery_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

async function bootstrapUser(client, { email, password, name, platformAdmin, companyId, role }) {
  if (!email || !password) return null;
  const normalizedEmail = normalizeEmail(email);
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const user = await client.query(
    `INSERT INTO users (email, display_name, password_salt, password_hash, is_platform_admin)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       password_salt = EXCLUDED.password_salt,
       password_hash = EXCLUDED.password_hash,
       is_platform_admin = users.is_platform_admin OR EXCLUDED.is_platform_admin,
       updated_at = NOW()
     RETURNING id`,
    [normalizedEmail, name || normalizedEmail, salt, passwordHash, Boolean(platformAdmin)]
  );
  if (companyId) {
    await client.query(
      `INSERT INTO company_memberships (company_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [companyId, user.rows[0].id, role || 'owner']
    );
  }
  return user.rows[0].id;
}

async function initDatabase() {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS slug TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS photo_proof_mode TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS signature_proof_mode TEXT NOT NULL DEFAULT 'off';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS activation_status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS admin_email TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Africa/Porto-Novo';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS delivery_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_code TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_cycle TEXT NOT NULL DEFAULT 'monthly';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS login_alerts BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
      ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;

      UPDATE companies
      SET slug = 'chicago-consulting-group', updated_at = NOW()
      WHERE id = (SELECT MIN(id) FROM companies WHERE name = 'Chicago Consulting Group')
        AND slug IS NULL
        AND NOT EXISTS (SELECT 1 FROM companies WHERE slug = 'chicago-consulting-group');

      CREATE UNIQUE INDEX IF NOT EXISTS companies_slug_unique ON companies(slug) WHERE slug IS NOT NULL;

      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

      CREATE TABLE IF NOT EXISTS company_memberships (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'operator',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('company', 'platform')),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);

      CREATE TABLE IF NOT EXISTS drivers (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id),
        name TEXT NOT NULL,
        traccar_unique_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, traccar_unique_id)
      );
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_type TEXT NOT NULL DEFAULT 'Moto';
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS capacity INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS availability_status TEXT NOT NULL DEFAULT 'available';
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_data BYTEA;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_mime TEXT;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;

      ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS driver_id BIGINT;
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_memberships_driver_fk') THEN
          ALTER TABLE company_memberships
            ADD CONSTRAINT company_memberships_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;
        END IF;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS company_memberships_driver_unique
        ON company_memberships(company_id, driver_id) WHERE driver_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS user_invitations (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        driver_id BIGINT REFERENCES drivers(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS user_invitations_company_created_idx
        ON user_invitations(company_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS user_invitations_active_email_unique
        ON user_invitations(company_id, email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS user_invitations_active_driver_unique
        ON user_invitations(company_id, driver_id)
        WHERE driver_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;

      CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id),
        driver_id BIGINT NOT NULL REFERENCES drivers(id),
        customer_name TEXT,
        customer_phone TEXT,
        delivery_address TEXT,
        status TEXT NOT NULL DEFAULT 'En préparation',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tracking_links (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        token TEXT UNIQUE,
        token_hash TEXT,
        token_ciphertext TEXT,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        revocation_reason TEXT,
        revocation_idempotency_key TEXT,
        revocation_fingerprint TEXT,
        last_rotated_at TIMESTAMPTZ,
        rotation_idempotency_key TEXT,
        rotation_fingerprint TEXT,
        generation INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
      ALTER TABLE tracking_links ALTER COLUMN token DROP NOT NULL;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS token_hash TEXT;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS token_ciphertext TEXT;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revoked_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revocation_reason TEXT;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revocation_idempotency_key TEXT;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS revocation_fingerprint TEXT;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS last_rotated_at TIMESTAMPTZ;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS rotation_idempotency_key TEXT;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS rotation_fingerprint TEXT;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE tracking_links ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      UPDATE tracking_links t SET company_id = o.company_id FROM orders o
      WHERE o.id = t.order_id AND t.company_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS tracking_links_token_hash_unique
        ON tracking_links(token_hash) WHERE token_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tracking_links_active_token_idx
        ON tracking_links(token) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS tracking_links_order_state_idx
        ON tracking_links(order_id, revoked_at, expires_at);
      UPDATE tracking_links
      SET expires_at = created_at + INTERVAL '30 days'
      WHERE expires_at IS NULL;

      CREATE TABLE IF NOT EXISTS tracking_link_events (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        tracking_link_id BIGINT NOT NULL REFERENCES tracking_links(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'rotated', 'revoked', 'revealed')),
        actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        reason TEXT,
        idempotency_key TEXT,
        request_fingerprint TEXT,
        result_version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tracking_link_events_idempotency_unique
        ON tracking_link_events(company_id, event_type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tracking_link_events_link_created_idx
        ON tracking_link_events(tracking_link_id, created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS customer_requests (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id),
        token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'En attente d’informations',
        customer_name TEXT,
        customer_phone TEXT,
        requested_time TEXT,
        location_lat DOUBLE PRECISION,
        location_lng DOUBLE PRECISION,
        location_accuracy DOUBLE PRECISION,
        location_at TIMESTAMPTZ,
        neighborhood TEXT,
        landmark TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS edit_token_hash TEXT;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      CREATE UNIQUE INDEX IF NOT EXISTS customer_requests_edit_token_unique
        ON customer_requests(edit_token_hash) WHERE edit_token_hash IS NOT NULL;

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_request_id BIGINT REFERENCES customer_requests(id);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS requested_time TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_lng DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_accuracy DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS neighborhood TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS landmark TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS failure_reason TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      -- Numéro métier lisible CMD-AAAA-NNNN (par entreprise, par année).
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS reference TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS orders_reference_unique
        ON orders(company_id, reference) WHERE reference IS NOT NULL;
      CREATE TABLE IF NOT EXISTS order_reference_counters (
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (company_id, year)
      );
      -- Backfill idempotent : attribue un numéro aux commandes qui n'en ont pas,
      -- dans l'ordre de création, par entreprise et par année.
      WITH numbered AS (
        SELECT id,
               'CMD-' || EXTRACT(YEAR FROM created_at)::int || '-' ||
               LPAD((ROW_NUMBER() OVER (
                 PARTITION BY company_id, EXTRACT(YEAR FROM created_at)
                 ORDER BY created_at, id))::text, 4, '0') AS ref
        FROM orders WHERE reference IS NULL
      )
      UPDATE orders o SET reference = n.ref FROM numbered n WHERE o.id = n.id;
      -- Amorce les compteurs à partir du plus grand numéro existant.
      INSERT INTO order_reference_counters (company_id, year, last_seq)
        SELECT company_id, SPLIT_PART(reference, '-', 2)::int AS year,
               MAX(SPLIT_PART(reference, '-', 3)::int) AS last_seq
        FROM orders WHERE reference LIKE 'CMD-%'
        GROUP BY company_id, SPLIT_PART(reference, '-', 2)::int
        ON CONFLICT (company_id, year)
          DO UPDATE SET last_seq = GREATEST(order_reference_counters.last_seq, EXCLUDED.last_seq);
      CREATE UNIQUE INDEX IF NOT EXISTS orders_customer_request_unique
        ON orders(customer_request_id) WHERE customer_request_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS order_status_events (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT,
        actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS delivery_otp_challenges (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        code_salt TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempts_remaining INTEGER NOT NULL DEFAULT 5,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS delivery_proofs (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        proof_type TEXT NOT NULL,
        otp_challenge_id BIGINT REFERENCES delivery_otp_challenges(id) ON DELETE SET NULL,
        verified_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(order_id, proof_type)
      );

      CREATE TABLE IF NOT EXISTS delivery_evidence_files (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        evidence_type TEXT NOT NULL CHECK (evidence_type IN ('photo', 'signature')),
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
        byte_size INTEGER NOT NULL,
        content_sha256 TEXT NOT NULL,
        content BYTEA,
        uploaded_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        superseded_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS delivery_evidence_active_unique
        ON delivery_evidence_files(order_id, evidence_type)
        WHERE superseded_at IS NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS delivery_evidence_order_created_idx
        ON delivery_evidence_files(order_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS delivery_otp_attempts (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        otp_challenge_id BIGINT REFERENCES delivery_otp_challenges(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        success BOOLEAN NOT NULL,
        attempts_remaining INTEGER NOT NULL,
        attempted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS delivery_incidents (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        opened_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        resolved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        resolution TEXT,
        resolution_idempotency_key TEXT,
        resolution_fingerprint TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );
      ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
      ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS resolution_idempotency_key TEXT;
      ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS resolution_fingerprint TEXT;
      ALTER TABLE delivery_incidents ADD COLUMN IF NOT EXISTS assigned_to_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS incident_events (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        incident_id BIGINT NOT NULL REFERENCES delivery_incidents(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        body TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        previous_hash TEXT,
        event_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS order_retention_holds (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
        reason TEXT NOT NULL,
        review_due_at TIMESTAMPTZ NOT NULL,
        placed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        placed_idempotency_key TEXT NOT NULL,
        placed_fingerprint TEXT NOT NULL,
        placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        release_reason TEXT,
        release_idempotency_key TEXT,
        release_fingerprint TEXT,
        released_at TIMESTAMPTZ,
        UNIQUE(company_id, placed_idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS order_retention_holds_active_unique
        ON order_retention_holds(order_id) WHERE status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS order_retention_holds_release_key_unique
        ON order_retention_holds(company_id, release_idempotency_key)
        WHERE release_idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS delivery_runs (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        driver_id BIGINT NOT NULL REFERENCES drivers(id),
        name TEXT NOT NULL,
        service_date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'planned', 'active', 'completed', 'cancelled')),
        version INTEGER NOT NULL DEFAULT 1,
        create_idempotency_key TEXT NOT NULL,
        create_fingerprint TEXT NOT NULL,
        created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, create_idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS delivery_runs_driver_day_open_unique
        ON delivery_runs(company_id, driver_id, service_date)
        WHERE status IN ('draft', 'planned', 'active');

      CREATE TABLE IF NOT EXISTS delivery_stops (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        run_id BIGINT NOT NULL REFERENCES delivery_runs(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        assignment_active BOOLEAN NOT NULL DEFAULT TRUE,
        removed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS delivery_stops_active_order_unique
        ON delivery_stops(order_id) WHERE assignment_active = TRUE;
      CREATE UNIQUE INDEX IF NOT EXISTS delivery_stops_run_sequence_unique
        ON delivery_stops(run_id, sequence) WHERE removed_at IS NULL;
      CREATE INDEX IF NOT EXISTS delivery_stops_run_idx
        ON delivery_stops(run_id, sequence) WHERE removed_at IS NULL;

      CREATE TABLE IF NOT EXISTS delivery_run_events (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        run_id BIGINT NOT NULL REFERENCES delivery_runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS delivery_run_events_run_created_idx
        ON delivery_run_events(run_id, created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
        user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        entity_type TEXT NOT NULL,
        entity_id BIGINT,
        action TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS export_logs (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        dataset TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        purpose TEXT,
        period_from DATE,
        period_to DATE,
        columns JSONB,
        filters JSONB,
        row_count INTEGER,
        worksheet_count INTEGER,
        artifact_bytes INTEGER,
        artifact_sha256 TEXT,
        request_fingerprint_sha256 TEXT,
        failure_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS export_logs_company_created_idx
        ON export_logs(company_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS customer_requests_company_created_idx
        ON customer_requests(company_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS orders_company_created_idx
        ON orders(company_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_logs_company_created_idx
        ON audit_logs(company_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS order_status_events_order_created_idx
        ON order_status_events(order_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS delivery_otp_challenges_order_created_idx
        ON delivery_otp_challenges(order_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS delivery_otp_attempts_order_created_idx
        ON delivery_otp_attempts(order_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS delivery_incidents_order_created_idx
        ON delivery_incidents(order_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS incident_events_incident_created_idx
        ON incident_events(incident_id, created_at ASC, id ASC);
      CREATE UNIQUE INDEX IF NOT EXISTS delivery_incidents_resolution_key_unique
        ON delivery_incidents(company_id, resolution_idempotency_key)
        WHERE resolution_idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS order_payment_accounts (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        expected_amount_minor BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'XOF',
        status TEXT NOT NULL DEFAULT 'pending',
        collected_amount_minor BIGINT,
        collection_method TEXT,
        collection_reference TEXT,
        discrepancy_reason TEXT,
        collected_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        collected_at TIMESTAMPTZ,
        reconciled_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        reconciled_at TIMESTAMPTZ,
        reconciliation_note TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payment_events (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        payment_account_id BIGINT NOT NULL REFERENCES order_payment_accounts(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        amount_minor BIGINT,
        currency TEXT NOT NULL,
        method TEXT,
        reference TEXT,
        reason TEXT,
        actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS payment_events_order_created_idx
        ON payment_events(order_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS payment_adjustments (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        payment_account_id BIGINT NOT NULL REFERENCES order_payment_accounts(id) ON DELETE CASCADE,
        adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('refund', 'additional_collection', 'reversal')),
        direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
        amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
        currency TEXT NOT NULL,
        method TEXT NOT NULL,
        reference TEXT,
        reason TEXT NOT NULL,
        effective_date DATE NOT NULL,
        resulting_total_minor BIGINT NOT NULL,
        reverses_adjustment_id BIGINT REFERENCES payment_adjustments(id),
        actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(company_id, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS payment_adjustments_reversal_unique
        ON payment_adjustments(reverses_adjustment_id) WHERE reverses_adjustment_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS payment_adjustments_order_created_idx
        ON payment_adjustments(order_id, created_at ASC, id ASC);

      INSERT INTO order_status_events (
        company_id, order_id, from_status, to_status, actor_user_id,
        idempotency_key, request_fingerprint, metadata, created_at
      )
      SELECT o.company_id, o.id, NULL, o.status, NULL,
             'system:bootstrap-order:' || o.id,
             md5('bootstrap:' || o.id || ':' || o.status),
             jsonb_build_object('source', 'bootstrap'), o.created_at
      FROM orders o
      WHERE NOT EXISTS (SELECT 1 FROM order_status_events e WHERE e.order_id = o.id);
    `);

    const legacyTrackingLinks = await client.query(
      `SELECT id, token FROM tracking_links WHERE token IS NOT NULL FOR UPDATE`
    );
    for (const link of legacyTrackingLinks.rows) {
      const stored = trackingTokenStorage(link.token);
      await client.query(
        `UPDATE tracking_links
         SET token_hash = $1, token_ciphertext = $2,
             token = CASE WHEN $4::boolean THEN NULL ELSE token END,
             updated_at = NOW()
         WHERE id = $3`,
        [stored.tokenHash, stored.tokenCiphertext, link.id, encryptedOnlyTrackingTokenStorage()]
      );
    }

    let company = await client.query(
      `SELECT id, name FROM companies WHERE slug = 'chicago-consulting-group' ORDER BY id LIMIT 1`
    );
    if (!company.rows[0]) {
      company = await client.query(
        `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id, name`,
        ['Chicago Consulting Group', 'chicago-consulting-group']
      );
    }
    const companyId = company.rows[0].id;

    await client.query(
      `INSERT INTO drivers (company_id, name, traccar_unique_id) VALUES ($1, $2, $3)
       ON CONFLICT (company_id, traccar_unique_id) DO UPDATE SET name = EXCLUDED.name`,
      [companyId, 'Téléphone test', process.env.TRACCAR_DEVICE_ID || '61779795']
    );

    await bootstrapUser(client, {
      email: process.env.ADMIN_USER,
      password: process.env.ADMIN_PASSWORD,
      name: 'Propriétaire',
      platformAdmin: false,
      companyId,
      role: 'owner',
    });
    await bootstrapUser(client, {
      email: process.env.PLATFORM_ADMIN_USER,
      password: process.env.PLATFORM_ADMIN_PASSWORD,
      name: 'Administrateur plateforme',
      platformAdmin: true,
    });

    await client.query('DELETE FROM app_sessions WHERE expires_at <= NOW()');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createSession(req, res, userId, companyId, scope) {
  const token = randomToken();
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 400) || null;
  await pool.query(
    `INSERT INTO app_sessions (token_hash, user_id, company_id, scope, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [digest(token), userId, companyId || null, scope, new Date(Date.now() + sessionDurationMs), userAgent]
  );
  setSessionCookie(req, res, token);
}

async function readSession(req, scope) {
  if (!pool) return null;
  const token = parseCookies(req).delivery_session;
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.user_id, s.company_id, s.scope, s.expires_at,
            u.email, u.display_name, u.is_platform_admin, u.disabled,
            c.name AS company_name, c.slug AS company_slug, c.activation_status, m.role, m.driver_id,
            d.active AS driver_active
     FROM app_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN companies c ON c.id = s.company_id
     LEFT JOIN company_memberships m ON m.company_id = s.company_id AND m.user_id = s.user_id
     LEFT JOIN drivers d ON d.id = m.driver_id AND d.company_id = m.company_id
     WHERE s.token_hash = $1 AND s.scope = $2 AND s.expires_at > NOW()`,
    [digest(token), scope]
  );
  const session = result.rows[0];
  if (!session || session.disabled) return null;
  if (scope === 'company' && (!session.company_id || !session.role)) return null;
  if (scope === 'platform' && !session.is_platform_admin) return null;
  return session;
}

function requireCompanyPage(req, res, next) {
  return readSession(req, 'company').then((session) => {
    if (!session) return res.redirect('/app/login');
    if (session.role === 'driver') return res.redirect('/driver');
    req.auth = session;
    return next();
  }).catch(next);
}

function requireDriverPage(req, res, next) {
  return readSession(req, 'company').then((session) => {
    if (!session) return res.redirect('/app/login');
    if (session.role !== 'driver' || !session.driver_id || !session.driver_active) return res.redirect('/app');
    req.auth = session;
    return next();
  }).catch(next);
}

function requirePlatformPage(req, res, next) {
  return readSession(req, 'platform').then((session) => {
    if (!session) return res.redirect('/admin/login');
    req.auth = session;
    return next();
  }).catch(next);
}

function requireCompanyApi(req, res, next) {
  return readSession(req, 'company').then((session) => {
    if (!session) return res.status(401).json({ error: 'Session entreprise requise.' });
    if (session.role === 'driver') return res.status(403).json({ error: 'Cette fonction est réservée à l’équipe d’exploitation.' });
    req.auth = session;
    // Preview accounts (self-signed-up, not yet activated/paid) may browse and read
    // everything but cannot perform any write until the account is activated. This
    // single gate backs the paywall: the UI blurs the same actions.
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (isWrite && session.activation_status === 'preview') {
      return res.status(402).json({
        error: 'Votre compte est en mode aperçu. Activez-le pour utiliser cette fonctionnalité.',
        code: 'ACCOUNT_PREVIEW',
      });
    }
    return next();
  }).catch(next);
}

function requireDriverApi(req, res, next) {
  return readSession(req, 'company').then((session) => {
    if (!session) return res.status(401).json({ error: 'Session livreur requise.' });
    if (session.role !== 'driver' || !session.driver_id || !session.driver_active) return res.status(403).json({ error: 'Compte livreur actif requis.' });
    req.auth = session;
    return next();
  }).catch(next);
}

function requireCompanyRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Vous n’avez pas l’autorisation d’effectuer cette action.' });
    }
    return next();
  };
}

async function writeAudit(auth, entityType, entityId, action, details = {}) {
  if (!pool) return;
  const result = await pool.query(
    `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [auth?.company_id || null, auth?.user_id || null, entityType, entityId || null, action, details]
  );
  return result.rows[0]?.id;
}

function addUtcDays(dateOnly, days) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day + days));
  return parsed.toISOString().slice(0, 10);
}

function portoNovoToday() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function crmReportingPeriod(query) {
  const today = portoNovoToday();
  const defaultFrom = `${today.slice(0, 7)}-01`;
  const from = query.from || defaultFrom;
  const to = query.to || today;
  if (!validDateOnly(from) || !validDateOnly(to)) {
    throw Object.assign(new Error('Utilisez des dates valides au format AAAA-MM-JJ.'), { statusCode: 400 });
  }
  const fromUtc = Date.parse(`${from}T00:00:00Z`);
  const toUtc = Date.parse(`${to}T00:00:00Z`);
  const dayCount = Math.round((toUtc - fromUtc) / 86400000) + 1;
  if (dayCount < 1) throw Object.assign(new Error('La date de fin doit suivre la date de début.'), { statusCode: 400 });
  if (dayCount > 366) throw Object.assign(new Error('La période ne peut pas dépasser 366 jours.'), { statusCode: 400 });
  const endExclusiveDate = addUtcDays(to, 1);
  const startInclusive = `${from}T00:00:00+01:00`;
  const endExclusive = `${endExclusiveDate}T00:00:00+01:00`;
  const reportEnd = Date.parse(endExclusive) - 1;
  return {
    from,
    to,
    startInclusive,
    endExclusive,
    asOf: new Date(Math.min(Date.now(), reportEnd)).toISOString(),
  };
}

function serializeMetricRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])));
}

async function repeatedRunEvent(client, auth, runId, idempotencyKey, fingerprint) {
  const repeated = await client.query(
    `SELECT id, run_id, event_type, request_fingerprint, details, created_at
     FROM delivery_run_events WHERE company_id = $1 AND idempotency_key = $2`,
    [auth.company_id, idempotencyKey]
  );
  if (!repeated.rows[0]) return null;
  if (String(repeated.rows[0].run_id) !== String(runId) || repeated.rows[0].request_fingerprint !== fingerprint) {
    throw Object.assign(new Error('Cette clé d’action a déjà été utilisée pour une autre modification.'), { statusCode: 409 });
  }
  return repeated.rows[0];
}

async function appendRunEvent(client, auth, runId, eventType, idempotencyKey, fingerprint, details = {}) {
  const result = await client.query(
    `INSERT INTO delivery_run_events (
       company_id, run_id, event_type, actor_user_id, idempotency_key, request_fingerprint, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, event_type, details, created_at`,
    [auth.company_id, runId, eventType, auth.user_id, idempotencyKey, fingerprint, details]
  );
  return result.rows[0];
}

async function loadDeliveryRun(companyId, runId, queryable = pool) {
  const runResult = await queryable.query(
    `SELECT r.id, r.driver_id, r.name, TO_CHAR(r.service_date, 'YYYY-MM-DD') AS service_date, r.status, r.version,
            r.started_at, r.completed_at, r.cancelled_at, r.created_at, r.updated_at,
            d.name AS driver_name, d.phone AS driver_phone, d.vehicle_type, d.capacity,
            d.availability_status, d.active AS driver_active
     FROM delivery_runs r
     JOIN drivers d ON d.id = r.driver_id AND d.company_id = r.company_id
     WHERE r.id = $1 AND r.company_id = $2`,
    [runId, companyId]
  );
  const run = runResult.rows[0];
  if (!run) return null;
  const [stops, eligibleOrders, events] = await Promise.all([
    queryable.query(
      `SELECT s.id, s.order_id, s.sequence, s.assignment_active, s.created_at,
              o.status AS order_status, o.reference AS order_reference, o.customer_name, o.customer_phone, o.requested_time,
              o.neighborhood, o.landmark, o.delivery_address, o.destination_lat, o.destination_lng
       FROM delivery_stops s
       JOIN orders o ON o.id = s.order_id AND o.company_id = s.company_id
       WHERE s.run_id = $1 AND s.company_id = $2 AND s.removed_at IS NULL
       ORDER BY s.sequence ASC, s.id ASC`,
      [runId, companyId]
    ),
    queryable.query(
      `SELECT o.id, o.status, o.customer_name, o.customer_phone, o.requested_time,
              o.neighborhood, o.landmark, o.delivery_address, o.destination_lat, o.destination_lng
       FROM orders o
       WHERE o.company_id = $1 AND o.driver_id = $2
         AND o.status <> ALL($3::text[])
         AND NOT EXISTS (
           SELECT 1 FROM delivery_stops s WHERE s.order_id = o.id AND s.assignment_active = TRUE
         )
       ORDER BY o.created_at ASC, o.id ASC LIMIT 100`,
      [companyId, run.driver_id, terminalOrderStatuses]
    ),
    queryable.query(
      `SELECT e.id, e.event_type, e.details, e.created_at,
              COALESCE(u.display_name, 'Système') AS actor_name
       FROM delivery_run_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.run_id = $1 AND e.company_id = $2
       ORDER BY e.created_at ASC, e.id ASC`,
      [runId, companyId]
    ),
  ]);
  return {
    ...run,
    stops: stops.rows,
    eligibleOrders: eligibleOrders.rows,
    events: events.rows,
    allowedTransitions: runTransitions[run.status] || [],
    canEditStops: run.status === 'draft',
    canReorderStops: ['draft', 'planned'].includes(run.status),
  };
}

// Date de service « du jour », au format YYYY-MM-DD.
function todayServiceDate() {
  return new Date().toISOString().slice(0, 10);
}

// Attribue le numéro métier CMD-AAAA-NNNN à une commande (compteur atomique par
// entreprise et par année). À appeler dans la transaction de création.
async function assignOrderReference(client, companyId, orderId) {
  const year = new Date().getFullYear();
  const seq = await client.query(
    `INSERT INTO order_reference_counters (company_id, year, last_seq)
     VALUES ($1, $2, 1)
     ON CONFLICT (company_id, year)
       DO UPDATE SET last_seq = order_reference_counters.last_seq + 1
     RETURNING last_seq`,
    [companyId, year]
  );
  const reference = `CMD-${year}-${String(seq.rows[0].last_seq).padStart(4, '0')}`;
  await client.query(
    `UPDATE orders SET reference = $1 WHERE id = $2 AND company_id = $3`,
    [reference, orderId, companyId]
  );
  return reference;
}

// Trouve (ou crée) la tournée ouverte du jour pour un livreur. La tournée est
// un objet dérivé : les commandes s'y rattachent automatiquement, l'entreprise
// n'a jamais à la créer ni à l'alimenter à la main.
async function ensureOpenDayRun(client, auth, driverId, serviceDate) {
  const found = await client.query(
    `SELECT id, version FROM delivery_runs
     WHERE company_id = $1 AND driver_id = $2 AND service_date = $3
       AND status IN ('draft', 'planned', 'active')
     ORDER BY id LIMIT 1`,
    [auth.company_id, driverId, serviceDate]
  );
  if (found.rows[0]) return found.rows[0];
  const [y, m, d] = String(serviceDate).split('-');
  const name = `Tournée du ${d}/${m}/${y}`;
  const key = `auto-run:${driverId}:${serviceDate}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const fingerprint = digest(canonicalJson({ driverId, serviceDate, auto: true }));
  try {
    const created = await client.query(
      `INSERT INTO delivery_runs (
         company_id, driver_id, name, service_date, create_idempotency_key,
         create_fingerprint, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, version`,
      [auth.company_id, driverId, name, serviceDate, key, fingerprint, auth.user_id]
    );
    await appendRunEvent(client, auth, created.rows[0].id, 'created', `${key}:evt`, fingerprint, {
      driverId, serviceDate, name, version: created.rows[0].version, auto: true,
    });
    return created.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      const retry = await client.query(
        `SELECT id, version FROM delivery_runs
         WHERE company_id = $1 AND driver_id = $2 AND service_date = $3
           AND status IN ('draft', 'planned', 'active')
         ORDER BY id LIMIT 1`,
        [auth.company_id, driverId, serviceDate]
      );
      if (retry.rows[0]) return retry.rows[0];
    }
    throw error;
  }
}

// Rattache une commande à la tournée du jour de son livreur (no-op si elle y est
// déjà). À appeler dans une SAVEPOINT : un échec ne doit jamais faire échouer la
// création de la commande, dont la source de vérité reste orders.driver_id.
async function attachOrderToDayRun(client, auth, orderId, driverId, serviceDate) {
  const already = await client.query(
    `SELECT 1 FROM delivery_stops WHERE order_id = $1 AND assignment_active = TRUE LIMIT 1`,
    [orderId]
  );
  if (already.rows[0]) return;
  const run = await ensureOpenDayRun(client, auth, driverId, serviceDate);
  const seq = await client.query(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM delivery_stops WHERE run_id = $1 AND removed_at IS NULL`,
    [run.id]
  );
  const stop = await client.query(
    `INSERT INTO delivery_stops (company_id, run_id, order_id, sequence)
     VALUES ($1, $2, $3, $4) RETURNING id, sequence`,
    [auth.company_id, run.id, orderId, seq.rows[0].n]
  );
  const updated = await client.query(
    `UPDATE delivery_runs SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING version`,
    [run.id]
  );
  await appendRunEvent(client, auth, run.id, 'order_added',
    `auto-attach:${orderId}:${Date.now()}`, digest(canonicalJson({ orderId, auto: true })), {
      stopId: stop.rows[0].id, orderId, sequence: stop.rows[0].sequence, version: updated.rows[0].version, auto: true,
    });
}

// Ordonne les arrêts d'après le réseau routier réel (OSRM) : plus proche voisin
// puis 2-opt sur les durées de trajet. Renvoie null si le routage est indisponible.
async function optimizeStopOrderByRoad(stops) {
  const health = routingAdapter.health();
  if (health.status === 'disabled' || !health.capabilities || !health.capabilities.matrix) return null;
  if (stops.length < 2 || stops.length > 25) return null;
  const coordinates = stops.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));
  const table = await routingAdapter.matrix({ profile: 'motorcycle', coordinates });
  if (table.status !== 'ok' && table.status !== 'partial') return null;
  const dur = table.durationsSeconds;
  const dist = table.distancesMeters;
  if (!dur) return null;
  const n = stops.length;
  const visited = new Array(n).fill(false);
  const order = [0];
  visited[0] = true;
  for (let k = 1; k < n; k += 1) {
    const last = order[order.length - 1];
    let best = -1;
    let bestVal = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (visited[j]) continue;
      const v = dur[last] ? dur[last][j] : null;
      if (v == null) continue;
      if (v < bestVal) { bestVal = v; best = j; }
    }
    if (best < 0) { for (let j = 0; j < n; j += 1) { if (!visited[j]) { best = j; break; } } }
    visited[best] = true;
    order.push(best);
  }
  const seqDur = (ord) => {
    let total = 0;
    for (let i = 0; i < ord.length - 1; i += 1) {
      const v = dur[ord[i]] ? dur[ord[i]][ord[i + 1]] : null;
      if (v == null) return Infinity;
      total += v;
    }
    return total;
  };
  let improved = true;
  let guard = 0;
  while (improved && guard < 50) {
    improved = false;
    guard += 1;
    for (let i = 0; i < order.length - 1; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if (seqDur(cand) < seqDur(order) - 1e-6) { order.splice(0, order.length, ...cand); improved = true; }
      }
    }
  }
  let durationSeconds = 0;
  let distanceMeters = 0;
  for (let i = 0; i < order.length - 1; i += 1) {
    durationSeconds += (dur[order[i]] && dur[order[i]][order[i + 1]]) || 0;
    distanceMeters += (dist && dist[order[i]] && dist[order[i]][order[i + 1]]) || 0;
  }
  return {
    stopIds: order.map((i) => Number(stops[i].id)),
    durationSeconds,
    distanceMeters,
    method: 'osrm_matrix_nn_2opt',
  };
}

app.get('/health', asyncRoute(async (_req, res) => {
  if (!pool) return res.status(503).json({ status: 'unavailable', database: 'not_configured' });
  try {
    await pool.query('SELECT 1');
    return res.json({ status: 'ok', database: 'reachable' });
  } catch (_error) {
    return res.status(503).json({ status: 'unavailable', database: 'unreachable' });
  }
}));

app.get('/', (_req, res) => res.redirect('/app'));

app.get('/app/login', (_req, res) => sendShell(res, 'app-login.html'));
// Brute-force protection on sign-in: a per-IP quota plus a per-email quota so a
// single targeted account cannot be hammered even from many IPs.
const loginRateLimit = createRateLimitMiddleware({
  keySecret: process.env.RATE_LIMIT_KEY_SECRET || trackingTokenSecret() || undefined,
  policies: [
    createIpPolicy({
      limiter: trackingLimiter('login_ip', { capacity: 20, refillTokens: 20, refillIntervalMs: 600_000, maxEntries: 10_000 }),
    }),
    createTokenPolicy({
      limiter: trackingLimiter('login_id', { capacity: 10, refillTokens: 10, refillIntervalMs: 600_000, maxEntries: 20_000 }),
      key: (req) => String((req.body && req.body.user) || '').trim().toLowerCase(),
      required: false,
    }),
  ],
});

app.post('/app/login', loginRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Base métier non configurée.');
  const email = normalizeEmail(req.body.user);
  const result = await pool.query(
    `SELECT u.id, u.password_salt, u.password_hash, u.disabled, m.company_id, m.role
     FROM users u JOIN company_memberships m ON m.user_id = u.id
     WHERE u.email = $1 ORDER BY m.id LIMIT 1`,
    [email]
  );
  const user = result.rows[0];
  if (!user || user.disabled || !passwordMatches(req.body.password, user.password_salt, user.password_hash)) {
    return res.redirect('/app/login?error=1');
  }
  await createSession(req, res, user.id, user.company_id, 'company');
  return res.redirect(user.role === 'driver' ? '/driver' : '/app');
}));

app.post('/app/logout', asyncRoute(async (req, res) => {
  const token = parseCookies(req).delivery_session;
  if (pool && token) await pool.query('DELETE FROM app_sessions WHERE token_hash = $1', [digest(token)]);
  clearSessionCookie(req, res);
  return res.redirect('/app/login');
}));

function slugifyCompany(name) {
  const base = String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'entreprise';
}

// Self-service company registration. New accounts start in "preview": the owner
// can sign in and browse, but requireCompanyApi blocks every write until the
// account is activated (paid). IP-rate-limited to blunt abuse of a public write.
const registerRateLimit = createRateLimitMiddleware({
  keySecret: process.env.RATE_LIMIT_KEY_SECRET || trackingTokenSecret() || undefined,
  policies: [
    createIpPolicy({
      limiter: trackingLimiter('register', { capacity: 20, refillTokens: 20, refillIntervalMs: 3_600_000, maxEntries: 10_000 }),
    }),
  ],
});

app.post('/app/register', registerRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Base métier non configurée.');
  const body = req.body || {};
  const companyName = String(body.companyName || '').trim();
  const ownerName = String(body.ownerName || '').trim();
  const email = normalizeEmail(body.email);
  const phone = String(body.phone || '').trim();
  const password = String(body.password || '');

  let fieldError = null;
  if (companyName.length < 2 || companyName.length > 120) fieldError = 'company';
  else if (ownerName.length < 2 || ownerName.length > 120) fieldError = 'name';
  else if (!email || email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fieldError = 'email';
  else if (phone.length < 6 || phone.length > 30) fieldError = 'phone';
  else if (password.length < 8 || password.length > 200) fieldError = 'password';
  if (fieldError) return res.redirect(`/app/login?tab=register&error=${fieldError}`);

  const client = await pool.connect();
  let userId;
  let companyId;
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows[0]) throw Object.assign(new Error('email_taken'), { code: 'email_taken' });

    let slug = slugifyCompany(companyName);
    const slugTaken = await client.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
    if (slugTaken.rows[0]) slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;

    const company = await client.query(
      `INSERT INTO companies (name, slug, activation_status) VALUES ($1, $2, 'preview') RETURNING id`,
      [companyName, slug]
    );
    companyId = company.rows[0].id;

    const salt = crypto.randomBytes(16).toString('hex');
    const createdUser = await client.query(
      `INSERT INTO users (email, display_name, phone, password_salt, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [email, ownerName, phone, salt, hashPassword(password, salt)]
    );
    userId = createdUser.rows[0].id;

    await client.query(
      `INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [companyId, userId]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'company', $3, 'company_registered', jsonb_build_object('activation_status', 'preview'))`,
      [companyId, userId, companyId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === 'email_taken') return res.redirect('/app/login?tab=register&error=email_taken');
    console.error('Registration error:', error.message);
    return res.redirect('/app/login?tab=register&error=server');
  } finally {
    client.release();
  }

  // No auto-login: the new owner confirms their credentials by signing in.
  return res.redirect('/app/login?created=1');
}));

// --- Mot de passe oublié (OWASP Forgot Password) ---
// Jeton aléatoire, stocké haché (SHA-256), expirant (1 h), à usage unique.
// La réponse est toujours identique pour ne pas révéler l'existence d'un compte.
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const forgotRateLimit = createRateLimitMiddleware({
  keySecret: process.env.RATE_LIMIT_KEY_SECRET || trackingTokenSecret() || undefined,
  policies: [
    createIpPolicy({
      limiter: trackingLimiter('forgot', { capacity: 12, refillTokens: 12, refillIntervalMs: 3_600_000, maxEntries: 10_000 }),
    }),
  ],
});

app.get('/app/forgot', (_req, res) => sendShell(res, 'app-reset.html'));
app.get('/app/reset', (_req, res) => sendShell(res, 'app-reset.html'));

app.post('/app/forgot', forgotRateLimit, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email || req.body.user);
  // Réponse générique quoi qu'il arrive (anti-énumération).
  const done = () => res.redirect('/app/forgot?sent=1');
  if (!pool || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return done();
  try {
    const found = await pool.query('SELECT id FROM users WHERE email = $1 AND disabled = FALSE', [email]);
    const user = found.rows[0];
    if (user) {
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
      // On invalide les anciens jetons non utilisés avant d'en émettre un nouveau.
      await pool.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [user.id]);
      await pool.query(
        'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
        [digest(token), user.id, expiresAt]
      );
      const base = publicBaseUrl(req);
      const resetUrl = `${base}/app/reset?token=${encodeURIComponent(token)}`;
      const html = renderEmailShell({
        baseUrl: base,
        heading: 'Réinitialisation de votre mot de passe',
        introHtml: 'Vous avez demandé à réinitialiser le mot de passe de votre compte TRAXO. Cliquez sur le bouton ci-dessous pour en choisir un nouveau. Ce lien expire dans 1 heure et ne peut être utilisé qu’une seule fois.',
        bodyHtml: `<p style="font-family:Arial,sans-serif;font-size:12.5px;color:#98a2b3;margin:16px 0 0;word-break:break-all">Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :<br>${escHtmlServer(resetUrl)}</p>`,
        ctaLabel: 'Réinitialiser mon mot de passe',
        ctaUrl: resetUrl,
        footerNote: 'Vous n’êtes pas à l’origine de cette demande ? Ignorez cet e-mail : votre mot de passe reste inchangé.',
      });
      const text = `Réinitialisez votre mot de passe TRAXO (lien valable 1 h) :\n${resetUrl}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.`;
      await sendEmail({ to: email, subject: 'TRAXO — Réinitialisation de votre mot de passe', html, text });
    }
  } catch (error) {
    console.error('Forgot password error:', error.message);
  }
  return done();
}));

app.post('/app/reset', forgotRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Base métier non configurée.');
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  const back = (err) => res.redirect(`/app/reset?token=${encodeURIComponent(token)}&error=${err}`);
  if (!token) return res.redirect('/app/forgot?error=invalid');
  if (password.length < 8 || password.length > 200) return back('password');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query(
      `SELECT user_id FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
      [digest(token)]
    );
    const reset = row.rows[0];
    if (!reset) {
      await client.query('ROLLBACK');
      return res.redirect('/app/forgot?error=invalid');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await client.query(
      'UPDATE users SET password_salt = $1, password_hash = $2, password_changed_at = NOW() WHERE id = $3',
      [salt, hashPassword(password, salt), reset.user_id]
    );
    await client.query('UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1', [digest(token)]);
    await client.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);
    // Invalide toutes les sessions existantes : reconnexion obligatoire.
    await client.query('DELETE FROM app_sessions WHERE user_id = $1', [reset.user_id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Reset password error:', error.message);
    return back('server');
  } finally {
    client.release();
  }
  return res.redirect('/app/login?reset=1');
}));

app.get('/admin/login', (_req, res) => sendShell(res, 'platform-login.html'));
app.post('/admin/login', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Base métier non configurée.');
  const email = normalizeEmail(req.body.user);
  const result = await pool.query(
    `SELECT id, password_salt, password_hash, disabled, is_platform_admin FROM users WHERE email = $1`,
    [email]
  );
  const user = result.rows[0];
  if (!user || user.disabled || !user.is_platform_admin || !passwordMatches(req.body.password, user.password_salt, user.password_hash)) {
    return res.redirect('/admin/login?error=1');
  }
  await createSession(req, res, user.id, null, 'platform');
  return res.redirect('/admin');
}));

app.post('/admin/logout', asyncRoute(async (req, res) => {
  const token = parseCookies(req).delivery_session;
  if (pool && token) await pool.query('DELETE FROM app_sessions WHERE token_hash = $1', [digest(token)]);
  clearSessionCookie(req, res);
  return res.redirect('/admin/login');
}));

app.get('/admin', requirePlatformPage, (_req, res) => {
  sendShell(res, 'platform-admin.html');
});

const companyPages = [
  '/app', '/app/operations', '/app/demandes', '/app/nouvelle-commande', '/app/commandes', '/app/carte',
  '/app/livreurs', '/app/tournees', '/app/incidents', '/app/equipe', '/app/clients', '/app/rapports', '/app/parametres',
];
app.get(companyPages, requireCompanyPage, (_req, res) => {
  sendShell(res, 'app.html');
});
app.get('/app/demandes/:id', requireCompanyPage, (_req, res) => {
  sendShell(res, 'app.html');
});
app.get('/app/commandes/:id', requireCompanyPage, (_req, res) => {
  sendShell(res, 'app.html');
});
app.get('/app/incidents/:id', requireCompanyPage, (_req, res) => {
  sendShell(res, 'app.html');
});
app.get('/app/tournees/:id', requireCompanyPage, (_req, res) => {
  sendShell(res, 'app.html');
});
app.get('/app/clients/:id', requireCompanyPage, (_req, res) => {
  sendShell(res, 'app.html');
});

app.get(['/driver', '/driver/commandes/:id'], requireDriverPage, (_req, res) => {
  sendShell(res, 'driver.html');
});

app.get('/suivi/:token', (req, res) => {
  const isDemo = Boolean(demoToken && req.params.token === demoToken);
  if (!isDemo && !pool) return res.status(404).send('Ce lien de suivi n’est plus disponible.');
  res.set({
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'origin',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  return sendShell(res, 'tracking.html');
});

app.get('/demande/:token', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Service momentanément indisponible.');
  const result = await pool.query('SELECT status, expires_at FROM customer_requests WHERE token = $1', [req.params.token]);
  const request = result.rows[0];
  if (!request || (request.expires_at && new Date(request.expires_at) <= new Date())) {
    return res.status(404).send('Ce formulaire est introuvable ou expiré.');
  }
  if (request.status !== 'En attente d’informations') {
    return res.redirect(`/demande/${encodeURIComponent(req.params.token)}/confirmation`);
  }
  return sendShell(res, 'request.html');
}));

app.get('/demande/:token/confirmation', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Service momentanément indisponible.');
  const result = await pool.query('SELECT id FROM customer_requests WHERE token = $1', [req.params.token]);
  if (!result.rows[0]) return res.status(404).send('Cette demande est introuvable.');
  return sendShell(res, 'confirmation.html');
}));

app.get('/invitation/:token', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Service momentanément indisponible.');
  const result = await pool.query(
    `SELECT id FROM user_invitations
     WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [digest(req.params.token)]
  );
  if (!result.rows[0]) return res.status(404).send('Cette invitation est invalide, expirée ou déjà utilisée.');
  return sendShell(res, 'invitation.html');
}));

app.get('/api/public/invitations/:token', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const result = await pool.query(
    `SELECT i.email, i.display_name, i.role, i.expires_at, c.name AS company_name, d.name AS driver_name
     FROM user_invitations i
     JOIN companies c ON c.id = i.company_id
     LEFT JOIN drivers d ON d.id = i.driver_id
     WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()`,
    [digest(req.params.token)]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Cette invitation est invalide, expirée ou déjà utilisée.' });
  return res.json(result.rows[0]);
}));

app.post('/api/public/invitations/:token/accept', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const password = String(req.body.password || '');
  const passwordConfirmation = String(req.body.passwordConfirmation || '');
  if (password.length < 12 || password.length > 128 || password.trim().length < 12) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir entre 12 et 128 caractères.' });
  }
  if (password !== passwordConfirmation) return res.status(400).json({ error: 'Les deux mots de passe ne correspondent pas.' });
  const client = await pool.connect();
  let invitation;
  let userId;
  try {
    await client.query('BEGIN');
    const invitationResult = await client.query(
      `SELECT * FROM user_invitations WHERE token_hash = $1 FOR UPDATE`,
      [digest(req.params.token)]
    );
    invitation = invitationResult.rows[0];
    if (!invitation || invitation.accepted_at || invitation.revoked_at || new Date(invitation.expires_at) <= new Date()) {
      throw Object.assign(new Error('Cette invitation est invalide, expirée ou déjà utilisée.'), { statusCode: 410 });
    }
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [invitation.email]);
    if (existing.rows[0]) {
      throw Object.assign(new Error('Un compte utilise déjà cette adresse. Demandez une nouvelle invitation à l’entreprise.'), { statusCode: 409 });
    }
    if (invitation.role === 'driver') {
      const driver = await client.query(
        `SELECT id FROM drivers WHERE id = $1 AND company_id = $2 AND active = TRUE FOR UPDATE`,
        [invitation.driver_id, invitation.company_id]
      );
      if (!driver.rows[0]) throw Object.assign(new Error('Le profil livreur associé n’est plus disponible.'), { statusCode: 409 });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const createdUser = await client.query(
      `INSERT INTO users (email, display_name, password_salt, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [invitation.email, invitation.display_name, salt, hashPassword(password, salt)]
    );
    userId = createdUser.rows[0].id;
    await client.query(
      `INSERT INTO company_memberships (company_id, user_id, role, driver_id)
       VALUES ($1, $2, $3, $4)`,
      [invitation.company_id, userId, invitation.role, invitation.role === 'driver' ? invitation.driver_id : null]
    );
    await client.query('UPDATE user_invitations SET accepted_at = NOW() WHERE id = $1', [invitation.id]);
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'user_invitation', $3, 'accepted', jsonb_build_object('role', $4::text))`,
      [invitation.company_id, userId, invitation.id, invitation.role]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Invitation acceptance error:', error.message);
    return res.status(500).json({ error: 'Impossible d’activer ce compte.' });
  } finally {
    client.release();
  }
  await createSession(req, res, userId, invitation.company_id, 'company');
  return res.status(201).json({ status: 'accepted', redirect: invitation.role === 'driver' ? '/driver' : '/app' });
}));

app.get('/api/app/team', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const [members, invitations] = await Promise.all([
    pool.query(
      `SELECT m.id, m.role, m.driver_id, u.email, u.display_name, u.disabled, u.created_at,
              d.name AS driver_name
       FROM company_memberships m JOIN users u ON u.id = m.user_id
       LEFT JOIN drivers d ON d.id = m.driver_id
       WHERE m.company_id = $1 ORDER BY u.display_name, u.email`,
      [req.auth.company_id]
    ),
    pool.query(
      `SELECT i.id, i.email, i.display_name, i.role, i.driver_id, i.expires_at, i.created_at, d.name AS driver_name
       FROM user_invitations i LEFT JOIN drivers d ON d.id = i.driver_id
       WHERE i.company_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
       ORDER BY i.created_at DESC`,
      [req.auth.company_id]
    ),
  ]);
  return res.json({ members: members.rows, invitations: invitations.rows });
}));

app.post('/api/app/invitations', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const displayName = String(req.body.displayName || '').trim();
  const role = String(req.body.role || '').trim();
  const driverId = req.body.driverId ? String(req.body.driverId) : null;
  if (!/^\S+@\S+\.\S+$/.test(email) || displayName.length < 2 || displayName.length > 100 || !invitationRoles.includes(role)) {
    return res.status(400).json({ error: 'Nom, adresse e-mail ou rôle invalide.' });
  }
  if (req.auth.role === 'manager' && role === 'manager') {
    return res.status(403).json({ error: 'Seul un propriétaire peut inviter un autre manager.' });
  }
  if (role === 'driver' && !driverId) return res.status(400).json({ error: 'Sélectionnez le livreur associé à ce compte.' });
  if (role !== 'driver' && driverId) return res.status(400).json({ error: 'Un profil livreur ne peut être associé qu’au rôle livreur.' });
  const token = randomToken();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingUser = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existingUser.rows[0]) throw Object.assign(new Error('Un compte utilise déjà cette adresse e-mail.'), { statusCode: 409 });
    if (role === 'driver') {
      const driver = await client.query(
        `SELECT d.id FROM drivers d
         WHERE d.id = $1 AND d.company_id = $2 AND d.active = TRUE
           AND NOT EXISTS (
             SELECT 1 FROM company_memberships m WHERE m.company_id = d.company_id AND m.driver_id = d.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM user_invitations i
             WHERE i.company_id = d.company_id AND i.driver_id = d.id
               AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
           )
         FOR UPDATE`,
        [driverId, req.auth.company_id]
      );
      if (!driver.rows[0]) throw Object.assign(new Error('Ce livreur est introuvable, inactif ou possède déjà un compte.'), { statusCode: 409 });
    }
    await client.query(
      `UPDATE user_invitations SET revoked_at = NOW()
       WHERE company_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [req.auth.company_id, email]
    );
    const invitation = await client.query(
      `INSERT INTO user_invitations (
         company_id, email, display_name, role, driver_id, token_hash, created_by_user_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '48 hours')
       RETURNING id, expires_at`,
      [req.auth.company_id, email, displayName, role, role === 'driver' ? driverId : null, digest(token), req.auth.user_id]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'user_invitation', $3, 'created', jsonb_build_object('role', $4::text, 'email', $5::text))`,
      [req.auth.company_id, req.auth.user_id, invitation.rows[0].id, role, email]
    );
    await client.query('COMMIT');
    return res.status(201).json({ id: invitation.rows[0].id, path: `/invitation/${token}`, expiresAt: invitation.rows[0].expires_at });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Une invitation active existe déjà pour cette adresse ou ce livreur.' });
    console.error('Invitation creation error:', error.message);
    return res.status(500).json({ error: 'Impossible de créer cette invitation.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/invitations/:id/revoke', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE user_invitations SET revoked_at = NOW()
     WHERE id = $1 AND company_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
       AND ($3::text = 'owner' OR role <> 'manager')
     RETURNING id`,
    [req.params.id, req.auth.company_id, req.auth.role]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Invitation active introuvable.' });
  await writeAudit(req.auth, 'user_invitation', result.rows[0].id, 'revoked');
  return res.json({ status: 'revoked' });
}));

app.get('/api/app/context', requireCompanyApi, (req, res) => res.json({
  user: { id: req.auth.user_id, email: req.auth.email, name: req.auth.display_name, role: req.auth.role },
  company: { id: req.auth.company_id, name: req.auth.company_name, slug: req.auth.company_slug, activationStatus: req.auth.activation_status || 'active' },
}));

app.get('/api/driver/context', requireDriverApi, asyncRoute(async (req, res) => {
  const driver = await pool.query(
    `SELECT id, name, phone, vehicle_type, availability_status, active
     FROM drivers WHERE id = $1 AND company_id = $2`,
    [req.auth.driver_id, req.auth.company_id]
  );
  if (!driver.rows[0] || !driver.rows[0].active) return res.status(403).json({ error: 'Ce profil livreur est désactivé.' });
  return res.json({
    user: { id: req.auth.user_id, email: req.auth.email, name: req.auth.display_name, role: req.auth.role },
    company: { id: req.auth.company_id, name: req.auth.company_name },
    driver: driver.rows[0],
  });
}));

app.get('/api/driver/runs', requireDriverApi, asyncRoute(async (req, res) => {
  const runsResult = await pool.query(
    `SELECT r.id, r.name, TO_CHAR(r.service_date, 'YYYY-MM-DD') AS service_date,
            r.status, r.version, r.started_at, r.updated_at
     FROM delivery_runs r
     WHERE r.company_id = $1 AND r.driver_id = $2
       AND (r.status = 'active' OR (r.status = 'planned' AND r.service_date <= CURRENT_DATE + 14))
     ORDER BY CASE r.status WHEN 'active' THEN 0 ELSE 1 END, r.service_date ASC, r.id ASC
     LIMIT 30`,
    [req.auth.company_id, req.auth.driver_id]
  );
  const runIds = runsResult.rows.map((run) => run.id);
  if (!runIds.length) return res.json([]);
  const stopsResult = await pool.query(
    `SELECT s.id, s.run_id, s.order_id, s.sequence,
            o.status AS order_status, o.customer_name, o.requested_time,
            o.neighborhood, o.landmark, o.delivery_address,
            o.destination_lat, o.destination_lng
     FROM delivery_stops s
     JOIN delivery_runs r ON r.id = s.run_id AND r.company_id = s.company_id
     JOIN orders o ON o.id = s.order_id AND o.company_id = s.company_id
     WHERE s.run_id = ANY($1::bigint[]) AND s.company_id = $2
       AND s.removed_at IS NULL AND s.assignment_active = TRUE
       AND r.driver_id = $3 AND o.driver_id = $3
     ORDER BY s.run_id ASC, s.sequence ASC, s.id ASC`,
    [runIds, req.auth.company_id, req.auth.driver_id]
  );
  const stopsByRun = new Map();
  for (const stop of stopsResult.rows) {
    const key = String(stop.run_id);
    if (!stopsByRun.has(key)) stopsByRun.set(key, []);
    stopsByRun.get(key).push(stop);
  }
  return res.json(runsResult.rows.map((run) => {
    const stops = stopsByRun.get(String(run.id)) || [];
    const completedStops = stops.filter((stop) => terminalOrderStatuses.includes(stop.order_status)).length;
    const nextStop = stops.find((stop) => !terminalOrderStatuses.includes(stop.order_status));
    return {
      ...run,
      stops,
      completedStops,
      totalStops: stops.length,
      nextStopId: nextStop?.id || null,
      nextOrderId: nextStop?.order_id || null,
    };
  }));
}));

app.get('/api/driver/orders', requireDriverApi, asyncRoute(async (req, res) => {
  const history = req.query.scope === 'history';
  const result = await pool.query(
    `SELECT o.id, o.status, o.customer_name, o.customer_phone, o.delivery_address,
            o.requested_time, o.neighborhood, o.landmark, o.destination_lat, o.destination_lng,
            o.created_at, o.updated_at, pa.expected_amount_minor, pa.currency AS payment_currency,
            pa.status AS payment_status,
            s.sequence AS stop_sequence, r.id AS run_id, r.name AS run_name,
            TO_CHAR(r.service_date, 'YYYY-MM-DD') AS run_service_date, r.status AS run_status
     FROM orders o
     LEFT JOIN order_payment_accounts pa ON pa.order_id = o.id
     LEFT JOIN delivery_stops s ON s.order_id = o.id AND s.company_id = o.company_id
       AND s.assignment_active = TRUE AND s.removed_at IS NULL
     LEFT JOIN delivery_runs r ON r.id = s.run_id AND r.company_id = o.company_id
       AND r.driver_id = o.driver_id AND r.status IN ('planned', 'active')
     WHERE o.company_id = $1 AND o.driver_id = $2
       AND ${history ? 'o.status = ANY($3::text[])' : 'NOT (o.status = ANY($3::text[]))'}
     ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,
              r.service_date ASC NULLS LAST, s.sequence ASC NULLS LAST, o.updated_at DESC, o.id DESC LIMIT 100`,
    [req.auth.company_id, req.auth.driver_id, terminalOrderStatuses]
  );
  return res.json(result.rows);
}));

app.get('/api/driver/orders/:id', requireDriverApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT o.*, pa.expected_amount_minor, pa.currency AS payment_currency,
             pa.status AS payment_status, pa.collected_amount_minor, pa.collection_method,
             pa.collection_reference, pa.discrepancy_reason,
             p.id AS proof_id, p.verified_at AS proof_verified_at,
             c.photo_proof_mode, c.signature_proof_mode,
             (SELECT c.expires_at FROM delivery_otp_challenges c
              WHERE c.order_id = o.id AND c.consumed_at IS NULL AND c.revoked_at IS NULL
                AND c.expires_at > NOW()
              ORDER BY c.created_at DESC LIMIT 1) AS active_otp_expires_at
     FROM orders o
     JOIN companies c ON c.id = o.company_id
     LEFT JOIN order_payment_accounts pa ON pa.order_id = o.id
     LEFT JOIN delivery_proofs p ON p.order_id = o.id AND p.proof_type = 'otp'
     WHERE o.id = $1 AND o.company_id = $2 AND o.driver_id = $3`,
    [req.params.id, req.auth.company_id, req.auth.driver_id]
  );
  const order = result.rows[0];
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  const [incidents, evidence, runContext] = await Promise.all([
    pool.query(
      `SELECT id, category, severity, description, status, resolution, created_at, resolved_at
       FROM delivery_incidents WHERE order_id = $1 AND company_id = $2
       ORDER BY created_at DESC, id DESC`,
      [order.id, req.auth.company_id]
    ),
    pool.query(
      `SELECT id, evidence_type, mime_type, byte_size, created_at
       FROM delivery_evidence_files
       WHERE order_id = $1 AND company_id = $2 AND superseded_at IS NULL AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [order.id, req.auth.company_id]
    ),
    pool.query(
      `SELECT r.id, r.name, TO_CHAR(r.service_date, 'YYYY-MM-DD') AS service_date,
              r.status, s.id AS stop_id, s.sequence,
              (SELECT COUNT(*)::int FROM delivery_stops total
               WHERE total.run_id = r.id AND total.removed_at IS NULL) AS total_stops,
              (SELECT next_stop.order_id FROM delivery_stops next_stop
               JOIN orders next_order ON next_order.id = next_stop.order_id
               WHERE next_stop.run_id = r.id AND next_stop.removed_at IS NULL
                 AND next_stop.assignment_active = TRUE
                 AND NOT (next_order.status = ANY($4::text[]))
               ORDER BY next_stop.sequence ASC, next_stop.id ASC LIMIT 1) AS next_order_id
       FROM delivery_stops s
       JOIN delivery_runs r ON r.id = s.run_id AND r.company_id = s.company_id
       WHERE s.order_id = $1 AND s.company_id = $2 AND r.driver_id = $3
         AND s.removed_at IS NULL AND s.assignment_active = TRUE
         AND r.status IN ('planned', 'active')
       LIMIT 1`,
      [order.id, req.auth.company_id, req.auth.driver_id, terminalOrderStatuses]
    ),
  ]);
  return res.json({
    ...order,
    allowedTransitions: allowedOrderTransitions(order.status).filter((status) => driverTransitionTargets.includes(status)),
    isTerminal: terminalOrderStatuses.includes(order.status),
    incidents: incidents.rows,
    evidence: evidence.rows,
    run: runContext.rows[0] || null,
  });
}));

app.post('/api/driver/orders/:id/transition', requireDriverApi, asyncRoute(async (req, res) => {
  const toStatus = String(req.body.toStatus || '').trim();
  const reason = String(req.body.reason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  if (!driverTransitionTargets.includes(toStatus)) return res.status(403).json({ error: 'Cette étape doit être gérée par l’exploitation.' });
  if (reasonRequiredStatuses.includes(toStatus) && reason.length < 5) {
    return res.status(400).json({ error: 'Expliquez la raison en au moins 5 caractères.' });
  }
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), toStatus, reason }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status, version FROM orders
       WHERE id = $1 AND company_id = $2 AND driver_id = $3 FOR UPDATE`,
      [req.params.id, req.auth.company_id, req.auth.driver_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    const repeated = await client.query(
      `SELECT id, order_id, to_status, request_fingerprint FROM order_status_events
       WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_fingerprint !== fingerprint || String(repeated.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ orderId: order.id, status: repeated.rows[0].to_status, alreadyApplied: true });
    }
    if (!allowedOrderTransitions(order.status).includes(toStatus)) {
      throw Object.assign(new Error(`La commande est maintenant « ${order.status} ». Cette action n’est plus possible.`), { statusCode: 409 });
    }
    const event = await client.query(
      `INSERT INTO order_status_events (
         company_id, order_id, from_status, to_status, reason, actor_user_id,
         idempotency_key, request_fingerprint, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{"source":"driver_portal"}'::jsonb)
       RETURNING id`,
      [req.auth.company_id, order.id, order.status, toStatus, reason || null, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `UPDATE orders SET status = $1, version = version + 1, status_changed_at = NOW(), updated_at = NOW(),
         failure_reason = CASE WHEN $1 = ANY($2::text[]) THEN $3 ELSE failure_reason END
       WHERE id = $4`,
      [toStatus, reasonRequiredStatuses, reason || null, order.id]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'driver_status_changed',
         jsonb_build_object('from', $4::text, 'to', $5::text, 'eventId', $6::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, order.status, toStatus, event.rows[0].id]
    );
    await client.query('COMMIT');
    return res.json({ orderId: order.id, status: toStatus, version: Number(order.version) + 1 });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Driver transition error:', error.message);
    return res.status(500).json({ error: 'Impossible de mettre à jour cette livraison.' });
  } finally {
    client.release();
  }
}));

async function openDeliveryIncident(req, res, driverScoped = false) {
  const category = String(req.body.category || '').trim();
  const severity = String(req.body.severity || 'medium').trim();
  const description = String(req.body.description || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!incidentCategories.includes(category) || !['low', 'medium', 'high'].includes(severity)) {
    return res.status(400).json({ error: 'Type ou gravité d’incident invalide.' });
  }
  if (description.length < 5 || description.length > 2000 || !idempotencyKey) {
    return res.status(400).json({ error: 'Décrivez correctement l’incident et réessayez.' });
  }
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), category, severity, description }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id FROM orders WHERE id = $1 AND company_id = $2${driverScoped ? ' AND driver_id = $3' : ''} FOR UPDATE`,
      driverScoped ? [req.params.id, req.auth.company_id, req.auth.driver_id] : [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    const inserted = await client.query(
      `INSERT INTO delivery_incidents (
         company_id, order_id, category, severity, description, idempotency_key,
         request_fingerprint, opened_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING id, created_at`,
      [req.auth.company_id, order.id, category, severity, description, idempotencyKey, fingerprint, req.auth.user_id]
    );
    let incident = inserted.rows[0];
    if (!incident) {
      const existing = await client.query(
        `SELECT id, order_id, request_fingerprint, created_at FROM delivery_incidents
         WHERE company_id = $1 AND idempotency_key = $2`,
        [req.auth.company_id, idempotencyKey]
      );
      incident = existing.rows[0];
      if (!incident || String(incident.order_id) !== String(order.id) || incident.request_fingerprint !== fingerprint) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
    }
    await appendIncidentEvent(client, req.auth, incident.id, 'opened', description, { category, severity }, idempotencyKey);
    if (inserted.rows[0]) {
      await client.query(
        `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
         VALUES ($1, $2, 'order', $3, $4,
           jsonb_build_object('incidentId', $5::bigint, 'category', $6::text, 'severity', $7::text))`,
        [req.auth.company_id, req.auth.user_id, order.id,
          driverScoped ? 'driver_incident_opened' : 'incident_opened', incident.id, category, severity]
      );
    }
    await client.query('COMMIT');
    return res.status(inserted.rows[0] ? 201 : 200).json({
      id: incident.id, createdAt: incident.created_at, alreadyCreated: !inserted.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Incident creation error:', error.message);
    return res.status(500).json({ error: 'Impossible de déclarer cet incident.' });
  } finally {
    client.release();
  }
}

app.post('/api/driver/orders/:id/incidents', requireDriverApi, asyncRoute(async (req, res) => {
  return openDeliveryIncident(req, res, true);
}));

app.post('/api/driver/orders/:id/payment/collect', requireDriverApi, asyncRoute(async (req, res) => {
  return collectOrderPayment(req, res, true);
}));

app.post('/api/driver/orders/:id/otp/verify', requireDriverApi, asyncRoute(async (req, res) => {
  return verifyOrderOtp(req, res, true);
}));

async function saveOrderEvidence(req, res, driverScoped = false) {
  const evidenceType = String(req.params.type || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey || req.get('Idempotency-Key'));
  if (!evidenceTypes.includes(evidenceType)) return res.status(404).json({ error: 'Type de preuve introuvable.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Sélectionnez une image.' });
  const mimeType = detectedImageMime(req.file.buffer);
  if (!mimeType || !['image/jpeg', 'image/png'].includes(req.file.mimetype)) {
    return res.status(415).json({ error: 'Seules les images JPEG et PNG valides sont acceptées.' });
  }
  const contentSha256 = digest(req.file.buffer);
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), evidenceType, contentSha256 }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT o.id, o.status, c.photo_proof_mode, c.signature_proof_mode
       FROM orders o JOIN companies c ON c.id = o.company_id
       WHERE o.id = $1 AND o.company_id = $2${driverScoped ? ' AND o.driver_id = $3' : ''} FOR UPDATE OF o`,
      driverScoped ? [req.params.id, req.auth.company_id, req.auth.driver_id] : [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    const repeated = await client.query(
      `SELECT id, order_id, evidence_type, request_fingerprint, created_at
       FROM delivery_evidence_files WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      const previous = repeated.rows[0];
      if (String(previous.order_id) !== String(order.id) || previous.evidence_type !== evidenceType || previous.request_fingerprint !== fingerprint) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ id: previous.id, type: previous.evidence_type, createdAt: previous.created_at, alreadyUploaded: true });
    }
    if (!['En livraison', 'Arrivée'].includes(order.status)) {
      throw Object.assign(new Error('La preuve peut être ajoutée uniquement pendant la remise au client.'), { statusCode: 409 });
    }
    const configuredMode = evidenceType === 'photo' ? order.photo_proof_mode : order.signature_proof_mode;
    if (configuredMode === 'off') throw Object.assign(new Error('Cette preuve n’est pas activée par l’entreprise.'), { statusCode: 403 });
    await client.query(
      `UPDATE delivery_evidence_files SET superseded_at = NOW(), content = NULL
       WHERE order_id = $1 AND evidence_type = $2 AND superseded_at IS NULL AND deleted_at IS NULL`,
      [order.id, evidenceType]
    );
    const inserted = await client.query(
      `INSERT INTO delivery_evidence_files (
         company_id, order_id, evidence_type, mime_type, byte_size, content_sha256,
         content, uploaded_by_user_id, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at`,
      [req.auth.company_id, order.id, evidenceType, mimeType, req.file.size, contentSha256,
        req.file.buffer, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'delivery_evidence_uploaded',
         jsonb_build_object('evidenceId', $4::bigint, 'type', $5::text, 'mimeType', $6::text, 'byteSize', $7::int))`,
      [req.auth.company_id, req.auth.user_id, order.id, inserted.rows[0].id, evidenceType, mimeType, req.file.size]
    );
    await client.query('COMMIT');
    return res.status(201).json({ id: inserted.rows[0].id, type: evidenceType, createdAt: inserted.rows[0].created_at });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Delivery evidence upload error:', error.message);
    return res.status(500).json({ error: 'Impossible d’enregistrer cette preuve.' });
  } finally {
    client.release();
  }
}

app.post('/api/driver/orders/:id/evidence/:type', requireDriverApi, receiveEvidence, asyncRoute(async (req, res) => {
  return saveOrderEvidence(req, res, true);
}));

app.get('/api/driver/evidence/:id', requireDriverApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT e.mime_type, e.content FROM delivery_evidence_files e
     JOIN orders o ON o.id = e.order_id
     WHERE e.id = $1 AND e.company_id = $2 AND o.driver_id = $3
       AND e.superseded_at IS NULL AND e.deleted_at IS NULL`,
    [req.params.id, req.auth.company_id, req.auth.driver_id]
  );
  if (!result.rows[0]?.content) return res.status(404).json({ error: 'Preuve introuvable.' });
  res.set({ 'Content-Type': result.rows[0].mime_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  return res.send(result.rows[0].content);
}));

app.get('/api/app/settings/proofs', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT photo_proof_mode, signature_proof_mode FROM companies WHERE id = $1`,
    [req.auth.company_id]
  );
  return res.json(result.rows[0]);
}));

// --- Paramètres > Général : profil de l'entreprise ---
const companyTimezones = [
  'Africa/Porto-Novo', 'Africa/Abidjan', 'Africa/Accra', 'Africa/Lagos',
  'Africa/Lome', 'Africa/Ouagadougou', 'Africa/Dakar', 'Africa/Bamako',
  'Africa/Niamey', 'Africa/Douala', 'Africa/Kinshasa', 'UTC', 'Europe/Paris',
];

app.get('/api/app/company', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.slug, c.admin_email, c.timezone, c.created_at,
            (SELECT u.display_name FROM company_memberships m JOIN users u ON u.id = m.user_id
             WHERE m.company_id = c.id AND m.role = 'owner' ORDER BY m.id LIMIT 1) AS owner_name,
            (SELECT COUNT(*)::int FROM drivers d WHERE d.company_id = c.id AND d.active = TRUE AND d.archived_at IS NULL) AS active_drivers
     FROM companies c WHERE c.id = $1`,
    [req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Entreprise introuvable.' });
  return res.json({ ...result.rows[0], timezones: companyTimezones });
}));

app.patch('/api/app/company', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const slug = String(req.body.slug || '').trim().toLowerCase();
  const adminEmail = req.body.adminEmail == null || req.body.adminEmail === '' ? null : String(req.body.adminEmail).trim();
  const timezone = String(req.body.timezone || '').trim();
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Le nom de l’entreprise doit contenir entre 2 et 120 caractères.' });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 80) {
    return res.status(400).json({ error: 'Le nom d’espace ne peut contenir que des lettres minuscules, chiffres et tirets.' });
  }
  if (adminEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) return res.status(400).json({ error: 'E-mail administratif invalide.' });
  if (!companyTimezones.includes(timezone)) return res.status(400).json({ error: 'Fuseau horaire non pris en charge.' });
  try {
    const result = await pool.query(
      `UPDATE companies SET name = $1, slug = $2, admin_email = $3, timezone = $4, updated_at = NOW()
       WHERE id = $5 RETURNING id, name, slug, admin_email, timezone`,
      [name, slug, adminEmail, timezone, req.auth.company_id]
    );
    await writeAudit(req.auth, 'company', req.auth.company_id, 'profile_updated', { name, slug });
    return res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Ce nom d’espace est déjà utilisé.' });
    console.error('Company update error:', error.message);
    return res.status(500).json({ error: 'Impossible d’enregistrer le profil.' });
  }
}));

// --- Paramètres > Livraisons : règles opérationnelles ---
const deliverySettingKeys = ['validateBeforeTracking', 'driverAssignmentRequired', 'allowEditAfterValidation', 'customerFormEnabled', 'internalEntryEnabled', 'manualValidation'];
const defaultDeliverySettings = {
  validateBeforeTracking: true, driverAssignmentRequired: true, allowEditAfterValidation: false,
  customerFormEnabled: true, internalEntryEnabled: true, manualValidation: true,
};
function normalizeDeliverySettings(stored) {
  const out = { ...defaultDeliverySettings };
  if (stored && typeof stored === 'object') {
    for (const key of deliverySettingKeys) {
      if (typeof stored[key] === 'boolean') out[key] = stored[key];
    }
  }
  return out;
}
// Lit un réglage Livraisons d'une entreprise (best-effort : en cas d'erreur, on
// retombe sur la valeur par défaut, jamais bloquant faute de configuration).
async function companyDeliverySetting(companyId, key, queryable = pool) {
  try {
    const result = await queryable.query('SELECT delivery_settings FROM companies WHERE id = $1', [companyId]);
    return normalizeDeliverySettings(result.rows[0] && result.rows[0].delivery_settings)[key];
  } catch {
    return defaultDeliverySettings[key];
  }
}

app.get('/api/app/settings/deliveries', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT delivery_settings FROM companies WHERE id = $1', [req.auth.company_id]);
  return res.json(normalizeDeliverySettings(result.rows[0] && result.rows[0].delivery_settings));
}));

app.patch('/api/app/settings/deliveries', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const incoming = {};
  for (const key of deliverySettingKeys) {
    if (typeof req.body[key] === 'boolean') incoming[key] = req.body[key];
  }
  const merged = normalizeDeliverySettings(incoming);
  const result = await pool.query(
    `UPDATE companies SET delivery_settings = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING delivery_settings`,
    [JSON.stringify(merged), req.auth.company_id]
  );
  await writeAudit(req.auth, 'company', req.auth.company_id, 'delivery_settings_changed', merged);
  return res.json(normalizeDeliverySettings(result.rows[0].delivery_settings));
}));

// --- Paramètres > Facturation : plans d'abonnement ---
// Source de vérité des formules. Les remises de cycle sont configurables via
// l'environnement (hypothèses commerciales à valider avant production).
const billingCycleDiscounts = {
  monthly: 0,
  quarterly: Math.min(0.9, Math.max(0, Number(process.env.BILLING_DISCOUNT_QUARTERLY) || 0.05)),
  yearly: Math.min(0.9, Math.max(0, Number(process.env.BILLING_DISCOUNT_YEARLY) || 0.10)),
};
const billingPlans = [
  { code: 'trial', name: 'Essai gratuit', microcopy: 'Découvrez TRAXO sans engagement.', kind: 'trial', monthly: 0, max: 0, capacityLabel: 'pendant 3 jours', tag: 'Première connexion uniquement', cta: 'Commencer l’essai', features: ['Toutes les fonctionnalités essentielles', 'Suivi de flotte en temps réel', 'Support par e-mail'] },
  { code: 'flexible', name: 'Flexible', microcopy: 'Pour les petites flottes.', kind: 'per_driver', monthly: 1000, max: 9, capacityLabel: '1 à 9 livreurs', features: ['1 à 9 livreurs', 'Fonctionnalités essentielles', 'Suivi de flotte', 'Support standard'] },
  { code: 'equipe', name: 'Équipe', microcopy: 'Le meilleur choix pour votre flotte actuelle.', kind: 'flat', monthly: 10000, max: 12, capacityLabel: 'Jusqu’à 12 livreurs', features: ['Jusqu’à 12 livreurs', 'Fonctionnalités essentielles', 'Suivi de flotte avancé', 'Meilleur rapport capacité-prix', 'Support prioritaire'] },
  { code: 'croissance', name: 'Croissance', microcopy: 'Pour les flottes en expansion.', kind: 'flat', monthly: 18000, max: 25, capacityLabel: 'Jusqu’à 25 livreurs', features: ['Jusqu’à 25 livreurs', 'Fonctionnalités avancées', 'Suivi de flotte avancé', 'Rapports détaillés', 'Support prioritaire'] },
  { code: 'business', name: 'Business', microcopy: 'Pour les opérations structurées.', kind: 'flat', monthly: 30000, max: 50, capacityLabel: 'Jusqu’à 50 livreurs', compact: true, features: [] },
  { code: 'grande', name: 'Grande flotte', microcopy: 'Pour les grandes flottes et les besoins spécifiques.', kind: 'custom', monthly: null, max: null, capacityLabel: '51 livreurs et plus', compact: true, features: [] },
];
function recommendPlanCode(n) {
  const count = Number(n) || 0;
  if (count <= 9) return 'flexible';
  if (count <= 12) return 'equipe';
  if (count <= 25) return 'croissance';
  if (count <= 50) return 'business';
  return 'grande';
}
function planCapacity(code) {
  const plan = billingPlans.find((p) => p.code === code);
  return plan && plan.max != null ? plan.max : Infinity;
}

app.get('/api/app/billing/plans', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT plan_code, billing_cycle,
            (SELECT COUNT(*)::int FROM drivers d WHERE d.company_id = c.id AND d.active = TRUE AND d.archived_at IS NULL) AS active_drivers
     FROM companies c WHERE c.id = $1`,
    [req.auth.company_id]
  );
  const row = result.rows[0] || {};
  const activeDrivers = Number(row.active_drivers || 0);
  const recommended = recommendPlanCode(activeDrivers);
  return res.json({
    activeDrivers,
    recommended,
    currentPlan: row.plan_code || recommended,
    billingCycle: row.billing_cycle || 'monthly',
    discounts: billingCycleDiscounts,
    plans: billingPlans.map((p) => ({ ...p, max: p.max === null ? null : p.max })),
  });
}));

app.post('/api/app/billing/plan', requireCompanyApi, requireCompanyRoles('owner'), asyncRoute(async (req, res) => {
  const planCode = String(req.body.planCode || '');
  const billingCycle = String(req.body.billingCycle || 'monthly');
  const plan = billingPlans.find((p) => p.code === planCode);
  if (!plan || plan.kind === 'trial' || plan.kind === 'custom') {
    return res.status(400).json({ error: 'Cette formule ne peut pas être sélectionnée directement.' });
  }
  if (!Object.prototype.hasOwnProperty.call(billingCycleDiscounts, billingCycle)) {
    return res.status(400).json({ error: 'Périodicité invalide.' });
  }
  const drivers = await pool.query(
    'SELECT COUNT(*)::int AS n FROM drivers WHERE company_id = $1 AND active = TRUE AND archived_at IS NULL',
    [req.auth.company_id]
  );
  const activeDrivers = drivers.rows[0].n;
  if (activeDrivers > planCapacity(planCode)) {
    return res.status(409).json({ error: `Cette formule accepte moins de livreurs que vos ${activeDrivers} livreurs actifs. Archivez des livreurs ou choisissez une formule supérieure.` });
  }
  await pool.query('UPDATE companies SET plan_code = $1, billing_cycle = $2, updated_at = NOW() WHERE id = $3', [planCode, billingCycle, req.auth.company_id]);
  await writeAudit(req.auth, 'company', req.auth.company_id, 'plan_changed', { planCode, billingCycle });
  return res.json({ planCode, billingCycle });
}));

// --- Paramètres > Sécurité : compte utilisateur ---
app.get('/api/app/account/security', requireCompanyApi, asyncRoute(async (req, res) => {
  const [user, sessions] = await Promise.all([
    pool.query('SELECT password_changed_at, login_alerts FROM users WHERE id = $1', [req.auth.user_id]),
    pool.query('SELECT COUNT(*)::int AS n FROM app_sessions WHERE user_id = $1 AND expires_at > NOW()', [req.auth.user_id]),
  ]);
  const row = user.rows[0] || {};
  return res.json({
    passwordChangedAt: row.password_changed_at || null,
    loginAlerts: row.login_alerts !== false,
    activeSessions: sessions.rows[0].n,
    twoFactorEnabled: false,
  });
}));

app.get('/api/app/account/sessions', requireCompanyApi, asyncRoute(async (req, res) => {
  const currentHash = digest(String(parseCookies(req).delivery_session || ''));
  const result = await pool.query(
    `SELECT token_hash, user_agent, created_at, expires_at FROM app_sessions
     WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 50`,
    [req.auth.user_id]
  );
  return res.json(result.rows.map((row) => ({
    id: row.token_hash.slice(0, 12),
    current: row.token_hash === currentHash,
    userAgent: row.user_agent || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  })));
}));

app.post('/api/app/account/password', requireCompanyApi, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 10 || newPassword.length > 200) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 10 caractères.' });
  const user = await pool.query('SELECT password_salt, password_hash FROM users WHERE id = $1', [req.auth.user_id]);
  if (!user.rows[0] || !passwordMatches(currentPassword, user.rows[0].password_salt, user.rows[0].password_hash)) {
    return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const currentHash = digest(String(parseCookies(req).delivery_session || ''));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET password_salt = $1, password_hash = $2, password_changed_at = NOW() WHERE id = $3`,
      [salt, hashPassword(newPassword, salt), req.auth.user_id]
    );
    // Déconnecte les autres sessions par sécurité, garde la session courante.
    await client.query('DELETE FROM app_sessions WHERE user_id = $1 AND token_hash <> $2', [req.auth.user_id, currentHash]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Password change error:', error.message);
    return res.status(500).json({ error: 'Impossible de changer le mot de passe.' });
  } finally {
    client.release();
  }
  await writeAudit(req.auth, 'user', req.auth.user_id, 'password_changed', {});
  return res.json({ ok: true });
}));

app.patch('/api/app/account/preferences', requireCompanyApi, asyncRoute(async (req, res) => {
  if (typeof req.body.loginAlerts !== 'boolean') return res.status(400).json({ error: 'Préférence invalide.' });
  await pool.query('UPDATE users SET login_alerts = $1 WHERE id = $2', [req.body.loginAlerts, req.auth.user_id]);
  return res.json({ loginAlerts: req.body.loginAlerts });
}));

app.patch('/api/app/settings/proofs', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const photoMode = String(req.body.photoMode || 'off');
  const signatureMode = String(req.body.signatureMode || 'off');
  if (!evidenceModes.includes(photoMode) || !evidenceModes.includes(signatureMode)) {
    return res.status(400).json({ error: 'Règle de preuve invalide.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE companies SET photo_proof_mode = $1, signature_proof_mode = $2, updated_at = NOW()
       WHERE id = $3 RETURNING photo_proof_mode, signature_proof_mode`,
      [photoMode, signatureMode, req.auth.company_id]
    );
    const audit = await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'company', $1, 'proof_policy_changed', jsonb_build_object('photoMode', $3::text, 'signatureMode', $4::text))
       RETURNING id`,
      [req.auth.company_id, req.auth.user_id, photoMode, signatureMode]
    );
    await client.query('COMMIT');
    return res.json({ ...result.rows[0], auditId: audit.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Proof policy update error:', error.message);
    return res.status(500).json({ error: 'Impossible d’enregistrer les règles de preuve.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/evidence/:type', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), receiveEvidence, asyncRoute(async (req, res) => {
  return saveOrderEvidence(req, res);
}));

app.get('/api/app/evidence/:id', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT mime_type, content FROM delivery_evidence_files
     WHERE id = $1 AND company_id = $2 AND superseded_at IS NULL AND deleted_at IS NULL`,
    [req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]?.content) return res.status(404).json({ error: 'Preuve introuvable.' });
  res.set({ 'Content-Type': result.rows[0].mime_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  return res.send(result.rows[0].content);
}));

app.get('/api/app/summary', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE archived_at IS NULL) AS active_requests,
            COUNT(*) FILTER (WHERE status = 'À vérifier' AND archived_at IS NULL) AS to_review,
            (SELECT COUNT(*) FROM orders WHERE company_id = $1) AS orders,
            (SELECT COUNT(*) FROM drivers WHERE company_id = $1) AS drivers,
            (SELECT COUNT(*) FROM delivery_runs WHERE company_id = $1 AND status IN ('draft', 'planned', 'active')) AS open_runs,
            (SELECT COUNT(*) FROM delivery_incidents WHERE company_id = $1 AND status = 'open') AS open_incidents,
            (SELECT COUNT(*) FROM order_retention_holds WHERE company_id = $1 AND status = 'active' AND review_due_at < NOW()) AS overdue_holds
     FROM customer_requests WHERE company_id = $1`,
    [req.auth.company_id]
  );
  return res.json(result.rows[0]);
}));

// Construit la liste des notifications actionnables d'une entreprise.
async function buildNotificationItems(cid) {
  const [reqs, unassigned, incidents, runs, relaunch] = await Promise.all([
    pool.query(
      `SELECT id, customer_name, created_at FROM customer_requests
       WHERE company_id = $1 AND archived_at IS NULL AND status = 'À vérifier'
       ORDER BY created_at DESC LIMIT 12`,
      [cid]
    ),
    pool.query(
      `SELECT id, customer_name, reference, created_at FROM orders
       WHERE company_id = $1 AND driver_id IS NULL AND status <> ALL($2::text[])
       ORDER BY created_at DESC LIMIT 12`,
      [cid, terminalOrderStatuses]
    ),
    pool.query(
      `SELECT i.id, i.created_at, o.customer_name FROM delivery_incidents i
       LEFT JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
       WHERE i.company_id = $1 AND i.status = 'open'
       ORDER BY i.created_at DESC LIMIT 12`,
      [cid]
    ),
    pool.query(
      `SELECT id, name, created_at FROM delivery_runs
       WHERE company_id = $1 AND status = 'draft'
       ORDER BY created_at DESC LIMIT 12`,
      [cid]
    ),
    // Clients « à relancer » : même dérivation d'étape que la liste CRM
    // (surcharge manuelle prioritaire, sinon stade auto selon l'ancienneté
    // de la dernière commande). Garder aligné avec l'API /crm/customers.
    pool.query(
      `WITH base AS (
         SELECT c.id, c.display_name, c.pipeline_stage, c.created_at,
           (SELECT MAX(o.created_at) FROM orders o WHERE o.company_id = c.company_id AND o.customer_id = c.id) AS last_order_at,
           (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.company_id AND o.customer_id = c.id) AS order_count
         FROM customers c
         WHERE c.company_id = $1 AND c.status NOT IN ('archived', 'merged', 'anonymized')
       ), staged AS (
         SELECT id, display_name, last_order_at,
           COALESCE(NULLIF(pipeline_stage, ''), CASE
             WHEN last_order_at IS NULL AND created_at >= NOW() - INTERVAL '30 days' THEN 'nouveau'
             WHEN last_order_at IS NULL THEN 'inactif'
             WHEN created_at >= NOW() - INTERVAL '21 days' AND order_count <= 2 THEN 'nouveau'
             WHEN last_order_at >= NOW() - INTERVAL '30 days' THEN 'actif'
             WHEN last_order_at >= NOW() - INTERVAL '90 days' THEN 'a_relancer'
             ELSE 'inactif' END) AS stage
         FROM base
       )
       SELECT id, display_name, last_order_at FROM staged
       WHERE stage = 'a_relancer'
       ORDER BY last_order_at ASC NULLS LAST LIMIT 12`,
      [cid]
    ),
  ]);
  const items = [];
  for (const r of reqs.rows) items.push({ id: `request-${r.id}`, type: 'requests', title: 'Nouvelle demande à vérifier', summary: r.customer_name || 'Client à préciser', at: r.created_at, href: `/app/demandes/${r.id}` });
  for (const o of unassigned.rows) items.push({ id: `order-${o.id}`, type: 'unassigned', title: 'Commande à affecter', summary: [o.reference, o.customer_name].filter(Boolean).join(' · ') || `Commande n° ${o.id}`, at: o.created_at, href: `/app/commandes/${o.id}` });
  for (const i of incidents.rows) items.push({ id: `incident-${i.id}`, type: 'incidents', title: 'Incident ouvert', summary: i.customer_name ? `Commande de ${i.customer_name}` : `Incident n° ${i.id}`, at: i.created_at, href: `/app/incidents/${i.id}` });
  for (const r of runs.rows) items.push({ id: `run-${r.id}`, type: 'runs', title: 'Tournée à planifier', summary: r.name || `Tournée n° ${r.id}`, at: r.created_at, href: `/app/tournees/${r.id}` });
  for (const c of relaunch.rows) items.push({ id: `relaunch-${c.id}`, type: 'relaunch', title: 'Client à relancer', summary: c.display_name || `Client n° ${c.id}`, at: c.last_order_at || new Date(0).toISOString(), href: `/app/clients/${c.id}` });
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return items.slice(0, 20);
}

// --- E-mail — indépendant du fournisseur (SMTP standard, ou Resend en repli) ---
// Inactif tant qu'aucun fournisseur n'est configuré. Pour activer : renseigner
// les variables SMTP_* (Brevo, Amazon SES, Mailgun…) ou RESEND_API_KEY.
const smtpConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
function emailConfigured() {
  return smtpConfigured() || Boolean(process.env.BREVO_API_KEY) || Boolean(process.env.RESEND_API_KEY);
}
function emailFrom() { return process.env.EMAIL_FROM || 'TRAXO <notifications@gettraxo.app>'; }
function escHtmlServer(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
// Sépare « Nom <email> » (ou un simple « email ») en { name, email }.
function parseAddress(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/);
  if (match) return { name: match[1] || undefined, email: match[2] };
  return { email: raw };
}
let mailTransport = null;
function getMailTransport() {
  if (mailTransport) return mailTransport;
  if (!smtpConfigured()) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Échoue vite si le port SMTP est filtré (fréquent sur les hébergeurs cloud)
    // au lieu d'attendre 2 min ; on bascule alors sur l'API HTTP si disponible.
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 15000,
  });
  return mailTransport;
}
// Envoi via l'API HTTP de Brevo (port 443, jamais bloqué par l'hébergeur).
async function sendViaBrevoApi({ from, to, subject, html, text }) {
  const sender = parseAddress(from);
  const recipient = parseAddress(to);
  await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { email: sender.email, name: sender.name || 'TRAXO' },
    to: [{ email: recipient.email }],
    subject,
    htmlContent: html,
    textContent: text,
  }, {
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    timeout: 10000,
  });
}
// Envoi : API Brevo en priorité si configurée (HTTP 443, fiable sur Railway où
// les ports SMTP sont bloqués), sinon SMTP standard, sinon Resend ;
// no-op « email_not_configured » si rien n'est configuré.
async function sendEmail({ to, subject, html, text }) {
  if (!to) return { sent: false, reason: 'no_recipient' };
  const from = emailFrom();
  if (process.env.BREVO_API_KEY) {
    try {
      await sendViaBrevoApi({ from, to, subject, html, text });
      return { sent: true, via: 'brevo_api' };
    } catch (error) {
      return { sent: false, reason: 'send_failed', detail: error.response?.data || error.message };
    }
  }
  const transport = getMailTransport();
  if (transport) {
    try {
      await transport.sendMail({ from, to, subject, html, text });
      return { sent: true, via: 'smtp' };
    } catch (error) {
      return { sent: false, reason: 'send_failed', detail: error.message };
    }
  }
  if (process.env.RESEND_API_KEY) {
    try {
      await axios.post('https://api.resend.com/emails', { from, to, subject, html, text }, {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      return { sent: true, via: 'resend' };
    } catch (error) {
      return { sent: false, reason: 'send_failed', detail: error.response?.data || error.message };
    }
  }
  return { sent: false, reason: 'email_not_configured' };
}
// URL publique de l'app (variable APP_BASE_URL, sinon dérivée de la requête).
function publicBaseUrl(req) {
  const fromEnv = String(process.env.APP_BASE_URL || '').trim();
  const base = fromEnv || (req && req.get ? `${req.protocol}://${req.get('host')}` : '');
  return base.replace(/\/+$/, '');
}
// Gabarit d'e-mail brandé, partagé par tous les envois (table-based, compatible
// clients mail). En-tête avec le logo TRAXO, corps, bouton d'action, pied.
function renderEmailShell({ baseUrl = '', heading = '', introHtml = '', bodyHtml = '', ctaLabel, ctaUrl, footerNote = '' }) {
  const logo = baseUrl
    ? `<img src="${escHtmlServer(baseUrl)}/brand/traxo-email.png" width="128" alt="TRAXO" style="display:block;border:0;height:auto;line-height:100%;outline:none;text-decoration:none">`
    : `<span style="font-family:Arial,sans-serif;font-weight:900;font-size:24px;letter-spacing:.06em;color:#111827">TRAXO</span>`;
  const cta = (ctaLabel && ctaUrl)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr>
         <td style="border-radius:12px;background:#111111"><a href="${escHtmlServer(ctaUrl)}" style="display:inline-block;padding:13px 26px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px">${escHtmlServer(ctaLabel)}</a></td>
       </tr></table>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6fa">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#ffffff;border:1px solid #e6eaf0;border-radius:16px;overflow:hidden">
      <tr><td style="padding:22px 28px;border-bottom:1px solid #eef1f5">${logo}</td></tr>
      <tr><td style="padding:26px 28px 8px">
        <h1 style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:20px;line-height:1.3;color:#111827">${escHtmlServer(heading)}</h1>
        ${introHtml ? `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#475467">${introHtml}</div>` : ''}
      </td></tr>
      <tr><td style="padding:6px 28px 26px">${bodyHtml}${cta}</td></tr>
      <tr><td style="padding:18px 28px;background:#fafbfc;border-top:1px solid #eef1f5">
        <p style="margin:0;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#98a2b3">${footerNote ? escHtmlServer(footerNote) + '<br>' : ''}TRAXO — Suivi de livraison en temps réel. Cet e-mail provient de votre espace TRAXO.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}
// Construit le digest e-mail des actions en attente d'une entreprise.
async function buildCompanyDigest(cid, appBaseUrl = '') {
  const items = await buildNotificationItems(cid);
  if (!items.length) return null;
  const baseUrl = String(appBaseUrl || '').replace(/\/+$/, '');
  const rows = items.map((it) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border:1px solid #eef1f5;border-radius:12px"><tr><td style="padding:12px 14px">
    <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#111827">${escHtmlServer(it.title)}</div>
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#667085;margin-top:2px">${escHtmlServer(it.summary)}</div>
    ${baseUrl ? `<a href="${escHtmlServer(baseUrl + it.href)}" style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#e11d2a;text-decoration:none">Ouvrir →</a>` : ''}
  </td></tr></table>`).join('');
  const label = `${items.length} action${items.length > 1 ? 's' : ''} en attente`;
  const html = renderEmailShell({
    baseUrl,
    heading: `Vous avez ${label}`,
    introHtml: 'Voici le récapitulatif des actions à traiter dans votre espace TRAXO.',
    bodyHtml: rows,
    ctaLabel: baseUrl ? 'Ouvrir TRAXO' : undefined,
    ctaUrl: baseUrl ? `${baseUrl}/app` : undefined,
  });
  const text = items.map((it) => `- ${it.title} : ${it.summary}`).join('\n');
  return { count: items.length, subject: `TRAXO — ${label}`, html, text };
}

app.get('/api/app/notifications', requireCompanyApi, asyncRoute(async (req, res) => {
  const items = await buildNotificationItems(req.auth.company_id);
  return res.json({ items, generatedAt: new Date().toISOString() });
}));

// Digest e-mail à la demande. Reste inactif (sent:false, reason:
// email_not_configured) tant qu'aucun fournisseur n'est configuré.
app.post('/api/app/notifications/digest', requireCompanyApi, asyncRoute(async (req, res) => {
  if (!['owner', 'manager'].includes(req.auth.role)) return res.status(403).json({ error: 'Réservé aux responsables.' });
  const digest = await buildCompanyDigest(req.auth.company_id, publicBaseUrl(req));
  if (!digest) return res.json({ sent: false, reason: 'nothing_to_send', count: 0, configured: emailConfigured() });
  const company = await pool.query('SELECT admin_email FROM companies WHERE id = $1', [req.auth.company_id]);
  const to = company.rows[0]?.admin_email || null;
  const result = await sendEmail({ to, subject: digest.subject, html: digest.html, text: digest.text });
  return res.json({ ...result, count: digest.count, configured: emailConfigured(), recipient: to });
}));

app.get('/api/app/crm/customers', requireCompanyApi, asyncRoute(async (req, res) => {
  const pageNumber = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const query = String(req.query.q || '').trim().slice(0, 120);
  const allowedStatuses = ['active', 'do_not_contact', 'archived', 'merged', 'anonymized'];
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'État client invalide.' });
  }
  const allowedStages = ['nouveau', 'actif', 'a_relancer', 'inactif'];
  const stage = req.query.stage && allowedStages.includes(String(req.query.stage)) ? String(req.query.stage) : null;
  const sortMap = {
    recent: 'last_activity_at DESC NULLS LAST, updated_at DESC, id DESC',
    oldest: 'last_activity_at ASC NULLS FIRST, id ASC',
    name: 'display_name ASC, id ASC',
    orders: 'order_count DESC, id DESC',
  };
  const sort = sortMap[String(req.query.sort)] ? String(req.query.sort) : 'recent';

  const result = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
    const values = [req.auth.company_id, query ? `%${query}%` : null, status];
    const filters = `c.company_id = $1
      AND ($2::text IS NULL OR c.display_name ILIKE $2 OR EXISTS (
        SELECT 1 FROM customer_contacts search_contact
        WHERE search_contact.company_id = c.company_id
          AND search_contact.customer_id = c.id
          AND search_contact.is_active = TRUE
          AND search_contact.value_display ILIKE $2
      ))
      AND ($3::text IS NULL OR c.status = $3)
      -- Par défaut on masque les fiches archivées/fusionnées/anonymisées ;
      -- elles restent accessibles via un filtre de statut explicite.
      AND ($3::text IS NOT NULL OR c.status NOT IN ('archived', 'merged', 'anonymized'))`;
    // Stade d'engagement dérivé (Nouveau / Actif / À relancer / Inactif) à partir de
    // l'ancienneté de la dernière commande, de la date de création et du nombre de
    // commandes — distinct de c.status (actif/ne pas contacter/archivé).
    const baseCte = `
      WITH base AS (
        SELECT c.id, c.customer_code, c.customer_type, c.sector, c.pipeline_stage,
               c.display_name, c.status, c.created_at, c.updated_at,
               primary_contact.value_display AS primary_phone,
               loc.locality AS primary_locality, loc.neighborhood AS primary_neighborhood,
               lastord.status AS last_order_status, lastord.created_at AS last_order_at,
               COUNT(DISTINCT o.id)::int AS order_count,
               COUNT(DISTINCT l.id) FILTER (WHERE l.is_active = TRUE)::int AS location_count,
               COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'open')::int AS open_incident_count
        FROM customers c
        LEFT JOIN LATERAL (
          SELECT cc.value_display FROM customer_contacts cc
          WHERE cc.company_id = c.company_id AND cc.customer_id = c.id
            AND cc.kind = 'phone' AND cc.is_active = TRUE
          ORDER BY cc.is_primary DESC, cc.id ASC LIMIT 1
        ) primary_contact ON TRUE
        LEFT JOIN LATERAL (
          SELECT cl.locality, cl.neighborhood FROM customer_locations cl
          WHERE cl.company_id = c.company_id AND cl.customer_id = c.id AND cl.is_active = TRUE
          ORDER BY cl.last_used_at DESC NULLS LAST, cl.id DESC LIMIT 1
        ) loc ON TRUE
        LEFT JOIN LATERAL (
          SELECT o2.status, o2.created_at FROM orders o2
          WHERE o2.company_id = c.company_id AND o2.customer_id = c.id
          ORDER BY o2.created_at DESC LIMIT 1
        ) lastord ON TRUE
        LEFT JOIN orders o ON o.company_id = c.company_id AND o.customer_id = c.id
        LEFT JOIN customer_locations l ON l.company_id = c.company_id AND l.customer_id = c.id
        LEFT JOIN delivery_incidents i ON i.company_id = c.company_id AND i.order_id = o.id
        WHERE ${filters}
        GROUP BY c.id, primary_contact.value_display, loc.locality, loc.neighborhood, lastord.status, lastord.created_at
      ),
      auto AS (
        SELECT *,
          COALESCE(last_order_at, created_at) AS last_activity_at,
          CASE
            WHEN last_order_at IS NULL AND created_at >= NOW() - INTERVAL '30 days' THEN 'nouveau'
            WHEN last_order_at IS NULL THEN 'inactif'
            WHEN created_at >= NOW() - INTERVAL '21 days' AND order_count <= 2 THEN 'nouveau'
            WHEN last_order_at >= NOW() - INTERVAL '30 days' THEN 'actif'
            WHEN last_order_at >= NOW() - INTERVAL '90 days' THEN 'a_relancer'
            ELSE 'inactif'
          END AS auto_stage
        FROM base
      ),
      staged AS (
        SELECT *,
          -- Surcharge manuelle (glisser-déposer) prioritaire sur le stade auto.
          COALESCE(NULLIF(pipeline_stage, ''), auto_stage) AS stage,
          CASE WHEN NULLIF(pipeline_stage, '') IS NOT NULL THEN 'manual' ELSE 'auto' END AS stage_source
        FROM auto
      )`;
    const stageFilter = stage ? ` WHERE stage = $${values.length + 1}` : '';
    const scopedValues = stage ? [...values, stage] : values;
    const listValues = [...scopedValues, limit, (pageNumber - 1) * limit];
    const [countResult, rowsResult, stageCountsResult] = await Promise.all([
      client.query(`${baseCte} SELECT COUNT(*)::int AS total FROM staged${stageFilter}`, scopedValues),
      client.query(`${baseCte} SELECT * FROM staged${stageFilter} ORDER BY ${sortMap[sort]} LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues),
      client.query(`${baseCte} SELECT stage, COUNT(*)::int AS total FROM staged GROUP BY stage`, values),
    ]);
    const stageCounts = { nouveau: 0, actif: 0, a_relancer: 0, inactif: 0 };
    for (const row of stageCountsResult.rows) if (row.stage in stageCounts) stageCounts[row.stage] = row.total;
    return { total: countResult.rows[0].total, customers: rowsResult.rows, stageCounts };
  });
  const totalPages = Math.max(1, Math.ceil(result.total / limit));
  return res.json({
    customers: result.customers,
    stageCounts: result.stageCounts,
    pagination: {
      page: pageNumber,
      limit,
      total: result.total,
      totalPages,
      hasPrevious: pageNumber > 1,
      hasNext: pageNumber < totalPages,
      sort,
      stage,
    },
  });
}));

// Création manuelle d'un client depuis le CRM (bouton « Nouveau client »).
app.post('/api/app/crm/customers', requireCompanyApi, asyncRoute(async (req, res) => {
  const displayName = String(req.body?.displayName ?? req.body?.display_name ?? '').trim().slice(0, 200);
  if (!displayName) return res.status(400).json({ error: 'Le nom du client est requis.' });
  const sector = String(req.body?.sector ?? req.body?.customerType ?? req.body?.customer_type ?? '').trim().slice(0, 120) || null;
  const phone = String(req.body?.phone ?? '').trim().slice(0, 320);
  // Validation du téléphone : rejette la saisie sans chiffres exploitables
  // (ex. « essai »), source de fiches parasites.
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 6) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  }
  const created = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
    const inserted = await client.query(
      `INSERT INTO customers (company_id, customer_code, sector, display_name, status,
         created_by_user_id, updated_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $5, NOW(), NOW())
       RETURNING id`,
      [req.auth.company_id, `MANUAL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, sector, displayName, req.auth.user_id || null]
    );
    const id = inserted.rows[0].id;
    await client.query(
      `UPDATE customers SET customer_code = $1 WHERE id = $2 AND company_id = $3`,
      [`CL-${String(id).padStart(4, '0')}`, id, req.auth.company_id]
    );
    if (phone) {
      await client.query(
        `INSERT INTO customer_contacts (company_id, customer_id, kind, value_display, value_normalized,
           is_primary, created_by_user_id, updated_by_user_id)
         VALUES ($1, $2, 'phone', $3, $4, TRUE, $5, $5)`,
        [req.auth.company_id, id, phone, phone.replace(/[^\d+]/g, ''), req.auth.user_id || null]
      );
    }
    return id;
  });
  return res.status(201).json({ id: created, customer_code: `CL-${String(created).padStart(4, '0')}` });
}));

// Mise à jour légère d'un client : stade de pipeline (glisser-déposer) et/ou
// statut (archivage). pipelineStage = null réinitialise en mode auto.
app.patch('/api/app/crm/customers/:id', requireCompanyApi, asyncRoute(async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId < 1) return res.status(404).json({ error: 'Client introuvable.' });
  const sets = [];
  const values = [];
  if ('pipelineStage' in (req.body || {})) {
    const raw = req.body.pipelineStage;
    if (raw === null || raw === '') {
      sets.push(`pipeline_stage = NULL`);
    } else if (['nouveau', 'actif', 'a_relancer', 'inactif'].includes(String(raw))) {
      values.push(String(raw));
      sets.push(`pipeline_stage = $${values.length}`);
    } else {
      return res.status(400).json({ error: 'Stade de pipeline invalide.' });
    }
  }
  if ('status' in (req.body || {})) {
    const status = String(req.body.status);
    if (!['active', 'archived', 'do_not_contact'].includes(status)) {
      return res.status(400).json({ error: 'Statut client invalide.' });
    }
    values.push(status);
    sets.push(`status = $${values.length}`);
  }
  if ('displayName' in (req.body || {})) {
    const name = String(req.body.displayName || '').trim();
    if (name.length < 1 || name.length > 160) return res.status(400).json({ error: 'Le nom doit contenir entre 1 et 160 caractères.' });
    values.push(name);
    sets.push(`display_name = $${values.length}`);
  }
  if ('sector' in (req.body || {})) {
    const sector = String(req.body.sector || '').trim();
    if (sector.length > 120) return res.status(400).json({ error: 'Secteur trop long (120 caractères max).' });
    values.push(sector || null);
    sets.push(`sector = $${values.length}`);
  }
  if ('serviceNotes' in (req.body || {})) {
    const notes = String(req.body.serviceNotes || '').trim();
    if (notes.length > 2000) return res.status(400).json({ error: 'Notes trop longues (2000 caractères max).' });
    values.push(notes || null);
    sets.push(`service_notes = $${values.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Aucune modification fournie.' });
  values.push(req.auth.user_id || null);
  const updatedBy = `$${values.length}`;
  values.push(customerId);
  const idParam = `$${values.length}`;
  values.push(req.auth.company_id);
  const companyParam = `$${values.length}`;
  const result = await withCompanyTransaction(pool, req.auth.company_id, async (client) => client.query(
    `UPDATE customers SET ${sets.join(', ')}, updated_by_user_id = ${updatedBy}, updated_at = NOW(), version = version + 1
     WHERE id = ${idParam} AND company_id = ${companyParam} RETURNING id`,
    values
  ));
  if (!result.rows[0]) return res.status(404).json({ error: 'Client introuvable.' });
  return res.json({ id: result.rows[0].id });
}));

// Doublons potentiels d'un client : autres fiches partageant un téléphone
// normalisé identique.
app.get('/api/app/crm/customers/:id/duplicates', requireCompanyApi, asyncRoute(async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId < 1) return res.status(404).json({ error: 'Client introuvable.' });
  const rows = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
    const result = await client.query(
      `WITH me AS (
         SELECT DISTINCT value_normalized FROM customer_contacts
         WHERE company_id = $1 AND customer_id = $2 AND kind = 'phone'
           AND is_active = TRUE AND value_normalized IS NOT NULL AND value_normalized <> ''
       )
       SELECT c.id, c.customer_code, c.display_name, c.status,
              MIN(cc.value_display) AS primary_phone,
              (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.company_id AND o.customer_id = c.id)::int AS order_count
       FROM customers c
       JOIN customer_contacts cc ON cc.company_id = c.company_id AND cc.customer_id = c.id
         AND cc.kind = 'phone' AND cc.is_active = TRUE
       WHERE c.company_id = $1 AND c.id <> $2
         AND c.status NOT IN ('merged', 'anonymized')
         AND cc.value_normalized IN (SELECT value_normalized FROM me)
       GROUP BY c.id
       ORDER BY order_count DESC, c.id ASC
       LIMIT 20`,
      [req.auth.company_id, customerId]
    );
    return result.rows;
  });
  return res.json({ duplicates: rows });
}));

// Fusion douce : bascule l'historique (commandes, demandes) du doublon vers la
// fiche cible et marque le doublon « merged » (redirection). Ne re-parente pas
// les contacts/lieux (FK composites) : approche sûre pour le MVP.
app.post('/api/app/crm/customers/:id/merge', requireCompanyApi, asyncRoute(async (req, res) => {
  const targetId = Number(req.params.id);
  const sourceId = Number(req.body?.sourceId);
  if (!Number.isInteger(targetId) || targetId < 1) return res.status(404).json({ error: 'Fiche cible introuvable.' });
  if (!Number.isInteger(sourceId) || sourceId < 1) return res.status(400).json({ error: 'Doublon invalide.' });
  if (targetId === sourceId) return res.status(400).json({ error: 'Impossible de fusionner une fiche avec elle-même.' });
  try {
    const merged = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
      const both = await client.query(
        `SELECT id, status FROM customers WHERE company_id = $1 AND id IN ($2, $3) FOR UPDATE`,
        [req.auth.company_id, targetId, sourceId]
      );
      const target = both.rows.find((row) => row.id === targetId);
      const source = both.rows.find((row) => row.id === sourceId);
      if (!target || !source) { const err = new Error('Fiche introuvable.'); err.code = 'NOT_FOUND'; throw err; }
      if (target.status === 'merged') { const err = new Error('La fiche cible est déjà fusionnée.'); err.code = 'BAD'; throw err; }
      if (source.status === 'merged') { const err = new Error('Ce doublon est déjà fusionné.'); err.code = 'BAD'; throw err; }
      await client.query(`UPDATE orders SET customer_id = $1 WHERE company_id = $2 AND customer_id = $3`, [targetId, req.auth.company_id, sourceId]);
      await client.query(`UPDATE customer_requests SET customer_id = $1 WHERE company_id = $2 AND customer_id = $3`, [targetId, req.auth.company_id, sourceId]);
      await client.query(
        `UPDATE customers SET status = 'merged', merged_into_customer_id = $1,
           updated_by_user_id = $2, updated_at = NOW(), version = version + 1
         WHERE company_id = $3 AND id = $4`,
        [targetId, req.auth.user_id || null, req.auth.company_id, sourceId]
      );
      return { targetId, sourceId };
    });
    return res.json({ ok: true, ...merged });
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
    if (error.code === 'BAD') return res.status(409).json({ error: error.message });
    throw error;
  }
}));

app.get('/api/app/crm/customers/:id', requireCompanyApi, asyncRoute(async (req, res) => {
  const customerId = Number(req.params.id);
  if (!Number.isInteger(customerId) || customerId < 1) return res.status(404).json({ error: 'Client introuvable.' });
  const result = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
    const customer = await client.query(
      `SELECT id, customer_code, customer_type, sector, display_name, status,
              preferred_language, service_notes, created_at, updated_at
       FROM customers WHERE id = $1 AND company_id = $2`,
      [customerId, req.auth.company_id]
    );
    if (!customer.rows[0]) return null;
    const interactionVisibility = ['owner', 'manager'].includes(req.auth.role)
      ? ['operations', 'manager', 'dispute']
      : ['operations'];
    const [contacts, locations, orders, interactions] = await Promise.all([
      client.query(
        `SELECT id, kind, label, contact_name, value_display, is_primary,
                is_active, verified_at, created_at, updated_at
         FROM customer_contacts
         WHERE company_id = $1 AND customer_id = $2 AND anonymized_at IS NULL
         ORDER BY is_primary DESC, is_active DESC, id ASC`,
        [req.auth.company_id, customerId]
      ),
      client.query(
        `SELECT id, label, neighborhood, locality, address_text, landmark,
                delivery_instructions, verified_at, last_used_at, is_active,
                archived_at, created_at, updated_at
         FROM customer_locations
         WHERE company_id = $1 AND customer_id = $2 AND anonymized_at IS NULL
         ORDER BY is_active DESC, last_used_at DESC NULLS LAST, id DESC`,
        [req.auth.company_id, customerId]
      ),
      client.query(
        `SELECT o.id, o.reference, o.status, o.neighborhood, o.landmark, o.created_at,
                o.updated_at, d.name AS driver_name
         FROM orders o JOIN drivers d ON d.id = o.driver_id AND d.company_id = o.company_id
         WHERE o.company_id = $1 AND o.customer_id = $2
         ORDER BY o.created_at DESC, o.id DESC LIMIT 100`,
        [req.auth.company_id, customerId]
      ),
      client.query(
        `SELECT id, channel, direction, purpose, outcome, summary,
                occurred_at, next_action_at, visibility
         FROM customer_interactions
         WHERE company_id = $1 AND customer_id = $2 AND anonymized_at IS NULL
           AND visibility = ANY($3::text[])
         ORDER BY occurred_at DESC, id DESC LIMIT 100`,
        [req.auth.company_id, customerId, interactionVisibility]
      ),
    ]);
    return {
      customer: customer.rows[0],
      contacts: contacts.rows,
      locations: locations.rows,
      orders: orders.rows,
      interactions: interactions.rows,
    };
  });
  if (!result) return res.status(404).json({ error: 'Client introuvable.' });
  return res.json(result);
}));

// --- CRM secure export (XLSX) ------------------------------------------------
// Read-only. The export contract (lib/crm-export-contract.js) validates the
// request, enforces role/period/column rules and formula neutralization; the
// generator (lib/crm-xlsx.js) writes the workbook. Only the `operations`
// dataset is wired for now; other datasets are validated by the contract but
// their queries are not implemented yet.


async function recordExportLog(auth, contract, status, outcome = {}) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO export_logs
         (company_id, actor_user_id, dataset, role, status, purpose, period_from, period_to,
          columns, filters, row_count, worksheet_count, artifact_bytes, artifact_sha256,
          request_fingerprint_sha256, failure_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        auth?.company_id || null,
        auth?.user_id || null,
        contract?.dataset || outcome.dataset || 'unknown',
        contract?.role || auth?.role || 'unknown',
        status,
        contract?.purpose || null,
        contract?.period?.from || null,
        contract?.period?.to || null,
        contract ? JSON.stringify(contract.columns) : null,
        contract ? JSON.stringify(contract.filters) : null,
        Number.isInteger(outcome.rowCount) ? outcome.rowCount : null,
        Number.isInteger(outcome.worksheetCount) ? outcome.worksheetCount : null,
        Number.isInteger(outcome.artifactBytes) ? outcome.artifactBytes : null,
        outcome.artifactSha256 || null,
        contract?.requestFingerprintSha256 || null,
        outcome.failureCode || null,
      ]
    );
  } catch (error) {
    // An export audit failure must not break the response, but should be visible.
    console.warn('Échec d’écriture du journal d’export :', error.message);
  }
}

// Sérialise les lignes normalisées de l'export en CSV (RFC 4180), avec BOM
// UTF-8 pour qu'Excel ouvre les accents correctement. En-têtes = clés de colonnes.
function buildExportCsv(columns, rows) {
  const esc = (value) => {
    const s = value == null ? '' : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(esc).join(',');
  const body = rows.map((row) => columns.map((column) => esc(row[column])).join(',')).join('\r\n');
  return `﻿${header}${body ? `\r\n${body}` : ''}`;
}

app.post('/api/app/crm/exports', requireCompanyApi, asyncRoute(async (req, res) => {
  const auth = req.auth;
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  let contract;
  try {
    contract = createExportContract({
      companyId: String(auth.company_id),
      actorId: String(auth.user_id),
      role: String(auth.role || ''),
      dataset: body.dataset,
      purpose: body.purpose,
      requestedAt: new Date().toISOString(),
      period: body.period,
      filters: body.filters,
      sensitiveColumns: body.sensitiveColumns,
    });
  } catch (error) {
    if (error instanceof ExportContractError) {
      await recordExportLog(auth, null, 'failed', { dataset: body.dataset, failureCode: error.code });
      return res.status(422).json({ error: error.message, code: error.code, details: error.details });
    }
    throw error;
  }

  if (contract.dataset !== 'operations') {
    await recordExportLog(auth, contract, 'failed', { failureCode: 'DATASET_NOT_WIRED' });
    return res.status(400).json({
      error: `L’export du jeu de données « ${contract.dataset} » n’est pas encore disponible. Seul « operations » l’est pour l’instant.`,
      code: 'DATASET_NOT_WIRED',
    });
  }

  let rows;
  try {
    rows = await withCompanyTransaction(pool, auth.company_id, async (client) => {
      const query = buildOperationsExportQuery(contract, auth.company_id);
      const result = await client.query(query.text, query.values);
      return result.rows;
    });
  } catch (error) {
    await recordExportLog(auth, contract, 'failed', { failureCode: 'QUERY_FAILED' });
    throw error;
  }

  if (rows.length > EXPORT_LIMITS.maxDataRowsPerWorkbook) {
    await recordExportLog(auth, contract, 'failed', { failureCode: 'EXPORT_TOO_LARGE' });
    return res.status(413).json({
      error: 'Export trop volumineux : réduisez la période ou les filtres. Aucun tronquage n’est appliqué.',
      code: 'EXPORT_TOO_LARGE',
    });
  }

  const normalizedRows = rows.map((row) => normalizeExportRow(row, OPERATIONS_NUMERIC_COLUMNS));
  const format = body.format === 'csv' ? 'csv' : 'xlsx';

  // Fabrique l'artefact selon le format demandé (XLSX via le générateur audité,
  // ou CSV construit à partir des mêmes lignes/colonnes du contrat).
  let artifact;
  try {
    if (format === 'csv') {
      const csv = buildExportCsv(contract.columns, normalizedRows);
      const buffer = Buffer.from(csv, 'utf8');
      artifact = {
        buffer,
        contentType: 'text/csv; charset=utf-8',
        ext: 'csv',
        totalRows: normalizedRows.length,
        worksheetCount: 1,
        artifactBytes: buffer.length,
        artifactSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
    } else {
      const workbook = buildExportWorkbook(contract, normalizedRows);
      artifact = {
        buffer: workbook.buffer,
        contentType: workbook.contentType,
        ext: 'xlsx',
        totalRows: workbook.totalRows,
        worksheetCount: workbook.worksheetCount,
        artifactBytes: workbook.artifactBytes,
        artifactSha256: workbook.artifactSha256,
      };
    }
  } catch (error) {
    if (error instanceof ExportContractError) {
      await recordExportLog(auth, contract, 'failed', { failureCode: error.code });
      return res.status(422).json({ error: error.message, code: error.code, details: error.details });
    }
    throw error;
  }

  const sensitiveIncluded = contract.columns.some((column) => (
    EXPORT_DATASETS[contract.dataset].sensitiveColumns.includes(column)
  ));
  await recordExportLog(auth, contract, 'downloaded', {
    rowCount: artifact.totalRows,
    worksheetCount: artifact.worksheetCount,
    artifactBytes: artifact.artifactBytes,
    artifactSha256: artifact.artifactSha256,
  });
  await writeAudit(auth, 'export', null, 'crm_export_downloaded', {
    dataset: contract.dataset,
    role: contract.role,
    purpose: contract.purpose,
    period: contract.period,
    format,
    rowCount: artifact.totalRows,
    sensitiveIncluded,
    artifactSha256: artifact.artifactSha256,
    requestFingerprint: contract.requestFingerprintSha256,
  });

  const filename = `export-${contract.dataset}-${contract.period.from}_${contract.period.to}.${artifact.ext}`;
  res.set('Content-Type', artifact.contentType);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Export-Row-Count', String(artifact.totalRows));
  res.set('X-Export-Bytes', String(artifact.artifactBytes));
  return res.send(artifact.buffer);
}));

app.get('/api/app/crm/metrics', requireCompanyApi, asyncRoute(async (req, res) => {
  let period;
  try {
    period = crmReportingPeriod(req.query);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }
  const companyId = req.auth.company_id;
  const arrays = await withCompanyTransaction(pool, companyId, async (client) => {
    const [orders, statusEvents, paymentAccounts, paymentEvents, paymentAdjustments, incidents, drivers, runs, stops] = await Promise.all([
      client.query(
        `SELECT id, company_id, driver_id, status, created_at, updated_at
         FROM orders WHERE company_id = $1 AND created_at < $2::timestamptz`,
        [companyId, period.endExclusive]
      ),
      client.query(
        `SELECT id, company_id, order_id, from_status, to_status, created_at
         FROM order_status_events WHERE company_id = $1 AND created_at < $2::timestamptz`,
        [companyId, period.endExclusive]
      ),
      client.query(
        `SELECT id, company_id, order_id, expected_amount_minor, currency, status, created_at
         FROM order_payment_accounts WHERE company_id = $1`,
        [companyId]
      ),
      client.query(
        `SELECT id, company_id, order_id, event_type, amount_minor, currency, created_at
         FROM payment_events
         WHERE company_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
        [companyId, period.startInclusive, period.endExclusive]
      ),
      client.query(
        `SELECT id, company_id, order_id, adjustment_type, direction, amount_minor,
                currency, effective_date, created_at
         FROM payment_adjustments
         WHERE company_id = $1 AND effective_date >= $2::date AND effective_date <= $3::date`,
        [companyId, period.from, period.to]
      ),
      client.query(
        `SELECT id, company_id, order_id, category, status, created_at, resolved_at
         FROM delivery_incidents WHERE company_id = $1 AND created_at <= $2::timestamptz`,
        [companyId, period.asOf]
      ),
      client.query(
        `SELECT id, company_id, active, availability_status, created_at, updated_at
         FROM drivers WHERE company_id = $1`,
        [companyId]
      ),
      client.query(
        `SELECT id, company_id, driver_id, status, service_date, started_at,
                completed_at, cancelled_at, created_at, updated_at
         FROM delivery_runs WHERE company_id = $1 AND created_at <= $2::timestamptz`,
        [companyId, period.asOf]
      ),
      client.query(
        `SELECT id, company_id, run_id, order_id, assignment_active, removed_at,
                created_at, updated_at
         FROM delivery_stops WHERE company_id = $1 AND created_at <= $2::timestamptz`,
        [companyId, period.asOf]
      ),
    ]);
    return {
      orders: serializeMetricRows(orders.rows),
      statusEvents: serializeMetricRows(statusEvents.rows),
      paymentAccounts: serializeMetricRows(paymentAccounts.rows),
      paymentEvents: serializeMetricRows(paymentEvents.rows),
      paymentAdjustments: serializeMetricRows(paymentAdjustments.rows),
      incidents: serializeMetricRows(incidents.rows),
      drivers: serializeMetricRows(drivers.rows),
      runs: serializeMetricRows(runs.rows),
      stops: serializeMetricRows(stops.rows),
    };
  });
  try {
    return res.json(calculateCrmMetrics({
      companyId,
      period: { startInclusive: period.startInclusive, endExclusive: period.endExclusive },
      asOf: period.asOf,
      ...arrays,
    }));
  } catch (error) {
    console.error('CRM metrics calculation failed:', error.message);
    return res.status(500).json({ error: 'Impossible de calculer ce rapport avec les données disponibles.' });
  }
}));

app.post('/api/app/request-links', requireCompanyApi, asyncRoute(async (req, res) => {
  if (!(await companyDeliverySetting(req.auth.company_id, 'customerFormEnabled'))) {
    return res.status(403).json({ error: 'Le formulaire client est désactivé dans vos paramètres Livraisons.' });
  }
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    `INSERT INTO customer_requests (company_id, token, expires_at) VALUES ($1, $2, $3) RETURNING id`,
    [req.auth.company_id, token, expiresAt]
  );
  await writeAudit(req.auth, 'customer_request', result.rows[0].id, 'link_created', { expiresAt });
  return res.status(201).json({ token, path: `/demande/${token}`, expiresAt });
}));

app.get('/api/app/requests', requireCompanyApi, asyncRoute(async (req, res) => {
  const archived = req.query.scope === 'archived';
  const result = await pool.query(
    `SELECT id, token, status, customer_name, customer_phone, requested_time,
            location_lat, location_lng, location_accuracy, neighborhood, landmark, notes,
            created_at, submitted_at, updated_at, expires_at, archived_at, version
     FROM customer_requests
     WHERE company_id = $1 AND ${archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'}
     ORDER BY created_at DESC LIMIT 100`,
    [req.auth.company_id]
  );
  return res.json(result.rows);
}));

app.get('/api/app/requests/:id', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.status, r.customer_name, r.customer_phone, r.requested_time,
            r.location_lat, r.location_lng, r.location_accuracy, r.location_at,
            r.neighborhood, r.landmark, r.notes, r.created_at, r.submitted_at, r.updated_at,
            r.expires_at, r.archived_at, r.validated_at, r.version,
            o.id AS order_id, o.status AS order_status, o.reference AS order_reference, d.name AS driver_name,
            t.token_ciphertext AS tracking_token_ciphertext, t.expires_at AS tracking_expires_at,
            t.revoked_at AS tracking_revoked_at, t.created_at AS tracking_created_at,
            t.version AS tracking_link_version
     FROM customer_requests r
     LEFT JOIN orders o ON o.customer_request_id = r.id
     LEFT JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN tracking_links t ON t.order_id = o.id
     WHERE r.id = $1 AND r.company_id = $2`,
    [req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Demande introuvable.' });
  const request = result.rows[0];
  const trackingLink = request.order_id ? trackingLinkBusinessView({ ...request, status: request.order_status }) : null;
  delete request.tracking_token_ciphertext;
  return res.json({ ...request, trackingLink });
}));

app.post('/api/app/requests/:id/status', requireCompanyApi, asyncRoute(async (req, res) => {
  const allowed = ['À vérifier', 'Informations à compléter', 'Refusée', 'Archivée'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Statut non autorisé.' });
  const result = await pool.query(
    `UPDATE customer_requests
     SET status = $1,
         validated_at = CASE WHEN $1 = 'Confirmée' THEN NOW() ELSE validated_at END,
         archived_at = CASE WHEN $1 = 'Archivée' THEN NOW() ELSE archived_at END,
         version = version + 1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3 AND archived_at IS NULL
     RETURNING id, status, version`,
    [req.body.status, req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Demande introuvable ou déjà archivée.' });
  await writeAudit(req.auth, 'customer_request', result.rows[0].id, 'status_changed', { status: req.body.status });
  return res.json(result.rows[0]);
}));

app.post('/api/app/requests/:id/convert', requireCompanyApi, asyncRoute(async (req, res) => {
  const driverId = Number(req.body.driverId);
  if (!Number.isInteger(driverId)) return res.status(400).json({ error: 'Sélectionnez un livreur.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const requestResult = await client.query(
      `SELECT * FROM customer_requests WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const request = requestResult.rows[0];
    if (!request) throw Object.assign(new Error('Demande introuvable.'), { statusCode: 404 });

    const existing = await client.query(
      `SELECT o.id, o.status, t.token_ciphertext, t.expires_at, t.revoked_at, t.created_at, t.version
       FROM orders o LEFT JOIN tracking_links t ON t.order_id = o.id
       WHERE o.customer_request_id = $1`,
      [request.id]
    );
    if (existing.rows[0]) {
      const trackingLink = trackingLinkBusinessView(existing.rows[0]);
      await client.query('COMMIT');
      return res.json({ orderId: existing.rows[0].id, path: trackingLink.path, trackingLink, alreadyConverted: true });
    }
    if (!editableRequestStatuses.includes(request.status)) {
      throw Object.assign(new Error('Cette demande ne peut plus être convertie.'), { statusCode: 409 });
    }
    if (!request.customer_name || !request.customer_phone || !request.neighborhood) {
      throw Object.assign(new Error('Les informations du client sont incomplètes.'), { statusCode: 400 });
    }

    const driverResult = await client.query(
      `SELECT id, name, active, availability_status FROM drivers
       WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [driverId, req.auth.company_id]
    );
    const driver = driverResult.rows[0];
    if (!driver || !driver.active) throw Object.assign(new Error('Livreur indisponible ou non autorisé.'), { statusCode: 400 });
    if (['off_duty', 'incident'].includes(driver.availability_status)) {
      throw Object.assign(new Error('Ce livreur est actuellement indisponible.'), { statusCode: 409 });
    }

    const deliveryAddress = [request.neighborhood, request.landmark, request.notes].filter(Boolean).join(' — ');
    const order = await client.query(
      `INSERT INTO orders (
         company_id, driver_id, customer_request_id, customer_name, customer_phone,
         delivery_address, requested_time, destination_lat, destination_lng,
         destination_accuracy, neighborhood, landmark, notes, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'Confirmée')
       RETURNING id`,
      [
        req.auth.company_id, driver.id, request.id, request.customer_name, request.customer_phone,
        deliveryAddress, request.requested_time, request.location_lat, request.location_lng,
        request.location_accuracy, request.neighborhood, request.landmark, request.notes,
      ]
    );
    await assignOrderReference(client, req.auth.company_id, order.rows[0].id);
    const trackingToken = randomToken(24);
    const trackingStorage = trackingTokenStorage(trackingToken);
    const trackingExpiration = createTrackingLinkExpiration();
    const trackingLink = await client.query(
      `INSERT INTO tracking_links (company_id, order_id, token, token_hash, token_ciphertext, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, generation, version`,
      [req.auth.company_id, order.rows[0].id, encryptedOnlyTrackingTokenStorage() ? null : trackingToken,
        trackingStorage.tokenHash, trackingStorage.tokenCiphertext, trackingExpiration.expiresAt]
    );
    await client.query(
      `INSERT INTO tracking_link_events (
         company_id, tracking_link_id, order_id, generation, event_type,
         actor_user_id, reason, result_version
       ) VALUES ($1, $2, $3, $4, 'created', $5, 'customer_request_conversion', $6)`,
      [req.auth.company_id, trackingLink.rows[0].id, order.rows[0].id,
        trackingLink.rows[0].generation, req.auth.user_id, trackingLink.rows[0].version]
    );
    await client.query(
      `INSERT INTO order_status_events (
         company_id, order_id, from_status, to_status, actor_user_id,
         idempotency_key, request_fingerprint, metadata
       ) VALUES ($1, $2, NULL, 'Confirmée', $3, $4, $5, jsonb_build_object('source', 'customer_request', 'requestId', $6::bigint))`,
      [req.auth.company_id, order.rows[0].id, req.auth.user_id, `system:request-conversion:${request.id}`, digest(`request-conversion:${request.id}:${driver.id}`), request.id]
    );
    await client.query(
      `UPDATE customer_requests
       SET status = 'Confirmée', validated_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $1`,
      [request.id]
    );
    await ensureOrderCrmSnapshot(client, order.rows[0].id, req.auth.user_id);
    // Rattachement automatique à la tournée du jour du livreur (best-effort).
    try {
      await client.query('SAVEPOINT sp_run_attach');
      await attachOrderToDayRun(client, req.auth, order.rows[0].id, driver.id, todayServiceDate());
      await client.query('RELEASE SAVEPOINT sp_run_attach');
    } catch (attachError) {
      await client.query('ROLLBACK TO SAVEPOINT sp_run_attach');
      console.error('Auto-attach run failed (conversion):', attachError.message);
    }
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES
         ($1, $2, 'customer_request', $3, 'converted_to_order', jsonb_build_object('orderId', $4::bigint, 'driverId', $5::bigint)),
         ($1, $2, 'order', $4, 'created_from_request', jsonb_build_object('requestId', $3::bigint, 'driverId', $5::bigint))`,
      [req.auth.company_id, req.auth.user_id, request.id, order.rows[0].id, driver.id]
    );
    await client.query('COMMIT');
    return res.status(201).json({
      orderId: order.rows[0].id,
      path: `/suivi/${trackingToken}`,
      trackingLink: { state: 'active', path: `/suivi/${trackingToken}`, expiresAt: trackingExpiration.expiresAt, version: 1 },
      driverName: driver.name,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Request conversion error:', error.message);
    return res.status(500).json({ error: 'Impossible de convertir la demande en commande.' });
  } finally {
    client.release();
  }
}));

app.get('/api/app/drivers', requireCompanyApi, asyncRoute(async (req, res) => {
  const localDrivers = await pool.query(
    `SELECT d.id, d.name, d.phone, d.vehicle_type, d.capacity, d.availability_status,
            d.active, d.traccar_unique_id,
            (d.photo_updated_at IS NOT NULL) AS has_photo, d.photo_updated_at,
            COUNT(o.id) FILTER (WHERE o.status NOT IN ('Livrée', 'Annulée', 'Retournée'))::int AS active_orders,
            EXISTS (SELECT 1 FROM company_memberships m WHERE m.company_id = d.company_id AND m.driver_id = d.id) AS has_account,
            EXISTS (SELECT 1 FROM user_invitations i WHERE i.company_id = d.company_id AND i.driver_id = d.id
                      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()) AS invite_pending
     FROM drivers d
     LEFT JOIN orders o ON o.driver_id = d.id
     WHERE d.company_id = $1 AND d.archived_at IS NULL
     GROUP BY d.id
     ORDER BY d.name`,
    [req.auth.company_id]
  );
  const enrich = (driver, device) => {
    const lastUpdate = device?.lastUpdate || null;
    const stale = !lastUpdate || Date.now() - new Date(lastUpdate).getTime() > 10 * 60 * 1000;
    let operationalState = 'available';
    if (!driver.active) operationalState = 'inactive';
    else if (driver.availability_status !== 'available') operationalState = driver.availability_status;
    else if (!device || device.status === 'offline') operationalState = 'offline';
    else if (stale) operationalState = 'stale';
    else if (driver.active_orders >= driver.capacity) operationalState = 'full';
    else if (driver.active_orders > 0) operationalState = 'busy';
    return {
      id: driver.id, name: driver.name, phone: driver.phone, vehicleType: driver.vehicle_type,
      capacity: driver.capacity, availabilityStatus: driver.availability_status, active: driver.active,
      uniqueId: driver.traccar_unique_id, trackerStatus: device?.status || 'unknown', lastUpdate,
      category: device?.category || null, activeOrders: driver.active_orders, operationalState,
      hasAccount: Boolean(driver.has_account), invitePending: Boolean(driver.invite_pending),
      hasPhoto: Boolean(driver.has_photo),
      photoVersion: driver.photo_updated_at ? new Date(driver.photo_updated_at).getTime() : null,
    };
  };
  if (!traccarConfigured()) {
    return res.json(localDrivers.rows.map((driver) => enrich(driver, null)));
  }
  const fleetSnapshot = await loadTraccarFleetSnapshot();
  if (fleetSnapshot.status !== 'online') {
    return res.json(localDrivers.rows.map((driver) => enrich(driver, null)));
  }
  const byUniqueId = new Map(fleetSnapshot.devices.map((device) => [device.uniqueId, device]));
  const ranking = { available: 0, busy: 1, full: 2, pause: 3, stale: 4, offline: 5, off_duty: 6, incident: 7, inactive: 8 };
  return res.json(localDrivers.rows
    .map((driver) => enrich(driver, byUniqueId.get(driver.traccar_unique_id)))
    .sort((a, b) => (ranking[a.operationalState] ?? 9) - (ranking[b.operationalState] ?? 9) || a.activeOrders - b.activeOrders || a.name.localeCompare(b.name)));
}));

app.get('/api/app/operations-map', requireCompanyApi, asyncRoute(async (req, res) => {
  const [driversResult, runsResult, ordersResult, pendingRequestsResult] = await Promise.all([
    pool.query(
      `SELECT d.id, d.name, d.phone, d.vehicle_type, d.capacity, d.availability_status,
              d.active, d.traccar_unique_id,
              COUNT(DISTINCT o.id) FILTER (WHERE o.status <> ALL($2::text[]))::int AS active_orders,
              COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'open')::int AS open_incidents
       FROM drivers d
       LEFT JOIN orders o ON o.driver_id = d.id AND o.company_id = d.company_id
       LEFT JOIN delivery_incidents i ON i.order_id = o.id AND i.company_id = d.company_id
       WHERE d.company_id = $1
       GROUP BY d.id
       ORDER BY d.name`,
      [req.auth.company_id, terminalOrderStatuses]
    ),
    pool.query(
      `SELECT r.id, r.driver_id, r.name, TO_CHAR(r.service_date, 'YYYY-MM-DD') AS service_date,
              r.status, r.started_at, r.updated_at,
              COUNT(s.id) FILTER (WHERE s.removed_at IS NULL)::int AS total_stops,
              COUNT(s.id) FILTER (WHERE s.removed_at IS NULL AND o.status = ANY($2::text[]))::int AS completed_stops
       FROM delivery_runs r
       LEFT JOIN delivery_stops s ON s.run_id = r.id AND s.company_id = r.company_id
       LEFT JOIN orders o ON o.id = s.order_id AND o.company_id = r.company_id
       WHERE r.company_id = $1 AND r.status IN ('draft', 'planned', 'active')
       GROUP BY r.id
       ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,
                r.service_date ASC, r.created_at ASC
       LIMIT 100`,
      [req.auth.company_id, terminalOrderStatuses]
    ),
    pool.query(
      `SELECT o.id, o.driver_id, o.customer_name, o.status, o.requested_time,
              o.neighborhood, o.landmark, o.delivery_address,
              o.destination_lat, o.destination_lng, o.destination_accuracy,
              o.updated_at, s.sequence, r.id AS run_id, r.name AS run_name,
              TO_CHAR(r.service_date, 'YYYY-MM-DD') AS run_service_date, r.status AS run_status,
              COUNT(i.id) FILTER (WHERE i.status = 'open')::int AS open_incidents
       FROM orders o
       JOIN drivers d ON d.id = o.driver_id AND d.company_id = o.company_id
       LEFT JOIN delivery_stops s ON s.order_id = o.id AND s.company_id = o.company_id
         AND s.assignment_active = TRUE AND s.removed_at IS NULL
       LEFT JOIN delivery_runs r ON r.id = s.run_id AND r.company_id = o.company_id
         AND r.status IN ('draft', 'planned', 'active')
       LEFT JOIN delivery_incidents i ON i.order_id = o.id AND i.company_id = o.company_id
       WHERE o.company_id = $1 AND o.status <> ALL($2::text[])
       GROUP BY o.id, s.id, r.id
       ORDER BY o.driver_id,
                CASE r.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
                s.sequence NULLS LAST, o.created_at ASC
       LIMIT 501`,
      [req.auth.company_id, terminalOrderStatuses]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS pending
       FROM customer_requests
       WHERE company_id = $1 AND archived_at IS NULL AND status = 'À vérifier'`,
      [req.auth.company_id]
    ),
  ]);

  const pendingRequests = Number(pendingRequestsResult.rows[0]?.pending || 0);
  const ordersTruncated = ordersResult.rows.length > 500;
  const orders = ordersResult.rows.slice(0, 500).map((order) => ({
    id: order.id,
    driverId: order.driver_id,
    customerName: order.customer_name,
    status: order.status,
    requestedTime: order.requested_time,
    neighborhood: order.neighborhood,
    landmark: order.landmark,
    deliveryAddress: order.delivery_address,
    destination: order.destination_lat != null && order.destination_lng != null
      && Number.isFinite(Number(order.destination_lat)) && Number.isFinite(Number(order.destination_lng))
      ? {
          latitude: Number(order.destination_lat),
          longitude: Number(order.destination_lng),
          accuracy: order.destination_accuracy != null && Number.isFinite(Number(order.destination_accuracy))
            ? Number(order.destination_accuracy) : null,
        }
      : null,
    updatedAt: order.updated_at,
    sequence: order.sequence == null ? null : Number(order.sequence),
    runId: order.run_id,
    runName: order.run_name,
    runServiceDate: order.run_service_date,
    runStatus: order.run_status,
    openIncidents: Number(order.open_incidents || 0),
  }));

  const runsByDriver = new Map();
  for (const run of runsResult.rows) {
    const value = {
      id: run.id,
      name: run.name,
      serviceDate: run.service_date,
      status: run.status,
      startedAt: run.started_at,
      updatedAt: run.updated_at,
      totalStops: Number(run.total_stops || 0),
      completedStops: Number(run.completed_stops || 0),
      stops: [],
    };
    if (!runsByDriver.has(String(run.driver_id))) runsByDriver.set(String(run.driver_id), []);
    runsByDriver.get(String(run.driver_id)).push(value);
  }
  for (const order of orders) {
    if (!order.runId) continue;
    const run = (runsByDriver.get(String(order.driverId)) || []).find((item) => String(item.id) === String(order.runId));
    if (run) run.stops.push(order);
  }
  const ordersByDriver = new Map();
  for (const order of orders) {
    const key = String(order.driverId);
    if (!ordersByDriver.has(key)) ordersByDriver.set(key, []);
    ordersByDriver.get(key).push(order);
  }

  const devicesByUniqueId = new Map();
  const positionsByDeviceId = new Map();
  const fleetSnapshot = await loadTraccarFleetSnapshot();
  for (const device of fleetSnapshot.devices) devicesByUniqueId.set(String(device.uniqueId), device);
  for (const position of fleetSnapshot.positions) positionsByDeviceId.set(String(position.deviceId), position);
  const locationService = { status: fleetSnapshot.status, message: fleetSnapshot.message };

  const ranking = { available: 0, busy: 1, full: 2, pause: 3, stale: 4, offline: 5, off_duty: 6, incident: 7, inactive: 8 };
  const drivers = driversResult.rows.map((driver) => {
    const device = devicesByUniqueId.get(String(driver.traccar_unique_id));
    const rawPosition = device ? positionsByDeviceId.get(String(device.id)) : null;
    const timestamp = rawPosition?.fixTime || rawPosition?.deviceTime || rawPosition?.serverTime || device?.lastUpdate || null;
    const timestampMs = timestamp ? new Date(timestamp).getTime() : NaN;
    const stale = !Number.isFinite(timestampMs) || Date.now() - timestampMs > 10 * 60 * 1000;
    const hasCoordinates = Number.isFinite(Number(rawPosition?.latitude))
      && Number.isFinite(Number(rawPosition?.longitude))
      && Number(rawPosition.latitude) >= -90 && Number(rawPosition.latitude) <= 90
      && Number(rawPosition.longitude) >= -180 && Number(rawPosition.longitude) <= 180;
    let operationalState = 'available';
    if (!driver.active) operationalState = 'inactive';
    else if (driver.availability_status !== 'available') operationalState = driver.availability_status;
    else if (!device || device.status === 'offline') operationalState = 'offline';
    else if (stale) operationalState = 'stale';
    else if (Number(driver.active_orders) >= Number(driver.capacity)) operationalState = 'full';
    else if (Number(driver.active_orders) > 0) operationalState = 'busy';
    return {
      id: driver.id,
      name: driver.name,
      phone: driver.phone,
      vehicleType: driver.vehicle_type,
      capacity: Number(driver.capacity),
      availabilityStatus: driver.availability_status,
      active: driver.active,
      trackerStatus: device?.status || 'unknown',
      lastUpdate: timestamp,
      operationalState,
      activeOrders: Number(driver.active_orders || 0),
      openIncidents: Number(driver.open_incidents || 0),
      position: hasCoordinates ? {
        latitude: Number(rawPosition.latitude),
        longitude: Number(rawPosition.longitude),
        accuracy: rawPosition.accuracy != null && Number.isFinite(Number(rawPosition.accuracy)) ? Number(rawPosition.accuracy) : null,
        speedKnots: rawPosition.speed != null && Number.isFinite(Number(rawPosition.speed)) ? Number(rawPosition.speed) : null,
        course: rawPosition.course != null && Number.isFinite(Number(rawPosition.course)) ? Number(rawPosition.course) : null,
        timestamp,
        stale,
      } : null,
      runs: runsByDriver.get(String(driver.id)) || [],
      unplannedOrders: (ordersByDriver.get(String(driver.id)) || []).filter((order) => !order.runId),
    };
  }).sort((a, b) => (ranking[a.operationalState] ?? 9) - (ranking[b.operationalState] ?? 9)
    || b.openIncidents - a.openIncidents || a.name.localeCompare(b.name));

  return res.json({
    generatedAt: new Date().toISOString(),
    refreshAfterSeconds: 15,
    locationService,
    mapConfig: mapConfiguration(),
    summary: {
      drivers: drivers.length,
      locatedDrivers: drivers.filter((driver) => driver.position).length,
      staleDrivers: drivers.filter((driver) => driver.position?.stale || ['stale', 'offline'].includes(driver.operationalState)).length,
      openRuns: runsResult.rows.length,
      activeOrders: orders.length,
      pendingRequests,
      onlineDrivers: drivers.filter((driver) => ['available', 'busy', 'full', 'pause'].includes(driver.operationalState)).length,
      locatedDestinations: orders.filter((order) => order.destination).length,
      openIncidents: drivers.reduce((sum, driver) => sum + driver.openIncidents, 0),
      ordersTruncated,
    },
    drivers,
  });
}));

function unavailableRunRoute(code, retryable = false) {
  const health = routingAdapter.health();
  return {
    status: 'unavailable',
    distanceMeters: null,
    durationSeconds: null,
    geometry: null,
    legs: [],
    snappedPoints: [],
    quality: { fallbackUsed: false, warnings: [code, 'eta_not_computed'] },
    failure: { code, retryable },
    source: {
      provider: health.source.provider,
      profile: 'motorcycle',
      mapDataVersion: health.source.mapDataVersion,
      providerVersion: health.source.providerVersion,
      calculatedAt: new Date().toISOString(),
      cache: 'disabled',
    },
  };
}

app.get('/api/app/routing/health', requireCompanyApi, (_req, res) => {
  res.json(routingAdapter.health());
});

app.get('/api/app/runs/:id/route', requireCompanyApi, asyncRoute(async (req, res) => {
  const runResult = await pool.query(
    `SELECT r.id, r.name, r.status, r.version, r.driver_id, d.traccar_unique_id
     FROM delivery_runs r
     JOIN drivers d ON d.id = r.driver_id AND d.company_id = r.company_id
     WHERE r.id = $1 AND r.company_id = $2`,
    [req.params.id, req.auth.company_id]
  );
  const run = runResult.rows[0];
  if (!run) return res.status(404).json({ error: 'Tournée introuvable.' });

  const stopsResult = await pool.query(
    `SELECT s.id, s.sequence, o.id AS order_id, o.status,
            o.destination_lat, o.destination_lng, o.destination_accuracy
     FROM delivery_stops s
     JOIN orders o ON o.id = s.order_id AND o.company_id = s.company_id
     WHERE s.run_id = $1 AND s.company_id = $2 AND s.removed_at IS NULL
       AND o.status <> ALL($3::text[])
     ORDER BY s.sequence
     LIMIT 51`,
    [run.id, req.auth.company_id, terminalOrderStatuses]
  );
  const stops = stopsResult.rows;
  const maximumStops = run.status === 'active' ? 49 : 50;
  if (stops.length > maximumStops) {
    return res.status(409).json({ error: `Cette tournée dépasse la limite de ${maximumStops} arrêts routables.`, code: 'too_many_stops' });
  }
  const missingDestination = stops.find((stop) => !publicDestination(stop));
  if (missingDestination) {
    return res.status(409).json({
      error: 'Au moins un arrêt restant ne possède pas de destination GPS valide.',
      code: 'missing_destination',
      sequence: Number(missingDestination.sequence),
    });
  }

  const coordinates = [];
  let origin = 'first_stop';
  if (run.status === 'active' && routingAdapter.health().status !== 'disabled') {
    const fleetSnapshot = await loadTraccarFleetSnapshot();
    const device = fleetSnapshot.devices.find((item) => String(item.uniqueId) === String(run.traccar_unique_id));
    const position = device
      ? fleetSnapshot.positions.find((item) => String(item.deviceId) === String(device.id))
      : null;
    const latitude = Number(position?.latitude);
    const longitude = Number(position?.longitude);
    const timestamp = position?.fixTime || position?.deviceTime || position?.serverTime || device?.lastUpdate || null;
    const timestampMs = timestamp ? new Date(timestamp).getTime() : NaN;
    const usable = fleetSnapshot.status === 'online'
      && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      && Number.isFinite(timestampMs) && Date.now() - timestampMs <= 10 * 60 * 1000;
    if (!usable) {
      return res.json({
        run: { id: run.id, name: run.name, status: run.status, version: Number(run.version), origin, stopCount: stops.length },
        route: unavailableRunRoute('driver_position_unavailable', true),
      });
    }
    coordinates.push({ lat: latitude, lng: longitude });
    origin = 'driver_position';
  }
  coordinates.push(...stops.map((stop) => ({
    lat: Number(stop.destination_lat),
    lng: Number(stop.destination_lng),
  })));

  if (coordinates.length < 2) {
    return res.json({
      run: { id: run.id, name: run.name, status: run.status, version: Number(run.version), origin, stopCount: stops.length },
      route: unavailableRunRoute('not_enough_points'),
    });
  }
  const route = await routingAdapter.route({ profile: 'motorcycle', coordinates });
  return res.json({
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      version: Number(run.version),
      origin,
      stopCount: stops.length,
      stopSequences: stops.map((stop) => Number(stop.sequence)),
    },
    route,
  });
}));

app.patch('/api/app/drivers/:id/availability', requireCompanyApi, asyncRoute(async (req, res) => {
  const allowed = ['available', 'pause', 'off_duty', 'incident'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'État de disponibilité invalide.' });
  const result = await pool.query(
    `UPDATE drivers SET availability_status = $1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3 AND active = TRUE
     RETURNING id, availability_status`,
    [req.body.status, req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Livreur introuvable.' });
  await writeAudit(req.auth, 'driver', result.rows[0].id, 'availability_changed', { status: req.body.status });
  return res.json(result.rows[0]);
}));

// Création d'un livreur depuis le SaaS (owner/manager). Génère un identifiant GPS
// aléatoire non devinable par défaut ; un identifiant Traccar existant peut être
// fourni pour relier un appareil déjà enrôlé.
app.post('/api/app/drivers', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  const vehicleType = String(req.body.vehicleType || 'Moto').trim();
  const capacity = Number(req.body.capacity);
  const trackerId = String(req.body.trackerId || '').trim();
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Nom du livreur invalide.' });
  if (phone.length > 40) return res.status(400).json({ error: 'Téléphone invalide.' });
  if (!driverVehicleTypes.includes(vehicleType)) return res.status(400).json({ error: 'Type de véhicule invalide.' });
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) return res.status(400).json({ error: 'Capacité invalide (1 à 50).' });
  if (trackerId && !/^[A-Za-z0-9_-]{4,64}$/.test(trackerId)) return res.status(400).json({ error: 'Identifiant GPS invalide (4 à 64 caractères alphanumériques).' });
  const uniqueId = trackerId || `trx-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const result = await pool.query(
      `INSERT INTO drivers (company_id, name, phone, vehicle_type, capacity, traccar_unique_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, phone, vehicle_type, capacity, traccar_unique_id, active, availability_status`,
      [req.auth.company_id, name, phone || null, vehicleType, capacity, uniqueId]
    );
    await writeAudit(req.auth, 'driver', result.rows[0].id, 'created', { name });
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Cet identifiant GPS est déjà utilisé dans votre entreprise.' });
    console.error('Driver create error:', error.message);
    return res.status(500).json({ error: 'Impossible de créer ce livreur.' });
  }
}));

// Modification d'un livreur (owner/manager) : coordonnées, capacité, identifiant
// GPS, activation.
app.patch('/api/app/drivers/:id', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const fields = [];
  const values = [];
  let index = 1;
  if (req.body.name !== undefined) { const name = String(req.body.name).trim(); if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Nom invalide.' }); fields.push(`name = $${index++}`); values.push(name); }
  if (req.body.phone !== undefined) { const phone = String(req.body.phone).trim(); if (phone.length > 40) return res.status(400).json({ error: 'Téléphone invalide.' }); fields.push(`phone = $${index++}`); values.push(phone || null); }
  if (req.body.vehicleType !== undefined) { const vehicleType = String(req.body.vehicleType).trim(); if (!driverVehicleTypes.includes(vehicleType)) return res.status(400).json({ error: 'Véhicule invalide.' }); fields.push(`vehicle_type = $${index++}`); values.push(vehicleType); }
  if (req.body.capacity !== undefined) { const capacity = Number(req.body.capacity); if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) return res.status(400).json({ error: 'Capacité invalide.' }); fields.push(`capacity = $${index++}`); values.push(capacity); }
  if (req.body.trackerId !== undefined) { const trackerId = String(req.body.trackerId).trim(); if (trackerId && !/^[A-Za-z0-9_-]{4,64}$/.test(trackerId)) return res.status(400).json({ error: 'Identifiant GPS invalide.' }); fields.push(`traccar_unique_id = $${index++}`); values.push(trackerId || `trx-${crypto.randomBytes(6).toString('hex')}`); }
  if (req.body.active !== undefined) { fields.push(`active = $${index++}`); values.push(Boolean(req.body.active)); }
  if (!fields.length) return res.status(400).json({ error: 'Aucune modification fournie.' });
  values.push(req.params.id, req.auth.company_id);
  try {
    const result = await pool.query(
      `UPDATE drivers SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${index++} AND company_id = $${index}
       RETURNING id, name, phone, vehicle_type, capacity, traccar_unique_id, active, availability_status`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Livreur introuvable.' });
    await writeAudit(req.auth, 'driver', result.rows[0].id, 'updated', {});
    return res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Cet identifiant GPS est déjà utilisé.' });
    console.error('Driver update error:', error.message);
    return res.status(500).json({ error: 'Impossible de mettre à jour ce livreur.' });
  }
}));

// Suppression d'un livreur (owner/manager) : archive douce pour préserver
// l'historique des commandes/tournées et rester réversible.
app.delete('/api/app/drivers/:id', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE drivers SET archived_at = NOW(), active = FALSE, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 AND archived_at IS NULL
     RETURNING id, name`,
    [req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Livreur introuvable.' });
  await writeAudit(req.auth, 'driver', result.rows[0].id, 'archived', { name: result.rows[0].name });
  return res.json({ id: result.rows[0].id, archived: true });
}));

// Photo d'un livreur : upload (owner/manager), stockée en base bornée à ~600 Ko,
// types image/jpeg|png|webp uniquement. Le corps est un data URL base64.
const driverPhotoMimes = { 'image/jpeg': true, 'image/png': true, 'image/webp': true };
app.post('/api/app/drivers/:id/photo', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const dataUrl = String(req.body.dataUrl || '');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || !driverPhotoMimes[match[1]]) return res.status(400).json({ error: 'Image invalide (JPEG, PNG ou WebP attendu).' });
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < 64 || buffer.length > 600 * 1024) return res.status(400).json({ error: 'Image trop lourde (max 600 Ko) ou vide.' });
  const result = await pool.query(
    `UPDATE drivers SET photo_data = $1, photo_mime = $2, photo_updated_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND company_id = $4 AND archived_at IS NULL
     RETURNING id, photo_updated_at`,
    [buffer, match[1], req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Livreur introuvable.' });
  await writeAudit(req.auth, 'driver', result.rows[0].id, 'photo_updated', {});
  return res.json({ id: result.rows[0].id, photoUpdatedAt: result.rows[0].photo_updated_at });
}));

app.delete('/api/app/drivers/:id/photo', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE drivers SET photo_data = NULL, photo_mime = NULL, photo_updated_at = NULL, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 RETURNING id`,
    [req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Livreur introuvable.' });
  return res.json({ id: result.rows[0].id, removed: true });
}));

app.get('/api/app/drivers/:id/photo', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    'SELECT photo_data, photo_mime, photo_updated_at FROM drivers WHERE id = $1 AND company_id = $2',
    [req.params.id, req.auth.company_id]
  );
  const row = result.rows[0];
  if (!row || !row.photo_data) return res.status(404).end();
  res.setHeader('Content-Type', row.photo_mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (row.photo_updated_at) res.setHeader('ETag', `"${new Date(row.photo_updated_at).getTime()}"`);
  return res.end(row.photo_data);
}));

// Nettoyage d'une trace GPS brute : retire le jitter (points quasi immobiles),
// les sauts physiquement impossibles (glitchs) et les points d'imprécision
// extrême. Ne « colle » pas aux routes (map-matching) — ça reste une trace de
// points, mais débarrassée des grands zigzags aberrants.
function cleanGpsTrack(points) {
  const R = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const distance = (a, b) => {
    const dLat = toRad(b.latitude - a.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const MIN_MOVE_M = 8;        // en-deçà : jitter à l'arrêt
  const MAX_SPEED_MS = 45;     // ~162 km/h : au-delà = glitch (moto)
  const MAX_ACCURACY_M = 500;  // imprécision extrême = point poubelle
  const kept = [];
  for (const point of points) {
    if (point.accuracy != null && point.accuracy > MAX_ACCURACY_M) continue;
    const last = kept[kept.length - 1];
    if (!last) { kept.push(point); continue; }
    const dt = (new Date(point.timestamp).getTime() - new Date(last.timestamp).getTime()) / 1000;
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const step = distance(last, point);
    if (step < MIN_MOVE_M) continue;               // immobile
    if (step / dt > MAX_SPEED_MS) continue;         // saut impossible
    kept.push(point);
  }
  return kept;
}

// Sous-échantillonne une trace à au plus `max` points, en gardant le premier et
// le dernier, pour le map-matching (OSRM interpole la route entre les points).
function downsampleTrack(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(points[Math.round(i * step)]);
  return out;
}

// Historique GPS d'un livreur (rejeu). Interroge l'historique Traccar, borné et
// isolé par entreprise : seul un livreur de la session peut être consulté.
app.get('/api/app/drivers/:id/track', requireCompanyApi, asyncRoute(async (req, res) => {
  const driverResult = await pool.query(
    `SELECT id, name, traccar_unique_id FROM drivers WHERE id = $1 AND company_id = $2`,
    [req.params.id, req.auth.company_id]
  );
  const driver = driverResult.rows[0];
  if (!driver) return res.status(404).json({ error: 'Livreur introuvable.' });

  const now = Date.now();
  const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  let to = req.query.to ? Date.parse(req.query.to) : now;
  let from = req.query.from ? Date.parse(req.query.from) : now - 3 * 60 * 60 * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return res.status(400).json({ error: 'Fenêtre temporelle invalide.' });
  if (to > now) to = now;
  if (from >= to) return res.status(400).json({ error: 'La date de début doit précéder la date de fin.' });
  if (to - from > MAX_WINDOW_MS) from = to - MAX_WINDOW_MS;

  if (!traccarConfigured()) return res.json({ status: 'not_configured', positions: [], message: 'Le service GPS n’est pas configuré.' });

  const snapshot = await loadTraccarFleetSnapshot();
  const device = snapshot.devices.find((item) => String(item.uniqueId) === String(driver.traccar_unique_id));
  if (!device) return res.json({ status: 'no_device', positions: [], message: 'Aucun appareil GPS n’est associé à ce livreur.' });

  try {
    const auth = { username: process.env.TRACCAR_USER, password: process.env.TRACCAR_PASSWORD };
    const response = await axios.get(`${process.env.TRACCAR_URL}/api/positions`, {
      auth, timeout: 15000,
      params: { deviceId: device.id, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    });
    const raw = Array.isArray(response.data) ? response.data : [];
    const positions = raw
      .map((point) => ({
        latitude: Number(point.latitude),
        longitude: Number(point.longitude),
        timestamp: point.fixTime || point.deviceTime || point.serverTime || null,
        speedKnots: point.speed != null && Number.isFinite(Number(point.speed)) ? Number(point.speed) : null,
        course: point.course != null && Number.isFinite(Number(point.course)) ? Number(point.course) : null,
        accuracy: point.accuracy != null && Number.isFinite(Number(point.accuracy)) ? Number(point.accuracy) : null,
      }))
      .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
        && point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const rawCount = positions.length;
    const cleaned = cleanGpsTrack(positions);
    const MAX_POINTS = 5000;
    const truncated = cleaned.length > MAX_POINTS;
    const output = truncated ? cleaned.slice(cleaned.length - MAX_POINTS) : cleaned;

    // Map-matching (snap-to-roads) : la trace collée au réseau routier, si un
    // moteur OSRM est configuré. Best-effort — un échec renvoie simplement la
    // trace nettoyée, jamais d'erreur.
    let roadGeometry = null;
    let matchInfo = null;
    try {
      if (routingAdapter.health().capabilities.match && output.length >= 2) {
        const matched = await routingAdapter.match({
          profile: 'motorcycle',
          points: downsampleTrack(output, 100).map((point) => ({ lat: point.latitude, lng: point.longitude, accuracy: point.accuracy })),
        });
        if (matched.status === 'ok' && matched.geometry?.value?.coordinates?.length >= 2) {
          roadGeometry = matched.geometry.value.coordinates.map(([lng, lat]) => [lat, lng]);
          matchInfo = { matchedPoints: matched.matchedPoints, totalPoints: matched.totalPoints, confidence: matched.confidence };
        }
      }
    } catch (matchError) {
      console.error('Map-matching error:', matchError.message);
    }

    return res.json({
      status: 'online',
      driverId: driver.id,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      rawCount,
      count: output.length,
      cleaned: rawCount - cleaned.length,
      truncated,
      positions: output,
      roadGeometry,
      match: matchInfo,
    });
  } catch (error) {
    console.error('Traccar track error:', error.response?.status || error.message);
    return res.status(502).json({ error: 'Historique GPS temporairement indisponible.' });
  }
}));

app.get('/api/app/runs', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.name, TO_CHAR(r.service_date, 'YYYY-MM-DD') AS service_date, r.status, r.version, r.created_at, r.updated_at,
            d.id AS driver_id, d.name AS driver_name, d.vehicle_type, d.traccar_unique_id AS driver_unique_id,
            (d.photo_updated_at IS NOT NULL) AS driver_has_photo, d.photo_updated_at AS driver_photo_at,
            COUNT(s.id) FILTER (WHERE s.removed_at IS NULL)::int AS stop_count,
            COUNT(s.id) FILTER (WHERE s.removed_at IS NULL AND o.status = ANY($2::text[]))::int AS terminal_stop_count
     FROM delivery_runs r
     JOIN drivers d ON d.id = r.driver_id AND d.company_id = r.company_id
     LEFT JOIN delivery_stops s ON s.run_id = r.id AND s.company_id = r.company_id
     LEFT JOIN orders o ON o.id = s.order_id AND o.company_id = r.company_id
     WHERE r.company_id = $1
     GROUP BY r.id, d.id
     ORDER BY r.service_date DESC, r.created_at DESC LIMIT 500`,
    [req.auth.company_id, terminalOrderStatuses]
  );
  const online = await driverOnlineByUnique();
  return res.json(result.rows.map((row) => ({ ...row, ...decorateRowDriver(row, online) })));
}));

app.post('/api/app/runs', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const driverId = Number(req.body.driverId);
  const name = String(req.body.name || '').trim();
  const serviceDate = validDateOnly(req.body.serviceDate);
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!Number.isInteger(driverId) || driverId <= 0) return res.status(400).json({ error: 'Sélectionnez un livreur.' });
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Le nom de la tournée doit contenir entre 2 et 120 caractères.' });
  if (!serviceDate) return res.status(400).json({ error: 'La date de tournée est invalide.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité invalide. Rechargez la page puis réessayez.' });
  const fingerprint = digest(canonicalJson({ driverId, name, serviceDate }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repeated = await client.query(
      `SELECT id, create_fingerprint FROM delivery_runs
       WHERE company_id = $1 AND create_idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (repeated.rows[0].create_fingerprint !== fingerprint) {
        throw Object.assign(new Error('Cette clé de création a déjà été utilisée avec d’autres informations.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      const payload = await loadDeliveryRun(req.auth.company_id, repeated.rows[0].id);
      return res.json({ ...payload, alreadyApplied: true });
    }
    const driver = await client.query(
      `SELECT id, name, active FROM drivers WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [driverId, req.auth.company_id]
    );
    if (!driver.rows[0]?.active) throw Object.assign(new Error('Livreur actif introuvable.'), { statusCode: 404 });
    const conflicting = await client.query(
      `SELECT id FROM delivery_runs
       WHERE company_id = $1 AND driver_id = $2 AND service_date = $3
         AND status IN ('draft', 'planned', 'active') LIMIT 1`,
      [req.auth.company_id, driverId, serviceDate]
    );
    if (conflicting.rows[0]) {
      throw Object.assign(new Error(`Ce livreur possède déjà une tournée ouverte à cette date (n° ${conflicting.rows[0].id}).`), { statusCode: 409 });
    }
    const created = await client.query(
      `INSERT INTO delivery_runs (
         company_id, driver_id, name, service_date, create_idempotency_key,
         create_fingerprint, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, version`,
      [req.auth.company_id, driverId, name, serviceDate, idempotencyKey, fingerprint, req.auth.user_id]
    );
    await appendRunEvent(client, req.auth, created.rows[0].id, 'created', idempotencyKey, fingerprint, {
      driverId, serviceDate, name, version: created.rows[0].version,
    });
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'delivery_run', $3, 'created', jsonb_build_object('driverId', $4::bigint, 'serviceDate', $5::text))`,
      [req.auth.company_id, req.auth.user_id, created.rows[0].id, driverId, serviceDate]
    );
    await client.query('COMMIT');
    const payload = await loadDeliveryRun(req.auth.company_id, created.rows[0].id);
    return res.status(201).json(payload);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Une tournée ouverte existe déjà pour ce livreur à cette date.' });
    console.error('Run creation error:', error.message);
    return res.status(500).json({ error: 'Impossible de créer la tournée.' });
  } finally {
    client.release();
  }
}));

app.get('/api/app/runs/:id', requireCompanyApi, asyncRoute(async (req, res) => {
  const payload = await loadDeliveryRun(req.auth.company_id, req.params.id);
  if (!payload) return res.status(404).json({ error: 'Tournée introuvable.' });
  return res.json(payload);
}));

app.post('/api/app/runs/:id/orders', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const orderId = Number(req.body.orderId);
  const expectedVersion = Number(req.body.expectedVersion);
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isInteger(expectedVersion) || !idempotencyKey) {
    return res.status(400).json({ error: 'Commande, version ou clé d’action invalide.' });
  }
  const fingerprint = digest(canonicalJson({ action: 'add_order', orderId, expectedVersion }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repeated = await repeatedRunEvent(client, req.auth, req.params.id, idempotencyKey, fingerprint);
    if (repeated) {
      await client.query('COMMIT');
      return res.json({ runId: Number(req.params.id), version: repeated.details.version, alreadyApplied: true });
    }
    const runResult = await client.query(
      `SELECT r.*, d.capacity FROM delivery_runs r JOIN drivers d ON d.id = r.driver_id
       WHERE r.id = $1 AND r.company_id = $2 FOR UPDATE OF r`,
      [req.params.id, req.auth.company_id]
    );
    const run = runResult.rows[0];
    if (!run) throw Object.assign(new Error('Tournée introuvable.'), { statusCode: 404 });
    if (run.version !== expectedVersion) throw Object.assign(new Error('Cette tournée a changé. Rechargez-la avant de continuer.'), { statusCode: 409 });
    if (run.status !== 'draft') throw Object.assign(new Error('Les colis ne peuvent être ajoutés que pendant la préparation de la tournée.'), { statusCode: 409 });
    const count = await client.query(
      `SELECT COUNT(*)::int AS count FROM delivery_stops WHERE run_id = $1 AND removed_at IS NULL`,
      [run.id]
    );
    // Pas de plafond de capacité : c'est l'entreprise qui décide combien de
    // colis un livreur peut porter. La capacité reste un simple indicateur.
    const order = await client.query(
      `SELECT id, driver_id, status FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [orderId, req.auth.company_id]
    );
    if (!order.rows[0]) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    if (String(order.rows[0].driver_id) !== String(run.driver_id)) {
      throw Object.assign(new Error('Cette commande est affectée à un autre livreur.'), { statusCode: 409 });
    }
    if (terminalOrderStatuses.includes(order.rows[0].status)) {
      throw Object.assign(new Error('Une commande terminée ne peut pas être ajoutée à une tournée.'), { statusCode: 409 });
    }
    const existing = await client.query(
      `SELECT run_id FROM delivery_stops WHERE order_id = $1 AND assignment_active = TRUE LIMIT 1`,
      [orderId]
    );
    if (existing.rows[0]) throw Object.assign(new Error(`Cette commande appartient déjà à la tournée n° ${existing.rows[0].run_id}.`), { statusCode: 409 });
    const nextSequence = count.rows[0].count + 1;
    const stop = await client.query(
      `INSERT INTO delivery_stops (company_id, run_id, order_id, sequence)
       VALUES ($1, $2, $3, $4) RETURNING id, sequence`,
      [req.auth.company_id, run.id, orderId, nextSequence]
    );
    const updated = await client.query(
      `UPDATE delivery_runs SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING version`,
      [run.id]
    );
    await appendRunEvent(client, req.auth, run.id, 'order_added', idempotencyKey, fingerprint, {
      stopId: stop.rows[0].id, orderId, sequence: stop.rows[0].sequence, version: updated.rows[0].version,
    });
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'delivery_run', $3, 'order_added', jsonb_build_object('orderId', $4::bigint, 'stopId', $5::bigint))`,
      [req.auth.company_id, req.auth.user_id, run.id, orderId, stop.rows[0].id]
    );
    await client.query('COMMIT');
    return res.status(201).json({ runId: run.id, stopId: stop.rows[0].id, version: updated.rows[0].version });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Cette commande est déjà affectée à une tournée.' });
    console.error('Run order add error:', error.message);
    return res.status(500).json({ error: 'Impossible d’ajouter cette commande.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/runs/:id/stops/:stopId/remove', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const expectedVersion = Number(req.body.expectedVersion);
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  const stopId = Number(req.params.stopId);
  if (!Number.isInteger(stopId) || !Number.isInteger(expectedVersion) || !idempotencyKey) {
    return res.status(400).json({ error: 'Arrêt, version ou clé d’action invalide.' });
  }
  const fingerprint = digest(canonicalJson({ action: 'remove_stop', stopId, expectedVersion }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repeated = await repeatedRunEvent(client, req.auth, req.params.id, idempotencyKey, fingerprint);
    if (repeated) {
      await client.query('COMMIT');
      return res.json({ runId: Number(req.params.id), version: repeated.details.version, alreadyApplied: true });
    }
    const runResult = await client.query(
      `SELECT * FROM delivery_runs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const run = runResult.rows[0];
    if (!run) throw Object.assign(new Error('Tournée introuvable.'), { statusCode: 404 });
    if (run.version !== expectedVersion) throw Object.assign(new Error('Cette tournée a changé. Rechargez-la avant de continuer.'), { statusCode: 409 });
    if (run.status !== 'draft') throw Object.assign(new Error('Un colis ne peut être retiré que pendant la préparation.'), { statusCode: 409 });
    const stop = await client.query(
      `SELECT id, order_id, sequence FROM delivery_stops
       WHERE id = $1 AND run_id = $2 AND company_id = $3 AND removed_at IS NULL FOR UPDATE`,
      [stopId, run.id, req.auth.company_id]
    );
    if (!stop.rows[0]) throw Object.assign(new Error('Arrêt introuvable ou déjà retiré.'), { statusCode: 404 });
    await client.query(
      `UPDATE delivery_stops SET removed_at = NOW(), assignment_active = FALSE, updated_at = NOW() WHERE id = $1`,
      [stopId]
    );
    await client.query(
      `UPDATE delivery_stops SET sequence = sequence + 100000, updated_at = NOW()
       WHERE run_id = $1 AND removed_at IS NULL AND sequence > $2`,
      [run.id, stop.rows[0].sequence]
    );
    await client.query(
      `UPDATE delivery_stops SET sequence = sequence - 100001, updated_at = NOW()
       WHERE run_id = $1 AND removed_at IS NULL AND sequence > 100000`,
      [run.id]
    );
    const updated = await client.query(
      `UPDATE delivery_runs SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING version`,
      [run.id]
    );
    await appendRunEvent(client, req.auth, run.id, 'order_removed', idempotencyKey, fingerprint, {
      stopId, orderId: stop.rows[0].order_id, formerSequence: stop.rows[0].sequence, version: updated.rows[0].version,
    });
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'delivery_run', $3, 'order_removed', jsonb_build_object('orderId', $4::bigint, 'stopId', $5::bigint))`,
      [req.auth.company_id, req.auth.user_id, run.id, stop.rows[0].order_id, stopId]
    );
    await client.query('COMMIT');
    return res.json({ runId: run.id, version: updated.rows[0].version });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Run stop remove error:', error.message);
    return res.status(500).json({ error: 'Impossible de retirer cet arrêt.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/runs/:id/reorder', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const expectedVersion = Number(req.body.expectedVersion);
  const stopIds = Array.isArray(req.body.stopIds) ? req.body.stopIds.map(Number) : [];
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!Number.isInteger(expectedVersion) || !idempotencyKey || !stopIds.length || stopIds.length > 100
      || stopIds.some((id) => !Number.isInteger(id) || id <= 0) || new Set(stopIds).size !== stopIds.length) {
    return res.status(400).json({ error: 'Ordre des arrêts, version ou clé d’action invalide.' });
  }
  const fingerprint = digest(canonicalJson({ action: 'reorder', stopIds, expectedVersion }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repeated = await repeatedRunEvent(client, req.auth, req.params.id, idempotencyKey, fingerprint);
    if (repeated) {
      await client.query('COMMIT');
      return res.json({ runId: Number(req.params.id), version: repeated.details.version, alreadyApplied: true });
    }
    const runResult = await client.query(
      `SELECT * FROM delivery_runs WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const run = runResult.rows[0];
    if (!run) throw Object.assign(new Error('Tournée introuvable.'), { statusCode: 404 });
    if (run.version !== expectedVersion) throw Object.assign(new Error('Cette tournée a changé. Rechargez-la avant d’enregistrer l’ordre.'), { statusCode: 409 });
    if (!['draft', 'planned'].includes(run.status)) throw Object.assign(new Error('Cette tournée ne peut plus être réorganisée.'), { statusCode: 409 });
    const current = await client.query(
      `SELECT id FROM delivery_stops WHERE run_id = $1 AND company_id = $2 AND removed_at IS NULL ORDER BY sequence FOR UPDATE`,
      [run.id, req.auth.company_id]
    );
    const currentIds = current.rows.map((row) => Number(row.id));
    if (currentIds.length !== stopIds.length || currentIds.some((id) => !stopIds.includes(id))) {
      throw Object.assign(new Error('La liste des arrêts a changé. Rechargez la tournée.'), { statusCode: 409 });
    }
    await client.query(
      `UPDATE delivery_stops SET sequence = sequence + 100000, updated_at = NOW()
       WHERE run_id = $1 AND removed_at IS NULL`,
      [run.id]
    );
    for (let index = 0; index < stopIds.length; index += 1) {
      await client.query(
        `UPDATE delivery_stops SET sequence = $1, updated_at = NOW()
         WHERE id = $2 AND run_id = $3 AND company_id = $4 AND removed_at IS NULL`,
        [index + 1, stopIds[index], run.id, req.auth.company_id]
      );
    }
    const updated = await client.query(
      `UPDATE delivery_runs SET version = version + 1, updated_at = NOW() WHERE id = $1 RETURNING version`,
      [run.id]
    );
    await appendRunEvent(client, req.auth, run.id, 'stops_reordered', idempotencyKey, fingerprint, {
      stopIds, version: updated.rows[0].version,
    });
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'delivery_run', $3, 'stops_reordered', jsonb_build_object('stopCount', $4::int))`,
      [req.auth.company_id, req.auth.user_id, run.id, stopIds.length]
    );
    await client.query('COMMIT');
    return res.json({ runId: run.id, version: updated.rows[0].version });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Run reorder error:', error.message);
    return res.status(500).json({ error: 'Impossible d’enregistrer l’ordre des arrêts.' });
  } finally {
    client.release();
  }
}));

app.get('/api/app/runs/:id/suggestion', requireCompanyApi, asyncRoute(async (req, res) => {
  const payload = await loadDeliveryRun(req.auth.company_id, req.params.id);
  if (!payload) return res.status(404).json({ error: 'Tournée introuvable.' });
  if (!['draft', 'planned'].includes(payload.status)) {
    return res.status(409).json({ error: 'Cette tournée ne peut plus être réorganisée.' });
  }
  if (payload.stops.length < 2) {
    return res.json({ available: false, reason: 'Ajoutez au moins deux arrêts pour obtenir une suggestion.' });
  }
  if (payload.stops.length > 50) {
    return res.json({ available: false, reason: 'La suggestion indicative est limitée à 50 arrêts.' });
  }
  const missingOrderIds = payload.stops
    .filter((stop) => !Number.isFinite(Number(stop.destination_lat)) || !Number.isFinite(Number(stop.destination_lng)))
    .map((stop) => stop.order_id);
  if (missingOrderIds.length) {
    return res.json({
      available: false,
      reason: 'Certaines destinations n’ont pas de position GPS.',
      missingOrderIds,
    });
  }
  const geoStops = payload.stops.map((stop) => ({
    id: Number(stop.id), lat: Number(stop.destination_lat), lng: Number(stop.destination_lng),
  }));
  // On privilégie l'ordre sur routes réelles (OSRM). En cas d'indisponibilité,
  // on retombe sur l'ordre géométrique à vol d'oiseau.
  try {
    const road = await optimizeStopOrderByRoad(geoStops);
    if (road) {
      return res.json({
        available: true,
        stopIds: road.stopIds,
        distanceKm: Number((road.distanceMeters / 1000).toFixed(2)),
        durationMin: Math.round(road.durationSeconds / 60),
        method: 'osrm_road_network',
        warning: 'Ordre calculé sur le réseau routier réel. Il ne tient pas compte du trafic en temps réel ni des créneaux clients : vérifiez avant de valider.',
      });
    }
  } catch (error) {
    console.error('Road optimization failed, falling back to geometric:', error.message);
  }
  const suggestion = suggestGeometricStopOrder(geoStops);
  return res.json({
    available: true,
    ...suggestion,
    distanceKm: Number(suggestion.distanceKm.toFixed(2)),
    method: 'straight_line_nearest_neighbor',
    warning: 'Ordre indicatif à vol d’oiseau (routage réel indisponible) : il ne tient pas compte des routes, du trafic ni des créneaux clients.',
  });
}));

app.post('/api/app/runs/:id/status', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const toStatus = String(req.body.toStatus || '').trim();
  const reason = String(req.body.reason || '').trim();
  const expectedVersion = Number(req.body.expectedVersion);
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!runStatuses.includes(toStatus) || !Number.isInteger(expectedVersion) || !idempotencyKey) {
    return res.status(400).json({ error: 'État, version ou clé d’action invalide.' });
  }
  if (toStatus === 'cancelled' && (reason.length < 10 || reason.length > 1000)) {
    return res.status(400).json({ error: 'Expliquez l’annulation en 10 à 1 000 caractères.' });
  }
  const fingerprint = digest(canonicalJson({ action: 'status', toStatus, reason: reason || null, expectedVersion }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repeated = await repeatedRunEvent(client, req.auth, req.params.id, idempotencyKey, fingerprint);
    if (repeated) {
      await client.query('COMMIT');
      return res.json({ runId: Number(req.params.id), status: repeated.details.toStatus, version: repeated.details.version, alreadyApplied: true });
    }
    const runResult = await client.query(
      `SELECT r.*, d.active AS driver_active, d.availability_status
       FROM delivery_runs r JOIN drivers d ON d.id = r.driver_id
       WHERE r.id = $1 AND r.company_id = $2 FOR UPDATE OF r`,
      [req.params.id, req.auth.company_id]
    );
    const run = runResult.rows[0];
    if (!run) throw Object.assign(new Error('Tournée introuvable.'), { statusCode: 404 });
    if (run.version !== expectedVersion) throw Object.assign(new Error('Cette tournée a changé. Rechargez-la avant de continuer.'), { statusCode: 409 });
    if (!(runTransitions[run.status] || []).includes(toStatus)) {
      throw Object.assign(new Error(`Le passage de « ${run.status} » à « ${toStatus} » n’est pas autorisé.`), { statusCode: 409 });
    }
    const stops = await client.query(
      `SELECT s.id, o.status FROM delivery_stops s JOIN orders o ON o.id = s.order_id
       WHERE s.run_id = $1 AND s.company_id = $2 AND s.removed_at IS NULL FOR UPDATE OF s, o`,
      [run.id, req.auth.company_id]
    );
    if (['planned', 'active'].includes(toStatus) && !stops.rowCount) {
      throw Object.assign(new Error('Ajoutez au moins un colis avant de planifier ou démarrer la tournée.'), { statusCode: 409 });
    }
    if (toStatus === 'active') {
      if (!run.driver_active || ['off_duty', 'incident'].includes(run.availability_status)) {
        throw Object.assign(new Error('Le livreur doit être actif et disponible avant le départ.'), { statusCode: 409 });
      }
      if (stops.rows.some((stop) => terminalOrderStatuses.includes(stop.status))) {
        throw Object.assign(new Error('Une commande de cette tournée est déjà terminée. Revenez au brouillon pour la corriger.'), { statusCode: 409 });
      }
    }
    if (toStatus === 'completed' && (!stops.rowCount || stops.rows.some((stop) => !terminalOrderStatuses.includes(stop.status)))) {
      throw Object.assign(new Error('La tournée ne peut être terminée que lorsque tous ses colis sont livrés, retournés ou annulés.'), { statusCode: 409 });
    }
    const updated = await client.query(
      `UPDATE delivery_runs
       SET status = $1, version = version + 1, updated_at = NOW(),
           started_at = CASE WHEN $1 = 'active' THEN COALESCE(started_at, NOW()) ELSE started_at END,
           completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END,
           cancelled_at = CASE WHEN $1 = 'cancelled' THEN NOW() ELSE cancelled_at END
       WHERE id = $2 RETURNING version`,
      [toStatus, run.id]
    );
    if (['completed', 'cancelled'].includes(toStatus)) {
      await client.query(
        `UPDATE delivery_stops SET assignment_active = FALSE, updated_at = NOW()
         WHERE run_id = $1 AND removed_at IS NULL`,
        [run.id]
      );
    }
    await appendRunEvent(client, req.auth, run.id, 'status_changed', idempotencyKey, fingerprint, {
      fromStatus: run.status, toStatus, reason: reason || null, version: updated.rows[0].version,
    });
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'delivery_run', $3, 'status_changed', jsonb_build_object('fromStatus', $4::text, 'toStatus', $5::text, 'reason', $6::text))`,
      [req.auth.company_id, req.auth.user_id, run.id, run.status, toStatus, reason || null]
    );
    await client.query('COMMIT');
    return res.json({ runId: run.id, status: toStatus, version: updated.rows[0].version });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Run status error:', error.message);
    return res.status(500).json({ error: 'Impossible de changer l’état de la tournée.' });
  } finally {
    client.release();
  }
}));

app.get('/api/app/orders', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT o.id, o.reference, o.status, o.customer_name, o.customer_phone, o.requested_time,
            o.neighborhood, o.landmark, o.created_at, o.updated_at,
            d.id AS driver_id, d.name AS driver_name, d.traccar_unique_id AS driver_unique_id,
            (d.photo_updated_at IS NOT NULL) AS driver_has_photo, d.photo_updated_at AS driver_photo_at,
            t.token_ciphertext AS tracking_token_ciphertext,
            t.expires_at AS tracking_expires_at, t.revoked_at AS tracking_revoked_at,
            t.created_at AS tracking_created_at, t.version AS tracking_link_version
     FROM orders o
     JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN tracking_links t ON t.order_id = o.id
     WHERE o.company_id = $1 ORDER BY o.created_at DESC LIMIT 500`,
    [req.auth.company_id]
  );
  const online = await driverOnlineByUnique();
  return res.json(result.rows.map((row) => {
    const trackingLink = trackingLinkBusinessView(row);
    delete row.tracking_token_ciphertext;
    return { ...row, trackingLink, ...decorateRowDriver(row, online) };
  }));
}));

app.get('/api/app/orders/:id', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT o.*, d.name AS driver_name, d.phone AS driver_phone,
            d.vehicle_type AS driver_vehicle_type,
            d.id AS driver_id, d.traccar_unique_id AS driver_unique_id,
            (d.photo_updated_at IS NOT NULL) AS driver_has_photo,
            d.photo_updated_at AS driver_photo_at,
            t.token_ciphertext AS tracking_token_ciphertext,
            t.expires_at AS tracking_expires_at, t.revoked_at AS tracking_revoked_at,
            t.created_at AS tracking_created_at, t.version AS tracking_link_version,
            p.id AS proof_id, p.proof_type, p.verified_at AS proof_verified_at,
            pa.id AS payment_account_id, pa.expected_amount_minor, pa.currency AS payment_currency,
            pa.status AS payment_status, pa.collected_amount_minor, pa.collection_method,
            pa.collection_reference, pa.discrepancy_reason, pa.collected_at,
            pa.reconciled_at, pa.reconciliation_note,
            c.photo_proof_mode, c.signature_proof_mode,
            (SELECT c.expires_at FROM delivery_otp_challenges c
             WHERE c.order_id = o.id AND c.consumed_at IS NULL AND c.revoked_at IS NULL
               AND c.expires_at > NOW()
             ORDER BY c.created_at DESC LIMIT 1) AS active_otp_expires_at
     FROM orders o
     JOIN drivers d ON d.id = o.driver_id
     JOIN companies c ON c.id = o.company_id
     LEFT JOIN tracking_links t ON t.order_id = o.id
     LEFT JOIN delivery_proofs p ON p.order_id = o.id AND p.proof_type = 'otp'
     LEFT JOIN order_payment_accounts pa ON pa.order_id = o.id
     WHERE o.id = $1 AND o.company_id = $2`,
    [req.params.id, req.auth.company_id]
  );
  const order = result.rows[0];
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  const [events, incidents, paymentEvents, paymentAdjustments, evidence] = await Promise.all([
    pool.query(
      `SELECT e.id, e.from_status, e.to_status, e.reason, e.metadata, e.created_at,
              COALESCE(u.display_name, 'Système') AS actor_name
       FROM order_status_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.order_id = $1 AND e.company_id = $2 ORDER BY e.created_at ASC, e.id ASC`,
      [order.id, req.auth.company_id]
    ),
    pool.query(
      `SELECT i.id, i.category, i.severity, i.description, i.status, i.resolution,
              i.created_at, i.resolved_at, COALESCE(u.display_name, 'Système') AS opened_by
       FROM delivery_incidents i
       LEFT JOIN users u ON u.id = i.opened_by_user_id
       WHERE i.order_id = $1 AND i.company_id = $2 ORDER BY i.created_at DESC, i.id DESC`,
      [order.id, req.auth.company_id]
    ),
    pool.query(
      `SELECT pe.id, pe.event_type, pe.amount_minor, pe.currency, pe.method,
              pe.reference, pe.reason, pe.created_at,
              COALESCE(u.display_name, 'Système') AS actor_name
       FROM payment_events pe LEFT JOIN users u ON u.id = pe.actor_user_id
       WHERE pe.order_id = $1 AND pe.company_id = $2 ORDER BY pe.created_at ASC, pe.id ASC`,
      [order.id, req.auth.company_id]
    ),
    pool.query(
      `SELECT a.id, a.adjustment_type, a.direction, a.amount_minor, a.currency, a.method,
              a.reference, a.reason, TO_CHAR(a.effective_date, 'YYYY-MM-DD') AS effective_date,
              a.reverses_adjustment_id, a.created_at,
              COALESCE(u.display_name, 'Système') AS actor_name,
              EXISTS (SELECT 1 FROM payment_adjustments r WHERE r.reverses_adjustment_id = a.id) AS reversed
       FROM payment_adjustments a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.order_id = $1 AND a.company_id = $2 ORDER BY a.created_at ASC, a.id ASC`,
      [order.id, req.auth.company_id]
    ),
    pool.query(
      `SELECT id, evidence_type, mime_type, byte_size, created_at
       FROM delivery_evidence_files
       WHERE order_id = $1 AND company_id = $2 AND superseded_at IS NULL AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [order.id, req.auth.company_id]
    ),
  ]);
  const trackingLink = trackingLinkBusinessView(order);
  delete order.tracking_token_ciphertext;
  const onlineMap = await driverOnlineByUnique();
  const driverDeco = decorateRowDriver(order, onlineMap);
  delete order.driver_unique_id;
  delete order.driver_has_photo;
  delete order.driver_photo_at;
  return res.json({
    ...order,
    ...driverDeco,
    trackingLink,
    allowedTransitions: allowedOrderTransitions(order.status),
    requiresOtpForDelivery: order.status === 'Arrivée' && !order.proof_id,
    paymentBlocksDelivery: Boolean(order.payment_account_id && ['pending', 'discrepancy'].includes(order.payment_status)),
    isTerminal: terminalOrderStatuses.includes(order.status),
    events: events.rows,
    incidents: incidents.rows,
    paymentEvents: paymentEvents.rows,
    paymentAdjustments: paymentAdjustments.rows,
    paymentAdjustedTotalMinor: Number(order.collected_amount_minor || 0) + paymentAdjustments.rows.reduce(
      (total, adjustment) => total + (adjustment.direction === 'inflow' ? Number(adjustment.amount_minor) : -Number(adjustment.amount_minor)), 0
    ),
    evidence: evidence.rows,
  });
}));

app.post('/api/app/orders/:id/tracking-link/reveal', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT o.id AS order_id, o.status AS order_status,
              t.id, t.token, t.token_ciphertext, t.expires_at, t.created_at,
              t.revoked_at, t.generation, t.version
       FROM orders o
       JOIN tracking_links t ON t.order_id = o.id AND t.company_id = o.company_id
       WHERE o.id = $1 AND o.company_id = $2
       FOR SHARE OF t`,
      [req.params.id, req.auth.company_id]
    );
    const link = result.rows[0];
    if (!link) throw Object.assign(new Error('Commande ou lien de suivi introuvable.'), { statusCode: 404 });
    const trackingLink = trackingLinkBusinessView({ ...link, status: link.order_status }, true);
    if (!trackingLink.path) throw Object.assign(new Error('Ce lien n’est plus actif. Renouvelez-le si la livraison continue.'), { statusCode: 409 });
    await client.query(
      `INSERT INTO tracking_link_events (
         company_id, tracking_link_id, order_id, generation, event_type,
         actor_user_id, reason, result_version
       ) VALUES ($1, $2, $3, $4, 'revealed', $5, 'manual_reveal', $6)`,
      [req.auth.company_id, link.id, link.order_id, link.generation, req.auth.user_id, link.version]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'tracking_link', $3, 'revealed', jsonb_build_object('orderId', $4::bigint, 'version', $5::integer))`,
      [req.auth.company_id, req.auth.user_id, link.id, link.order_id, link.version]
    );
    await client.query('COMMIT');
    return res.json({ orderId: link.order_id, trackingLink });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Tracking link reveal error:', error.message);
    return res.status(500).json({ error: 'Impossible d’afficher le lien de suivi.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/tracking-link/rotate', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  const expiresInDays = req.body.expiresInDays === undefined ? 7 : Number(req.body.expiresInDays);
  const expectedVersion = Number(req.body.expectedVersion);
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide. Rechargez puis réessayez.' });
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
    return res.status(400).json({ error: 'Choisissez une durée comprise entre 1 et 30 jours.' });
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return res.status(400).json({ error: 'La version du lien est absente. Rechargez la commande.' });
  }
  const fingerprint = digest(JSON.stringify({
    action: 'rotate_tracking_link', orderId: String(req.params.id), expiresInDays, expectedVersion,
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let replay = await trackingLinkEventReplay(client, {
      companyId: req.auth.company_id, orderId: req.params.id, eventType: 'rotated', idempotencyKey, fingerprint,
    });
    if (replay) {
      await client.query('COMMIT');
      return res.json(replay);
    }
    const result = await client.query(
      `SELECT o.id AS order_id, o.status AS order_status,
              t.id, t.token, t.token_ciphertext, t.expires_at, t.created_at, t.revoked_at,
              t.generation, t.version
       FROM orders o
       JOIN tracking_links t ON t.order_id = o.id AND t.company_id = o.company_id
       WHERE o.id = $1 AND o.company_id = $2
       FOR UPDATE OF o, t`,
      [req.params.id, req.auth.company_id]
    );
    const link = result.rows[0];
    if (!link) throw Object.assign(new Error('Commande ou lien de suivi introuvable.'), { statusCode: 404 });
    replay = await trackingLinkEventReplay(client, {
      companyId: req.auth.company_id, orderId: req.params.id, eventType: 'rotated', idempotencyKey, fingerprint,
    });
    if (replay) {
      await client.query('COMMIT');
      return res.json(replay);
    }
    if (Number(link.version) !== expectedVersion) {
      throw Object.assign(new Error('Ce lien a été modifié ailleurs. Rechargez la commande avant de recommencer.'), { statusCode: 409 });
    }
    const plan = planTrackingLinkRotation({
      link: {
        expires_at: link.expires_at,
        created_at: link.created_at,
        revoked_at: link.revoked_at,
        order_status: link.order_status,
      },
      ttlMs: expiresInDays * 24 * 60 * 60 * 1000,
    });
    const token = randomToken(24);
    const stored = trackingTokenStorage(token);
    const updated = await client.query(
      `UPDATE tracking_links
       SET token_hash = $1, token_ciphertext = $2, token = $3, expires_at = $4,
           revoked_at = NULL, revoked_by_user_id = NULL, revocation_reason = NULL,
           last_rotated_at = $5, generation = generation + 1, version = version + 1, updated_at = NOW()
       WHERE id = $6
       RETURNING generation, version`,
      [stored.tokenHash, stored.tokenCiphertext, encryptedOnlyTrackingTokenStorage() ? null : token,
        plan.next.expiresAt, plan.effectiveAt, link.id]
    );
    await client.query(
      `INSERT INTO tracking_link_events (
         company_id, tracking_link_id, order_id, generation, event_type, actor_user_id,
         reason, idempotency_key, request_fingerprint, result_version
       ) VALUES ($1, $2, $3, $4, 'rotated', $5, 'operator_rotation', $6, $7, $8)`,
      [req.auth.company_id, link.id, link.order_id, updated.rows[0].generation, req.auth.user_id,
        idempotencyKey, fingerprint, updated.rows[0].version]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'tracking_link', $3, 'rotated',
         jsonb_build_object('orderId', $4::bigint, 'expiresAt', $5::text, 'version', $6::integer))`,
      [req.auth.company_id, req.auth.user_id, link.id, link.order_id, plan.next.expiresAt, updated.rows[0].version]
    );
    await client.query('COMMIT');
    return res.json({
      orderId: link.order_id,
      trackingLink: {
        state: 'active', path: `/suivi/${token}`, expiresAt: plan.next.expiresAt,
        revokedAt: null, version: Number(updated.rows[0].version),
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof TrackingLinkPolicyError) {
      const status = error.code === 'terminal_order' ? 409 : error.code === 'link_unavailable' ? 404 : 400;
      const message = error.code === 'terminal_order'
        ? 'Une commande terminée ne peut pas recevoir un nouveau lien.'
        : 'Le lien de suivi ne peut pas être renouvelé.';
      return res.status(status).json({ error: message });
    }
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Tracking link rotation error:', error.message);
    return res.status(500).json({ error: 'Impossible de renouveler le lien de suivi.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/tracking-link/revoke', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  const reason = String(req.body.reason || '').trim();
  const expectedVersion = Number(req.body.expectedVersion);
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide. Rechargez puis réessayez.' });
  if (reason.length < 8 || reason.length > 500) {
    return res.status(400).json({ error: 'Expliquez la révocation en 8 à 500 caractères.' });
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return res.status(400).json({ error: 'La version du lien est absente. Rechargez la commande.' });
  }
  const fingerprint = digest(JSON.stringify({
    action: 'revoke_tracking_link', orderId: String(req.params.id), reason, expectedVersion,
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let replay = await trackingLinkEventReplay(client, {
      companyId: req.auth.company_id, orderId: req.params.id, eventType: 'revoked', idempotencyKey, fingerprint,
    });
    if (replay) {
      await client.query('COMMIT');
      return res.json(replay);
    }
    const result = await client.query(
      `SELECT o.id AS order_id, o.status AS order_status,
              t.id, t.expires_at, t.created_at, t.revoked_at, t.generation, t.version
       FROM orders o
       JOIN tracking_links t ON t.order_id = o.id AND t.company_id = o.company_id
       WHERE o.id = $1 AND o.company_id = $2
       FOR UPDATE OF o, t`,
      [req.params.id, req.auth.company_id]
    );
    const link = result.rows[0];
    if (!link) throw Object.assign(new Error('Commande ou lien de suivi introuvable.'), { statusCode: 404 });
    replay = await trackingLinkEventReplay(client, {
      companyId: req.auth.company_id, orderId: req.params.id, eventType: 'revoked', idempotencyKey, fingerprint,
    });
    if (replay) {
      await client.query('COMMIT');
      return res.json(replay);
    }
    if (Number(link.version) !== expectedVersion) {
      throw Object.assign(new Error('Ce lien a été modifié ailleurs. Rechargez la commande avant de recommencer.'), { statusCode: 409 });
    }
    const plan = planTrackingLinkRevocation({
      link: { expires_at: link.expires_at, created_at: link.created_at, revoked_at: link.revoked_at, order_status: link.order_status },
      reason: 'operator_request',
    });
    if (plan.action === 'no_op') {
      await client.query(
        `INSERT INTO tracking_link_events (
           company_id, tracking_link_id, order_id, generation, event_type, actor_user_id,
           reason, idempotency_key, request_fingerprint, result_version
         ) VALUES ($1, $2, $3, $4, 'revoked', $5, $6, $7, $8, $9)`,
        [req.auth.company_id, link.id, link.order_id, link.generation, req.auth.user_id,
          reason, idempotencyKey, fingerprint, link.version]
      );
      await client.query('COMMIT');
      return res.json({ orderId: link.order_id, trackingLink: { state: 'revoked', path: null, revokedAt: link.revoked_at, version: Number(link.version) }, alreadyApplied: true });
    }
    const updated = await client.query(
      `UPDATE tracking_links
       SET revoked_at = $1, revoked_by_user_id = $2, revocation_reason = $3,
           version = version + 1, updated_at = NOW()
       WHERE id = $4
       RETURNING generation, version`,
      [plan.effectiveAt, req.auth.user_id, reason, link.id]
    );
    await client.query(
      `INSERT INTO tracking_link_events (
         company_id, tracking_link_id, order_id, generation, event_type, actor_user_id,
         reason, idempotency_key, request_fingerprint, result_version
       ) VALUES ($1, $2, $3, $4, 'revoked', $5, $6, $7, $8, $9)`,
      [req.auth.company_id, link.id, link.order_id, updated.rows[0].generation, req.auth.user_id,
        reason, idempotencyKey, fingerprint, updated.rows[0].version]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'tracking_link', $3, 'revoked',
         jsonb_build_object('orderId', $4::bigint, 'reason', $5::text, 'version', $6::integer))`,
      [req.auth.company_id, req.auth.user_id, link.id, link.order_id, reason, updated.rows[0].version]
    );
    await client.query('COMMIT');
    return res.json({
      orderId: link.order_id,
      trackingLink: { state: 'revoked', path: null, revokedAt: plan.effectiveAt, version: Number(updated.rows[0].version) },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof TrackingLinkPolicyError) return res.status(409).json({ error: 'Le lien de suivi ne peut pas être révoqué.' });
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Tracking link revocation error:', error.message);
    return res.status(500).json({ error: 'Impossible de révoquer le lien de suivi.' });
  } finally {
    client.release();
  }
}));

// Réassignation d'une commande à un autre livreur (version simplifiée) : on
// change le livreur, on déplace la commande de la tournée du jour de l'ancien
// livreur vers celle du nouveau. Interdit sur une commande terminée.
app.post('/api/app/orders/:id/reassign', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const newDriverId = Number(req.body.driverId);
  if (!Number.isInteger(newDriverId) || newDriverId <= 0) return res.status(400).json({ error: 'Sélectionnez un livreur.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, driver_id, status, version FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    if (terminalOrderStatuses.includes(order.status)) {
      throw Object.assign(new Error('Une commande terminée ne peut pas être réassignée.'), { statusCode: 409 });
    }
    const driver = await client.query(
      `SELECT id, name, active FROM drivers WHERE id = $1 AND company_id = $2 AND archived_at IS NULL`,
      [newDriverId, req.auth.company_id]
    );
    if (!driver.rows[0]) throw Object.assign(new Error('Livreur introuvable.'), { statusCode: 404 });
    if (!driver.rows[0].active) throw Object.assign(new Error('Ce livreur est désactivé.'), { statusCode: 409 });
    if (String(order.driver_id) === String(newDriverId)) {
      await client.query('COMMIT');
      return res.json({ orderId: order.id, driverId: newDriverId, driverName: driver.rows[0].name, unchanged: true });
    }
    await client.query(
      `UPDATE orders SET driver_id = $1, version = version + 1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [newDriverId, order.id, req.auth.company_id]
    );
    const activeStop = await client.query(
      `SELECT id, run_id FROM delivery_stops WHERE order_id = $1 AND assignment_active = TRUE FOR UPDATE`,
      [order.id]
    );
    if (activeStop.rows[0]) {
      await client.query(
        `UPDATE delivery_stops SET assignment_active = FALSE, removed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [activeStop.rows[0].id]
      );
      await client.query(
        `UPDATE delivery_runs SET version = version + 1, updated_at = NOW() WHERE id = $1`,
        [activeStop.rows[0].run_id]
      );
      await appendRunEvent(client, req.auth, activeStop.rows[0].run_id, 'order_removed',
        `reassign-out:${order.id}:${Date.now()}`, digest(canonicalJson({ orderId: order.id, reassign: true })),
        { orderId: order.id, reason: 'reassigned' });
    }
    try {
      await client.query('SAVEPOINT sp_reassign');
      await attachOrderToDayRun(client, req.auth, order.id, newDriverId, todayServiceDate());
      await client.query('RELEASE SAVEPOINT sp_reassign');
    } catch (attachError) {
      await client.query('ROLLBACK TO SAVEPOINT sp_reassign');
      console.error('Reassign attach failed:', attachError.message);
    }
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'reassigned', jsonb_build_object('fromDriverId', $4::bigint, 'toDriverId', $5::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, order.driver_id, newDriverId]
    );
    await client.query('COMMIT');
    return res.json({ orderId: order.id, driverId: newDriverId, driverName: driver.rows[0].name });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Reassign error:', error.message);
    return res.status(500).json({ error: 'Réassignation impossible.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/transition', requireCompanyApi, asyncRoute(async (req, res) => {
  const toStatus = String(req.body.toStatus || '').trim();
  const reason = String(req.body.reason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide. Rechargez puis réessayez.' });
  if (!Object.prototype.hasOwnProperty.call(orderTransitions, toStatus)) {
    return res.status(400).json({ error: 'Étape de livraison invalide.' });
  }
  if (reasonRequiredStatuses.includes(toStatus) && reason.length < 5) {
    return res.status(400).json({ error: 'Expliquez la raison en au moins 5 caractères.' });
  }
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), toStatus, reason }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status, version FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });

    const repeated = await client.query(
      `SELECT id, order_id, to_status, request_fingerprint FROM order_status_events
       WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_fingerprint !== fingerprint || String(repeated.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée pour une autre opération.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ orderId: order.id, status: repeated.rows[0].to_status, eventId: repeated.rows[0].id, alreadyApplied: true });
    }
    if (!allowedOrderTransitions(order.status).includes(toStatus)) {
      throw Object.assign(new Error(`La commande est maintenant « ${order.status} ». Cette transition n’est plus possible.`), { statusCode: 409 });
    }

    const event = await client.query(
      `INSERT INTO order_status_events (
         company_id, order_id, from_status, to_status, reason, actor_user_id,
         idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
      [req.auth.company_id, order.id, order.status, toStatus, reason || null, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `UPDATE orders SET status = $1, version = version + 1, status_changed_at = NOW(), updated_at = NOW(),
         completed_at = CASE WHEN $1 = ANY($2::text[]) THEN NOW() ELSE completed_at END,
         cancelled_at = CASE WHEN $1 = 'Annulée' THEN NOW() ELSE cancelled_at END,
         failure_reason = CASE WHEN $1 = ANY($3::text[]) THEN $4 ELSE failure_reason END
       WHERE id = $5`,
      [toStatus, terminalOrderStatuses, reasonRequiredStatuses, reason || null, order.id]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'status_changed', jsonb_build_object('from', $4::text, 'to', $5::text, 'eventId', $6::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, order.status, toStatus, event.rows[0].id]
    );
    await client.query('COMMIT');
    return res.json({ orderId: order.id, status: toStatus, eventId: event.rows[0].id, version: Number(order.version) + 1 });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Order transition error:', error.message);
    return res.status(500).json({ error: 'Impossible de mettre à jour cette livraison.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/otp', requireCompanyApi, asyncRoute(async (req, res) => {
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    if (order.status !== 'Arrivée') {
      throw Object.assign(new Error('Le code de remise est disponible uniquement lorsque le livreur est arrivé.'), { statusCode: 409 });
    }
    const proof = await client.query(`SELECT id FROM delivery_proofs WHERE order_id = $1 AND proof_type = 'otp'`, [order.id]);
    if (proof.rows[0]) throw Object.assign(new Error('La remise de cette commande est déjà confirmée.'), { statusCode: 409 });

    const existing = await client.query(
      `SELECT id, order_id, expires_at, attempts_remaining FROM delivery_otp_challenges
       WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    const code = otpCodeFor(req.auth.company_id, order.id, idempotencyKey);
    if (existing.rows[0]) {
      if (String(existing.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée pour une autre commande.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ code, expiresAt: existing.rows[0].expires_at, attemptsRemaining: existing.rows[0].attempts_remaining, alreadyGenerated: true });
    }

    await client.query(
      `UPDATE delivery_otp_challenges SET revoked_at = NOW()
       WHERE order_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [order.id]
    );
    const salt = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const challenge = await client.query(
      `INSERT INTO delivery_otp_challenges (
         company_id, order_id, code_salt, code_hash, idempotency_key,
         attempts_remaining, expires_at, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, 5, $6, $7) RETURNING id`,
      [req.auth.company_id, order.id, salt, hashPassword(code, salt), idempotencyKey, expiresAt, req.auth.user_id]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'delivery_otp_generated', jsonb_build_object('challengeId', $4::bigint, 'expiresAt', $5::text))`,
      [req.auth.company_id, req.auth.user_id, order.id, challenge.rows[0].id, expiresAt.toISOString()]
    );
    await client.query('COMMIT');
    return res.status(201).json({ code, expiresAt, attemptsRemaining: 5 });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('OTP generation error:', error.message);
    return res.status(500).json({ error: 'Impossible de générer le code de remise.' });
  } finally {
    client.release();
  }
}));

async function verifyOrderOtp(req, res, driverScoped = false) {
  const code = String(req.body.code || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Saisissez le code à 6 chiffres.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), action: 'verify_otp', codeDigest: digest(code) }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status, version FROM orders
       WHERE id = $1 AND company_id = $2${driverScoped ? ' AND driver_id = $3' : ''} FOR UPDATE`,
      driverScoped ? [req.params.id, req.auth.company_id, req.auth.driver_id] : [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    const previousAttempt = await client.query(
      `SELECT id, order_id, request_fingerprint, success, attempts_remaining
       FROM delivery_otp_attempts WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (previousAttempt.rows[0]) {
      const attempt = previousAttempt.rows[0];
      if (attempt.request_fingerprint !== fingerprint || String(attempt.order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée pour une autre tentative.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      if (attempt.success) return res.json({ orderId: order.id, status: 'Livrée', alreadyVerified: true });
      const retryStatus = attempt.attempts_remaining ? 400 : 429;
      return res.status(retryStatus).json({
        error: attempt.attempts_remaining ? `Code incorrect. ${attempt.attempts_remaining} essai(s) restant(s).` : 'Trop d’essais. Générez un nouveau code.',
        attemptsRemaining: attempt.attempts_remaining,
        alreadyAttempted: true,
      });
    }
    const repeated = await client.query(
      `SELECT id, order_id, request_fingerprint FROM order_status_events
       WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_fingerprint !== fingerprint || String(repeated.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ orderId: order.id, status: 'Livrée', alreadyVerified: true });
    }
    if (order.status !== 'Arrivée') {
      throw Object.assign(new Error(`La commande est maintenant « ${order.status} » et ne peut pas être remise avec ce code.`), { statusCode: 409 });
    }
    const paymentResult = await client.query(
      `SELECT status FROM order_payment_accounts WHERE order_id = $1 FOR UPDATE`,
      [order.id]
    );
    if (paymentResult.rows[0] && ['pending', 'discrepancy'].includes(paymentResult.rows[0].status)) {
      const message = paymentResult.rows[0].status === 'discrepancy'
        ? 'L’écart d’encaissement doit être rapproché avant de confirmer la remise.'
        : 'Enregistrez l’encaissement attendu avant de confirmer la remise.';
      throw Object.assign(new Error(message), { statusCode: 409 });
    }
    const evidencePolicy = await client.query(
      `SELECT c.photo_proof_mode, c.signature_proof_mode,
              EXISTS (SELECT 1 FROM delivery_evidence_files e WHERE e.order_id = $2 AND e.evidence_type = 'photo' AND e.superseded_at IS NULL AND e.deleted_at IS NULL) AS has_photo,
              EXISTS (SELECT 1 FROM delivery_evidence_files e WHERE e.order_id = $2 AND e.evidence_type = 'signature' AND e.superseded_at IS NULL AND e.deleted_at IS NULL) AS has_signature
       FROM companies c WHERE c.id = $1`,
      [req.auth.company_id, order.id]
    );
    const policy = evidencePolicy.rows[0];
    const missingEvidence = [];
    if (policy?.photo_proof_mode === 'required' && !policy.has_photo) missingEvidence.push('photo');
    if (policy?.signature_proof_mode === 'required' && !policy.has_signature) missingEvidence.push('signature');
    if (missingEvidence.length) {
      throw Object.assign(new Error(`Ajoutez la preuve obligatoire avant la remise : ${missingEvidence.join(' et ')}.`), { statusCode: 409 });
    }
    const challengeResult = await client.query(
      `SELECT id, code_salt, code_hash, attempts_remaining FROM delivery_otp_challenges
       WHERE order_id = $1 AND company_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL
         AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [order.id, req.auth.company_id]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) throw Object.assign(new Error('Aucun code actif. Générez un nouveau code de remise.'), { statusCode: 409 });
    if (!passwordMatches(code, challenge.code_salt, challenge.code_hash)) {
      const remaining = Math.max(0, challenge.attempts_remaining - 1);
      await client.query(
        `UPDATE delivery_otp_challenges SET attempts_remaining = $1,
           revoked_at = CASE WHEN $1 = 0 THEN NOW() ELSE revoked_at END WHERE id = $2`,
        [remaining, challenge.id]
      );
      await client.query(
        `INSERT INTO delivery_otp_attempts (
           company_id, order_id, otp_challenge_id, idempotency_key, request_fingerprint,
           success, attempts_remaining, attempted_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7)`,
        [req.auth.company_id, order.id, challenge.id, idempotencyKey, fingerprint, remaining, req.auth.user_id]
      );
      await client.query(
        `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
         VALUES ($1, $2, 'order', $3, 'delivery_otp_failed', jsonb_build_object('attemptsRemaining', $4::int))`,
        [req.auth.company_id, req.auth.user_id, order.id, remaining]
      );
      await client.query('COMMIT');
      return res.status(remaining ? 400 : 429).json({ error: remaining ? `Code incorrect. ${remaining} essai(s) restant(s).` : 'Trop d’essais. Générez un nouveau code.', attemptsRemaining: remaining });
    }

    const proof = await client.query(
      `INSERT INTO delivery_proofs (company_id, order_id, proof_type, otp_challenge_id, verified_by_user_id, details)
       VALUES ($1, $2, 'otp', $3, $4, jsonb_build_object('method', 'one_time_code')) RETURNING id, verified_at`,
      [req.auth.company_id, order.id, challenge.id, req.auth.user_id]
    );
    await client.query(
      `INSERT INTO delivery_otp_attempts (
         company_id, order_id, otp_challenge_id, idempotency_key, request_fingerprint,
         success, attempts_remaining, attempted_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, TRUE, 0, $6)`,
      [req.auth.company_id, order.id, challenge.id, idempotencyKey, fingerprint, req.auth.user_id]
    );
    await client.query(`UPDATE delivery_otp_challenges SET consumed_at = NOW(), attempts_remaining = 0 WHERE id = $1`, [challenge.id]);
    const event = await client.query(
      `INSERT INTO order_status_events (
         company_id, order_id, from_status, to_status, actor_user_id,
         idempotency_key, request_fingerprint, metadata
       ) VALUES ($1, $2, 'Arrivée', 'Livrée', $3, $4, $5, jsonb_build_object('proofId', $6::bigint, 'proofType', 'otp')) RETURNING id`,
      [req.auth.company_id, order.id, req.auth.user_id, idempotencyKey, fingerprint, proof.rows[0].id]
    );
    await client.query(
      `UPDATE orders SET status = 'Livrée', version = version + 1, status_changed_at = NOW(),
         completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [order.id]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'delivered_with_otp', jsonb_build_object('proofId', $4::bigint, 'eventId', $5::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, proof.rows[0].id, event.rows[0].id]
    );
    await client.query('COMMIT');
    return res.json({ orderId: order.id, status: 'Livrée', proofId: proof.rows[0].id, verifiedAt: proof.rows[0].verified_at });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('OTP verification error:', error.message);
    return res.status(500).json({ error: 'Impossible de confirmer la remise.' });
  } finally {
    client.release();
  }
}

app.post('/api/app/orders/:id/otp/verify', requireCompanyApi, asyncRoute(async (req, res) => {
  return verifyOrderOtp(req, res);
}));

app.post('/api/app/orders/:id/incidents', requireCompanyApi, asyncRoute(async (req, res) => {
  return openDeliveryIncident(req, res);
}));

app.post('/api/app/incidents/:id/resolve', requireCompanyApi, asyncRoute(async (req, res) => {
  const resolution = String(req.body.resolution || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (resolution.length < 5 || resolution.length > 2000) return res.status(400).json({ error: 'Précisez la résolution de l’incident.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ incidentId: String(req.params.id), resolution }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const incidentResult = await client.query(
      `SELECT id, order_id, status, resolution_idempotency_key, resolution_fingerprint
       FROM delivery_incidents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const incident = incidentResult.rows[0];
    if (!incident) throw Object.assign(new Error('Incident introuvable.'), { statusCode: 404 });
    if (incident.status === 'resolved') {
      if (incident.resolution_idempotency_key !== idempotencyKey || incident.resolution_fingerprint !== fingerprint) {
        throw Object.assign(new Error('Cet incident a déjà été résolu.'), { statusCode: 409 });
      }
      await appendIncidentEvent(client, req.auth, incident.id, 'resolved', resolution, {}, idempotencyKey);
      await client.query('COMMIT');
      return res.json({ id: incident.id, status: 'resolved', alreadyResolved: true });
    }
    await client.query(
      `UPDATE delivery_incidents SET status = 'resolved', resolution = $1, resolved_by_user_id = $2,
         resolution_idempotency_key = $3, resolution_fingerprint = $4,
         resolved_at = NOW(), updated_at = NOW() WHERE id = $5`,
      [resolution, req.auth.user_id, idempotencyKey, fingerprint, incident.id]
    );
    await appendIncidentEvent(client, req.auth, incident.id, 'resolved', resolution, {}, idempotencyKey);
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'incident_resolved', jsonb_build_object('incidentId', $4::bigint))`,
      [req.auth.company_id, req.auth.user_id, incident.order_id, incident.id]
    );
    await client.query('COMMIT');
    return res.json({ id: incident.id, status: 'resolved' });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Incident resolution error:', error.message);
    return res.status(500).json({ error: 'Impossible de résoudre cet incident.' });
  } finally {
    client.release();
  }
}));

app.get('/api/app/incidents', requireCompanyApi, asyncRoute(async (req, res) => {
  const scope = ['open', 'resolved', 'all'].includes(req.query.scope) ? req.query.scope : 'open';
  const result = await pool.query(
    `SELECT i.id, i.order_id, i.category, i.severity, i.description, i.status,
            i.created_at, i.resolved_at, o.customer_name, o.customer_phone,
            o.neighborhood, o.status AS order_status, o.reference AS order_reference,
            d.id AS driver_id, d.name AS driver_name, d.traccar_unique_id AS driver_unique_id,
            (d.photo_updated_at IS NOT NULL) AS driver_has_photo, d.photo_updated_at AS driver_photo_at,
            opener.display_name AS opened_by, assignee.display_name AS assigned_to,
            h.id AS retention_hold_id, h.review_due_at AS retention_review_due_at
     FROM delivery_incidents i
     JOIN orders o ON o.id = i.order_id
     JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN users opener ON opener.id = i.opened_by_user_id
     LEFT JOIN users assignee ON assignee.id = i.assigned_to_user_id
     LEFT JOIN order_retention_holds h ON h.order_id = o.id AND h.status = 'active'
     WHERE i.company_id = $1 AND ($2 = 'all' OR i.status = $2)
     ORDER BY CASE i.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              i.created_at DESC, i.id DESC
     LIMIT 300`,
    [req.auth.company_id, scope]
  );
  const online = await driverOnlineByUnique();
  return res.json(result.rows.map((row) => ({ ...row, ...decorateRowDriver(row, online) })));
}));

async function loadIncidentDossier(companyId, incidentId) {
  const incidentResult = await pool.query(
    `SELECT i.id, i.company_id, i.order_id, i.category, i.severity, i.description,
            i.status, i.opened_by_user_id, i.resolved_by_user_id, i.assigned_to_user_id,
            i.resolution, i.resolved_at, i.created_at, i.updated_at,
            o.customer_name, o.customer_phone, o.delivery_address, o.requested_time,
            o.destination_lat, o.destination_lng, o.destination_accuracy, o.neighborhood,
            o.landmark, o.notes AS order_notes, o.status AS order_status, o.created_at AS order_created_at,
            o.reference AS order_reference, o.completed_at, o.cancelled_at, o.failure_reason,
            d.id AS driver_id, d.name AS driver_name, d.phone AS driver_phone,
            d.vehicle_type AS driver_vehicle_type,
            opener.display_name AS opened_by, resolver.display_name AS resolved_by,
            assignee.display_name AS assigned_to
     FROM delivery_incidents i
     JOIN orders o ON o.id = i.order_id
     JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN users opener ON opener.id = i.opened_by_user_id
     LEFT JOIN users resolver ON resolver.id = i.resolved_by_user_id
     LEFT JOIN users assignee ON assignee.id = i.assigned_to_user_id
     WHERE i.id = $1 AND i.company_id = $2`,
    [incidentId, companyId]
  );
  const incident = incidentResult.rows[0];
  if (!incident) return null;
  const [events, holds, evidence, orderEvents, paymentEvents, paymentAdjustments, proofs, relatedIncidents, members] = await Promise.all([
    pool.query(
      `SELECT e.id, e.incident_id, e.event_type, e.body, e.details, e.actor_user_id,
              e.previous_hash, e.event_hash, e.created_at,
              COALESCE(u.display_name, 'Compte supprimé') AS actor_name
       FROM incident_events e LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.incident_id = $1 AND e.company_id = $2 ORDER BY e.created_at ASC, e.id ASC`,
      [incident.id, companyId]
    ),
    pool.query(
      `SELECT h.id, h.order_id, h.status, h.reason, h.review_due_at, h.placed_at,
              h.released_at, h.release_reason,
              placer.display_name AS placed_by, releaser.display_name AS released_by
       FROM order_retention_holds h
       LEFT JOIN users placer ON placer.id = h.placed_by_user_id
       LEFT JOIN users releaser ON releaser.id = h.released_by_user_id
       WHERE h.order_id = $1 AND h.company_id = $2 ORDER BY h.placed_at DESC, h.id DESC`,
      [incident.order_id, companyId]
    ),
    pool.query(
      `SELECT id, evidence_type, mime_type, byte_size, content_sha256, uploaded_by_user_id,
              superseded_at, deleted_at, created_at
       FROM delivery_evidence_files WHERE order_id = $1 AND company_id = $2 ORDER BY created_at ASC, id ASC`,
      [incident.order_id, companyId]
    ),
    pool.query(
      `SELECT e.id, e.from_status, e.to_status, e.reason, e.metadata, e.actor_user_id,
              e.created_at, COALESCE(u.display_name, 'Système') AS actor_name
       FROM order_status_events e LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.order_id = $1 AND e.company_id = $2 ORDER BY e.created_at ASC, e.id ASC`,
      [incident.order_id, companyId]
    ),
    pool.query(
      `SELECT p.id, p.event_type, p.amount_minor, p.currency, p.method, p.reference,
               p.reason, p.actor_user_id, p.created_at, COALESCE(u.display_name, 'Système') AS actor_name
       FROM payment_events p LEFT JOIN users u ON u.id = p.actor_user_id
       WHERE p.order_id = $1 AND p.company_id = $2 ORDER BY p.created_at ASC, p.id ASC`,
      [incident.order_id, companyId]
    ),
    pool.query(
      `SELECT a.id, a.adjustment_type, a.direction, a.amount_minor, a.currency, a.method,
              a.reference, a.reason, TO_CHAR(a.effective_date, 'YYYY-MM-DD') AS effective_date,
              a.resulting_total_minor, a.reverses_adjustment_id, a.actor_user_id, a.created_at,
              COALESCE(u.display_name, 'Système') AS actor_name
       FROM payment_adjustments a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.order_id = $1 AND a.company_id = $2 ORDER BY a.created_at ASC, a.id ASC`,
      [incident.order_id, companyId]
    ),
    pool.query(
      `SELECT id, proof_type, verified_by_user_id, details, verified_at, created_at
       FROM delivery_proofs WHERE order_id = $1 AND company_id = $2 ORDER BY created_at ASC, id ASC`,
      [incident.order_id, companyId]
    ),
    pool.query(
      `SELECT id, category, severity, description, status, resolution, created_at, resolved_at
       FROM delivery_incidents WHERE order_id = $1 AND company_id = $2 ORDER BY created_at ASC, id ASC`,
      [incident.order_id, companyId]
    ),
    pool.query(
      `SELECT u.id, u.display_name, m.role
       FROM company_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = $1 AND m.role IN ('owner', 'manager', 'operator') AND u.disabled = FALSE
       ORDER BY u.display_name ASC`,
      [companyId]
    ),
  ]);
  return {
    incident,
    events: events.rows,
    eventChainValid: events.rows.length ? verifyIncidentEventChain(events.rows) : null,
    holds: holds.rows,
    evidence: evidence.rows,
    orderEvents: orderEvents.rows,
    paymentEvents: paymentEvents.rows,
    paymentAdjustments: paymentAdjustments.rows,
    proofs: proofs.rows,
    relatedIncidents: relatedIncidents.rows,
    members: members.rows,
  };
}

app.get('/api/app/incidents/:id', requireCompanyApi, asyncRoute(async (req, res) => {
  const dossier = await loadIncidentDossier(req.auth.company_id, req.params.id);
  if (!dossier) return res.status(404).json({ error: 'Incident introuvable.' });
  if (!['owner', 'manager'].includes(req.auth.role)) dossier.members = [];
  return res.json(dossier);
}));

app.post('/api/app/incidents/:id/notes', requireCompanyApi, asyncRoute(async (req, res) => {
  const note = String(req.body.note || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (note.length < 3 || note.length > 2000) return res.status(400).json({ error: 'La note doit contenir entre 3 et 2 000 caractères.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const incident = await client.query(
      `SELECT id, order_id FROM delivery_incidents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    if (!incident.rows[0]) throw Object.assign(new Error('Incident introuvable.'), { statusCode: 404 });
    const event = await appendIncidentEvent(client, req.auth, incident.rows[0].id, 'note_added', note, {}, idempotencyKey);
    if (!event.alreadyCreated) {
      await client.query(
        `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
         VALUES ($1, $2, 'order', $3, 'incident_note_added', jsonb_build_object('incidentId', $4::bigint, 'eventId', $5::bigint))`,
        [req.auth.company_id, req.auth.user_id, incident.rows[0].order_id, incident.rows[0].id, event.id]
      );
    }
    await client.query('COMMIT');
    return res.status(event.alreadyCreated ? 200 : 201).json({ id: event.id, alreadyCreated: Boolean(event.alreadyCreated) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Incident note error:', error.message);
    return res.status(500).json({ error: 'Impossible d’ajouter cette note.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/incidents/:id/assign', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const assignedToUserId = String(req.body.userId || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!/^\d+$/.test(assignedToUserId) || !idempotencyKey) return res.status(400).json({ error: 'Responsable ou clé d’action invalide.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const incident = await client.query(
      `SELECT id, order_id FROM delivery_incidents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    if (!incident.rows[0]) throw Object.assign(new Error('Incident introuvable.'), { statusCode: 404 });
    const member = await client.query(
      `SELECT u.id, u.display_name FROM company_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = $1 AND u.id = $2 AND m.role IN ('owner', 'manager', 'operator') AND u.disabled = FALSE`,
      [req.auth.company_id, assignedToUserId]
    );
    if (!member.rows[0]) throw Object.assign(new Error('Ce responsable ne fait pas partie de l’équipe autorisée.'), { statusCode: 400 });
    const details = { assignedToUserId: String(member.rows[0].id), assignedToName: member.rows[0].display_name };
    const event = await appendIncidentEvent(client, req.auth, incident.rows[0].id, 'assigned', null, details, idempotencyKey);
    if (!event.alreadyCreated) {
      await client.query('UPDATE delivery_incidents SET assigned_to_user_id = $1, updated_at = NOW() WHERE id = $2', [member.rows[0].id, incident.rows[0].id]);
      await client.query(
        `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
         VALUES ($1, $2, 'order', $3, 'incident_assigned', jsonb_build_object('incidentId', $4::bigint, 'assignedToUserId', $5::bigint))`,
        [req.auth.company_id, req.auth.user_id, incident.rows[0].order_id, incident.rows[0].id, member.rows[0].id]
      );
    }
    await client.query('COMMIT');
    return res.json({ assignedTo: member.rows[0].display_name, alreadyAssigned: Boolean(event.alreadyCreated) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Incident assignment error:', error.message);
    return res.status(500).json({ error: 'Impossible d’attribuer ce dossier.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/incidents/:id/retention-hold', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const reviewDueAt = new Date(req.body.reviewDueAt);
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  const maximumReview = Date.now() + 366 * 24 * 60 * 60 * 1000;
  if (reason.length < 10 || reason.length > 2000) return res.status(400).json({ error: 'Précisez le motif du gel entre 10 et 2 000 caractères.' });
  if (!Number.isFinite(reviewDueAt.getTime()) || reviewDueAt.getTime() <= Date.now() || reviewDueAt.getTime() > maximumReview) {
    return res.status(400).json({ error: 'Choisissez une date de révision future, dans les 12 prochains mois.' });
  }
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(canonicalJson({ incidentId: String(req.params.id), reason, reviewDueAt: reviewDueAt.toISOString() }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const incident = await client.query(
      `SELECT id, order_id FROM delivery_incidents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    if (!incident.rows[0]) throw Object.assign(new Error('Incident introuvable.'), { statusCode: 404 });
    const repeated = await client.query(
      `SELECT id, order_id, placed_fingerprint, review_due_at FROM order_retention_holds
       WHERE company_id = $1 AND placed_idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (String(repeated.rows[0].order_id) !== String(incident.rows[0].order_id) || repeated.rows[0].placed_fingerprint !== fingerprint) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ id: repeated.rows[0].id, reviewDueAt: repeated.rows[0].review_due_at, alreadyPlaced: true });
    }
    const active = await client.query(
      `SELECT id FROM order_retention_holds WHERE order_id = $1 AND company_id = $2 AND status = 'active'`,
      [incident.rows[0].order_id, req.auth.company_id]
    );
    if (active.rows[0]) throw Object.assign(new Error('Cette commande est déjà placée sous gel de conservation.'), { statusCode: 409 });
    const hold = await client.query(
      `INSERT INTO order_retention_holds (
         company_id, order_id, reason, review_due_at, placed_by_user_id,
         placed_idempotency_key, placed_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, review_due_at, placed_at`,
      [req.auth.company_id, incident.rows[0].order_id, reason, reviewDueAt.toISOString(), req.auth.user_id, idempotencyKey, fingerprint]
    );
    await appendIncidentEvent(client, req.auth, incident.rows[0].id, 'retention_hold_placed', reason,
      { holdId: String(hold.rows[0].id), reviewDueAt: reviewDueAt.toISOString() }, idempotencyKey);
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'retention_hold_placed',
         jsonb_build_object('incidentId', $4::bigint, 'holdId', $5::bigint, 'reviewDueAt', $6::text))`,
      [req.auth.company_id, req.auth.user_id, incident.rows[0].order_id, incident.rows[0].id, hold.rows[0].id, reviewDueAt.toISOString()]
    );
    await client.query('COMMIT');
    return res.status(201).json({ id: hold.rows[0].id, reviewDueAt: hold.rows[0].review_due_at, placedAt: hold.rows[0].placed_at });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Cette commande est déjà placée sous gel de conservation.' });
    console.error('Retention hold error:', error.message);
    return res.status(500).json({ error: 'Impossible de placer ce gel de conservation.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/incidents/:id/retention-hold/release', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (reason.length < 10 || reason.length > 2000) return res.status(400).json({ error: 'Précisez le motif de levée entre 10 et 2 000 caractères.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(canonicalJson({ incidentId: String(req.params.id), reason }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const incident = await client.query(
      `SELECT id, order_id FROM delivery_incidents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    if (!incident.rows[0]) throw Object.assign(new Error('Incident introuvable.'), { statusCode: 404 });
    const repeated = await client.query(
      `SELECT id, order_id, release_fingerprint, released_at FROM order_retention_holds
       WHERE company_id = $1 AND release_idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (String(repeated.rows[0].order_id) !== String(incident.rows[0].order_id) || repeated.rows[0].release_fingerprint !== fingerprint) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ id: repeated.rows[0].id, releasedAt: repeated.rows[0].released_at, alreadyReleased: true });
    }
    const hold = await client.query(
      `SELECT id FROM order_retention_holds
       WHERE order_id = $1 AND company_id = $2 AND status = 'active' FOR UPDATE`,
      [incident.rows[0].order_id, req.auth.company_id]
    );
    if (!hold.rows[0]) throw Object.assign(new Error('Aucun gel de conservation actif sur cette commande.'), { statusCode: 409 });
    const released = await client.query(
      `UPDATE order_retention_holds SET status = 'released', released_by_user_id = $1,
         release_reason = $2, release_idempotency_key = $3, release_fingerprint = $4, released_at = NOW()
       WHERE id = $5 RETURNING id, released_at`,
      [req.auth.user_id, reason, idempotencyKey, fingerprint, hold.rows[0].id]
    );
    await appendIncidentEvent(client, req.auth, incident.rows[0].id, 'retention_hold_released', reason,
      { holdId: String(hold.rows[0].id) }, idempotencyKey);
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'retention_hold_released', jsonb_build_object('incidentId', $4::bigint, 'holdId', $5::bigint))`,
      [req.auth.company_id, req.auth.user_id, incident.rows[0].order_id, incident.rows[0].id, hold.rows[0].id]
    );
    await client.query('COMMIT');
    return res.json({ id: released.rows[0].id, releasedAt: released.rows[0].released_at });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Retention hold release error:', error.message);
    return res.status(500).json({ error: 'Impossible de lever ce gel de conservation.' });
  } finally {
    client.release();
  }
}));

app.get('/api/app/incidents/:id/export', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const dossier = await loadIncidentDossier(req.auth.company_id, req.params.id);
  if (!dossier) return res.status(404).json({ error: 'Incident introuvable.' });
  const company = await pool.query('SELECT id, name, slug FROM companies WHERE id = $1', [req.auth.company_id]);
  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    generatedBy: { userId: String(req.auth.user_id), name: req.auth.display_name, role: req.auth.role },
    company: company.rows[0],
    incident: dossier.incident,
    incidentEvents: dossier.events,
    retentionHolds: dossier.holds,
    orderStatusEvents: dossier.orderEvents,
    paymentEvents: dossier.paymentEvents,
    paymentAdjustments: dossier.paymentAdjustments,
    deliveryProofs: dossier.proofs,
    deliveryEvidenceMetadata: dossier.evidence,
    relatedIncidents: dossier.relatedIncidents,
  };
  const manifestSha256 = digest(canonicalJson(manifest));
  await writeAudit(req.auth, 'order', dossier.incident.order_id, 'incident_dossier_exported', {
    incidentId: dossier.incident.id, manifestSha256, eventChainValid: dossier.eventChainValid,
  });
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="incident-${dossier.incident.id}-dossier.json"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.send(JSON.stringify({ ...manifest, integrity: { manifestSha256, incidentEventChainValid: dossier.eventChainValid } }, null, 2));
}));

app.post('/api/app/orders/:id/payment/configure', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const expectedAmount = moneyInteger(req.body.expectedAmountMinor);
  const currency = String(req.body.currency || 'XOF').toUpperCase();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (expectedAmount === null || expectedAmount <= 0) return res.status(400).json({ error: 'Le montant attendu doit être un entier positif.' });
  if (currency !== 'XOF') return res.status(400).json({ error: 'Cette version accepte uniquement le franc CFA XOF.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), expectedAmount, currency, action: 'configure' }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    if (terminalOrderStatuses.includes(order.status)) throw Object.assign(new Error('L’encaissement ne peut plus être configuré sur une commande terminée.'), { statusCode: 409 });
    const repeated = await client.query(
      `SELECT pe.id, pe.order_id, pe.request_fingerprint, pa.status
       FROM payment_events pe JOIN order_payment_accounts pa ON pa.id = pe.payment_account_id
       WHERE pe.company_id = $1 AND pe.idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_fingerprint !== fingerprint || String(repeated.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ orderId: order.id, status: repeated.rows[0].status, alreadyApplied: true });
    }
    let accountResult = await client.query(`SELECT * FROM order_payment_accounts WHERE order_id = $1 FOR UPDATE`, [order.id]);
    if (accountResult.rows[0] && !['pending', 'not_required'].includes(accountResult.rows[0].status)) {
      throw Object.assign(new Error('Un encaissement a déjà été enregistré. Annulez-le avant de modifier le montant attendu.'), { statusCode: 409 });
    }
    if (accountResult.rows[0]) {
      accountResult = await client.query(
        `UPDATE order_payment_accounts SET expected_amount_minor = $1, currency = $2, status = 'pending',
           version = version + 1, updated_at = NOW() WHERE id = $3 RETURNING *`,
        [expectedAmount, currency, accountResult.rows[0].id]
      );
    } else {
      accountResult = await client.query(
        `INSERT INTO order_payment_accounts (company_id, order_id, expected_amount_minor, currency)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.auth.company_id, order.id, expectedAmount, currency]
      );
    }
    const account = accountResult.rows[0];
    const event = await client.query(
      `INSERT INTO payment_events (
         company_id, order_id, payment_account_id, event_type, amount_minor, currency,
         actor_user_id, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'configured', $4, $5, $6, $7, $8) RETURNING id`,
      [req.auth.company_id, order.id, account.id, expectedAmount, currency, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'payment_configured', jsonb_build_object('paymentEventId', $4::bigint, 'amountMinor', $5::bigint, 'currency', $6::text))`,
      [req.auth.company_id, req.auth.user_id, order.id, event.rows[0].id, expectedAmount, currency]
    );
    await client.query('COMMIT');
    return res.status(201).json({ orderId: order.id, paymentAccountId: account.id, status: account.status, expectedAmountMinor: account.expected_amount_minor, currency });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Payment configuration error:', error.message);
    return res.status(500).json({ error: 'Impossible de configurer cet encaissement.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/payment/remove', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (reason.length < 5) return res.status(400).json({ error: 'Expliquez pourquoi l’encaissement n’est plus requis.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), reason, action: 'remove_requirement' }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(`SELECT id, status FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, req.auth.company_id]);
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    if (terminalOrderStatuses.includes(order.status)) throw Object.assign(new Error('La commande est déjà terminée.'), { statusCode: 409 });
    const accountResult = await client.query(`SELECT * FROM order_payment_accounts WHERE order_id = $1 FOR UPDATE`, [order.id]);
    const account = accountResult.rows[0];
    if (!account) throw Object.assign(new Error('Aucun encaissement configuré.'), { statusCode: 409 });
    const repeated = await client.query(`SELECT order_id, request_fingerprint FROM payment_events WHERE company_id = $1 AND idempotency_key = $2`, [req.auth.company_id, idempotencyKey]);
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_fingerprint !== fingerprint || String(repeated.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ orderId: order.id, status: 'not_required', alreadyApplied: true });
    }
    if (account.status !== 'pending') throw Object.assign(new Error('Cet encaissement ne peut plus être retiré directement.'), { statusCode: 409 });
    await client.query(`UPDATE order_payment_accounts SET status = 'not_required', version = version + 1, updated_at = NOW() WHERE id = $1`, [account.id]);
    const event = await client.query(
      `INSERT INTO payment_events (
         company_id, order_id, payment_account_id, event_type, amount_minor, currency,
         reason, actor_user_id, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'requirement_removed', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [req.auth.company_id, order.id, account.id, account.expected_amount_minor, account.currency,
        reason, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'payment_requirement_removed', jsonb_build_object('paymentEventId', $4::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, event.rows[0].id]
    );
    await client.query('COMMIT');
    return res.json({ orderId: order.id, status: 'not_required' });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Payment requirement removal error:', error.message);
    return res.status(500).json({ error: 'Impossible de retirer cet encaissement.' });
  } finally {
    client.release();
  }
}));

async function collectOrderPayment(req, res, driverScoped = false) {
  const amount = moneyInteger(req.body.amountMinor);
  const method = String(req.body.method || '').trim();
  const reference = String(req.body.reference || '').trim().slice(0, 120);
  const discrepancyReason = String(req.body.discrepancyReason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (amount === null || !paymentMethods.includes(method)) return res.status(400).json({ error: 'Montant ou mode d’encaissement invalide.' });
  if (discrepancyReason.length > 1000) return res.status(400).json({ error: 'Le motif de l’écart est trop long.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), amount, method, reference, discrepancyReason, action: 'collect' }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status FROM orders
       WHERE id = $1 AND company_id = $2${driverScoped ? ' AND driver_id = $3' : ''} FOR UPDATE`,
      driverScoped ? [req.params.id, req.auth.company_id, req.auth.driver_id] : [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    if (!['En livraison', 'Arrivée'].includes(order.status)) {
      throw Object.assign(new Error('L’encaissement peut être déclaré uniquement pendant la remise au client.'), { statusCode: 409 });
    }
    const accountResult = await client.query(`SELECT * FROM order_payment_accounts WHERE order_id = $1 FOR UPDATE`, [order.id]);
    const account = accountResult.rows[0];
    if (!account) throw Object.assign(new Error('Aucun encaissement n’est configuré pour cette commande.'), { statusCode: 409 });
    const repeated = await client.query(
      `SELECT id, order_id, request_fingerprint FROM payment_events
       WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_fingerprint !== fingerprint || String(repeated.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ orderId: order.id, status: account.status, alreadyApplied: true });
    }
    if (account.status !== 'pending') throw Object.assign(new Error('Un encaissement est déjà enregistré pour cette commande.'), { statusCode: 409 });
    const hasDiscrepancy = amount !== Number(account.expected_amount_minor);
    if (hasDiscrepancy && discrepancyReason.length < 5) {
      throw Object.assign(new Error('Expliquez l’écart entre le montant attendu et le montant reçu.'), { statusCode: 400 });
    }
    const paymentStatus = hasDiscrepancy ? 'discrepancy' : 'collected';
    const updated = await client.query(
      `UPDATE order_payment_accounts SET status = $1, collected_amount_minor = $2,
         collection_method = $3, collection_reference = $4, discrepancy_reason = $5,
         collected_by_user_id = $6, collected_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $7 RETURNING collected_at`,
      [paymentStatus, amount, method, reference || null, discrepancyReason || null, req.auth.user_id, account.id]
    );
    const event = await client.query(
      `INSERT INTO payment_events (
         company_id, order_id, payment_account_id, event_type, amount_minor, currency,
         method, reference, reason, actor_user_id, idempotency_key, request_fingerprint,
         metadata
       ) VALUES ($1, $2, $3, 'collected', $4, $5, $6, $7, $8, $9, $10, $11,
         jsonb_build_object('expectedAmountMinor', $12::bigint, 'hasDiscrepancy', $13::boolean)) RETURNING id`,
      [req.auth.company_id, order.id, account.id, amount, account.currency, method, reference || null,
        discrepancyReason || null, req.auth.user_id, idempotencyKey, fingerprint, account.expected_amount_minor, hasDiscrepancy]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'payment_collected', jsonb_build_object('paymentEventId', $4::bigint, 'status', $5::text))`,
      [req.auth.company_id, req.auth.user_id, order.id, event.rows[0].id, paymentStatus]
    );
    await client.query('COMMIT');
    return res.status(201).json({ orderId: order.id, status: paymentStatus, amountMinor: amount, currency: account.currency, collectedAt: updated.rows[0].collected_at });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Payment collection error:', error.message);
    return res.status(500).json({ error: 'Impossible d’enregistrer cet encaissement.' });
  } finally {
    client.release();
  }
}

app.post('/api/app/orders/:id/payment/collect', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  return collectOrderPayment(req, res);
}));

app.post('/api/app/orders/:id/payment/reconcile', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const note = String(req.body.note || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), note, action: 'reconcile' }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(`SELECT id FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, req.auth.company_id]);
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    const accountResult = await client.query(`SELECT * FROM order_payment_accounts WHERE order_id = $1 FOR UPDATE`, [order.id]);
    const account = accountResult.rows[0];
    if (!account) throw Object.assign(new Error('Aucun encaissement à rapprocher.'), { statusCode: 409 });
    const repeated = await client.query(`SELECT order_id, request_fingerprint FROM payment_events WHERE company_id = $1 AND idempotency_key = $2`, [req.auth.company_id, idempotencyKey]);
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_fingerprint !== fingerprint || String(repeated.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ orderId: order.id, status: 'reconciled', alreadyApplied: true });
    }
    if (!['collected', 'discrepancy'].includes(account.status)) throw Object.assign(new Error('Cet encaissement n’est pas prêt à être rapproché.'), { statusCode: 409 });
    if (account.status === 'discrepancy' && note.length < 5) throw Object.assign(new Error('Expliquez la décision prise pour cet écart.'), { statusCode: 400 });
    await client.query(
      `UPDATE order_payment_accounts SET status = 'reconciled', reconciled_by_user_id = $1,
         reconciled_at = NOW(), reconciliation_note = $2, version = version + 1, updated_at = NOW()
       WHERE id = $3`,
      [req.auth.user_id, note || null, account.id]
    );
    const event = await client.query(
      `INSERT INTO payment_events (
         company_id, order_id, payment_account_id, event_type, amount_minor, currency,
         method, reference, reason, actor_user_id, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'reconciled', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [req.auth.company_id, order.id, account.id, account.collected_amount_minor, account.currency,
        account.collection_method, account.collection_reference, note || null, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'payment_reconciled', jsonb_build_object('paymentEventId', $4::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, event.rows[0].id]
    );
    await client.query('COMMIT');
    return res.json({ orderId: order.id, status: 'reconciled' });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Payment reconciliation error:', error.message);
    return res.status(500).json({ error: 'Impossible de rapprocher cet encaissement.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/payment/reverse', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (reason.length < 5) return res.status(400).json({ error: 'Expliquez pourquoi l’encaissement doit être annulé.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), reason, action: 'reverse' }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(`SELECT id, status FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, req.auth.company_id]);
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    if (terminalOrderStatuses.includes(order.status)) throw Object.assign(new Error('Une commande terminée nécessite un ajustement comptable, pas une annulation simple.'), { statusCode: 409 });
    const accountResult = await client.query(`SELECT * FROM order_payment_accounts WHERE order_id = $1 FOR UPDATE`, [order.id]);
    const account = accountResult.rows[0];
    if (!account) throw Object.assign(new Error('Aucun encaissement à annuler.'), { statusCode: 409 });
    const repeated = await client.query(`SELECT order_id, request_fingerprint FROM payment_events WHERE company_id = $1 AND idempotency_key = $2`, [req.auth.company_id, idempotencyKey]);
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_fingerprint !== fingerprint || String(repeated.rows[0].order_id) !== String(order.id)) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ orderId: order.id, status: 'pending', alreadyApplied: true });
    }
    if (!['collected', 'discrepancy'].includes(account.status)) throw Object.assign(new Error('Cet encaissement ne peut pas être annulé.'), { statusCode: 409 });
    const event = await client.query(
      `INSERT INTO payment_events (
         company_id, order_id, payment_account_id, event_type, amount_minor, currency,
         method, reference, reason, actor_user_id, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'reversed', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [req.auth.company_id, order.id, account.id, account.collected_amount_minor, account.currency,
        account.collection_method, account.collection_reference, reason, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `UPDATE order_payment_accounts SET status = 'pending', collected_amount_minor = NULL,
         collection_method = NULL, collection_reference = NULL, discrepancy_reason = NULL,
         collected_by_user_id = NULL, collected_at = NULL, reconciled_by_user_id = NULL,
         reconciled_at = NULL, reconciliation_note = NULL, version = version + 1, updated_at = NOW()
       WHERE id = $1`,
      [account.id]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'payment_reversed', jsonb_build_object('paymentEventId', $4::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, event.rows[0].id]
    );
    await client.query('COMMIT');
    return res.json({ orderId: order.id, status: 'pending' });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Payment reversal error:', error.message);
    return res.status(500).json({ error: 'Impossible d’annuler cet encaissement.' });
  } finally {
    client.release();
  }
}));

async function paymentAdjustedTotal(client, paymentAccountId) {
  const result = await client.query(
    `SELECT COALESCE(pa.collected_amount_minor, 0)
       + COALESCE(SUM(CASE WHEN a.direction = 'inflow' THEN a.amount_minor ELSE -a.amount_minor END), 0) AS total
     FROM order_payment_accounts pa
     LEFT JOIN payment_adjustments a ON a.payment_account_id = pa.id
     WHERE pa.id = $1 GROUP BY pa.id`,
    [paymentAccountId]
  );
  const total = Number(result.rows[0]?.total || 0);
  if (!Number.isSafeInteger(total)) throw Object.assign(new Error('Le total financier dépasse la limite prise en charge.'), { statusCode: 409 });
  return total;
}

function pilotLocalDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

app.post('/api/app/orders/:id/payment/adjustments', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const adjustmentType = String(req.body.adjustmentType || '').trim();
  const amount = moneyInteger(req.body.amountMinor);
  const method = String(req.body.method || '').trim();
  const reference = String(req.body.reference || '').trim().slice(0, 120);
  const reason = String(req.body.reason || '').trim();
  const effectiveDate = validDateOnly(req.body.effectiveDate);
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!paymentAdjustmentTypes.includes(adjustmentType) || amount === null || amount <= 0 || !paymentMethods.includes(method)) {
    return res.status(400).json({ error: 'Type, montant ou mode de l’ajustement invalide.' });
  }
  if (reason.length < 10 || reason.length > 1000) return res.status(400).json({ error: 'Expliquez l’ajustement en 10 à 1 000 caractères.' });
  if (!effectiveDate || effectiveDate > pilotLocalDate()) return res.status(400).json({ error: 'La date effective est invalide ou future.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(canonicalJson({ orderId: String(req.params.id), adjustmentType, amount, method, reference, reason, effectiveDate }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status,
              TO_CHAR((COALESCE(completed_at, cancelled_at, status_changed_at) AT TIME ZONE 'Africa/Porto-Novo')::date, 'YYYY-MM-DD') AS terminal_date
       FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    const repeated = await client.query(
      `SELECT id, order_id, request_fingerprint, resulting_total_minor
       FROM payment_adjustments WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (String(repeated.rows[0].order_id) !== String(order.id) || repeated.rows[0].request_fingerprint !== fingerprint) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ id: repeated.rows[0].id, orderId: order.id, resultingTotalMinor: Number(repeated.rows[0].resulting_total_minor), alreadyApplied: true });
    }
    if (!terminalOrderStatuses.includes(order.status)) throw Object.assign(new Error('Un ajustement est réservé à une commande terminée.'), { statusCode: 409 });
    if (effectiveDate < order.terminal_date) throw Object.assign(new Error('La date effective ne peut pas précéder la clôture de la commande.'), { statusCode: 400 });
    const accountResult = await client.query('SELECT * FROM order_payment_accounts WHERE order_id = $1 FOR UPDATE', [order.id]);
    const account = accountResult.rows[0];
    if (!account || !['collected', 'reconciled'].includes(account.status) || account.collected_amount_minor === null) {
      throw Object.assign(new Error('Aucun encaissement finalisé ne peut être ajusté.'), { statusCode: 409 });
    }
    const currentTotal = await paymentAdjustedTotal(client, account.id);
    const direction = adjustmentType === 'refund' ? 'outflow' : 'inflow';
    const resultingTotal = currentTotal + (direction === 'inflow' ? amount : -amount);
    if (resultingTotal < 0) throw Object.assign(new Error('Le remboursement dépasse le total net encaissé.'), { statusCode: 409 });
    if (!Number.isSafeInteger(resultingTotal) || resultingTotal > 1000000000000) {
      throw Object.assign(new Error('Le total ajusté dépasse la limite prise en charge.'), { statusCode: 409 });
    }
    const inserted = await client.query(
      `INSERT INTO payment_adjustments (
         company_id, order_id, payment_account_id, adjustment_type, direction, amount_minor,
         currency, method, reference, reason, effective_date, resulting_total_minor,
         actor_user_id, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, created_at`,
      [req.auth.company_id, order.id, account.id, adjustmentType, direction, amount, account.currency,
        method, reference || null, reason, effectiveDate, resultingTotal, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'payment_adjustment_posted',
         jsonb_build_object('adjustmentId', $4::bigint, 'type', $5::text, 'amountMinor', $6::bigint, 'resultingTotalMinor', $7::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, inserted.rows[0].id, adjustmentType, amount, resultingTotal]
    );
    await client.query('COMMIT');
    return res.status(201).json({ id: inserted.rows[0].id, orderId: order.id, resultingTotalMinor: resultingTotal, createdAt: inserted.rows[0].created_at });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Payment adjustment error:', error.message);
    return res.status(500).json({ error: 'Impossible d’enregistrer cet ajustement.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/payment/adjustments/:adjustmentId/reverse', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const effectiveDate = validDateOnly(req.body.effectiveDate);
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (reason.length < 10 || reason.length > 1000) return res.status(400).json({ error: 'Expliquez la correction en 10 à 1 000 caractères.' });
  if (!effectiveDate || effectiveDate > pilotLocalDate()) return res.status(400).json({ error: 'La date effective est invalide ou future.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(canonicalJson({ orderId: String(req.params.id), adjustmentId: String(req.params.adjustmentId), reason, effectiveDate }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query('SELECT id FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, req.auth.company_id]);
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('Commande introuvable.'), { statusCode: 404 });
    const repeated = await client.query(
      `SELECT id, order_id, request_fingerprint, resulting_total_minor
       FROM payment_adjustments WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (repeated.rows[0]) {
      if (String(repeated.rows[0].order_id) !== String(order.id) || repeated.rows[0].request_fingerprint !== fingerprint) {
        throw Object.assign(new Error('Cette clé d’action a déjà été utilisée ailleurs.'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return res.json({ id: repeated.rows[0].id, orderId: order.id, resultingTotalMinor: Number(repeated.rows[0].resulting_total_minor), alreadyApplied: true });
    }
    const accountResult = await client.query('SELECT * FROM order_payment_accounts WHERE order_id = $1 FOR UPDATE', [order.id]);
    const account = accountResult.rows[0];
    if (!account) throw Object.assign(new Error('Aucun encaissement associé.'), { statusCode: 409 });
    const targetResult = await client.query(
      `SELECT a.*, TO_CHAR(a.effective_date, 'YYYY-MM-DD') AS effective_date_text FROM payment_adjustments a
       WHERE id = $1 AND order_id = $2 AND company_id = $3 FOR UPDATE`,
      [req.params.adjustmentId, order.id, req.auth.company_id]
    );
    const target = targetResult.rows[0];
    if (!target) throw Object.assign(new Error('Ajustement introuvable.'), { statusCode: 404 });
    if (target.adjustment_type === 'reversal') throw Object.assign(new Error('Une écriture inverse ne peut pas être inversée à nouveau.'), { statusCode: 409 });
    if (effectiveDate < target.effective_date_text) throw Object.assign(new Error('La correction ne peut pas précéder l’ajustement original.'), { statusCode: 400 });
    const alreadyReversed = await client.query('SELECT id FROM payment_adjustments WHERE reverses_adjustment_id = $1', [target.id]);
    if (alreadyReversed.rows[0]) throw Object.assign(new Error('Cet ajustement possède déjà une écriture inverse.'), { statusCode: 409 });
    const currentTotal = await paymentAdjustedTotal(client, account.id);
    const direction = target.direction === 'inflow' ? 'outflow' : 'inflow';
    const amount = Number(target.amount_minor);
    const resultingTotal = currentTotal + (direction === 'inflow' ? amount : -amount);
    if (resultingTotal < 0) throw Object.assign(new Error('Cette correction rendrait le total net négatif.'), { statusCode: 409 });
    const inserted = await client.query(
      `INSERT INTO payment_adjustments (
         company_id, order_id, payment_account_id, adjustment_type, direction, amount_minor,
         currency, method, reference, reason, effective_date, resulting_total_minor,
         reverses_adjustment_id, actor_user_id, idempotency_key, request_fingerprint
       ) VALUES ($1, $2, $3, 'reversal', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id, created_at`,
      [req.auth.company_id, order.id, account.id, direction, amount, target.currency, target.method,
        target.reference, reason, effectiveDate, resultingTotal, target.id, req.auth.user_id, idempotencyKey, fingerprint]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'order', $3, 'payment_adjustment_reversed',
         jsonb_build_object('adjustmentId', $4::bigint, 'reversesAdjustmentId', $5::bigint, 'resultingTotalMinor', $6::bigint))`,
      [req.auth.company_id, req.auth.user_id, order.id, inserted.rows[0].id, target.id, resultingTotal]
    );
    await client.query('COMMIT');
    return res.status(201).json({ id: inserted.rows[0].id, orderId: order.id, resultingTotalMinor: resultingTotal, reversesAdjustmentId: target.id });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'Cet ajustement a déjà été corrigé.' });
    console.error('Payment adjustment reversal error:', error.message);
    return res.status(500).json({ error: 'Impossible de corriger cet ajustement.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders', requireCompanyApi, asyncRoute(async (req, res) => {
  const { customerName, customerPhone, deliveryAddress, driverId } = req.body;
  if (!customerName || !deliveryAddress || !driverId) {
    return res.status(400).json({ error: 'Nom client, lieu de livraison et livreur sont obligatoires.' });
  }
  if (!(await companyDeliverySetting(req.auth.company_id, 'internalEntryEnabled'))) {
    return res.status(403).json({ error: 'La saisie interne est désactivée dans vos paramètres Livraisons.' });
  }
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const driver = await client.query(
      'SELECT id FROM drivers WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [driverId, req.auth.company_id]
    );
    if (!driver.rows[0]) throw Object.assign(new Error('Livreur non autorisé.'), { statusCode: 400 });
    const order = await client.query(
      `INSERT INTO orders (company_id, driver_id, customer_name, customer_phone, delivery_address, status)
       VALUES ($1, $2, $3, $4, $5, 'Confirmée') RETURNING id`,
      [req.auth.company_id, driver.rows[0].id, customerName, customerPhone || null, deliveryAddress]
    );
    await assignOrderReference(client, req.auth.company_id, order.rows[0].id);
    const token = randomToken(24);
    const tokenStorage = trackingTokenStorage(token);
    const trackingExpiration = createTrackingLinkExpiration();
    const trackingLink = await client.query(
      `INSERT INTO tracking_links (company_id, order_id, token, token_hash, token_ciphertext, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, generation, version`,
      [req.auth.company_id, order.rows[0].id, encryptedOnlyTrackingTokenStorage() ? null : token,
        tokenStorage.tokenHash, tokenStorage.tokenCiphertext, trackingExpiration.expiresAt]
    );
    await client.query(
      `INSERT INTO tracking_link_events (
         company_id, tracking_link_id, order_id, generation, event_type,
         actor_user_id, reason, result_version
       ) VALUES ($1, $2, $3, $4, 'created', $5, 'direct_order', $6)`,
      [req.auth.company_id, trackingLink.rows[0].id, order.rows[0].id,
        trackingLink.rows[0].generation, req.auth.user_id, trackingLink.rows[0].version]
    );
    await client.query(
      `INSERT INTO order_status_events (
         company_id, order_id, from_status, to_status, actor_user_id,
         idempotency_key, request_fingerprint, metadata
       ) VALUES ($1, $2, NULL, 'Confirmée', $3, $4, $5, '{"source":"direct"}'::jsonb)`,
      [req.auth.company_id, order.rows[0].id, req.auth.user_id, `system:direct-order:${order.rows[0].id}`, digest(`direct-order:${order.rows[0].id}`)]
    );
    await ensureOrderCrmSnapshot(client, order.rows[0].id, req.auth.user_id);
    // Rattachement automatique à la tournée du jour du livreur. Best-effort via
    // SAVEPOINT : la commande doit se créer même si ce rattachement échoue.
    try {
      await client.query('SAVEPOINT sp_run_attach');
      await attachOrderToDayRun(client, req.auth, order.rows[0].id, driver.rows[0].id, todayServiceDate());
      await client.query('RELEASE SAVEPOINT sp_run_attach');
    } catch (attachError) {
      await client.query('ROLLBACK TO SAVEPOINT sp_run_attach');
      console.error('Auto-attach run failed:', attachError.message);
    }
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action)
       VALUES ($1, $2, 'order', $3, 'created')`,
      [req.auth.company_id, req.auth.user_id, order.rows[0].id]
    );
    await client.query('COMMIT');
    committed = true;
    return res.status(201).json({
      orderId: order.rows[0].id,
      path: `/suivi/${token}`,
      trackingLink: { state: 'active', path: `/suivi/${token}`, expiresAt: trackingExpiration.expiresAt, version: 1 },
    });
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    if (error.statusCode === 400) return res.status(400).json({ error: error.message });
    console.error('Order creation error:', error.message);
    return res.status(500).json({ error: 'Impossible de créer la commande.' });
  } finally {
    client.release();
  }
}));

app.post('/api/public/requests/:token', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const { customerName, customerPhone, requestedTime, locationLat, locationLng, locationAccuracy, neighborhood, landmark, notes } = req.body;
  if (!customerName || !customerPhone || !neighborhood) {
    return res.status(400).json({ error: 'Nom, téléphone et zone sont obligatoires.' });
  }
  const owning = await pool.query('SELECT company_id FROM customer_requests WHERE token = $1', [req.params.token]);
  if (owning.rows[0] && !(await companyDeliverySetting(owning.rows[0].company_id, 'customerFormEnabled'))) {
    return res.status(403).json({ error: 'Ce formulaire n’est plus actif.' });
  }
  const editToken = randomToken(24);
  const result = await pool.query(
    `UPDATE customer_requests
     SET status = 'À vérifier', customer_name = $1, customer_phone = $2,
         requested_time = $3, location_lat = $4, location_lng = $5, location_accuracy = $6,
         location_at = CASE WHEN $4::double precision IS NULL OR $5::double precision IS NULL THEN NULL ELSE NOW() END,
         neighborhood = $7, landmark = $8, notes = $9,
         edit_token_hash = $10, submitted_at = NOW(), updated_at = NOW(), version = version + 1
     WHERE token = $11 AND status = 'En attente d’informations'
       AND (expires_at IS NULL OR expires_at > NOW())
     RETURNING id, version`,
    [
      String(customerName).trim(), String(customerPhone).trim(), requestedTime || null,
      optionalNumber(locationLat), optionalNumber(locationLng), optionalNumber(locationAccuracy),
      String(neighborhood).trim(), landmark || null, notes || null, digest(editToken), req.params.token,
    ]
  );
  if (!result.rows[0]) return res.status(409).json({ error: 'Ce formulaire a déjà été envoyé ou a expiré.' });
  const requestCompany = await pool.query('SELECT company_id FROM customer_requests WHERE id = $1', [result.rows[0].id]);
  await writeAudit({ company_id: requestCompany.rows[0]?.company_id, user_id: null }, 'customer_request', result.rows[0].id, 'submitted');
  const redirect = `/demande/${encodeURIComponent(req.params.token)}/confirmation?edit=${encodeURIComponent(editToken)}`;
  return res.json({ status: 'received', message: 'Merci. L’entreprise va vérifier votre demande.', redirect });
}));

app.get('/api/public/requests/:token', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const result = await pool.query(
    `SELECT status, customer_name, customer_phone, requested_time, location_lat, location_lng,
            location_accuracy, neighborhood, landmark, notes, submitted_at, updated_at,
            edit_token_hash, version
     FROM customer_requests WHERE token = $1`,
    [req.params.token]
  );
  const request = result.rows[0];
  if (!request) return res.status(404).json({ error: 'Demande introuvable.' });
  const suppliedEditToken = String(req.query.edit || '');
  const canEdit = Boolean(
    suppliedEditToken && request.edit_token_hash && digest(suppliedEditToken) === request.edit_token_hash
    && editableRequestStatuses.includes(request.status)
  );
  delete request.edit_token_hash;
  return res.json({ ...request, canEdit });
}));

app.put('/api/public/requests/:token', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const editToken = String(req.body.editToken || '');
  const { customerName, customerPhone, requestedTime, locationLat, locationLng, locationAccuracy, neighborhood, landmark, notes, version } = req.body;
  if (!editToken || !customerName || !customerPhone || !neighborhood || !Number.isInteger(Number(version))) {
    return res.status(400).json({ error: 'Informations de modification incomplètes.' });
  }
  const result = await pool.query(
    `UPDATE customer_requests
     SET customer_name = $1, customer_phone = $2, requested_time = $3,
         location_lat = $4, location_lng = $5, location_accuracy = $6,
         location_at = CASE WHEN $4::double precision IS NULL OR $5::double precision IS NULL THEN location_at ELSE NOW() END,
         neighborhood = $7, landmark = $8, notes = $9, version = version + 1, updated_at = NOW()
     WHERE token = $10 AND edit_token_hash = $11 AND version = $12 AND status = ANY($13::text[])
     RETURNING id, company_id, version`,
    [
      String(customerName).trim(), String(customerPhone).trim(), requestedTime || null,
      optionalNumber(locationLat), optionalNumber(locationLng), optionalNumber(locationAccuracy),
      String(neighborhood).trim(), landmark || null, notes || null,
      req.params.token, digest(editToken), Number(version), editableRequestStatuses,
    ]
  );
  if (!result.rows[0]) return res.status(409).json({ error: 'La demande a été validée ou modifiée ailleurs. Rechargez la page.' });
  await writeAudit({ company_id: result.rows[0].company_id, user_id: null }, 'customer_request', result.rows[0].id, 'customer_updated');
  return res.json({ message: 'Vos informations ont été mises à jour.', version: result.rows[0].version });
}));

app.get('/api/tracking/:token', publicTrackingRateLimit, asyncRoute(async (req, res) => {
  let deviceId = process.env.TRACCAR_DEVICE_ID;
  let tracking = {
    orderStatus: null,
    statusChangedAt: null,
    requestedTime: null,
    neighborhood: null,
    landmark: null,
    destination: null,
    driverName: null,
    driverVehicleType: null,
  };
  const isDemo = Boolean(demoToken && req.params.token === demoToken);
  if (!isDemo && !/^[A-Za-z0-9_-]{32,128}$/.test(req.params.token)) {
    const unavailable = publicTrackingLinkMessage('unavailable');
    return res.status(unavailable.statusCode).json({ error: unavailable.message });
  }
  if (pool && !isDemo) {
    const link = await pool.query(
      `SELECT d.traccar_unique_id, d.name AS driver_name, d.vehicle_type AS driver_vehicle_type,
               o.status, o.status_changed_at, o.requested_time, o.neighborhood, o.landmark,
               o.destination_lat, o.destination_lng, o.destination_accuracy,
               t.expires_at, t.created_at, t.revoked_at
        FROM tracking_links t
        JOIN orders o ON o.id = t.order_id AND o.company_id = t.company_id
        JOIN drivers d ON d.id = o.driver_id AND d.company_id = o.company_id
        WHERE t.token_hash = $1 OR t.token = $2`,
      [digest(req.params.token), req.params.token]
    );
    const lifecycle = evaluateTrackingLink(link.rows[0] ? {
      expires_at: link.rows[0].expires_at,
      created_at: link.rows[0].created_at,
      revoked_at: link.rows[0].revoked_at,
      order_status: link.rows[0].status,
    } : null);
    if (!['active', 'terminal'].includes(lifecycle.state)) {
      const unavailable = publicTrackingLinkMessage(lifecycle.state);
      return res.status(unavailable.statusCode).json({ error: unavailable.message });
    }
    const row = link.rows[0];
    deviceId = row.traccar_unique_id;
    tracking = {
      orderStatus: row.status,
      statusChangedAt: row.status_changed_at,
      requestedTime: row.requested_time,
      neighborhood: row.neighborhood,
      landmark: row.landmark,
      destination: publicDestination(row),
      driverName: row.driver_name,
      driverVehicleType: row.driver_vehicle_type,
    };
  } else if (!isDemo && !pool) {
    const unavailable = publicTrackingLinkMessage('unavailable');
    return res.status(unavailable.statusCode).json({ error: unavailable.message });
  }
  const publicDetails = {
    orderStatus: tracking.orderStatus,
    requestedTime: tracking.requestedTime,
    neighborhood: tracking.neighborhood,
    landmark: tracking.landmark,
    driver: tracking.driverName ? { name: tracking.driverName, vehicleType: tracking.driverVehicleType } : null,
    mapConfig: mapConfiguration(),
  };
  if (terminalOrderStatuses.includes(tracking.orderStatus)) {
    const message = tracking.orderStatus === 'Livrée' ? 'Votre livraison a été remise.'
      : tracking.orderStatus === 'Retournée' ? 'La livraison a été retournée à l’entreprise.'
        : 'Cette livraison a été annulée.';
    return res.json({ status: 'completed', positionVisible: false, ...publicDetails, message, timestamp: tracking.statusChangedAt });
  }
  const activeDetails = { ...publicDetails, destination: tracking.destination };
  if (tracking.orderStatus && !publicTrackingPositionStatuses.includes(tracking.orderStatus)) {
    return res.json({
      status: 'waiting',
      positionVisible: false,
      ...activeDetails,
      message: 'Le suivi en direct commencera lorsque le livreur prendra la route.',
    });
  }
  activeDetails.positionVisible = true;
  if (!traccarConfigured() || !deviceId) {
    return res.json({ status: 'unavailable', ...activeDetails, message: 'La position du livreur n’est pas encore disponible.' });
  }
  const fleetSnapshot = await loadTraccarFleetSnapshot();
  if (fleetSnapshot.status !== 'online') {
    return res.json({ status: 'unavailable', ...activeDetails, message: 'Le service de localisation est temporairement indisponible.' });
  }
  const device = fleetSnapshot.devices.find((item) => String(item.uniqueId) === String(deviceId));
  if (!device) return res.json({ status: 'waiting', ...activeDetails, message: 'Le livreur n’a pas encore transmis de position.' });
  const position = fleetSnapshot.positions.find((item) => String(item.deviceId) === String(device.id));
  const latitude = Number(position?.latitude);
  const longitude = Number(position?.longitude);
  if (!position || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.json({ status: 'waiting', ...activeDetails, message: 'Position momentanément indisponible.' });
  }
  const timestamp = position.fixTime || position.deviceTime || position.serverTime || device.lastUpdate || null;
  const timestampMs = timestamp ? new Date(timestamp).getTime() : NaN;
  const isStale = !Number.isFinite(timestampMs) || Date.now() - timestampMs > 10 * 60 * 1000;
  const finiteOrNull = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);
  return res.json({
    status: isStale ? 'stale' : 'online',
    ...activeDetails,
    latitude,
    longitude,
    speed: finiteOrNull(position.speed),
    course: finiteOrNull(position.course),
    accuracy: finiteOrNull(position.accuracy),
    timestamp,
  });
}));

app.use((error, _req, res, _next) => {
  const correlationId = crypto.randomUUID();
  console.error(`[${correlationId}]`, error);
  if (res.headersSent) return;
  return res.status(500).json({ error: 'Une erreur interne est survenue.', correlationId });
});

// Rétro-rattachement : les commandes actives créées avant l'auto-tournée
// n'appartiennent à aucune tournée. On les regroupe dans la tournée du jour de
// leur livreur (créée si besoin). Étape best-effort : toute erreur est
// journalisée mais ne fait jamais échouer le démarrage.
async function backfillOrderRuns(dbPool) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO delivery_runs (
        company_id, driver_id, name, service_date, status,
        create_idempotency_key, create_fingerprint, created_by_user_id
      )
      SELECT DISTINCT o.company_id, o.driver_id,
             'Tournée du ' || TO_CHAR(o.created_at, 'DD/MM/YYYY'),
             o.created_at::date, 'draft',
             'backfill-run:' || o.company_id || ':' || o.driver_id || ':' || o.created_at::date,
             md5('backfill-run:' || o.company_id || ':' || o.driver_id || ':' || o.created_at::date),
             NULL
      FROM orders o
      WHERE o.status NOT IN ('Livrée','Retournée','Annulée')
        AND NOT EXISTS (SELECT 1 FROM delivery_stops s WHERE s.order_id = o.id AND s.assignment_active = TRUE)
        AND NOT EXISTS (SELECT 1 FROM delivery_runs r
                        WHERE r.company_id = o.company_id AND r.driver_id = o.driver_id
                          AND r.service_date = o.created_at::date AND r.status IN ('draft','planned','active'))
      ON CONFLICT (company_id, create_idempotency_key) DO NOTHING
    `);
    await client.query(`
      INSERT INTO delivery_stops (company_id, run_id, order_id, sequence)
      SELECT o.company_id, r.id, o.id,
             COALESCE((SELECT MAX(s2.sequence) FROM delivery_stops s2
                       WHERE s2.run_id = r.id AND s2.removed_at IS NULL), 0)
             + ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY o.created_at, o.id)
      FROM orders o
      JOIN delivery_runs r ON r.company_id = o.company_id AND r.driver_id = o.driver_id
                          AND r.service_date = o.created_at::date AND r.status IN ('draft','planned','active')
      WHERE o.status NOT IN ('Livrée','Retournée','Annulée')
        AND NOT EXISTS (SELECT 1 FROM delivery_stops s WHERE s.order_id = o.id AND s.assignment_active = TRUE)
      ON CONFLICT DO NOTHING
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Backfill order→run attach skipped:', error.message);
  } finally {
    client.release();
  }
}

initDatabase()
  .then(() => applyCrmSchema(pool, path.join(__dirname, 'db', 'crm-schema.sql')))
  .then(() => synchronizeExistingOrders(pool))
  .then(() => backfillOrderRuns(pool))
  .then(() => app.listen(port, () => console.log(`Delivery SaaS listening on port ${port}`)))
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
