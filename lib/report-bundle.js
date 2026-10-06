'use strict';

// Rapports unifiés : un seul parcours pour choisir des familles de données
// (Commandes, Tournées, Incidents, Clients), les filtrer ensemble, puis
// emporter un fichier : CSV (ZIP si plusieurs familles), synthèse SVG, ou
// classeur Excel enrichi (synthèse + un onglet par famille, formules et
// graphiques Excel natifs).
//
// Définitions (affichées dans l'interface) :
// - période : création des commandes, date de service des tournées, ouverture
//   des incidents ; borne de fin exclusive (début du lendemain, heure du Bénin) ;
// - clients : ceux qui ont au moins une commande créée sur la période (après
//   filtres zone/livreur) ; leurs compteurs portent sur cette période ;
// - part livrée : commandes livrées / toutes les commandes de la sélection,
//   annulations incluses.

const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const TZ_OFFSET = '+01:00'; // Bénin, sans heure d'été
const TIME_ZONE = 'Africa/Porto-Novo';
const PREVIEW_LIMIT = 2000; // lignes renvoyées au navigateur par famille
const EXPORT_LIMIT = 100000; // au-delà : refus, jamais de troncature silencieuse

const f = (key, label, opts = {}) => ({ key, label, required: Boolean(opts.required), personal: Boolean(opts.personal), type: opts.type || 'text' });
const FAMILIES = Object.freeze({
  orders: {
    name: 'Commandes', file: 'Commandes', roles: ['owner', 'manager', 'operator'],
    fields: [f('id', 'Commande', { required: true }), f('date', 'Créée le', { required: true, type: 'date' }), f('clientId', 'ID client', { required: true }),
      f('client', 'Client'), f('zone', 'Zone'), f('driver', 'Livreur'), f('status', 'Statut'), f('priority', 'Priorité'), f('tourId', 'Tournée', { required: true }),
      f('phone', 'Téléphone', { personal: true }), f('address', 'Adresse', { personal: true })],
  },
  tours: {
    name: 'Tournées', file: 'Tournees', roles: ['owner', 'manager'],
    fields: [f('id', 'Tournée', { required: true }), f('date', 'Date', { required: true, type: 'day' }), f('driver', 'Livreur'), f('status', 'Statut'),
      f('stops', 'Arrêts', { type: 'number' }), f('delivered', 'Livrées', { type: 'number' })],
  },
  incidents: {
    name: 'Incidents', file: 'Incidents', roles: ['owner', 'manager'],
    fields: [f('id', 'Incident', { required: true }), f('date', 'Ouvert le', { required: true, type: 'date' }), f('orderId', 'Commande', { required: true }),
      f('clientId', 'ID client', { required: true }), f('zone', 'Zone'), f('driver', 'Livreur'), f('reason', 'Motif'), f('severity', 'Gravité'), f('status', 'Statut')],
  },
  clients: {
    name: 'Clients', file: 'Clients', roles: ['owner', 'manager'],
    fields: [f('id', 'ID client', { required: true }), f('name', 'Client'), f('zone', 'Zone'), f('orders', 'Commandes', { type: 'number' }),
      f('delivered', 'Livrées', { type: 'number' }), f('phone', 'Téléphone', { personal: true })],
  },
});
const FAMILY_KEYS = Object.keys(FAMILIES);

const RUN_STATUS = { draft: 'En préparation', planned: 'Planifiée', active: 'En cours', completed: 'Terminée', cancelled: 'Annulée' };
const INCIDENT_STATUS = { open: 'À traiter', resolved: 'Résolu' };
const INCIDENT_CATEGORY = { client_injoignable: 'Client injoignable', adresse: 'Adresse ou accès', colis: 'Colis endommagé ou manquant', paiement: 'Paiement', vehicule: 'Véhicule', gps: 'GPS ou connexion', autre: 'Autre' };
const SEVERITY = { low: 'Faible', medium: 'Moyenne', high: 'Élevée' };
const PRIORITY = { normal: 'Normale', urgent: 'Urgente' };

class ReportError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---- Sélection : validation (rôle, période, familles, colonnes) ----------
const ROLE_PERIOD_DAYS = { owner: 366, manager: 366, operator: 31 };
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function normalizeSelection(body, role) {
  const input = body && typeof body === 'object' ? body : {};
  const allowed = FAMILY_KEYS.filter((k) => FAMILIES[k].roles.includes(role));
  if (!allowed.length) throw new ReportError('FORBIDDEN', 'Votre rôle ne permet pas d’exporter des données.', 403);
  const requested = Array.isArray(input.sources) ? [...new Set(input.sources.map(String))] : [];
  const sources = requested.filter((k) => FAMILY_KEYS.includes(k));
  if (!sources.length) throw new ReportError('NO_SOURCE', 'Sélectionnez au moins une famille de données.');
  const refused = sources.filter((k) => !allowed.includes(k));
  if (refused.length) throw new ReportError('FORBIDDEN_SOURCE', `Votre rôle ne permet pas d’exporter : ${refused.map((k) => FAMILIES[k].name).join(', ')}.`, 403);
  const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
  const from = String(filters.from || ''); const to = String(filters.to || '');
  if (!isDay(from) || !isDay(to)) throw new ReportError('BAD_PERIOD', 'Choisissez une date de début et une date de fin valides.');
  if (from > to) throw new ReportError('BAD_PERIOD', 'La date de fin doit être après la date de début.');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  const maxDays = ROLE_PERIOD_DAYS[role] || 31;
  if (days > maxDays) throw new ReportError('PERIOD_TOO_LONG', `La période est limitée à ${maxDays} jours pour votre rôle.`);
  const zone = filters.zone && filters.zone !== 'all' ? String(filters.zone).slice(0, 160) : null;
  const driver = filters.driver && filters.driver !== 'all' && /^\d+$/.test(String(filters.driver)) ? String(filters.driver) : null;
  const status = {};
  if (filters.status && typeof filters.status === 'object') {
    for (const k of sources) if (filters.status[k] && filters.status[k] !== 'all') status[k] = String(filters.status[k]).slice(0, 60);
  }
  const query = String(filters.query || '').slice(0, 120);
  const fields = {};
  for (const k of sources) {
    const wanted = input.fields && Array.isArray(input.fields[k]) ? new Set(input.fields[k].map(String)) : null;
    fields[k] = FAMILIES[k].fields.filter((x) => x.required || (wanted ? wanted.has(x.key) : !x.personal)).map((x) => x.key);
  }
  return { sources, from, to, days, zone, driver, status, query, fields, allowed };
}

// ---- Lecture des données (une requête par famille, isolée par entreprise) ----
const fmtRef = (prefix, id) => (id == null ? '' : `${prefix}-${id}`);

async function fetchFamily(db, key, companyId, sel, { personal = false, limit = EXPORT_LIMIT + 1 } = {}) {
  const start = `${sel.from}T00:00:00${TZ_OFFSET}`;
  const end = `${addDays(sel.to, 1)}T00:00:00${TZ_OFFSET}`;
  const values = [companyId, start, end];
  const extra = [];
  const add = (sql, value) => { values.push(value); extra.push(sql.replace('$?', `$${values.length}`)); };
  if (key === 'orders' || key === 'clients') {
    if (sel.zone) add('o.neighborhood = $?', sel.zone);
    if (sel.driver) add('o.driver_id = $?::bigint', sel.driver);
  }
  if (key === 'orders') {
    const r = await db.query(
      `SELECT o.id, o.reference, o.created_at, o.status, o.priority, o.neighborhood,
              o.customer_name, ${personal ? 'o.customer_phone, o.delivery_address,' : ''}
              c.customer_code, d.name AS driver_name,
              (SELECT s.run_id FROM delivery_stops s WHERE s.order_id = o.id AND s.company_id = o.company_id
               ORDER BY s.assignment_active DESC, s.id DESC LIMIT 1) AS run_id
       FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id AND d.company_id = o.company_id
       LEFT JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
       WHERE o.company_id = $1 AND o.archived_at IS NULL AND o.created_at >= $2::timestamptz AND o.created_at < $3::timestamptz
       ${extra.map((x) => `AND ${x}`).join(' ')}
       ORDER BY o.created_at, o.id LIMIT ${limit}`, values);
    return r.rows.map((o) => ({
      id: o.reference || fmtRef('CMD', o.id), date: o.created_at, clientId: o.customer_code || '', client: o.customer_name || '',
      zone: o.neighborhood || '', driver: o.driver_name || '', status: o.status, priority: PRIORITY[o.priority] || 'Normale',
      tourId: fmtRef('TRN', o.run_id), ...(personal ? { phone: o.customer_phone || '', address: o.delivery_address || '' } : {}),
    }));
  }
  if (key === 'clients') {
    const r = await db.query(
      `SELECT c.id, c.customer_code, c.display_name,
              (ARRAY_AGG(o.neighborhood ORDER BY o.created_at DESC))[1] AS zone,
              COUNT(o.id)::int AS orders, COUNT(o.id) FILTER (WHERE o.status = 'Livrée')::int AS delivered
              ${personal ? `, (SELECT cc.value_display FROM customer_contacts cc WHERE cc.company_id = c.company_id AND cc.customer_id = c.id
                 AND cc.kind = 'phone' AND cc.is_active = TRUE AND cc.anonymized_at IS NULL ORDER BY cc.is_primary DESC, cc.id ASC LIMIT 1) AS phone` : ''}
       FROM orders o JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
       WHERE o.company_id = $1 AND o.archived_at IS NULL AND o.created_at >= $2::timestamptz AND o.created_at < $3::timestamptz
         AND c.status NOT IN ('merged', 'anonymized')
       ${extra.map((x) => `AND ${x}`).join(' ')}
       GROUP BY c.id ORDER BY c.customer_code NULLS LAST, c.id LIMIT ${limit}`, values);
    return r.rows.map((c) => ({ id: c.customer_code || fmtRef('CLI', c.id), name: c.display_name || '', zone: c.zone || '', orders: c.orders, delivered: c.delivered, ...(personal ? { phone: c.phone || '' } : {}) }));
  }
  if (key === 'tours') {
    const v = [companyId, sel.from, addDays(sel.to, 1)];
    const w = [];
    if (sel.driver) { v.push(sel.driver); w.push(`r.driver_id = $${v.length}::bigint`); }
    if (sel.zone) { v.push(sel.zone); w.push(`EXISTS (SELECT 1 FROM delivery_stops s2 JOIN orders o2 ON o2.id = s2.order_id WHERE s2.run_id = r.id AND s2.removed_at IS NULL AND o2.neighborhood = $${v.length})`); }
    const r = await db.query(
      `SELECT r.id, TO_CHAR(r.service_date, 'YYYY-MM-DD') AS day, r.status, d.name AS driver_name,
              (SELECT COUNT(*) FROM delivery_stops s WHERE s.run_id = r.id AND s.removed_at IS NULL)::int AS stops,
              (SELECT COUNT(*) FROM delivery_stops s JOIN orders o ON o.id = s.order_id
                WHERE s.run_id = r.id AND s.removed_at IS NULL AND o.status = 'Livrée')::int AS delivered
       FROM delivery_runs r LEFT JOIN drivers d ON d.id = r.driver_id AND d.company_id = r.company_id
       WHERE r.company_id = $1 AND r.service_date >= $2::date AND r.service_date < $3::date
       ${w.map((x) => `AND ${x}`).join(' ')}
       ORDER BY r.service_date, r.id LIMIT ${limit}`, v);
    return r.rows.map((t) => ({ id: fmtRef('TRN', t.id), date: t.day, driver: t.driver_name || '', status: RUN_STATUS[t.status] || t.status, stops: t.stops, delivered: t.delivered }));
  }
  if (key === 'incidents') {
    const v = [companyId, start, end];
    const w = [];
    if (sel.zone) { v.push(sel.zone); w.push(`o.neighborhood = $${v.length}`); }
    if (sel.driver) { v.push(sel.driver); w.push(`o.driver_id = $${v.length}::bigint`); }
    const r = await db.query(
      `SELECT i.id, i.created_at, i.category, i.severity, i.status, o.id AS order_id, o.reference, o.neighborhood,
              c.customer_code, d.name AS driver_name
       FROM delivery_incidents i
       JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
       LEFT JOIN customers c ON c.id = o.customer_id AND c.company_id = o.company_id
       LEFT JOIN drivers d ON d.id = o.driver_id AND d.company_id = o.company_id
       WHERE i.company_id = $1 AND i.created_at >= $2::timestamptz AND i.created_at < $3::timestamptz
       ${w.map((x) => `AND ${x}`).join(' ')}
       ORDER BY i.created_at, i.id LIMIT ${limit}`, v);
    return r.rows.map((i) => ({
      id: fmtRef('INC', i.id), date: i.created_at, orderId: i.reference || fmtRef('CMD', i.order_id), clientId: i.customer_code || '',
      zone: i.neighborhood || '', driver: i.driver_name || '', reason: INCIDENT_CATEGORY[i.category] || i.category,
      severity: SEVERITY[i.severity] || i.severity, status: INCIDENT_STATUS[i.status] || i.status,
    }));
  }
  throw new ReportError('NO_SOURCE', 'Famille inconnue.');
}

// Recherche commune (sans accents ni casse) et statut propre à chaque famille.
const fold = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('fr');
function applyRowFilters(key, rows, sel) {
  const status = sel.status[key];
  const q = fold(sel.query).trim();
  return rows.filter((r) => (!status || r.status === status) && (!q || fold(Object.values(r).map((x) => (x instanceof Date ? '' : x)).join(' ')).includes(q)));
}

async function loadSelection(db, companyId, sel, { personal = false, limit = EXPORT_LIMIT + 1 } = {}) {
  const out = [];
  for (const key of sel.sources) {
    const needsPersonal = personal || sel.fields[key].some((k) => FAMILIES[key].fields.find((x) => x.key === k)?.personal);
    const raw = await fetchFamily(db, key, companyId, sel, { personal: needsPersonal, limit });
    if (raw.length > EXPORT_LIMIT) throw new ReportError('EXPORT_TOO_LARGE', `Trop de ${FAMILIES[key].name.toLowerCase()} pour un seul fichier : réduisez la période ou ajoutez un filtre.`, 413);
    const statuses = [...new Set(raw.map((r) => r.status).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    out.push({ key, name: FAMILIES[key].name, file: FAMILIES[key].file, rows: applyRowFilters(key, raw, sel), statuses, fields: sel.fields[key].map((k) => FAMILIES[key].fields.find((x) => x.key === k)) });
  }
  return out;
}

// ---- Formats --------------------------------------------------------------
const dayFr = (d) => new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
const periodLabel = (sel) => `${dayFr(sel.from)} – ${dayFr(sel.to)}`;
const localStamp = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const cellText = (field, value) => (field.type === 'date' ? localStamp(value) : value == null ? '' : String(value));

// CSV : UTF-8 avec BOM, point-virgule, tout entre guillemets, et protection
// contre l'interprétation d'une saisie comme formule (= + - @ tabulation).
function toCsv(family) {
  const cell = (v) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, (m) => `'${m}`).replace(/"/g, '""')}"`;
  const lines = [family.fields.map((x) => cell(x.label)).join(';')];
  for (const r of family.rows) lines.push(family.fields.map((x) => cell(cellText(x, r[x.key]))).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
async function toZip(families) {
  const zip = new JSZip();
  for (const fam of families) zip.file(`${fam.file}.csv`, toCsv(fam));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const xmlEsc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// Synthèse vectorielle : volumes par famille, période et filtres. Aucun
// script, lien ou coordonnée personnelle.
function toSvg(families, sel, { companyName = '', filtersLabel = '' } = {}) {
  const w = 960; const pad = 48; const h = 250 + families.length * 70;
  const max = Math.max(1, ...families.map((x) => x.rows.length));
  const bars = families.map((x, i) => {
    const y = 196 + i * 70;
    return `<text x="${pad}" y="${y}" font-family="Arial,sans-serif" font-size="16" fill="#3b574a">${xmlEsc(x.name)}</text>`
      + `<text x="${w - pad}" y="${y}" text-anchor="end" font-family="Arial,sans-serif" font-size="17" font-weight="700" fill="#24303c">${x.rows.length}</text>`
      + `<rect x="${pad}" y="${y + 14}" width="${w - pad * 2}" height="11" rx="3" fill="#eef3ef"/>`
      + `<rect x="${pad}" y="${y + 14}" width="${Math.max(x.rows.length ? 6 : 0, ((w - pad * 2) * x.rows.length) / max).toFixed(1)}" height="11" rx="3" fill="${x.key === 'orders' ? '#e95168' : '#699081'}"/>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Synthèse TRAXO">`
    + `<rect width="${w}" height="${h}" fill="#ffffff"/><rect x="${pad}" y="40" width="34" height="4" rx="2" fill="#e81735"/>`
    + `<text x="${pad}" y="76" font-family="Arial,sans-serif" font-size="13" letter-spacing="2" fill="#a94c5a">TRAXO / RAPPORT${companyName ? ` · ${xmlEsc(companyName.toUpperCase())}` : ''}</text>`
    + `<text x="${pad}" y="118" font-family="Arial,sans-serif" font-size="34" fill="#283d35">Votre activité en bref.</text>`
    + `<text x="${pad}" y="148" font-family="Arial,sans-serif" font-size="15" fill="#718177">${xmlEsc(periodLabel(sel))}${filtersLabel ? ` · ${xmlEsc(filtersLabel)}` : ''}</text>`
    + bars
    + `<text x="${pad}" y="${h - 26}" font-family="Arial,sans-serif" font-size="12" fill="#839086">Généré par TRAXO le ${xmlEsc(localStamp(new Date()))} · volumes de la sélection</text></svg>`;
}

// ---- Excel enrichi --------------------------------------------------------
const colLetter = (n) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
const excelDate = (v, dayOnly) => {
  if (!v) return null;
  if (dayOnly) return new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
  // Heure locale du Bénin, posée comme date « flottante » pour Excel.
  const s = localStamp(v); if (!s) return null;
  return new Date(`${s.replace(' ', 'T')}:00Z`);
};
const DARK = 'FF344B51'; const INK = 'FF263C42'; const MUTED = 'FF677979'; const RED = 'FFE81735';

async function toXlsx(families, sel, { companyName = '', filtersLabel = '' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TRAXO'; wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };
  const synth = wb.addWorksheet('Synthèse', { views: [{ showGridLines: false }], properties: { tabColor: { argb: RED } } });
  const sheets = {};
  const subtitle = `${companyName ? `${companyName} · ` : ''}${periodLabel(sel)}${filtersLabel ? ` · ${filtersLabel}` : ''}`;

  for (const fam of families) {
    const ws = wb.addWorksheet(fam.name, { views: [{ state: 'frozen', ySplit: 5, showGridLines: false }], properties: { tabColor: { argb: 'FF6C8C85' } } });
    const n = fam.fields.length;
    ws.columns = fam.fields.map((x) => ({ width: x.type === 'date' ? 18 : ['client', 'name', 'reason', 'address'].includes(x.key) ? 28 : x.type === 'number' ? 12 : 18 }));
    ws.mergeCells(2, 1, 2, n); ws.getCell(2, 1).value = `TRAXO · ${fam.name}`; ws.getCell(2, 1).font = { name: 'Arial', size: 18, bold: true, color: { argb: INK } };
    ws.mergeCells(3, 1, 3, n); ws.getCell(3, 1).value = subtitle; ws.getCell(3, 1).font = { name: 'Arial', size: 11, color: { argb: MUTED } };
    const rows = fam.rows.map((r) => fam.fields.map((x) => {
      if (x.type === 'date' || x.type === 'day') return excelDate(r[x.key], x.type === 'day');
      if (x.type === 'number') return Number(r[x.key]) || 0;
      return r[x.key] == null ? '' : String(r[x.key]); // texte : jamais interprété comme formule
    }));
    ws.addTable({
      name: `Traxo${fam.file}`, ref: 'A5', headerRow: true, totalsRow: false,
      style: { theme: 'TableStyleLight1', showRowStripes: true },
      columns: fam.fields.map((x) => ({ name: x.label, filterButton: true })),
      rows: rows.length ? rows : [fam.fields.map(() => '')],
    });
    ws.getRow(5).height = 26;
    fam.fields.forEach((x, i) => {
      const cell = ws.getCell(5, i + 1);
      cell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
      if (x.type === 'date' || x.type === 'day') ws.getColumn(i + 1).numFmt = x.type === 'day' ? 'dd/mm/yyyy' : 'dd/mm/yyyy hh:mm';
    });
    for (let r = 6; r < 6 + Math.max(1, rows.length); r += 1) ws.getRow(r).font = { name: 'Arial', size: 11, color: { argb: INK } };
    sheets[fam.key] = { ws, fam, first: 6, last: 5 + Math.max(1, rows.length), col: (key) => { const i = fam.fields.findIndex((x) => x.key === key); return i < 0 ? null : colLetter(i + 1); } };
  }

  // Clients : compteurs recalculés depuis l'onglet Commandes quand il est présent.
  const ord = sheets.orders; const cli = sheets.clients;
  if (ord && cli && cli.col('orders') && ord.col('clientId')) {
    const range = (c) => `Commandes!$${c}$${ord.first}:$${c}$${ord.last}`;
    cli.fam.rows.forEach((r, i) => {
      const row = cli.first + i; const idCell = `${cli.col('id')}${row}`;
      cli.ws.getCell(`${cli.col('orders')}${row}`).value = { formula: `COUNTIFS(${range(ord.col('clientId'))},${idCell})`, result: r.orders };
      if (cli.col('delivered') && ord.col('status')) cli.ws.getCell(`${cli.col('delivered')}${row}`).value = { formula: `COUNTIFS(${range(ord.col('clientId'))},${idCell},${range(ord.col('status'))},"Livrée")`, result: r.delivered };
    });
  }

  // Synthèse
  synth.columns = Array.from({ length: 14 }, (_, i) => ({ width: i === 0 ? 3 : 13 }));
  synth.mergeCells('B2:M2'); synth.getCell('B2').value = 'Votre activité avec TRAXO'; synth.getCell('B2').font = { name: 'Arial', size: 21, bold: true, color: { argb: INK } };
  synth.mergeCells('B3:M3'); synth.getCell('B3').value = subtitle; synth.getCell('B3').font = { name: 'Arial', size: 11, color: { argb: MUTED } };
  for (let c = 2; c <= 13; c += 1) synth.getCell(4, c).border = { bottom: { style: 'thin', color: { argb: RED } } };
  const orders = ord ? ord.fam.rows : null;
  const delivered = orders ? orders.filter((r) => r.status === 'Livrée').length : null;
  const kpis = [];
  if (ord) {
    kpis.push(['B', 'Commandes', { formula: `COUNTA(Commandes!${ord.col('id')}${ord.first}:${ord.col('id')}${ord.last})-COUNTBLANK(Commandes!${ord.col('id')}${ord.first}:${ord.col('id')}${ord.last})`, result: orders.length }]);
    if (ord.col('status')) {
      kpis.push(['E', 'Livrées', { formula: `COUNTIFS(Commandes!${ord.col('status')}${ord.first}:${ord.col('status')}${ord.last},"Livrée")`, result: delivered }]);
      kpis.push(['H', 'Part livrée', { formula: 'IF(B7=0,"n.a.",E7/B7)', result: orders.length ? delivered / orders.length : 'n.a.' }, '0.0%']);
    }
  }
  const inc = sheets.incidents;
  if (inc && inc.col('status')) {
    kpis.push(['K', 'Incidents à traiter', { formula: `COUNTIFS(Incidents!${inc.col('status')}${inc.first}:${inc.col('status')}${inc.last},"À traiter")`, result: inc.fam.rows.filter((r) => r.status === 'À traiter').length }]);
  }
  // Familles sans formule : volumes simples.
  let slot = kpis.length;
  for (const fam of families) {
    if (fam.key === 'orders' || (fam.key === 'incidents' && inc && inc.col('status'))) continue;
    if (slot >= 4) break;
    kpis.push([['B', 'E', 'H', 'K'][slot], fam.name, fam.rows.length]); slot += 1;
  }
  for (const [col, label, value, fmt] of kpis) {
    synth.getCell(`${col}6`).value = label; synth.getCell(`${col}6`).font = { name: 'Arial', size: 11, color: { argb: MUTED } };
    synth.getCell(`${col}7`).value = value; synth.getCell(`${col}7`).font = { name: 'Arial', size: 24, bold: true, color: { argb: INK } };
    if (fmt) synth.getCell(`${col}7`).numFmt = fmt;
  }
  synth.getRow(7).height = 34;
  synth.mergeCells('B9:M9');
  synth.getCell('B9').value = ord ? 'Part livrée : commandes livrées / toutes les commandes de la sélection, annulations incluses.' : 'Ajoutez la famille Commandes pour obtenir les graphiques d’activité.';
  synth.getCell('B9').font = { name: 'Arial', size: 10, italic: true, color: { argb: MUTED } };

  const charts = [];
  if (ord && ord.col('status')) {
    // Tableau des statuts (source du premier graphique)
    const statusList = [...new Set(orders.map((r) => r.status))].sort((a, b) => (a === 'Livrée' ? -1 : b === 'Livrée' ? 1 : a.localeCompare(b, 'fr')));
    synth.getCell('B28').value = 'Statut'; synth.getCell('C28').value = 'Commandes';
    ['B28', 'C28'].forEach((a) => { synth.getCell(a).font = { name: 'Arial', bold: true, color: { argb: INK } }; });
    const statusRows = statusList.length ? statusList : ['Aucune commande'];
    statusRows.forEach((st, i) => {
      const r = 29 + i;
      synth.getCell(`B${r}`).value = st;
      synth.getCell(`C${r}`).value = statusList.length ? { formula: `COUNTIFS(Commandes!$${ord.col('status')}$${ord.first}:$${ord.col('status')}$${ord.last},B${r})`, result: orders.filter((o) => o.status === st).length } : 0;
    });
    charts.push({ type: 'bar', title: 'Commandes par statut', color: 'E81735', cat: `'Synthèse'!$B$29:$B$${28 + statusRows.length}`, val: `'Synthèse'!$C$29:$C$${28 + statusRows.length}`, name: `'Synthèse'!$C$28`, cats: statusRows, vals: statusRows.map((st) => orders.filter((o) => o.status === st).length), from: { col: 1, row: 10 }, to: { col: 7, row: 25 } });
    // Commandes créées par jour (jusqu'à 92 jours ; au-delà, par semaine)
    const byWeek = sel.days > 92;
    const buckets = [];
    for (let d = sel.from; d <= sel.to; d = addDays(d, byWeek ? 7 : 1)) buckets.push(d);
    synth.getCell('G28').value = byWeek ? 'Semaine du' : 'Jour'; synth.getCell('H28').value = 'Commandes'; synth.getCell('I28').value = 'Début';
    ['G28', 'H28', 'I28'].forEach((a) => { synth.getCell(a).font = { name: 'Arial', bold: true, color: { argb: INK } }; });
    const dCol = ord.col('date');
    const counts = buckets.map((d) => {
      const next = addDays(d, byWeek ? 7 : 1);
      return orders.filter((o) => { const s = localStamp(o.date).slice(0, 10); return s >= d && s < next; }).length;
    });
    buckets.forEach((d, i) => {
      const r = 29 + i; const next = byWeek ? 7 : 1;
      synth.getCell(`G${r}`).value = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
      synth.getCell(`I${r}`).value = new Date(`${d}T00:00:00Z`); synth.getCell(`I${r}`).numFmt = 'dd/mm/yyyy';
      synth.getCell(`H${r}`).value = { formula: `COUNTIFS(Commandes!$${dCol}$${ord.first}:$${dCol}$${ord.last},">="&I${r},Commandes!$${dCol}$${ord.first}:$${dCol}$${ord.last},"<"&(I${r}+${next}))`, result: counts[i] };
    });
    charts.push({ type: 'line', title: byWeek ? 'Commandes créées par semaine' : 'Commandes créées par jour', color: '477E6C', cat: `'Synthèse'!$G$29:$G$${28 + buckets.length}`, val: `'Synthèse'!$H$29:$H$${28 + buckets.length}`, name: `'Synthèse'!$H$28`, cats: buckets.map((d) => new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))), vals: counts, from: { col: 7, row: 10 }, to: { col: 13, row: 25 } });
  }
  const noteRow = Math.max(27, synth.rowCount) + 2;
  synth.mergeCells(`B${noteRow}:M${noteRow}`);
  synth.getCell(`B${noteRow}`).value = 'Ce fichier est un instantané : les modifications faites ensuite dans TRAXO ne le mettent pas à jour. Les calculs suivent les lignes des onglets.';
  synth.getCell(`B${noteRow}`).font = { name: 'Arial', size: 10, color: { argb: MUTED } };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return charts.length ? injectCharts(buffer, charts) : buffer;
}

// ExcelJS n'écrit pas de graphiques : on ajoute des graphiques Excel natifs
// (DrawingML) liés aux cellules de la Synthèse, donc modifiables dans Excel.
function chartXml(ch, index) {
  const pts = (arr, num) => arr.map((v, i) => `<c:pt idx="${i}"><c:v>${num ? Number(v) || 0 : xmlEsc(v)}</c:v></c:pt>`).join('');
  const txt = '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:solidFill><a:srgbClr val="46525F"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="fr-FR"/></a:p></c:txPr>';
  const ser = `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${xmlEsc(ch.name)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Commandes</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    + (ch.type === 'bar'
      ? `<c:spPr><a:solidFill><a:srgbClr val="${ch.color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`
      : `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${ch.color}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${ch.color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>`)
    + `<c:cat><c:strRef><c:f>${xmlEsc(ch.cat)}</c:f><c:strCache><c:ptCount val="${ch.cats.length}"/>${pts(ch.cats)}</c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>${xmlEsc(ch.val)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${ch.vals.length}"/>${pts(ch.vals, true)}</c:numCache></c:numRef></c:val>`
    + (ch.type === 'line' ? '<c:smooth val="0"/>' : '') + '</c:ser>';
  const ax1 = 500 + index * 10; const ax2 = ax1 + 1;
  const plot = ch.type === 'bar'
    ? `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}<c:gapWidth val="70"/><c:axId val="${ax1}"/><c:axId val="${ax2}"/></c:barChart>`
    : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="${ax1}"/><c:axId val="${ax2}"/></c:lineChart>`;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<c:roundedCorners val="0"/><c:chart>'
    + `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="fr-FR" sz="1400" b="1"><a:solidFill><a:srgbClr val="263C42"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${xmlEsc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
    + `<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}`
    + `<c:catAx><c:axId val="${ax1}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D3D9DE"/></a:solidFill></a:ln></c:spPr>${txt}<c:crossAx val="${ax2}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
    + `<c:valAx><c:axId val="${ax2}"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E9EC"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txt}<c:crossAx val="${ax1}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`
    + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>'
    + '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="6350"><a:solidFill><a:srgbClr val="E3E8EC"/></a:solidFill></a:ln></c:spPr>'
    + '</c:chartSpace>';
}

async function injectCharts(buffer, charts) {
  const zip = await JSZip.loadAsync(buffer);
  // Feuille « Synthèse » : première feuille écrite par ExcelJS.
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const book = await zip.file('xl/workbook.xml').async('string');
  const sheetRid = (book.match(/<sheet [^>]*name="Synthèse"[^>]*r:id="([^"]+)"/) || book.match(/<sheet [^>]*r:id="([^"]+)"[^>]*name="Synthèse"/) || [])[1];
  const target = sheetRid && (rels.match(new RegExp(`<Relationship [^>]*Id="${sheetRid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${sheetRid}"`)) || [])[1];
  if (!target) return buffer;
  const sheetPath = `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`;
  const sheetName = sheetPath.split('/').pop();
  const relsPath = `xl/worksheets/_rels/${sheetName}.rels`;
  let drawingNo = 1; while (zip.file(`xl/drawings/drawing${drawingNo}.xml`)) drawingNo += 1;
  let chartNo = 1; while (zip.file(`xl/charts/chart${chartNo}.xml`)) chartNo += 1;

  const anchors = []; const drawingRels = []; const overrides = [];
  charts.forEach((ch, i) => {
    const n = chartNo + i;
    zip.file(`xl/charts/chart${n}.xml`, chartXml(ch, i));
    drawingRels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${n}.xml"/>`);
    overrides.push(`<Override PartName="/xl/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
    anchors.push(`<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${ch.from.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${ch.from.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${ch.to.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${ch.to.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
      + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${xmlEsc(ch.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`);
  });
  zip.file(`xl/drawings/drawing${drawingNo}.xml`, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `${anchors.join('')}</xdr:wsDr>`);
  zip.file(`xl/drawings/_rels/drawing${drawingNo}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels.join('')}</Relationships>`);
  overrides.push(`<Override PartName="/xl/drawings/drawing${drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);

  let sheetRels = zip.file(relsPath) ? await zip.file(relsPath).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const relId = 'rIdTraxoDrawing1';
  sheetRels = sheetRels.replace('</Relationships>', `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingNo}.xml"/></Relationships>`);
  zip.file(relsPath, sheetRels);

  let sheet = await zip.file(sheetPath).async('string');
  if (!/xmlns:r=/.test(sheet.slice(0, 600))) sheet = sheet.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  const tag = `<drawing r:id="${relId}"/>`;
  // Ordre imposé par le schéma : <drawing> avant legacyDrawing / tableParts / extLst.
  const before = sheet.search(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
  sheet = before >= 0 ? `${sheet.slice(0, before)}${tag}${sheet.slice(before)}` : sheet.replace('</worksheet>', `${tag}</worksheet>`);
  zip.file(sheetPath, sheet);

  let types = await zip.file('[Content_Types].xml').async('string');
  types = types.replace('</Types>', `${overrides.join('')}</Types>`);
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = {
  FAMILIES, FAMILY_KEYS, PREVIEW_LIMIT, EXPORT_LIMIT, ReportError,
  normalizeSelection, loadSelection, applyRowFilters, toCsv, toZip, toSvg, toXlsx, periodLabel, localStamp,
};
