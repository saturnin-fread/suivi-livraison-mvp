// Équipe et accès : invitations (e-mail, téléphone + code WhatsApp),
// rôle Lecture seule, changement de rôle, suspension, retrait, annulation,
// protections (propriétaire, soi-même, livreurs, administrateurs).
// À lancer avec WHATSAPP_FAKE=outbox et EMAIL_OUTBOX_DIR.
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
    console.log('team-test: OK');
  } finally {
    if (createdUsers.length) {
      await pool.query('DELETE FROM app_sessions WHERE user_id = ANY($1::bigint[])', [createdUsers]);
      await pool.query('DELETE FROM company_memberships WHERE user_id = ANY($1::bigint[])', [createdUsers]);
    }
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
