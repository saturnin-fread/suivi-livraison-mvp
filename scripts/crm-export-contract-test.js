'use strict';

const assert = require('node:assert/strict');
const {
  DATASETS,
  DOWNLOAD_GRANT_TTL_MINUTES,
  EXCEL_LIMITS,
  EXPORT_TTL_HOURS,
  FORBIDDEN_DEFAULT_COLUMNS,
  OPERATIONAL_LIMITS,
  ExportContractError,
  buildAuditRecord,
  canonicalize,
  computeExpiry,
  createExportContract,
  fingerprintExportRequest,
  neutralizeSpreadsheetText,
  sha256Hex,
  validateVolume,
} = require('../lib/crm-export-contract');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`✓ ${name}\n`);
  } catch (error) {
    process.stderr.write(`✗ ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error instanceof ExportContractError && error.code === code);
}

function baseRequest(overrides = {}) {
  return {
    companyId: 'company-benin-001',
    actorId: 'user-001',
    role: 'owner',
    dataset: 'operations',
    purpose: 'Pilotage mensuel des livraisons',
    period: { from: '2026-08-01', to: '2026-09-01' },
    requestedAt: '2026-09-15T10:00:00.000Z',
    filters: {},
    ...overrides,
  };
}

test('les profils exposent uniquement les jeux de données prévus', () => {
  assert.deepEqual(Object.keys(DATASETS).sort(), [
    'customers',
    'drivers_summary',
    'incidents',
    'operations',
    'payments',
    'routes',
  ]);
});

test('owner et manager peuvent exporter les profils de gestion', () => {
  for (const role of ['owner', 'manager']) {
    for (const dataset of Object.keys(DATASETS)) {
      const contract = createExportContract(baseRequest({ role, dataset }));
      assert.equal(contract.companyId, 'company-benin-001');
      assert.equal(contract.dataset, dataset);
    }
  }
});

test('operator ne peut exporter que les opérations', () => {
  assert.equal(createExportContract(baseRequest({ role: 'operator' })).dataset, 'operations');
  for (const dataset of ['customers', 'drivers_summary', 'incidents', 'payments', 'routes']) {
    expectCode('FORBIDDEN_EXPORT', () => createExportContract(baseRequest({ role: 'operator', dataset })));
  }
});

test('driver ne dispose d’aucun export en masse', () => {
  for (const dataset of Object.keys(DATASETS)) {
    expectCode('FORBIDDEN_EXPORT', () => createExportContract(baseRequest({ role: 'driver', dataset })));
  }
});

test('une entreprise, un acteur et une période bornée sont obligatoires', () => {
  expectCode('INVALID_REQUEST', () => createExportContract(baseRequest({ companyId: '' })));
  expectCode('INVALID_REQUEST', () => createExportContract(baseRequest({ actorId: '' })));
  expectCode('INVALID_PERIOD', () => createExportContract(baseRequest({ period: undefined })));
  expectCode('INVALID_PERIOD', () => createExportContract(baseRequest({
    period: { from: '2026-09-01', to: '2026-09-01' },
  })));
});

test('les filtres sont limités par profil, sans données sensibles ni valeurs non bornées', () => {
  expectCode('FORBIDDEN_FILTER', () => createExportContract(baseRequest({
    filters: { customer_phone: '22997000000' },
  })));
  expectCode('INVALID_REQUEST', () => createExportContract(baseRequest({
    filters: { status: 'x'.repeat(501) },
  })));
  expectCode('INVALID_REQUEST', () => createExportContract(baseRequest({
    filters: { status: Number.POSITIVE_INFINITY },
  })));
  assert.deepEqual(createExportContract(baseRequest({
    filters: { destination_zone: 'Calavi', status: ['delivered'] },
  })).filters, { destination_zone: 'Calavi', status: ['delivered'] });
});

test('les limites de période sont de 31 jours pour operator et 366 pour owner/manager', () => {
  assert.equal(createExportContract(baseRequest({
    role: 'operator',
    period: { from: '2026-01-01', to: '2026-02-01' },
  })).period.days, 31);
  expectCode('PERIOD_TOO_LARGE', () => createExportContract(baseRequest({
    role: 'operator',
    period: { from: '2026-01-01', to: '2026-02-02' },
  })));
  assert.equal(createExportContract(baseRequest({
    period: { from: '2024-01-01', to: '2025-01-01' },
  })).period.days, 366);
  expectCode('PERIOD_TOO_LARGE', () => createExportContract(baseRequest({
    period: { from: '2024-01-01', to: '2025-01-02' },
  })));
});

test('aucun profil par défaut ne contient de GPS détaillé', () => {
  for (const [dataset, profile] of Object.entries(DATASETS)) {
    assert.equal(
      profile.columns.some((column) => FORBIDDEN_DEFAULT_COLUMNS.includes(column)),
      false,
      dataset,
    );
  }
  assert.equal(createExportContract(baseRequest()).privacy.detailedGpsIncluded, false);
});

test('les données sensibles exigent un rôle privilégié, un motif et une liste autorisée', () => {
  expectCode('FORBIDDEN_SENSITIVE_EXPORT', () => createExportContract(baseRequest({
    role: 'operator',
    sensitiveColumns: ['customer_phone'],
  })));
  expectCode('PURPOSE_REQUIRED', () => createExportContract(baseRequest({
    purpose: 'Support',
    sensitiveColumns: ['customer_phone'],
  })));
  expectCode('FORBIDDEN_COLUMN', () => createExportContract(baseRequest({
    sensitiveColumns: ['latitude'],
  })));
  const contract = createExportContract(baseRequest({ sensitiveColumns: ['customer_phone'] }));
  assert.equal(contract.columns.includes('customer_phone'), true);
});

test('les déclencheurs de formules sont neutralisés et les textes sûrs restent intacts', () => {
  const dangerous = [
    '=1+1',
    '+SUM(A1:A2)',
    '-1+2',
    '@SUM(A1:A2)',
    '\tcommande',
    '\rcommande',
    '\ncommande',
    '\uFEFF  =WEBSERVICE("https://example.invalid")',
    '  +1',
    '\uFF1D1+1',
    '\uFF0BSUM(A1:A2)',
    '\uFF0D1',
    '\uFF20SUM(A1:A2)',
  ];
  for (const value of dangerous) {
    assert.equal(neutralizeSpreadsheetText(value), `'${value}`);
  }
  assert.equal(neutralizeSpreadsheetText('Client + partenaire'), 'Client + partenaire');
  assert.equal(neutralizeSpreadsheetText('22997000000'), '22997000000');
  assert.equal(neutralizeSpreadsheetText(1500), 1500);
  expectCode('CELL_CONTAINS_NUL', () => neutralizeSpreadsheetText('a\u0000b'));
  expectCode('CELL_TOO_LONG', () => neutralizeSpreadsheetText('x'.repeat(32_768)));
});

test('le classeur interdit formules, macros, liens externes, hyperliens et feuilles cachées', () => {
  const workbook = createExportContract(baseRequest()).workbook;
  assert.deepEqual(workbook, {
    macrosAllowed: false,
    formulasAllowed: false,
    externalLinksAllowed: false,
    hyperlinksAllowed: false,
    hiddenSheetsAllowed: false,
  });
});

test('l’empreinte de requête est stable et sensible au périmètre entreprise/rôle/période', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), canonicalize({ a: 1, b: 2 }));
  const first = fingerprintExportRequest({ b: 2, nested: { z: 3, a: 1 } });
  const second = fingerprintExportRequest({ nested: { a: 1, z: 3 }, b: 2 });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);

  const baseline = createExportContract(baseRequest()).requestFingerprintSha256;
  assert.notEqual(baseline, createExportContract(baseRequest({ companyId: 'company-002' })).requestFingerprintSha256);
  assert.notEqual(baseline, createExportContract(baseRequest({ role: 'manager' })).requestFingerprintSha256);
  assert.notEqual(baseline, createExportContract(baseRequest({
    filters: { status: ['delivered'] },
  })).requestFingerprintSha256);
  assert.notEqual(baseline, createExportContract(baseRequest({
    period: { from: '2026-07-01', to: '2026-08-01' },
  })).requestFingerprintSha256);
});

test('SHA-256 porte sur les octets exacts du fichier', () => {
  assert.equal(
    sha256Hex(Buffer.from('xlsx-factice', 'utf8')),
    '2a8e18f37a8490e130e939903d81bc396f700e90ee78f9965a20c25aa44439e6',
  );
});

test('les limites opérationnelles restent sous les limites Excel et refusent sans tronquer', () => {
  assert.ok(OPERATIONAL_LIMITS.maxDataRowsPerWorksheet < EXCEL_LIMITS.maxRowsPerWorksheet);
  assert.ok(OPERATIONAL_LIMITS.maxColumnsPerWorksheet < EXCEL_LIMITS.maxColumnsPerWorksheet);
  assert.equal(validateVolume({
    totalRows: 100_000,
    rowsPerWorksheet: [50_000, 50_000],
    estimatedBytes: 50 * 1024 * 1024,
  }), true);
  expectCode('EXPORT_TOO_LARGE', () => validateVolume({
    totalRows: 100_001,
    rowsPerWorksheet: [50_000, 50_000, 1],
    estimatedBytes: 1,
  }));
  expectCode('EXPORT_TOO_LARGE', () => validateVolume({
    totalRows: 50_001,
    rowsPerWorksheet: [50_001],
    estimatedBytes: 1,
  }));
  expectCode('INVALID_VOLUME', () => validateVolume({
    totalRows: 2,
    rowsPerWorksheet: [1],
    estimatedBytes: 1,
  }));
});

test('l’expiration est déterministe : fichier 24 h, autorisation de téléchargement 5 min', () => {
  assert.equal(EXPORT_TTL_HOURS, 24);
  assert.equal(DOWNLOAD_GRANT_TTL_MINUTES, 5);
  assert.equal(computeExpiry('2026-09-15T10:00:00.000Z'), '2026-09-16T10:00:00.000Z');
  assert.equal(createExportContract(baseRequest()).expiresAt, '2026-09-16T10:00:00.000Z');
});

test('l’audit ne contient ni lignes exportées ni coordonnées GPS et valide l’empreinte fichier', () => {
  const contract = createExportContract(baseRequest());
  const audit = buildAuditRecord(contract, {
    exportId: 'exp-001',
    status: 'ready',
    rowCount: 10,
    worksheetCount: 1,
    artifactBytes: 4096,
    artifactSha256: 'a'.repeat(64),
  });
  assert.equal(audit.companyId, contract.companyId);
  assert.equal(audit.artifactSha256, 'a'.repeat(64));
  assert.equal(Object.hasOwn(audit, 'rows'), false);
  assert.equal(Object.hasOwn(audit, 'latitude'), false);
  assert.equal(Object.hasOwn(audit, 'longitude'), false);
  expectCode('INVALID_ARTIFACT_HASH', () => buildAuditRecord(contract, { artifactSha256: 'invalide' }));
});

if (process.exitCode) {
  process.stderr.write(`\n${passed} tests réussis avant échec.\n`);
} else {
  process.stdout.write(`\n${passed} tests réussis. Aucun accès réseau utilisé.\n`);
}
