// Opérations TRAXO (kit « Operations Premium », données réelles).
// Une table dense et une fiche latérale : commandes, incidents, tournées,
// demandes. Vues enregistrées en base, colonnes ajustables, filtres,
// pagination, sélection sur plusieurs pages, corbeille réversible.
// Les actions métier (statuts, preuves, encaissement…) restent dans les
// tiroirs existants, ouverts par « Gérer la livraison ».
(function () {
  'use strict';

  // Icônes Lucide (licence ISC).
  const P = {
    'package': '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /> <path d="M12 22V12" /> <path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" /> <path d="m7.5 4.27 9 5.15" />',
    'circle-alert': '<circle cx="12" cy="12" r="10" /> <line x1="12" x2="12" y1="8" y2="12" /> <line x1="12" x2="12.01" y1="16" y2="16" />',
    'route': '<circle cx="6" cy="19" r="3" /> <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /> <circle cx="18" cy="5" r="3" />',
    'inbox': '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /> <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />',
    'plus': '<path d="M5 12h14" /> <path d="M12 5v14" />',
    'search': '<circle cx="11" cy="11" r="8" /> <path d="m21 21-4.3-4.3" />',
    'columns-3': '<rect width="18" height="18" x="3" y="3" rx="2" /> <path d="M9 3v18" /> <path d="M15 3v18" />',
    'list-filter': '<path d="M3 6h18" /> <path d="M7 12h10" /> <path d="M10 18h4" />',
    'sliders-horizontal': '<line x1="21" x2="14" y1="4" y2="4" /> <line x1="10" x2="3" y1="4" y2="4" /> <line x1="21" x2="12" y1="12" y2="12" /> <line x1="8" x2="3" y1="12" y2="12" /> <line x1="21" x2="16" y1="20" y2="20" /> <line x1="12" x2="3" y1="20" y2="20" /> <line x1="14" x2="14" y1="2" y2="6" /> <line x1="8" x2="8" y1="10" y2="14" /> <line x1="16" x2="16" y1="18" y2="22" />',
    'table-2': '<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18" />',
    'layout-grid': '<rect width="7" height="7" x="3" y="3" rx="1" /> <rect width="7" height="7" x="14" y="3" rx="1" /> <rect width="7" height="7" x="14" y="14" rx="1" /> <rect width="7" height="7" x="3" y="14" rx="1" />',
    'trash-2': '<path d="M3 6h18" /> <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /> <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /> <line x1="10" x2="10" y1="11" y2="17" /> <line x1="14" x2="14" y1="11" y2="17" />',
    'arrow-up-right': '<path d="M7 7h10v10" /> <path d="M7 17 17 7" />',
    'check': '<path d="M20 6 9 17l-5-5" />',
    'bike': '<circle cx="18.5" cy="17.5" r="3.5" /> <circle cx="5.5" cy="17.5" r="3.5" /> <circle cx="15" cy="5" r="1" /> <path d="M12 17.5V14l-3-3 4-3 2 3h2" />',
    'package-check': '<path d="m16 16 2 2 4-4" /> <path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14" /> <path d="m7.5 4.27 9 5.15" /> <polyline points="3.29 7 12 12 20.71 7" /> <line x1="12" x2="12" y1="22" y2="12" />',
    'chevrons-left': '<path d="m11 17-5-5 5-5" /> <path d="m18 17-5-5 5-5" />',
    'chevrons-right': '<path d="m6 17 5-5-5-5" /> <path d="m13 17 5-5-5-5" />',
    'chevron-left': '<path d="m15 18-6-6 6-6" />',
    'chevron-right': '<path d="m9 18 6-6-6-6" />',
    'arrow-left': '<path d="m12 19-7-7 7-7" /> <path d="M19 12H5" />',
    'arrow-right': '<path d="M5 12h14" /> <path d="m12 5 7 7-7 7" />',
    'x': '<path d="M18 6 6 18" /> <path d="m6 6 12 12" />',
    'layers-2': '<path d="m16.02 12 5.48 3.13a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74L7.98 12" /> <path d="M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74Z" />',
    'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /> <polyline points="7 10 12 15 17 10" /> <line x1="12" x2="12" y1="15" y2="3" />',
    'user-round': '<circle cx="12" cy="8" r="5" /> <path d="M20 21a8 8 0 0 0-16 0" />',
    'undo-2': '<path d="M9 14 4 9l5-5" /> <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />',
    'calendar-days': '<path d="M8 2v4" /> <path d="M16 2v4" /> <rect width="18" height="18" x="3" y="4" rx="2" /> <path d="M3 10h18" /> <path d="M8 14h.01" /> <path d="M12 14h.01" /> <path d="M16 14h.01" /> <path d="M8 18h.01" /> <path d="M12 18h.01" /> <path d="M16 18h.01" />',
    'phone': '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />',
    'mail': '<rect width="20" height="16" x="2" y="4" rx="2" /> <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />',
    'map-pin': '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /> <circle cx="12" cy="10" r="3" />',
    'save': '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /> <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /> <path d="M7 3v4a1 1 0 0 0 1 1h7" />',
    'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /> <path d="m15 5 4 4" />',
    'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
    'move-up': '<path d="M8 6L12 2L16 6" /> <path d="M12 2V22" />',
    'move-down': '<path d="M8 18L12 22L16 18" /> <path d="M12 2V22" />',
    'external-link': '<path d="M15 3h6v6" /> <path d="M10 14 21 3" /> <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />',
    'tag': '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /> <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />',
    'circle-dollar-sign': '<circle cx="12" cy="12" r="10" /> <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" /> <path d="M12 18V6" />',
    'sticky-note': '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z" /> <path d="M15 3v4a2 2 0 0 0 2 2h4" />',
    'building-2': '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" /> <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /> <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" /> <path d="M10 6h4" /> <path d="M10 10h4" /> <path d="M10 14h4" /> <path d="M10 18h4" />',
    'clock': '<circle cx="12" cy="12" r="10" /> <polyline points="12 6 12 12 16 14" />',
    'navigation': '<polygon points="3 11 22 2 13 21 11 13 3 11" />',
  };
  const ic = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const pad2 = (n) => String(n).padStart(2, '0');
  const when = (iso) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '—';
    return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const dayOnly = (ymd) => {
    if (!ymd) return '—';
    const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00`);
    return Number.isNaN(d.getTime()) ? String(ymd) : d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  const since = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  };
  const money = (minor, currency) => (minor == null || minor === '' ? '' : `${Number(minor).toLocaleString('fr-FR')} ${!currency || currency === 'XOF' ? 'FCFA' : esc(currency)}`);
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ } },
  };
  // Une cellule ne doit jamais devenir une formule dans un tableur.
  const csvCell = (value) => {
    let t = value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };

  const TERMINAL = ['Livrée', 'Retournée', 'Annulée'];
  const ON_ROAD = ['Vers la collecte', 'Récupérée', 'En tournée', 'En livraison', 'Arrivée'];
  const PRE_PICKUP = ['En préparation', 'Confirmée', 'Vers la collecte'];
  const ORDER_TONE = { 'Livrée': 'green', 'Confirmée': 'amber', 'En préparation': 'amber', 'Vers la collecte': 'amber', 'Récupérée': 'blue', 'En tournée': 'blue', 'En livraison': 'blue', 'Arrivée': 'blue', 'Échec': 'red', 'Retour': 'amber', 'Retournée': 'grey', 'Annulée': 'grey' };
  const REQUEST_LABEL = { 'En attente d’informations': 'En attente du client', 'À confirmer par le client': 'À confirmer par le client', 'À vérifier': 'À valider', 'Informations à compléter': 'À compléter par le client', 'Validée': 'Validée', 'Confirmée': 'Commande créée', 'Refusée': 'Refusée', 'Archivée': 'Archivée' };
  const REQUEST_TONE = { 'À vérifier': 'amber', 'Informations à compléter': 'amber', 'Validée': 'blue', 'Confirmée': 'green', 'Refusée': 'red' };
  const RUN_LABEL = { draft: 'En préparation', planned: 'Planifiée', active: 'En cours', completed: 'Terminée', cancelled: 'Annulée' };
  const RUN_TONE = { active: 'blue', completed: 'green', planned: 'amber', draft: 'grey', cancelled: 'grey' };
  const INC_CATEGORY = { client_injoignable: 'Client injoignable', adresse: 'Adresse ou accès', colis: 'Colis endommagé ou manquant', paiement: 'Paiement', vehicule: 'Véhicule', gps: 'GPS ou connexion', autre: 'Autre' };
  const INC_SEVERITY = { low: 'Faible', medium: 'Moyenne', high: 'Élevée' };
  const INC_STATUS = { open: 'Ouvert', resolved: 'Résolu' };
  const INC_EVENT = { opened: 'Incident déclaré', note_added: 'Note ajoutée', assigned: 'Responsable attribué', resolved: 'Incident résolu', retention_hold_placed: 'Gel de conservation activé', retention_hold_released: 'Gel de conservation levé' };
  const PAYMENT_LABEL = { pending: 'À encaisser', collected: 'Encaissé', discrepancy: 'Écart à vérifier', reconciled: 'Rapproché', not_required: 'Non requis' };
  const TRACKING_LABEL = { active: 'Lien de suivi actif', expired: 'Lien de suivi expiré', revoked: 'Lien de suivi désactivé', rotated: 'Lien de suivi renouvelé' };
  let PACKAGE_LABEL = {};

  const chip = (label, tone) => (label ? `<span class="ops-chip ops-${tone || 'grey'}">${esc(label)}</span>` : '<span class="ops-dim">—</span>');
  const avatar = (name, tone) => `<span class="ops-av ops-av-${tone || (initials(name).charCodeAt(0) % 4)}">${esc(initials(name))}</span>`;
  const person = (name) => (name ? `<span class="ops-person">${avatar(name, 'n')}<span>${esc(name)}</span></span>` : '<span class="ops-dim">À attribuer</span>');

  // Suivi en quatre étapes, déduit du statut réel de la commande.
  const STEPS = [['check', 'Confirmée'], ['package', 'Colis récupéré'], ['bike', 'En route'], ['package-check', 'Livrée']];
  function orderStage(status) {
    if (status === 'Livrée') return { done: 4, tone: 'ok' };
    if (status === 'Annulée' || status === 'Retournée') return { done: 0, tone: 'off' };
    if (status === 'Échec' || status === 'Retour') return { done: 2, current: 2, tone: 'bad' };
    if (status === 'Arrivée') return { done: 3, current: 3, tone: 'ok' };
    if (['Récupérée', 'En tournée', 'En livraison'].includes(status)) return { done: 2, current: 2, tone: 'ok' };
    if (status === 'Confirmée' || status === 'Vers la collecte') return { done: 1, current: 1, tone: 'ok' };
    return { done: 0, current: 0, tone: 'ok' };
  }
  function steps(status) {
    const s = orderStage(status);
    return `<span class="ops-steps ops-steps-${s.tone}" title="${esc(status)}">${STEPS.map(([icon, label], i) => {
      const cls = i < s.done ? 'done' : i === s.current ? 'now' : '';
      return `<span class="ops-step ${cls}" aria-label="${esc(label)}${cls === 'done' ? ' : fait' : cls === 'now' ? ' : en cours' : ''}">${ic(icon)}</span>`;
    }).join('')}</span>`;
  }
  const bar = (pct) => `<span class="ops-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>`;

  const orderRef = (r) => r.reference || `CMD-${r.id}`;
  const SOURCES = {
    commandes: {
      label: 'Commandes', icon: 'package', count: 'orders', trashCount: 'orders_trash',
      placeholder: 'Un client, une commande…',
      endpoint: (trash) => (trash ? '/api/app/orders?trash=1' : '/api/app/orders'),
      pills: [
        ['all', 'Toutes', () => true],
        ['todo', 'À préparer', (r) => ['En préparation', 'Confirmée'].includes(r.status)],
        ['road', 'En cours', (r) => ON_ROAD.includes(r.status)],
        ['issue', 'À traiter', (r) => ['Échec', 'Retour'].includes(r.status)],
        ['done', 'Livrées', (r) => r.status === 'Livrée'],
      ],
      columns: [
        { key: 'client', label: 'Client / Référence', required: true, cell: (r) => `<span class="ops-who">${avatar(r.customer_name)}<span><b>${esc(r.customer_name || '—')}</b><small>${esc(orderRef(r))}</small></span></span>`, text: (r) => `${r.customer_name || ''} ${orderRef(r)}`, sort: (r) => (r.customer_name || '').toLowerCase() },
        { key: 'phone', label: 'Téléphone', cell: (r) => esc(r.customer_phone || '—'), text: (r) => r.customer_phone },
        { key: 'destination', label: 'Destination', cell: (r) => `<span class="ops-two"><span>${esc(r.neighborhood || r.landmark || '—')}</span>${r.requested_time ? `<small>${esc(r.requested_time)}</small>` : ''}</span>`, text: (r) => [r.neighborhood || r.landmark, r.requested_time].filter(Boolean).join(' · '), sort: (r) => (r.neighborhood || '').toLowerCase() },
        { key: 'driver', label: 'Livreur', cell: (r) => person(r.driver_name), text: (r) => r.driver_name, sort: (r) => (r.driver_name || '').toLowerCase() },
        { key: 'suivi', label: 'Suivi', cell: (r) => steps(r.status), text: (r) => r.status },
        { key: 'status', label: 'Statut', cell: (r) => chip(r.status, ORDER_TONE[r.status]), text: (r) => r.status, sort: (r) => r.status || '' },
        { key: 'package', label: 'Colis', cell: (r) => `<span class="ops-two"><span>${esc(PACKAGE_LABEL[r.package_type] || (r.package_type ? r.package_type : '—'))}</span>${r.package_description ? `<small>${esc(r.package_description)}</small>` : ''}</span>`, text: (r) => [PACKAGE_LABEL[r.package_type] || r.package_type, r.package_description].filter(Boolean).join(' · ') },
        { key: 'pickup', label: 'Collecte', cell: (r) => (r.has_pickup ? chip('À récupérer', 'amber') : '<span class="ops-dim">Non</span>'), text: (r) => (r.has_pickup ? 'À récupérer' : 'Non') },
        { key: 'amount', label: 'À encaisser', cell: (r) => (r.expected_amount_minor != null ? `<b class="ops-num">${money(r.expected_amount_minor, r.payment_currency)}</b>` : '<span class="ops-dim">—</span>'), text: (r) => (r.expected_amount_minor != null ? money(r.expected_amount_minor, r.payment_currency) : ''), sort: (r) => Number(r.expected_amount_minor || 0) },
        { key: 'date', label: 'Date', cell: (r) => `<span class="ops-num">${esc(when(r.created_at))}</span>`, text: (r) => when(r.created_at), sort: (r) => +new Date(r.created_at) },
      ],
      defaults: ['client', 'destination', 'driver', 'suivi', 'status', 'date'],
      compact: ['client', 'suivi', 'status'],
      status: (r) => r.status,
      statusValues: ['En préparation', 'Confirmée', 'Vers la collecte', 'Récupérée', 'En tournée', 'En livraison', 'Arrivée', 'Livrée', 'Échec', 'Retour', 'Retournée', 'Annulée'],
      statusLabel: (s) => s,
      zone: (r) => r.neighborhood || '',
      driver: (r) => (r.driver_id ? [String(r.driver_id), r.driver_name] : null),
      text: (r) => `${orderRef(r)} ${r.id} ${r.customer_name || ''} ${r.customer_phone || ''} ${r.neighborhood || ''} ${r.landmark || ''} ${r.driver_name || ''} ${r.status || ''} ${r.package_description || ''}`,
      trashable: (r) => TERMINAL.includes(r.status),
      trashNote: 'Seules les commandes livrées, annulées ou retournées vont dans la corbeille.',
      assign: true, fiche: ['livraison', 'client', 'colis', 'activite'],
      create: { label: 'Nouvelle commande', href: '/app/nouvelle-commande' },
      sort: { key: 'date', dir: -1 },
    },
    incidents: {
      label: 'Incidents', icon: 'circle-alert', count: 'open_incidents', trashCount: 'incidents_trash',
      placeholder: 'Un incident, une commande, un client…',
      endpoint: (trash) => `/api/app/incidents?scope=all${trash ? '&trash=1' : ''}`,
      pills: [
        ['all', 'Tous', () => true],
        ['open', 'À traiter', (r) => r.status !== 'resolved'],
        ['resolved', 'Résolus', (r) => r.status === 'resolved'],
      ],
      columns: [
        { key: 'incident', label: 'Incident', required: true, cell: (r) => `<span class="ops-who"><span class="ops-av ops-av-alert">${ic('circle-alert')}</span><span><b>${esc(INC_CATEGORY[r.category] || r.category)}</b><small>INC-${esc(r.id)}</small></span></span>`, text: (r) => `${INC_CATEGORY[r.category] || r.category} INC-${r.id}`, sort: (r) => r.category || '' },
        { key: 'order', label: 'Commande', cell: (r) => `<span class="ops-two"><span>${esc(r.customer_name || '—')}</span><small>${esc(r.order_reference || `CMD-${r.order_id}`)}</small></span>`, text: (r) => `${r.customer_name || ''} ${r.order_reference || `CMD-${r.order_id}`}` },
        { key: 'zone', label: 'Zone', cell: (r) => esc(r.neighborhood || '—'), text: (r) => r.neighborhood, sort: (r) => (r.neighborhood || '').toLowerCase() },
        { key: 'driver', label: 'Livreur', cell: (r) => person(r.driver_name), text: (r) => r.driver_name, sort: (r) => (r.driver_name || '').toLowerCase() },
        { key: 'assignee', label: 'Suivi par', cell: (r) => (r.assigned_to ? esc(r.assigned_to) : '<span class="ops-dim">Personne</span>'), text: (r) => r.assigned_to },
        { key: 'severity', label: 'Priorité', cell: (r) => chip(INC_SEVERITY[r.severity] || r.severity, r.severity === 'high' ? 'red' : r.severity === 'medium' ? 'amber' : 'grey'), text: (r) => INC_SEVERITY[r.severity] || r.severity, sort: (r) => ({ high: 0, medium: 1, low: 2 }[r.severity] ?? 3) },
        { key: 'status', label: 'Statut', cell: (r) => chip(INC_STATUS[r.status] || r.status, r.status === 'resolved' ? 'green' : 'red'), text: (r) => INC_STATUS[r.status] || r.status, sort: (r) => r.status || '' },
        { key: 'date', label: 'Date', cell: (r) => `<span class="ops-num">${esc(when(r.created_at))}</span>`, text: (r) => when(r.created_at), sort: (r) => +new Date(r.created_at) },
      ],
      defaults: ['incident', 'order', 'driver', 'severity', 'status', 'date'],
      compact: ['incident', 'status'],
      status: (r) => r.status,
      statusValues: ['open', 'resolved'],
      statusLabel: (s) => INC_STATUS[s] || s,
      zone: (r) => r.neighborhood || '',
      driver: (r) => (r.driver_id ? [String(r.driver_id), r.driver_name] : null),
      text: (r) => `INC-${r.id} ${INC_CATEGORY[r.category] || r.category} ${r.order_reference || ''} ${r.customer_name || ''} ${r.customer_phone || ''} ${r.neighborhood || ''} ${r.driver_name || ''} ${INC_STATUS[r.status] || r.status}`,
      trashable: (r) => r.status === 'resolved',
      trashNote: 'Seuls les incidents résolus vont dans la corbeille.',
      fiche: ['incident', 'client', 'activite'],
      create: { label: 'Signaler un incident', action: 'newIncident' },
      sort: { key: 'date', dir: -1 },
    },
    tournees: {
      label: 'Tournées', icon: 'route', count: 'open_runs',
      placeholder: 'Une tournée, un livreur…',
      endpoint: () => '/api/app/runs',
      pills: [
        ['all', 'Toutes', () => true],
        ['open', 'En cours', (r) => ['draft', 'planned', 'active'].includes(r.status)],
        ['done', 'Terminées', (r) => r.status === 'completed'],
      ],
      columns: [
        { key: 'name', label: 'Tournée', required: true, cell: (r) => `<span class="ops-who"><span class="ops-av ops-av-route">${ic('route')}</span><span><b>${esc(r.name || `Tournée ${r.id}`)}</b><small>TRN-${esc(r.id)}</small></span></span>`, text: (r) => r.name || `Tournée ${r.id}`, sort: (r) => (r.name || '').toLowerCase() },
        { key: 'driver', label: 'Livreur', cell: (r) => person(r.driver_name), text: (r) => r.driver_name, sort: (r) => (r.driver_name || '').toLowerCase() },
        { key: 'day', label: 'Jour', cell: (r) => esc(dayOnly(r.service_date)), text: (r) => dayOnly(r.service_date), sort: (r) => r.service_date || '' },
        { key: 'stops', label: 'Arrêts', cell: (r) => `<span class="ops-num">${esc(r.terminal_stop_count)} / ${esc(r.stop_count)}</span>`, text: (r) => `${r.terminal_stop_count} / ${r.stop_count}`, sort: (r) => Number(r.stop_count) },
        { key: 'progress', label: 'Avancement', cell: (r) => { const t = Number(r.stop_count) || 0; return bar(t ? Math.round((Number(r.terminal_stop_count) / t) * 100) : 0); }, text: (r) => { const t = Number(r.stop_count) || 0; return t ? `${Math.round((Number(r.terminal_stop_count) / t) * 100)} %` : '0 %'; } },
        { key: 'status', label: 'État', cell: (r) => chip(RUN_LABEL[r.status] || r.status, RUN_TONE[r.status]), text: (r) => RUN_LABEL[r.status] || r.status, sort: (r) => r.status || '' },
      ],
      defaults: ['name', 'driver', 'day', 'stops', 'progress', 'status'],
      compact: ['name', 'status'],
      status: (r) => r.status,
      statusValues: ['draft', 'planned', 'active', 'completed', 'cancelled'],
      statusLabel: (s) => RUN_LABEL[s] || s,
      zone: () => '',
      driver: (r) => (r.driver_id ? [String(r.driver_id), r.driver_name] : null),
      text: (r) => `${r.name || ''} TRN-${r.id} ${r.driver_name || ''} ${RUN_LABEL[r.status] || ''}`,
      sort: { key: 'day', dir: -1 },
    },
    demandes: {
      label: 'Demandes', icon: 'inbox', count: 'active_requests', trashCount: 'requests_trash',
      placeholder: 'Un client, une demande…',
      endpoint: (trash) => (trash ? '/api/app/requests?scope=archived' : '/api/app/requests'),
      pills: [
        ['all', 'Toutes', () => true],
        ['review', 'À valider', (r) => r.status === 'À vérifier'],
        ['wait', 'Chez le client', (r) => ['En attente d’informations', 'Informations à compléter', 'À confirmer par le client'].includes(r.status)],
        ['ok', 'Validées', (r) => ['Validée', 'Confirmée'].includes(r.status)],
      ],
      columns: [
        { key: 'client', label: 'Client / Demande', required: true, cell: (r) => `<span class="ops-who">${avatar(r.customer_name || '?')}<span><b>${esc(r.customer_name || 'En attente du client')}</b><small>DEM-${esc(r.id)}</small></span></span>`, text: (r) => `${r.customer_name || ''} DEM-${r.id}`, sort: (r) => (r.customer_name || '').toLowerCase() },
        { key: 'phone', label: 'Téléphone', cell: (r) => esc(r.customer_phone || '—'), text: (r) => r.customer_phone },
        { key: 'zone', label: 'Destination', cell: (r) => `<span class="ops-two"><span>${esc(r.neighborhood || '—')}</span>${r.landmark ? `<small>${esc(r.landmark)}</small>` : ''}</span>`, text: (r) => [r.neighborhood, r.landmark].filter(Boolean).join(' · '), sort: (r) => (r.neighborhood || '').toLowerCase() },
        { key: 'position', label: 'Position', cell: (r) => (r.location_lat != null ? chip('Partagée', 'green') : chip(r.submitted_at ? 'Manquante' : 'Pas encore', r.submitted_at ? 'red' : 'grey')), text: (r) => (r.location_lat != null ? 'Partagée' : 'Manquante') },
        { key: 'package', label: 'Colis', cell: (r) => esc(PACKAGE_LABEL[r.package_type] || r.package_type || '—'), text: (r) => PACKAGE_LABEL[r.package_type] || r.package_type },
        { key: 'status', label: 'Statut', cell: (r) => chip(REQUEST_LABEL[r.status] || r.status, REQUEST_TONE[r.status]), text: (r) => REQUEST_LABEL[r.status] || r.status, sort: (r) => r.status || '' },
        { key: 'date', label: 'Date', cell: (r) => `<span class="ops-num">${esc(when(r.created_at))}</span>`, text: (r) => when(r.created_at), sort: (r) => +new Date(r.created_at) },
      ],
      defaults: ['client', 'zone', 'position', 'status', 'date'],
      compact: ['client', 'status'],
      status: (r) => r.status,
      statusValues: Object.keys(REQUEST_LABEL).filter((s) => s !== 'Archivée'),
      statusLabel: (s) => REQUEST_LABEL[s] || s,
      zone: (r) => r.neighborhood || '',
      driver: () => null,
      text: (r) => `DEM-${r.id} ${r.customer_name || ''} ${r.customer_phone || ''} ${r.neighborhood || ''} ${r.landmark || ''} ${REQUEST_LABEL[r.status] || r.status}`,
      trashable: () => true,
      fiche: ['demande', 'client'],
      create: { label: 'Nouvelle demande', href: '/app/operations?vue=creer' },
      sort: { key: 'date', dir: -1 },
    },
  };
  const ORDER = ['commandes', 'incidents', 'tournees', 'demandes'];
  const TAB_LABEL = { livraison: 'Livraison', client: 'Client', colis: 'Colis', activite: 'Activité', incident: 'Incident', demande: 'Demande' };
  const SIZES = [5, 10, 20, 50];

  function defaultCfg(source) {
    const S = SOURCES[source];
    return { layout: 'table', density: 'comfortable', pageSize: 10, columns: S.defaults.slice(), pill: 'all', group: null, sort: { ...S.sort }, filters: { status: [], zone: [], driver: [] } };
  }
  // Réglages d'une vue, bornés à ce que la source sait afficher.
  function normalizeCfg(source, raw) {
    const S = SOURCES[source];
    const base = defaultCfg(source);
    const c = raw && typeof raw === 'object' ? raw : {};
    const keys = S.columns.map((col) => col.key);
    let columns = Array.isArray(c.columns) ? c.columns.filter((k) => keys.includes(k)) : base.columns;
    S.columns.filter((col) => col.required).forEach((col) => { if (!columns.includes(col.key)) columns.unshift(col.key); });
    columns = [...new Set(columns)];
    const sortable = S.columns.filter((col) => col.sort).map((col) => col.key);
    return {
      layout: c.layout === 'cards' ? 'cards' : 'table',
      density: c.density === 'compact' ? 'compact' : 'comfortable',
      pageSize: SIZES.includes(Number(c.pageSize)) ? Number(c.pageSize) : 10,
      columns,
      pill: S.pills.some(([k]) => k === c.pill) ? c.pill : 'all',
      group: ['status', 'zone', 'driver'].includes(c.group) ? c.group : null,
      sort: c.sort && sortable.includes(c.sort.key) ? { key: c.sort.key, dir: c.sort.dir < 0 ? -1 : 1 } : base.sort,
      filters: {
        status: Array.isArray(c.filters?.status) ? c.filters.status.map(String) : [],
        zone: Array.isArray(c.filters?.zone) ? c.filters.zone.map(String) : [],
        driver: Array.isArray(c.filters?.driver) ? c.filters.driver.map(String) : [],
      },
    };
  }

  async function render(page, deps) {
    const { api, uiToast, uiConfirm, openModal } = deps;
    PACKAGE_LABEL = Object.fromEntries(deps.packageTypes || []);
    const role = deps.context?.user?.role || '';
    const canAct = ['owner', 'manager', 'operator'].includes(role);
    const canShare = ['owner', 'manager'].includes(role);
    const params = new URLSearchParams(location.search);
    const start = ORDER.includes(params.get('vue')) ? params.get('vue') : 'commandes';

    const st = {
      source: start, trash: false, raw: [], extra: [], capped: false, counts: {}, views: [], viewId: null,
      cfg: normalizeCfg(start, store.get(`traxo.ops.general.${start}`)),
      query: '', page: 1, sel: new Set(), loading: true, error: null,
      panel: null, editView: null, formSource: start, confirm: false, flash: null,
      fiche: null, drivers: null,
    };
    const S = () => SOURCES[st.source];
    page.classList.add('page-ops');
    page.innerHTML = '<div class="ops" id="ops"></div>';
    const root = page.querySelector('#ops');
    const narrow = window.matchMedia('(max-width: 760px)');
    const wide = window.matchMedia('(min-width: 1180px)');

    const activeView = () => st.views.find((v) => v.id === st.viewId) || null;
    const viewsOf = (source) => st.views.filter((v) => v.source === source);
    const saveGeneral = () => { if (!st.viewId) store.set(`traxo.ops.general.${st.source}`, st.cfg); };
    const flash = (text, tone = 'ok', undo = null) => { st.flash = { text, tone, undo }; };

    // ---- Données -----------------------------------------------------
    function rows() {
      const S0 = S();
      const seen = new Set();
      let out = st.raw.concat(st.extra).filter((r) => { const k = String(r.id); if (seen.has(k)) return false; seen.add(k); return true; });
      const q = st.query.toLowerCase();
      if (q) out = out.filter((r) => S0.text(r).toLowerCase().includes(q));
      const f = st.cfg.filters;
      if (f.status.length) out = out.filter((r) => f.status.includes(String(S0.status(r))));
      if (f.zone.length) out = out.filter((r) => f.zone.includes(S0.zone(r)));
      if (f.driver.length) out = out.filter((r) => { const d = S0.driver(r); return d && f.driver.includes(d[0]); });
      return out;
    }
    function filtered() {
      const S0 = S();
      const pill = S0.pills.find(([k]) => k === st.cfg.pill) || S0.pills[0];
      const out = rows().filter(pill[2]);
      const col = S0.columns.find((c) => c.key === st.cfg.sort?.key);
      const dir = st.cfg.sort?.dir || 1;
      const groupKey = groupOf();
      out.sort((a, b) => {
        if (groupKey) { const ga = groupKey(a); const gb = groupKey(b); if (ga !== gb) return ga < gb ? -1 : 1; }
        if (!col || !col.sort) return 0;
        const va = col.sort(a); const vb = col.sort(b);
        return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
      });
      return out;
    }
    function groupOf() {
      const S0 = S();
      if (st.cfg.group === 'status') return (r) => String(S0.statusLabel(S0.status(r)) || '—');
      if (st.cfg.group === 'zone') return (r) => S0.zone(r) || 'Sans zone';
      if (st.cfg.group === 'driver') return (r) => (S0.driver(r) ? S0.driver(r)[1] : 'Sans livreur');
      return null;
    }
    function zones() { return [...new Set(st.raw.map((r) => S().zone(r)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr')); }
    function driversOfRows() {
      const m = new Map();
      st.raw.forEach((r) => { const d = S().driver(r); if (d) m.set(d[0], d[1]); });
      return [...m.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'fr'));
    }

    async function loadCounts() { try { st.counts = await api('/api/app/summary'); } catch { st.counts = {}; } }
    async function loadViews() { try { st.views = await api('/api/app/ops/views'); } catch { st.views = []; } }
    async function load() {
      st.loading = true; st.error = null; st.extra = [];
      renderList();
      try {
        st.raw = await api(S().endpoint(st.trash));
        st.capped = st.source === 'commandes' && st.raw.length >= 500;
      } catch (error) { st.raw = []; st.error = error.message; }
      st.loading = false;
    }
    // Après une action (tiroir, corbeille, attribution) : liste, compteurs et
    // fiche ouverte sont relus.
    async function reload() {
      await Promise.all([load(), loadCounts()]);
      const f = st.fiche;
      if (f && !st.raw.concat(st.extra).some((r) => String(r.id) === f.id)) st.fiche = null;
      draw();
      if (st.fiche) openFiche(st.fiche.id, st.fiche.tab);
    }

    // Au-delà des 500 commandes chargées, la recherche interroge le serveur.
    let searchTimer = null;
    function serverSearch() {
      clearTimeout(searchTimer);
      if (!st.capped || st.trash || st.query.length < 2) { st.extra = []; return; }
      const q = st.query;
      searchTimer = setTimeout(async () => {
        try {
          const more = await api(`/api/app/orders?q=${encodeURIComponent(q)}`);
          if (q === st.query) { st.extra = more; renderList(); }
        } catch { /* la recherche locale reste affichée */ }
      }, 350);
    }

    // ---- Rendu --------------------------------------------------------
    function draw() {
      const S0 = S();
      const c = st.counts;
      const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const stat = (n, label, tone, src, pill) => `<button type="button" data-act="stat" data-src="${src}" data-pill="${pill}"><i class="ops-dot ops-dot-${tone}"></i><b>${esc(n ?? 0)}</b> ${esc(label)}</button>`;
      const n = (k) => Number(c[k] || 0);
      const views = viewsOf(st.source);
      const view = activeView();
      const dirty = view && JSON.stringify(normalizeCfg(view.source, view.config)) !== JSON.stringify(st.cfg);
      const editable = view && (view.mine || canShare);
      root.innerHTML = `
        ${st.flash ? `<div class="ops-flash ops-flash-${st.flash.tone}" role="status"><span>${esc(st.flash.text)}</span>${st.flash.undo ? '<button type="button" class="ops-link" data-act="undo">Annuler</button>' : ''}<button type="button" class="ops-icon-btn" data-act="flash-close" aria-label="Fermer">${ic('x')}</button></div>` : ''}
        <header class="ops-head">
          <div>
            <h1>Opérations</h1>
            <p>Chaque livraison, et la prochaine action utile.</p>
            <div class="ops-pulse">
              ${stat(n('to_review'), n('to_review') > 1 ? 'demandes à vérifier' : 'demande à vérifier', 'amber', 'demandes', 'review')}
              ${stat(n('orders_in_progress'), n('orders_in_progress') > 1 ? 'livraisons en cours' : 'livraison en cours', 'green', 'commandes', 'road')}
              ${stat(n('open_incidents'), n('open_incidents') > 1 ? 'incidents à traiter' : 'incident à traiter', 'rose', 'incidents', 'open')}
            </div>
          </div>
          <span class="ops-day">${ic('calendar-days')}<span>${esc(today.charAt(0).toUpperCase() + today.slice(1))}</span></span>
        </header>
        <nav class="ops-tabs" aria-label="Données">
          ${ORDER.map((k) => `<button type="button" data-act="tab" data-src="${k}" aria-pressed="${k === st.source}">${ic(SOURCES[k].icon)}<span>${esc(SOURCES[k].label)}</span><b>${esc(c[SOURCES[k].count] ?? '')}</b></button>`).join('')}
          <button type="button" class="ops-tabs-new" data-act="create-view">${ic('plus')}<span>Créer une vue</span></button>
        </nav>
        <div class="ops-views">
          <button type="button" class="ops-view ${!st.viewId ? 'on' : ''}" data-act="view" data-id="">${ic('table-2')}Vue générale</button>
          ${views.map((v) => `<button type="button" class="ops-view ${v.id === st.viewId ? 'on' : ''}" data-act="view" data-id="${esc(v.id)}">${ic(v.config?.layout === 'cards' ? 'layout-grid' : 'table-2')}${esc(v.name)}${v.shared ? '<em>Équipe</em>' : ''}</button>`).join('')}
          ${dirty && editable ? '<button type="button" class="ops-link ops-save-view" data-act="save-view">Enregistrer les changements</button>' : ''}
          <button type="button" class="ops-manage" data-act="manage-views">${ic('layers-2')}Gérer les vues${views.length ? ` · ${views.length}` : ''}</button>
        </div>
        <div id="opsPanel">${panelHtml()}</div>
        <div class="ops-toolbar">
          <label class="ops-search">${ic('search')}<input type="search" data-input="search" placeholder="${esc(S0.placeholder)}" value="${esc(st.query)}" autocomplete="off" aria-label="Rechercher"></label>
          <div class="ops-actions">
            <button type="button" class="ops-btn ${st.panel === 'columns' ? 'on' : ''}" data-act="panel" data-p="columns" aria-expanded="${st.panel === 'columns'}">${ic('columns-3')}Colonnes</button>
            <button type="button" class="ops-btn ${st.panel === 'filter' ? 'on' : ''}" data-act="panel" data-p="filter" aria-expanded="${st.panel === 'filter'}">${ic('list-filter')}Filtrer${filterCount() ? `<b class="ops-badge">${filterCount()}</b>` : ''}</button>
            <button type="button" class="ops-btn ${st.panel === 'display' ? 'on' : ''}" data-act="panel" data-p="display" aria-expanded="${st.panel === 'display'}">${ic('sliders-horizontal')}Affichage</button>
            ${S0.create ? `<button type="button" class="ops-btn ops-primary" data-act="new">${ic('plus')}${esc(S0.create.label)}</button>` : ''}
          </div>
        </div>
        <div class="ops-pills">
          <div class="ops-pill-row" role="group" aria-label="Filtre rapide">
            ${S0.pills.map(([k, label, test]) => `<button type="button" data-act="pill" data-pill="${k}" aria-pressed="${st.cfg.pill === k}">${esc(label)}<b>${rows().filter(test).length}</b></button>`).join('')}
          </div>
          <div class="ops-pill-side">
            <span class="ops-seg" role="group" aria-label="Présentation">
              <button type="button" data-act="layout" data-l="table" aria-pressed="${st.cfg.layout === 'table'}" aria-label="Tableau" title="Tableau">${ic('table-2')}</button>
              <button type="button" data-act="layout" data-l="cards" aria-pressed="${st.cfg.layout === 'cards'}" aria-label="Cartes" title="Cartes">${ic('layout-grid')}</button>
            </span>
            ${S0.trashable ? `<button type="button" class="ops-trash-btn" data-act="trash-toggle" aria-pressed="${st.trash}">${ic(st.trash ? 'undo-2' : 'trash-2')}${st.trash ? 'Quitter la corbeille' : 'Corbeille'}<b>${esc(c[S0.trashCount] ?? 0)}</b></button>` : ''}
          </div>
        </div>
        <div class="ops-grid ${st.fiche && wide.matches ? 'with-fiche' : ''}">
          <section class="ops-list" id="opsMain"></section>
          ${st.fiche ? '<aside class="ops-fiche" id="opsFiche" aria-label="Fiche"></aside>' : ''}
        </div>
        ${st.fiche && !wide.matches ? '<div class="ops-fiche-backdrop" data-act="fiche-close"></div>' : ''}
        <footer class="ops-foot">TRAXO · Vos livraisons, simplement</footer>`;
      // Les animations ne jouent qu'à la première apparition d'un élément.
      if (st.flash && !st.flash.seen) { root.querySelector('.ops-flash')?.classList.add('ops-anim'); st.flash.seen = true; }
      const panelKey = st.panel ? `${st.panel}:${st.editView?.id || ''}` : null;
      if (panelKey && panelKey !== st.lastPanel) root.querySelector('#opsPanel > .ops-panel')?.classList.add('ops-anim');
      st.lastPanel = panelKey;
      if (st.fiche && st.fiche.id !== st.lastFiche) root.querySelector('#opsFiche')?.classList.add('ops-anim');
      st.lastFiche = st.fiche ? st.fiche.id : null;
      renderList();
      if (st.fiche) renderFiche();
    }
    const filterCount = () => st.cfg.filters.status.length + st.cfg.filters.zone.length + st.cfg.filters.driver.length;

    function panelHtml() {
      const S0 = S();
      if (st.panel === 'columns') {
        const order = st.cfg.columns.concat(S0.columns.map((c) => c.key).filter((k) => !st.cfg.columns.includes(k)));
        return `<div class="ops-panel"><div class="ops-panel-head"><div><h2>Colonnes</h2><p>Choisissez et ordonnez les informations du tableau.</p></div><button type="button" class="ops-icon-btn" data-act="close-panel" aria-label="Fermer">${ic('x')}</button></div>
          <ul class="ops-cols">${order.map((k, i) => {
            const col = S0.columns.find((c) => c.key === k);
            const on = st.cfg.columns.includes(k);
            const idx = st.cfg.columns.indexOf(k);
            return `<li class="${on ? '' : 'off'}"><label><input type="checkbox" data-col="${k}" ${on ? 'checked' : ''} ${col.required ? 'disabled' : ''}> ${esc(col.label)}${col.required ? ' <small>toujours visible</small>' : ''}</label>
              <span><button type="button" class="ops-icon-btn" data-act="col-move" data-k="${k}" data-d="-1" aria-label="Déplacer à gauche" ${!on || idx <= 0 ? 'disabled' : ''}>${ic('move-up')}</button><button type="button" class="ops-icon-btn" data-act="col-move" data-k="${k}" data-d="1" aria-label="Déplacer à droite" ${!on || idx < 0 || idx >= st.cfg.columns.length - 1 ? 'disabled' : ''}>${ic('move-down')}</button></span></li>`;
          }).join('')}</ul>
          <div class="ops-panel-foot"><button type="button" class="ops-link" data-act="cols-reset">Revenir aux colonnes par défaut</button></div></div>`;
      }
      if (st.panel === 'filter') {
        const f = st.cfg.filters;
        const statusVals = S0.statusValues.filter((v) => st.raw.some((r) => String(S0.status(r)) === v) || f.status.includes(v));
        const box = (kind, value, label) => `<label class="ops-check"><input type="checkbox" data-f="${kind}" value="${esc(value)}" ${f[kind].includes(String(value)) ? 'checked' : ''}> ${esc(label)}</label>`;
        const z = zones();
        const d = driversOfRows();
        return `<div class="ops-panel"><div class="ops-panel-head"><div><h2>Filtrer</h2><p>Les filtres s’ajoutent au filtre rapide et à la recherche.</p></div><button type="button" class="ops-icon-btn" data-act="close-panel" aria-label="Fermer">${ic('x')}</button></div>
          <div class="ops-filter-grid">
            <fieldset><legend>Statut</legend>${statusVals.length ? statusVals.map((v) => box('status', v, S0.statusLabel(v))).join('') : '<p class="ops-dim">Aucun statut pour le moment.</p>'}</fieldset>
            ${st.source !== 'tournees' ? `<fieldset><legend>Zone</legend>${z.length ? z.map((v) => box('zone', v, v)).join('') : '<p class="ops-dim">Aucune zone renseignée.</p>'}</fieldset>` : ''}
            ${st.source !== 'demandes' ? `<fieldset><legend>Livreur</legend>${d.length ? d.map(([id, name]) => box('driver', id, name)).join('') : '<p class="ops-dim">Aucun livreur.</p>'}</fieldset>` : ''}
          </div>
          <div class="ops-panel-foot"><button type="button" class="ops-link" data-act="filter-clear" ${filterCount() ? '' : 'disabled'}>Effacer les filtres</button></div></div>`;
      }
      if (st.panel === 'display') {
        const sortable = S0.columns.filter((c) => c.sort);
        const sel = (name, value, options) => `<select data-d="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        const groups = [['', 'Aucun'], ['status', 'Statut']];
        if (st.source !== 'tournees') groups.push(['zone', 'Zone']);
        if (st.source !== 'demandes') groups.push(['driver', 'Livreur']);
        return `<div class="ops-panel"><div class="ops-panel-head"><div><h2>Affichage</h2><p>Présentation, densité, tri et regroupement.</p></div><button type="button" class="ops-icon-btn" data-act="close-panel" aria-label="Fermer">${ic('x')}</button></div>
          <div class="ops-form-grid">
            <label>Présentation${sel('layout', st.cfg.layout, [['table', 'Tableau'], ['cards', 'Cartes']])}</label>
            <label>Densité${sel('density', st.cfg.density, [['comfortable', 'Confortable'], ['compact', 'Compacte']])}</label>
            <label>Lignes par page${sel('pageSize', st.cfg.pageSize, SIZES.map((s) => [s, s]))}</label>
            <label>Trier par${sel('sortKey', st.cfg.sort?.key, sortable.map((c) => [c.key, c.label.split(' / ')[0]]))}</label>
            <label>Ordre${sel('sortDir', st.cfg.sort?.dir, [[-1, 'Décroissant'], [1, 'Croissant']])}</label>
            <label>Regrouper par${sel('group', st.cfg.group || '', groups)}</label>
          </div></div>`;
      }
      if (st.panel === 'create') return viewFormHtml();
      if (st.panel === 'manage') {
        const list = st.views;
        return `<div class="ops-panel"><div class="ops-panel-head"><div><h2>Vos vues</h2><p>Supprimer une vue ne supprime aucune donnée.</p></div><button type="button" class="ops-icon-btn" data-act="close-panel" aria-label="Fermer">${ic('x')}</button></div>
          ${list.length ? `<ul class="ops-vlist">${list.map((v) => {
            const can = v.mine || canShare;
            return `<li><div><b>${esc(v.name)}</b><small>${esc(SOURCES[v.source]?.label || v.source)} · ${v.config?.layout === 'cards' ? 'Cartes' : 'Tableau'}${v.shared ? ' · partagée avec l’équipe' : ''}</small></div>
              <span><button type="button" class="ops-btn ops-sm" data-act="view" data-id="${esc(v.id)}">Appliquer</button>${can ? `<button type="button" class="ops-btn ops-sm" data-act="view-edit" data-id="${esc(v.id)}">${ic('pencil')}Modifier</button>` : ''}<button type="button" class="ops-btn ops-sm" data-act="view-dup" data-id="${esc(v.id)}">${ic('copy')}Dupliquer</button>${can ? `<button type="button" class="ops-btn ops-sm ops-danger" data-act="view-del" data-id="${esc(v.id)}">${ic('trash-2')}Supprimer</button>` : ''}</span></li>`;
          }).join('')}</ul>` : '<p class="ops-empty-line">Aucune vue enregistrée. Une vue retient une source, des colonnes, des filtres et une présentation.</p>'}
          <div class="ops-panel-foot"><button type="button" class="ops-btn ops-primary" data-act="create-view">${ic('plus')}Créer une vue</button></div></div>`;
      }
      return '';
    }

    function viewFormHtml() {
      const v = st.editView;
      const source = st.formSource;
      const S1 = SOURCES[source];
      const same = source === st.source;
      const cfg = v ? normalizeCfg(v.source, v.config) : (same ? st.cfg : defaultCfg(source));
      const zoneList = same ? zones() : [];
      const zoneNow = cfg.filters.zone.length === 1 ? cfg.filters.zone[0] : '';
      const opt = (val, cur, label) => `<option value="${esc(val)}" ${String(val) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
      return `<form class="ops-panel" data-form="view" novalidate>
        <div class="ops-panel-head"><div><h2>${v ? 'Modifier la vue' : 'Une vue pour votre façon de travailler'}</h2><p>Choisissez les données et les informations dont vous avez besoin.</p></div><button type="button" class="ops-icon-btn" data-act="close-panel" aria-label="Fermer">${ic('x')}</button></div>
        <div class="ops-form-grid">
          <label>Nom de la vue<input name="name" maxlength="60" required value="${esc(v ? v.name : '')}" placeholder="Ex. Livraisons Akpakpa"></label>
          <label>Données<select name="source" data-d="formSource" ${v ? 'disabled' : ''}>${ORDER.map((k) => opt(k, source, SOURCES[k].label)).join('')}</select></label>
          <label>Présentation<select name="layout">${opt('table', cfg.layout, 'Tableau')}${opt('cards', cfg.layout, 'Cartes')}</select></label>
          ${source !== 'tournees' ? `<label>Zone<select name="zone">${opt('', zoneNow, 'Toutes les zones')}${zoneList.map((z) => opt(z, zoneNow, z)).join('')}${zoneNow && !zoneList.includes(zoneNow) ? opt(zoneNow, zoneNow, zoneNow) : ''}</select></label>` : ''}
          <label>Densité<select name="density">${opt('comfortable', cfg.density, 'Confortable')}${opt('compact', cfg.density, 'Compacte')}</select></label>
          <label>Lignes par page<select name="pageSize">${SIZES.map((s) => opt(s, cfg.pageSize, s)).join('')}</select></label>
        </div>
        <fieldset class="ops-visible"><legend>Informations visibles</legend>
          ${S1.columns.map((c) => `<label class="ops-check"><input type="checkbox" name="col" value="${c.key}" ${cfg.columns.includes(c.key) ? 'checked' : ''} ${c.required ? 'checked disabled' : ''}> ${esc(c.label)}</label>`).join('')}
        </fieldset>
        ${canShare ? `<label class="ops-check ops-share"><input type="checkbox" name="shared" ${v?.shared ? 'checked' : ''}> Partager cette vue avec l’équipe</label>` : ''}
        <p class="ops-note">${same || v ? 'Les filtres, le tri et le regroupement actuels sont repris.' : 'La vue démarre avec les filtres par défaut de cette source.'}</p>
        <div class="ops-form-error" role="alert"></div>
        <div class="ops-panel-foot"><button type="submit" class="ops-btn ops-primary">${v ? 'Enregistrer' : 'Créer ma vue'}</button><button type="button" class="ops-btn ops-ghost" data-act="close-panel">Annuler</button></div>
      </form>`;
    }

    function shownColumns() {
      const S0 = S();
      let keys = st.cfg.columns;
      if (st.fiche && wide.matches) keys = keys.filter((k) => S0.compact.includes(k));
      return keys.map((k) => S0.columns.find((c) => c.key === k)).filter(Boolean);
    }

    function pageNumbers(cur, total) {
      if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
      const out = [1];
      const a = Math.max(2, cur - 1); const b = Math.min(total - 1, cur + 1);
      if (a > 2) out.push('…');
      for (let i = a; i <= b; i += 1) out.push(i);
      if (b < total - 1) out.push('…');
      out.push(total);
      return out;
    }

    function renderList() {
      const el = root.querySelector('#opsMain');
      if (!el) return;
      const S0 = S();
      if (st.loading) { el.innerHTML = '<div class="ops-card"><div class="ops-state"><span class="ops-spin"></span>Chargement…</div></div>'; return; }
      if (st.error) { el.innerHTML = `<div class="ops-card"><div class="ops-state ops-error">${esc(st.error)} <button type="button" class="ops-link" data-act="retry">Réessayer</button></div></div>`; return; }
      const all = filtered();
      const total = all.length;
      const size = st.cfg.pageSize;
      const pages = Math.max(1, Math.ceil(total / size));
      if (st.page > pages) st.page = pages;
      const from = (st.page - 1) * size;
      const slice = all.slice(from, from + size);
      const cols = shownColumns();
      const cards = st.cfg.layout === 'cards' || narrow.matches;
      const pageIds = slice.map((r) => String(r.id));
      const onPage = pageIds.filter((id) => st.sel.has(id)).length;
      const allSel = total > 0 && all.every((r) => st.sel.has(String(r.id)));
      const selectable = true;
      const group = groupOf();

      let bulk = '';
      if (st.sel.size) {
        const chosen = all.filter((r) => st.sel.has(String(r.id)));
        bulk = `<div class="ops-bulk"><b>${plural(st.sel.size, 'sélectionné', 'sélectionnés')}</b>
          ${!allSel && total > st.sel.size ? `<button type="button" class="ops-link" data-act="sel-all">Sélectionner les ${total} résultats</button>` : ''}
          <span class="ops-bulk-actions">
            <button type="button" class="ops-btn ops-sm" data-act="bulk-export">${ic('download')}Exporter</button>
            ${canAct && S0.assign && !st.trash ? `<button type="button" class="ops-btn ops-sm" data-act="bulk-assign">${ic('user-round')}Attribuer</button>` : ''}
            ${canAct && S0.trashable && !st.trash ? `<button type="button" class="ops-btn ops-sm ops-danger" data-act="bulk-trash">${ic('trash-2')}Supprimer</button>` : ''}
            ${canAct && st.trash ? `<button type="button" class="ops-btn ops-sm" data-act="bulk-restore">${ic('undo-2')}Restaurer</button>` : ''}
            <button type="button" class="ops-icon-btn" data-act="sel-clear" aria-label="Effacer la sélection">${ic('x')}</button>
          </span></div>`;
        if (st.confirm) {
          const ok = chosen.filter((r) => S0.trashable(r)).length;
          const ko = chosen.length - ok;
          bulk += `<div class="ops-confirm" role="alertdialog" aria-label="Confirmer la suppression">
            <div><b>${ok ? `Supprimer ${plural(ok, 'élément', 'éléments')} ?` : 'Rien à supprimer'}</b>
            <p>${ok ? 'Ils seront déplacés dans la corbeille. Les profils clients et les autres éléments liés seront conservés.' : ''}${ko ? ` ${ko > 1 ? `${ko} éléments restent` : '1 élément reste'} en place : ${esc(S0.trashNote || '')}` : ''}</p></div>
            <span>${ok ? `<button type="button" class="ops-btn ops-primary" data-act="confirm-trash">Supprimer ${ok > 1 ? `les ${ok} éléments` : 'l’élément'}</button>` : ''}<button type="button" class="ops-btn" data-act="cancel-confirm">Annuler</button></span></div>`;
        }
      }
      const trashNote = st.trash ? `<div class="ops-trash-note">${ic('trash-2')}<span><b>Corbeille</b> — éléments retirés des listes actives. Sélectionnez-les pour les restaurer.</span></div>` : '';

      let body = '';
      if (!total) {
        const filteredOut = st.raw.length > 0;
        body = `<div class="ops-state ops-empty">${ic(st.trash ? 'trash-2' : S0.icon)}<b>${st.trash ? 'La corbeille est vide.' : filteredOut ? 'Aucun résultat ne correspond.' : 'Rien à afficher pour le moment.'}</b>${filteredOut && !st.trash ? '<button type="button" class="ops-link" data-act="reset-filters">Effacer la recherche et les filtres</button>' : ''}</div>`;
      } else if (cards) {
        let lastGroup = null;
        body = `<div class="ops-cards">${slice.map((r) => {
          const id = String(r.id);
          let head = '';
          if (group) { const g = group(r); if (g !== lastGroup) { lastGroup = g; head = `<div class="ops-group-label">${esc(g)}</div>`; } }
          const first = cols[0];
          const rest = cols.slice(1).filter((c) => c.key !== 'status' && c.key !== 'suivi');
          const status = S0.columns.find((c) => c.key === 'status');
          const suivi = cols.find((c) => c.key === 'suivi');
          return `${head}<article class="ops-cardrow ${st.sel.has(id) ? 'sel' : ''} ${st.fiche?.id === id ? 'cur' : ''}" data-row="${esc(id)}">
            <div class="ops-cardrow-top">${selectable ? `<input type="checkbox" class="ops-cb" data-sel="${esc(id)}" ${st.sel.has(id) ? 'checked' : ''} aria-label="Sélectionner">` : ''}${status ? status.cell(r) : ''}${suivi ? suivi.cell(r) : ''}<button type="button" class="ops-open" data-act="open" data-id="${esc(id)}" aria-label="Ouvrir">${ic('arrow-up-right')}</button></div>
            <div class="ops-cardrow-who">${first.cell(r)}</div>
            ${rest.length ? `<dl>${rest.map((c) => `<div><dt>${esc(c.label)}</dt><dd>${c.cell(r)}</dd></div>`).join('')}</dl>` : ''}
          </article>`;
        }).join('')}</div>`;
      } else {
        let lastGroup = null;
        const span = cols.length + (selectable ? 2 : 1);
        body = `<div class="ops-scroll"><table class="ops-table ${st.cfg.density === 'compact' ? 'compact' : ''}">
          <thead><tr>${selectable ? `<th class="ops-cbcol"><input type="checkbox" class="ops-cb" data-act-change="sel-page" ${onPage && onPage === pageIds.length ? 'checked' : ''} aria-label="Sélectionner la page"></th>` : ''}${cols.map((c) => {
            const on = st.cfg.sort?.key === c.key;
            return `<th>${c.sort ? `<button type="button" class="ops-th ${on ? 'on' : ''}" data-act="sort" data-k="${c.key}" aria-sort="${on ? (st.cfg.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(c.label)}${on ? `<span aria-hidden="true">${st.cfg.sort.dir > 0 ? '↑' : '↓'}</span>` : ''}</button>` : esc(c.label)}</th>`;
          }).join('')}<th class="ops-actcol"><span class="ops-sr">Ouvrir</span></th></tr></thead>
          <tbody>${slice.map((r) => {
            const id = String(r.id);
            let head = '';
            if (group) { const g = group(r); if (g !== lastGroup) { lastGroup = g; head = `<tr class="ops-group"><td colspan="${span}">${esc(g)}</td></tr>`; } }
            return `${head}<tr data-row="${esc(id)}" class="${st.sel.has(id) ? 'sel' : ''} ${st.fiche?.id === id ? 'cur' : ''}">${selectable ? `<td class="ops-cbcol"><input type="checkbox" class="ops-cb" data-sel="${esc(id)}" ${st.sel.has(id) ? 'checked' : ''} aria-label="Sélectionner"></td>` : ''}${cols.map((c) => `<td>${c.cell(r)}</td>`).join('')}<td class="ops-actcol"><button type="button" class="ops-open" data-act="open" data-id="${esc(id)}" aria-label="Ouvrir">${ic('arrow-up-right')}</button></td></tr>`;
          }).join('')}</tbody></table></div>`;
      }
      const nums = pageNumbers(st.page, pages);
      const pager = total ? `<div class="ops-pager">
        <span class="ops-pager-count"><b>${from + 1}–${Math.min(total, from + size)}</b> sur ${total}
          <select data-d="pageSize" aria-label="Lignes par page">${SIZES.map((s) => `<option value="${s}" ${s === size ? 'selected' : ''}>${s}</option>`).join('')}</select> par page</span>
        <nav class="ops-pages" aria-label="Pagination">
          <button type="button" data-act="pg" data-p="1" ${st.page <= 1 ? 'disabled' : ''} aria-label="Première page">${ic('chevrons-left')}</button>
          <button type="button" data-act="pg" data-p="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''} aria-label="Page précédente">${ic('chevron-left')}</button>
          ${nums.map((p) => (p === '…' ? '<span class="ops-ell">…</span>' : `<button type="button" data-act="pg" data-p="${p}" class="${p === st.page ? 'on' : ''}" ${p === st.page ? 'aria-current="page"' : ''}>${p}</button>`)).join('')}
          <button type="button" data-act="pg" data-p="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''} aria-label="Page suivante">${ic('chevron-right')}</button>
          <button type="button" data-act="pg" data-p="${pages}" ${st.page >= pages ? 'disabled' : ''} aria-label="Dernière page">${ic('chevrons-right')}</button>
        </nav>
        <form class="ops-goto" data-form="goto"><label>Page <input type="number" name="p" min="1" max="${pages}" value="${st.page}" inputmode="numeric"></label><button type="submit" class="ops-icon-btn" aria-label="Aller à la page">${ic('arrow-right')}</button></form>
      </div>` : '';
      const capped = st.capped && !st.trash ? '<p class="ops-capnote">Les 500 commandes les plus récentes sont chargées ; la recherche interroge aussi les plus anciennes.</p>' : '';
      el.innerHTML = `${trashNote}<div class="ops-card ${st.sel.size ? 'has-bulk' : ''}">${bulk}${body}${pager}</div>${capped}`;
      const headCb = el.querySelector('[data-act-change="sel-page"]');
      if (headCb) headCb.indeterminate = onPage > 0 && onPage < pageIds.length;
      // Les compteurs des filtres rapides suivent la recherche.
      root.querySelectorAll('.ops-pill-row [data-pill]').forEach((b) => {
        const pill = S0.pills.find(([k]) => k === b.dataset.pill);
        const n = b.querySelector('b');
        if (pill && n) n.textContent = String(rows().filter(pill[2]).length);
      });
    }

    // ---- Fiche latérale --------------------------------------------------
    async function openFiche(id, tab) {
      const S0 = S();
      if (!S0.fiche) return openExisting(id);
      st.fiche = { id: String(id), tab: tab || S0.fiche[0], data: null, cust: undefined, error: null };
      draw();
      try {
        const url = st.source === 'commandes' ? `/api/app/orders/${encodeURIComponent(id)}`
          : st.source === 'incidents' ? `/api/app/incidents/${encodeURIComponent(id)}`
            : `/api/app/requests/${encodeURIComponent(id)}`;
        const data = await api(url);
        if (st.fiche?.id !== String(id)) return;
        st.fiche.data = data;
      } catch (error) { if (st.fiche) st.fiche.error = error.message; }
      renderFiche();
      if (st.fiche?.tab === 'client') loadCustomer();
    }
    function customerIdOf() {
      const f = st.fiche;
      if (!f?.data) return null;
      if (st.source === 'commandes') return f.data.customer_id || null;
      const row = st.raw.find((r) => String(r.id) === f.id);
      return row?.customer_id || (st.source === 'incidents' ? f.data.incident?.customer_id : f.data.customer_id) || null;
    }
    async function loadCustomer() {
      const f = st.fiche;
      if (!f || f.cust !== undefined) return;
      const cid = customerIdOf();
      if (!cid) { f.cust = null; renderFiche(); return; }
      f.cust = 'loading'; renderFiche();
      try { const data = await api(`/api/app/crm/customers/${encodeURIComponent(cid)}`); if (st.fiche === f) f.cust = data; }
      catch (error) { if (st.fiche === f) f.cust = { error: error.message }; }
      renderFiche();
    }
    function openExisting(id) {
      const onChange = () => reload();
      if (st.source === 'commandes') return deps.openOrderDrawer(id, { onChange });
      if (st.source === 'incidents') return deps.openIncidentDrawer(id, { onChange });
      if (st.source === 'tournees') return deps.openRunDrawer(id, { onChange });
      return deps.openRequestDrawer(id, { onChange });
    }

    const field = (label, value) => `<div class="ops-field"><dt>${esc(label)}</dt><dd>${value || '<span class="ops-dim">—</span>'}</dd></div>`;
    function renderFiche() {
      const el = root.querySelector('#opsFiche');
      if (!el || !st.fiche) return;
      const f = st.fiche;
      const S0 = S();
      const d = f.data;
      if (f.error) { el.innerHTML = `<div class="ops-fiche-in"><div class="ops-fiche-top"><span></span><button type="button" class="ops-icon-btn" data-act="fiche-close" aria-label="Fermer">${ic('x')}</button></div><div class="ops-state ops-error">${esc(f.error)}</div></div>`; return; }
      if (!d) { el.innerHTML = `<div class="ops-fiche-in"><div class="ops-fiche-top"><span></span><button type="button" class="ops-icon-btn" data-act="fiche-close" aria-label="Fermer">${ic('x')}</button></div><div class="ops-state"><span class="ops-spin"></span>Chargement…</div></div>`; return; }
      let code = ''; let title = ''; let status = ''; let date = '';
      if (st.source === 'commandes') { code = orderRef(d); title = d.customer_name; status = chip(d.status, ORDER_TONE[d.status]); date = when(d.created_at); }
      if (st.source === 'incidents') { const i = d.incident; code = `INC-${i.id}`; title = INC_CATEGORY[i.category] || i.category; status = chip(INC_STATUS[i.status] || i.status, i.status === 'resolved' ? 'green' : 'red'); date = when(i.created_at); }
      if (st.source === 'demandes') { code = `DEM-${d.id}`; title = d.customer_name || 'En attente du client'; status = chip(REQUEST_LABEL[d.status] || d.status, REQUEST_TONE[d.status]); date = when(d.created_at); }
      const tabs = S0.fiche.map((t) => `<button type="button" role="tab" data-act="fiche-tab" data-t="${t}" aria-selected="${f.tab === t}">${esc(TAB_LABEL[t])}</button>`).join('');
      el.innerHTML = `<div class="ops-fiche-in">
        <div class="ops-fiche-top"><small>${esc(code)}</small><button type="button" class="ops-icon-btn" data-act="fiche-close" aria-label="Fermer la fiche">${ic('x')}</button></div>
        <h2>${esc(title || '—')}</h2>
        <div class="ops-fiche-meta">${status}<span>${esc(date)}</span></div>
        <div class="ops-fiche-tabs" role="tablist">${tabs}</div>
        <div class="ops-fiche-body" role="tabpanel">${ficheBody()}</div>
      </div>`;
      const key = `${f.id}:${f.tab}`;
      if (key !== st.lastTab) el.querySelector('.ops-fiche-body')?.classList.add('ops-anim');
      st.lastTab = key;
    }

    function ficheBody() {
      const f = st.fiche; const d = f.data;
      if (f.tab === 'client') return clientTab();
      if (st.source === 'commandes') {
        if (f.tab === 'livraison') {
          const s = orderStage(d.status);
          const at = (status) => d.events?.slice().reverse().find((e) => e.to_status === status)?.created_at;
          const stepAt = [at('Confirmée') || d.created_at, at('Récupérée'), at('En tournée') || at('En livraison'), at('Livrée')];
          const timeline = s.tone === 'off'
            ? `<p class="ops-closed">${ic('x')}Commande ${esc(String(d.status).toLowerCase())}${d.cancelled_at ? ` le ${esc(when(d.cancelled_at))}` : ''} : plus aucune étape à venir.</p>`
            : `<ol class="ops-timeline">${STEPS.map(([icon, label], i) => `<li class="${i < s.done ? 'done' : i === s.current ? `now ${s.tone}` : ''}"><span>${ic(icon)}</span><div><b>${esc(label)}</b><small>${i < s.done && stepAt[i] ? esc(when(stepAt[i])) : i === s.current ? esc(d.status) : 'À venir'}</small></div></li>`).join('')}</ol>`;
          return `${timeline}
            <dl class="ops-fields">
              ${field('Destination', esc([...new Set([d.neighborhood, d.delivery_address].filter(Boolean))].join(' · ')))}
              ${field('Repère', esc(d.landmark || ''))}
              ${field('Créneau', esc(d.requested_time || ''))}
              ${field('Téléphone du client', d.customer_phone ? `<a href="tel:${esc(String(d.customer_phone).replace(/\s+/g, ''))}">${esc(d.customer_phone)}</a>` : '')}
              ${field('Livreur', d.driver_name ? `${esc(d.driver_name)}${d.driver_phone ? ` · <a href="tel:${esc(String(d.driver_phone).replace(/\s+/g, ''))}">${esc(d.driver_phone)}</a>` : ''}` : '')}
              ${field('Suivi client', esc(TRACKING_LABEL[d.trackingLink?.state] || 'Pas de lien actif'))}
              ${d.failure_reason ? field('Motif', esc(d.failure_reason)) : ''}
            </dl>
            <div class="ops-fiche-actions"><button type="button" class="ops-btn ops-primary" data-act="fiche-manage">Gérer la livraison${ic('arrow-right')}</button></div>
            <p class="ops-note">Statuts, preuves de remise, encaissement et lien de suivi se gèrent dans la livraison.</p>`;
        }
        if (f.tab === 'colis') {
          const pickup = d.pickup_address || d.pickup_name || d.pickup_lat != null;
          const amount = d.payment_account_id ? `${money(d.expected_amount_minor, d.payment_currency)} · ${esc(PAYMENT_LABEL[d.payment_status] || d.payment_status || '')}` : '';
          return `<dl class="ops-fields">
              ${field('Type de colis', esc(PACKAGE_LABEL[d.package_type] || d.package_type || 'Non précisé'))}
              ${field('Contenu', esc(d.package_description || ''))}
              ${field('À encaisser à la remise', amount || '<span class="ops-dim">Aucun encaissement demandé</span>')}
              ${d.collected_amount_minor != null ? field('Encaissé', money(d.collected_amount_minor, d.payment_currency)) : ''}
            </dl>
            <h3 class="ops-sub">${ic('map-pin')}Collecte</h3>
            ${pickup ? `<dl class="ops-fields">
              ${field('Lieu', esc(d.pickup_name || ''))}
              ${field('Adresse ou repère', esc(d.pickup_address || ''))}
              ${field('Téléphone sur place', d.pickup_phone ? `<a href="tel:${esc(String(d.pickup_phone).replace(/\s+/g, ''))}">${esc(d.pickup_phone)}</a>` : '')}
              ${field('Prêt à partir de', esc(d.pickup_ready || ''))}
            </dl>` : '<p class="ops-empty-line">Le livreur part avec le colis : pas de collecte ailleurs.</p>'}
            ${canAct && PRE_PICKUP.includes(d.status) ? `<div class="ops-fiche-actions"><button type="button" class="ops-btn" data-act="pickup-edit">${ic('pencil')}Modifier le colis et la collecte</button></div>` : ''}
            <p class="ops-note">Montant déclaré par votre entreprise. Le livreur l’encaisse à la remise ; TRAXO enregistre ce qui est déclaré et ne prélève rien.</p>`;
        }
        return activity();
      }
      if (st.source === 'incidents') {
        const i = d.incident;
        if (f.tab === 'incident') {
          return `<dl class="ops-fields">
              ${field('Priorité', chip(INC_SEVERITY[i.severity] || i.severity, i.severity === 'high' ? 'red' : i.severity === 'medium' ? 'amber' : 'grey'))}
              ${field('Description', esc(i.description || ''))}
              ${field('Commande', `${esc(i.order_reference || `CMD-${i.order_id}`)} · ${esc(i.order_status || '')}`)}
              ${field('Client', esc([i.customer_name, i.customer_phone].filter(Boolean).join(' · ')))}
              ${field('Livreur', esc(i.driver_name || ''))}
              ${field('Déclaré par', esc(i.opened_by || ''))}
              ${field('Suivi par', esc(i.assigned_to || 'Personne'))}
              ${i.resolution ? field('Résolution', esc(i.resolution)) : ''}
            </dl>
            <div class="ops-fiche-actions"><button type="button" class="ops-btn ops-primary" data-act="fiche-manage">${i.status === 'resolved' ? 'Ouvrir le dossier' : 'Traiter l’incident'}${ic('arrow-right')}</button></div>`;
        }
        const ev = (d.events || []).slice().reverse();
        return ev.length ? `<ol class="ops-acts">${ev.map((e) => `<li><b>${esc(INC_EVENT[e.event_type] || e.event_type)}</b>${e.body ? `<p>${esc(e.body)}</p>` : ''}<small>${esc(when(e.created_at))} · ${esc(e.actor_name)}</small></li>`).join('')}</ol>` : '<p class="ops-empty-line">Aucune activité.</p>';
      }
      // Demandes
      const shared = d.location_lat != null;
      return `<dl class="ops-fields">
          ${field('Téléphone', d.customer_phone ? `<a href="tel:${esc(String(d.customer_phone).replace(/\s+/g, ''))}">${esc(d.customer_phone)}</a>` : '')}
          ${field('Destination', esc([d.neighborhood, d.landmark].filter(Boolean).join(' · ')))}
          ${field('Position', shared ? chip('Partagée', 'green') : chip(d.submitted_at ? 'Manquante' : 'Pas encore', d.submitted_at ? 'red' : 'grey'))}
          ${field('Créneau', esc(d.requested_time || ''))}
          ${field('Photos du lieu', d.photo_ids?.length ? plural(d.photo_ids.length, 'photo', 'photos') : '')}
          ${field('Remarques', esc(d.notes || ''))}
          ${d.order_id ? field('Commande', `${esc(d.order_reference || `CMD-${d.order_id}`)} · ${esc(d.order_status || '')}`) : ''}
        </dl>
        ${!d.submitted_at ? '<p class="ops-empty-line">Le client n’a pas encore rempli le formulaire. Le profil client sera créé avec ses réponses.</p>' : ''}
        <div class="ops-fiche-actions"><button type="button" class="ops-btn ops-primary" data-act="fiche-manage">${d.status === 'À vérifier' ? 'Valider la demande' : 'Ouvrir la demande'}${ic('arrow-right')}</button></div>`;
    }

    function activity() {
      const d = st.fiche.data;
      const items = [];
      (d.events || []).forEach((e) => items.push({ at: e.created_at, title: e.from_status ? `${e.from_status} → ${e.to_status}` : `Commande ${String(e.to_status || 'créée').toLowerCase()}`, body: e.reason, who: e.actor_name }));
      (d.opsActivity || []).forEach((a) => items.push({ at: a.created_at, title: a.action === 'reassigned' ? `Attribuée à ${a.to_driver_name || 'un autre livreur'}` : a.action === 'trashed' ? 'Mise à la corbeille' : 'Restaurée depuis la corbeille', who: a.actor_name }));
      (d.incidents || []).forEach((i) => items.push({ at: i.created_at, title: `Incident : ${INC_CATEGORY[i.category] || i.category}`, body: i.description, who: i.opened_by }));
      (d.paymentEvents || []).forEach((p) => items.push({ at: p.created_at, title: p.event_type === 'collected' ? `Encaissement déclaré : ${money(p.amount_minor, p.currency)}` : `Paiement : ${p.event_type}`, body: p.reason, who: p.actor_name }));
      items.sort((a, b) => new Date(b.at) - new Date(a.at));
      return items.length ? `<ol class="ops-acts">${items.map((it) => `<li><b>${esc(it.title)}</b>${it.body ? `<p>${esc(it.body)}</p>` : ''}<small>${esc(when(it.at))}${it.who ? ` · ${esc(it.who)}` : ''}</small></li>`).join('')}</ol>` : '<p class="ops-empty-line">Aucune activité pour le moment.</p>';
    }

    function clientTab() {
      const f = st.fiche;
      if (f.cust === undefined || f.cust === 'loading') return '<div class="ops-state"><span class="ops-spin"></span>Chargement du client…</div>';
      if (f.cust === null) {
        const d = f.data;
        const name = st.source === 'incidents' ? d.incident?.customer_name : d.customer_name;
        const phone = st.source === 'incidents' ? d.incident?.customer_phone : d.customer_phone;
        return `<div class="ops-cust-head">${avatar(name || '?')}<div><b>${esc(name || 'Client inconnu')}</b><small>${esc(phone || '')}</small></div></div>
          <p class="ops-empty-line">${st.source === 'demandes' && !d.submitted_at ? 'La fiche client sera créée quand le client aura rempli le formulaire.' : 'Cet élément n’est pas encore rattaché à une fiche client.'}</p>`;
      }
      if (f.cust.error) return `<div class="ops-state ops-error">${esc(f.cust.error)}</div>`;
      const { customer, contacts = [], locations = [], orders = [], openIncidents = 0 } = f.cust;
      const phones = contacts.filter((c) => c.kind === 'phone' && c.is_active !== false);
      const emails = contacts.filter((c) => c.kind === 'email' && c.is_active !== false);
      const loc = locations.find((l) => l.is_active !== false) || locations[0];
      const delivered = orders.filter((o) => o.status === 'Livrée').length;
      return `<div class="ops-cust-head">${avatar(customer.display_name)}<div><b>${esc(customer.display_name)}</b><small>${esc(customer.customer_code || '')}${customer.created_at ? ` · Depuis ${esc(since(customer.created_at))}` : ''}</small></div></div>
        <div class="ops-tags">${chip(customer.customer_type === 'organization' ? 'Entreprise' : 'Particulier', 'grey')}${customer.sector ? chip(customer.sector, 'blue') : ''}${customer.status === 'do_not_contact' ? chip('Ne pas contacter', 'red') : ''}</div>
        <div class="ops-counters"><div><b>${orders.length}${orders.length >= 100 ? '+' : ''}</b><span>${orders.length > 1 ? 'commandes' : 'commande'}</span></div><div><b>${delivered}</b><span>${delivered > 1 ? 'livrées' : 'livrée'}</span></div><div><b>${openIncidents}</b><span>${openIncidents > 1 ? 'incidents ouverts' : 'incident ouvert'}</span></div></div>
        <dl class="ops-fields ops-fields-2">
          ${field('Téléphone', phones.map((p) => `<a href="tel:${esc(String(p.value_display).replace(/\s+/g, ''))}">${esc(p.value_display)}</a>`).join('<br>'))}
          ${emails.length ? field('E-mail', emails.map((e) => `<a href="mailto:${esc(e.value_display)}">${esc(e.value_display)}</a>`).join('<br>')) : ''}
          ${customer.preferred_language ? field('Langue', esc(customer.preferred_language)) : ''}
          ${loc ? field('Adresse de livraison', `${esc([loc.neighborhood, loc.address_text].filter(Boolean).join(' · ') || loc.label || '')}${loc.landmark ? `<small>${esc(loc.landmark)}</small>` : ''}`) : ''}
        </dl>
        <form class="ops-note-form" data-form="note">
          <div class="ops-note-label"><label for="opsNote">Note interne</label><small>Votre équipe uniquement</small></div>
          <textarea id="opsNote" name="note" maxlength="2000" rows="3" placeholder="Ex. Appeler à l’arrivée.">${esc(customer.service_notes || '')}</textarea>
          <button type="submit" class="ops-btn ops-sm">${ic('save')}Enregistrer la note</button>
        </form>
        ${orders.length ? `<h3 class="ops-sub">Commandes de ce client</h3><ul class="ops-mini">${orders.slice(0, 6).map((o) => `<li><button type="button" data-act="fiche-order" data-id="${esc(o.id)}"><span><b>${esc(o.reference || `CMD-${o.id}`)}</b><small>${esc(when(o.created_at))}</small></span>${chip(o.status, ORDER_TONE[o.status])}${ic('chevron-right')}</button></li>`).join('')}</ul>` : ''}`;
    }

    // ---- Actions ----------------------------------------------------------
    function resetSelection() { st.sel.clear(); st.confirm = false; }
    async function switchSource(src, pill) {
      if (!SOURCES[src]) return;
      const changed = src !== st.source;
      st.source = src; st.viewId = null; st.trash = false; st.query = ''; st.page = 1; st.fiche = null; st.panel = null;
      st.cfg = normalizeCfg(src, store.get(`traxo.ops.general.${src}`));
      if (pill) st.cfg.pill = pill;
      resetSelection();
      try { history.replaceState(null, '', `/app/operations?vue=${src}`); } catch { /* ignore */ }
      if (changed) { st.raw = []; st.extra = []; st.loading = true; draw(); await load(); }
      draw();
    }
    async function applyView(id) {
      if (!id) {
        st.viewId = null;
        st.cfg = normalizeCfg(st.source, store.get(`traxo.ops.general.${st.source}`));
        st.page = 1; resetSelection(); st.panel = null; draw(); return;
      }
      const v = st.views.find((x) => x.id === id);
      if (!v) return;
      const changed = v.source !== st.source;
      st.source = v.source; st.viewId = v.id; st.cfg = normalizeCfg(v.source, v.config);
      st.page = 1; st.query = ''; st.trash = false; st.panel = null; st.fiche = changed ? null : st.fiche; resetSelection();
      try { history.replaceState(null, '', `/app/operations?vue=${v.source}`); } catch { /* ignore */ }
      if (changed) { st.raw = []; st.extra = []; st.loading = true; draw(); await load(); }
      draw();
    }
    function cfgChanged({ keepSelection = false } = {}) {
      st.page = 1;
      if (!keepSelection) resetSelection();
      saveGeneral();
    }

    function selectedRows() { return st.raw.concat(st.extra).filter((r) => st.sel.has(String(r.id))); }

    function exportCsv() {
      const S0 = S();
      const chosen = filtered().filter((r) => st.sel.has(String(r.id)));
      const cols = st.cfg.columns.map((k) => S0.columns.find((c) => c.key === k)).filter(Boolean);
      const lines = [cols.map((c) => csvCell(c.label)).join(';')];
      chosen.forEach((r) => lines.push(cols.map((c) => csvCell(c.text ? c.text(r) : '')).join(';')));
      const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `traxo-${st.source}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      uiToast(`${plural(chosen.length, 'ligne exportée', 'lignes exportées')}.`, 'success');
    }

    async function trashSelected() {
      const S0 = S();
      const ids = selectedRows().filter((r) => S0.trashable(r)).map((r) => String(r.id));
      if (!ids.length) return;
      try {
        const out = await api('/api/app/ops/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: st.source, ids }) });
        resetSelection();
        flash(`${plural(out.done.length, 'élément déplacé', 'éléments déplacés')} dans la corbeille.${out.skipped.length ? ` ${out.skipped.length} non déplacé${out.skipped.length > 1 ? 's' : ''}.` : ''}`, 'ok', out.done.length ? { source: st.source, ids: out.done } : null);
        await reload();
      } catch (error) { uiToast(error.message, 'error'); }
    }
    async function restore(source, ids) {
      try {
        const out = await api('/api/app/ops/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, ids }) });
        resetSelection();
        flash(`${plural(out.done.length, 'élément restauré', 'éléments restaurés')}.`);
        await reload();
      } catch (error) { uiToast(error.message, 'error'); }
    }

    async function assignSelected() {
      const chosen = selectedRows();
      const eligible = chosen.filter((r) => !TERMINAL.includes(r.status));
      if (!eligible.length) { uiToast('Les commandes livrées, annulées ou retournées ne peuvent pas être attribuées.', 'error'); return; }
      let drivers = [];
      try { drivers = (await api('/api/app/drivers')).filter((d) => d.active && !d.suspended); } catch (error) { uiToast(error.message, 'error'); return; }
      if (!drivers.length) { uiToast('Aucun livreur actif. Ajoutez un livreur d’abord.', 'error'); return; }
      const skipped = chosen.length - eligible.length;
      const modal = openModal('Attribuer à un livreur', `<form id="opsAssign" class="ops-assign" novalidate>
          <p>${plural(eligible.length, 'commande', 'commandes')} à attribuer${skipped ? ` · ${skipped} ignorée${skipped > 1 ? 's' : ''} (déjà terminée${skipped > 1 ? 's' : ''})` : ''}.</p>
          <div class="field"><label for="opsAssignDriver">Livreur</label><select id="opsAssignDriver" name="driver">${drivers.map((d) => {
            const full = d.activeOrders >= d.capacity;
            return `<option value="${esc(d.id)}">${esc(d.name)} — ${esc(d.activeOrders)} colis / capacité ${esc(d.capacity)}${full ? ' (complet)' : ''}</option>`;
          }).join('')}</select></div>
          <p class="muted">La capacité du livreur est vérifiée pour chaque commande. Celles qui la dépassent restent à leur livreur actuel.</p>
          <div id="opsAssignErr" role="alert"></div></form>`, '<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button primary" id="opsAssignGo" type="button">Attribuer</button>');
      modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
      modal.backdrop.querySelector('#opsAssignGo').addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        const driverId = Number(modal.backdrop.querySelector('#opsAssignDriver').value);
        btn.disabled = true; btn.textContent = 'Attribution…';
        let ok = 0; const refused = [];
        for (const r of eligible) {
          try {
            await api(`/api/app/orders/${encodeURIComponent(r.id)}/reassign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId, checkCapacity: true }) });
            ok += 1;
          } catch (error) { refused.push(error.message); }
        }
        modal.close();
        resetSelection();
        flash(`${plural(ok, 'commande attribuée', 'commandes attribuées')}.${refused.length ? ` ${refused.length} non attribuée${refused.length > 1 ? 's' : ''} : ${refused[0]}` : ''}`, refused.length && !ok ? 'warn' : 'ok');
        await reload();
      });
    }

    async function submitView(form) {
      const fd = new FormData(form);
      const v = st.editView;
      const source = v ? v.source : st.formSource;
      const S1 = SOURCES[source];
      const err = form.querySelector('.ops-form-error');
      const name = String(fd.get('name') || '').trim();
      if (!name) { err.textContent = 'Donnez un nom à la vue.'; form.name.focus(); return; }
      const base = v ? normalizeCfg(v.source, v.config) : (source === st.source ? JSON.parse(JSON.stringify(st.cfg)) : defaultCfg(source));
      const cols = S1.columns.filter((c) => c.required).map((c) => c.key).concat(fd.getAll('col').map(String));
      const ordered = base.columns.filter((k) => cols.includes(k)).concat(cols.filter((k) => !base.columns.includes(k)));
      const config = { ...base, layout: fd.get('layout') === 'cards' ? 'cards' : 'table', density: fd.get('density') === 'compact' ? 'compact' : 'comfortable', pageSize: Number(fd.get('pageSize')) || 10, columns: [...new Set(ordered)] };
      if (fd.has('zone')) config.filters = { ...config.filters, zone: fd.get('zone') ? [String(fd.get('zone'))] : [] };
      const body = { name, config };
      if (canShare) body.shared = fd.get('shared') === 'on';
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        let saved;
        if (v) saved = await api(`/api/app/ops/views/${encodeURIComponent(v.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        else saved = await api('/api/app/ops/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, source }) });
        st.views = st.views.filter((x) => x.id !== saved.id).concat(saved);
        st.editView = null;
        flash(v ? 'La vue est enregistrée.' : `La vue « ${saved.name} » est créée.`);
        await applyView(saved.id);
      } catch (error) { err.textContent = error.message; btn.disabled = false; }
    }

    async function saveViewChanges() {
      const v = activeView();
      if (!v) return;
      try {
        const saved = await api(`/api/app/ops/views/${encodeURIComponent(v.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: st.cfg }) });
        st.views = st.views.map((x) => (x.id === saved.id ? saved : x));
        flash('Les changements sont enregistrés dans la vue.');
        draw();
      } catch (error) { uiToast(error.message, 'error'); }
    }

    async function duplicateView(id) {
      const v = st.views.find((x) => x.id === id);
      if (!v) return;
      try {
        const saved = await api('/api/app/ops/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: v.source, name: `${v.name} · copie`.slice(0, 60), config: v.config }) });
        st.views.push(saved);
        flash(`La vue « ${saved.name} » est créée.`);
        draw();
      } catch (error) { uiToast(error.message, 'error'); }
    }
    async function deleteView(id) {
      const v = st.views.find((x) => x.id === id);
      if (!v) return;
      if (!(await uiConfirm(`Supprimer la vue « ${v.name} » ?`, { message: v.shared ? 'Elle disparaîtra pour toute l’équipe. Les données ne sont pas touchées.' : 'Les données ne sont pas touchées.', confirmLabel: 'Supprimer la vue', tone: 'danger' }))) return;
      try {
        await api(`/api/app/ops/views/${encodeURIComponent(id)}`, { method: 'DELETE' });
        st.views = st.views.filter((x) => x.id !== id);
        if (st.viewId === id) { st.viewId = null; st.cfg = normalizeCfg(st.source, store.get(`traxo.ops.general.${st.source}`)); }
        flash('La vue a été supprimée. Les données sont conservées.');
        draw();
      } catch (error) { uiToast(error.message, 'error'); }
    }

    async function saveNote(form) {
      const f = st.fiche;
      const cid = f?.cust?.customer?.id;
      if (!cid) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        await api(`/api/app/crm/customers/${encodeURIComponent(cid)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceNotes: form.note.value }) });
        f.cust.customer.service_notes = form.note.value.trim();
        uiToast('Note enregistrée pour votre équipe.', 'success');
      } catch (error) { uiToast(error.message, 'error'); }
      btn.disabled = false;
    }

    // ---- Événements (délégués) ------------------------------------------
    root.addEventListener('click', async (event) => {
      const t = event.target.closest('[data-act]');
      const rowEl = event.target.closest('[data-row]');
      if (!t && rowEl && !event.target.closest('input, a, button, label, select')) { openFiche(rowEl.dataset.row); return; }
      if (!t) return;
      const act = t.dataset.act;
      if (act === 'tab') return switchSource(t.dataset.src);
      if (act === 'stat') return switchSource(t.dataset.src, t.dataset.pill);
      if (act === 'view') return applyView(t.dataset.id);
      if (act === 'create-view') { st.panel = 'create'; st.editView = null; st.formSource = st.source; draw(); root.querySelector('[data-form="view"] input[name="name"]')?.focus(); return; }
      if (act === 'manage-views') { st.panel = st.panel === 'manage' ? null : 'manage'; draw(); return; }
      if (act === 'view-edit') { st.editView = st.views.find((x) => x.id === t.dataset.id) || null; st.formSource = st.editView?.source || st.source; st.panel = 'create'; draw(); return; }
      if (act === 'view-dup') return duplicateView(t.dataset.id);
      if (act === 'view-del') return deleteView(t.dataset.id);
      if (act === 'save-view') return saveViewChanges();
      if (act === 'panel') { st.panel = st.panel === t.dataset.p ? null : t.dataset.p; draw(); return; }
      if (act === 'close-panel') { st.panel = null; st.editView = null; draw(); return; }
      if (act === 'pill') { st.cfg.pill = t.dataset.pill; cfgChanged(); draw(); return; }
      if (act === 'layout') { st.cfg.layout = t.dataset.l; saveGeneral(); draw(); return; }
      if (act === 'sort') { const k = t.dataset.k; st.cfg.sort = st.cfg.sort?.key === k ? { key: k, dir: -st.cfg.sort.dir } : { key: k, dir: 1 }; cfgChanged({ keepSelection: true }); draw(); return; }
      if (act === 'trash-toggle') { st.trash = !st.trash; st.page = 1; st.fiche = null; st.raw = []; st.loading = true; resetSelection(); draw(); await load(); draw(); return; }
      if (act === 'new') {
        const c = S().create;
        if (c?.href) { location.href = c.href; return; }
        if (c?.action && deps[c.action]) deps[c.action](() => reload());
        return;
      }
      if (act === 'open') { openFiche(t.dataset.id); return; }
      if (act === 'sel-all') { filtered().forEach((r) => st.sel.add(String(r.id))); renderList(); return; }
      if (act === 'sel-clear') { resetSelection(); renderList(); return; }
      if (act === 'bulk-export') return exportCsv();
      if (act === 'bulk-assign') return assignSelected();
      if (act === 'bulk-trash') { st.confirm = true; renderList(); root.querySelector('.ops-confirm button')?.focus(); return; }
      if (act === 'cancel-confirm') { st.confirm = false; renderList(); return; }
      if (act === 'confirm-trash') return trashSelected();
      if (act === 'bulk-restore') return restore(st.source, selectedRows().map((r) => String(r.id)));
      if (act === 'undo') { const u = st.flash?.undo; st.flash = null; if (u) restore(u.source, u.ids); return; }
      if (act === 'flash-close') { st.flash = null; root.querySelector('.ops-flash')?.remove(); return; }
      if (act === 'pg') { st.page = Math.max(1, Number(t.dataset.p) || 1); renderList(); root.querySelector('#opsMain')?.scrollIntoView({ block: 'nearest' }); return; }
      if (act === 'col-move') {
        const k = t.dataset.k; const dir = Number(t.dataset.d);
        const cols = st.cfg.columns; const i = cols.indexOf(k); const j = i + dir;
        if (i < 0 || j < 0 || j >= cols.length) return;
        [cols[i], cols[j]] = [cols[j], cols[i]];
        saveGeneral(); draw(); return;
      }
      if (act === 'cols-reset') { st.cfg.columns = S().defaults.slice(); saveGeneral(); draw(); return; }
      if (act === 'filter-clear') { st.cfg.filters = { status: [], zone: [], driver: [] }; cfgChanged(); draw(); return; }
      if (act === 'reset-filters') { st.query = ''; st.extra = []; st.cfg.filters = { status: [], zone: [], driver: [] }; st.cfg.pill = 'all'; cfgChanged(); draw(); return; }
      if (act === 'retry') { await load(); draw(); return; }
      if (act === 'fiche-close') { st.fiche = null; draw(); return; }
      if (act === 'fiche-tab') { st.fiche.tab = t.dataset.t; renderFiche(); if (st.fiche.tab === 'client') loadCustomer(); return; }
      if (act === 'fiche-manage') { openExisting(st.fiche.id); return; }
      if (act === 'fiche-order') {
        if (st.source !== 'commandes') { await switchSource('commandes'); }
        openFiche(t.dataset.id, 'livraison');
        return;
      }
      if (act === 'pickup-edit') { deps.openPickupEditor(st.fiche.data, () => reload()); }
    });

    root.addEventListener('change', (event) => {
      const t = event.target;
      if (t.dataset.sel) {
        if (t.checked) st.sel.add(t.dataset.sel); else st.sel.delete(t.dataset.sel);
        st.confirm = false; renderList(); return;
      }
      if (t.dataset.actChange === 'sel-page') {
        const all = filtered();
        const from = (st.page - 1) * st.cfg.pageSize;
        all.slice(from, from + st.cfg.pageSize).forEach((r) => { if (t.checked) st.sel.add(String(r.id)); else st.sel.delete(String(r.id)); });
        st.confirm = false; renderList(); return;
      }
      if (t.dataset.col) {
        const k = t.dataset.col;
        if (t.checked && !st.cfg.columns.includes(k)) st.cfg.columns.push(k);
        if (!t.checked) st.cfg.columns = st.cfg.columns.filter((x) => x !== k);
        saveGeneral(); draw(); return;
      }
      if (t.dataset.f) {
        const list = st.cfg.filters[t.dataset.f];
        const v = String(t.value);
        if (t.checked && !list.includes(v)) list.push(v);
        if (!t.checked) st.cfg.filters[t.dataset.f] = list.filter((x) => x !== v);
        cfgChanged(); draw(); return;
      }
      if (t.dataset.d === 'formSource') { st.formSource = t.value; const name = root.querySelector('[data-form="view"] input[name="name"]')?.value || ''; draw(); const input = root.querySelector('[data-form="view"] input[name="name"]'); if (input) input.value = name; return; }
      if (t.dataset.d && !t.closest('[data-form="view"]')) {
        const k = t.dataset.d;
        if (k === 'layout') st.cfg.layout = t.value === 'cards' ? 'cards' : 'table';
        if (k === 'density') st.cfg.density = t.value === 'compact' ? 'compact' : 'comfortable';
        if (k === 'pageSize') { st.cfg.pageSize = SIZES.includes(Number(t.value)) ? Number(t.value) : 10; st.page = 1; }
        if (k === 'sortKey') st.cfg.sort = { key: t.value, dir: st.cfg.sort?.dir || -1 };
        if (k === 'sortDir') st.cfg.sort = { key: st.cfg.sort?.key || S().sort.key, dir: Number(t.value) < 0 ? -1 : 1 };
        if (k === 'group') st.cfg.group = t.value || null;
        saveGeneral(); draw();
      }
    });

    root.addEventListener('input', (event) => {
      if (event.target.dataset.input !== 'search') return;
      st.query = event.target.value.trim();
      st.page = 1; resetSelection();
      serverSearch();
      renderList();
    });

    root.addEventListener('submit', (event) => {
      const form = event.target;
      event.preventDefault();
      if (form.dataset.form === 'view') return submitView(form);
      if (form.dataset.form === 'note') return saveNote(form);
      if (form.dataset.form === 'goto') {
        const total = Math.max(1, Math.ceil(filtered().length / st.cfg.pageSize));
        st.page = Math.min(total, Math.max(1, Number(form.p.value) || 1));
        renderList();
      }
    });

    const onKey = (event) => {
      if (event.key !== 'Escape' || !document.body.contains(root)) return;
      if (document.querySelector('.modal-backdrop, .crm-drawer-wrap')) return;
      if (event.target.closest?.('input, textarea, select')) return;
      if (st.fiche) { st.fiche = null; draw(); } else if (st.panel) { st.panel = null; draw(); }
    };
    document.addEventListener('keydown', onKey);
    const onMedia = () => { if (document.body.contains(root)) draw(); };
    narrow.addEventListener?.('change', onMedia);
    wide.addEventListener?.('change', onMedia);

    draw();
    await Promise.all([loadCounts(), loadViews(), load()]);
    draw();

    // Arrivée depuis une notification : …?vue=commandes&commande=ID
    const focus = { commandes: 'commande', demandes: 'demande', incidents: 'incident', tournees: 'tournee' }[st.source];
    const fid = params.get(focus);
    if (/^\d{1,18}$/.test(fid || '')) {
      params.delete(focus);
      try { history.replaceState(null, '', `${location.pathname}?${params.toString()}`); } catch { /* ignore */ }
      // Une demande arrive pour être traitée : on ouvre directement son tiroir.
      if (st.source === 'demandes' || st.source === 'tournees') openExisting(fid); else openFiche(fid);
    }
  }

  // ---- Entrée des opérations (kit « Entrée ») ------------------------------
  // Deux écrans : l'accueil (Nouvelle livraison / Suivre l'activité) et
  // Nouvelle livraison (Demander sa position / Saisir ses coordonnées). Les
  // parcours eux-mêmes ne changent pas : lien client, formulaire de commande,
  // table de suivi.
  const ENTRY_ART = {
    nouvelle: '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="460" height="240" viewBox="0 0 460 240"><ellipse cx="238" cy="211" rx="119" ry="9" fill="#eae3de" opacity=".55"/><g transform="rotate(-8 230 130)"><rect x="117" y="54" width="222" height="142" rx="15" fill="#ede6e0" stroke="none"/></g><g class="float-part"><rect x="113" y="47" width="238" height="151" rx="14" fill="#fff" stroke="#e6e0dc"/><rect x="134" y="67" width="35" height="35" rx="10" fill="#fce9ed" stroke="none"/><svg x="142" y="75" style="width:19px;height:19px" class="lucide lucide-package" xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#d43852" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" /><path d="m7.5 4.27 9 5.15" /></svg><text x="182" y="83" font-family="Arial,sans-serif" font-size="9" fill="#9e8790" font-weight="400">UNE NOUVELLE LIVRAISON</text><text x="182" y="99" font-family="Arial,sans-serif" font-size="10" fill="#69727d" font-weight="400">Tout commence avec un client.</text><rect x="134" y="123" width="126" height="5" rx="2" fill="#e6eaed" stroke="none"/><rect x="134" y="138" width="166" height="5" rx="2" fill="#eff1f3" stroke="none"/><rect x="134" y="153" width="91" height="5" rx="2" fill="#eff1f3" stroke="none"/><text x="134" y="179" font-family="Arial,sans-serif" font-size="10" fill="#9ba3ac" font-weight="400">Client / Adresse / Livreur</text></g><g class="float-part delay"><circle cx="344" cy="58" r="23" fill="#e81735"/><svg x="332" y="46" style="width:24px;height:24px" class="lucide lucide-plus" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M5 12h14" /><path d="M12 5v14" /></svg></g></svg>',
    activite: '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="460" height="240" viewBox="0 0 460 240"><path d="M114 73V176" fill="none" stroke="#d6e2dd" stroke-width="2"/><g><rect x="91" y="39" width="265" height="49" rx="11" fill="#e3e9e7" stroke="none"/><rect x="88" y="35" width="265" height="49" rx="11" fill="#fff" stroke="#e2e9e7"/><rect x="101" y="46" width="28" height="28" rx="8" fill="#f7ede1" stroke="none"/><svg x="107" y="52" style="width:16px;height:16px" class="lucide lucide-package" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9c8264" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" /><path d="m7.5 4.27 9 5.15" /></svg><text x="141" y="65" font-family="Arial,sans-serif" font-size="12" fill="#9c8264" font-weight="500">À préparer</text><rect x="271" y="58" width="59" height="4" rx="2" fill="#eaf0ed" stroke="none"/></g><g class="float-part"><rect x="110" y="102" width="265" height="49" rx="11" fill="#e3e9e7" stroke="none"/><rect x="107" y="98" width="265" height="49" rx="11" fill="#fff" stroke="#e2e9e7"/><rect x="120" y="109" width="28" height="28" rx="8" fill="#edf2f8" stroke="none"/><svg x="126" y="115" style="width:16px;height:16px" class="lucide lucide-bike" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#647f9f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><circle cx="18.5" cy="17.5" r="3.5" /><circle cx="5.5" cy="17.5" r="3.5" /><circle cx="15" cy="5" r="1" /><path d="M12 17.5V14l-3-3 4-3 2 3h2" /></svg><text x="160" y="128" font-family="Arial,sans-serif" font-size="12" fill="#647f9f" font-weight="500">En livraison</text><rect x="290" y="121" width="59" height="4" rx="2" fill="#eaf0ed" stroke="none"/></g><g><rect x="129" y="165" width="265" height="49" rx="11" fill="#e3e9e7" stroke="none"/><rect x="126" y="161" width="265" height="49" rx="11" fill="#fff" stroke="#e2e9e7"/><rect x="139" y="172" width="28" height="28" rx="8" fill="#edf5ef" stroke="none"/><svg x="145" y="178" style="width:16px;height:16px" class="lucide lucide-check" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#648a74" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M20 6 9 17l-5-5" /></svg><text x="179" y="191" font-family="Arial,sans-serif" font-size="12" fill="#648a74" font-weight="500">Livrée</text><rect x="309" y="184" width="59" height="4" rx="2" fill="#eaf0ed" stroke="none"/></g></svg>',
  };
  function entryCard({ href, act, art, kicker, title, copy, cta, hint, tone }) {
    const inner = `<span class="ope-art" aria-hidden="true">${art}</span>
      <span class="ope-copy">${kicker ? `<span class="ope-kicker">${esc(kicker)}</span>` : ''}<h2>${esc(title)}</h2><p>${esc(copy)}</p>
        <span class="ope-bottom"><span class="ope-cta">${esc(cta)}${ic('arrow-right')}</span>${hint ? `<span class="ope-hint">${esc(hint)}</span>` : ''}</span></span>`;
    return href
      ? `<a class="ope-choice ${tone || ''}" href="${esc(href)}">${inner}</a>`
      : `<button type="button" class="ope-choice ${tone || ''}" data-entry="${esc(act)}">${inner}</button>`;
  }
  function renderEntry(page, deps, screen) {
    const { api, publicLink, actionKey } = deps;
    page.classList.add('page-ops');
    const home = screen !== 'new';
    page.innerHTML = `<div class="ope">
      <nav class="ope-crumb" aria-label="Fil d’Ariane">${home ? '<span>Opérations</span>' : `<a href="/app/operations">Opérations</a>${ic('chevron-right')}<span>Nouvelle livraison</span>`}</nav>
      <div class="ope-content">
        ${home ? `<section class="ope-intro"><div class="ope-eyebrow">Votre espace opérations</div><h1>Chaque livraison commence ici.</h1><p>Préparez la prochaine, ou retrouvez celles déjà en route.</p></section>
          <div class="ope-choices">
            ${entryCard({ href: '/app/operations?vue=creer', art: ENTRY_ART.nouvelle, kicker: 'Préparer', title: 'Nouvelle livraison', copy: 'Le client partage sa position, ou vous renseignez ses informations.', cta: 'Commencer', hint: 'Deux façons de démarrer' })}
            ${entryCard({ href: '/app/operations?vue=commandes', art: ENTRY_ART.activite, kicker: 'Piloter', title: 'Suivre l’activité', copy: 'Retrouvez vos commandes, demandes, tournées et incidents au même endroit.', cta: 'Ouvrir le suivi', hint: 'Toute votre activité', tone: 'secondary' })}
          </div>`
        : `<a class="ope-back" href="/app/operations">${ic('arrow-left')}Retour aux opérations</a>
          <section class="ope-intro"><h1>Nouvelle livraison</h1><p>Demandez sa position au client ou utilisez l’adresse que vous avez déjà.</p></section>
          <div class="ope-choices delivery">
            ${entryCard({ act: 'client-link', art: '<img src="/img/entry-position-client.webp" alt="" width="840" height="560">', title: 'Demander sa position', copy: 'Envoyez un lien au client. Il indique son nom, son téléphone et partage sa position. Vous validez ensuite la demande.', cta: 'Créer le lien', hint: 'Sans compte client' })}
            ${entryCard({ href: '/app/nouvelle-commande', art: '<img src="/img/entry-livraison-scooter.webp" alt="" width="840" height="560">', title: 'Saisir ses coordonnées', copy: 'Vous connaissez déjà son adresse ? Renseignez son nom, son téléphone et le lieu de livraison.', cta: 'Saisir la commande', tone: 'secondary' })}
          </div>
          <div id="opeLink" aria-live="polite"></div>`}
      </div>
    </div>`;
    const linkBtn = page.querySelector('[data-entry="client-link"]');
    if (!linkBtn) return;
    linkBtn.addEventListener('click', async () => {
      const panel = page.querySelector('#opeLink');
      linkBtn.disabled = true;
      panel.innerHTML = '<div class="ope-panel"><div class="ops-state"><span class="ops-spin"></span>Création du lien…</div></div>';
      try {
        const result = await api('/api/app/request-links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: actionKey('request-link') }) });
        const url = publicLink(result.path);
        const wa = encodeURIComponent(`Bonjour, pour organiser votre livraison, merci de remplir vos informations ici : ${url}`);
        panel.innerHTML = `<div class="ope-panel">
          <div><h2>Le lien est prêt : envoyez-le au client</h2><p>Il remplit ses informations et partage sa position. Le lien reste valable 7 jours ; vous êtes prévenu dès qu’il est rempli.</p></div>
          <div class="ope-linkrow"><input type="text" readonly value="${esc(url)}" aria-label="Lien à envoyer au client"><button type="button" class="ops-btn" data-copy>${ic('copy')}Copier</button></div>
          <div class="ope-linkactions"><a class="ops-btn ops-primary" target="_blank" rel="noopener" href="https://wa.me/?text=${wa}">Partager sur WhatsApp</a><a class="ops-btn" target="_blank" rel="noopener" href="${esc(url)}">Voir ce que reçoit le client</a><a class="ops-btn ops-ghost" href="/app/operations?vue=demandes">Suivre les demandes${ic('arrow-right')}</a></div>
        </div>`;
        const input = panel.querySelector('input');
        panel.querySelector('[data-copy]').addEventListener('click', (event) => {
          input.select();
          try { navigator.clipboard?.writeText(input.value); } catch { /* le lien reste sélectionné */ }
          event.currentTarget.innerHTML = `${ic('check')}Copié`;
        });
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (error) {
        panel.innerHTML = `<div class="ope-panel"><div class="ops-state ops-error">${esc(error.message)}</div></div>`;
      } finally {
        linkBtn.disabled = false;
      }
    });
  }

  window.TraxoOps = { render, renderEntry };
}());
