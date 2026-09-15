'use strict';

const crypto = require('node:crypto');

const OPAQUE_KEY_PATTERN = /^rl_[A-Za-z0-9_-]{43}$/;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_OVERFLOW_RETRY_MS = 1_000;
const MAX_IDLE_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

class RateLimitConfigurationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'RateLimitConfigurationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Produces stable, opaque storage keys. Raw tokens and IP addresses are never
 * returned or retained by this factory.
 */
function createOpaqueKeyFactory(options = {}) {
  const suppliedSecret = options.secret;
  const secret = suppliedSecret === undefined
    ? crypto.randomBytes(32)
    : normalizeSecret(suppliedSecret);

  return function opaqueKey(namespace, rawValue) {
    const normalizedNamespace = normalizeNamespace(namespace);
    const normalizedValue = normalizeRawKey(rawValue);
    const digest = crypto
      .createHmac('sha256', secret)
      .update(`${Buffer.byteLength(normalizedNamespace)}:${normalizedNamespace}`)
      .update('\0')
      .update(normalizedValue)
      .digest('base64url');
    return `rl_${digest}`;
  };
}

/**
 * In-memory token bucket with bounded cardinality. It intentionally refuses a
 * new key when full instead of evicting an active bucket and allowing churn to
 * bypass a limit.
 */
function createTokenBucket(options = {}) {
  const capacity = integerOption(options.capacity, 60, 1, 100_000, 'capacity');
  const refillTokens = numberOption(options.refillTokens, capacity, 0.000001, capacity, 'refill_tokens');
  const refillIntervalMs = integerOption(
    options.refillIntervalMs,
    60_000,
    1,
    86_400_000,
    'refill_interval_ms',
  );
  const maxEntries = integerOption(
    options.maxEntries,
    DEFAULT_MAX_ENTRIES,
    1,
    1_000_000,
    'max_entries',
  );
  const fullRefillMs = Math.ceil((capacity / refillTokens) * refillIntervalMs);
  if (!Number.isSafeInteger(fullRefillMs) || fullRefillMs > MAX_IDLE_TTL_MS) {
    throw new RateLimitConfigurationError('invalid_refill_horizon');
  }
  const defaultIdleTtlMs = Math.min(MAX_IDLE_TTL_MS, Math.max(fullRefillMs * 2, 60_000));
  const idleTtlMs = integerOption(
    options.idleTtlMs,
    defaultIdleTtlMs,
    fullRefillMs,
    MAX_IDLE_TTL_MS,
    'idle_ttl_ms',
  );
  const cleanupIntervalMs = integerOption(
    options.cleanupIntervalMs,
    Math.min(idleTtlMs, 60_000),
    1,
    idleTtlMs,
    'cleanup_interval_ms',
  );
  const overflowRetryMs = integerOption(
    options.overflowRetryMs,
    DEFAULT_OVERFLOW_RETRY_MS,
    1,
    86_400_000,
    'overflow_retry_ms',
  );
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const refillPerMs = refillTokens / refillIntervalMs;
  const buckets = new Map();
  let nextCleanupAt = 0;

  function clock(explicitNow) {
    const value = explicitNow === undefined ? now() : explicitNow;
    if (!Number.isFinite(value) || value < 0) {
      throw new RateLimitConfigurationError('invalid_clock');
    }
    return value;
  }

  function sweep(at) {
    const currentTime = clock(at);
    let removed = 0;
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.lastSeenAt >= idleTtlMs) {
        buckets.delete(key);
        removed += 1;
      }
    }
    nextCleanupAt = currentTime + cleanupIntervalMs;
    return removed;
  }

  function opportunisticSweep(at) {
    if (at >= nextCleanupAt) sweep(at);
  }

  function refill(bucket, at) {
    const elapsed = Math.max(0, at - bucket.updatedAt);
    if (elapsed > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * refillPerMs));
      bucket.updatedAt = at;
    }
    bucket.lastSeenAt = at;
  }

  function inspect(key, cost = 1, explicitNow) {
    validateOpaqueKey(key);
    const normalizedCost = costOption(cost, capacity);
    const at = clock(explicitNow);
    opportunisticSweep(at);
    const bucket = buckets.get(key);

    if (!bucket) {
      if (buckets.size >= maxEntries) {
        // A full store gets one exact sweep before refusing a new identity.
        // Active buckets are never evicted merely to make room for key churn.
        sweep(at);
        if (buckets.size >= maxEntries) {
          return decision(false, 'store_capacity', capacity, 0, overflowRetryMs, at);
        }
      }
      return decision(true, 'allowed', capacity, capacity, 0, at);
    }

    refill(bucket, at);
    if (bucket.tokens + Number.EPSILON < normalizedCost) {
      const retryAfterMs = Math.ceil((normalizedCost - bucket.tokens) / refillPerMs);
      return decision(false, 'rate_exceeded', capacity, bucket.tokens, retryAfterMs, at);
    }
    return decision(true, 'allowed', capacity, bucket.tokens, 0, at);
  }

  function consume(key, cost = 1, explicitNow) {
    validateOpaqueKey(key);
    const normalizedCost = costOption(cost, capacity);
    const at = clock(explicitNow);
    const preview = inspect(key, normalizedCost, at);
    if (!preview.allowed) return preview;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: at, lastSeenAt: at };
      buckets.set(key, bucket);
    } else {
      refill(bucket, at);
    }
    bucket.tokens = Math.max(0, bucket.tokens - normalizedCost);
    return decision(true, 'allowed', capacity, bucket.tokens, 0, at);
  }

  function clear() {
    buckets.clear();
    nextCleanupAt = 0;
  }

  return Object.freeze({
    inspect,
    consume,
    sweep,
    clear,
    get size() {
      return buckets.size;
    },
    config: Object.freeze({
      capacity,
      refillTokens,
      refillIntervalMs,
      maxEntries,
      idleTtlMs,
      cleanupIntervalMs,
      overflowRetryMs,
    }),
  });
}

/**
 * Composes independent Express policies (for example IP + token). All checks
 * happen before consumption, so a request rejected by one policy does not
 * consume the allowance of another policy.
 */
function createRateLimitMiddleware(options = {}) {
  if (!Array.isArray(options.policies) || options.policies.length === 0 || options.policies.length > 16) {
    throw new RateLimitConfigurationError('invalid_policies');
  }

  const policies = options.policies.map(normalizePolicy);
  const names = new Set();
  for (const policy of policies) {
    if (names.has(policy.name)) throw new RateLimitConfigurationError('duplicate_policy_name');
    names.add(policy.name);
  }

  const opaqueKey = options.opaqueKey || createOpaqueKeyFactory({ secret: options.keySecret });
  if (typeof opaqueKey !== 'function') throw new RateLimitConfigurationError('invalid_opaque_key_factory');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const requirePolicyMatch = options.requirePolicyMatch !== false;
  const failureRetryMs = integerOption(options.failureRetryMs, 1_000, 1, 86_400_000, 'failure_retry_ms');

  return async function rateLimitMiddleware(req, res, next) {
    let evaluations;
    try {
      evaluations = await evaluatePolicies(req);
    } catch (error) {
      return reject(res, 503, 'rate_limit_unavailable', failureRetryMs);
    }

    if (evaluations.length === 0) {
      if (requirePolicyMatch) return reject(res, 503, 'rate_limit_unavailable', failureRetryMs);
      return next();
    }

    const denied = evaluations.filter((item) => !item.preview.allowed);
    if (denied.length > 0) {
      const unavailable = denied.some((item) => item.preview.reason !== 'rate_exceeded');
      const retryAfterMs = Math.max(...denied.map((item) => item.preview.retryAfterMs), failureRetryMs);
      return reject(
        res,
        unavailable ? 503 : 429,
        unavailable ? 'rate_limit_unavailable' : 'rate_limit_exceeded',
        retryAfterMs,
      );
    }

    try {
      for (const item of evaluations) {
        const committed = item.policy.limiter.consume(item.key, item.cost, item.at);
        if (!committed || committed.allowed !== true) {
          return reject(res, 503, 'rate_limit_unavailable', failureRetryMs);
        }
      }
    } catch (error) {
      return reject(res, 503, 'rate_limit_unavailable', failureRetryMs);
    }

    // Keep downstream application errors in Express' normal error pipeline.
    return next();

    async function evaluatePolicies(reqValue) {
      const evaluations = [];
      for (const policy of policies) {
        try {
          if (policy.skip && await policy.skip(reqValue)) continue;
          const rawKey = await policy.key(reqValue);
          if (rawKey === undefined || rawKey === null || rawKey === '') {
            if (policy.required) throw new Error('missing_rate_limit_key');
            continue;
          }
          const cost = typeof policy.cost === 'function' ? await policy.cost(reqValue) : policy.cost;
          const at = now();
          if (!Number.isFinite(at) || at < 0) throw new Error('invalid_clock');
          const key = opaqueKey(policy.name, rawKey);
          validateOpaqueKey(key);
          const preview = policy.limiter.inspect(key, cost, at);
          if (!preview || typeof preview.allowed !== 'boolean') throw new Error('invalid_limiter_result');
          evaluations.push({ policy, key, cost, at, preview });
        } catch (error) {
          if (policy.failMode === 'open') continue;
          evaluations.push({
            policy,
            key: null,
            cost: 0,
            at: now(),
            preview: decision(false, 'policy_unavailable', 0, 0, failureRetryMs, now()),
          });
        }
      }
      return evaluations;
    }
  };
}

function createIpPolicy(options = {}) {
  return policyFromOptions('ip', options, (req) => req && req.ip);
}

function createTokenPolicy(options = {}) {
  if (typeof options.key !== 'function') {
    throw new RateLimitConfigurationError('token_key_resolver_required');
  }
  return policyFromOptions('token', options, options.key);
}

function policyFromOptions(defaultName, options, defaultKey) {
  return {
    name: options.name || defaultName,
    limiter: options.limiter,
    key: options.key || defaultKey,
    cost: options.cost === undefined ? 1 : options.cost,
    required: options.required === undefined ? true : options.required,
    failMode: options.failMode,
    skip: options.skip,
  };
}

function normalizePolicy(policy, index) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new RateLimitConfigurationError('invalid_policy', { index });
  }
  const name = normalizeNamespace(policy.name || `policy_${index + 1}`);
  if (!policy.limiter || typeof policy.limiter.inspect !== 'function' || typeof policy.limiter.consume !== 'function') {
    throw new RateLimitConfigurationError('invalid_policy_limiter', { name });
  }
  if (typeof policy.key !== 'function') throw new RateLimitConfigurationError('invalid_policy_key', { name });
  if (policy.skip !== undefined && typeof policy.skip !== 'function') {
    throw new RateLimitConfigurationError('invalid_policy_skip', { name });
  }
  const failMode = policy.failMode === undefined ? 'closed' : policy.failMode;
  if (!['closed', 'open'].includes(failMode)) {
    throw new RateLimitConfigurationError('invalid_fail_mode', { name });
  }
  const cost = policy.cost === undefined ? 1 : policy.cost;
  if (typeof cost !== 'function' && (!Number.isFinite(cost) || cost <= 0)) {
    throw new RateLimitConfigurationError('invalid_policy_cost', { name });
  }
  return Object.freeze({
    name,
    limiter: policy.limiter,
    key: policy.key,
    cost,
    required: policy.required !== false,
    failMode,
    skip: policy.skip,
  });
}

function reject(res, status, error, retryAfterMs) {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1_000));
  if (res && typeof res.set === 'function') {
    res.set('Retry-After', String(retryAfter));
    res.set('Cache-Control', 'no-store');
  } else if (res && typeof res.setHeader === 'function') {
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('Cache-Control', 'no-store');
  }
  const body = { error, retryAfter };
  if (res && typeof res.status === 'function') {
    const response = res.status(status);
    if (response && typeof response.json === 'function') return response.json(body);
    if (response && typeof response.send === 'function') return response.send(body);
  }
  if (res) {
    res.statusCode = status;
    if (typeof res.end === 'function') return res.end(JSON.stringify(body));
  }
  return undefined;
}

function decision(allowed, reason, limit, tokens, retryAfterMs, at) {
  return Object.freeze({
    allowed,
    reason,
    limit,
    remaining: Math.max(0, Math.floor(tokens)),
    retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
    checkedAt: at,
  });
}

function normalizeSecret(value) {
  const secret = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
  if (secret.length < 16) throw new RateLimitConfigurationError('key_secret_too_short');
  return secret;
}

function normalizeNamespace(value) {
  const result = String(value || '');
  if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(result)) {
    throw new RateLimitConfigurationError('invalid_namespace');
  }
  return result;
}

function normalizeRawKey(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) {
    throw new RateLimitConfigurationError('invalid_raw_key');
  }
  const result = String(value);
  if (result.length === 0 || Buffer.byteLength(result) > 4_096) {
    throw new RateLimitConfigurationError('invalid_raw_key');
  }
  return result;
}

function validateOpaqueKey(key) {
  if (typeof key !== 'string' || !OPAQUE_KEY_PATTERN.test(key)) {
    throw new RateLimitConfigurationError('opaque_key_required');
  }
}

function costOption(value, capacity) {
  if (!Number.isFinite(value) || value <= 0 || value > capacity) {
    throw new RateLimitConfigurationError('invalid_cost');
  }
  return value;
}

function numberOption(value, fallback, minimum, maximum, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new RateLimitConfigurationError(`invalid_${name}`);
  }
  return result;
}

function integerOption(value, fallback, minimum, maximum, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RateLimitConfigurationError(`invalid_${name}`);
  }
  return result;
}

module.exports = {
  RateLimitConfigurationError,
  createOpaqueKeyFactory,
  createTokenBucket,
  createRateLimitMiddleware,
  createIpPolicy,
  createTokenPolicy,
};
