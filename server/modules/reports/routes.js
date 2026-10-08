// Rapports et exports : espace d'export unifié (Commandes, Tournées, Incidents,
// Clients), essai Excel, exports CRM sécurisés (XLSX/CSV) et indicateurs CRM.
// Lecture seule : le contrat d'export (lib/crm-export-contract.js) valide les
// filtres ; chaque export est journalisé (crm_export_logs).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { calculateCrmMetrics } = require('../../../lib/crm-metrics');
const {
  createExportContract,
  ExportContractError,
  DATASETS: EXPORT_DATASETS,
  OPERATIONAL_LIMITS: EXPORT_LIMITS,
  columnLabel: exportColumnLabel,
  DATASET_COLUMN_DEFS: EXPORT_COLUMN_DEFS,
} = require('../../../lib/crm-export-contract');
const { buildWorkbook: buildExportWorkbook } = require('../../../lib/crm-xlsx');
const {
  buildOperationsExportQuery,
  normalizeExportRow,
  OPERATIONS_NUMERIC_COLUMNS,
} = require('../../../lib/crm-operations-export');
const {
  buildCustomersExportQuery,
  CUSTOMERS_NUMERIC_COLUMNS,
  buildIncidentsExportQuery,
  INCIDENTS_NUMERIC_COLUMNS,
  buildRoutesExportQuery,
  ROUTES_NUMERIC_COLUMNS,
} = require('../../../lib/crm-dataset-exports');
const { buildPremiumWorkbook } = require('../../../lib/crm-premium-xlsx');
const reportBundle = require('../../../lib/report-bundle');
const { BillingError } = require('../billing/service');

const EXPORT_DATASET_TITLES = { operations: 'Commandes', customers: 'Clients', incidents: 'Incidents', routes: 'Tournées' };
// Logo chargé une fois pour la couverture des exports premium (repli sans logo).
let premiumLogoBuffer = null;
try { premiumLogoBuffer = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'brand', 'traxo-email.png')); } catch (_) { premiumLogoBuffer = null; }
// Jeux de données câblés pour l'export (requête + colonnes numériques).
const EXPORT_QUERY_BUILDERS = {
  operations: { build: buildOperationsExportQuery, numeric: OPERATIONS_NUMERIC_COLUMNS },
  customers: { build: buildCustomersExportQuery, numeric: CUSTOMERS_NUMERIC_COLUMNS },
  incidents: { build: buildIncidentsExportQuery, numeric: INCIDENTS_NUMERIC_COLUMNS },
  routes: { build: buildRoutesExportQuery, numeric: ROUTES_NUMERIC_COLUMNS },
};

module.exports = function registerReports(app, deps) {
  const {
    pool, asyncRoute, requireCompanyApi, requireCompanyRoles, withCompanyTransaction,
    writeAudit, serializeMetricRows, runQueries, crmReportingPeriod, billing,
  } = deps;

  // Read-only. The export contract (lib/crm-export-contract.js) validates the
  // request, enforces role/period/column rules and formula neutralization; the
  // generator (lib/crm-xlsx.js) writes the workbook. Only the `operations`
  // dataset is wired for now; other datasets are validated by the contract but
  // their queries are not implemented yet.


  async function recordExportLog(auth, contract, status, outcome = {}) {
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO export_logs
           (company_id, actor_user_id, dataset, role, status, purpose, period_from, period_to,
            columns, filters, row_count, worksheet_count, artifact_bytes, artifact_sha256,
            request_fingerprint_sha256, failure_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          auth?.company_id || null,
          auth?.user_id || null,
          contract?.dataset || outcome.dataset || 'unknown',
          contract?.role || auth?.role || 'unknown',
          status,
          contract?.purpose || null,
          contract?.period?.from || null,
          contract?.period?.to || null,
          contract ? JSON.stringify(contract.columns) : null,
          contract ? JSON.stringify(contract.filters) : null,
          Number.isInteger(outcome.rowCount) ? outcome.rowCount : null,
          Number.isInteger(outcome.worksheetCount) ? outcome.worksheetCount : null,
          Number.isInteger(outcome.artifactBytes) ? outcome.artifactBytes : null,
          outcome.artifactSha256 || null,
          contract?.requestFingerprintSha256 || null,
          outcome.failureCode || null,
        ]
      );
    } catch (error) {
      // An export audit failure must not break the response, but should be visible.
      console.warn('Échec d’écriture du journal d’export :', error.message);
    }
  }

  // Sérialise les lignes normalisées de l'export en CSV (RFC 4180), avec BOM
  // UTF-8 pour qu'Excel ouvre les accents correctement. En-têtes localisés FR,
  // données lues par clé technique.
  function buildExportCsv(headerLabels, columnKeys, rows) {
    const esc = (value) => {
      const s = value == null ? '' : String(value);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = headerLabels.map(esc).join(',');
    const body = rows.map((row) => columnKeys.map((column) => esc(row[column])).join(',')).join('\r\n');
    return `﻿${header}${body ? `\r\n${body}` : ''}`;
  }

  // ---- Rapports unifiés (Commandes, Tournées, Incidents, Clients) ----------
  // Rapport Premium (Excel enrichi) : rapports offerts, puis payés depuis le
  // portefeuille (voir billing/service.js). Le CSV et le SVG restent gratuits.
  const excelAccess = (companyId) => (billing ? billing.premiumStatus(companyId) : Promise.resolve(null));
  const canPayPremium = (auth) => ['owner', 'manager'].includes(String(auth.role || ''));
  function reportErrorResponse(res, error) {
    if (error instanceof reportBundle.ReportError) return res.status(error.status).json({ error: error.message, code: error.code });
    throw error;
  }
  const reportFiltersLabel = (sel, driverName) => [sel.zone ? `Zone : ${sel.zone}` : '', driverName ? `Livreur : ${driverName}` : '', sel.query ? `Recherche : « ${sel.query} »` : ''].filter(Boolean).join(' · ');

  app.get('/api/app/reports/options', requireCompanyApi, asyncRoute(async (req, res) => {
    const role = String(req.auth.role || '');
    const [zones, drivers, access] = await Promise.all([
      pool.query(
        `SELECT neighborhood AS zone, COUNT(*)::int AS n FROM orders
         WHERE company_id = $1 AND archived_at IS NULL AND neighborhood IS NOT NULL AND neighborhood <> '' AND created_at > NOW() - INTERVAL '400 days'
         GROUP BY neighborhood ORDER BY n DESC, neighborhood LIMIT 150`, [req.auth.company_id]),
      pool.query('SELECT id, name FROM drivers WHERE company_id = $1 ORDER BY active DESC, name LIMIT 300', [req.auth.company_id]),
      excelAccess(req.auth.company_id),
    ]);
    return res.json({
      families: reportBundle.FAMILY_KEYS.map((key) => ({ key, name: reportBundle.FAMILIES[key].name, allowed: reportBundle.FAMILIES[key].roles.includes(role), fields: reportBundle.FAMILIES[key].fields })),
      maxDays: { owner: 366, manager: 366, operator: 31 }[role] || 31,
      zones: zones.rows.map((r) => r.zone).sort((a, b) => a.localeCompare(b, 'fr')),
      drivers: drivers.rows.map((d) => ({ id: String(d.id), name: d.name })),
      excel: access,
      canPay: ['owner', 'manager'].includes(role),
      supportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(process.env.SUPPORT_EMAIL || '')) ? process.env.SUPPORT_EMAIL : 'support@gettraxo.app',
    });
  }));

  app.post('/api/app/reports/preview', requireCompanyApi, asyncRoute(async (req, res) => {
    let sel;
    try { sel = reportBundle.normalizeSelection(req.body, String(req.auth.role || '')); } catch (error) { return reportErrorResponse(res, error); }
    // L'aperçu ne compte que les lignes et n'envoie au navigateur que les colonnes choisies.
    try {
      const families = await withCompanyTransaction(pool, req.auth.company_id, (client) => reportBundle.loadSelection(client, req.auth.company_id, sel));
      return res.json({
        period: { from: sel.from, to: sel.to, label: reportBundle.periodLabel(sel) },
        total: families.reduce((a, x) => a + x.rows.length, 0),
        families: families.map((fam) => ({
          key: fam.key, name: fam.name, count: fam.rows.length, statuses: fam.statuses,
          fields: fam.fields.map((x) => x.key),
          rows: fam.rows.slice(0, reportBundle.PREVIEW_LIMIT).map((r) => Object.fromEntries(fam.fields.map((x) => [x.key, x.type === 'date' ? reportBundle.localStamp(r[x.key]) : r[x.key]]))),
          previewLimited: fam.rows.length > reportBundle.PREVIEW_LIMIT,
        })),
      });
    } catch (error) { return reportErrorResponse(res, error); }
  }));

  // Mois illimité du Rapport Premium, payé depuis le portefeuille.
  app.post('/api/app/reports/premium/month', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
    if (!billing) return res.status(503).json({ error: 'La facturation est momentanément indisponible.' });
    try {
      const out = await billing.buyPremiumMonth(req.auth.company_id, req.auth.user_id);
      await writeAudit(req.auth, 'company', req.auth.company_id, 'premium_month_bought', { until: out.monthUntil, amount: -out.entry.amount });
      return res.json(await excelAccess(req.auth.company_id));
    } catch (error) {
      if (error instanceof BillingError) return res.status(error.status).json({ error: error.message, code: error.code, excel: await excelAccess(req.auth.company_id) });
      throw error;
    }
  }));

  app.post('/api/app/reports/export', requireCompanyApi, asyncRoute(async (req, res) => {
    const auth = req.auth;
    const format = ['csv', 'svg', 'xlsx'].includes(req.body?.format) ? req.body.format : null;
    if (!format) return res.status(400).json({ error: 'Choisissez un format.', code: 'BAD_FORMAT' });
    let sel;
    try { sel = reportBundle.normalizeSelection(req.body, String(auth.role || '')); } catch (error) { return reportErrorResponse(res, error); }
    const payReport = req.body?.pay === 'report';
    if (format === 'xlsx') {
      const access = await excelAccess(auth.company_id);
      if (!access) return res.status(503).json({ error: 'L’Excel enrichi est momentanément indisponible. Le CSV et le SVG restent disponibles.' });
      if (access.state === 'paid') {
        if (!payReport) return res.status(402).json({ error: 'Vos rapports offerts sont utilisés. Ce rapport est payant.', code: 'premium_required', excel: access });
        if (!canPayPremium(auth)) return res.status(403).json({ error: 'Seuls le propriétaire et les responsables peuvent payer un rapport.', code: 'premium_forbidden', excel: access });
        if (!access.canPayReport) return res.status(402).json({ error: `Solde insuffisant : il faut ${access.reportPrice.toLocaleString('fr-FR')} F sur votre portefeuille.`, code: 'wallet_insufficient', excel: access });
      }
    }
    const logContract = { dataset: `rapport:${sel.sources.join('+')}`, role: auth.role, purpose: 'reporting', period: { from: sel.from, to: sel.to }, columns: sel.fields, filters: { zone: sel.zone, driver: sel.driver, status: sel.status, query: sel.query ? 'oui' : null, format } };
    let families;
    try {
      families = await withCompanyTransaction(pool, auth.company_id, (client) => reportBundle.loadSelection(client, auth.company_id, sel));
    } catch (error) {
      await recordExportLog(auth, logContract, 'failed', { failureCode: error.code || 'QUERY_FAILED' });
      return reportErrorResponse(res, error);
    }
    const total = families.reduce((a, x) => a + x.rows.length, 0);
    if (!total && format !== 'svg') {
      await recordExportLog(auth, logContract, 'failed', { failureCode: 'EMPTY' });
      return res.status(422).json({ error: 'Aucune donnée ne correspond à votre sélection.', code: 'EMPTY' });
    }
    const company = (await pool.query('SELECT name FROM companies WHERE id = $1', [auth.company_id])).rows[0] || {};
    const driverName = sel.driver ? (await pool.query('SELECT name FROM drivers WHERE id = $1 AND company_id = $2', [sel.driver, auth.company_id])).rows[0]?.name : null;
    const meta = { companyName: company.name || '', filtersLabel: reportFiltersLabel(sel, driverName) };
    const stamp = `${sel.from}_${sel.to}`;
    let buffer; let type; let name;
    if (format === 'csv' && families.length === 1) { buffer = Buffer.from(reportBundle.toCsv(families[0]), 'utf8'); type = 'text/csv; charset=utf-8'; name = `TRAXO_${families[0].file}_${stamp}.csv`; }
    else if (format === 'csv') { buffer = await reportBundle.toZip(families); type = 'application/zip'; name = `TRAXO_Export_${stamp}.zip`; }
    else if (format === 'svg') { buffer = Buffer.from(reportBundle.toSvg(families, sel, meta), 'utf8'); type = 'image/svg+xml'; name = `TRAXO_Synthese_${stamp}.svg`; }
    else { buffer = await reportBundle.toXlsx(families, sel, meta); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; name = `TRAXO_Bilan_activite_${stamp}.xlsx`; }
    // Rapport Premium : décompté seulement une fois le classeur produit.
    let premiumVia = null;
    if (format === 'xlsx') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const used = await billing.consumePremiumReport(client, auth.company_id, { pay: payReport && canPayPremium(auth) ? 'report' : null, userId: auth.user_id, note: `Rapport ${stamp}` });
        await client.query('COMMIT');
        premiumVia = used.via;
      } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof BillingError) {
          await recordExportLog(auth, logContract, 'failed', { failureCode: error.code });
          return res.status(error.status).json({ error: error.message, code: error.code, excel: await excelAccess(auth.company_id) });
        }
        throw error;
      } finally {
        client.release();
      }
    }
    await recordExportLog(auth, logContract, 'completed', {
      rowCount: total, worksheetCount: format === 'xlsx' ? families.length + 1 : families.length,
      artifactBytes: buffer.length, artifactSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    });
    res.set('Content-Type', type);
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.set('Cache-Control', 'no-store');
    res.set('X-Export-Rows', String(total));
    if (premiumVia) res.set('X-Premium-Via', premiumVia);
    return res.send(buffer);
  }));

  app.post('/api/app/crm/exports', requireCompanyApi, asyncRoute(async (req, res) => {
    const auth = req.auth;
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    let contract;
    try {
      contract = createExportContract({
        companyId: String(auth.company_id),
        actorId: String(auth.user_id),
        role: String(auth.role || ''),
        dataset: body.dataset,
        purpose: body.purpose,
        requestedAt: new Date().toISOString(),
        period: body.period,
        filters: body.filters,
        sensitiveColumns: body.sensitiveColumns,
      });
    } catch (error) {
      if (error instanceof ExportContractError) {
        await recordExportLog(auth, null, 'failed', { dataset: body.dataset, failureCode: error.code });
        return res.status(422).json({ error: error.message, code: error.code, details: error.details });
      }
      throw error;
    }

    const wiredDataset = EXPORT_QUERY_BUILDERS[contract.dataset];
    if (!wiredDataset) {
      await recordExportLog(auth, contract, 'failed', { failureCode: 'DATASET_NOT_WIRED' });
      return res.status(400).json({
        error: `L’export du jeu de données « ${contract.dataset} » n’est pas encore disponible.`,
        code: 'DATASET_NOT_WIRED',
      });
    }

    let rows;
    try {
      rows = await withCompanyTransaction(pool, auth.company_id, async (client) => {
        const query = wiredDataset.build(contract, auth.company_id);
        const result = await client.query(query.text, query.values);
        return result.rows;
      });
    } catch (error) {
      await recordExportLog(auth, contract, 'failed', { failureCode: 'QUERY_FAILED' });
      throw error;
    }

    if (rows.length > EXPORT_LIMITS.maxDataRowsPerWorkbook) {
      await recordExportLog(auth, contract, 'failed', { failureCode: 'EXPORT_TOO_LARGE' });
      return res.status(413).json({
        error: 'Export trop volumineux : réduisez la période ou les filtres. Aucun tronquage n’est appliqué.',
        code: 'EXPORT_TOO_LARGE',
      });
    }

    const normalizedRows = rows.map((row) => normalizeExportRow(row, wiredDataset.numeric));
    const format = ['csv', 'premium'].includes(body.format) ? body.format : 'xlsx';
    // En-têtes en français (source unique : DATASET_COLUMN_DEFS du contrat).
    const headerLabels = contract.columns.map((key) => exportColumnLabel(contract.dataset, key));

    // Fabrique l'artefact selon le format demandé (XLSX audité, CSV, ou
    // « premium » : classeur brandé avec graphiques via ExcelJS).
    let artifact;
    try {
      if (format === 'csv') {
        const csv = buildExportCsv(headerLabels, contract.columns, normalizedRows);
        const buffer = Buffer.from(csv, 'utf8');
        artifact = {
          buffer,
          contentType: 'text/csv; charset=utf-8',
          ext: 'csv',
          totalRows: normalizedRows.length,
          worksheetCount: 1,
          artifactBytes: buffer.length,
          artifactSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        };
      } else if (format === 'premium') {
        const defs = EXPORT_COLUMN_DEFS[contract.dataset] || {};
        const columns = contract.columns.map((key) => ({
          key,
          label: exportColumnLabel(contract.dataset, key),
          type: (defs[key] && defs[key].type) || 'texte',
        }));
        const companyRow = await pool.query('SELECT name FROM companies WHERE id = $1', [auth.company_id]);
        const buffer = await buildPremiumWorkbook({
          datasetKey: contract.dataset,
          rows: normalizedRows,
          columns,
          meta: {
            companyName: companyRow.rows[0]?.name || '',
            title: `Rapport ${EXPORT_DATASET_TITLES[contract.dataset] || contract.dataset}`,
            periodFrom: contract.period.from,
            periodTo: contract.period.to,
            generatedAt: new Date().toISOString(),
          },
          options: premiumLogoBuffer ? { logoBuffer: premiumLogoBuffer } : {},
        });
        artifact = {
          buffer,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ext: 'xlsx',
          totalRows: normalizedRows.length,
          worksheetCount: 3,
          artifactBytes: buffer.length,
          artifactSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        };
      } else {
        const workbook = buildExportWorkbook(contract, normalizedRows, { headerLabels });
        artifact = {
          buffer: workbook.buffer,
          contentType: workbook.contentType,
          ext: 'xlsx',
          totalRows: workbook.totalRows,
          worksheetCount: workbook.worksheetCount,
          artifactBytes: workbook.artifactBytes,
          artifactSha256: workbook.artifactSha256,
        };
      }
    } catch (error) {
      if (error instanceof ExportContractError) {
        await recordExportLog(auth, contract, 'failed', { failureCode: error.code });
        return res.status(422).json({ error: error.message, code: error.code, details: error.details });
      }
      throw error;
    }

    const sensitiveIncluded = contract.columns.some((column) => (
      EXPORT_DATASETS[contract.dataset].sensitiveColumns.includes(column)
    ));
    await recordExportLog(auth, contract, 'downloaded', {
      rowCount: artifact.totalRows,
      worksheetCount: artifact.worksheetCount,
      artifactBytes: artifact.artifactBytes,
      artifactSha256: artifact.artifactSha256,
    });
    await writeAudit(auth, 'export', null, 'crm_export_downloaded', {
      dataset: contract.dataset,
      role: contract.role,
      purpose: contract.purpose,
      period: contract.period,
      format,
      rowCount: artifact.totalRows,
      sensitiveIncluded,
      artifactSha256: artifact.artifactSha256,
      requestFingerprint: contract.requestFingerprintSha256,
    });

    const filename = `export-${contract.dataset}-${contract.period.from}_${contract.period.to}.${artifact.ext}`;
    res.set('Content-Type', artifact.contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Export-Row-Count', String(artifact.totalRows));
    res.set('X-Export-Bytes', String(artifact.artifactBytes));
    return res.send(artifact.buffer);
  }));

  app.get('/api/app/crm/metrics', requireCompanyApi, asyncRoute(async (req, res) => {
    let period;
    try {
      period = crmReportingPeriod(req.query);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ error: error.message });
    }
    const companyId = req.auth.company_id;
    const arrays = await withCompanyTransaction(pool, companyId, async (client) => {
      const [orders, statusEvents, paymentAccounts, paymentEvents, paymentAdjustments, incidents, drivers, runs, stops] = await runQueries(client, [
        () => client.query(
          `SELECT id, company_id, driver_id, status, created_at, updated_at
           FROM orders WHERE company_id = $1 AND created_at < $2::timestamptz`,
          [companyId, period.endExclusive]
        ),
        () => client.query(
          `SELECT id, company_id, order_id, from_status, to_status, created_at
           FROM order_status_events WHERE company_id = $1 AND created_at < $2::timestamptz`,
          [companyId, period.endExclusive]
        ),
        () => client.query(
          `SELECT id, company_id, order_id, expected_amount_minor, currency, status, created_at
           FROM order_payment_accounts WHERE company_id = $1`,
          [companyId]
        ),
        () => client.query(
          `SELECT id, company_id, order_id, event_type, amount_minor, currency, created_at
           FROM payment_events
           WHERE company_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
          [companyId, period.startInclusive, period.endExclusive]
        ),
        () => client.query(
          `SELECT id, company_id, order_id, adjustment_type, direction, amount_minor,
                  currency, effective_date, created_at
           FROM payment_adjustments
           WHERE company_id = $1 AND effective_date >= $2::date AND effective_date <= $3::date`,
          [companyId, period.from, period.to]
        ),
        () => client.query(
          `SELECT id, company_id, order_id, category, status, created_at, resolved_at
           FROM delivery_incidents WHERE company_id = $1 AND created_at <= $2::timestamptz`,
          [companyId, period.asOf]
        ),
        () => client.query(
          `SELECT id, company_id, active, availability_status, created_at, updated_at
           FROM drivers WHERE company_id = $1`,
          [companyId]
        ),
        () => client.query(
          `SELECT id, company_id, driver_id, status, service_date, started_at,
                  completed_at, cancelled_at, created_at, updated_at
           FROM delivery_runs WHERE company_id = $1 AND created_at <= $2::timestamptz`,
          [companyId, period.asOf]
        ),
        () => client.query(
          `SELECT id, company_id, run_id, order_id, assignment_active, removed_at,
                  created_at, updated_at
           FROM delivery_stops WHERE company_id = $1 AND created_at <= $2::timestamptz`,
          [companyId, period.asOf]
        ),
      ]);
      return {
        orders: serializeMetricRows(orders.rows),
        statusEvents: serializeMetricRows(statusEvents.rows),
        paymentAccounts: serializeMetricRows(paymentAccounts.rows),
        paymentEvents: serializeMetricRows(paymentEvents.rows),
        paymentAdjustments: serializeMetricRows(paymentAdjustments.rows),
        incidents: serializeMetricRows(incidents.rows),
        drivers: serializeMetricRows(drivers.rows),
        runs: serializeMetricRows(runs.rows),
        stops: serializeMetricRows(stops.rows),
      };
    });
    try {
      return res.json(calculateCrmMetrics({
        companyId,
        period: { startInclusive: period.startInclusive, endExclusive: period.endExclusive },
        asOf: period.asOf,
        ...arrays,
      }));
    } catch (error) {
      console.error('CRM metrics calculation failed:', error.message);
      return res.status(500).json({ error: 'Impossible de calculer ce rapport avec les données disponibles.' });
    }
  }));

  return { buildExportCsv };
};
