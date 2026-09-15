'use strict';

const assert = require('node:assert/strict');
const {
  RateLimitConfigurationError,
  createOpaqueKeyFactory,
  createTokenBucket,
  createRateLimitMiddleware,
  createIpPolicy,
  createTokenPolicy,
} = require('../lib/rate-limit');

const SECRET = '0123456789abcdef0123456789abcdef';

async function run() {
  testOpaqueKeys();
  testTokenBucketRefillAndRetryAfter();
  testBoundedStoreFailsClosed();
  testCleanup();
  await testComposableMiddleware();
  await testOptionalAndFailModes();
  await testStoreCapacityMiddlewareResponse();
  await testDownstreamErrorsAreNotConverted();
  testValidation();
  process.stdout.write('Tests limitation d’abus réussis : clés opaques, quotas composés, Retry-After, plafond, nettoyage et dégradation sûre.\n');
}

function testOpaqueKeys() {
  const opaque = createOpaqueKeyFactory({ secret: SECRET });
  const rawIp = '203.0.113.42';
  const rawToken = 'secret-bearer-token';
  const ipKey = opaque('ip', rawIp);
  const tokenKey = opaque('token', rawToken);
  assert.match(ipKey, /^rl_[A-Za-z0-9_-]{43}$/);
  assert.equal(ipKey, opaque('ip', rawIp));
  assert.notEqual(ipKey, tokenKey);
  assert.equal(ipKey.includes(rawIp), false);
  assert.equal(tokenKey.includes(rawToken), false);
}

function testTokenBucketRefillAndRetryAfter() {
  let time = 1_000;
  const opaque = createOpaqueKeyFactory({ secret: SECRET });
  const key = opaque('ip', '198.51.100.9');
  const bucket = createTokenBucket({
    capacity: 2,
    refillTokens: 1,
    refillIntervalMs: 1_000,
    maxEntries: 5,
    now: () => time,
  });

  assert.equal(bucket.consume(key).remaining, 1);
  assert.equal(bucket.consume(key).remaining, 0);
  const denied = bucket.consume(key);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'rate_exceeded');
  assert.equal(denied.retryAfterMs, 1_000);

  time += 500;
  assert.equal(bucket.inspect(key).retryAfterMs, 500);
  time += 500;
  assert.equal(bucket.consume(key).allowed, true);
  assert.equal(bucket.consume(key).allowed, false);
}

function testBoundedStoreFailsClosed() {
  const opaque = createOpaqueKeyFactory({ secret: SECRET });
  const bucket = createTokenBucket({ capacity: 1, maxEntries: 1, overflowRetryMs: 2_500 });
  assert.equal(bucket.consume(opaque('ip', 'one')).allowed, true);
  const overflow = bucket.inspect(opaque('ip', 'two'));
  assert.equal(overflow.allowed, false);
  assert.equal(overflow.reason, 'store_capacity');
  assert.equal(overflow.retryAfterMs, 2_500);
  assert.equal(bucket.size, 1);
}

function testCleanup() {
  let time = 0;
  const opaque = createOpaqueKeyFactory({ secret: SECRET });
  const bucket = createTokenBucket({
    capacity: 1,
    refillTokens: 1,
    refillIntervalMs: 100,
    idleTtlMs: 200,
    cleanupIntervalMs: 50,
    maxEntries: 2,
    now: () => time,
  });
  bucket.consume(opaque('ip', 'stale'));
  assert.equal(bucket.size, 1);
  time = 199;
  assert.equal(bucket.sweep(), 0);
  time = 200;
  assert.equal(bucket.sweep(), 1);
  assert.equal(bucket.size, 0);
}

async function testComposableMiddleware() {
  let time = 0;
  const ipBucket = createTokenBucket({
    capacity: 2,
    refillTokens: 1,
    refillIntervalMs: 10_000,
    now: () => time,
  });
  const tokenBucket = createTokenBucket({
    capacity: 1,
    refillTokens: 1,
    refillIntervalMs: 10_000,
    now: () => time,
  });
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

  result = await invoke(middleware, { ip: '203.0.113.1', auth: { tokenId: 'token-a' } }, () => { nextCalls += 1; });
  assert.equal(result.status, 429);
  assert.deepEqual(result.body, { error: 'rate_limit_exceeded', retryAfter: 10 });
  assert.equal(result.headers['Retry-After'], '10');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(nextCalls, 1);

  // The rejected token request did not consume the IP allowance.
  result = await invoke(middleware, { ip: '203.0.113.1', auth: { tokenId: 'token-b' } }, () => { nextCalls += 1; });
  assert.equal(result.status, null);
  assert.equal(nextCalls, 2);

  result = await invoke(middleware, { ip: '203.0.113.1', auth: { tokenId: 'token-c' } }, () => { nextCalls += 1; });
  assert.equal(result.status, 429);
  assert.equal(nextCalls, 2);
}

async function testOptionalAndFailModes() {
  let time = 0;
  const bucket = createTokenBucket({ capacity: 3, now: () => time });
  const optionalToken = createRateLimitMiddleware({
    keySecret: SECRET,
    now: () => time,
    policies: [
      createIpPolicy({ limiter: bucket }),
      createTokenPolicy({ limiter: bucket, key: () => null, required: false }),
    ],
  });
  let nextCalls = 0;
  let result = await invoke(optionalToken, { ip: '198.51.100.7' }, () => { nextCalls += 1; });
  assert.equal(result.status, null);
  assert.equal(nextCalls, 1);

  const closed = createRateLimitMiddleware({
    keySecret: SECRET,
    now: () => time,
    policies: [createIpPolicy({ limiter: bucket, key: () => { throw new Error('resolver failed'); } })],
  });
  result = await invoke(closed, {}, () => { nextCalls += 1; });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'rate_limit_unavailable');
  assert.equal(result.headers['Retry-After'], '1');
  assert.equal(nextCalls, 1);

  const openAlongsideProtectedIp = createRateLimitMiddleware({
    keySecret: SECRET,
    now: () => time,
    policies: [
      createIpPolicy({ limiter: bucket, name: 'fallback_ip' }),
      createTokenPolicy({
        limiter: bucket,
        key: () => { throw new Error('token source unavailable'); },
        failMode: 'open',
      }),
    ],
  });
  result = await invoke(openAlongsideProtectedIp, { ip: '198.51.100.8' }, () => { nextCalls += 1; });
  assert.equal(result.status, null);
  assert.equal(nextCalls, 2);
}

async function testDownstreamErrorsAreNotConverted() {
  const bucket = createTokenBucket({ capacity: 1 });
  const middleware = createRateLimitMiddleware({
    keySecret: SECRET,
    policies: [createIpPolicy({ limiter: bucket })],
  });
  const downstreamError = new Error('downstream_failure');
  await assert.rejects(
    () => invoke(middleware, { ip: '192.0.2.12' }, () => { throw downstreamError; }),
    (error) => error === downstreamError,
  );
}

async function testStoreCapacityMiddlewareResponse() {
  const bucket = createTokenBucket({ capacity: 1, maxEntries: 1, overflowRetryMs: 2_500 });
  const middleware = createRateLimitMiddleware({
    keySecret: SECRET,
    policies: [createIpPolicy({ limiter: bucket })],
  });
  let nextCalls = 0;
  let result = await invoke(middleware, { ip: '192.0.2.1' }, () => { nextCalls += 1; });
  assert.equal(result.status, null);
  result = await invoke(middleware, { ip: '192.0.2.2' }, () => { nextCalls += 1; });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'rate_limit_unavailable', retryAfter: 3 });
  assert.equal(result.headers['Retry-After'], '3');
  assert.equal(nextCalls, 1);
}

function testValidation() {
  assert.throws(
    () => createOpaqueKeyFactory({ secret: 'short' }),
    (error) => error instanceof RateLimitConfigurationError && error.code === 'key_secret_too_short',
  );
  assert.throws(
    () => createTokenBucket({ capacity: 0 }),
    (error) => error.code === 'invalid_capacity',
  );
  const bucket = createTokenBucket();
  assert.throws(
    () => bucket.consume('plain-ip-address'),
    (error) => error.code === 'opaque_key_required',
  );
  assert.throws(
    () => createTokenPolicy({ limiter: bucket }),
    (error) => error.code === 'token_key_resolver_required',
  );
}

async function invoke(middleware, req, onNext) {
  const response = {
    status: null,
    body: null,
    headers: {},
  };
  const res = {
    set(name, value) {
      response.headers[name] = value;
      return this;
    },
    status(value) {
      response.status = value;
      return this;
    },
    json(value) {
      response.body = value;
      return this;
    },
  };
  await middleware(req, res, onNext);
  return response;
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
