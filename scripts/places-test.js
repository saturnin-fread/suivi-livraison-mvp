// Recherche d'un lieu depuis un lien de demande client (géocodage serveur).
// À lancer avec le faux service (scripts/fake-geocoder.js) et GEOCODER_URL
// pointant dessus côté serveur.
const assert = require('assert');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  try {
    // Lien de demande préparé par l'équipe, marqué urgent.
    let r = await call('POST', '/api/app/requests/prefilled', { cookie: staff, body: { customerName: 'Lieu Test', customerPhone: '01 97 31 32 36', customerPhoneCountry: 'BJ', neighborhood: 'Akpakpa', priority: 'urgent' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const row = (await pool.query('SELECT token, priority FROM customer_requests WHERE id = $1', [r.data.id])).rows[0];
    assert.ok(row && row.token, 'lien créé');
    assert.strictEqual(row.priority, 'urgent', 'priorité gardée sur la demande');

    r = await call('GET', `/api/public/requests/${row.token}/places?q=dantokpa`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.status, 'ok');
    assert.ok(r.data.results.length >= 1, 'lieu trouvé');
    const hit = r.data.results[0];
    assert.strictEqual(hit.label, 'Marché Dantokpa');
    assert.ok(hit.detail.includes('Cotonou'), 'quartier et ville');
    assert.ok(Number.isFinite(hit.lat) && Number.isFinite(hit.lng), 'coordonnées');

    r = await call('GET', `/api/public/requests/${row.token}/places?q=camp%20guezo&lat=6.36&lng=2.41`);
    assert.strictEqual(r.data.results[0].label, 'Pharmacie Camp Guézo', 'recherche sans accents');
    r = await call('GET', `/api/public/requests/${row.token}/places?q=zzzzzz`);
    assert.strictEqual(r.data.results.length, 0, 'aucun résultat');
    r = await call('GET', `/api/public/requests/${row.token}/places?q=ab`);
    assert.strictEqual(r.data.status, 'too_short', 'au moins 3 lettres');
    r = await call('GET', '/api/public/requests/lien-inconnu/places?q=dantokpa');
    assert.strictEqual(r.status, 404, 'réservé aux liens valides');
    console.log('places-test: OK');
  } finally {
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
