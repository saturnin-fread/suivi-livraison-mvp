'use strict';

// Redis-backed token bucket, interface-compatible with the in-memory limiter in
// lib/rate-limit.js (async inspect/consume returning the same decision shape).
// It lets delivery-app run several replicas while sharing one abuse budget.
//
// The client is injected (any object exposing an ioredis-style async
// `eval(script, numKeys, key, ...args)`), so this module has no hard dependency
// and stays unit-testable with a faithful fake. The bucket refill and the
// decrement are done inside one Lua script, so concurrent replicas cannot race
// past the limit.

const OPAQUE_KEY_PATTERN = /^rl_[A-Za-z0-9_-]{43}$/;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

class RedisRateLimitError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'RedisRateLimitError';
    this.code = code;
    this.details = details;
  }
}

// KEYS[1] bucket hash. ARGV: capacity, refillPerMs, now(ms), cost, ttl(ms), mode.
// Returns { allowed(0|1), tokens(string), retryAfterMs(int) }.
const LUA_TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local mode = ARGV[6]
local data = redis.call('HMGET', key, 't', 'u')
local tokens = tonumber(data[1])
local updatedAt = tonumber(data[2])
if tokens == nil or updatedAt == nil then
  tokens = capacity
  updatedAt = now
end
local elapsed = now - updatedAt
if elapsed > 0 then
  tokens = math.min(capacity, tokens + elapsed * refillPerMs)
  updatedAt = now
end
local allowed = 0
local retry = 0
if tokens + 0.000001 >= cost then
  allowed = 1
  if mode == 'consume' then
    tokens = tokens - cost
  end
else
  retry = math.ceil((cost - tokens) / refillPerMs)
end
redis.call('HSET', key, 't', tostring(tokens), 'u', tostring(updatedAt))
redis.call('PEXPIRE', key, ttl)
return {allowed, tostring(tokens), retry}
`;

function createRedisTokenBucket(options = {}) {
  const client = options.client;
  if (!client || typeof client.eval !== 'function') {
    throw new RedisRateLimitError('invalid_client');
  }
  const capacity = integerOption(options.capacity, 60, 1, 100_000, 'capacity');
  const refillTokens = numberOption(options.refillTokens, capacity, 0.000001, capacity, 'refill_tokens');
  const refillIntervalMs = integerOption(options.refillIntervalMs, 60_000, 1, 86_400_000, 'refill_interval_ms');
  const keyPrefix = normalizeKeyPrefix(options.keyPrefix);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const refillPerMs = refillTokens / refillIntervalMs;
  const fullRefillMs = Math.ceil((capacity / refillTokens) * refillIntervalMs);
  if (!Number.isSafeInteger(fullRefillMs) || fullRefillMs > MAX_TTL_MS) {
    throw new RedisRateLimitError('invalid_refill_horizon');
  }
  const ttlMs = Math.min(MAX_TTL_MS, Math.max(fullRefillMs * 2, 60_000));

  async function evaluate(key, cost, mode, explicitNow) {
    validateOpaqueKey(key);
    const normalizedCost = costOption(cost, capacity);
    const at = clock(now, explicitNow);
    const redisKey = `${keyPrefix}${key}`;
    let raw;
    try {
      raw = await client.eval(
        LUA_TOKEN_BUCKET,
        1,
        redisKey,
        String(capacity),
        String(refillPerMs),
        String(at),
        String(normalizedCost),
        String(ttlMs),
        mode,
      );
    } catch (error) {
      throw new RedisRateLimitError('redis_unavailable', { cause: error && error.message });
    }
    if (!Array.isArray(raw) || raw.length < 3) {
      throw new RedisRateLimitError('invalid_redis_result');
    }
    const allowed = Number(raw[0]) === 1;
    const tokens = Number(raw[1]);
    const retryAfterMs = Number(raw[2]);
    if (!Number.isFinite(tokens) || !Number.isFinite(retryAfterMs)) {
      throw new RedisRateLimitError('invalid_redis_result');
    }
    return decision(allowed, allowed ? 'allowed' : 'rate_exceeded', capacity, tokens, retryAfterMs, at);
  }

  return Object.freeze({
    inspect(key, cost = 1, explicitNow) {
      return evaluate(key, cost, 'inspect', explicitNow);
    },
    consume(key, cost = 1, explicitNow) {
      return evaluate(key, cost, 'consume', explicitNow);
    },
    config: Object.freeze({ capacity, refillTokens, refillIntervalMs, ttlMs, keyPrefix }),
  });
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

function clock(now, explicitNow) {
  const value = explicitNow === undefined ? now() : explicitNow;
  if (!Number.isFinite(value) || value < 0) {
    throw new RedisRateLimitError('invalid_clock');
  }
  return value;
}

function normalizeKeyPrefix(value) {
  if (value === undefined) return 'rl:';
  const result = String(value);
  if (result.length === 0 || result.length > 128) {
    throw new RedisRateLimitError('invalid_key_prefix');
  }
  return result;
}

function validateOpaqueKey(key) {
  if (typeof key !== 'string' || !OPAQUE_KEY_PATTERN.test(key)) {
    throw new RedisRateLimitError('opaque_key_required');
  }
}

function costOption(value, capacity) {
  if (!Number.isFinite(value) || value <= 0 || value > capacity) {
    throw new RedisRateLimitError('invalid_cost');
  }
  return value;
}

function numberOption(value, fallback, minimum, maximum, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new RedisRateLimitError(`invalid_${name}`);
  }
  return result;
}

function integerOption(value, fallback, minimum, maximum, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RedisRateLimitError(`invalid_${name}`);
  }
  return result;
}

module.exports = {
  RedisRateLimitError,
  createRedisTokenBucket,
  LUA_TOKEN_BUCKET,
};
