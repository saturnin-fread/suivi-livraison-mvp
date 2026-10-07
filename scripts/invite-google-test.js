// Rejoindre une équipe avec Google : départ depuis l'invitation (le retour
// de Google ne peut pas être simulé sans Google). Serveur lancé avec
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET de test et WHATSAPP_FAKE=outbox.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const outbox = process.env.EMAIL_OUTBOX_DIR;
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { res, status: res.status, data: await res.json().catch(() => ({})) };
}
const startGoogle = (token, code) => fetch(`${base}/app/auth/google/invite`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, ...(code ? { code } : {}) }) });
async function waitWa(digits, since) {
  for (let i = 0; i < 60; i += 1) {
    const files = fs.existsSync(outbox) ? fs.readdirSync(outbox).filter((f) => f.endsWith('-wa.json')).sort().reverse() : [];
    for (const f of files) {
      if (Number(f.split('-')[0]) < since) continue;
      const msg = JSON.parse(fs.readFileSync(path.join(outbox, f), 'utf8'));
      if (String(msg.whatsapp || '').replace(/\D/g, '').endsWith(digits)) { const m = String(msg.text).match(/\*(\d{6})\*/); if (m) return m[1]; }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Code WhatsApp non reçu');
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const owner = cookieOf(login, 'delivery_session');
  assert.ok(owner, 'connexion');
  const marker = Date.now().toString(36);
  const ids = [];
  try {
    // Lien inconnu : page conçue (pas de texte brut), statut 404
    let page = await fetch(`${base}/invitation/inconnu-${marker}`);
    assert.strictEqual(page.status, 404);
    assert.match(await page.text(), /Cette invitation n’est plus valable/, 'état « invitation expirée » dans la page');

    // Invitation par e-mail : Google directement, adresse pré-remplie chez Google
    const email = `g-${marker}@example.com`;
    let r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Google ${marker}`, role: 'operator', email } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    ids.push(r.data.id);
    const token = r.data.path.split('/').pop();
    r = await call('GET', `/api/public/invitations/${token}`);
    assert.strictEqual(r.data.google, true, 'Google proposé');
    assert.strictEqual(r.data.existingGoogle, false);
    let go = await startGoogle(token);
    assert.strictEqual(go.status, 303);
    const url = new URL(go.headers.get('location'));
    assert.strictEqual(url.host, 'accounts.google.com');
    assert.strictEqual(url.searchParams.get('login_hint'), email, 'compte Google de l’adresse invitée proposé');
    assert.ok(cookieOf(go, 'traxo_oauth'), 'état OAuth signé posé');

    // Invitation par téléphone : code WhatsApp obligatoire avant Google
    const tail = String(Date.now()).slice(-6);
    const phone = `01 94 ${tail.slice(0, 2)} ${tail.slice(2, 4)} ${tail.slice(4, 6)}`;
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Tel ${marker}`, role: 'viewer', phone } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    ids.push(r.data.id);
    const ptoken = r.data.path.split('/').pop();
    go = await startGoogle(ptoken);
    assert.strictEqual(go.status, 303);
    assert.match(go.headers.get('location'), /\?error=code$/, 'sans code : retour sur l’invitation');
    const since = Date.now() - 1000;
    r = await call('POST', `/api/public/invitations/${ptoken}/send-code`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const code = await waitWa(phone.replace(/\D/g, '').slice(-8), since);
    go = await startGoogle(ptoken, code);
    assert.strictEqual(go.status, 303);
    assert.strictEqual(new URL(go.headers.get('location')).host, 'accounts.google.com', 'code valide : départ chez Google');
    const att = (await pool.query('SELECT verify_attempts FROM user_invitations WHERE id = $1', [r.data?.id || ids[1]])).rows[0];
    assert.ok(att && att.verify_attempts === 1, 'l’essai sans code a été compté');

    // Invitation annulée : retour sur la page (état expiré)
    await pool.query('UPDATE user_invitations SET revoked_at = NOW() WHERE id = $1', [ids[0]]);
    go = await startGoogle(token);
    assert.strictEqual(go.headers.get('location'), `/invitation/${encodeURIComponent(token)}`);
    console.log('invite-google-test: OK');
  } finally {
    if (ids.length) await pool.query('UPDATE user_invitations SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = ANY($1::bigint[])', [ids]).catch(() => {});
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
