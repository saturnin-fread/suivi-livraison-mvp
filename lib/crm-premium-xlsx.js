'use strict';

/**
 * Générateur de classeurs Excel « premium » pour TRAXO (couverture brandée +
 * feuille de données stylée FR + tableau de bord avec graphiques).
 *
 * Pile : ExcelJS (classeur, styles, images) + Chart.js rendu en PNG via
 * @napi-rs/canvas (binaires précompilés, AUCUNE dépendance système, contrairement
 * à node-canvas). Les graphiques sont incrustés comme images — rendu déterministe
 * qui s'ouvre toujours sans avertissement (contrepartie : graphiques non éditables
 * dans Excel, ce qui est acceptable pour un export « photo à un instant T »).
 *
 * Sécurité : les cellules de données sont écrites comme CHAÎNES par ExcelJS, donc
 * inertes (une valeur commençant par = + - @ n'est jamais interprétée comme une
 * formule dans une cellule de type texte). On ne préfixe donc pas d'apostrophe
 * (qui s'afficherait littéralement). La volumétrie est bornée EN AMONT par
 * l'endpoint (refus, pas de troncature).
 *
 * Fonction exposée :
 *   buildPremiumWorkbook({ datasetKey, rows, meta, columns, options }) -> Buffer
 */

const path = require('path');
const ExcelJS = require('exceljs');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { Chart, registerables } = require('chart.js');
const ChartDataLabels = require('chartjs-plugin-datalabels');

Chart.register(...registerables, ChartDataLabels);

// Police embarquée (DejaVu Sans, licence permissive) enregistrée sous le nom
// « TRAXO Sans » : garantit le rendu du texte des graphiques même si l'image
// de déploiement (Railway) ne fournit aucune police système.
const FONT_NAME = 'TRAXO Sans';
try {
  const fontDir = path.join(__dirname, '..', 'assets', 'fonts');
  GlobalFonts.registerFromPath(path.join(fontDir, 'DejaVuSans.ttf'), FONT_NAME);
  GlobalFonts.registerFromPath(path.join(fontDir, 'DejaVuSans-Bold.ttf'), FONT_NAME);
} catch (_) { /* repli sur les polices système si l'enregistrement échoue */ }

// --- Charte TRAXO -----------------------------------------------------------
const BRAND = {
  red: 'FFE11D2A', navy: 'FF16233F', white: 'FFFFFFFF',
  zebra: 'FFF6F8FB', border: 'FFD8DEE9', muted: 'FF6C757D',
};
const CHART_PALETTE = ['#E11D2A', '#16233F', '#F2A900', '#2E86AB', '#6C757D', '#8E44AD', '#1ABC9C', '#F39C12', '#7F8C8D', '#C0392B'];
const STATUS_BADGE_COLORS = {
  livree: 'FF1E8E3E', 'livrée': 'FF1E8E3E', delivered: 'FF1E8E3E',
  'en cours': 'FFF2A900', in_progress: 'FFF2A900', en_route: 'FFF2A900', 'en tournée': 'FFF2A900', 'en livraison': 'FFF2A900',
  annulee: 'FF8E8E93', 'annulée': 'FF8E8E93', cancelled: 'FF8E8E93',
  echec: 'FFE11D2A', 'échec': 'FFE11D2A', failed: 'FFE11D2A',
  'en attente': 'FF2E86AB', pending: 'FF2E86AB', 'en préparation': 'FF2E86AB',
  ouvert: 'FFE11D2A', open: 'FFE11D2A',
  resolu: 'FF1E8E3E', 'résolu': 'FF1E8E3E', resolved: 'FF1E8E3E',
  terminee: 'FF1E8E3E', 'terminée': 'FF1E8E3E', completed: 'FF1E8E3E', active: 'FFF2A900',
};

const DATASET_TITLES = { operations: 'Commandes', customers: 'Clients', incidents: 'Incidents', routes: 'Tournées' };
const DATE_FMT = 'dd/mm/yyyy';
const DATETIME_FMT = 'dd/mm/yyyy hh:mm';

// --- Sécurité / types -------------------------------------------------------
// Coercition sûre : renvoie une chaîne (inerte dans une cellule ExcelJS de type
// texte), un nombre, une Date ou null. Aucune apostrophe visible ajoutée.
function safeText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}
function parseIsoToDate(iso) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function isoHasTime(iso) {
  if (iso instanceof Date) return true;
  return typeof iso === 'string' && /T\d{2}:\d{2}/.test(iso);
}
function formatFrDate(iso) { const d = parseIsoToDate(iso); return d ? d.toLocaleDateString('fr-FR') : '—'; }
function formatFrDateTime(iso) { const d = parseIsoToDate(iso); return d ? d.toLocaleString('fr-FR') : '—'; }

// --- Rendu graphique (Chart.js -> PNG via @napi-rs/canvas) ------------------
const CHART_W = 880, CHART_H = 500;

function renderChartPng(config) {
  const canvas = createCanvas(CHART_W, CHART_H);
  // Shims attendus par Chart.js pour un <canvas> hors DOM (Node).
  canvas.addEventListener = () => {};
  canvas.removeEventListener = () => {};
  canvas.style = {};
  canvas.getBoundingClientRect = () => ({ width: CHART_W, height: CHART_H, top: 0, left: 0, right: CHART_W, bottom: CHART_H });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, CHART_W, CHART_H);
  const chart = new Chart(ctx, config);
  const png = canvas.toBuffer('image/png');
  chart.destroy();
  return png;
}

const FONT = { family: `"${FONT_NAME}", Arial, sans-serif` };

function baseOptions(extra = {}) {
  return {
    responsive: false, animation: false, devicePixelRatio: 1,
    layout: { padding: 14 },
    font: FONT,
    plugins: { legend: { position: 'bottom', labels: { color: '#16233F', font: { ...FONT, size: 13 } } }, title: { display: false }, datalabels: { display: false } },
    ...extra,
  };
}
function barChart(labels, data, opts = {}) {
  const total = data.reduce((a, b) => a + b, 0);
  return renderChartPng({
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: CHART_PALETTE[opts.colorIndex ?? 0], borderRadius: 6, maxBarThickness: 34 }] },
    options: baseOptions({
      indexAxis: opts.horizontal ? 'y' : 'x',
      plugins: {
        legend: { display: false },
        datalabels: { display: true, anchor: 'end', align: opts.horizontal ? 'end' : 'top', color: '#16233F', font: { ...FONT, weight: 'bold', size: 12 }, formatter: (v) => (total ? `${v} (${Math.round((v / total) * 100)}%)` : v) },
      },
      scales: { x: { grid: { display: false }, ticks: { color: '#16233F', font: FONT } }, y: { beginAtZero: true, grid: { color: '#EEF1F6' }, ticks: { color: '#16233F', font: FONT } } },
    }),
  });
}
function lineChart(labels, data) {
  return renderChartPng({
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: CHART_PALETTE[0], backgroundColor: 'rgba(225,29,42,0.10)', borderWidth: 2.5, fill: true, tension: 0.35, pointRadius: 2, pointBackgroundColor: CHART_PALETTE[0] }] },
    options: baseOptions({ plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#16233F', font: FONT } }, y: { beginAtZero: true, grid: { color: '#EEF1F6' }, ticks: { color: '#16233F', font: FONT } } } }),
  });
}
function pieChart(labels, data) {
  const total = data.reduce((a, b) => a + b, 0);
  return renderChartPng({
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: CHART_PALETTE, borderColor: '#FFFFFF', borderWidth: 3 }] },
    options: baseOptions({
      cutout: '60%',
      plugins: { datalabels: { display: (c) => (total ? c.dataset.data[c.dataIndex] / total >= 0.06 : false), color: '#FFFFFF', font: { ...FONT, weight: 'bold', size: 13 }, formatter: (v) => `${Math.round((v / total) * 100)}%` } },
    }),
  });
}

// --- Agrégations ------------------------------------------------------------
function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const raw = r[key];
    const label = raw === null || raw === undefined || raw === '' ? 'Non renseigné' : String(raw);
    m.set(label, (m.get(label) || 0) + 1);
  }
  return m;
}
function topN(map, n) { return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); }
function average(nums) { const v = nums.filter((n) => typeof n === 'number' && !isNaN(n)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
const lc = (v) => String(v || '').toLowerCase();

function analyzeOperations(rows) {
  const statusCounts = countBy(rows, 'status');
  const zoneCounts = topN(countBy(rows, 'destination_zone'), 8);
  const driverCounts = topN(countBy(rows, 'driver_reference'), 8);
  const byDay = new Map();
  for (const r of rows) { const d = parseIsoToDate(r.created_at); if (!d) continue; const k = d.toISOString().slice(0, 10); byDay.set(k, (byDay.get(k) || 0) + 1); }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const total = rows.length;
  const delivered = rows.filter((r) => lc(r.status).includes('livr') || lc(r.status) === 'delivered').length;
  return { kpis: [
    { label: 'Commandes totales', value: total }, { label: 'Livrées', value: delivered },
    { label: 'Taux de livraison', value: `${total ? ((delivered / total) * 100).toFixed(1) : '0.0'} %` },
    { label: 'Zones actives', value: zoneCounts.length },
  ], charts: { statusCounts, zoneCounts, driverCounts, days } };
}
function analyzeCustomers(rows) {
  const topClients = topN(new Map(rows.map((r) => [r.customer_name || r.customer_reference || 'Client', Number(r.order_count) || 0])), 10);
  const zoneCounts = topN(countBy(rows, 'destination_zone'), 8);
  const now = Date.now(); const NINETY = 90 * 864e5; let active = 0, inactive = 0;
  for (const r of rows) { const d = parseIsoToDate(r.last_order_at); if (d && now - d.getTime() <= NINETY) active++; else inactive++; }
  return { kpis: [
    { label: 'Clients totaux', value: rows.length }, { label: 'Actifs (90 j.)', value: active }, { label: 'Inactifs (90 j.)', value: inactive },
  ], charts: { topClients, zoneCounts, activity: new Map([['Actifs', active], ['Inactifs', inactive]]) } };
}
function analyzeIncidents(rows) {
  const typeCounts = countBy(rows, 'category');
  const statusCounts = countBy(rows, 'status');
  const mins = rows.map((r) => { const o = parseIsoToDate(r.opened_at); const s = parseIsoToDate(r.resolved_at); return o && s ? (s - o) / 60000 : null; }).filter((v) => v !== null && v >= 0);
  const avg = average(mins);
  return { kpis: [
    { label: 'Incidents totaux', value: rows.length },
    { label: 'Résolus', value: rows.filter((r) => lc(r.status).includes('resol') || lc(r.status).includes('résol')).length },
    { label: 'Délai moyen de résolution', value: avg > 0 ? `${(avg / 60).toFixed(1)} h` : 'N/A' },
  ], charts: { typeCounts, statusCounts } };
}
function analyzeRoutes(rows) {
  const byRoute = rows.map((r) => ({ label: r.run_reference || 'Tournée', stops: Number(r.stop_count) || 0, orders: Number(r.order_count) || 0 })).slice(0, 15);
  const total = rows.length;
  const completed = rows.filter((r) => lc(r.status).includes('termin') || lc(r.status) === 'completed').length;
  return { kpis: [
    { label: 'Tournées totales', value: total }, { label: 'Terminées', value: completed },
    { label: 'Taux de complétion', value: `${total ? ((completed / total) * 100).toFixed(1) : '0.0'} %` },
  ], charts: { byRoute, statusCounts: countBy(rows, 'status') } };
}
function analyzeDataset(key, rows) {
  if (key === 'operations') return analyzeOperations(rows);
  if (key === 'customers') return analyzeCustomers(rows);
  if (key === 'incidents') return analyzeIncidents(rows);
  if (key === 'routes') return analyzeRoutes(rows);
  return { kpis: [], charts: {} };
}

function buildChartsFor(key, a) {
  const c = a.charts; const out = [];
  const mapKeys = (m) => [...m.keys()]; const mapVals = (m) => [...m.values()];
  if (key === 'operations') {
    if (c.statusCounts.size) out.push({ title: 'Répartition des commandes par statut', buffer: pieChart(mapKeys(c.statusCounts), mapVals(c.statusCounts)) });
    if (c.days.length) out.push({ title: 'Volume de commandes par jour', buffer: lineChart(c.days.map(([d]) => d.slice(5)), c.days.map(([, n]) => n)) });
    if (c.zoneCounts.length) out.push({ title: 'Top zones de livraison', buffer: barChart(c.zoneCounts.map((x) => x[0]), c.zoneCounts.map((x) => x[1]), { horizontal: true, colorIndex: 0 }) });
    if (c.driverCounts.length) out.push({ title: 'Top livreurs (nb de commandes)', buffer: barChart(c.driverCounts.map((x) => x[0]), c.driverCounts.map((x) => x[1]), { horizontal: true, colorIndex: 1 }) });
  } else if (key === 'customers') {
    if (c.topClients.length) out.push({ title: 'Top clients (nb de commandes)', buffer: barChart(c.topClients.map((x) => x[0]), c.topClients.map((x) => x[1]), { horizontal: true }) });
    if (c.zoneCounts.length) out.push({ title: 'Répartition des clients par zone', buffer: pieChart(c.zoneCounts.map((x) => x[0]), c.zoneCounts.map((x) => x[1])) });
    out.push({ title: 'Clients actifs vs inactifs (90 jours)', buffer: pieChart(mapKeys(c.activity), mapVals(c.activity)) });
  } else if (key === 'incidents') {
    if (c.typeCounts.size) out.push({ title: 'Incidents par type', buffer: barChart(mapKeys(c.typeCounts), mapVals(c.typeCounts)) });
    if (c.statusCounts.size) out.push({ title: 'Incidents par statut', buffer: pieChart(mapKeys(c.statusCounts), mapVals(c.statusCounts)) });
  } else if (key === 'routes') {
    if (c.byRoute.length) {
      out.push({ title: 'Arrêts par tournée', buffer: barChart(c.byRoute.map((r) => r.label), c.byRoute.map((r) => r.stops), { colorIndex: 0 }) });
      out.push({ title: 'Commandes par tournée', buffer: barChart(c.byRoute.map((r) => r.label), c.byRoute.map((r) => r.orders), { colorIndex: 1 }) });
    }
    if (c.statusCounts.size) out.push({ title: 'Statut des tournées', buffer: pieChart(mapKeys(c.statusCounts), mapVals(c.statusCounts)) });
  }
  return out;
}

// --- Feuilles ---------------------------------------------------------------
function isIdentifier(key) { return /(^id$|_id$|^reference$|_reference$|_id_)/i.test(key); }
function widthFor(col) {
  if (isIdentifier(col.key)) return 16;
  if (col.type === 'date') return 18;
  if (col.type === 'nombre') return 14;
  if (/adresse|instructions/i.test(col.key)) return 40;
  return 20;
}

function buildCoverSheet(wb, { meta, rowCount, datasetKey, logoImageId }) {
  const sheet = wb.addWorksheet('Couverture', { properties: { tabColor: { argb: BRAND.navy } }, views: [{ showGridLines: false }] });
  sheet.columns = [{ width: 4 }, { width: 46 }, { width: 46 }, { width: 4 }];
  sheet.mergeCells('A1:D3');
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.navy } };
  if (logoImageId !== null && logoImageId !== undefined) {
    sheet.addImage(logoImageId, { tl: { col: 0.3, row: 0.4 }, ext: { width: 210, height: 56 } });
  } else {
    // Repli sans logo : on écrit le mot-symbole dans le bandeau déjà fusionné
    // (A1:D3) — pas de seconde fusion (sinon « already merged »).
    const t = sheet.getCell('A1'); t.value = 'TRAXO'; t.font = { size: 28, bold: true, color: { argb: BRAND.white } }; t.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
  }
  sheet.mergeCells('A5:D5');
  const title = sheet.getCell('A5');
  title.value = safeText(meta.title) || `Rapport — ${DATASET_TITLES[datasetKey] || datasetKey}`;
  title.font = { size: 18, bold: true, color: { argb: BRAND.navy } };
  sheet.mergeCells('A6:D6');
  sheet.getCell('A6').value = safeText(meta.companyName) || '';
  sheet.getCell('A6').font = { size: 13, color: { argb: 'FF444444' } };
  const info = [
    ['Période', `${formatFrDate(meta.periodFrom)}  →  ${formatFrDate(meta.periodTo)}`],
    ['Généré le', formatFrDateTime(meta.generatedAt || new Date().toISOString())],
    ['Nombre de lignes', String(rowCount)],
    ['Source', DATASET_TITLES[datasetKey] || datasetKey],
  ];
  let r = 9;
  for (const [label, value] of info) {
    const l = sheet.getCell(`B${r}`); l.value = label; l.font = { bold: true, color: { argb: BRAND.navy } };
    sheet.getCell(`C${r}`).value = value; r += 1;
  }
  sheet.mergeCells(`A${r + 2}:D${r + 2}`);
  const f = sheet.getCell(`A${r + 2}`);
  f.value = 'Document généré automatiquement par TRAXO — confidentiel, usage interne.';
  f.font = { italic: true, size: 9, color: { argb: 'FF888888' } };
}

function buildDataSheet(wb, { rows, columns }) {
  const sheet = wb.addWorksheet('Données', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((col) => ({ header: col.label, key: col.key, width: widthFor(col) }));
  const head = sheet.getRow(1); head.height = 22;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.navy } };
    cell.font = { bold: true, color: { argb: BRAND.white }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  const statusColIdx = columns.findIndex((c) => /statut|status/i.test(c.key));
  rows.forEach((row, idx) => {
    const xr = sheet.getRow(idx + 2);
    columns.forEach((col, ci) => {
      const cell = xr.getCell(ci + 1);
      const raw = row[col.key];
      if (col.type === 'date') {
        const d = parseIsoToDate(raw);
        cell.value = d;
        cell.numFmt = isoHasTime(raw) ? DATETIME_FMT : DATE_FMT;
      } else if (col.type === 'nombre') {
        const n = Number(raw); cell.value = isNaN(n) || raw === null || raw === undefined ? null : n; cell.alignment = { horizontal: 'right' };
      } else {
        cell.value = safeText(raw) ?? '';
        if (isIdentifier(col.key)) cell.numFmt = '@';
      }
    });
    if (idx % 2 === 1) xr.eachCell({ includeEmpty: true }, (cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.zebra } }; });
    if (statusColIdx !== -1) {
      const label = safeText(row[columns[statusColIdx].key]);
      if (label) {
        const color = STATUS_BADGE_COLORS[lc(label).trim()] || 'FFB0B7C3';
        xr.getCell(statusColIdx + 1).value = { richText: [
          { font: { color: { argb: color }, size: 12 }, text: '● ' },
          { font: { color: { argb: BRAND.navy } }, text: label },
        ] };
      }
    }
    xr.eachCell({ includeEmpty: true }, (cell) => { cell.border = { bottom: { style: 'hair', color: { argb: BRAND.border } } }; });
  });
  const lastCol = sheet.getColumn(columns.length).letter;
  sheet.autoFilter = { from: 'A1', to: `${lastCol}1` };
}

const KPI_ACCENTS = [BRAND.red, BRAND.navy, 'FFF2A900', 'FF2E86AB'];
function buildDashboardSheet(wb, { datasetKey, analysis, charts }) {
  const sheet = wb.addWorksheet('Tableau de bord', { views: [{ showGridLines: false }], properties: { tabColor: { argb: BRAND.red } } });
  sheet.getColumn(1).width = 2.5;
  for (let i = 2; i <= 14; i++) sheet.getColumn(i).width = 11;
  sheet.mergeCells('B2:N2');
  const title = sheet.getCell('B2'); title.value = `Tableau de bord — ${DATASET_TITLES[datasetKey] || datasetKey}`; title.font = { size: 17, bold: true, color: { argb: BRAND.navy } };
  sheet.mergeCells('B3:N3'); sheet.getCell('B3').border = { bottom: { style: 'medium', color: { argb: BRAND.red } } };

  let kpiCol = 2; const kpiRow = 5; const kpiH = 3;
  analysis.kpis.forEach((kpi, i) => {
    const accent = sheet.getColumn(kpiCol).letter; const bs = sheet.getColumn(kpiCol + 1).letter; const be = sheet.getColumn(kpiCol + 2).letter;
    sheet.mergeCells(`${accent}${kpiRow}:${accent}${kpiRow + kpiH - 1}`);
    sheet.getColumn(kpiCol).width = 1.2;
    sheet.getCell(`${accent}${kpiRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KPI_ACCENTS[i % KPI_ACCENTS.length] } };
    sheet.mergeCells(`${bs}${kpiRow}:${be}${kpiRow + kpiH - 1}`);
    const body = sheet.getCell(`${bs}${kpiRow}`);
    body.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.white } };
    body.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 };
    body.value = { richText: [
      { font: { bold: true, size: 18, color: { argb: BRAND.navy } }, text: `${kpi.value}\n` },
      { font: { size: 10, color: { argb: BRAND.muted } }, text: String(kpi.label).toUpperCase() },
    ] };
    ['top', 'bottom', 'right'].forEach((side) => { body.border = { ...body.border, [side]: { style: 'thin', color: { argb: BRAND.border } } }; });
    kpiCol += 4;
  });

  const cardCols = 6; const cardRows = 17; let row = kpiRow + kpiH + 2; let col = 2;
  for (const chart of charts) {
    const s = sheet.getColumn(col).letter; const e = sheet.getColumn(col + cardCols - 1).letter;
    sheet.mergeCells(`${s}${row}:${e}${row + cardRows - 1}`);
    const card = sheet.getCell(`${s}${row}`);
    card.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.white } };
    card.border = { top: { style: 'thin', color: { argb: BRAND.border } }, bottom: { style: 'thin', color: { argb: BRAND.border } }, left: { style: 'thin', color: { argb: BRAND.border } }, right: { style: 'thin', color: { argb: BRAND.border } } };
    card.alignment = { vertical: 'top', horizontal: 'left', indent: 1 };
    sheet.getRow(row).height = 20;
    card.value = chart.title; card.font = { bold: true, color: { argb: BRAND.navy }, size: 11 };
    const imgId = wb.addImage({ buffer: chart.buffer, extension: 'png' });
    sheet.addImage(imgId, { tl: { col: col - 1 + 0.15, row: row + 0.6 }, ext: { width: CHART_W * 0.42, height: CHART_H * 0.42 } });
    if (col === 2) { col = 2 + cardCols + 1; } else { col = 2; row += cardRows + 2; }
  }
}

// --- API --------------------------------------------------------------------
async function buildPremiumWorkbook({ datasetKey, rows, meta = {}, columns, options = {} }) {
  if (!['operations', 'customers', 'incidents', 'routes'].includes(datasetKey)) throw new Error(`datasetKey invalide : ${datasetKey}`);
  if (!Array.isArray(rows)) throw new Error('rows doit être un tableau');
  if (!Array.isArray(columns) || columns.length === 0) throw new Error('columns doit être un tableau non vide');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'TRAXO'; wb.created = new Date(); wb.properties.date1904 = false;

  let logoImageId = null;
  if (options.logoBuffer) { try { logoImageId = wb.addImage({ buffer: options.logoBuffer, extension: 'png' }); } catch { logoImageId = null; } }

  const analysis = analyzeDataset(datasetKey, rows);
  const charts = buildChartsFor(datasetKey, analysis);

  buildCoverSheet(wb, { meta, rowCount: rows.length, datasetKey, logoImageId });
  buildDataSheet(wb, { rows, columns });
  buildDashboardSheet(wb, { datasetKey, analysis, charts });

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(arr) ? arr : Buffer.from(arr);
}

module.exports = { buildPremiumWorkbook };
