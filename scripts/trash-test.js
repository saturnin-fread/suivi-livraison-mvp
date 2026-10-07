// Corbeille : suppression définitive (responsables), gels légaux respectés,
// demandes détachées de leur commande, fiches clients, purge après 30 jours.
// Lancer avec TRASH_PURGE_START=2020-01-01T00:00:00Z pour tester l'échéance.
process.env.TRASH_PURGE_START = process.env.TRASH_PURGE_START || '2020-01-01T00:00:00Z';
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const { withCompanyTransaction } = require('../lib/crm-repository');
const trashPurge = require('../lib/trash-purge');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function login(user, password) {
  const res = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user, password }) });
  return cookieOf(res, 'delivery_session');
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const owner = await login(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD);
  assert.ok(owner, 'connexion propriétaire');
  const marker = Date.now().toString(36);
  const made = { users: [], drivers: [] };
  try {
    const cid = String((await call('GET', '/api/app/context', { cookie: owner })).data.company.id);
    // Opérateur de test
    const opEmail = `trash-op-${marker}@example.com`; const opPwd = `Corbeille-${marker}-op9`;
    const salt = crypto.randomBytes(16).toString('hex');
    const opId = (await pool.query(`INSERT INTO users (email, display_name, password_salt, password_hash) VALUES ($1, 'Op corbeille', $2, $3) RETURNING id`, [opEmail, salt, crypto.scryptSync(opPwd, salt, 64).toString('hex')])).rows[0].id;
    made.users.push(opId);
    await pool.query(`INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'operator')`, [cid, opId]);
    const op = await login(opEmail, opPwd);
    assert.ok(op, 'connexion opérateur');
    const drv = (await pool.query(`INSERT INTO drivers (company_id, name, traccar_unique_id, phone) VALUES ($1, $2, $3, '+22901970001') RETURNING id`, [cid, `Corbeille ${marker}`, `trash-${marker}`])).rows[0].id;
    made.drivers.push(drv);
    const newOrder = async (name) => {
      const r = await call('POST', '/api/app/orders', { cookie: owner, body: { customerName: `${name} ${marker}`, neighborhood: 'Akpakpa', driverId: drv } });
      assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
      const id = String(r.data.orderId || r.data.id);
      await pool.query(`UPDATE orders SET status = 'Livrée' WHERE id = $1`, [id]);
      return id;
    };

    // 1. Commande : à la corbeille, refus pour l'opérateur, suppression par le responsable
    const o1 = await newOrder('Purge');
    let r = await call('POST', '/api/app/ops/trash', { cookie: owner, body: { source: 'commandes', ids: [o1] } });
    assert.deepStrictEqual(r.data.done, [o1]);
    r = await call('POST', '/api/app/ops/purge', { cookie: op, body: { source: 'commandes', ids: [o1] } });
    assert.strictEqual(r.status, 403, 'opérateur : suppression définitive refusée');
    const o2 = await newOrder('Active');
    r = await call('POST', '/api/app/ops/purge', { cookie: owner, body: { source: 'commandes', ids: [o1, o2] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(r.data.done, [o1], 'seule la commande de la corbeille part');
    assert.strictEqual(r.data.skipped[0].id, o2, 'commande hors corbeille conservée');
    assert.strictEqual((await pool.query('SELECT count(*)::int n FROM orders WHERE id = $1', [o1])).rows[0].n, 0, 'commande effacée');
    assert.strictEqual((await pool.query('SELECT count(*)::int n FROM tracking_links WHERE order_id = $1', [o1])).rows[0].n, 0, 'lien de suivi effacé avec elle');
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE entity_type = 'order' AND entity_id = $1 AND action = 'purged'`, [o1])).rows[0], 'suppression journalisée');

    // 2. Gel légal : la commande reste
    await pool.query(`UPDATE orders SET archived_at = NOW() WHERE id = $1`, [o2]);
    await pool.query(`INSERT INTO order_retention_holds (company_id, order_id, reason, review_due_at, placed_idempotency_key, placed_fingerprint)
      VALUES ($1, $2, 'Litige client', NOW() + INTERVAL '30 days', $3, 'fp')`, [cid, o2, `hold-${marker}`]);
    r = await call('POST', '/api/app/ops/purge', { cookie: owner, body: { source: 'commandes', ids: [o2] } });
    assert.deepStrictEqual(r.data.done, [], 'commande gelée non supprimée');
    assert.match(r.data.skipped[0].reason, /gel légal/);

    // 3. Demande convertie en commande : la demande part, la commande reste
    r = await call('POST', '/api/app/requests/prefilled', { cookie: owner, body: { customerName: `Demande ${marker}`, customerPhone: '01 97 44 55 66', customerPhoneCountry: 'BJ', neighborhood: 'Ganhi' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const reqId = String(r.data.id);
    await pool.query(`UPDATE customer_requests SET status = 'Validée', location_lat = 6.37, location_lng = 2.42 WHERE id = $1`, [reqId]);
    r = await call('POST', `/api/app/requests/${reqId}/convert`, { cookie: owner, body: { driverId: drv } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const fromReq = String(r.data.orderId);
    r = await call('POST', '/api/app/ops/trash', { cookie: owner, body: { source: 'demandes', ids: [reqId] } });
    assert.deepStrictEqual(r.data.done, [reqId]);
    r = await call('POST', '/api/app/ops/purge', { cookie: owner, body: { source: 'demandes', ids: [reqId] } });
    assert.deepStrictEqual(r.data.done, [reqId], JSON.stringify(r.data));
    const kept = (await pool.query('SELECT customer_request_id FROM orders WHERE id = $1', [fromReq])).rows[0];
    assert.ok(kept && kept.customer_request_id === null, 'la commande issue de la demande reste, sans lien');

    // 4. Fiche client : corbeille du carnet, liste réservée, suppression définitive
    r = await call('POST', '/api/app/crm/customers', { cookie: owner, body: { displayName: `Client corbeille ${marker}`, phone: '01 97 66 77 88', phoneCountry: 'BJ', allowDuplicate: true } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const custId = String(r.data.customer?.id || r.data.id);
    await pool.query('UPDATE orders SET customer_id = $2, customer_contact_id = NULL, customer_location_id = NULL WHERE id = $1', [fromReq, custId]);
    r = await call('POST', '/api/app/crm/customers/bulk', { cookie: owner, body: { action: 'remove', ids: [custId] } });
    assert.deepStrictEqual(r.data.done, [custId]);
    r = await call('GET', '/api/app/crm/customers?all=1&removed=1', { cookie: op });
    assert.strictEqual(r.status, 403, 'corbeille du carnet réservée aux responsables');
    r = await call('GET', '/api/app/crm/customers?all=1&removed=1', { cookie: owner });
    const inTrash = r.data.customers.find((c) => String(c.id) === custId);
    assert.ok(inTrash && inTrash.removed_at, 'fiche visible dans la corbeille, avec sa date');
    r = await call('POST', '/api/app/crm/customers/purge', { cookie: op, body: { ids: [custId] } });
    assert.strictEqual(r.status, 403);
    r = await call('POST', '/api/app/crm/customers/purge', { cookie: owner, body: { ids: [custId] } });
    assert.deepStrictEqual(r.data.done, [custId], JSON.stringify(r.data));
    const gone = await withCompanyTransaction(pool, cid, (c) => c.query('SELECT count(*)::int n FROM customers WHERE id = $1', [custId]));
    assert.strictEqual(gone.rows[0].n, 0, 'fiche effacée');
    assert.strictEqual((await pool.query('SELECT customer_id FROM orders WHERE id = $1', [fromReq])).rows[0].customer_id, null, 'commande conservée, détachée de la fiche');

    // 5. Purge automatique : 30 jours après la mise à la corbeille
    const o3 = await newOrder('Vieille'); const o4 = await newOrder('Récente');
    await pool.query(`UPDATE orders SET archived_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [o3]);
    await pool.query(`UPDATE orders SET archived_at = NOW() - INTERVAL '29 days' WHERE id = $1`, [o4]);
    await pool.query(`UPDATE orders SET archived_at = NOW() - INTERVAL '40 days' WHERE id = $1`, [o2]);
    const totals = await trashPurge.purgeExpired(pool, (companyId, fn) => withCompanyTransaction(pool, companyId, fn));
    assert.ok(totals.commandes >= 1, JSON.stringify(totals));
    const left = (await pool.query('SELECT id::text FROM orders WHERE id = ANY($1::bigint[])', [[o2, o3, o4]])).rows.map((x) => x.id).sort();
    assert.deepStrictEqual(left, [o2, o4].sort(), 'après 30 jours : supprimée ; avant, ou gelée : conservée');
    // Date de purge affichée : jamais avant 30 jours pleins à partir de la mise en service
    assert.strictEqual(trashPurge.purgeAtOf('2020-01-02T00:00:00Z'), '2020-02-01T00:00:00.000Z');
    console.log('trash-test: OK');
  } finally {
    await pool.query(`UPDATE orders SET archived_at = NOW() WHERE customer_name LIKE $1`, [`% ${marker}`]).catch(() => {});
    if (made.drivers.length) await pool.query('UPDATE drivers SET active = FALSE WHERE id = ANY($1::bigint[])', [made.drivers]).catch(() => {});
    if (made.users.length) {
      await pool.query('DELETE FROM app_sessions WHERE user_id = ANY($1::bigint[])', [made.users]).catch(() => {});
      await pool.query('DELETE FROM company_memberships WHERE user_id = ANY($1::bigint[])', [made.users]).catch(() => {});
    }
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
