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

  // ---- Choix du fond : Plan / Satellite / Hybride ----------------------
  // Contrôle Leaflet commun (formulaire client, suivi, carte d'exploitation).
  // Le choix est mémorisé par appareil. Imagerie satellite plafonnée à son
  // zoom natif (18) puis agrandie : pas de tuiles grises « non disponible ».
  const LAYER_KEY = 'traxo.mapLayer';
  const LAYER_LABELS = { street: 'Plan', satellite: 'Satellite', hybrid: 'Hybride' };
  let layerCss = false;
  function injectLayerCss() {
    if (layerCss) return;
    layerCss = true;
    const style = document.createElement('style');
    style.textContent = `.tx-layers{display:inline-flex;gap:2px;padding:3px;border-radius:10px;background:#fff;box-shadow:0 4px 16px rgba(16,24,40,.16);border:1px solid rgba(16,24,40,.08)}
.tx-layers button{min-height:30px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:#1f2933;font-family:inherit;font-weight:600;font-size:12px;line-height:1;cursor:pointer;transition:background .15s,color .15s}
.tx-layers button:hover{background:#f2f4f7}
.tx-layers button[aria-pressed="true"]{background:#1f2933;color:#fff}
.tx-layers button:focus-visible{outline:2px solid #e11d2a;outline-offset:1px}
@media (max-width:420px){.tx-layers button{padding:0 8px;font-size:11.5px}}`;
    document.head.appendChild(style);
  }
  function rememberedLayer(fallback) {
    try { const v = localStorage.getItem(LAYER_KEY); return LAYER_LABELS[v] ? v : fallback; } catch (_) { return fallback; }
  }
  function tile(conf, extra) {
    if (!conf || typeof conf.url !== 'string' || !/^https:\/\//i.test(conf.url)) return null;
    return L.tileLayer(conf.url, {
      maxZoom: 20,
      maxNativeZoom: zoom(conf.maxNativeZoom || conf.maxZoom, 18),
      attribution: String(conf.attribution || ''),
      ...extra,
    });
  }
  function layerSwitcher(map, config, { position = 'topright', initial = 'street', onChange } = {}) {
    injectLayerCss();
    const layers = { street: baseLayer(config.base) };
    layers.satellite = tile(config.satellite);
    // Hybride : imagerie + routes + noms de lieux (couches transparentes).
    const overlays = [tile(config.roads, { pane: 'overlayPane' }), tile(config.labels, { pane: 'overlayPane' })].filter(Boolean);
    const hybridSatellite = tile(config.satellite);
    const available = layers.satellite ? ['street', 'satellite', 'hybrid'] : ['street'];
    let current = null;
    const container = L.DomUtil.create('div', 'tx-layers');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Fond de carte');
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    container.innerHTML = available.map((name) => `<button type="button" data-layer="${name}" aria-pressed="false">${LAYER_LABELS[name]}</button>`).join('');
    function set(name) {
      if (!available.includes(name)) name = 'street';
      if (name === current) return;
      [layers.street, layers.satellite, hybridSatellite, ...overlays].forEach((layer) => { if (layer && map.hasLayer(layer)) map.removeLayer(layer); });
      if (name === 'street') layers.street.addTo(map);
      else if (name === 'satellite') layers.satellite.addTo(map);
      else { hybridSatellite.addTo(map); overlays.forEach((layer) => layer.addTo(map)); }
      current = name;
      container.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layer === name)));
      try { localStorage.setItem(LAYER_KEY, name); } catch (_) { /* stockage indisponible */ }
      if (onChange) onChange(name);
    }
    container.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-layer]');
      if (button) set(button.dataset.layer);
    });
    const Control = L.Control.extend({ options: { position }, onAdd: () => container });
    const control = new Control();
    // Un seul groupe de boutons : on ne l'ajoute que si un autre fond existe.
    if (available.length > 1) control.addTo(map);
    set(rememberedLayer(initial));
    return {
      set,
      get: () => current,
      element: container,
      // Nouveau fond « Plan » annoncé par le serveur (tuiles vectorielles revenues…).
      updateStreet(base) {
        const wasStreet = current === 'street';
        if (map.hasLayer(layers.street)) map.removeLayer(layers.street);
        layers.street = baseLayer(base);
        if (wasStreet) layers.street.addTo(map);
      },
    };
  }

  window.TraxoMapBase = { load, baseLayer, layerSwitcher, fallback: FALLBACK };
})();
