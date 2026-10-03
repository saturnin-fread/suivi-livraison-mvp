// Clients TRAXO (kit « Clients », données réelles).
// Carnet en Liste, Cartes ou Par étape, vues enregistrées en base, sélection
// sur plusieurs pages, actions groupées annulables, fiche client complète
// (aperçu, contacts, lieux, commandes, notes et activité) et création avec
// contrôle du téléphone en double. Les droits sont appliqués par le serveur.
(function () {
  'use strict';

  // Icônes Lucide (licence ISC).
  const P = {
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    contact: '<path d="M16 2v2"/><path d="M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/><path d="M8 2v2"/><circle cx="12" cy="11" r="3"/><rect x="3" y="4" width="18" height="18" rx="2"/>',
    merge: '<path d="m8 6 4-4 4 4"/><path d="M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22"/><path d="m20 22-5-5"/>',
  };
  const ic = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[n] || ''}</svg>`;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const cid = (id) => `CL-${String(id).padStart(4, '0')}`;
  const dShort = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '—');
  const dLong = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
  const dTime = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  };

  const STAGES = { nouveau: ['Nouveau', 'purple'], actif: ['Actif', 'green'], a_relancer: ['À relancer', 'amber'], inactif: ['Inactif', 'gray'] };
  const CHANNELS = { call: 'Appel', whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-mail' };
  const ORIGIN = { manual: 'Création manuelle', order: 'Créée à la première commande', request: 'Formulaire client' };
  const COORD = {
    customer_gps: 'Position partagée par le client', map_pin: 'Point placé sur la carte', whatsapp_link: 'Position envoyée par WhatsApp',
    operator: 'Position relevée par l’équipe', import: 'Position importée',
  };
  const FIELD_LABEL = {
    displayName: 'nom', customerType: 'type', phone: 'téléphone', email: 'e-mail', pipelineStage: 'étape', mainCity: 'ville',
    sector: 'secteur', preferredLanguage: 'langue', preferredChannel: 'canal', tags: 'étiquettes', driverInstructions: 'consignes livreur',
    defaultLocationId: 'lieu habituel', status: 'statut', serviceNotes: 'notes',
  };
  const ACTIVITY = {
    created: () => 'Fiche client créée',
    updated: (d) => `Informations modifiées${Array.isArray(d.fields) && d.fields.length ? ` : ${d.fields.map((f) => FIELD_LABEL[f] || f).join(', ')}` : ''}`,
    contact_added: (d) => `Contact ajouté : ${d.name || ''}`,
    contact_removed: (d) => `Contact retiré : ${d.name || ''}`,
    location_added: (d) => `Lieu ajouté : ${d.label || ''}`,
    location_updated: (d) => `Lieu modifié : ${d.label || ''}`,
    bulk_stage: (d) => (d.stage ? `Étape : ${STAGES[d.stage]?.[0] || d.stage}` : 'Étape : automatique'),
    bulk_archive: () => 'Fiche archivée',
    bulk_restore: () => 'Fiche restaurée',
    bulk_remove: () => 'Fiche supprimée du carnet',
    bulk_unremove: () => 'Suppression annulée',
  };
  const ORDER_TONE = (s) => (s === 'Livrée' ? 'green' : ['Échec', 'Annulée', 'Retournée', 'Retour'].includes(s) ? 'red' : 'blue');
  const COLUMNS = { phone: 'Téléphone', city: 'Ville et lieux', orders: 'Commandes', last: 'Dernière activité' };
  const blankFilter = () => ({ stage: 'all', city: 'all', type: 'all', frequency: 'any' });
  const RECURRING = 5;

  async function render(page, deps) {
    const { api, context } = deps;
    const role = context.user.role;
    const canWrite = role !== 'viewer';
    const isLead = ['owner', 'manager'].includes(role);
    const json = (url, body, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    page.classList.add('page-clients');
    const root = document.createElement('div');
    root.className = 'cl';
    page.innerHTML = '';
    page.appendChild(root);
    const $ = (s) => root.querySelector(s);

    const st = {
      screen: 'list', detailId: null, detailTab: 'overview', editor: '', editPlaceId: null,
      viewId: 'all', scope: 'current', filter: blankFilter(), query: '', sort: 'recent',
      layout: store.get('traxo.clients.layout') || 'list', page: 1, size: 12,
      columns: { phone: true, city: true, orders: true, last: true },
      selected: new Set(), tool: '', confirm: null, undo: null, flash: null, busy: false,
      draft: null, dup: null, orderFilter: 'all',
    };
    let current = []; let archived = []; let views = [];
    let detail = null; let duplicates = [];

    function normalize(r) {
      const row = {
        id: String(r.id), name: r.display_name || `Client ${r.id}`, type: r.customer_type === 'organization' ? 'organization' : 'person',
        sector: r.sector || '', phone: r.primary_phone || '', email: r.primary_email || '', stage: r.stage, stageSource: r.stage_source,
        archived: r.status === 'archived', city: r.main_city || r.primary_locality || '', tags: r.tags || [],
        places: r.location_count || 0, orders: r.order_count || 0, active: r.active_order_count || 0,
        lastOrderAt: r.last_order_at, lastStatus: r.last_order_status, lastActivity: r.last_activity_at || r.created_at,
      };
      row.search = [row.name, row.phone, row.email, cid(row.id), row.city, r.primary_neighborhood, ...row.tags, r.location_search, row.sector]
        .join(' ').toLowerCase();
      return row;
    }
    async function loadList() {
      const [a, b] = await Promise.all([
        api('/api/app/crm/customers?all=1'),
        api('/api/app/crm/customers?all=1&status=archived'),
      ]);
      current = a.customers.map(normalize);
      archived = b.customers.map(normalize);
    }
    async function loadViews() {
      try { views = (await api('/api/app/ops/views')).filter((v) => v.source === 'clients'); } catch { views = []; }
    }
    const byId = (id) => current.find((c) => c.id === id) || archived.find((c) => c.id === id);
    const pool = () => (st.scope === 'archived' ? archived : current);
    function filtered() {
      const q = st.query.trim().toLowerCase();
      const f = st.filter;
      const rows = pool().filter((c) => (f.stage === 'all' || c.stage === f.stage)
        && (f.city === 'all' || c.city === f.city)
        && (f.type === 'all' || c.type === f.type)
        && (f.frequency === 'any' || (f.frequency === 'recurring' ? c.orders >= RECURRING : f.frequency === 'none' ? c.orders === 0 : c.orders > 0 && c.orders < RECURRING))
        && (!q || c.search.includes(q)));
      const t = (iso) => (iso ? new Date(iso).getTime() : 0);
      return rows.sort((a, b) => (st.sort === 'name' ? a.name.localeCompare(b.name, 'fr')
        : st.sort === 'orders' ? b.orders - a.orders || a.name.localeCompare(b.name, 'fr')
          : t(b.lastActivity) - t(a.lastActivity)));
    }
    const flash = (text, tone = 'ok', undo = null) => { st.flash = { text, tone }; if (undo !== undefined) st.undo = undo; };
    const discardUndo = () => { st.undo = null; };

    // ---------- Navigation interne (les réglages de liste restent au retour)
    function go(path, replace = false) {
      if (replace) history.replaceState({ cl: true }, '', path); else history.pushState({ cl: true }, '', path);
      return route();
    }
    async function route() {
      const path = location.pathname;
      const m = path.match(/^\/app\/clients\/(\d+)$/);
      st.confirm = null; st.editor = ''; st.dup = null; st.tool = '';
      if (path === '/app/clients/nouveau') {
        if (!canWrite) return go('/app/clients', true);
        st.screen = 'new'; st.draft = null; draw();
        $('[name="displayName"]')?.focus({ preventScroll: true });
      } else if (m) {
        st.screen = 'detail'; st.detailId = m[1];
        const tab = new URLSearchParams(location.search).get('onglet');
        st.detailTab = ['overview', 'contacts', 'places', 'orders', 'activity'].includes(tab) ? tab : 'overview';
        await loadDetail();
      } else {
        st.screen = 'list';
        if (!current.length && !archived.length) await loadList();
        draw();
      }
      window.scrollTo({ top: 0 });
    }
    async function loadDetail() {
      root.innerHTML = '<p class="cl-loading">Chargement de la fiche…</p>';
      try {
        const [d, dup] = await Promise.all([
          api(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}`),
          api(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}/duplicates`).catch(() => ({ duplicates: [] })),
        ]);
        detail = d; duplicates = dup.duplicates || [];
      } catch (error) {
        detail = null;
        root.innerHTML = `<button type="button" class="cl-back" data-act="back">${ic('arrow-left')}Tous les clients</button><div class="cl-empty"><h2>Fiche introuvable</h2><p>${esc(error.message)}</p></div>`;
        return;
      }
      draw();
    }
    async function reloadDetail() {
      const keep = window.scrollY;
      await loadDetail();
      window.scrollTo({ top: keep });
    }

    // ---------- Rendu
    function draw() {
      root.innerHTML = st.screen === 'list' ? listPage() : st.screen === 'new' ? newPage() : detailPage();
      if (st.screen === 'list') drawResults();
    }
    const btn = (act, label, icon, cls = '', extra = '') => `<button type="button" class="cl-btn ${cls}" data-act="${act}" ${extra}>${icon ? ic(icon) : ''}${label}</button>`;
    const badge = (c) => (c.archived ? '<span class="cl-badge gray">Archivé</span>' : `<span class="cl-badge ${STAGES[c.stage]?.[1] || 'gray'}">${esc(STAGES[c.stage]?.[0] || '—')}</span>`);
    const avatar = (c) => `<span class="cl-avatar ${c.type === 'organization' ? 'business' : ''}">${c.type === 'organization' ? ic('building') : esc(initials(c.name))}</span>`;
    function flashHtml() {
      if (!st.flash) return '';
      return `<div class="cl-flash ${st.flash.tone}" role="status"><span>${esc(st.flash.text)}</span><span class="cl-flash-actions">${st.undo ? '<button type="button" data-act="undo">Annuler</button>' : ''}<button type="button" class="cl-icon" data-act="dismiss" aria-label="Fermer le message">${ic('x')}</button></span></div>`;
    }

    function listPage() {
      const builtIn = [['all', 'Tous les clients'], ['follow', 'À relancer'], ['repeat', 'Récurrents']];
      const custom = views.map((v) => [v.id, v.name + (v.shared ? ' · équipe' : '')]);
      const active = views.find((v) => v.id === st.viewId);
      const nFilters = Object.entries(st.filter).filter(([k, v]) => (k === 'frequency' ? v !== 'any' : v !== 'all')).length;
      return `<div class="cl-heading"><div><h1>Clients</h1><p>Les coordonnées, les lieux et l’historique de vos clients, au même endroit.</p></div>
        <div class="cl-heading-actions">${isLead ? btn('export', 'Exporter', 'download') : ''}${canWrite ? btn('new', 'Nouveau client', 'plus', 'primary') : ''}</div></div>
        <div id="clFlash">${flashHtml()}</div>
        <div class="cl-viewbar"><div class="cl-views" role="group" aria-label="Vues du carnet">
          ${[...builtIn, ...custom, ['archived', 'Archivés']].map(([id, name]) => `<button type="button" data-view="${esc(id)}" aria-pressed="${id === st.viewId}">${esc(name)}${id === 'all' ? ` <span>${current.length}</span>` : id === 'archived' && archived.length ? ` <span>${archived.length}</span>` : ''}</button>`).join('')}
        </div><button type="button" class="cl-addview" data-act="new-view">${ic('plus')}Créer une vue</button></div>
        <div class="cl-toolbar">
          <label class="cl-search">${ic('search')}<input id="clQuery" type="search" value="${esc(st.query)}" placeholder="Nom, téléphone, adresse, étiquette…" aria-label="Rechercher un client" autocomplete="off"></label>
          <div class="cl-tool-actions">
            ${btn('filters', `Filtres${nFilters ? ` · ${nFilters}` : ''}`, 'sliders', st.tool === 'filters' ? 'pressed' : '', `aria-expanded="${st.tool === 'filters'}"`)}
            <select id="clSort" aria-label="Trier les clients"><option value="recent" ${st.sort === 'recent' ? 'selected' : ''}>Dernière activité</option><option value="name" ${st.sort === 'name' ? 'selected' : ''}>Nom A–Z</option><option value="orders" ${st.sort === 'orders' ? 'selected' : ''}>Plus de commandes</option></select>
            <div class="cl-layout" role="group" aria-label="Affichage">${[['list', 'Liste', 'list'], ['cards', 'Cartes', 'grid'], ['stage', 'Par étape', 'columns']].map(([k, l, i]) => `<button type="button" data-layout="${k}" aria-pressed="${st.layout === k}" aria-label="Affichage ${l}">${ic(i)}<span>${l}</span></button>`).join('')}</div>
            ${st.layout === 'list' ? btn('columns', 'Colonnes', 'columns', `cl-columns-btn ${st.tool === 'columns' ? 'pressed' : ''}`, `aria-expanded="${st.tool === 'columns'}"`) : ''}
            ${active && (active.mine || isLead) ? btn('edit-view', 'Modifier la vue', 'pencil', st.tool === 'edit-view' ? 'pressed' : '') : ''}
          </div>
        </div>
        ${st.tool ? toolPanel() : ''}
        <div id="clSelection"></div><div id="clConfirm"></div><div id="clResults"></div>
        <div class="cl-footnote">${ic('contact')}<span>Une fiche par client : ses contacts, ses lieux et ses commandes. Une nouvelle commande avec le même nom et le même téléphone rejoint la fiche existante.</span></div>`;
    }
    function toolPanel() {
      if (st.tool === 'filters') {
        const cities = [...new Set(pool().map((c) => c.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
        return `<section class="cl-inline-tool" aria-label="Filtres"><div class="cl-filter-fields">
          <label>Étape<select id="clF-stage"><option value="all">Toutes les étapes</option>${Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${st.filter.stage === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></label>
          <label>Ville<select id="clF-city"><option value="all">Toutes les villes</option>${cities.map((x) => `<option value="${esc(x)}" ${st.filter.city === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          <label>Type<select id="clF-type"><option value="all">Tous les clients</option><option value="person" ${st.filter.type === 'person' ? 'selected' : ''}>Particulier</option><option value="organization" ${st.filter.type === 'organization' ? 'selected' : ''}>Entreprise</option></select></label>
          <label>Fréquence<select id="clF-frequency"><option value="any">Toutes</option><option value="none" ${st.filter.frequency === 'none' ? 'selected' : ''}>Aucune commande</option><option value="occasional" ${st.filter.frequency === 'occasional' ? 'selected' : ''}>1 à ${RECURRING - 1} commandes</option><option value="recurring" ${st.filter.frequency === 'recurring' ? 'selected' : ''}>${RECURRING} commandes ou plus</option></select></label>
        </div><div class="cl-inline-actions">${btn('reset-filters', 'Réinitialiser')}${btn('new-view', 'Enregistrer comme vue', 'plus')}</div></section>`;
      }
      if (st.tool === 'columns') {
        return `<section class="cl-inline-tool"><strong>Colonnes de la liste</strong><div class="cl-column-options">${Object.entries(COLUMNS).map(([k, v]) => `<label><input type="checkbox" data-column="${k}" ${st.columns[k] ? 'checked' : ''}>${v}</label>`).join('')}</div><small>Le nom, l’identifiant et l’étape restent toujours visibles.</small></section>`;
      }
      const v = st.tool === 'edit-view' ? views.find((x) => x.id === st.viewId) : null;
      return `<section class="cl-inline-tool"><form id="clViewForm" class="cl-view-form" novalidate>
        <label>Nom de la vue<input name="name" maxlength="60" required value="${esc(v?.name || '')}" placeholder="Ex. Clients de Cotonou"></label>
        ${isLead ? `<label class="cl-check"><input type="checkbox" name="shared" ${v?.shared ? 'checked' : ''}>Partager avec l’équipe</label>` : ''}
        <p>Enregistre la recherche, les filtres, le tri, les colonnes, l’affichage et ${st.scope === 'archived' ? 'la vue des archivés' : 'le carnet courant'}.</p>
        <button class="cl-btn primary" type="submit" ${st.busy ? 'disabled' : ''}>${v ? 'Enregistrer' : 'Créer la vue'}</button>${btn('close-tool', 'Annuler')}${v ? btn('delete-view', 'Supprimer la vue', 'trash', 'danger') : ''}
        <span id="clViewError" class="cl-error" role="alert"></span></form></section>`;
    }

    function drawResults() {
      const ds = filtered();
      const max = Math.max(1, Math.ceil(ds.length / st.size));
      st.page = Math.min(Math.max(1, st.page), max);
      const visible = st.layout === 'stage' ? ds : ds.slice((st.page - 1) * st.size, st.page * st.size);
      const n = st.selected.size;
      $('#clSelection').innerHTML = n ? `<div class="cl-selectionbar"><strong>${plural(n, 'client sélectionné', 'clients sélectionnés')}</strong>
        ${ds.length > n ? `<button type="button" class="cl-linkish" data-act="select-all">Sélectionner les ${ds.length} résultats</button>` : ''}<span class="cl-spacer"></span>
        ${canWrite && st.scope !== 'archived' ? `<label class="cl-sr" for="clBulkStage">Changer l’étape</label><select id="clBulkStage"><option value="">Changer l’étape…</option>${Object.entries(STAGES).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}<option value="auto">Automatique (selon l’activité)</option></select>` : ''}
        ${isLead ? btn('export-selected', 'Exporter', 'download') : ''}
        ${canWrite ? btn(st.scope === 'archived' ? 'restore' : 'archive', st.scope === 'archived' ? 'Restaurer' : 'Archiver', 'archive') : ''}
        ${isLead ? btn('delete', 'Supprimer', 'trash', 'danger') : ''}
        ${btn('clear-selection', 'Désélectionner', 'x')}</div>` : '';
      $('#clConfirm').innerHTML = st.confirm ? confirmHtml() : '';
      const isFiltered = st.query || Object.entries(st.filter).some(([k, v]) => (k === 'frequency' ? v !== 'any' : v !== 'all'));
      $('#clResults').innerHTML = ds.length
        ? (st.layout === 'list' ? table(visible) : st.layout === 'cards' ? `<div class="cl-cards">${visible.map(card).join('')}</div>` : board(ds))
          + (st.layout === 'stage' ? `<div class="cl-board-summary">${plural(ds.length, 'client affiché', 'clients affichés')}${canWrite ? ' · Changez l’étape depuis chaque carte.' : ''}</div>` : pagination(ds.length))
        : `<div class="cl-empty">${ic('search')}<h2>${isFiltered ? 'Aucun client ne correspond.' : st.scope === 'archived' ? 'Aucune fiche archivée.' : 'Aucun client pour le moment.'}</h2>
          <p>${isFiltered ? 'Essayez un autre nom ou élargissez vos filtres.' : st.scope === 'archived' ? 'Les fiches archivées apparaîtront ici, restaurables à tout moment.' : 'Ajoutez votre premier client, ou créez une commande : sa fiche se crée toute seule.'}</p>
          ${isFiltered || st.viewId !== 'all' ? btn('reset-all', 'Voir tous les clients') : ''}${canWrite && !isFiltered ? btn('new', 'Nouveau client', 'plus', 'primary') : ''}</div>`;
      const pick = $('#clPickPage');
      if (pick) {
        const k = visible.filter((c) => st.selected.has(c.id)).length;
        pick.checked = visible.length > 0 && k === visible.length;
        pick.indeterminate = k > 0 && k < visible.length;
      }
    }
    const identity = (c) => `<button type="button" class="cl-identity" data-open="${esc(c.id)}">${avatar(c)}<span><strong>${esc(c.name)}</strong><small>${cid(c.id)}${c.type === 'organization' ? ' · Entreprise' : ''}</small></span></button>`;
    const pick = (c) => `<input type="checkbox" data-pick="${esc(c.id)}" aria-label="Sélectionner ${esc(c.name)}" ${st.selected.has(c.id) ? 'checked' : ''}>`;
    const lastCell = (c) => (c.lastOrderAt ? `<span>${esc(dShort(c.lastOrderAt))}</span><small>${esc(c.lastStatus || '')}</small>` : '<span>Aucune commande</span><small>Fiche créée</small>');
    function table(rows) {
      const col = st.columns;
      return `<div class="cl-table-wrap"><table class="cl-table"><thead><tr><th class="cl-checkcell"><input id="clPickPage" type="checkbox" aria-label="Sélectionner cette page"></th><th>Client</th>${col.phone ? '<th>Téléphone</th>' : ''}<th>Étape</th>${col.city ? '<th>Ville et lieux</th>' : ''}${col.orders ? '<th>Commandes</th>' : ''}${col.last ? '<th class="cl-activity-col">Dernière activité</th>' : ''}<th><span class="cl-sr">Ouvrir</span></th></tr></thead><tbody>
        ${rows.map((c) => `<tr class="${st.selected.has(c.id) ? 'selected' : ''}"><td class="cl-checkcell">${pick(c)}</td><td>${identity(c)}</td>
          ${col.phone ? `<td data-label="Téléphone"><span class="cl-phone-text">${esc(c.phone || 'À compléter')}</span></td>` : ''}
          <td data-label="Étape">${badge(c)}</td>
          ${col.city ? `<td data-label="Lieux"><strong class="cl-cell-main">${esc(c.city || 'À compléter')}</strong><small>${plural(c.places, 'lieu', 'lieux')}</small></td>` : ''}
          ${col.orders ? `<td data-label="Commandes"><span class="cl-order-count">${c.orders}</span>${c.active ? `<small class="cl-ongoing">${c.active > 1 ? `${c.active} livraisons en cours` : 'Une livraison en cours'}</small>` : ''}</td>` : ''}
          ${col.last ? `<td data-label="Activité">${lastCell(c)}</td>` : ''}
          <td class="cl-row-action"><button type="button" class="cl-open" data-open="${esc(c.id)}" aria-label="Ouvrir la fiche de ${esc(c.name)}">${ic('arrow-up-right')}</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    function card(c) {
      return `<article class="cl-card"><div class="cl-card-head">${identity(c)}${pick(c)}</div><div class="cl-card-meta">${badge(c)}<span>${esc(c.city || 'Ville à compléter')}</span></div>
        <p class="cl-card-phone">${esc(c.phone || 'Téléphone à compléter')}</p>
        <div class="cl-card-stats"><span><b>${c.orders}</b> commande${c.orders > 1 ? 's' : ''}</span><span><b>${c.places}</b> lieu${c.places > 1 ? 'x' : ''}</span><span>Dernière · ${esc(c.lastOrderAt ? dShort(c.lastOrderAt) : '—')}</span></div>
        <button type="button" class="cl-card-link" data-open="${esc(c.id)}">Ouvrir la fiche ${ic('arrow-right')}</button></article>`;
    }
    function board(ds) {
      return `<div class="cl-board">${Object.entries(STAGES).map(([s, v]) => {
        const items = ds.filter((c) => c.stage === s);
        return `<section class="cl-lane ${v[1]}"><h2><span class="cl-stage-dot"></span>${v[0]}<b>${items.length}</b></h2><div class="cl-lane-items">
          ${items.length ? items.map((c) => `<article class="cl-board-card"><div class="cl-card-head">${identity(c)}${pick(c)}</div>
            <p>${esc(c.city || 'Ville à compléter')} · ${plural(c.orders, 'commande', 'commandes')}</p>
            ${canWrite && !c.archived ? `<label class="cl-sr" for="clStage-${esc(c.id)}">Étape de ${esc(c.name)}</label><select id="clStage-${esc(c.id)}" data-stage="${esc(c.id)}">${Object.entries(STAGES).map(([k, val]) => `<option value="${k}" ${c.stage === k ? 'selected' : ''}>${val[0]}</option>`).join('')}</select>` : ''}
          </article>`).join('') : '<p class="cl-lane-empty">Aucun client à cette étape.</p>'}</div></section>`;
      }).join('')}</div>`;
    }
    function pagination(n) {
      const max = Math.max(1, Math.ceil(n / st.size));
      const pages = [];
      for (let i = 1; i <= max; i += 1) if (i === 1 || i === max || Math.abs(i - st.page) <= 1) pages.push(i); else if (pages[pages.length - 1] !== '…') pages.push('…');
      return `<div class="cl-pagination"><span>${(st.page - 1) * st.size + 1}–${Math.min(st.page * st.size, n)} sur ${plural(n, 'client', 'clients')}</span>
        <div class="cl-page-buttons"><button type="button" data-page="${st.page - 1}" ${st.page === 1 ? 'disabled' : ''} aria-label="Page précédente">${ic('chevron-left')}</button>
        ${pages.map((p) => (p === '…' ? '<span class="cl-ellipsis">…</span>' : `<button type="button" data-page="${p}" aria-label="Page ${p}" ${st.page === p ? 'aria-current="page"' : ''}>${p}</button>`)).join('')}
        <button type="button" data-page="${st.page + 1}" ${st.page === max ? 'disabled' : ''} aria-label="Page suivante">${ic('chevron-right')}</button></div>
        <label><select id="clPageSize" aria-label="Clients par page">${[6, 12, 24].map((k) => `<option value="${k}" ${st.size === k ? 'selected' : ''}>${k}</option>`).join('')}</select> par page</label></div>`;
    }
    function confirmHtml() {
      const { type, ids } = st.confirm;
      const n = ids.length;
      const title = { delete: 'Supprimer', archive: 'Archiver', restore: 'Restaurer' }[type];
      const text = {
        delete: 'Les fiches quittent toutes les vues du carnet. Leurs commandes et leur historique sont conservés, et vous pouvez annuler juste après.',
        archive: 'Vous les retrouverez dans la vue Archivés.',
        restore: 'Les fiches retrouvent leur place dans votre carnet.',
      }[type];
      return `<div class="cl-confirm" role="alert"><div><strong>${title} ${plural(n, 'fiche', 'fiches')} ?</strong><p>${text}</p></div><div>${btn('cancel-confirm', 'Annuler')}${btn('confirm', type === 'delete' ? `Supprimer ${n > 1 ? 'les fiches' : 'la fiche'}` : title, null, type === 'delete' ? 'danger-fill' : 'primary', st.busy ? 'disabled' : '')}</div></div>`;
    }

    // ---------- Formulaire fiche (création et modification)
    const field = (label, name, value = '', type = 'text', attrs = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
    function profileForm(c, creating) {
      const autoStage = c.autoStage ? ` (${STAGES[c.autoStage]?.[0] || ''})` : '';
      return `<form id="clProfileForm" class="cl-edit-form" novalidate><div class="cl-form-grid">
        ${field('Nom du client *', 'displayName', c.name || '', 'text', 'required maxlength="160" autocomplete="off"')}
        <label>Type de client<select name="customerType"><option value="person" ${c.type !== 'organization' ? 'selected' : ''}>Particulier</option><option value="organization" ${c.type === 'organization' ? 'selected' : ''}>Entreprise</option></select></label>
        ${field('Téléphone', 'phone', c.phone || '', 'tel', 'inputmode="tel" autocomplete="off" placeholder="01 97 12 34 56"')}
        ${field('E-mail', 'email', c.email || '', 'email', 'inputmode="email" autocomplete="off"')}
        <label>Étape<select name="stage"><option value="auto" ${!c.stageManual ? 'selected' : ''}>Automatique${esc(autoStage)}</option>${Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${c.stageManual === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select></label>
        ${field('Ville principale', 'city', c.city || '', 'text', 'maxlength="120" placeholder="Ex. Cotonou"')}
      </div>
      <details ${creating ? '' : 'open'}><summary>Informations complémentaires</summary><div class="cl-form-grid">
        ${field('Secteur d’activité', 'sector', c.sector || '', 'text', 'maxlength="120"')}
        ${field('Langue préférée', 'language', c.language || '', 'text', 'maxlength="35" placeholder="Ex. Français, Fon"')}
        <label>Canal préféré<select name="channel"><option value="">Aucun en particulier</option>${Object.entries(CHANNELS).map(([k, v]) => `<option value="${k}" ${c.channel === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        ${field('Étiquettes, séparées par une virgule', 'tags', (c.tags || []).join(', '), 'text', 'maxlength="300"')}
      </div>
      <label>Consigne habituelle pour le livreur<textarea name="driverInstructions" rows="3" maxlength="1000" placeholder="Ex. Appeler à l’arrivée, entrer par le portail de droite.">${esc(c.driverInstructions || '')}</textarea></label></details>
      <p class="cl-form-help">${creating ? 'Le nom suffit pour créer une fiche. Ajoutez un téléphone dès que vous le connaissez : il évite les doublons.' : 'Ces informations sont partagées avec votre équipe. Les notes internes restent dans l’onglet Notes et activité.'}</p>
      <div id="clFormError" class="cl-form-error" role="alert">${st.dup ? dupHtml() : ''}</div>
      <div class="cl-form-actions"><button class="cl-btn primary" type="submit" ${st.busy ? 'disabled' : ''}>${creating ? 'Créer la fiche' : 'Enregistrer les modifications'}</button>${btn(creating ? 'back' : 'cancel-editor', 'Annuler')}</div></form>`;
    }
    function dupHtml() {
      const d = st.dup;
      return `<p>Ce téléphone est déjà lié à <strong>${esc(d.name)}</strong> (${esc(cid(d.id))}${d.archived ? ', archivée' : ''}).</p>
        <div class="cl-dup-actions"><button type="button" class="cl-btn" data-open="${esc(d.id)}">Ouvrir sa fiche</button><button type="button" class="cl-btn" data-act="save-anyway">Le numéro est partagé : enregistrer quand même</button></div>`;
    }
    function newPage() {
      const c = st.draft || {};
      return `${btn('back', 'Retour aux clients', 'arrow-left', 'cl-back')}
        <div class="cl-form-page"><div class="cl-form-intro"><span class="cl-eyebrow">Nouveau client</span><h1>Commençons par son nom.</h1><p>Vous compléterez sa fiche au fil des livraisons.</p>
          <div class="cl-form-aside">${ic('contact')}<p>Une personne ou une entreprise : une seule fiche pour retrouver ses contacts, ses lieux de livraison et ses commandes.</p></div></div>
        <section class="cl-surface">${profileForm(c, true)}</section></div>`;
    }

    // ---------- Fiche client
    function detailModel() {
      const d = detail;
      const c = d.customer;
      const phones = d.contacts.filter((x) => x.kind === 'phone' && x.is_active);
      const primaryPhone = phones.find((x) => x.is_primary) || phones[0];
      const email = d.contacts.find((x) => x.kind === 'email' && x.is_active);
      const places = d.locations.filter((l) => l.is_active);
      const usual = places.find((l) => String(l.id) === String(c.default_location_id)) || null;
      return {
        id: String(c.id), name: c.display_name, type: c.customer_type === 'organization' ? 'organization' : 'person', sector: c.sector || '',
        phone: primaryPhone?.value_display || '', phoneContactId: primaryPhone?.id, email: email?.value_display || '',
        stage: c.stage, stageManual: c.pipeline_stage || null, autoStage: c.stage_source === 'auto' ? c.stage : null,
        archived: c.status === 'archived', merged: c.status === 'merged', mergedInto: c.merged_into_customer_id, removed: Boolean(c.removed_at),
        city: c.main_city || places[0]?.locality || '', mainCity: c.main_city || '', language: c.preferred_language || '', channel: c.preferred_channel || '',
        tags: c.tags || [], driverInstructions: c.driver_instructions || '', origin: c.origin, createdAt: c.created_at, createdBy: c.created_by_name,
        extraContacts: phones.filter((x) => !x.is_primary), places, usual: usual || places[0] || null, usualIsSet: Boolean(usual),
        orders: d.orders, counters: d.counters, notes: d.interactions.filter((i) => i.channel === 'internal'), activity: d.activity,
      };
    }
    function detailPage() {
      if (!detail) return '';
      const c = detailModel();
      const editable = canWrite && !c.removed && !c.merged;
      const tabs = [['overview', 'Aperçu'], ['contacts', 'Contacts'], ['places', 'Lieux'], ['orders', 'Commandes'], ['activity', 'Notes et activité']];
      return `${btn('back', 'Tous les clients', 'arrow-left', 'cl-back')}
        <div id="clFlash">${flashHtml()}</div>
        ${c.merged ? `<div class="cl-notice">Cette fiche a été regroupée avec une autre. ${c.mergedInto ? `<button type="button" class="cl-linkish" data-open="${esc(c.mergedInto)}">Ouvrir la fiche principale</button>` : ''}</div>` : ''}
        ${c.removed ? `<div class="cl-notice">Cette fiche a été supprimée du carnet. Ses commandes restent consultables.${isLead ? ' <button type="button" class="cl-linkish" data-act="unremove-one">Annuler la suppression</button>' : ''}</div>` : ''}
        <div class="cl-detail-heading"><div class="cl-detail-identity">${avatar(c)}<div><div class="cl-detail-meta">${cid(c.id)} · ${c.type === 'organization' ? 'Entreprise' : 'Particulier'} ${badge(c)}</div><h1>${esc(c.name)}</h1><p>${esc(c.city || 'Ville à compléter')}${c.sector ? ` · ${esc(c.sector)}` : ''}</p></div></div>
          <div class="cl-heading-actions">${editable && !c.archived ? `<a class="cl-btn primary" href="/app/nouvelle-commande?client=${encodeURIComponent(c.id)}">${ic('plus')}Nouvelle commande</a>` : ''}
            ${btn('copy-phone', 'Copier le téléphone', 'phone')}
            ${editable ? btn('edit', 'Modifier', 'pencil') : ''}
            ${editable ? btn(c.archived ? 'restore-one' : 'archive-one', c.archived ? 'Restaurer' : 'Archiver', 'archive') : ''}</div></div>
        <div class="cl-detail-tabs" role="tablist" aria-label="Rubriques de la fiche">${tabs.map(([k, v]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${st.detailTab === k}">${v}${k === 'places' ? ` <b>${c.places.length}</b>` : k === 'orders' ? ` <b>${c.counters.orders}</b>` : ''}</button>`).join('')}</div>
        ${st.confirm ? confirmHtml() : ''}
        ${st.editor === 'profile' ? `<section class="cl-surface cl-profile-editor"><h2>Modifier les informations</h2>${profileForm(c, false)}</section>`
          : st.detailTab === 'overview' ? overview(c, editable) : st.detailTab === 'contacts' ? contactsTab(c, editable)
            : st.detailTab === 'places' ? placesTab(c, editable) : st.detailTab === 'orders' ? ordersTab(c) : activityTab(c, editable)}`;
    }
    function overview(c, editable) {
      const k = c.counters;
      const last = c.notes[0];
      return `<div class="cl-detail-grid"><section class="cl-summary"><h2>À propos</h2><dl>
          <div><dt>Téléphone</dt><dd>${esc(c.phone || 'Non renseigné')}</dd></div>
          <div><dt>E-mail</dt><dd>${esc(c.email || 'Non renseigné')}</dd></div>
          <div><dt>Canal préféré</dt><dd>${esc(CHANNELS[c.channel] || 'Non précisé')}</dd></div>
          <div><dt>Langue</dt><dd>${esc(c.language || 'Non renseignée')}</dd></div>
          <div><dt>Origine de la fiche</dt><dd>${esc(ORIGIN[c.origin] || 'Création manuelle')}</dd></div>
          <div><dt>Client depuis</dt><dd>${esc(dLong(k.firstOrderAt && new Date(k.firstOrderAt) < new Date(c.createdAt) ? k.firstOrderAt : c.createdAt))}</dd></div>
        </dl><div class="cl-tags">${c.tags.map((t) => `<span>${esc(t)}</span>`).join('') || '<small>Aucune étiquette</small>'}</div>
        <div class="cl-instructions"><h3>Pour le livreur</h3><p>${esc(c.driverInstructions || 'Aucune consigne particulière pour le moment.')}</p>${c.driverInstructions ? '<small>Reprise dans la consigne de chaque nouvelle commande créée depuis cette fiche.</small>' : ''}</div></section>
        <div class="cl-detail-main">
          <div class="cl-activity-strip"><div><strong>${k.orders}</strong><span>commande${k.orders > 1 ? 's' : ''}</span></div><div><strong>${k.delivered}</strong><span>livrée${k.delivered > 1 ? 's' : ''}</span></div><div><strong>${k.active}</strong><span>en cours</span></div><div><strong>${c.places.length}</strong><span>lieu${c.places.length > 1 ? 'x' : ''} enregistré${c.places.length > 1 ? 's' : ''}</span></div></div>
          ${duplicates.length ? `<section class="cl-section cl-dups"><div class="cl-section-heading"><div><h2>Même téléphone sur d’autres fiches</h2><p>Un numéro partagé n’est pas forcément la même personne. Regroupez seulement si c’est bien le même client : ses commandes rejoindront cette fiche.</p></div></div>
            ${duplicates.map((x) => `<div class="cl-dup-row">${avatar({ name: x.display_name })}<div><strong>${esc(x.display_name)}</strong><small>${esc(cid(x.id))} · ${plural(x.order_count, 'commande', 'commandes')}${x.status === 'archived' ? ' · archivée' : ''}</small></div><button type="button" class="cl-btn" data-open="${esc(x.id)}">Ouvrir</button>${editable ? `<button type="button" class="cl-btn" data-merge="${esc(x.id)}" data-merge-name="${esc(x.display_name)}">${ic('merge')}Regrouper ici</button>` : ''}</div>`).join('')}</section>` : ''}
          <section class="cl-section"><div class="cl-section-heading"><h2>Dernières commandes</h2><button type="button" class="cl-section-link" data-tab="orders">Tout voir ${ic('arrow-right')}</button></div>${orderTable(c.orders.slice(0, 3))}</section>
          <section class="cl-section"><div class="cl-section-heading"><h2>Lieu habituel</h2><button type="button" class="cl-section-link" data-tab="places">Gérer les lieux ${ic('arrow-right')}</button></div>${c.usual ? placeCard(c.usual, c, false) : '<p class="cl-quiet">Ajoutez une adresse depuis l’onglet Lieux.</p>'}</section>
          <section class="cl-section"><div class="cl-section-heading"><h2>Dernière note</h2><button type="button" class="cl-section-link" data-tab="activity">${editable ? `Ajouter une note ${ic('plus')}` : `Voir les notes ${ic('arrow-right')}`}</button></div>${last ? `<p class="cl-note-text">${esc(last.summary)}</p><small>${esc(last.author_name || 'Équipe')} · ${esc(dTime(last.occurred_at))}</small>` : '<p class="cl-quiet">Les informations utiles à l’équipe trouveront leur place ici.</p>'}</section>
        </div></div>`;
    }
    function orderTable(rows) {
      if (!rows.length) return '<p class="cl-quiet">Aucune commande pour ce client pour le moment.</p>';
      return `<div class="cl-order-wrap"><table class="cl-order-table"><thead><tr><th>Commande</th><th>Statut</th><th>Livraison</th><th>Livreur</th></tr></thead><tbody>
        ${rows.map((o) => `<tr><td><a href="/app/operations?vue=commandes&commande=${encodeURIComponent(o.id)}">${esc(o.reference || `CMD-${o.id}`)}</a><small>${esc(dShort(o.created_at))}</small></td>
          <td><span class="cl-badge ${ORDER_TONE(o.status)}">${esc(o.status)}</span></td><td>${esc(o.location_label && !/^Livraison commande/.test(o.location_label) ? o.location_label : o.neighborhood || '—')}</td><td>${esc(o.driver_name || 'À attribuer')}${o.driver_name && !['En préparation', 'Confirmée'].includes(o.status) ? `<small><a href="/app/carte?commande=${encodeURIComponent(o.id)}">Voir le trajet</a></small>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
    }
    function ordersTab(c) {
      const statuses = [...new Set(c.orders.map((o) => o.status))];
      const rows = st.orderFilter === 'all' ? c.orders : c.orders.filter((o) => o.status === st.orderFilter);
      return `<section class="cl-section"><div class="cl-section-heading"><div><h2>Les commandes de ${esc(c.name)}</h2><p>L’historique de ses livraisons, au même endroit${c.orders.length >= 200 ? ' (200 plus récentes)' : ''}.</p></div>
        ${statuses.length > 1 ? `<select id="clOrderFilter" aria-label="Filtrer les commandes"><option value="all">Tous les statuts</option>${statuses.map((s) => `<option value="${esc(s)}" ${st.orderFilter === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}</div>
        <div id="clOrders">${orderTable(rows)}</div></section>`;
    }
    function contactsTab(c, editable) {
      return `<section class="cl-section"><div class="cl-section-heading"><div><h2>Les personnes à joindre</h2><p>Gardez le bon numéro pour chaque interlocuteur.</p></div>${editable ? btn('add-contact', 'Ajouter un contact', 'plus') : ''}</div>
        ${st.editor === 'contact' ? `<form id="clContactForm" class="cl-inline-edit" novalidate><div class="cl-form-grid cl-three">${field('Nom *', 'name', '', 'text', 'required maxlength="120" autocomplete="off"')}${field('Téléphone *', 'phone', '', 'tel', 'required inputmode="tel" autocomplete="off"')}${field('Rôle ou précision', 'role', '', 'text', 'maxlength="80" placeholder="Ex. Réception des colis"')}</div><div id="clContactError" role="alert" class="cl-form-error"></div><div class="cl-form-actions"><button class="cl-btn primary" type="submit">Ajouter le contact</button>${btn('cancel-editor', 'Annuler')}</div></form>` : ''}
        <div class="cl-contact-list"><article><span class="cl-symbol">${ic('user')}</span><div><h3>${esc(c.name)}</h3><p>${esc(c.phone || 'Téléphone à compléter')}${c.email ? ` · ${esc(c.email)}` : ''}</p><small>Contact principal</small></div>${editable ? btn('edit', 'Modifier', 'pencil') : ''}</article>
        ${c.extraContacts.map((x) => `<article><span class="cl-symbol">${ic('user')}</span><div><h3>${esc(x.contact_name || 'Contact')}</h3><p>${esc(x.value_display)}</p><small>${esc(x.label || 'Contact supplémentaire')}</small></div>${editable ? `<button type="button" class="cl-btn" data-remove-contact="${esc(x.id)}" data-name="${esc(x.contact_name || '')}" aria-label="Retirer ${esc(x.contact_name || 'ce contact')}">${ic('trash')}</button>` : ''}</article>`).join('')}</div></section>`;
    }
    function placeOrigin(p) {
      if (p.has_gps) return `${COORD[p.coordinate_source] || 'Position GPS enregistrée'}${p.accuracy_meters ? ` (± ${Math.round(p.accuracy_meters)} m)` : ''}`;
      return 'Adresse saisie, sans position GPS';
    }
    function placeCard(p, c, actions = true, editable = false) {
      const usual = c.usualIsSet && String(p.id) === String(c.usual?.id);
      const label = /^Livraison commande \d+$/.test(p.label) ? (p.neighborhood || 'Adresse de livraison') : p.label;
      return `<article class="cl-place"><div class="cl-place-heading"><span class="cl-symbol">${ic('pin')}</span><div><h3>${esc(label)}</h3><span>${esc(p.locality || 'Ville à compléter')}</span></div>${usual ? '<span class="cl-badge gray">Lieu habituel</span>' : ''}</div>
        <p>${esc([p.neighborhood, p.address_text].filter(Boolean).join(' — ') || 'Adresse à compléter')}</p>${p.landmark ? `<p class="cl-landmark">Repère : ${esc(p.landmark)}</p>` : ''}
        <small>${esc(placeOrigin(p))}${p.order_count ? ` · ${plural(p.order_count, 'commande', 'commandes')}` : ''}</small>
        ${actions && editable ? `<div class="cl-place-actions">${!usual ? `<button type="button" class="cl-btn" data-usual-place="${esc(p.id)}">Définir comme habituel</button>` : ''}<button type="button" class="cl-btn" data-edit-place="${esc(p.id)}">${ic('pencil')}Modifier</button></div>` : ''}</article>`;
    }
    function placesTab(c, editable) {
      const p = c.places.find((x) => String(x.id) === String(st.editPlaceId)) || {};
      return `<section class="cl-section"><div class="cl-section-heading"><div><h2>Ses lieux de livraison</h2><p>Une adresse claire et un repère font gagner du temps au livreur.</p></div>${editable ? btn('add-place', 'Ajouter un lieu', 'plus') : ''}</div>
        ${st.editor === 'place' ? `<form id="clPlaceForm" class="cl-inline-edit" novalidate><div class="cl-form-grid">
          ${field('Nom du lieu *', 'label', /^Livraison commande \d+$/.test(p.label || '') ? '' : p.label || '', 'text', 'required maxlength="100" placeholder="Ex. Domicile, Bureau"')}
          ${field('Ville', 'city', p.locality || c.mainCity || '', 'text', 'maxlength="200"')}
          ${field('Quartier', 'neighborhood', p.neighborhood || '', 'text', 'maxlength="200"')}
          ${field('Adresse', 'address', p.address_text || '', 'text', 'maxlength="1000"')}
          ${field('Repère utile', 'landmark', p.landmark || '', 'text', 'maxlength="500" placeholder="Ex. portail bleu, près de la pharmacie"')}
          ${!p.id ? '<label class="cl-check"><input type="checkbox" name="isDefault">Lieu habituel</label>' : ''}
        </div>${p.has_gps ? '<p class="cl-form-help">Modifier le quartier ou l’adresse efface la position GPS enregistrée : elle ne correspondrait plus.</p>' : ''}
        <div id="clPlaceError" role="alert" class="cl-form-error"></div><div class="cl-form-actions"><button class="cl-btn primary" type="submit">Enregistrer le lieu</button>${btn('cancel-editor', 'Annuler')}</div></form>` : ''}
        <div class="cl-places-grid">${c.places.map((x) => placeCard(x, c, true, editable)).join('') || '<p class="cl-quiet">Aucun lieu enregistré. Ajoutez sa première adresse.</p>'}</div></section>`;
    }
    function activityTab(c, editable) {
      const events = c.activity.map((a) => ({ text: (ACTIVITY[a.action] || (() => a.action))(a.details || {}), at: a.created_at, who: a.author_name || 'Système' }));
      if (!c.activity.some((a) => a.action === 'created')) events.push({ text: c.origin === 'order' ? 'Fiche créée à la première commande' : c.origin === 'request' ? 'Fiche créée depuis un formulaire client' : 'Fiche client créée', at: c.createdAt, who: c.createdBy || 'Système' });
      return `<div class="cl-notes-layout"><section class="cl-section"><h2>Notes d’équipe</h2>
        ${editable ? `<form id="clNoteForm"><label class="cl-sr" for="clNoteText">Nouvelle note</label><textarea id="clNoteText" name="text" required maxlength="2000" rows="3" placeholder="Une préférence, un repère ou une information à transmettre…"></textarea><div id="clNoteError" class="cl-form-error" role="alert"></div><div class="cl-form-actions"><button class="cl-btn primary" type="submit">Ajouter la note</button></div></form>` : ''}
        <div class="cl-notes">${c.notes.map((n) => `<article><p>${esc(n.summary)}</p><small>${esc(n.author_name || 'Équipe')} · ${esc(dTime(n.occurred_at))}</small></article>`).join('') || '<p class="cl-quiet">Aucune note pour le moment.</p>'}</div></section>
        <section class="cl-section"><h2>Activité de la fiche</h2><div class="cl-timeline">${events.map((h) => `<article><span></span><div><p>${esc(h.text)}</p><small>${esc(h.who)} · ${esc(dTime(h.at))}</small></div></article>`).join('')}</div></section></div>`;
    }

    // ---------- Actions
    function applyView(id) {
      Object.assign(st, { viewId: id, scope: id === 'archived' ? 'archived' : 'current', query: '', filter: blankFilter(), sort: 'recent', page: 1, tool: '', confirm: null });
      if (id === 'follow') st.filter.stage = 'a_relancer';
      if (id === 'repeat') st.filter.frequency = 'recurring';
      const v = views.find((x) => x.id === id);
      if (v) {
        const cfg = v.config || {};
        st.scope = cfg.scope === 'archived' ? 'archived' : 'current';
        st.layout = cfg.layout || st.layout;
        st.size = cfg.pageSize || 12;
        st.query = cfg.q || '';
        st.sort = cfg.sort || 'recent';
        const f = cfg.filters || {};
        st.filter = { stage: f.stage?.[0] || 'all', city: f.city?.[0] || 'all', type: f.type?.[0] || 'all', frequency: f.frequency || 'any' };
        if (Array.isArray(cfg.columns) && cfg.columns.length) st.columns = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, cfg.columns.includes(k)]));
      }
      st.selected.clear();
      draw();
    }
    const viewConfig = () => ({
      layout: st.layout, scope: st.scope, pageSize: st.size, q: st.query, sort: st.sort,
      columns: Object.keys(COLUMNS).filter((k) => st.columns[k]),
      filters: {
        stage: st.filter.stage === 'all' ? [] : [st.filter.stage], city: st.filter.city === 'all' ? [] : [st.filter.city],
        type: st.filter.type === 'all' ? [] : [st.filter.type], frequency: st.filter.frequency,
      },
    });

    async function bulk(action, ids, extra = {}) {
      return json('/api/app/crm/customers/bulk', { action, ids, ...extra });
    }
    async function perform(type, ids) {
      st.busy = true;
      try {
        const action = type === 'delete' ? 'remove' : type;
        const r = await bulk(action, ids);
        await loadList();
        const n = r.done.length;
        const word = { delete: 'supprimée', archive: 'archivée', restore: 'restaurée' }[type];
        const reverse = { delete: 'unremove', archive: 'restore', restore: 'archive' }[type];
        flash(n ? `${plural(n, 'fiche', 'fiches')} ${word}${n > 1 ? 's' : ''}.${r.skipped.length ? ` ${r.skipped.length} déjà dans cet état.` : ''}` : 'Aucune fiche à modifier.', n ? 'ok' : 'warn', n ? { action: reverse, ids: r.done } : null);
        st.selected.clear();
        if (st.screen === 'detail') {
          if (type === 'delete') { st.busy = false; st.confirm = null; return go('/app/clients'); }
          await reloadDetail();
        }
      } catch (error) {
        flash(error.message, 'error', null);
      }
      st.busy = false; st.confirm = null;
      if (st.screen === 'list') draw(); else draw();
    }
    async function changeStage(ids, stage) {
      const before = ids.map((id) => byId(id)).filter(Boolean);
      // Annulation : chaque fiche retrouve son étape (manuelle ou automatique).
      const groups = {};
      before.forEach((c) => { const k = c.stageSource === 'manual' ? c.stage : 'auto'; (groups[k] = groups[k] || []).push(c.id); });
      try {
        const r = await bulk('stage', ids, { stage: stage === 'auto' ? null : stage });
        await loadList();
        flash(`Étape mise à jour pour ${plural(r.done.length, 'fiche', 'fiches')} : ${stage === 'auto' ? 'automatique' : STAGES[stage][0]}.`, 'ok', { action: 'stage', groups });
        st.selected.clear();
      } catch (error) { flash(error.message, 'error', null); }
      draw();
    }
    async function undo() {
      const u = st.undo;
      st.undo = null;
      if (!u) return;
      try {
        if (u.action === 'stage') {
          for (const [stage, ids] of Object.entries(u.groups)) await bulk('stage', ids, { stage: stage === 'auto' ? null : stage });
        } else {
          await bulk(u.action, u.ids);
        }
        await loadList();
        flash('La dernière action a été annulée.', 'ok', null);
        if (st.screen === 'detail') await reloadDetail();
      } catch (error) { flash(error.message, 'error', null); }
      draw();
    }
    async function exportIds(ids) {
      if (!ids.length) { flash('Aucune fiche à exporter.', 'warn'); draw(); return; }
      try {
        const res = await fetch('/api/app/crm/customers/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Export impossible.'); }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        flash(`${plural(ids.length, 'fiche exportée', 'fiches exportées')} en CSV (sans notes ni consignes).`);
      } catch (error) { flash(error.message, 'error'); }
      const zone = $('#clFlash'); if (zone) zone.innerHTML = flashHtml();
    }
    async function copyPhone() {
      const c = detail && detailModel();
      if (!c?.phone) { flash('Ajoutez un téléphone dans les informations du client.', 'warn'); $('#clFlash').innerHTML = flashHtml(); return; }
      try { await navigator.clipboard.writeText(c.phone); flash('Téléphone copié.'); } catch { flash(`Téléphone : ${c.phone}`); }
      $('#clFlash').innerHTML = flashHtml();
    }

    function readProfile(form) {
      const f = new FormData(form);
      const g = (k) => String(f.get(k) || '').trim();
      return {
        name: g('displayName').replace(/\s+/g, ' '), type: g('customerType'), phone: g('phone'), email: g('email'), stage: g('stage'),
        city: g('city'), sector: g('sector'), language: g('language'), channel: g('channel'),
        tags: g('tags').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12), driverInstructions: g('driverInstructions'),
      };
    }
    function validProfile(v, errBox) {
      if (!v.name) { errBox.textContent = 'Indiquez le nom du client.'; return false; }
      if (v.phone && !(/^\+?[\d\s().-]+$/.test(v.phone) && v.phone.replace(/\D/g, '').length >= 8 && v.phone.replace(/\D/g, '').length <= 15)) { errBox.textContent = 'Vérifiez le numéro de téléphone.'; return false; }
      if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) { errBox.textContent = 'Vérifiez l’adresse e-mail.'; return false; }
      if (v.language && v.language.length < 2) { errBox.textContent = 'La langue doit contenir au moins 2 caractères.'; return false; }
      return true;
    }
    async function submitProfile(form, allowDuplicate = false) {
      const errBox = $('#clFormError');
      errBox.textContent = '';
      const v = readProfile(form);
      if (!validProfile(v, errBox)) return;
      const creating = st.screen === 'new';
      st.busy = true;
      form.querySelector('[type="submit"]').disabled = true;
      try {
        if (creating) {
          const r = await json('/api/app/crm/customers', {
            displayName: v.name, customerType: v.type, phone: v.phone, phoneCountry: 'BJ', email: v.email, stage: v.stage === 'auto' ? null : v.stage,
            city: v.city, sector: v.sector, preferredLanguage: v.language, preferredChannel: v.channel || null, tags: v.tags,
            driverInstructions: v.driverInstructions, allowDuplicate,
          });
          st.busy = false; st.dup = null; st.draft = null;
          current = []; archived = [];
          flash('La fiche client est créée.', 'ok', null);
          await go(`/app/clients/${r.id}`, true);
          return;
        }
        const old = detailModel();
        const body = {};
        if (v.name !== old.name) body.displayName = v.name;
        if (v.type !== old.type) body.customerType = v.type;
        if (v.phone !== old.phone) { body.phone = v.phone; body.phoneCountry = 'BJ'; }
        if (v.email !== old.email) body.email = v.email;
        const newStage = v.stage === 'auto' ? null : v.stage;
        if (newStage !== old.stageManual) body.pipelineStage = newStage;
        if (v.city !== old.mainCity) body.mainCity = v.city;
        if (v.sector !== old.sector) body.sector = v.sector;
        if (v.language !== old.language) body.preferredLanguage = v.language;
        if ((v.channel || '') !== (old.channel || '')) body.preferredChannel = v.channel || null;
        if (v.tags.join('|') !== old.tags.join('|')) body.tags = v.tags;
        if (v.driverInstructions !== old.driverInstructions) body.driverInstructions = v.driverInstructions;
        if (!Object.keys(body).length) { st.busy = false; st.editor = ''; flash('Aucune modification à enregistrer.', 'warn'); draw(); return; }
        if (allowDuplicate) body.allowDuplicate = true;
        await json(`/api/app/crm/customers/${encodeURIComponent(old.id)}`, body, 'PATCH');
        st.busy = false; st.dup = null; st.editor = '';
        discardUndo(); current = []; archived = [];
        flash('Les informations ont été enregistrées.', 'ok', null);
        await reloadDetail();
      } catch (error) {
        st.busy = false;
        form.querySelector('[type="submit"]').disabled = false;
        if (error.payload?.code === 'DUPLICATE_PHONE') {
          st.dup = error.payload.duplicate;
          errBox.innerHTML = dupHtml();
        } else errBox.textContent = error.message;
      }
    }

    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.open) { e.preventDefault(); return go(`/app/clients/${b.dataset.open}`); }
      if (b.dataset.view) return applyView(b.dataset.view);
      if (b.dataset.layout) { st.layout = b.dataset.layout; store.set('traxo.clients.layout', st.layout); if (st.layout !== 'list' && st.tool === 'columns') st.tool = ''; st.confirm = null; return draw(); }
      if (b.dataset.page) { st.page = Number(b.dataset.page); drawResults(); $('#clResults')?.scrollIntoView({ block: 'nearest' }); return; }
      if (b.dataset.tab) {
        st.detailTab = b.dataset.tab; st.editor = ''; st.orderFilter = 'all';
        history.replaceState({ cl: true }, '', `/app/clients/${st.detailId}${st.detailTab === 'overview' ? '' : `?onglet=${st.detailTab}`}`);
        return draw();
      }
      if (b.dataset.editPlace) { st.editPlaceId = b.dataset.editPlace; st.editor = 'place'; draw(); $('#clPlaceForm input')?.focus(); return; }
      if (b.dataset.usualPlace) {
        try { await json(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}`, { defaultLocationId: b.dataset.usualPlace }, 'PATCH'); discardUndo(); flash('Le lieu habituel a été mis à jour.'); await reloadDetail(); } catch (error) { flash(error.message, 'error'); draw(); }
        return;
      }
      if (b.dataset.removeContact) {
        const ok = await deps.uiConfirm(`Retirer ${b.dataset.name || 'ce contact'} ?`, { message: 'Le contact quitte la fiche. Les commandes passées ne changent pas.', tone: 'danger', confirmLabel: 'Retirer', cancelLabel: 'Garder' });
        if (!ok) return;
        try { await api(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}/contacts/${encodeURIComponent(b.dataset.removeContact)}`, { method: 'DELETE' }); discardUndo(); flash('Contact retiré.'); await reloadDetail(); } catch (error) { flash(error.message, 'error'); draw(); }
        return;
      }
      if (b.dataset.merge) {
        const ok = await deps.uiConfirm(`Regrouper « ${b.dataset.mergeName} » dans cette fiche ?`, { message: 'Ses commandes et demandes rejoignent cette fiche ; l’autre fiche renverra ici. Faites-le seulement s’il s’agit bien du même client.', confirmLabel: 'Regrouper', cancelLabel: 'Annuler' });
        if (!ok) return;
        try { await json(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}/merge`, { sourceId: b.dataset.merge }); discardUndo(); current = []; archived = []; flash('Les deux fiches sont regroupées.'); await reloadDetail(); } catch (error) { flash(error.message, 'error'); draw(); }
        return;
      }
      const a = b.dataset.act;
      if (!a) return;
      if (a === 'new') return go('/app/clients/nouveau');
      if (a === 'back') { st.editor = ''; return go('/app/clients'); }
      if (a === 'edit') { st.editor = 'profile'; st.dup = null; draw(); $('#clProfileForm input')?.focus(); return; }
      if (a === 'cancel-editor') { st.editor = ''; st.editPlaceId = null; st.dup = null; return draw(); }
      if (a === 'add-contact') { st.editor = 'contact'; draw(); $('#clContactForm input')?.focus(); return; }
      if (a === 'add-place') { st.editor = 'place'; st.editPlaceId = null; draw(); $('#clPlaceForm input')?.focus(); return; }
      if (a === 'copy-phone') return copyPhone();
      if (a === 'save-anyway') { const form = $('#clProfileForm'); if (form) submitProfile(form, true); return; }
      if (a === 'filters' || a === 'columns') { st.tool = st.tool === a ? '' : a; return draw(); }
      if (a === 'new-view' || a === 'edit-view') { st.tool = a; draw(); $('#clViewForm [name="name"]')?.focus({ preventScroll: true }); return; }
      if (a === 'close-tool') { st.tool = ''; return draw(); }
      if (a === 'delete-view') {
        try { await api(`/api/app/ops/views/${encodeURIComponent(st.viewId)}`, { method: 'DELETE' }); await loadViews(); flash('La vue a été supprimée. Les clients sont conservés.', 'ok', null); applyView('all'); } catch (error) { flash(error.message, 'error'); draw(); }
        return;
      }
      if (a === 'reset-filters') { st.filter = blankFilter(); st.selected.clear(); st.page = 1; return draw(); }
      if (a === 'reset-all') return applyView('all');
      if (a === 'clear-selection') { st.selected.clear(); st.confirm = null; return drawResults(); }
      if (a === 'select-all') { filtered().forEach((c) => st.selected.add(c.id)); return drawResults(); }
      if (['archive', 'delete', 'restore'].includes(a)) { st.confirm = { type: a, ids: [...st.selected] }; drawResults(); $('#clConfirm [data-act="confirm"]')?.focus(); return; }
      if (a === 'archive-one' || a === 'restore-one') { st.confirm = { type: a.split('-')[0], ids: [st.detailId] }; draw(); return; }
      if (a === 'unremove-one') { try { await bulk('unremove', [st.detailId]); current = []; archived = []; flash('Suppression annulée : la fiche revient dans le carnet.', 'ok', null); await reloadDetail(); } catch (error) { flash(error.message, 'error'); draw(); } return; }
      if (a === 'cancel-confirm') { st.confirm = null; return st.screen === 'list' ? drawResults() : draw(); }
      if (a === 'confirm' && st.confirm) return perform(st.confirm.type, st.confirm.ids);
      if (a === 'undo') return undo();
      if (a === 'export') return exportIds(filtered().map((c) => c.id));
      if (a === 'export-selected') return exportIds([...st.selected]);
      if (a === 'dismiss') { st.flash = null; const z = $('#clFlash'); if (z) z.innerHTML = ''; }
    });
    root.addEventListener('input', (e) => {
      if (e.target.id === 'clQuery') { st.query = e.target.value; st.page = 1; st.selected.clear(); st.confirm = null; drawResults(); }
    });
    root.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.dataset.pick) { if (t.checked) st.selected.add(t.dataset.pick); else st.selected.delete(t.dataset.pick); return drawResults(); }
      if (t.id === 'clPickPage') { filtered().slice((st.page - 1) * st.size, st.page * st.size).forEach((c) => (t.checked ? st.selected.add(c.id) : st.selected.delete(c.id))); return drawResults(); }
      if (t.id === 'clPageSize') { st.size = Number(t.value); st.page = 1; return drawResults(); }
      if (t.id === 'clSort') { st.sort = t.value; st.page = 1; return drawResults(); }
      if (t.id?.startsWith('clF-')) { st.filter[t.id.slice(4)] = t.value; st.page = 1; st.selected.clear(); st.confirm = null; return draw(); }
      if (t.dataset.column) { st.columns[t.dataset.column] = t.checked; return drawResults(); }
      if (t.dataset.stage) return changeStage([t.dataset.stage], t.value);
      if (t.id === 'clBulkStage' && t.value) return changeStage([...st.selected], t.value);
      if (t.id === 'clOrderFilter') { st.orderFilter = t.value; $('#clOrders').innerHTML = orderTable(st.orderFilter === 'all' ? detail.orders : detail.orders.filter((o) => o.status === st.orderFilter)); }
    });
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const f = new FormData(form);
      const g = (k) => String(f.get(k) || '').trim();
      if (form.id === 'clProfileForm') return submitProfile(form, false);
      if (form.id === 'clViewForm') {
        const name = g('name');
        const err = $('#clViewError');
        if (!name) { err.textContent = 'Donnez un nom à cette vue.'; return; }
        const editing = st.tool === 'edit-view';
        if (views.some((v) => v.name.toLowerCase() === name.toLowerCase() && (!editing || v.id !== st.viewId))) { err.textContent = 'Ce nom est déjà utilisé.'; return; }
        const body = { name, config: viewConfig(), ...(isLead ? { shared: f.get('shared') === 'on' } : {}) };
        try {
          const v = editing ? await json(`/api/app/ops/views/${encodeURIComponent(st.viewId)}`, body, 'PATCH') : await json('/api/app/ops/views', { source: 'clients', ...body });
          await loadViews();
          flash(editing ? 'La vue est mise à jour avec vos réglages actuels.' : 'Vue enregistrée.', 'ok', null);
          applyView(v.id);
        } catch (error) { err.textContent = error.message; }
        return;
      }
      if (form.id === 'clContactForm') {
        const err = $('#clContactError');
        if (!g('name') || !g('phone')) { err.textContent = 'Indiquez un nom et un téléphone.'; return; }
        try { await json(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}/contacts`, { name: g('name'), phone: g('phone'), phoneCountry: 'BJ', role: g('role') }); discardUndo(); st.editor = ''; flash('Contact ajouté.'); await reloadDetail(); } catch (error) { err.textContent = error.message; }
        return;
      }
      if (form.id === 'clPlaceForm') {
        const err = $('#clPlaceError');
        if (!g('label')) { err.textContent = 'Donnez un nom au lieu (ex. Domicile, Bureau).'; return; }
        if (!g('address') && !g('neighborhood')) { err.textContent = 'Indiquez au moins le quartier ou l’adresse.'; return; }
        const body = { label: g('label'), city: g('city'), neighborhood: g('neighborhood'), address: g('address'), landmark: g('landmark'), isDefault: f.get('isDefault') === 'on' };
        try {
          if (st.editPlaceId) await json(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}/locations/${encodeURIComponent(st.editPlaceId)}`, body, 'PATCH');
          else await json(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}/locations`, body);
          discardUndo(); st.editor = ''; st.editPlaceId = null; current = []; archived = [];
          flash('Le lieu de livraison a été enregistré.');
          await reloadDetail();
        } catch (error) { err.textContent = error.message; }
        return;
      }
      if (form.id === 'clNoteForm') {
        const err = $('#clNoteError');
        if (g('text').length < 2) { err.textContent = 'Écrivez votre note.'; return; }
        try { await json(`/api/app/crm/customers/${encodeURIComponent(st.detailId)}/notes`, { text: g('text') }); discardUndo(); flash('Note ajoutée. Elle est visible par votre équipe, jamais par le client.'); await reloadDetail(); } catch (error) { err.textContent = error.message; }
      }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (st.confirm) { st.confirm = null; draw(); } else if (st.editor) { st.editor = ''; draw(); } else if (st.tool) { st.tool = ''; draw(); }
    });
    window.addEventListener('popstate', () => { if (location.pathname.startsWith('/app/clients')) route(); });

    root.innerHTML = '<p class="cl-loading">Chargement des clients…</p>';
    await Promise.all([loadList(), loadViews()]);
    await route();
  }

  window.TraxoClients = { render };
}());
