'use strict';

const crypto = require('node:crypto');

const PORTO_NOVO_TIME_ZONE = 'Africa/Porto-Novo';
const MINUTE_MS = 60_000;
const MAX_DIMENSIONS = 32;
const MAX_RESERVATIONS = 10_000;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const DIMENSION_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;

class DispatchPolicyError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'DispatchPolicyError';
    this.code = code;
    this.details = details;
  }
}

const portoNovoFormatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
  timeZone: PORTO_NOVO_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Validates a customer time window expressed in Porto-Novo civil time.
 * No implicit Date.now() call is made: callers opt into past/lead-time checks
 * by supplying options.now.
 */
function validatePortoNovoTimeWindow(input, options = {}) {
  const minWindowMinutes = integerOption(options.minWindowMinutes, 5, 1, 1_440, 'min_window_minutes');
  const maxWindowMinutes = integerOption(
    options.maxWindowMinutes,
    1_440,
    minWindowMinutes,
    7 * 1_440,
    'max_window_minutes',
  );
  const minLeadMinutes = integerOption(options.minLeadMinutes, 0, 0, 30 * 1_440, 'min_lead_minutes');
  const errors = [];

  if (!isPlainObject(input)) {
    return result(false, [issue('window_required', 'window')], null);
  }
  if (input.timeZone !== undefined && input.timeZone !== PORTO_NOVO_TIME_ZONE) {
    errors.push(issue('unsupported_time_zone', 'timeZone', { expected: PORTO_NOVO_TIME_ZONE }));
  }

  const start = parseLocalDateTimeField(input.startLocal, 'startLocal', errors);
  const end = parseLocalDateTimeField(input.endLocal, 'endLocal', errors);
  let durationMinutes = null;

  if (start && end) {
    durationMinutes = (end.epochMs - start.epochMs) / MINUTE_MS;
    if (durationMinutes <= 0) {
      errors.push(issue('window_end_not_after_start', 'endLocal'));
    } else {
      if (durationMinutes < minWindowMinutes) {
        errors.push(issue('window_too_short', 'endLocal', { minWindowMinutes }));
      }
      if (durationMinutes > maxWindowMinutes) {
        errors.push(issue('window_too_long', 'endLocal', { maxWindowMinutes }));
      }
    }
  }

  if (start && options.now !== undefined) {
    const nowMs = parseNow(options.now);
    const earliestStart = nowMs + (minLeadMinutes * MINUTE_MS);
    if (start.epochMs < earliestStart) {
      errors.push(issue('window_starts_too_early', 'startLocal', {
        earliestStartAt: new Date(earliestStart).toISOString(),
      }));
    }
  }

  const value = start && end && errors.length === 0
    ? {
        timeZone: PORTO_NOVO_TIME_ZONE,
        startLocal: input.startLocal,
        endLocal: input.endLocal,
        startAt: new Date(start.epochMs).toISOString(),
        endAt: new Date(end.epochMs).toISOString(),
        durationMinutes,
      }
    : null;
  return result(errors.length === 0, errors, value);
}

function validateServiceDuration(minutes, options = {}) {
  const minMinutes = integerOption(options.minMinutes, 1, 1, 1_440, 'min_service_minutes');
  const maxMinutes = integerOption(options.maxMinutes, 480, minMinutes, 7 * 1_440, 'max_service_minutes');
  const errors = [];
  if (!Number.isSafeInteger(minutes)) {
    errors.push(issue('service_duration_must_be_integer', 'serviceMinutes'));
  } else {
    if (minutes < minMinutes) errors.push(issue('service_duration_too_short', 'serviceMinutes', { minMinutes }));
    if (minutes > maxMinutes) errors.push(issue('service_duration_too_long', 'serviceMinutes', { maxMinutes }));
  }
  return result(errors.length === 0, errors, errors.length === 0 ? { minutes } : null);
}

/**
 * Evaluates all declared capacity dimensions independently. Typical dimensions
 * are parcelCount, weightKg or volumeM3; units must never be mixed by callers.
 */
function evaluateCapacity(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return capacityResult(false, false, [issue('capacity_required', 'capacity')], [], {});
  }

  const limits = normalizeDimensionObject(input.limits, 'limits', errors, { requireNonEmpty: true });
  const currentLoad = normalizeDimensionObject(input.currentLoad, 'currentLoad', errors, { defaultEmpty: true });
  const additionalLoad = normalizeDimensionObject(input.additionalLoad, 'additionalLoad', errors, { defaultEmpty: true });
  const limitNames = new Set(Object.keys(limits));

  for (const name of [...Object.keys(currentLoad), ...Object.keys(additionalLoad)]) {
    if (!limitNames.has(name)) {
      errors.push(issue('capacity_limit_missing', `limits.${name}`, { dimension: name }));
    }
  }

  const dimensions = {};
  const violations = [];
  if (errors.length === 0) {
    for (const name of Object.keys(limits).sort()) {
      const limit = limits[name];
      const current = currentLoad[name] || 0;
      const additional = additionalLoad[name] || 0;
      const projected = current + additional;
      if (!Number.isFinite(projected) || projected > 1_000_000_000_000) {
        errors.push(issue('capacity_sum_out_of_range', `additionalLoad.${name}`, { dimension: name }));
        continue;
      }
      const overBy = Math.max(0, projected - limit);
      dimensions[name] = {
        limit,
        current,
        additional,
        projected,
        remainingBefore: Math.max(0, limit - current),
        remainingAfter: Math.max(0, limit - projected),
        feasible: overBy === 0,
        overBy,
      };
      if (current > limit) {
        violations.push(issue('existing_load_exceeds_capacity', `currentLoad.${name}`, { dimension: name, overBy: current - limit }));
      } else if (projected > limit) {
        violations.push(issue('additional_load_exceeds_capacity', `additionalLoad.${name}`, { dimension: name, overBy }));
      }
    }
  }

  return capacityResult(
    errors.length === 0,
    errors.length === 0 && violations.length === 0,
    errors,
    violations,
    dimensions,
  );
}

/**
 * Finds collisions between explicit planned service reservations. Intervals
 * are half-open [start, end), so two adjacent reservations do not overlap.
 */
function findScheduleOverlaps(candidate, existingReservations = []) {
  const errors = [];
  const normalizedCandidate = normalizeReservation(candidate, 'candidate', errors);
  if (!Array.isArray(existingReservations)) {
    errors.push(issue('reservations_must_be_array', 'existingReservations'));
    existingReservations = [];
  } else if (existingReservations.length > MAX_RESERVATIONS) {
    errors.push(issue('too_many_reservations', 'existingReservations', { maximum: MAX_RESERVATIONS }));
    existingReservations = [];
  }

  const normalizedExisting = existingReservations.map((reservation, index) =>
    normalizeReservation(reservation, `existingReservations[${index}]`, errors));
  const overlaps = [];

  if (normalizedCandidate && errors.length === 0) {
    for (const reservation of normalizedExisting) {
      if (!reservation) continue;
      if (normalizedCandidate.id && reservation.id === normalizedCandidate.id) continue;
      const overlapStart = Math.max(normalizedCandidate.startMs, reservation.startMs);
      const overlapEnd = Math.min(normalizedCandidate.endMs, reservation.endMs);
      if (overlapStart < overlapEnd) {
        overlaps.push({
          reservationId: reservation.id,
          overlapStartAt: new Date(overlapStart).toISOString(),
          overlapEndAt: new Date(overlapEnd).toISOString(),
          overlapMinutes: (overlapEnd - overlapStart) / MINUTE_MS,
        });
      }
    }
  }

  overlaps.sort((left, right) =>
    left.overlapStartAt.localeCompare(right.overlapStartAt)
      || String(left.reservationId || '').localeCompare(String(right.reservationId || '')));
  return deepFreeze({
    valid: errors.length === 0,
    hasOverlap: errors.length === 0 && overlaps.length > 0,
    errors,
    overlaps,
    convention: 'half_open_interval',
  });
}

/**
 * Builds a non-executing dispatch proposal from explicit operational facts.
 * It never ranks a driver, estimates travel, assigns automatically or reads
 * performance metrics.
 */
function createDispatchProposal(input, options = {}) {
  const errors = [];
  if (!isPlainObject(input)) {
    return blockedProposal([issue('dispatch_input_required', 'input')]);
  }

  const orderId = normalizeIdentifier(input.orderId, 'orderId', errors);
  const driverId = normalizeIdentifier(input.driverId, 'driverId', errors);
  const windowCheck = validatePortoNovoTimeWindow(input.window, options.window);
  const serviceCheck = validateServiceDuration(input.serviceMinutes, options.service);
  const capacityCheck = evaluateCapacity(input.capacity);
  errors.push(...prefixIssues(windowCheck.errors, 'window'));
  errors.push(...prefixIssues(serviceCheck.errors, 'service'));
  errors.push(...prefixIssues(capacityCheck.errors, 'capacity'));
  errors.push(...prefixIssues(capacityCheck.violations, 'capacity'));

  let plannedService = null;
  let overlapCheck = deepFreeze({ valid: false, hasOverlap: false, errors: [], overlaps: [], convention: 'half_open_interval' });
  if (serviceCheck.valid) {
    const plannedStartMs = parseInstantField(input.plannedStartAt, 'plannedStartAt', errors);
    if (plannedStartMs !== null) {
      const plannedEndMs = plannedStartMs + (serviceCheck.value.minutes * MINUTE_MS);
      if (!Number.isSafeInteger(plannedEndMs)) {
        errors.push(issue('planned_service_out_of_range', 'plannedStartAt'));
      } else {
        plannedService = {
          id: input.reservationId === undefined ? null : normalizeIdentifier(input.reservationId, 'reservationId', errors),
          startAt: new Date(plannedStartMs).toISOString(),
          endAt: new Date(plannedEndMs).toISOString(),
          durationMinutes: serviceCheck.value.minutes,
          basis: 'human_planned_service_start',
        };
      }
    }
  }

  if (plannedService && windowCheck.valid) {
    const plannedStartMs = Date.parse(plannedService.startAt);
    const plannedEndMs = Date.parse(plannedService.endAt);
    const windowStartMs = Date.parse(windowCheck.value.startAt);
    const windowEndMs = Date.parse(windowCheck.value.endAt);
    if (plannedStartMs < windowStartMs) {
      errors.push(issue('planned_service_before_window', 'plannedStartAt'));
    }
    if (plannedStartMs >= windowEndMs) {
      errors.push(issue('planned_service_starts_after_window', 'plannedStartAt'));
    }
    if (plannedEndMs > windowEndMs) {
      errors.push(issue('planned_service_ends_after_window', 'serviceMinutes'));
    }

    overlapCheck = findScheduleOverlaps(plannedService, input.existingReservations || []);
    errors.push(...prefixIssues(overlapCheck.errors, 'schedule'));
    if (overlapCheck.hasOverlap) {
      errors.push(issue('planned_service_overlaps_existing', 'plannedStartAt', {
        reservationIds: overlapCheck.overlaps.map((entry) => entry.reservationId),
      }));
    }
  } else if (input.existingReservations !== undefined && !Array.isArray(input.existingReservations)) {
    errors.push(issue('reservations_must_be_array', 'existingReservations'));
  }

  const checks = {
    timeWindow: windowCheck,
    serviceDuration: serviceCheck,
    capacity: capacityCheck,
    schedule: overlapCheck,
  };
  const normalized = {
    orderId,
    driverId,
    timeWindow: windowCheck.value,
    plannedService,
    capacity: capacityCheck.dimensions,
    scheduleConflicts: overlapCheck.overlaps,
  };
  const proposalId = makeProposalId({ normalized, errors });
  const confirmable = errors.length === 0;

  return deepFreeze({
    proposalId,
    status: confirmable ? 'ready_for_human_confirmation' : 'blocked',
    confirmable,
    requiresHumanConfirmation: true,
    autoAssign: false,
    recommendation: confirmable ? 'eligible_for_review' : 'do_not_assign',
    errors,
    checks,
    normalized,
    exclusions: [
      'travel_time_not_evaluated',
      'traffic_not_evaluated',
      'route_not_evaluated',
      'driver_performance_not_evaluated',
    ],
  });
}

/**
 * Records an explicit human approval/rejection without performing persistence
 * or assignment. expectedProposalId is mandatory to reject stale screens.
 */
function recordHumanDispatchDecision(proposal, input) {
  const errors = [];
  if (!isPlainObject(proposal) || typeof proposal.proposalId !== 'string') {
    return result(false, [issue('proposal_required', 'proposal')], null);
  }
  if (!isPlainObject(input)) {
    return result(false, [issue('decision_required', 'decision')], null);
  }

  const expectedProposalId = normalizeIdentifier(input.expectedProposalId, 'expectedProposalId', errors);
  if (expectedProposalId && expectedProposalId !== proposal.proposalId) {
    errors.push(issue('stale_proposal', 'expectedProposalId'));
  }
  const actorId = normalizeIdentifier(input.actorId, 'actorId', errors);
  const decidedAtMs = parseInstantField(input.decidedAt, 'decidedAt', errors);
  const decision = input.decision;
  if (!['approve', 'reject'].includes(decision)) {
    errors.push(issue('invalid_human_decision', 'decision'));
  }

  const reason = input.reason === undefined || input.reason === null ? '' : String(input.reason).trim();
  if (reason.length > 500) errors.push(issue('decision_reason_too_long', 'reason', { maximum: 500 }));
  if (decision === 'reject' && reason.length === 0) errors.push(issue('decision_reason_required', 'reason'));
  if (decision === 'approve' && proposal.confirmable !== true) {
    errors.push(issue('blocked_proposal_cannot_be_approved', 'decision'));
  }

  const value = errors.length === 0
    ? {
        proposalId: proposal.proposalId,
        decision,
        actorId,
        decidedAt: new Date(decidedAtMs).toISOString(),
        reason: reason || null,
        assignmentAuthorized: decision === 'approve',
        persistencePerformed: false,
      }
    : null;
  return result(errors.length === 0, errors, value);
}

function blockedProposal(errors) {
  return deepFreeze({
    proposalId: makeProposalId({ errors }),
    status: 'blocked',
    confirmable: false,
    requiresHumanConfirmation: true,
    autoAssign: false,
    recommendation: 'do_not_assign',
    errors,
    checks: null,
    normalized: null,
    exclusions: [
      'travel_time_not_evaluated',
      'traffic_not_evaluated',
      'route_not_evaluated',
      'driver_performance_not_evaluated',
    ],
  });
}

function parseLocalDateTimeField(value, field, errors) {
  if (typeof value !== 'string') {
    errors.push(issue('local_datetime_required', field));
    return null;
  }
  const match = LOCAL_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    errors.push(issue('invalid_local_datetime_format', field, { expected: 'YYYY-MM-DDTHH:mm' }));
    return null;
  }

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
  };
  if (!isValidGregorianDateTime(parts)) {
    errors.push(issue('invalid_local_datetime', field));
    return null;
  }

  const epochMs = localPartsToPortoNovoEpoch(parts);
  if (epochMs === null) {
    errors.push(issue('unresolvable_local_datetime', field));
    return null;
  }
  return { parts, epochMs };
}

function localPartsToPortoNovoEpoch(target) {
  const targetAsUtc = partsToUtcEpoch(target);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = formatPortoNovoParts(candidate);
    const delta = targetAsUtc - partsToUtcEpoch(represented);
    if (delta === 0) break;
    candidate += delta;
  }
  return sameDateTime(formatPortoNovoParts(candidate), target) ? candidate : null;
}

function formatPortoNovoParts(epochMs) {
  const values = {};
  for (const part of portoNovoFormatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function partsToUtcEpoch(parts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second || 0, 0);
  return date.getTime();
}

function isValidGregorianDateTime(parts) {
  if (parts.year < 1970 || parts.year > 9999) return false;
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return false;
  if (parts.hour < 0 || parts.hour > 23 || parts.minute < 0 || parts.minute > 59) return false;
  if (!Number.isInteger(parts.second) || parts.second < 0 || parts.second > 59) return false;
  const epochMs = partsToUtcEpoch(parts);
  const date = new Date(epochMs);
  return date.getUTCFullYear() === parts.year
    && date.getUTCMonth() + 1 === parts.month
    && date.getUTCDate() === parts.day
    && date.getUTCHours() === parts.hour
    && date.getUTCMinutes() === parts.minute
    && date.getUTCSeconds() === parts.second;
}

function sameDateTime(left, right) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === (right.second || 0);
}

function normalizeDimensionObject(value, field, errors, options = {}) {
  if (value === undefined && options.defaultEmpty) return {};
  if (!isPlainObject(value)) {
    errors.push(issue('capacity_dimensions_required', field));
    return {};
  }
  const names = Object.keys(value);
  if (options.requireNonEmpty && names.length === 0) errors.push(issue('capacity_limits_empty', field));
  if (names.length > MAX_DIMENSIONS) {
    errors.push(issue('too_many_capacity_dimensions', field, { maximum: MAX_DIMENSIONS }));
    return {};
  }
  const normalized = {};
  for (const name of names.sort()) {
    if (!DIMENSION_PATTERN.test(name)) {
      errors.push(issue('invalid_capacity_dimension', `${field}.${name}`));
      continue;
    }
    const amount = value[name];
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000) {
      errors.push(issue('invalid_capacity_amount', `${field}.${name}`));
      continue;
    }
    normalized[name] = amount;
  }
  return normalized;
}

function normalizeReservation(value, field, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue('reservation_required', field));
    return null;
  }
  const id = value.id === undefined || value.id === null
    ? null
    : normalizeIdentifier(value.id, `${field}.id`, errors);
  const startMs = parseInstantField(value.startAt, `${field}.startAt`, errors);
  const endMs = parseInstantField(value.endAt, `${field}.endAt`, errors);
  if (startMs !== null && endMs !== null && endMs <= startMs) {
    errors.push(issue('reservation_end_not_after_start', `${field}.endAt`));
  }
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { id, startMs, endMs };
}

function parseInstantField(value, field, errors) {
  const match = typeof value === 'string' ? INSTANT_PATTERN.exec(value) : null;
  if (!match) {
    errors.push(issue('absolute_instant_required', field));
    return null;
  }
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] === undefined ? 0 : Number(match[6]),
  };
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (!isValidGregorianDateTime(parts) || offsetHour > 23 || offsetMinute > 59) {
    errors.push(issue('invalid_absolute_instant', field));
    return null;
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    errors.push(issue('invalid_absolute_instant', field));
    return null;
  }
  return epochMs;
}

function parseNow(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const errors = [];
    const epochMs = parseInstantField(value, 'now', errors);
    if (epochMs !== null) return epochMs;
  }
  throw new DispatchPolicyError('invalid_now');
}

function normalizeIdentifier(value, field, errors) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) {
    errors.push(issue('identifier_required', field));
    return null;
  }
  const normalized = String(value).trim();
  if (normalized.length === 0 || normalized.length > 128) {
    errors.push(issue('invalid_identifier', field, { maximum: 128 }));
    return null;
  }
  return normalized;
}

function prefixIssues(issues, prefix) {
  return issues.map((entry) => ({
    ...entry,
    field: entry.field ? `${prefix}.${entry.field}` : prefix,
  }));
}

function makeProposalId(value) {
  const digest = crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
  return `dp_${digest}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function issue(code, field, details = {}) {
  return { code, field, ...details };
}

function result(valid, errors, value) {
  return deepFreeze({ valid, errors, value });
}

function capacityResult(valid, feasible, errors, violations, dimensions) {
  return deepFreeze({ valid, feasible, errors, violations, dimensions });
}

function integerOption(value, fallback, minimum, maximum, code) {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new DispatchPolicyError(`invalid_${code}`);
  }
  return normalized;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  PORTO_NOVO_TIME_ZONE,
  DispatchPolicyError,
  validatePortoNovoTimeWindow,
  validateServiceDuration,
  evaluateCapacity,
  findScheduleOverlaps,
  createDispatchProposal,
  recordHumanDispatchDecision,
};
