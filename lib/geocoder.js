'use strict';

// Recherche de lieux (géocodage) pour aider un client à placer son repère :
// « Marché Dantokpa », « Pharmacie Camp Guézo »… Fournisseur configurable :
//   GEOCODER_PROVIDER = nominatim (défaut) | photon | disabled
//   GEOCODER_URL      = base du service (défaut : service public du fournisseur)
//   GEOCODER_COUNTRY  = codes pays ISO séparés par des virgules (défaut : bj)
//   GEOCODER_CONTACT  = adresse de contact transmise au service public (politique Nominatim)
// Le service public Nominatim impose au plus 1 requête/s et un cache : on
// sérialise les appels, on met en cache 24 h, et on borne la taille des entrées.

const DEFAULTS = {
  nominatim: 'https://nominatim.openstreetmap.org',
  photon: 'https://photon.komoot.io',
};

function createGeocoder(options = {}) {
  const provider = String(options.provider || 'nominatim').toLowerCase();
  if (!['nominatim', 'photon', 'disabled'].includes(provider)) throw new Error(`Fournisseur de géocodage inconnu : ${provider}`);
  const baseUrl = String(options.baseUrl || DEFAULTS[provider] || '').replace(/\/+$/, '');
  const countries = String(options.countries || 'bj').toLowerCase().split(',').map((c) => c.trim()).filter((c) => /^[a-z]{2}$/.test(c));
  const contact = options.contact ? String(options.contact) : '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) || 4000;
  const minIntervalMs = options.minIntervalMs != null ? Number(options.minIntervalMs) : (provider === 'nominatim' && !options.baseUrl ? 1100 : 0);
  const cacheTtlMs = Number(options.cacheTtlMs) || 24 * 3600 * 1000;
  const cacheMax = Number(options.cacheMax) || 500;
  const userAgent = options.userAgent || `TRAXO/1.0 (+https://app.gettraxo.app${contact ? `; ${contact}` : ''})`;
  const cache = new Map();
  let queue = Promise.resolve();
  let lastCall = 0;

  const enabled = () => provider !== 'disabled' && Boolean(baseUrl) && typeof fetchImpl === 'function';

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > cacheTtlMs) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, hit); // plus récemment utilisé à la fin
    return hit.value;
  }
  function cacheSet(key, value) {
    cache.set(key, { at: Date.now(), value });
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value);
  }

  // Un seul appel à la fois, espacés de minIntervalMs.
  function throttled(task) {
    const run = queue.then(async () => {
      const wait = lastCall + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      return task();
    });
    queue = run.catch(() => {});
    return run;
  }

  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Language': 'fr' }, signal: controller.signal });
      if (!res.ok) throw Object.assign(new Error(`geocoder_http_${res.status}`), { code: 'provider_error' });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const finite = (n) => Number.isFinite(Number(n));

  function fromNominatim(rows) {
    return (Array.isArray(rows) ? rows : []).filter((r) => finite(r.lat) && finite(r.lon)).map((r) => {
      const a = r.address || {};
      const name = clean(r.name) || clean(String(r.display_name || '').split(',')[0]);
      const area = [a.suburb || a.neighbourhood || a.quarter || a.city_district, a.city || a.town || a.village || a.municipality || a.county, a.state]
        .map(clean).filter((v, i, all) => v && v !== name && all.indexOf(v) === i);
      return { label: name, detail: area.slice(0, 2).join(', '), lat: Number(r.lat), lng: Number(r.lon), kind: clean(r.type || r.category) || null };
    });
  }
  function fromPhoton(json) {
    const features = Array.isArray(json?.features) ? json.features : [];
    return features.filter((f) => Array.isArray(f.geometry?.coordinates) && (!countries.length || countries.includes(String(f.properties?.countrycode || '').toLowerCase())))
      .map((f) => {
        const p = f.properties || {};
        const name = clean(p.name) || clean(p.street);
        const area = [p.district || p.locality, p.city || p.county, p.state].map(clean).filter((v, i, all) => v && v !== name && all.indexOf(v) === i);
        return { label: name, detail: area.slice(0, 2).join(', '), lat: Number(f.geometry.coordinates[1]), lng: Number(f.geometry.coordinates[0]), kind: clean(p.osm_value) || null };
      });
  }

  async function search(query, { near = null, limit = 6 } = {}) {
    const q = clean(query).slice(0, 120);
    if (q.length < 3) return { status: 'too_short', results: [] };
    if (!enabled()) return { status: 'disabled', results: [] };
    const n = near && finite(near.lat) && finite(near.lng) ? { lat: Number(near.lat), lng: Number(near.lng) } : null;
    const key = `${q.toLowerCase()}|${n ? `${n.lat.toFixed(2)},${n.lng.toFixed(2)}` : '-'}|${limit}`;
    const cached = cacheGet(key);
    if (cached) return { status: 'ok', results: cached, cached: true };
    let results;
    try {
      results = await throttled(async () => {
        if (provider === 'photon') {
          const url = new URL(`${baseUrl}/api/`);
          url.searchParams.set('q', q); url.searchParams.set('limit', String(limit * 2)); url.searchParams.set('lang', 'fr');
          if (n) { url.searchParams.set('lat', String(n.lat)); url.searchParams.set('lon', String(n.lng)); }
          return fromPhoton(await getJson(url));
        }
        const url = new URL(`${baseUrl}/search`);
        url.searchParams.set('q', q); url.searchParams.set('format', 'jsonv2'); url.searchParams.set('addressdetails', '1');
        url.searchParams.set('limit', String(limit)); url.searchParams.set('accept-language', 'fr');
        if (countries.length) url.searchParams.set('countrycodes', countries.join(','));
        if (contact) url.searchParams.set('email', contact);
        if (n) { // privilégier les environs, sans exclure le reste
          url.searchParams.set('viewbox', [n.lng - 0.3, n.lat + 0.3, n.lng + 0.3, n.lat - 0.3].map((v) => v.toFixed(4)).join(','));
          url.searchParams.set('bounded', '0');
        }
        return fromNominatim(await getJson(url));
      });
    } catch (error) {
      return { status: 'unavailable', results: [], error: error.code || (error.name === 'AbortError' ? 'timeout' : 'network') };
    }
    const seen = new Set();
    const unique = results.filter((r) => r.label && !seen.has(`${r.label}|${r.lat.toFixed(4)}|${r.lng.toFixed(4)}`) && seen.add(`${r.label}|${r.lat.toFixed(4)}|${r.lng.toFixed(4)}`)).slice(0, limit);
    cacheSet(key, unique);
    return { status: 'ok', results: unique };
  }

  return { search, enabled, provider };
}

module.exports = { createGeocoder };
