// Recette (staging) : interdiction d'indexation, limites désactivées sur demande,
// comptes et données fictives créés au démarrage, isolation entre espaces.
// Le serveur doit tourner avec RAILWAY_ENVIRONMENT_NAME=staging, STAGING_SEED=on,
// STAGING_RATE_LIMITS=off et les variables STAGING_PASSWORD_*.
const assert = require('assert');
const { installStagingGuards, rateLimitsRelaxed, ACCOUNTS } = require('../server/core/staging');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('delivery_session='));
async function login(user, password) {
  const res = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user, password }) });
  return { status: res.status, location: res.headers.get('location'), cookie: cookieOf(res) };
}
const api = async (cookie, url) => { const r = await fetch(`${base}${url}`, { headers: { Cookie: cookie } }); return { status: r.status, data: await r.json().catch(() => ({})) }; };

(async () => {
  // Hors staging : aucun effet.
  const calls = [];
  assert.strictEqual(installStagingGuards({ use: () => calls.push('use'), get: () => calls.push('get') }, { RAILWAY_ENVIRONMENT_NAME: 'production', STAGING_SEED: 'on' }), false);
  assert.strictEqual(calls.length, 0, 'production : aucune règle de recette installée');
  assert.strictEqual(rateLimitsRelaxed({ RAILWAY_ENVIRONMENT_NAME: 'production', STAGING_RATE_LIMITS: 'off' }), false, 'production : limites toujours actives');

  let r = await fetch(`${base}/robots.txt`);
  assert.strictEqual(r.status, 200); assert.ok((await r.text()).includes('Disallow: /'), 'robots.txt interdit tout');
  r = await fetch(`${base}/app/login`);
  assert.ok(/noindex/.test(r.headers.get('x-robots-tag') || ''), 'X-Robots-Tag sur toutes les pages');

  // Chaque compte de recette se connecte.
  const sessions = {};
  for (const a of ACCOUNTS) {
    const s = await login(a.email, process.env[a.passwordVar]);
    assert.strictEqual(s.status, 302, a.email); assert.ok(s.cookie && !/error/.test(s.location), `${a.email} connecté (${s.location})`);
    sessions[a.email] = s.cookie;
  }
  const ownerA = await login(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD);
  assert.ok(ownerA.cookie, 'propriétaire A connecté');
  const ctxA = (await api(ownerA.cookie, '/api/app/context')).data;
  const ctxB = (await api(sessions[ACCOUNTS.find((a) => a.role === 'owner').email], '/api/app/context')).data;
  assert.notStrictEqual(ctxA.company.id, ctxB.company.id, 'deux espaces distincts');
  const wrong = await login(ACCOUNTS[0].email, 'mauvais-mot-de-passe');
  assert.ok(/error=1/.test(wrong.location || ''), 'échec : redirection vers /app/login?error=1');

  // Données fictives présentes, et cloisonnées.
  const dA = (await api(ownerA.cookie, '/api/app/drivers')).data;
  const dB = (await api(sessions['owner-b@staging-traxo.test'], '/api/app/drivers')).data;
  assert.ok(dB.some((d) => /Koffi B/.test(d.name)) && !dB.some((d) => /Koffi A/.test(d.name)), 'livreurs de B seulement');
  assert.ok(dA.some((d) => /Koffi A/.test(d.name)), 'livreurs fictifs de A');
  const wallet = (await api(sessions['owner-b@staging-traxo.test'], '/api/app/billing/wallet')).data;
  assert.ok(wallet.balance >= 5000, 'crédit de recette sur le portefeuille');

  // Limites désactivées : 25 échecs de connexion d'affilée, aucun 429.
  for (let i = 0; i < 25; i += 1) {
    const f = await login(ACCOUNTS[0].email, `faux-${i}`);
    assert.notStrictEqual(f.status, 429, 'pas de limitation en recette');
  }
  console.log('staging-test: OK');
})().catch((error) => { console.error(error); process.exit(1); });
