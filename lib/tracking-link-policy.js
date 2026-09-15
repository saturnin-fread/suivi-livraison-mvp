'use strict';

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const DEFAULT_TRACKING_LINK_TTL_MS = 7 * DAY_MS;
const MIN_TRACKING_LINK_TTL_MS = 15 * MINUTE_MS;
const MAX_TRACKING_LINK_TTL_MS = 30 * DAY_MS;
const LEGACY_NULL_EXPIRY_TTL_MS = MAX_TRACKING_LINK_TTL_MS;

const TRACKING_LINK_STATES = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  TERMINAL: 'terminal',
  UNAVAILABLE: 'unavailable',
});

const TERMINAL_ORDER_STATUSES = Object.freeze(['Livrée', 'Retournée', 'Annulée']);
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,200}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/i;

const GENERIC_UNAVAILABLE_MESSAGE = Object.freeze({
  statusCode: 404,
  code: 'TRACKING_LINK_UNAVAILABLE',
  message: 'Ce lien de suivi n’est plus disponible.',
});

class TrackingLinkPolicyError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'TrackingLinkPolicyError';
    this.code = code;
    this.details = details;
  }
}

function asDate(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TrackingLinkPolicyError('invalid_date', { field });
  }
  return date;
}

function currentDate(value) {
  return value === undefined ? new Date() : asDate(value, 'now');
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TrackingLinkPolicyError('invalid_ttl', { field });
  }
  return value;
}

function normalizePolicy(options = {}) {
  const minimumTtlMs = positiveInteger(
    options.minimumTtlMs ?? MIN_TRACKING_LINK_TTL_MS,
    'minimumTtlMs',
  );
  const maximumTtlMs = positiveInteger(
    options.maximumTtlMs ?? MAX_TRACKING_LINK_TTL_MS,
    'maximumTtlMs',
  );
  const defaultTtlMs = positiveInteger(
    options.defaultTtlMs ?? DEFAULT_TRACKING_LINK_TTL_MS,
    'defaultTtlMs',
  );
  const legacyNullExpiryTtlMs = positiveInteger(
    options.legacyNullExpiryTtlMs ?? LEGACY_NULL_EXPIRY_TTL_MS,
    'legacyNullExpiryTtlMs',
  );

  if (minimumTtlMs > maximumTtlMs) {
    throw new TrackingLinkPolicyError('invalid_ttl_policy', { reason: 'minimum_exceeds_maximum' });
  }
  if (defaultTtlMs < minimumTtlMs || defaultTtlMs > maximumTtlMs) {
    throw new TrackingLinkPolicyError('invalid_ttl_policy', { reason: 'default_out_of_bounds' });
  }
  if (legacyNullExpiryTtlMs > maximumTtlMs) {
    throw new TrackingLinkPolicyError('invalid_ttl_policy', { reason: 'legacy_ttl_exceeds_maximum' });
  }

  return Object.freeze({ minimumTtlMs, maximumTtlMs, defaultTtlMs, legacyNullExpiryTtlMs });
}

function normalizeTrackingLinkTtl(requestedTtlMs, options = {}) {
  const policy = normalizePolicy(options);
  if (requestedTtlMs === undefined || requestedTtlMs === null || requestedTtlMs === '') {
    return policy.defaultTtlMs;
  }
  const ttlMs = positiveInteger(requestedTtlMs, 'requestedTtlMs');
  if (ttlMs < policy.minimumTtlMs) {
    throw new TrackingLinkPolicyError('ttl_too_short', { minimumTtlMs: policy.minimumTtlMs });
  }
  if (ttlMs > policy.maximumTtlMs) {
    throw new TrackingLinkPolicyError('ttl_too_long', { maximumTtlMs: policy.maximumTtlMs });
  }
  return ttlMs;
}

function createTrackingLinkExpiration({ now, ttlMs } = {}, options = {}) {
  const issuedAt = currentDate(now);
  const normalizedTtlMs = normalizeTrackingLinkTtl(ttlMs, options);
  return Object.freeze({
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + normalizedTtlMs).toISOString(),
    ttlMs: normalizedTtlMs,
  });
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function resolveEffectiveExpiration(link, options = {}) {
  if (!link || typeof link !== 'object') {
    return Object.freeze({ expiresAt: null, source: 'missing', valid: false });
  }
  if (hasValue(link.expiresAt ?? link.expires_at)) {
    try {
      const expiresAt = asDate(link.expiresAt ?? link.expires_at, 'expiresAt');
      return Object.freeze({ expiresAt: expiresAt.toISOString(), source: 'explicit', valid: true });
    } catch (_error) {
      return Object.freeze({ expiresAt: null, source: 'invalid_explicit', valid: false });
    }
  }

  const createdAtValue = link.createdAt ?? link.created_at;
  if (!hasValue(createdAtValue)) {
    return Object.freeze({ expiresAt: null, source: 'legacy_missing_created_at', valid: false });
  }
  try {
    const policy = normalizePolicy(options);
    const createdAt = asDate(createdAtValue, 'createdAt');
    return Object.freeze({
      expiresAt: new Date(createdAt.getTime() + policy.legacyNullExpiryTtlMs).toISOString(),
      source: 'legacy_created_at',
      valid: true,
    });
  } catch (_error) {
    return Object.freeze({ expiresAt: null, source: 'legacy_invalid_created_at', valid: false });
  }
}

function terminalStatuses(options = {}) {
  const values = options.terminalStatuses ?? TERMINAL_ORDER_STATUSES;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new TrackingLinkPolicyError('invalid_terminal_statuses');
  }
  return new Set(values);
}

function evaluateTrackingLink(link, options = {}) {
  const now = currentDate(options.now);
  if (!link || typeof link !== 'object') {
    return lifecycleResult(TRACKING_LINK_STATES.UNAVAILABLE, 'missing_link', null, false);
  }

  const revokedAt = link.revokedAt ?? link.revoked_at;
  const rotatedAt = link.rotatedAt ?? link.rotated_at ?? link.supersededAt ?? link.superseded_at;
  if (hasValue(revokedAt) || hasValue(rotatedAt)) {
    return lifecycleResult(
      TRACKING_LINK_STATES.REVOKED,
      hasValue(rotatedAt) ? 'rotated' : 'revoked',
      null,
      false,
    );
  }

  const expiration = resolveEffectiveExpiration(link, options);
  if (!expiration.valid) {
    return lifecycleResult(TRACKING_LINK_STATES.UNAVAILABLE, expiration.source, null, false);
  }
  if (asDate(expiration.expiresAt, 'expiresAt').getTime() <= now.getTime()) {
    return lifecycleResult(TRACKING_LINK_STATES.EXPIRED, 'expired', expiration, false);
  }

  const orderStatus = link.orderStatus ?? link.order_status ?? link.status ?? null;
  if (orderStatus && terminalStatuses(options).has(orderStatus)) {
    return lifecycleResult(TRACKING_LINK_STATES.TERMINAL, 'terminal_order', expiration, false, {
      orderStatus,
      terminalReceiptVisible: true,
    });
  }

  return lifecycleResult(TRACKING_LINK_STATES.ACTIVE, 'active', expiration, true);
}

function lifecycleResult(state, reason, expiration, trackingVisible, extra = {}) {
  return Object.freeze({
    state,
    reason,
    publicTrackingAllowed: trackingVisible,
    positionVisible: trackingVisible,
    shouldRefresh: trackingVisible,
    expiresAt: expiration?.expiresAt ?? null,
    expirationSource: expiration?.source ?? null,
    ...extra,
  });
}

function publicTrackingLinkMessage(state, orderStatus = null) {
  if (state === TRACKING_LINK_STATES.ACTIVE) return null;
  if (state === TRACKING_LINK_STATES.TERMINAL) {
    const terminalMessages = {
      'Livrée': 'Votre livraison a été remise.',
      'Retournée': 'La livraison a été retournée à l’entreprise.',
      'Annulée': 'Cette livraison a été annulée.',
    };
    return Object.freeze({
      statusCode: 200,
      code: 'TRACKING_COMPLETED',
      message: terminalMessages[orderStatus] || 'Cette livraison est terminée.',
    });
  }
  return Object.freeze({ ...GENERIC_UNAVAILABLE_MESSAGE });
}

function planTrackingLinkRevocation({ link, now, reason = 'manual' } = {}) {
  const effectiveAt = currentDate(now).toISOString();
  const current = evaluateTrackingLink(link, { now: effectiveAt });
  if (current.state === TRACKING_LINK_STATES.UNAVAILABLE) {
    throw new TrackingLinkPolicyError('link_unavailable');
  }
  if (current.state === TRACKING_LINK_STATES.REVOKED) {
    return Object.freeze({ action: 'no_op', state: TRACKING_LINK_STATES.REVOKED, effectiveAt: null, patch: null });
  }
  if (typeof reason !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/i.test(reason)) {
    throw new TrackingLinkPolicyError('invalid_revocation_reason');
  }
  return Object.freeze({
    action: 'revoke',
    state: TRACKING_LINK_STATES.REVOKED,
    effectiveAt,
    patch: Object.freeze({ revokedAt: effectiveAt, revocationReason: reason }),
  });
}

function planTrackingLinkRotation({ link, now, ttlMs } = {}, options = {}) {
  const effectiveAt = currentDate(now).toISOString();
  const orderStatus = link?.orderStatus ?? link?.order_status ?? link?.status ?? null;
  if (orderStatus && terminalStatuses(options).has(orderStatus)) {
    throw new TrackingLinkPolicyError('terminal_order');
  }
  const current = evaluateTrackingLink(link, { ...options, now: effectiveAt });
  if (current.state === TRACKING_LINK_STATES.UNAVAILABLE) {
    throw new TrackingLinkPolicyError('link_unavailable');
  }
  const next = createTrackingLinkExpiration({ now: effectiveAt, ttlMs }, options);
  return Object.freeze({
    action: current.state === TRACKING_LINK_STATES.ACTIVE ? 'rotate' : 'reissue',
    effectiveAt,
    atomic: true,
    previous: Object.freeze({ revokedAt: effectiveAt, revocationReason: 'rotated' }),
    next: Object.freeze({ issuedAt: next.issuedAt, expiresAt: next.expiresAt, ttlMs: next.ttlMs }),
  });
}

function validateIdempotency({ key, fingerprint, existing = null } = {}) {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new TrackingLinkPolicyError('invalid_idempotency_key');
  }
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new TrackingLinkPolicyError('invalid_idempotency_fingerprint');
  }
  if (existing === null || existing === undefined) {
    return Object.freeze({ outcome: 'proceed', retryable: false });
  }
  if (typeof existing !== 'object') {
    throw new TrackingLinkPolicyError('invalid_existing_idempotency_record');
  }
  if (existing.key !== key || existing.fingerprint !== fingerprint) {
    return Object.freeze({ outcome: 'conflict', retryable: false, code: 'IDEMPOTENCY_CONFLICT' });
  }
  if (existing.status === 'processing') {
    return Object.freeze({ outcome: 'in_progress', retryable: true, code: 'IDEMPOTENCY_IN_PROGRESS' });
  }
  if (existing.status === 'completed' || existing.status === 'failed') {
    return Object.freeze({ outcome: 'replay', retryable: false, code: 'IDEMPOTENCY_REPLAY' });
  }
  throw new TrackingLinkPolicyError('invalid_idempotency_status');
}

module.exports = {
  DEFAULT_TRACKING_LINK_TTL_MS,
  GENERIC_UNAVAILABLE_MESSAGE,
  LEGACY_NULL_EXPIRY_TTL_MS,
  MAX_TRACKING_LINK_TTL_MS,
  MIN_TRACKING_LINK_TTL_MS,
  TERMINAL_ORDER_STATUSES,
  TRACKING_LINK_STATES,
  TrackingLinkPolicyError,
  createTrackingLinkExpiration,
  evaluateTrackingLink,
  normalizeTrackingLinkTtl,
  planTrackingLinkRevocation,
  planTrackingLinkRotation,
  publicTrackingLinkMessage,
  resolveEffectiveExpiration,
  validateIdempotency,
};
