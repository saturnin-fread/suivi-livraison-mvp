'use strict';

const assert = require('node:assert/strict');
const {
  RedisRateLimitError,
  createRedisTokenBucket,
} = require('../lib/redis-rate-limit');
const {
  createOpaqueKeyFactory,
  createRateLimitMiddleware,
  createIpPolicy,
  createTokenPolicy,
} = require('../lib/rate-limit');

const SECRET = '0123456789abcdef0123456789abcdef';

// Faithful in-memory stand-in for a Redis server evaluating LUA_TOKEN_BUCKET.
// It mirrors the Lua algorithm exactly so the test exercises the real decision
// shaping and middleware wiring without a live Redis. Set `failing` to simulate
// an outage and check the fail-closed path.
function createFakeRedis() {
  const store = new Map();
  return {
    failing: false,
    async eval(_script, _numKeys, key, capacityStr, refillPerMsStr, nowStr, costStr, ttlStr, mode) {
      if (this.failing) throw new Error('connection refused');
      const capacity = Number(capacityStr);
      const refillPerMs = Number(refillPerMsStr);
      const now = Number(nowStr);
      const cost = Number(costStr);
      let entry = store.get(key);
      let tokens = entry ? entry.tokens : capacity;
      let updatedAt = entry ? entry.updatedAt : now;
      const elapsed = now - updatedAt;
      if (elapsed > 0) {
        tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
        updatedAt = now;
      }
      let allowed = 0;
      let retry = 0;
      if (tokens + 0.000001 >= cost) {
        allowed = 1;
        if (mode === 'consume') tokens -= cost;
      } else {
        retry = Math.ceil((cost - tokens) / refillPerMs);
      }
      store.set(key, { tokens, updatedAt });
      return [allowed, String(tokens), retry];
    },
  };
}

async function run() {
  await testRefillAndRetryAfter();
  await testKeyPrefixIsolation();
  await testComposableMiddlewareFairness();
  await testRedisOutageFailsClosed();
  testValidation();
  process.stdout.write('Tests limitation Redis réussis : recharge, Retry-After, préfixes, équité inter-quotas et dégradation fermée.\n');
}

async function testRefillAndRetryAfter() {
  let time = 1_000;
  const client = createFakeRedis();
  const opaque = createOpaqueKeyFactory({ secret: SECRET });
  const key = opaque('ip', '198.51.100.9');
  const bucket = createRedisTokenBucket({
    client,
    capacity: 2,
    refillTokens: 1,
    refillIntervalMs: 1_000,
    now: () => time,
  });

  assert.equal((await bucket.consume(key)).remaining, 1);
  assert.equal((await bucket.consume(key)).remaining, 0);
  const denied = await bucket.consume(key);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'rate_exceeded');
  assert.equal(denied.retryAfterMs, 1_000);

  time += 500;
  assert.equal((await bucket.inspect(key)).retryAfterMs, 500);
  time += 500;
  assert.equal((await bucket.consume(key)).allowed, true);
  assert.equal((await bucket.consume(key)).allowed, false);
}

async function testKeyPrefixIsolation() {
  const time = 0;
  const client = createFakeRedis();
  const opaque = createOpaqueKeyFactory({ secret: SECRET });
  const key = opaque('ip', '203.0.113.5');
  const ipBucket = createRedisTokenBucket({ client, keyPrefix: 'rl:ip:', capacity: 1, now: () => time });
  const tokenBucket = createRedisTokenBucket({ client, keyPrefix: 'rl:tok:', capacity: 1, now: () => time });

  // Same opaque key, different prefixes => independent budgets.
  assert.equal((await ipBucket.consume(key)).allowed, true);
  assert.equal((await ipBucket.consume(key)).allowed, false);
  assert.equal((await tokenBucket.consume(key)).allowed, true);
}

async function testComposableMiddlewareFairness() {
  let time = 0;
  const client = createFakeRedis();
  const ipBucket = createRedisTokenBucket({ client, keyPrefix: 'rl:ip:', capacity: 2, refillTokens: 1, refillIntervalMs: 10_000, now: () => time });
  const tokenBucket = createRedisTokenBucket({ client, keyPrefix: 'rl:tok:', capacity: 1, refillTokens: 1, refillIntervalMs: 10_000, now: () => time });
  const middleware = createRateLimitMiddleware({
    keySecret: SECRET,
    now: () => time,
    policies: [
      createIpPolicy({ limiter: ipBucket }),
      createTokenPolicy({ limiter: tokenBucket, key: (req) => req.auth.tokenId }),
    ],
  });

  let nextCalls = 0;
  let result = await invoke(middleware, { ip: '203.0.113.1', auth: { tokenId: 'token-a' } }, () => { nextCalls += 1; });
  assert.equal(result.status, null);
  assert.equal(nextCalls, 1);

  // token-a exhausted its 1-token budget; IP budget must not be consumed by the denial.
  result = await invoke(middleware, { ip: '203.0.113.1', auth: { tokenId: 'token-a' } }, () => { nextCalls += 1; });
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, { error: 'rate_limit_exceeded', retryAfter: 10 });
  assert.equal(nextCalls, 1);

  result = await invoke(middleware, { ip: '203.0.113.1', auth: { tokenId: 'token-b' } }, () => { nextCalls += 1; });
  assert.equal(result.status, null);
  assert.equal(nextCalls, 2);

  // IP budget (2) now spent; a fresh token is still blocked by the IP quota.
  result = await invoke(middleware, { ip: '203.0.113.1', auth: { tokenId: 'token-c' } }, () => { nextCalls += 1; });
  assert.equal(result.status, 429);
  assert.equal(nextCalls, 2);
}

async function testRedisOutageFailsClosed() {
  const client = createFakeRedis();
  const bucket = createRedisTokenBucket({ client, capacity: 5 });
  const middleware = createRateLimitMiddleware({
    keySecret: SECRET,
    policies: [createIpPolicy({ limiter: bucket })],
  });
  client.failing = true;
  let nextCalls = 0;
  const result = await invoke(middleware, { ip: '192.0.2.42' }, () => { nextCalls += 1; });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'rate_limit_unavailable');
  assert.equal(result.headers['Retry-After'], '1');
  assert.equal(nextCalls, 0);
}

function testValidation() {
  assert.throws(
    () => createRedisTokenBucket({}),
    (error) => error instanceof RedisRateLimitError && error.code === 'invalid_client',
  );
  const client = createFakeRedis();
  assert.throws(
    () => createRedisTokenBucket({ client, capacity: 0 }),
    (error) => error.code === 'invalid_capacity',
  );
  const bucket = createRedisTokenBucket({ client });
  assert.rejects(
    () => bucket.consume('plain-ip-address'),
    (error) => error.code === 'opaque_key_required',
  );
}

async function invoke(middleware, req, onNext) {
  const response = { status: null, body: null, headers: {} };
  const res = {
    set(name, value) { response.headers[name] = value; return this; },
    status(value) { response.status = value; return this; },
    json(value) { response.body = value; return this; },
  };
  await middleware(req, res, onNext);
  return response;
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
