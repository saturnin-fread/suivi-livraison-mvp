// Itinéraire en direct (livreur → prochain point) et tournée qui démarre seule
// au premier départ. À lancer avec le faux Traccar (scripts/fake-traccar.js) ;
// avec EXPECT_ROUTING=1, exige aussi un calcul routier (scripts/fake-osrm.js).
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

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
    // Le faux Traccar ignore les identifiants multiples de 7 et met hors ligne les multiples de 6.
    const mkDriver = async (name) => {
      for (;;) {
        const id = (await pool.query(
          `INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active) VALUES ($1, $2, $3, '22900000067', TRUE) RETURNING id`,
          [cid, `${name} ${marker}`, `lr-${name}-${marker}-${crypto.randomUUID().slice(0, 4)}`]
        )).rows[0].id;
        created.push(id);
        if (Number(id) % 7 !== 0 && Number(id) % 6 !== 0 && Number(id) % 5 !== 0) return id;
      }
    };
    const d1 = await mkDriver('Rachid');
    const idle = await mkDriver('Sena');
    const mkOrder = async (name, { pickup, priority, dest = [6.3520, 2.3900] }) => {
      const r = await call('POST', '/api/app/orders', { cookie: staff, body: { customerName: `${name} ${marker}`, customerPhone: '01 97 31 32 35', customerPhoneCountry: 'BJ', neighborhood: 'Cadjèhoun', driverId: d1, ...(priority ? { priority } : {}) } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      const id = r.data.orderId;
      await pool.query('UPDATE orders SET destination_lat = $2, destination_lng = $3 WHERE id = $1', [id, dest[0], dest[1]]);
      if (pickup) await pool.query("UPDATE orders SET pickup_name = 'Boutique Ayi', pickup_address = 'Ganhi', pickup_lat = 6.3600, pickup_lng = 2.4300 WHERE id = $1", [id]);
      return String(id);
    };
    const withPickup = await mkOrder('Collecte', { pickup: true });
    const direct = await mkOrder('Direct', { pickup: false });

    // La commande rejoint d'office la tournée du jour, encore « à démarrer ».
    const runOf = async (orderId) => (await pool.query(
      `SELECT r.id, r.status, r.started_at FROM delivery_stops s JOIN delivery_runs r ON r.id = s.run_id
       WHERE s.order_id = $1 AND s.assignment_active = TRUE AND s.removed_at IS NULL`, [orderId])).rows[0];
    let run = await runOf(withPickup);
    assert.ok(run, 'commande rattachée à la tournée du jour');
    assert.strictEqual(run.status, 'draft');

    // Itinéraire en direct : position du livreur, collecte d'abord, puis clients.
    let r = await call('GET', `/api/app/drivers/${d1}/live-route`, { cookie: staff });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.origin && Number.isFinite(r.data.origin.lat), 'position actuelle du livreur');
    assert.ok(['ok', 'routing_unavailable'].includes(r.data.status), r.data.status);
    if (process.env.EXPECT_ROUTING === '1') assert.strictEqual(r.data.status, 'ok', 'calcul routier');
    assert.deepStrictEqual(r.data.targets.map((t) => `${t.orderId}:${t.kind}`), [`${withPickup}:pickup`, `${withPickup}:delivery`, `${direct}:delivery`]);
    if (r.data.status === 'ok') {
      assert.strictEqual(r.data.route.legs.length, r.data.targets.length, 'une étape par point');
      assert.ok(r.data.route.geometry.value.coordinates.length >= 2, 'tracé routier');
      assert.ok(r.data.route.distanceMeters > 0 && r.data.route.durationSeconds > 0);
    }

    // Départ du livreur : la tournée démarre seule, sans validation.
    const step = (orderId, toStatus) => call('POST', `/api/app/orders/${orderId}/transition`, { cookie: staff, body: { toStatus, reason: '', idempotencyKey: crypto.randomUUID() } });
    r = await step(withPickup, 'Vers la collecte');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    run = await runOf(withPickup);
    assert.strictEqual(run.status, 'active', 'tournée démarrée au départ');
    assert.ok(run.started_at, 'heure de départ');
    const evt = (await pool.query("SELECT details FROM delivery_run_events WHERE run_id = $1 AND event_type = 'status_changed' ORDER BY id DESC LIMIT 1", [run.id])).rows[0];
    assert.strictEqual(evt.details.auto, true, 'démarrage tracé comme automatique');

    // Colis récupéré : le prochain point devient le client.
    r = await step(withPickup, 'Récupérée');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await call('GET', `/api/app/drivers/${d1}/live-route`, { cookie: staff });
    assert.deepStrictEqual(r.data.targets.map((t) => `${t.orderId}:${t.kind}`), [`${withPickup}:delivery`, `${direct}:delivery`]);
    assert.strictEqual(r.data.targets[0].active, true);

    // Priorité : une commande créée urgente passe devant les autres de même étape.
    const express = await mkOrder('Express', { pickup: false, priority: 'urgent', dest: [6.3700, 2.4400] });
    assert.strictEqual((await pool.query('SELECT priority FROM orders WHERE id = $1', [express])).rows[0].priority, 'urgent', 'priorité enregistrée à la création');
    r = await call('GET', `/api/app/drivers/${d1}/live-route`, { cookie: staff });
    assert.deepStrictEqual(r.data.targets.map((t) => t.orderId), [withPickup, express, direct], 'l’urgente passe avant la commande normale');
    assert.strictEqual(r.data.targets[1].priority, 'urgent');
    if (r.data.status === 'ok') {
      assert.strictEqual(r.data.route.legGeometries.length, r.data.targets.length, 'un tronçon par point');
      assert.ok(r.data.route.legGeometries.every((g) => g.length >= 2), 'tronçons tracés');
    }
    // Modification de la priorité depuis l'exploitation.
    r = await call('PATCH', `/api/app/orders/${express}/priority`, { cookie: staff, body: { priority: 'normal' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await call('PATCH', `/api/app/orders/${direct}/priority`, { cookie: staff, body: { priority: 'urgent' } });
    assert.strictEqual(r.data.priority, 'urgent');
    r = await call('GET', `/api/app/drivers/${d1}/live-route`, { cookie: staff });
    assert.deepStrictEqual(r.data.targets.map((t) => t.orderId), [withPickup, direct, express], 'ordre recalculé après changement');
    r = await call('PATCH', `/api/app/orders/${direct}/priority`, { cookie: staff, body: { priority: 'tres-urgent' } });
    assert.strictEqual(r.status, 400, 'priorité inconnue refusée');
    r = await call('PATCH', '/api/app/orders/999999999/priority', { cookie: staff, body: { priority: 'urgent' } });
    assert.strictEqual(r.status, 404);
    r = await call('GET', '/api/app/operations-map', { cookie: staff });
    const mapped = r.data.drivers.find((x) => String(x.id) === String(d1));
    const allStops = [...(mapped?.runs || []).flatMap((run) => run.stops || []), ...(mapped?.unplannedOrders || [])];
    assert.ok(allStops.some((o) => String(o.id) === direct && o.priority === 'urgent'), 'priorité visible sur la carte');

    // Rien à faire, livreur inconnu.
    r = await call('GET', `/api/app/drivers/${idle}/live-route`, { cookie: staff });
    assert.strictEqual(r.data.status, 'no_target');
    r = await call('GET', '/api/app/drivers/abc/live-route', { cookie: staff });
    assert.strictEqual(r.status, 404);
    r = await call('GET', '/api/app/drivers/999999999/live-route', { cookie: staff });
    assert.strictEqual(r.status, 404);
    r = await call('GET', `/api/app/drivers/${d1}/live-route`);
    assert.ok([401, 302, 403].includes(r.status), 'réservé à l’équipe');
    console.log('live-route-test: OK');
  } finally {
    if (created.length) await pool.query('UPDATE drivers SET active = FALSE WHERE id = ANY($1::bigint[])', [created]);
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
