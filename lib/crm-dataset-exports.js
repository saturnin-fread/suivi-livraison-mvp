'use strict';

// Constructeurs de requêtes d'export pour les jeux de données « customers »,
// « incidents » et « routes » (tournées). Même contrat que crm-operations-export :
// pas d'accès base ici, uniquement la forme SQL (colonnes, filtres, période),
// pour rester testable et cohérent avec le contrat d'export.

const { OPERATIONAL_LIMITS } = require('./crm-export-contract');

const LIMIT = OPERATIONAL_LIMITS.maxDataRowsPerWorkbook + 1;

// Ajoute les filtres du contrat (égalité simple ou ANY) au WHERE, en réutilisant
// exactement la sémantique de l'export operations.
function applyContractFilters(filterSql, contract, values, where) {
  for (const [key, expr] of Object.entries(filterSql)) {
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
}

// --- Clients (dataset customers) ---
const CUSTOMERS_EXPORT_SQL = Object.freeze({
  customer_reference: 'c.customer_code',
  destination_zone: '(SELECT o2.neighborhood FROM orders o2 WHERE o2.company_id = c.company_id AND o2.customer_id = c.id ORDER BY o2.created_at DESC LIMIT 1)',
  order_count: '(SELECT COUNT(*) FROM orders o3 WHERE o3.company_id = c.company_id AND o3.customer_id = c.id)',
  completed_order_count: "(SELECT COUNT(*) FROM orders o4 WHERE o4.company_id = c.company_id AND o4.customer_id = c.id AND o4.status = 'Livrée')",
  last_order_at: '(SELECT MAX(o5.created_at) FROM orders o5 WHERE o5.company_id = c.company_id AND o5.customer_id = c.id)',
  customer_name: 'c.display_name',
  customer_phone: "(SELECT cc.value_display FROM customer_contacts cc WHERE cc.company_id = c.company_id AND cc.customer_id = c.id AND cc.kind = 'phone' AND cc.is_active = TRUE ORDER BY cc.is_primary DESC, cc.id ASC LIMIT 1)",
});
const CUSTOMERS_FILTER_SQL = Object.freeze({
  activity_status: 'c.status',
  destination_zone: '(SELECT o6.neighborhood FROM orders o6 WHERE o6.company_id = c.company_id AND o6.customer_id = c.id ORDER BY o6.created_at DESC LIMIT 1)',
});
const CUSTOMERS_NUMERIC_COLUMNS = new Set(['order_count', 'completed_order_count']);

function buildCustomersExportQuery(contract, companyId) {
  const selectList = contract.columns.map((column) => `${CUSTOMERS_EXPORT_SQL[column]} AS "${column}"`).join(', ');
  const values = [companyId, `${contract.period.from}T00:00:00Z`, `${contract.period.to}T00:00:00Z`];
  const where = [
    'c.company_id = $1',
    'c.created_at >= $2::timestamptz',
    'c.created_at < $3::timestamptz',
    "c.status NOT IN ('merged', 'anonymized')",
  ];
  applyContractFilters(CUSTOMERS_FILTER_SQL, contract, values, where);
  const text = `SELECT ${selectList} FROM customers c WHERE ${where.join(' AND ')} ORDER BY c.id LIMIT ${LIMIT}`;
  return { text, values };
}

// --- Incidents (dataset incidents) ---
const INCIDENTS_EXPORT_SQL = Object.freeze({
  incident_id: "('INC-' || i.id)",
  order_id: "('ORD-' || i.order_id)",
  category: 'i.category',
  severity: 'i.severity',
  status: 'i.status',
  opened_at: 'i.created_at',
  resolved_at: 'i.resolved_at',
  resolution_code: 'i.resolution',
});
const INCIDENTS_FILTER_SQL = Object.freeze({
  status: 'i.status',
  category: 'i.category',
  severity: 'i.severity',
});
const INCIDENTS_NUMERIC_COLUMNS = new Set();

function buildIncidentsExportQuery(contract, companyId) {
  const selectList = contract.columns.map((column) => `${INCIDENTS_EXPORT_SQL[column]} AS "${column}"`).join(', ');
  const values = [companyId, `${contract.period.from}T00:00:00Z`, `${contract.period.to}T00:00:00Z`];
  const where = [
    'i.company_id = $1',
    'i.created_at >= $2::timestamptz',
    'i.created_at < $3::timestamptz',
  ];
  applyContractFilters(INCIDENTS_FILTER_SQL, contract, values, where);
  const text = `SELECT ${selectList} FROM delivery_incidents i WHERE ${where.join(' AND ')} ORDER BY i.id LIMIT ${LIMIT}`;
  return { text, values };
}

// --- Tournées (dataset routes) ---
const ROUTES_EXPORT_SQL = Object.freeze({
  run_reference: "('RUN-' || r.id)",
  service_date: 'r.service_date',
  driver_reference: "('DRV-' || r.driver_id)",
  status: 'r.status',
  stop_count: '(SELECT COUNT(*) FROM delivery_stops s WHERE s.run_id = r.id AND s.removed_at IS NULL)',
  order_count: '(SELECT COUNT(DISTINCT s.order_id) FROM delivery_stops s WHERE s.run_id = r.id AND s.removed_at IS NULL)',
  started_at: 'r.started_at',
  completed_at: 'r.completed_at',
});
const ROUTES_FILTER_SQL = Object.freeze({
  status: 'r.status',
  driver_reference: "('DRV-' || r.driver_id)",
});
const ROUTES_NUMERIC_COLUMNS = new Set(['stop_count', 'order_count']);

function buildRoutesExportQuery(contract, companyId) {
  const selectList = contract.columns.map((column) => `${ROUTES_EXPORT_SQL[column]} AS "${column}"`).join(', ');
  // La période s'applique à la date de service (DATE) de la tournée.
  const values = [companyId, contract.period.from, contract.period.to];
  const where = [
    'r.company_id = $1',
    'r.service_date >= $2::date',
    'r.service_date < $3::date',
  ];
  applyContractFilters(ROUTES_FILTER_SQL, contract, values, where);
  const text = `SELECT ${selectList} FROM delivery_runs r WHERE ${where.join(' AND ')} ORDER BY r.id LIMIT ${LIMIT}`;
  return { text, values };
}

module.exports = {
  CUSTOMERS_EXPORT_SQL,
  CUSTOMERS_FILTER_SQL,
  CUSTOMERS_NUMERIC_COLUMNS,
  buildCustomersExportQuery,
  INCIDENTS_EXPORT_SQL,
  INCIDENTS_FILTER_SQL,
  INCIDENTS_NUMERIC_COLUMNS,
  buildIncidentsExportQuery,
  ROUTES_EXPORT_SQL,
  ROUTES_FILTER_SQL,
  ROUTES_NUMERIC_COLUMNS,
  buildRoutesExportQuery,
};
