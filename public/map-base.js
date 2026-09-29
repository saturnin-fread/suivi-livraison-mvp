// Fond de carte commun (back-office, formulaire client, suivi client).
// Le serveur annonce le fond à utiliser : tuiles vectorielles auto-hébergées
// ou fond raster de secours. Les tuiles vectorielles sont rendues par MapLibre
// (WebGL, style complet avec icônes) intégré à Leaflet ; sans WebGL, repli sur
// protomaps-leaflet (Canvas, plus sobre). Les bibliothèques ne sont chargées
// qu'au premier affichage d'une carte.
(function () {
  const FALLBACK = {
    base: { type: 'raster', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' },
  };
  const ASSETS = '/vendor/basemaps-assets';
  const MAPLIBRE_SCRIPTS = ['/vendor/maplibre-gl/maplibre-gl.js', '/vendor/maplibre-gl-leaflet/leaflet-maplibre-gl.js', '/vendor/protomaps-basemaps/basemaps.js'];
  const CANVAS_SCRIPTS = ['/vendor/protomaps-leaflet/protomaps-leaflet.js'];
  let pending = null;
  const loaded = {};

  function zoom(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 24 ? parsed : fallback;
  }

  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
        document.head.appendChild(script);
      });
    }
    return loaded[src];
  }

  function loadStyle(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  const loadScripts = (list) => list.reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve());

  function webglAvailable() {
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch (_) {
      return false;
    }
  }

  // ---- Repères locaux -------------------------------------------------
  // Le style Protomaps n'affiche pas ces lieux, pourtant présents dans les
  // tuiles ; ce sont les repères qu'on donne pour guider un livreur.
  const LANDMARKS = {
    pharmacy: { color: '#15803d', glyph: 'cross' },
    hospital: { color: '#dc2626', glyph: 'H' },
    clinic: { color: '#dc2626', glyph: 'H' },
    doctors: { color: '#dc2626', glyph: 'H' },
    fuel: { color: '#c2410c', glyph: 'fuel' },
    bank: { color: '#1d4ed8', glyph: 'bank' },
    atm: { color: '#1d4ed8', glyph: 'bank' },
    marketplace: { color: '#b45309', glyph: 'market' },
    place_of_worship: { color: '#6d28d9', glyph: 'worship' },
    police: { color: '#1e3a8a', glyph: 'shield' },
    hotel: { color: '#0f766e', glyph: 'bed' },
    guest_house: { color: '#0f766e', glyph: 'bed' },
  };

  function drawLandmark(kind) {
    const spec = LANDMARKS[kind];
    const ratio = 2;
    const size = 18 * ratio;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const g = canvas.getContext('2d');
    const c = size / 2;
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(c, c, c, 0, Math.PI * 2); g.fill();
    g.fillStyle = spec.color;
    g.beginPath(); g.arc(c, c, c - 1.5 * ratio, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.6 * ratio;
    const u = ratio;
    switch (spec.glyph) {
      case 'cross':
        g.fillRect(c - 1.6 * u, c - 5 * u, 3.2 * u, 10 * u);
        g.fillRect(c - 5 * u, c - 1.6 * u, 10 * u, 3.2 * u);
        break;
      case 'H':
        g.font = `700 ${11 * u}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('H', c, c + 0.5 * u);
        break;
      case 'fuel':
        g.fillRect(c - 4.5 * u, c - 5 * u, 6 * u, 10 * u);
        g.fillStyle = spec.color; g.fillRect(c - 3.3 * u, c - 3.8 * u, 3.6 * u, 3 * u); g.fillStyle = '#ffffff';
        g.beginPath(); g.moveTo(c + 1.5 * u, c - 2 * u); g.lineTo(c + 4 * u, c); g.lineTo(c + 4 * u, c + 4 * u); g.stroke();
        break;
      case 'bank':
        g.beginPath(); g.moveTo(c - 5.5 * u, c - 2 * u); g.lineTo(c, c - 5.5 * u); g.lineTo(c + 5.5 * u, c - 2 * u); g.closePath(); g.fill();
        [-4, -0.8, 2.4].forEach((x) => g.fillRect(c + x * u, c - 1 * u, 1.6 * u, 4.5 * u));
        g.fillRect(c - 5.5 * u, c + 4 * u, 11 * u, 1.6 * u);
        break;
      case 'market':
        g.fillRect(c - 5.5 * u, c - 4.5 * u, 11 * u, 2.4 * u);
        g.fillRect(c - 4.5 * u, c - 1 * u, 9 * u, 5.5 * u);
        g.fillStyle = spec.color; g.fillRect(c - 1.3 * u, c + 1 * u, 2.6 * u, 3.5 * u);
        break;
      case 'worship':
        g.beginPath(); g.moveTo(c, c - 6 * u); g.lineTo(c + 4.5 * u, c - 1 * u); g.lineTo(c + 4.5 * u, c + 5 * u);
        g.lineTo(c - 4.5 * u, c + 5 * u); g.lineTo(c - 4.5 * u, c - 1 * u); g.closePath(); g.fill();
        g.fillStyle = spec.color; g.fillRect(c - 1.2 * u, c + 1.5 * u, 2.4 * u, 3.5 * u);
        break;
      case 'shield':
        g.beginPath(); g.moveTo(c, c - 5.5 * u); g.lineTo(c + 4.8 * u, c - 3.5 * u); g.lineTo(c + 4 * u, c + 2 * u);
        g.lineTo(c, c + 5.5 * u); g.lineTo(c - 4 * u, c + 2 * u); g.lineTo(c - 4.8 * u, c - 3.5 * u); g.closePath(); g.fill();
        break;
      case 'bed':
        g.fillRect(c - 5.5 * u, c - 3.5 * u, 1.6 * u, 8 * u);
        g.fillRect(c - 5.5 * u, c + 1 * u, 11 * u, 2 * u);
        g.fillRect(c + 3.9 * u, c + 1 * u, 1.6 * u, 3.5 * u);
        g.fillRect(c - 3 * u, c - 1.5 * u, 7.5 * u, 2.5 * u);
        break;
      default: break;
    }
    return { image: g.getImageData(0, 0, size, size), ratio };
  }

  function landmarkLayer(dark) {
    const kinds = Object.keys(LANDMARKS);
    const colors = ['match', ['get', 'kind']];
    kinds.forEach((kind) => colors.push(kind, LANDMARKS[kind].color));
    colors.push('#475569');
    return {
      id: 'traxo-landmarks',
      type: 'symbol',
      source: 'protomaps',
      'source-layer': 'pois',
      minzoom: 13,
      filter: ['all', ['in', ['get', 'kind'], ['literal', kinds]], ['>=', ['zoom'], ['max', 14, ['coalesce', ['get', 'min_zoom'], 0]]]],
      layout: {
        'icon-image': ['concat', 'traxo-', ['get', 'kind']],
        'icon-size': 1,
        'text-field': ['coalesce', ['get', 'name:fr'], ['get', 'name']],
        'text-font': ['Noto Sans Medium'],
        'text-size': 11,
        'text-offset': [0, 1.15],
        'text-anchor': 'top',
        'text-max-width': 9,
        'text-optional': true,
        'symbol-sort-key': ['match', ['get', 'kind'], ['pharmacy', 'hospital', 'fuel'], 0, 1],
      },
      paint: {
        'text-color': colors,
        'text-halo-color': dark ? '#111827' : '#ffffff',
        'text-halo-width': 1.4,
      },
    };
  }

  function vectorStyle(base) {
    const origin = window.location.origin;
    const flavorName = base.flavor === 'dark' ? 'dark' : 'light';
    const layers = window.basemaps.layers('protomaps', window.basemaps.namedFlavor(flavorName), { lang: base.lang || 'fr' });
    const poiIndex = layers.findIndex((layer) => layer['source-layer'] === 'pois');
    layers.splice(poiIndex >= 0 ? poiIndex + 1 : layers.length, 0, landmarkLayer(flavorName === 'dark'));
    return {
      version: 8,
      glyphs: `${origin}${ASSETS}/fonts/{fontstack}/{range}.pbf`,
      sprite: `${origin}${ASSETS}/sprites/${flavorName}`,
      sources: {
        protomaps: {
          type: 'vector',
          tiles: [origin + base.url],
          maxzoom: zoom(base.maxDataZoom, 15),
          attribution: String(base.attribution || '&copy; OpenStreetMap'),
        },
      },
      layers,
    };
  }

  function maplibreLayer(base) {
    const layer = L.maplibreGL({ style: vectorStyle(base), interactive: false, pane: 'tilePane' });
    layer.once('add', () => {
      const gl = layer.getMaplibreMap && layer.getMaplibreMap();
      if (!gl) return;
      gl.on('styleimagemissing', (event) => {
        const kind = String(event.id || '').replace(/^traxo-/, '');
        if (event.id.indexOf('traxo-') !== 0 || !LANDMARKS[kind] || gl.hasImage(event.id)) return;
        const { image, ratio } = drawLandmark(kind);
        gl.addImage(event.id, image, { pixelRatio: ratio });
      });
    });
    return layer;
  }

  function canvasLayer(base) {
    return window.protomapsL.leafletLayer({
      url: base.url,
      flavor: base.flavor || 'light',
      lang: base.lang || 'fr',
      maxDataZoom: zoom(base.maxDataZoom, 15),
      maxZoom: zoom(base.maxZoom, 19),
      attribution: String(base.attribution || '&copy; OpenStreetMap'),
    });
  }

  function rasterLayer(base) {
    const raster = base && typeof base.url === 'string' && /^https:\/\//i.test(base.url) ? base : FALLBACK.base;
    return L.tileLayer(raster.url, { maxZoom: zoom(raster.maxZoom, 19), attribution: String(raster.attribution || '') });
  }

  async function createLayer(base) {
    const vector = !!base && base.type === 'vector' && typeof base.url === 'string' && base.url.charAt(0) === '/';
    if (!vector) return rasterLayer(base);
    if (webglAvailable()) {
      try {
        loadStyle('/vendor/maplibre-gl/maplibre-gl.css');
        await loadScripts(MAPLIBRE_SCRIPTS);
        return maplibreLayer(base);
      } catch (error) {
        console.warn('MapLibre indisponible, rendu Canvas :', error.message);
      }
    }
    try {
      await loadScripts(CANVAS_SCRIPTS);
      return canvasLayer(base);
    } catch (_) {
      return rasterLayer(FALLBACK.base);
    }
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

  // Renvoie tout de suite un groupe Leaflet (ajoutable / retirable comme une
  // couche normale) ; le fond réel y est inséré dès que ses scripts sont prêts.
  function baseLayer(base) {
    const group = L.layerGroup();
    createLayer(base).then((layer) => group.addLayer(layer));
    return group;
  }

  window.TraxoMapBase = { load, baseLayer, fallback: FALLBACK };
})();
