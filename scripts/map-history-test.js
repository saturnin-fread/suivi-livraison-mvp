// Trajets : historique d'un livreur (arrêts, coupures, distance), commandes
// d'un livreur sur une période, et trajet d'une commande terminée, y compris
// quand elle a changé de livreur. À lancer avec le faux Traccar
// (scripts/fake-traccar.js) et TRACCAR_URL pointant dessus.
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

(async () => {
  assert.ok(process.env.TRACCAR_URL, 'TRACCAR_URL (faux Traccar) requis');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  const created = [];
  try {
    const cid = (await pool.query('SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1', [process.env.ADMIN_USER])).rows[0].company_id;
    // Le faux Traccar ignore les livreurs dont l'identifiant est multiple de 7.
    const mkDriver = async (name) => {
      for (;;) {
        const id = (await pool.query(
          `INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active) VALUES ($1, $2, $3, '22900000066', TRUE) RETURNING id`,
          [cid, `${name} ${marker}`, `fm-${name}-${marker}-${crypto.randomUUID().slice(0, 4)}`]
        )).rows[0].id;
        created.push(id);
        if (Number(id) % 7 !== 0 && Number(id) % 6 !== 0) return id;
      }
    };
    const d1 = await mkDriver('Kofi');
    const d2 = await mkDriver('Ama');

    // Historique d'un livreur sur deux heures : arrêts, coupure, distance.
    const to = new Date(); const from = new Date(Date.now() - 2 * 3600000);
    let r = await call('GET', `/api/app/drivers/${d1}/track?from=${from.toISOString()}&to=${to.toISOString()}`, { cookie: staff });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.status, 'online');
    assert.ok(r.data.positions.length > 50, 'positions reçues');
    assert.ok(r.data.stops.length >= 1 && r.data.stops[0].minutes >= 3, 'arrêt détecté');
    assert.ok(r.data.gaps.length >= 1 && r.data.gaps[0].minutes > 5, 'coupure de signal détectée');
    assert.ok(r.data.distanceMeters > 1000, 'distance mesurée');
    r = await call('GET', `/api/app/drivers/${d1}/track?from=${to.toISOString()}&to=${from.toISOString()}`, { cookie: staff });
    assert.strictEqual(r.status, 400, 'période inversée refusée');

    // Commande terminée, avec un changement de livreur en route.
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { customerName: `Trajet ${marker}`, customerPhone: '01 97 31 32 33', customerPhoneCountry: 'BJ', neighborhood: 'Ganhi', driverId: d1 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const orderId = r.data.orderId;
    await pool.query('UPDATE orders SET status = $1, driver_id = $2, destination_lat = 6.3600, destination_lng = 2.4310 WHERE id = $3', ['Livrée', d2, orderId]);
    const at = (min) => new Date(Date.now() - min * 60000);
    const steps = [['Confirmée', 'Vers la collecte', 70], ['Vers la collecte', 'Récupérée', 60], ['Récupérée', 'En livraison', 55], ['En livraison', 'Livrée', 15]];
    for (const [fromS, toS, min] of steps) {
      await pool.query(
        `INSERT INTO order_status_events (company_id, order_id, from_status, to_status, actor_user_id, idempotency_key, request_fingerprint, metadata, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, '{}'::jsonb, $7)`,
        [cid, orderId, fromS, toS, `test:${marker}:${toS}`, sha(`${marker}${toS}`), at(min)]
      );
    }
    await pool.query(
      `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details, created_at)
       VALUES ($1, NULL, 'order', $2, 'reassigned', jsonb_build_object('fromDriverId', $3::bigint, 'toDriverId', $4::bigint), $5)`,
      [cid, orderId, d1, d2, at(40)]
    );
    r = await call('GET', `/api/app/orders/${orderId}/track`, { cookie: staff });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.status, 'ok');
    assert.strictEqual(r.data.ended, true);
    assert.ok(r.data.milestones.some((m) => m.status === 'Livrée'), 'statuts horodatés');
    assert.ok(Math.abs(new Date(r.data.from).getTime() - at(73).getTime()) < 120000, 'départ au premier mouvement, avec marge');
    assert.ok(Math.abs(new Date(r.data.to).getTime() - at(12).getTime()) < 120000, 'fin à la remise, avec marge');
    assert.strictEqual(r.data.segments.length, 2, 'une portion par livreur');
    assert.strictEqual(r.data.segments[0].driverId, String(d1));
    assert.strictEqual(r.data.segments[1].driverId, String(d2));
    assert.ok(r.data.segments.every((s) => s.positions.length > 0), 'positions sur chaque portion');
    assert.ok(r.data.order.destination, 'adresse de livraison');

    // Commandes du livreur sur la période.
    r = await call('GET', `/api/app/drivers/${d2}/orders?from=${from.toISOString()}&to=${to.toISOString()}`, { cookie: staff });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.orders.some((o) => o.id === String(orderId)), 'commande listée pour le livreur');

    // Commande pas encore partie.
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { customerName: `Attente ${marker}`, customerPhone: '01 97 31 32 34', customerPhoneCountry: 'BJ', neighborhood: 'Akpakpa', driverId: d1 } });
    const waiting = r.data.orderId;
    r = await call('GET', `/api/app/orders/${waiting}/track`, { cookie: staff });
    assert.strictEqual(r.data.status, 'not_started');
    r = await call('GET', '/api/app/orders/abc/track', { cookie: staff });
    assert.strictEqual(r.status, 404);
    r = await call('GET', '/api/app/orders/999999999/track', { cookie: staff });
    assert.strictEqual(r.status, 404);

    // Carte : photos annoncées dans l'instantané.
    r = await call('GET', '/api/app/operations-map', { cookie: staff });
    assert.strictEqual(r.status, 200);
    const snap = r.data.drivers.find((d) => String(d.id) === String(d1));
    assert.ok(snap && 'hasPhoto' in snap && snap.position, 'livreur localisé avec indicateur de photo');
    assert.ok(Array.isArray(r.data.waiting), 'livraisons à attribuer');
    assert.ok(r.data.waiting.every((w) => Number.isFinite(w.latitude) && Number.isFinite(w.longitude) && ['À vérifier', 'Validée'].includes(w.status)), 'à attribuer : positions et statuts valides');
    console.log('map-history-test: OK');
  } finally {
    if (created.length) await pool.query('UPDATE drivers SET active = FALSE WHERE id = ANY($1::bigint[])', [created]);
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
