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
// Chaque étape simule une adresse IP différente (le quota de connexions est par IP).
let ip = '10.9.0.1';
async function post(url, body, cookie) {
  return fetch(`${base}${url}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(body) });
}
async function get(url, cookie) {
  return fetch(`${base}${url}`, { redirect: 'manual', headers: { 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) } });
}
function lastCode(to) {
  const files = fs.readdirSync(outbox).filter((f) => f.endsWith('.json')).sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const mail = JSON.parse(fs.readFileSync(path.join(outbox, files[i]), 'utf8'));
    if (mail.to === to) return /(\d{6}) — votre code TRAXO/.exec(mail.subject)[1];
  }
  throw new Error('Aucun e-mail reçu pour ' + to);
}
// Le message WhatsApp part en différé (file d'envoi) : on attend son arrivée.
async function whatsAppCodeAfter(digits, since, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const files = fs.readdirSync(outbox).filter((f) => f.endsWith('-wa.json')).sort();
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const msg = JSON.parse(fs.readFileSync(path.join(outbox, files[i]), 'utf8'));
      if (msg.whatsapp === digits && (msg.at || 0) >= since) return { code: /\*(\d{6})\*/.exec(msg.text)[1], at: msg.at };
    }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  throw new Error('Aucun message WhatsApp pour ' + digits);
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

    // 1. Inscription : confirmation exigée si fournie, pas de session avant le code
    assert.strictEqual((await post('/app/register', { email, password, passwordConfirm: 'autre chose ici' })).headers.get('location'), '/app/register?error=password_mismatch', 'confirmation différente refusée');
    const reg = await post('/app/register', { email, password, passwordConfirm: password });
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
    assert.strictEqual((await post('/app/login/code/resend', {}, verify)).status, 429, 'renvoi limité (1 min après le premier code)');

    // 3. Bon code : session 12 h, configuration guidée ; appareil non mémorisé (« rester connecté » non coché)
    const ok = await post('/app/login/code', { code: lastCode(email) }, verify);
    assert.strictEqual(ok.headers.get('location'), '/app/bienvenue', 'code correct → configuration guidée');
    const session = cookieOf(ok, 'delivery_session');
    assert.ok(session && !cookieOf(ok, 'traxo_device'), 'session ouverte, appareil non mémorisé');
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

    // Code par e-mail (en choisissant d'abord le canal si WhatsApp est proposé)
    const resend = (cookie, channel) => fetch(`${base}/app/login/code/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, Cookie: cookie }, body: JSON.stringify({ channel }) });
    async function emailCodeFor(cookie) {
      const st = await (await get('/app/login/code/state', cookie)).json();
      if (st.channel === 'pending') {
        assert.ok(/error=code/.test((await post('/app/login/code', { code: '123456' }, cookie)).headers.get('location')), 'aucun code valable avant le choix du canal');
        assert.strictEqual((await resend(cookie, 'email')).status, 200, 'choix e-mail');
      }
      return lastCode(email);
    }

    ip = '10.9.0.5';
    // 5. Sans « rester connecté » : code à chaque connexion. Avec : appareil reconnu 30 jours.
    const noRemember = await post('/app/login', { user: email, password });
    assert.strictEqual(noRemember.headers.get('location'), '/app/login/code', 'code exigé sans « rester connecté »');
    const withRemember = await post('/app/login', { user: email, password, remember: '1' });
    const verifyR = cookieOf(withRemember, 'traxo_verify');
    const okR = await post('/app/login/code', { code: await emailCodeFor(verifyR) }, verifyR);
    assert.strictEqual(okR.headers.get('location'), '/app');
    const device = cookieOf(okR, 'traxo_device');
    assert.ok(device, 'appareil mémorisé');
    assert.strictEqual(maxAgeOf(okR, 'delivery_session'), 30 * 24 * 3600, 'rester connecté : 30 jours');
    const again = await post('/app/login', { user: email, password }, device);
    assert.strictEqual(again.headers.get('location'), '/app', 'appareil reconnu : pas de code');

    // 6 bis. Le canal choisi devient la préférence ; choix WhatsApp (canal simulé : WHATSAPP_FAKE=outbox)
    if (process.env.WHATSAPP_FAKE === 'outbox') {
      ip = '10.9.0.6';
      const remembered = await post('/app/login', { user: email, password });
      const remState = await (await get('/app/login/code/state', cookieOf(remembered, 'traxo_verify'))).json();
      assert.strictEqual(remState.channel, 'email', 'premier choix (e-mail) mémorisé : le code part directement');
      await pool.query('UPDATE users SET code_channel = NULL WHERE email = $1', [email]);
      const viaWa = await post('/app/login', { user: email, password });
      const verifyWa = cookieOf(viaWa, 'traxo_verify');
      const waState = await (await get('/app/login/code/state', verifyWa)).json();
      assert.strictEqual(waState.channel, 'pending', 'sans préférence : choix du canal proposé');
      assert.ok(waState.whatsapp && waState.whatsapp.endsWith('07'), 'WhatsApp proposé (numéro masqué)');
      const askedAt = Date.now();
      const switched = await fetch(`${base}/app/login/code/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, Cookie: verifyWa }, body: JSON.stringify({ channel: 'whatsapp' }) });
      assert.strictEqual(switched.status, 200, 'premier envoi WhatsApp immédiat');
      assert.strictEqual((await switched.json()).resendIn, 60, 'renvoi possible après 1 min');
      const again = await fetch(`${base}/app/login/code/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, Cookie: verifyWa }, body: JSON.stringify({ channel: 'email' }) });
      assert.strictEqual(again.status, 429, 'autre canal aussi limité pendant 1 min');
      const wa = await whatsAppCodeAfter('2250707070707', askedAt);
      const minDelay = Number(process.env.WHATSAPP_DELAY_MIN_MS ?? 5000);
      assert.ok(wa.at - askedAt >= minDelay - 50, `message WhatsApp différé (${wa.at - askedAt} ms)`);
      const waOk = await post('/app/login/code', { code: wa.code }, verifyWa);
      assert.strictEqual(waOk.headers.get('location'), '/app', 'code WhatsApp accepté');
      const waSession = cookieOf(waOk, 'delivery_session');
      assert.strictEqual((await pool.query('SELECT code_channel FROM users WHERE email = $1', [email])).rows[0].code_channel, 'whatsapp', 'WhatsApp mémorisé');
      ip = '10.9.0.8';
      const direct = await post('/app/login', { user: email, password });
      const directState = await (await get('/app/login/code/state', cookieOf(direct, 'traxo_verify'))).json();
      assert.strictEqual(directState.channel, 'whatsapp', 'connexion suivante : code directement sur WhatsApp');
      // Paramètres : revenir à l'e-mail
      const back = await fetch(`${base}/api/app/account/phone`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: waSession }, body: JSON.stringify({ codeChannel: 'email' }) });
      assert.strictEqual((await back.json()).codeChannel, 'email', 'préférence modifiable dans les paramètres');
      const local = await fetch(`${base}/api/app/account/phone`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: waSession }, body: JSON.stringify({ phone: '01 97 12 34 56', codeChannel: 'email' }) });
      assert.strictEqual((await local.json()).phone, '+2290197123456', 'numéro béninois sans indicatif accepté');
    }

    ip = '10.9.0.7';
    // 6. Nouvel appareil : code exigé, 5 essais au maximum
    const fresh = await post('/app/login', { user: email, password });
    assert.strictEqual(fresh.headers.get('location'), '/app/login/code', 'nouvel appareil → code');
    assert.ok(!cookieOf(fresh, 'delivery_session'));
    const verify2 = cookieOf(fresh, 'traxo_verify');
    const good = await emailCodeFor(verify2);
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
