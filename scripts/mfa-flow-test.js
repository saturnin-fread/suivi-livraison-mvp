// Parcours double authentification (serveur lancé, SMOKE_BASE_URL) : activation,
// connexion en deux étapes, code faux, code de secours à usage unique, désactivation.
const assert = require('assert');
const totp = require('../lib/totp');
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const email = process.env.ADMIN_USER; const password = process.env.ADMIN_PASSWORD;
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function login() {
  const res = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: email, password }) });
  return { location: res.headers.get('location'), session: cookieOf(res, 'delivery_session'), mfa: cookieOf(res, 'traxo_mfa') };
}
async function second(mfa, code) {
  const res = await fetch(`${base}/app/login/2fa`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: mfa }, body: new URLSearchParams({ code }) });
  return { location: res.headers.get('location'), session: cookieOf(res, 'delivery_session') };
}
const api = async (cookie, path, body) => { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let cleanupCodes = null;
// En cas d'échec en cours de route, on désactive la 2FA pour ne pas bloquer
// les autres tests qui se connectent avec le même compte.
async function cleanup() {
  if (!cleanupCodes) return;
  for (const code of cleanupCodes.slice(2)) {
    const step = await login();
    if (step.session) return;
    const done = await second(step.mfa, code);
    if (!done.session) continue;
    const off = await api(done.session, '/api/app/account/2fa/disable', { password, code: cleanupCodes[cleanupCodes.length - 1] });
    if (off.status === 200) return;
  }
}
(async () => {
  const first = await login();
  assert.ok(first.session && first.location === '/app', 'connexion simple sans 2FA');
  const setup = await api(first.session, '/api/app/account/2fa/setup', {});
  assert.strictEqual(setup.status, 200); assert.ok(setup.data.qrSvg.startsWith('<svg'), 'QR code SVG');
  const secret = setup.data.secret.replace(/\s+/g, '');
  assert.strictEqual((await api(first.session, '/api/app/account/2fa/enable', { code: '000000' })).status, 400, 'code faux refusé à l’activation');
  const enabled = await api(first.session, '/api/app/account/2fa/enable', { code: totp.totp(secret) });
  assert.strictEqual(enabled.status, 200); assert.strictEqual(enabled.data.recoveryCodes.length, 8);
  cleanupCodes = enabled.data.recoveryCodes;
  const sec = await api(first.session, '/api/app/account/security');
  assert.ok(sec.data.twoFactorEnabled && sec.data.recoveryCodesLeft === 8, 'état 2FA exposé');

  const step1 = await login();
  assert.ok(!step1.session && step1.mfa && step1.location === '/app/login/2fa', 'mot de passe seul : pas de session, étape 2');
  const bad = await second(step1.mfa, '123456');
  assert.ok(!bad.session && /error=code/.test(bad.location), 'code faux : refusé');
  await wait(31000); // le code d'activation ne peut pas être rejoué : on attend le pas suivant
  const good = await second(step1.mfa, totp.totp(secret));
  assert.ok(good.session && good.location === '/app', 'code correct : session ouverte');
  assert.strictEqual((await api(good.session, '/api/app/context')).status, 200);
  const replay = await second(step1.mfa, totp.totp(secret));
  assert.ok(!replay.session, 'défi déjà consommé');

  const step2 = await login();
  const recovery = await second(step2.mfa, enabled.data.recoveryCodes[0].toLowerCase());
  assert.ok(recovery.session, 'code de secours accepté');
  const step3 = await login();
  assert.ok(!(await second(step3.mfa, enabled.data.recoveryCodes[0])).session, 'code de secours à usage unique');

  const step4 = await login();
  const expired = [];
  for (let i = 0; i < 6; i += 1) expired.push((await second(step4.mfa, '999999')).location);
  assert.ok(expired[5].includes('error=expired'), 'défi bloqué après 5 échecs');

  assert.strictEqual((await api(good.session, '/api/app/account/2fa/disable', { password: 'faux', code: enabled.data.recoveryCodes[1] })).status, 400, 'mot de passe exigé');
  const off = await api(good.session, '/api/app/account/2fa/disable', { password, code: enabled.data.recoveryCodes[1] });
  assert.strictEqual(off.status, 200);
  cleanupCodes = null;
  assert.ok((await login()).session, 'après désactivation : connexion simple');
  console.log('Double authentification OK : activation, 2 étapes, code faux, anti-rejeu, codes de secours, blocage, désactivation.');
})().catch(async (e) => { console.error('Test 2FA échoué :', e.message); await cleanup().catch(() => {}); process.exit(1); });
