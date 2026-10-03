// Carte d'exploitation TRAXO (données réelles, Leaflet).
// La carte occupe toute la page. Par-dessus : la colonne « Votre équipe »
// (repliable, feuille glissante sur téléphone), les chiffres du moment qui
// servent de filtres, les fonds de carte toujours visibles, et les contrôles.
// Mode Historique : trajet d'un livreur sur une période ou d'une commande,
// même terminée, avec arrêts, coupures de signal et statuts horodatés.
// Rien n'est extrapolé : un signal ancien reste présenté comme ancien.
(function () {
  'use strict';

  // Icônes Lucide (ISC) ; moto : Tabler Icons « motorbike » (MIT).
  const P = {
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    me: '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
    maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
    minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    moto: '<path d="M5 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M19 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M7.5 14h5l4 -4h-10.5m1.5 4l4 -4"/><path d="M13 6h2l1.5 3l2 4"/>',
    truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
    bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  };
  const ic = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[n] || ''}</svg>`;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const clockSec = (t) => { const d = new Date(t); return `${clock(t)}:${pad2(d.getSeconds())}`; };
  const dayLabel = (t) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  };
  function ago(ts) {
    if (!ts) return null;
    const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} j`;
  }
  const km = (m) => (m == null ? '—' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: m < 10000 ? 1 : 0 })} km`);
  const duration = (ms) => { const min = Math.round(ms / 60000); return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${pad2(min % 60)}`; };
  const dist = (a, b) => {
    const toRad = (v) => (v * Math.PI) / 180;
    const h = Math.sin(toRad(b[0] - a[0]) / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(toRad(b[1] - a[1]) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  // Le travail du livreur et la fraîcheur du signal sont deux propriétés.
  function job(d) {
    if (d.operationalState === 'incident' || d.openIncidents > 0) return { key: 'incident', label: 'Incident', tone: 'red' };
    if (d.operationalState === 'inactive') return { key: 'off', label: 'Désactivé', tone: 'gray' };
    if (d.operationalState === 'off_duty') return { key: 'off', label: 'Hors service', tone: 'gray' };
    if (d.operationalState === 'pause') return { key: 'pause', label: 'En pause', tone: 'gray' };
    if (d.activeOrders > 0) return { key: 'moving', label: 'En livraison', tone: 'green' };
    return { key: 'available', label: 'Disponible', tone: 'blue' };
  }
  function signal(d) {
    if (!d.position) return { key: 'none', label: 'Aucune position', tone: 'gray' };
    if (d.position.stale) return { key: 'stale', label: 'Signal ancien', tone: 'amber' };
    return { key: 'live', label: 'Signal récent', tone: 'green' };
  }
  const vehicleIcon = (d) => {
    const v = String(d.vehicleType || '').toLowerCase();
    if (/v[ée]lo/.test(v)) return 'bike';
    if (/voit|camion|car|auto|utilit/.test(v)) return 'truck';
    return 'moto';
  };
  const FILTERS = {
    all: ['Tous', () => true, ''],
    moving: ['En livraison', (d) => d.activeOrders > 0, 'green'],
    available: ['Disponibles', (d) => job(d).key === 'available' && signal(d).key !== 'none', 'blue'],
    attention: ['À vérifier', (d) => signal(d).key === 'stale' || job(d).key === 'incident', 'amber'],
    none: ['Sans position', (d) => signal(d).key === 'none', 'gray'],
  };
  const BASEMAPS = [['plan', 'Plan'], ['night', 'Sombre'], ['satellite', 'Satellite'], ['hybrid', 'Hybride']];
  const ORDER_DONE = ['Livrée'];
  const ORDER_BAD = ['Annulée', 'Retournée', 'Échec', 'Retour'];

  async function render(page, deps) {
    const { api } = deps;
    if (typeof L === 'undefined') throw new Error('La carte n’a pas pu être chargée. Rechargez la page.');
    page.classList.add('page-fleetmap');
    const params = new URLSearchParams(location.search);
    const narrow = () => window.matchMedia('(max-width: 760px)').matches;
    const pref = (k, d) => { const v = store.get(`traxo.fm.${k}`); return v == null ? d : v; };
    const st = {
      snapshot: null, selectedId: params.get('livreur') || '', filter: 'all', query: '', tab: 'drivers', mode: 'current',
      collapsed: narrow() ? false : pref('collapsed', window.matchMedia('(max-width: 1100px)').matches),
      sheet: 'peek', basemap: pref('basemap', 'plan'), layersOpen: false,
      showPhotos: pref('photos', true), showNames: pref('names', true), showStops: pref('stops', true), showAllStops: pref('allstops', false),
      showRuns: pref('runs', true), showWaiting: pref('waiting', true), autoRefresh: pref('auto', true),
      follow: false, isolate: false, error: null, refreshing: false, focusWaiting: null,
      period: 'today', custom: null, target: null, track: null, loadingTrack: false, trackError: null,
      playTime: null, playing: false, speed: 60, driverOrders: null, liveRoute: null,
    };
    const root = document.createElement('div');
    root.className = 'fm';
    page.innerHTML = '';
    page.appendChild(root);
    root.innerHTML = `
      <div class="fm-stage" id="fmStage">
        <div id="fmMap" class="fm-map" aria-label="Carte des livreurs"></div>
        <section class="fm-team" id="fmTeam" aria-label="Votre équipe">
          <div id="fmTeamHead"></div><div class="fm-rail" id="fmRail"></div><div class="fm-panel-body" id="fmPanel"></div>
        </section>
        <div class="fm-top">
          <div class="fm-mode" role="group" aria-label="Mode de la carte"><button type="button" data-act="mode-current">${ic('radio')}<span>Suivi</span></button><button type="button" data-act="mode-history">${ic('history')}<span>Historique</span></button></div>
          <div class="fm-kpis" id="fmKpis" role="group" aria-label="Filtrer la carte"></div>
          <div id="fmMapState" class="fm-state"></div>
        </div>
        <div class="fm-bases-wrap">
          <div class="fm-bases" role="radiogroup" aria-label="Fond de carte" id="fmBases"></div>
          <button type="button" class="fm-tool fm-layers-btn" data-act="layers" aria-expanded="false" aria-label="Repères et options">${ic('layers')}<span>Repères</span></button>
        </div>
        <div id="fmLayers"></div>
        <div class="fm-controls">
          <button type="button" data-act="zoom-in" aria-label="Zoom avant" title="Zoom avant">${ic('plus')}</button>
          <button type="button" data-act="zoom-out" aria-label="Zoom arrière" title="Zoom arrière">${ic('minus')}</button>
          <button type="button" data-act="locate" aria-label="Ma position" title="Ma position">${ic('me')}</button>
          <button type="button" data-act="fit" aria-label="Tout afficher" title="Tout afficher">${ic('fit')}</button>
          <button type="button" data-act="fullscreen" class="fm-fs-btn" aria-label="Plein écran" title="Plein écran">${ic('maximize')}</button>
        </div>
        <div id="fmPlayer"></div>
        <div class="fm-legend" id="fmLegend"><span><i class="lg-moving"></i>En livraison</span><span><i class="lg-available"></i>Disponible</span><span><i class="lg-stale"></i>Signal ancien</span><span><i class="lg-incident"></i>Incident</span><span><i class="lg-waiting"></i>À attribuer</span></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const stage = $('#fmStage');

    // ---------- Carte et fonds
    const map = L.map($('#fmMap'), { zoomControl: false, attributionControl: true, zoomSnap: 0.5 }).setView([6.37, 2.42], 13);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
    const layers = {
      waiting: L.layerGroup().addTo(map), runs: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map), stops: L.layerGroup().addTo(map),
      drivers: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map), history: L.layerGroup().addTo(map), playhead: L.layerGroup().addTo(map),
    };
    const bases = {};
    let activeBase = [];
    function buildBases(cfg) {
      if (bases.plan) return;
      const tb = window.TraxoMapBase;
      const tile = (c, extra = {}) => L.tileLayer(c.url, { maxZoom: 20, maxNativeZoom: c.maxNativeZoom || c.maxZoom || 19, attribution: c.attribution, ...extra });
      bases.plan = tb ? tb.baseLayer(cfg.base) : tile(cfg.base);
      if (cfg.base.type === 'vector' && tb) bases.night = tb.baseLayer({ ...cfg.base, flavor: 'dark' });
      else if (cfg.dark) bases.night = tile(cfg.dark);
      if (cfg.satellite) {
        bases.satellite = tile(cfg.satellite);
        bases.hybridSat = tile(cfg.satellite);
        if (cfg.roads) bases.roads = tile(cfg.roads, { pane: 'overlayPane' });
        if (cfg.labels) bases.labels = tile(cfg.labels, { pane: 'overlayPane' });
      }
      if (!available(st.basemap)) st.basemap = 'plan';
      setBasemap(st.basemap);
    }
    const available = (k) => (k === 'plan' ? true : k === 'night' ? Boolean(bases.night) : Boolean(bases.satellite));
    const basesHtml = () => BASEMAPS.map(([k, label]) => `<button type="button" role="radio" data-basemap="${k}" aria-checked="${st.basemap === k}" aria-label="${label}" title="${available(k) ? label : 'Indisponible sur ce serveur'}" ${available(k) ? '' : 'disabled'}><span class="fm-swatch sw-${k}"></span><span class="fm-base-label">${label}</span></button>`).join('');
    function setBasemap(k) {
      if (!available(k)) return;
      activeBase.forEach((l) => map.removeLayer(l));
      activeBase = k === 'plan' ? [bases.plan] : k === 'night' ? [bases.night] : k === 'satellite' ? [bases.satellite] : [bases.hybridSat, bases.roads, bases.labels].filter(Boolean);
      activeBase.forEach((l) => l.addTo(map));
      st.basemap = k;
      store.set('traxo.fm.basemap', k);
      stage.dataset.base = k;
      $('#fmBases').innerHTML = basesHtml();
    }

    // ---------- Données
    const drivers = () => st.snapshot?.drivers || [];
    const waiting = () => st.snapshot?.waiting || [];
    const selected = () => drivers().find((d) => String(d.id) === String(st.selectedId));
    const photoUrl = (d) => (d.hasPhoto ? `/api/app/drivers/${encodeURIComponent(d.id)}/photo?v=${encodeURIComponent(d.photoVersion || 0)}` : null);
    const moving = (d) => d.position && !d.position.stale && d.position.speedKnots != null && d.position.speedKnots * 1.852 >= 4 && d.position.course != null;
    function avatar(d, size = '', { heading = false } = {}) {
      const url = st.showPhotos ? photoUrl(d) : null;
      const ring = signal(d).key === 'stale' ? 'amber' : job(d).tone;
      return `<span class="fm-av ${size} ring-${ring} ${signal(d).key === 'none' ? 'is-none' : ''}">${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<b>${esc(initials(d.name))}</b><i class="fm-veh">${ic(vehicleIcon(d))}</i>${heading && moving(d) ? `<i class="fm-heading" style="--deg:${Math.round(d.position.course)}deg"></i>` : ''}</span>`;
    }
    function stopsOf(d) {
      const seen = new Set(); const out = [];
      for (const run of d.runs || []) for (const s of run.stops || []) if (!seen.has(String(s.id))) { seen.add(String(s.id)); out.push({ ...s, run }); }
      for (const o of d.unplannedOrders || []) if (!seen.has(String(o.id))) { seen.add(String(o.id)); out.push({ ...o, run: null }); }
      return out;
    }
    // Ordre réel de passage : celui de l'itinéraire en direct quand il est connu
    // (ce que le livreur fait maintenant d'abord), sinon l'ordre de la tournée.
    function orderedStops(d) {
      const list = stopsOf(d);
      const r = st.liveRoute;
      if (!r || String(r.driverId) !== String(d.id) || !r.targets?.length) return list;
      const rank = new Map();
      r.targets.filter((t) => t.kind === 'delivery').forEach((t, i) => { if (!rank.has(t.orderId)) rank.set(t.orderId, i); });
      return list.map((x) => ({ ...x, liveN: rank.has(String(x.id)) ? rank.get(String(x.id)) + 1 : null }))
        .sort((a, b) => (a.liveN ?? 1e9) - (b.liveN ?? 1e9));
    }
    const zoneOf = (d) => stopsOf(d)[0]?.neighborhood || (d.position ? 'Position reçue' : 'Aucune position');
    const progressOf = (d) => {
      const run = (d.runs || []).find((r) => r.status === 'active') || (d.runs || [])[0];
      return run ? { done: run.completedStops, total: run.totalStops, run } : { done: 0, total: d.activeOrders, run: null };
    };
    function matches() {
      const q = st.query.trim().toLowerCase();
      const f = FILTERS[st.filter][1];
      return drivers().filter((d) => f(d) && (!q || [d.name, d.vehicleType, ...stopsOf(d).map((s) => s.neighborhood)].join(' ').toLowerCase().includes(q)));
    }
    // Livreur disponible le plus proche (signal récent, place libre), à vol d'oiseau.
    function nearestFor(w) {
      let best = null;
      for (const d of drivers()) {
        if (!d.position || d.position.stale || !['available', 'moving'].includes(job(d).key)) continue;
        if (Number(d.capacity) && d.activeOrders >= Number(d.capacity)) continue;
        const m = dist([w.latitude, w.longitude], [d.position.latitude, d.position.longitude]);
        if (!best || m < best.m) best = { d, m };
      }
      return best;
    }
    // Marges de cadrage : la zone utile est à côté de la colonne ou au-dessus de la feuille.
    function viewPadding() {
      if (narrow()) return { paddingTopLeft: [24, 130], paddingBottomRight: [64, ($('#fmTeam')?.offsetHeight || 150) + 30] };
      const left = st.collapsed ? 110 : ($('#fmTeam')?.offsetWidth || 340) + 40;
      return { paddingTopLeft: [left, 130], paddingBottomRight: [80, st.mode === 'history' ? 170 : 60] };
    }
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fly = (ll, z) => map.flyTo(ll, z ?? Math.max(map.getZoom(), 15), { duration: reduced() ? 0 : 0.42 });
    const flyBounds = (b, maxZoom = 16) => map.flyToBounds(b, { ...viewPadding(), maxZoom, duration: reduced() ? 0 : 0.42 });

    // ---------- Chiffres du moment = filtres
    function renderKpis() {
      if (st.mode === 'history') { $('#fmKpis').innerHTML = ''; return; }
      const count = (k) => drivers().filter(FILTERS[k][1]).length;
      const chips = ['moving', 'available', 'attention', 'none'].map((k) => `<button type="button" class="fm-kpi tone-${FILTERS[k][2]}" data-filter="${k}" aria-pressed="${st.filter === k}"><b>${count(k)}</b><span>${FILTERS[k][0]}</span></button>`);
      const w = waiting().length;
      chips.push(`<button type="button" class="fm-kpi tone-violet" data-act="tab-waiting" aria-pressed="${st.tab === 'waiting'}" title="Livraisons qui attendent un livreur, avec la position du client"><b>${w}</b><span>À attribuer</span></button>`);
      const pending = st.snapshot?.summary?.pendingRequests || 0;
      if (pending) chips.push(`<a class="fm-kpi tone-plain" href="/app/operations?vue=demandes"><b>${pending}</b><span>Demande${pending > 1 ? 's' : ''} à valider</span></a>`);
      $('#fmKpis').innerHTML = chips.join('');
    }

    // ---------- Colonne / feuille « Votre équipe »
    function renderTeam() {
      const d = selected();
      stage.classList.toggle('collapsed', st.collapsed && !narrow());
      stage.dataset.sheet = st.sheet;
      stage.dataset.mode = st.mode;
      const attention = drivers().filter(FILTERS.attention[1]).length;
      const sub = d ? d.name : `${plural(drivers().length, 'livreur', 'livreurs')}${attention ? ` · ${plural(attention, 'point à vérifier', 'points à vérifier')}` : ''}`;
      $('#fmTeamHead').innerHTML = `<div class="fm-team-head">
        ${narrow() ? '<button type="button" class="fm-grip" data-act="sheet" aria-label="Agrandir ou réduire le panneau"><span></span></button>' : ''}
        <button type="button" class="fm-team-toggle" data-act="${narrow() ? 'sheet' : 'collapse'}" aria-expanded="${narrow() ? st.sheet !== 'peek' : !st.collapsed}" aria-controls="fmPanel">
          <span class="fm-team-heading">${ic('users')}<span><strong>Votre équipe</strong><small>${esc(sub)}</small></span></span>
          ${ic(narrow() ? (st.sheet === 'full' ? 'chevron-down' : 'chevron-up') : (st.collapsed ? 'chevron-right' : 'chevron-left'))}</button></div>`;
      $('#fmRail').innerHTML = drivers().map((x) => `<button type="button" data-driver="${esc(x.id)}" aria-label="Afficher ${esc(x.name)}" title="${esc(x.name)}" class="${String(x.id) === String(st.selectedId) ? 'sel' : ''}">${avatar(x, 'sm')}</button>`).join('');
      const panel = $('#fmPanel');
      panel.hidden = st.collapsed && !narrow();
      if (!panel.hidden) {
        panel.innerHTML = st.mode === 'history' && st.target?.kind === 'order'
          ? `<div class="fm-detail"><div class="fm-badges"><span class="fm-badge red">Historique</span></div>${orderHistoryHtml()}</div>`
          : d ? detailHtml(d) : listHtml();
      }
      root.querySelectorAll('[data-act="mode-current"], [data-act="mode-history"]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.act === 'mode-history') === (st.mode === 'history'))));
      renderKpis(); renderMapState();
    }
    function listHtml() {
      const w = waiting();
      const tabs = `<div class="fm-tabs" role="tablist"><button type="button" role="tab" data-act="tab-drivers" aria-selected="${st.tab === 'drivers'}">Livreurs <b>${drivers().length}</b></button><button type="button" role="tab" data-act="tab-waiting" aria-selected="${st.tab === 'waiting'}">À attribuer <b>${w.length}</b></button></div>`;
      if (st.tab === 'waiting') return `${tabs}<div class="fm-list">${waitingRows()}</div><div class="fm-panel-foot">Le livreur proposé est le plus proche à vol d’oiseau parmi ceux disponibles, avec un signal récent et une place libre.</div>`;
      const filterNote = st.filter !== 'all' ? `<div class="fm-filter-note"><span>Filtre : <strong>${FILTERS[st.filter][0]}</strong></span><button type="button" data-filter="${st.filter}">Tout afficher</button></div>` : '';
      return `${tabs}<div class="fm-panel-top"><label class="fm-search">${ic('search')}<input id="fmSearch" type="search" aria-label="Rechercher un livreur" placeholder="Nom, véhicule ou quartier…" value="${esc(st.query)}" autocomplete="off"></label>${filterNote}</div>
        <div class="fm-list" id="fmList">${driverRows(matches())}</div><div class="fm-panel-foot">Chaque signal indique l’heure de sa dernière réception.</div>`;
    }
    function driverRows(ds) {
      if (!drivers().length) return '<p class="fm-empty">Aucun livreur pour le moment. Ajoutez-en depuis la page <a href="/app/livreurs">Livreurs</a>.</p>';
      if (!ds.length) return '<p class="fm-empty">Aucun livreur ne correspond.</p>';
      return ds.map((d) => {
        const j = job(d); const s = signal(d); const p = progressOf(d);
        return `<button type="button" class="fm-item" data-driver="${esc(d.id)}"><span class="fm-id">${avatar(d)}<span><strong>${esc(d.name)}</strong><small>${esc(zoneOf(d))}${p.total ? ` · ${p.done}/${p.total} livrée${p.done > 1 ? 's' : ''}` : ''}</small></span>${ic('chevron-right')}</span>
          <span class="fm-meta"><span class="fm-badge ${j.tone}">${j.label}</span>${s.key === 'stale' ? '<span class="fm-badge amber">Signal ancien</span>' : ''}<span class="fm-age">${d.position ? `il y a ${ago(d.position.timestamp)}` : 'Aucun signal'}</span></span></button>`;
      }).join('');
    }
    function waitingRows() {
      const w = waiting();
      if (!w.length) return '<p class="fm-empty">Aucune livraison en attente de livreur avec une position client.</p>';
      return w.map((x) => {
        const n = nearestFor(x);
        return `<div class="fm-wait ${st.focusWaiting === x.id ? 'sel' : ''}"><button type="button" class="fm-wait-main" data-waiting="${esc(x.id)}"><span class="fm-wait-ic">${ic('package')}</span><span><strong>${esc(x.customerName || `Demande ${x.id}`)}</strong><small>${esc(x.neighborhood || x.landmark || 'Position partagée')} · ${x.status === 'Validée' ? 'validée, sans livreur' : 'à valider'} · il y a ${ago(x.createdAt)}</small>
          ${n ? `<small class="fm-near">${ic('navigation')}Plus proche : ${esc(n.d.name)} · ${km(n.m)}</small>` : '<small class="fm-near none">Aucun livreur disponible localisé</small>'}</span></button>
          <div class="fm-stop-acts"><button type="button" data-request="${esc(x.id)}">Ouvrir la demande</button>${n ? `<button type="button" data-driver="${esc(n.d.id)}">Voir ${esc(n.d.name.split(' ')[0])}</button>` : ''}</div></div>`;
      }).join('');
    }
    function detailHtml(d) {
      const j = job(d); const s = signal(d);
      const cap = Number(d.capacity) ? ` · ${d.activeOrders}/${d.capacity} colis` : '';
      return `<div class="fm-detail"><button type="button" class="fm-back" data-act="back">${ic('arrow-left')}Tous les livreurs</button>
        <div class="fm-id fm-id-lg">${avatar(d, 'lg')}<div><strong>${esc(d.name)}</strong><small>${esc(d.vehicleType || 'Véhicule')}${cap}</small></div></div>
        <div class="fm-badges">${st.mode === 'history' ? '<span class="fm-badge red">Historique</span>' : `<span class="fm-badge ${j.tone}">${j.label}</span>${s.key !== 'live' ? `<span class="fm-badge ${s.tone}">${s.label}</span>` : ''}`}</div>
        ${st.mode === 'history' ? historyHtml() : currentHtml(d)}</div>`;
    }
    function currentHtml(d) {
      const s = signal(d);
      const speed = d.position && !d.position.stale && d.position.speedKnots != null ? `${Math.round(d.position.speedKnots * 1.852)} km/h` : null;
      const phone = String(d.phone || '').replace(/[^+\d]/g, '');
      const p = progressOf(d);
      const stops = orderedStops(d);
      const note = s.key === 'stale' ? '<div class="fm-note amber">Le livreur a peut-être avancé depuis. Ce point ne représente pas sa position actuelle.</div>'
        : s.key === 'none' ? '<div class="fm-note">Le livreur apparaîtra sur la carte dès que son application transmettra une position.</div>' : '';
      const route = st.liveRoute && String(st.liveRoute.driverId) === String(d.id) ? liveRouteHtml() : '';
      return `${note}${d.openIncidents ? `<div class="fm-note red">${ic('alert')}<span>${plural(d.openIncidents, 'incident ouvert', 'incidents ouverts')} sur ses livraisons.</span></div>` : ''}
        <dl class="fm-facts">
          <div><dt>Dernier signal</dt><dd>${d.position ? `il y a ${ago(d.position.timestamp)} · ${clock(d.position.timestamp)}` : 'Aucune position'}</dd></div>
          <div><dt>Vitesse</dt><dd>${speed || (d.position?.stale ? 'Inconnue (signal ancien)' : '—')}</dd></div>
          <div><dt>Précision</dt><dd>${d.position?.accuracy != null ? `± ${Math.round(d.position.accuracy)} m` : '—'}</dd></div>
          <div><dt>En cours</dt><dd>${plural(d.activeOrders, 'commande', 'commandes')}</dd></div>
        </dl>
        <div class="fm-actions">
          <button type="button" class="fm-btn" data-act="center" ${d.position ? '' : 'disabled'}>${ic('me')}Centrer</button>
          <button type="button" class="fm-btn ${st.follow ? 'on' : ''}" data-act="follow" aria-pressed="${st.follow}" ${d.position ? '' : 'disabled'} title="La carte suit le livreur à chaque actualisation">${ic('navigation')}Suivre</button>
          <button type="button" class="fm-btn ${st.isolate ? 'on' : ''}" data-act="isolate" aria-pressed="${st.isolate}" title="Masquer le reste de l’équipe">${ic('eye')}Lui seul</button>
          ${phone ? `<a class="fm-btn" href="tel:${esc(phone)}">${ic('phone')}Appeler</a>` : ''}
        </div>
        <button type="button" class="fm-btn primary fm-wide" data-act="mode-history">${ic('route')}Voir le trajet</button>
        ${route}
        ${stops.length ? `<div class="fm-route-head"><h3>${p.run ? esc(p.run.name || 'La tournée du jour') : 'Ses livraisons'}</h3>${p.total ? `<span>${p.done}/${p.total} livrée${p.done > 1 ? 's' : ''}</span>` : ''}</div>
          ${p.total ? `<div class="fm-progress" role="progressbar" aria-label="Tournée livrée" aria-valuenow="${p.done}" aria-valuemin="0" aria-valuemax="${p.total}"><span style="width:${Math.round((p.done / p.total) * 100)}%"></span></div>` : ''}
          ${stops.map((x, i) => `<div class="fm-stop"><span class="fm-stop-n">${x.liveN ?? x.sequence ?? i + 1}</span><div><strong>${esc(x.customerName || `Commande ${x.id}`)}</strong><p>${esc(x.neighborhood || x.landmark || x.deliveryAddress || 'Adresse à préciser')} · ${esc(x.status)}${x.destination && d.position ? ` · à ${km(dist([d.position.latitude, d.position.longitude], [x.destination.latitude, x.destination.longitude]))}` : ''}</p>
            <div class="fm-stop-acts">${x.destination ? `<button type="button" data-stop="${esc(x.id)}">Voir sur la carte</button>` : '<span class="fm-dim">Sans position GPS</span>'}<button type="button" data-order="${esc(x.id)}">Ouvrir</button></div></div></div>`).join('')}
          ${p.run ? `<button type="button" class="fm-btn fm-wide" data-run="${esc(p.run.id)}">Ouvrir la tournée ${ic('arrow-up-right')}</button>` : ''}`
        : '<p class="fm-quiet">Aucune livraison en cours pour ce livreur.</p>'}`;
    }
    function liveRouteHtml() {
      const r = st.liveRoute;
      if (r.loading) return '<div class="fm-liveroute wait"><i></i><div><strong>Calcul de l’itinéraire…</strong></div></div>';
      if (r.error) return '<div class="fm-note">Itinéraire indisponible pour le moment. Nouvel essai à la prochaine actualisation.</div>';
      if (r.status === 'no_target') return '<div class="fm-note">Aucun point à rejoindre : pas de commande en cours avec une position.</div>';
      if (r.status === 'no_position') return '<div class="fm-note amber">Pas de position récente du livreur. L’itinéraire reprendra au prochain signal.</div>';
      const next = r.targets[0];
      const leg = r.legs?.[0];
      const nextKm = leg ? leg.distanceMeters : dist([r.origin.lat, r.origin.lng], [next.lat, next.lng]);
      const what = next.kind === 'pickup' ? 'Collecte' : 'Livraison';
      const others = r.targets.length - 1;
      return `<div class="fm-liveroute ${r.status === 'ok' ? '' : 'crow'}"><i></i><div>
          <small class="fm-lr-kicker">${what} · prochain point</small>
          <strong>${esc(next.label)}${next.place ? ` · ${esc(next.place)}` : ''}</strong>
          <span class="fm-lr-eta">${km(nextKm)}${leg ? ` · ~${Math.max(1, Math.round(leg.durationSeconds / 60))} min` : ' à vol d’oiseau'}</span>
          ${others > 0 && r.status === 'ok' ? `<small>Ensuite ${plural(others, 'autre point', 'autres points')} · ${km(r.distanceMeters)} et ~${Math.round(r.durationSeconds / 60)} min au total, hors arrêts</small>` : ''}
          ${r.status !== 'ok' ? '<small>Calcul routier indisponible : ligne droite affichée.</small>' : ''}
          <small class="fm-lr-live">${ic('radio')}Recalculé à ${clockSec(new Date(r.computedAt).getTime())}, suit le livreur</small>
        </div></div>`;
    }

    // ---------- Historique
    const PERIODS = [['30', '30 min'], ['60', '1 heure'], ['today', 'Aujourd’hui'], ['yesterday', 'Hier'], ['custom', 'Période']];
    function midnight(offsetDays = 0) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offsetDays); return d.getTime(); }
    function periodRange() {
      const now = Date.now();
      if (st.period === '30') return [now - 30 * 60000, now];
      if (st.period === '60') return [now - 60 * 60000, now];
      if (st.period === 'yesterday') return [midnight(-1), midnight(0)];
      if (st.period === 'custom' && st.custom) return [st.custom.from, st.custom.to];
      return [midnight(0), now];
    }
    function historyHtml() {
      if (st.target?.kind === 'order') return orderHistoryHtml();
      const c = st.custom || {};
      const dv = new Date(c.from || midnight(0));
      const ymd = `${dv.getFullYear()}-${pad2(dv.getMonth() + 1)}-${pad2(dv.getDate())}`;
      return `<p class="fm-intro">Retrouvez le parcours sur une période précise.</p>
        <div class="fm-periods" role="group" aria-label="Période">${PERIODS.map(([k, v]) => `<button type="button" data-period="${k}" aria-pressed="${st.period === k}">${v}</button>`).join('')}</div>
        ${st.period === 'custom' ? `<form id="fmPeriodForm" class="fm-period-form" novalidate><label>Date<input type="date" name="date" value="${ymd}" max="${new Date().toISOString().slice(0, 10)}" required></label>
          <div class="fm-time-fields"><label>De<input type="time" name="from" value="${c.from ? clock(c.from) : '08:00'}" required></label><label>À<input type="time" name="to" value="${c.to ? clock(c.to) : '18:00'}" required></label></div>
          <button type="submit" class="fm-btn primary">Afficher le trajet</button><p id="fmPeriodError" class="fm-error" role="alert"></p></form>` : ''}
        ${trackSummaryHtml(st.track)}${driverOrdersHtml()}
        <button type="button" class="fm-back" data-act="mode-current">${ic('arrow-left')}Revenir au suivi</button>`;
    }
    function trackSummaryHtml(tr) {
      if (st.loadingTrack) return '<p class="fm-quiet">Chargement du trajet…</p>';
      if (st.trackError) return `<div class="fm-note red">${esc(st.trackError)}</div>`;
      if (!tr) return '';
      if (tr.message) return `<div class="fm-empty-history">${ic('route')}<strong>${esc(tr.message)}</strong></div>`;
      if (!tr.points.length) {
        return `<div class="fm-empty-history">${ic('route')}<strong>Aucun trajet sur cette période.</strong><p>Aucune position reçue entre ${clock(tr.from)} et ${clock(tr.to)}${new Date(tr.from).toDateString() !== new Date().toDateString() ? ` le ${esc(dayLabel(tr.from))}` : ''}.</p></div>`;
      }
      const first = tr.points[0].t; const last = tr.points[tr.points.length - 1].t;
      const stopMin = tr.stops.reduce((a, s) => a + s.minutes, 0);
      const span = last - first;
      const rolling = Math.max(0, span - stopMin * 60000 - tr.gaps.reduce((a, g) => a + (g.toT - g.fromT), 0));
      const avg = rolling > 120000 ? Math.round((tr.distance / 1000) / (rolling / 3600000)) : null;
      return `<div class="fm-stats"><div><strong>${km(tr.distance)}</strong><small>parcourus${avg ? ` · ${avg} km/h en roulant` : ''}</small></div><div><strong>${duration(span)}</strong><small>du premier au dernier point</small></div>
          <div><strong>${tr.stops.length}</strong><small>arrêt${tr.stops.length > 1 ? 's' : ''}${stopMin ? ` · ${duration(stopMin * 60000)}` : ''}</small></div><div><strong>${tr.gaps.length}</strong><small>coupure${tr.gaps.length > 1 ? 's' : ''} de signal</small></div></div>
        ${tr.stops.length ? `<div class="fm-route-head"><h3>Arrêts</h3></div><div class="fm-milestones">${tr.stops.map((x) => `<button type="button" class="fm-milestone stop" data-seek="${x.fromT}"><b>${clock(x.fromT)}</b><span>Arrêt de ${x.minutes} min</span></button>`).join('')}</div>` : ''}
        <p class="fm-note-small">${esc(dayLabel(first))}. ${tr.matched ? 'Le tracé est calé sur les routes.' : 'Le tracé relie les positions reçues.'}${tr.gaps.length ? ' Les coupures de signal sont en pointillés : rien n’est inventé entre deux points.' : ''}</p>`;
    }
    function driverOrdersHtml() {
      const list = st.driverOrders;
      if (!list || !list.length) return '';
      return `<div class="fm-route-head"><h3>Ses commandes sur la période</h3><span>${list.length}</span></div>
        ${list.map((o) => `<div class="fm-stop"><span class="fm-stop-n">${ic('package')}</span><div><strong>${esc(o.reference)} · ${esc(o.customerName || '')}</strong><p>${esc(o.neighborhood || '—')} · ${esc(o.status)} · ${clock(o.firstAt)}–${clock(o.lastAt)}</p>
          <div class="fm-stop-acts"><button type="button" data-replay-order="${esc(o.id)}">Rejouer ce trajet</button><button type="button" data-order="${esc(o.id)}">Ouvrir</button></div></div></div>`).join('')}`;
    }
    function orderHistoryHtml() {
      const t = st.track; const o = st.target.order;
      const head = '<p class="fm-intro">Le trajet de la commande, du départ du livreur jusqu’à la remise.</p>';
      if (st.loadingTrack || !o) return `${head}${st.trackError ? `<div class="fm-note red">${esc(st.trackError)}</div>` : '<p class="fm-quiet">Chargement du trajet…</p>'}`;
      const stamps = (st.target.milestones || []).map((m) => `<button type="button" class="fm-milestone ${ORDER_DONE.includes(m.status) ? 'ok' : ORDER_BAD.includes(m.status) ? 'bad' : ''}" data-seek="${new Date(m.at).getTime()}"><b>${clock(m.at)}</b><span>${esc(m.status)}</span></button>`).join('');
      const gap = st.target.deliveredGap;
      return `${head}<div class="fm-order-card"><strong>${esc(o.reference)}</strong><span>${esc(o.customerName || '')}${o.neighborhood ? ` · ${esc(o.neighborhood)}` : ''}</span>
          <small>${(t?.drivers || []).length > 1 ? `Livreurs : ${esc(t.drivers.join(' puis '))}` : `Livreur : ${esc(t?.drivers?.[0] || o.driverName || '—')}`}</small></div>
        <div class="fm-milestones">${stamps || '<p class="fm-quiet">Aucun statut enregistré.</p>'}</div>
        ${st.target.status === 'not_started' ? `<div class="fm-empty-history">${ic('route')}<strong>Le livreur n’est pas encore parti.</strong><p>Le trajet commence au départ vers la collecte ou la livraison.</p></div>`
          : st.target.status === 'too_long' ? '<div class="fm-note">Cette commande s’étend sur plus de 24 heures : choisissez une période depuis la fiche du livreur.</div>' : trackSummaryHtml(t)}
        ${gap != null ? `<div class="fm-note ${gap > 150 ? 'amber' : ''}">${gap > 150 ? `Livrée à ${km(gap)} de l’adresse indiquée : vérifiez la preuve de livraison.` : `Livrée à ${km(gap)} de l’adresse indiquée.`}</div>` : ''}
        <div class="fm-actions"><button type="button" class="fm-btn" data-order="${esc(o.id)}">Ouvrir la commande</button></div>
        <button type="button" class="fm-back" data-act="history-driver">${ic('arrow-left')}${selected() ? 'Trajet du livreur' : 'Revenir au suivi'}</button>`;
    }
    function buildTrack(segments, from, to) {
      const points = []; const road = []; const stops = []; const gaps = []; const names = [];
      let distance = 0; let matched = false; let message = null;
      for (const seg of segments) {
        if (seg.status === 'not_configured') message = 'Le service GPS n’est pas configuré.';
        else if (seg.status === 'no_device') message = message || 'Aucun appareil GPS n’est associé à ce livreur.';
        if (seg.driverName && !names.includes(seg.driverName)) names.push(seg.driverName);
        const pts = (seg.positions || []).map((p) => ({ ll: [p.latitude, p.longitude], t: new Date(p.timestamp).getTime() }));
        if (!pts.length) continue;
        points.push(...pts);
        distance += seg.distanceMeters || 0;
        (seg.stops || []).forEach((s) => stops.push({ ...s, fromT: new Date(s.from).getTime(), toT: new Date(s.to).getTime() }));
        (seg.gaps || []).forEach((g) => gaps.push({ ...g, fromT: new Date(g.from).getTime(), toT: new Date(g.to).getTime() }));
        if (Array.isArray(seg.roadGeometry) && seg.roadGeometry.length > 1) {
          // Horodate le tracé calé sur les routes par rapprochement avec les points bruts.
          matched = true;
          let j = 0;
          for (const ll of seg.roadGeometry) {
            while (j + 1 < pts.length && dist(ll, pts[j + 1].ll) <= dist(ll, pts[j].ll)) j += 1;
            road.push({ ll, t: pts[j].t });
          }
        } else pts.forEach((p) => road.push(p));
      }
      points.sort((a, b) => a.t - b.t);
      for (let k = 1; k < road.length; k += 1) if (road[k].t < road[k - 1].t) road[k].t = road[k - 1].t;
      return { points, road, stops, gaps, distance, matched, from, to, message: points.length ? null : message, drivers: names };
    }
    async function loadDriverHistory() {
      const d = selected();
      if (!d) return;
      stopPlay();
      const [from, to] = periodRange();
      st.target = { kind: 'driver', driverId: d.id };
      st.loadingTrack = true; st.trackError = null; st.track = null; st.driverOrders = null;
      renderTeam(); drawHistory(); renderPlayer();
      try {
        const q = `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
        const [data, orders] = await Promise.all([
          api(`/api/app/drivers/${encodeURIComponent(d.id)}/track?${q}`),
          api(`/api/app/drivers/${encodeURIComponent(d.id)}/orders?${q}`).catch(() => ({ orders: [] })),
        ]);
        if (st.target?.kind !== 'driver' || String(st.target.driverId) !== String(d.id)) return;
        st.track = buildTrack([{ ...data, driverName: d.name }], from, to);
        if (data.message) st.track.message = data.message;
        st.driverOrders = orders.orders || [];
      } catch (error) { st.trackError = error.message; }
      st.loadingTrack = false;
      st.playTime = st.track?.points.length ? st.track.points[0].t : null;
      renderTeam(); drawHistory(true); renderPlayer();
    }
    async function loadOrderHistory(orderId) {
      stopPlay();
      st.mode = 'history'; st.collapsed = false;
      if (narrow()) st.sheet = 'half';
      st.target = { kind: 'order', orderId: String(orderId) };
      st.loadingTrack = true; st.trackError = null; st.track = null;
      renderTeam(); drawCurrent(); drawHistory(); renderPlayer();
      try {
        const data = await api(`/api/app/orders/${encodeURIComponent(orderId)}/track`);
        if (st.target?.orderId !== String(orderId)) return;
        st.target = { ...st.target, order: data.order, milestones: data.milestones, status: data.status };
        const from = data.from ? new Date(data.from).getTime() : Date.now();
        const to = data.to ? new Date(data.to).getTime() : Date.now();
        st.track = data.status === 'ok' ? buildTrack(data.segments, from, to) : null;
        const delivered = (data.milestones || []).find((m) => m.status === 'Livrée');
        if (delivered && data.order.destination && st.track?.points.length) {
          const p = positionAt(new Date(delivered.at).getTime());
          if (p) st.target.deliveredGap = dist(p.ll, [data.order.destination.latitude, data.order.destination.longitude]);
        }
      } catch (error) { st.trackError = error.message; }
      st.loadingTrack = false;
      st.playTime = st.track?.points.length ? st.track.points[0].t : null;
      renderTeam(); drawHistory(true); renderPlayer();
    }
    const trackLine = () => (st.track?.road.length > 1 ? st.track.road : st.track?.points || []);
    function positionAt(t) {
      const line = trackLine();
      if (!line.length) return null;
      if (t <= line[0].t) return { ll: line[0].ll, t };
      if (t >= line[line.length - 1].t) return { ll: line[line.length - 1].ll, t };
      let lo = 0; let hi = line.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (line[mid].t <= t) lo = mid; else hi = mid; }
      const a = line[lo]; const b = line[hi];
      const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return { ll: [a.ll[0] + (b.ll[0] - a.ll[0]) * f, a.ll[1] + (b.ll[1] - a.ll[1]) * f], t };
    }
    let traveledLine = null; let playMarker = null; let playLabel = null;
    function drawHistory(fit = false) {
      layers.history.clearLayers(); layers.playhead.clearLayers();
      traveledLine = null; playMarker = null;
      if (st.mode !== 'history') return;
      const tr = st.track;
      const o = st.target?.order;
      const flag = (pt, cls, icon, tip) => L.marker(pt, { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-flag ${cls}">${ic(icon)}</span>`, iconSize: [30, 30], iconAnchor: [15, 28] }) }).addTo(layers.history).bindTooltip(tip);
      if (o?.destination) flag([o.destination.latitude, o.destination.longitude], '', 'flag', `Adresse de livraison${o.neighborhood ? ` · ${esc(o.neighborhood)}` : ''}`);
      if (o?.pickup) flag([o.pickup.latitude, o.pickup.longitude], 'pickup', 'package', `Collecte${o.pickupName ? ` · ${esc(o.pickupName)}` : ''}`);
      if (!tr || !tr.points.length) { if (fit && o?.destination) fly([o.destination.latitude, o.destination.longitude], 15); return; }
      const line = trackLine();
      const pieces = []; let cur = [];
      for (let k = 0; k < line.length; k += 1) {
        if (k && tr.gaps.some((g) => line[k - 1].t <= g.fromT + 1000 && line[k].t >= g.toT - 1000)) {
          L.polyline([line[k - 1].ll, line[k].ll], { color: '#8a94a3', weight: 3, dashArray: '4 8', opacity: 0.95 }).addTo(layers.history).bindTooltip(`Signal coupé ${clock(line[k - 1].t)}–${clock(line[k].t)}`);
          if (cur.length > 1) pieces.push(cur);
          cur = [];
        }
        cur.push(line[k].ll);
      }
      if (cur.length > 1) pieces.push(cur);
      const dark = ['night', 'satellite', 'hybrid'].includes(st.basemap);
      pieces.forEach((pc) => L.polyline(pc, { color: dark ? '#f6c3ca' : '#e9a7b0', weight: 5, opacity: 0.9 }).addTo(layers.history));
      traveledLine = L.polyline([], { color: '#e11d2a', weight: 5, opacity: 1 }).addTo(layers.history);
      L.circleMarker(line[0].ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#2f6b4f', fillOpacity: 1 }).addTo(layers.history).bindTooltip(`Premier point · ${clock(line[0].t)}`);
      L.circleMarker(line[line.length - 1].ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#27303a', fillOpacity: 1 }).addTo(layers.history).bindTooltip(`Dernier point · ${clock(line[line.length - 1].t)}`);
      tr.stops.forEach((s) => {
        L.marker([s.latitude, s.longitude], { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-stopdot">${s.minutes}′</span>`, iconSize: [32, 20], iconAnchor: [16, 10] }) })
          .addTo(layers.history).bindTooltip(`Arrêt de ${s.minutes} min · ${clock(s.fromT)}–${clock(s.toT)}`).on('click', () => seek(s.fromT));
      });
      (st.target?.milestones || []).forEach((m) => {
        const t = new Date(m.at).getTime();
        if (t < tr.points[0].t - 60000 || t > tr.points[tr.points.length - 1].t + 60000) return;
        const p = positionAt(t);
        if (!p) return;
        const tone = ORDER_DONE.includes(m.status) ? 'ok' : ORDER_BAD.includes(m.status) ? 'bad' : '';
        L.marker(p.ll, { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-mile ${tone}"></span>`, iconSize: [14, 14], iconAnchor: [7, 7] }) })
          .addTo(layers.history).bindTooltip(`${esc(m.status)} · ${clock(t)}`, { direction: 'top', offset: [0, -6] }).on('click', () => seek(t));
      });
      const who = st.target?.kind === 'driver' ? selected() : drivers().find((x) => x.name === tr.drivers[0]);
      const icon = L.divIcon({ className: 'fm-divicon', html: `<span class="fm-pin history">${who ? avatar(who) : `<span class="fm-av">${ic('moto')}</span>`}</span>`, iconSize: [46, 46], iconAnchor: [23, 23] });
      playMarker = L.marker(line[0].ll, { icon, zIndexOffset: 1000 }).addTo(layers.playhead);
      playLabel = L.tooltip({ permanent: true, direction: 'bottom', offset: [0, 22], className: 'fm-play-label' });
      playMarker.bindTooltip(playLabel).openTooltip();
      if (fit) {
        const b = L.latLngBounds(line.map((p) => p.ll));
        if (o?.destination) b.extend([o.destination.latitude, o.destination.longitude]);
        flyBounds(b);
      }
      updatePlayhead();
    }
    function updatePlayhead() {
      const tr = st.track;
      if (!tr || !tr.points.length || !playMarker) return;
      const t = st.playTime ?? tr.points[0].t;
      const p = positionAt(t);
      if (!p) return;
      playMarker.setLatLng(p.ll);
      const done = trackLine().filter((x) => x.t <= t).map((x) => x.ll);
      done.push(p.ll);
      traveledLine?.setLatLngs(done);
      const inStop = tr.stops.find((s) => t >= s.fromT && t <= s.toT);
      const inGap = tr.gaps.find((g) => t > g.fromT && t < g.toT);
      playLabel?.setContent(`${clockSec(t)}${inStop ? ' · à l’arrêt' : inGap ? ' · signal coupé' : ''}`);
      const range = $('#fmTimeline'); if (range && Number(range.value) !== Math.round(t / 1000)) range.value = Math.round(t / 1000);
      const now = $('#fmPlayNow'); if (now) now.textContent = clock(t);
    }

    // ---------- Lecteur : frise colorée (en route / arrêt / coupure) et jalons
    let raf = null; let lastFrame = 0;
    function renderPlayer() {
      const tr = st.track;
      const has = Boolean(st.mode === 'history' && tr && tr.points.length);
      stage.classList.toggle('has-player', has);
      if (!has) { $('#fmPlayer').innerHTML = ''; return; }
      const first = tr.points[0].t; const last = tr.points[tr.points.length - 1].t;
      const span = Math.max(1, last - first);
      const pct = (t) => Math.max(0, Math.min(100, ((t - first) / span) * 100));
      const bands = [...tr.stops.map((s) => ({ a: s.fromT, b: s.toT, cls: 'stop', tip: `Arrêt de ${s.minutes} min` })), ...tr.gaps.map((g) => ({ a: g.fromT, b: g.toT, cls: 'gap', tip: `Signal coupé ${g.minutes} min` }))]
        .map((x) => `<i class="fm-band ${x.cls}" style="left:${pct(x.a)}%;width:${Math.max(0.6, pct(x.b) - pct(x.a))}%" title="${esc(x.tip)}"></i>`).join('');
      const ticks = (st.target?.milestones || []).map((m) => ({ t: new Date(m.at).getTime(), s: m.status })).filter((m) => m.t >= first - 60000 && m.t <= last + 60000)
        .map((m) => `<button type="button" class="fm-tick ${ORDER_DONE.includes(m.s) ? 'ok' : ORDER_BAD.includes(m.s) ? 'bad' : ''}" style="left:${pct(m.t)}%" data-seek="${m.t}" title="${esc(m.s)} · ${clock(m.t)}" aria-label="${esc(m.s)} à ${clock(m.t)}"></button>`).join('');
      const who = st.target?.kind === 'order' ? `la commande ${st.target.order?.reference || ''}` : (selected()?.name.split(' ')[0] || '');
      $('#fmPlayer').innerHTML = `<div class="fm-player"><div class="fm-player-title"><strong>Le trajet de ${esc(who)}</strong><span>${esc(dayLabel(first))}</span>
          <span class="fm-player-legend"><i class="run"></i>En route<i class="stop"></i>Arrêt<i class="gap"></i>Signal coupé</span></div>
        <div class="fm-player-controls"><button type="button" class="fm-play" data-act="play" aria-label="${st.playing ? 'Mettre en pause' : 'Lire le trajet'}">${ic(st.playing ? 'pause' : 'play')}</button>
          <div class="fm-scrub"><div class="fm-scrub-track">${bands}${ticks}</div><label class="fm-sr" for="fmTimeline">Heure sur le trajet</label><input type="range" id="fmTimeline" min="${Math.round(first / 1000)}" max="${Math.round(last / 1000)}" step="1" value="${Math.round((st.playTime ?? first) / 1000)}">
            <div class="fm-scrub-labels"><span>${clock(first)}</span><span>${clock(last)}</span></div></div>
          <label class="fm-sr" for="fmSpeed">Vitesse de lecture</label><select id="fmSpeed">${[30, 60, 120, 300].map((n) => `<option value="${n}" ${st.speed === n ? 'selected' : ''}>${n}×</option>`).join('')}</select>
          <strong class="fm-play-now" id="fmPlayNow">${clock(st.playTime ?? first)}</strong></div></div>`;
    }
    function frame(ts) {
      const tr = st.track;
      if (!st.playing || !tr) return;
      const dt = lastFrame ? Math.min(250, ts - lastFrame) : 16;
      lastFrame = ts;
      let t = (st.playTime ?? tr.points[0].t) + dt * st.speed;
      const gap = tr.gaps.find((g) => t > g.fromT && t < g.toT);
      if (gap) t = gap.toT; // on ne rejoue pas le vide
      const last = tr.points[tr.points.length - 1].t;
      if (t >= last) { st.playTime = last; updatePlayhead(); stopPlay(); renderPlayer(); return; }
      st.playTime = t;
      updatePlayhead();
      raf = requestAnimationFrame(frame);
    }
    function play() {
      const tr = st.track;
      if (!tr || !tr.points.length) return;
      if ((st.playTime ?? 0) >= tr.points[tr.points.length - 1].t) st.playTime = tr.points[0].t;
      st.playing = true; lastFrame = 0;
      renderPlayer();
      raf = requestAnimationFrame(frame);
    }
    function stopPlay() { st.playing = false; if (raf) cancelAnimationFrame(raf); raf = null; }
    function seek(t) {
      stopPlay();
      const pts = st.track?.points || [];
      st.playTime = pts.length ? Math.min(Math.max(t, pts[0].t), pts[pts.length - 1].t) : t;
      renderPlayer(); updatePlayhead();
    }

    // ---------- Suivi en direct
    function tipHtml(d) {
      const j = job(d); const s = signal(d); const next = stopsOf(d)[0]; const p = progressOf(d);
      return `<div class="fm-tip-card"><strong>${esc(d.name)}</strong><span class="fm-badge ${j.tone}">${j.label}</span>
        <small>${s.key === 'stale' ? `Signal ancien · il y a ${ago(d.position.timestamp)}` : `Signal il y a ${ago(d.position.timestamp)}`}${moving(d) ? ` · ${Math.round(d.position.speedKnots * 1.852)} km/h` : ''}</small>
        ${p.total ? `<small>${p.done}/${p.total} livrée${p.done > 1 ? 's' : ''}${next ? ` · prochaine : ${esc(next.neighborhood || next.customerName || '')}` : ''}</small>` : ''}</div>`;
    }
    function drawCurrent() {
      ['drivers', 'stops', 'runs', 'waiting'].forEach((k) => layers[k].clearLayers());
      if (st.mode === 'history') { layers.route.clearLayers(); return; }
      const sel = selected();
      const shown = (st.isolate && sel ? [sel] : matches()).filter((d) => d.position);
      const z = map.getZoom();
      const groups = [];
      for (const d of shown) {
        const pt = map.latLngToLayerPoint([d.position.latitude, d.position.longitude]);
        const own = String(d.id) === String(st.selectedId);
        const g = z < 15 && !own ? groups.find((x) => !x.locked && x.pt.distanceTo(pt) < 46) : null;
        if (g) g.items.push(d); else groups.push({ pt, items: [d], locked: own });
      }
      for (const g of groups) {
        if (g.items.length > 1) {
          const b = L.latLngBounds(g.items.map((d) => [d.position.latitude, d.position.longitude]));
          const tones = ['green', 'blue', 'amber', 'red'].map((tn) => [tn, g.items.filter((d) => (signal(d).key === 'stale' ? 'amber' : job(d).tone) === tn).length]).filter(([, n]) => n);
          const icon = L.divIcon({ className: 'fm-divicon', html: `<button type="button" class="fm-cluster" aria-label="${g.items.length} livreurs proches, rapprocher la carte"><b>${g.items.length}</b><span class="fm-cluster-tones">${tones.map(([tn, n]) => `<i class="${tn}" style="flex:${n}"></i>`).join('')}</span></button>`, iconSize: [44, 44], iconAnchor: [22, 22] });
          L.marker(b.getCenter(), { icon, keyboard: false }).addTo(layers.drivers)
            .bindTooltip(g.items.slice(0, 6).map((d) => esc(d.name)).join('<br>') + (g.items.length > 6 ? `<br>et ${g.items.length - 6} autres` : ''), { direction: 'top', offset: [0, -22] })
            .on('click', () => flyBounds(b.pad(0.6)));
          continue;
        }
        const d = g.items[0];
        const isSel = String(d.id) === String(st.selectedId);
        const j = job(d); const s = signal(d);
        const label = st.showNames && (isSel || z >= 14) ? `<span class="fm-pin-name"><strong>${esc(d.name.split(' ')[0])}</strong><small class="${s.key === 'stale' ? 'amber' : j.tone}">${s.key === 'stale' ? `Signal ancien · ${ago(d.position.timestamp)}` : j.label}</small></span>` : '';
        const icon = L.divIcon({ className: 'fm-divicon', html: `<span class="fm-pin ${isSel ? 'sel' : ''}">${avatar(d, '', { heading: true })}${label}</span>`, iconSize: [46, 46], iconAnchor: [23, 23] });
        L.marker([d.position.latitude, d.position.longitude], { icon, title: d.name, zIndexOffset: isSel ? 900 : 0, riseOnHover: true }).addTo(layers.drivers)
          .bindTooltip(tipHtml(d), { direction: 'top', offset: [0, -26], className: 'fm-tip', opacity: 1 })
          .on('click', () => selectDriver(d.id, { pan: false }));
      }
      if (st.showStops) {
        const owners = st.isolate && sel ? [sel] : (st.showAllStops ? matches() : (sel ? [sel] : []));
        owners.forEach((d) => {
          const mine = sel && String(d.id) === String(sel.id);
          (mine ? orderedStops(d) : stopsOf(d)).forEach((x, i) => {
            if (!x.destination) return;
            const html = mine ? `<span class="fm-dest">${esc(x.liveN ?? x.sequence ?? i + 1)}</span>` : `<span class="fm-dest-dot tone-${job(d).tone}"></span>`;
            L.marker([x.destination.latitude, x.destination.longitude], { icon: L.divIcon({ className: 'fm-divicon', html, iconSize: mine ? [28, 28] : [12, 12], iconAnchor: mine ? [14, 14] : [6, 6] }), title: x.customerName || `Commande ${x.id}` })
              .addTo(layers.stops)
              .bindPopup(`<div class="fm-popup"><strong>${esc(x.customerName || `Commande ${x.id}`)}</strong><span>${esc(x.neighborhood || x.landmark || x.deliveryAddress || '')}</span><small>${esc(d.name)} · ${esc(x.status)}</small><button type="button" data-order="${esc(x.id)}">Ouvrir la commande</button></div>`);
          });
          // Ordre des arrêts, à vol d'oiseau, pour le livreur choisi.
          // Inutile quand l'itinéraire en direct est tracé : il montre déjà l'ordre réel.
          const live = st.liveRoute && String(st.liveRoute.driverId) === String(d.id) && st.liveRoute.targets?.length;
          if (mine && st.showRuns && !live) {
            const pts = stopsOf(d).filter((x) => x.destination).map((x) => [x.destination.latitude, x.destination.longitude]);
            if (d.position) pts.unshift([d.position.latitude, d.position.longitude]);
            if (pts.length > 1) L.polyline(pts, { color: '#5b6878', weight: 2.5, dashArray: '6 8', opacity: 0.75 }).addTo(layers.runs);
          }
        });
      }
      if (st.showWaiting && !st.isolate) {
        waiting().forEach((w) => {
          const focus = st.focusWaiting === w.id;
          L.marker([w.latitude, w.longitude], { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-waiting ${focus ? 'sel' : ''}">${ic('package')}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: focus ? 800 : 0 })
            .addTo(layers.waiting)
            .bindTooltip(`<div class="fm-tip-card"><strong>${esc(w.customerName || 'Demande')}</strong><small>${esc(w.neighborhood || '')} · en attente d’un livreur</small></div>`, { direction: 'top', offset: [0, -14], className: 'fm-tip', opacity: 1 })
            .on('click', () => focusWaiting(w.id));
        });
      }
    }
    function focusWaiting(id) {
      const w = waiting().find((x) => x.id === String(id));
      if (!w) return;
      st.focusWaiting = w.id; st.tab = 'waiting'; st.selectedId = '';
      if (narrow()) st.sheet = 'half'; else st.collapsed = false;
      layers.route.clearLayers(); st.liveRoute = null;
      renderTeam(); drawCurrent();
      const n = nearestFor(w);
      if (n) flyBounds(L.latLngBounds([[w.latitude, w.longitude], [n.d.position.latitude, n.d.position.longitude]]).pad(0.3), 16);
      else fly([w.latitude, w.longitude], 16);
    }
    // Itinéraire en direct : recalculé quand le livreur a bougé (≥ 30 m), quand
    // ses commandes changent, ou au plus tard toutes les 60 s.
    const routeSig = (d) => stopsOf(d).map((x) => `${x.id}:${x.status}`).join('|');
    function liveRouteStale(d) {
      const r = st.liveRoute;
      if (!r || String(r.driverId) !== String(d.id) || r.error) return true;
      if (r.loading || r.pending) return false;
      if (r.sig !== routeSig(d)) return true;
      if (Date.now() - new Date(r.computedAt).getTime() > 60000) return true;
      if (d.position && r.origin) return dist([d.position.latitude, d.position.longitude], [r.origin.lat, r.origin.lng]) >= 30;
      return Boolean(d.position) !== Boolean(r.origin);
    }
    let routeSeq = 0;
    async function refreshLiveRoute({ fit = false, force = false } = {}) {
      const d = selected();
      if (!d || st.mode !== 'current') { layers.route.clearLayers(); st.liveRoute = null; return; }
      if (!force && !liveRouteStale(d)) return;
      const seq = ++routeSeq;
      const keep = st.liveRoute && String(st.liveRoute.driverId) === String(d.id) && !st.liveRoute.error;
      if (!keep) { layers.route.clearLayers(); st.liveRoute = { driverId: d.id, loading: true }; renderTeam(); }
      else st.liveRoute.pending = true; // l'ancien tracé reste affiché pendant le recalcul
      let data;
      try { data = await api(`/api/app/drivers/${encodeURIComponent(d.id)}/live-route`); }
      catch { if (seq === routeSeq) { st.liveRoute = { driverId: d.id, error: true }; layers.route.clearLayers(); renderTeam(); } return; }
      if (seq !== routeSeq || String(selected()?.id) !== String(d.id) || st.mode !== 'current') return;
      st.liveRoute = { driverId: d.id, sig: routeSig(d), status: data.status, targets: data.targets || [], origin: data.origin, computedAt: data.computedAt,
        distanceMeters: data.route?.distanceMeters, durationSeconds: data.route?.durationSeconds, legs: data.route?.legs || [] };
      const fitTo = fit && !st.follow && data.origin && data.targets?.[0]
        ? L.latLngBounds([[data.origin.lat, data.origin.lng], [data.targets[0].lat, data.targets[0].lng]]).pad(0.35) : null;
      renderTeam(); drawCurrent();
      drawLiveRoute(data, { fitTo });
    }
    // Tracé façon itinéraire : la caméra cadre A → B, la ligne se dessine depuis
    // le livreur jusqu'au prochain point, puis un flux de points avance dans le
    // sens de la marche. Tant que la destination ne change pas, les recalculs
    // déplacent la ligne sans rejouer l'animation.
    let routeDraw = null;
    const routeKey = (data) => { const t = data.targets?.[0]; return t ? `${data.driverId}|${t.orderId}:${t.kind}|${data.status}` : ''; };
    function drawIn(lines, ms, done) {
      const paths = lines.map((l) => l._path).filter(Boolean);
      let over = false;
      const end = () => {
        if (over) return; over = true; map.off('zoomstart', end);
        paths.forEach((p) => { p.style.transition = ''; p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; p.style.opacity = ''; });
        done();
      };
      if (!paths.length) { end(); return; }
      map.once('zoomstart', end); // un zoom pendant le dessin change la longueur : on affiche tout de suite
      paths.forEach((p) => { const len = p.getTotalLength(); p.style.transition = 'none'; p.style.strokeDasharray = `${len} ${len}`; p.style.strokeDashoffset = `${len}`; p.style.opacity = ''; });
      paths[0].getBoundingClientRect();
      requestAnimationFrame(() => paths.forEach((p) => { p.style.transition = `stroke-dashoffset ${ms}ms cubic-bezier(.5,.05,.25,1)`; p.style.strokeDashoffset = '0'; }));
      setTimeout(end, ms + 80);
    }
    function drawLiveRoute(data, { fitTo = null } = {}) {
      if (!data.origin || !data.targets?.length) { layers.route.clearLayers(); routeDraw = null; return; }
      const coords = data.status === 'ok' && data.route?.geometry?.value?.coordinates?.length >= 2
        ? data.route.geometry.value.coordinates.map(([lng, lat]) => [lat, lng])
        : [[data.origin.lat, data.origin.lng], ...data.targets.map((t) => [t.lat, t.lng])];
      const crow = data.status !== 'ok';
      const key = routeKey(data);
      if (routeDraw && routeDraw.key === key && map.hasLayer(routeDraw.line)) {
        [routeDraw.casing, routeDraw.line, routeDraw.flow].forEach((l) => l?.setLatLngs(coords));
        return;
      }
      layers.route.clearLayers();
      const style = { interactive: false, lineCap: 'round', lineJoin: 'round' };
      const casing = L.polyline(coords, { ...style, color: '#9d1320', weight: 10, opacity: 0.9, className: 'fm-route-casing' }).addTo(layers.route);
      const line = L.polyline(coords, { ...style, color: '#e11d2a', weight: 6, opacity: 1, dashArray: crow ? '8 10' : null, className: 'fm-route-line' }).addTo(layers.route);
      const flow = crow ? null : L.polyline(coords, { ...style, color: '#ffffff', weight: 4, opacity: 0.9, dashArray: '0.5 15.5', className: 'fm-route-flow' });
      const next = data.targets[0];
      const halo = L.marker([next.lat, next.lng], { icon: L.divIcon({ className: 'fm-divicon', html: '<span class="fm-next-halo" aria-hidden="true"></span>', iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false, zIndexOffset: -10 });
      data.targets.filter((t) => t.kind === 'pickup').forEach((t) => {
        L.marker([t.lat, t.lng], { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-pickup" title="Collecte">${ic('package')}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }), title: `Collecte · ${t.label}` })
          .addTo(layers.route).bindTooltip(`<div class="fm-tip-card"><strong>Collecte · ${esc(t.label)}</strong><small>Pour ${esc(t.customerName || t.reference || '')}</small></div>`, { direction: 'top', offset: [0, -14], className: 'fm-tip', opacity: 1 });
      });
      const draw = { key, casing, line, flow };
      routeDraw = draw;
      stage.dataset.route = 'drawing';
      const finish = () => {
        if (routeDraw !== draw || !map.hasLayer(line)) return;
        flow?.addTo(layers.route); halo.addTo(layers.route);
        stage.dataset.route = 'ready';
      };
      const start = () => { if (routeDraw !== draw || !map.hasLayer(line)) return; if (reduced() || crow) finish(); else drawIn([casing, line], 1200, finish); };
      if (fitTo && !reduced()) {
        [casing, line].forEach((l) => { if (l._path) l._path.style.opacity = '0'; });
        flyBounds(fitTo, 16);
        setTimeout(start, 520); // après le cadrage (0,42 s) : la longueur du tracé est alors stable
      } else {
        if (fitTo) flyBounds(fitTo, 16);
        start();
      }
    }
    function renderMapState() {
      const d = selected();
      let text;
      if (st.mode === 'history') text = st.target?.kind === 'order' ? `Historique · ${st.target.order?.reference || 'commande'}` : `Historique · ${d?.name || ''}${st.track ? ` · ${dayLabel(st.track.from)}` : ''}`;
      else if (d) text = d.position ? `${d.name.split(' ')[0]} · signal il y a ${ago(d.position.timestamp)}${st.follow ? ' · suivi' : ''}` : `${d.name} · aucune position`;
      else {
        const located = matches().filter((x) => x.position).length;
        const none = matches().length - located;
        text = `${plural(located, 'position', 'positions')}${none ? ` · ${none} sans signal` : ''}`;
      }
      const upd = st.snapshot ? `${st.autoRefresh ? 'Actualisé' : 'En pause · actualisé'} à ${clock(st.snapshot.generatedAt)}` : 'Chargement…';
      const service = st.snapshot?.locationService;
      const warn = st.error ? `<div class="fm-map-status red">${ic('alert')}<span>${esc(st.error)}</span></div>`
        : service && service.status !== 'online' ? `<div class="fm-map-status amber">${ic('alert')}<span>${esc(service.message)}</span></div>` : '';
      $('#fmMapState').innerHTML = `<div class="fm-map-status ${st.mode === 'history' ? 'history' : ''}">${ic(st.mode === 'history' ? 'history' : 'radio')}<span>${esc(text)}</span><span class="fm-sep" aria-hidden="true"></span><button type="button" data-act="refresh" title="Actualiser maintenant">${ic('refresh')}<span>${esc(upd)}</span></button></div>${warn}`;
    }
    function renderLayersPanel() {
      $('[data-act="layers"]').setAttribute('aria-expanded', String(st.layersOpen));
      const opt = (key, label, hint = '') => `<label><input type="checkbox" data-layer="${key}" ${st[key] ? 'checked' : ''}><span>${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`;
      $('#fmLayers').innerHTML = st.layersOpen ? `<div class="fm-layers" role="dialog" aria-label="Repères et options"><div class="fm-layers-head"><h3>Repères et options</h3><button type="button" data-act="layers" aria-label="Fermer">${ic('x')}</button></div>
        <div class="fm-bases fm-bases-panel" role="radiogroup" aria-label="Fond de carte">${basesHtml()}</div>
        ${opt('showPhotos', 'Photos des livreurs')}${opt('showNames', 'Noms des livreurs', 'à partir du zoom quartier')}
        ${opt('showStops', 'Destinations')}${opt('showAllStops', 'Destinations de toute l’équipe', 'sinon, seulement celles du livreur choisi')}
        ${opt('showRuns', 'Ordre des arrêts')}${opt('showWaiting', 'Livraisons à attribuer')}
        ${opt('autoRefresh', 'Actualisation automatique', 'toutes les 15 secondes')}
        <p>Le fond de carte ne change pas les positions.</p></div>` : '';
    }

    function selectDriver(id, { pan = true } = {}) {
      st.selectedId = String(id); st.follow = false; st.focusWaiting = null; st.tab = 'drivers';
      if (narrow()) st.sheet = 'half';
      if (st.mode === 'history') { loadDriverHistory(); return; }
      renderTeam(); drawCurrent(); refreshLiveRoute({ fit: pan, force: true });
      const d = selected();
      if (pan && d?.position) fly([d.position.latitude, d.position.longitude]);
      history.replaceState(null, '', `/app/carte?livreur=${encodeURIComponent(id)}`);
    }
    function setMode(mode) {
      stopPlay();
      st.mode = mode;
      if (mode === 'history') {
        if (!selected()) { const first = matches().find((d) => d.position) || drivers()[0]; if (first) st.selectedId = String(first.id); }
        if (!selected()) { st.mode = 'current'; renderTeam(); return; }
        st.collapsed = false; if (narrow()) st.sheet = 'half';
        drawCurrent(); loadDriverHistory();
        return;
      }
      st.target = null; st.track = null; st.driverOrders = null;
      layers.history.clearLayers(); layers.playhead.clearLayers();
      renderPlayer(); renderTeam(); drawCurrent(); refreshLiveRoute({ force: true });
    }
    function fitAll() {
      if (st.mode === 'history' && st.track?.points.length) { drawHistory(true); return; }
      const pts = (st.isolate && selected() ? [selected()] : matches()).filter((d) => d.position).map((d) => [d.position.latitude, d.position.longitude]);
      if (st.showWaiting && !st.isolate && st.filter === 'all') waiting().forEach((w) => pts.push([w.latitude, w.longitude]));
      if (pts.length) flyBounds(L.latLngBounds(pts).pad(0.1), 15);
    }
    function locateMe() {
      if (!navigator.geolocation) { flashError('La position de cet appareil n’est pas disponible.'); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        const ll = [pos.coords.latitude, pos.coords.longitude];
        layers.me.clearLayers();
        L.circle(ll, { radius: pos.coords.accuracy || 30, color: '#3459a8', weight: 1, fillOpacity: 0.08 }).addTo(layers.me);
        L.marker(ll, { icon: L.divIcon({ className: 'fm-divicon', html: '<span class="fm-me"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(layers.me).bindTooltip('Vous êtes ici');
        fly(ll, 15);
      }, () => flashError('Position refusée par le navigateur.'), { enableHighAccuracy: true, timeout: 10000 });
    }
    function flashError(text) { st.error = text; renderMapState(); setTimeout(() => { if (st.error === text) { st.error = null; renderMapState(); } }, 4000); }
    function toggleFullscreen() {
      if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
      if (stage.requestFullscreen) stage.requestFullscreen().catch(() => document.body.classList.toggle('fm-focused'));
      else document.body.classList.toggle('fm-focused');
      setTimeout(() => map.invalidateSize(), 150);
    }

    let timer = null;
    async function loadSnapshot(first = false) {
      if (st.refreshing) return;
      st.refreshing = true;
      try {
        st.snapshot = await api('/api/app/operations-map');
        st.error = null;
        buildBases(st.snapshot.mapConfig);
        if (st.selectedId && !selected()) st.selectedId = '';
        if (st.focusWaiting && !waiting().some((w) => w.id === st.focusWaiting)) st.focusWaiting = null;
        if (st.mode === 'current') { renderTeam(); drawCurrent(); } else { renderKpis(); renderMapState(); }
        const d = selected();
        if (st.follow && d?.position && st.mode === 'current') map.panTo([d.position.latitude, d.position.longitude], { animate: !reduced() });
        if (first) {
          if (d?.position) map.setView([d.position.latitude, d.position.longitude], 15); else fitAll();
          if (d) refreshLiveRoute({ fit: true, force: true });
        } else if (d && st.mode === 'current') refreshLiveRoute();
      } catch (error) {
        st.error = `Actualisation impossible : ${error.message}`;
        renderMapState();
      }
      st.refreshing = false;
      schedule();
    }
    function schedule() {
      clearTimeout(timer);
      if (st.autoRefresh && !document.hidden) timer = setTimeout(() => loadSnapshot(false), Math.max(10, Number(st.snapshot?.refreshAfterSeconds || 15)) * 1000);
    }

    // ---------- Interactions
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button, a[data-order]');
      if (!b || b.disabled) return;
      if (b.dataset.driver) { selectDriver(b.dataset.driver); return; }
      if (b.dataset.filter) {
        st.filter = st.filter === b.dataset.filter ? 'all' : b.dataset.filter;
        st.tab = 'drivers'; st.selectedId = ''; st.isolate = false; st.follow = false;
        if (narrow() && st.sheet === 'peek') st.sheet = 'half';
        layers.route.clearLayers(); st.liveRoute = null;
        renderTeam(); drawCurrent(); fitAll(); return;
      }
      if (b.dataset.basemap) { setBasemap(b.dataset.basemap); renderLayersPanel(); if (st.mode === 'history') drawHistory(); return; }
      if (b.dataset.period) {
        st.period = b.dataset.period;
        if (st.period === 'custom') { renderTeam(); $('#fmPeriodForm input')?.focus(); return; }
        loadDriverHistory(); return;
      }
      if (b.dataset.replayOrder) { loadOrderHistory(b.dataset.replayOrder); return; }
      if (b.dataset.seek) { seek(Number(b.dataset.seek)); return; }
      if (b.dataset.waiting) { focusWaiting(b.dataset.waiting); return; }
      if (b.dataset.request) { deps.openRequestDrawer?.(b.dataset.request, { onChange: () => loadSnapshot(false) }); return; }
      if (b.dataset.stop) {
        const x = stopsOf(selected() || {}).find((s) => String(s.id) === b.dataset.stop);
        if (x?.destination) fly([x.destination.latitude, x.destination.longitude], 16);
        return;
      }
      if (b.dataset.order) { e.preventDefault(); deps.openOrderDrawer?.(b.dataset.order, { onChange: () => loadSnapshot(false) }); return; }
      if (b.dataset.run) { deps.openRunDrawer?.(b.dataset.run, { onChange: () => loadSnapshot(false) }); return; }
      const a = b.dataset.act;
      if (a === 'collapse') { st.collapsed = !st.collapsed; store.set('traxo.fm.collapsed', st.collapsed); renderTeam(); return; }
      if (a === 'sheet') { st.sheet = st.sheet === 'peek' ? 'half' : st.sheet === 'half' ? 'full' : 'peek'; renderTeam(); return; }
      if (a === 'tab-drivers' || a === 'tab-waiting') {
        st.tab = a === 'tab-waiting' ? 'waiting' : 'drivers'; st.selectedId = ''; st.isolate = false; st.follow = false;
        layers.route.clearLayers(); st.liveRoute = null;
        if (a === 'tab-waiting' && !st.showWaiting) { st.showWaiting = true; store.set('traxo.fm.waiting', true); }
        if (narrow()) { if (st.sheet === 'peek') st.sheet = 'half'; } else st.collapsed = false;
        if (st.mode === 'history') setMode('current'); else { renderTeam(); drawCurrent(); }
        return;
      }
      if (a === 'back') {
        st.selectedId = ''; st.follow = false; st.isolate = false; layers.route.clearLayers(); st.liveRoute = null;
        if (st.mode === 'history') setMode('current'); else { renderTeam(); drawCurrent(); }
        history.replaceState(null, '', '/app/carte');
        return;
      }
      if (a === 'center') { const d = selected(); if (d?.position) fly([d.position.latitude, d.position.longitude], 16); return; }
      if (a === 'follow') { st.follow = !st.follow; const d = selected(); if (st.follow && d?.position) fly([d.position.latitude, d.position.longitude], 16); renderTeam(); return; }
      if (a === 'isolate') { st.isolate = !st.isolate; renderTeam(); drawCurrent(); fitAll(); return; }
      if (a === 'mode-current') { setMode('current'); return; }
      if (a === 'mode-history') { setMode('history'); return; }
      if (a === 'history-driver') { if (selected()) { st.target = null; loadDriverHistory(); } else setMode('current'); return; }
      if (a === 'layers') { st.layersOpen = !st.layersOpen; renderLayersPanel(); return; }
      if (a === 'fit') { fitAll(); return; }
      if (a === 'zoom-in') { map.zoomIn(); return; }
      if (a === 'zoom-out') { map.zoomOut(); return; }
      if (a === 'locate') { locateMe(); return; }
      if (a === 'fullscreen') { toggleFullscreen(); return; }
      if (a === 'refresh') { loadSnapshot(false); return; }
      if (a === 'play') { if (st.playing) { stopPlay(); renderPlayer(); } else play(); }
    });
    // Fenêtres de la carte (popups), rendues hors du module.
    $('#fmMap').addEventListener('click', (e) => {
      const b = e.target.closest('[data-order]');
      if (b) deps.openOrderDrawer?.(b.dataset.order, { onChange: () => loadSnapshot(false) });
    });
    root.addEventListener('input', (e) => {
      if (e.target.id === 'fmSearch') { st.query = e.target.value; $('#fmList').innerHTML = driverRows(matches()); drawCurrent(); }
      if (e.target.id === 'fmTimeline') { stopPlay(); st.playTime = Number(e.target.value) * 1000; updatePlayhead(); const p = $('[data-act="play"]'); if (p) p.innerHTML = ic('play'); }
    });
    const LAYER_KEYS = { showPhotos: 'photos', showNames: 'names', showStops: 'stops', showAllStops: 'allstops', showRuns: 'runs', showWaiting: 'waiting', autoRefresh: 'auto' };
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'fmSpeed') { st.speed = Number(t.value); return; }
      if (t.dataset.layer) {
        const k = t.dataset.layer;
        st[k] = t.checked;
        store.set(`traxo.fm.${LAYER_KEYS[k]}`, t.checked);
        if (k === 'autoRefresh') { schedule(); renderMapState(); return; }
        renderTeam();
        if (st.mode === 'history') drawHistory(); else drawCurrent();
      }
    });
    root.addEventListener('submit', (e) => {
      if (e.target.id !== 'fmPeriodForm') return;
      e.preventDefault();
      const f = new FormData(e.target);
      const err = $('#fmPeriodError');
      const date = String(f.get('date') || ''); const from = String(f.get('from') || ''); const to = String(f.get('to') || '');
      if (!date || !from || !to) { err.textContent = 'Choisissez une date et des heures.'; return; }
      const a = new Date(`${date}T${from}:00`).getTime(); const b = new Date(`${date}T${to}:00`).getTime();
      if (!(b > a)) { err.textContent = 'L’heure de fin doit suivre l’heure de début.'; return; }
      if (a > Date.now()) { err.textContent = 'Cette période n’a pas encore commencé.'; return; }
      st.custom = { from: a, to: Math.min(b, Date.now()) };
      loadDriverHistory();
    });
    document.addEventListener('keydown', function onKey(e) {
      if (!document.body.contains(root)) { document.removeEventListener('keydown', onKey); return; }
      if (e.key === 'Escape' && st.layersOpen) { st.layersOpen = false; renderLayersPanel(); return; }
      if (e.target.closest && e.target.closest('input, select, textarea, button, a')) return;
      if (e.key === ' ' && st.mode === 'history' && st.track?.points.length) { e.preventDefault(); if (st.playing) { stopPlay(); renderPlayer(); } else play(); }
    });
    document.addEventListener('fullscreenchange', function onFs() {
      if (!document.body.contains(root)) { document.removeEventListener('fullscreenchange', onFs); return; }
      const on = document.fullscreenElement === stage;
      const btn = $('.fm-fs-btn'); btn.innerHTML = ic(on ? 'minimize' : 'maximize'); btn.setAttribute('aria-label', on ? 'Quitter le plein écran' : 'Plein écran');
      setTimeout(() => map.invalidateSize(), 120);
    });
    map.on('zoomend', () => { if (st.mode === 'current') drawCurrent(); });
    map.on('dragstart', () => { if (st.follow) { st.follow = false; renderTeam(); } });
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe(stage);
    document.addEventListener('visibilitychange', function onVis() {
      if (!document.body.contains(root)) { document.removeEventListener('visibilitychange', onVis); return; }
      if (document.hidden) { stopPlay(); renderPlayer(); clearTimeout(timer); } else loadSnapshot(false);
    });

    $('#fmBases').innerHTML = basesHtml();
    renderTeam(); renderLayersPanel();
    await loadSnapshot(true);
    const orderParam = params.get('commande');
    if (/^\d{1,18}$/.test(orderParam || '')) loadOrderHistory(orderParam);
    else if (params.get('trajet') === '1' && selected()) setMode('history');
  }

  window.TraxoFleetMap = { render };
}());
