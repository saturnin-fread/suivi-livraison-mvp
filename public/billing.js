// Facturation (kit « Facturation TRAXO » V2.2) : Portefeuille, Mouvements,
// Tarifs & bonus, recharge en deux étapes, préférences et aide, plus la jauge
// d'utilisation de la navigation. Toutes les valeurs viennent de
// /api/app/billing/* : un solde ou un volume inconnu s'affiche « — », jamais 0.
//
// Les « commandes offertes » d'une recharge sont un équivalent estimé au prix
// le plus élevé de la grille (le portefeuille reste en FCFA, aucun quota n'est
// créé) ; le bonus réel est calculé et crédité par le serveur.
(function () {
  'use strict';

  // Icônes Lucide (licence ISC).
  const ICONS = {
    'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    'sliders-horizontal': '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    'package': '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    'check-check': '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
    'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'headset': '<path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/><path d="M21 16v2a4 4 0 0 1-4 4h-5"/>',
    'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    'circle-alert': '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    'credit-card': '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
    'smartphone': '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    'settings': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  };
  const icon = (name, cls = 'bl-ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  const IMG = '/img/billing';

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => new Intl.NumberFormat('fr-FR').format(n);
  const money = (n) => `${n < 0 ? '−' : ''}${fmt(Math.abs(n))} F`;
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))} F`;
  const pct = (n) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(n);
  const plural = (n, one, many) => `${fmt(n)} ${n > 1 ? many : one}`;
  const TZ = 'Africa/Porto-Novo';
  const dShort = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', timeZone: TZ });
  const dLong = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ });
  const dFull = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const dayDate = (day) => new Date(`${day}T12:00:00Z`); // « AAAA-MM-JJ » → midi UTC, même jour au Bénin
  const monthLabel = (ym) => {
    const s = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-15T12:00:00Z`));
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Règles de présentation (le serveur reste la référence) ---------------
  // Palier de la prochaine commande et progression vers le palier suivant.
  function tierModel(tiers, count) {
    if (!Array.isArray(tiers) || !tiers.length || !Number.isSafeInteger(count) || count < 0) return { known: false };
    const idx = Math.max(0, tiers.findIndex((t) => t.upTo == null || count + 1 <= t.upTo));
    const min = idx === 0 ? 0 : tiers[idx - 1].upTo;
    const target = tiers[idx].upTo;
    return {
      known: true, count, idx, min, target, price: tiers[idx].price,
      next: target != null && tiers[idx + 1] ? tiers[idx + 1].price : null,
      ratio: target != null ? Math.min(1, (count - min) / (target - min)) : 1,
    };
  }
  const tierRange = (tiers, i) => {
    const from = i === 0 ? 1 : tiers[i - 1].upTo + 1;
    if (tiers[i].upTo == null) return `À partir de ${fmt(from)}`;
    return i === 0 ? `De 1 à ${fmt(tiers[i].upTo)} commandes` : `De ${fmt(from)} à ${fmt(tiers[i].upTo)}`;
  };
  const referencePrice = (w) => Math.max(0, ...w.pricing.tiers.map((t) => t.price));
  // Montant saisi → recharge (même règle que le serveur : plus haut palier atteint, arrondi inférieur).
  function quote(raw, w) {
    let s = String(raw ?? '').replace(/[\s\u00a0\u202f]/g, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // « 5.000 » : séparateur de milliers
    const n = Number(s);
    const valid = /^\d+$/.test(s) && Number.isSafeInteger(n) && n >= w.recharge.min && n <= w.recharge.max;
    let percent = 0;
    if (valid) for (const b of w.pricing.rechargeBonus) if (n >= b.from) percent = b.percent;
    const bonus = valid ? Math.floor((n * percent) / 100) : 0;
    let error = '';
    if (!valid) {
      if (!s) error = 'Indiquez votre montant.';
      else if (!/^\d+$/.test(s)) error = 'Saisissez un montant entier, sans décimale.';
      else if (n < w.recharge.min) error = `La recharge commence à ${money(w.recharge.min)}.`;
      else error = `Le maximum est de ${money(w.recharge.max)} par recharge.`;
    }
    return { valid, raw: s, amount: valid ? n : 0, percent, bonus, total: valid ? n + bonus : 0, error };
  }
  // Équivalent en commandes d'une recharge (présentation seulement).
  function benefit(q, w) {
    const ref = referencePrice(w);
    if (!q.valid || !(ref > 0)) return { known: false, ref };
    const bought = Math.floor(q.amount / ref);
    const total = Math.floor(q.total / ref);
    const rates = w.pricing.rechargeBonus.map((b) => b.percent).filter((p) => p > 0);
    return {
      known: true, ref, bought, free: total - bought, total,
      remainder: q.total % ref,
      carry: total - bought - Math.floor(q.bonus / ref),
      saving: q.total ? (100 * q.bonus) / q.total : 0,
      stage: q.percent > 0 ? Math.min(3, rates.filter((p) => p <= q.percent).length) : 0,
    };
  }

  // ---- Mouvements -----------------------------------------------------------
  const KIND = {
    order_charge: ['Commande', 'package', '', 'Commandes'],
    order_refund: ['Commande remboursée', 'rotate-ccw', 'red', 'Remboursements'],
    recharge: ['Recharge du portefeuille', 'plus', 'green', 'Recharges'],
    bonus: ['Bonus de recharge', 'check-check', 'green', 'Bonus'],
    premium_report: ['Rapport Premium', 'file-text', '', 'Rapports Premium'],
    premium_month: ['Rapport Premium · 30 jours', 'file-text', '', 'Rapports Premium'],
    adjustment: ['Correction TRAXO', 'settings', '', 'Corrections TRAXO'],
  };
  const CATEGORIES = [['', 'Tous les mouvements'], ['orders', 'Commandes'], ['refunds', 'Remboursements'], ['recharges', 'Recharges'], ['bonus', 'Bonus'], ['premium', 'Rapports Premium'], ['adjustments', 'Corrections TRAXO']];
  const unitText = (m) => (m.unitPrice != null ? `${fmt(m.count)} × ${fmt(m.unitPrice)} F` : m.unitPriceRange ? `de ${fmt(m.unitPriceRange[0])} à ${fmt(m.unitPriceRange[1])} F` : '');
  function movementInfo(m) {
    const [label, ic, tone, category] = KIND[m.kind] || [m.kind, 'circle-help', '', 'Autre'];
    const at = new Date(m.createdAt);
    let name = label; let ref = '';
    if (m.type === 'day') { name = plural(m.count, 'commande', 'commandes'); ref = unitText(m); }
    else if (m.kind === 'order_charge' || m.kind === 'order_refund') ref = m.orderReference || (m.orderId ? `Commande n° ${m.orderId}` : '');
    else if (m.kind === 'recharge' || m.kind === 'bonus') ref = m.paymentReference || '';
    else ref = m.note || '';
    return { label, name, ref, ic, tone, category, at, positive: m.amount > 0 };
  }
  function movementRow(m, { recent = false } = {}) {
    const i = movementInfo(m);
    const when = m.type === 'day' ? dayDate(m.day) : i.at;
    const sub = [i.ref, dShort.format(when)].filter(Boolean).join(' · ');
    return `<button type="button" class="bl-move" data-move="${esc(m.type === 'day' ? `day:${m.day}` : m.id)}" aria-label="${esc(`${i.name}, ${dLong.format(when)}, ${signed(m.amount)}, confirmé. Voir le détail.`)}">
      <span class="bl-move-id"><span class="bl-micon ${i.tone}">${icon(i.ic)}</span><span><b>${esc(i.name)}</b><small>${esc(sub)}</small></span></span>
      ${recent ? '' : '<span class="bl-move-status"><span class="bl-badge"><i></i>Confirmé</span></span>'}
      <span class="bl-move-date">${esc(dLong.format(when))}</span>
      <span class="bl-move-value ${i.positive ? 'positive' : ''}">${esc(signed(m.amount))}</span>${icon('chevron-right', 'bl-ico bl-move-arrow')}</button>`;
  }

  // ---- Jauge d'utilisation (navigation) ------------------------------------
  // Mesure la progression entre les paliers de prix du mois. Ce n'est ni un
  // crédit restant ni un quota.
  const gauge = { w: null, error: false, deps: null };
  function gaugeHtml(w, { inline = false } = {}) {
    const m = w ? tierModel(w.pricing.tiers, w.month.orders) : { known: false };
    const label = m.known
      ? `${plural(m.count, 'commande facturée', 'commandes facturées')} ce mois-ci. ${fmt(m.price)} F la prochaine. ${m.target != null ? `Progression vers le tarif de ${fmt(m.next)} F : ${fmt(m.count)} sur ${fmt(m.target)} commandes.` : 'Tarif minimum atteint.'} Ouvrir les tarifs.`
      : 'Utilisation indisponible. Ouvrir la facturation.';
    const p = m.known ? Math.round(m.ratio * 1000) / 10 : 0;
    const ring = `<svg class="bl-gauge-ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="14" pathLength="100" class="bl-gauge-track"/><circle cx="18" cy="18" r="14" pathLength="100" class="bl-gauge-meter" style="stroke-dasharray:${p} 100"/></svg>`;
    if (inline) return `<button type="button" class="bl-gauge-pill" data-gauge aria-label="${esc(label)}" title="${esc(label)}">${ring}<span><strong>${m.known ? fmt(m.count) : '—'}</strong><span class="bl-gauge-pill-label"> ce mois-ci</span></span></button>`;
    return `<button type="button" class="bl-gauge-card" data-gauge aria-label="${esc(label)}" title="${esc(label)}">
      <span class="bl-gauge-full"><span class="bl-gauge-top"><span>Utilisation</span><b>${m.known ? plural(m.count, 'commande', 'commandes') : '—'}</b></span>
        <span class="bl-gauge-line"><span style="width:${p}%"></span></span>
        <span class="bl-gauge-bottom"><span>${m.known ? (m.next != null ? `Vers ${fmt(m.next)} F / cmd` : `${fmt(m.price)} F / commande`) : 'Données indisponibles'}</span><b>${m.known ? (m.target != null ? `${fmt(m.count)} / ${fmt(m.target)}` : 'Tarif minimum') : '—'}</b></span></span>
      <span class="bl-gauge-mini">${ring}</span></button>`;
  }
  function paintGauge() {
    const side = document.getElementById('blNavGauge');
    const top = document.getElementById('blTopGauge');
    if (side) side.innerHTML = gaugeHtml(gauge.w);
    if (top) top.innerHTML = gaugeHtml(gauge.w, { inline: true });
  }
  function openUsage() {
    if (document.getElementById('traxoBilling') && S.deps) { show('rates'); return; }
    location.href = '/app/parametres?section=billing&vue=tarifs';
  }
  async function mountGauge(deps) {
    gauge.deps = deps;
    if (!['owner', 'manager'].includes(deps.context?.user?.role)) return;
    const link = document.querySelector('.nav-bottom a[data-route="billing"]');
    if (link && !document.getElementById('blNavGauge')) link.insertAdjacentHTML('beforebegin', '<div class="bl-gauge" id="blNavGauge"></div>');
    const notif = document.querySelector('.topbar-actions .notif-menu');
    if (notif && !document.getElementById('blTopGauge')) notif.insertAdjacentHTML('beforebegin', '<div class="bl-gauge-top-slot" id="blTopGauge"></div>');
    document.addEventListener('click', (e) => { if (e.target.closest('[data-gauge]')) { document.getElementById('sidebar')?.classList.remove('open'); openUsage(); } });
    paintGauge();
    try { gauge.w = await deps.api('/api/app/billing/wallet'); } catch { gauge.w = null; }
    paintGauge();
  }
  function updateGauge(w) { gauge.w = w; paintGauge(); }

  // ---- Page Facturation -----------------------------------------------------
  const VIEW_PARAM = { wallet: null, history: 'mouvements', rates: 'tarifs', recharge: 'recharge' };
  const S = {
    deps: null, root: null, w: null, wError: null, view: 'wallet', returnView: 'wallet',
    step: 1, amount: '', result: null, payment: null, paid: null, busy: false,
    hist: { q: '', category: '', month: '', page: 1 }, histData: null, recent: null,
  };
  const canEdit = () => ['owner', 'manager'].includes(S.deps?.context?.user?.role);
  const histKey = () => `traxo.billing.hist.${S.deps.context.company.id}`;
  function saveHist() { try { sessionStorage.setItem(histKey(), JSON.stringify(S.hist)); } catch { /* stockage indisponible */ } }
  function loadHist() {
    try { const v = JSON.parse(sessionStorage.getItem(histKey()) || 'null'); if (v && typeof v === 'object') S.hist = { q: String(v.q || ''), category: String(v.category || ''), month: String(v.month || ''), page: Number(v.page) || 1 }; } catch { /* ignore */ }
  }
  const $ = (sel) => S.root.querySelector(sel);
  const $$ = (sel) => [...S.root.querySelectorAll(sel)];

  function setUrl() {
    const params = new URLSearchParams(location.search);
    params.set('section', 'billing');
    const v = VIEW_PARAM[S.view] ?? null;
    if (v) params.set('vue', v); else params.delete('vue');
    try { history.replaceState(null, '', `/app/parametres?${params}`); } catch { /* ignore */ }
  }

  async function render(box, deps) {
    S.deps = deps;
    loadHist();
    deps.setHeader?.('Facturation', 'Gardez un œil sur vos dépenses.');
    box.innerHTML = '<div class="bl" id="traxoBilling"><div class="bl-skeleton" aria-busy="true"><span></span><span></span><span></span></div></div>';
    S.root = box.querySelector('#traxoBilling');
    S.root.addEventListener('click', onClick);
    S.root.addEventListener('change', onChange);
    S.root.addEventListener('input', onInput);
    S.root.addEventListener('keydown', onKeydown);
    const vue = new URLSearchParams(location.search).get('vue');
    const wanted = Object.keys(VIEW_PARAM).find((k) => VIEW_PARAM[k] && VIEW_PARAM[k] === vue) || 'wallet';
    await loadWallet();
    S.view = 'wallet';
    if (wanted === 'recharge') startRecharge();
    else show(wanted);
  }

  async function loadWallet() {
    try { S.w = await S.deps.api('/api/app/billing/wallet'); S.wError = null; updateGauge(S.w); } catch (error) { S.wError = error; }
  }

  function show(view, { focusTab = false } = {}) {
    if (S.busy) { S.deps.uiToast('Le paiement est en cours de vérification.', 'info'); return; }
    if (view === 'history' && !canEdit()) view = 'wallet';
    S.view = view;
    if (['wallet', 'history', 'rates'].includes(view)) S.returnView = view;
    setUrl();
    paint();
    if (focusTab) $(`[data-view="${view}"]`)?.focus();
    if (view === 'history') loadHistory();
    if (view === 'wallet') loadRecent();
  }

  function paint() {
    let html;
    if (S.view === 'recharge') html = rechargeView();
    else if (S.view === 'result') html = resultView();
    else html = `${header()}<div class="bl-scene" id="blPanel" role="tabpanel" aria-labelledby="blTab-${S.view}" tabindex="-1">${S.view === 'wallet' ? walletView() : S.view === 'history' ? historyView() : ratesView()}</div>`;
    S.root.innerHTML = html + pageFoot();
    if (S.view === 'recharge' && S.step === 1) updateQuote({ animate: false });
  }

  const header = () => {
    const tabs = [['wallet', 'Portefeuille'], ...(canEdit() ? [['history', 'Mouvements']] : []), ['rates', 'Tarifs & bonus']];
    return `<div class="bl-head"><div><h1>Facturation</h1><p>Gardez un œil sur vos dépenses.</p></div>
      ${canEdit() && S.w ? `<button type="button" class="bl-btn secondary bl-prefs-btn" data-act="preferences" aria-label="Préférences de facturation">${icon('sliders-horizontal')}<span>Préférences</span></button>` : ''}</div>
      <div class="bl-tabsline"><div class="bl-tabs" role="tablist" aria-label="Vues de la facturation">${tabs.map(([id, t]) => `<button type="button" class="bl-tab" id="blTab-${id}" data-view="${id}" role="tab" aria-controls="blPanel" aria-selected="${S.view === id}" tabindex="${S.view === id ? '0' : '-1'}">${t}</button>`).join('')}</div>
      <button type="button" class="bl-utility" data-act="help">${icon('circle-help')}<span>Une question ?</span></button></div>`;
  };
  const pageFoot = () => `<footer class="bl-foot"><span>FCFA · ${S.w && !S.w.pricing.pricesIncludeTax ? 'Prix HT' : 'Prix TTC'} · Sans abonnement</span><button type="button" data-act="support">Un doute ? Parlons-en.</button></footer>`;

  // ---- Vue Portefeuille -------------------------------------------------------
  function walletNotice(w) {
    if (!w) return `<div class="bl-notice">${icon('circle-alert')}<span>Le solde n’a pas pu être chargé.</span><button type="button" data-act="retry">Réessayer</button></div>`;
    if (w.trial.active) return `<div class="bl-notice info">${icon('clock')}<span>Essai gratuit en cours${w.trial.endsAt ? ` jusqu’au ${esc(new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: TZ }).format(new Date(w.trial.endsAt)))}` : ''} : vos commandes ne sont pas débitées.</span></div>`;
    if (w.state === 'blocked') return `<div class="bl-notice">${icon('circle-alert')}<span>Découvert atteint : rechargez pour créer de nouvelles commandes.</span></div>`;
    if (w.state === 'overdraft') return `<div class="bl-notice">${icon('circle-alert')}<span>Votre portefeuille est à découvert de ${money(-w.balance)}${w.enforcement ? ` (jusqu’à ${money(w.overdraft.amount)} autorisés)` : ''}. Rechargez pour continuer sans interruption.</span></div>`;
    if (w.state === 'low') return `<div class="bl-notice">${icon('circle-alert')}<span>Il reste ${money(w.balance)}. Pensez à votre prochaine recharge.</span></div>`;
    return '';
  }
  function activityHtml(w) {
    const m = w ? tierModel(w.pricing.tiers, w.month.orders) : { known: false };
    const daily = w ? w.month.daily || [] : [];
    const max = Math.max(0, ...daily.map((d) => d.orders));
    const first = daily[0]; const last = daily[daily.length - 1];
    const bars = max > 0
      ? `<div class="bl-spark ${daily.length > 16 ? 'dense' : ''}" role="img" aria-label="${esc(`Commandes facturées par jour, du ${dShort.format(dayDate(first.day))} au ${dShort.format(dayDate(last.day))} : ${daily.map((d) => d.orders).join(', ')}`)}">${daily.map((d, i) => `<div class="bl-bar ${d.orders ? '' : 'zero'}" style="--h:${d.orders ? Math.max(6, (d.orders / max) * 100) : 3}%;--i:${i}" title="${esc(`${dShort.format(dayDate(d.day))} : ${plural(d.orders, 'commande', 'commandes')}`)}"><span>${fmt(d.orders)} cmd</span></div>`).join('')}</div>
        <div class="bl-spark-caption" aria-hidden="true"><span>${esc(dShort.format(dayDate(first.day)))}</span><span>${esc(dShort.format(dayDate(last.day)))}</span></div>`
      : `<div class="bl-spark"><span class="bl-spark-empty">${!w ? 'Données indisponibles' : w.trial.active ? 'Pendant l’essai, vos commandes ne sont pas facturées.' : 'Votre activité apparaîtra ici.'}</span></div>`;
    return `<div class="bl-peek"><div class="bl-peek-head"><span>${first ? esc(monthLabel(first.day.slice(0, 7)).toUpperCase()) : 'CE MOIS-CI'}</span><b><i></i> Votre activité</b></div>
      <div class="bl-peek-value">${w ? fmt(w.month.orders) : '—'}<span>${w && w.month.orders > 1 ? 'commandes facturées' : 'commande facturée'}</span></div>${bars}
      <div class="bl-peek-foot"><span>La prochaine commande <strong>${m.known ? money(m.price) : '—'}</strong></span><button type="button" class="bl-iconbtn" data-view="rates" aria-label="Comprendre le tarif de la prochaine commande">${icon('arrow-up-right')}</button></div></div>`;
  }
  function walletView() {
    const w = S.w;
    const line = !w ? 'Vos données restent inchangées.' : w.balance === 0 ? 'Commencez avec le montant qui vous convient.' : 'Vous rechargez quand vous en avez besoin.';
    const value = w ? `${w.balance < 0 ? '−' : ''}${fmt(Math.abs(w.balance))}` : '—';
    return `${walletNotice(w)}<section class="bl-overview" aria-label="Votre portefeuille">
      <div class="bl-balance"><div class="bl-eyebrow">Disponible pour vos commandes</div>
        <div class="bl-balance-line"><span class="bl-balance-value ${value.length > 8 ? 'long' : ''} ${w && w.balance < 0 ? 'negative' : ''}">${value}</span><span class="bl-currency">FCFA</span></div>
        <p>${line}</p>
        ${canEdit() ? `<div class="bl-balance-actions"><button type="button" class="bl-btn primary" data-act="recharge" ${w ? '' : 'disabled'}>${icon('plus')} Recharger</button><span>À partir de ${w ? money(w.recharge.min) : '1 000 F'}.<br>À votre rythme.</span></div>`
    : '<p class="bl-muted-note">Seuls le propriétaire et les responsables de l’espace peuvent recharger le portefeuille.</p>'}
      </div>${activityHtml(w)}</section>
      ${canEdit() ? `<section class="bl-recent" aria-label="Derniers mouvements"><div class="bl-section-head"><h2>Derniers mouvements</h2><button type="button" class="bl-link" data-view="history">Tout l’historique ${icon('arrow-right')}</button></div>
        <div id="blRecent">${recentHtml()}</div>
        <div class="bl-recent-foot"><span>${icon('shield-check')} Chaque mouvement reste consultable.</span><button type="button" class="bl-link" data-act="help">Comment fonctionne la facturation ?</button></div></section>`
    : `<div class="bl-recent-foot solo"><span>${icon('shield-check')} L’historique est réservé au propriétaire et aux responsables.</span><button type="button" class="bl-link" data-act="help">Comment fonctionne la facturation ?</button></div>`}`;
  }
  const emptyState = (title, text, action = '') => `<div class="bl-empty"><img src="${IMG}/illustration-empty.svg" alt="" width="115" height="86"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
  function recentHtml() {
    if (S.recent === null) return '<div class="bl-rows-loading"><span></span><span></span><span></span></div>';
    if (S.recent instanceof Error) return `<div class="bl-notice">${icon('circle-alert')}<span>${esc(S.recent.message)}</span><button type="button" data-act="retry-recent">Réessayer</button></div>`;
    if (!S.recent.length) return emptyState('Vous partez d’une page blanche.', 'Vos recharges et commandes s’afficheront ici, au fil de votre activité.');
    return `<div class="bl-recent-rows">${S.recent.map((m) => movementRow(m, { recent: true })).join('')}</div>`;
  }
  async function loadRecent() {
    if (!canEdit()) return;
    try { S.recent = (await S.deps.api('/api/app/billing/movements?pageSize=3')).items; } catch (error) { S.recent = error; }
    S.recentById = new Map((Array.isArray(S.recent) ? S.recent : []).map((m) => [m.type === 'day' ? `day:${m.day}` : m.id, m]));
    const box = S.view === 'wallet' && $('#blRecent');
    if (box) box.innerHTML = recentHtml();
  }

  // ---- Vue Mouvements -------------------------------------------------------
  function monthOptionsHtml() {
    const h = S.hist;
    const months = [...new Set([...(h.month ? [h.month] : []), ...(S.histData?.months || [])])].sort().reverse();
    return `<option value="">Toutes les périodes</option>${months.map((m) => `<option value="${esc(m)}" ${h.month === m ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('')}`;
  }
  function historyView() {
    const h = S.hist;
    return `<div class="bl-history-head"><div><h2>Chaque mouvement, en détail.</h2><p>Recharges, commandes, bonus et remboursements.</p></div>
        <a class="bl-btn secondary bl-export" id="blExport" href="${esc(exportUrl())}" download aria-label="Exporter les mouvements filtrés en CSV">${icon('download')}<span>Exporter</span></a></div>
      <div class="bl-toolbar"><div class="bl-searchfield">${icon('search')}<input type="search" id="blSearch" value="${esc(h.q)}" placeholder="Une référence : CMD-…, REC-…" aria-label="Rechercher un mouvement par référence" autocomplete="off" maxlength="60"></div>
        <select id="blCategory" class="bl-select" aria-label="Type de mouvement">${CATEGORIES.map(([v, t]) => `<option value="${v}" ${h.category === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <select id="blMonth" class="bl-select" aria-label="Période">${monthOptionsHtml()}</select></div>
      <div id="blResults">${historyResultsHtml()}</div>`;
  }
  const exportUrl = () => {
    const p = new URLSearchParams();
    if (S.hist.q) p.set('q', S.hist.q);
    if (S.hist.category) p.set('category', S.hist.category);
    if (S.hist.month) p.set('month', S.hist.month);
    return `/api/app/billing/movements.csv${p.toString() ? `?${p}` : ''}`;
  };
  function pagerButtons(page, pages) {
    const nums = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
    const list = [...nums].sort((a, b) => a - b);
    let out = ''; let prev = 0;
    for (const n of list) {
      if (n - prev > 1) out += '<span class="bl-pager-gap" aria-hidden="true">…</span>';
      out += `<button type="button" data-page="${n}" ${n === page ? 'aria-current="page"' : ''} aria-label="Page ${n}">${n}</button>`;
      prev = n;
    }
    return out;
  }
  function historyResultsHtml() {
    const d = S.histData;
    if (!d) return '<div class="bl-rows-loading"><span></span><span></span><span></span><span></span></div>';
    if (d instanceof Error) return `<div class="bl-notice">${icon('circle-alert')}<span>${esc(d.message)}</span><button type="button" data-act="retry-history">Réessayer</button></div>`;
    const filtered = Boolean(S.hist.q || S.hist.category || S.hist.month);
    if (!d.items.length) {
      return filtered
        ? emptyState('Aucun mouvement trouvé.', 'Essayez une autre référence ou retirez vos filtres.', '<button type="button" class="bl-link" data-act="clear-filters">Effacer les filtres</button>')
        : emptyState('L’historique commence ici.', 'Vos opérations apparaîtront dès votre première recharge ou commande.');
    }
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const start = (d.page - 1) * d.pageSize;
    return `<div class="bl-tablehead" aria-hidden="true"><span>Mouvement</span><span class="bl-col-status">Statut</span><span class="bl-col-date">Date</span><span>Montant</span><span></span></div>
      <div class="bl-history-list">${d.items.map((m) => movementRow(m)).join('')}</div>
      <div class="bl-pagination"><span>${fmt(start + 1)}–${fmt(start + d.items.length)} sur ${plural(d.total, 'mouvement', 'mouvements')}</span>
        ${pages > 1 ? `<nav class="bl-pager" aria-label="Pagination"><button type="button" data-page="${d.page - 1}" ${d.page === 1 ? 'disabled' : ''} aria-label="Page précédente">${icon('chevron-left')}</button>${pagerButtons(d.page, pages)}<button type="button" data-page="${d.page + 1}" ${d.page === pages ? 'disabled' : ''} aria-label="Page suivante">${icon('chevron-right')}</button></nav>` : ''}</div>`;
  }
  let histSeq = 0;
  async function loadHistory() {
    const seq = ++histSeq;
    const p = new URLSearchParams({ page: String(S.hist.page), pageSize: '10' });
    if (S.hist.q) p.set('q', S.hist.q);
    if (S.hist.category) p.set('category', S.hist.category);
    if (S.hist.month) p.set('month', S.hist.month);
    let data;
    try { data = await S.deps.api(`/api/app/billing/movements?${p}`); } catch (error) { data = error; }
    if (seq !== histSeq || S.view !== 'history') return;
    const hadMonths = (S.histData?.months || []).join();
    S.histData = data;
    S.histById = new Map((data.items || []).map((m) => [m.type === 'day' ? `day:${m.day}` : m.id, m]));
    // Page devenue vide (filtre plus restrictif) : revenir à la dernière page.
    if (!(data instanceof Error) && !data.items.length && data.total > 0 && S.hist.page > 1) {
      S.hist.page = Math.ceil(data.total / data.pageSize); saveHist(); loadHistory(); return;
    }
    if (!(data instanceof Error) && data.months.join() !== hadMonths) {
      const sel = $('#blMonth');
      if (sel) sel.innerHTML = monthOptionsHtml();
    }
    const box = $('#blResults');
    if (box) box.innerHTML = historyResultsHtml();
    const exp = $('#blExport');
    if (exp) { exp.href = exportUrl(); exp.classList.toggle('disabled', !(data.total > 0)); exp.setAttribute('aria-disabled', String(!(data.total > 0))); }
  }

  // ---- Vue Tarifs & bonus ---------------------------------------------------
  function ratesView() {
    const w = S.w;
    if (!w) return `<div class="bl-rates-unavailable">${walletNotice(null)}</div>`;
    const tiers = w.pricing.tiers;
    const m = tierModel(tiers, w.month.orders);
    const bonus = w.pricing.rechargeBonus.filter((b) => b.percent > 0);
    return `<div class="bl-rate-intro"><div><h2>Plus de commandes, un prix plus doux.</h2><p>Votre tarif évolue avec votre volume du mois.</p></div><span class="bl-badge big">${plural(w.month.orders, 'commande facturée', 'commandes facturées')} ce mois-ci</span></div>
      <section class="bl-price-track" style="--n:${tiers.length}" aria-label="Tarifs par commande">${tiers.map((t, i) => `<article class="bl-stage ${m.idx === i ? 'current' : ''}"><div class="bl-eyebrow">Palier ${i + 1}</div><strong>${fmt(t.price)}<span>F / commande</span></strong><p>${esc(tierRange(tiers, i))}</p><div class="bl-stage-label">${m.idx === i ? 'Votre tarif actuel' : ''}</div></article>`).join('')}</section>
      <div class="bl-usage"><p>${m.target != null ? `Encore <strong>${plural(m.target - m.count, 'commande', 'commandes')}</strong> avant le tarif suivant.` : `Vous bénéficiez du tarif minimum de ${money(m.price)} par commande.`}${w.trial.active ? ' Pendant l’essai gratuit, vos commandes ne sont pas comptées.' : ''}</p>
        <div class="bl-usage-gauge"><div role="progressbar" aria-label="Progression dans le palier" aria-valuemin="${m.min}" aria-valuemax="${m.target ?? m.count}" aria-valuenow="${m.count}"><i style="width:${m.ratio * 100}%"></i></div><p>${m.target != null ? `${fmt(m.count)} / ${fmt(m.target)} commandes` : 'Tarif minimum atteint'}</p></div></div>
      ${bonus.length ? `<section class="bl-bonus"><div class="bl-bonus-head"><img src="${IMG}/illustration-bonus.svg" alt="" width="33" height="33"><div><h2>Votre recharge, avec un bonus.</h2><p>Le montant offert s’ajoute à votre portefeuille.</p></div></div>
        <div class="bl-bonus-rows">${bonus.map((b) => `<div class="bl-bonus-row"><span>Dès ${money(b.from)} rechargés</span><b>+${fmt(b.percent)} % offerts</b></div>`).join('')}</div>
        <div class="bl-bonus-actions"><p>Vous voyez le montant total crédité avant de confirmer votre recharge.</p>${canEdit() ? `<button type="button" class="bl-btn soft" data-act="recharge">Choisir ma recharge ${icon('arrow-right')}</button>` : ''}</div></section>` : ''}
      <details class="bl-faq"><summary>Et si une commande est annulée ?</summary><p>Annulée avant le départ du livreur (« En préparation » ou « Confirmée »), la commande est remboursée sur votre portefeuille. Le remboursement apparaît dans vos mouvements. Après le départ, le suivi a eu lieu : elle reste facturée.</p></details>
      <details class="bl-faq"><summary>Comment le volume du mois est-il compté ?</summary><p>Chaque commande facturée compte, même si elle est remboursée ensuite. Le compteur repart à zéro le 1er de chaque mois (heure du Bénin).</p></details>`;
  }

  // ---- Recharge en deux étapes ---------------------------------------------
  function startRecharge() {
    if (!S.w || !canEdit()) { show('wallet'); return; }
    S.returnView = ['wallet', 'history', 'rates'].includes(S.view) ? S.view : 'wallet';
    S.amount = String(S.w.recharge.suggested);
    S.step = 1; S.result = null; S.payment = null;
    S.view = 'recharge'; setUrl(); paint(); scrollTop();
  }
  const scrollTop = () => { try { S.root.scrollIntoView({ block: 'start' }); window.scrollTo({ top: 0 }); } catch { /* ignore */ } };
  const presets = (w) => [...new Set([w.recharge.min, ...w.pricing.rechargeBonus.map((b) => b.from)])].filter((n) => n >= w.recharge.min && n <= w.recharge.max).sort((a, b) => a - b).slice(0, 4);
  const sliderMax = (w) => Math.max(w.recharge.min, Math.min(50000, w.recharge.max));
  function wizardTop() {
    return `<div class="bl-wizard-top"><button type="button" class="bl-link" data-act="${S.step === 2 ? 'step-back' : 'cancel-recharge'}">${icon('arrow-left')} ${S.step === 2 ? 'Modifier le montant' : 'Facturation'}</button>
      <div class="bl-stepper" aria-label="Étape ${S.step} sur 2"><span class="bl-step ${S.step === 1 ? 'active' : ''}"><b>1</b> Montant</span>${icon('chevron-right')}<span class="bl-step ${S.step === 2 ? 'active' : ''}"><b>2</b> Confirmation</span></div></div>`;
  }
  function rechargeView() {
    const w = S.w;
    if (S.step === 2) return wizardTop() + confirmationView();
    const q = quote(S.amount, w);
    const max = sliderMax(w);
    return `${wizardTop()}<div class="bl-scene"><div class="bl-recharge-intro"><h1>À vous de choisir le montant.</h1><p>Ajustez le montant pour voir vos commandes achetées et offertes.</p></div>
      <div class="bl-compose"><section class="bl-studio" aria-label="Montant de la recharge"><div class="bl-amount-controls">
        <label class="bl-fieldlabel" for="blAmount">Vous rechargez</label>
        <div class="bl-amount-entry"><input id="blAmount" type="text" inputmode="numeric" autocomplete="off" value="${esc(q.valid ? fmt(q.amount) : S.amount)}" aria-describedby="blAmountHelp blAmountError" aria-invalid="false"><span>FCFA</span></div>
        <p class="bl-amount-help" id="blAmountHelp">Déplacez le curseur ou saisissez votre montant.</p>
        <div class="bl-range"><input id="blRange" type="range" min="${w.recharge.min}" max="${max}" step="500" value="${Math.min(max, Math.max(w.recharge.min, q.amount || w.recharge.min))}" aria-label="Ajuster le montant de la recharge" aria-describedby="blRangeNote"><div class="bl-range-labels" aria-hidden="true"><span>${money(w.recharge.min)}</span><span>${money(max)}</span></div></div>
        <div class="bl-quick" role="group" aria-label="Montants rapides">${presets(w).map((n) => `<button type="button" data-amount="${n}" aria-pressed="false">${money(n)}</button>`).join('')}</div>
        <p class="bl-range-note" id="blRangeNote">Un montant précis ? Vous pouvez le saisir directement.</p>
        <p class="bl-error" id="blAmountError" role="status"></p></div>
        <div class="bl-recharge-bottom"><button type="button" class="bl-btn primary" id="blContinue" data-act="continue">Continuer ${icon('arrow-right')}</button><p>Vous vérifiez le récapitulatif avant de confirmer.</p></div></section>
      <aside class="bl-benefit" data-stage="1" aria-label="Avantage de votre recharge"><div class="bl-benefit-head"><span>Avec cette recharge</span><img class="bl-benefit-mark" src="${IMG}/illustration-order-credit.svg" alt="" width="104" height="80"></div>
        <div class="bl-orders"><div><strong id="blBought">—</strong><span>achetées</span></div><b aria-hidden="true">+</b><div class="offered"><strong id="blFree">—</strong><span>offertes</span></div></div>
        <div class="bl-benefit-number"><strong id="blTotal">—</strong></div><h2 class="bl-benefit-title" id="blBenefitTitle">commandes au total<sup>*</sup></h2>
        <span class="bl-saving" id="blSaving"></span><p class="bl-benefit-desc" id="blBenefitDesc"></p>
        <details class="bl-benefit-details" id="blDetails"><summary>Comment est-ce calculé ?</summary><div><dl><div><dt>Votre recharge</dt><dd id="blDPaid"></dd></div><div><dt>Crédit offert <span id="blDRate"></span></dt><dd id="blDBonus"></dd></div><div><dt>Total ajouté au portefeuille</dt><dd id="blDTotal"></dd></div></dl>
          <p id="blCalc"></p><p id="blRemainder"></p><p>L’économie compare le coût des mêmes commandes avec et sans le crédit offert. Elle s’ajoute à l’effet de votre tarif par palier, sans le modifier.</p></div></details>
        <div class="bl-sr" id="blAnnounce" role="status" aria-live="polite" aria-atomic="true"></div></aside></div></div>`;
  }
  let lastTotal = null; let announceTimer = null;
  function updateQuote({ animate = true } = {}) {
    const w = S.w; const q = quote(S.amount, w); const b = benefit(q, w);
    const range = $('#blRange'); const input = $('#blAmount');
    if (!range || !input) return;
    const max = sliderMax(w);
    $('#blContinue').disabled = !q.valid;
    $('#blAmountError').textContent = q.valid ? '' : q.error;
    input.setAttribute('aria-invalid', String(!q.valid));
    input.classList.toggle('long', String(input.value).length > 7);
    range.disabled = !q.valid || q.amount > max;
    range.value = String(q.valid ? Math.min(max, q.amount) : w.recharge.min);
    range.style.setProperty('--fill', `${max > w.recharge.min ? Math.max(0, Math.min(100, (100 * (Number(range.value) - w.recharge.min)) / (max - w.recharge.min))) : 100}%`);
    range.setAttribute('aria-valuetext', q.valid ? `${fmt(q.amount)} francs CFA` : 'Montant à renseigner');
    $('#blRangeNote').textContent = q.valid && q.amount > max ? `Au-delà de ${money(max)}, ajustez le montant dans le champ.` : 'Un montant précis ? Vous pouvez le saisir directement.';
    $$('[data-amount]').forEach((x) => x.setAttribute('aria-pressed', String(q.valid && Number(x.dataset.amount) === q.amount)));
    $('.bl-benefit').dataset.stage = b.known ? String(b.stage) : 'unknown';
    $('#blBought').textContent = b.known ? fmt(b.bought) : '—';
    $('#blFree').textContent = b.known ? fmt(b.free) : '—';
    const total = $('#blTotal');
    total.textContent = b.known ? fmt(b.total) : '—';
    total.classList.toggle('long', b.known && b.total > 9999);
    $('#blBenefitTitle').innerHTML = q.valid ? 'commandes au total<sup>*</sup>' : 'Votre estimation s’affichera ici';
    $('#blSaving').textContent = q.valid && q.bonus ? `≈ ${pct(b.saving)} % d’économie sur vos frais` : '';
    $('#blBenefitDesc').textContent = !q.valid ? 'Indiquez un montant valide pour voir vos commandes.'
      : `* Estimation à ${money(b.ref)} par commande. Selon votre palier, cette recharge peut en couvrir davantage.`;
    $('#blDPaid').textContent = q.valid ? money(q.amount) : '—';
    $('#blDBonus').textContent = q.valid ? money(q.bonus) : '—';
    $('#blDRate').textContent = q.valid && q.bonus ? `· ${pct(q.percent)} %` : '';
    $('#blDTotal').textContent = q.valid ? money(q.total) : '—';
    $('#blCalc').textContent = b.known ? `${money(q.amount)} ÷ ${money(b.ref)} = ${plural(b.bought, 'commande achetée entière', 'commandes achetées entières')}. Avec le crédit offert : ${money(q.total)} ÷ ${money(b.ref)} = ${plural(b.total, 'commande', 'commandes')} au total. Soit ${plural(b.free, 'commande supplémentaire', 'commandes supplémentaires')} grâce à l’offre.` : '';
    $('#blRemainder').textContent = b.known ? `${b.remainder ? `Les ${money(b.remainder)} restants sont conservés dans votre crédit. ` : ''}${b.carry ? 'Le crédit restant sur la part achetée complète une commande supplémentaire avec le bonus. ' : ''}Le portefeuille reste en FCFA ; ces nombres sont des équivalents estimés.` : '';
    $('#blDetails').hidden = !q.valid;
    const key = b.known ? b.total : null;
    if (animate && lastTotal !== null && lastTotal !== key && !reduceMotion() && total.animate) {
      total.getAnimations().forEach((a) => a.cancel());
      total.animate([{ opacity: 0.35, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    lastTotal = key;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const live = $('#blAnnounce');
      if (live) live.textContent = q.valid && b.known ? `${money(q.amount)} de recharge. ${fmt(b.bought)} commandes achetées plus ${fmt(b.free)} offertes : ${fmt(b.total)} au total, estimées à ${money(b.ref)} par commande.${q.bonus ? ` Économie équivalente de ${pct(b.saving)} pour cent.` : ''}` : 'Montant invalide.';
    }, 400);
  }
  function confirmationView() {
    const w = S.w; const q = quote(S.amount, w); const b = benefit(q, w);
    const available = w.recharge.available;
    const action = available
      ? `<button type="button" class="bl-btn primary" data-act="pay" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Paiement en cours…' : `Payer ${money(q.amount)}`} ${S.busy ? '' : icon('arrow-right')}</button>`
      : `<button type="button" class="bl-btn primary" data-act="prepare-support">Préparer ma demande ${icon('arrow-right')}</button>`;
    return `<div class="bl-scene bl-confirm"><div class="bl-confirm-copy"><h1 tabindex="-1">Tout est bon pour vous ?</h1><p class="bl-lead">Voici ce que vous payez et ce qui sera ajouté à votre portefeuille.</p>
        ${available
    ? `<div class="bl-payment-note">${icon('smartphone')}<div><h3>Mobile Money ou carte bancaire.</h3><p>Le paiement s’ouvre dans une fenêtre sécurisée de notre prestataire${w.recharge.provider === 'kkiapay' ? ' Kkiapay' : ''}. Votre solde change seulement une fois le paiement vérifié par TRAXO.</p></div></div>`
    : `<div class="bl-payment-note">${icon('headset')}<div><h3>Notre équipe vous accompagne.</h3><p>Le paiement en ligne n’est pas encore ouvert. Préparez votre demande de recharge pour le support : vous la relisez avant de l’envoyer.</p></div></div>`}
        <p class="bl-error" id="blPayError" role="alert">${esc(S.payError || '')}</p>
        <div class="bl-wizard-actions">${action}</div>${S.busy && S.payment ? '<button type="button" class="bl-link" data-act="cancel-pay">Fenêtre de paiement fermée ? Revenir au récapitulatif</button>' : ''}<p class="bl-fineprint">Le solde est mis à jour après confirmation de la recharge.</p></div>
      <aside class="bl-receipt" aria-label="Récapitulatif de recharge"><div class="bl-receipt-top"><span>Votre recharge</span>${icon('file-text')}</div>
        ${b.known ? `<div class="bl-receipt-offer"><div class="bl-receipt-lines"><div><span>Commandes achetées</span><b>${fmt(b.bought)}</b></div><div><span>Commandes offertes</span><b>+ ${fmt(b.free)}</b></div></div><strong>${plural(b.total, 'commande', 'commandes')} au total*</strong><span>${q.bonus ? `≈ ${pct(b.saving)} % d’économie sur vos frais.<br>` : ''}* Équivalent à ${money(b.ref)} par commande ; votre palier peut en couvrir davantage.</span></div>` : ''}
        <div class="bl-receipt-main"><div class="bl-receipt-line"><span>Vous payez</span><strong>${money(q.amount)}</strong></div><div class="bl-receipt-line bonus"><span>Crédit offert${q.percent ? ` · ${pct(q.percent)} %` : ''}</span><strong>+${money(q.bonus)}</strong></div></div>
        <div class="bl-receipt-total"><span>Ajouté à votre portefeuille</span><strong>${fmt(q.total)} <small>FCFA</small></strong></div>
        <div class="bl-receipt-foot">Solde après confirmation : ${money(w.balance + q.total)}</div>
        <button type="button" class="bl-link" data-act="step-back">Modifier le montant</button></aside>
      <div class="bl-confirm-mobile">${action}</div></div>`;
  }

  // Paiement : widget Kkiapay (ou prestataire de test hors production), puis
  // vérification par le serveur, seule à créditer le portefeuille.
  let kkiapayLoading = null;
  function loadKkiapay() {
    if (window.openKkiapayWidget) return Promise.resolve();
    if (!kkiapayLoading) {
      kkiapayLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.kkiapay.me/k.js';
        script.onload = resolve;
        script.onerror = () => { kkiapayLoading = null; reject(new Error('Le module de paiement n’a pas pu être chargé. Vérifiez votre connexion.')); };
        document.head.appendChild(script);
      });
    }
    return kkiapayLoading;
  }
  function payWithKkiapay(checkout) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
      window.addSuccessListener?.((r) => finish(resolve, r && r.transactionId));
      window.addFailedListener?.(() => finish(reject, Object.assign(new Error('Le paiement n’a pas abouti.'), { final: true })));
      window.addKkiapayCloseListener?.(() => setTimeout(() => finish(reject, Object.assign(new Error('Le paiement a été interrompu avant sa confirmation.'), { cancelled: true })), 800));
      window.openKkiapayWidget({ amount: checkout.amount, key: checkout.publicKey, sandbox: checkout.sandbox, data: checkout.data, position: 'center', theme: '#eb142c' });
    });
  }
  const post = (url, body) => S.deps.api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  async function pay() {
    const q = quote(S.amount, S.w);
    if (S.busy || !q.valid) return;
    S.busy = true; S.payError = ''; paint();
    let started; let current = null;
    try {
      started = await post('/api/app/billing/recharges', { amount: q.amount });
      current = { id: started.payment.id, reference: started.payment.reference, amount: started.payment.amount, bonus: started.payment.bonus, transactionId: null };
      S.payment = current;
      if (started.checkout.provider === 'kkiapay') {
        await loadKkiapay();
        paint(); // affiche « Fenêtre de paiement fermée ? » pendant que le widget est ouvert
        const transactionId = await payWithKkiapay(started.checkout);
        if (S.payment !== current) return; // abandonné entre-temps
        current.transactionId = transactionId;
      }
    } catch (error) {
      if (current && S.payment !== current) return;
      S.busy = false;
      if (S.payment && error.final) { S.result = 'failure'; S.view = 'result'; paint(); return; }
      S.payError = error.cancelled ? 'Le paiement a été interrompu. Si votre opérateur affiche un débit, contactez le support avant de réessayer.' : error.message;
      paint(); return;
    }
    await confirmPayment();
  }
  async function confirmPayment() {
    S.busy = true; S.result = 'processing'; S.view = 'result'; paint(); scrollTop();
    try {
      const out = await post(`/api/app/billing/recharges/${S.payment.id}/confirm`, { transactionId: S.payment.transactionId });
      S.paid = out.payment; S.w = out.wallet; updateGauge(out.wallet); S.recent = null; S.histData = null;
      S.result = 'success';
    } catch (error) {
      let status = null;
      try { status = (await S.deps.api(`/api/app/billing/recharges/${S.payment.id}`)).payment.status; } catch { /* état inconnu : en attente */ }
      S.result = status === 'succeeded' ? 'success' : status === 'failed' ? 'failure' : 'pending';
      if (S.result === 'success') { await loadWallet(); S.paid = { amount: S.payment.amount, bonus: S.payment.bonus }; }
      S.payError = error.message;
    }
    S.busy = false; paint();
  }
  function resultView() {
    const p = S.payment || {};
    if (S.result === 'processing') return `<section class="bl-scene bl-result" role="status"><div class="bl-status pending">${icon('credit-card')}</div><h1>Un instant…</h1><p>Nous vérifions le paiement auprès de notre prestataire. Votre solde n’a pas encore changé.</p><p class="bl-fineprint">Ne fermez pas cette page et ne relancez pas de paiement.</p></section>`;
    if (S.result === 'failure') return `<section class="bl-scene bl-result"><div class="bl-status failed">${icon('circle-alert')}</div><h1>Le paiement n’a pas abouti.</h1><p>Aucune recharge n’a été ajoutée. Vous pouvez retrouver votre montant et réessayer.</p><button type="button" class="bl-btn primary" data-act="retry-payment">Revenir à ma recharge</button><br><button type="button" class="bl-link" data-act="support-payment">Contacter le support ${icon('arrow-up-right')}</button><p class="bl-fineprint">Si votre opérateur affiche un débit, contactez-nous avant de relancer un paiement${p.reference ? ` (référence ${esc(p.reference)})` : ''}.</p></section>`;
    if (S.result === 'pending') return `<section class="bl-scene bl-result"><div class="bl-status">${icon('clock')}</div><h1>La confirmation est en attente.</h1><p>Votre paiement est enregistré, mais pas encore confirmé. Attendez la confirmation avant de relancer un paiement.</p><div class="bl-new-balance"><span>Recharge en attente</span><strong>${money(p.amount || 0)}</strong></div><button type="button" class="bl-btn primary" data-act="recheck">Vérifier à nouveau</button><br><button type="button" class="bl-link" data-act="support-payment">Contacter le support ${icon('arrow-up-right')}</button><p class="bl-fineprint">Votre solde reste inchangé · référence ${esc(p.reference || '—')}.</p></section>`;
    const paid = S.paid || {};
    return `<section class="bl-scene bl-result"><img src="${IMG}/illustration-success.svg" alt="" width="115" height="115"><h1>C’est bon, vous pouvez continuer.</h1><p>${money((paid.amount || 0) + (paid.bonus || 0))} ont été ajoutés à votre portefeuille${paid.bonus ? `, dont ${money(paid.bonus)} de bonus` : ''}.</p><div class="bl-new-balance"><span>Votre nouveau solde</span><strong>${S.w ? money(S.w.balance) : '—'}</strong></div><button type="button" class="bl-btn primary" data-act="back-wallet">Retour à mon portefeuille ${icon('arrow-right')}</button><p class="bl-fineprint">Référence ${esc(p.reference || paid.reference || '—')} · visible dans vos mouvements.</p></section>`;
  }

  // ---- Support prérempli ---------------------------------------------------
  function compose(subject, text) {
    if (window.TraxoSupport?.compose?.({ subject, category: 'billing', text })) return true;
    S.deps.uiToast('Le support n’a pas pu s’ouvrir. Réessayez dans un instant.', 'error');
    return false;
  }
  function prepareSupport() {
    const q = quote(S.amount, S.w);
    const company = S.deps.context.company.name || 'notre espace';
    const ok = compose('Demande de recharge', `Bonjour,\nJe souhaite recharger le portefeuille de ${company} de ${money(q.amount)}.${q.bonus ? ` Le récapitulatif prévoit ${money(q.bonus)} de crédit offert (${pct(q.percent)} %), soit ${money(q.total)} ajoutés au portefeuille.` : ` ${money(q.total)} seront ajoutés au portefeuille.`}\nComment puis-je procéder ? Merci.`);
    if (ok) S.deps.uiToast('Votre demande est prête dans le support. Relisez-la, puis envoyez-la.', 'success', { timeout: 6000 });
  }

  // ---- Tiroirs (détail, préférences, aide) --------------------------------
  let drawer = null; let drawerOpener = null;
  function openDrawer(label, title, body, foot = '') {
    if (!drawer) {
      drawer = document.createElement('dialog');
      drawer.className = 'bl-drawer';
      drawer.setAttribute('aria-labelledby', 'blDrawerTitle');
      document.body.appendChild(drawer);
      drawer.addEventListener('click', (e) => {
        if (e.target === drawer) { const r = drawer.getBoundingClientRect(); if (e.clientX < r.left || e.clientY < r.top || e.clientY > r.bottom) drawer.close(); return; }
        onDrawerClick(e);
      });
      drawer.addEventListener('close', () => { document.documentElement.classList.remove('bl-drawer-open'); if (drawerOpener?.isConnected) drawerOpener.focus(); });
    }
    if (!drawer.open) drawerOpener = document.activeElement;
    drawer.innerHTML = `<div class="bl-drawer-head"><div><small>${esc(label)}</small><h2 id="blDrawerTitle">${esc(title)}</h2></div><button type="button" class="bl-iconbtn" data-dact="close" aria-label="Fermer">${icon('x')}</button></div><div class="bl-drawer-body">${body}</div>${foot ? `<div class="bl-drawer-foot">${foot}</div>` : ''}`;
    if (!drawer.open) { document.documentElement.classList.add('bl-drawer-open'); drawer.showModal(); }
    return drawer;
  }
  const closeDrawer = () => drawer?.open && drawer.close();

  async function openDetail(key) {
    const m = (S.histById && S.histById.get(key)) || (S.recentById && S.recentById.get(key));
    if (!m) return;
    const i = movementInfo(m);
    const when = m.type === 'day' ? dayDate(m.day) : i.at;
    const meta = [
      ['Référence', m.type === 'day' ? 'Commandes du jour' : i.ref || '—'],
      ['Date', m.type === 'day' ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(when) : dFull.format(when)],
      ['Catégorie', i.category],
      ...(m.type === 'day' ? [['Commandes', unitText(m)]] : m.unitPrice != null ? [['Prix unitaire', money(m.unitPrice)]] : []),
      ...(m.type !== 'day' && m.balanceAfter != null ? [['Solde après', money(m.balanceAfter)]] : []),
    ];
    const desc = {
      order_charge: m.type === 'day' ? 'Commandes créées ce jour-là, débitées au prix de votre palier du mois.' : 'Commande débitée à sa création, au prix de votre palier du mois.',
      order_refund: 'Commande annulée avant le départ du livreur : ses frais sont revenus sur votre portefeuille.',
      recharge: 'Recharge confirmée par le prestataire de paiement.',
      bonus: 'Crédit offert sur votre recharge, selon son montant.',
      premium_report: 'Rapport Excel enrichi payé depuis le portefeuille.',
      premium_month: '30 jours de rapports Excel enrichis, payés depuis le portefeuille.',
      adjustment: m.note ? `Motif : ${m.note}` : 'Correction enregistrée par l’équipe TRAXO.',
    }[m.kind] || '';
    const body = `<div class="bl-detail-top">${icon(i.ic)}<h3>${esc(i.name)}</h3><div class="bl-detail-value ${i.positive ? 'positive' : ''}">${esc(signed(m.amount))}</div><span class="bl-badge"><i></i>Confirmé</span></div>
      <div class="bl-detail-meta">${meta.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>
      <p class="bl-detail-sub">${esc(desc)}</p>
      ${m.type === 'day' ? '<div class="bl-day-orders" id="blDayOrders"><div class="bl-rows-loading"><span></span><span></span></div></div>' : ''}
      <div class="bl-note">Ce détail n’est ni une facture ni un justificatif de paiement. Les mouvements confirmés ne sont jamais supprimés : une correction est un nouveau mouvement.</div>`;
    openDrawer('Vos mouvements', 'Le détail du mouvement.', body, `<button type="button" class="bl-btn plain full" data-dact="detail-support" data-key="${esc(key)}">Une question sur ce mouvement ?</button>`);
    if (m.type === 'day') {
      let html;
      try {
        const out = await S.deps.api(`/api/app/billing/movements/day/${encodeURIComponent(m.day)}`);
        html = `<h4>${plural(out.orders.length, 'commande', 'commandes')}</h4><ul>${out.orders.map((o) => `<li>${o.orderId ? `<a href="/app/commandes/${esc(o.orderId)}">${esc(o.orderReference || `Commande n° ${o.orderId}`)}</a>` : `<span>${esc(o.orderReference || '—')}</span>`}<span>${o.refunded ? '<em>remboursée</em>' : ''}${esc(money(o.unitPrice ?? -o.amount))}</span></li>`).join('')}</ul>`;
      } catch (error) { html = `<p class="bl-error">${esc(error.message)}</p>`; }
      const box = drawer?.open && drawer.querySelector('#blDayOrders');
      if (box) box.innerHTML = html;
    }
  }
  function openPreferences() {
    const a = S.w.alert;
    const body = `<p class="bl-drawer-intro">Un rappel avant que votre solde soit trop bas.</p>
      <div class="bl-switchrow"><label for="blAlertOn">Alerte de solde bas<small>Une notification dans TRAXO, pour le propriétaire et les responsables.</small></label>${window.TraxoUI ? window.TraxoUI.switchHtml({ id: 'blAlertOn', name: 'alertEnabled', checked: a.enabled }) : `<input type="checkbox" id="blAlertOn" ${a.enabled ? 'checked' : ''}>`}</div>
      <div class="bl-formfield"><label class="bl-fieldlabel" for="blThreshold">Me prévenir en dessous de</label><div class="bl-inputbox"><input id="blThreshold" inputmode="numeric" autocomplete="off" value="${a.custom ? esc(fmt(a.threshold)) : ''}" placeholder="${esc(`Conseillé : ${fmt(a.defaultThreshold)}`)}" aria-describedby="blThresholdHelp blThresholdError"><span>FCFA</span></div>
        <p class="bl-help" id="blThresholdHelp">Laissez vide pour le seuil conseillé : ${money(a.defaultThreshold)}, soit environ ${plural(Math.round(a.defaultThreshold / Math.max(1, S.w.month.nextUnitPrice)), 'commande', 'commandes')}.</p><p class="bl-error" id="blThresholdError" role="status"></p></div>
      <div class="bl-note">Cette alerte ne déclenche aucune recharge automatique. Vous décidez quand recharger.</div>`;
    openDrawer('Facturation', 'Vos préférences.', body, '<button type="button" class="bl-btn primary full" data-dact="save-preferences">Enregistrer</button>');
  }
  async function savePreferences(btn) {
    let raw = drawer.querySelector('#blThreshold').value.replace(/[\s\u00a0\u202f]/g, '');
    if (/^\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
    const err = drawer.querySelector('#blThresholdError');
    if (raw && (!/^\d+$/.test(raw) || Number(raw) > 10000000)) { err.textContent = 'Choisissez un montant entier entre 0 et 10 000 000 F.'; drawer.querySelector('#blThreshold').focus(); return; }
    btn.disabled = true; btn.textContent = 'Enregistrement…';
    try {
      const out = await S.deps.api('/api/app/billing/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alertEnabled: drawer.querySelector('#blAlertOn').checked, threshold: raw ? Number(raw) : null }) });
      S.w.alert = out.alert;
      closeDrawer();
      await loadWallet();
      if (S.view === 'wallet') paint();
      S.deps.uiToast(out.alert.enabled ? `Alerte enregistrée : sous ${money(out.alert.threshold)}.` : 'Alerte de solde bas désactivée.', 'success');
    } catch (error) { err.textContent = error.message; btn.disabled = false; btn.textContent = 'Enregistrer'; }
  }
  function openHelp() {
    const w = S.w;
    const tiers = w ? w.pricing.tiers.map((t, i) => `${fmt(t.price)} F (${tierRange(w.pricing.tiers, i).toLowerCase()})`).join(', ') : '';
    const qa = [
      ['Que règle mon portefeuille ?', 'Il sert à payer l’utilisation de TRAXO : chaque commande créée est débitée une fois. Il est distinct des montants que vos clients vous paient pour leurs livraisons.'],
      ['Que se passe-t-il en cas d’annulation ?', 'Si la commande est annulée avant le départ du livreur, ses frais sont remboursés. Le remboursement apparaît comme un nouveau crédit dans les mouvements.'],
      ...(w ? [['Comment mon tarif évolue-t-il ?', `Le prix d’une commande dépend de son rang dans le mois : ${tiers}. La vue Tarifs & bonus présente les seuils.`]] : []),
      ...(w ? [['Et si mon solde tombe à zéro ?', `Un découvert de ${plural(w.overdraft.orders, 'commande', 'commandes')} vous laisse finir la journée ; il est repris à la recharge suivante.${w.enforcement ? ' Au-delà, la création de commandes est suspendue jusqu’à la recharge.' : ''}`]] : []),
      ['Comment obtenir un justificatif ?', 'Les justificatifs ne sont pas encore téléchargeables dans TRAXO. Chaque recharge garde sa référence (REC-…) dans vos mouvements : indiquez-la au support pour toute question.'],
    ];
    openDrawer('Facturation', 'Les réponses utiles.', `<p class="bl-drawer-intro">Quelques repères pour comprendre votre portefeuille.</p>${qa.map(([q, a], i) => `<details class="bl-faq" ${i === 0 ? 'open' : ''}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}`,
      `<button type="button" class="bl-btn secondary full" data-dact="support">Contacter le support ${icon('arrow-up-right')}</button>`);
  }
  function onDrawerClick(e) {
    const b = e.target.closest('[data-dact]');
    if (!b || b.disabled) return;
    switch (b.dataset.dact) {
      case 'close': closeDrawer(); break;
      case 'save-preferences': savePreferences(b); break;
      case 'support': closeDrawer(); compose('Question sur ma facturation', 'Bonjour,\nJ’ai une question sur ma facturation : '); break;
      case 'detail-support': {
        const m = (S.histById && S.histById.get(b.dataset.key)) || (S.recentById && S.recentById.get(b.dataset.key));
        closeDrawer();
        if (m) { const i = movementInfo(m); const when = m.type === 'day' ? dayDate(m.day) : i.at; compose(`Question sur un mouvement${i.ref && m.type !== 'day' ? ` (${i.ref})` : ''}`, `Bonjour,\nJ’ai une question sur le mouvement « ${i.name} »${i.ref && m.type !== 'day' ? ` (${i.ref})` : ''} du ${dLong.format(when)} (${signed(m.amount)}).\nVoici les précisions : `); }
        break;
      }
      default: break;
    }
  }

  // ---- Événements -----------------------------------------------------------
  let searchTimer = null;
  function onInput(e) {
    if (e.target.id === 'blAmount') { S.amount = e.target.value.replace(/[\s\u00a0\u202f]/g, ''); updateQuote(); return; }
    if (e.target.id === 'blRange') { S.amount = e.target.value; $('#blAmount').value = fmt(Number(S.amount)); updateQuote(); return; }
    if (e.target.id === 'blSearch') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { S.hist.q = e.target.value.trim(); S.hist.page = 1; saveHist(); loadHistory(); }, 280);
    }
  }
  function onChange(e) {
    if (e.target.id === 'blCategory') { S.hist.category = e.target.value; S.hist.page = 1; saveHist(); loadHistory(); }
    if (e.target.id === 'blMonth') { S.hist.month = e.target.value; S.hist.page = 1; saveHist(); loadHistory(); }
    if (e.target.id === 'blAmount') { const q = quote(S.amount, S.w); if (q.valid) e.target.value = fmt(q.amount); }
  }
  function onKeydown(e) {
    const tab = e.target.closest('.bl-tab');
    if (tab) {
      const ids = $$('.bl-tab').map((b) => b.dataset.view);
      const i = ids.indexOf(tab.dataset.view);
      let n = null;
      if (e.key === 'ArrowRight') n = (i + 1) % ids.length; else if (e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = ids.length - 1;
      if (n !== null) { e.preventDefault(); show(ids[n], { focusTab: true }); }
      return;
    }
    if (e.target.id === 'blAmount' && e.key === 'Enter') { e.preventDefault(); if (quote(S.amount, S.w).valid) goStep2(); }
  }
  function goStep2() { S.step = 2; S.payError = ''; paint(); scrollTop(); $('.bl-confirm-copy h1')?.focus(); }
  function onClick(e) {
    const exp = e.target.closest('#blExport');
    if (exp && exp.classList.contains('disabled')) { e.preventDefault(); S.deps.uiToast('Aucun mouvement à exporter.', 'info'); return; }
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.view) { show(b.dataset.view, { focusTab: b.classList.contains('bl-tab') }); return; }
    if (b.dataset.move) { openDetail(b.dataset.move); return; }
    if (b.dataset.page) { S.hist.page = Math.max(1, Number(b.dataset.page)); saveHist(); loadHistory().then(() => $('.bl-pager [aria-current]')?.focus()); return; }
    if (b.dataset.amount) { S.amount = b.dataset.amount; $('#blAmount').value = fmt(Number(S.amount)); updateQuote(); return; }
    switch (b.dataset.act) {
      case 'recharge': startRecharge(); break;
      case 'continue': if (quote(S.amount, S.w).valid) goStep2(); break;
      case 'step-back': if (!S.busy) { S.step = 1; S.payError = ''; paint(); scrollTop(); $('#blAmount')?.focus(); } break;
      case 'cancel-recharge': show(S.returnView); break;
      case 'prepare-support': prepareSupport(); break;
      case 'pay': pay(); break;
      case 'cancel-pay': S.payment = null; S.busy = false; S.payError = 'Paiement interrompu. Si votre opérateur affiche un débit, contactez le support avant de réessayer.'; paint(); break;
      case 'recheck': confirmPayment(); break;
      case 'retry-payment': S.view = 'recharge'; S.step = 2; S.payment = null; S.payError = ''; setUrl(); paint(); break;
      case 'back-wallet': show('wallet'); break;
      case 'support-payment': compose('Problème de paiement', `Bonjour,\nMa recharge${S.payment?.reference ? ` ${S.payment.reference}` : ''} de ${money(S.payment?.amount || 0)} n’a pas été confirmée.\nVoici ce que j’observe : `); break;
      case 'preferences': openPreferences(); break;
      case 'help': openHelp(); break;
      case 'support': compose('Question sur ma facturation', 'Bonjour,\nJ’ai une question sur ma facturation : '); break;
      case 'retry': loadWallet().then(() => show(S.view === 'result' ? 'wallet' : S.view)); break;
      case 'retry-recent': S.recent = null; $('#blRecent').innerHTML = recentHtml(); loadRecent(); break;
      case 'retry-history': S.histData = null; $('#blResults').innerHTML = historyResultsHtml(); loadHistory(); break;
      case 'clear-filters': S.hist = { q: '', category: '', month: '', page: 1 }; saveHist(); S.histData = null; paint(); loadHistory(); $('#blSearch')?.focus(); break;
      default: break;
    }
  }

  window.TraxoBilling = { render, mountGauge, updateGauge, show: (v) => show(v), _model: { tierModel, quote, benefit } };
})();
