// Support TRAXO : création idempotente, pièces jointes privées et vérifiées,
// droits (créateur + propriétaire), notes internes jamais exposées, réponse du
// support → non-lu (pastille + cloche) → lecture, statuts, résolution et
// réouverture sous la même référence, accès en lecture seule.
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body, raw, type } = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}) };
  if (raw) headers['Content-Type'] = type || 'application/octet-stream';
  else if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers, body: raw || (body ? JSON.stringify(body) : undefined) });
  const buf = Buffer.from(await res.arrayBuffer());
  let data = {};
  try { data = JSON.parse(buf.toString('utf8')); } catch { data = { raw: buf }; }
  return { status: res.status, data, headers: res.headers, buf };
}
const key = () => crypto.randomBytes(12).toString('hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c00000000049454e44ae426082', 'hex');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const owner = cookieOf(login, 'delivery_session');
  assert.ok(owner, 'connexion propriétaire');
  const marker = Date.now().toString(36);
  const made = { users: [], companies: [], sessions: [] };
  const ctx = (await call('GET', '/api/app/context', { cookie: owner })).data;
  const cid = ctx.company.id;
  assert.strictEqual(ctx.user.role, 'owner', 'ADMIN_USER est propriétaire');

  async function sessionFor({ role, platform = false, companyId = cid }) {
    const u = (await pool.query(`INSERT INTO users (email, display_name, password_salt, password_hash, is_platform_admin) VALUES ($1, $2, 'test', $3, $4) RETURNING id`,
      [`support-${role}-${marker}-${made.users.length}@example.invalid`, `${role} ${marker}`, '0'.repeat(128), platform])).rows[0].id;
    made.users.push(u);
    await pool.query(`INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, $3)`, [companyId, u, role]);
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    made.sessions.push(hash);
    await pool.query(`INSERT INTO app_sessions (token_hash, user_id, company_id, scope, expires_at) VALUES ($1, $2, $3, 'company', NOW() + INTERVAL '20 minutes')`, [hash, u, companyId]);
    return `delivery_session=${token}`;
  }
  try {
    const operator = await sessionFor({ role: 'operator' });
    const viewer = await sessionFor({ role: 'viewer' });
    const foreignCo = (await pool.query(`INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Support autre ${marker}`, `support-autre-${marker}`])).rows[0].id;
    made.companies.push(foreignCo);
    const foreign = await sessionFor({ role: 'owner', companyId: foreignCo });
    const agentCo = (await pool.query(`INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Équipe TRAXO ${marker}`, `traxo-${marker}`])).rows[0].id;
    made.companies.push(agentCo);
    const agent = await sessionFor({ role: 'owner', platform: true, companyId: agentCo });

    // --- Création ---------------------------------------------------------
    let r = await call('POST', '/api/app/support/tickets', { cookie: owner, body: { subject: 'Sans clé', message: 'x' } });
    assert.strictEqual(r.status, 400, 'clé d’idempotence requise');
    r = await call('POST', '/api/app/support/tickets', { cookie: owner, body: { subject: '', message: 'x', idempotencyKey: key() } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'SUBJECT');
    r = await call('POST', '/api/app/support/tickets', { cookie: owner, body: { subject: 'Rien', message: '', idempotencyKey: key() } });
    assert.strictEqual(r.data.code, 'MESSAGE', 'message, fichier ou note requis');

    // Pièce jointe : type vérifié par le contenu, pas par le nom
    r = await call('POST', '/api/app/support/uploads?name=faux.png', { cookie: owner, raw: Buffer.from('<script>alert(1)</script> pas une image') });
    assert.strictEqual(r.status, 415, 'contenu non reconnu refusé');
    r = await call('POST', '/api/app/support/uploads?name=' + encodeURIComponent('capture écran.png'), { cookie: owner, raw: PNG, type: 'image/png' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const upload = r.data;
    assert.strictEqual(upload.kind, 'image'); assert.strictEqual(upload.mime, 'image/png');
    r = await call('GET', `/api/app/support/files/${upload.id}`, { cookie: operator });
    assert.strictEqual(r.status, 404, 'brouillon visible de son seul auteur');
    r = await call('POST', '/api/app/support/uploads?name=gros.bin', { cookie: owner, raw: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]) });
    assert.strictEqual(r.status, 413, 'au-delà de 10 Mo');

    const createKey = key();
    const body = { subject: `Livreur hors ligne ${marker}`, category: 'drivers', message: 'Mon livreur reste hors ligne depuis ce matin.', uploadId: upload.id, idempotencyKey: createKey };
    r = await call('POST', '/api/app/support/tickets', { cookie: owner, body });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const t = r.data.ticket;
    assert.match(t.reference, /^TRX-\d{4,}$/);
    assert.strictEqual(t.status, 'received'); assert.strictEqual(t.statusLabel, 'Reçue');
    const again = await call('POST', '/api/app/support/tickets', { cookie: owner, body });
    assert.strictEqual(again.status, 200, 'même clé : pas de seconde demande');
    assert.strictEqual(again.data.ticket.id, t.id);
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM support_tickets WHERE create_idempotency_key = $1', [createKey])).rows[0].n, 1);
    r = await call('POST', '/api/app/support/tickets', { cookie: owner, body: { ...body, idempotencyKey: key() } });
    assert.strictEqual(r.status, 409, 'une pièce jointe ne passe pas d’une demande à l’autre');

    r = await call('GET', `/api/app/support/files/${upload.id}`, { cookie: owner });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'image/png');
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(/no-store/.test(r.headers.get('cache-control')));
    assert.ok(r.buf.equals(PNG), 'fichier intact');

    // --- Droits -----------------------------------------------------------
    r = await call('GET', '/api/app/support/tickets?tab=all', { cookie: operator });
    assert.ok(!r.data.tickets.some((x) => x.id === t.id), 'un opérateur ne voit pas la demande du propriétaire');
    assert.strictEqual((await call('GET', `/api/app/support/tickets/${t.id}`, { cookie: operator })).status, 404);
    assert.strictEqual((await call('GET', `/api/app/support/files/${upload.id}`, { cookie: operator })).status, 404);
    assert.strictEqual((await call('GET', `/api/app/support/tickets/${t.id}`, { cookie: foreign })).status, 404, 'autre entreprise');
    assert.strictEqual((await call('GET', `/api/app/support/files/${upload.id}`, { cookie: foreign })).status, 404);
    r = await call('POST', '/api/app/support/tickets', { cookie: operator, body: { subject: `Question opérateur ${marker}`, message: 'Bonjour', idempotencyKey: key() } });
    assert.strictEqual(r.status, 201);
    const opTicket = r.data.ticket.id;
    r = await call('GET', '/api/app/support/tickets?tab=open', { cookie: owner });
    assert.ok(r.data.tickets.some((x) => x.id === opTicket), 'le propriétaire voit les demandes de son espace');
    r = await call('POST', '/api/app/support/tickets', { cookie: viewer, body: { subject: `Lecture seule ${marker}`, message: 'Besoin d’aide', idempotencyKey: key() } });
    assert.strictEqual(r.status, 201, 'le support reste accessible en lecture seule');
    assert.strictEqual((await call('GET', '/api/app/platform/support/tickets', { cookie: operator })).status, 403, 'bureau du support réservé à TRAXO');
    assert.strictEqual((await call('GET', '/api/app/platform/support/tickets', { cookie: foreign })).status, 403);

    // --- Côté support : note interne, réponse, statut ----------------------
    r = await call('GET', '/api/app/platform/support/tickets?status=open', { cookie: agent });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const row = r.data.tickets.find((x) => x.id === t.id);
    assert.ok(row && row.unread, 'nouveau message client signalé au support');
    r = await call('POST', `/api/app/platform/support/tickets/${t.id}/messages`, { cookie: agent, body: { message: `NOTE-INTERNE-${marker}`, internal: true, idempotencyKey: key() } });
    assert.strictEqual(r.status, 201);
    r = await call('POST', `/api/app/platform/support/tickets/${t.id}/messages`, { cookie: agent, body: { message: 'Ouvrez sa fiche puis « Connecter l’application ».', status: 'waiting_customer', idempotencyKey: key() } });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.data.ticket.status, 'waiting_customer');

    r = await call('GET', `/api/app/support/tickets/${t.id}`, { cookie: owner });
    assert.ok(!JSON.stringify(r.data).includes(`NOTE-INTERNE-${marker}`), 'note interne jamais envoyée au client');
    assert.ok(!('internal' in r.data.messages[0]));
    assert.strictEqual(r.data.messages.length, 2);
    assert.strictEqual(r.data.messages[1].author, 'support');
    assert.strictEqual(r.data.ticket.statusLabel, 'Votre réponse attendue');
    assert.ok(r.data.events.some((e) => e.kind === 'status_changed' && e.to === 'waiting_customer'));

    r = await call('GET', '/api/app/support/summary', { cookie: owner });
    assert.ok(r.data.unreadTicketIds.includes(t.id), 'pastille : réponse non lue');
    r = await call('GET', '/api/app/notifications', { cookie: owner });
    const notif = r.data.items.find((x) => x.type === 'support' && x.href === `/app?support=${t.id}`);
    assert.ok(notif, 'cloche : la notification ouvre la bonne demande');
    r = await call('GET', '/api/app/support/tickets?tab=open', { cookie: owner });
    assert.strictEqual(r.data.tickets.find((x) => x.id === t.id).unread, true);
    await call('POST', `/api/app/support/tickets/${t.id}/read`, { cookie: owner, body: {} });
    r = await call('GET', '/api/app/support/summary', { cookie: owner });
    assert.ok(!r.data.unreadTicketIds.includes(t.id), 'lu');
    r = await call('GET', '/api/app/notifications', { cookie: owner });
    assert.ok(!r.data.items.some((x) => x.id === notif.id), 'la cloche suit la même source');

    // --- Réponse du client : repasse « En cours », envoi rejoué sans doublon
    const msgKey = key();
    r = await call('POST', `/api/app/support/tickets/${t.id}/messages`, { cookie: owner, body: { message: 'C’est fait, merci.', idempotencyKey: msgKey } });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.data.ticket.status, 'in_progress');
    const replay = await call('POST', `/api/app/support/tickets/${t.id}/messages`, { cookie: owner, body: { message: 'C’est fait, merci.', idempotencyKey: msgKey } });
    assert.strictEqual(replay.status, 200); assert.strictEqual(replay.data.messageId, r.data.messageId);
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM support_messages WHERE ticket_id = $1 AND NOT internal', [t.id])).rows[0].n, 3);

    // --- Résolution, puis réouverture sous la même référence ----------------
    r = await call('POST', `/api/app/platform/support/tickets/${t.id}/status`, { cookie: agent, body: { status: 'resolved' } });
    assert.strictEqual(r.data.ticket.status, 'resolved');
    r = await call('POST', `/api/app/support/tickets/${t.id}/messages`, { cookie: owner, body: { message: 'Encore un souci', idempotencyKey: key() } });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.data.code, 'RESOLVED');
    r = await call('GET', '/api/app/support/tickets?tab=resolved', { cookie: owner });
    assert.ok(r.data.tickets.some((x) => x.id === t.id), 'onglet Résolues');
    r = await call('POST', `/api/app/support/tickets/${t.id}/reopen`, { cookie: owner });
    assert.strictEqual(r.data.ticket.status, 'in_progress');
    assert.strictEqual(r.data.ticket.reference, t.reference, 'même référence');
    r = await call('GET', `/api/app/support/tickets/${t.id}`, { cookie: owner });
    assert.ok(r.data.events.some((e) => e.kind === 'reopened'));
    assert.strictEqual(r.data.messages[0].attachments[0].id, upload.id, 'la pièce jointe reste dans sa demande');

    // --- Fichier du support visible du client, pas d'une autre entreprise ---
    r = await call('POST', '/api/app/platform/support/uploads?name=guide.png', { cookie: agent, raw: PNG });
    assert.strictEqual(r.status, 201);
    const agentFile = r.data.id;
    r = await call('POST', `/api/app/platform/support/tickets/${t.id}/messages`, { cookie: agent, body: { message: 'Voici la capture.', uploadId: agentFile, idempotencyKey: key() } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await call('GET', `/api/app/support/files/${agentFile}`, { cookie: owner })).status, 200);
    assert.strictEqual((await call('GET', `/api/app/support/files/${agentFile}`, { cookie: foreign })).status, 404);
    console.log('support-test: OK');
  } finally {
    if (made.sessions.length) await pool.query('DELETE FROM app_sessions WHERE token_hash = ANY($1::text[])', [made.sessions]);
    await pool.query(`DELETE FROM support_tickets WHERE subject LIKE $1`, [`%${marker}%`]).catch(() => {});
    await pool.query(`DELETE FROM support_attachments WHERE message_id IS NULL AND uploaded_by_user_id = ANY($1::bigint[])`, [made.users]).catch(() => {});
    if (made.users.length) {
      await pool.query('DELETE FROM company_memberships WHERE user_id = ANY($1::bigint[])', [made.users]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [made.users]).catch(() => {});
    }
    if (made.companies.length) await pool.query('DELETE FROM companies WHERE id = ANY($1::bigint[])', [made.companies]).catch(() => {});
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
