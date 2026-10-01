require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { Pool } = require('pg');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const { createRoutingAdapter, RoutingInputError } = require('./lib/routing');
const { calculateCrmMetrics } = require('./lib/crm-metrics');
const { computeInsights } = require('./lib/dashboard-insights');
const { computeEta, learnedParameters } = require('./lib/eta');
const totpLib = require('./lib/totp');
const { WhatsAppChannel, internationalDigits, maskPhone } = require('./lib/whatsapp');
const { buildIncidentPdf } = require('./lib/incident-pdf');
const QRCode = require('qrcode');
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
  columnLabel: exportColumnLabel,
} = require('./lib/crm-export-contract');
const { buildWorkbook: buildExportWorkbook } = require('./lib/crm-xlsx');
const {
  buildOperationsExportQuery,
  normalizeExportRow,
  OPERATIONS_NUMERIC_COLUMNS,
} = require('./lib/crm-operations-export');
const {
  buildCustomersExportQuery,
  CUSTOMERS_NUMERIC_COLUMNS,
  buildIncidentsExportQuery,
  INCIDENTS_NUMERIC_COLUMNS,
  buildRoutesExportQuery,
  ROUTES_NUMERIC_COLUMNS,
} = require('./lib/crm-dataset-exports');
const { buildPremiumWorkbook } = require('./lib/crm-premium-xlsx');
const { DATASET_COLUMN_DEFS: EXPORT_COLUMN_DEFS } = require('./lib/crm-export-contract');
const EXPORT_DATASET_TITLES = { operations: 'Commandes', customers: 'Clients', incidents: 'Incidents', routes: 'Tournées' };
// Logo chargé une fois pour la couverture des exports premium (repli sans logo).
let premiumLogoBuffer = null;
try { premiumLogoBuffer = fs.readFileSync(path.join(__dirname, 'public', 'brand', 'traxo-email.png')); } catch (_) { premiumLogoBuffer = null; }
// Jeux de données câblés pour l'export (requête + colonnes numériques).
const EXPORT_QUERY_BUILDERS = {
  operations: { build: buildOperationsExportQuery, numeric: OPERATIONS_NUMERIC_COLUMNS },
  customers: { build: buildCustomersExportQuery, numeric: CUSTOMERS_NUMERIC_COLUMNS },
  incidents: { build: buildIncidentsExportQuery, numeric: INCIDENTS_NUMERIC_COLUMNS },
  routes: { build: buildRoutesExportQuery, numeric: ROUTES_NUMERIC_COLUMNS },
};
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
// Session standard : 12 h. « Rester connecté » : 30 jours au maximum (durée
// absolue, non prolongée à l'usage).
const sessionDurationMs = 12 * 60 * 60 * 1000;
const rememberSessionMs = 30 * 24 * 60 * 60 * 1000;
const editableRequestStatuses = ['À vérifier', 'Informations à compléter'];
// Demande saisie par l'équipe, en attente de la confirmation du client.
const PREFILLED_REQUEST_STATUS = 'À confirmer par le client';
const PREFILLED_CONFIRM_MAX_ATTEMPTS = 5;
// « Validée » : l'entreprise a validé la demande (infos client verrouillées)
// sans avoir encore affecté de livreur. La conversion en commande reste possible.
const convertibleRequestStatuses = [...editableRequestStatuses, 'Validée'];
// Réglage Livraisons « Le client peut corriger sa demande après validation » :
// une demande « Validée » (pas encore convertie en commande) reste modifiable.
const publicEditableSql = `(status = ANY($EDIT::text[]) OR (status = 'Validée' AND COALESCE((
  SELECT (c.delivery_settings->>'allowEditAfterValidation')::boolean FROM companies c WHERE c.id = customer_requests.company_id), FALSE)))`;
const REQUEST_PHOTO_MAX = 3;
const REQUEST_PHOTO_MAX_BYTES = 700 * 1024;
const terminalOrderStatuses = ['Livrée', 'Retournée', 'Annulée'];
const publicTrackingPositionStatuses = ['En tournée', 'En livraison', 'Arrivée'];
const orderTransitions = {
  'En préparation': ['Confirmée', 'Annulée'],
  'Confirmée': ['Vers la collecte', 'Récupérée', 'Annulée'],
  // Le livreur part chercher le colis au point de collecte.
  'Vers la collecte': ['Récupérée', 'Annulée'],
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
const driverTransitionTargets = ['Vers la collecte', 'Récupérée', 'En tournée', 'En livraison', 'Arrivée', 'Échec', 'Retour'];
const evidenceTypes = ['photo', 'signature'];
const evidenceModes = ['off', 'optional', 'required'];
const runStatuses = ['draft', 'planned', 'active', 'completed', 'cancelled'];
const runStatusLabelsFr = { draft: 'En préparation', planned: 'Planifiée', active: 'En cours', completed: 'Terminée', cancelled: 'Annulée' };
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

// ---- Tuiles vectorielles auto-hébergées ------------------------------------
// Le service Railway « tiles » (dossier tiles/) sert les pays couverts au format
// PMTiles. On le relaie en même origine, avec un cache mémoire borné, et on
// surveille sa disponibilité pour basculer sur le fond raster s'il tombe.
const VECTOR_TILES_URL = String(process.env.TILES_INTERNAL_URL || '').trim().replace(/\/+$/, '');
const VECTOR_TILES_NAME = String(process.env.TILES_NAME || 'zones').trim();
const VECTOR_TILES_MAX_ZOOM = 15;
const VECTOR_TILES_CACHE_BYTES = 48 * 1024 * 1024;
const vectorTiles = { healthy: false, checkedAt: 0, cache: new Map(), cacheBytes: 0 };

async function checkVectorTiles() {
  if (!VECTOR_TILES_URL) { vectorTiles.healthy = false; return false; }
  const before = vectorTiles.healthy;
  let reason = '';
  try {
    const response = await fetch(`${VECTOR_TILES_URL}/${encodeURIComponent(VECTOR_TILES_NAME)}/0/0/0.mvt`, { signal: AbortSignal.timeout(4000) });
    vectorTiles.healthy = response.ok;
    if (!response.ok) reason = `HTTP ${response.status}`;
    await response.arrayBuffer().catch(() => null);
  } catch (error) {
    vectorTiles.healthy = false;
    reason = error.cause?.code || error.name || 'erreur réseau';
  }
  vectorTiles.checkedAt = Date.now();
  if (before !== vectorTiles.healthy || (!vectorTiles.healthy && !vectorTiles.reported)) {
    console.log(vectorTiles.healthy ? 'Tuiles vectorielles disponibles' : `Tuiles vectorielles injoignables (${reason}) : fond raster de secours`);
    vectorTiles.reported = true;
  }
  return vectorTiles.healthy;
}

function cacheVectorTile(key, entry) {
  if (vectorTiles.cache.has(key)) return;
  vectorTiles.cache.set(key, entry);
  vectorTiles.cacheBytes += entry.body.length;
  // Map conserve l'ordre d'insertion : on évince les plus anciennes.
  for (const [oldKey, oldEntry] of vectorTiles.cache) {
    if (vectorTiles.cacheBytes <= VECTOR_TILES_CACHE_BYTES) break;
    vectorTiles.cache.delete(oldKey);
    vectorTiles.cacheBytes -= oldEntry.body.length;
  }
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
  // Routes et rues par-dessus l'imagerie (vue hybride).
  const roadsUrl = String(process.env.MAP_ROADS_TILE_URL
    || 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}').trim();
  // Fond de plan : tuiles vectorielles auto-hébergées (service « tiles »,
  // relayées sur /tiles) dès qu'elles répondent ; sinon fond raster de secours.
  const base = vectorTiles.healthy ? {
    type: 'vector',
    url: '/tiles/{z}/{x}/{y}.mvt',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    maxZoom: 19,
    maxDataZoom: VECTOR_TILES_MAX_ZOOM,
    flavor: 'light',
    lang: 'fr',
  } : {
    type: 'raster',
    url: String(process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
    attribution: String(process.env.MAP_TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors'),
    maxZoom: maxZoom(process.env.MAP_TILE_MAX_ZOOM),
  };
  return {
    base,
    satellite: satelliteUrl ? {
      url: satelliteUrl,
      attribution: String(process.env.MAP_SATELLITE_ATTRIBUTION
        || 'Imagerie &copy; Esri, Maxar, Earthstar Geographics'),
      maxZoom: maxZoom(process.env.MAP_SATELLITE_MAX_ZOOM),
      // Zoom natif de l'imagerie : au-delà, les tuiles sont agrandies.
      maxNativeZoom: maxZoom(process.env.MAP_SATELLITE_NATIVE_ZOOM, 18),
    } : null,
    roads: roadsUrl ? {
      url: roadsUrl,
      attribution: String(process.env.MAP_ROADS_ATTRIBUTION || '&copy; Esri'),
      maxZoom: maxZoom(process.env.MAP_ROADS_MAX_ZOOM),
      maxNativeZoom: maxZoom(process.env.MAP_ROADS_NATIVE_ZOOM, 18),
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
// Formulaire / page de demande client (lecture, modification, photos).
const publicRequestRateLimit = createRateLimitMiddleware({
  keySecret: process.env.RATE_LIMIT_KEY_SECRET || trackingTokenSecret() || undefined,
  policies: [
    createIpPolicy({
      limiter: trackingLimiter('request-ip', { capacity: 120, refillTokens: 120, refillIntervalMs: 60_000, maxEntries: 10_000 }),
    }),
    createTokenPolicy({
      limiter: trackingLimiter('request-token', { capacity: 40, refillTokens: 40, refillIntervalMs: 60_000, maxEntries: 20_000 }),
      key: (req) => req.params.token,
    }),
  ],
});
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), {
  immutable: true,
  maxAge: '30d',
}));
app.use('/vendor/protomaps-leaflet', express.static(path.join(__dirname, 'node_modules', 'protomaps-leaflet', 'dist'), {
  maxAge: '7d',
}));
app.use('/vendor/maplibre-gl', express.static(path.join(__dirname, 'node_modules', 'maplibre-gl', 'dist'), { maxAge: '7d' }));
app.use('/vendor/maplibre-gl-leaflet', express.static(path.join(__dirname, 'node_modules', '@maplibre', 'maplibre-gl-leaflet'), { maxAge: '7d' }));
app.use('/vendor/protomaps-basemaps', express.static(path.join(__dirname, 'node_modules', '@protomaps', 'basemaps', 'dist'), { maxAge: '7d' }));
app.use('/vendor/basemaps-assets', express.static(path.join(__dirname, 'public', 'vendor', 'basemaps-assets'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

// Relais des tuiles vectorielles (même origine : pas de CORS, pas de domaine
// public pour le service de tuiles).
app.get('/tiles/:z/:x/:y.mvt', asyncRoute(async (req, res) => {
  const [z, x, y] = [req.params.z, req.params.x, req.params.y].map((value) => (/^\d{1,6}$/.test(value) ? Number(value) : NaN));
  if (![z, x, y].every(Number.isInteger) || z > VECTOR_TILES_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) {
    return res.status(404).set('Cache-Control', 'no-store').end();
  }
  if (!VECTOR_TILES_URL) return res.status(404).set('Cache-Control', 'no-store').end();
  const key = `${z}/${x}/${y}`;
  const send = (entry) => {
    res.set({ 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
    if (!entry.body.length) return res.status(204).end();
    return res.status(200).type('application/vnd.mapbox-vector-tile').send(entry.body);
  };
  const cached = vectorTiles.cache.get(key);
  if (cached) return send(cached);
  let response;
  try {
    response = await fetch(`${VECTOR_TILES_URL}/${encodeURIComponent(VECTOR_TILES_NAME)}/${key}.mvt`, { signal: AbortSignal.timeout(8000) });
  } catch {
    vectorTiles.healthy = false;
    return res.status(502).set('Cache-Control', 'no-store').end();
  }
  if (response.status === 204 || response.status === 404) {
    await response.arrayBuffer().catch(() => null);
    const entry = { body: Buffer.alloc(0) };
    cacheVectorTile(key, entry);
    return send(entry);
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => null);
    return res.status(502).set('Cache-Control', 'no-store').end();
  }
  // fetch décompresse déjà un éventuel Content-Encoding gzip.
  const entry = { body: Buffer.from(await response.arrayBuffer()) };
  cacheVectorTile(key, entry);
  return send(entry);
}));

// Configuration du fond de carte pour les pages publiques (formulaire client).
app.get('/api/public/map-config', (req, res) => {
  res.set('Cache-Control', 'no-store').json(mapConfiguration());
});

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
    for (const file of ['app.js', 'app.css', 'driver.js', 'driver.css', 'client.js', 'client.css', 'map-base.js']) {
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
      .replace(/(href|src)="\/(app|driver|client|map-base|auth|onboarding|loaders|settings|ui-kit|neworder|confirm|notifications|dashboard|drivers|join)\.(css|js)"/g, `$1="/$2.$3?v=${ASSET_VERSION}"`);
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

// « Vers la collecte » n'a de sens que si la commande a un point de collecte.
function allowedOrderTransitions(status, order = null) {
  const next = orderTransitions[status] || [];
  const hasPickup = Boolean(order && (order.pickup_address || order.pickup_name || order.pickup_lat != null));
  return hasPickup ? next : next.filter((target) => target !== 'Vers la collecte');
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

function setSessionCookie(req, res, token, durationMs = sessionDurationMs) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append(
    'Set-Cookie',
    `delivery_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(durationMs / 1000)}${secure ? '; Secure' : ''}`
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
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_data BYTEA;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_mime TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
      -- Configuration guidée après inscription. Les entreprises existantes
      -- prennent la valeur par défaut « done » ; seules les nouvelles
      -- inscriptions sont créées en « pending ».
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'done';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_type TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS country TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS city TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS fleet_estimate TEXT;

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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS login_alerts BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
      CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL;
      CREATE TABLE IF NOT EXISTS mfa_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id BIGINT,
        role TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE mfa_challenges ADD COLUMN IF NOT EXISTS remember BOOLEAN NOT NULL DEFAULT FALSE;
      -- Session WhatsApp (Baileys), chiffrée ; une ligne par clé.
      CREATE TABLE IF NOT EXISTS whatsapp_auth (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- Code de vérification envoyé par e-mail (inscription, nouvel appareil).
      -- Code haché avec un secret serveur ; 10 min, 5 essais, 5 envois max.
      CREATE TABLE IF NOT EXISTS login_codes (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id BIGINT,
        role TEXT,
        purpose TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        remember BOOLEAN NOT NULL DEFAULT FALSE,
        attempts INTEGER NOT NULL DEFAULT 0,
        sends INTEGER NOT NULL DEFAULT 1,
        last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';
      -- Appareils reconnus après un code valide : pas de nouveau code pendant 30 jours.
      CREATE TABLE IF NOT EXISTS trusted_devices (
        token_hash TEXT NOT NULL,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_agent TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (token_hash, user_id)
      );
      -- Appareil reconnu uniquement si l'utilisateur a coché « Rester connecté ».
      ALTER TABLE trusted_devices ADD COLUMN IF NOT EXISTS remembered BOOLEAN NOT NULL DEFAULT FALSE;

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
      ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;

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
      -- Profil livreur complet (kit Livreurs) et permissions dans l'appli.
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS plate TEXT;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS zone TEXT;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS team TEXT;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS note TEXT;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS can_contact BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS can_report_incident BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS driver_code TEXT;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone_digits TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS drivers_company_code_unique ON drivers(company_id, driver_code) WHERE driver_code IS NOT NULL;
      UPDATE drivers SET phone_digits = NULLIF(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), '') WHERE phone_digits IS NULL AND phone IS NOT NULL;
      WITH mx AS (
        SELECT company_id, COALESCE(MAX(NULLIF(regexp_replace(COALESCE(driver_code, ''), '\\D', '', 'g'), '')::int), 0) AS m FROM drivers GROUP BY company_id
      ), todo AS (
        SELECT id, company_id, row_number() OVER (PARTITION BY company_id ORDER BY id) AS rn FROM drivers WHERE driver_code IS NULL
      )
      UPDATE drivers d SET driver_code = 'LIV-' || lpad((mx.m + todo.rn)::text, 3, '0')
      FROM todo JOIN mx ON mx.company_id = todo.company_id WHERE d.id = todo.id;

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
      -- Demandes pré-remplies par l'équipe, que le client confirme (code à 4 chiffres).
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS prefilled_by_user_id BIGINT;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS confirm_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS confirm_locked_at TIMESTAMPTZ;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS customer_confirmed_at TIMESTAMPTZ;
      -- Colis et point de collecte facultatif (le colis est récupéré ailleurs avant la remise).
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS package_description TEXT;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS package_type TEXT;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_name TEXT;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_phone TEXT;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_address TEXT;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
      ALTER TABLE customer_requests ADD COLUMN IF NOT EXISTS pickup_ready TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS customer_requests_edit_token_unique
        ON customer_requests(edit_token_hash) WHERE edit_token_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS customer_request_photos (
        id BIGSERIAL PRIMARY KEY,
        request_id BIGINT NOT NULL REFERENCES customer_requests(id) ON DELETE CASCADE,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        data BYTEA NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS customer_request_photos_request_idx
        ON customer_request_photos(request_id, id);

      ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_request_id BIGINT REFERENCES customer_requests(id);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS requested_time TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_lat DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_lng DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_accuracy DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS neighborhood TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_description TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_type TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_name TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_phone TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_address TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_ready TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_lat DOUBLE PRECISION;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_lng DOUBLE PRECISION;
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

      -- Durée prévue / réelle du dernier trajet vers chaque client : sert à caler
      -- l'estimation d'arrivée sur la circulation réelle de l'entreprise.
      CREATE TABLE IF NOT EXISTS eta_samples (
        order_id BIGINT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        predicted_seconds INTEGER NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actual_seconds INTEGER,
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS eta_samples_company_idx ON eta_samples(company_id, completed_at DESC);
      -- Invitation d'un livreur à l'appli : QR + code de secours, 15 min, usage unique.
      CREATE TABLE IF NOT EXISTS driver_invitations (
        id BIGSERIAL PRIMARY KEY,
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        driver_id BIGINT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        code_hash TEXT NOT NULL UNIQUE,
        replacement BOOLEAN NOT NULL DEFAULT FALSE,
        expires_at TIMESTAMPTZ NOT NULL,
        verify_code_hash TEXT,
        verify_sent_at TIMESTAMPTZ,
        verify_attempts INTEGER NOT NULL DEFAULT 0,
        used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS driver_invitations_driver_idx ON driver_invitations(driver_id, created_at DESC);
      -- Places livreurs utilisées dans le mois (anti-partage d'abonnement) : une
      -- personne compte une fois dans le mois, même si son profil est supprimé puis recréé.
      CREATE TABLE IF NOT EXISTS driver_seat_usage (
        company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        month DATE NOT NULL,
        seat_key TEXT NOT NULL,
        driver_id BIGINT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (company_id, month, seat_key)
      );
      CREATE TABLE IF NOT EXISTS notification_states (
        user_id BIGINT NOT NULL,
        company_id BIGINT NOT NULL,
        notif_key TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ,
        later_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, company_id, notif_key)
      );
      CREATE TABLE IF NOT EXISTS notification_prefs (
        user_id BIGINT NOT NULL,
        company_id BIGINT NOT NULL,
        categories JSONB NOT NULL DEFAULT '{}'::jsonb,
        digest TEXT NOT NULL DEFAULT 'off',
        digest_hour INTEGER NOT NULL DEFAULT 8,
        digest_day INTEGER NOT NULL DEFAULT 1,
        timezone TEXT,
        last_digest_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, company_id)
      );

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

    const platformAdmins = String(process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean);
    if (platformAdmins.length) {
      await client.query('UPDATE users SET is_platform_admin = TRUE WHERE email = ANY($1) AND is_platform_admin = FALSE', [platformAdmins]);
    }

    await client.query('DELETE FROM app_sessions WHERE expires_at <= NOW()');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createSession(req, res, userId, companyId, scope, { remember = false, durationMs: forcedDuration = null } = {}) {
  const token = randomToken();
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 400) || null;
  const durationMs = forcedDuration || (remember ? rememberSessionMs : sessionDurationMs);
  await pool.query(
    `INSERT INTO app_sessions (token_hash, user_id, company_id, scope, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [digest(token), userId, companyId || null, scope, new Date(Date.now() + durationMs), userAgent]
  );
  setSessionCookie(req, res, token, durationMs);
}

async function readSession(req, scope) {
  if (!pool) return null;
  const token = parseCookies(req).delivery_session;
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.user_id, s.company_id, s.scope, s.expires_at,
            u.email, u.display_name, u.is_platform_admin, u.disabled,
            c.name AS company_name, c.slug AS company_slug, c.activation_status, c.logo_updated_at AS company_logo_at, c.onboarding_status, m.role, m.driver_id,
            d.active AS driver_active, d.can_contact AS driver_can_contact, d.can_report_incident AS driver_can_report
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
    if (session.onboarding_status === 'pending' && session.role === 'owner') return res.redirect('/app/bienvenue');
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
    // Exceptions : la sécurité du compte personnel (mot de passe, double
    // authentification, sessions, numéro) et la demande de devis restent possibles.
    const previewAllowed = req.path.startsWith('/api/app/account/') || req.path === '/api/app/billing/quote-request';
    if (isWrite && session.activation_status === 'preview' && !previewAllowed) {
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
app.get('/favicon.ico', (_req, res) => res.type('png').set('Cache-Control', 'public, max-age=604800').sendFile(path.join(__dirname, 'public', 'favicon.png')));

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

const wantsRemember = (value) => value === true || value === 'on' || value === '1' || value === 'true';

// Page d'arrivée après connexion : appli livreur, configuration guidée tant
// qu'elle n'est pas terminée (propriétaire), sinon le back-office.
function homeAfterLogin(role, onboardingStatus) {
  if (role === 'driver') return '/driver';
  if (role === 'owner' && onboardingStatus === 'pending') return '/app/bienvenue';
  return '/app';
}

// Défi de double authentification (application TOTP) : mot de passe (ou
// Google) validé, mais la session n'est ouverte qu'après le code.
async function startTotpChallenge(req, res, { userId, companyId, role, remember }) {
  const challenge = randomToken();
  await pool.query('DELETE FROM mfa_challenges WHERE user_id = $1 OR expires_at < NOW()', [userId]);
  await pool.query(
    `INSERT INTO mfa_challenges (token_hash, user_id, company_id, role, expires_at, remember)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '5 minutes', $5)`,
    [digest(challenge), userId, companyId, role, Boolean(remember)]
  );
  setMfaCookie(req, res, challenge, 300);
}

// --- Code de vérification par e-mail (inscription, connexion sur un nouvel appareil) ---
// Actif dès qu'un fournisseur d'e-mail est configuré (LOGIN_EMAIL_CODE=off pour
// le couper, =on pour le forcer en test avec EMAIL_OUTBOX_DIR).
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_RESEND_S = 30;
const LOGIN_CODE_MAX_SENDS = 5;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const TRUSTED_DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
function loginCodesEnabled() {
  const mode = String(process.env.LOGIN_EMAIL_CODE || '').toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return emailConfigured();
}
function loginCodePepper() {
  return process.env.OTP_PEPPER || trackingTokenSecret() || process.env.SESSION_SECRET || 'traxo-dev-login-code';
}
function loginCodeHash(challenge, code) {
  return crypto.createHmac('sha256', loginCodePepper()).update(`login-code:v1:${challenge}:${code}`).digest('hex');
}
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'•'.repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
}
function cookieFlags(req) {
  return (req.secure || req.get('x-forwarded-proto') === 'https') ? '; Secure' : '';
}
function setVerifyCookie(req, res, value, maxAge) {
  res.append('Set-Cookie', `traxo_verify=${encodeURIComponent(value)}; Path=/app/login; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieFlags(req)}`);
}
async function isTrustedDevice(req, userId) {
  const token = String(parseCookies(req).traxo_device || '');
  if (!token) return false;
  const result = await pool.query(
    `UPDATE trusted_devices SET last_used_at = NOW()
     WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW() AND remembered = TRUE RETURNING 1`,
    [digest(token), userId]
  );
  return result.rowCount > 0;
}
async function trustDevice(req, res, userId) {
  let token = String(parseCookies(req).traxo_device || '');
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) token = randomToken();
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 400) || null;
  await pool.query(
    `INSERT INTO trusted_devices (token_hash, user_id, user_agent, expires_at, remembered)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (token_hash, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, user_agent = EXCLUDED.user_agent, remembered = TRUE, last_used_at = NOW()`,
    [digest(token), userId, userAgent, new Date(Date.now() + TRUSTED_DEVICE_MS)]
  );
  res.append('Set-Cookie', `traxo_device=${encodeURIComponent(token)}; Path=/app; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TRUSTED_DEVICE_MS / 1000)}${cookieFlags(req)}`);
}
// Alerte de connexion : e-mail envoyé lorsqu'une session s'ouvre sur un
// appareil non reconnu, si l'utilisateur l'a activée (par défaut : oui).
function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const os = /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iPhone / iPad' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : 'Appareil inconnu';
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Navigateur';
  return `${browser} sur ${os}`;
}
async function notifyNewLogin(req, userId, method) {
  const row = (await pool.query(
    `SELECT u.email, u.login_alerts, c.timezone FROM users u
     LEFT JOIN company_memberships m ON m.user_id = u.id LEFT JOIN companies c ON c.id = m.company_id
     WHERE u.id = $1 ORDER BY m.id LIMIT 1`, [userId])).rows[0];
  if (!row || row.login_alerts === false) return;
  const when = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: row.timezone || 'Africa/Porto-Novo' }).format(new Date());
  const how = { code: 'mot de passe + code de vérification', totp: 'mot de passe + application d’authentification', google: 'compte Google' }[method] || method;
  const device = describeDevice(req.headers['user-agent']);
  const base = publicBaseUrl(req);
  const html = renderEmailShell({
    baseUrl: base,
    heading: 'Nouvelle connexion à votre compte',
    introHtml: 'Une connexion à votre compte TRAXO vient d’avoir lieu depuis un appareil qui n’était pas reconnu.',
    bodyHtml: `<table role="presentation" style="font-family:Arial,sans-serif;font-size:14px;color:#344054;margin:14px 0"><tr><td style="padding:4px 16px 4px 0;color:#667085">Quand</td><td>${escHtmlServer(when)}</td></tr><tr><td style="padding:4px 16px 4px 0;color:#667085">Appareil</td><td>${escHtmlServer(device)}</td></tr><tr><td style="padding:4px 16px 4px 0;color:#667085">Méthode</td><td>${escHtmlServer(how)}</td></tr></table>`,
    ctaLabel: 'Voir mes sessions',
    ctaUrl: `${base}/app/parametres?section=security`,
    footerNote: 'C’est bien vous ? Aucune action n’est nécessaire. Sinon, changez votre mot de passe et fermez les autres sessions depuis Paramètres › Sécurité.',
  });
  await sendEmail({ to: row.email, subject: 'TRAXO — Nouvelle connexion à votre compte', html, text: `Nouvelle connexion à votre compte TRAXO\nQuand : ${when}\nAppareil : ${device}\nMéthode : ${how}\n\nCe n’est pas vous ? Changez votre mot de passe.` });
}
function newLoginCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}
async function sendLoginCodeEmail(req, email, code, purpose) {
  const base = publicBaseUrl(req);
  const intro = purpose === 'signup'
    ? 'Voici votre code pour confirmer votre adresse e-mail et terminer la création de votre compte TRAXO.'
    : 'Voici votre code pour vous connecter à TRAXO depuis un nouvel appareil.';
  const html = renderEmailShell({
    baseUrl: base,
    heading: purpose === 'signup' ? 'Confirmez votre adresse e-mail' : 'Votre code de connexion',
    introHtml: intro,
    bodyHtml: `<p style="font-family:Arial,sans-serif;font-size:34px;font-weight:700;letter-spacing:8px;color:#111827;margin:22px 0 8px">${code}</p>
      <p style="font-family:Arial,sans-serif;font-size:13.5px;color:#667085;margin:0">Ce code est valable 10 minutes. Ne le communiquez à personne : l’équipe TRAXO ne vous le demandera jamais.</p>`,
    footerNote: purpose === 'signup'
      ? 'Vous n’avez pas créé de compte TRAXO ? Ignorez cet e-mail.'
      : 'Ce n’est pas vous ? Quelqu’un connaît votre mot de passe : changez-le dès maintenant depuis « Mot de passe oublié ».',
  });
  const text = `${intro}\n\nCode : ${code}\n\nValable 10 minutes. Ne le communiquez à personne.`;
  return sendEmail({ to: email, subject: `${code} — votre code TRAXO`, html, text });
}
// Canal WhatsApp (numéro TRAXO relié depuis Paramètres › WhatsApp).
const whatsapp = new WhatsAppChannel({
  pool,
  secret: process.env.WHATSAPP_SECRET || process.env.MFA_SECRET || trackingTokenSecret(),
});
// Tests locaux uniquement : canal simulé qui écrit les messages dans
// EMAIL_OUTBOX_DIR (jamais en production).
if (process.env.WHATSAPP_FAKE === 'outbox' && process.env.EMAIL_OUTBOX_DIR
  && process.env.NODE_ENV !== 'production' && process.env.RAILWAY_ENVIRONMENT_NAME !== 'production') {
  whatsapp.isReady = () => true;
  whatsapp.sendText = async (phone, text) => {
    if (!internationalDigits(phone)) throw Object.assign(new Error('bad_number'), { code: 'bad_number' });
    fs.mkdirSync(process.env.EMAIL_OUTBOX_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.EMAIL_OUTBOX_DIR, `${Date.now()}-wa.json`), JSON.stringify({ whatsapp: internationalDigits(phone), text }));
    return { jid: `${internationalDigits(phone)}@s.whatsapp.net` };
  };
}
function whatsappAvailableFor(phone) {
  return whatsapp.isReady() && Boolean(internationalDigits(phone));
}
async function sendLoginCodeWhatsApp(phone, code, purpose) {
  const intro = purpose === 'signup' ? 'pour confirmer votre compte TRAXO' : 'pour vous connecter à TRAXO';
  return whatsapp.sendText(phone, `*${code}* est votre code ${intro}.\n\nIl expire dans 10 minutes. Ne le communiquez à personne : l’équipe TRAXO ne vous le demandera jamais.`);
}

// Crée le défi, envoie le code et pose le cookie ; renvoie false si l'e-mail
// n'a pas pu partir (l'appelant affiche alors une erreur).
// channel 'pending' : aucun code envoyé, l'utilisateur choisit d'abord
// e-mail ou WhatsApp sur la page du code.
async function startLoginCode(req, res, { userId, email, companyId, role, purpose, remember, channel = 'email' }) {
  const challenge = randomToken();
  const code = newLoginCode();
  await pool.query('DELETE FROM login_codes WHERE user_id = $1 OR expires_at < NOW()', [userId]);
  await pool.query(
    `INSERT INTO login_codes (token_hash, user_id, company_id, role, purpose, code_hash, remember, expires_at, channel, sends)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [digest(challenge), userId, companyId, role, purpose,
      channel === 'pending' ? loginCodeHash(challenge, randomToken(12)) : loginCodeHash(challenge, code),
      Boolean(remember), new Date(Date.now() + LOGIN_CODE_TTL_MS), channel, channel === 'pending' ? 0 : 1]
  );
  if (channel === 'pending') {
    setVerifyCookie(req, res, challenge, Math.floor(LOGIN_CODE_TTL_MS / 1000));
    return true;
  }
  const sent = await sendLoginCodeEmail(req, email, code, purpose);
  if (!sent.sent) {
    console.error('Login code e-mail failed:', sent.reason, sent.detail || '');
    await pool.query('DELETE FROM login_codes WHERE token_hash = $1', [digest(challenge)]);
    return false;
  }
  setVerifyCookie(req, res, challenge, Math.floor(LOGIN_CODE_TTL_MS / 1000));
  return true;
}

app.post('/app/login', loginRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Base métier non configurée.');
  const email = normalizeEmail(req.body.user);
  const remember = wantsRemember(req.body.remember);
  const result = await pool.query(
    `SELECT u.id, u.email, u.phone, u.password_salt, u.password_hash, u.disabled, u.totp_enabled_at, m.company_id, m.role, c.onboarding_status
     FROM users u JOIN company_memberships m ON m.user_id = u.id
     JOIN companies c ON c.id = m.company_id
     WHERE u.email = $1 ORDER BY m.id LIMIT 1`,
    [email]
  );
  const user = result.rows[0];
  if (!user || user.disabled || !passwordMatches(req.body.password, user.password_salt, user.password_hash)) {
    return res.redirect('/app/login?error=1');
  }
  if (user.totp_enabled_at) {
    await startTotpChallenge(req, res, { userId: user.id, companyId: user.company_id, role: user.role, remember });
    return res.redirect('/app/login/2fa');
  }
  // Appareil non reconnu : code avant d'ouvrir la session. Si WhatsApp est
  // possible, l'utilisateur choisit d'abord où le recevoir.
  if (loginCodesEnabled() && !(await isTrustedDevice(req, user.id))) {
    const started = await startLoginCode(req, res, {
      userId: user.id, email: user.email, companyId: user.company_id, role: user.role, purpose: 'login', remember,
      channel: whatsappAvailableFor(user.phone) ? 'pending' : 'email',
    });
    if (!started) return res.redirect('/app/login?error=code_send');
    return res.redirect('/app/login/code');
  }
  await createSession(req, res, user.id, user.company_id, 'company', { remember });
  return res.redirect(homeAfterLogin(user.role, user.onboarding_status));
}));

app.get('/app/login/code', (req, res) => {
  if (!parseCookies(req).traxo_verify) return res.redirect('/app/login?error=expired');
  return sendShell(res, 'app-code.html');
});
app.get('/app/login/2fa', (req, res) => {
  if (!parseCookies(req).traxo_mfa) return res.redirect('/app/login?error=expired');
  return sendShell(res, 'app-code.html');
});

async function findLoginCode(queryable, req, { lock = false } = {}) {
  const challenge = String(parseCookies(req).traxo_verify || '');
  if (!challenge) return { challenge, row: null };
  const row = (await queryable.query(
    `SELECT l.*, u.email, u.phone FROM login_codes l JOIN users u ON u.id = l.user_id
     WHERE l.token_hash = $1 AND l.expires_at > NOW()${lock ? ' FOR UPDATE OF l' : ''}`,
    [digest(challenge)]
  )).rows[0] || null;
  return { challenge, row };
}

app.get('/app/login/code/state', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!pool) return res.status(503).json({ error: 'Base métier non configurée.' });
  const { row } = await findLoginCode(pool, req);
  if (!row) return res.status(410).json({ error: 'expired' });
  const wait = Math.max(0, LOGIN_CODE_RESEND_S - Math.floor((Date.now() - new Date(row.last_sent_at).getTime()) / 1000));
  return res.json({
    email: maskEmail(row.email),
    purpose: row.purpose,
    channel: row.channel,
    whatsapp: whatsappAvailableFor(row.phone) ? maskPhone(row.phone) : null,
    resendIn: row.sends >= LOGIN_CODE_MAX_SENDS ? null : wait,
    attemptsLeft: Math.max(0, LOGIN_CODE_MAX_ATTEMPTS - row.attempts),
  });
}));

app.post('/app/login/code/resend', loginRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Base métier non configurée.' });
  const { challenge, row } = await findLoginCode(pool, req);
  if (!row) return res.status(410).json({ error: 'Ce code a expiré. Reconnectez-vous pour en recevoir un nouveau.' });
  if (row.sends >= LOGIN_CODE_MAX_SENDS) return res.status(429).json({ error: 'Nombre maximal d’envois atteint. Reconnectez-vous dans quelques minutes.' });
  const channel = (req.body && req.body.channel) === 'whatsapp' ? 'whatsapp' : 'email';
  if (channel === 'whatsapp' && !whatsappAvailableFor(row.phone)) {
    return res.status(409).json({ error: 'L’envoi par WhatsApp n’est pas disponible pour ce compte. Utilisez l’e-mail.' });
  }
  // Changer de canal est permis tout de suite ; renvoyer sur le même canal, toutes les 30 s.
  const elapsed = (Date.now() - new Date(row.last_sent_at).getTime()) / 1000;
  if (channel === row.channel && elapsed < LOGIN_CODE_RESEND_S) return res.status(429).json({ error: 'Patientez quelques secondes avant de demander un nouveau code.', resendIn: Math.ceil(LOGIN_CODE_RESEND_S - elapsed) });
  const code = newLoginCode();
  const updated = await pool.query(
    `UPDATE login_codes SET code_hash = $1, sends = sends + 1, attempts = 0, last_sent_at = NOW(), expires_at = $2, channel = $5
     WHERE token_hash = $3 AND sends = $4 RETURNING sends`,
    [loginCodeHash(challenge, code), new Date(Date.now() + LOGIN_CODE_TTL_MS), digest(challenge), row.sends, channel]
  );
  if (!updated.rowCount) return res.status(429).json({ error: 'Un code vient déjà d’être envoyé.', resendIn: LOGIN_CODE_RESEND_S });
  if (channel === 'whatsapp') {
    try {
      await sendLoginCodeWhatsApp(row.phone, code, row.purpose);
    } catch (error) {
      console.error('Login code WhatsApp failed:', error.code || error.message);
      const message = error.code === 'not_on_whatsapp'
        ? 'Votre numéro n’a pas de compte WhatsApp. Utilisez l’e-mail.'
        : 'Le code n’a pas pu être envoyé sur WhatsApp. Utilisez l’e-mail.';
      return res.status(502).json({ error: message, channel: 'email' });
    }
  } else {
    const sent = await sendLoginCodeEmail(req, row.email, code, row.purpose);
    if (!sent.sent) return res.status(502).json({ error: 'L’e-mail n’a pas pu être envoyé. Réessayez dans un instant.' });
  }
  setVerifyCookie(req, res, challenge, Math.floor(LOGIN_CODE_TTL_MS / 1000));
  return res.json({ ok: true, channel, resendIn: updated.rows[0].sends >= LOGIN_CODE_MAX_SENDS ? null : LOGIN_CODE_RESEND_S });
}));

app.post('/app/login/code', loginRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Base métier non configurée.');
  const code = String(req.body.code || '').replace(/\D/g, '');
  const client = await pool.connect();
  let found;
  try {
    await client.query('BEGIN');
    const lookup = await findLoginCode(client, req, { lock: true });
    found = lookup.row;
    if (!found || found.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
      if (found) await client.query('DELETE FROM login_codes WHERE token_hash = $1', [found.token_hash]);
      await client.query('COMMIT');
      setVerifyCookie(req, res, '', 0);
      return res.redirect('/app/login?error=expired');
    }
    const expected = Buffer.from(found.code_hash, 'hex');
    const actual = Buffer.from(loginCodeHash(lookup.challenge, code), 'hex');
    if (found.channel === 'pending' || code.length !== 6 || !crypto.timingSafeEqual(expected, actual)) {
      await client.query('UPDATE login_codes SET attempts = attempts + 1 WHERE token_hash = $1', [found.token_hash]);
      await client.query('COMMIT');
      return res.redirect(`/app/login/code?error=code&left=${Math.max(0, LOGIN_CODE_MAX_ATTEMPTS - 1 - found.attempts)}`);
    }
    await client.query('DELETE FROM login_codes WHERE token_hash = $1', [found.token_hash]);
    await client.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $1', [found.user_id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const status = (await pool.query(
    `SELECT c.onboarding_status, m.role FROM company_memberships m JOIN companies c ON c.id = m.company_id
     WHERE m.user_id = $1 AND m.company_id = $2`,
    [found.user_id, found.company_id]
  )).rows[0];
  if (!status) return res.redirect('/app/login?error=1');
  if (found.remember) await trustDevice(req, res, found.user_id);
  await createSession(req, res, found.user_id, found.company_id, 'company', { remember: found.remember });
  setVerifyCookie(req, res, '', 0);
  notifyNewLogin(req, found.user_id, 'code').catch(() => {});
  return res.redirect(homeAfterLogin(status.role, status.onboarding_status));
}));

function setMfaCookie(req, res, value, maxAge) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `traxo_mfa=${encodeURIComponent(value)}; Path=/app/login; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

// Secret TOTP chiffré au repos (AES-256-GCM). Clé dédiée MFA_SECRET ; la clé
// dérivée du secret des liens de suivi reste acceptée en lecture (secrets
// chiffrés avant la mise en place de MFA_SECRET).
function mfaKeys() {
  const derive = (secret) => crypto.createHash('sha256').update(`mfa-totp:v1:${secret}`).digest();
  const keys = [];
  if (process.env.MFA_SECRET && Buffer.byteLength(process.env.MFA_SECRET) >= 16) keys.push(derive(process.env.MFA_SECRET));
  const legacy = trackingTokenSecret();
  if (legacy && Buffer.byteLength(legacy) >= 16) keys.push(derive(legacy));
  if (!keys.length) {
    throw Object.assign(new Error('La double authentification n’est pas configurée sur ce serveur.'), { statusCode: 503 });
  }
  return keys;
}
function encryptMfaSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', mfaKeys()[0], iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}
function decryptMfaSecret(value) {
  const [version, iv, tag, data] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) return null;
  for (const key of mfaKeys()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    } catch { /* clé suivante */ }
  }
  return null;
}
const recoveryHash = (code) => digest(`mfa-recovery:${code}`);

// Vérifie un code d'application ou un code de secours ; consomme le code
// (anti-rejeu / usage unique). Renvoie 'totp', 'recovery' ou null.
async function consumeSecondFactor(queryable, userId, rawCode) {
  const row = (await queryable.query(
    'SELECT totp_secret, totp_last_step, totp_recovery_hashes FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  )).rows[0];
  if (!row || !row.totp_secret) return null;
  const secret = decryptMfaSecret(row.totp_secret);
  const step = totpLib.verifyTotp(secret, rawCode, { lastStep: row.totp_last_step });
  if (step != null) {
    await queryable.query('UPDATE users SET totp_last_step = $1 WHERE id = $2', [step, userId]);
    return 'totp';
  }
  const recovery = totpLib.normalizeRecoveryCode(rawCode);
  const hashes = Array.isArray(row.totp_recovery_hashes) ? row.totp_recovery_hashes : [];
  if (recovery && hashes.includes(recoveryHash(recovery))) {
    const remaining = hashes.filter((hash) => hash !== recoveryHash(recovery));
    await queryable.query('UPDATE users SET totp_recovery_hashes = $1::jsonb WHERE id = $2', [JSON.stringify(remaining), userId]);
    return 'recovery';
  }
  return null;
}

app.post('/app/login/2fa', loginRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Base métier non configurée.');
  const challenge = String(parseCookies(req).traxo_mfa || '');
  if (!challenge) return res.redirect('/app/login?error=expired');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = (await client.query(
      'SELECT * FROM mfa_challenges WHERE token_hash = $1 AND expires_at > NOW() FOR UPDATE',
      [digest(challenge)]
    )).rows[0];
    if (!found || found.attempts >= 5) {
      if (found) await client.query('DELETE FROM mfa_challenges WHERE token_hash = $1', [found.token_hash]);
      await client.query('COMMIT');
      setMfaCookie(req, res, '', 0);
      return res.redirect('/app/login?error=expired');
    }
    const method = await consumeSecondFactor(client, found.user_id, req.body.code);
    if (!method) {
      await client.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [found.token_hash]);
      await client.query('COMMIT');
      return res.redirect(`/app/login/2fa?error=code&left=${Math.max(0, 4 - found.attempts)}`);
    }
    await client.query('DELETE FROM mfa_challenges WHERE token_hash = $1', [found.token_hash]);
    await client.query('COMMIT');
    const status = (await pool.query('SELECT onboarding_status FROM companies WHERE id = $1', [found.company_id])).rows[0];
    if (found.remember) await trustDevice(req, res, found.user_id);
    await createSession(req, res, found.user_id, found.company_id, 'company', { remember: found.remember });
    setMfaCookie(req, res, '', 0);
    notifyNewLogin(req, found.user_id, 'totp').catch(() => {});
    return res.redirect(homeAfterLogin(found.role, status && status.onboarding_status));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

// Crée l'entreprise (en aperçu, configuration guidée à faire) et son
// propriétaire. Utilisé par l'inscription e-mail et par Google.
async function createOwnerAccount(client, { email, displayName, phone = null, companyName = null, password = null, googleSub = null, emailVerified = false }) {
  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) throw Object.assign(new Error('email_taken'), { code: 'email_taken' });
  const name = companyName || 'Mon entreprise';
  let slug = slugifyCompany(name);
  const slugTaken = await client.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
  if (slugTaken.rows[0]) slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  const company = await client.query(
    `INSERT INTO companies (name, slug, activation_status, onboarding_status, admin_email)
     VALUES ($1, $2, 'preview', 'pending', $3) RETURNING id`,
    [name, slug, email]
  );
  const companyId = company.rows[0].id;
  const salt = crypto.randomBytes(16).toString('hex');
  // Compte Google sans mot de passe : empreinte d'un secret aléatoire jamais
  // communiqué (« Mot de passe oublié » permet d'en définir un plus tard).
  const secret = password || randomToken(32);
  const createdUser = await client.query(
    `INSERT INTO users (email, display_name, phone, password_salt, password_hash, google_sub, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, ${emailVerified ? 'NOW()' : 'NULL'}) RETURNING id`,
    [email, displayName, phone, salt, hashPassword(secret, salt), googleSub]
  );
  const userId = createdUser.rows[0].id;
  await client.query(`INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [companyId, userId]);
  await client.query(
    `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
     VALUES ($1, $2, 'company', $3, 'company_registered', jsonb_build_object('activation_status', 'preview', 'method', $4::text))`,
    [companyId, userId, companyId, googleSub ? 'google' : 'email']
  );
  return { userId, companyId };
}

// Inscription courte (e-mail + mot de passe) : le nom de l'activité, la ville
// et l'équipe sont demandés ensuite, dans la configuration guidée.
app.post('/app/register', registerRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Base métier non configurée.');
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const companyName = String(body.companyName || '').trim() || null;
  const ownerName = String(body.ownerName || '').trim();
  const phone = String(body.phone || '').trim() || null;

  let fieldError = null;
  if (!email || email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fieldError = 'email';
  else if (password.length < 10 || password.length > 200) fieldError = 'password';
  else if (body.passwordConfirm != null && String(body.passwordConfirm) !== password) fieldError = 'password_mismatch';
  else if (companyName && (companyName.length < 2 || companyName.length > 120)) fieldError = 'company';
  else if (phone && (phone.length < 6 || phone.length > 30)) fieldError = 'phone';
  if (fieldError) return res.redirect(`/app/register?error=${fieldError}`);

  const client = await pool.connect();
  let account;
  try {
    await client.query('BEGIN');
    account = await createOwnerAccount(client, {
      email,
      displayName: (ownerName || email.split('@')[0]).slice(0, 120),
      phone,
      companyName,
      password,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === 'email_taken') return res.redirect('/app/register?error=email_taken');
    console.error('Registration error:', error.message);
    return res.redirect('/app/register?error=server');
  } finally {
    client.release();
  }

  // Adresse confirmée par code avant d'entrer ; sans fournisseur d'e-mail
  // configuré, la session s'ouvre directement.
  if (loginCodesEnabled()) {
    const started = await startLoginCode(req, res, {
      userId: account.userId, email, companyId: account.companyId, role: 'owner', purpose: 'signup', remember: false,
    });
    if (started) return res.redirect('/app/login/code');
    return res.redirect('/app/login?created=1&error=code_send');
  }
  await createSession(req, res, account.userId, account.companyId, 'company');
  return res.redirect('/app/bienvenue');
}));

app.get('/app/register', (_req, res) => sendShell(res, 'app-register.html'));
app.get('/app/auth/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ google: googleAuthConfigured(), supportEmail: process.env.SUPPORT_EMAIL || 'support@gettraxo.app' });
});
app.get('/confidentialite', (_req, res) => sendShell(res, 'legal-privacy.html'));
app.get('/conditions', (_req, res) => sendShell(res, 'legal-terms.html'));

// --- Connexion avec Google (OpenID Connect, flux « authorization code » + PKCE) ---
// Active seulement si GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET sont définis ;
// sinon le bouton n'est pas affiché. URI de redirection à déclarer chez
// Google : <APP_BASE_URL>/app/auth/google/callback
function googleAuthConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
function googleRedirectUri(req) {
  return `${publicBaseUrl(req)}/app/auth/google/callback`;
}
function setOauthCookie(req, res, value, maxAge) {
  res.append('Set-Cookie', `traxo_oauth=${encodeURIComponent(value)}; Path=/app/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cookieFlags(req)}`);
}
// Contenu du cookie signé (HMAC) : état anti-CSRF, nonce, vérificateur PKCE.
function oauthCookieKey() {
  return crypto.createHash('sha256').update(`google-oauth:v1:${loginCodePepper()}`).digest();
}
function sealOauth(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', oauthCookieKey()).update(data).digest('base64url');
  return `${data}.${mac}`;
}
function openOauth(value) {
  const [data, mac] = String(value || '').split('.');
  if (!data || !mac) return null;
  const expected = crypto.createHmac('sha256', oauthCookieKey()).update(data).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return payload && payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

app.get('/app/auth/google', (req, res) => {
  if (!googleAuthConfigured()) return res.redirect('/app/login?error=google_off');
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const from = req.query.from === 'register' ? 'register' : 'login';
  setOauthCookie(req, res, sealOauth({ state, nonce, verifier, from, remember: wantsRemember(req.query.remember), exp: Date.now() + 10 * 60 * 1000 }), 600);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/app/auth/google/callback', loginRateLimit, asyncRoute(async (req, res) => {
  const saved = openOauth(parseCookies(req).traxo_oauth);
  setOauthCookie(req, res, '', 0);
  const back = saved && saved.from === 'register' ? '/app/register' : '/app/login';
  if (!pool || !googleAuthConfigured()) return res.redirect(`${back}?error=google_off`);
  if (req.query.error) return res.redirect(`${back}?error=google_cancel`);
  const state = String(req.query.state || '');
  if (!saved || !state || state.length !== saved.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(saved.state))) {
    return res.redirect(`${back}?error=google`);
  }
  let claims;
  try {
    const token = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      code: String(req.query.code || ''),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(req),
      grant_type: 'authorization_code',
      code_verifier: saved.verifier,
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    // Jeton reçu directement de Google (TLS, authentification client) : on
    // contrôle émetteur, audience, expiration et nonce (OIDC Core §3.1.3.7).
    const payload = String(token.data.id_token || '').split('.')[1];
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    console.error('Google OAuth token error:', error.response?.data?.error || error.message);
    return res.redirect(`${back}?error=google`);
  }
  const email = normalizeEmail(claims.email);
  const valid = claims && GOOGLE_ISSUERS.includes(claims.iss) && claims.aud === process.env.GOOGLE_CLIENT_ID
    && Number(claims.exp) * 1000 > Date.now() && claims.nonce === saved.nonce && claims.sub && email
    && (claims.email_verified === true || claims.email_verified === 'true');
  if (!valid) return res.redirect(`${back}?error=google`);

  const sub = String(claims.sub);
  const displayName = String(claims.name || claims.given_name || email.split('@')[0]).trim().slice(0, 120);
  let user = (await pool.query(
    `SELECT u.id, u.disabled, u.google_sub, u.email_verified_at, u.totp_enabled_at, m.company_id, m.role, c.onboarding_status
     FROM users u LEFT JOIN company_memberships m ON m.user_id = u.id LEFT JOIN companies c ON c.id = m.company_id
     WHERE u.google_sub = $1 OR u.email = $2
     ORDER BY (u.google_sub = $1) DESC NULLS LAST, m.id LIMIT 1`,
    [sub, email]
  )).rows[0];
  if (user && user.disabled) return res.redirect(`${back}?error=disabled`);
  if (user && user.google_sub && user.google_sub !== sub) return res.redirect(`${back}?error=google_other`);
  if (user && !user.google_sub) {
    // Première connexion Google sur un compte existant. Si l'adresse n'avait
    // jamais été confirmée, un tiers a pu créer ce compte avec un mot de passe
    // choisi par lui : on invalide ce mot de passe et ses sessions.
    const unverified = !user.email_verified_at;
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `UPDATE users SET google_sub = $1, email_verified_at = COALESCE(email_verified_at, NOW()),
         password_salt = CASE WHEN $2 THEN $3 ELSE password_salt END,
         password_hash = CASE WHEN $2 THEN $4 ELSE password_hash END, updated_at = NOW()
       WHERE id = $5`,
      [sub, unverified, salt, hashPassword(randomToken(32), salt), user.id]
    );
    if (unverified) await pool.query('DELETE FROM app_sessions WHERE user_id = $1', [user.id]);
  }
  if (!user) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = await createOwnerAccount(client, { email, displayName, googleSub: sub, emailVerified: true });
      await client.query('COMMIT');
      user = { id: account.userId, company_id: account.companyId, role: 'owner', onboarding_status: 'pending' };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Google registration error:', error.message);
      return res.redirect(`${back}?error=server`);
    } finally {
      client.release();
    }
  }
  if (!user.company_id || !user.role) return res.redirect(`${back}?error=no_company`);
  if (user.totp_enabled_at) {
    await startTotpChallenge(req, res, { userId: user.id, companyId: user.company_id, role: user.role, remember: saved.remember });
    return res.redirect('/app/login/2fa');
  }
  if (saved.remember) await trustDevice(req, res, user.id);
  await createSession(req, res, user.id, user.company_id, 'company', { remember: saved.remember });
  notifyNewLogin(req, user.id, 'google').catch(() => {});
  return res.redirect(homeAfterLogin(user.role, user.onboarding_status));
}));

// --- WhatsApp TRAXO : liaison du numéro (administrateur plateforme uniquement) ---
function requirePlatformAdminApi(req, res, next) {
  return readSession(req, 'company').then((session) => {
    if (!session) return res.status(401).json({ error: 'Session requise.' });
    if (!session.is_platform_admin) return res.status(403).json({ error: 'Réservé à l’administrateur de la plateforme TRAXO.' });
    req.auth = session;
    return next();
  }).catch(next);
}
app.get('/api/app/whatsapp', requirePlatformAdminApi, (_req, res) => res.json(whatsapp.snapshot()));
app.post('/api/app/whatsapp/link', requirePlatformAdminApi, asyncRoute(async (req, res) => {
  const method = req.body && req.body.method === 'code' ? 'code' : 'qr';
  let phone = null;
  if (method === 'code') {
    phone = internationalDigits(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Indiquez le numéro avec son indicatif, par exemple +229 01 40 05 67 66.' });
  }
  if (whatsapp.isReady()) return res.status(409).json({ error: 'Un numéro est déjà relié. Déliez-le d’abord.' });
  await whatsapp.logout().catch(() => {});
  await whatsapp.connect({ phone });
  await writeAudit(req.auth, 'platform', null, 'whatsapp_link_started', { method });
  return res.json(whatsapp.snapshot());
}));
app.post('/api/app/whatsapp/cancel', requirePlatformAdminApi, asyncRoute(async (_req, res) => {
  if (!whatsapp.isReady()) await whatsapp.logout().catch(() => {});
  return res.json(whatsapp.snapshot());
}));
app.post('/api/app/whatsapp/logout', requirePlatformAdminApi, asyncRoute(async (req, res) => {
  await whatsapp.logout();
  await writeAudit(req.auth, 'platform', null, 'whatsapp_unlinked', {});
  return res.json(whatsapp.snapshot());
}));
app.post('/api/app/whatsapp/test', requirePlatformAdminApi, asyncRoute(async (req, res) => {
  const phone = String(req.body && req.body.phone || '').trim();
  try {
    await whatsapp.sendText(phone, 'Message de test TRAXO : le canal WhatsApp fonctionne.');
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  return res.json({ ok: true, ...whatsapp.snapshot() });
}));

// --- Configuration guidée (après inscription) ---
const ONBOARDING_CATEGORIES = ['restaurant', 'commerce', 'vente-en-ligne', 'livraison', 'autre'];
const ONBOARDING_FLEET = ['Pas encore', '1', '2–5', '6–12', '13 et plus'];
const COUNTRY_TIMEZONES = {
  'Bénin': 'Africa/Porto-Novo', 'Côte d’Ivoire': 'Africa/Abidjan', 'Togo': 'Africa/Lome', 'Sénégal': 'Africa/Dakar',
  'Burkina Faso': 'Africa/Ouagadougou', 'Cameroun': 'Africa/Douala', 'Mali': 'Africa/Bamako', 'Niger': 'Africa/Niamey',
  'Ghana': 'Africa/Accra', 'Nigeria': 'Africa/Lagos', 'République démocratique du Congo': 'Africa/Kinshasa', 'France': 'Europe/Paris',
};
function onboardingSession(req, res, api) {
  return readSession(req, 'company').then((session) => {
    if (!session) {
      if (api) res.status(401).json({ error: 'Votre session a expiré. Reconnectez-vous.' });
      else res.redirect('/app/login');
      return null;
    }
    if (session.role !== 'owner' || session.onboarding_status !== 'pending') {
      if (api) res.status(409).json({ error: 'La configuration de ce compte est déjà terminée.', redirect: homeAfterLogin(session.role, 'done') });
      else res.redirect(homeAfterLogin(session.role, 'done'));
      return null;
    }
    return session;
  });
}
app.get('/app/bienvenue', asyncRoute(async (req, res) => {
  const session = await onboardingSession(req, res, false);
  if (session) return sendShell(res, 'onboarding.html');
}));
app.get('/api/onboarding', asyncRoute(async (req, res) => {
  const session = await onboardingSession(req, res, true);
  if (!session) return;
  const row = (await pool.query(
    `SELECT u.display_name, u.phone, u.email, c.name, c.country, c.city
     FROM users u JOIN companies c ON c.id = $2 WHERE u.id = $1`,
    [session.user_id, session.company_id]
  )).rows[0] || {};
  const emailLocal = String(row.email || '').split('@')[0];
  return res.json({
    name: row.display_name && row.display_name !== emailLocal ? row.display_name : '',
    business: row.name && row.name !== 'Mon entreprise' ? row.name : '',
    country: row.country || '',
    city: row.city || '',
    phone: row.phone || '',
  });
}));
app.post('/api/onboarding', asyncRoute(async (req, res) => {
  const session = await onboardingSession(req, res, true);
  if (!session) return;
  const body = req.body || {};
  const text = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const business = text(body.business, 70);
  const category = text(body.category, 30);
  const country = text(body.country, 60);
  const city = text(body.city, 70);
  const name = text(body.name, 80);
  const prefix = text(body.prefix, 5);
  const phoneRaw = text(body.phone, 30);
  const fleet = text(body.fleet, 20);
  if (business.length < 2) return res.status(400).json({ error: 'Il nous manque le nom de votre activité.', field: 'business' });
  if (!ONBOARDING_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Choisissez l’activité qui vous correspond le mieux.', field: 'category' });
  if (!country) return res.status(400).json({ error: 'Choisissez le pays où vous travaillez.', field: 'country' });
  if (!city) return res.status(400).json({ error: 'Indiquez votre ville principale.', field: 'city' });
  if (name.length < 2) return res.status(400).json({ error: 'Indiquez votre prénom et votre nom.', field: 'name' });
  let phone = null;
  if (phoneRaw) {
    const digits = phoneRaw.replace(/\D/g, '');
    if (!/^\+[1-9]\d{0,3}$/.test(prefix) || digits.length < 6 || digits.length > 15 || !/^[\d\s().-]+$/.test(phoneRaw)) {
      return res.status(400).json({ error: 'Ce numéro semble incomplet. Vérifiez aussi l’indicatif.', field: 'phone' });
    }
    phone = `${prefix} ${phoneRaw}`;
  }
  if (!ONBOARDING_FLEET.includes(fleet)) return res.status(400).json({ error: 'Choisissez une estimation, même si vous n’avez pas encore de livreur.', field: 'fleet' });
  let logo = null;
  if (body.logo) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.logo));
    const buffer = match ? Buffer.from(match[2], 'base64') : null;
    if (!match || buffer.length < 64 || buffer.length > 600 * 1024 || detectImageMime(buffer) !== match[1]) {
      return res.status(400).json({ error: 'Ce logo n’a pas pu être enregistré. Choisissez une image PNG, JPG ou WebP de moins de 2 Mo.', field: 'logo' });
    }
    logo = { buffer, mime: match[1] };
  }
  const timezone = COUNTRY_TIMEZONES[country];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT slug FROM companies WHERE id = $1 FOR UPDATE', [session.company_id])).rows[0];
    let slug = current && current.slug;
    // L'identifiant provisoire (« mon-entreprise… ») prend le nom de l'activité.
    if (!slug || slug.startsWith('mon-entreprise')) {
      slug = slugifyCompany(business);
      const taken = await client.query('SELECT 1 FROM companies WHERE slug = $1 AND id <> $2', [slug, session.company_id]);
      if (taken.rows[0]) slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    }
    await client.query(
      `UPDATE companies SET name = $1, slug = $2, business_type = $3, country = $4, city = $5, fleet_estimate = $6,
         timezone = COALESCE($7, timezone), onboarding_status = 'done', onboarding_completed_at = NOW(), updated_at = NOW()
       WHERE id = $8`,
      [business, slug, category, country, city, fleet, timezone && companyTimezones.includes(timezone) ? timezone : null, session.company_id]
    );
    if (logo) {
      await client.query(
        'UPDATE companies SET logo_data = $1, logo_mime = $2, logo_updated_at = NOW() WHERE id = $3',
        [logo.buffer, logo.mime, session.company_id]
      );
    }
    await client.query(
      'UPDATE users SET display_name = $1, phone = COALESCE($2, phone), updated_at = NOW() WHERE id = $3',
      [name, phone, session.user_id]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'company', $1, 'onboarding_completed', jsonb_build_object('business_type', $3::text, 'country', $4::text, 'fleet', $5::text))`,
      [session.company_id, session.user_id, category, country, fleet]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Onboarding error:', error.message);
    return res.status(500).json({ error: 'Vos informations n’ont pas pu être enregistrées. Réessayez dans un instant.' });
  } finally {
    client.release();
  }
  return res.json({ ok: true, redirect: '/app' });
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
  if (password.length < 10 || password.length > 200) return back('password');

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
      'UPDATE users SET password_salt = $1, password_hash = $2, password_changed_at = NOW(), email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = $3',
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
  '/app/livreurs', '/app/tournees', '/app/incidents', '/app/equipe', '/app/clients', '/app/rapports', '/app/parametres', '/app/notifications',
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
  res.set(PUBLIC_REQUEST_PAGE_HEADERS);
  if (request.status === PREFILLED_REQUEST_STATUS) return sendShell(res, 'confirm.html');
  if (request.status !== 'En attente d’informations') {
    return res.redirect(`/demande/${encodeURIComponent(req.params.token)}/confirmation`);
  }
  return sendShell(res, 'request.html');
}));

app.get('/demande/:token/confirmation', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Service momentanément indisponible.');
  const result = await pool.query('SELECT id FROM customer_requests WHERE token = $1', [req.params.token]);
  if (!result.rows[0]) return res.status(404).send('Cette demande est introuvable.');
  res.set(PUBLIC_REQUEST_PAGE_HEADERS);
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
  if (password.length < 10 || password.length > 128 || password.trim().length < 10) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 10 caractères.' });
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
  const notifyByEmail = req.body.notify === 'email';
  if (!/^\S+@\S+\.\S+$/.test(email) || displayName.length < 2 || displayName.length > 100 || !invitationRoles.includes(role)) {
    return res.status(400).json({ error: 'Vérifiez le nom, l’adresse e-mail et le rôle de la personne invitée.' });
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
    const baseUrl = publicBaseUrl(req);
    const inviteUrl = `${baseUrl}/invitation/${token}`;
    let emailed = false;
    if (notifyByEmail) {
      try {
        const companyRow = await pool.query('SELECT name FROM companies WHERE id = $1', [req.auth.company_id]);
        const companyName = companyRow.rows[0]?.name || 'votre équipe';
        const roleLabelsServer = { manager: 'Manager', operator: 'Opérateur', driver: 'Livreur' };
        const html = renderEmailShell({
          baseUrl,
          heading: `Vous êtes invité·e à rejoindre ${companyName} sur TRAXO`,
          introHtml: `Bonjour ${escHtmlServer(displayName)}, vous avez été invité·e comme <strong>${escHtmlServer(roleLabelsServer[role] || role)}</strong>.`,
          bodyHtml: '<p style="margin:0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#475467">Cliquez sur le bouton ci-dessous pour créer votre accès. Le lien est valable 48 heures et à usage unique.</p>',
          ctaLabel: 'Créer mon accès',
          ctaUrl: inviteUrl,
          footerNote: 'Si vous n’attendiez pas cette invitation, ignorez cet e-mail.',
        });
        const result = await sendEmail({
          to: email,
          subject: `Invitation à rejoindre ${companyName} sur TRAXO`,
          html,
          text: `Bonjour ${displayName}, créez votre accès TRAXO : ${inviteUrl} (valable 48 h).`,
        });
        emailed = Boolean(result && result.sent);
      } catch (mailError) {
        console.error('Invite email failed:', mailError.message);
      }
    }
    return res.status(201).json({ id: invitation.rows[0].id, path: `/invitation/${token}`, url: inviteUrl, expiresAt: invitation.rows[0].expires_at, emailed });
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
  user: { id: req.auth.user_id, email: req.auth.email, name: req.auth.display_name, role: req.auth.role, isPlatformAdmin: Boolean(req.auth.is_platform_admin) },
  company: { id: req.auth.company_id, name: req.auth.company_name, slug: req.auth.company_slug, activationStatus: req.auth.activation_status || 'active', logoUrl: companyLogoUrl(req.auth.company_id, req.auth.company_logo_at) },
  supportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(process.env.SUPPORT_EMAIL || '')) ? process.env.SUPPORT_EMAIL : null,
  // Domaine canonique des liens partagés aux clients (APP_BASE_URL), quel que
  // soit le domaine par lequel l'entreprise consulte l'application.
  publicBaseUrl: publicBaseUrl(req),
}));

app.get('/api/driver/context', requireDriverApi, asyncRoute(async (req, res) => {
  const driver = await pool.query(
    `SELECT id, name, phone, vehicle_type, availability_status, active
     FROM drivers WHERE id = $1 AND company_id = $2`,
    [req.auth.driver_id, req.auth.company_id]
  );
  if (!driver.rows[0] || !driver.rows[0].active) return res.status(403).json({ error: 'Ce profil livreur est désactivé.' });
  return res.json({
    user: { id: req.auth.user_id, email: req.auth.email, name: req.auth.display_name, role: req.auth.role, isPlatformAdmin: Boolean(req.auth.is_platform_admin) },
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
  if (req.auth.driver_can_contact === false) result.rows.forEach((row) => { row.customer_phone = null; });
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
  // Sans la permission « contacter le destinataire », le numéro du client ne part pas vers l'appli.
  if (req.auth.driver_can_contact === false) order.customer_phone = null;
  return res.json({
    ...order,
    canContact: req.auth.driver_can_contact !== false,
    canReportIncident: req.auth.driver_can_report !== false,
    allowedTransitions: allowedOrderTransitions(order.status, order).filter((status) => driverTransitionTargets.includes(status)),
    isTerminal: terminalOrderStatuses.includes(order.status),
    incidents: incidents.rows,
    evidence: evidence.rows,
    run: runContext.rows[0] || null,
  });
}));

// Position actuelle d'un livreur d'après Traccar (null si indisponible ou trop ancienne).
async function driverCurrentPosition(driverId, companyId, maxAgeMs = 10 * 60 * 1000) {
  if (!traccarConfigured()) return null;
  const row = (await pool.query('SELECT traccar_unique_id FROM drivers WHERE id = $1 AND company_id = $2', [driverId, companyId])).rows[0];
  if (!row) return null;
  const snap = await loadTraccarFleetSnapshot();
  if (snap.status !== 'online') return null;
  const device = snap.devices.find((d) => String(d.uniqueId) === String(row.traccar_unique_id));
  const position = device && snap.positions.find((p) => String(p.deviceId) === String(device.id));
  const lat = Number(position?.latitude);
  const lng = Number(position?.longitude);
  const at = position && (position.fixTime || position.deviceTime || position.serverTime);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !at || Date.now() - new Date(at).getTime() > maxAgeMs) return null;
  return { lat, lng, at };
}
async function rememberPickupPosition(orderId, auth) {
  const position = await driverCurrentPosition(auth.driver_id, auth.company_id);
  if (!position) return;
  await pool.query(
    'UPDATE orders SET picked_up_lat = $3, picked_up_lng = $4 WHERE id = $1 AND company_id = $2 AND picked_up_lat IS NULL',
    [orderId, auth.company_id, position.lat, position.lng]
  );
}

app.post('/api/driver/orders/:id/transition', requireDriverApi, asyncRoute(async (req, res) => {
  const toStatus = String(req.body.toStatus || '').trim();
  const reason = String(req.body.reason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
  if (!driverTransitionTargets.includes(toStatus)) return res.status(403).json({ error: 'Cette étape doit être gérée par l’exploitation.' });
  if (reasonRequiredStatuses.includes(toStatus) && reason.length < 5) {
    return res.status(400).json({ error: 'Expliquez la raison en au moins 5 caractères.' });
  }
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), toStatus, reason }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status, version, pickup_name, pickup_address, pickup_lat FROM orders
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
    if (!allowedOrderTransitions(order.status, order).includes(toStatus)) {
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
    // Première collecte à un lieu sans position : on retient l'endroit où le
    // livreur a récupéré le colis (servira aux prochaines commandes).
    if (toStatus === 'Récupérée' && (order.pickup_address || order.pickup_name) && order.pickup_lat == null) {
      rememberPickupPosition(order.id, req.auth).catch(() => {});
    }
    if (['En livraison', 'Arrivée'].includes(toStatus)) recordEtaSample(order.id, req.auth.company_id, toStatus, req.auth.driver_id);
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
    return res.status(400).json({ error: 'Choisissez le type d’incident et sa gravité.' });
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
  if (req.auth.driver_can_report === false) return res.status(403).json({ error: 'Votre entreprise gère les incidents depuis le bureau. Appelez votre responsable.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
    `SELECT c.id, c.name, c.slug, c.admin_email, c.timezone, c.created_at, c.logo_updated_at,
            (SELECT u.display_name FROM company_memberships m JOIN users u ON u.id = m.user_id
             WHERE m.company_id = c.id AND m.role = 'owner' ORDER BY m.id LIMIT 1) AS owner_name,
            (SELECT COUNT(*)::int FROM drivers d WHERE d.company_id = c.id AND d.active = TRUE AND d.archived_at IS NULL) AS active_drivers,
            (SELECT COUNT(*)::int FROM driver_seat_usage u WHERE u.company_id = c.id
               AND u.month = date_trunc('month', NOW() AT TIME ZONE 'Africa/Porto-Novo')::date) AS seats_month
     FROM companies c WHERE c.id = $1`,
    [req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Entreprise introuvable.' });
  const { logo_updated_at: logoAt, ...company } = result.rows[0];
  return res.json({ ...company, logoUrl: companyLogoUrl(company.id, logoAt), timezones: companyTimezones });
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
  if (adminEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) return res.status(400).json({ error: 'Cette adresse e-mail semble incorrecte.' });
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
const deliverySettingKeys = ['validateBeforeTracking', 'driverAssignmentRequired', 'allowEditAfterValidation', 'customerFormEnabled', 'internalEntryEnabled', 'manualValidation', 'showFullRoute'];
const defaultDeliverySettings = {
  validateBeforeTracking: true, driverAssignmentRequired: false, allowEditAfterValidation: false,
  customerFormEnabled: true, internalEntryEnabled: true, manualValidation: true,
  // Le client voit tout le trajet du livreur (collecte, autres arrêts) : au choix de l'entreprise.
  showFullRoute: false,
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
  const current = (await pool.query('SELECT delivery_settings FROM companies WHERE id = $1', [req.auth.company_id])).rows[0];
  const merged = normalizeDeliverySettings(current && current.delivery_settings);
  for (const key of deliverySettingKeys) {
    if (key in (req.body || {}) && typeof req.body[key] !== 'boolean') return res.status(400).json({ error: 'Réglage invalide.', field: key });
    if (typeof req.body[key] === 'boolean') merged[key] = req.body[key];
  }
  if (!merged.customerFormEnabled && !merged.internalEntryEnabled) {
    return res.status(400).json({ error: 'Gardez au moins une façon de créer une livraison : le lien client ou la saisie par votre équipe.' });
  }
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
  { code: 'equipe', name: 'Équipe', microcopy: 'Un forfait pour toute votre équipe.', kind: 'flat', monthly: 10000, max: 12, capacityLabel: 'Jusqu’à 12 livreurs', features: ['Jusqu’à 12 livreurs', 'Fonctionnalités essentielles', 'Suivi de flotte avancé', 'Meilleur rapport capacité-prix', 'Support prioritaire'] },
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
            (SELECT COUNT(*)::int FROM drivers d WHERE d.company_id = c.id AND d.active = TRUE AND d.archived_at IS NULL) AS active_drivers,
            (SELECT COUNT(*)::int FROM driver_seat_usage u WHERE u.company_id = c.id
               AND u.month = date_trunc('month', NOW() AT TIME ZONE 'Africa/Porto-Novo')::date) AS seats_month
     FROM companies c WHERE c.id = $1`,
    [req.auth.company_id]
  );
  const row = result.rows[0] || {};
  const activeDrivers = Number(row.active_drivers || 0);
  // Places : personnes différentes ayant travaillé dans le mois (supprimer puis
  // recréer des profils ne libère pas de place avant le mois suivant).
  const seatsThisMonth = Math.max(activeDrivers, Number(row.seats_month || 0));
  const recommended = recommendPlanCode(seatsThisMonth);
  return res.json({
    activeDrivers,
    seatsThisMonth,
    recommended,
    currentPlan: row.plan_code || recommended,
    billingCycle: row.billing_cycle || 'monthly',
    discounts: billingCycleDiscounts,
    plans: billingPlans.map((p) => ({ ...p, max: p.max === null ? null : p.max })),
  });
}));

// Calcul officiel d'une formule : équivalent mensuel et total de la période.
const billingCycleMonths = { monthly: 1, quarterly: 3, yearly: 12 };
function billingQuote(planCode, cycle, drivers) {
  const plan = billingPlans.find((p) => p.code === planCode);
  if (!plan || !billingCycleMonths[cycle] || plan.kind === 'trial' || plan.kind === 'custom') return null;
  const count = Math.max(1, Math.min(500, Math.round(Number(drivers) || 1)));
  const base = plan.kind === 'per_driver' ? plan.monthly * count : plan.monthly;
  const monthly = Math.round(base * (1 - (billingCycleDiscounts[cycle] || 0)));
  return {
    planCode, planName: plan.name, cycle, drivers: count, capacity: plan.max,
    fits: plan.max == null || count <= plan.max,
    monthlyBase: base, monthlyEquivalent: monthly, periodMonths: billingCycleMonths[cycle],
    periodTotal: monthly * billingCycleMonths[cycle], discount: billingCycleDiscounts[cycle] || 0, currency: 'XOF',
  };
}
app.get('/api/app/billing/quote', requireCompanyApi, asyncRoute(async (req, res) => {
  const quote = billingQuote(String(req.query.plan || ''), String(req.query.cycle || 'monthly'), req.query.drivers);
  if (!quote) return res.status(400).json({ error: 'Formule ou périodicité inconnue.' });
  return res.json(quote);
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
    `SELECT (SELECT COUNT(*)::int FROM drivers WHERE company_id = $1 AND active = TRUE AND archived_at IS NULL) AS n,
            (SELECT COUNT(*)::int FROM driver_seat_usage WHERE company_id = $1
               AND month = date_trunc('month', NOW() AT TIME ZONE 'Africa/Porto-Novo')::date) AS seats`,
    [req.auth.company_id]
  );
  const activeDrivers = drivers.rows[0].n;
  // Les places du mois comptent les personnes différentes qui ont livré, même
  // retirées depuis : retirer des profils ne permet pas de passer sous la limite.
  const seats = Math.max(activeDrivers, drivers.rows[0].seats);
  if (seats > planCapacity(planCode)) {
    return res.status(409).json({
      error: activeDrivers >= seats
        ? `Cette formule accepte moins de livreurs que vos ${activeDrivers} livreurs actifs. Retirez des livreurs ou choisissez une formule supérieure.`
        : `Ce mois-ci, ${seats} personnes différentes ont travaillé pour vous : cette formule n’en couvre pas autant. Vous pourrez la choisir à partir du mois prochain.`,
    });
  }
  await pool.query('UPDATE companies SET plan_code = $1, billing_cycle = $2, updated_at = NOW() WHERE id = $3', [planCode, billingCycle, req.auth.company_id]);
  await writeAudit(req.auth, 'company', req.auth.company_id, 'plan_changed', { planCode, billingCycle });
  return res.json({ planCode, billingCycle });
}));

// Demande de devis « Grande flotte » : envoyée par e-mail à l'équipe TRAXO
// (SUPPORT_EMAIL, à défaut le premier administrateur plateforme).
app.post('/api/app/billing/quote-request', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const drivers = Math.round(Number(req.body.drivers));
  const message = String(req.body.message || '').trim().slice(0, 1000);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Indiquez une adresse e-mail valide pour vous répondre.' });
  if (!Number.isInteger(drivers) || drivers < 1 || drivers > 100000) return res.status(400).json({ error: 'Indiquez le nombre de livreurs de votre flotte.' });
  const support = String(process.env.SUPPORT_EMAIL || '').trim();
  const recipient = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support)
    ? support
    : String(process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map(normalizeEmail).find(Boolean);
  if (!recipient) return res.status(503).json({ error: 'Les demandes de devis ne sont pas encore ouvertes. Réessayez plus tard.' });
  const recent = await pool.query(
    `SELECT COUNT(*)::int AS n FROM audit_logs
     WHERE company_id = $1 AND action = 'quote_requested' AND created_at > NOW() - INTERVAL '1 hour'`,
    [req.auth.company_id]
  );
  if (recent.rows[0].n >= 3) return res.status(429).json({ error: 'Votre demande a bien été reçue. Patientez avant d’en envoyer une nouvelle.' });
  const company = (await pool.query('SELECT name, slug FROM companies WHERE id = $1', [req.auth.company_id])).rows[0] || {};
  const lines = [
    `Entreprise : ${company.name || '—'} (espace #${req.auth.company_id}, ${company.slug || '—'})`,
    `Demandé par : ${req.auth.display_name || req.auth.email} <${req.auth.email}>`,
    `E-mail de réponse : ${email}`,
    `Livreurs : ${drivers}`,
    `Besoin : ${message || '—'}`,
  ];
  const result = await sendEmail({
    to: recipient,
    subject: `Devis Grande flotte — ${company.name || `espace #${req.auth.company_id}`} (${drivers} livreurs)`,
    html: renderEmailShell({
      baseUrl: publicBaseUrl(req),
      heading: 'Nouvelle demande de devis Grande flotte',
      introHtml: lines.map((l) => escHtmlServer(l)).join('<br>'),
      bodyHtml: '',
      footerNote: 'Répondez directement à l’adresse indiquée par le client.',
    }),
    text: lines.join('\n'),
  });
  if (!result || !result.sent) return res.status(502).json({ error: 'La demande n’a pas pu être envoyée. Réessayez dans quelques minutes.' });
  await writeAudit(req.auth, 'company', req.auth.company_id, 'quote_requested', { drivers });
  return res.status(201).json({ sent: true });
}));

// --- Paramètres > Sécurité : compte utilisateur ---
app.get('/api/app/account/security', requireCompanyApi, asyncRoute(async (req, res) => {
  const [user, sessions] = await Promise.all([
    pool.query('SELECT password_changed_at, login_alerts, totp_enabled_at, totp_recovery_hashes, phone, google_sub FROM users WHERE id = $1', [req.auth.user_id]),
    pool.query('SELECT COUNT(*)::int AS n FROM app_sessions WHERE user_id = $1 AND expires_at > NOW()', [req.auth.user_id]),
  ]);
  const row = user.rows[0] || {};
  return res.json({
    passwordChangedAt: row.password_changed_at || null,
    loginAlerts: row.login_alerts !== false,
    activeSessions: sessions.rows[0].n,
    twoFactorEnabled: !!row.totp_enabled_at,
    twoFactorEnabledAt: row.totp_enabled_at || null,
    recoveryCodesLeft: Array.isArray(row.totp_recovery_hashes) ? row.totp_recovery_hashes.length : 0,
    phone: row.phone || '',
    phoneInternational: Boolean(internationalDigits(row.phone)),
    googleLinked: Boolean(row.google_sub),
    whatsappChannel: whatsapp.isReady(),
    loginCodes: loginCodesEnabled(),
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

// --- Double authentification (application d'authentification) ---
async function issueRecoveryCodes(queryable, userId) {
  const codes = totpLib.generateRecoveryCodes();
  await queryable.query('UPDATE users SET totp_recovery_hashes = $1::jsonb WHERE id = $2', [JSON.stringify(codes.map(recoveryHash)), userId]);
  return codes;
}

app.post('/api/app/account/2fa/setup', requireCompanyApi, asyncRoute(async (req, res) => {
  const user = (await pool.query('SELECT email, totp_enabled_at FROM users WHERE id = $1', [req.auth.user_id])).rows[0];
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  if (user.totp_enabled_at) return res.status(409).json({ error: 'La double authentification est déjà activée.' });
  const secret = totpLib.generateSecret();
  await pool.query('UPDATE users SET totp_pending_secret = $1 WHERE id = $2', [encryptMfaSecret(secret), req.auth.user_id]);
  const url = totpLib.otpauthUrl({ secret, account: user.email, issuer: 'TRAXO' });
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0c0d10', light: '#ffffff' } });
  return res.json({ secret: secret.match(/.{1,4}/g).join(' '), otpauthUrl: url, qrSvg });
}));

app.post('/api/app/account/2fa/enable', requireCompanyApi, asyncRoute(async (req, res) => {
  const row = (await pool.query('SELECT totp_pending_secret, totp_enabled_at FROM users WHERE id = $1', [req.auth.user_id])).rows[0];
  if (!row || !row.totp_pending_secret) return res.status(400).json({ error: 'Relancez la configuration : aucun QR code en attente.' });
  if (row.totp_enabled_at) return res.status(409).json({ error: 'La double authentification est déjà activée.' });
  const secret = decryptMfaSecret(row.totp_pending_secret);
  const step = totpLib.verifyTotp(secret, req.body.code);
  if (step == null) return res.status(400).json({ error: 'Code incorrect. Vérifiez l’heure du téléphone et saisissez le code affiché.' });
  await pool.query(
    `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = NOW(), totp_last_step = $1 WHERE id = $2`,
    [step, req.auth.user_id]
  );
  const codes = await issueRecoveryCodes(pool, req.auth.user_id);
  await writeAudit(req.auth, 'user', req.auth.user_id, 'mfa_enabled', {});
  return res.json({ enabled: true, recoveryCodes: codes });
}));

app.post('/api/app/account/2fa/disable', requireCompanyApi, asyncRoute(async (req, res) => {
  const user = (await pool.query('SELECT password_salt, password_hash, totp_enabled_at FROM users WHERE id = $1', [req.auth.user_id])).rows[0];
  if (!user || !user.totp_enabled_at) return res.status(400).json({ error: 'La double authentification n’est pas activée.' });
  if (!passwordMatches(String(req.body.password || ''), user.password_salt, user.password_hash)) return res.status(400).json({ error: 'Mot de passe incorrect.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const method = await consumeSecondFactor(client, req.auth.user_id, req.body.code);
    if (!method) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Code incorrect.' }); }
    await client.query(
      `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_recovery_hashes = '[]'::jsonb WHERE id = $1`,
      [req.auth.user_id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await writeAudit(req.auth, 'user', req.auth.user_id, 'mfa_disabled', {});
  return res.json({ enabled: false });
}));

app.post('/api/app/account/2fa/recovery-codes', requireCompanyApi, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const method = await consumeSecondFactor(client, req.auth.user_id, req.body.code);
    if (!method) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Code incorrect.' }); }
    const codes = await issueRecoveryCodes(client, req.auth.user_id);
    await client.query('COMMIT');
    await writeAudit(req.auth, 'user', req.auth.user_id, 'mfa_recovery_regenerated', {});
    return res.json({ recoveryCodes: codes });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

// Numéro de l'utilisateur (codes de connexion par WhatsApp) : format international obligatoire.
app.patch('/api/app/account/phone', requireCompanyApi, asyncRoute(async (req, res) => {
  const raw = String(req.body.phone || '').trim();
  if (raw && !internationalDigits(raw)) {
    return res.status(400).json({ error: 'Indiquez le numéro avec son indicatif, par exemple +229 01 97 12 34 56.' });
  }
  const phone = raw ? `+${internationalDigits(raw)}` : null;
  await pool.query('UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2', [phone, req.auth.user_id]);
  await writeAudit(req.auth, 'user', req.auth.user_id, 'phone_changed', {});
  return res.json({ phone: phone || '', phoneInternational: Boolean(phone) });
}));

// Ferme une session (autre appareil) ou toutes les autres sessions.
app.post('/api/app/account/sessions/revoke', requireCompanyApi, asyncRoute(async (req, res) => {
  const currentHash = digest(String(parseCookies(req).delivery_session || ''));
  const target = String(req.body.id || '');
  let result;
  if (target === 'others') {
    result = await pool.query('DELETE FROM app_sessions WHERE user_id = $1 AND token_hash <> $2', [req.auth.user_id, currentHash]);
    await pool.query('DELETE FROM trusted_devices WHERE user_id = $1', [req.auth.user_id]);
  } else if (/^[0-9a-f]{12}$/.test(target)) {
    if (currentHash.startsWith(target)) return res.status(400).json({ error: 'Pour fermer cette session, utilisez « Se déconnecter ».' });
    result = await pool.query('DELETE FROM app_sessions WHERE user_id = $1 AND left(token_hash, 12) = $2 AND token_hash <> $3', [req.auth.user_id, target, currentHash]);
  } else {
    return res.status(400).json({ error: 'Session inconnue.' });
  }
  await writeAudit(req.auth, 'user', req.auth.user_id, 'sessions_revoked', { scope: target === 'others' ? 'others' : 'one', count: result.rowCount });
  return res.json({ closed: result.rowCount });
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
  // Tests locaux uniquement : les e-mails sont écrits dans un dossier au lieu
  // d'être envoyés (jamais en production).
  const outbox = process.env.EMAIL_OUTBOX_DIR;
  if (outbox && process.env.NODE_ENV !== 'production' && process.env.RAILWAY_ENVIRONMENT_NAME !== 'production') {
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`), JSON.stringify({ from, to, subject, html, text }));
    return { sent: true, via: 'outbox' };
  }
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
// ---- Notifications ----------------------------------------------------------
// Les notifications sont calculées à partir de l'état métier (demandes, incidents,
// commandes, tournées) : elles disparaissent quand l'élément est traité. L'état
// lu / archivé / « plus tard » est propre à chaque utilisateur (notification_states)
// et ne change jamais l'état métier.
const NOTIFICATION_CATEGORIES = ['incidents', 'requests', 'deliveries', 'runs', 'clients'];
const notificationIncidentLabels = {
  client_injoignable: 'Client injoignable', adresse: 'Adresse à préciser', colis: 'Colis endommagé ou manquant',
  paiement: 'Problème de paiement', vehicule: 'Problème de véhicule', gps: 'GPS ou connexion', autre: 'Incident signalé',
};
const notifKeyPattern = /^[a-z]+-[0-9a-f-]{1,40}$/;

function frDateShort(value, timeZone = DASHBOARD_TZ) {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone }).format(new Date(value));
}

async function buildNotificationItems(cid, { currentSessionHash = null, userId = null } = {}) {
  const [reqs, toAssign, unassigned, incidents, runs, relaunch, delivered, logins] = await Promise.all([
    pool.query(
      `SELECT id, customer_name, created_at, submitted_at FROM customer_requests
       WHERE company_id = $1 AND archived_at IS NULL AND status = 'À vérifier'
       ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 200`,
      [cid]
    ),
    pool.query(
      `SELECT r.id, r.customer_name, r.neighborhood, r.validated_at, r.customer_confirmed_at, (r.location_lat IS NOT NULL) AS has_location
       FROM customer_requests r LEFT JOIN orders o ON o.customer_request_id = r.id
       WHERE r.company_id = $1 AND r.archived_at IS NULL AND r.status = 'Validée' AND o.id IS NULL
       ORDER BY COALESCE(r.customer_confirmed_at, r.validated_at) DESC LIMIT 30`,
      [cid]
    ),
    pool.query(
      `SELECT id, customer_name, reference, created_at FROM orders
       WHERE company_id = $1 AND driver_id IS NULL AND status <> ALL($2::text[])
       ORDER BY created_at DESC LIMIT 30`,
      [cid, terminalOrderStatuses]
    ),
    pool.query(
      `SELECT i.id, i.category, i.created_at, i.description, o.id AS order_id, o.reference, o.customer_name, d.name AS driver_name
       FROM delivery_incidents i
       LEFT JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
       LEFT JOIN drivers d ON d.id = o.driver_id
       WHERE i.company_id = $1 AND i.status = 'open'
       ORDER BY i.created_at DESC LIMIT 30`,
      [cid]
    ),
    pool.query(
      `SELECT r.id, r.name, r.created_at, r.service_date, d.name AS driver_name
       FROM delivery_runs r LEFT JOIN drivers d ON d.id = r.driver_id
       WHERE r.company_id = $1 AND r.status = 'draft'
       ORDER BY r.created_at DESC LIMIT 20`,
      [cid]
    ),
    // Clients « à relancer » : même dérivation d'étape que la liste CRM.
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
    // Livraisons terminées : un récapitulatif par jour (7 derniers jours), pas un message par arrêt.
    pool.query(
      `SELECT to_char((e.created_at AT TIME ZONE '${DASHBOARD_TZ}')::date, 'YYYY-MM-DD') AS day, COUNT(DISTINCT e.order_id)::int AS n, MAX(e.created_at) AS last_at
       FROM order_status_events e
       WHERE e.company_id = $1 AND e.to_status = 'Livrée' AND e.created_at >= NOW() - INTERVAL '7 days'
       GROUP BY 1 ORDER BY 1 DESC`,
      [cid]
    ),
    userId ? pool.query(
      `SELECT token_hash, user_agent, created_at FROM app_sessions
       WHERE user_id = $1 AND expires_at > NOW() AND (created_at >= NOW() - INTERVAL '7 days' OR token_hash = $2)
       ORDER BY created_at DESC LIMIT 40`,
      [userId, currentSessionHash || '']
    ) : Promise.resolve({ rows: [] }),
  ]);
  const items = [];
  if (reqs.rows.length) {
    const n = reqs.rows.length;
    const newest = reqs.rows[0];
    const oldest = reqs.rows[n - 1];
    const range = n > 1 ? `${frDateShort(oldest.submitted_at || oldest.created_at)} – ${frDateShort(newest.submitted_at || newest.created_at)}` : (newest.customer_name || 'Client à préciser');
    items.push({
      id: `requests-${newest.id}`, category: 'requests', type: 'requests', priority: 'action',
      title: n > 1 ? `${n} demandes attendent votre validation` : 'Nouvelle demande à valider',
      summary: n > 1 ? `Formulaires reçus · ${range}` : range,
      meta: n > 1 ? 'Demandes regroupées' : 'Formulaire client',
      detail: n > 1 ? `${n} clients ont rempli leur formulaire. Vérifiez leurs informations, puis validez-les ou affectez un livreur.` : 'Un client a rempli son formulaire. Vérifiez ses informations, puis validez la demande ou affectez un livreur.',
      ref: n > 1 ? `${n} demandes` : `Demande #${newest.id}`,
      at: newest.submitted_at || newest.created_at,
      href: n > 1 ? '/app/operations?vue=demandes' : `/app/operations?vue=demandes&demande=${newest.id}`,
      cta: n > 1 ? 'Examiner les demandes' : 'Voir la demande',
    });
  }
  for (const r of toAssign.rows) {
    const confirmed = Boolean(r.customer_confirmed_at);
    items.push({
      id: `assign-${r.id}`, category: 'deliveries', type: 'assign', priority: 'action',
      title: confirmed ? 'Commande confirmée par le client' : 'Demande validée, livreur à affecter',
      summary: [r.customer_name, r.neighborhood].filter(Boolean).join(' · ') || `Demande #${r.id}`,
      meta: confirmed ? (r.has_location ? 'Position partagée' : 'Position non partagée') : 'Validée',
      detail: confirmed
        ? `Le client a vérifié ses informations${r.has_location ? ' et partagé sa position' : ''}. Affectez un livreur pour lancer la livraison.`
        : 'La demande est validée. Affectez un livreur pour créer la commande.',
      ref: `Demande #${r.id}`,
      at: r.customer_confirmed_at || r.validated_at,
      href: `/app/operations?vue=demandes&demande=${r.id}`,
      cta: 'Affecter un livreur',
    });
  }
  for (const o of unassigned.rows) {
    items.push({
      id: `order-${o.id}`, category: 'deliveries', type: 'assign', priority: 'action',
      title: 'Commande sans livreur', summary: [o.reference, o.customer_name].filter(Boolean).join(' · ') || `Commande n° ${o.id}`,
      meta: 'À affecter', detail: 'Cette commande n’a pas encore de livreur.', ref: o.reference || `Commande n° ${o.id}`,
      at: o.created_at, href: `/app/operations?vue=commandes&commande=${o.id}`, cta: 'Voir la commande',
    });
  }
  for (const i of incidents.rows) {
    items.push({
      id: `incident-${i.id}`, category: 'incidents', type: 'incident', priority: 'action',
      title: notificationIncidentLabels[i.category] || 'Incident signalé',
      summary: [i.reference, i.customer_name].filter(Boolean).join(' · ') || `Incident n° ${i.id}`,
      meta: i.driver_name || '',
      detail: `${i.driver_name ? `${i.driver_name} a signalé` : 'Un incident a été signalé'} sur cette livraison. Consultez la commande pour organiser la suite.`,
      ref: [i.reference, i.customer_name].filter(Boolean).join(' · ') || `Incident n° ${i.id}`,
      at: i.created_at, href: `/app/incidents/${i.id}`, cta: 'Voir l’incident',
    });
  }
  for (const r of runs.rows) {
    items.push({
      id: `run-${r.id}`, category: 'runs', type: 'run', priority: 'action',
      title: 'Une tournée reste à préparer', summary: r.name || `Tournée n° ${r.id}`, meta: r.driver_name || '',
      detail: 'Cette tournée est en préparation : vérifiez l’ordre des arrêts, puis planifiez-la.',
      ref: r.name || `Tournée n° ${r.id}`, at: r.created_at, href: `/app/tournees/${r.id}`, cta: 'Voir la tournée',
    });
  }
  for (const d of delivered.rows) {
    items.push({
      id: `delivered-${d.day}`, category: 'deliveries', type: 'delivered', priority: 'info',
      title: `${d.n} livraison${d.n > 1 ? 's' : ''} terminée${d.n > 1 ? 's' : ''}`,
      summary: `Récapitulatif du ${frDateShort(`${d.day}T12:00:00Z`)}`, meta: 'Information',
      detail: 'Les livraisons remises ce jour-là. Aucune action n’est attendue.',
      ref: `Livraisons du ${frDateShort(`${d.day}T12:00:00Z`)}`, at: d.last_at, href: '/app/operations?vue=commandes', cta: 'Voir les commandes',
    });
  }
  for (const c of relaunch.rows) {
    items.push({
      id: `relaunch-${c.id}`, category: 'clients', type: 'client', priority: 'info',
      title: 'Client à relancer', summary: c.display_name || `Client n° ${c.id}`, meta: 'Sans commande depuis plus de 30 jours',
      detail: 'Ce client n’a pas commandé depuis plus d’un mois. Une relance peut le faire revenir.',
      ref: c.display_name || `Client n° ${c.id}`, at: c.last_order_at || new Date(0).toISOString(), href: `/app/clients/${c.id}`, cta: 'Voir le client',
    });
  }
  // Une alerte par appareil (le plus récent), jamais pour l'appareil utilisé en ce moment.
  const currentDevice = logins.rows.find((s) => currentSessionHash && s.token_hash === currentSessionHash);
  const seenDevices = new Set(currentDevice ? [describeDevice(currentDevice.user_agent)] : []);
  for (const s of logins.rows) {
    if (currentSessionHash && s.token_hash === currentSessionHash) continue;
    const device = describeDevice(s.user_agent);
    if (seenDevices.has(device)) continue;
    seenDevices.add(device);
    items.push({
      id: `login-${s.token_hash.slice(0, 12)}`, category: 'security', type: 'security', priority: 'security',
      title: 'Nouvelle connexion à votre compte', summary: describeDevice(s.user_agent), meta: 'Sécurité',
      detail: 'Un appareil s’est connecté à votre compte. Si ce n’était pas vous, fermez cette session et changez votre mot de passe.',
      ref: describeDevice(s.user_agent), at: s.created_at, href: '/app/parametres?section=security', cta: 'Voir mes sessions',
    });
  }
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return items;
}

function defaultNotificationPrefs() {
  return { categories: Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true])), digest: 'off', digestHour: 8, digestDay: 1, timezone: null };
}
async function notificationPrefs(userId, cid) {
  const row = (await pool.query('SELECT categories, digest, digest_hour, digest_day, timezone FROM notification_prefs WHERE user_id = $1 AND company_id = $2', [userId, cid])).rows[0];
  const prefs = defaultNotificationPrefs();
  if (row) {
    for (const c of NOTIFICATION_CATEGORIES) if (typeof row.categories?.[c] === 'boolean') prefs.categories[c] = row.categories[c];
    prefs.digest = row.digest; prefs.digestHour = row.digest_hour; prefs.digestDay = row.digest_day; prefs.timezone = row.timezone;
  }
  return prefs;
}

// Éléments + état propre à l'utilisateur, filtrés selon ses préférences
// (la sécurité reste toujours visible).
async function userNotifications(auth, currentSessionHash) {
  const [items, prefs, states] = await Promise.all([
    buildNotificationItems(auth.company_id, { currentSessionHash, userId: auth.user_id }),
    notificationPrefs(auth.user_id, auth.company_id),
    pool.query('SELECT notif_key, read_at, archived_at, later_at FROM notification_states WHERE user_id = $1 AND company_id = $2', [auth.user_id, auth.company_id]),
  ]);
  const byKey = new Map(states.rows.map((r) => [r.notif_key, r]));
  const visible = items.filter((it) => it.category === 'security' || prefs.categories[it.category] !== false).map((it) => {
    const st = byKey.get(it.id) || {};
    return { ...it, read: Boolean(st.read_at), readAt: st.read_at || null, archived: Boolean(st.archived_at), later: Boolean(st.later_at) };
  });
  const active = visible.filter((it) => !it.archived && !it.later);
  const counts = {
    action: active.filter((it) => it.priority !== 'info').length,
    all: active.length,
    unread: active.filter((it) => !it.read).length,
    later: visible.filter((it) => it.later && !it.archived).length,
    archived: visible.filter((it) => it.archived).length,
  };
  return { items: visible, counts, prefs };
}

app.get('/api/app/notifications', requireCompanyApi, asyncRoute(async (req, res) => {
  const currentHash = digest(String(parseCookies(req).delivery_session || ''));
  const { items, counts } = await userNotifications(req.auth, currentHash);
  return res.json({ items, counts, generatedAt: new Date().toISOString() });
}));

// Lu / non lu / archivé / plus tard : idempotent, par utilisateur.
app.post('/api/app/notifications/state', requireCompanyApi, asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(String))] : [];
  const action = String(req.body.action || '');
  const columns = { read: ['read_at', true], unread: ['read_at', false], archive: ['archived_at', true], unarchive: ['archived_at', false], later: ['later_at', true], unlater: ['later_at', false] };
  if (!ids.length || ids.length > 300 || ids.some((id) => !notifKeyPattern.test(id)) || !columns[action]) {
    return res.status(400).json({ error: 'Demande invalide.' });
  }
  const [column, on] = columns[action];
  await pool.query(
    `INSERT INTO notification_states (user_id, company_id, notif_key, ${column}, updated_at)
     SELECT $1, $2, k, CASE WHEN $4 THEN NOW() ELSE NULL END, NOW() FROM unnest($3::text[]) AS k
     ON CONFLICT (user_id, company_id, notif_key) DO UPDATE
       SET ${column} = CASE WHEN $4 THEN COALESCE(notification_states.${column}, NOW()) ELSE NULL END,
           updated_at = NOW()`,
    [req.auth.user_id, req.auth.company_id, ids, on]
  );
  // Archiver ou « plus tard » : l'élément est aussi considéré comme lu.
  if (on && (action === 'archive' || action === 'later')) {
    await pool.query(
      `UPDATE notification_states SET read_at = COALESCE(read_at, NOW()) WHERE user_id = $1 AND company_id = $2 AND notif_key = ANY($3::text[])`,
      [req.auth.user_id, req.auth.company_id, ids]
    );
  }
  return res.json({ ok: true, count: ids.length });
}));

app.get('/api/app/notifications/preferences', requireCompanyApi, asyncRoute(async (req, res) => {
  const prefs = await notificationPrefs(req.auth.user_id, req.auth.company_id);
  const company = (await pool.query('SELECT timezone FROM companies WHERE id = $1', [req.auth.company_id])).rows[0] || {};
  const user = (await pool.query('SELECT email FROM users WHERE id = $1', [req.auth.user_id])).rows[0] || {};
  return res.json({ ...prefs, timezone: prefs.timezone || company.timezone || DASHBOARD_TZ, timezones: companyTimezones, email: user.email, emailConfigured: emailConfigured() });
}));

app.put('/api/app/notifications/preferences', requireCompanyApi, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const categories = {};
  for (const c of NOTIFICATION_CATEGORIES) {
    if (typeof body.categories?.[c] !== 'boolean') return res.status(400).json({ error: 'Préférences invalides.', field: c });
    categories[c] = body.categories[c];
  }
  const digestMode = String(body.digest || 'off');
  const hour = Number(body.digestHour);
  const day = Number(body.digestDay);
  const timezone = String(body.timezone || '');
  if (!['off', 'daily', 'weekly'].includes(digestMode) || !Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(day) || day < 1 || day > 7 || !companyTimezones.includes(timezone)) {
    return res.status(400).json({ error: 'Préférences du récapitulatif invalides.' });
  }
  await pool.query(
    `INSERT INTO notification_prefs (user_id, company_id, categories, digest, digest_hour, digest_day, timezone, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id, company_id) DO UPDATE SET categories = EXCLUDED.categories, digest = EXCLUDED.digest,
       digest_hour = EXCLUDED.digest_hour, digest_day = EXCLUDED.digest_day, timezone = EXCLUDED.timezone, updated_at = NOW()`,
    [req.auth.user_id, req.auth.company_id, JSON.stringify(categories), digestMode, hour, day, timezone]
  );
  await writeAudit(req.auth, 'user', req.auth.user_id, 'notification_prefs_changed', { digest: digestMode });
  return res.json({ categories, digest: digestMode, digestHour: hour, digestDay: day, timezone });
}));

// Récapitulatif e-mail d'un utilisateur : éléments autorisés, non lus, non archivés.
async function buildUserDigest(auth, appBaseUrl = '') {
  const { items } = await userNotifications(auth, null);
  const pending = items.filter((it) => !it.read && !it.archived && !it.later && it.priority !== 'info');
  if (!pending.length) return null;
  const baseUrl = String(appBaseUrl || '').replace(/\/+$/, '');
  const rows = pending.slice(0, 15).map((it) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border:1px solid #eef1f5;border-radius:12px"><tr><td style="padding:12px 14px">
    <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#111827">${escHtmlServer(it.title)}</div>
    <div style="font-family:Arial,sans-serif;font-size:13px;color:#667085;margin-top:2px">${escHtmlServer(it.summary)}</div>
    ${baseUrl ? `<a href="${escHtmlServer(baseUrl + it.href)}" style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#e11d2a;text-decoration:none">${escHtmlServer(it.cta || 'Ouvrir')} →</a>` : ''}
  </td></tr></table>`).join('');
  const label = `${pending.length} notification${pending.length > 1 ? 's' : ''} à traiter`;
  const html = renderEmailShell({
    baseUrl,
    heading: `Vous avez ${label}`,
    introHtml: 'Voici ce qui attend votre attention dans votre espace TRAXO.',
    bodyHtml: rows,
    ctaLabel: baseUrl ? 'Ouvrir le centre de notifications' : undefined,
    ctaUrl: baseUrl ? `${baseUrl}/app/notifications` : undefined,
    footerNote: 'Vous recevez ce récapitulatif parce que vous l’avez activé dans vos préférences de notifications.',
  });
  const text = pending.map((it) => `- ${it.title} : ${it.summary}`).join('\n');
  return { count: pending.length, subject: `TRAXO — ${label}`, html, text };
}

app.post('/api/app/notifications/digest', requireCompanyApi, asyncRoute(async (req, res) => {
  const digestMail = await buildUserDigest(req.auth, publicBaseUrl(req));
  if (!digestMail) return res.json({ sent: false, reason: 'nothing_to_send', count: 0, configured: emailConfigured() });
  const result = await sendEmail({ to: req.auth.email, subject: digestMail.subject, html: digestMail.html, text: digestMail.text });
  return res.json({ ...result, count: digestMail.count, configured: emailConfigured(), recipient: req.auth.email });
}));

// Envoi planifié des récapitulatifs (quotidien ou hebdomadaire, à l'heure locale choisie).
function localClock(timeZone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday] || 1;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}
async function runNotificationDigests() {
  if (!pool || !emailConfigured() || process.env.NOTIFICATION_DIGEST === 'off') return;
  const due = await pool.query(
    `SELECT p.user_id, p.company_id, p.digest, p.digest_hour, p.digest_day, COALESCE(p.timezone, c.timezone, '${DASHBOARD_TZ}') AS tz,
            p.last_digest_at, u.email, u.display_name, m.role
     FROM notification_prefs p
     JOIN users u ON u.id = p.user_id AND COALESCE(u.disabled, FALSE) = FALSE
     JOIN company_memberships m ON m.user_id = p.user_id AND m.company_id = p.company_id AND m.role <> 'driver'
     JOIN companies c ON c.id = p.company_id
     WHERE p.digest IN ('daily', 'weekly')`
  );
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  for (const row of due.rows) {
    try {
      const now = localClock(row.tz);
      if (now.hour < row.digest_hour) continue;
      if (row.digest === 'weekly' && now.weekday !== row.digest_day) continue;
      const last = row.last_digest_at ? localClock(row.tz, new Date(row.last_digest_at)).day : null;
      if (last === now.day) continue;
      if (row.digest === 'weekly' && row.last_digest_at && Date.now() - new Date(row.last_digest_at).getTime() < 6 * 24 * 3600 * 1000) continue;
      // Marqué avant l'envoi : un échec ne provoque pas de rafale d'e-mails.
      await pool.query('UPDATE notification_prefs SET last_digest_at = NOW() WHERE user_id = $1 AND company_id = $2', [row.user_id, row.company_id]);
      const mail = await buildUserDigest({ user_id: row.user_id, company_id: row.company_id, role: row.role, email: row.email }, base);
      if (mail) await sendEmail({ to: row.email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (error) {
      console.error('Notification digest failed:', error.message);
    }
  }
}
if (process.env.NODE_ENV !== 'test') {
  const digestTimer = setInterval(() => { runNotificationDigests().catch((error) => console.error('Digest loop:', error.message)); }, 10 * 60 * 1000);
  digestTimer.unref();
}

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
    if (digits.length < 6) return res.status(400).json({ error: 'Ce numéro de téléphone semble incorrect (ex. : 01 97 12 34 56).' });
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
      return res.status(400).json({ error: 'Étape commerciale inconnue.' });
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
// UTF-8 pour qu'Excel ouvre les accents correctement. En-têtes localisés FR,
// données lues par clé technique.
function buildExportCsv(headerLabels, columnKeys, rows) {
  const esc = (value) => {
    const s = value == null ? '' : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = headerLabels.map(esc).join(',');
  const body = rows.map((row) => columnKeys.map((column) => esc(row[column])).join(',')).join('\r\n');
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

  const wiredDataset = EXPORT_QUERY_BUILDERS[contract.dataset];
  if (!wiredDataset) {
    await recordExportLog(auth, contract, 'failed', { failureCode: 'DATASET_NOT_WIRED' });
    return res.status(400).json({
      error: `L’export du jeu de données « ${contract.dataset} » n’est pas encore disponible.`,
      code: 'DATASET_NOT_WIRED',
    });
  }

  let rows;
  try {
    rows = await withCompanyTransaction(pool, auth.company_id, async (client) => {
      const query = wiredDataset.build(contract, auth.company_id);
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

  const normalizedRows = rows.map((row) => normalizeExportRow(row, wiredDataset.numeric));
  const format = ['csv', 'premium'].includes(body.format) ? body.format : 'xlsx';
  // En-têtes en français (source unique : DATASET_COLUMN_DEFS du contrat).
  const headerLabels = contract.columns.map((key) => exportColumnLabel(contract.dataset, key));

  // Fabrique l'artefact selon le format demandé (XLSX audité, CSV, ou
  // « premium » : classeur brandé avec graphiques via ExcelJS).
  let artifact;
  try {
    if (format === 'csv') {
      const csv = buildExportCsv(headerLabels, contract.columns, normalizedRows);
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
    } else if (format === 'premium') {
      const defs = EXPORT_COLUMN_DEFS[contract.dataset] || {};
      const columns = contract.columns.map((key) => ({
        key,
        label: exportColumnLabel(contract.dataset, key),
        type: (defs[key] && defs[key].type) || 'texte',
      }));
      const companyRow = await pool.query('SELECT name FROM companies WHERE id = $1', [auth.company_id]);
      const buffer = await buildPremiumWorkbook({
        datasetKey: contract.dataset,
        rows: normalizedRows,
        columns,
        meta: {
          companyName: companyRow.rows[0]?.name || '',
          title: `Rapport ${EXPORT_DATASET_TITLES[contract.dataset] || contract.dataset}`,
          periodFrom: contract.period.from,
          periodTo: contract.period.to,
          generatedAt: new Date().toISOString(),
        },
        options: premiumLogoBuffer ? { logoBuffer: premiumLogoBuffer } : {},
      });
      artifact = {
        buffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ext: 'xlsx',
        totalRows: normalizedRows.length,
        worksheetCount: 3,
        artifactBytes: buffer.length,
        artifactSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
    } else {
      const workbook = buildExportWorkbook(contract, normalizedRows, { headerLabels });
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

// ---------------------------------------------------------------------------
// Tableau de bord : utilitaires de dates (jours au format AAAA-MM-JJ).
// ---------------------------------------------------------------------------
const DASHBOARD_TZ = 'Africa/Porto-Novo';
function dashboardAddDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dashboardDaysBetween(fromStr, toStr) {
  const a = Date.parse(`${fromStr}T00:00:00Z`);
  const b = Date.parse(`${toStr}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}
const validDashboardDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

// Tableau de bord : période de 7 ou 30 jours, ou plage choisie (92 jours au plus),
// comparée à la période précédente de même durée, dans le fuseau de l'entreprise.
// Filtre facultatif par livreur, appliqué à toutes les mesures. Les demandes
// clients n'ont pas de livreur tant qu'elles ne sont pas converties : avec un
// filtre, seules les demandes devenues commandes de ce livreur sont comptées.
const DASHBOARD_RANGE_MAX_DAYS = 92;
const DASHBOARD_ROWS_MAX = 3000;
function localDateIn(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

app.get('/api/app/dashboard', requireCompanyApi, asyncRoute(async (req, res) => {
  const cid = req.auth.company_id;
  const company = (await pool.query('SELECT timezone FROM companies WHERE id = $1', [cid])).rows[0] || {};
  const timezone = companyTimezones.includes(company.timezone) ? company.timezone : DASHBOARD_TZ;
  const today = localDateIn(timezone);
  let from;
  let to;
  if (req.query.from || req.query.to) {
    if (!validDashboardDate(req.query.from) || !validDashboardDate(req.query.to) || req.query.from > req.query.to) {
      return res.status(400).json({ error: 'Choisissez une date de début antérieure à la date de fin.' });
    }
    if (req.query.from > today) return res.status(400).json({ error: 'La période ne peut pas commencer après aujourd’hui.' });
    from = req.query.from;
    to = req.query.to > today ? today : req.query.to;
    if (dashboardDaysBetween(from, to) > DASHBOARD_RANGE_MAX_DAYS) {
      return res.status(400).json({ error: `Choisissez une période de ${DASHBOARD_RANGE_MAX_DAYS} jours au plus.` });
    }
  } else {
    const days = Number(req.query.period) === 30 ? 30 : 7;
    to = today;
    from = dashboardAddDays(today, -(days - 1));
  }
  const days = dashboardDaysBetween(from, to);
  const prevFrom = dashboardAddDays(from, -days);
  // Bornes larges en UTC (± 1 jour) : le découpage exact par jour local est fait ensuite.
  const startIso = `${dashboardAddDays(prevFrom, -1)}T00:00:00Z`;
  const endIso = `${dashboardAddDays(to, 2)}T00:00:00Z`;

  const drivers = (await pool.query(
    'SELECT id, name, active, archived_at FROM drivers WHERE company_id = $1 ORDER BY (active AND archived_at IS NULL) DESC, name ASC', [cid]
  )).rows;
  let driverId = null;
  if (req.query.driver && req.query.driver !== 'all') {
    driverId = /^\d+$/.test(String(req.query.driver)) ? Number(req.query.driver) : NaN;
    if (!drivers.some((d) => Number(d.id) === driverId)) return res.status(400).json({ error: 'Livreur introuvable.' });
  }

  const [orders, requests, runs, incidents, stock] = await Promise.all([
    pool.query(
      `SELECT o.id, o.reference, o.customer_name, o.neighborhood, o.status, o.driver_id, o.created_at,
              ev.delivered_at, ev.returned_at, ev.out_at,
              (SELECT count(*) FROM delivery_incidents i WHERE i.company_id = o.company_id AND i.order_id = o.id)::int AS incidents
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT MIN(e.created_at) FILTER (WHERE e.to_status = 'Livrée') AS delivered_at,
                MIN(e.created_at) FILTER (WHERE e.to_status = 'Retournée') AS returned_at,
                MIN(e.created_at) FILTER (WHERE e.to_status IN ('En tournée', 'En livraison')) AS out_at
         FROM order_status_events e WHERE e.order_id = o.id AND e.company_id = o.company_id
       ) ev ON TRUE
       WHERE o.company_id = $1 AND ($4::bigint IS NULL OR o.driver_id = $4)
         AND ((o.created_at >= $2 AND o.created_at < $3)
           OR (o.status IN ('Livrée', 'Retournée') AND COALESCE(o.status_changed_at, o.updated_at) >= $2))
       ORDER BY o.created_at DESC
       LIMIT 20000`,
      [cid, startIso, endIso, driverId]
    ),
    pool.query(
      `SELECT r.id, r.customer_name, r.neighborhood, r.status, r.submitted_at, r.customer_confirmed_at, o.id AS order_id, o.driver_id
       FROM customer_requests r LEFT JOIN orders o ON o.customer_request_id = r.id AND o.company_id = r.company_id
       WHERE r.company_id = $1 AND COALESCE(r.submitted_at, r.customer_confirmed_at) >= $2 AND COALESCE(r.submitted_at, r.customer_confirmed_at) < $3
         AND ($4::bigint IS NULL OR o.driver_id = $4)
       LIMIT 20000`,
      [cid, startIso, endIso, driverId]
    ),
    pool.query(
      `SELECT r.id, r.name, r.status, r.driver_id, to_char(r.service_date, 'YYYY-MM-DD') AS service_date,
              COALESCE(st.total, 0)::int AS stops_total, COALESCE(st.done, 0)::int AS stops_done
       FROM delivery_runs r
       LEFT JOIN LATERAL (
         SELECT count(*) AS total, count(*) FILTER (WHERE o.status IN ('Livrée', 'Retournée')) AS done
         FROM delivery_stops s JOIN orders o ON o.id = s.order_id AND o.company_id = s.company_id
         WHERE s.run_id = r.id AND s.company_id = r.company_id AND s.removed_at IS NULL
       ) st ON TRUE
       WHERE r.company_id = $1 AND r.service_date >= $2::date AND r.service_date <= $3::date AND ($4::bigint IS NULL OR r.driver_id = $4)
       LIMIT 5000`,
      [cid, prevFrom, to, driverId]
    ),
    pool.query(
      `SELECT i.id, i.category, i.status, i.created_at, o.id AS order_id, o.reference, o.customer_name, o.driver_id
       FROM delivery_incidents i JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
       WHERE i.company_id = $1 AND i.created_at >= $2 AND i.created_at < $3 AND ($4::bigint IS NULL OR o.driver_id = $4)
       LIMIT 20000`,
      [cid, startIso, endIso, driverId]
    ),
    pool.query(
      `SELECT
         (SELECT count(*) FROM delivery_incidents i JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
          WHERE i.company_id = $1 AND i.status = 'open' AND ($2::bigint IS NULL OR o.driver_id = $2))::int AS open_incidents,
         (SELECT count(*) FROM customer_requests WHERE company_id = $1 AND archived_at IS NULL AND status = 'À vérifier')::int AS to_review`,
      [cid, driverId]
    ),
  ]);

  const stockRow = stock.rows[0] || {};
  const result = computeInsights({
    raw: { orders: orders.rows, requests: requests.rows, runs: runs.rows, incidents: incidents.rows },
    drivers, from, to, timezone,
    stock: { openIncidents: stockRow.open_incidents || 0 },
  });
  let truncated = orders.rows.length >= 20000;
  for (const key of Object.keys(result.rows)) {
    if (result.rows[key].length > DASHBOARD_ROWS_MAX) { result.rows[key] = result.rows[key].slice(0, DASHBOARD_ROWS_MAX); truncated = true; }
  }
  return res.json({
    ...result,
    today,
    maxDays: DASHBOARD_RANGE_MAX_DAYS,
    driver: driverId,
    drivers: drivers.filter((d) => (d.active && !d.archived_at) || Number(d.id) === driverId).map((d) => ({ id: Number(d.id), name: d.name })),
    attention: { incidents: stockRow.open_incidents || 0, requests: stockRow.to_review || 0 },
    truncated,
  });
}));

// Commande saisie par l'équipe, confirmée ensuite par le client (même lien que le
// formulaire client). Le client prouve qu'il est le destinataire avec les 4 derniers
// chiffres de son numéro ; le lien est alors lié à son appareil.
// ---- Colis et point de collecte ------------------------------------------
// Facultatif : sans collecte, le colis part de chez l'entreprise. Les champs
// vivent sur la demande (saisie préremplie) puis sont recopiés sur la commande.
const packageTypes = ['colis', 'documents', 'repas', 'fragile', 'vetements', 'autre'];
const PICKUP_COLUMNS = ['package_description', 'package_type', 'pickup_name', 'pickup_phone', 'pickup_address', 'pickup_lat', 'pickup_lng', 'pickup_ready'];
function pickupFieldsFromBody(body = {}) {
  const text = (value, max) => { const v = String(value ?? '').trim(); return v ? v.slice(0, max) : null; };
  const fields = {
    package_description: text(body.packageDescription, 240),
    package_type: packageTypes.includes(body.packageType) ? body.packageType : null,
    pickup_name: null, pickup_phone: null, pickup_address: null, pickup_lat: null, pickup_lng: null, pickup_ready: null,
  };
  if (body.packageType && !fields.package_type) return { error: 'Choisissez un type de colis dans la liste.', field: 'packageType' };
  const enabled = body.pickupEnabled === true || body.pickupEnabled === 'true';
  if (!enabled) return { fields };
  fields.pickup_name = text(body.pickupName, 120);
  fields.pickup_address = text(body.pickupAddress, 240);
  fields.pickup_ready = text(body.pickupReady, 80);
  const lat = optionalNumber(body.pickupLat);
  const lng = optionalNumber(body.pickupLng);
  if ((lat == null) !== (lng == null) || (lat != null && (lat < -90 || lat > 90 || lng < -180 || lng > 180))) {
    return { error: 'La position du point de collecte est invalide.', field: 'pickupLat' };
  }
  fields.pickup_lat = lat;
  fields.pickup_lng = lng;
  if (!fields.pickup_address && lat == null) return { error: 'Indiquez où récupérer le colis : un quartier, un repère ou une épingle sur la carte.', field: 'pickupAddress' };
  if (String(body.pickupPhone || '').trim()) {
    const phone = normalizeCustomerPhone({ customerPhone: body.pickupPhone, customerPhoneCountry: body.pickupPhoneCountry || body.customerPhoneCountry });
    if (!phone) return { error: 'Le numéro du point de collecte semble incorrect.', field: 'pickupPhone' };
    fields.pickup_phone = phone;
  }
  return { fields };
}
async function savePickupFields(queryable, table, id, companyId, fields) {
  if (!['orders', 'customer_requests'].includes(table)) throw new Error('table');
  const sets = PICKUP_COLUMNS.map((column, i) => `${column} = $${i + 3}`).join(', ');
  await queryable.query(`UPDATE ${table} SET ${sets} WHERE id = $1 AND company_id = $2`, [id, companyId, ...PICKUP_COLUMNS.map((c) => fields[c] ?? null)]);
}
function publicPickupFields(row) {
  return {
    packageDescription: row.package_description || null,
    packageType: row.package_type || null,
    pickup: row.pickup_address || row.pickup_name || row.pickup_lat != null ? {
      name: row.pickup_name || null, phone: row.pickup_phone || null, address: row.pickup_address || null,
      lat: row.pickup_lat ?? null, lng: row.pickup_lng ?? null, ready: row.pickup_ready || null,
    } : null,
  };
}

function prefilledFieldsFromBody(body) {
  const text = (value, max) => { const v = String(value || '').trim(); return v ? v.slice(0, max) : null; };
  return {
    customerName: text(body.customerName, 120),
    neighborhood: text(body.neighborhood, 160),
    landmark: text(body.landmark, 240),
    notes: text(body.notes, 1000),
    requestedTime: text(body.requestedTime, 80),
  };
}
function phoneLastDigits(phone, count = 4) {
  return String(phone || '').replace(/\D/g, '').slice(-count);
}

app.post('/api/app/requests/prefilled', requireCompanyApi, asyncRoute(async (req, res) => {
  if (!(await companyDeliverySetting(req.auth.company_id, 'internalEntryEnabled'))) {
    return res.status(403).json({ error: 'La saisie par votre équipe est désactivée dans vos paramètres Livraisons.' });
  }
  const fields = prefilledFieldsFromBody(req.body || {});
  if (!fields.customerName || fields.customerName.length < 2) return res.status(400).json({ error: 'Indiquez le nom du client.', field: 'customerName' });
  const phone = normalizeCustomerPhone(req.body || {});
  if (!phone) return res.status(400).json({ error: 'Le téléphone du client est nécessaire : il sert à protéger son lien de confirmation.', field: 'customerPhone' });
  if (!fields.neighborhood) return res.status(400).json({ error: 'Indiquez le quartier ou la zone de livraison.', field: 'neighborhood' });
  const pickup = pickupFieldsFromBody(req.body || {});
  if (pickup.error) return res.status(400).json({ error: pickup.error, field: pickup.field });
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    `INSERT INTO customer_requests (company_id, token, status, customer_name, customer_phone, neighborhood,
       landmark, notes, requested_time, expires_at, prefilled_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [req.auth.company_id, token, PREFILLED_REQUEST_STATUS, fields.customerName, phone, fields.neighborhood,
      fields.landmark, fields.notes, fields.requestedTime, expiresAt, req.auth.user_id]
  );
  await savePickupFields(pool, 'customer_requests', result.rows[0].id, req.auth.company_id, pickup.fields);
  await writeAudit(req.auth, 'customer_request', result.rows[0].id, 'prefilled_created', { expiresAt });
  const company = (await pool.query('SELECT name FROM companies WHERE id = $1', [req.auth.company_id])).rows[0] || {};
  const url = `${publicBaseUrl(req)}/demande/${token}`;
  const firstName = fields.customerName.split(/\s+/)[0];
  return res.status(201).json({
    id: result.rows[0].id,
    token,
    path: `/demande/${token}`,
    url,
    expiresAt,
    phone,
    message: `Bonjour ${firstName}, ${company.name || 'nous'} prépare votre livraison. Vérifiez vos informations et confirmez ici : ${url}`,
  });
}));

// Colis et collecte modifiables tant que le colis n'est pas récupéré.
app.patch('/api/app/orders/:id/pickup', requireCompanyApi, asyncRoute(async (req, res) => {
  const pickup = pickupFieldsFromBody(req.body || {});
  if (pickup.error) return res.status(400).json({ error: pickup.error, field: pickup.field });
  const row = (await pool.query('SELECT id, status FROM orders WHERE id = $1 AND company_id = $2', [req.params.id, req.auth.company_id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Commande introuvable.' });
  if (!['En préparation', 'Confirmée', 'Vers la collecte'].includes(row.status)) {
    return res.status(409).json({ error: 'Le colis est déjà récupéré : la collecte ne peut plus être modifiée.' });
  }
  if (row.status === 'Vers la collecte' && !pickup.fields.pickup_address && pickup.fields.pickup_lat == null) {
    return res.status(409).json({ error: 'Le livreur est en route vers la collecte : modifiez le lieu plutôt que de le retirer.' });
  }
  await savePickupFields(pool, 'orders', row.id, req.auth.company_id, pickup.fields);
  await writeAudit(req.auth, 'order', row.id, 'pickup_updated', { pickup: Boolean(pickup.fields.pickup_address || pickup.fields.pickup_lat != null) });
  const updated = (await pool.query(`SELECT ${PICKUP_COLUMNS.join(', ')} FROM orders WHERE id = $1`, [row.id])).rows[0];
  return res.json(publicPickupFields(updated));
}));

// Carnet automatique : les lieux de collecte déjà utilisés, du plus récent au plus ancien.
app.get('/api/app/pickup-places', requireCompanyApi, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const result = await pool.query(
    `SELECT DISTINCT ON (lower(COALESCE(pickup_name, '')), lower(COALESCE(pickup_address, '')))
            pickup_name, pickup_phone, pickup_address,
            COALESCE(pickup_lat, picked_up_lat) AS pickup_lat, COALESCE(pickup_lng, picked_up_lng) AS pickup_lng, created_at
     FROM orders
     WHERE company_id = $1 AND (pickup_name IS NOT NULL OR pickup_address IS NOT NULL)
       AND ($2::text = '' OR pickup_name ILIKE '%' || $2 || '%' OR pickup_address ILIKE '%' || $2 || '%')
     ORDER BY lower(COALESCE(pickup_name, '')), lower(COALESCE(pickup_address, '')), created_at DESC
     LIMIT 200`,
    [req.auth.company_id, q]
  );
  const places = result.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 12).map((r) => ({
    name: r.pickup_name, phone: r.pickup_phone, address: r.pickup_address,
    lat: r.pickup_lat == null ? null : Number(r.pickup_lat), lng: r.pickup_lng == null ? null : Number(r.pickup_lng),
  }));
  return res.json({ places });
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
  return res.status(201).json({ token, path: `/demande/${token}`, url: `${publicBaseUrl(req)}/demande/${token}`, expiresAt });
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
    `SELECT r.id, r.token, r.status, r.customer_name, r.customer_phone, r.requested_time,
            r.location_lat, r.location_lng, r.location_accuracy, r.location_at,
            r.neighborhood, r.landmark, r.notes, r.created_at, r.submitted_at, r.updated_at,
            r.expires_at, r.archived_at, r.validated_at, r.version,
            o.id AS order_id, o.status AS order_status, o.reference AS order_reference, d.name AS driver_name,
            t.token_ciphertext AS tracking_token_ciphertext, t.expires_at AS tracking_expires_at,
            t.revoked_at AS tracking_revoked_at, t.created_at AS tracking_created_at,
            t.version AS tracking_link_version,
            (SELECT COALESCE(json_agg(p.id ORDER BY p.id), '[]'::json)
               FROM customer_request_photos p WHERE p.request_id = r.id) AS photo_ids
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

app.get('/api/app/requests/:id/photos/:photoId', requireCompanyApi, asyncRoute(async (req, res) => {
  if (!numericIdPattern.test(req.params.id) || !numericIdPattern.test(req.params.photoId)) return res.status(404).end();
  const result = await pool.query(
    `SELECT p.mime, p.data FROM customer_request_photos p
     WHERE p.id = $1 AND p.request_id = $2 AND p.company_id = $3`,
    [req.params.photoId, req.params.id, req.auth.company_id]
  );
  const photo = result.rows[0];
  if (!photo) return res.status(404).end();
  return sendRequestPhoto(res, photo);
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

// Validation sans livreur : verrouille les informations du client. L'affectation
// d'un livreur (conversion en commande) peut se faire ensuite.
app.post('/api/app/requests/:id/validate', requireCompanyApi, asyncRoute(async (req, res) => {
  if (await companyDeliverySetting(req.auth.company_id, 'driverAssignmentRequired')) {
    return res.status(409).json({
      error: 'Vos règles de livraison exigent un livreur pour valider. Choisissez un livreur : la demande sera validée et la commande créée.',
      code: 'DRIVER_REQUIRED',
    });
  }
  const result = await pool.query(
    `UPDATE customer_requests
     SET status = 'Validée', validated_at = NOW(), version = version + 1, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 AND archived_at IS NULL AND status = ANY($3::text[])
       AND customer_name IS NOT NULL AND customer_phone IS NOT NULL AND neighborhood IS NOT NULL
     RETURNING id, status, version, validated_at`,
    [req.params.id, req.auth.company_id, editableRequestStatuses]
  );
  if (!result.rows[0]) {
    return res.status(409).json({ error: 'Cette demande ne peut pas être validée (déjà traitée ou informations incomplètes).' });
  }
  await writeAudit(req.auth, 'customer_request', result.rows[0].id, 'validated');
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
    markDriverSeat(req.auth.company_id, driver.id);
      return res.json({ orderId: existing.rows[0].id, path: trackingLink.path, trackingLink, alreadyConverted: true });
    }
    if (!convertibleRequestStatuses.includes(request.status)) {
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
    // Colis et collecte saisis sur la demande : recopiés sur la commande.
    await client.query(
      `UPDATE orders o SET ${PICKUP_COLUMNS.map((c) => `${c} = r.${c}`).join(', ')}
       FROM customer_requests r WHERE o.id = $1 AND r.id = $2 AND r.company_id = o.company_id`,
      [order.rows[0].id, request.id]
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
       SET status = 'Confirmée', validated_at = COALESCE(validated_at, NOW()), version = version + 1, updated_at = NOW()
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
            d.active, d.traccar_unique_id, d.driver_code, d.email, d.plate, d.zone, d.team, d.note,
            d.can_contact, d.can_report_incident, d.suspended_at,
            (SELECT s.user_agent FROM app_sessions s JOIN company_memberships m2 ON m2.user_id = s.user_id AND m2.company_id = d.company_id
             WHERE m2.driver_id = d.id AND s.scope = 'company' AND s.expires_at > NOW() ORDER BY s.created_at DESC LIMIT 1) AS device_agent,
            (SELECT MAX(s.created_at) FROM app_sessions s JOIN company_memberships m2 ON m2.user_id = s.user_id AND m2.company_id = d.company_id
             WHERE m2.driver_id = d.id AND s.scope = 'company' AND s.expires_at > NOW()) AS device_since,
            (SELECT i.expires_at FROM driver_invitations i WHERE i.driver_id = d.id AND i.company_id = d.company_id
             AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW() ORDER BY i.created_at DESC LIMIT 1) AS driver_invite_expires,
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
      hasAccount: Boolean(driver.has_account), invitePending: Boolean(driver.invite_pending || driver.driver_invite_expires),
      code: driver.driver_code, email: driver.email, plate: driver.plate, zone: driver.zone, team: driver.team, note: driver.note,
      canContact: driver.can_contact !== false, canReportIncident: driver.can_report_incident !== false,
      suspended: Boolean(driver.suspended_at),
      // Accès à l'appli : distinct de la connexion réseau (un accès actif peut être hors ligne).
      accessState: driver.suspended_at ? 'suspended' : driver.driver_invite_expires ? 'invited' : (driver.has_account || driver.device_agent) ? 'active' : 'none',
      device: driver.device_agent ? { label: describeDevice(driver.device_agent), since: driver.device_since } : null,
      inviteExpiresAt: driver.driver_invite_expires || null,
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

// Activité récente d'un livreur : dernières commandes qui lui sont affectées
// (pour la fiche livreur — « Dernières mises à jour »).
app.get('/api/app/drivers/:id/activity', requireCompanyApi, asyncRoute(async (req, res) => {
  const driver = await pool.query(
    `SELECT id, name FROM drivers WHERE id = $1 AND company_id = $2 AND archived_at IS NULL`,
    [req.params.id, req.auth.company_id]
  );
  if (!driver.rows[0]) return res.status(404).json({ error: 'Livreur introuvable.' });
  const orders = await pool.query(
    `SELECT id, reference, customer_name, status, status_changed_at, created_at
     FROM orders
     WHERE company_id = $1 AND driver_id = $2
     ORDER BY COALESCE(status_changed_at, created_at) DESC
     LIMIT 6`,
    [req.auth.company_id, req.params.id]
  );
  return res.json({
    driverId: driver.rows[0].id,
    updates: orders.rows.map((o) => ({
      id: o.id, reference: o.reference, customerName: o.customer_name,
      status: o.status, at: o.status_changed_at || o.created_at,
    })),
  });
}));

// Création d'un livreur depuis le SaaS (owner/manager). Génère un identifiant GPS
// aléatoire non devinable par défaut ; un identifiant Traccar existant peut être
// fourni pour relier un appareil déjà enrôlé.
// ---- Profils livreurs ------------------------------------------------------
// Le numéro identifie la personne : unique dans l'entreprise, il sert aussi à
// vérifier l'identité au moment de rejoindre l'appli.
function driverProfileFields(body, { partial = false } = {}) {
  const out = {};
  const text = (value, max) => { const v = String(value ?? '').trim(); return v ? v.slice(0, max) : null; };
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 80) return { error: 'Indiquez le nom complet du livreur.', field: 'name' };
    out.name = name;
  }
  if (!partial || body.phone !== undefined) {
    const raw = String(body.phone || '').trim();
    if (!raw) { if (!partial) return { error: 'Indiquez le téléphone du livreur : il servira à vérifier son identité.', field: 'phone' }; out.phone = null; out.phone_digits = null; }
    else {
      const normalized = normalizeCustomerPhone({ customerPhone: raw, customerPhoneCountry: body.phoneCountry || 'BJ' });
      if (!normalized) return { error: 'Ce numéro semble incorrect. Au Bénin : 10 chiffres commençant par 01.', field: 'phone' };
      out.phone = normalized;
      out.phone_digits = normalized.replace(/\D/g, '');
    }
  }
  if (!partial || body.vehicleType !== undefined) {
    const vehicleType = String(body.vehicleType || 'Moto').trim();
    if (!driverVehicleTypes.includes(vehicleType)) return { error: 'Choisissez un type de véhicule dans la liste.', field: 'vehicleType' };
    out.vehicle_type = vehicleType;
  }
  if (!partial || body.capacity !== undefined) {
    const capacity = Number(body.capacity ?? 10);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) return { error: 'La capacité doit être comprise entre 1 et 500 colis.', field: 'capacity' };
    out.capacity = capacity;
  }
  if (body.email !== undefined) {
    const email = text(body.email, 160);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Cette adresse e-mail semble incorrecte.', field: 'email' };
    out.email = email ? email.toLowerCase() : null;
  }
  if (body.plate !== undefined) out.plate = text(body.plate, 20);
  if (body.zone !== undefined) out.zone = text(body.zone, 80);
  if (body.team !== undefined) out.team = text(body.team, 80);
  if (body.note !== undefined) out.note = text(body.note, 500);
  if (body.canContact !== undefined) out.can_contact = body.canContact !== false;
  if (body.canReportIncident !== undefined) out.can_report_incident = body.canReportIncident !== false;
  if (body.trackerId !== undefined) {
    const trackerId = String(body.trackerId || '').trim();
    if (trackerId && !/^[A-Za-z0-9_-]{4,64}$/.test(trackerId)) return { error: 'L’identifiant GPS doit contenir 4 à 64 lettres ou chiffres.', field: 'trackerId' };
    out.traccar_unique_id = trackerId || null;
  }
  return { fields: out };
}
async function nextDriverCode(queryable, companyId) {
  const row = (await queryable.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(COALESCE(driver_code, ''), '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM drivers WHERE company_id = $1`,
    [companyId]
  )).rows[0];
  return `LIV-${String(row.n).padStart(3, '0')}`;
}
async function duplicateDriverPhone(queryable, companyId, digits, exceptId = null) {
  if (!digits) return null;
  return (await queryable.query(
    `SELECT id, name FROM drivers WHERE company_id = $1 AND phone_digits = $2 AND archived_at IS NULL AND ($3::bigint IS NULL OR id <> $3) LIMIT 1`,
    [companyId, digits, exceptId]
  )).rows[0] || null;
}
// Une place = une personne (numéro) dans le mois, quels que soient les profils créés.
async function markDriverSeat(companyId, driverId, phoneDigits = undefined, queryable = pool) {
  try {
    let digits = phoneDigits;
    if (digits === undefined) digits = (await queryable.query('SELECT phone_digits FROM drivers WHERE id = $1 AND company_id = $2', [driverId, companyId])).rows[0]?.phone_digits || null;
    const seatKey = digits ? `tel:${digest(`seat:${digits}`).slice(0, 32)}` : `profil:${driverId}`;
    await queryable.query(
      `INSERT INTO driver_seat_usage (company_id, month, seat_key, driver_id)
       VALUES ($1, date_trunc('month', NOW() AT TIME ZONE 'Africa/Porto-Novo')::date, $2, $3)
       ON CONFLICT DO NOTHING`,
      [companyId, seatKey, driverId]
    );
  } catch (error) {
    console.error('Seat usage failed:', error.message);
  }
}
async function revokeDriverAccess(queryable, companyId, driverId, { sessions = true, invitations = true, exceptSessionHash = null } = {}) {
  if (sessions) {
    await queryable.query(
      `DELETE FROM app_sessions s USING company_memberships m
       WHERE m.user_id = s.user_id AND m.company_id = $1 AND m.driver_id = $2 AND s.company_id = $1
         AND ($3::text IS NULL OR s.token_hash <> $3)`,
      [companyId, driverId, exceptSessionHash]
    );
  }
  if (invitations) {
    await queryable.query(
      'UPDATE driver_invitations SET revoked_at = NOW() WHERE company_id = $1 AND driver_id = $2 AND used_at IS NULL AND revoked_at IS NULL',
      [companyId, driverId]
    );
  }
}

app.post('/api/app/drivers', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const parsed = driverProfileFields(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error, field: parsed.field });
  const f = parsed.fields;
  const duplicate = await duplicateDriverPhone(pool, req.auth.company_id, f.phone_digits);
  if (duplicate) return res.status(409).json({ error: `Ce numéro appartient déjà au profil de ${duplicate.name}. Ouvrez ce profil plutôt que d’en créer un second.`, field: 'phone', driverId: duplicate.id });
  const uniqueId = f.traccar_unique_id || `trx-${crypto.randomBytes(6).toString('hex')}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const code = await nextDriverCode(pool, req.auth.company_id);
      const result = await pool.query(
        `INSERT INTO drivers (company_id, name, phone, phone_digits, vehicle_type, capacity, traccar_unique_id, driver_code,
           email, plate, zone, team, note, can_contact, can_report_incident)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, TRUE), COALESCE($15, TRUE))
         RETURNING id, name, phone, vehicle_type, capacity, traccar_unique_id, active, availability_status, driver_code`,
        [req.auth.company_id, f.name, f.phone, f.phone_digits, f.vehicle_type, f.capacity, uniqueId, code,
          f.email ?? null, f.plate ?? null, f.zone ?? null, f.team ?? null, f.note ?? null, f.can_contact ?? null, f.can_report_incident ?? null]
      );
      await writeAudit(req.auth, 'driver', result.rows[0].id, 'created', { name: f.name });
      await markDriverSeat(req.auth.company_id, result.rows[0].id, f.phone_digits);
      return res.status(201).json({ ...result.rows[0], code: result.rows[0].driver_code });
    } catch (error) {
      if (error.code === '23505' && /driver_code/.test(error.constraint || '')) continue;
      if (error.code === '23505') return res.status(409).json({ error: 'Cet identifiant GPS est déjà utilisé dans votre entreprise.', field: 'trackerId' });
      console.error('Driver create error:', error.message);
      return res.status(500).json({ error: 'Impossible de créer ce livreur.' });
    }
  }
  return res.status(500).json({ error: 'Impossible de créer ce livreur. Réessayez.' });
}));

// Modification d'un livreur : profil, organisation, permissions. Un numéro
// modifié coupe l'accès à l'appli : la personne devra se reconnecter.
app.patch('/api/app/drivers/:id', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const parsed = driverProfileFields(req.body || {}, { partial: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error, field: parsed.field });
  const f = parsed.fields;
  if (req.body.active !== undefined) f.active = Boolean(req.body.active);
  if (f.traccar_unique_id === null) f.traccar_unique_id = `trx-${crypto.randomBytes(6).toString('hex')}`;
  if (!Object.keys(f).length) return res.status(400).json({ error: 'Aucune modification fournie.' });
  const current = (await pool.query('SELECT id, phone_digits FROM drivers WHERE id = $1 AND company_id = $2 AND archived_at IS NULL', [req.params.id, req.auth.company_id])).rows[0];
  if (!current) return res.status(404).json({ error: 'Livreur introuvable.' });
  if ('phone_digits' in f) {
    const duplicate = await duplicateDriverPhone(pool, req.auth.company_id, f.phone_digits, current.id);
    if (duplicate) return res.status(409).json({ error: `Ce numéro appartient déjà au profil de ${duplicate.name}.`, field: 'phone' });
  }
  const phoneChanged = 'phone_digits' in f && (f.phone_digits || null) !== (current.phone_digits || null);
  const columns = Object.keys(f);
  const values = columns.map((c) => f[c]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE drivers SET ${columns.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING id, name, phone, vehicle_type, capacity, traccar_unique_id, active, availability_status, driver_code`,
      [current.id, req.auth.company_id, ...values]
    );
    if (phoneChanged) await revokeDriverAccess(client, req.auth.company_id, current.id);
    await client.query('COMMIT');
    await writeAudit(req.auth, 'driver', current.id, 'updated', { phoneChanged });
    if (phoneChanged && f.phone_digits) await markDriverSeat(req.auth.company_id, current.id, f.phone_digits);
    return res.json({ ...result.rows[0], code: result.rows[0].driver_code, accessReset: phoneChanged });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'Cet identifiant GPS est déjà utilisé.', field: 'trackerId' });
    console.error('Driver update error:', error.message);
    return res.status(500).json({ error: 'Impossible de mettre à jour ce livreur.' });
  } finally {
    client.release();
  }
}));

// Suspendre : plus de missions ni d'accès à l'appli ; le profil et l'historique restent.
app.post('/api/app/drivers/:id/suspend', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const driver = (await pool.query(
    `SELECT d.id, d.name, (SELECT COUNT(*)::int FROM orders o WHERE o.driver_id = d.id AND o.company_id = d.company_id AND NOT (o.status = ANY($3::text[]))) AS open_orders
     FROM drivers d WHERE d.id = $1 AND d.company_id = $2 AND d.archived_at IS NULL`,
    [req.params.id, req.auth.company_id, terminalOrderStatuses]
  )).rows[0];
  if (!driver) return res.status(404).json({ error: 'Livreur introuvable.' });
  if (driver.open_orders > 0) {
    return res.status(409).json({ error: `${driver.name.split(/\s+/)[0]} a encore ${driver.open_orders} colis. Confiez-les à un autre livreur avant de suspendre son accès.`, openOrders: driver.open_orders });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE drivers SET active = FALSE, suspended_at = NOW(), availability_status = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2', [driver.id, req.auth.company_id, 'off_duty']);
    await revokeDriverAccess(client, req.auth.company_id, driver.id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await writeAudit(req.auth, 'driver', driver.id, 'suspended', {});
  return res.json({ id: driver.id, suspended: true });
}));

app.post('/api/app/drivers/:id/reactivate', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const result = await pool.query(
    `UPDATE drivers SET active = TRUE, suspended_at = NULL, availability_status = 'available', updated_at = NOW()
     WHERE id = $1 AND company_id = $2 AND archived_at IS NULL RETURNING id, phone_digits`,
    [req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Livreur introuvable.' });
  await writeAudit(req.auth, 'driver', result.rows[0].id, 'reactivated', {});
  await markDriverSeat(req.auth.company_id, result.rows[0].id, result.rows[0].phone_digits);
  return res.json({ id: result.rows[0].id, suspended: false });
}));

// ---- Invitation à l'appli (QR) -------------------------------------------------
const DRIVER_INVITE_MS = 15 * 60 * 1000;
const DRIVER_SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const inviteCodeAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  const bytes = crypto.randomBytes(8);
  return `TX-${Array.from(bytes).map((b) => inviteCodeAlphabet[b % inviteCodeAlphabet.length]).join('')}`;
}
app.post('/api/app/drivers/:id/invitation', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const driver = (await pool.query('SELECT id, name, phone, suspended_at FROM drivers WHERE id = $1 AND company_id = $2 AND archived_at IS NULL', [req.params.id, req.auth.company_id])).rows[0];
  if (!driver) return res.status(404).json({ error: 'Livreur introuvable.' });
  if (driver.suspended_at) return res.status(409).json({ error: 'Réactivez d’abord ce profil pour l’inviter.' });
  if (!driver.phone) return res.status(400).json({ error: 'Ajoutez d’abord le téléphone du livreur : il sert à vérifier son identité.', field: 'phone' });
  const token = randomToken(24);
  const code = newInviteCode();
  const expiresAt = new Date(Date.now() + DRIVER_INVITE_MS);
  const replacement = req.body?.replacement === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Une seule invitation valable à la fois : la nouvelle remplace QR, code et lien précédents.
    await revokeDriverAccess(client, req.auth.company_id, driver.id, { sessions: false, invitations: true });
    await client.query(
      `INSERT INTO driver_invitations (company_id, driver_id, token_hash, code_hash, replacement, expires_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.auth.company_id, driver.id, digest(token), digest(code), replacement, expiresAt, req.auth.user_id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await writeAudit(req.auth, 'driver', driver.id, 'invitation_created', { replacement });
  return res.status(201).json({
    url: `${publicBaseUrl(req)}/rejoindre/${token}`,
    path: `/rejoindre/${token}`,
    code,
    expiresAt,
    replacement,
    verification: whatsappAvailableFor(driver.phone) ? 'whatsapp' : 'in_person',
  });
}));
app.delete('/api/app/drivers/:id/invitation', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  await revokeDriverAccess(pool, req.auth.company_id, req.params.id, { sessions: false, invitations: true });
  await writeAudit(req.auth, 'driver', req.params.id, 'invitation_revoked', {});
  return res.json({ revoked: true });
}));

// ---- Rejoindre l'appli livreur (page ouverte depuis le QR) --------------------
const driverJoinRateLimit = createRateLimitMiddleware({
  keySecret: process.env.RATE_LIMIT_KEY_SECRET || trackingTokenSecret() || undefined,
  policies: [
    createIpPolicy({ limiter: trackingLimiter('driver_join_ip', { capacity: 40, refillTokens: 40, refillIntervalMs: 600_000, maxEntries: 10_000 }) }),
  ],
});
async function findDriverInvitation(ref, queryable = pool, { lock = false } = {}) {
  const value = String(ref || '').trim();
  if (!value || value.length > 128) return null;
  const isCode = /^TX-[A-Z0-9]{8}$/i.test(value);
  if (!isCode && !/^[A-Za-z0-9_-]{24,128}$/.test(value)) return null;
  const result = await queryable.query(
    `SELECT i.*, d.name AS driver_name, d.phone AS driver_phone, d.zone, d.team, d.suspended_at, d.archived_at,
            c.name AS company_name, c.logo_updated_at AS company_logo_at
     FROM driver_invitations i
     JOIN drivers d ON d.id = i.driver_id AND d.company_id = i.company_id
     JOIN companies c ON c.id = i.company_id
     WHERE ${isCode ? 'i.code_hash' : 'i.token_hash'} = $1 ${lock ? 'FOR UPDATE OF i' : ''}`,
    [digest(isCode ? value.toUpperCase() : value)]
  );
  return result.rows[0] || null;
}
function driverInvitationState(inv) {
  if (!inv) return 'invalid';
  if (inv.used_at) return 'used';
  if (inv.revoked_at) return 'revoked';
  if (new Date(inv.expires_at) <= new Date()) return 'expired';
  if (inv.suspended_at || inv.archived_at) return 'unavailable';
  return 'ready';
}
const joinMessages = {
  invalid: 'Ce lien ou ce code n’existe pas. Vérifiez-le, ou demandez un nouveau QR code à votre responsable.',
  used: 'Cette invitation a déjà été utilisée. Si c’est votre téléphone, ouvrez directement vos livraisons. Sinon, demandez un nouveau QR code.',
  revoked: 'Cette invitation a été remplacée ou annulée. Demandez le nouveau QR code à votre responsable.',
  expired: 'Cette invitation a expiré : elle n’est valable que 15 minutes. Demandez un nouveau QR code à votre responsable.',
  unavailable: 'Ce profil n’est plus actif dans l’entreprise. Rapprochez-vous de votre responsable.',
};

app.get(['/rejoindre', '/rejoindre/:ref'], (req, res) => sendShell(res, 'join.html'));

app.get('/api/public/driver-invitations/:ref', driverJoinRateLimit, asyncRoute(async (req, res) => {
  const inv = await findDriverInvitation(req.params.ref);
  const state = driverInvitationState(inv);
  if (state !== 'ready') return res.status(state === 'invalid' ? 404 : 410).json({ state, error: joinMessages[state] });
  return res.json({
    state,
    company: { name: inv.company_name, logoUrl: companyLogoUrl(inv.company_id, inv.company_logo_at) },
    driver: { firstName: String(inv.driver_name || '').split(/\s+/)[0], name: inv.driver_name, team: inv.team, zone: inv.zone },
    replacement: inv.replacement,
    phoneMasked: maskPhone(inv.driver_phone),
    verification: whatsappAvailableFor(inv.driver_phone) ? 'whatsapp' : 'in_person',
    expiresAt: inv.expires_at,
  });
}));

app.post('/api/public/driver-invitations/:ref/send-code', driverJoinRateLimit, asyncRoute(async (req, res) => {
  const inv = await findDriverInvitation(req.params.ref);
  const state = driverInvitationState(inv);
  if (state !== 'ready') return res.status(410).json({ state, error: joinMessages[state] });
  if (!whatsappAvailableFor(inv.driver_phone)) return res.json({ sent: false, verification: 'in_person' });
  if (inv.verify_sent_at && Date.now() - new Date(inv.verify_sent_at).getTime() < 45_000) {
    return res.status(429).json({ error: 'Un code vient de partir. Patientez quelques secondes avant d’en demander un autre.' });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query('UPDATE driver_invitations SET verify_code_hash = $2, verify_sent_at = NOW() WHERE id = $1', [inv.id, digest(`join:${inv.id}:${code}`)]);
  try {
    await whatsapp.sendText(inv.driver_phone, `*${code}* est votre code pour rejoindre ${inv.company_name} sur TRAXO.\n\nIl expire dans 10 minutes. Ne le communiquez à personne.`);
  } catch (error) {
    console.error('Driver join code failed:', error.code || error.message);
    return res.status(502).json({ error: 'Le code n’a pas pu partir sur WhatsApp. Réessayez dans un instant ou demandez de l’aide à votre responsable.' });
  }
  return res.json({ sent: true, phoneMasked: maskPhone(inv.driver_phone) });
}));

app.post('/api/public/driver-invitations/:ref/accept', driverJoinRateLimit, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    const inv = await findDriverInvitation(req.params.ref, client, { lock: true });
    const state = driverInvitationState(inv);
    if (state !== 'ready') { await client.query('ROLLBACK'); return res.status(410).json({ state, error: joinMessages[state] }); }
    // Vérification du numéro quand le canal WhatsApp est relié ; sinon, le QR
    // montré en personne par le responsable fait foi (usage unique, 15 min).
    if (whatsappAvailableFor(inv.driver_phone)) {
      const code = String(req.body?.code || '').replace(/\D/g, '');
      const fresh = inv.verify_sent_at && Date.now() - new Date(inv.verify_sent_at).getTime() < 10 * 60 * 1000;
      const ok = fresh && inv.verify_code_hash && code.length === 6 && crypto.timingSafeEqual(Buffer.from(digest(`join:${inv.id}:${code}`)), Buffer.from(inv.verify_code_hash));
      if (!ok) {
        const attempts = inv.verify_attempts + 1;
        await client.query(`UPDATE driver_invitations SET verify_attempts = $2${attempts >= 5 ? ', revoked_at = NOW()' : ''} WHERE id = $1`, [inv.id, attempts]);
        await client.query('COMMIT');
        if (attempts >= 5) return res.status(423).json({ state: 'revoked', error: 'Trop d’essais : cette invitation est annulée. Demandez un nouveau QR code à votre responsable.' });
        return res.status(400).json({ error: !fresh ? 'Ce code a expiré. Demandez-en un nouveau.' : 'Ce code ne correspond pas. Vérifiez le message reçu sur WhatsApp.', attemptsLeft: 5 - attempts });
      }
    }
    let userId = (await client.query(
      `SELECT user_id FROM company_memberships WHERE company_id = $1 AND driver_id = $2 AND role = 'driver' ORDER BY id LIMIT 1`,
      [inv.company_id, inv.driver_id]
    )).rows[0]?.user_id;
    if (!userId) {
      // Compte sans e-mail réel : le livreur se connecte avec son téléphone associé, pas par mot de passe.
      const salt = crypto.randomBytes(16).toString('hex');
      const email = `livreur-${inv.company_id}-${inv.driver_id}-${crypto.randomBytes(4).toString('hex')}@livreurs.traxo.invalid`;
      userId = (await client.query(
        `INSERT INTO users (email, display_name, password_salt, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, inv.driver_name, salt, hashPassword(crypto.randomBytes(32).toString('hex'), salt)]
      )).rows[0].id;
      await client.query(
        `INSERT INTO company_memberships (company_id, user_id, role, driver_id) VALUES ($1, $2, 'driver', $3)`,
        [inv.company_id, userId, inv.driver_id]
      );
    }
    // Un seul téléphone actif par livreur : l'ancien est déconnecté maintenant.
    await revokeDriverAccess(client, inv.company_id, inv.driver_id, { sessions: true, invitations: false });
    await client.query('UPDATE driver_invitations SET used_at = NOW() WHERE id = $1', [inv.id]);
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES ($1, $2, 'driver', $3, 'app_joined', jsonb_build_object('replacement', $4::boolean))`,
      [inv.company_id, userId, inv.driver_id, inv.replacement]
    );
    await client.query('COMMIT');
    result = { userId, companyId: inv.company_id, driverId: inv.driver_id, companyName: inv.company_name, firstName: String(inv.driver_name || '').split(/\s+/)[0] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Driver join error:', error.message);
    return res.status(500).json({ error: 'Impossible de terminer l’association. Réessayez.' });
  } finally {
    client.release();
  }
  await createSession(req, res, result.userId, result.companyId, 'company', { durationMs: DRIVER_SESSION_MS });
  await markDriverSeat(result.companyId, result.driverId);
  return res.status(201).json({ joined: true, redirect: '/driver', companyName: result.companyName, firstName: result.firstName });
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
  if (!match || !driverPhotoMimes[match[1]]) return res.status(400).json({ error: 'Choisissez une image au format JPEG, PNG ou WebP.' });
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

// Logo de l'entreprise : même contrôle que les photos de livreurs (data URL,
// JPEG/PNG/WebP, 600 Ko max). Servi publiquement (image de marque affichée
// sur les pages client), sans aucune donnée personnelle.
function companyLogoUrl(companyId, updatedAt) {
  return updatedAt && companyId ? `/brand/logo/${encodeURIComponent(companyId)}?v=${new Date(updatedAt).getTime()}` : null;
}

app.post('/api/app/company/logo', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  const dataUrl = String(req.body.dataUrl || '');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || !driverPhotoMimes[match[1]]) return res.status(400).json({ error: 'Choisissez une image au format JPEG, PNG ou WebP.' });
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < 64 || buffer.length > 600 * 1024) return res.status(400).json({ error: 'Image trop lourde (max 600 Ko) ou vide.' });
  if (detectImageMime(buffer) !== match[1]) return res.status(400).json({ error: 'Le contenu du fichier ne correspond pas à une image valide.' });
  const result = await pool.query(
    `UPDATE companies SET logo_data = $1, logo_mime = $2, logo_updated_at = NOW(), updated_at = NOW()
     WHERE id = $3 RETURNING id, logo_updated_at`,
    [buffer, match[1], req.auth.company_id]
  );
  await writeAudit(req.auth, 'company', req.auth.company_id, 'logo_updated', {});
  return res.json({ logoUrl: companyLogoUrl(result.rows[0].id, result.rows[0].logo_updated_at) });
}));

app.delete('/api/app/company/logo', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
  await pool.query(
    'UPDATE companies SET logo_data = NULL, logo_mime = NULL, logo_updated_at = NULL, updated_at = NOW() WHERE id = $1',
    [req.auth.company_id]
  );
  await writeAudit(req.auth, 'company', req.auth.company_id, 'logo_removed', {});
  return res.json({ logoUrl: null });
}));

app.get('/brand/logo/:companyId', asyncRoute(async (req, res) => {
  if (!/^\d{1,18}$/.test(req.params.companyId) || !pool) return res.status(404).end();
  const result = await pool.query('SELECT logo_data, logo_mime FROM companies WHERE id = $1', [req.params.companyId]);
  const row = result.rows[0];
  if (!row || !row.logo_data) return res.status(404).end();
  res.set({
    'Content-Type': row.logo_mime || 'image/png',
    'Cache-Control': 'public, max-age=604800, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  return res.end(row.logo_data);
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
  if (!Number.isFinite(from) || !Number.isFinite(to)) return res.status(400).json({ error: 'Période incorrecte : vérifiez les dates de début et de fin.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
    return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
    return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
    return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
    return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
      throw Object.assign(new Error(`Impossible de passer la tournée de « ${runStatusLabelsFr[run.status] || run.status} » à « ${runStatusLabelsFr[toStatus] || toStatus} ».`), { statusCode: 409 });
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
    allowedTransitions: allowedOrderTransitions(order.status, order),
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
    return res.status(400).json({ error: 'Choisissez une durée comprise entre 1 et 30 jours.' });
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return res.status(400).json({ error: 'Rechargez la commande puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
  if (reason.length < 8 || reason.length > 500) {
    return res.status(400).json({ error: 'Expliquez la révocation en 8 à 500 caractères.' });
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return res.status(400).json({ error: 'Rechargez la commande puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
  if (!Object.prototype.hasOwnProperty.call(orderTransitions, toStatus)) {
    return res.status(400).json({ error: 'Cette étape n’est pas possible pour cette commande.' });
  }
  if (reasonRequiredStatuses.includes(toStatus) && reason.length < 5) {
    return res.status(400).json({ error: 'Expliquez la raison en au moins 5 caractères.' });
  }
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), toStatus, reason }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status, version, driver_id, pickup_name, pickup_address, pickup_lat FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
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
    if (!allowedOrderTransitions(order.status, order).includes(toStatus)) {
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
    if (['En livraison', 'Arrivée'].includes(toStatus)) recordEtaSample(order.id, req.auth.company_id, toStatus, order.driver_id);
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (!/^\d+$/.test(assignedToUserId) || !idempotencyKey) return res.status(400).json({ error: 'Choisissez un responsable, puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  const company = await pool.query('SELECT id, name, slug, timezone FROM companies WHERE id = $1', [req.auth.company_id]);
  const format = req.query.format === 'json' ? 'json' : 'pdf';
  const { timezone, ...companyInfo } = company.rows[0];
  company.rows[0] = companyInfo;
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
    incidentId: dossier.incident.id, manifestSha256, eventChainValid: dossier.eventChainValid, format,
  });
  if (format === 'pdf') {
    const pdf = await buildIncidentPdf({
      dossier, company: companyInfo, generatedBy: req.auth.display_name, generatedAt, manifestSha256, timezone: timezone || 'Africa/Porto-Novo',
    });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="TRAXO-incident-INC-${dossier.incident.id}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(pdf);
  }
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
  if (currency !== 'XOF') return res.status(400).json({ error: 'Seuls les montants en franc CFA (FCFA) sont acceptés pour le moment.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
    return res.status(500).json({ error: 'Impossible de demander un paiement pour cette commande.' });
  } finally {
    client.release();
  }
}));

app.post('/api/app/orders/:id/payment/remove', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (reason.length < 5) return res.status(400).json({ error: 'Expliquez pourquoi l’encaissement n’est plus requis.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (amount === null || !paymentMethods.includes(method)) return res.status(400).json({ error: 'Indiquez un montant supérieur à zéro et un moyen de paiement.' });
  if (discrepancyReason.length > 1000) return res.status(400).json({ error: 'Le motif de l’écart est trop long.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
    return res.status(400).json({ error: 'Vérifiez le type de correction, le montant et le moyen de paiement.' });
  }
  if (reason.length < 10 || reason.length > 1000) return res.status(400).json({ error: 'Expliquez l’ajustement en 10 à 1 000 caractères.' });
  if (!effectiveDate || effectiveDate > pilotLocalDate()) return res.status(400).json({ error: 'Choisissez la date du jour ou une date passée.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  if (!effectiveDate || effectiveDate > pilotLocalDate()) return res.status(400).json({ error: 'Choisissez la date du jour ou une date passée.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Cette action n’a pas pu être enregistrée. Rechargez la page puis réessayez.' });
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
  const { driverId } = req.body;
  // Champs structurés (nouvelle saisie) ou adresse libre (ancienne saisie, API).
  const structured = prefilledFieldsFromBody(req.body || {});
  const customerName = structured.customerName;
  const deliveryAddress = String(req.body.deliveryAddress || '').trim()
    || [structured.neighborhood, structured.landmark, structured.notes].filter(Boolean).join(' — ');
  let customerPhone = String(req.body.customerPhone || '').trim() || null;
  if (customerPhone && req.body.customerPhoneCountry) {
    customerPhone = normalizeCustomerPhone(req.body);
    if (!customerPhone) return res.status(400).json({ error: INVALID_PHONE_MESSAGE, field: 'customerPhone' });
  }
  if (!customerName || !deliveryAddress || !driverId) {
    return res.status(400).json({ error: 'Nom client, lieu de livraison et livreur sont obligatoires.' });
  }
  if (!(await companyDeliverySetting(req.auth.company_id, 'internalEntryEnabled'))) {
    return res.status(403).json({ error: 'La saisie interne est désactivée dans vos paramètres Livraisons.' });
  }
  const pickup = pickupFieldsFromBody(req.body || {});
  if (pickup.error) return res.status(400).json({ error: pickup.error, field: pickup.field });
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
      `INSERT INTO orders (company_id, driver_id, customer_name, customer_phone, delivery_address,
         neighborhood, landmark, notes, requested_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Confirmée') RETURNING id`,
      [req.auth.company_id, driver.rows[0].id, customerName, customerPhone || null, deliveryAddress,
        structured.neighborhood, structured.landmark, structured.notes, structured.requestedTime]
    );
    await savePickupFields(client, 'orders', order.rows[0].id, req.auth.company_id, pickup.fields);
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
    markDriverSeat(req.auth.company_id, driver.rows[0].id);
    committed = true;
    return res.status(201).json({
      orderId: order.rows[0].id,
      customerPhone,
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

// ---- Accès à une demande client, lié à l'appareil qui l'a remplie ---------
// Le lien /demande/:token ne sert qu'à REMPLIR le formulaire une fois. À l'envoi,
// le navigateur reçoit un secret dans un cookie HttpOnly + SameSite=Strict,
// limité au chemin de cette demande ; aucun secret ne transite plus par l'URL.
// Un autre appareil qui ouvre le même lien ne voit donc aucune donnée.
// (W3C TAG « Good Practices for Capability URLs », OWASP Session Management.)
const REQUEST_DEVICE_COOKIE = 'traxo_req';
const REQUEST_DEVICE_MAX_AGE_S = 60 * 24 * 3600;
const PUBLIC_REQUEST_PAGE_HEADERS = { 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };

function setRequestDeviceCookie(req, res, token, secret) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', `${REQUEST_DEVICE_COOKIE}=${encodeURIComponent(secret)}; Path=/api/public/requests/${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Max-Age=${REQUEST_DEVICE_MAX_AGE_S}${secure ? '; Secure' : ''}`);
}

function requestDeviceSecret(req) {
  return String(parseCookies(req)[REQUEST_DEVICE_COOKIE] || '');
}

// Téléphone : indicatif choisi + numéro → format international validé
// (métadonnées libphonenumber : Bénin à 10 chiffres « 01… » depuis 2024).
function normalizeCustomerPhone(body) {
  const raw = String(body.customerPhone || '').trim();
  const country = /^[A-Z]{2}$/.test(String(body.customerPhoneCountry || '')) ? String(body.customerPhoneCountry) : 'BJ';
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, country);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.formatInternational();
}
const INVALID_PHONE_MESSAGE = 'Numéro de téléphone invalide. Vérifiez l’indicatif et le numéro (au Bénin : 10 chiffres commençant par 01).';

function phoneParts(stored) {
  const parsed = parsePhoneNumberFromString(String(stored || ''), 'BJ');
  return parsed && parsed.country
    ? { country: parsed.country, national: parsed.formatNational() }
    : { country: 'BJ', national: String(stored || '') };
}

// Coordonnées GPS obligatoires pour envoyer ou modifier une demande client.
function requestGpsFromBody(body) {
  const lat = optionalNumber(body.locationLat);
  const lng = optionalNumber(body.locationLng);
  if (lat == null || lng == null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const accuracy = optionalNumber(body.locationAccuracy);
  return { lat, lng, accuracy: accuracy != null && accuracy >= 0 ? accuracy : null };
}

// Type réel de l'image d'après sa signature : le Content-Type n'est pas fiable.
function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function sendRequestPhoto(res, photo) {
  res.set({
    'Content-Type': photo.mime,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  return res.end(photo.data);
}

const numericIdPattern = /^\d{1,18}$/;

// Étape affichée au client, calculée ici pour rester cohérente entre les pages.
function publicRequestStage(row) {
  if (row.order_id) {
    if (row.order_status === 'Livrée') return 'delivered';
    if (['Retournée', 'Annulée'].includes(row.order_status)) return 'closed';
    return 'assigned';
  }
  if (row.status === PREFILLED_REQUEST_STATUS) return row.archived_at ? 'closed' : 'to_confirm';
  if (row.status === 'Refusée') return 'refused';
  if (row.status === 'Archivée' || row.archived_at) return 'closed';
  if (row.status === 'Validée' || row.status === 'Confirmée') return 'validated';
  if (editableRequestStatuses.includes(row.status)) return 'received';
  return 'pending';
}

const rawPhotoParser = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: REQUEST_PHOTO_MAX_BYTES });
function requestPhotoBody(req, res, next) {
  rawPhotoParser(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.status === 413 || error.type === 'entity.too.large';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Photo trop lourde (700 Ko maximum).' : 'Envoi de la photo invalide.' });
  });
}

async function editableRequestForPhotos(token, deviceSecret) {
  if (!deviceSecret) return null;
  const result = await pool.query(
    `SELECT id, company_id FROM customer_requests
     WHERE token = $1 AND edit_token_hash = $2 AND ${publicEditableSql.replace('$EDIT', '$3')} AND archived_at IS NULL`,
    [token, digest(deviceSecret), editableRequestStatuses]
  );
  return result.rows[0] || null;
}

app.post('/api/public/requests/:token', publicRequestRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const { customerName, customerPhone, requestedTime, neighborhood, landmark, notes } = req.body;
  if (!customerName || !customerPhone || !neighborhood) {
    return res.status(400).json({ error: 'Nom, téléphone et zone sont obligatoires.' });
  }
  const phone = normalizeCustomerPhone(req.body);
  if (!phone) return res.status(400).json({ error: INVALID_PHONE_MESSAGE, field: 'customerPhone' });
  const gps = requestGpsFromBody(req.body);
  if (!gps) return res.status(400).json({ error: 'Partagez votre position GPS pour envoyer votre demande.' });
  const owning = await pool.query('SELECT company_id FROM customer_requests WHERE token = $1', [req.params.token]);
  if (owning.rows[0] && !(await companyDeliverySetting(owning.rows[0].company_id, 'customerFormEnabled'))) {
    return res.status(403).json({ error: 'Ce formulaire n’est plus actif.' });
  }
  const verifyFirst = owning.rows[0] ? await companyDeliverySetting(owning.rows[0].company_id, 'manualValidation') : true;
  const editToken = randomToken(24);
  const result = await pool.query(
    `UPDATE customer_requests
     SET status = CASE WHEN $12 THEN 'À vérifier' ELSE 'Validée' END,
         validated_at = CASE WHEN $12 THEN validated_at ELSE NOW() END,
         customer_name = $1, customer_phone = $2,
         requested_time = $3, location_lat = $4, location_lng = $5, location_accuracy = $6,
         location_at = NOW(),
         neighborhood = $7, landmark = $8, notes = $9,
         edit_token_hash = $10, submitted_at = NOW(), updated_at = NOW(), version = version + 1
     WHERE token = $11 AND status = 'En attente d’informations'
       AND (expires_at IS NULL OR expires_at > NOW())
     RETURNING id, company_id, version`,
    [
      String(customerName).trim(), phone, requestedTime || null,
      gps.lat, gps.lng, gps.accuracy,
      String(neighborhood).trim(), landmark || null, notes || null, digest(editToken), req.params.token, verifyFirst,
    ]
  );
  if (!result.rows[0]) return res.status(409).json({ error: 'Ce formulaire a déjà été envoyé ou a expiré.' });
  await writeAudit({ company_id: result.rows[0].company_id, user_id: null }, 'customer_request', result.rows[0].id, verifyFirst ? 'submitted' : 'submitted_auto_validated');
  // Le secret reste dans ce navigateur (cookie HttpOnly), jamais dans l'URL.
  setRequestDeviceCookie(req, res, req.params.token, editToken);
  const redirect = `/demande/${encodeURIComponent(req.params.token)}/confirmation`;
  return res.json({ status: 'received', message: 'Merci. L’entreprise va vérifier votre demande.', redirect });
}));

app.get('/api/public/requests/:token', publicRequestRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const result = await pool.query(
    `SELECT r.id, r.status, r.customer_name, r.customer_phone, r.requested_time, r.location_lat, r.location_lng,
            r.location_accuracy, r.neighborhood, r.landmark, r.notes, r.submitted_at, r.updated_at,
            r.validated_at, r.archived_at, r.edit_token_hash, r.version, r.expires_at, r.confirm_attempts, r.confirm_locked_at,
            c.name AS company_name, c.id AS company_ref, c.logo_updated_at AS company_logo_at,
            o.id AS order_id, o.status AS order_status, o.status_changed_at AS order_status_changed_at,
            d.name AS driver_name, d.vehicle_type AS driver_vehicle_type,
            t.token AS tracking_token, t.token_ciphertext AS tracking_token_ciphertext,
            t.expires_at AS tracking_expires_at, t.revoked_at AS tracking_revoked_at,
            t.created_at AS tracking_created_at, t.version AS tracking_link_version,
            (SELECT COALESCE(json_agg(p.id ORDER BY p.id), '[]'::json)
               FROM customer_request_photos p WHERE p.request_id = r.id) AS photo_ids
     FROM customer_requests r
     JOIN companies c ON c.id = r.company_id
     LEFT JOIN orders o ON o.customer_request_id = r.id
     LEFT JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN tracking_links t ON t.order_id = o.id
     WHERE r.token = $1`,
    [req.params.token]
  );
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: 'Demande introuvable.' });
  res.set('Cache-Control', 'private, no-store');
  const stage = publicRequestStage(row);
  // Formulaire pas encore rempli : rien de personnel à protéger.
  if (stage === 'pending') return res.json({ stage, companyName: row.company_name, companyLogoUrl: companyLogoUrl(row.company_ref, row.company_logo_at) });
  if (stage === 'to_confirm') {
    const expired = row.expires_at && new Date(row.expires_at) <= new Date();
    const confirmOk = Boolean(row.edit_token_hash && requestDeviceSecret(req) && digest(requestDeviceSecret(req)) === row.edit_token_hash);
    const brand = { stage, companyName: row.company_name, companyLogoUrl: companyLogoUrl(row.company_ref, row.company_logo_at) };
    if (expired) return res.json({ ...brand, stage: 'expired' });
    if (!confirmOk) {
      return res.json({
        ...brand,
        locked: Boolean(row.confirm_locked_at),
        attemptsLeft: Math.max(0, PREFILLED_CONFIRM_MAX_ATTEMPTS - Number(row.confirm_attempts || 0)),
        needsCode: true,
      });
    }
    const split = phoneParts(row.customer_phone);
    return res.json({
      ...brand,
      needsCode: false,
      id: row.id,
      customer_name: row.customer_name,
      phone_country: split.country,
      phone_national: split.national,
      neighborhood: row.neighborhood,
      landmark: row.landmark,
      notes: row.notes,
      requested_time: row.requested_time,
      expiresAt: row.expires_at,
    });
  }
  let deviceOk = Boolean(row.edit_token_hash && requestDeviceSecret(req)
    && digest(requestDeviceSecret(req)) === row.edit_token_hash);
  // Anciens liens « ?edit=… » (avant ce changement) : échange UNIQUE contre un
  // cookie, avec un nouveau secret. Le lien copié devient ensuite inutile.
  const legacyToken = String(req.query.edit || '');
  if (!deviceOk && legacyToken && row.edit_token_hash && digest(legacyToken) === row.edit_token_hash) {
    const fresh = randomToken(24);
    const swapped = await pool.query(
      'UPDATE customer_requests SET edit_token_hash = $1 WHERE id = $2 AND edit_token_hash = $3 RETURNING id',
      [digest(fresh), row.id, digest(legacyToken)]
    );
    if (swapped.rows[0]) {
      setRequestDeviceCookie(req, res, req.params.token, fresh);
      deviceOk = true;
    }
  }
  // Autre appareil : la demande existe, mais ses données ne sont pas montrées.
  if (!deviceOk) return res.json({ stage: 'other_device', companyName: row.company_name, companyLogoUrl: companyLogoUrl(row.company_ref, row.company_logo_at) });
  const canEdit = !row.archived_at && !row.order_id && (editableRequestStatuses.includes(row.status)
    || (row.status === 'Validée' && await companyDeliverySetting(row.company_ref, 'allowEditAfterValidation')));
  // Le client garde le même lien : dès qu'un livreur est affecté, sa page de
  // demande lui donne accès au suivi (détenir ce lien suffit déjà à voir la demande).
  let trackingPath = null;
  if (row.order_id) {
    const link = trackingLinkBusinessView({ ...row, status: row.order_status }, true);
    if (['active', 'terminal'].includes(link.state)) trackingPath = link.path;
  }
  const phoneSplit = phoneParts(row.customer_phone);
  return res.json({
    id: row.id,
    status: row.status,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    phone_country: phoneSplit.country,
    phone_national: phoneSplit.national,
    requested_time: row.requested_time,
    location_lat: row.location_lat,
    location_lng: row.location_lng,
    location_accuracy: row.location_accuracy,
    neighborhood: row.neighborhood,
    landmark: row.landmark,
    notes: row.notes,
    submitted_at: row.submitted_at,
    updated_at: row.updated_at,
    validated_at: row.validated_at,
    version: row.version,
    companyName: row.company_name,
    companyLogoUrl: companyLogoUrl(row.company_ref, row.company_logo_at),
    stage,
    canEdit,
    photoIds: row.photo_ids || [],
    photoMax: REQUEST_PHOTO_MAX,
    order: row.order_id ? {
      status: row.order_status,
      statusChangedAt: row.order_status_changed_at,
      driver: row.driver_name ? { name: row.driver_name, vehicleType: row.driver_vehicle_type } : null,
      trackingPath,
    } : null,
  });
}));

// Le client prouve qu'il est le destinataire : 4 derniers chiffres de son numéro.
app.post('/api/public/requests/:token/unlock', publicRequestRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const code = String((req.body || {}).code || '').replace(/\D/g, '');
  if (code.length !== 4) return res.status(400).json({ error: 'Saisissez les 4 derniers chiffres de votre numéro.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, company_id, customer_phone, confirm_attempts, confirm_locked_at, expires_at FROM customer_requests
       WHERE token = $1 AND status = $2 AND archived_at IS NULL FOR UPDATE`,
      [req.params.token, PREFILLED_REQUEST_STATUS]
    );
    const row = found.rows[0];
    if (!row || (row.expires_at && new Date(row.expires_at) <= new Date())) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ce lien est introuvable ou a expiré.' });
    }
    if (row.confirm_locked_at) {
      await client.query('ROLLBACK');
      return res.status(423).json({ error: 'Trop d’essais. Pour votre sécurité, ce lien est bloqué : contactez l’entreprise pour en recevoir un nouveau.', locked: true });
    }
    const expected = Buffer.from(phoneLastDigits(row.customer_phone));
    const given = Buffer.from(code);
    const ok = expected.length === 4 && crypto.timingSafeEqual(expected, given);
    if (!ok) {
      const attempts = Number(row.confirm_attempts || 0) + 1;
      const lock = attempts >= PREFILLED_CONFIRM_MAX_ATTEMPTS;
      await client.query('UPDATE customer_requests SET confirm_attempts = $1, confirm_locked_at = CASE WHEN $2 THEN NOW() ELSE confirm_locked_at END WHERE id = $3', [attempts, lock, row.id]);
      await client.query('COMMIT');
      if (lock) await writeAudit({ company_id: row.company_id, user_id: null }, 'customer_request', row.id, 'confirm_locked');
      return res.status(lock ? 423 : 400).json({
        error: lock ? 'Trop d’essais. Pour votre sécurité, ce lien est bloqué : contactez l’entreprise pour en recevoir un nouveau.' : 'Ces chiffres ne correspondent pas au numéro enregistré.',
        locked: lock,
        attemptsLeft: Math.max(0, PREFILLED_CONFIRM_MAX_ATTEMPTS - attempts),
      });
    }
    const secret = randomToken(24);
    await client.query('UPDATE customer_requests SET edit_token_hash = $1, confirm_attempts = 0 WHERE id = $2', [digest(secret), row.id]);
    await client.query('COMMIT');
    await writeAudit({ company_id: row.company_id, user_id: null }, 'customer_request', row.id, 'confirm_unlocked');
    setRequestDeviceCookie(req, res, req.params.token, secret);
    return res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

// Confirmation par le client : informations vérifiées, position partagée ou non.
app.post('/api/public/requests/:token/confirm', publicRequestRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const secret = requestDeviceSecret(req);
  if (!secret) return res.status(403).json({ error: 'Rouvrez le lien et saisissez les 4 derniers chiffres de votre numéro.' });
  const body = req.body || {};
  const fields = prefilledFieldsFromBody(body);
  if (!fields.customerName || fields.customerName.length < 2 || !fields.neighborhood) {
    return res.status(400).json({ error: 'Votre nom et votre quartier sont obligatoires.' });
  }
  const phone = normalizeCustomerPhone(body);
  if (!phone) return res.status(400).json({ error: INVALID_PHONE_MESSAGE, field: 'customerPhone' });
  const share = body.shareLocation === true;
  const gps = share ? requestGpsFromBody(body) : null;
  if (share && !gps) return res.status(400).json({ error: 'Votre position n’a pas pu être lue. Réessayez ou continuez sans la partager.' });
  const result = await pool.query(
    `UPDATE customer_requests
     SET status = 'Validée', validated_at = NOW(), customer_confirmed_at = NOW(), submitted_at = NOW(),
         customer_name = $1, customer_phone = $2, neighborhood = $3, landmark = $4, notes = $5, requested_time = $6,
         location_lat = $7, location_lng = $8, location_accuracy = $9,
         location_at = CASE WHEN $7::double precision IS NULL THEN NULL ELSE NOW() END,
         version = version + 1, updated_at = NOW()
     WHERE token = $10 AND edit_token_hash = $11 AND status = $12 AND archived_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     RETURNING id, company_id`,
    [fields.customerName, phone, fields.neighborhood, fields.landmark, fields.notes, fields.requestedTime,
      gps ? gps.lat : null, gps ? gps.lng : null, gps ? gps.accuracy : null,
      req.params.token, digest(secret), PREFILLED_REQUEST_STATUS]
  );
  if (!result.rows[0]) return res.status(409).json({ error: 'Cette commande a déjà été confirmée ou le lien a expiré.' });
  await writeAudit({ company_id: result.rows[0].company_id, user_id: null }, 'customer_request', result.rows[0].id, 'customer_confirmed', { locationShared: Boolean(gps) });
  return res.json({ status: 'confirmed', redirect: `/demande/${encodeURIComponent(req.params.token)}/confirmation` });
}));

app.put('/api/public/requests/:token', publicRequestRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const editToken = requestDeviceSecret(req);
  if (!editToken) return res.status(403).json({ error: 'Cette demande ne peut être modifiée que depuis l’appareil qui l’a envoyée.' });
  const { customerName, customerPhone, requestedTime, neighborhood, landmark, notes, version } = req.body;
  if (!customerName || !customerPhone || !neighborhood || !Number.isInteger(Number(version))) {
    return res.status(400).json({ error: 'Informations de modification incomplètes.' });
  }
  const phone = normalizeCustomerPhone(req.body);
  if (!phone) return res.status(400).json({ error: INVALID_PHONE_MESSAGE, field: 'customerPhone' });
  const gps = requestGpsFromBody(req.body);
  if (!gps) return res.status(400).json({ error: 'Votre position GPS est requise.' });
  const result = await pool.query(
    `UPDATE customer_requests
     SET customer_name = $1, customer_phone = $2, requested_time = $3,
         location_at = CASE WHEN location_lat IS DISTINCT FROM $4::double precision
                              OR location_lng IS DISTINCT FROM $5::double precision THEN NOW() ELSE location_at END,
         location_lat = $4, location_lng = $5, location_accuracy = $6,
         neighborhood = $7, landmark = $8, notes = $9, version = version + 1, updated_at = NOW()
     WHERE token = $10 AND edit_token_hash = $11 AND version = $12 AND ${publicEditableSql.replace('$EDIT', '$13')} AND archived_at IS NULL
     RETURNING id, company_id, version`,
    [
      String(customerName).trim(), phone, requestedTime || null,
      gps.lat, gps.lng, gps.accuracy,
      String(neighborhood).trim(), landmark || null, notes || null,
      req.params.token, digest(editToken), Number(version), editableRequestStatuses,
    ]
  );
  if (!result.rows[0]) return res.status(409).json({ error: 'La demande a été validée ou modifiée ailleurs. Rechargez la page.' });
  await writeAudit({ company_id: result.rows[0].company_id, user_id: null }, 'customer_request', result.rows[0].id, 'customer_updated');
  return res.json({ message: 'Vos informations ont été mises à jour.', version: result.rows[0].version });
}));

// Photos du lieu (facultatives, 3 maximum), envoyées une à une en binaire.
app.post('/api/public/requests/:token/photos', publicRequestRateLimit, requestPhotoBody, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  const request = await editableRequestForPhotos(req.params.token, requestDeviceSecret(req));
  if (!request) return res.status(403).json({ error: 'Les photos ne sont plus modifiables pour cette demande.' });
  const buffer = req.body;
  const mime = detectImageMime(buffer);
  if (!mime) return res.status(400).json({ error: 'Choisissez une image au format JPEG, PNG ou WebP.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verrou sur la demande : deux envois simultanés ne dépassent pas le plafond.
    await client.query('SELECT id FROM customer_requests WHERE id = $1 FOR UPDATE', [request.id]);
    const count = await client.query('SELECT COUNT(*)::int AS n FROM customer_request_photos WHERE request_id = $1', [request.id]);
    if (count.rows[0].n >= REQUEST_PHOTO_MAX) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `${REQUEST_PHOTO_MAX} photos maximum.` });
    }
    const inserted = await client.query(
      `INSERT INTO customer_request_photos (request_id, company_id, mime, data, byte_size)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [request.id, request.company_id, mime, buffer, buffer.length]
    );
    await client.query('UPDATE customer_requests SET updated_at = NOW() WHERE id = $1', [request.id]);
    await client.query('COMMIT');
    await writeAudit({ company_id: request.company_id, user_id: null }, 'customer_request', request.id, 'photo_added');
    return res.status(201).json({ id: inserted.rows[0].id });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/public/requests/:token/photos/:photoId', publicRequestRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Service momentanément indisponible.' });
  if (!numericIdPattern.test(req.params.photoId)) return res.status(404).json({ error: 'Photo introuvable.' });
  const request = await editableRequestForPhotos(req.params.token, requestDeviceSecret(req));
  if (!request) return res.status(403).json({ error: 'Les photos ne sont plus modifiables pour cette demande.' });
  const result = await pool.query(
    'DELETE FROM customer_request_photos WHERE id = $1 AND request_id = $2 RETURNING id',
    [req.params.photoId, request.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Photo introuvable.' });
  await writeAudit({ company_id: request.company_id, user_id: null }, 'customer_request', request.id, 'photo_removed');
  return res.json({ deleted: true });
}));

app.get('/api/public/requests/:token/photos/:photoId', publicRequestRateLimit, asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).end();
  if (!numericIdPattern.test(req.params.photoId)) return res.status(404).end();
  const secret = requestDeviceSecret(req);
  if (!secret) return res.status(404).end();
  const result = await pool.query(
    `SELECT p.mime, p.data FROM customer_request_photos p
     JOIN customer_requests r ON r.id = p.request_id
     WHERE p.id = $1 AND r.token = $2 AND r.edit_token_hash = $3`,
    [req.params.photoId, req.params.token, digest(secret)]
  );
  if (!result.rows[0]) return res.status(404).end();
  return sendRequestPhoto(res, result.rows[0]);
}));


// Étapes horodatées affichées au client (première occurrence de chaque statut).
// ---- Estimation d'arrivée ----------------------------------------------------
const etaLearnedCache = new Map();
async function etaLearned(companyId) {
  const hit = etaLearnedCache.get(companyId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  let value = {};
  try {
    const [service, traffic] = await Promise.all([
      pool.query(
        `SELECT EXTRACT(EPOCH FROM (l.at - a.at))::float AS s FROM
           (SELECT order_id, MIN(created_at) AS at FROM order_status_events WHERE company_id = $1 AND to_status = 'Arrivée' AND created_at > NOW() - INTERVAL '60 days' GROUP BY order_id) a
         JOIN (SELECT order_id, MIN(created_at) AS at FROM order_status_events WHERE company_id = $1 AND to_status = 'Livrée' AND created_at > NOW() - INTERVAL '60 days' GROUP BY order_id) l
           ON l.order_id = a.order_id AND l.at > a.at
         LIMIT 400`,
        [companyId]
      ),
      pool.query(
        `SELECT actual_seconds::float / predicted_seconds AS f FROM eta_samples
         WHERE company_id = $1 AND actual_seconds IS NOT NULL AND predicted_seconds >= 120
           AND completed_at > NOW() - INTERVAL '60 days' AND actual_seconds BETWEEN 60 AND 14400
         ORDER BY completed_at DESC LIMIT 400`,
        [companyId]
      ),
    ]);
    value = learnedParameters({
      serviceSamples: service.rows.map((r) => Number(r.s)).filter((x) => x > 0 && x < 3600),
      trafficSamples: traffic.rows.map((r) => Number(r.f)),
    });
  } catch (error) {
    console.error('ETA learning failed:', error.message);
  }
  etaLearnedCache.set(companyId, { at: Date.now(), value });
  return value;
}

const PRE_PICKUP = ['En préparation', 'Confirmée', 'Vers la collecte'];
const validPoint = (lat, lng) => lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) ? { lat: Number(lat), lng: Number(lng) } : null;
// Arrêts encore à faire avant cette commande dans la tournée du livreur, avec
// les collectes non encore faites (dans l'ordre prévu).
async function orderEtaWaypoints(row) {
  const prior = await pool.query(
    `SELECT o2.id, o2.status, o2.destination_lat, o2.destination_lng,
            COALESCE(o2.pickup_lat, o2.picked_up_lat) AS pickup_lat, COALESCE(o2.pickup_lng, o2.picked_up_lng) AS pickup_lng,
            (o2.pickup_address IS NOT NULL OR o2.pickup_name IS NOT NULL OR o2.pickup_lat IS NOT NULL) AS has_pickup
     FROM delivery_stops s
     JOIN delivery_runs r ON r.id = s.run_id AND r.company_id = s.company_id AND r.status IN ('draft', 'planned', 'active')
     JOIN delivery_stops s2 ON s2.run_id = s.run_id AND s2.removed_at IS NULL AND s2.assignment_active = TRUE AND s2.sequence < s.sequence
     JOIN orders o2 ON o2.id = s2.order_id AND o2.company_id = s.company_id
     WHERE s.order_id = $1 AND s.company_id = $2 AND s.removed_at IS NULL AND s.assignment_active = TRUE
       AND NOT (o2.status = ANY($3::text[]))
     ORDER BY s2.sequence ASC, s2.id ASC`,
    [row.order_id, row.company_ref, terminalOrderStatuses]
  );
  const ownPickup = row.has_pickup && PRE_PICKUP.includes(row.status) ? validPoint(row.pickup_lat, row.pickup_lng) : null;
  // En route vers ce client : il ne fait plus d'autre arrêt avant.
  if (['En livraison', 'Arrivée'].includes(row.status)) return { via: [], stopsBefore: 0, pickup: null, viaPoints: [] };
  const via = [];
  const viaPoints = [];
  if (row.status === 'Vers la collecte' && ownPickup) via.push(ownPickup);
  for (const o of prior.rows) {
    if (o.has_pickup && PRE_PICKUP.includes(o.status)) { const p = validPoint(o.pickup_lat, o.pickup_lng); if (p) via.push(p); }
    const d = validPoint(o.destination_lat, o.destination_lng);
    if (d) { via.push(d); viaPoints.push(d); }
  }
  if (row.status !== 'Vers la collecte' && ownPickup) via.push(ownPickup);
  return { via: via.slice(0, 40), stopsBefore: prior.rows.length, pickup: ownPickup, viaPoints };
}

// Calage : durée prévue au départ vers le client, durée réelle à l'arrivée.
async function recordEtaSample(orderId, companyId, toStatus, driverId) {
  try {
    if (toStatus === 'En livraison') {
      const o = (await pool.query('SELECT destination_lat, destination_lng FROM orders WHERE id = $1 AND company_id = $2', [orderId, companyId])).rows[0];
      const dest = o && validPoint(o.destination_lat, o.destination_lng);
      const driver = dest && await driverCurrentPosition(driverId, companyId, 3 * 60 * 1000);
      if (!driver) return;
      const route = await routingAdapter.route({ profile: 'motorcycle', coordinates: [driver, dest] });
      if (route?.status !== 'ok' || !Number.isFinite(Number(route.durationSeconds))) return;
      await pool.query(
        `INSERT INTO eta_samples (order_id, company_id, predicted_seconds) VALUES ($1, $2, $3)
         ON CONFLICT (order_id) DO UPDATE SET predicted_seconds = EXCLUDED.predicted_seconds, started_at = NOW(), actual_seconds = NULL, completed_at = NULL`,
        [orderId, companyId, Math.round(Number(route.durationSeconds))]
      );
    } else if (toStatus === 'Arrivée') {
      await pool.query(
        `UPDATE eta_samples SET actual_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::int, completed_at = NOW()
         WHERE order_id = $1 AND company_id = $2 AND completed_at IS NULL`,
        [orderId, companyId]
      );
    }
  } catch (error) {
    console.error('ETA sample failed:', error.message);
  }
}

async function publicTrackingSteps(row) {
  const events = await pool.query(
    `SELECT to_status, MIN(created_at) AS at FROM order_status_events
     WHERE order_id = $1 AND to_status = ANY($2::text[])
     GROUP BY to_status`,
    [row.order_id, ['Confirmée', 'Récupérée', 'En tournée', 'En livraison', 'Arrivée', 'Livrée']]
  );
  const at = Object.fromEntries(events.rows.map((event) => [event.to_status, event.at]));
  const earliest = (...values) => values.filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] || null;
  return {
    validatedAt: row.request_validated_at || at['Confirmée'] || row.order_created_at || null,
    pickedUpAt: at['Récupérée'] || null,
    enRouteAt: earliest(at['En tournée'], at['En livraison']),
    arrivedAt: at['Arrivée'] || null,
    deliveredAt: at['Livrée'] || null,
  };
}

// Tracé livreur → destination pour la carte client, calculé côté serveur à
// partir de la position connue du livreur (le client n'envoie aucune
// coordonnée). Recalculé au plus toutes les 60 s par lien, ou si le livreur a
// bougé de plus de 150 m.
const publicRouteCache = new Map();
async function publicTrackingRoute(key, driver, destination, via = []) {
  if (!key || !destination) return null;
  const viaKey = via.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(';');
  key = `${key}|${viaKey}`;
  const cached = publicRouteCache.get(key);
  if (cached && Date.now() - cached.at < 60_000 && haversineKm(cached.driver, driver) * 1000 < 150) return cached.value;
  let value = null;
  try {
    const result = await routingAdapter.route({
      profile: 'motorcycle',
      coordinates: [driver, ...via, { lat: destination.latitude, lng: destination.longitude }],
    });
    const coordinates = result?.status === 'ok' ? result.geometry?.value?.coordinates : null;
    if (Array.isArray(coordinates) && coordinates.length >= 2) {
      value = { coordinates, distanceMeters: result.distanceMeters, durationSeconds: result.durationSeconds, legs: result.legs || [] };
    }
  } catch (_error) {
    value = null;
  }
  if (publicRouteCache.size >= 2000) publicRouteCache.delete(publicRouteCache.keys().next().value);
  publicRouteCache.set(key, { at: Date.now(), driver, value });
  return value;
}

app.get('/api/tracking/:token', publicTrackingRateLimit, asyncRoute(async (req, res) => {
  let deviceId = process.env.TRACCAR_DEVICE_ID;
  let routeKey = null;
  let trackingRow = null;
  let tracking = {
    orderStatus: null,
    statusChangedAt: null,
    requestedTime: null,
    neighborhood: null,
    landmark: null,
    destination: null,
    driverName: null,
    driverVehicleType: null,
    companyName: null,
    displayNumber: null,
    steps: null,
  };
  const isDemo = Boolean(demoToken && req.params.token === demoToken);
  if (!isDemo && !/^[A-Za-z0-9_-]{32,128}$/.test(req.params.token)) {
    const unavailable = publicTrackingLinkMessage('unavailable');
    return res.status(unavailable.statusCode).json({ error: unavailable.message });
  }
  if (pool && !isDemo) {
    const link = await pool.query(
      `SELECT d.traccar_unique_id, d.name AS driver_name, d.vehicle_type AS driver_vehicle_type,
               o.id AS order_id, o.reference AS order_reference, o.customer_request_id,
               o.status, o.status_changed_at, o.requested_time, o.neighborhood, o.landmark,
               o.destination_lat, o.destination_lng, o.destination_accuracy, o.created_at AS order_created_at,
               o.driver_id, COALESCE(o.pickup_lat, o.picked_up_lat) AS pickup_lat, COALESCE(o.pickup_lng, o.picked_up_lng) AS pickup_lng,
               (o.pickup_address IS NOT NULL OR o.pickup_name IS NOT NULL OR o.pickup_lat IS NOT NULL) AS has_pickup,
               o.pickup_name, c.delivery_settings,
               c.name AS company_name, c.id AS company_ref, c.logo_updated_at AS company_logo_at, r.validated_at AS request_validated_at,
               t.id AS tracking_link_id, t.expires_at, t.created_at, t.revoked_at
        FROM tracking_links t
        JOIN orders o ON o.id = t.order_id AND o.company_id = t.company_id
        JOIN drivers d ON d.id = o.driver_id AND d.company_id = o.company_id
        JOIN companies c ON c.id = o.company_id
        LEFT JOIN customer_requests r ON r.id = o.customer_request_id
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
    routeKey = `link:${row.tracking_link_id}`;
    trackingRow = row;
    tracking = {
      orderStatus: row.status,
      statusChangedAt: row.status_changed_at,
      requestedTime: row.requested_time,
      neighborhood: row.neighborhood,
      landmark: row.landmark,
      destination: publicDestination(row),
      driverName: row.driver_name,
      driverVehicleType: row.driver_vehicle_type,
      companyName: row.company_name,
      companyLogoUrl: companyLogoUrl(row.company_ref, row.company_logo_at),
      // Même numéro que la demande côté client (« Demande #55 » → « Livraison #55 »).
      displayNumber: row.customer_request_id ? String(row.customer_request_id) : (row.order_reference || String(row.order_id)),
      steps: await publicTrackingSteps(row),
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
    companyName: tracking.companyName,
    companyLogoUrl: tracking.companyLogoUrl || null,
    displayNumber: tracking.displayNumber,
    steps: tracking.steps,
    mapConfig: mapConfiguration(),
  };
  if (terminalOrderStatuses.includes(tracking.orderStatus)) {
    const message = tracking.orderStatus === 'Livrée' ? 'Votre livraison a été remise.'
      : tracking.orderStatus === 'Retournée' ? 'La livraison a été retournée à l’entreprise.'
        : 'Cette livraison a été annulée.';
    return res.json({ status: 'completed', positionVisible: false, ...publicDetails, message, timestamp: tracking.statusChangedAt });
  }
  const activeDetails = { ...publicDetails, destination: tracking.destination };
  // Trajet complet visible (collecte, autres arrêts) : au choix de l'entreprise.
  const fullRoute = Boolean(trackingRow && normalizeDeliverySettings(trackingRow.delivery_settings).showFullRoute);
  const plan = trackingRow ? await orderEtaWaypoints(trackingRow) : { via: [], stopsBefore: 0, pickup: null, viaPoints: [] };
  const learned = trackingRow ? await etaLearned(trackingRow.company_ref) : {};
  const etaBase = {
    status: tracking.orderStatus, hasPickup: Boolean(trackingRow?.has_pickup), deliveriesBefore: plan.stopsBefore,
    requestedTime: tracking.requestedTime, learned,
  };
  activeDetails.deliveriesBefore = plan.stopsBefore;
  activeDetails.fullRoute = fullRoute;
  if (fullRoute && trackingRow?.has_pickup) {
    activeDetails.pickup = { name: trackingRow.pickup_name || null, ...(plan.pickup ? { latitude: plan.pickup.lat, longitude: plan.pickup.lng } : {}) };
  }
  // Position du livreur montrée au client : en route vers lui, ou trajet complet autorisé.
  const showStatuses = fullRoute ? [...publicTrackingPositionStatuses, 'Vers la collecte', 'Récupérée'] : publicTrackingPositionStatuses;
  const positionAllowed = (!tracking.orderStatus || showStatuses.includes(tracking.orderStatus)) && (fullRoute || plan.stopsBefore === 0);
  const waitingMessage = plan.stopsBefore > 0
    ? `Votre livreur termine ${plan.stopsBefore} livraison${plan.stopsBefore > 1 ? 's' : ''} avant la vôtre.`
    : tracking.orderStatus === 'Vers la collecte' ? 'Votre livreur récupère votre colis.'
      : 'Le suivi en direct commencera lorsque le livreur prendra la route.';
  // Suivi actif mais position absente : positionVisible reste vrai (le suivi a démarré).
  const respondWithoutPosition = (status, message, extra = {}) => res.json({
    status, positionVisible: positionAllowed, ...activeDetails, message,
    eta: computeEta({ ...etaBase, ...extra }),
  });
  if (!traccarConfigured() || !deviceId) {
    return respondWithoutPosition(positionAllowed ? 'unavailable' : 'waiting', positionAllowed ? 'La position du livreur n’est pas encore disponible.' : waitingMessage);
  }
  const fleetSnapshot = await loadTraccarFleetSnapshot();
  if (fleetSnapshot.status !== 'online') {
    return respondWithoutPosition('unavailable', positionAllowed ? 'Le service de localisation est temporairement indisponible.' : waitingMessage);
  }
  const device = fleetSnapshot.devices.find((item) => String(item.uniqueId) === String(deviceId));
  const position = device && fleetSnapshot.positions.find((item) => String(item.deviceId) === String(device.id));
  const latitude = Number(position?.latitude);
  const longitude = Number(position?.longitude);
  if (!device || !position || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return respondWithoutPosition('waiting', positionAllowed ? 'Le livreur n’a pas encore transmis de position.' : waitingMessage);
  }
  const timestamp = position.fixTime || position.deviceTime || position.serverTime || device.lastUpdate || null;
  const timestampMs = timestamp ? new Date(timestamp).getTime() : NaN;
  const ageMs = Number.isFinite(timestampMs) ? Date.now() - timestampMs : Infinity;
  const isStale = ageMs > 10 * 60 * 1000;
  const finiteOrNull = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);
  // Sans destination enregistrée, le client peut se situer depuis son téléphone :
  // sa position sert au calcul du trajet puis est oubliée (jamais enregistrée).
  let routeTarget = tracking.destination ? 'destination' : null;
  let routeTo = tracking.destination;
  if (!routeTo) {
    const viewerLat = optionalNumber(req.query.lat);
    const viewerLng = optionalNumber(req.query.lng);
    if (viewerLat != null && viewerLng != null && viewerLat >= -90 && viewerLat <= 90 && viewerLng >= -180 && viewerLng <= 180) {
      routeTo = { latitude: viewerLat, longitude: viewerLng };
      routeTarget = 'viewer';
    }
  }
  // Au-delà de 30 min sans position, on ne calcule plus de trajet : il serait faux.
  const route = routeTo && ageMs <= 30 * 60 * 1000
    ? await publicTrackingRoute(routeTarget === 'viewer' && routeKey ? `${routeKey}:viewer:${routeTo.latitude.toFixed(3)},${routeTo.longitude.toFixed(3)}` : routeKey, { lat: latitude, lng: longitude }, routeTo, plan.via)
    : null;
  const eta = computeEta({ ...etaBase, route, stale: isStale, pickedUp: !PRE_PICKUP.includes(tracking.orderStatus) });
  if (!positionAllowed) {
    return res.json({ status: 'waiting', positionVisible: false, ...activeDetails, message: waitingMessage, eta, positionAge: Math.round(ageMs / 1000) });
  }
  return res.json({
    status: isStale ? 'stale' : 'online',
    ...activeDetails,
    positionVisible: true,
    // Tracé : complet si l'entreprise l'autorise, sinon seulement quand il vient directement.
    route: route && (fullRoute || plan.via.length === 0) ? { coordinates: route.coordinates, distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds } : null,
    routeTarget: route ? routeTarget : null,
    detourPoints: fullRoute ? plan.viaPoints.map((p) => ({ latitude: p.lat, longitude: p.lng })) : [],
    eta,
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
             -- Typage explicite : avec DISTINCT, un NULL nu devient « text » et
             -- l'insertion échouait à chaque démarrage (colonne bigint).
             NULL::bigint
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
  .then(async () => {
    if (VECTOR_TILES_URL) {
      await checkVectorTiles();
      setInterval(checkVectorTiles, 60_000).unref();
    }
  })
  .then(() => app.listen(port, () => console.log(`Delivery SaaS listening on port ${port}`)))
  .then(() => { whatsapp.start().catch((error) => console.error('WhatsApp start failed:', error.message)); })
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
