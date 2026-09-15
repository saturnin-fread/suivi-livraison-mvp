'use strict';

const assert = require('node:assert/strict');
const { buildWorkbook, columnRef } = require('../lib/crm-xlsx');
const { createExportContract, ExportContractError } = require('../lib/crm-export-contract');

function baseContract(overrides = {}) {
  return createExportContract({
    companyId: 'company-1',
    actorId: 'user-1',
    role: 'owner',
    dataset: 'operations',
    purpose: 'Audit interne trimestriel',
    requestedAt: '2026-09-15T10:00:00.000Z',
    period: { from: '2026-08-01', to: '2026-09-01' },
    sensitiveColumns: ['customer_name'],
    ...overrides,
  });
}

function run() {
  testColumnRef();
  testStructureAndSecurity();
  testEmptyExportHasHeaderOnly();
  testCellTooLongIsRejected();
  process.stdout.write('Tests générateur XLSX réussis : conteneur ZIP, neutralisation des formules, échappement XML, cellules numériques et volume.\n');
}

function testColumnRef() {
  assert.equal(columnRef(0), 'A');
  assert.equal(columnRef(25), 'Z');
  assert.equal(columnRef(26), 'AA');
  assert.equal(columnRef(27), 'AB');
}

function testStructureAndSecurity() {
  const contract = baseContract();
  const row = {
    order_id: 1001,
    created_at: '2026-08-15T10:00:00Z',
    requested_window: '08:00-10:00',
    status: 'delivered',
    destination_zone: 'Nord & <Zone>',
    driver_reference: 'DRV-2',
    run_reference: 'RUN-9',
    delivered_at: null,
    delivery_duration_minutes: 42,
    payment_status: 'collected',
    incident_count: 0,
    customer_name: '=SUM(A1)+cmd()', // formula-injection attempt in a sensitive column
  };

  const result = buildWorkbook(contract, [row]);
  const { buffer } = result;

  // ZIP container magic and end-of-central-directory record.
  assert.equal(buffer[0], 0x50); // P
  assert.equal(buffer[1], 0x4b); // K
  assert.equal(buffer[2], 0x03);
  assert.equal(buffer[3], 0x04);
  const eocd = buffer.subarray(buffer.length - 22);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50);
  // 4 base parts (content types, root rels, workbook, workbook rels) + 1 sheet.
  assert.equal(eocd.readUInt16LE(10), 5);

  const text = buffer.toString('utf8');
  // Header row carries the contract columns, including the sensitive one.
  assert.ok(text.includes('order_id'));
  assert.ok(text.includes('customer_name'));
  // Formula trigger is neutralized with a leading apostrophe, so it cannot execute.
  assert.ok(text.includes("'=SUM(A1)+cmd()"), 'la valeur formule doit être neutralisée');
  assert.ok(!text.includes('<t xml:space="preserve">=SUM(A1)'), 'aucune formule brute ne doit rester');
  // XML special characters are escaped.
  assert.ok(text.includes('Nord &amp; &lt;Zone&gt;'));
  // Numbers stay numeric value cells (not text).
  assert.ok(text.includes('<v>1001</v>'));
  assert.ok(text.includes('<v>42</v>'));
  // No formulas / macros / external links anywhere.
  assert.ok(!text.includes('<f>'), 'aucune formule ne doit être écrite');
  assert.ok(!text.toLowerCase().includes('vbaproject'));

  assert.equal(result.totalRows, 1);
  assert.equal(result.worksheetCount, 1);
  assert.match(result.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.artifactBytes, buffer.length);
}

function testEmptyExportHasHeaderOnly() {
  const contract = baseContract();
  const result = buildWorkbook(contract, []);
  assert.equal(result.totalRows, 0);
  assert.equal(result.worksheetCount, 1);
  const text = result.buffer.toString('utf8');
  assert.ok(text.includes('<row r="1">'));
  assert.ok(!text.includes('<row r="2">'));
}

function testCellTooLongIsRejected() {
  const contract = baseContract();
  const row = { order_id: 1, status: 'x'.repeat(40_000) };
  assert.throws(
    () => buildWorkbook(contract, [row]),
    (error) => error instanceof ExportContractError && error.code === 'CELL_TOO_LONG',
  );
}

run();
