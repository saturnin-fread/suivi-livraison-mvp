// Commande saisie par l'équipe et confirmée par le client (code à 4 chiffres,
// lien lié à l'appareil, position facultative), puis affectation d'un livreur.
const assert = require('assert');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));

async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  try {
    // 1. Création : téléphone obligatoire
    let r = await call('POST', '/api/app/requests/prefilled', { cookie: staff, body: { customerName: 'Awa Test', neighborhood: 'Akpakpa' } });
    assert.strictEqual(r.status, 400, 'téléphone exigé');
    r = await call('POST', '/api/app/requests/prefilled', { cookie: staff, body: { customerName: `Awa ${marker}`, customerPhone: '01 97 12 34 56', customerPhoneCountry: 'BJ', neighborhood: 'Akpakpa, Cotonou', landmark: 'Portail vert', requestedTime: '15 h – 17 h' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const { token, id } = r.data;
    assert.ok(/Awa/.test(r.data.message) && r.data.message.includes(`/demande/${token}`), 'message prêt à envoyer');
    const pub = `/api/public/requests/${encodeURIComponent(token)}`;

    // 2. Page publique sans code : aucune donnée personnelle
    assert.strictEqual((await fetch(`${base}/demande/${token}`)).status, 200, 'page de confirmation servie');
    r = await call('GET', pub);
    assert.strictEqual(r.data.stage, 'to_confirm');
    assert.strictEqual(r.data.needsCode, true);
    assert.ok(!('customer_name' in r.data) && !JSON.stringify(r.data).includes('Akpakpa'), 'rien de personnel avant le code');

    // 3. Mauvais code, puis bon code (4 derniers chiffres)
    r = await call('POST', `${pub}/unlock`, { body: { code: '0000' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.data.attemptsLeft, 4);
    r = await call('POST', `${pub}/unlock`, { body: { code: '3456' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const device = cookieOf(r.res, 'traxo_req');
    assert.ok(device, 'appareil lié');

    // 4. Données visibles sur cet appareil seulement
    r = await call('GET', pub, { cookie: device });
    assert.strictEqual(r.data.needsCode, false);
    assert.strictEqual(r.data.customer_name, `Awa ${marker}`);
    assert.strictEqual(r.data.landmark, 'Portail vert');
    r = await call('GET', pub);
    assert.strictEqual(r.data.needsCode, true, 'autre appareil : toujours le code');

    // 5. Confirmation sans position
    r = await call('POST', `${pub}/confirm`, { body: { customerName: 'X', neighborhood: 'Y', customerPhone: '0197123456', customerPhoneCountry: 'BJ', shareLocation: false } });
    assert.strictEqual(r.status, 403, 'confirmation impossible sans l’appareil');
    r = await call('POST', `${pub}/confirm`, { cookie: device, body: { customerName: `Awa ${marker}`, customerPhone: '01 97 12 34 56', customerPhoneCountry: 'BJ', neighborhood: 'Akpakpa, Cotonou', landmark: 'Portail vert, 2e rue', shareLocation: true } });
    assert.strictEqual(r.status, 400, 'partage demandé sans coordonnées');
    r = await call('POST', `${pub}/confirm`, { cookie: device, body: { customerName: `Awa ${marker}`, customerPhone: '01 97 12 34 56', customerPhoneCountry: 'BJ', neighborhood: 'Akpakpa, Cotonou', landmark: 'Portail vert, 2e rue', shareLocation: false } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const row = (await pool.query('SELECT status, landmark, location_lat, customer_confirmed_at FROM customer_requests WHERE id = $1', [id])).rows[0];
    assert.deepStrictEqual([row.status, row.landmark, row.location_lat], ['Validée', 'Portail vert, 2e rue', null]);
    assert.ok(row.customer_confirmed_at, 'date de confirmation');
    r = await call('POST', `${pub}/confirm`, { cookie: device, body: { customerName: 'Awa', customerPhone: '0197123456', customerPhoneCountry: 'BJ', neighborhood: 'Z', shareLocation: false } });
    assert.strictEqual(r.status, 409, 'confirmation unique');
    r = await call('GET', pub, { cookie: device });
    assert.strictEqual(r.data.stage, 'validated');

    // 6. Affectation d'un livreur
    const drv = await pool.query(`INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active) SELECT company_id, $1, $2, '22900000031', TRUE FROM customer_requests WHERE id = $3 RETURNING id`, [`Livreur confirm ${marker}`, `confirm-${marker}`, id]);
    r = await call('POST', `/api/app/requests/${id}/convert`, { cookie: staff, body: { driverId: Number(drv.rows[0].id) } });
    assert.ok([200, 201].includes(r.status) && r.data.orderId, JSON.stringify(r.data));
    const order = (await pool.query('SELECT destination_lat, landmark, customer_phone FROM orders WHERE id = $1', [r.data.orderId])).rows[0];
    assert.strictEqual(order.destination_lat, null, 'pas de destination sans partage');
    assert.strictEqual(order.landmark, 'Portail vert, 2e rue');

    // 7. Blocage après 5 essais
    r = await call('POST', '/api/app/requests/prefilled', { cookie: staff, body: { customerName: `Bio ${marker}`, customerPhone: '01 61 00 00 42', customerPhoneCountry: 'BJ', neighborhood: 'Fidjrossè' } });
    const pub2 = `/api/public/requests/${encodeURIComponent(r.data.token)}`;
    for (let i = 0; i < 4; i += 1) assert.strictEqual((await call('POST', `${pub2}/unlock`, { body: { code: '1111' } })).status, 400);
    r = await call('POST', `${pub2}/unlock`, { body: { code: '1111' } });
    assert.strictEqual(r.status, 423, 'bloqué au 5e essai');
    r = await call('POST', `${pub2}/unlock`, { body: { code: '0042' } });
    assert.strictEqual(r.status, 423, 'même le bon code est refusé une fois bloqué');
    assert.strictEqual((await call('GET', pub2)).data.locked, true);

    // 8. Commande directe avec champs structurés
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { customerName: `Kofi ${marker}`, customerPhone: '01 97 00 11 22', customerPhoneCountry: 'BJ', neighborhood: 'Cadjèhoun', landmark: 'Face à la station', driverId: drv.rows[0].id } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.customerPhone, '+229 01 97 00 11 22');
    const direct = (await pool.query('SELECT neighborhood, landmark, delivery_address FROM orders WHERE id = $1', [r.data.orderId])).rows[0];
    assert.deepStrictEqual([direct.neighborhood, direct.landmark], ['Cadjèhoun', 'Face à la station']);
    assert.ok(direct.delivery_address.includes('Cadjèhoun'));
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { customerName: 'Kofi', customerPhone: '12', customerPhoneCountry: 'BJ', neighborhood: 'Z', driverId: drv.rows[0].id } });
    assert.strictEqual(r.status, 400, 'téléphone invalide refusé');

    console.log('Commande confirmée par le client : création, code, appareil, confirmation, blocage, affectation OK');
  } finally {
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
