// Opérations : corbeille réversible, vues enregistrées, capacité à
// l'attribution, champs enrichis de la liste et recherche serveur.
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { res, status: res.status, data: await res.json().catch(() => ({})) };
}
const key = () => crypto.randomUUID();

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  const created = { drivers: [], views: [] };
  try {
    const cid = (await pool.query('SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1', [process.env.ADMIN_USER])).rows[0]?.company_id
      || (await pool.query('SELECT id FROM companies ORDER BY id LIMIT 1')).rows[0].id;
    const mkDriver = async (name, capacity) => (await pool.query(
      `INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active, capacity) VALUES ($1, $2, $3, '22900000088', TRUE, $4) RETURNING id`,
      [cid, `${name} ${marker}`, `ops-${name}-${marker}`, capacity]
    )).rows[0].id;
    const d1 = await mkDriver('Ops A', 5);
    const d2 = await mkDriver('Ops B', 1);
    created.drivers.push(d1, d2);
    const order = async (extra = {}) => {
      const r = await call('POST', '/api/app/orders', { cookie: staff, body: { customerName: `Ops ${marker}`, customerPhone: '01 97 44 55 66', customerPhoneCountry: 'BJ', neighborhood: 'Akpakpa', driverId: d1, ...extra } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      return String(r.data.orderId);
    };

    // Liste enrichie
    const o1 = await order({ packageType: 'documents', packageDescription: 'Contrat', pickupEnabled: true, pickupAddress: 'Dantokpa' });
    const o2 = await order();
    let list = await call('GET', '/api/app/orders', { cookie: staff });
    let row = list.data.find((r) => String(r.id) === o1);
    assert.ok(row, 'commande listée');
    assert.strictEqual(row.package_type, 'documents');
    assert.strictEqual(row.has_pickup, true);
    assert.ok('customer_id' in row && 'expected_amount_minor' in row, 'champs client et montant présents');
    assert.strictEqual(list.res.headers.get('x-list-limit'), '500');

    // Recherche serveur
    const ref = row.reference;
    let found = await call('GET', `/api/app/orders?q=${encodeURIComponent(ref)}`, { cookie: staff });
    assert.deepStrictEqual(found.data.map((r) => String(r.id)), [o1], 'recherche par référence');
    found = await call('GET', `/api/app/orders?q=${encodeURIComponent('%')}`, { cookie: staff });
    assert.strictEqual(found.data.length, 0, 'le joker SQL est échappé');

    // Corbeille : une commande en cours est refusée
    let r = await call('POST', '/api/app/ops/trash', { cookie: staff, body: { source: 'commandes', ids: [o1] } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.done, []);
    assert.strictEqual(r.data.skipped[0].id, o1);
    r = await call('POST', `/api/app/orders/${o2}/transition`, { cookie: staff, body: { toStatus: 'Annulée', reason: 'Client absent, annulation test', idempotencyKey: key() } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const before = (await call('GET', '/api/app/summary', { cookie: staff })).data;
    r = await call('POST', '/api/app/ops/trash', { cookie: staff, body: { source: 'commandes', ids: [o2, o1] } });
    assert.deepStrictEqual(r.data.done, [o2], 'commande annulée mise à la corbeille');
    list = await call('GET', '/api/app/orders', { cookie: staff });
    assert.ok(!list.data.some((x) => String(x.id) === o2), 'retirée de la liste active');
    const trash = await call('GET', '/api/app/orders?trash=1', { cookie: staff });
    assert.ok(trash.data.some((x) => String(x.id) === o2), 'visible dans la corbeille');
    const all = await call('GET', '/api/app/orders?trash=all', { cookie: staff });
    assert.ok(all.data.some((x) => String(x.id) === o2) && all.data.some((x) => String(x.id) === o1), 'rapports : tout');
    const after = (await call('GET', '/api/app/summary', { cookie: staff })).data;
    assert.strictEqual(Number(after.orders), Number(before.orders) - 1, 'compteur commandes');
    assert.strictEqual(Number(after.orders_trash), Number(before.orders_trash) + 1, 'compteur corbeille');
    let detail = (await call('GET', `/api/app/orders/${o2}`, { cookie: staff })).data;
    assert.ok(detail.opsActivity.some((a) => a.action === 'trashed'), 'activité : mise à la corbeille');
    r = await call('POST', '/api/app/ops/restore', { cookie: staff, body: { source: 'commandes', ids: [o2] } });
    assert.deepStrictEqual(r.data.done, [o2], 'restaurée');
    list = await call('GET', '/api/app/orders', { cookie: staff });
    assert.ok(list.data.some((x) => String(x.id) === o2), 'de retour dans la liste');

    // Validation des entrées
    r = await call('POST', '/api/app/ops/trash', { cookie: staff, body: { source: 'tournees', ids: [o2] } });
    assert.strictEqual(r.status, 400, 'source refusée');
    r = await call('POST', '/api/app/ops/trash', { cookie: staff, body: { source: 'commandes', ids: [] } });
    assert.strictEqual(r.status, 400, 'liste vide refusée');

    // Incidents : seul un incident résolu va à la corbeille
    r = await call('POST', `/api/app/orders/${o1}/incidents`, { cookie: staff, body: { category: 'adresse', severity: 'low', description: 'Adresse imprécise test', idempotencyKey: key() } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const inc = String(r.data.incidentId || r.data.id || r.data.incident?.id);
    r = await call('POST', '/api/app/ops/trash', { cookie: staff, body: { source: 'incidents', ids: [inc] } });
    assert.deepStrictEqual(r.data.done, [], 'incident ouvert refusé');
    r = await call('POST', `/api/app/incidents/${inc}/resolve`, { cookie: staff, body: { resolution: 'Adresse confirmée par appel', idempotencyKey: key() } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await call('POST', '/api/app/ops/trash', { cookie: staff, body: { source: 'incidents', ids: [inc] } });
    assert.deepStrictEqual(r.data.done, [inc], 'incident résolu à la corbeille');
    let incs = await call('GET', '/api/app/incidents?scope=all', { cookie: staff });
    assert.ok(!incs.data.some((x) => String(x.id) === inc), 'incident retiré');
    incs = await call('GET', '/api/app/incidents?scope=all&trash=1', { cookie: staff });
    assert.ok(incs.data.some((x) => String(x.id) === inc), 'incident dans la corbeille');
    await call('POST', '/api/app/ops/restore', { cookie: staff, body: { source: 'incidents', ids: [inc] } });

    // Demandes : corbeille = archivage, la restauration rend le statut d'avant
    r = await call('POST', '/api/app/request-links', { cookie: staff, body: { idempotencyKey: key() } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const reqId = String((await pool.query('SELECT id FROM customer_requests WHERE token = $1', [r.data.token])).rows[0].id);
    const statusBefore = (await pool.query('SELECT status FROM customer_requests WHERE id = $1', [reqId])).rows[0].status;
    r = await call('POST', '/api/app/ops/trash', { cookie: staff, body: { source: 'demandes', ids: [reqId] } });
    assert.deepStrictEqual(r.data.done, [reqId]);
    let reqs = await call('GET', '/api/app/requests?scope=archived', { cookie: staff });
    assert.ok(reqs.data.some((x) => String(x.id) === reqId), 'demande archivée');
    r = await call('POST', '/api/app/ops/restore', { cookie: staff, body: { source: 'demandes', ids: [reqId] } });
    assert.deepStrictEqual(r.data.done, [reqId]);
    const statusAfter = (await pool.query('SELECT status, archived_at FROM customer_requests WHERE id = $1', [reqId])).rows[0];
    assert.strictEqual(statusAfter.status, statusBefore, 'statut d’origine rendu');
    assert.strictEqual(statusAfter.archived_at, null);

    // Capacité : le livreur B (capacité 1) est complet après une commande
    const o3 = await order();
    r = await call('POST', `/api/app/orders/${o3}/reassign`, { cookie: staff, body: { driverId: d2, checkCapacity: true } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await call('POST', `/api/app/orders/${o1}/reassign`, { cookie: staff, body: { driverId: d2, checkCapacity: true } });
    assert.strictEqual(r.status, 409, 'livreur complet');
    assert.strictEqual(r.data.code, 'driver_full');
    r = await call('POST', `/api/app/orders/${o1}/reassign`, { cookie: staff, body: { driverId: d2 } });
    assert.strictEqual(r.status, 200, 'sans contrôle : comportement inchangé');
    detail = (await call('GET', `/api/app/orders/${o3}`, { cookie: staff })).data;
    const act = detail.opsActivity.find((a) => a.action === 'reassigned');
    assert.ok(act && act.to_driver_name === `Ops B ${marker}`, 'activité : attribution avec nom du livreur');

    // Vues enregistrées
    r = await call('POST', '/api/app/ops/views', { cookie: staff, body: { source: 'commandes', name: `  Akpakpa   ${marker} `, config: { layout: 'cards', pageSize: 20, columns: ['client', 'zone', 'BAD-COL', 'zone'], filters: { zone: ['Akpakpa'], driver: [String(d1), 'x'] }, sort: { key: 'date', dir: -1 }, evil: '<script>' } } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const view = r.data;
    created.views.push(view.id);
    assert.strictEqual(view.name, `Akpakpa ${marker}`, 'nom nettoyé');
    assert.deepStrictEqual(view.config.columns, ['client', 'zone'], 'colonnes filtrées');
    assert.deepStrictEqual(view.config.filters.driver, [String(d1)]);
    assert.strictEqual(view.config.pageSize, 20);
    assert.ok(!('evil' in view.config), 'clé inconnue ignorée');
    assert.strictEqual(view.mine, true);
    r = await call('POST', '/api/app/ops/views', { cookie: staff, body: { source: 'factures', name: 'x' } });
    assert.strictEqual(r.status, 400, 'source inconnue');
    r = await call('POST', '/api/app/ops/views', { cookie: staff, body: { source: 'commandes', name: '' } });
    assert.strictEqual(r.status, 400, 'nom vide');
    r = await call('PATCH', `/api/app/ops/views/${view.id}`, { cookie: staff, body: { name: `Akpakpa copie ${marker}`, config: { layout: 'table', pageSize: 7 } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.config.pageSize, 10, 'taille hors liste ramenée à 10');
    let views = await call('GET', '/api/app/ops/views', { cookie: staff });
    assert.ok(views.data.some((v) => v.id === view.id && v.name === `Akpakpa copie ${marker}`));
    // Isolement : une autre entreprise ne voit pas la vue
    const otherCo = (await pool.query(`INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Autre ${marker}`, `autre-${marker}`])).rows[0].id;
    const foreign = (await pool.query(`INSERT INTO ops_views (company_id, user_id, source, name, shared) VALUES ($1, 1, 'commandes', 'Étrangère', TRUE) RETURNING id`, [otherCo])).rows[0].id;
    views = await call('GET', '/api/app/ops/views', { cookie: staff });
    assert.ok(!views.data.some((v) => v.id === String(foreign)), 'vue d’une autre entreprise invisible');
    r = await call('DELETE', `/api/app/ops/views/${foreign}`, { cookie: staff });
    assert.strictEqual(r.status, 404, 'suppression hors entreprise refusée');
    await pool.query('DELETE FROM companies WHERE id = $1', [otherCo]);
    r = await call('DELETE', `/api/app/ops/views/${view.id}`, { cookie: staff });
    assert.strictEqual(r.status, 200);
    created.views = [];

    // Informations commerciales
    r = await call('PATCH', `/api/app/orders/${o1}/commercial`, { cookie: staff, body: { items: [{ name: 'Robe', qty: 0, unitMinor: 5000 }] } });
    assert.strictEqual(r.status, 400, 'quantité nulle refusée');
    r = await call('PATCH', `/api/app/orders/${o1}/commercial`, { cookie: staff, body: { weightKg: 'lourd' } });
    assert.strictEqual(r.status, 400, 'poids invalide refusé');
    r = await call('PATCH', `/api/app/orders/${o1}/commercial`, { cookie: staff, body: { merchantPayment: 'banque' } });
    assert.strictEqual(r.status, 400, 'règlement inconnu refusé');
    r = await call('PATCH', `/api/app/orders/${o1}/commercial`, { cookie: staff, body: { sellerReference: ' BOUT-1247 ', items: [{ name: 'Produits de soin', qty: 3, unitMinor: 8000 }, { name: '  ', qty: 1, unitMinor: 1 }], weightKg: '0,8', deliveryFeeMinor: 2000, merchantPayment: 'paid', evil: 1 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(r.data.commercial, { sellerReference: 'BOUT-1247', items: [{ name: 'Produits de soin', qty: 3, unitMinor: 8000 }], deliveryFeeMinor: 2000, weightKg: 0.8, merchantPayment: 'paid' });
    list = await call('GET', '/api/app/orders', { cookie: staff });
    row = list.data.find((x) => String(x.id) === o1);
    assert.strictEqual(row.commercial.items[0].qty, 3, 'liste : articles');
    assert.ok('customer_email' in row, 'liste : e-mail client');
    detail = (await call('GET', `/api/app/orders/${o1}`, { cookie: staff })).data;
    assert.ok(detail.opsActivity.some((a) => a.action === 'commercial_updated'), 'activité : informations commerciales');
    r = await call('PATCH', `/api/app/orders/${o1}/commercial`, { cookie: staff, body: {} });
    assert.strictEqual(r.data.commercial, null, 'effacement');

    // Refus de demande avec motif conservé
    r = await call('POST', '/api/app/request-links', { cookie: staff, body: { idempotencyKey: key() } });
    const req2 = String((await pool.query('SELECT id FROM customer_requests WHERE token = $1', [r.data.token])).rows[0].id);
    r = await call('POST', `/api/app/requests/${req2}/status`, { cookie: staff, body: { status: 'Refusée', reason: 'Zone pas encore desservie' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const audit = (await pool.query(`SELECT details FROM audit_logs WHERE entity_type = 'customer_request' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [req2])).rows[0];
    assert.strictEqual(audit.details.reason, 'Zone pas encore desservie', 'motif conservé');

    // Fiche client : compteur d'incidents ouverts
    const cust = (await pool.query('SELECT customer_id FROM orders WHERE id = $1', [o1])).rows[0].customer_id;
    if (cust) {
      const c = await call('GET', `/api/app/crm/customers/${cust}`, { cookie: staff });
      assert.strictEqual(c.status, 200);
      assert.strictEqual(typeof c.data.openIncidents, 'number');
      let u = await call('PATCH', `/api/app/crm/customers/${cust}`, { cookie: staff, body: { preferredChannel: 'pigeon' } });
      assert.strictEqual(u.status, 400, 'canal inconnu refusé');
      u = await call('PATCH', `/api/app/crm/customers/${cust}`, { cookie: staff, body: { preferredChannel: 'whatsapp', preferredLanguage: 'Fon' } });
      assert.strictEqual(u.status, 200, JSON.stringify(u.data));
      const c2 = await call('GET', `/api/app/crm/customers/${cust}`, { cookie: staff });
      assert.deepStrictEqual([c2.data.customer.preferred_channel, c2.data.customer.preferred_language], ['whatsapp', 'Fon']);
    }
    console.log('ops-test: OK');
  } finally {
    if (created.views.length) await pool.query('DELETE FROM ops_views WHERE id = ANY($1::bigint[])', [created.views]);
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
