// Colis et point de collecte : saisie, statut « Vers la collecte », modification,
// carnet automatique des lieux, recopie depuis une demande préremplie.
const assert = require('assert');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { res, status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  try {
    const cid = (await pool.query("SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1", [process.env.ADMIN_USER])).rows[0]?.company_id
      || (await pool.query('SELECT id FROM companies ORDER BY id LIMIT 1')).rows[0].id;
    const drv = (await pool.query(`INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active) VALUES ($1, $2, $3, '22900000077', TRUE) RETURNING id`, [cid, `Livreur collecte ${marker}`, `pk-${marker}`])).rows[0].id;
    const base = { customerName: `Kemi ${marker}`, customerPhone: '01 97 44 55 66', customerPhoneCountry: 'BJ', neighborhood: 'Cadjèhoun', driverId: drv };

    // Validation
    let r = await call('POST', '/api/app/orders', { cookie: staff, body: { ...base, pickupEnabled: true } });
    assert.strictEqual(r.status, 400, 'collecte sans lieu refusée');
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { ...base, packageType: 'bijoux' } });
    assert.strictEqual(r.status, 400, 'type de colis inconnu refusé');
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { ...base, pickupEnabled: true, pickupAddress: 'Dantokpa', pickupLat: 6.4 } });
    assert.strictEqual(r.status, 400, 'position incomplète refusée');
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { ...base, pickupEnabled: true, pickupAddress: 'Dantokpa', pickupPhone: '12' } });
    assert.strictEqual(r.status, 400, 'téléphone de collecte invalide refusé');

    // Commande sans collecte : pas d'étape « Vers la collecte »
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { ...base, packageType: 'documents', packageDescription: 'Contrat signé' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    let o = (await call('GET', `/api/app/orders/${r.data.orderId}`, { cookie: staff })).data;
    assert.deepStrictEqual([o.package_type, o.package_description, o.pickup_address], ['documents', 'Contrat signé', null]);
    assert.ok(!o.allowedTransitions.includes('Vers la collecte'), 'pas de collecte : étape absente');

    // Commande avec collecte
    r = await call('POST', '/api/app/orders', { cookie: staff, body: { ...base, packageType: 'vetements', packageDescription: '2 robes', pickupEnabled: true, pickupName: `Boutique ${marker}`, pickupAddress: 'Dantokpa, allée des tissus', pickupPhone: '01 61 22 33 44', pickupPhoneCountry: 'BJ', pickupReady: '14 h', pickupLat: 6.3727, pickupLng: 2.4339 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const orderId = r.data.orderId;
    o = (await call('GET', `/api/app/orders/${orderId}`, { cookie: staff })).data;
    assert.strictEqual(o.pickup_name, `Boutique ${marker}`);
    assert.strictEqual(o.pickup_phone, '+229 01 61 22 33 44');
    assert.strictEqual(Number(o.pickup_lat), 6.3727);
    assert.ok(o.allowedTransitions.includes('Vers la collecte'), 'collecte : étape proposée');

    // Carnet automatique
    r = await call('GET', `/api/app/pickup-places?q=${encodeURIComponent(marker)}`, { cookie: staff });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.places.some((p) => p.name === `Boutique ${marker}` && p.lat === 6.3727), 'lieu retrouvé avec sa position');

    // Modification avant récupération
    r = await call('PATCH', `/api/app/orders/${orderId}/pickup`, { cookie: staff, body: { pickupEnabled: true, pickupName: `Boutique ${marker}`, pickupAddress: 'Dantokpa, porte 3', packageType: 'fragile' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.pickup.address, 'Dantokpa, porte 3');
    assert.strictEqual(r.data.packageType, 'fragile');

    // Statut « Vers la collecte » puis « Récupérée »
    const step = (toStatus) => call('POST', `/api/app/orders/${orderId}/transition`, { cookie: staff, body: { toStatus, idempotencyKey: `pk-${marker}-${toStatus.normalize("NFD").replace(/[^A-Za-z]/g, "")}` } });
    r = await step('Vers la collecte');
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    r = await call('PATCH', `/api/app/orders/${orderId}/pickup`, { cookie: staff, body: { pickupEnabled: false } });
    assert.strictEqual(r.status, 409, 'impossible de retirer la collecte en route');
    r = await step('Récupérée');
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    r = await call('PATCH', `/api/app/orders/${orderId}/pickup`, { cookie: staff, body: { pickupEnabled: true, pickupAddress: 'Ailleurs' } });
    assert.strictEqual(r.status, 409, 'collecte figée après récupération');

    // Demande préremplie : colis et collecte recopiés sur la commande
    r = await call('POST', '/api/app/requests/prefilled', { cookie: staff, body: { customerName: `Ola ${marker}`, customerPhone: '01 97 88 77 66', customerPhoneCountry: 'BJ', neighborhood: 'Fidjrossè', packageType: 'repas', packageDescription: 'Plateau', pickupEnabled: true, pickupName: 'Restaurant du coin', pickupAddress: 'Haie Vive' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const reqId = r.data.id;
    await pool.query(`UPDATE customer_requests SET status = 'Validée', validated_at = NOW() WHERE id = $1`, [reqId]);
    r = await call('POST', `/api/app/requests/${reqId}/convert`, { cookie: staff, body: { driverId: drv } });
    assert.ok([200, 201].includes(r.status) && r.data.orderId, JSON.stringify(r.data));
    o = (await call('GET', `/api/app/orders/${r.data.orderId}`, { cookie: staff })).data;
    assert.deepStrictEqual([o.package_type, o.pickup_name, o.pickup_address], ['repas', 'Restaurant du coin', 'Haie Vive']);

    // Formulaire rempli par le client lui-même : colis et collecte
    const link = await call('POST', '/api/app/request-links', { cookie: staff });
    assert.strictEqual(link.status, 201, JSON.stringify(link.data));
    const tok = link.data.token;
    const clientForm = { customerName: `Rissi ${marker}`, customerPhone: '01 97 22 33 44', customerPhoneCountry: 'BJ', neighborhood: 'Akpakpa', locationLat: 6.37, locationLng: 2.45, locationAccuracy: 10 };
    r = await call('POST', `/api/public/requests/${tok}`, { body: { ...clientForm, packageType: 'vetements', pickupEnabled: 'true' } });
    assert.strictEqual(r.status, 400, 'collecte sans lieu refusée');
    assert.strictEqual(r.data.field, 'pickupAddress');
    const sent = await fetch(`${process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000'}/api/public/requests/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...clientForm, packageType: 'vetements', packageDescription: '3 pagnes', pickupEnabled: 'true', pickupName: 'Tante Rose', pickupAddress: 'Dantokpa, porte 3', pickupPhone: '01 61 22 33 44', pickupReady: 'dès 10 h' }) });
    assert.strictEqual(sent.status, 200, await sent.text());
    const device = (sent.headers.get('set-cookie') || '').split(';')[0];
    let mine = await call('GET', `/api/public/requests/${tok}`, { cookie: device });
    assert.deepStrictEqual([mine.data.package_type, mine.data.package_description, mine.data.pickup_enabled, mine.data.pickup_name, mine.data.pickup_address], ['vetements', '3 pagnes', true, 'Tante Rose', 'Dantokpa, porte 3']);
    r = await call('PUT', `/api/public/requests/${tok}`, { cookie: device, body: { ...clientForm, version: mine.data.version, packageType: 'fragile', packageDescription: 'Un miroir', pickupEnabled: 'true', pickupAddress: 'Dantokpa, porte 4' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    mine = await call('GET', `/api/public/requests/${tok}`, { cookie: device });
    assert.deepStrictEqual([mine.data.package_type, mine.data.pickup_address, mine.data.pickup_name], ['fragile', 'Dantokpa, porte 4', ''], 'modification par le client enregistrée');
    await pool.query(`UPDATE customer_requests SET status = 'Validée', validated_at = NOW() WHERE id = $1`, [mine.data.id]);
    r = await call('POST', `/api/app/requests/${mine.data.id}/convert`, { cookie: staff, body: { driverId: drv } });
    assert.ok([200, 201].includes(r.status) && r.data.orderId, JSON.stringify(r.data));
    o = (await call('GET', `/api/app/orders/${r.data.orderId}`, { cookie: staff })).data;
    assert.deepStrictEqual([o.package_type, o.package_description, o.pickup_address], ['fragile', 'Un miroir', 'Dantokpa, porte 4'], 'colis du client recopié sur la commande');
    assert.ok(o.allowedTransitions.includes('Vers la collecte'), 'étape de collecte proposée');

    console.log('Collecte : validation, statut, modification, carnet de lieux, recopie depuis une demande préremplie et depuis le formulaire client OK');
  } finally {
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
