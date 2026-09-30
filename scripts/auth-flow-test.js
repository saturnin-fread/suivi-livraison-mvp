// Parcours d'accès (serveur lancé avec LOGIN_EMAIL_CODE=on et EMAIL_OUTBOX_DIR) :
// inscription courte, code e-mail, configuration guidée, appareil reconnu,
// « rester connecté 30 jours », nouvel appareil, blocage après 5 codes faux.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const outbox = process.env.EMAIL_OUTBOX_DIR;
if (!outbox) { console.error('EMAIL_OUTBOX_DIR requis (même dossier que le serveur).'); process.exit(1); }
const email = `auth-${Date.now()}@example.test`;
const password = 'une phrase assez longue';

const cookies = (res) => (res.headers.getSetCookie?.() || []);
const cookieOf = (res, name) => cookies(res).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);
const maxAgeOf = (res, name) => {
  const raw = cookies(res).find((c) => c.startsWith(`${name}=`));
  const m = raw && /Max-Age=(\d+)/.exec(raw);
  return m ? Number(m[1]) : null;
};
const jar = (...values) => values.filter(Boolean).join('; ');
async function post(url, body, cookie) {
  return fetch(`${base}${url}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body) });
}
async function get(url, cookie) {
  return fetch(`${base}${url}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
}
function lastCode(to) {
  const files = fs.readdirSync(outbox).filter((f) => f.endsWith('.json')).sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const mail = JSON.parse(fs.readFileSync(path.join(outbox, files[i]), 'utf8'));
    if (mail.to === to) return /(\d{6}) — votre code TRAXO/.exec(mail.subject)[1];
  }
  throw new Error('Aucun e-mail reçu pour ' + to);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Pages publiques
    for (const url of ['/app/login', '/app/register', '/confidentialite', '/conditions']) {
      assert.strictEqual((await get(url)).status, 200, `${url} accessible`);
    }
    const google = await get('/app/auth/google');
    assert.ok(google.status === 302 && /google_off|accounts\.google\.com/.test(google.headers.get('location')), 'Google : désactivé proprement ou redirigé');

    // 1. Inscription : pas de session avant le code
    const reg = await post('/app/register', { email, password });
    assert.strictEqual(reg.headers.get('location'), '/app/login/code', 'inscription → page du code');
    assert.ok(!cookieOf(reg, 'delivery_session'), 'aucune session avant le code');
    const verify = cookieOf(reg, 'traxo_verify');
    assert.ok(verify, 'cookie de vérification posé');
    const state = await (await get('/app/login/code/state', verify)).json();
    assert.strictEqual(state.purpose, 'signup');
    assert.ok(state.email.endsWith('@example.test') && !state.email.includes(email.split('@')[0]), 'adresse masquée');
    assert.strictEqual((await post('/app/register', { email, password })).headers.get('location'), '/app/register?error=email_taken', 'adresse déjà prise');

    // 2. Code faux puis renvoi trop tôt
    const bad = await post('/app/login/code', { code: '000000' === lastCode(email) ? '111111' : '000000' }, verify);
    assert.ok(/error=code&left=4/.test(bad.headers.get('location')), 'code faux compté');
    assert.strictEqual((await post('/app/login/code/resend', {}, verify)).status, 429, 'renvoi limité à 30 s');

    // 3. Bon code : session 12 h, appareil reconnu, configuration guidée
    const ok = await post('/app/login/code', { code: lastCode(email) }, verify);
    assert.strictEqual(ok.headers.get('location'), '/app/bienvenue', 'code correct → configuration guidée');
    const session = cookieOf(ok, 'delivery_session');
    const device = cookieOf(ok, 'traxo_device');
    assert.ok(session && device, 'session et appareil reconnu');
    assert.strictEqual(maxAgeOf(ok, 'delivery_session'), 12 * 3600, 'session standard de 12 h');
    assert.strictEqual((await get('/app', session)).headers.get('location'), '/app/bienvenue', 'back-office inaccessible avant configuration');
    assert.strictEqual((await get('/app/bienvenue', session)).status, 200);

    // 4. Configuration guidée
    const api = (body) => fetch(`${base}/api/onboarding`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: session }, body: JSON.stringify(body) });
    const valid = { business: 'Maison Test', category: 'commerce', country: 'Côte d’Ivoire', city: 'Abidjan', name: 'Awa Test', prefix: '+225', phone: '07 07 07 07 07', fleet: '2–5' };
    const missing = await api({ ...valid, category: 'inconnue' });
    assert.strictEqual(missing.status, 400);
    assert.strictEqual((await missing.json()).field, 'category', 'champ en erreur indiqué');
    assert.strictEqual((await api({ ...valid, phone: '12' })).status, 400, 'téléphone incomplet refusé');
    const saved = await api(valid);
    assert.strictEqual(saved.status, 200, 'configuration enregistrée');
    const company = (await pool.query(
      `SELECT c.name, c.slug, c.timezone, c.onboarding_status, c.city, u.display_name, u.phone, u.email_verified_at
       FROM users u JOIN company_memberships m ON m.user_id = u.id JOIN companies c ON c.id = m.company_id WHERE u.email = $1`, [email])).rows[0];
    assert.strictEqual(company.name, 'Maison Test');
    assert.ok(company.slug.startsWith('maison-test'), 'identifiant de l’espace mis à jour');
    assert.strictEqual(company.timezone, 'Africa/Abidjan', 'fuseau déduit du pays');
    assert.strictEqual(company.onboarding_status, 'done');
    assert.strictEqual(company.display_name, 'Awa Test');
    assert.strictEqual(company.phone, '+225 07 07 07 07 07');
    assert.ok(company.email_verified_at, 'adresse confirmée');
    assert.strictEqual((await get('/app', session)).status, 200, 'back-office ouvert');
    assert.strictEqual((await get('/app/bienvenue', session)).headers.get('location'), '/app', 'configuration non rejouable');
    assert.strictEqual((await api(valid)).status, 409);

    // 5. Même appareil + « rester connecté » : pas de code, session 30 jours
    const again = await post('/app/login', { user: email, password, remember: '1' }, device);
    assert.strictEqual(again.headers.get('location'), '/app', 'appareil reconnu : pas de code');
    assert.strictEqual(maxAgeOf(again, 'delivery_session'), 30 * 24 * 3600, 'rester connecté : 30 jours');

    // 6. Nouvel appareil : code exigé, 5 essais au maximum
    const fresh = await post('/app/login', { user: email, password });
    assert.strictEqual(fresh.headers.get('location'), '/app/login/code', 'nouvel appareil → code');
    assert.ok(!cookieOf(fresh, 'delivery_session'));
    const verify2 = cookieOf(fresh, 'traxo_verify');
    const good = lastCode(email);
    const wrong = good === '123456' ? '654321' : '123456';
    const seen = [];
    for (let i = 0; i < 6; i += 1) seen.push((await post('/app/login/code', { code: wrong }, verify2)).headers.get('location'));
    assert.strictEqual(seen[5], '/app/login?error=expired', 'bloqué après 5 codes faux');
    assert.strictEqual((await post('/app/login/code', { code: good }, verify2)).headers.get('location'), '/app/login?error=expired', 'bon code refusé après blocage');

    console.log('Parcours d’accès OK : inscription, code e-mail, configuration guidée, appareil reconnu, 30 jours, nouvel appareil, blocage.');
  } finally {
    await pool.query(
      `DELETE FROM companies WHERE id IN (SELECT m.company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1)`, [email]
    ).catch(() => {});
    await pool.query('DELETE FROM users WHERE email = $1', [email]).catch(() => {});
    await pool.end();
  }
})().catch((error) => {
  console.error('Parcours d’accès échoué :', error.message);
  process.exit(1);
});
