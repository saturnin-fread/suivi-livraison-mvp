const crypto = require('node:crypto');
const { Pool } = require('pg');
const { chromium } = require('playwright');

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function waitFor(check, message, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function run() {
  ensure(process.env.DATABASE_URL && process.env.ADMIN_USER, 'DATABASE_URL et ADMIN_USER sont requis.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
  const marker = crypto.randomBytes(10).toString('hex');
  const email = `offline-${marker}@example.invalid`;
  const password = `Offline-${marker}-Aa1!`;
  const ids = { orders: [] };
  let browser;
  try {
    const company = await pool.query(
      `SELECT m.company_id FROM users u JOIN company_memberships m ON m.user_id = u.id
       WHERE u.email = $1 AND m.role = 'owner' LIMIT 1`,
      [String(process.env.ADMIN_USER).trim().toLowerCase()]
    );
    ensure(company.rows[0], 'Entreprise de test introuvable.');
    ids.company = company.rows[0].company_id;
    const driver = await pool.query(
      `INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active)
       VALUES ($1, $2, $3, '22900009999', TRUE) RETURNING id`,
      [ids.company, `Livreur hors ligne ${marker}`, `offline-${marker}`]
    );
    ids.driver = driver.rows[0].id;
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await pool.query(
      `INSERT INTO users (email, display_name, password_salt, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, `Livreur hors ligne ${marker}`, salt, passwordHash(password, salt)]
    );
    ids.user = user.rows[0].id;
    await pool.query(
      `INSERT INTO company_memberships (company_id, user_id, role, driver_id)
       VALUES ($1, $2, 'driver', $3)`,
      [ids.company, ids.user, ids.driver]
    );
    const orders = await pool.query(
      `INSERT INTO orders (company_id, driver_id, customer_name, customer_phone, delivery_address, status)
       VALUES
         ($1, $2, $3, '22901010101', 'Destination hors ligne A', 'Confirmée'),
         ($1, $2, $4, '22902020202', 'Destination hors ligne B', 'Confirmée'),
         ($1, $2, $5, '22903030303', 'Destination paiement', 'En livraison')
       RETURNING id`,
      [ids.company, ids.driver, `Client sync ${marker}`, `Client conflit ${marker}`, `Client paiement ${marker}`]
    );
    ids.orders.push(...orders.rows.map((row) => row.id));
    await pool.query(
      `INSERT INTO order_payment_accounts (company_id, order_id, expected_amount_minor, currency, status)
       VALUES ($1, $2, 5000, 'XOF', 'pending')`,
      [ids.company, ids.orders[2]]
    );

    browser = await chromium.launch({ executablePath, headless: true });
    const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const page = await browserContext.newPage();
    await page.goto(`${baseUrl}/app/login`);
    await page.locator('input[name="user"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await Promise.all([page.waitForURL('**/driver'), page.locator('button.primary').click()]);
    const owner = `${ids.company}:${ids.user}:${ids.driver}`;

    await page.goto(`${baseUrl}/driver/commandes/${ids.orders[0]}`);
    await page.waitForSelector('.transition');
    const apiCacheHeader = await page.evaluate(async () => (await fetch('/api/driver/context')).headers.get('cache-control'));
    ensure(apiCacheHeader?.includes('no-store'), 'Les données authentifiées du livreur peuvent être mises en cache.');

    await browserContext.setOffline(true);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Colis récupéré' }).click();
    await page.waitForFunction(() => document.body.textContent.includes('Action enregistrée sur ce téléphone'));
    ensure(await page.getByRole('button', { name: 'Colis récupéré' }).isDisabled(), 'Une seconde transition reste possible avant synchronisation.');
    await page.selectOption('#incidentForm select[name="category"]', 'gps');
    await page.selectOption('#incidentForm select[name="severity"]', 'medium');
    await page.fill('#incidentForm textarea[name="description"]', 'Connexion coupée pendant le trajet de test');
    await page.locator('#incidentForm button').click();
    await page.waitForTimeout(750);
    const incidentFeedback = await page.locator('#incidentResult').innerText();
    ensure(incidentFeedback.includes('Incident enregistré sur ce téléphone'), `Retour incident inattendu : ${incidentFeedback || 'aucun message'}`);
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    ensure(!horizontalOverflow, 'L’indicateur hors ligne provoque un débordement horizontal sur mobile.');
    let queued = await page.evaluate((currentOwner) => DriverQueue.list(currentOwner), owner);
    ensure(queued.length === 2 && queued.every((item) => item.status === 'pending'), 'Les deux actions sûres n’ont pas été conservées hors ligne.');

    const cachedRequests = await page.evaluate(async () => {
      const keys = await caches.keys();
      const requests = (await Promise.all(keys.map(async (key) => (await caches.open(key)).keys()))).flat();
      return requests.map((request) => new URL(request.url).pathname);
    });
    ensure(!cachedRequests.some((pathname) => pathname.startsWith('/api/')), 'Une réponse API sensible a été mise en cache.');

    await browserContext.setOffline(false);
    await waitFor(async () => {
      const status = await pool.query('SELECT status FROM orders WHERE id = $1', [ids.orders[0]]);
      const incidents = await pool.query('SELECT COUNT(*)::int AS count FROM delivery_incidents WHERE order_id = $1', [ids.orders[0]]);
      return status.rows[0]?.status === 'Récupérée' && incidents.rows[0]?.count === 1;
    }, 'Les actions hors ligne n’ont pas été synchronisées.');
    queued = await page.evaluate((currentOwner) => DriverQueue.list(currentOwner), owner);
    ensure(queued.length === 0, 'La file locale n’a pas été vidée après confirmation du serveur.');
    const events = await pool.query(
      `SELECT COUNT(*)::int AS count FROM order_status_events
       WHERE order_id = $1 AND metadata->>'source' = 'driver_portal'`,
      [ids.orders[0]]
    );
    ensure(events.rows[0].count === 1, 'La reprise réseau a dupliqué le changement d’étape.');

    await page.goto(`${baseUrl}/driver/commandes/${ids.orders[1]}`);
    await page.waitForSelector('.transition');
    await browserContext.setOffline(true);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Colis récupéré' }).click();
    await pool.query("UPDATE orders SET status = 'Annulée', updated_at = NOW() WHERE id = $1", [ids.orders[1]]);
    await browserContext.setOffline(false);
    await waitFor(async () => {
      const items = await page.evaluate((currentOwner) => DriverQueue.list(currentOwner), owner);
      return items[0]?.status === 'attention';
    }, 'Un conflit métier n’a pas été conservé pour vérification.');
    await page.evaluate((currentOwner) => DriverQueue.clearOwner(currentOwner), owner);

    await page.goto(`${baseUrl}/driver/commandes/${ids.orders[2]}`);
    await page.waitForSelector('#paymentForm');
    await browserContext.setOffline(true);
    await page.locator('#paymentForm button').click();
    await page.waitForFunction(() => document.body.textContent.includes('encaissement doit être confirmé immédiatement'));
    queued = await page.evaluate((currentOwner) => DriverQueue.list(currentOwner), owner);
    ensure(queued.length === 0, 'Un encaissement a été enregistré localement alors qu’il doit rester en ligne.');
    await browserContext.setOffline(false);

    const queuePolicy = await page.evaluate(async ({ currentOwner, orderId }) => {
      const action = (suffix) => ({
        type: 'incident', owner: currentOwner, orderId: String(orderId),
        url: `/api/driver/orders/${orderId}/incidents`,
        idempotencyKey: `offline-policy-${suffix}`,
        payload: { category: 'gps', severity: 'low', description: 'Test de politique locale', idempotencyKey: `offline-policy-${suffix}` },
      });
      const realNow = Date.now;
      Date.now = () => realNow() - (25 * 60 * 60 * 1000);
      await DriverQueue.enqueue(action('expired'));
      Date.now = realNow;
      const expired = await DriverQueue.purgeExpired(currentOwner);
      await Promise.all(Array.from({ length: 30 }, (_, index) => DriverQueue.enqueue(action(`capacity-${index}`))));
      let capacityBlocked = false;
      try { await DriverQueue.enqueue(action('capacity-overflow')); } catch (_error) { capacityBlocked = true; }
      await DriverQueue.clearOwner(currentOwner);
      await DriverQueue.enqueue(action('session'));
      await DriverQueue.flush({ currentOwner, owner: currentOwner, fetchImpl: async () => new Response(JSON.stringify({ error: 'Session expirée.' }), { status: 401, headers: { 'Content-Type': 'application/json' } }) });
      const sessionState = (await DriverQueue.list(currentOwner))[0]?.status;
      await DriverQueue.clearOwner(currentOwner);
      return { expired, capacityBlocked, sessionState };
    }, { currentOwner: owner, orderId: ids.orders[2] });
    ensure(queuePolicy.expired === 1, 'Une action locale âgée de plus de 24 heures n’a pas été supprimée.');
    ensure(queuePolicy.capacityBlocked, 'La limite locale de 30 actions n’est pas appliquée.');
    ensure(queuePolicy.sessionState === 'attention', 'Une session expirée n’a pas suspendu la reprise.');

    await page.evaluate(async ({ currentOwner, orderId }) => DriverQueue.enqueue({
      type: 'incident', owner: currentOwner, orderId: String(orderId),
      url: `/api/driver/orders/${orderId}/incidents`, idempotencyKey: 'offline-logout-confirmation',
      payload: { category: 'gps', severity: 'low', description: 'Action à préserver', idempotencyKey: 'offline-logout-confirmation' },
    }), { currentOwner: owner, orderId: ids.orders[2] });
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('.driver-logout').click();
    queued = await page.evaluate((currentOwner) => DriverQueue.list(currentOwner), owner);
    ensure(queued.length === 1 && !page.url().endsWith('/app/login'), 'L’annulation de la déconnexion a perdu une action locale.');
    await page.evaluate((currentOwner) => DriverQueue.clearOwner(currentOwner), owner);

    console.log('Test navigateur hors ligne réussi : reprise unique, conflit visible, cache sûr, limites locales, déconnexion protégée et encaissement bloqué.');
  } finally {
    if (browser) await browser.close();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (ids.orders.length) {
        await client.query("DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = ANY($1::bigint[])", [ids.orders]);
        await client.query('DELETE FROM orders WHERE id = ANY($1::bigint[])', [ids.orders]);
      }
      if (ids.user) {
        await client.query('DELETE FROM app_sessions WHERE user_id = $1', [ids.user]);
        await client.query('DELETE FROM users WHERE id = $1', [ids.user]);
      }
      if (ids.driver) {
        await client.query("DELETE FROM audit_logs WHERE entity_type = 'driver' AND entity_id = $1", [ids.driver]);
        await client.query('DELETE FROM drivers WHERE id = $1', [ids.driver]);
      }
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
  console.error(`Test navigateur hors ligne échoué : ${error.stack || error.message}`);
  process.exitCode = 1;
});
