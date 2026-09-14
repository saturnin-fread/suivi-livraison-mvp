require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const demoToken = process.env.DEMO_TRACKING_TOKEN || 'demo-ccg-2026';
const sessionDurationMs = 8 * 60 * 60 * 1000;
const editableRequestStatuses = ['À vérifier', 'Informations à compléter'];
const terminalOrderStatuses = ['Livrée', 'Retournée', 'Annulée'];
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
const invitationRoles = ['manager', 'operator', 'driver'];
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

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
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
        order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

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
  await pool.query(
    `INSERT INTO app_sessions (token_hash, user_id, company_id, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [digest(token), userId, companyId || null, scope, new Date(Date.now() + sessionDurationMs)]
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
            c.name AS company_name, c.slug AS company_slug, m.role, m.driver_id,
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
              o.status AS order_status, o.customer_name, o.customer_phone, o.requested_time,
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

app.get('/app/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app-login.html')));
app.post('/app/login', asyncRoute(async (req, res) => {
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

app.get('/admin/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'platform-login.html')));
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
  res.sendFile(path.join(__dirname, 'public', 'platform-admin.html'));
});

const companyPages = [
  '/app', '/app/demandes', '/app/nouvelle-commande', '/app/commandes', '/app/carte',
  '/app/livreurs', '/app/tournees', '/app/incidents', '/app/equipe', '/app/clients', '/app/rapports', '/app/parametres',
];
app.get(companyPages, requireCompanyPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app/demandes/:id', requireCompanyPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app/commandes/:id', requireCompanyPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app/incidents/:id', requireCompanyPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app/tournees/:id', requireCompanyPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get(['/driver', '/driver/commandes/:id'], requireDriverPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'driver.html'));
});

app.get('/suivi/:token', (req, res) => {
  if (req.params.token !== demoToken && !pool) return res.status(404).send('Lien de suivi introuvable ou expiré.');
  return res.sendFile(path.join(__dirname, 'public', 'tracking.html'));
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
  return res.sendFile(path.join(__dirname, 'public', 'request.html'));
}));

app.get('/demande/:token/confirmation', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Service momentanément indisponible.');
  const result = await pool.query('SELECT id FROM customer_requests WHERE token = $1', [req.params.token]);
  if (!result.rows[0]) return res.status(404).send('Cette demande est introuvable.');
  return res.sendFile(path.join(__dirname, 'public', 'confirmation.html'));
}));

app.get('/invitation/:token', asyncRoute(async (req, res) => {
  if (!pool) return res.status(503).send('Service momentanément indisponible.');
  const result = await pool.query(
    `SELECT id FROM user_invitations
     WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
    [digest(req.params.token)]
  );
  if (!result.rows[0]) return res.status(404).send('Cette invitation est invalide, expirée ou déjà utilisée.');
  return res.sendFile(path.join(__dirname, 'public', 'invitation.html'));
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
  company: { id: req.auth.company_id, name: req.auth.company_name, slug: req.auth.company_slug },
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

app.get('/api/driver/orders', requireDriverApi, asyncRoute(async (req, res) => {
  const history = req.query.scope === 'history';
  const result = await pool.query(
    `SELECT o.id, o.status, o.customer_name, o.customer_phone, o.delivery_address,
            o.requested_time, o.neighborhood, o.landmark, o.destination_lat, o.destination_lng,
            o.created_at, o.updated_at, pa.expected_amount_minor, pa.currency AS payment_currency,
            pa.status AS payment_status
     FROM orders o
     LEFT JOIN order_payment_accounts pa ON pa.order_id = o.id
     WHERE o.company_id = $1 AND o.driver_id = $2
       AND ${history ? 'o.status = ANY($3::text[])' : 'NOT (o.status = ANY($3::text[]))'}
     ORDER BY o.updated_at DESC, o.id DESC LIMIT 100`,
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
  const [incidents, evidence] = await Promise.all([
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
  ]);
  return res.json({
    ...order,
    allowedTransitions: allowedOrderTransitions(order.status).filter((status) => driverTransitionTargets.includes(status)),
    isTerminal: terminalOrderStatuses.includes(order.status),
    incidents: incidents.rows,
    evidence: evidence.rows,
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

app.post('/api/app/request-links', requireCompanyApi, asyncRoute(async (req, res) => {
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
            o.id AS order_id, o.status AS order_status, d.name AS driver_name,
            t.token AS tracking_token, t.expires_at AS tracking_expires_at
     FROM customer_requests r
     LEFT JOIN orders o ON o.customer_request_id = r.id
     LEFT JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN tracking_links t ON t.order_id = o.id
     WHERE r.id = $1 AND r.company_id = $2`,
    [req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Demande introuvable.' });
  return res.json(result.rows[0]);
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
      `SELECT o.id, t.token FROM orders o LEFT JOIN tracking_links t ON t.order_id = o.id
       WHERE o.customer_request_id = $1`,
      [request.id]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return res.json({ orderId: existing.rows[0].id, path: `/suivi/${existing.rows[0].token}`, alreadyConverted: true });
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
    const trackingToken = randomToken(24);
    await client.query(
      `INSERT INTO tracking_links (order_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [order.rows[0].id, trackingToken]
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
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
       VALUES
         ($1, $2, 'customer_request', $3, 'converted_to_order', jsonb_build_object('orderId', $4::bigint, 'driverId', $5::bigint)),
         ($1, $2, 'order', $4, 'created_from_request', jsonb_build_object('requestId', $3::bigint, 'driverId', $5::bigint))`,
      [req.auth.company_id, req.auth.user_id, request.id, order.rows[0].id, driver.id]
    );
    await client.query('COMMIT');
    return res.status(201).json({ orderId: order.rows[0].id, path: `/suivi/${trackingToken}`, driverName: driver.name });
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
            COUNT(o.id) FILTER (WHERE o.status NOT IN ('Livrée', 'Annulée', 'Retournée'))::int AS active_orders
     FROM drivers d
     LEFT JOIN orders o ON o.driver_id = d.id
     WHERE d.company_id = $1
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
    };
  };
  if (!process.env.TRACCAR_URL || !process.env.TRACCAR_USER || !process.env.TRACCAR_PASSWORD) {
    return res.json(localDrivers.rows.map((driver) => enrich(driver, null)));
  }
  try {
    const response = await axios.get(`${process.env.TRACCAR_URL}/api/devices`, {
      auth: { username: process.env.TRACCAR_USER, password: process.env.TRACCAR_PASSWORD }, timeout: 10000,
    });
    const byUniqueId = new Map(response.data.map((device) => [device.uniqueId, device]));
    const ranking = { available: 0, busy: 1, full: 2, pause: 3, stale: 4, offline: 5, off_duty: 6, incident: 7, inactive: 8 };
    return res.json(localDrivers.rows
      .map((driver) => enrich(driver, byUniqueId.get(driver.traccar_unique_id)))
      .sort((a, b) => (ranking[a.operationalState] ?? 9) - (ranking[b.operationalState] ?? 9) || a.activeOrders - b.activeOrders || a.name.localeCompare(b.name)));
  } catch (error) {
    console.error('Drivers API error:', error.response?.status || error.message);
    return res.json(localDrivers.rows.map((driver) => enrich(driver, null)));
  }
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

app.get('/api/app/runs', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.name, TO_CHAR(r.service_date, 'YYYY-MM-DD') AS service_date, r.status, r.version, r.created_at, r.updated_at,
            d.id AS driver_id, d.name AS driver_name, d.vehicle_type,
            COUNT(s.id) FILTER (WHERE s.removed_at IS NULL)::int AS stop_count,
            COUNT(s.id) FILTER (WHERE s.removed_at IS NULL AND o.status = ANY($2::text[]))::int AS terminal_stop_count
     FROM delivery_runs r
     JOIN drivers d ON d.id = r.driver_id AND d.company_id = r.company_id
     LEFT JOIN delivery_stops s ON s.run_id = r.id AND s.company_id = r.company_id
     LEFT JOIN orders o ON o.id = s.order_id AND o.company_id = r.company_id
     WHERE r.company_id = $1
     GROUP BY r.id, d.id
     ORDER BY r.service_date DESC, r.created_at DESC LIMIT 100`,
    [req.auth.company_id, terminalOrderStatuses]
  );
  return res.json(result.rows);
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
    if (count.rows[0].count >= run.capacity) {
      throw Object.assign(new Error(`La capacité déclarée du livreur est atteinte (${run.capacity} colis).`), { statusCode: 409 });
    }
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
  const suggestion = suggestGeometricStopOrder(payload.stops.map((stop) => ({
    id: Number(stop.id), lat: Number(stop.destination_lat), lng: Number(stop.destination_lng),
  })));
  return res.json({
    available: true,
    ...suggestion,
    distanceKm: Number(suggestion.distanceKm.toFixed(2)),
    method: 'straight_line_nearest_neighbor',
    warning: 'Ordre indicatif à vol d’oiseau : il ne tient pas compte des routes, du trafic ni des créneaux clients.',
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
    `SELECT o.id, o.status, o.customer_name, o.customer_phone, o.requested_time,
            o.neighborhood, o.landmark, o.created_at, o.updated_at,
            d.name AS driver_name, t.token AS tracking_token, t.expires_at AS tracking_expires_at
     FROM orders o
     JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN tracking_links t ON t.order_id = o.id
     WHERE o.company_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
    [req.auth.company_id]
  );
  return res.json(result.rows);
}));

app.get('/api/app/orders/:id', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT o.*, d.name AS driver_name, d.phone AS driver_phone,
            d.vehicle_type AS driver_vehicle_type, t.token AS tracking_token,
            t.expires_at AS tracking_expires_at,
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
  const [events, incidents, paymentEvents, evidence] = await Promise.all([
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
      `SELECT id, evidence_type, mime_type, byte_size, created_at
       FROM delivery_evidence_files
       WHERE order_id = $1 AND company_id = $2 AND superseded_at IS NULL AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [order.id, req.auth.company_id]
    ),
  ]);
  return res.json({
    ...order,
    allowedTransitions: allowedOrderTransitions(order.status),
    requiresOtpForDelivery: order.status === 'Arrivée' && !order.proof_id,
    paymentBlocksDelivery: Boolean(order.payment_account_id && ['pending', 'discrepancy'].includes(order.payment_status)),
    isTerminal: terminalOrderStatuses.includes(order.status),
    events: events.rows,
    incidents: incidents.rows,
    paymentEvents: paymentEvents.rows,
    evidence: evidence.rows,
  });
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
            o.neighborhood, o.status AS order_status, d.name AS driver_name,
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
  return res.json(result.rows);
}));

async function loadIncidentDossier(companyId, incidentId) {
  const incidentResult = await pool.query(
    `SELECT i.id, i.company_id, i.order_id, i.category, i.severity, i.description,
            i.status, i.opened_by_user_id, i.resolved_by_user_id, i.assigned_to_user_id,
            i.resolution, i.resolved_at, i.created_at, i.updated_at,
            o.customer_name, o.customer_phone, o.delivery_address, o.requested_time,
            o.destination_lat, o.destination_lng, o.destination_accuracy, o.neighborhood,
            o.landmark, o.notes AS order_notes, o.status AS order_status, o.created_at AS order_created_at,
            o.completed_at, o.cancelled_at, o.failure_reason,
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
  const [events, holds, evidence, orderEvents, paymentEvents, proofs, relatedIncidents, members] = await Promise.all([
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

app.post('/api/app/orders', requireCompanyApi, asyncRoute(async (req, res) => {
  const { customerName, customerPhone, deliveryAddress, driverId } = req.body;
  if (!customerName || !deliveryAddress || !driverId) {
    return res.status(400).json({ error: 'Nom client, lieu de livraison et livreur sont obligatoires.' });
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
    const token = randomToken(24);
    await client.query(
      `INSERT INTO tracking_links (order_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [order.rows[0].id, token]
    );
    await client.query(
      `INSERT INTO order_status_events (
         company_id, order_id, from_status, to_status, actor_user_id,
         idempotency_key, request_fingerprint, metadata
       ) VALUES ($1, $2, NULL, 'Confirmée', $3, $4, $5, '{"source":"direct"}'::jsonb)`,
      [req.auth.company_id, order.rows[0].id, req.auth.user_id, `system:direct-order:${order.rows[0].id}`, digest(`direct-order:${order.rows[0].id}`)]
    );
    await client.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action)
       VALUES ($1, $2, 'order', $3, 'created')`,
      [req.auth.company_id, req.auth.user_id, order.rows[0].id]
    );
    await client.query('COMMIT');
    committed = true;
    return res.status(201).json({ orderId: order.rows[0].id, token, path: `/suivi/${token}` });
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

app.get('/api/tracking/:token', asyncRoute(async (req, res) => {
  const traccarUrl = process.env.TRACCAR_URL;
  let deviceId = process.env.TRACCAR_DEVICE_ID;
  let orderStatus = null;
  let statusChangedAt = null;
  if (pool && req.params.token !== demoToken) {
    const link = await pool.query(
      `SELECT d.traccar_unique_id, o.status, o.status_changed_at FROM tracking_links t
       JOIN orders o ON o.id = t.order_id JOIN drivers d ON d.id = o.driver_id
       WHERE t.token = $1 AND (t.expires_at IS NULL OR t.expires_at > NOW())`,
      [req.params.token]
    );
    if (!link.rows[0]) return res.status(404).json({ error: 'Lien de suivi introuvable ou expiré.' });
    deviceId = link.rows[0].traccar_unique_id;
    orderStatus = link.rows[0].status;
    statusChangedAt = link.rows[0].status_changed_at;
  } else if (req.params.token !== demoToken && !pool) {
    return res.status(404).json({ error: 'Lien de suivi introuvable ou expiré.' });
  }
  if (terminalOrderStatuses.includes(orderStatus)) {
    const message = orderStatus === 'Livrée' ? 'Votre livraison a été remise.'
      : orderStatus === 'Retournée' ? 'La livraison a été retournée à l’entreprise.'
        : 'Cette livraison a été annulée.';
    return res.json({ status: 'completed', orderStatus, message, timestamp: statusChangedAt });
  }
  if (!traccarUrl || !deviceId || !process.env.TRACCAR_USER || !process.env.TRACCAR_PASSWORD) {
    return res.status(503).json({ error: 'Le suivi n’est pas encore configuré.' });
  }
  try {
    const devicesResponse = await axios.get(`${traccarUrl}/api/devices`, {
      params: { uniqueId: deviceId },
      auth: { username: process.env.TRACCAR_USER, password: process.env.TRACCAR_PASSWORD }, timeout: 10000,
    });
    const device = devicesResponse.data?.[0];
    if (!device) return res.status(404).json({ error: 'Livreur introuvable dans Traccar.' });
    const response = await axios.get(`${traccarUrl}/api/positions`, {
      params: device.positionId ? { id: device.positionId } : { deviceId: device.id },
      auth: { username: process.env.TRACCAR_USER, password: process.env.TRACCAR_PASSWORD }, timeout: 10000,
    });
    const position = response.data?.[0];
    if (!position) return res.json({ status: 'waiting', message: 'Position momentanément indisponible.' });
    const timestamp = position.fixTime || position.deviceTime || position.serverTime;
    const isStale = timestamp && (Date.now() - new Date(timestamp).getTime()) > 10 * 60 * 1000;
    return res.json({
      status: isStale ? 'stale' : 'online', orderStatus,
      latitude: position.latitude, longitude: position.longitude,
      speed: position.speed, course: position.course, accuracy: position.accuracy, timestamp,
    });
  } catch (error) {
    console.error('Traccar API error:', error.response?.status || error.message);
    return res.status(502).json({ error: 'Le service de localisation est temporairement indisponible.' });
  }
}));

app.use((error, _req, res, _next) => {
  const correlationId = crypto.randomUUID();
  console.error(`[${correlationId}]`, error);
  if (res.headersSent) return;
  return res.status(500).json({ error: 'Une erreur interne est survenue.', correlationId });
});

initDatabase()
  .then(() => app.listen(port, () => console.log(`Delivery SaaS listening on port ${port}`)))
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
