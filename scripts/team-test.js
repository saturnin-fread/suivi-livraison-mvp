// Équipe et accès : invitations (e-mail, téléphone + code WhatsApp),
// rôle Lecture seule, changement de rôle, suspension, retrait, annulation,
// protections (propriétaire, soi-même, livreurs, administrateurs).
// À lancer avec WHATSAPP_FAKE=outbox et EMAIL_OUTBOX_DIR.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const { waitEmailCode } = require('./lib/outbox-code');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const outbox = process.env.EMAIL_OUTBOX_DIR;
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { res, status: res.status, data: await res.json().catch(() => ({})) };
}
async function waitCode(digits, since) {
  for (let i = 0; i < 60; i += 1) {
    const files = fs.existsSync(outbox) ? fs.readdirSync(outbox).filter((f) => f.endsWith('-wa.json')).sort() : [];
    for (const f of files.reverse()) {
      if (Number(f.split('-')[0]) < since) continue;
      const msg = JSON.parse(fs.readFileSync(path.join(outbox, f), 'utf8'));
      if (String(msg.whatsapp || '').replace(/\D/g, '').endsWith(digits)) {
        const m = String(msg.text).match(/\*(\d{6})\*/);
        if (m) return m[1];
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Code WhatsApp non reçu');
}

(async () => {
  assert.ok(outbox, 'EMAIL_OUTBOX_DIR requis');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const owner = cookieOf(login, 'delivery_session');
  assert.ok(owner, 'connexion propriétaire');
  const marker = Date.now().toString(36);
  const tail = String(Date.now()).slice(-6);
  const phone = `01 97 ${tail.slice(0, 2)} ${tail.slice(2, 4)} ${tail.slice(4, 6)}`;
  const createdUsers = [];
  try {
    // Validation
    let r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: 'A', role: 'operator', email: 'x@example.com' } });
    assert.strictEqual(r.status, 400, 'nom trop court');
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Sans contact ${marker}`, role: 'operator' } });
    assert.strictEqual(r.status, 400, 'un contact est exigé');
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Mauvais ${marker}`, role: 'operator', phone: '12' } });
    assert.strictEqual(r.status, 400, 'téléphone invalide');
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Rôle ${marker}`, role: 'owner', email: `r-${marker}@example.com` } });
    assert.strictEqual(r.status, 400, 'propriétaire non invitable');

    // Invitation par téléphone, rôle Lecture seule
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Lina ${marker}`, role: 'viewer', phone } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const inviteId = String(r.data.id);
    let token = r.data.path.split('/').pop();
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Lina bis ${marker}`, role: 'operator', phone } });
    assert.strictEqual(r.status, 409, 'doublon refusé');

    // Copier puis renouveler
    r = await call('POST', `/api/app/invitations/${inviteId}/reveal`, { cookie: owner });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.path.endsWith(token), 'lien recopié identique');
    r = await call('POST', `/api/app/invitations/${inviteId}/renew`, { cookie: owner });
    assert.strictEqual(r.status, 200);
    const oldToken = token;
    token = r.data.path.split('/').pop();
    assert.notStrictEqual(token, oldToken);
    r = await call('GET', `/api/public/invitations/${oldToken}`);
    assert.strictEqual(r.status, 404, 'ancien lien invalide');
    r = await call('GET', `/api/public/invitations/${token}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.needsEmail, true);
    assert.strictEqual(r.data.verification, 'whatsapp');
    assert.strictEqual(r.data.role_label, 'Lecture seule');
    assert.ok(r.data.invited_by, 'invitant affiché');

    // Acceptation : code obligatoire
    const pwd = `Lecture-${marker}-Aa1!`;
    r = await call('POST', `/api/public/invitations/${token}/accept`, { body: { email: `lina-${marker}@example.com`, code: '000000', password: pwd, passwordConfirmation: pwd } });
    assert.strictEqual(r.status, 400, 'code requis');
    const since = Date.now() - 1000;
    r = await call('POST', `/api/public/invitations/${token}/send-code`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const code = await waitCode(phone.replace(/\D/g, '').slice(-8), since);
    const accept = await call('POST', `/api/public/invitations/${token}/accept`, { body: { email: `lina-${marker}@example.com`, code, password: pwd, passwordConfirmation: pwd } });
    assert.strictEqual(accept.status, 201, JSON.stringify(accept.data));
    const viewer = cookieOf(accept.res, 'delivery_session');
    assert.ok(viewer, 'session ouverte');
    const viewerUser = (await pool.query('SELECT id, phone, code_channel FROM users WHERE email = $1', [`lina-${marker}@example.com`])).rows[0];
    createdUsers.push(viewerUser.id);
    assert.ok(viewerUser.phone, 'téléphone enregistré');
    assert.strictEqual(viewerUser.code_channel, 'whatsapp');

    // Lecture seule : lecture oui, écriture non (sauf son compte)
    r = await call('GET', '/api/app/orders', { cookie: viewer });
    assert.strictEqual(r.status, 200, 'lecture autorisée');
    r = await call('POST', '/api/app/request-links', { cookie: viewer, body: {} });
    assert.strictEqual(r.status, 403, 'écriture bloquée');
    assert.strictEqual(r.data.code, 'READ_ONLY');
    r = await call('POST', '/api/app/ops/views', { cookie: viewer, body: { source: 'commandes', name: `Vue ${marker}` } });
    assert.strictEqual(r.status, 201, 'vue personnelle autorisée');
    await pool.query('DELETE FROM ops_views WHERE id = $1', [r.data.id]);
    r = await call('GET', '/api/app/team', { cookie: viewer });
    assert.strictEqual(r.status, 403, 'équipe réservée aux responsables');

    // Liste et protections
    let team = (await call('GET', '/api/app/team', { cookie: owner })).data;
    const me = team.members.find((m) => m.me);
    const ownerMember = team.members.find((m) => m.role === 'owner');
    const lina = team.members.find((m) => m.userId === String(viewerUser.id));
    assert.ok(lina && lina.role === 'viewer' && lina.state === 'active', 'membre listé');
    assert.ok(lina.lastSeenAt, 'dernière activité');
    r = await call('PATCH', `/api/app/team/members/${me.id}`, { cookie: owner, body: { role: 'operator' } });
    assert.strictEqual(r.status, 409, 'pas soi-même');
    if (ownerMember.id !== me.id) {
      r = await call('POST', `/api/app/team/members/${ownerMember.id}/suspend`, { cookie: owner });
      assert.strictEqual(r.status, 409, 'propriétaire protégé');
    }
    r = await call('PATCH', `/api/app/team/members/${lina.id}`, { cookie: owner, body: { role: 'owner' } });
    assert.strictEqual(r.status, 400, 'rôle propriétaire refusé');

    // Rôle, suspension, réactivation
    r = await call('PATCH', `/api/app/team/members/${lina.id}`, { cookie: owner, body: { role: 'operator' } });
    assert.strictEqual(r.status, 200);
    r = await call('POST', `/api/app/team/members/${lina.id}/suspend`, { cookie: owner });
    assert.strictEqual(r.status, 200);
    r = await call('GET', '/api/app/orders', { cookie: viewer });
    assert.strictEqual(r.status, 401, 'session coupée à la suspension');
    const relog = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: `lina-${marker}@example.com`, password: pwd }) });
    const relogCookie = cookieOf(relog, 'delivery_session');
    if (relogCookie) {
      r = await call('GET', '/api/app/orders', { cookie: relogCookie });
      assert.strictEqual(r.status, 401, 'reconnexion inutile tant que suspendu');
    }
    r = await call('POST', `/api/app/team/members/${lina.id}/reactivate`, { cookie: owner });
    assert.strictEqual(r.status, 200);
    let hist = (await call('GET', `/api/app/team/members/${lina.id}/history`, { cookie: owner })).data;
    const actions = hist.map((h) => h.action);
    ['role_changed', 'suspended', 'reactivated', 'accepted'].forEach((a) => assert.ok(actions.includes(a), `historique : ${a}`));

    // Retrait puis annulation
    r = await call('POST', `/api/app/team/members/${lina.id}/remove`, { cookie: owner });
    assert.strictEqual(r.status, 200);
    team = (await call('GET', '/api/app/team', { cookie: owner })).data;
    assert.ok(!team.members.some((m) => m.userId === String(viewerUser.id)), 'retiré de la liste');
    r = await call('POST', '/api/app/team/members/restore', { cookie: owner, body: { userId: String(viewerUser.id) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.role, 'operator', 'rôle rétabli');
    r = await call('POST', '/api/app/team/members/restore', { cookie: owner, body: { userId: String(viewerUser.id) } });
    assert.strictEqual(r.status, 409, 'déjà rétabli');

    // Invitation par e-mail : révocation, statut annulé visible
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Marc ${marker}`, role: 'operator', email: `marc-${marker}@example.com` } });
    assert.strictEqual(r.status, 201);
    const mailInvite = String(r.data.id);
    r = await call('POST', `/api/app/invitations/${mailInvite}/revoke`, { cookie: owner });
    assert.strictEqual(r.status, 200);
    team = (await call('GET', '/api/app/team', { cookie: owner })).data;
    assert.strictEqual(team.invitations.find((i) => i.id === mailInvite)?.state, 'revoked', 'invitation annulée listée');
    r = await call('POST', `/api/app/invitations/${mailInvite}/reveal`, { cookie: owner });
    assert.strictEqual(r.status, 404, 'lien d’une invitation annulée non affiché');
    // --- Compte TRAXO existant : il rejoint cet espace sans conflit ----------
    const extEmail = `ext-${marker}@example.com`;
    const extPwd = `Mon-espace-${marker}-Bz9`;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(extPwd, salt, 64).toString('hex');
    const extUser = (await pool.query(`INSERT INTO users (email, display_name, password_salt, password_hash) VALUES ($1, 'Ext', $2, $3) RETURNING id`, [extEmail, salt, hash])).rows[0].id;
    createdUsers.push(extUser);
    const extCo = (await pool.query(`INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Espace Ext ${marker}`, `ext-${marker}`])).rows[0].id;
    await pool.query(`INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [extCo, extUser]);
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Ext ${marker}`, role: 'operator', email: extEmail } });
    assert.strictEqual(r.status, 201, `compte existant invitable : ${JSON.stringify(r.data)}`);
    const extToken = r.data.path.split('/').pop();
    r = await call('GET', `/api/public/invitations/${extToken}`);
    assert.strictEqual(r.data.existingAccount, true, 'compte existant reconnu');
    assert.strictEqual(r.data.verification, 'email', 'code par e-mail exigé');
    r = await call('POST', `/api/public/invitations/${extToken}/accept`, { body: { password: extPwd } });
    assert.strictEqual(r.status, 400, 'le lien seul ne suffit pas : code exigé');
    let since2 = Date.now() - 1000;
    r = await call('POST', `/api/public/invitations/${extToken}/send-code`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.channel, 'email');
    const extCode = await waitEmailCode(extEmail, since2);
    r = await call('POST', `/api/public/invitations/${extToken}/accept`, { body: { code: extCode } });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.data.code, 'EXISTING_ACCOUNT', 'mot de passe du compte demandé');
    r = await call('POST', `/api/public/invitations/${extToken}/accept`, { body: { code: extCode, password: 'pas-le-bon-mot-de-passe' } });
    assert.strictEqual(r.status, 400, 'mauvais mot de passe refusé');
    const joined = await call('POST', `/api/public/invitations/${extToken}/accept`, { body: { code: extCode, password: extPwd } });
    assert.strictEqual(joined.status, 201, JSON.stringify(joined.data));
    assert.strictEqual(joined.data.joinedExisting, true);
    const extSession = cookieOf(joined.res, 'delivery_session');
    r = await call('GET', '/api/app/account/spaces', { cookie: extSession });
    assert.strictEqual(r.data.spaces.length, 2, 'deux espaces sur le même compte');
    assert.ok(r.data.spaces.some((sp) => sp.id === String(extCo) && sp.role === 'owner'), 'son propre espace est conservé');
    r = await call('POST', '/api/app/account/spaces/switch', { cookie: extSession, body: { companyId: String(extCo) } });
    assert.strictEqual(r.status, 200);
    r = await call('GET', '/api/app/context', { cookie: extSession });
    assert.strictEqual(String(r.data.company.id), String(extCo), 'bascule vers son espace');
    assert.strictEqual(r.data.user.role, 'owner');
    const foreignCo = (await pool.query(`INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Étranger ${marker}`, `etr-${marker}`])).rows[0].id;
    r = await call('POST', '/api/app/account/spaces/switch', { cookie: extSession, body: { companyId: String(foreignCo) } });
    assert.strictEqual(r.status, 404, 'impossible de basculer vers un espace dont on n’est pas membre');
    await pool.query('DELETE FROM companies WHERE id = $1', [foreignCo]);
    // La connexion revient au dernier espace ouvert
    const extRelog = await fetch(`${base}/app/login`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ user: extEmail, password: extPwd }) });
    const extRelogCookie = cookieOf(extRelog, 'delivery_session');
    if (extRelogCookie) { r = await call('GET', '/api/app/context', { cookie: extRelogCookie }); assert.strictEqual(String(r.data.company.id), String(extCo), 'dernier espace ouvert retrouvé'); }
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Ext bis ${marker}`, role: 'viewer', email: extEmail } });
    assert.strictEqual(r.status, 409, 'déjà membre : pas de seconde invitation');
    // Invitation par téléphone vers un compte existant : le code arrive sur le
    // WhatsApp invité, pas à l'adresse du compte → pas de session ouverte,
    // connexion normale exigée (code envoyé à l'adresse du compte).
    const ext2Email = `ext2-${marker}@example.com`;
    const salt2 = crypto.randomBytes(16).toString('hex');
    const ext2 = (await pool.query(`INSERT INTO users (email, display_name, password_salt, password_hash) VALUES ($1, 'Ext2', $2, $3) RETURNING id`, [ext2Email, salt2, crypto.scryptSync(extPwd, salt2, 64).toString('hex')])).rows[0].id;
    createdUsers.push(ext2);
    const phone2 = `01 96 ${tail.slice(0, 2)} ${tail.slice(2, 4)} ${tail.slice(4, 6)}`;
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Ext2 ${marker}`, role: 'operator', phone: phone2 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const ext2Token = r.data.path.split('/').pop();
    const since3 = Date.now() - 1000;
    r = await call('POST', `/api/public/invitations/${ext2Token}/send-code`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const ext2Code = await waitCode(phone2.replace(/\D/g, '').slice(-8), since3);
    const viaPhone = await call('POST', `/api/public/invitations/${ext2Token}/accept`, { body: { email: ext2Email, code: ext2Code, password: extPwd } });
    assert.strictEqual(viaPhone.status, 201, JSON.stringify(viaPhone.data));
    assert.strictEqual(viaPhone.data.redirect, '/app/login?joined=1', 'compte existant via téléphone : connexion normale exigée');
    assert.ok(!cookieOf(viaPhone.res, 'delivery_session'), 'aucune session ouverte sans preuve de l’adresse du compte');

    // --- Nouveau compte par e-mail : code + mot de passe solide ----------------
    const newEmail = `nouveau-${marker}@example.com`;
    r = await call('POST', '/api/app/invitations', { cookie: owner, body: { displayName: `Nouveau ${marker}`, role: 'operator', email: newEmail } });
    const newToken = r.data.path.split('/').pop();
    since2 = Date.now() - 1000;
    await call('POST', `/api/public/invitations/${newToken}/send-code`);
    const newCode = await waitEmailCode(newEmail, since2);
    r = await call('POST', `/api/public/invitations/${newToken}/accept`, { body: { code: newCode, password: 'azertyuiop', passwordConfirmation: 'azertyuiop' } });
    assert.strictEqual(r.status, 400, 'mot de passe courant refusé');
    r = await call('POST', `/api/public/invitations/${newToken}/accept`, { body: { code: newCode, password: `nouveau${marker}x`, passwordConfirmation: `nouveau${marker}x` } });
    assert.strictEqual(r.status, 400, 'mot de passe reprenant l’adresse refusé');
    const okPwd = `Une phrase ${marker} solide`;
    r = await call('POST', `/api/public/invitations/${newToken}/accept`, { body: { code: newCode, password: okPwd, passwordConfirmation: okPwd } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const newUser = (await pool.query('SELECT id, email_verified_at FROM users WHERE email = $1', [newEmail])).rows[0];
    createdUsers.push(newUser.id);
    assert.ok(newUser.email_verified_at, 'adresse confirmée par le code');
    console.log('team-test: OK');
  } finally {
    if (createdUsers.length) {
      await pool.query('DELETE FROM app_sessions WHERE user_id = ANY($1::bigint[])', [createdUsers]);
      await pool.query('DELETE FROM company_memberships WHERE user_id = ANY($1::bigint[])', [createdUsers]);
      await pool.query(`DELETE FROM companies WHERE slug LIKE 'ext-%' AND NOT EXISTS (SELECT 1 FROM company_memberships m WHERE m.company_id = companies.id)`).catch(() => {});
    }
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
