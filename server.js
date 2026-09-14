require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const axios = require('axios');
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
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
    })
  : null;

app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
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
  await pool.query(
    `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [auth?.company_id || null, auth?.user_id || null, entityType, entityId || null, action, details]
  );
}

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
  '/app/livreurs', '/app/equipe', '/app/clients', '/app/rapports', '/app/parametres',
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
            p.id AS proof_id, p.verified_at AS proof_verified_at
     FROM orders o
     LEFT JOIN order_payment_accounts pa ON pa.order_id = o.id
     LEFT JOIN delivery_proofs p ON p.order_id = o.id AND p.proof_type = 'otp'
     WHERE o.id = $1 AND o.company_id = $2 AND o.driver_id = $3`,
    [req.params.id, req.auth.company_id, req.auth.driver_id]
  );
  const order = result.rows[0];
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  const incidents = await pool.query(
    `SELECT id, category, severity, description, status, resolution, created_at, resolved_at
     FROM delivery_incidents WHERE order_id = $1 AND company_id = $2
     ORDER BY created_at DESC, id DESC`,
    [order.id, req.auth.company_id]
  );
  return res.json({
    ...order,
    allowedTransitions: allowedOrderTransitions(order.status).filter((status) => driverTransitionTargets.includes(status)),
    isTerminal: terminalOrderStatuses.includes(order.status),
    incidents: incidents.rows,
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

app.post('/api/driver/orders/:id/incidents', requireDriverApi, asyncRoute(async (req, res) => {
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
  const order = await pool.query(
    `SELECT id FROM orders WHERE id = $1 AND company_id = $2 AND driver_id = $3`,
    [req.params.id, req.auth.company_id, req.auth.driver_id]
  );
  if (!order.rows[0]) return res.status(404).json({ error: 'Commande introuvable.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), category, severity, description }));
  const inserted = await pool.query(
    `INSERT INTO delivery_incidents (
       company_id, order_id, category, severity, description, idempotency_key,
       request_fingerprint, opened_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING id, created_at`,
    [req.auth.company_id, order.rows[0].id, category, severity, description, idempotencyKey, fingerprint, req.auth.user_id]
  );
  if (!inserted.rows[0]) {
    const existing = await pool.query(
      `SELECT id, order_id, request_fingerprint, created_at FROM delivery_incidents
       WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (!existing.rows[0] || String(existing.rows[0].order_id) !== String(order.rows[0].id) || existing.rows[0].request_fingerprint !== fingerprint) {
      return res.status(409).json({ error: 'Cette clé d’action a déjà été utilisée ailleurs.' });
    }
    return res.json({ id: existing.rows[0].id, createdAt: existing.rows[0].created_at, alreadyCreated: true });
  }
  await writeAudit(req.auth, 'order', order.rows[0].id, 'driver_incident_opened', { incidentId: inserted.rows[0].id, category, severity });
  return res.status(201).json({ id: inserted.rows[0].id, createdAt: inserted.rows[0].created_at });
}));

app.get('/api/app/summary', requireCompanyApi, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE archived_at IS NULL) AS active_requests,
            COUNT(*) FILTER (WHERE status = 'À vérifier' AND archived_at IS NULL) AS to_review,
            (SELECT COUNT(*) FROM orders WHERE company_id = $1) AS orders,
            (SELECT COUNT(*) FROM drivers WHERE company_id = $1) AS drivers
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
            (SELECT c.expires_at FROM delivery_otp_challenges c
             WHERE c.order_id = o.id AND c.consumed_at IS NULL AND c.revoked_at IS NULL
               AND c.expires_at > NOW()
             ORDER BY c.created_at DESC LIMIT 1) AS active_otp_expires_at
     FROM orders o
     JOIN drivers d ON d.id = o.driver_id
     LEFT JOIN tracking_links t ON t.order_id = o.id
     LEFT JOIN delivery_proofs p ON p.order_id = o.id AND p.proof_type = 'otp'
     LEFT JOIN order_payment_accounts pa ON pa.order_id = o.id
     WHERE o.id = $1 AND o.company_id = $2`,
    [req.params.id, req.auth.company_id]
  );
  const order = result.rows[0];
  if (!order) return res.status(404).json({ error: 'Commande introuvable.' });
  const [events, incidents, paymentEvents] = await Promise.all([
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

app.post('/api/app/orders/:id/otp/verify', requireCompanyApi, asyncRoute(async (req, res) => {
  const code = String(req.body.code || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Saisissez le code à 6 chiffres.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), action: 'verify_otp', codeDigest: digest(code) }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status, version FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
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
}));

app.post('/api/app/orders/:id/incidents', requireCompanyApi, asyncRoute(async (req, res) => {
  const category = String(req.body.category || '').trim();
  const severity = String(req.body.severity || 'medium').trim();
  const description = String(req.body.description || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (!incidentCategories.includes(category) || !['low', 'medium', 'high'].includes(severity)) {
    return res.status(400).json({ error: 'Type ou gravité d’incident invalide.' });
  }
  if (description.length < 5 || description.length > 2000) {
    return res.status(400).json({ error: 'Décrivez l’incident entre 5 et 2 000 caractères.' });
  }
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const order = await pool.query(`SELECT id FROM orders WHERE id = $1 AND company_id = $2`, [req.params.id, req.auth.company_id]);
  if (!order.rows[0]) return res.status(404).json({ error: 'Commande introuvable.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), category, severity, description }));
  const inserted = await pool.query(
    `INSERT INTO delivery_incidents (
       company_id, order_id, category, severity, description, idempotency_key,
       request_fingerprint, opened_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING id, created_at`,
    [req.auth.company_id, order.rows[0].id, category, severity, description, idempotencyKey, fingerprint, req.auth.user_id]
  );
  if (!inserted.rows[0]) {
    const existing = await pool.query(
      `SELECT id, order_id, request_fingerprint, created_at FROM delivery_incidents
       WHERE company_id = $1 AND idempotency_key = $2`,
      [req.auth.company_id, idempotencyKey]
    );
    if (!existing.rows[0] || String(existing.rows[0].order_id) !== String(order.rows[0].id) || existing.rows[0].request_fingerprint !== fingerprint) {
      return res.status(409).json({ error: 'Cette clé d’action a déjà été utilisée pour un autre incident.' });
    }
    return res.json({ id: existing.rows[0].id, createdAt: existing.rows[0].created_at, alreadyCreated: true });
  }
  await writeAudit(req.auth, 'order', order.rows[0].id, 'incident_opened', { incidentId: inserted.rows[0].id, category, severity });
  return res.status(201).json({ id: inserted.rows[0].id, createdAt: inserted.rows[0].created_at });
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
      await client.query('COMMIT');
      return res.json({ id: incident.id, status: 'resolved', alreadyResolved: true });
    }
    await client.query(
      `UPDATE delivery_incidents SET status = 'resolved', resolution = $1, resolved_by_user_id = $2,
         resolution_idempotency_key = $3, resolution_fingerprint = $4,
         resolved_at = NOW(), updated_at = NOW() WHERE id = $5`,
      [resolution, req.auth.user_id, idempotencyKey, fingerprint, incident.id]
    );
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

app.post('/api/app/orders/:id/payment/collect', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
  const amount = moneyInteger(req.body.amountMinor);
  const method = String(req.body.method || '').trim();
  const reference = String(req.body.reference || '').trim().slice(0, 120);
  const discrepancyReason = String(req.body.discrepancyReason || '').trim();
  const idempotencyKey = normalizeIdempotencyKey(req.body.idempotencyKey);
  if (amount === null || !paymentMethods.includes(method)) return res.status(400).json({ error: 'Montant ou mode d’encaissement invalide.' });
  if (!idempotencyKey) return res.status(400).json({ error: 'Clé de sécurité de l’action invalide.' });
  const fingerprint = digest(JSON.stringify({ orderId: String(req.params.id), amount, method, reference, discrepancyReason, action: 'collect' }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status FROM orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, req.auth.company_id]
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
