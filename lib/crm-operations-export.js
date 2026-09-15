'use strict';

// Pure, database-free helpers for the CRM "operations" export. Kept out of
// server.js so the SQL shape (column selection, parameter numbering, filters)
// and the row normalization can be unit-tested without a live database.

const { OPERATIONAL_LIMITS } = require('./crm-export-contract');

const OPERATIONS_EXPORT_SQL = Object.freeze({
  order_id: 'o.id',
  created_at: 'o.created_at',
  requested_window: 'o.requested_time',
  status: 'o.status',
  destination_zone: 'o.neighborhood',
  driver_reference: "('DRV-' || o.driver_id)",
  run_reference: "(CASE WHEN r.id IS NOT NULL THEN 'RUN-' || r.id ELSE NULL END)",
  delivered_at: 'o.completed_at',
  delivery_duration_minutes:
    '(CASE WHEN o.completed_at IS NOT NULL THEN ROUND(EXTRACT(EPOCH FROM (o.completed_at - o.created_at)) / 60.0) ELSE NULL END)',
  payment_status: 'pa.status',
  incident_count: 'COALESCE(inc.cnt, 0)',
  customer_name: 'o.customer_name',
  customer_phone: 'o.customer_phone',
  delivery_address: 'o.delivery_address',
  delivery_instructions: 'o.notes',
});

const OPERATIONS_EXPORT_FILTER_SQL = Object.freeze({
  status: 'o.status',
  destination_zone: 'o.neighborhood',
  driver_reference: "('DRV-' || o.driver_id)",
  run_reference: "(CASE WHEN r.id IS NOT NULL THEN 'RUN-' || r.id ELSE NULL END)",
  payment_status: 'pa.status',
});

// Metric columns kept numeric in the spreadsheet. Identifiers such as order_id
// stay text so large BIGINT values are never rounded.
const OPERATIONS_NUMERIC_COLUMNS = new Set(['delivery_duration_minutes', 'incident_count']);

function buildOperationsExportQuery(contract, companyId) {
  const selectList = contract.columns
    .map((column) => `${OPERATIONS_EXPORT_SQL[column]} AS "${column}"`)
    .join(', ');
  const values = [
    companyId,
    `${contract.period.from}T00:00:00Z`,
    `${contract.period.to}T00:00:00Z`,
  ];
  const where = [
    'o.company_id = $1',
    'o.created_at >= $2::timestamptz',
    'o.created_at < $3::timestamptz',
  ];
  for (const [key, expr] of Object.entries(OPERATIONS_EXPORT_FILTER_SQL)) {
    if (!Object.prototype.hasOwnProperty.call(contract.filters, key)) continue;
    const value = contract.filters[key];
    if (Array.isArray(value)) {
      values.push(value.map((item) => (item === null ? null : String(item))));
      where.push(`${expr} = ANY($${values.length}::text[])`);
    } else {
      values.push(value === null ? null : String(value));
      where.push(`${expr} = $${values.length}`);
    }
  }
  const text = `
    SELECT ${selectList}
    FROM orders o
    LEFT JOIN order_payment_accounts pa ON pa.order_id = o.id AND pa.company_id = o.company_id
    LEFT JOIN delivery_stops ds ON ds.order_id = o.id AND ds.company_id = o.company_id AND ds.assignment_active = TRUE
    LEFT JOIN delivery_runs r ON r.id = ds.run_id AND r.company_id = o.company_id
    LEFT JOIN (
      SELECT order_id, COUNT(*)::int AS cnt
      FROM delivery_incidents WHERE company_id = $1 GROUP BY order_id
    ) inc ON inc.order_id = o.id
    WHERE ${where.join(' AND ')}
    ORDER BY o.id
    LIMIT ${OPERATIONAL_LIMITS.maxDataRowsPerWorkbook + 1}
  `;
  return { text, values };
}

function normalizeExportRow(row, numericColumns = OPERATIONS_NUMERIC_COLUMNS) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      normalized[key] = value.toISOString();
    } else if (numericColumns.has(key) && value !== null && value !== undefined) {
      normalized[key] = Number(value);
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

module.exports = {
  OPERATIONS_EXPORT_SQL,
  OPERATIONS_EXPORT_FILTER_SQL,
  OPERATIONS_NUMERIC_COLUMNS,
  buildOperationsExportQuery,
  normalizeExportRow,
};
