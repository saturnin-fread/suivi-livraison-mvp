'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const databaseUrl = process.env.DATABASE_URL;
const nativeFetch = global.fetch;

global.fetch = (url, options = {}) => nativeFetch(url, {
  ...options,
  signal: options.signal || AbortSignal.timeout(20000),
});

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response) {
  return { response, payload: await response.json().catch(() => ({})) };
}

function isLoopbackHostname(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(hostname).toLowerCase());
}

function assertLocalTarget() {
  let application;
  let database;
  try {
    application = new URL(baseUrl);
    database = new URL(databaseUrl);
  } catch (_error) {
    throw new Error('SMOKE_BASE_URL et DATABASE_URL doivent être des URL locales valides.');
  }
  ensure(isLoopbackHostname(application.hostname), 'Refus du smoke CRM : le serveur cible doit être local.');
  ensure(isLoopbackHostname(database.hostname), 'Refus du smoke CRM : la base cible doit être locale.');
}

function hashPassword(value, salt) {
  return crypto.scryptSync(value, salt, 64).toString('hex');
}

function customerItems(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['customers', 'items', 'data', 'results']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function containsCustomer(payload, customerId, marker) {
  return customerItems(payload).some((item) => (
    String(item?.id) === String(customerId)
    || String(item?.displayName || item?.display_name || item?.name || '').includes(marker)
  ));
}

function findForbiddenCoordinatePath(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenCoordinatePath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;

  const forbidden = new Set([
    'lat', 'latitude', 'lng', 'lon', 'longitude',
    'locationlat', 'locationlng', 'locationlatitude', 'locationlongitude',
    'destinationlat', 'destinationlng', 'destinationlatitude', 'destinationlongitude',
  ]);
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (forbidden.has(normalizedKey)) return `${path}.${key}`;
    const found = findForbiddenCoordinatePath(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function ensureCoordinatesArePrivate(payload, latitude, longitude, label) {
  const forbiddenPath = findForbiddenCoordinatePath(payload);
  ensure(!forbiddenPath, `${label} expose une coordonnée via ${forbiddenPath}.`);
  const serialized = JSON.stringify(payload);
  ensure(!serialized.includes(String(latitude)) && !serialized.includes(String(longitude)),
    `${label} expose les valeurs GPS du lieu client.`);
}

function deliveryRateFrom(payload) {
  const metrics = payload?.metrics || payload;
  return metrics?.delivery?.deliveryRate || metrics?.delivery?.delivery_rate || null;
}

function loadPlaywright() {
  if (process.env.RUN_BROWSER_TEST !== '1') return null;
  try {
    return require('playwright');
  } catch (_error) {
    throw new Error('RUN_BROWSER_TEST=1 mais Playwright n’est pas disponible dans ce projet.');
  }
}

async function verifyMobilePages(cookie) {
  const playwright = loadPlaywright();
  if (!playwright) return false;

  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
  });
  try {
    const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const separator = cookie.indexOf('=');
    await browserContext.addCookies([{
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      url: baseUrl,
    }]);
    const page = await browserContext.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    for (const expected of [
      { path: '/app/clients', heading: /clients/i },
      { path: '/app/rapports', heading: /rapports/i },
    ]) {
      const response = await page.goto(`${baseUrl}${expected.path}`, { waitUntil: 'domcontentloaded' });
      ensure(response?.ok(), `La page ${expected.path} est indisponible sur mobile.`);
      await page.getByRole('heading', { name: expected.heading }).first().waitFor({ state: 'visible' });
      const body = await page.locator('body').innerText();
      ensure(!/fonctionnalit[eé].*(construction|venir)/i.test(body),
        `La page ${expected.path} affiche encore un contenu provisoire.`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      ensure(!overflow, `La page ${expected.path} déborde horizontalement sur mobile.`);
    }
    ensure(pageErrors.length === 0, `Erreur navigateur CRM : ${pageErrors[0]}.`);
    return true;
  } finally {
    await browser.close();
  }
}

async function insertFixture(pool, marker) {
  const ownerEmail = `crm-smoke-${marker}@example.invalid`;
  const ownerPassword = `Crm-${crypto.randomBytes(18).toString('base64url')}!9a`;
  const salt = crypto.randomBytes(16).toString('hex');
  const ownLatitude = 6.123456789;
  const ownLongitude = 2.987654321;
  const fixture = {
    ownerEmail,
    ownerPassword,
    ownLatitude,
    ownLongitude,
    userId: null,
    companyIds: [],
    ownCompanyId: null,
    driverId: null,
    ownCustomerId: null,
    foreignCustomerId: null,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tables = await client.query(
      `SELECT to_regclass('public.customers') AS customers,
              to_regclass('public.customer_contacts') AS contacts,
              to_regclass('public.customer_locations') AS locations`
    );
    ensure(tables.rows[0].customers && tables.rows[0].contacts && tables.rows[0].locations,
      'Le schéma CRM doit être appliqué avant ce smoke test.');

    const ownCompany = await client.query(
      `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Entreprise CRM smoke ${marker}`, `crm-smoke-${marker}`]
    );
    fixture.ownCompanyId = ownCompany.rows[0].id;
    fixture.companyIds.push(fixture.ownCompanyId);

    const owner = await client.query(
      `INSERT INTO users (email, display_name, password_salt, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ownerEmail, `Responsable CRM ${marker}`, salt, hashPassword(ownerPassword, salt)]
    );
    fixture.userId = owner.rows[0].id;
    await client.query(
      `INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [fixture.ownCompanyId, fixture.userId]
    );
    const driver = await client.query(
      `INSERT INTO drivers (company_id, name, traccar_unique_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [fixture.ownCompanyId, `Livreur CRM ${marker}`, `crm-${marker}`]
    );
    fixture.driverId = driver.rows[0].id;
    await client.query(`SELECT set_config('app.company_id', $1, true)`, [String(fixture.ownCompanyId)]);

    const ownCustomer = await client.query(
      `INSERT INTO customers (company_id, customer_code, display_name, created_by_user_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [fixture.ownCompanyId, `CRM-${marker}`, `Client CRM ${marker}`, fixture.userId]
    );
    fixture.ownCustomerId = ownCustomer.rows[0].id;
    await client.query(
      `INSERT INTO customer_contacts (
         company_id, customer_id, kind, label, value_display, value_normalized, value_hash, is_primary
       ) VALUES ($1, $2, 'phone', 'Principal', $3, $3, $4, TRUE)`,
      [fixture.ownCompanyId, fixture.ownCustomerId, `+22901${marker.slice(0, 8)}`, crypto.createHash('sha256').update(marker).digest('hex')]
    );
    await client.query(
      `INSERT INTO customer_locations (
         company_id, customer_id, label, neighborhood, address_text, landmark,
         latitude, longitude, accuracy_meters, coordinate_source, coordinates_captured_at
       ) VALUES ($1, $2, 'Livraison', 'Zone smoke', 'Adresse synthétique', 'Repère synthétique',
                 $3, $4, 7, 'operator', NOW())`,
      [fixture.ownCompanyId, fixture.ownCustomerId, ownLatitude, ownLongitude]
    );

    const foreignCompany = await client.query(
      `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Entreprise étrangère CRM ${marker}`, `crm-smoke-foreign-${marker}`]
    );
    fixture.companyIds.push(foreignCompany.rows[0].id);
    await client.query(`SELECT set_config('app.company_id', $1, true)`, [String(foreignCompany.rows[0].id)]);
    const foreignCustomer = await client.query(
      `INSERT INTO customers (company_id, customer_code, display_name)
       VALUES ($1, $2, $3) RETURNING id`,
      [foreignCompany.rows[0].id, `FOREIGN-${marker}`, `Client étranger CRM ${marker}`]
    );
    fixture.foreignCustomerId = foreignCustomer.rows[0].id;
    await client.query('COMMIT');
    return fixture;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixture(pool, fixture) {
  if (!fixture) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (fixture.userId) {
      await client.query('DELETE FROM app_sessions WHERE user_id = $1', [fixture.userId]);
    }
    for (const companyId of fixture.companyIds) {
      await client.query(`SELECT set_config('app.company_id', $1, true)`, [String(companyId)]);
      await client.query('DELETE FROM orders WHERE company_id = $1', [companyId]);
      await client.query('DELETE FROM customers WHERE company_id = $1', [companyId]);
      await client.query('DELETE FROM drivers WHERE company_id = $1', [companyId]);
    }
    if (fixture.userId) {
      await client.query('DELETE FROM company_memberships WHERE user_id = $1', [fixture.userId]);
      await client.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
    }
    if (fixture.companyIds.length) {
      await client.query('DELETE FROM companies WHERE id = ANY($1::bigint[])', [fixture.companyIds]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function run() {
  ensure(databaseUrl, 'DATABASE_URL est requis.');
  assertLocalTarget();

  const pool = new Pool({ connectionString: databaseUrl });
  const marker = crypto.randomBytes(10).toString('hex');
  let fixture;
  let runError;
  try {
    const health = await json(await fetch(`${baseUrl}/health`));
    ensure(health.response.ok && health.payload.status === 'ok', 'Le serveur local n’est pas prêt.');
    fixture = await insertFixture(pool, marker);

    const unauthenticated = await fetch(`${baseUrl}/api/app/crm/customers`);
    ensure(unauthenticated.status === 401, 'La liste CRM est accessible sans connexion.');

    const login = await fetch(`${baseUrl}/app/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: fixture.ownerEmail, password: fixture.ownerPassword }),
    });
    ensure(login.status === 302 && login.headers.get('location') === '/app',
      'La connexion du responsable CRM a échoué.');
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    ensure(cookie, 'Cookie de session CRM absent.');

    const context = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: cookie } }));
    ensure(context.response.ok && String(context.payload.company?.id) === String(fixture.ownCompanyId),
      'La session CRM n’est pas rattachée à la bonne entreprise.');

    const directOrder = await json(await fetch(`${baseUrl}/api/app/orders`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: `Client commande CRM ${marker}`,
        customerPhone: `+22901${marker.slice(0, 8)}`,
        deliveryAddress: `Adresse commande CRM ${marker}`,
        driverId: fixture.driverId,
      }),
    }));
    ensure(directOrder.response.status === 201, `La commande directe CRM a échoué (${directOrder.response.status}).`);
    const linkedOrder = await pool.query(
      `SELECT o.customer_id, o.customer_contact_id, o.customer_location_id, c.display_name
       FROM orders o
       JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
       WHERE o.id = $1 AND o.company_id = $2`,
      [directOrder.payload.orderId, fixture.ownCompanyId]
    );
    ensure(linkedOrder.rows[0]?.customer_id && linkedOrder.rows[0]?.customer_contact_id
      && linkedOrder.rows[0]?.customer_location_id,
    'La commande directe n’a pas créé ses liens CRM complets.');
    ensure(linkedOrder.rows[0].display_name.includes(marker),
      'La fiche CRM créée depuis la commande ne conserve pas le bon client.');

    const list = await json(await fetch(
      `${baseUrl}/api/app/crm/customers?q=${encodeURIComponent(marker)}&status=active&page=1&limit=20`,
      { headers: { Cookie: cookie } }
    ));
    ensure(list.response.ok, `La liste CRM est indisponible (${list.response.status}).`);
    ensure(containsCustomer(list.payload, fixture.ownCustomerId, marker),
      'Le client de l’entreprise est absent de la liste CRM.');
    ensure(!containsCustomer(list.payload, fixture.foreignCustomerId, `étranger CRM ${marker}`),
      'Un client d’une autre entreprise apparaît dans la liste CRM.');
    ensureCoordinatesArePrivate(list.payload, fixture.ownLatitude, fixture.ownLongitude, 'La liste CRM');

    const detail = await json(await fetch(`${baseUrl}/api/app/crm/customers/${fixture.ownCustomerId}`, {
      headers: { Cookie: cookie },
    }));
    ensure(detail.response.ok, `La fiche client CRM est indisponible (${detail.response.status}).`);
    ensure(JSON.stringify(detail.payload).includes(marker), 'La fiche CRM ne correspond pas au client demandé.');
    ensureCoordinatesArePrivate(detail.payload, fixture.ownLatitude, fixture.ownLongitude, 'La fiche CRM');

    const foreignDetail = await json(await fetch(`${baseUrl}/api/app/crm/customers/${fixture.foreignCustomerId}`, {
      headers: { Cookie: cookie },
    }));
    ensure(foreignDetail.response.status === 404,
      'L’identifiant d’un client étranger est lisible ou déductible.');
    ensure(!JSON.stringify(foreignDetail.payload).includes(`étranger CRM ${marker}`),
      'La réponse 404 révèle des informations sur le client étranger.');

    const invalidPeriod = await fetch(
      `${baseUrl}/api/app/crm/metrics?from=2026-02-30&to=2026-03-31`,
      { headers: { Cookie: cookie } }
    );
    ensure(invalidPeriod.status === 400, 'Une date civile invalide a été acceptée par les métriques CRM.');

    const excessivePeriod = await fetch(
      `${baseUrl}/api/app/crm/metrics?from=2025-01-01&to=2027-01-01`,
      { headers: { Cookie: cookie } }
    );
    ensure(excessivePeriod.status === 400, 'Une période supérieure à 366 jours a été acceptée.');

    const emptyMetrics = await json(await fetch(
      `${baseUrl}/api/app/crm/metrics?from=2026-01-01&to=2026-01-31`,
      { headers: { Cookie: cookie } }
    ));
    ensure(emptyMetrics.response.ok, `Les métriques CRM valides sont indisponibles (${emptyMetrics.response.status}).`);
    const deliveryRate = deliveryRateFrom(emptyMetrics.payload);
    ensure(deliveryRate, 'Le taux de livraison est absent des métriques CRM.');
    ensure(deliveryRate.status === 'not_calculable'
      && deliveryRate.value === null
      && Number(deliveryRate.denominator) === 0,
    'Un dénominateur nul doit rester non calculable, avec une valeur nulle.');

    const browserChecked = await verifyMobilePages(cookie);
    console.log(`Smoke CRM local réussi : connexion, cloisonnement, confidentialité GPS et métriques${browserChecked ? ', pages mobiles comprises' : ''}.`);
  } catch (error) {
    runError = error;
  } finally {
    try {
      await cleanupFixture(pool, fixture);
    } catch (cleanupError) {
      if (!runError) runError = new Error(`Nettoyage CRM incomplet : ${cleanupError.message}`);
    }
    await pool.end();
  }
  if (runError) throw runError;
}

run().catch((error) => {
  console.error(`Smoke CRM échoué : ${error.message}`);
  process.exitCode = 1;
});
