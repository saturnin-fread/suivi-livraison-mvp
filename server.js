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

function optionalNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
            c.name AS company_name, c.slug AS company_slug, m.role
     FROM app_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN companies c ON c.id = s.company_id
     LEFT JOIN company_memberships m ON m.company_id = s.company_id AND m.user_id = s.user_id
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
    req.auth = session;
    return next();
  }).catch(next);
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
  return res.redirect('/app');
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
  '/app/livreurs', '/app/clients', '/app/rapports', '/app/parametres',
];
app.get(companyPages, requireCompanyPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});
app.get('/app/demandes/:id', requireCompanyPage, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
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

app.get('/api/app/context', requireCompanyApi, (req, res) => res.json({
  user: { id: req.auth.user_id, email: req.auth.email, name: req.auth.display_name, role: req.auth.role },
  company: { id: req.auth.company_id, name: req.auth.company_name, slug: req.auth.company_slug },
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
    `SELECT id, status, customer_name, customer_phone, requested_time,
            location_lat, location_lng, location_accuracy, location_at,
            neighborhood, landmark, notes, created_at, submitted_at, updated_at,
            expires_at, archived_at, validated_at, version
     FROM customer_requests WHERE id = $1 AND company_id = $2`,
    [req.params.id, req.auth.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Demande introuvable.' });
  return res.json(result.rows[0]);
}));

app.post('/api/app/requests/:id/status', requireCompanyApi, asyncRoute(async (req, res) => {
  const allowed = ['À vérifier', 'Informations à compléter', 'Confirmée', 'Refusée', 'Archivée'];
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

app.get('/api/app/drivers', requireCompanyApi, asyncRoute(async (req, res) => {
  const localDrivers = await pool.query(
    'SELECT id, name, traccar_unique_id FROM drivers WHERE company_id = $1 ORDER BY name',
    [req.auth.company_id]
  );
  if (!process.env.TRACCAR_URL || !process.env.TRACCAR_USER || !process.env.TRACCAR_PASSWORD) {
    return res.json(localDrivers.rows.map((driver) => ({ ...driver, uniqueId: driver.traccar_unique_id, status: 'unknown', lastUpdate: null })));
  }
  try {
    const response = await axios.get(`${process.env.TRACCAR_URL}/api/devices`, {
      auth: { username: process.env.TRACCAR_USER, password: process.env.TRACCAR_PASSWORD }, timeout: 10000,
    });
    const byUniqueId = new Map(response.data.map((device) => [device.uniqueId, device]));
    return res.json(localDrivers.rows.map((driver) => {
      const device = byUniqueId.get(driver.traccar_unique_id);
      return {
        id: driver.id, name: driver.name, uniqueId: driver.traccar_unique_id,
        status: device?.status || 'unknown', lastUpdate: device?.lastUpdate || null, category: device?.category || null,
      };
    }));
  } catch (error) {
    console.error('Drivers API error:', error.response?.status || error.message);
    return res.json(localDrivers.rows.map((driver) => ({ ...driver, uniqueId: driver.traccar_unique_id, status: 'unknown', lastUpdate: null })));
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
      `INSERT INTO orders (company_id, driver_id, customer_name, customer_phone, delivery_address)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.auth.company_id, driver.rows[0].id, customerName, customerPhone || null, deliveryAddress]
    );
    const token = randomToken(24);
    await client.query(
      `INSERT INTO tracking_links (order_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [order.rows[0].id, token]
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
  if (pool && req.params.token !== demoToken) {
    const link = await pool.query(
      `SELECT d.traccar_unique_id FROM tracking_links t
       JOIN orders o ON o.id = t.order_id JOIN drivers d ON d.id = o.driver_id
       WHERE t.token = $1 AND (t.expires_at IS NULL OR t.expires_at > NOW())`,
      [req.params.token]
    );
    if (!link.rows[0]) return res.status(404).json({ error: 'Lien de suivi introuvable ou expiré.' });
    deviceId = link.rows[0].traccar_unique_id;
  } else if (req.params.token !== demoToken && !pool) {
    return res.status(404).json({ error: 'Lien de suivi introuvable ou expiré.' });
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
      status: isStale ? 'stale' : 'online', latitude: position.latitude, longitude: position.longitude,
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
