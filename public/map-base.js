// Fond de carte commun (back-office, formulaire client, suivi client).
// Le serveur annonce le fond à utiliser : tuiles vectorielles auto-hébergées
// (rendues ici par protomaps-leaflet) ou fond raster de secours.
(function () {
  const FALLBACK = {
    base: { type: 'raster', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' },
  };
  let pending = null;

  function zoom(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 24 ? parsed : fallback;
  }

  function isVector(base) {
    return !!base && base.type === 'vector' && typeof base.url === 'string' && base.url.charAt(0) === '/'
      && typeof window.protomapsL !== 'undefined';
  }

  function isRaster(base) {
    return !!base && typeof base.url === 'string' && /^https:\/\//i.test(base.url);
  }

  // Configuration publique (pages client) ; le back-office la reçoit déjà
  // dans son instantané d'opérations.
  function load() {
    if (!pending) {
      pending = fetch('/api/public/map-config', { credentials: 'same-origin' })
        .then((response) => (response.ok ? response.json() : FALLBACK))
        .catch(() => FALLBACK);
    }
    return pending;
  }

  function baseLayer(base) {
    if (isVector(base)) {
      return window.protomapsL.leafletLayer({
        url: base.url,
        flavor: base.flavor || 'light',
        lang: base.lang || 'fr',
        maxDataZoom: zoom(base.maxDataZoom, 15),
        maxZoom: zoom(base.maxZoom, 19),
        attribution: String(base.attribution || '&copy; OpenStreetMap'),
      });
    }
    const raster = isRaster(base) ? base : FALLBACK.base;
    return L.tileLayer(raster.url, { maxZoom: zoom(raster.maxZoom, 19), attribution: String(raster.attribution || '') });
  }

  window.TraxoMapBase = { load, baseLayer, fallback: FALLBACK };
})();
