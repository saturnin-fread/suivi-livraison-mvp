'use strict';

// Recherche globale (Ctrl/⌘ K) : clients, commandes, demandes, tournées,
// incidents et livreurs d'une seule entreprise.
//
// Ce n'est pas une recherche sémantique. Deux modes, choisis d'après la saisie :
//  - numéro : la saisie ne contient que des chiffres et des séparateurs
//    (« 97 42 18 », « +229 01 97 42 18 60 », « 4218 »). On compare les chiffres
//    seuls, quel que soit le format enregistré ; un numéro international retrouve
//    aussi un numéro enregistré sans indicatif, et inversement.
//  - texte : chaque mot doit apparaître quelque part dans la fiche (nom, code,
//    contacts, lieux, notes…), sans tenir compte des accents ni de la casse.
// Les codes CMD-…, DEM-…, TRN-…, INC-… ciblent directement l'enregistrement.

const MAX_QUERY = 80;
const MAX_TOKENS = 6;
const PER_GROUP = 5;
const PER_GROUP_SINGLE = 25;

const fold = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'").toLowerCase();
const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const likeEscape = (v) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

function parseQuery(raw) {
  const q = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  const folded = fold(q);
  const digits = digitsOf(q);
  const phone = digits.length >= 3 && /^[\d\s+().\-/]+$/.test(q);
  const code = folded.match(/^(cmd|dem|trn|inc)[\s-]*(\d{1,12})$/);
  const tokens = [...new Set(folded.split(' ').filter(Boolean))].slice(0, MAX_TOKENS);
  return {
    q, folded, digits, phone, tokens,
    code: code ? { kind: code[1], id: code[2] } : null,
    number: /^\d{1,12}$/.test(q) ? q : null,
    tooShort: q.length < 2,
  };
}

// Correspondance de numéros, côté SQL. $d = chiffres saisis.
//  1. fragment : les chiffres saisis figurent dans le numéro enregistré ;
//  2. saisie avec indicatif : le numéro enregistré (8 chiffres et plus) termine la saisie ;
//  3. même abonné : les 8 derniers chiffres coïncident (ancien/nouveau format béninois).
function phoneSql(column, param) {
  const cd = `regexp_replace(COALESCE(${column}, ''), '\\D', '', 'g')`;
  return `(${cd} <> '' AND (${cd} LIKE '%' || ${param} || '%'
    OR (length(${cd}) >= 8 AND ${param} LIKE '%' || ${cd})
    OR (length(${param}) >= 8 AND length(${cd}) >= 8 AND right(${cd}, 8) = right(${param}, 8))))`;
}

function phoneMatches(stored, digits) {
  const cd = digitsOf(stored);
  if (!cd || !digits) return false;
  return cd.includes(digits) || (cd.length >= 8 && digits.endsWith(cd)) || (digits.length >= 8 && cd.length >= 8 && cd.slice(-8) === digits.slice(-8));
}
const phoneExact = (stored, digits) => {
  const cd = digitsOf(stored);
  return Boolean(cd && digits) && (cd === digits || (cd.length >= 8 && digits.length >= 8 && cd.slice(-8) === digits.slice(-8)));
};

// Construit « tous les mots dans ce texte » : AND traxo_fold(doc) LIKE $n …
function tokenSql(doc, tokens, values) {
  return tokens.map((t) => { values.push(`%${likeEscape(t)}%`); return `${doc} LIKE $${values.length}`; }).join(' AND ') || 'FALSE';
}
const hasAll = (text, tokens) => { const f = fold(text); return tokens.every((t) => f.includes(t)); };
const hasAny = (text, tokens) => { const f = fold(text); return tokens.some((t) => f.includes(t)); };

const SQL_FOLD = `CREATE OR REPLACE FUNCTION traxo_fold(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$
  SELECT translate(lower(COALESCE($1, '')),
    'àáâãäåāçćčèéêëēěìíîïīñńòóôõöøōùúûüūýÿ’',
    'aaaaaaaccceeeeeeiiiiinnooooooouuuuuyy''')
$f$`;

function createGlobalSearch({ pool, withCompanyTransaction }) {
  async function ensureSchema() { await pool.query(SQL_FOLD); }

  // ---- Clients (tables CRM sous RLS : transaction d'entreprise) ----------
  async function searchClients(companyId, p, limit) {
    return withCompanyTransaction(pool, companyId, async (client) => {
      const values = [companyId];
      let where;
      if (p.phone) {
        values.push(p.digits);
        where = `EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.company_id = c.company_id AND cc.customer_id = c.id
                   AND cc.is_active = TRUE AND cc.kind IN ('phone', 'whatsapp', 'other') AND ${phoneSql('cc.value_display', `$${values.length}`)})`;
      } else {
        const doc = `traxo_fold(concat_ws(' ', c.display_name, c.customer_code, c.service_notes, c.main_city,
          (SELECT string_agg(concat_ws(' ', cc.value_display, cc.contact_name, cc.label), ' ') FROM customer_contacts cc
             WHERE cc.company_id = c.company_id AND cc.customer_id = c.id AND cc.is_active = TRUE),
          (SELECT string_agg(concat_ws(' ', l.label, l.neighborhood, l.locality, l.address_text, l.landmark, l.delivery_instructions), ' ')
             FROM customer_locations l WHERE l.company_id = c.company_id AND l.customer_id = c.id AND l.is_active = TRUE)))`;
        where = tokenSql(doc, p.tokens, values);
      }
      const rows = (await client.query(
        `SELECT c.id, c.display_name, c.customer_code, c.status, c.service_notes, c.main_city
         FROM customers c
         WHERE c.company_id = $1 AND c.removed_at IS NULL AND c.status NOT IN ('merged', 'anonymized') AND (${where})
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ${limit + 1}`, values)).rows;
      if (!rows.length) return { rows: [], more: false };
      const ids = rows.map((r) => r.id);
      const [contacts, places] = await Promise.all([
        client.query(`SELECT customer_id, kind, value_display, contact_name, label, is_primary FROM customer_contacts
                      WHERE company_id = $1 AND customer_id = ANY($2::bigint[]) AND is_active = TRUE ORDER BY is_primary DESC, id`, [companyId, ids]),
        client.query(`SELECT customer_id, label, neighborhood, locality, address_text, landmark, delivery_instructions FROM customer_locations
                      WHERE company_id = $1 AND customer_id = ANY($2::bigint[]) AND is_active = TRUE ORDER BY id`, [companyId, ids]),
      ]);
      const by = (list) => list.rows.reduce((m, r) => { (m[r.customer_id] = m[r.customer_id] || []).push(r); return m; }, {});
      const cMap = by(contacts); const pMap = by(places);
      const items = rows.slice(0, limit).map((c) => {
        const cs = cMap[c.id] || []; const ps = pMap[c.id] || [];
        const phones = cs.filter((x) => x.kind !== 'email');
        const primary = phones[0]?.value_display || cs[0]?.value_display || '';
        let where = 'overview'; let detail = ''; let score = 10;
        if (p.phone) {
          const hit = phones.find((x) => phoneMatches(x.value_display, p.digits));
          // Numéro principal : la fiche suffit. Numéro d'un contact secondaire : onglet Contacts.
          if (hit && hit !== phones[0]) { where = 'contacts'; detail = hit.contact_name ? `${hit.contact_name} · ${hit.value_display}` : hit.value_display; }
          score = hit && phoneExact(hit.value_display, p.digits) ? 100 : 60;
        } else if (hasAll(`${c.display_name} ${c.customer_code}`, p.tokens)) {
          score = fold(c.display_name).startsWith(p.tokens[0]) || fold(c.customer_code) === p.folded ? 80 : 50;
        } else {
          const contact = cs.find((x) => hasAny(`${x.value_display} ${x.contact_name || ''} ${x.label || ''}`, p.tokens));
          const place = ps.find((x) => hasAny(`${x.label} ${x.neighborhood || ''} ${x.locality || ''} ${x.address_text || ''} ${x.landmark || ''} ${x.delivery_instructions || ''}`, p.tokens));
          if (place) { where = 'places'; detail = [place.label, place.neighborhood || place.locality].filter(Boolean).join(' · '); score = 40; }
          else if (contact) { where = 'contacts'; detail = contact.contact_name ? `${contact.contact_name} · ${contact.value_display}` : contact.value_display; score = 40; }
          else if (hasAny(c.service_notes, p.tokens)) { where = 'notes'; detail = 'Consignes de service'; score = 25; }
        }
        const section = { overview: null, contacts: 'Contacts', places: 'Lieux', notes: 'Consignes' }[where];
        return {
          type: 'client', id: String(c.id), score,
          title: c.display_name,
          subtitle: [primary, c.customer_code].filter(Boolean).join(' · '),
          detail,
          path: ['Clients', c.display_name, ...(section ? [section] : [])],
          href: `/app/clients/${c.id}${where === 'contacts' || where === 'places' ? `?onglet=${where}` : ''}`,
          archived: c.status === 'archived',
        };
      });
      return { rows: items, more: rows.length > limit };
    });
  }

  // ---- Tables opérationnelles (filtrées par company_id) ---------------------
  async function run(sql, values) { return (await pool.query(sql, values)).rows; }

  async function searchOrders(companyId, p, limit) {
    const values = [companyId];
    const conds = [];
    if (p.code?.kind === 'cmd') { values.push(p.code.id); conds.push(`o.id = $${values.length}::bigint`); }
    if (p.number) { values.push(p.number); conds.push(`o.id = $${values.length}::bigint`); }
    if (p.phone) {
      values.push(p.digits); const d = `$${values.length}`;
      conds.push(phoneSql('o.customer_phone', d), phoneSql('o.pickup_phone', d));
      values.push(`%${p.digits}%`); conds.push(`regexp_replace(COALESCE(o.reference, ''), '\\D', '', 'g') LIKE $${values.length}`);
    } else if (!p.code) {
      conds.push(`(${tokenSql(`traxo_fold(concat_ws(' ', o.reference, 'cmd-' || o.id, o.customer_name, o.customer_phone, o.delivery_address, o.neighborhood,
        o.landmark, o.package_description, o.notes, o.pickup_name, o.pickup_phone, o.pickup_address, d.name, o.status))`, p.tokens, values)})`);
    }
    if (!conds.length) return { rows: [], more: false };
    const rows = await run(
      `SELECT o.id, o.reference, o.customer_name, o.customer_phone, o.pickup_phone, o.neighborhood, o.landmark, o.delivery_address,
              o.status, o.priority, o.archived_at, o.created_at, d.name AS driver_name
       FROM orders o LEFT JOIN drivers d ON d.id = o.driver_id AND d.company_id = o.company_id
       WHERE o.company_id = $1 AND (${conds.join(' OR ')})
       ORDER BY (o.archived_at IS NULL) DESC, o.created_at DESC, o.id DESC LIMIT ${limit + 1}`, values);
    const items = rows.slice(0, limit).map((o) => {
      const code = o.reference || `CMD-${o.id}`;
      let score = 30;
      if ((p.code?.kind === 'cmd' && String(o.id) === p.code.id) || (p.number && String(o.id) === p.number) || fold(code) === p.folded) score = 95;
      else if (p.phone) score = phoneExact(o.customer_phone, p.digits) || phoneExact(o.pickup_phone, p.digits) ? 90 : 55;
      const pickupHit = p.phone && !phoneMatches(o.customer_phone, p.digits) && phoneMatches(o.pickup_phone, p.digits);
      return {
        type: 'order', id: String(o.id), score: o.archived_at ? score - 20 : score,
        title: `${code} · ${o.customer_name || 'Client'}`,
        subtitle: [o.status, o.neighborhood || o.landmark, o.driver_name].filter(Boolean).join(' · '),
        detail: pickupHit ? `Collecte · ${o.pickup_phone}` : (p.phone ? o.customer_phone : ''),
        path: ['Opérations', 'Commandes', code],
        href: `/app/operations?vue=commandes&commande=${o.id}`,
        urgent: o.priority === 'urgent', archived: Boolean(o.archived_at),
      };
    });
    return { rows: items, more: rows.length > limit };
  }

  async function searchRequests(companyId, p, limit) {
    const values = [companyId];
    const conds = [];
    if (p.code?.kind === 'dem') { values.push(p.code.id); conds.push(`r.id = $${values.length}::bigint`); }
    if (p.number) { values.push(p.number); conds.push(`r.id = $${values.length}::bigint`); }
    if (p.phone) { values.push(p.digits); conds.push(phoneSql('r.customer_phone', `$${values.length}`)); }
    else if (!p.code) conds.push(`(${tokenSql(`traxo_fold(concat_ws(' ', 'dem-' || r.id, r.customer_name, r.customer_phone, r.neighborhood, r.landmark, r.notes, r.status))`, p.tokens, values)})`);
    if (!conds.length) return { rows: [], more: false };
    const rows = await run(
      `SELECT r.id, r.customer_name, r.customer_phone, r.neighborhood, r.status, r.created_at FROM customer_requests r
       WHERE r.company_id = $1 AND r.archived_at IS NULL AND (${conds.join(' OR ')})
       ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit + 1}`, values);
    return {
      rows: rows.slice(0, limit).map((r) => ({
        type: 'request', id: String(r.id),
        score: (p.code?.kind === 'dem' && String(r.id) === p.code.id) || (p.number && String(r.id) === p.number) ? 92 : p.phone ? (phoneExact(r.customer_phone, p.digits) ? 85 : 50) : 28,
        title: `DEM-${r.id} · ${r.customer_name || 'En attente du client'}`,
        subtitle: [r.status, r.neighborhood].filter(Boolean).join(' · '),
        detail: p.phone ? r.customer_phone : '',
        path: ['Opérations', 'Demandes', `DEM-${r.id}`],
        href: `/app/operations?vue=demandes&demande=${r.id}`,
      })),
      more: rows.length > limit,
    };
  }

  async function searchRuns(companyId, p, limit) {
    if (p.phone && !p.number) return { rows: [], more: false };
    const values = [companyId];
    const conds = [];
    if (p.code?.kind === 'trn') { values.push(p.code.id); conds.push(`r.id = $${values.length}::bigint`); }
    if (p.number) { values.push(p.number); conds.push(`r.id = $${values.length}::bigint`); }
    if (!p.code && !p.number) conds.push(`(${tokenSql(`traxo_fold(concat_ws(' ', r.name, 'trn-' || r.id, d.name))`, p.tokens, values)})`);
    if (!conds.length) return { rows: [], more: false };
    const rows = await run(
      `SELECT r.id, r.name, r.status, r.service_date, d.name AS driver_name FROM delivery_runs r
       LEFT JOIN drivers d ON d.id = r.driver_id AND d.company_id = r.company_id
       WHERE r.company_id = $1 AND (${conds.join(' OR ')})
       ORDER BY r.service_date DESC, r.id DESC LIMIT ${limit + 1}`, values);
    const runLabel = { draft: 'Brouillon', planned: 'Planifiée', active: 'En cours', completed: 'Terminée', cancelled: 'Annulée' };
    return {
      rows: rows.slice(0, limit).map((r) => ({
        type: 'run', id: String(r.id),
        score: (p.code?.kind === 'trn' && String(r.id) === p.code.id) ? 92 : p.number ? 40 : 26,
        title: r.name || `TRN-${r.id}`,
        subtitle: [r.driver_name, runLabel[r.status] || r.status].filter(Boolean).join(' · '),
        detail: '',
        path: ['Opérations', 'Tournées', r.name || `TRN-${r.id}`],
        href: `/app/operations?vue=tournees&tournee=${r.id}`,
      })),
      more: rows.length > limit,
    };
  }

  async function searchIncidents(companyId, p, limit) {
    if (p.phone && !p.number) return { rows: [], more: false };
    const values = [companyId];
    const conds = [];
    if (p.code?.kind === 'inc') { values.push(p.code.id); conds.push(`i.id = $${values.length}::bigint`); }
    if (p.number) { values.push(p.number); conds.push(`i.id = $${values.length}::bigint`); }
    if (!p.code && !p.number) conds.push(`(${tokenSql(`traxo_fold(concat_ws(' ', 'inc-' || i.id, i.description, i.resolution, o.reference, o.customer_name))`, p.tokens, values)})`);
    if (!conds.length) return { rows: [], more: false };
    const rows = await run(
      `SELECT i.id, i.description, i.status, i.category, o.reference AS order_reference, o.id AS order_id, o.customer_name
       FROM delivery_incidents i JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
       WHERE i.company_id = $1 AND i.archived_at IS NULL AND (${conds.join(' OR ')})
       ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit + 1}`, values);
    return {
      rows: rows.slice(0, limit).map((i) => ({
        type: 'incident', id: String(i.id),
        score: (p.code?.kind === 'inc' && String(i.id) === p.code.id) ? 92 : p.number ? 38 : 24,
        title: `INC-${i.id} · ${i.order_reference || `CMD-${i.order_id}`}`,
        subtitle: [i.status === 'resolved' ? 'Résolu' : 'Ouvert', i.customer_name].filter(Boolean).join(' · '),
        detail: String(i.description || '').slice(0, 90),
        path: ['Opérations', 'Incidents', `INC-${i.id}`],
        href: `/app/operations?vue=incidents&incident=${i.id}`,
      })),
      more: rows.length > limit,
    };
  }

  async function searchDrivers(companyId, p, limit) {
    if (p.code) return { rows: [], more: false };
    const values = [companyId];
    let where;
    if (p.phone) { values.push(p.digits); where = phoneSql('d.phone', `$${values.length}`); }
    else where = tokenSql(`traxo_fold(concat_ws(' ', d.name, d.phone, d.email, d.plate, d.vehicle_type))`, p.tokens, values);
    const rows = await run(
      `SELECT d.id, d.name, d.phone, d.vehicle_type, d.plate, d.active FROM drivers d
       WHERE d.company_id = $1 AND d.archived_at IS NULL AND (${where})
       ORDER BY d.active DESC, d.name ASC, d.id ASC LIMIT ${limit + 1}`, values);
    return {
      rows: rows.slice(0, limit).map((d) => ({
        type: 'driver', id: String(d.id),
        score: p.phone ? (phoneExact(d.phone, p.digits) ? 88 : 52) : fold(d.name).startsWith(p.tokens[0] || '') ? 60 : 35,
        title: d.name,
        subtitle: [d.vehicle_type, d.plate, d.active ? null : 'Inactif'].filter(Boolean).join(' · '),
        detail: p.phone ? d.phone : '',
        path: ['Livreurs', d.name],
        href: `/app/livreurs?livreur=${d.id}`,
      })),
      more: rows.length > limit,
    };
  }

  const GROUPS = [
    { key: 'clients', label: 'Clients', fn: searchClients },
    { key: 'orders', label: 'Commandes', fn: searchOrders },
    { key: 'requests', label: 'Demandes', fn: searchRequests, family: 'operations' },
    { key: 'runs', label: 'Tournées', fn: searchRuns, family: 'operations' },
    { key: 'incidents', label: 'Incidents', fn: searchIncidents, family: 'operations' },
    { key: 'drivers', label: 'Livreurs', fn: searchDrivers },
  ];
  const SCOPES = ['all', 'clients', 'orders', 'operations', 'drivers'];

  async function search(companyId, raw, { scope = 'all' } = {}) {
    const p = parseQuery(raw);
    const s = SCOPES.includes(scope) ? scope : 'all';
    if (p.tooShort || (!p.phone && !p.tokens.length)) return { query: p.q, mode: 'idle', groups: [] };
    const groups = GROUPS.filter((g) => s === 'all' || g.key === s || g.family === s);
    const limit = s === 'all' ? PER_GROUP : PER_GROUP_SINGLE;
    const results = await Promise.all(groups.map((g) => g.fn(companyId, p, limit)));
    const out = groups.map((g, i) => ({ key: g.key, label: g.label, more: results[i].more, items: results[i].rows.sort((a, b) => b.score - a.score) }))
      .filter((g) => g.items.length);
    // Le groupe qui contient la meilleure correspondance passe en premier.
    out.sort((a, b) => (b.items[0].score - a.items[0].score));
    return { query: p.q, mode: p.phone ? 'phone' : 'text', groups: out };
  }

  return { ensureSchema, search };
}

module.exports = { createGlobalSearch, parseQuery, phoneMatches, fold };
