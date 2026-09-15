const crypto = require('node:crypto');
const { Pool } = require('pg');

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const email = process.env.ADMIN_USER;
const password = process.env.ADMIN_PASSWORD;
const nativeFetch = global.fetch;
global.fetch = (url, options = {}) => nativeFetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) });

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response) {
  return { response, payload: await response.json().catch(() => ({})) };
}

async function verifyBrowser(cookie, driverId, driverName) {
  if (process.env.RUN_BROWSER_TEST !== '1') return;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXECUTABLE || undefined,
  });
  try {
    const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const [name, value] = cookie.split('=');
    await browserContext.addCookies([{ name, value, url: baseUrl }]);
    const page = await browserContext.newPage();
    await page.goto(`${baseUrl}/app/carte`, { waitUntil: 'domcontentloaded' });
    await page.locator('#operationsMap .leaflet-control-zoom').waitFor({ state: 'visible' });
    await page.locator('#mapDriverSelect').selectOption(String(driverId));
    await page.locator('#operationsPanel').getByText(driverName, { exact: true }).waitFor({ state: 'visible' });
    ensure(await page.locator('.destination-map-marker.selected').count() === 2,
      'La carte mobile ne montre pas les deux destinations planifiées restantes.');
    ensure(await page.locator('.run-map-card').count() >= 2,
      'La tournée et les commandes hors tournée ne sont pas séparées dans le panneau.');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ensure(!overflow, 'La carte d’exploitation déborde horizontalement sur mobile.');
    await page.locator('#showDestinations').uncheck();
    ensure(await page.locator('.destination-map-marker').count() === 0,
      'Le filtre des destinations ne masque pas les marqueurs.');
  } finally {
    await browser.close();
  }
}

async function run() {
  ensure(email && password && process.env.DATABASE_URL, 'ADMIN_USER, ADMIN_PASSWORD et DATABASE_URL sont requis.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
  const marker = crypto.randomBytes(10).toString('hex');
  const ids = { drivers: [], orders: [], runs: [], incidents: [] };
  let foreignCompanyId;
  try {
    const login = await fetch(`${baseUrl}/app/login`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: email, password }),
    });
    ensure(login.status === 302, 'Connexion propriétaire impossible.');
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    ensure(cookie, 'Cookie de session absent.');
    const context = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: cookie } }));
    ensure(context.response.ok, 'Contexte entreprise indisponible.');
    const companyId = context.payload.company.id;
    const driverName = `Livreur carte ${marker}`;
    const hiddenUniqueId = `map-secret-${marker}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const driver = await client.query(
        `INSERT INTO drivers (company_id, name, phone, vehicle_type, capacity, traccar_unique_id)
         VALUES ($1, $2, '+22901020304', 'Moto', 4, $3) RETURNING id`,
        [companyId, driverName, hiddenUniqueId]
      );
      ids.drivers.push(driver.rows[0].id);
      const orders = await client.query(
        `INSERT INTO orders (
           company_id, driver_id, customer_name, delivery_address, neighborhood,
           destination_lat, destination_lng, destination_accuracy, status
         ) VALUES
           ($1, $2, $3, 'Portail bleu', 'Calavi', 6.4481, 2.3557, 12, 'Confirmée'),
           ($1, $2, $4, 'Près du marché', 'Godomey', 6.3891, 2.3451, 18, 'En tournée'),
           ($1, $2, $5, 'Sans GPS', 'Akassato', NULL, NULL, NULL, 'En préparation'),
           ($1, $2, $6, 'Déjà remis', 'Cotonou', 6.3703, 2.3912, 10, 'Livrée')
         RETURNING id`,
        [companyId, driver.rows[0].id, `Client A ${marker}`, `Client B ${marker}`, `Client C ${marker}`, `Client terminé ${marker}`]
      );
      ids.orders.push(...orders.rows.map((row) => row.id));
      const serviceDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const deliveryRun = await client.query(
        `INSERT INTO delivery_runs (
           company_id, driver_id, name, service_date, status, create_idempotency_key, create_fingerprint
         ) VALUES ($1, $2, $3, $4, 'planned', $5, $6) RETURNING id`,
        [companyId, driver.rows[0].id, `Tournée carte ${marker}`, serviceDate, `map-run:${marker}`, marker]
      );
      ids.runs.push(deliveryRun.rows[0].id);
      await client.query(
        `INSERT INTO delivery_stops (company_id, run_id, order_id, sequence)
         VALUES ($1, $2, $3, 1), ($1, $2, $4, 2)`,
        [companyId, deliveryRun.rows[0].id, orders.rows[0].id, orders.rows[1].id]
      );
      const incident = await client.query(
        `INSERT INTO delivery_incidents (
           company_id, order_id, category, severity, description, idempotency_key, request_fingerprint
         ) VALUES ($1, $2, 'adresse', 'medium', 'Repère à confirmer pour le test carte', $3, $4) RETURNING id`,
        [companyId, orders.rows[2].id, `map-incident:${marker}`, marker]
      );
      ids.incidents.push(incident.rows[0].id);

      const foreignCompany = await client.query(
        `INSERT INTO companies (name) VALUES ($1) RETURNING id`, [`Entreprise étrangère ${marker}`]
      );
      foreignCompanyId = foreignCompany.rows[0].id;
      const foreignDriver = await client.query(
        `INSERT INTO drivers (company_id, name, traccar_unique_id) VALUES ($1, $2, $3) RETURNING id`,
        [foreignCompanyId, `Livreur étranger ${marker}`, `foreign-map-${marker}`]
      );
      ids.drivers.push(foreignDriver.rows[0].id);
      const foreignOrder = await client.query(
        `INSERT INTO orders (company_id, driver_id, customer_name, delivery_address, destination_lat, destination_lng, status)
         VALUES ($1, $2, $3, 'Adresse étrangère', 7.1, 2.2, 'Confirmée') RETURNING id`,
        [foreignCompanyId, foreignDriver.rows[0].id, `Client étranger ${marker}`]
      );
      ids.orders.push(foreignOrder.rows[0].id);
      const foreignRun = await client.query(
        `INSERT INTO delivery_runs (
           company_id, driver_id, name, service_date, status, create_idempotency_key, create_fingerprint
         ) VALUES ($1, $2, $3, $4, 'planned', $5, $6) RETURNING id`,
        [foreignCompanyId, foreignDriver.rows[0].id, `Tournée étrangère ${marker}`, serviceDate, `foreign-map-run:${marker}`, marker]
      );
      ids.runs.push(foreignRun.rows[0].id);
      await client.query(
        `INSERT INTO delivery_stops (company_id, run_id, order_id, sequence)
         VALUES ($1, $2, $3, 1)`,
        [foreignCompanyId, foreignRun.rows[0].id, foreignOrder.rows[0].id]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const response = await json(await fetch(`${baseUrl}/api/app/operations-map`, { headers: { Cookie: cookie } }));
    ensure(response.response.ok, `Instantané cartographique indisponible (${response.response.status}).`);
    ensure(Array.isArray(response.payload.drivers), 'La liste cartographique des livreurs est absente.');
    const visibleDriver = response.payload.drivers.find((driver) => String(driver.id) === String(ids.drivers[0]));
    ensure(visibleDriver, 'Le livreur autorisé est absent de la carte.');
    ensure(!response.payload.drivers.some((driver) => String(driver.id) === String(ids.drivers[1])),
      'Un livreur d’une autre entreprise est visible.');
    ensure(!JSON.stringify(response.payload).includes(hiddenUniqueId),
      'L’identifiant technique Traccar ne doit pas être envoyé au navigateur.');
    ensure(visibleDriver.activeOrders === 3, 'Les commandes terminales ne sont pas exclues de la charge active.');
    ensure(visibleDriver.openIncidents === 1, 'Le compteur d’incidents ouverts est incorrect.');
    ensure(visibleDriver.runs.length === 1 && visibleDriver.runs[0].stops.length === 2,
      'La tournée ou ses arrêts restants sont absents.');
    ensure(visibleDriver.runs[0].stops.map((stop) => stop.sequence).join(',') === '1,2',
      'L’ordre confirmé des arrêts n’est pas respecté.');
    ensure(visibleDriver.unplannedOrders.length === 1 && !visibleDriver.unplannedOrders[0].destination,
      'La commande hors tournée ou sa destination manquante est mal représentée.');
    ensure(response.payload.summary.locatedDestinations >= 2,
      'Les destinations GPS valides ne sont pas comptabilisées.');
    ensure(!JSON.stringify(response.payload).includes(`Client étranger ${marker}`),
      'Une commande d’une autre entreprise est visible.');
    ensure(response.payload.mapConfig?.base?.url, 'La configuration du fond cartographique est absente.');

    const routeResponse = await json(await fetch(`${baseUrl}/api/app/runs/${ids.runs[0]}/route`, { headers: { Cookie: cookie } }));
    ensure(routeResponse.response.ok && String(routeResponse.payload.run?.id) === String(ids.runs[0]),
      'La route interne de la tournée autorisée est indisponible.');
    ensure(routeResponse.payload.route?.status === 'unavailable'
      && routeResponse.payload.route?.failure?.code === 'provider_disabled'
      && routeResponse.payload.route?.distanceMeters == null
      && routeResponse.payload.route?.durationSeconds == null
      && routeResponse.payload.route?.geometry == null,
    'Le fournisseur désactivé doit rester explicite et ne jamais inventer de route ou de durée.');
    const foreignRoute = await fetch(`${baseUrl}/api/app/runs/${ids.runs[1]}/route`, { headers: { Cookie: cookie } });
    ensure(foreignRoute.status === 404, 'Une tournée étrangère ne doit pas être déductible par l’endpoint routier.');

    const [leafletScript, leafletStyle, mapPage] = await Promise.all([
      fetch(`${baseUrl}/vendor/leaflet/leaflet.js`),
      fetch(`${baseUrl}/vendor/leaflet/leaflet.css`),
      fetch(`${baseUrl}/app/carte`, { headers: { Cookie: cookie } }),
    ]);
    ensure(leafletScript.ok && leafletStyle.ok && mapPage.ok,
      'Les ressources locales de la carte ou la page entreprise sont indisponibles.');
    await verifyBrowser(cookie, ids.drivers[0], driverName);
    console.log(`Smoke carte réussi : cloisonnement, charge active, incidents, tournées, ordre des arrêts et ressources locales${process.env.RUN_BROWSER_TEST === '1' ? ', mobile compris' : ''}.`);
  } finally {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (ids.runs.length) await client.query('DELETE FROM delivery_runs WHERE id = ANY($1::bigint[])', [ids.runs]);
      if (ids.orders.length) await client.query('DELETE FROM orders WHERE id = ANY($1::bigint[])', [ids.orders]);
      if (ids.drivers.length) await client.query('DELETE FROM drivers WHERE id = ANY($1::bigint[])', [ids.drivers]);
      if (foreignCompanyId) await client.query('DELETE FROM companies WHERE id = $1', [foreignCompanyId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
}

run().catch((error) => {
  console.error(`Smoke carte échoué : ${error.message}`);
  process.exitCode = 1;
});
