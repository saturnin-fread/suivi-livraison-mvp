// Prix indicatifs : saisis sur la demande ou la commande, recopiés à la
// conversion, repris dans les rapports (chiffre d'affaires). Aucun encaissement.
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const JSZip = require('jszip');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = {}; try { data = JSON.parse(buf.toString('utf8')); } catch { data = { raw: buf }; }
  return { status: res.status, data, buf };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const owner = cookieOf(login, 'delivery_session');
  assert.ok(owner, 'connexion');
  const marker = Date.now().toString(36);
  const made = { requests: [], orders: [], drivers: [] };
  try {
    const cid = (await call('GET', '/api/app/context', { cookie: owner })).data.company.id;
    const drv = (await pool.query(`INSERT INTO drivers (company_id, name, traccar_unique_id, phone) VALUES ($1, $2, $3, '+22901970000') RETURNING id`, [cid, `Prix ${marker}`, `prix-${marker}`])).rows[0].id;
    made.drivers.push(drv);

    // Demande préremplie avec prix
    let r = await call('POST', '/api/app/requests/prefilled', { cookie: owner, body: { customerName: `Client prix ${marker}`, customerPhone: '01 97 11 22 33', customerPhoneCountry: 'BJ', neighborhood: 'Ganhi', deliveryFee: 1500, orderAmount: 25000 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const reqId = r.data.id; made.requests.push(reqId);
    r = await call('GET', `/api/app/requests/${reqId}`, { cookie: owner });
    assert.strictEqual(r.data.commercial?.deliveryFeeMinor, 1500, 'prix de livraison enregistré');
    assert.strictEqual(r.data.commercial?.declaredValueMinor, 25000, 'montant de la commande enregistré');
    r = await call('POST', '/api/app/requests/prefilled', { cookie: owner, body: { customerName: `Mauvais ${marker}`, customerPhone: '01 97 11 22 34', customerPhoneCountry: 'BJ', neighborhood: 'Ganhi', deliveryFee: -3 } });
    assert.strictEqual(r.status, 400, 'prix négatif refusé');
    // Modification depuis la demande
    r = await call('PATCH', `/api/app/requests/${reqId}/prices`, { cookie: owner, body: { deliveryFee: 2000, orderAmount: '' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.commercial.deliveryFeeMinor, 2000);
    assert.ok(!('declaredValueMinor' in r.data.commercial), 'montant effacé');
    r = await call('PATCH', `/api/app/requests/${reqId}/prices`, { cookie: owner, body: { deliveryFee: 2000, orderAmount: 30000 } });
    // Conversion : la commande reprend les prix
    await pool.query(`UPDATE customer_requests SET status = 'Validée', location_lat = 6.37, location_lng = 2.42 WHERE id = $1`, [reqId]);
    r = await call('POST', `/api/app/requests/${reqId}/convert`, { cookie: owner, body: { driverId: drv } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const orderId = r.data.orderId; made.orders.push(orderId);
    const ord = (await pool.query('SELECT commercial FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.strictEqual(ord.commercial.deliveryFeeMinor, 2000, 'prix recopié sur la commande');
    assert.strictEqual(ord.commercial.declaredValueMinor, 30000);

    // Commande directe avec prix
    r = await call('POST', '/api/app/orders', { cookie: owner, body: { customerName: `Direct ${marker}`, neighborhood: 'Akpakpa', driverId: drv, deliveryFee: 1000, orderAmount: 8000 } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const directId = r.data.orderId || r.data.id; made.orders.push(directId);
    await pool.query(`UPDATE orders SET status = 'Livrée' WHERE id = $1`, [directId]);

    // Rapports : colonnes et chiffre d'affaires
    const today = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Africa/Porto-Novo' }).format(new Date());
    const sel = { sources: ['orders'], filters: { from: today, to: today, query: marker } };
    r = await call('POST', '/api/app/reports/preview', { cookie: owner, body: sel });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const rows = r.data.families[0].rows;
    const direct = rows.find((x) => x.client === `Direct ${marker}`);
    assert.ok(direct && direct.deliveryFee === 1000 && direct.orderAmount === 8000, `prix dans l’aperçu (${JSON.stringify(direct)})`);
    assert.ok(r.data.families[0].fields.includes('deliveryFee'), 'colonne prix disponible');
    r = await call('POST', '/api/app/reports/export', { cookie: owner, body: { ...sel, format: 'csv' } });
    assert.strictEqual(r.status, 200);
    const csv = r.buf.toString('utf8');
    assert.ok(/Prix livraison \(FCFA\)/.test(csv) && /"?1000"?;"?8000"?;/.test(csv), 'CSV avec prix');
    // Excel (mois Premium accordé pour le test)
    await pool.query(`INSERT INTO company_export_access (company_id, premium_month_until) VALUES ($1, NOW() + INTERVAL '1 day')
      ON CONFLICT (company_id) DO UPDATE SET premium_month_until = GREATEST(company_export_access.premium_month_until, NOW() + INTERVAL '1 day')`, [cid]);
    r = await call('POST', '/api/app/reports/export', { cookie: owner, body: { ...sel, format: 'xlsx' } });
    assert.strictEqual(r.status, 200, r.buf.toString('utf8').slice(0, 200));
    const zip = await JSZip.loadAsync(r.buf);
    const synth = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const shared = await zip.file('xl/sharedStrings.xml')?.async('string') || '';
    assert.ok(/SUMIFS\(Commandes!/.test(synth), 'chiffre d’affaires calculé par Excel (SUMIFS)');
    assert.ok(/Chiffre d’affaires indicatif/.test(shared + synth), 'bloc chiffre d’affaires');
    console.log('prices-test: OK');
  } finally {
    if (made.orders.length) await pool.query('UPDATE orders SET archived_at = NOW() WHERE id = ANY($1::bigint[])', [made.orders]).catch(() => {});
    if (made.requests.length) await pool.query('UPDATE customer_requests SET archived_at = NOW() WHERE id = ANY($1::bigint[])', [made.requests]).catch(() => {});
    if (made.drivers.length) await pool.query('UPDATE drivers SET active = FALSE WHERE id = ANY($1::bigint[])', [made.drivers]).catch(() => {});
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
