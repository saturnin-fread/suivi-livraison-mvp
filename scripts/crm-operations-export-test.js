'use strict';

const assert = require('node:assert/strict');
const {
  buildOperationsExportQuery,
  normalizeExportRow,
  OPERATIONS_NUMERIC_COLUMNS,
} = require('../lib/crm-operations-export');
const { createExportContract, OPERATIONAL_LIMITS } = require('../lib/crm-export-contract');

function run() {
  testQueryWithFiltersAndSensitiveColumn();
  testOperatorGetsNoSensitiveColumn();
  testRowNormalization();
  process.stdout.write('Tests export operations réussis : sélection de colonnes, paramètres de filtres, cloisonnement et normalisation.\n');
}

function testQueryWithFiltersAndSensitiveColumn() {
  const contract = createExportContract({
    companyId: '42',
    actorId: 'user-9',
    role: 'owner',
    dataset: 'operations',
    purpose: 'Revue mensuelle des livraisons',
    requestedAt: '2026-09-15T10:00:00.000Z',
    period: { from: '2026-08-01', to: '2026-09-01' },
    sensitiveColumns: ['customer_name'],
    filters: { status: 'delivered', driver_reference: ['DRV-1', 'DRV-2'] },
  });

  const query = buildOperationsExportQuery(contract, 42);

  // Company id and period are the first three bound parameters.
  assert.equal(query.values[0], 42);
  assert.equal(query.values[1], '2026-08-01T00:00:00Z');
  assert.equal(query.values[2], '2026-09-01T00:00:00Z');

  // Filters keep a deterministic order (contract filter order), so parameter
  // numbering is stable: status -> $4, driver_reference -> $5.
  assert.equal(query.values[3], 'delivered');
  assert.deepEqual(query.values[4], ['DRV-1', 'DRV-2']);
  assert.equal(query.values.length, 5);
  assert.ok(query.text.includes('o.status = $4'));
  assert.ok(query.text.includes("('DRV-' || o.driver_id) = ANY($5::text[])"));

  // Authorized columns are selected, including the requested sensitive one.
  assert.ok(query.text.includes('o.id AS "order_id"'));
  assert.ok(query.text.includes('o.customer_name AS "customer_name"'));
  assert.ok(query.text.includes('COALESCE(inc.cnt, 0) AS "incident_count"'));

  // Company isolation is always in the WHERE clause, and no silent truncation.
  assert.ok(query.text.includes('o.company_id = $1'));
  assert.ok(query.text.includes(`LIMIT ${OPERATIONAL_LIMITS.maxDataRowsPerWorkbook + 1}`));
}

function testOperatorGetsNoSensitiveColumn() {
  const contract = createExportContract({
    companyId: '7',
    actorId: 'op-1',
    role: 'operator',
    dataset: 'operations',
    purpose: 'Suivi hebdomadaire',
    requestedAt: '2026-09-15T10:00:00.000Z',
    period: { from: '2026-09-01', to: '2026-09-08' },
  });
  const query = buildOperationsExportQuery(contract, 7);
  assert.ok(!query.text.includes('customer_name'));
  assert.ok(!query.text.includes('customer_phone'));
  assert.equal(query.values.length, 3); // no filters
}

function testRowNormalization() {
  const row = {
    order_id: '1000000000001', // BIGINT as string: stays text, never rounded
    created_at: new Date('2026-08-15T09:30:00.000Z'),
    delivered_at: null,
    delivery_duration_minutes: '42', // NUMERIC as string -> number
    incident_count: 0,
    status: 'delivered',
  };
  const normalized = normalizeExportRow(row, OPERATIONS_NUMERIC_COLUMNS);
  assert.equal(normalized.order_id, '1000000000001');
  assert.equal(normalized.created_at, '2026-08-15T09:30:00.000Z');
  assert.equal(normalized.delivered_at, null);
  assert.equal(normalized.delivery_duration_minutes, 42);
  assert.equal(typeof normalized.delivery_duration_minutes, 'number');
  assert.equal(normalized.incident_count, 0);
  assert.equal(normalized.status, 'delivered');
}

run();
