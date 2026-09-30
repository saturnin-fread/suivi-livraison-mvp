// Tableau de bord TRAXO (kit « Dashboard Motion », données réelles).
// Rendu en SVG et requestAnimationFrame, sans bibliothèque. Les données viennent
// de /api/app/dashboard ; changer d'onglet ne recharge rien, changer de période
// ou de livreur recharge.
(function () {
  'use strict';

  const P = {
    package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    check: '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    line: '<path d="M12 16v5"/><path d="M16 14v7"/><path d="M20 10v11"/><path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15"/><path d="M4 18v3"/><path d="M8 14v7"/>',
    bars: '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
    arrowUpRight: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  };
  const ic = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, dec = 0) => (n == null || !Number.isFinite(Number(n)) ? '—' : new Intl.NumberFormat('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n));
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease = (t) => 1 - (1 - t) ** 3;
  const rate = (a, b) => (b ? (a / b) * 100 : null);
  const shortDate = (d) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  const longDate = (d) => new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  const rangeLabel = (from, to) => {
    const a = new Date(`${from}T12:00:00Z`);
    const b = new Date(`${to}T12:00:00Z`);
    const f = (d, o) => new Intl.DateTimeFormat('fr-FR', { ...o, timeZone: 'UTC' }).format(d);
    if (from === to) return f(a, { day: 'numeric', month: 'short', year: 'numeric' });
    if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${f(a, { day: 'numeric', month: 'short', year: 'numeric' })} – ${f(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    return `${f(a, { day: 'numeric', month: 'short' })} – ${f(b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  };
  const timeOf = (iso, tz) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));

  const TABS = [
    ['general', 'Général', 'general'], ['orders', 'Commandes', 'commandes'], ['deliveries', 'Livraisons', 'livraisons'],
    ['drivers', 'Livreurs', 'livreurs'], ['requests', 'Demandes', 'demandes'], ['routes', 'Tournées', 'tournees'], ['incidents', 'Incidents', 'incidents'],
  ];
  const TITLES = {
    general: ['Votre activité, en un regard.', 'Commandes, équipe, livraisons : l’essentiel de votre activité.'],
    orders: ['Commandes', 'Suivez les volumes et gardez le fil de chaque commande.'],
    deliveries: ['Livraisons', 'Mesurez ce qui arrive à destination, et ce qui reste à livrer.'],
    drivers: ['Livreurs', 'Voyez comment votre équipe avance sur le terrain.'],
    requests: ['Demandes', 'Transformez les demandes reçues en commandes prêtes à partir.'],
    routes: ['Tournées', 'Suivez vos départs et la progression de vos tournées.'],
    incidents: ['Incidents', 'Repérez les blocages et retrouvez les livraisons concernées.'],
  };
  const KPI_ICON = {
    ordersCreated: 'package', deliveryRate: 'gauge', activeDrivers: 'bike', openIncidents: 'alert', cohortDelivered: 'check', cohortOpen: 'clock',
    cohortCanceled: 'alert', assigned: 'bike', delivered: 'check', avgMinutes: 'clock', noIncident: 'gauge', perDriver: 'bike', requests: 'inbox',
    converted: 'check', waiting: 'clock', conversion: 'gauge', runs: 'route', runsFinished: 'check', runsProgress: 'route', stopsPerRun: 'route',
    incidents: 'alert', incidentsOpen: 'alert', incidentsClosed: 'check', incidentOrdersRate: 'gauge',
  };
  const SEGMENTS = {
    drivers: ['#5b8b79', '#80a3d2', '#dca76d', '#b49bc6', '#d7717f', '#98a5bc'],
    incidents: ['#dba263', '#98a5bc', '#d7717f', '#5b8b79', '#b49bc6', '#80a3d2', '#c9b18a'],
    default: ['#598c79', '#8da9d4', '#e5b477', '#da7c85'],
  };
  const segmentColors = (tab) => SEGMENTS[tab] || SEGMENTS.default;
  const PAGE = 6;
  const RUN_LABELS = { draft: 'En préparation', planned: 'Planifiée', active: 'En cours', completed: 'Terminée', cancelled: 'Annulée' };
  const GROUP_TONE = { delivered: 'delivered', converted: 'delivered', finished: 'delivered', progress: 'progress', waiting: 'waiting', pending: 'waiting', planned: 'waiting', canceled: '', rejected: '' };

  function render(page, env) {
    const params = new URLSearchParams(location.search);
    const tabFromUrl = TABS.find((t) => t[2] === params.get('onglet') || t[0] === params.get('onglet'));
    const state = {
      tab: tabFromUrl ? tabFromUrl[0] : 'general',
      period: params.get('periode') === '30' ? 30 : 7,
      from: params.get('du'), to: params.get('au'),
      driver: params.get('livreur') || 'all',
      compare: true, chart: 'line', day: null, page: 0, detail: null,
    };
    if (!(state.from && state.to)) { state.from = null; state.to = null; }
    let data = null;
    let loadSeq = 0;
    const anim = { metrics: {}, chart: null, fan: null, rafs: {} };
    let chartObserver = null;

    page.classList.add('page-td');
    page.innerHTML = `<div class="td" id="td">
      <div class="td-titlebar">
        <div><div class="td-eyebrow"><i></i><span id="tdEyebrow">Données de votre espace</span></div><h1 id="tdTitle"></h1><p id="tdSubtitle"></p></div>
        <div class="td-toolbar">
          <div class="td-datewrap"><button type="button" class="td-btn" data-action="date" aria-expanded="false" aria-controls="tdDatePanel">${ic('calendar')}<span id="tdRange">…</span></button>
            <form class="td-datepanel" id="tdDatePanel" hidden novalidate>
              <label>Du<input type="date" id="tdFrom" required></label><label>Au<input type="date" id="tdTo" required></label>
              <small id="tdDateHint"></small><p id="tdDateError" role="alert"></p>
              <button type="submit" class="td-btn td-btn-red">Appliquer</button>
            </form></div>
          <div class="td-period" role="group" aria-label="Période"><button type="button" data-period="7">7 jours</button><button type="button" data-period="30">30 jours</button></div>
          <button type="button" class="td-btn td-btn-red" data-action="export">${ic('download')}<span>Exporter</span></button>
        </div>
      </div>
      <div class="td-navigation">
        <div class="td-tabs" role="tablist" aria-label="Rubriques">${TABS.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="false">${label}</button>`).join('')}</div>
        <label class="td-driver-filter">${ic('users')}<select id="tdDriver" aria-label="Filtrer par livreur"><option value="all">Tous les livreurs</option></select></label>
      </div>
      <div class="td-notice" id="tdNotice" hidden></div>
      <div id="tdContent">${skeleton()}</div>
      <div class="td-foot"><span>TRAXO · Tableau de bord</span><span id="tdFootNote"></span></div>
    </div>`;
    const root = page.querySelector('#td');
    const $ = (s) => root.querySelector(s);

    function skeleton() {
      return `<div class="td-metrics">${'<div class="td-skeleton" style="height:150px"></div>'.repeat(4)}</div>
        <div class="td-main-grid"><div class="td-skeleton" style="height:380px"></div><div class="td-skeleton" style="height:380px"></div></div>`;
    }

    function queryString() {
      const q = new URLSearchParams();
      if (state.from && state.to) { q.set('from', state.from); q.set('to', state.to); } else q.set('period', String(state.period));
      if (state.driver !== 'all') q.set('driver', state.driver);
      return q.toString();
    }
    function syncUrl() {
      const q = new URLSearchParams();
      const tab = TABS.find((t) => t[0] === state.tab);
      if (state.tab !== 'general') q.set('onglet', tab[2]);
      if (state.from && state.to) { q.set('du', state.from); q.set('au', state.to); } else if (state.period !== 7) q.set('periode', String(state.period));
      if (state.driver !== 'all') q.set('livreur', state.driver);
      const s = q.toString();
      try { history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}`); } catch { /* ignore */ }
    }

    async function load({ animate = true } = {}) {
      const seq = (loadSeq += 1);
      root.classList.add('td-refreshing');
      try {
        const next = await env.api(`/api/app/dashboard?${queryString()}`);
        if (seq !== loadSeq) return;
        data = next;
        state.day = null; state.page = 0; state.detail = null;
        fillDrivers();
        draw(animate);
        syncUrl();
      } catch (error) {
        if (seq !== loadSeq) return;
        if (!data) $('#tdContent').innerHTML = `<div class="td-panel td-empty">${ic('alert')}${esc(error.message)}</div>`;
        else env.uiToast(error.message, 'error');
        throw error;
      } finally {
        if (seq === loadSeq) root.classList.remove('td-refreshing');
      }
    }

    function fillDrivers() {
      const select = $('#tdDriver');
      const current = String(state.driver);
      select.innerHTML = `<option value="all">Tous les livreurs</option>${data.drivers.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}`;
      select.value = data.drivers.some((d) => String(d.id) === current) ? current : 'all';
    }

    // ---- Rendu d'un onglet ------------------------------------------------
    function draw(animate) {
      if (!data) return;
      const tab = data.tabs[state.tab];
      const [title, subtitle] = TITLES[state.tab];
      $('#tdTitle').textContent = title;
      $('#tdSubtitle').textContent = subtitle;
      env.setHeader('Tableau de bord', 'Votre activité, période par période');
      $('#tdRange').textContent = rangeLabel(data.range.from, data.range.to);
      $('#tdEyebrow').textContent = `Données de votre espace · ${data.range.days} jour${data.range.days > 1 ? 's' : ''}`;
      $('#tdFootNote').textContent = `Comparé au ${rangeLabel(data.comparison.from, data.comparison.to)} · Fuseau ${data.range.timezone}`;
      root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
      root.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(!state.from && Number(b.dataset.period) === state.period)));
      const notice = $('#tdNotice');
      const notes = [];
      if (state.driver !== 'all' && state.tab === 'requests') notes.push('Avec un livreur choisi, seules les demandes devenues des commandes de ce livreur sont comptées.');
      if (data.truncated) notes.push('Période très chargée : le tableau et l’export sont limités aux 3 000 lignes les plus récentes. Les indicateurs restent complets.');
      notice.hidden = !notes.length;
      notice.innerHTML = notes.length ? `${ic('info')}<span>${esc(notes.join(' '))}</span>` : '';

      const content = $('#tdContent');
      content.classList.toggle('td-anim', Boolean(animate) && !reduced());
      const dist = tab.distribution;
      content.innerHTML = `<section class="td-metrics" aria-label="Indicateurs de la période">${tab.kpis.map(metricHtml).join('')}</section>
        <div class="td-main-grid">
          <section class="td-panel td-chart-panel">
            <div class="td-chart-header"><div><h2>${esc(tab.series.title)}</h2><p>Par jour · ${data.range.days} jour${data.range.days > 1 ? 's' : ''} sélectionné${data.range.days > 1 ? 's' : ''}</p></div>
              <div class="td-chart-controls" role="group" aria-label="Présentation du graphique"><button type="button" data-chart="line" aria-label="Courbe" aria-pressed="${state.chart === 'line'}">${ic('line')}</button><button type="button" data-chart="bar" aria-label="Barres" aria-pressed="${state.chart === 'bar'}">${ic('bars')}</button></div></div>
            <div class="td-chart-summary"><strong>${fmt(tab.series.total)}</strong>${seriesChip(tab.series)}</div>
            <div class="td-chart-wrap"><svg class="td-chart-svg" id="tdChart" role="img" aria-label="${esc(tab.series.title)} par jour, ${esc(rangeLabel(data.range.from, data.range.to))}"></svg><div class="td-plot-tooltip" id="tdTip" hidden></div></div>
            <div class="td-chart-footer"><div class="td-chart-legend"><span class="td-legend-item">Cette période</span>${state.compare ? '<span class="td-legend-item td-legend-previous">Précédente</span>' : ''}</div>
              <label class="td-compare"><input type="checkbox" id="tdCompare" ${state.compare ? 'checked' : ''}> Comparer</label></div>
          </section>
          <section class="td-panel td-distribution">
            <div class="td-distribution-head"><h2>${esc(dist.title)}</h2><span>${fmt(dist.total)} au total</span></div>
            <div class="td-fan-wrap td-shape-${dist.shape}"><svg class="td-fan" id="tdFan" viewBox="0 0 290 ${fanHeight(dist)}" role="img" aria-label="${esc(dist.title)} : ${esc(dist.items.map((x) => `${x.label} ${x.value}`).join(', ') || 'aucune donnée')}"></svg>
              <div class="td-fan-value"><strong>${fmt(dist.total)}</strong><small>${esc(dist.unit)}</small></div></div>
            <div class="td-dist-rows">${dist.items.map((x, i) => `<div class="td-dist-row" style="--segment:${segmentColors(state.tab)[i % segmentColors(state.tab).length]}"><span>${esc(x.label)}</span><strong>${fmt(x.value)}<small>${fmt(rate(x.value, dist.total) || 0, 0)} %</small></strong></div>`).join('')}</div>
            ${dist.note ? `<p class="td-dist-note">${esc(dist.note)}</p>` : ''}
            ${attentionHtml()}
          </section>
        </div>
        <div class="td-bottom-grid"><div><div id="tdTable">${tableHtml(animate)}</div><div id="tdDetail"></div></div>
          <div class="td-right-rail">${leadersHtml()}${heatmapHtml()}</div></div>`;
      animateMetrics(tab.kpis, animate);
      drawChart(tab.series, animate);
      drawFan(dist, animate);
      chartObserver?.disconnect();
      const wrap = $('.td-chart-wrap');
      let width = wrap.getBoundingClientRect().width;
      chartObserver = new ResizeObserver((entries) => {
        const w = entries[0].contentRect.width;
        if (Math.abs(w - width) > 0.5) { width = w; drawChart(tab.series, false); }
      });
      chartObserver.observe(wrap);
    }

    function deltaParts(k) {
      if (k.stock) return { cls: 'td-neutral', text: '<span class="td-stock">État actuel</span>', label: 'à ce jour' };
      if (k.value == null || k.previous == null) return { cls: 'td-neutral', text: '—', label: 'Pas de comparaison' };
      let change;
      let text;
      if (k.unit === '%') { change = k.value - k.previous; text = `${change > 0 ? '+' : ''}${fmt(change, 1)} pt`; }
      else if (k.previous === 0) {
        if (k.value === 0) return { cls: 'td-neutral', text: '=', label: 'comme la période précédente' };
        return { cls: k.invert ? 'td-negative' : 'td-positive', text: 'Nouveau', label: 'rien sur la période précédente' };
      } else { change = ((k.value - k.previous) / k.previous) * 100; text = `${change > 0 ? '+' : ''}${fmt(change, 1)} %`; }
      const cls = Math.abs(change) < 0.05 ? 'td-neutral' : (change > 0) !== k.invert ? 'td-positive' : 'td-negative';
      return { cls, text, label: 'vs période précédente' };
    }
    function spark(values) {
      if (!values || values.length < 2) return '';
      const v = values.map((x) => (x == null ? 0 : x));
      const max = Math.max(1, ...v);
      const d = v.map((x, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * 76 + 1).toFixed(1)},${(29 - (x / max) * 25).toFixed(1)}`).join(' ');
      return `<svg class="td-spark" viewBox="0 0 78 32" aria-hidden="true"><path d="${d}" pathLength="1" fill="none" stroke="currentColor"/></svg>`;
    }
    function metricHtml(k, i) {
      const d = deltaParts(k);
      const dec = k.decimals ?? 0;
      return `<article class="td-metric" ${k.hint ? `title="${esc(k.hint)}"` : ''}>
        <div class="td-metric-label"><span class="td-kpi-icon">${ic(KPI_ICON[k.key] || 'package')}</span>${esc(k.label)}</div>
        <div class="td-value-row"><strong class="td-value"><span data-kpi="${i}">${fmt(k.value, k.value == null ? 0 : dec)}</span>${k.unit && k.value != null ? `<small>${esc(k.unit)}</small>` : ''}</strong>${spark(k.spark)}</div>
        <div class="td-metric-delta"><b class="${d.cls}">${d.text}</b><span>${esc(d.label)}</span></div></article>`;
    }
    function seriesChip(s) {
      if (!s.previousTotal) return `<span class="td-chip">${s.total ? 'Rien sur la période précédente' : 'Aucune activité sur la période'}</span>`;
      const change = ((s.total - s.previousTotal) / s.previousTotal) * 100;
      const invert = state.tab === 'incidents';
      const bad = Math.abs(change) >= 0.05 && ((change > 0) === invert);
      return `<span class="td-chip ${bad ? 'td-negative' : ''}">${change > 0 ? '+' : ''}${fmt(change, 1)} % vs période précédente</span>`;
    }

    // Interpolation des chiffres (600 ms), depuis la valeur précédemment affichée.
    function animateMetrics(kpis, animate) {
      cancelAnimationFrame(anim.rafs.metrics);
      const key = state.tab;
      const from = anim.metrics[key] || kpis.map(() => 0);
      anim.metrics[key] = kpis.map((k) => k.value);
      if (!animate || reduced()) return;
      const els = [...root.querySelectorAll('[data-kpi]')];
      const start = performance.now();
      const step = (now) => {
        const t = Math.max(0, Math.min(1, (now - start) / 600));
        const e = ease(t);
        els.forEach((el, i) => {
          const k = kpis[i];
          if (!k || k.value == null) return;
          const a = from[i] == null ? 0 : from[i];
          el.textContent = fmt(a + (k.value - a) * e, k.decimals ?? 0);
        });
        if (t < 1) anim.rafs.metrics = requestAnimationFrame(step);
      };
      anim.rafs.metrics = requestAnimationFrame(step);
    }

    // ---- Courbe / barres --------------------------------------------------
    const resample = (arr, n) => {
      if (!arr.length) return Array(n).fill(0);
      if (arr.length === n) return arr.slice();
      return Array.from({ length: n }, (_, i) => {
        const x = (i / Math.max(1, n - 1)) * (arr.length - 1);
        const j = Math.floor(x);
        const t = x - j;
        return arr[j] * (1 - t) + (arr[Math.min(j + 1, arr.length - 1)] ?? 0) * t;
      });
    };
    function niceCeil(max) {
      if (max <= 4) return 4;
      const step = 10 ** Math.floor(Math.log10(max / 4));
      const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => s * 4 >= max) || step * 10;
      return nice * 4;
    }
    function drawChart(series, animate) {
      cancelAnimationFrame(anim.rafs.chart);
      const svg = $('#tdChart');
      if (!svg) return;
      const box = svg.getBoundingClientRect();
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (!width) return;
      const cur = series.current;
      const prev = resample(series.previous, cur.length);
      const n = cur.length;
      const left = 36;
      const right = 10;
      const top = 12;
      const bottom = 30;
      const pw = width - left - right;
      const ph = height - top - bottom;
      if (pw < 40 || ph < 40) return;
      const ceiling = niceCeil(Math.max(0, ...cur, ...(state.compare ? prev : [])));
      const x = (i) => left + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
      const y = (v) => top + ph - (v / ceiling) * ph;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const maxTicks = width < 380 ? 3 : width < 620 ? 4 : 7;
      const tickCount = Math.min(maxTicks, n);
      const ticks = [...new Set(Array.from({ length: tickCount }, (_, i) => Math.round((i / Math.max(1, tickCount - 1)) * (n - 1))))];
      const dates = data.range.dates;
      svg.innerHTML = `<defs><linearGradient id="tdGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7fae9c" stop-opacity=".22"/><stop offset="100%" stop-color="#7fae9c" stop-opacity="0"/></linearGradient>
          <clipPath id="tdClip"><rect x="${left - 2}" y="${top - 6}" width="${pw + 4}" height="${ph + 8}"/></clipPath></defs>
        ${[0, 1, 2, 3, 4].map((i) => { const yy = top + ph - (i / 4) * ph; return `<line x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}" stroke="#dce3e4" stroke-dasharray="2 5"/><text x="${left - 9}" y="${yy + 4}" text-anchor="end">${fmt((i / 4) * ceiling)}</text>`; }).join('')}
        ${ticks.map((i, j) => `<text x="${x(i)}" y="${height - 8}" text-anchor="${n === 1 ? 'middle' : j === 0 ? 'start' : j === ticks.length - 1 ? 'end' : 'middle'}">${esc(shortDate(dates[i]))}</text>`).join('')}
        <g clip-path="url(#tdClip)"><path id="tdArea" fill="url(#tdGrad)"/><path id="tdPrev" fill="none" stroke="#dca567" stroke-width="1.6" stroke-dasharray="4 5"/><g id="tdBars"></g><path id="tdLine" fill="none" stroke="#407a68" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/></g>
        <g id="tdHover" visibility="hidden"><line id="tdHoverLine" y1="${top}" y2="${top + ph}" stroke="#737d8e" stroke-dasharray="3 3"/><circle id="tdHoverPrev" r="3.5" fill="#fff" stroke="#dca567" stroke-width="2"/><circle id="tdHoverDot" r="4.5" fill="#407a68" stroke="#fff" stroke-width="2"/></g>
        <rect id="tdHit" x="${left}" y="${top}" width="${pw}" height="${ph}" fill="transparent" style="cursor:pointer"/>`;

      const old = anim.chart;
      const typeChanged = old && old.chart !== state.chart;
      const origin = !old || typeChanged ? cur.map(() => 0) : resample(old.cur, n);
      const originPrev = !old ? prev.map(() => 0) : resample(old.prev, n);
      anim.chart = { cur: cur.slice(), prev: prev.slice(), chart: state.chart };
      const linePath = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(Math.max(0, v)).toFixed(2)}`).join(' ');
      const barW = Math.max(3, Math.min(26, (pw / n) * 0.55));
      const frame = (t) => {
        if (!svg.isConnected) return;
        const mix = (a, b) => a.map((v, i) => v + (b[i] - v) * t);
        const c = mix(origin, cur);
        const p = mix(originPrev, prev);
        const lineEl = svg.querySelector('#tdLine');
        if (state.chart === 'line') {
          const d = linePath(c);
          lineEl.setAttribute('d', n > 1 ? d : `M${left},${y(c[0])} L${width - right},${y(c[0])}`);
          svg.querySelector('#tdArea').setAttribute('d', n > 1 ? `${d} L ${x(n - 1)},${top + ph} L ${left},${top + ph} Z` : '');
          svg.querySelector('#tdBars').innerHTML = '';
        } else {
          lineEl.setAttribute('d', '');
          svg.querySelector('#tdArea').setAttribute('d', '');
          svg.querySelector('#tdBars').innerHTML = c.map((v, i) => {
            const h = Math.max(0, (v / ceiling) * ph);
            const bx = Math.max(left, Math.min(width - right - barW, x(i) - barW / 2));
            return `<rect x="${bx.toFixed(1)}" y="${(top + ph - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(5, barW / 2)}" fill="#77a48f"/>`;
          }).join('');
        }
        svg.querySelector('#tdPrev').setAttribute('d', state.compare && n > 1 ? linePath(p) : '');
      };
      const should = animate && !reduced();
      const start = performance.now();
      const step = (now) => {
        const t = should ? Math.max(0, Math.min(1, (now - start) / 650)) : 1;
        frame(ease(t));
        if (t < 1) anim.rafs.chart = requestAnimationFrame(step);
      };
      step(start);

      const tip = $('#tdTip');
      const hover = svg.querySelector('#tdHover');
      const inspect = (event) => {
        const r = svg.getBoundingClientRect();
        const point = (event.clientX - r.left - left) / pw;
        const i = Math.max(0, Math.min(n - 1, Math.round(point * (n - 1))));
        const xp = x(i);
        hover.setAttribute('visibility', 'visible');
        svg.querySelector('#tdHoverLine').setAttribute('x1', xp);
        svg.querySelector('#tdHoverLine').setAttribute('x2', xp);
        svg.querySelector('#tdHoverDot').setAttribute('cx', xp);
        svg.querySelector('#tdHoverDot').setAttribute('cy', y(cur[i]));
        const hp = svg.querySelector('#tdHoverPrev');
        hp.setAttribute('visibility', state.compare ? 'visible' : 'hidden');
        hp.setAttribute('cx', xp);
        hp.setAttribute('cy', y(prev[i] || 0));
        const prevDate = data.comparison.from ? addDaysLocal(data.comparison.from, Math.round((i / Math.max(1, n - 1)) * (series.previous.length - 1))) : null;
        tip.innerHTML = `<strong>${esc(longDate(dates[i]))}</strong><span>Cette période <b>${fmt(cur[i])}</b></span>${state.compare ? `<span>${esc(prevDate ? shortDate(prevDate) : 'Précédente')} <b>${fmt(series.previous[Math.round((i / Math.max(1, n - 1)) * (series.previous.length - 1))] ?? 0)}</b></span>` : ''}${tableFor(state.tab).date === false ? '' : '<small>Cliquez pour filtrer le tableau sur ce jour</small>'}`;
        tip.hidden = false;
        const tw = tip.offsetWidth || 170;
        tip.style.left = `${Math.max(0, Math.min(width - tw, xp + 12 > width - tw ? xp - tw - 12 : xp + 12))}px`;
        tip.style.top = '6px';
        return i;
      };
      const hit = svg.querySelector('#tdHit');
      hit.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') inspect(e); });
      hit.addEventListener('pointerleave', () => { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); });
      hit.addEventListener('click', (e) => {
        const i = inspect(e);
        if (tableFor(state.tab).date === false) return;
        state.day = dates[i];
        state.page = 0;
        state.detail = null;
        $('#tdTable').innerHTML = tableHtml(true);
        $('#tdDetail').innerHTML = '';
      });
    }
    const addDaysLocal = (dateStr, n) => {
      const [yy, mm, dd] = dateStr.split('-').map(Number);
      return new Date(Date.UTC(yy, mm - 1, dd + n)).toISOString().slice(0, 10);
    };

    // ---- Répartition : éventail, anneau ou barres (720 ms) -----------------
    const fanHeight = (dist) => (dist.shape === 'bars' ? Math.max(156, 16 + dist.items.length * 38) : 156);
    function drawFan(dist, animate) {
      cancelAnimationFrame(anim.rafs.fan);
      const svg = $('#tdFan');
      if (!svg) return;
      const total = dist.total;
      const dest = dist.items.map((x) => (dist.shape === 'bars' ? (Math.max(...dist.items.map((i) => i.value), 0) ? x.value / Math.max(...dist.items.map((i) => i.value)) : 0) : total ? x.value / total : 0));
      const prevFan = anim.fan && anim.fan.shape === dist.shape && anim.fan.dest.length === dest.length ? anim.fan.dest : dest.map(() => 0);
      anim.fan = { shape: dist.shape, dest };
      const colors = segmentColors(state.tab);
      const pos = (angle, r) => [145 + Math.cos(angle) * r, 143 - Math.sin(angle) * r];
      const wedge = (a0, a1) => {
        const a = pos(Math.PI - a0, 123); const b = pos(Math.PI - a1, 123); const c = pos(Math.PI - a1, 78); const d = pos(Math.PI - a0, 78);
        return `M${a} A123,123 0 0 1 ${b} L${c} A78,78 0 0 0 ${d} Z`;
      };
      const pct = (v) => fmt(rate(v, total) || 0, 1);
      const frame = (e) => {
        if (!svg.isConnected) return;
        let markup = '';
        if (dist.shape === 'bars') {
          markup = dist.items.length ? dist.items.map((item, i) => {
            const yy = 10 + i * 38;
            const v = prevFan[i] + (dest[i] - prevFan[i]) * e;
            return `<text x="18" y="${yy + 10}" font-size="12" fill="#5f6b74">${esc(item.label.length > 34 ? `${item.label.slice(0, 33)}…` : item.label)}</text><text x="272" y="${yy + 10}" font-size="12" fill="#36454b" text-anchor="end" font-weight="600">${fmt(item.value)}</text>
              <rect x="18" y="${yy + 18}" width="254" height="8" rx="4" fill="#f2f4f5"/><rect x="18" y="${yy + 18}" width="${(254 * v).toFixed(1)}" height="8" rx="4" fill="${colors[i % colors.length]}"><title>${esc(item.label)} : ${fmt(item.value)}</title></rect>`;
          }).join('') : '<text x="145" y="80" text-anchor="middle" font-size="13" fill="#8a939b">Aucune donnée sur la période</text>';
        } else if (!total) {
          markup = dist.shape === 'ring' ? '<circle cx="145" cy="78" r="60" fill="none" stroke="#eef1f2" stroke-width="19"/>' : `<path d="${wedge(0, Math.PI)}" fill="#eef1f2"/>`;
        } else if (dist.shape === 'ring') {
          let offset = 0;
          const circ = 2 * Math.PI * 60;
          markup = dest.map((target, i) => {
            const v = prevFan[i] + (target - prevFan[i]) * e;
            const seg = Math.max(0, v * circ - (v > 0 ? 3 : 0));
            const out = `<circle cx="145" cy="78" r="60" fill="none" stroke="${colors[i % colors.length]}" stroke-width="19" stroke-dasharray="${seg.toFixed(2)} ${(circ - seg).toFixed(2)}" stroke-dashoffset="${(-offset * circ).toFixed(2)}" transform="rotate(-90 145 78)"><title>${esc(dist.items[i].label)} : ${fmt(dist.items[i].value)} (${pct(dist.items[i].value)} %)</title></circle>`;
            offset += v;
            return out;
          }).join('');
        } else {
          let offset = 0;
          dest.forEach((target, i) => {
            const amount = prevFan[i] + (target - prevFan[i]) * e;
            const span = amount * Math.PI;
            const count = Math.max(1, Math.ceil(amount * 36));
            for (let k = 0; k < count; k += 1) {
              const gap = Math.min(0.012, (span / count) * 0.17);
              const a0 = offset + (k * span) / count + gap;
              const a1 = offset + ((k + 1) * span) / count - gap;
              if (a1 > a0) markup += `<path d="${wedge(a0, a1)}" fill="${colors[i % colors.length]}"><title>${esc(dist.items[i].label)} : ${fmt(dist.items[i].value)} (${pct(dist.items[i].value)} %)</title></path>`;
            }
            offset += span;
          });
        }
        svg.innerHTML = markup;
      };
      const should = animate && !reduced();
      const start = performance.now();
      const step = (now) => {
        const t = should ? Math.max(0, Math.min(1, (now - start) / 720)) : 1;
        frame(ease(t));
        if (t < 1) anim.rafs.fan = requestAnimationFrame(step);
      };
      step(start);
    }

    function attentionHtml() {
      const isRequests = state.tab === 'requests';
      const n = isRequests ? data.attention.requests : data.attention.incidents;
      if (!n) {
        return `<div class="td-attention td-calm">${ic('check')}<div><strong>${isRequests ? 'Aucune demande à valider' : 'Aucun incident à traiter'}</strong><small>Tout est à jour pour le moment.</small></div></div>`;
      }
      const label = isRequests ? `${n} demande${n > 1 ? 's' : ''} à valider` : `${n} incident${n > 1 ? 's' : ''} à traiter`;
      return `<a class="td-attention" href="/app/operations?vue=${isRequests ? 'demandes' : 'incidents'}">${ic('alert')}<div><strong>${label}</strong><small>Ouvrir dans Opérations</small></div><span class="td-arrow">${ic('arrowRight')}</span></a>`;
    }

    // ---- Tableau ----------------------------------------------------------
    function statusBadge(label, group) {
      return `<span class="td-status ${GROUP_TONE[group] ? `td-status-${GROUP_TONE[group]}` : ''}">${esc(label)}</span>`;
    }
    const tz = () => data.range.timezone;
    const TABLES = {
      orders: {
        title: 'Dernières commandes', source: 'orders', cols: ['Commande', 'Client', 'Livreur', 'Statut'],
        cells: (o) => [`<strong>${esc(o.reference)}</strong><small>${esc(shortDate(o.day))} · ${esc(timeOf(o.at, tz()))}</small>`, `${esc(o.client || '—')}${o.zone ? `<small>${esc(o.zone)}</small>` : ''}`, esc(o.driver || 'Non affecté'), statusBadge(o.status, o.group)],
        href: (o) => `/app/operations?vue=commandes&commande=${o.id}`,
        fields: (o) => [['Référence', o.reference], ['Client', o.client || '—'], ['Zone', o.zone || '—'], ['Livreur', o.driver || 'Non affecté'], ['Statut', o.status], ['Créée', `${longDate(o.day)} · ${timeOf(o.at, tz())}`]],
        csv: [['Référence', (o) => o.reference], ['Créée le', (o) => o.at], ['Client', (o) => o.client], ['Zone', (o) => o.zone], ['Livreur', (o) => o.driver || ''], ['Statut', (o) => o.status]],
      },
      deliveries: {
        title: 'Livraisons terminées', source: 'deliveries', cols: ['Commande', 'Client', 'Livreur', 'Durée'],
        cells: (o) => [`<strong>${esc(o.reference)}</strong><small>Livrée le ${esc(shortDate(o.day))} · ${esc(timeOf(o.at, tz()))}</small>`, `${esc(o.client || '—')}${o.zone ? `<small>${esc(o.zone)}</small>` : ''}`, esc(o.driver || 'Non affecté'), `${o.minutes == null ? '—' : `${fmt(o.minutes)} min`}${o.incidents ? '<small>Avec incident</small>' : ''}`],
        href: (o) => `/app/operations?vue=commandes&commande=${o.id}`,
        fields: (o) => [['Référence', o.reference], ['Client', o.client || '—'], ['Zone', o.zone || '—'], ['Livreur', o.driver || 'Non affecté'], ['Durée', o.minutes == null ? 'Non mesurée' : `${fmt(o.minutes)} min`], ['Livrée', `${longDate(o.day)} · ${timeOf(o.at, tz())}`]],
        csv: [['Référence', (o) => o.reference], ['Livrée le', (o) => o.at], ['Client', (o) => o.client], ['Zone', (o) => o.zone], ['Livreur', (o) => o.driver || ''], ['Durée (min)', (o) => o.minutes ?? ''], ['Incident', (o) => (o.incidents ? 'oui' : 'non')]],
      },
      drivers: {
        title: 'Performance par livreur', source: 'drivers', cols: ['Livreur', 'Affectées', 'Livrées', 'Taux'], num: [1, 2, 3], date: false,
        cells: (d) => [`<strong>${esc(d.name)}</strong><small>${d.avgMinutes == null ? 'Durée non mesurée' : `${fmt(d.avgMinutes)} min en moyenne`}</small>`, fmt(d.assigned), fmt(d.delivered), d.rate == null ? '—' : `${fmt(d.rate, 1)} %`],
        href: (d) => `/app/livreurs?livreur=${d.id}`,
        fields: (d) => [['Livreur', d.name], ['Commandes affectées', fmt(d.assigned)], ['Déjà livrées', `${fmt(d.done)} (${d.rate == null ? '—' : `${fmt(d.rate, 1)} %`})`], ['Livraisons terminées sur la période', fmt(d.delivered)], ['Durée moyenne', d.avgMinutes == null ? 'Non mesurée' : `${fmt(d.avgMinutes)} min`]],
        csv: [['Livreur', (d) => d.name], ['Affectées', (d) => d.assigned], ['Livrées (cohorte)', (d) => d.done], ['Livraisons terminées', (d) => d.delivered], ['Taux (%)', (d) => (d.rate == null ? '' : d.rate.toFixed(1))], ['Durée moyenne (min)', (d) => (d.avgMinutes == null ? '' : Math.round(d.avgMinutes))]],
      },
      requests: {
        title: 'Demandes reçues', source: 'requests', cols: ['Demande', 'Client', 'Reçue', 'Statut'],
        cells: (r) => [`<strong>Demande n° ${r.id}</strong>${r.zone ? `<small>${esc(r.zone)}</small>` : ''}`, esc(r.client || '—'), `${esc(shortDate(r.day))}<small>${esc(timeOf(r.at, tz()))}</small>`, statusBadge(r.group === 'converted' ? 'Convertie' : r.status, r.group)],
        href: (r) => (r.orderId ? `/app/operations?vue=commandes&commande=${r.orderId}` : `/app/operations?vue=demandes&demande=${r.id}`),
        fields: (r) => [['Demande', `n° ${r.id}`], ['Client', r.client || '—'], ['Zone', r.zone || '—'], ['Statut', r.status], ['Reçue', `${longDate(r.day)} · ${timeOf(r.at, tz())}`], ['Commande', r.orderId ? `n° ${r.orderId}` : 'Pas encore créée']],
        csv: [['Demande', (r) => r.id], ['Reçue le', (r) => r.at], ['Client', (r) => r.client], ['Zone', (r) => r.zone], ['Statut', (r) => r.status], ['Commande', (r) => r.orderId || '']],
      },
      routes: {
        title: 'Vos tournées', source: 'runs', cols: ['Tournée', 'Livreur', 'Progression', 'Statut'],
        cells: (r) => [`<strong>${esc(r.name)}</strong><small>${esc(shortDate(r.day))}</small>`, esc(r.driver || '—'), `${fmt(r.done)} / ${fmt(r.total)} arrêts<span class="td-progress"><span style="width:${r.total ? (r.done / r.total) * 100 : 0}%"></span></span>`, statusBadge(RUN_LABELS[r.status] || r.status, r.group)],
        href: (r) => `/app/operations?vue=tournees&tournee=${r.id}`,
        fields: (r) => [['Tournée', r.name], ['Livreur', r.driver || '—'], ['Date de service', longDate(r.day)], ['Arrêts terminés', `${fmt(r.done)} / ${fmt(r.total)}`], ['Statut', RUN_LABELS[r.status] || r.status]],
        csv: [['Tournée', (r) => r.name], ['Date', (r) => r.day], ['Livreur', (r) => r.driver || ''], ['Arrêts', (r) => r.total], ['Terminés', (r) => r.done], ['Statut', (r) => RUN_LABELS[r.status] || r.status]],
      },
      incidents: {
        title: 'Suivi des incidents', source: 'incidents', cols: ['Commande', 'Motif', 'Livreur', 'État'],
        cells: (i) => [`<strong>${esc(i.reference || `Incident n° ${i.id}`)}</strong><small>${esc(shortDate(i.day))} · ${esc(timeOf(i.at, tz()))}</small>`, `${esc(i.label)}${i.client ? `<small>${esc(i.client)}</small>` : ''}`, esc(i.driver || 'Non affecté'), `<span class="td-status ${i.open ? 'td-status-alert' : 'td-status-delivered'}">${i.open ? 'À traiter' : 'Clôturé'}</span>`],
        href: (i) => `/app/operations?vue=incidents&incident=${i.id}`,
        fields: (i) => [['Incident', `n° ${i.id}`], ['Motif', i.label], ['Commande', i.reference || '—'], ['Client', i.client || '—'], ['Livreur', i.driver || 'Non affecté'], ['État', i.open ? 'À traiter' : 'Clôturé'], ['Signalé', `${longDate(i.day)} · ${timeOf(i.at, tz())}`]],
        csv: [['Incident', (i) => i.id], ['Signalé le', (i) => i.at], ['Motif', (i) => i.label], ['Commande', (i) => i.reference], ['Client', (i) => i.client], ['Livreur', (i) => i.driver || ''], ['État', (i) => (i.open ? 'À traiter' : 'Clôturé')]],
      },
    };
    const tableFor = (tab) => TABLES[tab === 'general' ? 'orders' : tab];
    function tableRows() {
      const t = tableFor(state.tab);
      let rows = data.rows[t.source] || [];
      if (state.day && t.date !== false) rows = rows.filter((r) => r.day === state.day);
      return rows;
    }
    function tableHtml(animate) {
      const t = tableFor(state.tab);
      const rows = tableRows();
      const max = Math.max(0, Math.ceil(rows.length / PAGE) - 1);
      state.page = Math.min(state.page, max);
      const visible = rows.slice(state.page * PAGE, state.page * PAGE + PAGE);
      const num = new Set(t.num || []);
      const head = t.cols.map((c, i) => `<th class="${i === 2 ? 'td-secondary' : ''} ${num.has(i) ? 'td-num' : ''}">${c}</th>`).join('');
      const body = visible.map((r, k) => `<tr style="--i:${k}" class="${state.detail === k + state.page * PAGE ? 'td-row-active' : ''}">${t.cells(r).map((c, i) => `<td class="${i === 2 ? 'td-secondary' : ''} ${num.has(i) ? 'td-num' : ''}">${c}</td>`).join('')}
        <td><button type="button" class="td-row-open" data-row="${state.page * PAGE + k}" aria-label="Voir le détail">${ic('arrowUpRight')}</button></td></tr>`).join('');
      return `<section class="td-panel td-table-panel">
        <div class="td-section-head"><h2>${esc(t.title)} <small>${fmt(rows.length)}</small></h2><button type="button" class="td-link" data-action="export">Exporter ${ic('arrowUpRight')}</button></div>
        ${state.day && t.date !== false ? `<span class="td-filter-pill">${esc(longDate(state.day))}<button type="button" data-action="clear-day" aria-label="Retirer le filtre du jour">${ic('x')}</button></span>` : ''}
        ${rows.length ? `<div class="td-table-scroll"><table class="td-table ${animate && !reduced() ? 'td-anim-rows' : ''}"><thead><tr>${head}<th aria-label="Détail"></th></tr></thead><tbody>${body}</tbody></table></div>`
          : `<div class="td-empty">${ic('inbox')}${state.day ? 'Rien ce jour-là.' : 'Aucun élément sur cette période.'}</div>`}
        <div class="td-table-foot"><span>${rows.length ? `${state.page * PAGE + 1}–${Math.min(rows.length, (state.page + 1) * PAGE)} sur ${fmt(rows.length)}` : '0 élément'}</span>
          <div><button type="button" class="td-link" data-action="prev" ${state.page === 0 ? 'disabled' : ''}>${ic('chevronLeft')} Précédent</button><button type="button" class="td-link" data-action="next" ${state.page >= max ? 'disabled' : ''}>Suivant ${ic('chevronRight')}</button></div></div>
      </section>`;
    }
    function openDetail(index) {
      const t = tableFor(state.tab);
      const row = tableRows()[index];
      if (!row) return;
      state.detail = index;
      $('#tdTable').innerHTML = tableHtml(false);
      const box = $('#tdDetail');
      box.innerHTML = `<section class="td-panel td-inspection" aria-live="polite"><div class="td-section-head"><h2>Détail</h2><button type="button" class="td-link" data-action="close-detail">Fermer ${ic('x')}</button></div>
        <dl class="td-detail-grid">${t.fields(row).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <div class="td-inspection-foot"><a class="td-btn" href="${esc(t.href(row))}">Ouvrir la fiche ${ic('arrowUpRight')}</a></div></section>`;
      box.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    }

    function leadersHtml() {
      if (state.tab === 'incidents') {
        const list = data.rows.incidents.slice(0, 4);
        return `<section class="td-panel td-leader-panel"><div class="td-section-head"><h2>Derniers signalements</h2><a class="td-link" href="/app/operations?vue=incidents">Tout voir ${ic('arrowUpRight')}</a></div>
          ${list.length ? list.map((i) => `<a class="td-event" href="/app/operations?vue=incidents&incident=${i.id}"><span class="${i.open ? '' : 'td-closed'}"></span><div>${esc(i.label)}<p>${esc(i.reference || `Incident n° ${i.id}`)} · ${esc(shortDate(i.day))} · ${i.open ? 'à traiter' : 'clôturé'}</p></div></a>`).join('')
            : '<div class="td-empty">Aucun incident sur la période.</div>'}</section>`;
      }
      const team = data.team;
      return `<section class="td-panel td-leader-panel"><div class="td-section-head"><h2>Votre équipe en action</h2>${state.tab === 'drivers' ? '' : `<button type="button" class="td-link" data-tab="drivers">Détails ${ic('arrowUpRight')}</button>`}</div>
        ${team.length ? team.map((m) => `<a class="td-leader" href="/app/livreurs?livreur=${m.id}"><span class="td-avatar">${esc(initials(m.name))}</span>
          <div class="td-leader-info"><strong>${esc(m.name)}</strong><small>${m.rate == null ? 'Aucune commande affectée' : `${fmt(m.rate, 1)} % terminées`}</small><div class="td-leader-progress"><span style="width:${m.rate || 0}%"></span></div></div>
          <div class="td-leader-total">${fmt(m.delivered)}<small>livrée${m.delivered > 1 ? 's' : ''}</small></div></a>`).join('')
          : '<div class="td-empty">Aucune commande affectée sur la période.</div>'}</section>`;
    }
    const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

    function heatmapHtml() {
      const h = data.heatmap;
      const week = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
      const weekLong = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
      const palette = ['#f5f0e9', '#f8e5ce', '#f2cda3', '#e9b57f', '#d79a62'];
      const max = Math.max(1, ...h.counts.flat());
      const label = (i, j, v) => `${weekLong[i]}, ${h.hours[j]} h – ${h.hours[j] + 2} h : ${v} commande${v > 1 ? 's' : ''}`;
      return `<section class="td-panel td-heat-panel"><h2>Vos heures les plus chargées</h2><p>Commandes créées · cumul de la période${state.driver !== 'all' ? ' · livreur choisi' : ''}</p>
        <div class="td-heat-grid" role="img" aria-label="${esc(h.counts.map((row, i) => row.map((v, j) => label(i, j, v)).join(' ; ')).join('. '))}"><span></span>${h.hours.map((x) => `<span>${x} h</span>`).join('')}
          ${h.counts.map((row, i) => `<span>${week[i]}</span>${row.map((v, j) => `<div class="td-heat-cell" style="--heat:${palette[v ? Math.max(1, Math.ceil((v / max) * 4)) : 0]};--order:${i * 5 + j}" title="${esc(label(i, j, v))}"></div>`).join('')}`).join('')}</div>
        <div class="td-heat-caption"><span>${h.outside ? `${fmt(h.outside)} hors 8 h – 18 h` : ''}</span><span>Moins ${palette.map((c) => `<i style="--heat:${c}"></i>`).join('')} Plus</span></div></section>`;
    }

    // ---- Export CSV ---------------------------------------------------------
    function csvText() {
      const t = tableFor(state.tab);
      const rows = tableRows();
      const cell = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      return `﻿${[t.csv.map((c) => cell(c[0])).join(';'), ...rows.map((r) => t.csv.map((c) => cell(c[1](r))).join(';'))].join('\r\n')}`;
    }
    function openExport() {
      if (!data) return;
      const tabLabel = TABS.find((x) => x[0] === state.tab)[1];
      const rows = tableRows();
      const fileName = `TRAXO_${TABS.find((x) => x[0] === state.tab)[2]}_${state.day || `${data.range.from}_${data.range.to}`}.csv`;
      const driverName = state.driver === 'all' ? 'Tous les livreurs' : (data.drivers.find((d) => String(d.id) === String(state.driver)) || {}).name || '';
      const modal = env.openModal('Exporter cette vue', `<div class="td-export-body"><p><strong>${fmt(rows.length)} ligne${rows.length > 1 ? 's' : ''}</strong> · ${esc(tabLabel)} · ${esc(state.day ? longDate(state.day) : rangeLabel(data.range.from, data.range.to))} · ${esc(driverName)}</p>
        <p>Le fichier CSV reprend exactement la liste affichée, avec les filtres actifs. Il s’ouvre dans Excel, LibreOffice ou Google Sheets.</p>${data.truncated ? '<p>La liste est limitée aux 3 000 lignes les plus récentes.</p>' : ''}</div>`,
      `<button type="button" class="button secondary" data-copy>Copier le CSV</button><button type="button" class="button accent" data-download ${rows.length ? '' : 'disabled'}>Télécharger le CSV</button>`);
      modal.backdrop.querySelector('[data-download]').addEventListener('click', () => {
        const blob = new Blob([csvText()], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
        modal.close();
        env.uiToast('Export téléchargé.', 'success');
      });
      modal.backdrop.querySelector('[data-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(csvText().replace(/^﻿/, '')); env.uiToast('CSV copié dans le presse-papiers.', 'success'); modal.close(); } catch { env.uiToast('Copie impossible dans ce navigateur. Utilisez le téléchargement.', 'warning'); }
      });
    }

    // ---- Événements ---------------------------------------------------------
    root.addEventListener('click', async (event) => {
      const b = event.target.closest('button');
      if (!b || !root.contains(b)) return;
      if (b.dataset.tab) {
        if (b.dataset.tab === state.tab) return;
        state.tab = b.dataset.tab; state.day = null; state.page = 0; state.detail = null;
        draw(true); syncUrl();
        return;
      }
      if (b.dataset.period) {
        const p = Number(b.dataset.period);
        if (!state.from && p === state.period) return;
        state.period = p; state.from = null; state.to = null;
        $('#tdDatePanel').hidden = true;
        load().catch(() => {});
        return;
      }
      if (b.dataset.chart) { if (state.chart !== b.dataset.chart) { state.chart = b.dataset.chart; root.querySelectorAll('[data-chart]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.chart === state.chart))); drawChart(data.tabs[state.tab].series, true); } return; }
      if (b.dataset.row) { openDetail(Number(b.dataset.row)); return; }
      const a = b.dataset.action;
      if (a === 'date') {
        const panel = $('#tdDatePanel');
        panel.hidden = !panel.hidden;
        b.setAttribute('aria-expanded', String(!panel.hidden));
        if (!panel.hidden && data) {
          $('#tdFrom').value = data.range.from; $('#tdTo').value = data.range.to;
          $('#tdFrom').max = data.today; $('#tdTo').max = data.today;
          $('#tdDateHint').textContent = `${data.maxDays} jours au plus, jusqu’à aujourd’hui.`;
          $('#tdDateError').textContent = '';
          $('#tdFrom').focus();
        }
      }
      if (a === 'export') openExport();
      if (a === 'clear-day') { state.day = null; state.page = 0; state.detail = null; $('#tdTable').innerHTML = tableHtml(true); $('#tdDetail').innerHTML = ''; }
      if (a === 'prev' || a === 'next') { state.page += a === 'next' ? 1 : -1; state.detail = null; $('#tdTable').innerHTML = tableHtml(true); $('#tdDetail').innerHTML = ''; }
      if (a === 'close-detail') { state.detail = null; $('#tdDetail').innerHTML = ''; $('#tdTable').innerHTML = tableHtml(false); }
    });
    root.addEventListener('change', (event) => {
      if (event.target.id === 'tdDriver') { state.driver = event.target.value; load().catch(() => {}); }
      if (event.target.id === 'tdCompare') {
        state.compare = event.target.checked;
        root.querySelector('.td-chart-legend').innerHTML = `<span class="td-legend-item">Cette période</span>${state.compare ? '<span class="td-legend-item td-legend-previous">Précédente</span>' : ''}`;
        drawChart(data.tabs[state.tab].series, true);
      }
    });
    $('#tdDatePanel').addEventListener('submit', async (event) => {
      event.preventDefault();
      const from = $('#tdFrom').value;
      const to = $('#tdTo').value;
      const err = $('#tdDateError');
      if (!from || !to) { err.textContent = 'Choisissez une date de début et une date de fin.'; return; }
      if (from > to) { err.textContent = 'La date de fin doit suivre la date de début.'; return; }
      const before = { from: state.from, to: state.to };
      state.from = from; state.to = to;
      try {
        await load();
        $('#tdDatePanel').hidden = true;
        root.querySelector('[data-action="date"]').setAttribute('aria-expanded', 'false');
      } catch (error) {
        state.from = before.from; state.to = before.to;
        err.textContent = error.message;
      }
    });
    const onDocClick = (event) => {
      if (!document.body.contains(root)) { document.removeEventListener('click', onDocClick); return; }
      const panel = $('#tdDatePanel');
      if (!panel.hidden && !event.target.closest('.td-datewrap')) { panel.hidden = true; root.querySelector('[data-action="date"]').setAttribute('aria-expanded', 'false'); }
    };
    document.addEventListener('click', onDocClick);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#tdDatePanel').hidden) { $('#tdDatePanel').hidden = true; root.querySelector('[data-action="date"]').focus(); }
      const tabBtn = event.target.closest('[role="tab"]');
      if (tabBtn && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        const list = [...root.querySelectorAll('[role="tab"]')];
        const next = list[(list.indexOf(tabBtn) + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
        next.focus(); next.click();
      }
    });

    env.setHeader('Tableau de bord', 'Votre activité, période par période');
    return load().catch(() => {});
  }

  window.TraxoDashboard = { render };
})();
