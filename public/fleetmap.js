// Carte d'exploitation TRAXO (kit « Carte », données réelles, Leaflet).
// Une colonne « Votre équipe » et la carte : suivi en direct, détail d'un
// livreur, sa tournée, et un mode Historique qui rejoue un trajet sur une
// période ou celui d'une commande, même terminée (statuts horodatés, arrêts,
// trous de signal). Rien n'est extrapolé : un signal ancien reste ancien.
(function () {
  'use strict';

  // Icônes Lucide (ISC) ; moto : Tabler Icons « motorbike » (MIT).
  const P = {
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    locate: '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
    maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
    minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    moto: '<path d="M5 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M19 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M7.5 14h5l4 -4h-10.5m1.5 4l4 -4"/><path d="M13 6h2l1.5 3l2 4"/>',
    truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
    bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
    pause2: '<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>',
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
  const km = (m) => (m == null ? '—' : `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: m < 10000 ? 1 : 0 })} km`);
  const duration = (ms) => {
    const min = Math.round(ms / 60000);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${pad2(min % 60)}`;
  };
  const dist = (a, b) => {
    const toRad = (v) => (v * Math.PI) / 180;
    const h = Math.sin(toRad(b[0] - a[0]) / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(toRad(b[1] - a[1]) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  // État affiché : le travail du livreur et la fraîcheur du signal sont deux
  // propriétés distinctes.
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
  const FILTERS = [
    ['all', 'Tous', () => true],
    ['moving', 'En livraison', (d) => d.activeOrders > 0],
    ['attention', 'À vérifier', (d) => signal(d).key === 'stale' || job(d).key === 'incident'],
    ['available', 'Disponibles', (d) => job(d).key === 'available' && signal(d).key !== 'none'],
    ['none', 'Sans position', (d) => signal(d).key === 'none'],
  ];

  async function render(page, deps) {
    const { api } = deps;
    if (typeof L === 'undefined') throw new Error('La carte n’a pas pu être chargée. Rechargez la page.');
    page.classList.add('page-fleetmap');
    const params = new URLSearchParams(location.search);
    const narrow = () => window.matchMedia('(max-width: 760px)').matches;
    const st = {
      snapshot: null, selectedId: params.get('livreur') || '', filter: 'all', query: '', mode: 'current',
      teamCollapsed: narrow() ? true : (store.get('traxo.fm.team') ?? window.matchMedia('(max-width: 1100px)').matches),
      basemap: store.get('traxo.fm.basemap') || 'plan', layersOpen: false,
      showPhotos: store.get('traxo.fm.photos') ?? true, showNames: store.get('traxo.fm.names') ?? true, showStops: store.get('traxo.fm.stops') ?? true,
      focused: false, error: null, refreshing: false,
      // Historique
      period: 'today', custom: null, target: null, track: null, loadingTrack: false, trackError: null,
      playTime: null, playing: false, speed: 60, driverOrders: null, liveRoute: null,
    };
    const root = document.createElement('div');
    root.className = 'fm';
    page.innerHTML = '';
    page.appendChild(root);
    root.innerHTML = `
      <div class="fm-head"><div><h1>Gardez votre équipe en vue.</h1><p>Un livreur, une livraison, un trajet. Retrouvez-les sur la carte.</p></div>
        <div class="fm-head-actions"><span class="fm-updated" id="fmUpdated" role="status"></span><button type="button" class="fm-btn" data-act="refresh">${ic('refresh')}Actualiser</button></div></div>
      <div class="fm-stage" id="fmStage">
        <section class="fm-panel" aria-label="Votre équipe">
          <div id="fmTeamToggle"></div><div class="fm-rail" id="fmRail"></div><div class="fm-panel-body" id="fmPanel"></div>
        </section>
        <section class="fm-deck" aria-label="Carte des livreurs">
          <div id="fmMap" class="fm-map"></div>
          <div class="fm-toolbar">
            <div class="fm-mode" role="group" aria-label="Mode de la carte">
              <button type="button" data-act="mode-current">${ic('radio')}Suivi</button>
              <button type="button" data-act="mode-history">${ic('history')}Historique</button>
            </div>
            <div id="fmMapState"></div>
          </div>
          <div class="fm-tools">
            <button type="button" class="fm-tool fm-basemap-btn" data-act="layers" aria-expanded="false">${ic('layers')}<span id="fmBasemapLabel">Plan</span></button>
            <button type="button" class="fm-tool" data-act="fit" aria-label="Recentrer la carte" title="Recentrer">${ic('locate')}</button>
            <button type="button" class="fm-tool fm-focus-btn" data-act="focus" aria-label="Agrandir la carte" title="Agrandir">${ic('maximize')}</button>
          </div>
          <div class="fm-zoom"><button type="button" data-act="zoom-in" aria-label="Zoom avant">${ic('plus')}</button><button type="button" data-act="zoom-out" aria-label="Zoom arrière">${ic('minus')}</button></div>
          <div id="fmLayers"></div>
          <div id="fmPlayer"></div>
          <div class="fm-legend" id="fmLegend"><span><i class="lg-moving"></i>En livraison</span><span><i class="lg-available"></i>Disponible</span><span><i class="lg-stale"></i>Signal ancien</span><span><i class="lg-incident"></i>Incident</span></div>
        </section>
      </div>`;
    const $ = (s) => root.querySelector(s);

    // ---------- Carte
    const map = L.map($('#fmMap'), { zoomControl: false, attributionControl: true, zoomSnap: 0.5 }).setView([6.37, 2.42], 13);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    const layers = {
      route: L.layerGroup().addTo(map), stops: L.layerGroup().addTo(map), drivers: L.layerGroup().addTo(map),
      history: L.layerGroup().addTo(map), playhead: L.layerGroup().addTo(map),
    };
    const bases = {};
    let activeBase = [];
    function buildBases(cfg) {
      if (bases.plan) return;
      const base = window.TraxoMapBase;
      bases.plan = base ? base.baseLayer(cfg.base) : L.tileLayer(cfg.base.url, { maxZoom: cfg.base.maxZoom, attribution: cfg.base.attribution });
      if (cfg.base.type === 'vector' && base) bases.night = base.baseLayer({ ...cfg.base, flavor: 'dark' });
      if (cfg.satellite) {
        bases.satellite = L.tileLayer(cfg.satellite.url, { maxZoom: 20, maxNativeZoom: cfg.satellite.maxNativeZoom || 18, attribution: cfg.satellite.attribution });
        bases.hybridSat = L.tileLayer(cfg.satellite.url, { maxZoom: 20, maxNativeZoom: cfg.satellite.maxNativeZoom || 18, attribution: cfg.satellite.attribution });
        if (cfg.roads) bases.roads = L.tileLayer(cfg.roads.url, { maxZoom: 20, maxNativeZoom: cfg.roads.maxNativeZoom || 18, attribution: cfg.roads.attribution, pane: 'overlayPane' });
        if (cfg.labels) bases.labels = L.tileLayer(cfg.labels.url, { maxZoom: cfg.labels.maxZoom || 20, attribution: cfg.labels.attribution, pane: 'overlayPane' });
      }
      if (!available(st.basemap)) st.basemap = 'plan';
      setBasemap(st.basemap);
    }
    const BASEMAPS = [['plan', 'Plan', 'Les rues en un coup d’œil'], ['satellite', 'Satellite', 'Le terrain en images'], ['hybrid', 'Hybride', 'Images et noms des lieux'], ['night', 'Plan sombre', 'Un fond moins lumineux']];
    const available = (k) => (k === 'plan' ? true : k === 'night' ? Boolean(bases.night) : Boolean(bases.satellite));
    function setBasemap(k) {
      if (!available(k)) return;
      activeBase.forEach((l) => map.removeLayer(l));
      activeBase = k === 'plan' ? [bases.plan] : k === 'night' ? [bases.night] : k === 'satellite' ? [bases.satellite] : [bases.hybridSat, bases.roads, bases.labels].filter(Boolean);
      activeBase.forEach((l) => l.addTo(map));
      st.basemap = k;
      store.set('traxo.fm.basemap', k);
      $('#fmBasemapLabel').textContent = BASEMAPS.find((b) => b[0] === k)[1];
      root.classList.toggle('fm-dark', k === 'night');
    }

    // ---------- Données
    const drivers = () => st.snapshot?.drivers || [];
    const selected = () => drivers().find((d) => String(d.id) === String(st.selectedId));
    const photoUrl = (d) => (d.hasPhoto ? `/api/app/drivers/${encodeURIComponent(d.id)}/photo?v=${encodeURIComponent(d.photoVersion || 0)}` : null);
    function avatar(d, size = '') {
      const url = st.showPhotos ? photoUrl(d) : null;
      return `<span class="fm-av ${size} tone-${job(d).tone} sig-${signal(d).key}">${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<b>${esc(initials(d.name))}</b><i class="fm-veh">${ic(vehicleIcon(d))}</i></span>`;
    }
    function matches() {
      const q = st.query.trim().toLowerCase();
      const f = FILTERS.find((x) => x[0] === st.filter)[2];
      return drivers().filter((d) => f(d) && (!q || [d.name, d.vehicleType, ...stopsOf(d).map((s) => s.neighborhood)].join(' ').toLowerCase().includes(q)));
    }
    function stopsOf(d) {
      const seen = new Set();
      const out = [];
      for (const run of d.runs || []) for (const s of run.stops || []) if (!seen.has(String(s.id))) { seen.add(String(s.id)); out.push({ ...s, run }); }
      for (const o of d.unplannedOrders || []) if (!seen.has(String(o.id))) { seen.add(String(o.id)); out.push({ ...o, run: null }); }
      return out;
    }
    const zoneOf = (d) => stopsOf(d)[0]?.neighborhood || (d.position ? 'Position reçue' : 'Aucune position');
    const progressOf = (d) => {
      const run = (d.runs || []).find((r) => r.status === 'active') || (d.runs || [])[0];
      return run ? { done: run.completedStops, total: run.totalStops, run } : { done: 0, total: d.activeOrders, run: null };
    };

    // ---------- Panneau
    function renderTeam() {
      const d = selected();
      $('#fmStage').classList.toggle('team-collapsed', st.teamCollapsed);
      const attention = drivers().filter(FILTERS[2][2]).length;
      $('#fmTeamToggle').innerHTML = `<button type="button" class="fm-team-toggle" data-act="toggle-team" aria-expanded="${!st.teamCollapsed}" aria-controls="fmPanel">
        <span class="fm-team-heading">${ic('users')}<span><strong>Votre équipe</strong><small>${d ? esc(d.name) : `${plural(drivers().length, 'livreur', 'livreurs')}${attention ? ` · ${plural(attention, 'point à vérifier', 'points à vérifier')}` : ''}`}</small></span></span>
        ${ic(narrow() ? (st.teamCollapsed ? 'chevron-down' : 'x') : (st.teamCollapsed ? 'chevron-right' : 'chevron-left'))}</button>`;
      $('#fmRail').innerHTML = drivers().map((x) => `<button type="button" data-driver="${esc(x.id)}" aria-label="Afficher ${esc(x.name)}" title="${esc(x.name)}" class="${String(x.id) === String(st.selectedId) ? 'sel' : ''}">${avatar(x, 'sm')}</button>`).join('');
      $('#fmPanel').hidden = st.teamCollapsed;
      if (!st.teamCollapsed) {
        $('#fmPanel').innerHTML = st.mode === 'history' && st.target?.kind === 'order'
          ? `<div class="fm-detail"><div class="fm-badges"><span class="fm-badge red">Historique</span></div>${orderHistoryHtml()}</div>`
          : d ? detailHtml(d) : fleetHtml();
      }
      root.querySelectorAll('[data-act="mode-current"], [data-act="mode-history"]').forEach((b) => {
        const on = (b.dataset.act === 'mode-history') === (st.mode === 'history');
        b.setAttribute('aria-pressed', String(on));
      });
      renderMapState();
    }
    function fleetHtml() {
      const ds = matches();
      const count = (key) => drivers().filter(FILTERS.find((x) => x[0] === key)[2]).length;
      return `<div class="fm-panel-top"><div class="fm-summary"><span><b>${count('moving')}</b> en livraison</span><span><b>${count('available')}</b> disponible${count('available') > 1 ? 's' : ''}</span></div>
          <label class="fm-search">${ic('search')}<input id="fmSearch" type="search" aria-label="Rechercher un livreur" placeholder="Nom ou quartier…" value="${esc(st.query)}" autocomplete="off"></label>
          <div class="fm-filters" role="group" aria-label="Filtrer les livreurs">${FILTERS.map(([k, label]) => `<button type="button" data-filter="${k}" aria-pressed="${st.filter === k}">${label} <b>${count(k)}</b></button>`).join('')}</div></div>
        <div class="fm-list" id="fmList">${fleetRows(ds)}</div>
        <div class="fm-panel-foot">Chaque signal indique l’heure de sa dernière réception.</div>`;
    }
    function fleetRows(ds) {
      if (!drivers().length) return '<p class="fm-empty">Aucun livreur pour le moment. Ajoutez-en depuis la page <a href="/app/livreurs">Livreurs</a>.</p>';
      if (!ds.length) return '<p class="fm-empty">Aucun livreur ne correspond à cette recherche.</p>';
      return ds.map((d) => {
        const j = job(d); const s = signal(d); const p = progressOf(d);
        return `<button type="button" class="fm-item" data-driver="${esc(d.id)}"><span class="fm-id">${avatar(d)}<span><strong>${esc(d.name)}</strong><small>${esc(zoneOf(d))}${p.total ? ` · ${p.done}/${p.total} livrée${p.done > 1 ? 's' : ''}` : ''}</small></span>${ic('chevron-right')}</span>
          <span class="fm-meta"><span class="fm-badge ${j.tone}">${j.label}</span>${s.key === 'stale' ? '<span class="fm-badge amber">Signal ancien</span>' : ''}<span class="fm-age">${d.position ? `il y a ${ago(d.position.timestamp)}` : 'Aucun signal'}</span></span></button>`;
      }).join('');
    }
    function detailHtml(d) {
      const j = job(d); const s = signal(d);
      const cap = Number(d.capacity) ? ` · ${plural(d.capacity, 'colis maximum', 'colis maximum')}` : '';
      return `<div class="fm-detail"><button type="button" class="fm-back" data-act="back">${ic('arrow-left')}Tous les livreurs</button>
        <div class="fm-id fm-id-lg">${avatar(d, 'lg')}<div><strong>${esc(d.name)}</strong><small>${esc(d.vehicleType || 'Véhicule')}${cap}</small></div></div>
        <div class="fm-badges">${st.mode === 'history' ? '<span class="fm-badge red">Historique</span>' : `<span class="fm-badge ${j.tone}">${j.label}</span>${s.key !== 'live' ? `<span class="fm-badge ${s.tone}">${s.label}</span>` : ''}`}</div>
        ${st.mode === 'history' ? historyHtml(d) : currentHtml(d)}</div>`;
    }
    function currentHtml(d) {
      const s = signal(d);
      const speed = d.position && !d.position.stale && d.position.speedKnots != null ? `${Math.round(d.position.speedKnots * 1.852)} km/h` : null;
      const phone = String(d.phone || '').replace(/[^+\d]/g, '');
      const p = progressOf(d);
      const stops = stopsOf(d);
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
          <button type="button" class="fm-btn" data-act="center" ${d.position ? '' : 'disabled'}>${ic('locate')}Centrer</button>
          ${phone ? `<a class="fm-btn" href="tel:${esc(phone)}">${ic('phone')}Appeler</a>` : ''}
          <button type="button" class="fm-btn primary" data-act="mode-history">${ic('route')}Voir le trajet</button>
        </div>
        ${route}
        ${stops.length ? `<div class="fm-route-head"><h3>${p.run ? esc(p.run.name || 'La tournée du jour') : 'Ses livraisons'}</h3>${p.total ? `<span>${p.done}/${p.total} livrée${p.done > 1 ? 's' : ''}</span>` : ''}</div>
          ${p.total ? `<div class="fm-progress" role="progressbar" aria-label="Tournée livrée" aria-valuenow="${p.done}" aria-valuemin="0" aria-valuemax="${p.total}"><span style="width:${Math.round((p.done / p.total) * 100)}%"></span></div>` : ''}
          ${stops.map((x, i) => `<div class="fm-stop"><span class="fm-stop-n">${x.sequence ?? i + 1}</span><div><strong>${esc(x.customerName || `Commande ${x.id}`)}</strong><p>${esc(x.neighborhood || x.landmark || x.deliveryAddress || 'Adresse à préciser')} · ${esc(x.status)}</p>
            <div class="fm-stop-acts">${x.destination ? `<button type="button" data-stop="${esc(x.id)}">Voir sur la carte</button>` : '<span class="fm-dim">Sans position GPS</span>'}<button type="button" data-order="${esc(x.id)}">Ouvrir</button></div></div></div>`).join('')}
          ${p.run ? `<button type="button" class="fm-btn fm-route-link" data-run="${esc(p.run.id)}">Ouvrir la tournée ${ic('arrow-up-right')}</button>` : ''}`
        : '<p class="fm-quiet">Aucune livraison en cours pour ce livreur.</p>'}`;
    }
    function liveRouteHtml() {
      const r = st.liveRoute;
      if (r.unavailable) return '<div class="fm-note">Itinéraire routier indisponible pour le moment.</div>';
      return `<div class="fm-liveroute ${r.planned ? 'planned' : ''}"><i></i><div><strong>${r.planned ? 'Itinéraire prévu' : 'Itinéraire restant'} · ${km(r.distanceMeters)}</strong><small>${r.durationSeconds != null ? `~${Math.round(r.durationSeconds / 60)} min de route, hors arrêts` : 'Durée indisponible'}</small></div></div>`;
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
    function historyHtml(d) {
      if (st.target?.kind === 'order') return orderHistoryHtml();
      const tr = st.track;
      const c = st.custom || {};
      const dateVal = new Date(c.from || midnight(0));
      const ymd = `${dateVal.getFullYear()}-${pad2(dateVal.getMonth() + 1)}-${pad2(dateVal.getDate())}`;
      return `<p class="fm-intro">Retrouvez le parcours sur une période précise.</p>
        <div class="fm-periods" role="group" aria-label="Période">${PERIODS.map(([k, v]) => `<button type="button" data-period="${k}" aria-pressed="${st.period === k}">${v}</button>`).join('')}</div>
        ${st.period === 'custom' ? `<form id="fmPeriodForm" class="fm-period-form" novalidate><label>Date<input type="date" name="date" value="${ymd}" max="${new Date().toISOString().slice(0, 10)}" required></label>
          <div class="fm-time-fields"><label>De<input type="time" name="from" value="${c.from ? clock(c.from) : '08:00'}" required></label><label>À<input type="time" name="to" value="${c.to ? clock(c.to) : '18:00'}" required></label></div>
          <button type="submit" class="fm-btn primary">Afficher le trajet</button><p id="fmPeriodError" class="fm-error" role="alert"></p></form>` : ''}
        ${trackSummaryHtml(tr)}
        ${driverOrdersHtml()}
        <button type="button" class="fm-back" data-act="mode-current">${ic('arrow-left')}Revenir au suivi</button>`;
    }
    function trackSummaryHtml(tr) {
      if (st.loadingTrack) return '<p class="fm-quiet">Chargement du trajet…</p>';
      if (st.trackError) return `<div class="fm-note red">${esc(st.trackError)}</div>`;
      if (!tr) return '';
      if (tr.message) return `<div class="fm-empty-history">${ic('route')}<strong>${esc(tr.message)}</strong></div>`;
      if (!tr.points.length) {
        return `<div class="fm-empty-history">${ic('route')}<strong>Aucun trajet sur cette période.</strong><p>Aucune position n’a été reçue entre ${clock(tr.from)} et ${clock(tr.to)}${new Date(tr.from).toDateString() !== new Date().toDateString() ? ` le ${esc(dayLabel(tr.from))}` : ''}.</p></div>`;
      }
      const first = tr.points[0].t; const last = tr.points[tr.points.length - 1].t;
      const stopMin = tr.stops.reduce((a, s) => a + s.minutes, 0);
      return `<div class="fm-stats"><div><strong>${km(tr.distance)}</strong><small>parcourus</small></div><div><strong>${duration(last - first)}</strong><small>entre le premier et le dernier point</small></div>
          <div><strong>${clock(first)}</strong><small>premier point</small></div><div><strong>${clock(last)}</strong><small>dernier point</small></div>
          <div><strong>${tr.stops.length}</strong><small>arrêt${tr.stops.length > 1 ? 's' : ''}${stopMin ? ` · ${duration(stopMin * 60000)}` : ''}</small></div>
          <div><strong>${tr.gaps.length}</strong><small>coupure${tr.gaps.length > 1 ? 's' : ''} de signal</small></div></div>
        <p class="fm-note-small">${esc(dayLabel(first))}. ${tr.matched ? 'Le tracé est calé sur les routes.' : 'Le tracé relie les positions reçues.'} ${tr.gaps.length ? 'Les coupures de signal sont en pointillés : rien n’est inventé entre deux points.' : ''}</p>`;
    }
    function driverOrdersHtml() {
      const list = st.driverOrders;
      if (!list || !list.length) return '';
      return `<div class="fm-route-head"><h3>Ses commandes sur la période</h3><span>${list.length}</span></div>
        ${list.map((o) => `<div class="fm-stop"><span class="fm-stop-n">${ic('package')}</span><div><strong>${esc(o.reference)} · ${esc(o.customerName || '')}</strong><p>${esc(o.neighborhood || '—')} · ${esc(o.status)} · ${clock(o.firstAt)}–${clock(o.lastAt)}</p>
          <div class="fm-stop-acts"><button type="button" data-replay-order="${esc(o.id)}">Rejouer ce trajet</button><button type="button" data-order="${esc(o.id)}">Ouvrir</button></div></div></div>`).join('')}`;
    }
    function orderHistoryHtml() {
      const t = st.track;
      const o = st.target.order;
      const head = `<p class="fm-intro">Le trajet de la commande, du départ du livreur jusqu’à la remise.</p>`;
      if (st.loadingTrack || !o) return `${head}<p class="fm-quiet">Chargement du trajet…</p>`;
      const stamps = (st.target.milestones || []).map((m) => `<button type="button" class="fm-milestone ${['Livrée'].includes(m.status) ? 'ok' : ['Annulée', 'Retournée', 'Échec', 'Retour'].includes(m.status) ? 'bad' : ''}" data-seek="${new Date(m.at).getTime()}"><b>${clock(m.at)}</b><span>${esc(m.status)}</span></button>`).join('');
      const delivered = st.target.deliveredGap;
      return `${head}<div class="fm-order-card"><strong>${esc(o.reference)}</strong><span>${esc(o.customerName || '')}${o.neighborhood ? ` · ${esc(o.neighborhood)}` : ''}</span>
          <small>${(t?.drivers || []).length > 1 ? `Livreurs : ${esc(t.drivers.join(' puis '))}` : `Livreur : ${esc(t?.drivers?.[0] || o.driverName || '—')}`}</small></div>
        <div class="fm-milestones">${stamps || '<p class="fm-quiet">Aucun statut enregistré.</p>'}</div>
        ${st.target.status === 'not_started' ? '<div class="fm-empty-history">' + ic('route') + '<strong>Le livreur n’est pas encore parti.</strong><p>Le trajet commence au départ vers la collecte ou la livraison.</p></div>'
          : st.target.status === 'too_long' ? '<div class="fm-note">Cette commande s’étend sur plus de 24 heures : choisissez une période depuis la fiche du livreur.</div>' : trackSummaryHtml(t)}
        ${delivered != null ? `<div class="fm-note ${delivered > 150 ? 'amber' : ''}">${delivered > 150 ? `Livrée à ${Math.round(delivered)} m de l’adresse indiquée : vérifiez la preuve de livraison.` : `Livrée à ${Math.round(delivered)} m de l’adresse indiquée.`}</div>` : ''}
        <div class="fm-actions"><button type="button" class="fm-btn" data-order="${esc(o.id)}">Ouvrir la commande</button></div>
        <button type="button" class="fm-back" data-act="history-driver">${ic('arrow-left')}${selected() ? 'Trajet du livreur' : 'Revenir au suivi'}</button>`;
    }

    // Construit une trace jouable : points horodatés, tracé calé sur les
    // routes horodaté par rapprochement avec les points bruts, arrêts, trous.
    function buildTrack(segments, from, to) {
      const points = []; const road = []; const stops = []; const gaps = []; const names = [];
      let distance = 0; let matched = false; let message = null;
      for (const seg of segments) {
        if (seg.status === 'not_configured') message = 'Le service GPS n’est pas configuré.';
        else if (seg.status === 'no_device') message = message || 'Aucun appareil GPS n’est associé à ce livreur.';
        if (seg.driverName && !names.includes(seg.driverName)) names.push(seg.driverName);
        const pts = (seg.positions || []).map((p) => ({ ll: [p.latitude, p.longitude], t: new Date(p.timestamp).getTime(), speed: p.speedKnots }));
        if (!pts.length) continue;
        points.push(...pts);
        distance += seg.distanceMeters || 0;
        (seg.stops || []).forEach((s) => stops.push({ ...s, fromT: new Date(s.from).getTime(), toT: new Date(s.to).getTime() }));
        (seg.gaps || []).forEach((g) => gaps.push({ ...g, fromT: new Date(g.from).getTime(), toT: new Date(g.to).getTime() }));
        if (Array.isArray(seg.roadGeometry) && seg.roadGeometry.length > 1) {
          matched = true;
          let j = 0;
          for (const ll of seg.roadGeometry) {
            while (j + 1 < pts.length && dist(ll, pts[j + 1].ll) <= dist(ll, pts[j].ll)) j += 1;
            road.push({ ll, t: pts[j].t });
          }
        } else pts.forEach((p) => road.push(p));
      }
      points.sort((a, b) => a.t - b.t);
      // Le tracé calé reste monotone dans le temps.
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
      renderTeam(); drawHistory();
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
      st.mode = 'history';
      st.teamCollapsed = false;
      st.target = { kind: 'order', orderId: String(orderId) };
      st.loadingTrack = true; st.trackError = null; st.track = null;
      renderTeam(); drawCurrent(); drawHistory();
      try {
        const data = await api(`/api/app/orders/${encodeURIComponent(orderId)}/track`);
        if (st.target?.orderId !== String(orderId)) return;
        st.target = { ...st.target, order: data.order, milestones: data.milestones, status: data.status };
        const from = data.from ? new Date(data.from).getTime() : Date.now();
        const to = data.to ? new Date(data.to).getTime() : Date.now();
        st.track = data.status === 'ok' ? buildTrack(data.segments, from, to) : null;
        // Écart entre l'endroit de la remise et l'adresse prévue.
        const deliveredAt = (data.milestones || []).find((m) => m.status === 'Livrée');
        if (deliveredAt && data.order.destination && st.track?.points.length) {
          const p = positionAt(new Date(deliveredAt.at).getTime());
          if (p) st.target.deliveredGap = dist(p.ll, [data.order.destination.latitude, data.order.destination.longitude]);
        }
      } catch (error) { st.trackError = error.message; st.target.order = st.target.order || null; }
      st.loadingTrack = false;
      st.playTime = st.track?.points.length ? st.track.points[0].t : null;
      renderTeam(); drawHistory(true); renderPlayer();
    }

    // Position à l'instant t, interpolée sur le tracé (jamais au-delà des points).
    function positionAt(t) {
      const tr = st.track;
      if (!tr || !tr.points.length) return null;
      const line = tr.road.length > 1 ? tr.road : tr.points;
      if (t <= line[0].t) return { ll: line[0].ll, t };
      if (t >= line[line.length - 1].t) return { ll: line[line.length - 1].ll, t };
      let lo = 0; let hi = line.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (line[mid].t <= t) lo = mid; else hi = mid; }
      const a = line[lo]; const b = line[hi];
      const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return { ll: [a.ll[0] + (b.ll[0] - a.ll[0]) * f, a.ll[1] + (b.ll[1] - a.ll[1]) * f], t, index: lo };
    }
    let traveledLine = null; let playMarker = null; let playLabel = null;
    function drawHistory(fit = false) {
      layers.history.clearLayers(); layers.playhead.clearLayers();
      traveledLine = null; playMarker = null;
      const tr = st.track;
      if (st.mode !== 'history') return;
      const o = st.target?.order;
      if (o?.destination) {
        L.marker([o.destination.latitude, o.destination.longitude], { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-flag">${ic('flag')}</span>`, iconSize: [30, 30], iconAnchor: [15, 28] }) })
          .addTo(layers.history).bindTooltip(`Adresse de livraison${o.neighborhood ? ` · ${esc(o.neighborhood)}` : ''}`);
      }
      if (o?.pickup) {
        L.marker([o.pickup.latitude, o.pickup.longitude], { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-flag pickup">${ic('package')}</span>`, iconSize: [30, 30], iconAnchor: [15, 28] }) })
          .addTo(layers.history).bindTooltip(`Collecte${o.pickupName ? ` · ${esc(o.pickupName)}` : ''}`);
      }
      if (!tr || !tr.points.length) {
        if (fit && o?.destination) map.setView([o.destination.latitude, o.destination.longitude], 15);
        return;
      }
      const line = tr.road.length > 1 ? tr.road : tr.points;
      // Trous de signal : la ligne est coupée et remplacée par des pointillés.
      const pieces = []; let cur = [];
      for (let k = 0; k < line.length; k += 1) {
        if (k && tr.gaps.some((g) => line[k - 1].t <= g.fromT + 1000 && line[k].t >= g.toT - 1000)) {
          L.polyline([line[k - 1].ll, line[k].ll], { color: '#8a94a3', weight: 3, dashArray: '4 8', opacity: 0.9 }).addTo(layers.history)
            .bindTooltip(`Signal coupé ${clock(line[k - 1].t)}–${clock(line[k].t)}`);
          if (cur.length > 1) pieces.push(cur);
          cur = [];
        }
        cur.push(line[k].ll);
      }
      if (cur.length > 1) pieces.push(cur);
      pieces.forEach((pc) => L.polyline(pc, { color: '#e9a7b0', weight: 5, opacity: 0.85 }).addTo(layers.history));
      traveledLine = L.polyline([], { color: '#e11d2a', weight: 5, opacity: 0.95 }).addTo(layers.history);
      L.circleMarker(line[0].ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#2f6b4f', fillOpacity: 1 }).addTo(layers.history).bindTooltip(`Départ · ${clock(line[0].t)}`);
      L.circleMarker(line[line.length - 1].ll, { radius: 6, color: '#fff', weight: 2, fillColor: '#27303a', fillOpacity: 1 }).addTo(layers.history).bindTooltip(`Dernier point · ${clock(line[line.length - 1].t)}`);
      tr.stops.forEach((s) => {
        L.marker([s.latitude, s.longitude], { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-stopdot">${s.minutes}′</span>`, iconSize: [30, 20], iconAnchor: [15, 10] }) })
          .addTo(layers.history).bindTooltip(`Arrêt de ${s.minutes} min · ${clock(s.fromT)}–${clock(s.toT)}`).on('click', () => seek(s.fromT));
      });
      (st.target?.milestones || []).forEach((m) => {
        const t = new Date(m.at).getTime();
        if (t < tr.points[0].t - 60000 || t > tr.points[tr.points.length - 1].t + 60000) return;
        const p = positionAt(t);
        if (!p) return;
        const tone = m.status === 'Livrée' ? 'ok' : ['Annulée', 'Retournée', 'Échec', 'Retour'].includes(m.status) ? 'bad' : '';
        L.marker(p.ll, { icon: L.divIcon({ className: 'fm-divicon', html: `<span class="fm-mile ${tone}"></span>`, iconSize: [14, 14], iconAnchor: [7, 7] }), title: `${m.status} · ${clock(t)}` })
          .addTo(layers.history).bindTooltip(`${esc(m.status)} · ${clock(t)}`, { direction: 'top', offset: [0, -6] }).on('click', () => seek(t));
      });
      const target = st.target?.kind === 'driver' ? selected() : drivers().find((x) => x.name === tr.drivers[0]);
      const icon = L.divIcon({ className: 'fm-divicon', html: `<span class="fm-pin history">${target ? avatar(target) : `<span class="fm-av">${ic('moto')}</span>`}</span>`, iconSize: [46, 46], iconAnchor: [23, 23] });
      playMarker = L.marker(line[0].ll, { icon, zIndexOffset: 1000 }).addTo(layers.playhead);
      playLabel = L.tooltip({ permanent: true, direction: 'bottom', offset: [0, 22], className: 'fm-play-label' });
      playMarker.bindTooltip(playLabel).openTooltip();
      if (fit) {
        const bounds = L.latLngBounds(line.map((p) => p.ll));
        if (o?.destination) bounds.extend([o.destination.latitude, o.destination.longitude]);
        map.flyToBounds(bounds, { padding: [70, 70], maxZoom: 16, duration: reduced() ? 0 : 0.42 });
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
      const line = tr.road.length > 1 ? tr.road : tr.points;
      const done = line.filter((x) => x.t <= t).map((x) => x.ll);
      done.push(p.ll);
      traveledLine?.setLatLngs(done);
      const inStop = tr.stops.find((s) => t >= s.fromT && t <= s.toT);
      const inGap = tr.gaps.find((g) => t > g.fromT && t < g.toT);
      playLabel?.setContent(`${clockSec(t)}${inStop ? ' · à l’arrêt' : inGap ? ' · signal coupé' : ''}`);
      const range = $('#fmTimeline'); if (range && Number(range.value) !== Math.round(t / 1000)) range.value = Math.round(t / 1000);
      const now = $('#fmPlayNow'); if (now) now.textContent = clock(t);
    }

    // ---------- Lecture
    let raf = null; let lastFrame = 0;
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function renderPlayer() {
      const tr = st.track;
      if (st.mode !== 'history' || !tr || !tr.points.length) { $('#fmPlayer').innerHTML = ''; return; }
      const first = tr.points[0].t; const last = tr.points[tr.points.length - 1].t;
      const who = st.target?.kind === 'order' ? `la commande ${st.target.order?.reference || ''}` : (selected()?.name.split(' ')[0] || '');
      $('#fmPlayer').innerHTML = `<div class="fm-player"><div class="fm-player-title"><strong>Le trajet de ${esc(who)}</strong><span>${esc(dayLabel(first))}</span></div>
        <div class="fm-player-controls"><button type="button" class="fm-play" data-act="play" aria-label="${st.playing ? 'Mettre en pause' : 'Lire le trajet'}">${ic(st.playing ? 'pause' : 'play')}</button>
          <div class="fm-scrub"><label class="fm-sr" for="fmTimeline">Heure sur le trajet</label><input type="range" id="fmTimeline" min="${Math.round(first / 1000)}" max="${Math.round(last / 1000)}" step="1" value="${Math.round((st.playTime ?? first) / 1000)}">
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
      // Une coupure de signal est franchie d'un coup : on ne rejoue pas le vide.
      const gap = tr.gaps.find((g) => t > g.fromT && t < g.toT && g.minutes >= 2);
      if (gap) t = gap.toT;
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
    function stopPlay() {
      st.playing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    }
    function seek(t) {
      stopPlay();
      const pts = st.track?.points || [];
      st.playTime = pts.length ? Math.min(Math.max(t, pts[0].t), pts[pts.length - 1].t) : t;
      renderPlayer(); updatePlayhead();
    }

    // ---------- Suivi en direct
    const markers = new Map();
    function drawCurrent() {
      layers.drivers.clearLayers(); layers.stops.clearLayers(); markers.clear();
      if (st.mode === 'history') { layers.route.clearLayers(); return; }
      const sel = selected();
      const shown = matches().filter((d) => d.position);
      const z = map.getZoom();
      // Regroupement simple des repères proches en vue d'ensemble.
      const groups = [];
      for (const d of shown) {
        const pt = map.latLngToLayerPoint([d.position.latitude, d.position.longitude]);
        const g = z < 15 && String(d.id) !== String(st.selectedId) ? groups.find((x) => !x.locked && x.pt.distanceTo(pt) < 46) : null;
        if (g) g.items.push(d); else groups.push({ pt, items: [d], locked: String(d.id) === String(st.selectedId) });
      }
      for (const g of groups) {
        if (g.items.length > 1) {
          const ll = L.latLngBounds(g.items.map((d) => [d.position.latitude, d.position.longitude]));
          const tones = ['green', 'blue', 'amber', 'red'].map((tn) => [tn, g.items.filter((d) => (signal(d).key === 'stale' ? 'amber' : job(d).tone) === tn).length]).filter(([, n]) => n);
          const icon = L.divIcon({ className: 'fm-divicon', html: `<button type="button" class="fm-cluster" aria-label="${g.items.length} livreurs proches, rapprocher la carte"><b>${g.items.length}</b><span class="fm-cluster-tones">${tones.map(([tn, n]) => `<i class="${tn}" style="flex:${n}"></i>`).join('')}</span></button>`, iconSize: [44, 44], iconAnchor: [22, 22] });
          L.marker(ll.getCenter(), { icon, keyboard: false }).addTo(layers.drivers).on('click', () => map.flyToBounds(ll.pad(0.6), { maxZoom: 16, duration: reduced() ? 0 : 0.42 }));
          continue;
        }
        const d = g.items[0];
        const isSel = String(d.id) === String(st.selectedId);
        const j = job(d); const s = signal(d);
        const label = st.showNames && (isSel || z >= 14) ? `<span class="fm-pin-name"><strong>${esc(d.name.split(' ')[0])}</strong><small class="${s.key === 'stale' ? 'amber' : j.tone}">${s.key === 'stale' ? `Signal ancien · ${ago(d.position.timestamp)}` : j.label}</small></span>` : '';
        const icon = L.divIcon({ className: 'fm-divicon', html: `<span class="fm-pin ${isSel ? 'sel' : ''} ${s.key === 'stale' ? 'stale' : ''}">${avatar(d)}${label}</span>`, iconSize: [46, 46], iconAnchor: [23, 23] });
        const m = L.marker([d.position.latitude, d.position.longitude], { icon, title: d.name, zIndexOffset: isSel ? 900 : 0, riseOnHover: true }).addTo(layers.drivers);
        m.on('click', () => selectDriver(d.id, { pan: false }));
        markers.set(String(d.id), m);
      }
      if (sel && st.showStops) {
        stopsOf(sel).forEach((x, i) => {
          if (!x.destination) return;
          const n = x.sequence ?? i + 1;
          const icon = L.divIcon({ className: 'fm-divicon', html: `<span class="fm-dest">${esc(n)}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
          L.marker([x.destination.latitude, x.destination.longitude], { icon, title: x.customerName || `Commande ${x.id}` }).addTo(layers.stops)
            .bindPopup(`<div class="fm-popup"><strong>${esc(x.customerName || `Commande ${x.id}`)}</strong><span>${esc(x.neighborhood || x.landmark || x.deliveryAddress || '')}</span><small>${esc(x.status)}</small><button type="button" data-order="${esc(x.id)}">Ouvrir la commande</button></div>`);
        });
      }
    }
    async function refreshLiveRoute() {
      layers.route.clearLayers();
      st.liveRoute = null;
      const d = selected();
      if (!d || st.mode !== 'current') return;
      const run = (d.runs || []).find((r) => r.status === 'active') || (d.runs || []).find((r) => r.status === 'planned') || (d.runs || []).find((r) => r.status === 'draft');
      if (!run) return;
      try {
        const data = await api(`/api/app/runs/${encodeURIComponent(run.id)}/route`);
        if (String(selected()?.id) !== String(d.id) || st.mode !== 'current') return;
        const route = data.route;
        if (route?.status === 'ok' && route.geometry?.value?.coordinates?.length >= 2) {
          const coords = route.geometry.value.coordinates.map(([lng, lat]) => [lat, lng]);
          L.polyline(coords, { color: run.status === 'active' ? '#e11d2a' : '#3459a8', weight: 4, opacity: 0.8 }).addTo(layers.route);
          st.liveRoute = { driverId: d.id, planned: run.status !== 'active', distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds };
        } else st.liveRoute = { driverId: d.id, unavailable: true };
      } catch { st.liveRoute = { driverId: d.id, unavailable: true }; }
      if (!st.teamCollapsed && selected() && st.mode === 'current') $('#fmPanel').innerHTML = detailHtml(selected());
    }
    function renderMapState() {
      const d = selected();
      let text;
      if (st.mode === 'history') {
        const tr = st.track;
        text = st.target?.kind === 'order' ? `Historique · ${st.target.order?.reference || 'commande'}` : `Historique · ${d?.name || ''}${tr ? ` · ${dayLabel(tr.from)}` : ''}`;
      } else if (d) text = d.position ? `Dernier signal de ${d.name.split(' ')[0]} · il y a ${ago(d.position.timestamp)}` : `${d.name} · aucune position`;
      else {
        const located = matches().filter((x) => x.position).length;
        const none = matches().length - located;
        text = `${plural(located, 'position', 'positions')}${none ? ` · ${none} sans signal` : ''}`;
      }
      const service = st.snapshot?.locationService;
      const warn = st.error ? `<div class="fm-map-status red">${ic('alert')}<span>${esc(st.error)}</span></div>`
        : service && service.status !== 'online' ? `<div class="fm-map-status amber">${ic('alert')}<span>${esc(service.message)}</span></div>` : '';
      $('#fmMapState').innerHTML = `<div class="fm-map-status ${st.mode === 'history' ? 'history' : ''}">${ic(st.mode === 'history' ? 'history' : 'radio')}<span>${esc(text)}</span></div>${warn}`;
    }
    function renderLayersPanel() {
      $('[data-act="layers"]').setAttribute('aria-expanded', String(st.layersOpen));
      $('#fmLayers').innerHTML = st.layersOpen ? `<div class="fm-layers" role="dialog" aria-label="Fond et repères"><div class="fm-layers-head"><h3>Votre carte, votre vue</h3><button type="button" data-act="layers" aria-label="Fermer">${ic('x')}</button></div>
        <div class="fm-basemaps">${BASEMAPS.map(([k, label, desc]) => `<button type="button" data-basemap="${k}" aria-pressed="${st.basemap === k}" ${available(k) ? '' : 'disabled'} title="${esc(available(k) ? desc : 'Indisponible sur ce serveur')}"><span class="fm-thumb thumb-${k}"><span class="fm-thumb-check">${ic('check')}</span></span><strong>${label}</strong></button>`).join('')}</div>
        <h4>Repères</h4>
        <label><input type="checkbox" data-layer="showPhotos" ${st.showPhotos ? 'checked' : ''}>Photos des livreurs</label>
        <label><input type="checkbox" data-layer="showNames" ${st.showNames ? 'checked' : ''}>Noms des livreurs</label>
        <label><input type="checkbox" data-layer="showStops" ${st.showStops ? 'checked' : ''}>Destinations du livreur sélectionné</label>
        <p>Le choix du fond ne change pas les positions.</p></div>` : '';
    }

    function selectDriver(id, { pan = true } = {}) {
      st.selectedId = String(id);
      if (narrow()) st.teamCollapsed = false;
      const d = selected();
      if (st.mode === 'history') { loadDriverHistory(); return; }
      renderTeam(); drawCurrent(); refreshLiveRoute();
      if (pan && d?.position) map.flyTo([d.position.latitude, d.position.longitude], Math.max(map.getZoom(), 15), { duration: reduced() ? 0 : 0.42 });
      history.replaceState(null, '', `/app/carte?livreur=${encodeURIComponent(id)}`);
    }
    function setMode(mode) {
      stopPlay();
      st.mode = mode;
      if (mode === 'history') {
        if (!selected()) { const first = matches().find((d) => d.position) || drivers()[0]; if (first) st.selectedId = String(first.id); }
        if (!selected()) { st.mode = 'current'; renderTeam(); return; }
        st.teamCollapsed = false;
        drawCurrent(); loadDriverHistory();
        return;
      }
      st.target = null; st.track = null; st.driverOrders = null;
      layers.history.clearLayers(); layers.playhead.clearLayers();
      renderPlayer(); renderTeam(); drawCurrent(); refreshLiveRoute();
    }
    function fitAll() {
      if (st.mode === 'history' && st.track?.points.length) { drawHistory(true); return; }
      const pts = matches().filter((d) => d.position).map((d) => [d.position.latitude, d.position.longitude]);
      if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15, duration: reduced() ? 0 : 0.42 });
    }

    let timer = null;
    async function loadSnapshot(first = false) {
      if (st.refreshing) return;
      st.refreshing = true;
      $('#fmUpdated').textContent = 'Actualisation…';
      try {
        st.snapshot = await api('/api/app/operations-map');
        st.error = null;
        buildBases(st.snapshot.mapConfig);
        if (st.selectedId && !selected()) st.selectedId = '';
        $('#fmUpdated').textContent = `Actualisé à ${clock(st.snapshot.generatedAt)}`;
        if (st.mode === 'current') { renderTeam(); drawCurrent(); } else renderMapState();
        if (first) {
          if (selected()?.position) map.setView([selected().position.latitude, selected().position.longitude], 15); else fitAll();
          if (selected()) refreshLiveRoute();
        }
      } catch (error) {
        st.error = `Actualisation impossible : ${error.message}`;
        $('#fmUpdated').textContent = '';
        renderMapState();
      }
      st.refreshing = false;
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => loadSnapshot(false), Math.max(10, Number(st.snapshot?.refreshAfterSeconds || 15)) * 1000);
    }

    // ---------- Interactions
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button, a[data-order]');
      if (!b || b.disabled) return;
      if (b.dataset.driver) { selectDriver(b.dataset.driver); return; }
      if (b.dataset.filter) { st.filter = b.dataset.filter; renderTeam(); drawCurrent(); return; }
      if (b.dataset.basemap) { setBasemap(b.dataset.basemap); renderLayersPanel(); return; }
      if (b.dataset.period) {
        st.period = b.dataset.period;
        if (st.period === 'custom') { renderTeam(); $('#fmPeriodForm input')?.focus(); return; }
        loadDriverHistory(); return;
      }
      if (b.dataset.replayOrder) { loadOrderHistory(b.dataset.replayOrder); return; }
      if (b.dataset.seek) { seek(Number(b.dataset.seek)); return; }
      if (b.dataset.stop) {
        const x = stopsOf(selected() || {}).find((s) => String(s.id) === b.dataset.stop);
        if (x?.destination) map.flyTo([x.destination.latitude, x.destination.longitude], 16, { duration: reduced() ? 0 : 0.42 });
        return;
      }
      if (b.dataset.order) { e.preventDefault(); deps.openOrderDrawer?.(b.dataset.order, { onChange: () => loadSnapshot(false) }); return; }
      if (b.dataset.run) { deps.openRunDrawer?.(b.dataset.run, { onChange: () => loadSnapshot(false) }); return; }
      const a = b.dataset.act;
      if (a === 'toggle-team') { st.teamCollapsed = !st.teamCollapsed; if (!narrow()) store.set('traxo.fm.team', st.teamCollapsed); renderTeam(); setTimeout(() => map.invalidateSize(), 220); return; }
      if (a === 'back') {
        st.selectedId = ''; layers.route.clearLayers(); st.liveRoute = null;
        if (st.mode === 'history') setMode('current'); else { renderTeam(); drawCurrent(); }
        history.replaceState(null, '', '/app/carte');
        return;
      }
      if (a === 'center') { const d = selected(); if (d?.position) map.flyTo([d.position.latitude, d.position.longitude], 16, { duration: reduced() ? 0 : 0.42 }); return; }
      if (a === 'mode-current') { setMode('current'); return; }
      if (a === 'mode-history') { setMode('history'); return; }
      if (a === 'history-driver') { if (selected()) { st.target = null; loadDriverHistory(); } else setMode('current'); return; }
      if (a === 'layers') { st.layersOpen = !st.layersOpen; renderLayersPanel(); return; }
      if (a === 'fit') { fitAll(); return; }
      if (a === 'zoom-in') { map.zoomIn(); return; }
      if (a === 'zoom-out') { map.zoomOut(); return; }
      if (a === 'refresh') { loadSnapshot(false); return; }
      if (a === 'play') { if (st.playing) { stopPlay(); renderPlayer(); } else play(); return; }
      if (a === 'focus') {
        st.focused = !st.focused;
        document.body.classList.toggle('fm-focused', st.focused);
        b.innerHTML = ic(st.focused ? 'minimize' : 'maximize');
        b.setAttribute('aria-label', st.focused ? 'Quitter la carte agrandie' : 'Agrandir la carte');
        setTimeout(() => map.invalidateSize(), 120);
      }
    });
    // Les fenêtres de la carte (popups) sont hors du module : délégation dédiée.
    $('#fmMap').addEventListener('click', (e) => {
      const b = e.target.closest('[data-order]');
      if (b) deps.openOrderDrawer?.(b.dataset.order, { onChange: () => loadSnapshot(false) });
    });
    root.addEventListener('input', (e) => {
      if (e.target.id === 'fmSearch') { st.query = e.target.value; $('#fmList').innerHTML = fleetRows(matches()); drawCurrent(); }
      if (e.target.id === 'fmTimeline') { stopPlay(); st.playTime = Number(e.target.value) * 1000; updatePlayhead(); const p = $('[data-act="play"]'); if (p) p.innerHTML = ic('play'); }
    });
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'fmSpeed') { st.speed = Number(t.value); return; }
      if (t.dataset.layer) { st[t.dataset.layer] = t.checked; store.set(`traxo.fm.${t.dataset.layer.replace('show', '').toLowerCase()}`, t.checked); renderTeam(); if (st.mode === 'history') drawHistory(); else drawCurrent(); }
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
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (st.layersOpen) { st.layersOpen = false; renderLayersPanel(); }
        else if (st.focused) $('[data-act="focus"]').click();
      }
    });
    map.on('zoomend', () => { if (st.mode === 'current') drawCurrent(); });
    document.addEventListener('visibilitychange', function onVis() {
      if (!document.body.contains(root)) { document.removeEventListener('visibilitychange', onVis); return; }
      if (document.hidden) { stopPlay(); renderPlayer(); clearTimeout(timer); } else loadSnapshot(false);
    });

    renderTeam(); renderLayersPanel();
    await loadSnapshot(true);
    const orderParam = params.get('commande');
    if (/^\d{1,18}$/.test(orderParam || '')) loadOrderHistory(orderParam);
    else if (params.get('trajet') === '1' && selected()) setMode('history');
  }

  window.TraxoFleetMap = { render };
}());
