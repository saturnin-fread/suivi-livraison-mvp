'use strict';

// Support TRAXO : une demande (SupportTicket) = un sujet, une référence, un
// statut et sa propre discussion. Les notes internes du support ne sortent
// jamais vers l'API client. Les fichiers sont privés : servis seulement à un
// participant authentifié, jamais par une URL publique.
//
// Droits côté entreprise : la personne qui a créé la demande, et le
// propriétaire du compte (responsable de l'abonnement). Les autres membres ne
// voient pas les demandes de leurs collègues.

const crypto = require('crypto');

const STATUSES = ['received', 'in_progress', 'waiting_customer', 'resolved'];
const OPEN_STATUSES = ['received', 'in_progress', 'waiting_customer'];
const STATUS_LABELS = { received: 'Reçue', in_progress: 'En cours', waiting_customer: 'Votre réponse attendue', resolved: 'Résolue' };
const CATEGORIES = {
  deliveries: 'Livraisons', drivers: 'Livreurs et application', billing: 'Facturation',
  account: 'Compte et accès', other: 'Autre chose',
};
const MAX_SUBJECT = 120;
const MAX_BODY = 5000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const STAGED_TTL_HOURS = 24;
const PAGE = 30;

class SupportError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// Type vérifié d'après les premiers octets, pas d'après le nom ou l'en-tête.
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  const hex = buf.subarray(0, 12).toString('hex');
  const ascii = buf.subarray(0, 12).toString('latin1');
  if (hex.startsWith('89504e47')) return { mime: 'image/png', kind: 'image', ext: 'png' };
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', kind: 'image', ext: 'jpg' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image', ext: 'webp' };
  if (ascii.startsWith('%PDF')) return { mime: 'application/pdf', kind: 'file', ext: 'pdf' };
  if (hex.startsWith('1a45dfa3')) return { mime: 'audio/webm', kind: 'audio', ext: 'webm' };
  if (ascii.startsWith('OggS')) return { mime: 'audio/ogg', kind: 'audio', ext: 'ogg' };
  if (ascii.slice(4, 8) === 'ftyp') return { mime: 'audio/mp4', kind: 'audio', ext: 'm4a' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio', ext: 'wav' };
  if (ascii.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', kind: 'audio', ext: 'mp3' };
  return null;
}
const cleanName = (name, ext) => {
  const base = String(name || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!base) return `piece-jointe.${ext}`;
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
};
const text = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const idemKey = (v) => (/^[A-Za-z0-9_-]{8,80}$/.test(String(v || '')) ? String(v) : null);

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS support_ticket_ref_seq START 1001;
CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference TEXT NOT NULL UNIQUE,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_by_label TEXT,
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND ${MAX_SUBJECT}),
  category TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'in_progress', 'waiting_customer', 'resolved')),
  assigned_to TEXT,
  create_idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (company_id, created_by_user_id, create_idempotency_key)
);
CREATE INDEX IF NOT EXISTS support_tickets_company_idx ON support_tickets (company_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, last_activity_at DESC);
CREATE TABLE IF NOT EXISTS support_messages (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('customer', 'support')),
  author_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  author_label TEXT,
  body TEXT NOT NULL DEFAULT '',
  internal BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticket_id, idempotency_key),
  CHECK (NOT internal OR author_kind = 'support')
);
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages (ticket_id, id);
CREATE TABLE IF NOT EXISTS support_attachments (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  uploaded_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_support BOOLEAN NOT NULL DEFAULT FALSE,
  ticket_id BIGINT REFERENCES support_tickets(id) ON DELETE CASCADE,
  message_id BIGINT REFERENCES support_messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file', 'audio')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= ${MAX_FILE_BYTES}),
  sha256 TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS support_attachments_message_idx ON support_attachments (message_id);
CREATE INDEX IF NOT EXISTS support_attachments_staged_idx ON support_attachments (created_at) WHERE message_id IS NULL;
CREATE TABLE IF NOT EXISTS support_events (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'status_changed', 'reopened', 'assigned')),
  from_status TEXT,
  to_status TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('customer', 'support', 'system')),
  actor_label TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS support_events_ticket_idx ON support_events (ticket_id, id);
-- Dernier message lu, par participant : 'u<id>' côté entreprise, 'support' côté TRAXO.
CREATE TABLE IF NOT EXISTS support_reads (
  ticket_id BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  reader TEXT NOT NULL,
  last_read_message_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, reader)
);
`;

function createSupport({ pool, notify = async () => {} }) {
  const ensureSchema = () => pool.query(SCHEMA);
  const reader = (auth) => `u${auth.user_id}`;
  const canSeeAll = (auth) => auth.role === 'owner';

  // ---- Lecture côté entreprise -------------------------------------------
  function visibleSql(auth, values, alias = 't') {
    values.push(auth.company_id);
    let sql = `${alias}.company_id = $${values.length}`;
    if (!canSeeAll(auth)) { values.push(auth.user_id); sql += ` AND ${alias}.created_by_user_id = $${values.length}`; }
    return sql;
  }

  async function loadTicketFor(auth, id, client = pool) {
    if (!/^\d{1,18}$/.test(String(id))) throw new SupportError(404, 'Cette demande est introuvable.');
    const values = [id];
    const row = (await client.query(`SELECT * FROM support_tickets t WHERE t.id = $1 AND ${visibleSql(auth, values)}`, values)).rows[0];
    if (!row) throw new SupportError(404, 'Cette demande est introuvable.');
    return row;
  }

  const ticketOut = (t, extra = {}) => ({
    id: String(t.id), reference: t.reference, subject: t.subject, category: t.category,
    categoryLabel: CATEGORIES[t.category] || CATEGORIES.other,
    status: t.status, statusLabel: STATUS_LABELS[t.status],
    createdAt: t.created_at, lastActivityAt: t.last_activity_at, resolvedAt: t.resolved_at,
    createdBy: t.created_by_label || null,
    ...extra,
  });

  async function listTickets(auth, { tab = 'open', before = null } = {}) {
    const values = [];
    const vis = visibleSql(auth, values);
    values.push(reader(auth));
    const rd = `$${values.length}`;
    const filter = tab === 'resolved' ? `AND t.status = 'resolved'` : tab === 'all' ? '' : `AND t.status <> 'resolved'`;
    let cursor = '';
    if (before && !Number.isNaN(Date.parse(before))) { values.push(new Date(before).toISOString()); cursor = `AND t.last_activity_at < $${values.length}`; }
    const rows = (await pool.query(
      `SELECT t.*, lm.body AS last_body, lm.author_kind AS last_author, lm.has_file AS last_has_file,
              EXISTS (SELECT 1 FROM support_messages m WHERE m.ticket_id = t.id AND m.author_kind = 'support' AND NOT m.internal
                      AND m.id > COALESCE((SELECT r.last_read_message_id FROM support_reads r WHERE r.ticket_id = t.id AND r.reader = ${rd}), 0)) AS unread
       FROM support_tickets t
       LEFT JOIN LATERAL (
         SELECT m.body, m.author_kind, EXISTS (SELECT 1 FROM support_attachments a WHERE a.message_id = m.id) AS has_file
         FROM support_messages m WHERE m.ticket_id = t.id AND NOT m.internal ORDER BY m.id DESC LIMIT 1
       ) lm ON TRUE
       WHERE ${vis} ${filter} ${cursor}
       ORDER BY t.last_activity_at DESC, t.id DESC LIMIT ${PAGE + 1}`, values)).rows;
    const cvals = [];
    const cvis = visibleSql(auth, cvals);
    const counts = (await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status <> 'resolved')::int AS open, COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved, COUNT(*)::int AS all
       FROM support_tickets t WHERE ${cvis}`, cvals)).rows[0];
    const page = rows.slice(0, PAGE);
    return {
      tickets: page.map((t) => ticketOut(t, {
        unread: t.unread,
        preview: t.last_body ? t.last_body.slice(0, 140) : t.last_has_file ? 'Pièce jointe' : '',
        lastFromSupport: t.last_author === 'support',
      })),
      counts,
      nextBefore: rows.length > PAGE ? page[page.length - 1].last_activity_at : null,
    };
  }

  async function messagesOf(ticketId, { includeInternal = false, afterId = 0 } = {}) {
    const msgs = (await pool.query(
      `SELECT id, author_kind, author_label, body, internal, created_at FROM support_messages
       WHERE ticket_id = $1 AND ($2 OR NOT internal) AND id > $3 ORDER BY id ASC LIMIT 300`,
      [ticketId, includeInternal, afterId])).rows;
    const files = msgs.length ? (await pool.query(
      `SELECT public_id, message_id, file_name, mime, kind, size_bytes FROM support_attachments WHERE message_id = ANY($1::bigint[]) ORDER BY id`,
      [msgs.map((m) => m.id)])).rows : [];
    return msgs.map((m) => ({
      id: String(m.id), author: m.author_kind, authorLabel: m.author_kind === 'support' ? (m.author_label || 'Équipe TRAXO') : (m.author_label || 'Vous'),
      body: m.body, createdAt: m.created_at, ...(includeInternal ? { internal: m.internal } : {}),
      attachments: files.filter((f) => String(f.message_id) === String(m.id)).map((f) => ({ id: f.public_id, name: f.file_name, mime: f.mime, kind: f.kind, size: f.size_bytes })),
    }));
  }
  async function eventsOf(ticketId) {
    return (await pool.query(`SELECT kind, from_status, to_status, actor_kind, created_at FROM support_events WHERE ticket_id = $1 ORDER BY id`, [ticketId])).rows
      .map((e) => ({ kind: e.kind, from: e.from_status, to: e.to_status, toLabel: STATUS_LABELS[e.to_status] || null, by: e.actor_kind, at: e.created_at }));
  }

  async function getTicket(auth, id) {
    const t = await loadTicketFor(auth, id);
    const [messages, events, read] = await Promise.all([
      messagesOf(t.id), eventsOf(t.id),
      pool.query('SELECT last_read_message_id FROM support_reads WHERE ticket_id = $1 AND reader = $2', [t.id, reader(auth)]),
    ]);
    return { ticket: ticketOut(t), messages, events, lastReadMessageId: String(read.rows[0]?.last_read_message_id || 0) };
  }

  async function markRead(ticketId, who, messageId) {
    await pool.query(
      `INSERT INTO support_reads (ticket_id, reader, last_read_message_id, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (ticket_id, reader) DO UPDATE SET last_read_message_id = GREATEST(support_reads.last_read_message_id, EXCLUDED.last_read_message_id), updated_at = NOW()`,
      [ticketId, who, messageId]);
  }
  async function readTicket(auth, id, messageId) {
    const t = await loadTicketFor(auth, id);
    const max = (await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM support_messages WHERE ticket_id = $1 AND NOT internal`, [t.id])).rows[0].m;
    const upTo = /^\d{1,18}$/.test(String(messageId || '')) ? Math.min(Number(messageId), Number(max)) : Number(max);
    await markRead(t.id, reader(auth), upTo);
    return { ok: true };
  }

  async function unreadFor(auth) {
    const values = [];
    const vis = visibleSql(auth, values);
    values.push(reader(auth));
    return (await pool.query(
      `SELECT t.id, t.reference, t.subject, t.status, m.id AS message_id, m.created_at
       FROM support_tickets t
       JOIN LATERAL (SELECT id, created_at FROM support_messages m WHERE m.ticket_id = t.id AND m.author_kind = 'support' AND NOT m.internal ORDER BY id DESC LIMIT 1) m ON TRUE
       WHERE ${vis} AND m.id > COALESCE((SELECT r.last_read_message_id FROM support_reads r WHERE r.ticket_id = t.id AND r.reader = $${values.length}), 0)
       ORDER BY m.id DESC LIMIT 50`, values)).rows;
  }

  // ---- Pièces jointes ------------------------------------------------------
  async function stageUpload(auth, buf, name, { support = false } = {}) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw new SupportError(400, 'Le fichier est vide.');
    if (buf.length > MAX_FILE_BYTES) throw new SupportError(413, 'Ce fichier dépasse 10 Mo.');
    const type = sniff(buf);
    if (!type) throw new SupportError(415, 'Format non accepté. Envoyez une image (JPG, PNG, WebP), un PDF ou un fichier audio.');
    const recent = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM support_attachments WHERE uploaded_by_user_id = $1 AND message_id IS NULL AND created_at > NOW() - INTERVAL '1 hour'`, [auth.user_id])).rows[0].n;
    if (recent >= 40) throw new SupportError(429, 'Trop de fichiers envoyés en peu de temps. Réessayez dans quelques minutes.');
    // Ménage : les fichiers jamais envoyés disparaissent après 24 h.
    pool.query(`DELETE FROM support_attachments WHERE message_id IS NULL AND created_at < NOW() - make_interval(hours => $1)`, [STAGED_TTL_HOURS]).catch(() => {});
    const publicId = crypto.randomBytes(16).toString('hex');
    const fileName = cleanName(name, type.ext);
    await pool.query(
      `INSERT INTO support_attachments (public_id, company_id, uploaded_by_user_id, uploaded_by_support, file_name, mime, kind, size_bytes, sha256, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [publicId, auth.company_id, auth.user_id, support, fileName, type.mime, type.kind, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), buf]);
    return { id: publicId, name: fileName, mime: type.mime, kind: type.kind, size: buf.length };
  }

  async function discardUpload(auth, publicId) {
    await pool.query(`DELETE FROM support_attachments WHERE public_id = $1 AND uploaded_by_user_id = $2 AND message_id IS NULL`, [String(publicId || ''), auth.user_id]);
    return { ok: true };
  }

  // Un fichier : en brouillon (son auteur seulement), ou rattaché à une demande visible.
  async function fileFor(auth, publicId, { support = false } = {}) {
    if (!/^[0-9a-f]{32}$/.test(String(publicId || ''))) throw new SupportError(404, 'Fichier introuvable.');
    const f = (await pool.query(`SELECT * FROM support_attachments WHERE public_id = $1`, [publicId])).rows[0];
    if (!f) throw new SupportError(404, 'Fichier introuvable.');
    if (support) return f;
    if (!f.message_id) {
      if (String(f.uploaded_by_user_id) !== String(auth.user_id) || String(f.company_id) !== String(auth.company_id)) throw new SupportError(404, 'Fichier introuvable.');
      return f;
    }
    const m = (await pool.query('SELECT internal FROM support_messages WHERE id = $1', [f.message_id])).rows[0];
    if (!m || m.internal) throw new SupportError(404, 'Fichier introuvable.');
    await loadTicketFor(auth, f.ticket_id);
    return f;
  }

  async function claimUpload(client, auth, uploadId, ticketId, messageId, { support = false } = {}) {
    if (!uploadId) return null;
    const r = await client.query(
      `UPDATE support_attachments SET ticket_id = $1, message_id = $2
       WHERE public_id = $3 AND message_id IS NULL AND uploaded_by_user_id = $4 AND (${support ? 'TRUE' : 'company_id = $5'})
       RETURNING public_id`,
      support ? [ticketId, messageId, String(uploadId), auth.user_id] : [ticketId, messageId, String(uploadId), auth.user_id, auth.company_id]);
    if (!r.rowCount) throw new SupportError(409, 'La pièce jointe a expiré. Joignez-la de nouveau.', 'UPLOAD_GONE');
    return r.rows[0].public_id;
  }

  // ---- Écriture côté entreprise -------------------------------------------
  async function withTx(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }

  async function createTicket(auth, body) {
    const subject = text(body.subject, MAX_SUBJECT);
    const message = text(body.message, MAX_BODY);
    const category = CATEGORIES[body.category] ? body.category : 'other';
    const key = idemKey(body.idempotencyKey);
    if (!key) throw new SupportError(400, 'Requête invalide. Rechargez la page.');
    if (!subject) throw new SupportError(400, 'Donnez un sujet à votre demande.', 'SUBJECT');
    if (!message && !body.uploadId) throw new SupportError(400, 'Décrivez le problème, ou joignez un fichier ou une note vocale.', 'MESSAGE');
    // Même clé = même demande : une coupure ou un double clic ne crée jamais deux demandes.
    const existing = (await pool.query(`SELECT * FROM support_tickets WHERE company_id = $1 AND created_by_user_id = $2 AND create_idempotency_key = $3`, [auth.company_id, auth.user_id, key])).rows[0];
    if (existing) return { ticket: ticketOut(existing), replayed: true };
    const recent = (await pool.query(`SELECT COUNT(*)::int AS n FROM support_tickets WHERE created_by_user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [auth.user_id])).rows[0].n;
    if (recent >= 10) throw new SupportError(429, 'Vous avez déjà ouvert plusieurs demandes. Patientez avant d’en créer une autre.');
    const label = auth.display_name || auth.email || null;
    let created;
    try {
      created = await withTx(async (client) => {
        const ref = (await client.query(`SELECT nextval('support_ticket_ref_seq') AS n`)).rows[0].n;
        const t = (await client.query(
          `INSERT INTO support_tickets (company_id, reference, created_by_user_id, created_by_label, subject, category, create_idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [auth.company_id, `TRX-${ref}`, auth.user_id, label, subject, category, key])).rows[0];
        const m = (await client.query(
          `INSERT INTO support_messages (ticket_id, company_id, author_kind, author_user_id, author_label, body, idempotency_key)
           VALUES ($1, $2, 'customer', $3, $4, $5, $6) RETURNING id`, [t.id, auth.company_id, auth.user_id, label, message, `create-${key}`])).rows[0];
        await claimUpload(client, auth, body.uploadId, t.id, m.id);
        await client.query(`INSERT INTO support_events (ticket_id, kind, to_status, actor_kind, actor_label) VALUES ($1, 'created', 'received', 'customer', $2)`, [t.id, label]);
        return t;
      });
    } catch (error) {
      if (error.code === '23505') { // course entre deux envois identiques
        const again = (await pool.query(`SELECT * FROM support_tickets WHERE company_id = $1 AND created_by_user_id = $2 AND create_idempotency_key = $3`, [auth.company_id, auth.user_id, key])).rows[0];
        if (again) return { ticket: ticketOut(again), replayed: true };
      }
      throw error;
    }
    await markRead(created.id, reader(auth), (await pool.query('SELECT MAX(id) AS m FROM support_messages WHERE ticket_id = $1', [created.id])).rows[0].m);
    notify('ticket_created', { ticket: created, message, auth }).catch(() => {});
    return { ticket: ticketOut(created), replayed: false };
  }

  async function postCustomerMessage(auth, id, body) {
    const t = await loadTicketFor(auth, id);
    const message = text(body.message, MAX_BODY);
    const key = idemKey(body.idempotencyKey);
    if (!key) throw new SupportError(400, 'Requête invalide. Rechargez la page.');
    if (!message && !body.uploadId) throw new SupportError(400, 'Écrivez un message ou joignez un fichier.');
    const replay = (await pool.query('SELECT id FROM support_messages WHERE ticket_id = $1 AND idempotency_key = $2', [t.id, key])).rows[0];
    if (replay) return { messageId: String(replay.id), replayed: true, ticket: ticketOut(t) };
    if (t.status === 'resolved') throw new SupportError(409, 'Cette demande est résolue. Rouvrez-la pour continuer l’échange.', 'RESOLVED');
    const label = auth.display_name || auth.email || null;
    let out;
    try {
      out = await withTx(async (client) => {
        const m = (await client.query(
          `INSERT INTO support_messages (ticket_id, company_id, author_kind, author_user_id, author_label, body, idempotency_key)
           VALUES ($1, $2, 'customer', $3, $4, $5, $6) RETURNING id`, [t.id, auth.company_id, auth.user_id, label, message, key])).rows[0];
        await claimUpload(client, auth, body.uploadId, t.id, m.id);
        // La réponse attendue est arrivée : la demande repasse « En cours ».
        let status = t.status;
        if (t.status === 'waiting_customer') {
          status = 'in_progress';
          await client.query(`INSERT INTO support_events (ticket_id, kind, from_status, to_status, actor_kind, actor_label) VALUES ($1, 'status_changed', 'waiting_customer', 'in_progress', 'customer', $2)`, [t.id, label]);
        }
        const nt = (await client.query(`UPDATE support_tickets SET status = $2, last_activity_at = NOW() WHERE id = $1 RETURNING *`, [t.id, status])).rows[0];
        return { m, nt };
      });
    } catch (error) {
      if (error.code === '23505') {
        const again = (await pool.query('SELECT id FROM support_messages WHERE ticket_id = $1 AND idempotency_key = $2', [t.id, key])).rows[0];
        if (again) return { messageId: String(again.id), replayed: true, ticket: ticketOut(t) };
      }
      throw error;
    }
    await markRead(t.id, reader(auth), out.m.id);
    notify('customer_message', { ticket: out.nt, message, auth }).catch(() => {});
    return { messageId: String(out.m.id), replayed: false, ticket: ticketOut(out.nt) };
  }

  async function reopen(auth, id) {
    const t = await loadTicketFor(auth, id);
    if (t.status !== 'resolved') return { ticket: ticketOut(t), changed: false };
    const label = auth.display_name || auth.email || null;
    const nt = await withTx(async (client) => {
      const row = (await client.query(`UPDATE support_tickets SET status = 'in_progress', resolved_at = NULL, last_activity_at = NOW() WHERE id = $1 AND status = 'resolved' RETURNING *`, [t.id])).rows[0];
      if (row) await client.query(`INSERT INTO support_events (ticket_id, kind, from_status, to_status, actor_kind, actor_label) VALUES ($1, 'reopened', 'resolved', 'in_progress', 'customer', $2)`, [t.id, label]);
      return row || t;
    });
    notify('ticket_reopened', { ticket: nt, auth }).catch(() => {});
    return { ticket: ticketOut(nt), changed: true };
  }

  // ---- Côté support TRAXO (administrateur plateforme) ----------------------
  async function adminList({ status = 'open', q = '' } = {}) {
    const values = [];
    let where = 'TRUE';
    if (status === 'open') where = `t.status <> 'resolved'`;
    else if (STATUSES.includes(status)) { values.push(status); where = `t.status = $${values.length}`; }
    const query = text(q, 80);
    if (query) { values.push(`%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where += ` AND (t.reference ILIKE $${values.length} OR t.subject ILIKE $${values.length} OR c.name ILIKE $${values.length})`; }
    const rows = (await pool.query(
      `SELECT t.*, c.name AS company_name,
              EXISTS (SELECT 1 FROM support_messages m WHERE m.ticket_id = t.id AND m.author_kind = 'customer'
                      AND m.id > COALESCE((SELECT r.last_read_message_id FROM support_reads r WHERE r.ticket_id = t.id AND r.reader = 'support'), 0)) AS unread
       FROM support_tickets t JOIN companies c ON c.id = t.company_id
       WHERE ${where} ORDER BY t.last_activity_at DESC, t.id DESC LIMIT 200`, values)).rows;
    const counts = (await pool.query(`SELECT status, COUNT(*)::int AS n FROM support_tickets GROUP BY status`)).rows
      .reduce((m, r) => { m[r.status] = r.n; return m; }, {});
    return { tickets: rows.map((t) => ticketOut(t, { companyName: t.company_name, companyId: String(t.company_id), unread: t.unread, assignedTo: t.assigned_to })), counts };
  }
  async function adminTicket(id) {
    if (!/^\d{1,18}$/.test(String(id))) throw new SupportError(404, 'Demande introuvable.');
    const t = (await pool.query(`SELECT t.*, c.name AS company_name FROM support_tickets t JOIN companies c ON c.id = t.company_id WHERE t.id = $1`, [id])).rows[0];
    if (!t) throw new SupportError(404, 'Demande introuvable.');
    const [messages, events] = await Promise.all([messagesOf(t.id, { includeInternal: true }), eventsOf(t.id)]);
    const max = messages.length ? messages[messages.length - 1].id : 0;
    await markRead(t.id, 'support', max);
    return { ticket: ticketOut(t, { companyName: t.company_name, companyId: String(t.company_id), assignedTo: t.assigned_to }), messages, events };
  }
  async function adminReply(auth, id, body) {
    const t = (await pool.query('SELECT * FROM support_tickets WHERE id = $1', [id])).rows[0];
    if (!t) throw new SupportError(404, 'Demande introuvable.');
    const message = text(body.message, MAX_BODY);
    const internal = body.internal === true;
    const key = idemKey(body.idempotencyKey);
    if (!key) throw new SupportError(400, 'Requête invalide.');
    if (!message && !body.uploadId) throw new SupportError(400, 'Écrivez une réponse.');
    const replay = (await pool.query('SELECT id FROM support_messages WHERE ticket_id = $1 AND idempotency_key = $2', [t.id, key])).rows[0];
    if (replay) return { messageId: String(replay.id), replayed: true };
    const label = text(body.signature, 60) || 'Équipe TRAXO';
    const nextStatus = STATUSES.includes(body.status) ? body.status : null;
    const out = await withTx(async (client) => {
      const m = (await client.query(
        `INSERT INTO support_messages (ticket_id, company_id, author_kind, author_user_id, author_label, body, internal, idempotency_key)
         VALUES ($1, $2, 'support', $3, $4, $5, $6, $7) RETURNING id`, [t.id, t.company_id, auth.user_id, label, message, internal, key])).rows[0];
      await claimUpload(client, auth, body.uploadId, t.id, m.id, { support: true });
      let status = t.status;
      // Une réponse ne signifie pas « réponse attendue » : le statut est choisi explicitement.
      if (!internal && nextStatus && nextStatus !== t.status) status = nextStatus;
      else if (!internal && t.status === 'received') status = 'in_progress';
      if (status !== t.status) {
        await client.query(`INSERT INTO support_events (ticket_id, kind, from_status, to_status, actor_kind, actor_label) VALUES ($1, 'status_changed', $2, $3, 'support', $4)`, [t.id, t.status, status, label]);
      }
      const nt = (await client.query(
        `UPDATE support_tickets SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE NULL END,
           last_activity_at = CASE WHEN $3 THEN last_activity_at ELSE NOW() END WHERE id = $1 RETURNING *`, [t.id, status, internal])).rows[0];
      return { m, nt };
    });
    await markRead(t.id, 'support', out.m.id);
    if (!internal) notify('support_reply', { ticket: out.nt, message }).catch(() => {});
    return { messageId: String(out.m.id), replayed: false, ticket: ticketOut(out.nt) };
  }
  async function adminSetStatus(auth, id, status, label = 'Équipe TRAXO') {
    if (!STATUSES.includes(status)) throw new SupportError(400, 'Statut inconnu.');
    const t = (await pool.query('SELECT * FROM support_tickets WHERE id = $1', [id])).rows[0];
    if (!t) throw new SupportError(404, 'Demande introuvable.');
    if (t.status === status) return { ticket: ticketOut(t), changed: false };
    const nt = await withTx(async (client) => {
      const row = (await client.query(
        `UPDATE support_tickets SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE NULL END, last_activity_at = NOW() WHERE id = $1 RETURNING *`, [t.id, status])).rows[0];
      await client.query(`INSERT INTO support_events (ticket_id, kind, from_status, to_status, actor_kind, actor_label) VALUES ($1, 'status_changed', $2, $3, 'support', $4)`, [t.id, t.status, status, label]);
      return row;
    });
    if (status === 'resolved' || status === 'waiting_customer') notify('status_changed', { ticket: nt }).catch(() => {});
    return { ticket: ticketOut(nt), changed: true };
  }
  async function adminAssign(id, assignee) {
    const value = text(assignee, 80) || null;
    const t = (await pool.query('UPDATE support_tickets SET assigned_to = $2 WHERE id = $1 RETURNING *', [id, value])).rows[0];
    if (!t) throw new SupportError(404, 'Demande introuvable.');
    await pool.query(`INSERT INTO support_events (ticket_id, kind, actor_kind, detail) VALUES ($1, 'assigned', 'support', $2)`, [t.id, value]);
    return { ticket: ticketOut(t, { assignedTo: t.assigned_to }) };
  }

  return {
    ensureSchema, listTickets, getTicket, readTicket, unreadFor, createTicket, postCustomerMessage, reopen,
    stageUpload, discardUpload, fileFor, adminList, adminTicket, adminReply, adminSetStatus, adminAssign,
  };
}

module.exports = { createSupport, SupportError, sniff, STATUS_LABELS, CATEGORIES, MAX_FILE_BYTES };
