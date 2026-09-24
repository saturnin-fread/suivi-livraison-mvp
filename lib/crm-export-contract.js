'use strict';

const crypto = require('node:crypto');

const CONTRACT_VERSION = '1.0.0';
const FORMAT = 'xlsx';
const TIMEZONE = 'Africa/Porto-Novo';
const EXPORT_TTL_HOURS = 24;
const DOWNLOAD_GRANT_TTL_MINUTES = 5;

const EXCEL_LIMITS = Object.freeze({
  maxRowsPerWorksheet: 1_048_576,
  maxColumnsPerWorksheet: 16_384,
  maxCharactersPerCell: 32_767,
});

const OPERATIONAL_LIMITS = Object.freeze({
  maxDataRowsPerWorksheet: 50_000,
  maxDataRowsPerWorkbook: 100_000,
  maxWorksheets: 8,
  maxColumnsPerWorksheet: 30,
  maxArtifactBytes: 50 * 1024 * 1024,
});

const ROLE_PERIOD_LIMIT_DAYS = Object.freeze({
  owner: 366,
  manager: 366,
  operator: 31,
});

const DATASETS = Object.freeze({
  operations: Object.freeze({
    roles: Object.freeze(['owner', 'manager', 'operator']),
    filters: Object.freeze(['status', 'destination_zone', 'driver_reference', 'run_reference', 'payment_status']),
    columns: Object.freeze([
      'order_id',
      'created_at',
      'requested_window',
      'status',
      'destination_zone',
      'driver_reference',
      'run_reference',
      'delivered_at',
      'delivery_duration_minutes',
      'payment_status',
      'incident_count',
    ]),
    sensitiveColumns: Object.freeze([
      'customer_name',
      'customer_phone',
      'delivery_address',
      'delivery_instructions',
    ]),
  }),
  customers: Object.freeze({
    roles: Object.freeze(['owner', 'manager']),
    filters: Object.freeze(['destination_zone', 'activity_status']),
    columns: Object.freeze([
      'customer_reference',
      'destination_zone',
      'order_count',
      'completed_order_count',
      'last_order_at',
    ]),
    sensitiveColumns: Object.freeze(['customer_name', 'customer_phone']),
  }),
  payments: Object.freeze({
    roles: Object.freeze(['owner', 'manager']),
    filters: Object.freeze(['payment_status', 'payment_method', 'currency']),
    columns: Object.freeze([
      'order_id',
      'currency',
      'expected_amount_minor',
      'collected_amount_minor',
      'adjusted_amount_minor',
      'payment_status',
      'payment_method',
      'collected_at',
      'reconciled_at',
    ]),
    sensitiveColumns: Object.freeze([]),
  }),
  incidents: Object.freeze({
    roles: Object.freeze(['owner', 'manager']),
    filters: Object.freeze(['status', 'category', 'severity']),
    columns: Object.freeze([
      'incident_id',
      'order_id',
      'category',
      'severity',
      'status',
      'opened_at',
      'resolved_at',
      'resolution_code',
    ]),
    sensitiveColumns: Object.freeze([]),
  }),
  routes: Object.freeze({
    roles: Object.freeze(['owner', 'manager']),
    filters: Object.freeze(['status', 'driver_reference']),
    columns: Object.freeze([
      'run_reference',
      'service_date',
      'driver_reference',
      'status',
      'stop_count',
      'order_count',
      'started_at',
      'completed_at',
    ]),
    sensitiveColumns: Object.freeze([]),
  }),
  drivers_summary: Object.freeze({
    roles: Object.freeze(['owner', 'manager']),
    filters: Object.freeze(['vehicle_type', 'driver_reference']),
    columns: Object.freeze([
      'driver_reference',
      'driver_name',
      'vehicle_type',
      'assigned_order_count',
      'completed_order_count',
      'returned_order_count',
      'incident_count',
      'active_delivery_minutes',
    ]),
    sensitiveColumns: Object.freeze([]),
  }),
});

const FORBIDDEN_DEFAULT_COLUMNS = Object.freeze([
  'latitude',
  'longitude',
  'gps_timestamp',
  'gps_accuracy',
  'raw_position',
  'route_geometry',
  'position_history',
  'traccar_device_id',
  'traccar_position_id',
]);

class ExportContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ExportContractError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function requiredText(value, field, maxLength = 240) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExportContractError('INVALID_REQUEST', `${field} est obligatoire.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ExportContractError('INVALID_REQUEST', `${field} dépasse ${maxLength} caractères.`);
  }
  return normalized;
}

function parseDateOnly(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ExportContractError('INVALID_PERIOD', `${field} doit respecter AAAA-MM-JJ.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ExportContractError('INVALID_PERIOD', `${field} n'est pas une date valide.`);
  }
  return date;
}

function validatePeriod(period, role) {
  if (!period || typeof period !== 'object') {
    throw new ExportContractError('INVALID_PERIOD', 'Une période bornée est obligatoire.');
  }
  const fromDate = parseDateOnly(period.from, 'period.from');
  const toDate = parseDateOnly(period.to, 'period.to');
  const days = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
  if (days <= 0) {
    throw new ExportContractError(
      'INVALID_PERIOD',
      'period.to doit être postérieure à period.from (borne de fin exclue).',
    );
  }
  const roleLimit = ROLE_PERIOD_LIMIT_DAYS[role];
  if (!roleLimit || days > roleLimit) {
    throw new ExportContractError('PERIOD_TOO_LARGE', `La période dépasse la limite de ${roleLimit || 0} jours.`, {
      maximumDays: roleLimit || 0,
      requestedDays: days,
    });
  }
  return Object.freeze({ from: period.from, to: period.to, endExclusive: true, days });
}

function parseRequestedAt(value) {
  const text = requiredText(value, 'requestedAt', 40);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ExportContractError('INVALID_REQUEST', 'requestedAt doit être un horodatage ISO 8601 valide.');
  }
  return timestamp.toISOString();
}

function computeExpiry(requestedAt, ttlHours = EXPORT_TTL_HOURS) {
  const normalized = parseRequestedAt(requestedAt);
  return new Date(new Date(normalized).getTime() + ttlHours * 3_600_000).toISOString();
}

function validateFilterScalar(value, key) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ExportContractError('INVALID_REQUEST', `Nombre de filtre non valide : ${key}`);
  }
  if (typeof value === 'string' && value.length > 500) {
    throw new ExportContractError('INVALID_REQUEST', `Valeur de filtre trop longue : ${key}`);
  }
  return ['string', 'number', 'boolean'].includes(typeof value) || value === null;
}

function normalizeFilters(filters, dataset) {
  if (filters === undefined) return {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new ExportContractError('INVALID_REQUEST', 'filters doit être un objet.');
  }
  const normalized = {};
  const allowedFilters = DATASETS[dataset].filters;
  for (const key of Object.keys(filters).sort()) {
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key)) {
      throw new ExportContractError('INVALID_REQUEST', `Filtre non autorisé : ${key}`);
    }
    if (!allowedFilters.includes(key)) {
      throw new ExportContractError('FORBIDDEN_FILTER', `Filtre non prévu pour ${dataset} : ${key}`);
    }
    const value = filters[key];
    const scalar = validateFilterScalar(value, key);
    const scalarArray = Array.isArray(value) && value.length <= 100 && value.every((item) => (
      validateFilterScalar(item, key)
    ));
    if (!scalar && !scalarArray) {
      throw new ExportContractError('INVALID_REQUEST', `Valeur de filtre non autorisée : ${key}`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function selectColumns(dataset, role, requestedSensitiveColumns, purpose) {
  const profile = DATASETS[dataset];
  if (!profile) {
    throw new ExportContractError('UNKNOWN_DATASET', `Jeu de données inconnu : ${dataset}`);
  }
  if (!profile.roles.includes(role)) {
    throw new ExportContractError('FORBIDDEN_EXPORT', `Le rôle ${role} ne peut pas exporter ${dataset}.`);
  }

  const requested = requestedSensitiveColumns === undefined ? [] : requestedSensitiveColumns;
  if (!Array.isArray(requested) || requested.some((column) => typeof column !== 'string')) {
    throw new ExportContractError('INVALID_REQUEST', 'sensitiveColumns doit être une liste de noms de colonnes.');
  }
  const uniqueRequested = [...new Set(requested)].sort();
  if (uniqueRequested.length > 0 && !['owner', 'manager'].includes(role)) {
    throw new ExportContractError('FORBIDDEN_SENSITIVE_EXPORT', 'Ce rôle ne peut pas exporter de données sensibles.');
  }
  if (uniqueRequested.length > 0 && purpose.length < 10) {
    throw new ExportContractError(
      'PURPOSE_REQUIRED',
      'Un motif explicite d’au moins 10 caractères est requis pour les données sensibles.',
    );
  }
  for (const column of uniqueRequested) {
    if (!profile.sensitiveColumns.includes(column)) {
      throw new ExportContractError('FORBIDDEN_COLUMN', `Colonne sensible non autorisée : ${column}`);
    }
  }
  const columns = [...profile.columns, ...uniqueRequested];
  if (columns.some((column) => FORBIDDEN_DEFAULT_COLUMNS.includes(column))) {
    throw new ExportContractError('GPS_DETAIL_FORBIDDEN', 'Les positions GPS détaillées ne sont pas exportables ici.');
  }
  if (columns.length > OPERATIONAL_LIMITS.maxColumnsPerWorksheet) {
    throw new ExportContractError('EXPORT_TOO_LARGE', 'Le nombre de colonnes dépasse la limite opérationnelle.');
  }
  return Object.freeze(columns);
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const pairs = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${pairs.join(',')}}`;
}

function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fingerprintExportRequest(request) {
  return sha256Hex(canonicalize(request));
}

function neutralizeSpreadsheetText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return value;
  if (value.includes('\u0000')) {
    throw new ExportContractError('CELL_CONTAINS_NUL', 'Une cellule contient un caractère NUL interdit par XML.');
  }
  if (value.length > EXCEL_LIMITS.maxCharactersPerCell) {
    throw new ExportContractError(
      'CELL_TOO_LONG',
      `Une cellule dépasse ${EXCEL_LIMITS.maxCharactersPerCell} caractères.`,
    );
  }
  const firstCharacterIsControlFormulaTrigger = /^[\t\r\n]/u.test(value);
  const probe = value.replace(/^[\uFEFF\u0001-\u0020]+/u, '');
  const firstMeaningfulCharacterIsFormulaTrigger = /^[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(probe);
  if (firstCharacterIsControlFormulaTrigger || firstMeaningfulCharacterIsFormulaTrigger) {
    return `'${value}`;
  }
  return value;
}

function validateVolume(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    throw new ExportContractError('INVALID_VOLUME', 'Les métriques de volume sont obligatoires.');
  }
  const totalRows = metrics.totalRows;
  const rowsPerWorksheet = metrics.rowsPerWorksheet;
  const estimatedBytes = metrics.estimatedBytes;
  if (!Number.isInteger(totalRows) || totalRows < 0) {
    throw new ExportContractError('INVALID_VOLUME', 'totalRows doit être un entier positif ou nul.');
  }
  if (!Array.isArray(rowsPerWorksheet) || rowsPerWorksheet.length === 0 || rowsPerWorksheet.some((rows) => (
    !Number.isInteger(rows) || rows < 0
  ))) {
    throw new ExportContractError('INVALID_VOLUME', 'rowsPerWorksheet doit contenir des entiers positifs ou nuls.');
  }
  if (!Number.isInteger(estimatedBytes) || estimatedBytes < 0) {
    throw new ExportContractError('INVALID_VOLUME', 'estimatedBytes doit être un entier positif ou nul.');
  }
  if (
    totalRows > OPERATIONAL_LIMITS.maxDataRowsPerWorkbook ||
    rowsPerWorksheet.length > OPERATIONAL_LIMITS.maxWorksheets ||
    rowsPerWorksheet.some((rows) => rows > OPERATIONAL_LIMITS.maxDataRowsPerWorksheet) ||
    estimatedBytes > OPERATIONAL_LIMITS.maxArtifactBytes
  ) {
    throw new ExportContractError(
      'EXPORT_TOO_LARGE',
      'Export trop volumineux : réduire la période ou les filtres. Aucun tronquage ne sera appliqué.',
      { limits: OPERATIONAL_LIMITS },
    );
  }
  const sum = rowsPerWorksheet.reduce((accumulator, rows) => accumulator + rows, 0);
  if (sum !== totalRows) {
    throw new ExportContractError('INVALID_VOLUME', 'Le total des lignes ne correspond pas aux feuilles.');
  }
  return true;
}

function createExportContract(input) {
  if (!input || typeof input !== 'object') {
    throw new ExportContractError('INVALID_REQUEST', 'La demande d’export est obligatoire.');
  }
  const companyId = requiredText(input.companyId, 'companyId', 128);
  const actorId = requiredText(input.actorId, 'actorId', 128);
  const role = requiredText(input.role, 'role', 32).toLowerCase();
  const dataset = requiredText(input.dataset, 'dataset', 64);
  const purpose = requiredText(input.purpose, 'purpose', 240);
  const requestedAt = parseRequestedAt(input.requestedAt);
  const columns = selectColumns(dataset, role, input.sensitiveColumns, purpose);
  const period = validatePeriod(input.period, role);
  const filters = normalizeFilters(input.filters, dataset);

  const fingerprintPayload = {
    contractVersion: CONTRACT_VERSION,
    format: FORMAT,
    companyId,
    actorId,
    role,
    dataset,
    period,
    filters,
    columns,
    purpose,
    privacyMode: 'minimized',
  };

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    format: FORMAT,
    companyId,
    actorId,
    role,
    dataset,
    purpose,
    period,
    filters: Object.freeze(filters),
    columns,
    timezone: TIMEZONE,
    requestedAt,
    expiresAt: computeExpiry(requestedAt),
    requestFingerprintSha256: fingerprintExportRequest(fingerprintPayload),
    privacy: Object.freeze({
      detailedGpsIncluded: false,
      defaultDataMinimization: true,
      formulaNeutralizationRequired: true,
      xlsxTextCellsOnlyForUntrustedValues: true,
    }),
    workbook: Object.freeze({
      macrosAllowed: false,
      formulasAllowed: false,
      externalLinksAllowed: false,
      hyperlinksAllowed: false,
      hiddenSheetsAllowed: false,
    }),
    limits: OPERATIONAL_LIMITS,
  });
}

function buildAuditRecord(contract, outcome = {}) {
  if (!contract || contract.contractVersion !== CONTRACT_VERSION) {
    throw new ExportContractError('INVALID_CONTRACT', 'Contrat d’export invalide.');
  }
  const allowedStatuses = ['requested', 'generating', 'ready', 'downloaded', 'expired', 'failed', 'cancelled'];
  const status = outcome.status || 'requested';
  if (!allowedStatuses.includes(status)) {
    throw new ExportContractError('INVALID_AUDIT_STATUS', `Statut d’audit invalide : ${status}`);
  }
  const record = {
    exportId: outcome.exportId ? requiredText(outcome.exportId, 'exportId', 128) : null,
    companyId: contract.companyId,
    actorId: contract.actorId,
    role: contract.role,
    dataset: contract.dataset,
    purpose: contract.purpose,
    period: contract.period,
    columns: contract.columns,
    filters: contract.filters,
    status,
    requestedAt: contract.requestedAt,
    expiresAt: contract.expiresAt,
    requestFingerprintSha256: contract.requestFingerprintSha256,
    rowCount: Number.isInteger(outcome.rowCount) ? outcome.rowCount : null,
    worksheetCount: Number.isInteger(outcome.worksheetCount) ? outcome.worksheetCount : null,
    artifactBytes: Number.isInteger(outcome.artifactBytes) ? outcome.artifactBytes : null,
    artifactSha256: outcome.artifactSha256 || null,
    failureCode: outcome.failureCode || null,
  };
  if (record.artifactSha256 && !/^[a-f0-9]{64}$/.test(record.artifactSha256)) {
    throw new ExportContractError('INVALID_ARTIFACT_HASH', 'L’empreinte du fichier doit être un SHA-256 hexadécimal.');
  }
  return Object.freeze(record);
}

module.exports = {
  CONTRACT_VERSION,
  FORMAT,
  TIMEZONE,
  EXPORT_TTL_HOURS,
  DOWNLOAD_GRANT_TTL_MINUTES,
  EXCEL_LIMITS,
  OPERATIONAL_LIMITS,
  ROLE_PERIOD_LIMIT_DAYS,
  DATASETS,
  FORBIDDEN_DEFAULT_COLUMNS,
  ExportContractError,
  buildAuditRecord,
  canonicalize,
  computeExpiry,
  createExportContract,
  fingerprintExportRequest,
  neutralizeSpreadsheetText,
  sha256Hex,
  validatePeriod,
  validateVolume,
};
