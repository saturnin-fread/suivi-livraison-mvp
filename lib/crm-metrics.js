'use strict';

const TIME_ZONE = 'Africa/Porto-Novo';
const CONTRACT_VERSION = 'crm-metrics.v1';
const TERMINAL_STATUSES = new Set(['Livrée', 'Retournée', 'Annulée']);
const OPEN_RUN_STATUSES = new Set(['planned', 'active']);

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function field(row, ...names) {
  for (const name of names) {
    if (row && row[name] !== undefined) return row[name];
  }
  return undefined;
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function explicitInstant(value, label) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError(`${label} doit être un instant ISO 8601 avec fuseau explicite.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} est invalide.`);
  return milliseconds;
}

function optionalInstant(value, exclusions, code) {
  if (value === undefined || value === null || value === '') {
    increment(exclusions, `${code}_missing`);
    return null;
  }
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    increment(exclusions, `${code}_invalid`);
    return null;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    increment(exclusions, `${code}_invalid`);
    return null;
  }
  return milliseconds;
}

function localParts(milliseconds) {
  const parts = Object.fromEntries(
    dateTimeFormatter.formatToParts(new Date(milliseconds))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return parts;
}

function portoNovoDateKey(value) {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : (typeof value === 'number' ? value : explicitInstant(value, 'timestamp'));
  if (!Number.isFinite(milliseconds)) throw new TypeError('timestamp est invalide.');
  const parts = localParts(milliseconds);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isLocalMidnight(milliseconds) {
  const parts = localParts(milliseconds);
  return parts.hour === '00' && parts.minute === '00' && parts.second === '00';
}

function normalizePeriod(period) {
  if (!period || typeof period !== 'object') throw new TypeError('period est obligatoire.');
  const start = explicitInstant(field(period, 'startInclusive', 'start'), 'period.startInclusive');
  const end = explicitInstant(field(period, 'endExclusive', 'end'), 'period.endExclusive');
  if (start >= end) throw new RangeError('La fin de période doit être postérieure au début.');
  if (!isLocalMidnight(start) || !isLocalMidnight(end)) {
    throw new RangeError(`Les bornes doivent être des minuits civils dans ${TIME_ZONE}.`);
  }
  return {
    start,
    end,
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
    startLocalDate: portoNovoDateKey(start),
    endLocalDateExclusive: portoNovoDateKey(end),
  };
}

function inPeriod(milliseconds, period) {
  return milliseconds >= period.start && milliseconds < period.end;
}

function validDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function sourceArrays(input) {
  const names = [
    'orders', 'statusEvents', 'paymentAccounts', 'paymentEvents',
    'paymentAdjustments', 'incidents', 'drivers', 'runs', 'stops',
  ];
  return Object.fromEntries(names.map((name) => {
    const value = input[name];
    if (value === undefined || value === null) return [name, []];
    if (!Array.isArray(value)) throw new TypeError(`${name} doit être un tableau.`);
    return [name, value];
  }));
}

function assertTenant(companyId, arrays) {
  if (companyId === undefined || companyId === null || String(companyId).trim() === '') {
    throw new TypeError('companyId est obligatoire.');
  }
  const expected = String(companyId);
  for (const [source, rows] of Object.entries(arrays)) {
    rows.forEach((row, index) => {
      const actual = field(row, 'companyId', 'company_id');
      if (actual === undefined || actual === null || String(actual) !== expected) {
        throw new Error(`Isolation multi-entreprises refusée: ${source}[${index}].companyId.`);
      }
    });
  }
  return expected;
}

function rowId(row, exclusions, source) {
  const value = field(row, 'id');
  if (value === undefined || value === null || String(value) === '') {
    increment(exclusions, `${source}_missing_id`);
    return null;
  }
  return String(value);
}

function orderId(row, exclusions, source) {
  const value = field(row, 'orderId', 'order_id');
  if (value === undefined || value === null || String(value) === '') {
    increment(exclusions, `${source}_missing_order_id`);
    return null;
  }
  return String(value);
}

function driverId(row, exclusions, source) {
  const value = field(row, 'driverId', 'driver_id');
  if (value === undefined || value === null || String(value) === '') {
    increment(exclusions, `${source}_missing_driver_id`);
    return null;
  }
  return String(value);
}

function metric({ key, value, unit = 'count', population, formula, exclusions = {} }) {
  return {
    key,
    version: 1,
    status: 'available',
    value,
    unit,
    population,
    formula,
    exclusions,
  };
}

function ratioMetric({ key, numerator, denominator, population, formula, exclusions = {} }) {
  return {
    key,
    version: 1,
    status: denominator === 0 ? 'not_calculable' : 'available',
    value: denominator === 0 ? null : numerator / denominator,
    unit: 'ratio',
    numerator,
    denominator,
    population,
    formula,
    exclusions,
  };
}

function percentileNearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}

function firstStatusEvents(statusEvents, targetStatus, exclusions) {
  const byOrder = new Map();
  for (const event of statusEvents) {
    if (field(event, 'toStatus', 'to_status') !== targetStatus) continue;
    const id = orderId(event, exclusions, 'status_event');
    if (!id) continue;
    const timestamp = optionalInstant(field(event, 'createdAt', 'created_at'), exclusions, 'status_event_created_at');
    if (timestamp === null) continue;
    const previous = byOrder.get(id);
    if (!previous || timestamp < previous.timestamp) byOrder.set(id, { event, timestamp });
  }
  return byOrder;
}

function terminalEvents(statusEvents, exclusions) {
  const grouped = new Map();
  for (const event of statusEvents) {
    const status = field(event, 'toStatus', 'to_status');
    if (!TERMINAL_STATUSES.has(status)) continue;
    const id = orderId(event, exclusions, 'terminal_event');
    if (!id) continue;
    const timestamp = optionalInstant(field(event, 'createdAt', 'created_at'), exclusions, 'terminal_event_created_at');
    if (timestamp === null) continue;
    const group = grouped.get(id) || [];
    group.push({ event, status, timestamp });
    grouped.set(id, group);
  }

  const result = new Map();
  for (const [id, events] of grouped) {
    const statuses = new Set(events.map((event) => event.status));
    if (statuses.size !== 1) {
      increment(exclusions, 'orders_with_conflicting_terminal_events');
      continue;
    }
    events.sort((left, right) => left.timestamp - right.timestamp);
    result.set(id, events[0]);
  }
  return result;
}

function buildDelayMetrics(ordersById, arrivals, period, options, exclusions) {
  const candidates = [...arrivals.entries()].filter(([, arrival]) => inPeriod(arrival.timestamp, period));
  const reliable = [];
  const delayExclusions = {};

  for (const [id, arrival] of candidates) {
    const order = ordersById.get(id);
    if (!order) {
      increment(delayExclusions, 'order_missing');
      continue;
    }
    if (field(order, 'promisedWindowReliable', 'promised_window_reliable') !== true) {
      increment(delayExclusions, 'window_not_explicitly_reliable');
      continue;
    }
    if (field(arrival.event, 'actualArrivalReliable', 'actual_arrival_reliable') !== true) {
      increment(delayExclusions, 'arrival_not_explicitly_reliable');
      continue;
    }
    const promisedEnd = optionalInstant(
      field(order, 'promisedWindowEnd', 'promised_window_end'),
      delayExclusions,
      'promised_window_end',
    );
    if (promisedEnd === null) continue;
    const updatedAt = optionalInstant(
      field(
        order,
        'promisedWindowRecordedAt',
        'promised_window_recorded_at',
        'promisedWindowUpdatedAt',
        'promised_window_updated_at',
      ),
      delayExclusions,
      'promised_window_recorded_at',
    );
    if (updatedAt === null) continue;
    if (updatedAt > arrival.timestamp) {
      increment(delayExclusions, 'window_modified_after_arrival');
      continue;
    }
    if (updatedAt > promisedEnd) {
      increment(delayExclusions, 'window_recorded_after_deadline');
      continue;
    }
    reliable.push({ delayMinutes: Math.max(0, (arrival.timestamp - promisedEnd) / 60000) });
  }

  const candidateCount = candidates.length;
  const sampleSize = reliable.length;
  const coverage = candidateCount === 0 ? null : sampleSize / candidateCount;
  const minimumSampleSize = options.delayMinimumSampleSize ?? 10;
  const minimumCoverage = options.delayMinimumCoverage ?? 0.8;
  if (!Number.isInteger(minimumSampleSize) || minimumSampleSize < 1) {
    throw new RangeError('delayMinimumSampleSize doit être un entier positif.');
  }
  if (typeof minimumCoverage !== 'number' || minimumCoverage < 0 || minimumCoverage > 1) {
    throw new RangeError('delayMinimumCoverage doit être compris entre 0 et 1.');
  }

  let status = 'available';
  if (candidateCount === 0) status = 'no_population';
  else if (sampleSize < minimumSampleSize) status = 'insufficient_sample';
  else if (coverage < minimumCoverage) status = 'insufficient_coverage';

  const lateDelays = reliable.map((item) => item.delayMinutes).filter((value) => value > 0);
  const available = status === 'available';
  Object.entries(delayExclusions).forEach(([key, value]) => increment(exclusions, `delay_${key}`, value));
  return {
    key: 'arrival_delay',
    version: 1,
    status,
    timezone: TIME_ZONE,
    candidateCount,
    reliableSampleSize: sampleSize,
    coverage,
    minimumSampleSize,
    minimumCoverage,
    lateCount: available ? lateDelays.length : null,
    lateRate: available ? lateDelays.length / sampleSize : null,
    lateNumerator: available ? lateDelays.length : null,
    lateDenominator: available ? sampleSize : null,
    medianLateMinutes: available ? percentileNearestRank(lateDelays, 0.5) : null,
    p90LateMinutes: available ? percentileNearestRank(lateDelays, 0.9) : null,
    formula: 'arrivée fiable après promised_window_end / arrivées avec créneau structuré fiable',
    exclusions: delayExclusions,
  };
}

function moneyAmount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function currencyCode(row) {
  const value = field(row, 'currency');
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}

function currencyBucket(map, currency) {
  if (!map.has(currency)) {
    map.set(currency, {
      currency,
      expectedForClosedOrdersMinor: 0,
      collectedGrossMinor: 0,
      collectionReversalsMinor: 0,
      adjustmentsInflowMinor: 0,
      adjustmentsOutflowMinor: 0,
      netCollectedMinor: 0,
      collectionEventCount: 0,
      adjustmentCount: 0,
    });
  }
  return map.get(currency);
}

function buildCollections(arrays, closedOrderIds, period, exclusions) {
  const currencies = new Map();

  for (const account of arrays.paymentAccounts) {
    const id = orderId(account, exclusions, 'payment_account');
    if (!id || !closedOrderIds.has(id)) continue;
    const currency = currencyCode(account);
    const amount = moneyAmount(field(account, 'expectedAmountMinor', 'expected_amount_minor'));
    if (!currency || amount === null) {
      increment(exclusions, 'payment_account_invalid_currency_or_amount');
      continue;
    }
    currencyBucket(currencies, currency).expectedForClosedOrdersMinor += amount;
  }

  for (const event of arrays.paymentEvents) {
    const eventType = field(event, 'eventType', 'event_type');
    if (!['collected', 'reversed'].includes(eventType)) continue;
    const timestamp = optionalInstant(field(event, 'createdAt', 'created_at'), exclusions, 'payment_event_created_at');
    if (timestamp === null || !inPeriod(timestamp, period)) continue;
    const currency = currencyCode(event);
    const amount = moneyAmount(field(event, 'amountMinor', 'amount_minor'));
    if (!currency || amount === null) {
      increment(exclusions, 'payment_event_invalid_currency_or_amount');
      continue;
    }
    const bucket = currencyBucket(currencies, currency);
    if (eventType === 'collected') {
      bucket.collectedGrossMinor += amount;
      bucket.collectionEventCount += 1;
    } else {
      bucket.collectionReversalsMinor += amount;
    }
  }

  for (const adjustment of arrays.paymentAdjustments) {
    const effectiveDate = field(adjustment, 'effectiveDate', 'effective_date');
    if (!validDateOnly(effectiveDate)) {
      increment(exclusions, 'payment_adjustment_invalid_effective_date');
      continue;
    }
    if (effectiveDate < period.startLocalDate || effectiveDate >= period.endLocalDateExclusive) continue;
    const currency = currencyCode(adjustment);
    const amount = moneyAmount(field(adjustment, 'amountMinor', 'amount_minor'));
    const direction = field(adjustment, 'direction');
    if (!currency || amount === null || !['inflow', 'outflow'].includes(direction)) {
      increment(exclusions, 'payment_adjustment_invalid_currency_amount_or_direction');
      continue;
    }
    const bucket = currencyBucket(currencies, currency);
    bucket.adjustmentCount += 1;
    bucket[direction === 'inflow' ? 'adjustmentsInflowMinor' : 'adjustmentsOutflowMinor'] += amount;
  }

  const values = [...currencies.values()].sort((left, right) => left.currency.localeCompare(right.currency, 'en'));
  for (const bucket of values) {
    bucket.netCollectedMinor = bucket.collectedGrossMinor
      - bucket.collectionReversalsMinor
      + bucket.adjustmentsInflowMinor
      - bucket.adjustmentsOutflowMinor;
  }
  return {
    key: 'collections',
    version: 1,
    status: values.length ? 'available' : 'no_data',
    accountingScope: 'operational_cash_ledger_not_statutory_accounts',
    currencies: values,
    formula: 'collectes - annulations + ajustements entrants - ajustements sortants, sans conversion de devise',
  };
}

function buildIncidentMetrics(incidents, pickedUpOrderIds, period, asOf, exclusions) {
  let opened = 0;
  let resolved = 0;
  let openAtAsOf = 0;
  const categories = {};
  const incidentOrderIds = new Set();

  for (const incident of incidents) {
    const id = orderId(incident, exclusions, 'incident');
    const createdAt = optionalInstant(field(incident, 'createdAt', 'created_at'), exclusions, 'incident_created_at');
    if (!id || createdAt === null) continue;
    const resolvedValue = field(incident, 'resolvedAt', 'resolved_at');
    const hasResolutionDate = resolvedValue !== undefined && resolvedValue !== null && resolvedValue !== '';
    const resolvedAt = hasResolutionDate
      ? optionalInstant(resolvedValue, exclusions, 'incident_resolved_at')
      : null;
    if (inPeriod(createdAt, period)) {
      opened += 1;
      incidentOrderIds.add(id);
      const category = field(incident, 'category');
      increment(categories, typeof category === 'string' && category ? category : 'unknown');
    }
    const resolutionSequenceValid = !hasResolutionDate
      || (resolvedAt !== null && resolvedAt >= createdAt);
    if (resolvedAt !== null && resolvedAt < createdAt) {
      increment(exclusions, 'incident_resolution_before_creation');
    }
    if (resolutionSequenceValid && resolvedAt !== null && inPeriod(resolvedAt, period)) resolved += 1;
    if (resolutionSequenceValid
      && createdAt <= asOf
      && (resolvedAt === null || resolvedAt > asOf)) openAtAsOf += 1;
  }

  const pickedUpIncidentOrderIds = new Set(
    [...incidentOrderIds].filter((id) => pickedUpOrderIds.has(id)),
  );

  return {
    opened: metric({
      key: 'incidents_opened', value: opened, population: 'incidents créés dans la période',
      formula: 'count(distinct incident_id)',
    }),
    resolved: metric({
      key: 'incidents_resolved', value: resolved, population: 'incidents résolus dans la période',
      formula: 'count(distinct incident_id avec resolved_at dans la période)',
    }),
    openAtAsOf: metric({
      key: 'incidents_open_at_as_of', value: openAtAsOf, population: 'incidents ouverts à asOf',
      formula: 'created_at <= asOf et (resolved_at absent ou > asOf)',
    }),
    ordersWithIncident: incidentOrderIds.size,
    per100PickedUpOrders: {
      ...ratioMetric({
        key: 'incident_orders_per_picked_up_order',
        numerator: pickedUpIncidentOrderIds.size,
        denominator: pickedUpOrderIds.size,
        population: 'commandes avec incident ouvert dans la période / commandes prises en charge dans la période',
        formula: 'commandes distinctes avec incident / commandes distinctes ayant atteint Récupérée',
      }),
      displayMultiplier: 100,
    },
    byCategory: Object.fromEntries(Object.entries(categories).sort(([left], [right]) => left.localeCompare(right, 'fr'))),
    attributionWarning: 'Un incident rattaché à une commande ne prouve pas une faute du livreur.',
  };
}

function activeAssignment(stop, run, order, asOf, exclusions) {
  if (!run || !order || !OPEN_RUN_STATUSES.has(field(run, 'status'))) return false;
  if (TERMINAL_STATUSES.has(field(order, 'status'))) return false;
  if (field(stop, 'assignmentActive', 'assignment_active') !== true) return false;
  const createdAt = optionalInstant(field(stop, 'createdAt', 'created_at'), exclusions, 'stop_created_at');
  if (createdAt === null || createdAt > asOf) return false;
  const removedValue = field(stop, 'removedAt', 'removed_at');
  if (removedValue === undefined || removedValue === null || removedValue === '') return true;
  const removedAt = optionalInstant(removedValue, exclusions, 'stop_removed_at');
  return removedAt !== null && removedAt > asOf;
}

function buildLoad(arrays, asOf, exclusions) {
  const runsById = new Map();
  const ordersById = new Map();
  const driversById = new Map();
  arrays.runs.forEach((run) => {
    const id = rowId(run, exclusions, 'run');
    if (id) runsById.set(id, run);
  });
  arrays.orders.forEach((order) => {
    const id = rowId(order, exclusions, 'order');
    if (id) ordersById.set(id, order);
  });
  arrays.drivers.forEach((driver) => {
    const id = rowId(driver, exclusions, 'driver');
    if (id) driversById.set(id, driver);
  });

  const load = new Map();
  for (const stop of arrays.stops) {
    const runValue = field(stop, 'runId', 'run_id');
    const orderValue = field(stop, 'orderId', 'order_id');
    const run = runValue === undefined ? null : runsById.get(String(runValue));
    const order = orderValue === undefined ? null : ordersById.get(String(orderValue));
    if (!run || !order) {
      increment(exclusions, 'active_stop_missing_run_or_order');
      continue;
    }
    if (!activeAssignment(stop, run, order, asOf, exclusions)) continue;
    const id = driverId(run, exclusions, 'run');
    if (!id) continue;
    const entry = load.get(id) || { openParcels: 0, inProgressParcels: 0 };
    entry.openParcels += 1;
    if (field(run, 'status') === 'active') entry.inProgressParcels += 1;
    load.set(id, entry);
  }

  const drivers = [...load.entries()].map(([id, values]) => {
    const driver = driversById.get(id);
    const rawCapacity = field(driver, 'capacity');
    const capacity = Number.isInteger(rawCapacity) && rawCapacity > 0 ? rawCapacity : null;
    if (capacity === null) increment(exclusions, 'driver_capacity_missing_or_invalid');
    return {
      driverId: id,
      openParcels: values.openParcels,
      inProgressParcels: values.inProgressParcels,
      declaredCapacity: capacity,
      capacityUse: capacity === null ? null : values.openParcels / capacity,
      availabilityStatus: field(driver, 'availabilityStatus', 'availability_status') ?? null,
    };
  }).sort((left, right) => left.driverId.localeCompare(right.driverId, 'en'));

  return {
    key: 'active_load_snapshot',
    version: 1,
    status: 'available',
    asOf: new Date(asOf).toISOString(),
    openParcelCount: drivers.reduce((sum, driver) => sum + driver.openParcels, 0),
    inProgressParcelCount: drivers.reduce((sum, driver) => sum + driver.inProgressParcels, 0),
    driversWithLoad: drivers.length,
    drivers,
    warning: 'Indicateur instantané de répartition, pas une mesure de productivité.',
  };
}

function assignmentDriverAt(order, timestamp, arrays, runsById, exclusions) {
  const matches = new Set();
  for (const stop of arrays.stops) {
    const stopOrderId = field(stop, 'orderId', 'order_id');
    if (stopOrderId === undefined || String(stopOrderId) !== String(order)) continue;
    const createdAt = optionalInstant(field(stop, 'createdAt', 'created_at'), exclusions, 'stop_created_at');
    if (createdAt === null || createdAt > timestamp) continue;
    const removedValue = field(stop, 'removedAt', 'removed_at');
    if (removedValue !== undefined && removedValue !== null && removedValue !== '') {
      const removedAt = optionalInstant(removedValue, exclusions, 'stop_removed_at');
      if (removedAt === null || removedAt <= timestamp) continue;
    }
    const runValue = field(stop, 'runId', 'run_id');
    const run = runValue === undefined ? null : runsById.get(String(runValue));
    const id = run ? driverId(run, exclusions, 'run') : null;
    if (id) matches.add(id);
  }
  if (matches.size !== 1) {
    increment(exclusions, matches.size === 0 ? 'activity_event_without_assignment' : 'activity_event_ambiguous_assignment');
    return null;
  }
  return [...matches][0];
}

function buildDriverActivity(arrays, pickups, terminals, period, exclusions) {
  const runsById = new Map();
  arrays.runs.forEach((run) => {
    const id = rowId(run, exclusions, 'run');
    if (id) runsById.set(id, run);
  });
  const activity = new Map();
  const ensure = (id) => {
    if (!activity.has(id)) {
      activity.set(id, {
        driverId: id,
        assignmentsCreated: 0,
        runsStarted: 0,
        ordersPickedUp: 0,
        ordersDelivered: 0,
        ordersReturned: 0,
        incidentContexts: 0,
      });
    }
    return activity.get(id);
  };

  arrays.drivers.forEach((driver) => {
    const id = rowId(driver, exclusions, 'driver');
    if (id) ensure(id);
  });

  for (const stop of arrays.stops) {
    const createdAt = optionalInstant(field(stop, 'createdAt', 'created_at'), exclusions, 'stop_created_at');
    if (createdAt === null || !inPeriod(createdAt, period)) continue;
    const runValue = field(stop, 'runId', 'run_id');
    const run = runValue === undefined ? null : runsById.get(String(runValue));
    const id = run ? driverId(run, exclusions, 'run') : null;
    if (id) ensure(id).assignmentsCreated += 1;
  }

  for (const run of arrays.runs) {
    const startedValue = field(run, 'startedAt', 'started_at');
    if (startedValue === undefined || startedValue === null || startedValue === '') continue;
    const startedAt = optionalInstant(startedValue, exclusions, 'run_started_at');
    const id = driverId(run, exclusions, 'run');
    if (startedAt !== null && id && inPeriod(startedAt, period)) ensure(id).runsStarted += 1;
  }

  for (const [id, pickup] of pickups) {
    if (!inPeriod(pickup.timestamp, period)) continue;
    const assigned = assignmentDriverAt(id, pickup.timestamp, arrays, runsById, exclusions);
    if (assigned) ensure(assigned).ordersPickedUp += 1;
  }
  for (const [id, terminal] of terminals) {
    if (!inPeriod(terminal.timestamp, period) || !['Livrée', 'Retournée'].includes(terminal.status)) continue;
    const assigned = assignmentDriverAt(id, terminal.timestamp, arrays, runsById, exclusions);
    if (!assigned) continue;
    ensure(assigned)[terminal.status === 'Livrée' ? 'ordersDelivered' : 'ordersReturned'] += 1;
  }
  for (const incident of arrays.incidents) {
    const id = orderId(incident, exclusions, 'incident');
    const createdAt = optionalInstant(field(incident, 'createdAt', 'created_at'), exclusions, 'incident_created_at');
    if (!id || createdAt === null || !inPeriod(createdAt, period)) continue;
    const assigned = assignmentDriverAt(id, createdAt, arrays, runsById, exclusions);
    if (assigned) ensure(assigned).incidentContexts += 1;
  }

  return {
    key: 'driver_activity_context',
    version: 1,
    status: 'available',
    ordering: 'driver_id_ascending_not_performance',
    ranking: null,
    automaticDecision: false,
    drivers: [...activity.values()].sort((left, right) => left.driverId.localeCompare(right.driverId, 'en')),
    warnings: [
      'Les incidents sont des contextes rattachés, pas une attribution de faute.',
      'Aucun score, classement, sanction ou affectation automatique ne peut être dérivé de cette sortie.',
    ],
  };
}

function calculateCrmMetrics(input, options = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input est obligatoire.');
  const arrays = sourceArrays(input);
  const companyId = assertTenant(field(input, 'companyId', 'company_id'), arrays);
  const period = normalizePeriod(input.period);
  const asOf = explicitInstant(input.asOf, 'asOf');
  const exclusions = {};

  const ordersById = new Map();
  let createdCount = 0;
  for (const order of arrays.orders) {
    const id = rowId(order, exclusions, 'order');
    if (!id) continue;
    if (ordersById.has(id)) {
      increment(exclusions, 'duplicate_order_id');
      continue;
    }
    ordersById.set(id, order);
    const createdAt = optionalInstant(field(order, 'createdAt', 'created_at'), exclusions, 'order_created_at');
    if (createdAt !== null && inPeriod(createdAt, period)) createdCount += 1;
  }

  const pickups = firstStatusEvents(arrays.statusEvents, 'Récupérée', exclusions);
  const arrivals = firstStatusEvents(arrays.statusEvents, 'Arrivée', exclusions);
  const terminals = terminalEvents(arrays.statusEvents, exclusions);
  const pickupsInPeriod = [...pickups.entries()].filter(([id, event]) => {
    if (!inPeriod(event.timestamp, period)) return false;
    if (ordersById.has(id)) return true;
    increment(exclusions, 'pickup_event_order_missing');
    return false;
  });
  const pickedUpOrderIds = new Set(pickupsInPeriod.map(([id]) => id));
  const terminalInPeriod = [...terminals.entries()].filter(([id, event]) => {
    if (!inPeriod(event.timestamp, period)) return false;
    if (ordersById.has(id)) return true;
    increment(exclusions, 'terminal_event_order_missing');
    return false;
  });
  const outcomes = { delivered: 0, returned: 0, cancelled: 0 };
  const outcomeKey = { 'Livrée': 'delivered', 'Retournée': 'returned', 'Annulée': 'cancelled' };
  terminalInPeriod.forEach(([, event]) => { outcomes[outcomeKey[event.status]] += 1; });
  const closedOrderIds = new Set(terminalInPeriod.map(([id]) => id));

  return {
    contractVersion: CONTRACT_VERSION,
    companyId,
    timezone: TIME_ZONE,
    period: {
      startInclusive: period.startIso,
      endExclusive: period.endIso,
      startLocalDate: period.startLocalDate,
      endLocalDateExclusive: period.endLocalDateExclusive,
      boundaryRule: '[start, end)',
    },
    asOf: new Date(asOf).toISOString(),
    guardrails: {
      ranking: false,
      automaticSanction: false,
      automaticAssignmentDecision: false,
      humanReviewRequired: true,
    },
    volumes: {
      ordersCreated: metric({
        key: 'orders_created', value: createdCount,
        population: 'commandes dont created_at est dans la période',
        formula: 'count(distinct order_id)',
      }),
      ordersPickedUp: metric({
        key: 'orders_picked_up', value: pickedUpOrderIds.size,
        population: 'premier événement Récupérée de chaque commande dans la période',
        formula: 'count(distinct order_id)',
      }),
      closed: metric({
        key: 'orders_closed', value: terminalInPeriod.length,
        population: 'premier événement terminal non conflictuel dans la période',
        formula: 'Livrée + Retournée + Annulée',
      }),
      outcomes,
    },
    delivery: {
      deliveryRate: ratioMetric({
        key: 'delivery_rate',
        numerator: outcomes.delivered,
        denominator: outcomes.delivered + outcomes.returned,
        population: 'commandes clôturées Livrée ou Retournée dans la période',
        formula: 'Livrée / (Livrée + Retournée); Annulée exclue',
      }),
    },
    delays: buildDelayMetrics(ordersById, arrivals, period, options, exclusions),
    collections: buildCollections(arrays, closedOrderIds, period, exclusions),
    incidents: buildIncidentMetrics(arrays.incidents, pickedUpOrderIds, period, asOf, exclusions),
    load: buildLoad(arrays, asOf, exclusions),
    driverActivity: buildDriverActivity(arrays, pickups, terminals, period, exclusions),
    dataQuality: {
      status: Object.keys(exclusions).length ? 'has_exclusions' : 'complete_for_requested_metrics',
      exclusions: Object.fromEntries(Object.entries(exclusions).sort(([left], [right]) => left.localeCompare(right, 'en'))),
      missingArraysAreEmpty: true,
    },
  };
}

module.exports = {
  CONTRACT_VERSION,
  TIME_ZONE,
  calculateCrmMetrics,
  portoNovoDateKey,
};
