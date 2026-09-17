const assert = require('node:assert/strict');
const {
  RoutingInputError,
  createMemoryRoutingCache,
  createRoutingAdapter,
} = require('../lib/routing');

const COTONOU = { lat: 6.3703, lng: 2.3912 };
const CALAVI = { lat: 6.4485, lng: 2.3557 };
const PORTO_NOVO = { lat: 6.4969, lng: 2.6289 };
const FIXED_NOW = () => new Date('2026-09-15T08:30:00.000Z');

function mockResponse(status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    headers: { get: (name) => lowerHeaders[String(name).toLowerCase()] ?? null },
    text: async () => body,
  };
}

function osrmRoutePayload() {
  return {
    code: 'Ok',
    routes: [{
      distance: 12_450.4,
      duration: 1_980.2,
      geometry: {
        type: 'LineString',
        coordinates: [[2.3912, 6.3703], [2.37, 6.41], [2.3557, 6.4485]],
      },
      legs: [{ distance: 12_450.4, duration: 1_980.2 }],
    }],
    waypoints: [
      { distance: 8.2, location: [2.3912, 6.3703] },
      { distance: 13.7, location: [2.3557, 6.4485] },
    ],
  };
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('le fournisseur désactivé dégrade sans distance, durée ou géométrie inventée', async () => {
  const adapter = createRoutingAdapter({ provider: 'disabled', now: FIXED_NOW });
  const health = adapter.health();
  assert.equal(health.status, 'disabled');
  assert.equal(health.capabilities.eta, false);

  const result = await adapter.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.distanceMeters, null);
  assert.equal(result.durationSeconds, null);
  assert.equal(result.geometry, null);
  assert.equal(result.quality.fallbackUsed, false);
  assert.equal(result.failure.code, 'provider_disabled');
  assert.equal(result.source.provider, 'disabled');
  assert.equal(result.source.calculatedAt, '2026-09-15T08:30:00.000Z');
});

test('les coordonnées, profils et limites sont validés avant tout appel fournisseur', async () => {
  const adapter = createRoutingAdapter({
    provider: 'disabled',
    maxRouteCoordinates: 2,
    profiles: { motorcycle: 'driving-benin-v1' },
    defaultProfile: 'motorcycle',
  });

  await assert.rejects(
    () => adapter.route({ coordinates: [COTONOU] }),
    (error) => error instanceof RoutingInputError && error.code === 'not_enough_coordinates',
  );
  await assert.rejects(
    () => adapter.route({ coordinates: [COTONOU, CALAVI, PORTO_NOVO] }),
    (error) => error instanceof RoutingInputError && error.code === 'too_many_coordinates',
  );
  await assert.rejects(
    () => adapter.route({ coordinates: [COTONOU, { lat: 91, lng: 2.4 }] }),
    (error) => error instanceof RoutingInputError && error.code === 'invalid_latitude' && error.details.index === 1,
  );
  await assert.rejects(
    () => adapter.route({ profile: 'truck', coordinates: [COTONOU, CALAVI] }),
    (error) => error instanceof RoutingInputError && error.code === 'unsupported_profile',
  );
});

test('la configuration OSRM refuse URL avec identifiants, paramètres ou protocole non HTTP', () => {
  for (const baseUrl of [
    'ftp://routing.internal',
    'https://user:mot-de-passe@routing.internal',
    'https://routing.internal?token=tres-secret',
  ]) {
    assert.throws(
      () => createRoutingAdapter({ provider: 'osrm', baseUrl }),
      (error) => error instanceof RoutingInputError
        && error.code === 'invalid_osrm_base_url'
        && !JSON.stringify(error).includes('tres-secret')
        && !JSON.stringify(error).includes('mot-de-passe'),
    );
  }
});

test('une route OSRM est normalisée, attribuée et mise en cache', async () => {
  let fetchCount = 0;
  let requestedUrl;
  const adapter = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal/osrm',
    profiles: { motorcycle: 'driving-benin-v1' },
    defaultProfile: 'motorcycle',
    mapDataVersion: 'benin-2026-09-08',
    providerVersion: 'osrm-6.0',
    now: FIXED_NOW,
    fetchImpl: async (url, options) => {
      fetchCount += 1;
      requestedUrl = url;
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Accept, 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
      return mockResponse(200, osrmRoutePayload());
    },
  });

  const first = await adapter.route({ profile: 'motorcycle', coordinates: [COTONOU, CALAVI] });
  assert.equal(first.status, 'ok');
  assert.equal(first.distanceMeters, 12_450.4);
  assert.equal(first.durationSeconds, 1_980.2);
  assert.deepEqual(first.legs, [{ fromIndex: 0, toIndex: 1, distanceMeters: 12_450.4, durationSeconds: 1_980.2 }]);
  assert.equal(first.geometry.format, 'geojson');
  assert.equal(first.snappedPoints[1].distanceMeters, 13.7);
  assert.equal(first.quality.fallbackUsed, false);
  assert.ok(first.quality.warnings.includes('routing_duration_is_not_eta'));
  assert.deepEqual(first.source, {
    provider: 'osrm',
    profile: 'motorcycle',
    providerProfile: 'driving-benin-v1',
    mapDataVersion: 'benin-2026-09-08',
    providerVersion: 'osrm-6.0',
    calculatedAt: '2026-09-15T08:30:00.000Z',
    requestFingerprint: first.source.requestFingerprint,
    cache: 'miss',
  });
  assert.match(first.source.requestFingerprint, /^[a-f0-9]{24}$/);
  assert.ok(requestedUrl instanceof URL);
  assert.match(requestedUrl.pathname, /\/osrm\/route\/v1\/driving-benin-v1\//);
  assert.equal(requestedUrl.searchParams.get('geometries'), 'geojson');
  assert.ok(!JSON.stringify(first).includes('routing.internal'));

  first.geometry.value.coordinates[0][0] = 99;
  const second = await adapter.route({ profile: 'motorcycle', coordinates: [COTONOU, CALAVI] });
  assert.equal(fetchCount, 1);
  assert.equal(second.source.cache, 'hit');
  assert.equal(second.geometry.value.coordinates[0][0], 2.3912);
});

test('un cache injecté reçoit une empreinte opaque et le TTL prévu', async () => {
  let stored;
  const cache = {
    get: async (key) => (stored?.key === key ? stored.value : null),
    set: async (key, value, ttlMs) => { stored = { key, value, ttlMs }; },
  };
  let fetchCount = 0;
  const adapter = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    cache,
    cacheTtlMs: 1_234,
    fetchImpl: async () => {
      fetchCount += 1;
      return mockResponse(200, osrmRoutePayload());
    },
  });

  await adapter.route({ coordinates: [COTONOU, CALAVI] });
  assert.match(stored.key, /^[a-f0-9]{24}$/);
  assert.equal(stored.ttlMs, 1_234);
  const cached = await adapter.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(cached.source.cache, 'hit');
  assert.equal(fetchCount, 1);
});

test('un TTL nul désactive totalement la lecture et l’écriture du cache', async () => {
  let fetchCount = 0;
  const adapter = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    cacheTtlMs: 0,
    cache: {
      get: async () => { assert.fail('le cache ne doit pas être lu'); },
      set: async () => { assert.fail('le cache ne doit pas être écrit'); },
    },
    fetchImpl: async () => {
      fetchCount += 1;
      return mockResponse(200, osrmRoutePayload());
    },
  });

  const first = await adapter.route({ coordinates: [COTONOU, CALAVI] });
  const second = await adapter.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(first.source.cache, 'disabled');
  assert.equal(second.source.cache, 'disabled');
  assert.equal(fetchCount, 2);
});

test('la matrice conserve les cellules inaccessibles sans créer de valeur de repli', async () => {
  const adapter = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    fetchImpl: async (url) => {
      assert.match(url.pathname, /\/table\/v1\/driving\//);
      assert.equal(url.searchParams.get('annotations'), 'duration,distance');
      return mockResponse(200, {
        code: 'Ok',
        durations: [[0, 120, null], [118, 0, 240], [null, 235, 0]],
        distances: [[0, 1_500, null], [1_480, 0, 3_200], [null, 3_180, 0]],
      });
    },
  });

  const result = await adapter.matrix({ coordinates: [COTONOU, CALAVI, PORTO_NOVO] });
  assert.equal(result.status, 'partial');
  const inaccessible = result.cells.find((cell) => cell.fromIndex === 0 && cell.toIndex === 2);
  assert.deepEqual(inaccessible, {
    fromIndex: 0,
    toIndex: 2,
    status: 'unreachable',
    distanceMeters: null,
    durationSeconds: null,
  });
  assert.equal(result.quality.fallbackUsed, false);
  assert.ok(result.quality.warnings.includes('matrix_contains_unreachable_cells'));
});

test('NoRoute et les réponses invalides ne produisent aucune distance exploitable', async () => {
  const noRoute = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    cache: null,
    fetchImpl: async () => mockResponse(200, { code: 'NoRoute', message: 'No route found' }),
  });
  const missing = await noRoute.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.failure.code, 'route_not_found');
  assert.equal(missing.failure.retryable, false);
  assert.equal(missing.distanceMeters, null);

  const invalid = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    cache: null,
    fetchImpl: async () => mockResponse(200, { ...osrmRoutePayload(), routes: [{ ...osrmRoutePayload().routes[0], duration: -1 }] }),
  });
  const rejected = await invalid.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(rejected.status, 'unavailable');
  assert.equal(rejected.failure.code, 'provider_invalid_response');
  assert.equal(rejected.durationSeconds, null);

  const noTable = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    cache: null,
    fetchImpl: async () => mockResponse(200, { code: 'NoTable', message: 'No table found' }),
  });
  const absentMatrix = await noTable.matrix({ coordinates: [COTONOU, CALAVI] });
  assert.equal(absentMatrix.status, 'unavailable');
  assert.equal(absentMatrix.failure.code, 'matrix_unavailable');
  assert.equal(absentMatrix.distancesMeters, null);
});

test('un délai dépassé s’arrête même si le client HTTP ignore le signal', async () => {
  const adapter = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    timeoutMs: 15,
    cache: null,
    fetchImpl: async () => new Promise(() => {}),
  });
  const startedAt = Date.now();
  const result = await adapter.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.failure.code, 'provider_timeout');
  assert.equal(result.failure.retryable, true);
  assert.ok(Date.now() - startedAt < 500);
});

test('les erreurs transport et HTTP restent sûres et indiquent si une reprise est possible', async () => {
  const transport = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    cache: null,
    fetchImpl: async () => { throw new Error('échec avec token=tres-secret'); },
  });
  const transportResult = await transport.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(transportResult.failure.code, 'provider_unreachable');
  assert.equal(transportResult.failure.retryable, true);
  assert.ok(!JSON.stringify(transportResult).includes('tres-secret'));

  for (const [status, expectedCode, retryable] of [
    [400, 'provider_http_error', false],
    [429, 'provider_rate_limited', true],
    [503, 'provider_http_error', true],
  ]) {
    const adapter = createRoutingAdapter({
      provider: 'osrm',
      baseUrl: 'http://routing.internal',
      cache: null,
      fetchImpl: async () => mockResponse(status, { code: 'Error', message: 'token=tres-secret' }),
    });
    const result = await adapter.route({ coordinates: [COTONOU, CALAVI] });
    assert.equal(result.failure.code, expectedCode);
    assert.equal(result.failure.retryable, retryable);
    assert.ok(!JSON.stringify(result).includes('tres-secret'));
  }
});

test('JSON mal formé et corps excessif sont rejetés sans lever une panne applicative', async () => {
  const malformed = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    cache: null,
    fetchImpl: async () => mockResponse(200, '{pas du json'),
  });
  const malformedResult = await malformed.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(malformedResult.failure.code, 'provider_invalid_response');
  assert.equal(malformedResult.failure.retryable, false);

  const oversized = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    cache: null,
    maxResponseBytes: 1_024,
    fetchImpl: async () => mockResponse(200, 'x'.repeat(1_025)),
  });
  const oversizedResult = await oversized.route({ coordinates: [COTONOU, CALAVI] });
  assert.equal(oversizedResult.failure.code, 'provider_response_too_large');
  assert.equal(oversizedResult.failure.retryable, false);
});

test('le cache mémoire expire et protège ses valeurs contre les mutations', () => {
  let clock = 1_000;
  const cache = createMemoryRoutingCache({ now: () => clock, maxEntries: 2 });
  const value = { status: 'ok', nested: { distance: 10 } };
  cache.set('a', value, 100);
  value.nested.distance = 99;
  assert.equal(cache.get('a').nested.distance, 10);
  clock = 1_101;
  assert.equal(cache.get('a'), null);
  assert.equal(cache.size, 0);
});

test('le map-matching OSRM colle la trace au réseau, borne les rayons et compte les points calés', async () => {
  let requestedUrl;
  const adapter = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    profiles: { motorcycle: 'driving-benin-v1' },
    defaultProfile: 'motorcycle',
    fetchImpl: async (url) => {
      requestedUrl = url;
      return mockResponse(200, {
        code: 'Ok',
        matchings: [
          {
            confidence: 0.95,
            distance: 640.2,
            duration: 96.4,
            geometry: { type: 'LineString', coordinates: [[2.3912, 6.3703], [2.3901, 6.3720], [2.3890, 6.3735]] },
          },
        ],
        tracepoints: [{ location: [2.3912, 6.3703] }, null, { location: [2.3890, 6.3735] }],
      });
    },
  });

  const result = await adapter.match({
    profile: 'motorcycle',
    points: [
      { lat: 6.3703, lng: 2.3912, accuracy: 2 },
      { lat: 6.3719, lng: 2.3902, accuracy: 80 },
      { lat: 6.3735, lng: 2.3890 },
    ],
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.geometry.format, 'geojson');
  assert.equal(result.geometry.value.coordinates.length, 3);
  assert.equal(result.matchedPoints, 2);
  assert.equal(result.totalPoints, 3);
  assert.equal(result.confidence, 0.95);
  assert.match(requestedUrl.pathname, /\/match\/v1\/driving-benin-v1\//);
  assert.equal(requestedUrl.searchParams.get('geometries'), 'geojson');
  assert.equal(requestedUrl.searchParams.get('tidy'), 'true');
  // accuracy 2 → plancher 4 ; 80 → plafond 50 ; absente → défaut 15.
  assert.equal(requestedUrl.searchParams.get('radiuses'), '4;50;15');
});

test('un NoMatch ne fabrique aucune géométrie de secours', async () => {
  const adapter = createRoutingAdapter({
    provider: 'osrm',
    baseUrl: 'http://routing.internal',
    fetchImpl: async () => mockResponse(200, { code: 'NoMatch', message: 'Could not match' }),
  });
  const result = await adapter.match({ points: [COTONOU, CALAVI] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.geometry, null);
  assert.equal(result.failure.code, 'match_not_found');
  assert.equal(result.failure.retryable, false);
});

test('le fournisseur désactivé refuse le map-matching sans appel réseau', async () => {
  const adapter = createRoutingAdapter({ provider: 'disabled', profiles: { motorcycle: 'driving' }, defaultProfile: 'motorcycle' });
  assert.equal(adapter.health().capabilities.match, false);
  const result = await adapter.match({ points: [COTONOU, CALAVI] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.failure.code, 'provider_disabled');
});

async function main() {
  for (const { name, run } of tests) {
    await run();
    process.stdout.write(`✓ ${name}\n`);
  }
  process.stdout.write(`\n${tests.length} tests de l’adaptateur de routage réussis.\n`);
}

main().catch((error) => {
  process.stderr.write(`Échec des tests de routage : ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
