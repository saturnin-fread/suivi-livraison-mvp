// Vigilance : calculs (distance, vitesse, alias e-mail, écarts) puis parcours
// réels : remise loin du client, déplacement impossible, photo réutilisée,
// écarts d'encaissement répétés, essai gratuit réutilisé, numéro partagé,
// affichage dans la cloche et marquage « vérifié ».
const assert = require('assert');
const { Pool } = require('pg');
const v = require('../lib/vigilance');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { res, status: res.status, data: await res.json().catch(() => ({})) };
}
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

(async () => {
  // --- Calculs -----------------------------------------------------------------
  const cotonou = { lat: 6.3703, lng: 2.3912 };
  assert.ok(Math.abs(v.distanceMeters(cotonou, { lat: 6.3793, lng: 2.3912 }) - 1001) < 5, 'distance ≈ 1 km');
  assert.strictEqual(v.farFromDestination({ ...cotonou, accuracy: 20 }, { lat: 6.3720, lng: 2.3912 }).far, false, '190 m : normal');
  assert.strictEqual(v.farFromDestination({ ...cotonou, accuracy: 20 }, { lat: 6.3793, lng: 2.3912 }).far, true, '1 km : loin');
  assert.strictEqual(v.farFromDestination({ ...cotonou, accuracy: 900 }, { lat: 6.3763, lng: 2.3912 }).far, false, 'GPS flou : marge élargie (plafonnée)');
  const t0 = new Date('2026-10-01T08:00:00Z');
  assert.strictEqual(v.impossibleJump({ ...cotonou, at: t0 }, { lat: 6.50, lng: 2.60, at: new Date(t0.getTime() + 60000) }).impossible, true, '27 km en 1 min : impossible');
  assert.strictEqual(v.impossibleJump({ ...cotonou, at: t0 }, { lat: 6.40, lng: 2.42, at: new Date(t0.getTime() + 15 * 60000) }).impossible, false, '4,6 km en 15 min : possible');
  assert.strictEqual(v.canonicalEmail('A.Wa+essai@GoogleMail.com'), 'awa@gmail.com', 'alias Gmail ramenés à la même boîte');
  assert.strictEqual(v.canonicalEmail('awa+2@exemple.bj'), 'awa@exemple.bj');
  assert.strictEqual(v.cashGapPattern([{ expected: 5000, collected: 4000 }, { expected: 3000, collected: 2500 }]).repeated, false);
  assert.deepStrictEqual(v.cashGapPattern([{ expected: 5000, collected: 4000 }, { expected: 3000, collected: 2500 }, { expected: 2000, collected: 1000 }, { expected: 1000, collected: 1200 }]), { count: 3, totalMinor: 2500, repeated: true });

  // --- Parcours réels ---------------------------------------------------------------
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  const phone = `0197${String(Math.floor(100000 + Math.random() * 899999))}`;
  const registered = [];
  try {
    const cid = (await pool.query('SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1', [process.env.ADMIN_USER])).rows[0].company_id;
    await pool.query(`UPDATE companies SET photo_proof_mode = 'optional' WHERE id = $1`, [cid]);

    // Livreur relié à son téléphone
    let r = await call('POST', '/api/app/drivers', { cookie: staff, body: { name: `Vigil ${marker}`, phone, phoneCountry: 'BJ' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const driverId = r.data.id;
    const inv = (await call('POST', `/api/app/drivers/${driverId}/invitation`, { cookie: staff, body: {} })).data;
    // Invitation en personne : le responsable confirme le numéro du téléphone.
    const ref = inv.path.split('/').pop();
    let joined = await call('POST', `/api/public/driver-invitations/${ref}/accept`, { body: {} });
    if (joined.status === 202) {
      await call('POST', `/api/app/drivers/${driverId}/invitation/pairing`, { cookie: staff, body: { decision: 'approve', code: joined.data.pairingCode } });
      joined = await call('POST', `/api/public/driver-invitations/${ref}/pairing`, { body: { pairingToken: joined.data.pairingToken } });
    }
    assert.strictEqual(joined.status, 201, JSON.stringify(joined.data));
    const phoneA = cookieOf(joined.res, 'delivery_session');

    const newOrder = async (lat, lng) => {
      const o = await call('POST', '/api/app/orders', { cookie: staff, body: { customerName: `Client ${marker}`, customerPhone: '01 97 44 55 66', customerPhoneCountry: 'BJ', neighborhood: 'Cadjèhoun', driverId, destinationLat: lat, destinationLng: lng } });
      assert.strictEqual(o.status, 201, JSON.stringify(o.data));
      await pool.query(`UPDATE orders SET status = 'En livraison', destination_lat = $2, destination_lng = $3 WHERE id = $1`, [o.data.orderId, lat, lng]);
      return o.data.orderId;
    };
    const arrive = (orderId, position) => call('POST', `/api/driver/orders/${orderId}/transition`, { cookie: phoneA, body: { toStatus: 'Arrivée', idempotencyKey: `vg-${marker}-${orderId}`, position } });
    const signals = async (kind) => (await pool.query('SELECT * FROM fraud_signals WHERE company_id = $1 AND driver_id = $2 AND kind = $3', [cid, driverId, kind])).rows;

    // 1. Arrivée déclarée à 1,4 km du client
    const o1 = await newOrder(6.3703, 2.3912);
    r = await arrive(o1, { lat: 6.3830, lng: 2.3912, accuracy: 15 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    await wait(400);
    let far = await signals('far_delivery');
    assert.strictEqual(far.length, 1, 'remise loin du client signalée');
    assert.ok(far[0].details.distance > 1300 && far[0].details.distance < 1500);
    // Position imprécise (> 200 m) : ignorée, pas de faux signal
    const o2 = await newOrder(6.3703, 2.3912);
    await arrive(o2, { lat: 6.40, lng: 2.39, accuracy: 900 });
    await wait(300);
    assert.strictEqual((await signals('far_delivery')).length, 1, 'position trop imprécise : rien n’est conclu');
    // Arrivée au bon endroit : rien
    const o3 = await newOrder(6.3703, 2.3912);
    await arrive(o3, { lat: 6.3705, lng: 2.3913, accuracy: 10 });
    await wait(300);
    assert.strictEqual((await signals('far_delivery')).length, 1, 'remise au bon endroit : aucun signal');

    // 2. Déplacement impossible : 25 km quelques secondes plus tard
    const o4 = await newOrder(6.5900, 2.3912);
    await arrive(o4, { lat: 6.5900, lng: 2.3912, accuracy: 10 });
    await wait(400);
    const speed = await signals('impossible_speed');
    assert.strictEqual(speed.length, 1, 'déplacement impossible signalé');
    assert.ok(speed[0].details.kmh > 150);

    // 3. Photo réutilisée pour une autre livraison
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`photo-${marker}`), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
    const upload = (orderId, key) => {
      const form = new FormData();
      form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
      form.append('idempotencyKey', key);
      return fetch(`${base}/api/driver/orders/${orderId}/evidence/photo`, { method: 'POST', headers: { Cookie: phoneA }, body: form });
    };
    let up = await upload(o1, `vg-${marker}-ph1`);
    assert.strictEqual(up.status, 201, await up.text());
    up = await upload(o3, `vg-${marker}-ph2`);
    assert.strictEqual(up.status, 409, 'photo déjà utilisée refusée');
    assert.match((await up.json()).error, /déjà servi/);
    await wait(300);
    assert.strictEqual((await signals('photo_reused')).length, 1, 'photo réutilisée signalée');

    // 4. Écarts d'encaissement répétés (3 en 30 jours)
    for (const [i, orderId] of [o1, o3, o4].entries()) {
      await pool.query(`INSERT INTO order_payment_accounts (company_id, order_id, expected_amount_minor) VALUES ($1, $2, 5000) ON CONFLICT (order_id) DO NOTHING`, [cid, orderId]);
      r = await call('POST', `/api/driver/orders/${orderId}/payment/collect`, { cookie: phoneA, body: { amountMinor: 4000, method: 'cash', discrepancyReason: 'Le client n’avait pas la monnaie', idempotencyKey: `vg-${marker}-pay${i}` } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    }
    await wait(400);
    const cash = await signals('cash_gap');
    assert.strictEqual(cash.length, 1, 'écarts répétés signalés');
    assert.deepStrictEqual([cash[0].details.count, Number(cash[0].details.totalMinor)], [3, 3000]);

    // 5. Cloche du responsable, fiche livreur, « c'est vérifié »
    let notif = (await call('GET', '/api/app/notifications', { cookie: staff })).data;
    const vig = notif.items.filter((it) => it.type === 'vigilance' && it.summary.includes(`Vigil ${marker}`));
    assert.ok(vig.length >= 4, `alertes dans la cloche (${vig.length})`);
    assert.ok(vig.some((it) => it.title === 'Remise déclarée loin du client' && /km de l’adresse/.test(it.detail)));
    const listed = (await call('GET', `/api/app/drivers/${driverId}/signals`, { cookie: staff })).data.signals;
    assert.strictEqual(listed.length, 4, 'quatre points d’attention sur la fiche');
    r = await call('POST', `/api/app/signals/${listed[0].id}/review`, { cookie: staff });
    assert.strictEqual(r.status, 200);
    notif = (await call('GET', '/api/app/notifications', { cookie: staff })).data;
    assert.ok(!notif.items.some((it) => it.id === `vigil-${listed[0].id}`), 'signal vérifié : retiré de la cloche');
    r = await call('GET', '/api/app/notifications', { cookie: phoneA });
    assert.ok([401, 403].includes(r.status) || !(r.data.items || []).some((it) => it.type === 'vigilance'), 'le livreur ne voit pas les alertes');

    // 6. Essai gratuit : une seule fois par personne (alias Gmail compris)
    const pwd = 'Vigilance-Test-2026!';
    const mail1 = `vig.${marker}@gmail.com`;
    const mail2 = `vig${marker}+bis@googlemail.com`;
    registered.push(mail1, mail2);
    const reg = async (email) => fetch(`${base}/app/register`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': `10.77.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` }, body: new URLSearchParams({ email, password: pwd, passwordConfirm: pwd }) });
    const first = await reg(mail1);
    assert.ok([302, 303].includes(first.status), `inscription 1 (${first.status})`);
    const second = await reg(mail2);
    assert.ok([302, 303].includes(second.status), `inscription 2 (${second.status})`);
    const trials = (await pool.query(`SELECT u.email, c.trial_status FROM users u JOIN company_memberships m ON m.user_id = u.id JOIN companies c ON c.id = m.company_id WHERE u.email = ANY($1::text[]) ORDER BY u.id`, [[mail1, mail2]])).rows;
    assert.deepStrictEqual(trials.map((t) => t.trial_status), ['active', 'used_elsewhere'], 'deuxième essai refusé');
    assert.ok((await pool.query(`SELECT 1 FROM fraud_signals WHERE company_id IS NULL AND kind = 'trial_reused' AND details->>'priorCompanyId' IS NOT NULL ORDER BY id DESC LIMIT 1`)).rows[0], 'signal pour l’équipe TRAXO');

    // 7. Même numéro de livreur dans une autre entreprise : signal TRAXO uniquement
    const otherSession = cookieOf(first, 'delivery_session');
    if (otherSession) {
      await pool.query(`UPDATE companies SET activation_status = 'active', onboarding_status = 'done' WHERE id = (SELECT m.company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1)`, [mail1]);
      r = await call('POST', '/api/app/drivers', { cookie: otherSession, body: { name: `Doublon ${marker}`, phone, phoneCountry: 'BJ' } });
      if (r.status === 201) {
        await wait(300);
        const shared = (await pool.query(`SELECT * FROM fraud_signals WHERE company_id IS NULL AND kind = 'shared_phone' AND (details->>'driverId')::bigint = $1`, [r.data.id])).rows;
        assert.strictEqual(shared.length, 1, 'numéro partagé signalé à TRAXO');
        const own = (await call('GET', '/api/app/notifications', { cookie: otherSession })).data;
        assert.ok(!(own.items || []).some((it) => it.type === 'vigilance' && /plusieurs entreprises/.test(it.title)), 'jamais visible par les entreprises');
      } else assert.fail(`création du livreur dans la 2e entreprise refusée (${r.status} ${JSON.stringify(r.data)})`);
    } else console.log('  (numéro partagé non testé : inscription avec code e-mail)');

    console.log('Vigilance OK : remise loin, position incohérente, photo réutilisée, écarts répétés, cloche, essai unique, numéro partagé.');
  } finally {
    await pool.query(`UPDATE companies SET photo_proof_mode = 'off' WHERE id IN (SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1)`, [process.env.ADMIN_USER]).catch(() => {});
    if (registered.length) {
      await pool.query('DELETE FROM companies WHERE id IN (SELECT m.company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ANY($1::text[]))', [registered]).catch(() => {});
      await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [registered]).catch(() => {});
    }
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
