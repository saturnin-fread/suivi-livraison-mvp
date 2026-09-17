const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROFILE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

class RoutingInputError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'RoutingInputError';
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function createMemoryRoutingCache(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxEntries = integerOption(options.maxEntries, 500, 1, 10_000, 'max_entries');
  const entries = new Map();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }

      // Refresh insertion order so eviction behaves as a small LRU cache.
      entries.delete(key);
      entries.set(key, entry);
      return clone(entry.value);
    },

    set(key, value, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
      entries.delete(key);
      entries.set(key, { value: clone(value), expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}

function createRoutingAdapter(options = {}) {
  const provider = String(options.provider || 'disabled').toLowerCase();
  if (!['disabled', 'osrm'].includes(provider)) {
    throw new RoutingInputError('unsupported_provider', { provider });
  }

  const timeoutMs = integerOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000, 'timeout_ms');
  const cacheTtlMs = integerOption(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 86_400_000, 'cache_ttl_ms');
  const maxRouteCoordinates = integerOption(options.maxRouteCoordinates, 50, 2, 500, 'max_route_coordinates');
  const maxMatrixCoordinates = integerOption(options.maxMatrixCoordinates, 25, 2, 100, 'max_matrix_coordinates');
  const maxMatchCoordinates = integerOption(options.maxMatchCoordinates, 100, 2, 1000, 'max_match_coordinates');
  const maxResponseBytes = integerOption(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1_024,
    20 * 1024 * 1024,
    'max_response_bytes',
  );
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const cache = options.cache === undefined ? createMemoryRoutingCache() : options.cache;
  validateCache(cache);
  const cacheEnabled = cache !== null && cacheTtlMs > 0;

  const profiles = normalizeProfiles(options.profiles);
  const defaultProfile = String(options.defaultProfile || Object.keys(profiles)[0]);
  if (!Object.hasOwn(profiles, defaultProfile)) {
    throw new RoutingInputError('unsupported_default_profile', { profile: defaultProfile });
  }

  const mapDataVersion = safeProvenanceValue(options.mapDataVersion, 'map_data_version');
  const providerVersion = safeProvenanceValue(options.providerVersion, 'provider_version');
  const baseUrl = provider === 'osrm' ? normalizeBaseUrl(options.baseUrl) : null;
  const fetchImpl = provider === 'osrm' ? (options.fetchImpl || globalThis.fetch) : null;
  if (provider === 'osrm' && typeof fetchImpl !== 'function') {
    throw new RoutingInputError('fetch_unavailable');
  }

  function health() {
    return {
      status: provider === 'disabled' ? 'disabled' : 'configured',
      capabilities: {
        route: provider === 'osrm',
        matrix: provider === 'osrm',
        match: provider === 'osrm',
        eta: false,
      },
      source: {
        provider,
        mapDataVersion,
        providerVersion,
        checkedAt: isoNow(now),
      },
    };
  }

  async function route(input = {}) {
    const normalized = normalizeInput(input, {
      minimum: 2,
      maximum: maxRouteCoordinates,
      profiles,
      defaultProfile,
      operation: 'route',
    });
    const source = makeSource({
      provider,
      normalized,
      mapDataVersion,
      providerVersion,
      now,
      cacheState: provider === 'disabled' || !cacheEnabled ? 'disabled' : 'miss',
    });

    if (provider === 'disabled') {
      return unavailableRoute(source, 'provider_disabled', false);
    }

    const cacheKey = makeCacheKey('route', normalized, mapDataVersion);
    const cached = cacheEnabled ? await readCache(cache, cacheKey) : null;
    if (cached) return markCacheHit(cached);

    try {
      const url = buildOsrmUrl(baseUrl, 'route', normalized);
      const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      const payload = await parseProviderResponse(response, maxResponseBytes);
      const failure = classifyOsrmFailure(response, payload, 'route');
      if (failure) return unavailableRoute(source, failure.code, failure.retryable);

      const result = normalizeOsrmRoute(payload, source, normalized.coordinates.length);
      await writeCache(cache, cacheKey, result, cacheTtlMs);
      return result;
    } catch (error) {
      return unavailableRoute(source, safeTransportCode(error), safeRetryable(error));
    }
  }

  async function matrix(input = {}) {
    const normalized = normalizeInput(input, {
      minimum: 2,
      maximum: maxMatrixCoordinates,
      profiles,
      defaultProfile,
      operation: 'matrix',
    });
    const source = makeSource({
      provider,
      normalized,
      mapDataVersion,
      providerVersion,
      now,
      cacheState: provider === 'disabled' || !cacheEnabled ? 'disabled' : 'miss',
    });

    if (provider === 'disabled') {
      return unavailableMatrix(source, 'provider_disabled', false);
    }

    const cacheKey = makeCacheKey('matrix', normalized, mapDataVersion);
    const cached = cacheEnabled ? await readCache(cache, cacheKey) : null;
    if (cached) return markCacheHit(cached);

    try {
      const url = buildOsrmUrl(baseUrl, 'table', normalized);
      const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      const payload = await parseProviderResponse(response, maxResponseBytes);
      const failure = classifyOsrmFailure(response, payload, 'matrix');
      if (failure) return unavailableMatrix(source, failure.code, failure.retryable);

      const result = normalizeOsrmMatrix(payload, source, normalized.coordinates.length);
      await writeCache(cache, cacheKey, result, cacheTtlMs);
      return result;
    } catch (error) {
      return unavailableMatrix(source, safeTransportCode(error), safeRetryable(error));
    }
  }

  async function match(input = {}) {
    const normalized = normalizeMatchInput(input, {
      minimum: 2,
      maximum: maxMatchCoordinates,
      profiles,
      defaultProfile,
    });
    const source = makeSource({
      provider,
      normalized,
      mapDataVersion,
      providerVersion,
      now,
      cacheState: 'disabled',
    });

    if (provider === 'disabled') {
      return unavailableMatch(source, 'provider_disabled', false);
    }

    try {
      const url = buildOsrmMatchUrl(baseUrl, normalized);
      const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      const payload = await parseProviderResponse(response, maxResponseBytes);
      const failure = classifyOsrmFailure(response, payload, 'match');
      if (failure) return unavailableMatch(source, failure.code, failure.retryable);
      return normalizeOsrmMatch(payload, source, normalized.coordinates.length);
    } catch (error) {
      return unavailableMatch(source, safeTransportCode(error), safeRetryable(error));
    }
  }

  return Object.freeze({ health, route, matrix, match });
}

function normalizeProfiles(rawProfiles) {
  const input = rawProfiles === undefined ? { driving: 'driving' } : rawProfiles;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) {
    throw new RoutingInputError('invalid_profiles');
  }

  const result = {};
  for (const [publicProfile, providerProfileValue] of Object.entries(input)) {
    const providerProfile = String(providerProfileValue);
    if (!PROFILE_PATTERN.test(publicProfile) || !PROFILE_PATTERN.test(providerProfile)) {
      throw new RoutingInputError('invalid_profile_mapping');
    }
    result[publicProfile] = providerProfile;
  }
  return Object.freeze(result);
}

function normalizeInput(input, rules) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoutingInputError('invalid_input');
  }

  const profile = input.profile === undefined ? rules.defaultProfile : String(input.profile);
  if (!Object.hasOwn(rules.profiles, profile)) {
    throw new RoutingInputError('unsupported_profile', { profile });
  }

  if (!Array.isArray(input.coordinates)) {
    throw new RoutingInputError('coordinates_required');
  }
  if (input.coordinates.length < rules.minimum) {
    throw new RoutingInputError('not_enough_coordinates', { minimum: rules.minimum });
  }
  if (input.coordinates.length > rules.maximum) {
    throw new RoutingInputError('too_many_coordinates', { maximum: rules.maximum });
  }

  const coordinates = input.coordinates.map((coordinate, index) => normalizeCoordinate(coordinate, index));
  return {
    operation: rules.operation,
    profile,
    providerProfile: rules.profiles[profile],
    coordinates,
  };
}

function normalizeCoordinate(coordinate, index) {
  if (!coordinate || typeof coordinate !== 'object' || Array.isArray(coordinate)) {
    throw new RoutingInputError('invalid_coordinate', { index });
  }
  const lat = coordinate.lat;
  const lng = coordinate.lng;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RoutingInputError('invalid_latitude', { index });
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new RoutingInputError('invalid_longitude', { index });
  }
  return { lat, lng };
}

function normalizeBaseUrl(rawValue) {
  if (!rawValue) throw new RoutingInputError('osrm_base_url_required');
  let parsed;
  try {
    parsed = new URL(String(rawValue));
  } catch {
    throw new RoutingInputError('invalid_osrm_base_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RoutingInputError('invalid_osrm_base_url');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed;
}

function buildOsrmUrl(baseUrl, service, input) {
  const url = new URL(baseUrl.toString());
  const rootPath = url.pathname.replace(/\/+$/, '');
  const coordinates = input.coordinates
    .map(({ lat, lng }) => `${fixedCoordinate(lng)},${fixedCoordinate(lat)}`)
    .join(';');
  url.pathname = `${rootPath}/${service}/v1/${input.providerProfile}/${coordinates}`;
  url.search = '';
  if (service === 'route') {
    url.searchParams.set('alternatives', 'false');
    url.searchParams.set('steps', 'false');
    url.searchParams.set('overview', 'full');
    url.searchParams.set('geometries', 'geojson');
  } else {
    url.searchParams.set('annotations', 'duration,distance');
  }
  return url;
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('routing_timeout');
      error.name = 'RoutingTimeoutError';
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function parseProviderResponse(response, maxResponseBytes) {
  if (!response || typeof response.status !== 'number' || typeof response.text !== 'function') {
    const error = new Error('invalid_provider_response');
    error.name = 'RoutingResponseError';
    throw error;
  }

  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    const error = new Error('provider_response_too_large');
    error.name = 'RoutingResponseTooLargeError';
    throw error;
  }

  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) {
    const error = new Error('provider_response_too_large');
    error.name = 'RoutingResponseTooLargeError';
    throw error;
  }

  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('invalid_provider_json');
    error.name = 'RoutingResponseError';
    throw error;
  }
}

function classifyOsrmFailure(response, payload, operation) {
  if (response.status < 200 || response.status >= 300) {
    return {
      code: response.status === 429 ? 'provider_rate_limited' : 'provider_http_error',
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { code: 'provider_invalid_response', retryable: false };
  }
  if (payload.code === 'NoRoute' || (operation === 'matrix' && payload.code === 'NoTable')) {
    return { code: operation === 'matrix' ? 'matrix_unavailable' : 'route_not_found', retryable: false };
  }
  if (operation === 'match' && (payload.code === 'NoMatch' || payload.code === 'NoSegment')) {
    return { code: 'match_not_found', retryable: false };
  }
  if (payload.code !== 'Ok') {
    return { code: 'provider_rejected_request', retryable: false };
  }
  return null;
}

function normalizeOsrmRoute(payload, source, coordinateCount) {
  try {
    if (!Array.isArray(payload.routes) || payload.routes.length === 0) throw new Error();
    const route = payload.routes[0];
    requireMetric(route.distance);
    requireMetric(route.duration);
    if (!Array.isArray(route.legs) || route.legs.length !== coordinateCount - 1) throw new Error();
    const legs = route.legs.map((leg, index) => {
      requireMetric(leg?.distance);
      requireMetric(leg?.duration);
      return {
        fromIndex: index,
        toIndex: index + 1,
        distanceMeters: leg.distance,
        durationSeconds: leg.duration,
      };
    });
    const legsDistance = legs.reduce((total, leg) => total + leg.distanceMeters, 0);
    const legsDuration = legs.reduce((total, leg) => total + leg.durationSeconds, 0);
    if (!metricsClose(route.distance, legsDistance) || !metricsClose(route.duration, legsDuration)) throw new Error();

    const geometry = normalizeGeoJsonLine(route.geometry);
    const snappedPoints = normalizeWaypoints(payload.waypoints, coordinateCount);
    return {
      status: 'ok',
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: { format: 'geojson', value: geometry },
      legs,
      snappedPoints,
      quality: { fallbackUsed: false, warnings: ['routing_duration_is_not_eta'] },
      source,
    };
  } catch {
    return unavailableRoute(source, 'provider_invalid_response', false);
  }
}

function normalizeOsrmMatrix(payload, source, coordinateCount) {
  try {
    const durations = normalizeSquareMatrix(payload.durations, coordinateCount);
    const distances = normalizeSquareMatrix(payload.distances, coordinateCount);
    const cells = [];
    let unreachableCount = 0;
    for (let fromIndex = 0; fromIndex < coordinateCount; fromIndex += 1) {
      for (let toIndex = 0; toIndex < coordinateCount; toIndex += 1) {
        const distanceMeters = distances[fromIndex][toIndex];
        const durationSeconds = durations[fromIndex][toIndex];
        const reachable = distanceMeters !== null && durationSeconds !== null;
        if (!reachable) unreachableCount += 1;
        cells.push({
          fromIndex,
          toIndex,
          status: reachable ? 'ok' : 'unreachable',
          distanceMeters: reachable ? distanceMeters : null,
          durationSeconds: reachable ? durationSeconds : null,
        });
      }
    }

    const warnings = ['routing_duration_is_not_eta'];
    if (unreachableCount > 0) warnings.push('matrix_contains_unreachable_cells');
    return {
      status: unreachableCount > 0 ? 'partial' : 'ok',
      distancesMeters: distances,
      durationsSeconds: durations,
      cells,
      quality: { fallbackUsed: false, warnings },
      source,
    };
  } catch {
    return unavailableMatrix(source, 'provider_invalid_response', false);
  }
}

function normalizeSquareMatrix(matrix, size) {
  if (!Array.isArray(matrix) || matrix.length !== size) throw new Error();
  return matrix.map((row) => {
    if (!Array.isArray(row) || row.length !== size) throw new Error();
    return row.map((value) => {
      if (value === null) return null;
      requireMetric(value);
      return value;
    });
  });
}

function normalizeGeoJsonLine(geometry) {
  if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
    throw new Error();
  }
  const coordinates = geometry.coordinates.map((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) throw new Error();
    const [lng, lat] = coordinate;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new Error();
    }
    return [lng, lat];
  });
  return { type: 'LineString', coordinates };
}

function normalizeWaypoints(waypoints, coordinateCount) {
  if (waypoints === undefined) return [];
  if (!Array.isArray(waypoints) || waypoints.length !== coordinateCount) throw new Error();
  return waypoints.map((waypoint, inputIndex) => {
    requireMetric(waypoint?.distance);
    return { inputIndex, distanceMeters: waypoint.distance };
  });
}

function unavailableRoute(source, code, retryable) {
  return {
    status: 'unavailable',
    distanceMeters: null,
    durationSeconds: null,
    geometry: null,
    legs: [],
    snappedPoints: [],
    quality: { fallbackUsed: false, warnings: [code, 'eta_not_computed'] },
    failure: { code, retryable },
    source,
  };
}

function unavailableMatrix(source, code, retryable) {
  return {
    status: 'unavailable',
    distancesMeters: null,
    durationsSeconds: null,
    cells: [],
    quality: { fallbackUsed: false, warnings: [code, 'eta_not_computed'] },
    failure: { code, retryable },
    source,
  };
}

function makeSource({ provider, normalized, mapDataVersion, providerVersion, now, cacheState }) {
  return {
    provider,
    profile: normalized.profile,
    providerProfile: normalized.providerProfile,
    mapDataVersion,
    providerVersion,
    calculatedAt: isoNow(now),
    requestFingerprint: fingerprint({
      operation: normalized.operation,
      profile: normalized.profile,
      providerProfile: normalized.providerProfile,
      coordinates: normalized.coordinates.map(({ lat, lng }) => [fixedCoordinate(lat), fixedCoordinate(lng)]),
    }),
    cache: cacheState,
  };
}

function markCacheHit(value) {
  const result = clone(value);
  result.source = { ...result.source, cache: 'hit' };
  return result;
}

function makeCacheKey(operation, normalized, mapDataVersion) {
  return fingerprint({
    operation,
    profile: normalized.profile,
    providerProfile: normalized.providerProfile,
    mapDataVersion,
    coordinates: normalized.coordinates.map(({ lat, lng }) => [fixedCoordinate(lat), fixedCoordinate(lng)]),
  });
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

async function readCache(cache, key) {
  if (!cache) return null;
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

async function writeCache(cache, key, value, ttlMs) {
  if (!cache || ttlMs <= 0 || value.status === 'unavailable') return;
  try {
    await cache.set(key, value, ttlMs);
  } catch {
    // A cache failure must not turn a valid route into an operational failure.
  }
}

function validateCache(cache) {
  if (cache === null) return;
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') {
    throw new RoutingInputError('invalid_cache');
  }
}

function requireMetric(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error();
}

function metricsClose(total, partsTotal) {
  return Math.abs(total - partsTotal) <= Math.max(1, total * 0.001);
}

function safeTransportCode(error) {
  if (error?.name === 'RoutingTimeoutError' || error?.name === 'AbortError') return 'provider_timeout';
  if (error?.name === 'RoutingResponseTooLargeError') return 'provider_response_too_large';
  if (error?.name === 'RoutingResponseError') return 'provider_invalid_response';
  return 'provider_unreachable';
}

function safeRetryable(error) {
  return !['RoutingResponseTooLargeError', 'RoutingResponseError'].includes(error?.name);
}

function safeProvenanceValue(value, code) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value);
  if (normalized.length > 100 || /[\r\n]/.test(normalized)) {
    throw new RoutingInputError(`invalid_${code}`);
  }
  return normalized;
}

function fixedCoordinate(value) {
  return Number(value).toFixed(6);
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RoutingInputError('invalid_clock');
  return date.toISOString();
}

function integerOption(value, fallback, minimum, maximum, code) {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RoutingInputError(`invalid_${code}`);
  }
  return normalized;
}

function normalizeMatchInput(input, rules) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoutingInputError('invalid_input');
  }
  const profile = input.profile === undefined ? rules.defaultProfile : String(input.profile);
  if (!Object.hasOwn(rules.profiles, profile)) {
    throw new RoutingInputError('unsupported_profile', { profile });
  }
  const points = input.points === undefined ? input.coordinates : input.points;
  if (!Array.isArray(points)) throw new RoutingInputError('coordinates_required');
  if (points.length < rules.minimum) throw new RoutingInputError('not_enough_coordinates', { minimum: rules.minimum });
  if (points.length > rules.maximum) throw new RoutingInputError('too_many_coordinates', { maximum: rules.maximum });

  const coordinates = [];
  const radiuses = [];
  points.forEach((point, index) => {
    coordinates.push(normalizeCoordinate(point, index));
    let radius = 15;
    if (point && point.accuracy != null) {
      const accuracy = Number(point.accuracy);
      if (Number.isFinite(accuracy) && accuracy > 0) radius = Math.min(50, Math.max(4, accuracy));
    }
    radiuses.push(Math.round(radius));
  });
  return { operation: 'match', profile, providerProfile: rules.profiles[profile], coordinates, radiuses };
}

function buildOsrmMatchUrl(baseUrl, input) {
  const url = new URL(baseUrl.toString());
  const rootPath = url.pathname.replace(/\/+$/, '');
  const coordinates = input.coordinates
    .map(({ lat, lng }) => `${fixedCoordinate(lng)},${fixedCoordinate(lat)}`)
    .join(';');
  url.pathname = `${rootPath}/match/v1/${input.providerProfile}/${coordinates}`;
  url.search = '';
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('tidy', 'true');
  url.searchParams.set('gaps', 'split');
  url.searchParams.set('steps', 'false');
  url.searchParams.set('annotations', 'false');
  url.searchParams.set('radiuses', input.radiuses.join(';'));
  return url;
}

function normalizeOsrmMatch(payload, source, coordinateCount) {
  try {
    if (!Array.isArray(payload.matchings) || payload.matchings.length === 0) throw new Error();
    const coordinates = [];
    let distanceMeters = 0;
    let durationSeconds = 0;
    const confidences = [];
    for (const matching of payload.matchings) {
      const geometry = normalizeGeoJsonLine(matching.geometry);
      for (const coordinate of geometry.coordinates) {
        const last = coordinates[coordinates.length - 1];
        if (!last || last[0] !== coordinate[0] || last[1] !== coordinate[1]) coordinates.push(coordinate);
      }
      if (Number.isFinite(matching.distance)) distanceMeters += matching.distance;
      if (Number.isFinite(matching.duration)) durationSeconds += matching.duration;
      if (Number.isFinite(matching.confidence)) confidences.push(matching.confidence);
    }
    if (coordinates.length < 2) throw new Error();
    const matchedPoints = Array.isArray(payload.tracepoints)
      ? payload.tracepoints.filter((tracepoint) => tracepoint !== null && tracepoint !== undefined).length
      : coordinateCount;
    const confidence = confidences.length
      ? confidences.reduce((total, value) => total + value, 0) / confidences.length
      : null;
    return {
      status: 'ok',
      geometry: { format: 'geojson', value: { type: 'LineString', coordinates } },
      matchings: payload.matchings.length,
      matchedPoints,
      totalPoints: coordinateCount,
      confidence,
      distanceMeters,
      durationSeconds,
      quality: { fallbackUsed: false, warnings: ['routing_duration_is_not_eta'] },
      source,
    };
  } catch {
    return unavailableMatch(source, 'provider_invalid_response', false);
  }
}

function unavailableMatch(source, code, retryable) {
  return {
    status: 'unavailable',
    geometry: null,
    matchings: 0,
    matchedPoints: 0,
    totalPoints: 0,
    confidence: null,
    distanceMeters: null,
    durationSeconds: null,
    quality: { fallbackUsed: false, warnings: [code, 'eta_not_computed'] },
    failure: { code, retryable },
    source,
  };
}

module.exports = {
  RoutingInputError,
  createMemoryRoutingCache,
  createRoutingAdapter,
};
