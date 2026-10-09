const page = document.getElementById('page');
const sidebar = document.getElementById('sidebar');
let context;
// Lien partagé à un client / membre : toujours sur le domaine canonique
// (APP_BASE_URL côté serveur), même si l'onglet est ouvert sur un autre domaine.
function publicLink(pathname) {
  const base = String(context?.publicBaseUrl || location.origin).replace(/\/+$/, '');
  return `${base}${pathname}`;
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[character]));

const formatDate = (value) => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const formatDateOnly = (value) => value ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`)) : '—';
const formatAge = (value) => {
  const elapsed = value ? Date.now() - new Date(value).getTime() : NaN;
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'inconnue';
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'moins d’une minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} j`;
};
const formatMoney = (value, currency = 'XOF') => value == null ? '—' : new Intl.NumberFormat('fr-FR', {
  style: 'currency', currency, maximumFractionDigits: 0,
}).format(Number(value));

function badge(status) {
  const type = ['Livrée', 'Disponible', 'Confirmée', 'Validée', 'Terminée'].includes(status) ? 'success'
    : ['Refusée', 'Annulée', 'Retournée', 'Incident', 'Échec'].includes(status) ? 'danger'
      : ['À vérifier', 'Arrivée', 'Retour', 'Position ancienne'].includes(status) ? 'warning' : '';
  return `<span class="badge ${type}">${escapeHtml(status || '—')}</span>`;
}

const actionKey = (prefix) => {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
};
function idempotencyKeyFor(element, prefix, payload) {
  const fingerprint = JSON.stringify(payload);
  if (element.dataset.actionFingerprint !== fingerprint) {
    element.dataset.actionFingerprint = fingerprint;
    element.dataset.idempotencyKey = actionKey(prefix);
  }
  return element.dataset.idempotencyKey;
}
const reasonRequiredStatuses = ['Échec', 'Retour', 'Retournée', 'Annulée'];
const incidentCategoryLabels = {
  client_injoignable: 'Client injoignable', adresse: 'Adresse ou accès', colis: 'Colis endommagé ou manquant',
  paiement: 'Paiement', vehicule: 'Véhicule', gps: 'GPS ou connexion', autre: 'Autre',
};
const paymentStatusLabels = {
  pending: 'À encaisser', collected: 'Encaissé', discrepancy: 'Écart à vérifier',
  reconciled: 'Rapproché', not_required: 'Non requis',
};
const paymentMethodLabels = {
  cash: 'Espèces', mobile_money: 'Mobile Money', card: 'Carte', bank_transfer: 'Virement', other: 'Autre',
};
const paymentAdjustmentLabels = {
  refund: 'Remboursement au client', additional_collection: 'Complément reçu', reversal: 'Écriture inverse',
};
const roleLabels = { owner: 'Propriétaire', manager: 'Administrateur', operator: 'Opérateur', viewer: 'Lecture seule', driver: 'Livreur' };
const runStatusLabels = {
  draft: 'En préparation', planned: 'Planifiée', active: 'En cours', completed: 'Terminée', cancelled: 'Annulée',
};
// Libellés affichés des statuts de demande (les valeurs en base ne changent pas).
// Voir docs/UX_WRITING_GUIDE.md.
const requestStatusLabels = {
  'En attente d’informations': 'En attente du client',
  'À confirmer par le client': 'À confirmer par le client',
  'À vérifier': 'À valider',
  'Informations à compléter': 'À compléter par le client',
  'Validée': 'Validée',
  'Confirmée': 'Commande créée',
  'Refusée': 'Refusée',
  'Archivée': 'Archivée',
};
const requestStatusTone = { 'En attente d’informations': 'grey', 'À confirmer par le client': 'grey', 'À vérifier': 'amber', 'Informations à compléter': 'amber', 'Validée': 'blue', 'Confirmée': 'green', 'Refusée': 'red', 'Archivée': 'grey' };
function requestStatusLabel(status) { return requestStatusLabels[status] || status || '—'; }
function requestStatusChip(status) { return crmChip(requestStatusLabel(status), requestStatusTone[status] || 'grey'); }
const runEventLabels = {
  created: 'Tournée créée', order_added: 'Colis ajouté', order_removed: 'Colis retiré',
  stops_reordered: 'Ordre des arrêts modifié', status_changed: 'État de la tournée modifié',
};

const customerStatusLabels = {
  active: 'Actif', do_not_contact: 'Ne pas contacter', archived: 'Archivé',
  merged: 'Fusionné', anonymized: 'Anonymisé',
};
const contactKindLabels = { phone: 'Téléphone', email: 'E-mail', whatsapp: 'WhatsApp', other: 'Autre' };
const interactionChannelLabels = {
  call: 'Appel', whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-mail',
  in_person: 'En personne', internal: 'Interne', other: 'Autre',
};
const interactionPurposeLabels = {
  delivery_confirmation: 'Confirmation de livraison', location_clarification: 'Précision du lieu',
  arrival: 'Arrivée', complaint: 'Réclamation', payment: 'Paiement', follow_up: 'Suivi', other: 'Autre',
};
const interactionOutcomeLabels = {
  reached: 'Contact établi', no_answer: 'Sans réponse', callback_requested: 'Rappel demandé',
  information_received: 'Information reçue', technical_failure: 'Échec technique', other: 'Autre',
};

const formatInteger = (value) => new Intl.NumberFormat('fr-FR').format(Number(value) || 0);
const formatCount = (value) => Number.isFinite(Number(value)) ? formatInteger(value) : 'Non calculable';
const formatPercent = (value) => Number.isFinite(Number(value))
  ? new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 }).format(Number(value))
  : 'Non calculable';
const formatMinorMoney = (value, currency) => {
  if (!Number.isFinite(Number(value)) || !currency) return 'Non calculable';
  try {
    const formatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
    return formatter.format(Number(value) / (10 ** fractionDigits));
  } catch {
    return `${formatInteger(value)} ${String(currency)}`;
  }
};

function renderPaymentSection(order) {
  const configured = Boolean(order.payment_account_id);
  const canConfigure = !order.isTerminal && (!configured || ['pending', 'not_required'].includes(order.payment_status));
  const canCollect = configured && order.payment_status === 'pending' && ['En livraison', 'Arrivée'].includes(order.status);
  const canControl = ['owner', 'manager'].includes(context.user.role);
  const canReconcile = canControl && ['collected', 'discrepancy'].includes(order.payment_status);
  const canReverse = canControl && ['collected', 'discrepancy'].includes(order.payment_status) && !order.isTerminal;
  const events = order.paymentEvents || [];
  const adjustments = order.paymentAdjustments || [];
  const canAdjust = canControl && order.isTerminal && configured && ['collected', 'reconciled'].includes(order.payment_status);
  const today = new Date(Date.now() - (new Date().getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
  return `<section class="card" style="margin-top:18px"><h2>Paiement à la livraison</h2>
    ${configured ? `<div class="detail-grid"><div class="detail"><span>Montant attendu</span><strong>${escapeHtml(formatMoney(order.expected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>État du paiement</span><strong>${badge(paymentStatusLabels[order.payment_status] || order.payment_status)}</strong></div><div class="detail"><span>Montant reçu</span><strong>${escapeHtml(formatMoney(order.collected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>Mode</span><strong>${escapeHtml(paymentMethodLabels[order.collection_method] || order.collection_method || '—')}</strong></div><div class="detail"><span>Référence</span><strong>${escapeHtml(order.collection_reference || '—')}</strong></div><div class="detail"><span>Rapprochement</span><strong>${escapeHtml(formatDate(order.reconciled_at))}</strong></div></div>${order.discrepancy_reason ? `<div class="notice error"><strong>Écart déclaré :</strong> ${escapeHtml(order.discrepancy_reason)}</div>` : ''}` : '<p class="subtitle">Indiquez un montant si le livreur doit encaisser à la remise. Sans montant, rien n’est demandé au client.</p>'}
    ${canConfigure ? `<form id="paymentConfigure" style="margin-top:18px"><div class="form-grid"><div class="field"><label>Montant à encaisser (FCFA)</label><input name="expectedAmountMinor" type="number" min="1" step="1" value="${configured && order.payment_status !== 'not_required' ? escapeHtml(order.expected_amount_minor) : ''}" required /></div><input type="hidden" name="currency" value="XOF" /></div><div class="actions" style="margin-top:12px"><button class="secondary">${configured ? 'Modifier le montant' : 'Demander ce paiement'}</button>${configured && order.payment_status === 'pending' ? '<button class="danger" type="button" id="removePaymentRequirement">Ne plus demander de paiement</button>' : ''}</div></form>` : ''}
    ${canCollect ? `<form id="paymentCollect" style="margin-top:18px"><h3>Déclarer la somme reçue</h3><div class="form-grid"><div class="field"><label>Montant reçu en FCFA</label><input name="amountMinor" type="number" min="0" step="1" value="${escapeHtml(order.expected_amount_minor)}" required /></div><div class="field"><label>Moyen de paiement</label><select name="method"><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="card">Carte</option><option value="bank_transfer">Virement</option><option value="other">Autre</option></select></div><div class="field"><label>Référence facultative</label><input name="reference" maxlength="120" placeholder="Référence Mobile Money, reçu…" /></div><div class="field"><label>Motif en cas d’écart</label><textarea name="discrepancyReason" placeholder="Obligatoire si le montant reçu diffère"></textarea></div></div><div class="actions" style="margin-top:12px"><button class="primary">Enregistrer le paiement reçu</button></div></form>` : configured && order.payment_status === 'pending' ? '<p class="notice">L’encaissement pourra être déclaré lorsque la commande sera « En livraison » ou « Arrivée ».</p>' : ''}
    ${canReconcile ? `<form id="paymentReconcile" style="margin-top:18px"><div class="field"><label>Note de rapprochement ${order.payment_status === 'discrepancy' ? '(obligatoire)' : '(facultative)'}</label><textarea name="note" placeholder="Contrôle de caisse, justification de l’écart…"></textarea></div><div class="actions" style="margin-top:12px"><button class="primary">Marquer comme rapproché</button>${canReverse ? '<button class="danger" type="button" id="reversePayment">Annuler la saisie</button>' : ''}</div></form>` : ''}
    ${order.isTerminal && configured ? `<section class="adjustment-panel"><h3>Corrections après livraison</h3><p class="subtitle">Le paiement d’origine reste visible. Chaque remboursement ou complément est ajouté comme une nouvelle ligne.</p><div class="detail-grid"><div class="detail"><span>Total d’origine</span><strong>${escapeHtml(formatMoney(order.collected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>Total après corrections</span><strong>${escapeHtml(formatMoney(order.paymentAdjustedTotalMinor, order.payment_currency))}</strong></div></div>${canAdjust ? `<details style="margin-top:14px"><summary>Ajouter une correction</summary><form id="paymentAdjustment" style="margin-top:14px"><div class="form-grid"><div class="field"><label>Nature</label><select name="adjustmentType"><option value="refund">Remboursement au client</option><option value="additional_collection">Complément reçu</option></select></div><div class="field"><label>Montant en FCFA</label><input name="amountMinor" type="number" min="1" step="1" required /></div><div class="field"><label>Mode</label><select name="method"><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="card">Carte</option><option value="bank_transfer">Virement</option><option value="other">Autre</option></select></div><div class="field"><label>Date effective</label><input name="effectiveDate" type="date" max="${today}" value="${today}" required /></div><div class="field full"><label>Référence facultative</label><input name="reference" maxlength="120" placeholder="Reçu, transaction Mobile Money…" /></div><div class="field full"><label>Motif détaillé</label><textarea name="reason" minlength="10" maxlength="1000" required placeholder="Pourquoi cet ajustement est-il nécessaire ?"></textarea></div></div><div class="notice warning" style="margin-top:12px">Vérifiez le sens et le montant. Une erreur sera corrigée par une écriture inverse, jamais par suppression.</div><div class="actions" style="margin-top:12px"><button class="primary">Enregistrer la correction</button></div></form></details>` : '<div class="notice">Seuls le propriétaire et les managers peuvent corriger un paiement après la livraison.</div>'}${adjustments.length ? `<ol class="timeline adjustment-timeline">${adjustments.map((adjustment) => `<li><strong>${escapeHtml(paymentAdjustmentLabels[adjustment.adjustment_type] || adjustment.adjustment_type)}</strong><span>${adjustment.direction === 'inflow' ? '+' : '−'} ${escapeHtml(formatMoney(adjustment.amount_minor, adjustment.currency))} · ${escapeHtml(paymentMethodLabels[adjustment.method] || adjustment.method)}</span><small>Date effective : ${escapeHtml(adjustment.effective_date)} · saisi le ${escapeHtml(formatDate(adjustment.created_at))} · ${escapeHtml(adjustment.actor_name)}</small><p>${escapeHtml(adjustment.reason)}</p>${adjustment.reference ? `<small>Référence : ${escapeHtml(adjustment.reference)}</small>` : ''}${adjustment.reversed ? '<div class="notice">Cette ligne a été annulée.</div>' : canAdjust && adjustment.adjustment_type !== 'reversal' ? `<button class="secondary reverse-adjustment" type="button" data-adjustment-id="${escapeHtml(adjustment.id)}">Annuler cette ligne</button>` : ''}</li>`).join('')}</ol>` : '<p class="subtitle">Aucune correction.</p>'}</section>` : ''}
    <div id="paymentResult"></div>
    ${events.length ? `<details style="margin-top:18px"><summary>Historique financier (${events.length})</summary><ol class="timeline" style="margin-top:16px">${events.map((event) => `<li><strong>${escapeHtml(event.event_type)}</strong><span>${escapeHtml(formatMoney(event.amount_minor, event.currency))}${event.method ? ` · ${escapeHtml(paymentMethodLabels[event.method] || event.method)}` : ''}</span><small>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor_name)}</small>${event.reason ? `<p>${escapeHtml(event.reason)}</p>` : ''}</li>`).join('')}</ol></details>` : ''}
  </section>`;
}

const driverStateLabels = {
  available: 'Disponible', busy: 'En tournée', full: 'Charge complète', pause: 'En pause',
  stale: 'Position ancienne', offline: 'Hors ligne', off_duty: 'Hors service', incident: 'Incident', inactive: 'Inactif',
};

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.href = '/app/login';
    throw new Error('Session expirée.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || 'Une erreur est survenue.'), { status: response.status, payload });
  return payload;
}

function setHeader(title, hint) {
  document.getElementById('topTitle').textContent = title;
  document.getElementById('topHint').textContent = hint;
  document.title = `${title} — TRAXO`;
}

const operationsRoutes = ['/app/operations', '/app/demandes', '/app/nouvelle-commande', '/app/commandes', '/app/tournees', '/app/incidents'];
function activateNavigation() {
  const pathname = location.pathname;
  const billing = pathname === '/app/parametres' && new URLSearchParams(location.search).get('section') === 'billing';
  document.querySelectorAll('.nav a[data-route]').forEach((link) => {
    const route = link.dataset.route;
    let active;
    if (route === 'billing') active = billing;
    else if (route === '/app') active = pathname === '/app';
    else if (route === '/app/operations') active = operationsRoutes.some((base) => pathname === base || pathname.startsWith(`${base}/`));
    else if (route === '/app/parametres') active = pathname.startsWith(route) && !billing;
    else active = pathname.startsWith(route);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  // Le groupe « Espace de travail » s'ouvre quand il contient la page active,
  // sinon il garde le choix de l'utilisateur.
  const group = document.getElementById('navWorkspace');
  if (group) {
    let saved = null;
    try { saved = localStorage.getItem('traxo.navWorkspace'); } catch { /* ignore */ }
    const containsActive = Boolean(group.querySelector('a.active'));
    setWorkspaceGroup(containsActive || saved === '1');
  }
}
function setWorkspaceGroup(open) {
  const group = document.getElementById('navWorkspace');
  const btn = document.getElementById('navWorkspaceBtn');
  if (!group || !btn) return;
  group.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', String(open));
}
document.getElementById('navWorkspaceBtn')?.addEventListener('click', () => {
  const group = document.getElementById('navWorkspace');
  const open = !group.classList.contains('open');
  if (!open && group.querySelector('a.active')) return; // ne jamais cacher la page courante
  setWorkspaceGroup(open);
  try { localStorage.setItem('traxo.navWorkspace', open ? '1' : '0'); } catch { /* ignore */ }
});

function renderError(error) {
  page.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
}

// Icônes partagées (liste des livreurs, etc.).
const DASH_ICONS = {
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><polyline points="3.29 7 12 12 20.71 7" /><path d="m7.5 4.27 9 5.15" /></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" /></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M21.801 10A10 10 0 1 1 17 3.335" /><path d="m9 11 3 3L22 4" /></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>',
  xcircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M12 6v6l4 2" /><circle cx="12" cy="12" r="10" /></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>',
  percent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><line x1="19" x2="5" y1="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ><path d="m6 9 6 6 6-6" /></svg>',
};

// Tableau de bord : rendu dans public/dashboard.js (kit « Dashboard Motion »).
async function renderDashboard() {
  setHeader('Tableau de bord', 'Votre activité, période par période');
  await window.TraxoDashboard.render(page, { api, setHeader, openModal, uiToast });
}

const packageTypeOptions = [['colis', 'Colis'], ['documents', 'Documents'], ['repas', 'Repas'], ['fragile', 'Fragile'], ['vetements', 'Vêtements'], ['autre', 'Autre']];
const packageTypeLabels = Object.fromEntries(packageTypeOptions);

async function renderNewOrder() {
  setHeader('Nouvelle commande', 'Vous connaissez déjà le client');
  page.classList.add('page-no');
  const C = window.TraxoClient;
  const noIcon = {
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    wa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.4L3 21z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .8c-1-.5-1.6-1.1-2.1-2.1l.8-1-1-2L9 9.5z"/></svg>',
    sms: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  };
  const [drivers, rules] = await Promise.all([
    api('/api/app/drivers').catch(() => []),
    api('/api/app/settings/deliveries').catch(() => ({ internalEntryEnabled: true, customerFormEnabled: true })),
  ]);
  const unavailable = ['inactive', 'off_duty', 'incident'];
  const sortedDrivers = drivers.filter((d) => d.active !== false)
    .sort((a, b) => Number(unavailable.includes(a.operationalState)) - Number(unavailable.includes(b.operationalState)) || (a.activeOrders || 0) - (b.activeOrders || 0));
  let mode = 'confirm';

  const journeys = {
    confirm: [
      ['Vous saisissez ce que vous savez', 'Nom, téléphone, quartier.'],
      ['Le client vérifie et confirme', 'Il corrige si besoin et partage sa position s’il le souhaite.'],
      ['Vous affectez un livreur', 'Depuis Opérations › Demandes.'],
      ['Le client suit sa livraison', 'En direct, avec le délai estimé s’il a partagé sa position.'],
    ],
    direct: [
      ['Vous saisissez la commande', 'Toutes les informations sont sûres.'],
      ['Vous choisissez le livreur', 'La commande rejoint sa tournée du jour.'],
      ['Vous envoyez le lien de suivi', 'Par WhatsApp, SMS ou copier-coller.'],
    ],
  };
  const journeyHtml = (steps, doneCount = 0) => `<ol class="no-journey">${steps.map(([t, s], i) => `<li class="${i < doneCount ? 'done' : i === doneCount ? 'now' : ''}" style="--i:${i}"><span class="dot" aria-hidden="true"></span><span><b>${escapeHtml(t)}</b><small>${escapeHtml(s)}</small></span></li>`).join('')}</ol>`;
  const initialsOf = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  const driverCard = (d) => {
    const off = unavailable.includes(d.operationalState);
    const tone = off ? '' : ['busy', 'full'].includes(d.operationalState) ? 'busy' : ['available'].includes(d.operationalState) ? 'ok' : '';
    const photo = d.hasPhoto ? `<img src="/api/app/drivers/${encodeURIComponent(d.id)}/photo?v=${encodeURIComponent(d.photoVersion || 0)}" alt="">` : escapeHtml(initialsOf(d.name));
    return `<label class="no-driver"><input type="radio" name="driverId" value="${escapeHtml(d.id)}" ${off ? 'disabled' : ''}><span class="no-driver-body"><span class="no-av">${photo}</span><span class="no-driver-text"><strong>${escapeHtml(d.name)}</strong><small><span class="no-state ${tone}"></span>${escapeHtml(driverStateLabels[d.operationalState] || d.operationalState || '')} · ${escapeHtml(colisCount(d.activeOrders))}</small></span></span></label>`;
  };

  const confirmAllowed = rules.internalEntryEnabled !== false;
  page.innerHTML = `<div class="no">
    <div class="no-grid">
      <aside class="no-aside">
        <p class="no-eyebrow">Nouvelle commande</p>
        <h1 class="no-title">Préparer une livraison</h1>
        <p class="no-lead">Vous connaissez déjà votre client ? Saisissez ce que vous savez, TRAXO s’occupe du reste.</p>
        <hr class="no-rule" />
        <div class="no-modes" role="radiogroup" aria-label="Comment créer la commande">
          <label class="no-mode"><input type="radio" name="noMode" value="confirm" checked ${confirmAllowed ? '' : 'disabled'}><span class="no-mode-body"><span class="no-mode-text"><strong>Le client confirme <span class="no-tag">Recommandé</span></strong><small>Il vérifie ses informations depuis son téléphone et partage sa position s’il le souhaite.</small></span></span></label>
          <label class="no-mode"><input type="radio" name="noMode" value="direct" ${confirmAllowed ? '' : 'disabled'}><span class="no-mode-body"><span class="no-mode-text"><strong>Je crée la commande maintenant</strong><small>Tout est sûr : vous choisissez le livreur tout de suite.</small></span></span></label>
        </div>
        <div id="noJourney">${journeyHtml(journeys.confirm)}</div>
        ${rules.customerFormEnabled !== false ? `<button type="button" class="no-textlink" id="noBlank">Le client remplit tout lui-même : envoyer un formulaire vierge ${noIcon.arrow}</button>` : ''}
      </aside>
      <div class="no-main" id="noMain">
        ${confirmAllowed ? '' : '<p class="no-notice">La saisie par votre équipe est désactivée dans Paramètres › Livraisons.</p>'}
        <form id="noForm" novalidate>
          <div id="noError" role="alert"></div>
          <section class="no-sec" style="--i:0">
            <div class="no-sec-head"><span class="no-sec-num">01</span><h2 class="no-sec-title">Le client</h2></div>
            <div class="no-row">
              <div class="no-field"><label for="f-name">Nom et prénom *</label><input class="cl-input" id="f-name" name="customerName" autocomplete="off" required maxlength="120" /></div>
              <div class="no-field"><label for="f-phone">Téléphone <span id="phoneReq">*</span></label>${C.phoneFieldHtml({})}<p class="no-hint" id="phoneHint">Pour le joindre à l’arrivée.</p></div>
            </div>
          </section>
          <section class="no-sec" style="--i:1">
            <div class="no-sec-head"><span class="no-sec-num">02</span><h2 class="no-sec-title">Lieu de livraison</h2></div>
            <p class="no-sec-sub" id="placeSub">Le client pourra corriger ces informations et partager sa position exacte.</p>
            <div class="no-field"><label for="f-zone">Quartier ou zone *</label><input class="cl-input" id="f-zone" name="neighborhood" required maxlength="160" placeholder="Ex. Akpakpa, Cotonou" /></div>
            <div class="no-field"><label for="f-landmark">Repère <em>(facultatif)</em></label><input class="cl-input" id="f-landmark" name="landmark" maxlength="240" placeholder="Ex. portail vert, près de la pharmacie" /></div>
            <div class="no-row">
              <div class="no-field"><label for="f-time">Créneau souhaité <em>(facultatif)</em></label><input class="cl-input" id="f-time" name="requestedTime" maxlength="80" placeholder="Ex. 15 h – 17 h" /></div>
              <div class="no-field"><label for="f-notes">Consigne pour le livreur <em>(facultatif)</em></label><input class="cl-input" id="f-notes" name="notes" maxlength="1000" placeholder="Ex. appeler en arrivant" /></div>
            </div>
            <label class="no-urgent"><input type="checkbox" name="priority" value="urgent" /><span><strong>Livraison urgente</strong><small>Elle passe devant les autres livraisons du livreur et ressort sur la carte.</small></span></label>
          </section>
          <section class="no-sec" style="--i:2">
            <div class="no-sec-head"><span class="no-sec-num">03</span><h2 class="no-sec-title">Le colis</h2></div>
            <p class="no-sec-sub">Ce que le livreur transporte, et d’où il part.</p>
            <div class="no-field"><span class="no-label" id="pkgTypeLabel">Type <em>(facultatif)</em></span>
              <div class="no-chips" role="radiogroup" aria-labelledby="pkgTypeLabel">${packageTypeOptions.map(([v, l]) => `<label class="no-chip"><input type="radio" name="packageType" value="${v}"><span>${escapeHtml(l)}</span></label>`).join('')}</div></div>
            <div class="no-field"><label for="f-pkg">Contenu <em>(facultatif)</em></label><input class="cl-input" id="f-pkg" name="packageDescription" maxlength="240" placeholder="Ex. 2 robes dans un sac, gâteau d’anniversaire" /></div>
            <div class="no-row">
              <div class="no-field"><label for="f-fee">Prix de la livraison <em>(facultatif)</em></label><div class="no-money"><input class="cl-input" id="f-fee" name="deliveryFee" inputmode="numeric" maxlength="12" placeholder="Ex. 1 500" autocomplete="off" /><span>FCFA</span></div></div>
              <div class="no-field"><label for="f-amount">Montant de la commande <em>(facultatif)</em></label><div class="no-money"><input class="cl-input" id="f-amount" name="orderAmount" inputmode="numeric" maxlength="14" placeholder="Ex. 25 000" autocomplete="off" /><span>FCFA</span></div></div>
            </div>
            <p class="no-hint no-money-hint">Pour suivre votre chiffre d’affaires dans les rapports. TRAXO n’encaisse aucun paiement.</p>
            <div class="no-field"><span class="no-label" id="pickupLabel">Où le livreur récupère-t-il le colis ?</span>
              <div class="no-seg" role="radiogroup" aria-labelledby="pickupLabel">
                <label><input type="radio" name="pickupEnabled" value="false" checked><span>Chez nous</span></label>
                <label><input type="radio" name="pickupEnabled" value="true"><span>Ailleurs</span></label>
              </div></div>
            <div class="no-collapse" id="noPickupWrap" aria-hidden="true"><div>
              <div class="no-pickup">
                <div class="no-row">
                  <div class="no-field no-suggest-wrap"><label for="f-pname">Nom du lieu</label><input class="cl-input" id="f-pname" name="pickupName" maxlength="120" autocomplete="off" placeholder="Ex. Boutique Awa, entrepôt du fournisseur" /><ul class="no-suggest" id="pickupSuggest" role="listbox" hidden></ul></div>
                  <div class="no-field"><label for="f-pphone">Téléphone sur place <em>(facultatif)</em></label><input class="cl-input" id="f-pphone" name="pickupPhone" type="tel" inputmode="tel" maxlength="30" placeholder="Ex. 01 97 12 34 56" /></div>
                </div>
                <div class="no-row">
                  <div class="no-field"><label for="f-paddr">Quartier ou repère *</label><input class="cl-input" id="f-paddr" name="pickupAddress" maxlength="240" placeholder="Ex. Dantokpa, allée des tissus" /></div>
                  <div class="no-field"><label for="f-pready">Colis prêt à partir de <em>(facultatif)</em></label><input class="cl-input" id="f-pready" name="pickupReady" maxlength="80" placeholder="Ex. 14 h" /></div>
                </div>
                <div class="no-field"><span class="no-label">Position exacte <em>(facultatif)</em></span>
                  <div class="no-pickmap" id="pickupMap" aria-label="Carte : touchez l’endroit de la collecte"></div>
                  <p class="no-hint" id="pickupMapHint">Touchez la carte pour placer l’épingle. Sinon, TRAXO retiendra l’endroit où le livreur récupère le colis.</p>
                  <input type="hidden" name="pickupLat" id="f-plat" /><input type="hidden" name="pickupLng" id="f-plng" /></div>
              </div>
            </div></div>
          </section>
          <div class="no-collapse" id="noDriverWrap" aria-hidden="true"><div>
            <section class="no-sec" style="--i:3">
              <div class="no-sec-head"><span class="no-sec-num">04</span><h2 class="no-sec-title">Livreur</h2></div>
              ${sortedDrivers.length ? `<div class="no-drivers" role="radiogroup" aria-label="Livreur">${sortedDrivers.map(driverCard).join('')}</div>` : '<p class="no-empty">Aucun livreur actif. Ajoutez-en un depuis la page Livreurs.</p>'}
            </section>
          </div></div>
          <div class="no-submit">
            <button class="no-btn big" id="noSubmit" type="submit" ${confirmAllowed ? '' : 'disabled'}><span id="noSubmitLabel">Envoyer au client pour confirmation</span>${noIcon.arrow}</button>
            <p class="no-hint" id="noSubmitHint">Vous obtenez un lien à envoyer par WhatsApp ou SMS.</p>
          </div>
        </form>
      </div>
    </div>
  </div>`;

  const form = document.getElementById('noForm');
  const main = document.getElementById('noMain');
  const errorBox = document.getElementById('noError');
  const say = (text) => { errorBox.innerHTML = text ? `<p class="no-notice">${escapeHtml(text)}</p>` : ''; };
  C.wirePhoneField(form);
  // Le libellé d'aide du téléphone vient du composant client : on l'adapte au contexte.
  const phoneHint = document.getElementById('phoneHint');
  const setMode = (next) => {
    mode = next;
    const direct = mode === 'direct';
    const wrap = document.getElementById('noDriverWrap');
    wrap.classList.toggle('open', direct);
    wrap.setAttribute('aria-hidden', String(!direct));
    wrap.querySelectorAll('input').forEach((i) => { i.tabIndex = direct ? 0 : -1; });
    document.getElementById('phoneReq').textContent = direct ? '' : '*';
    document.getElementById('f-phone').required = !direct;
    phoneHint.textContent = direct ? 'Pour le joindre à l’arrivée.' : 'Obligatoire : il reçoit le lien et s’en sert pour déverrouiller ses informations.';
    document.getElementById('placeSub').textContent = direct ? 'Ces informations partent telles quelles au livreur.' : 'Le client pourra corriger ces informations et partager sa position exacte.';
    document.getElementById('noSubmitLabel').textContent = direct ? 'Créer la commande' : 'Envoyer au client pour confirmation';
    document.getElementById('noSubmitHint').textContent = direct ? 'Le lien de suivi est créé en même temps que la commande.' : 'Vous obtenez un lien à envoyer par WhatsApp ou SMS.';
    document.getElementById('noJourney').innerHTML = journeyHtml(journeys[mode]);
  };
  document.querySelectorAll('input[name="noMode"]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));
  setMode('confirm');

  // Depuis une fiche client (« Nouvelle commande ») : coordonnées et lieu
  // habituel préremplis, et la commande rejoint cette fiche.
  const fromClient = new URLSearchParams(location.search).get('client');
  if (/^\d{1,18}$/.test(fromClient || '')) {
    try {
      const d = await api(`/api/app/crm/customers/${encodeURIComponent(fromClient)}`);
      const phone = (d.contacts || []).find((c) => c.kind === 'phone' && c.is_active && c.is_primary) || (d.contacts || []).find((c) => c.kind === 'phone' && c.is_active);
      const places = (d.locations || []).filter((l) => l.is_active);
      const place = places.find((l) => String(l.id) === String(d.customer.default_location_id)) || places[0];
      form.querySelector('#f-name').value = d.customer.display_name || '';
      if (phone) {
        const raw = String(phone.value_display || '').trim();
        form.querySelector('#f-phone').value = /^\+229/.test(raw.replace(/\s/g, '')) ? raw.replace(/^\+229\s*/, '') : raw;
      }
      if (place) {
        form.querySelector('#f-zone').value = [place.neighborhood || place.address_text, place.locality].filter(Boolean).join(', ').slice(0, 160);
        if (place.landmark) form.querySelector('#f-landmark').value = place.landmark.slice(0, 240);
      }
      const notes = form.querySelector('[name="notes"]');
      if (notes && !notes.value && d.customer.driver_instructions) notes.value = d.customer.driver_instructions;
      form.insertAdjacentHTML('afterbegin', `<input type="hidden" name="customerId" value="${escapeHtml(fromClient)}"><p class="no-notice no-client-pick">Commande pour <strong>${escapeHtml(d.customer.display_name)}</strong> (CL-${escapeHtml(String(d.customer.id).padStart(4, '0'))}) : elle rejoindra sa fiche. <button type="button" class="no-textlink" id="noUnpick">Ne pas lier à cette fiche</button></p>`);
      form.querySelector('#noUnpick').addEventListener('click', () => { form.querySelector('[name="customerId"]')?.remove(); form.querySelector('.no-client-pick')?.remove(); });
    } catch { /* fiche introuvable : formulaire vierge */ }
  }

  // Collecte : section dépliée seulement si le colis part d'ailleurs.
  const pickupWrap = document.getElementById('noPickupWrap');
  const pickupAddr = document.getElementById('f-paddr');
  let pickupMap = null;
  let pickupMarker = null;
  const setPin = (lat, lng, { pan = true } = {}) => {
    document.getElementById('f-plat').value = lat == null ? '' : lat.toFixed(6);
    document.getElementById('f-plng').value = lng == null ? '' : lng.toFixed(6);
    if (!pickupMap) return;
    if (lat == null) { if (pickupMarker) { pickupMap.removeLayer(pickupMarker); pickupMarker = null; } return; }
    if (!pickupMarker) {
      pickupMarker = L.marker([lat, lng], { draggable: true, title: 'Point de collecte' }).addTo(pickupMap);
      pickupMarker.on('dragend', () => { const p = pickupMarker.getLatLng(); setPin(p.lat, p.lng, { pan: false }); });
    } else pickupMarker.setLatLng([lat, lng]);
    if (pan) pickupMap.setView([lat, lng], Math.max(pickupMap.getZoom(), 16));
    document.getElementById('pickupMapHint').textContent = 'Épingle posée. Vous pouvez la déplacer si besoin.';
    pickupAddr.required = false;
  };
  const ensurePickupMap = () => {
    if (pickupMap || typeof L === 'undefined') return;
    pickupMap = L.map('pickupMap', { zoomControl: true, scrollWheelZoom: false }).setView([6.3703, 2.3912], 12);
    if (window.TraxoMapBase) window.TraxoMapBase.load().then((config) => window.TraxoMapBase.layerSwitcher(pickupMap, config, { position: 'topright' }));
    pickupMap.on('click', (event) => setPin(event.latlng.lat, event.latlng.lng, { pan: false }));
  };
  const setPickup = (on) => {
    pickupWrap.classList.toggle('open', on);
    pickupWrap.setAttribute('aria-hidden', String(!on));
    pickupWrap.querySelectorAll('input').forEach((i) => { i.tabIndex = on ? 0 : -1; });
    pickupAddr.required = on && !document.getElementById('f-plat').value;
    if (on) { ensurePickupMap(); setTimeout(() => pickupMap && pickupMap.invalidateSize(), 320); }
  };
  document.querySelectorAll('input[name="pickupEnabled"]').forEach((r) => r.addEventListener('change', () => setPickup(r.value === 'true' && r.checked)));
  setPickup(false);

  // Carnet automatique : les lieux de collecte déjà utilisés par l'équipe.
  const pickupName = document.getElementById('f-pname');
  const suggest = document.getElementById('pickupSuggest');
  let places = [];
  let suggestTimer = null;
  const paintSuggest = () => {
    const q = pickupName.value.trim().toLowerCase();
    const shown = places.filter((p) => !q || `${p.name || ''} ${p.address || ''}`.toLowerCase().includes(q)).slice(0, 6);
    suggest.innerHTML = shown.map((p, i) => `<li role="option" tabindex="-1" data-i="${places.indexOf(p)}"><strong>${escapeHtml(p.name || p.address)}</strong>${p.name && p.address ? `<small>${escapeHtml(p.address)}</small>` : ''}${p.lat != null ? '<em>Position connue</em>' : ''}</li>`).join('');
    suggest.hidden = !shown.length || document.activeElement !== pickupName;
  };
  const loadPlaces = async () => {
    try { places = (await api(`/api/app/pickup-places?q=${encodeURIComponent(pickupName.value.trim())}`)).places || []; } catch { places = []; }
    paintSuggest();
  };
  pickupName.addEventListener('focus', loadPlaces);
  pickupName.addEventListener('input', () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(loadPlaces, 180); });
  pickupName.addEventListener('blur', () => setTimeout(() => { suggest.hidden = true; }, 150));
  suggest.addEventListener('mousedown', (event) => {
    const li = event.target.closest('li[data-i]');
    if (!li) return;
    event.preventDefault();
    const p = places[Number(li.dataset.i)];
    pickupName.value = p.name || '';
    if (p.address) pickupAddr.value = p.address;
    if (p.phone) document.getElementById('f-pphone').value = p.phone;
    if (p.lat != null) { ensurePickupMap(); setPin(p.lat, p.lng); }
    suggest.hidden = true;
    pickupAddr.required = !document.getElementById('f-plat').value;
  });

  const digitsOf = (phone) => String(phone || '').replace(/\D/g, '');
  const shareScreen = ({ title, lead, url, message, phone, meta, doneCount, steps, next }) => {
    const digits = digitsOf(phone);
    main.innerHTML = `<div class="no-done" id="noDone" tabindex="-1">
      <svg class="no-check" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30"/><path d="M20 33l8 8 16-17"/></svg>
      <p class="no-eyebrow">${escapeHtml(meta.eyebrow)}</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(lead)}</p>
      <div class="no-linkbox"><code>${escapeHtml(url)}</code><button type="button" data-copy="url">Copier</button></div>
      <div class="no-share">
        ${digits ? `<a class="no-btn no-wa" href="https://wa.me/${escapeHtml(digits)}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener">${noIcon.wa} WhatsApp</a>
        <a class="no-btn outline" href="sms:+${escapeHtml(digits)}?&body=${encodeURIComponent(message)}">${noIcon.sms} SMS</a>` : ''}
        <button type="button" class="no-btn ghost" data-copy="message">${noIcon.copy} Copier le message</button>
      </div>
      ${meta.note ? `<p class="no-meta">${escapeHtml(meta.note)}</p>` : ''}
      ${journeyHtml(steps, doneCount)}
      <div class="no-next">${next}<button type="button" class="no-btn ghost" id="noAgain">Saisir une autre commande</button></div>
    </div>`;
    const copy = async (text, label) => {
      try { await navigator.clipboard.writeText(text); uiToast(label, 'success'); } catch { uiToast('Copie impossible : sélectionnez le texte à la main.', 'warning'); }
    };
    main.querySelector('[data-copy="url"]').addEventListener('click', () => copy(url, 'Lien copié.'));
    main.querySelector('[data-copy="message"]').addEventListener('click', () => copy(message, 'Message copié.'));
    main.querySelector('#noAgain').addEventListener('click', () => { history.replaceState(null, '', '/app/nouvelle-commande'); renderNewOrder(); });
    document.getElementById('noDone').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  document.getElementById('noBlank')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const link = await api('/api/app/request-links', { method: 'POST' });
      const url = publicLink(link.path);
      shareScreen({
        title: 'Formulaire prêt à envoyer',
        lead: 'Le client indique lui-même ses coordonnées et sa position. Sa demande arrive ensuite dans Opérations › Demandes.',
        url, message: `Bonjour, pour préparer votre livraison, indiquez vos informations ici : ${url}`, phone: '',
        meta: { eyebrow: 'Formulaire vierge', note: `Le lien expire le ${formatDateOnly(link.expiresAt)}.` },
        steps: [['Vous envoyez le formulaire', ''], ['Le client le remplit', 'Coordonnées, position, photos du lieu.'], ['Vous validez et affectez un livreur', '']],
        doneCount: 1,
        next: '<a class="no-btn outline" href="/app/operations?vue=demandes">Voir les demandes</a>',
      });
    } catch (error) { uiToast(error.message, 'error'); button.disabled = false; }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    say('');
    const missing = C.firstMissing(form);
    if (missing) { say('Merci de remplir les champs obligatoires.'); missing.focus(); return; }
    const data = C.readFields(form);
    data.priority = form.querySelector('input[name="priority"]')?.checked ? 'urgent' : 'normal';
    data.pickupEnabled = data.pickupEnabled === 'true';
    data.pickupPhoneCountry = data.customerPhoneCountry;
    if (!data.packageType) delete data.packageType;
    for (const k of ['deliveryFee', 'orderAmount']) {
      const digits = String(data[k] || '').replace(/[\s.\u202f\u00a0]/g, '');
      if (!digits) { delete data[k]; continue; }
      if (!/^\d{1,12}$/.test(digits)) { say('Indiquez les prix en FCFA, sans centimes (ex. 1500).'); form.querySelector(`[name="${k}"]`).focus(); return; }
      data[k] = Number(digits);
    }
    const submit = document.getElementById('noSubmit');
    const label = document.getElementById('noSubmitLabel');
    const idle = label.textContent;
    if (mode === 'direct' && !data.driverId) { say('Choisissez le livreur de cette commande.'); form.querySelector('input[name="driverId"]:not(:disabled)')?.focus(); return; }
    submit.disabled = true;
    label.textContent = mode === 'direct' ? 'Création…' : 'Préparation du lien…';
    try {
      if (mode === 'confirm') {
        const result = await api('/api/app/requests/prefilled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const firstName = data.customerName.split(/\s+/)[0];
        shareScreen({
          title: `Envoyez le lien à ${firstName}`,
          lead: `${firstName} vérifiera ses informations et partagera sa position s’il le souhaite. Pour protéger ses données, on lui demandera les 4 derniers chiffres de son numéro.`,
          url: publicLink(result.path), message: result.message.replace(result.url, publicLink(result.path)), phone: result.phone,
          meta: { eyebrow: 'Lien de confirmation prêt', note: `Le lien expire le ${formatDateOnly(result.expiresAt)}. Vous le retrouvez aussi dans Opérations › Demandes.` },
          steps: journeys.confirm, doneCount: 1,
          next: `<a class="no-btn outline" href="/app/operations?vue=demandes&demande=${encodeURIComponent(result.id)}">Voir la demande</a>`,
        });
      } else {
        const result = await api('/api/app/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        const url = publicLink(result.path);
        const firstName = data.customerName.split(/\s+/)[0];
        shareScreen({
          title: 'Commande créée',
          lead: `Envoyez à ${firstName} son lien de suivi : il verra son livreur en direct dès le départ.`,
          url, message: `Bonjour ${firstName}, votre livraison est en préparation. Suivez-la ici : ${url}`, phone: result.customerPhone,
          meta: { eyebrow: 'Lien de suivi', note: 'Le lien reste disponible dans le tiroir de la commande.' },
          steps: journeys.direct, doneCount: 2,
          next: `<a class="no-btn outline" href="/app/operations?vue=commandes&commande=${encodeURIComponent(result.orderId)}">Voir la commande</a>`,
        });
      }
    } catch (error) {
      say(error.message);
      if (/collecte/i.test(error.message)) document.getElementById('f-paddr')?.focus();
      else if (/téléphone/i.test(error.message)) C.markFieldError(form, 'customerPhone', error.message);
      submit.disabled = false;
      label.textContent = idle;
    }
  });
}

// Ancienne page « /app/commandes/:id » : tout est désormais dans le tiroir
// Opérations › Commandes (liens, favoris et notifications y sont redirigés).
function renderOrderDetail(id) {
  location.replace(`/app/operations?vue=commandes&commande=${encodeURIComponent(id)}`);
}

// Actions d'une commande (étape, réaffectation, lien de suivi, encaissement,
// preuves, code de remise, incidents), montées dans `root` — le tiroir de la
// commande. `refresh` redessine le tiroir après chaque action.
async function mountOrderActions(root, id, { refresh, order: prefetched } = {}) {
  const $ = (elementId) => root.querySelector(`#${elementId}`);
  const reload = refresh || (() => mountOrderActions(root, id, {}));
  const canManage = ['owner', 'manager', 'operator'].includes(context.user.role);
  const order = prefetched || await api(`/api/app/orders/${encodeURIComponent(id)}`);
  const reassignDrivers = (!order.isTerminal && canManage) ? await api('/api/app/drivers').catch(() => []) : [];
  const destination = [order.neighborhood, order.landmark, order.delivery_address].filter(Boolean).join(' — ') || '—';
  const incidentOptions = Object.entries(incidentCategoryLabels)
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
  const evidenceByType = Object.fromEntries((order.evidence || []).map((item) => [item.evidence_type, item]));
  const missingRequiredEvidence = [
    order.photo_proof_mode === 'required' && !evidenceByType.photo ? 'photo' : null,
    order.signature_proof_mode === 'required' && !evidenceByType.signature ? 'signature' : null,
  ].filter(Boolean);
  const trackingLink = order.trackingLink || { state: 'unavailable', path: null };
  const trackingStateLabels = {
    active: 'Actif', terminal: 'Livraison terminée', revoked: 'Révoqué', expired: 'Expiré', unavailable: 'Indisponible',
  };
  const trackingLinkUsable = ['active', 'terminal'].includes(trackingLink.state);
  root.innerHTML = `
    ${!order.isTerminal && order.allowedTransitions.length ? `<section class="card" style="margin-top:18px"><h2>Mettre à jour le statut</h2><p class="subtitle">Choisissez la prochaine étape : seules les étapes possibles à ce stade sont proposées.</p><form id="transitionForm" style="margin-top:16px"><div class="form-grid"><div class="field"><label>Prochaine étape</label><select name="toStatus" required><option value="">Choisir une étape</option>${order.allowedTransitions.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join('')}</select></div><div class="field"><label>Motif ou remarque</label><textarea name="reason" placeholder="Obligatoire en cas d’échec, de retour ou d’annulation"></textarea></div></div><div class="actions" style="margin-top:16px"><button class="primary">Mettre à jour</button></div></form><div id="transitionResult"></div></section>` : ''}

    ${(!order.isTerminal && canManage) ? `<section class="card" style="margin-top:18px"><h2>Changer de livreur</h2><p class="subtitle">La commande rejoint automatiquement la tournée du jour du nouveau livreur.</p><form id="reassignForm" style="margin-top:14px"><div class="form-grid"><div class="field full"><label>Livreur</label><select name="driverId" required>${reassignDrivers.map((d) => `<option value="${escapeHtml(d.id)}" ${String(d.id) === String(order.driver_id) ? 'selected' : ''} ${(!d.active || ['inactive', 'off_duty', 'incident'].includes(d.operationalState)) && String(d.id) !== String(order.driver_id) ? 'disabled' : ''}>${escapeHtml(d.name)}${d.vehicleType ? ` · ${escapeHtml(d.vehicleType)}` : ''}${String(d.id) === String(order.driver_id) ? ' (actuel)' : ''}</option>`).join('')}</select></div></div><div class="actions" style="margin-top:14px"><button class="primary">Changer de livreur</button></div></form><div id="reassignResult"></div></section>` : ''}

    <section class="card" style="margin-top:18px"><h2>Lien de suivi du client</h2><p class="subtitle">Le client voit uniquement cette livraison. Par sécurité, le lien ne s’affiche que sur demande et chaque affichage est enregistré.</p><div class="detail-grid"><div class="detail"><span>État du lien</span><strong>${escapeHtml(trackingStateLabels[trackingLink.state] || trackingLink.state)}</strong></div><div class="detail"><span>Expiration</span><strong>${escapeHtml(formatDate(trackingLink.expiresAt))}</strong></div></div><div class="actions" style="margin-top:18px">${trackingLinkUsable ? '<button class="secondary" type="button" id="revealTrackingLink">Afficher et copier</button>' : ''}${!order.isTerminal ? `<label class="field" style="max-width:190px"><span>Durée de validité</span><select id="trackingTtl"><option value="1">1 jour</option><option value="3">3 jours</option><option value="7" selected>7 jours</option><option value="14">14 jours</option><option value="30">30 jours</option></select></label><button class="primary" type="button" id="rotateTrackingLink">${trackingLinkUsable ? 'Renouveler le lien' : 'Créer un nouveau lien'}</button>` : ''}${trackingLinkUsable ? '<button class="danger" type="button" id="revokeTrackingLink">Révoquer</button>' : ''}</div><div id="trackingLinkResult"></div></section>

    ${renderPaymentSection(order)}


    ${(order.photo_proof_mode !== 'off' || order.signature_proof_mode !== 'off' || order.evidence?.length) ? `<section class="card" style="margin-top:18px"><h2>Preuves de livraison</h2><p class="subtitle">Photo et signature prises à la remise. Visibles par votre équipe et le livreur, jamais par le client.</p><div class="evidence-grid">${['photo', 'signature'].filter((type) => order[`${type}_proof_mode`] !== 'off' || evidenceByType[type]).map((type) => { const item = evidenceByType[type]; const label = type === 'photo' ? 'Photo de remise' : 'Signature'; const mode = order[`${type}_proof_mode`]; return `<article class="evidence-card"><strong>${label}</strong><small>${mode === 'required' ? 'Obligatoire' : 'Facultative'}</small>${item ? `<a target="_blank" rel="noopener" href="/api/app/evidence/${escapeHtml(item.id)}"><img src="/api/app/evidence/${escapeHtml(item.id)}" alt="${label}" /></a><small>Ajoutée le ${escapeHtml(formatDate(item.created_at))}</small>` : '<div class="evidence-empty">Pas encore ajoutée</div>'}</article>`; }).join('')}</div></section>` : ''}
    ${order.requiresOtpForDelivery ? `<section class="card" style="margin-top:18px"><h2>Valider la remise avec le code</h2><p class="subtitle">Le destinataire donne ce code au livreur pour confirmer la remise. Valable 30 minutes, une seule fois : envoyez-le par SMS ou WhatsApp.</p>${order.paymentBlocksDelivery ? '<div class="notice error">Finalisez l’encaissement ou son rapprochement avant de confirmer la livraison.</div>' : ''}${missingRequiredEvidence.length ? `<div class="notice error">Preuve obligatoire manquante : ${escapeHtml(missingRequiredEvidence.join(' et '))}.</div>` : ''}<div class="actions" style="margin-top:16px"><button class="secondary" id="generateOtp">Générer un code de remise</button></div><div id="otpGenerated"></div><form id="verifyOtp" style="margin-top:18px"><div class="field"><label>Code communiqué par le destinataire</label><input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="000000" required /></div><div class="actions" style="margin-top:12px"><button class="primary" ${order.paymentBlocksDelivery || missingRequiredEvidence.length ? 'disabled' : ''}>Confirmer la livraison</button></div></form><div id="otpResult"></div></section>` : ''}
    ${order.proof_id ? `<section class="card" style="margin-top:18px"><h2>Code de remise</h2><div class="notice success">Remise confirmée par code à usage unique le ${escapeHtml(formatDate(order.proof_verified_at))}.</div></section>` : ''}

    <section class="card" style="margin-top:18px"><h2>Incidents</h2><form id="incidentForm"><div class="form-grid"><div class="field"><label>Type</label><select name="category">${incidentOptions}</select></div><div class="field"><label>Gravité</label><select name="severity"><option value="low">Faible</option><option value="medium" selected>Moyenne</option><option value="high">Élevée</option></select></div><div class="field full"><label>Que s’est-il passé ?</label><textarea name="description" maxlength="2000" required placeholder="Décrivez ce qui s’est passé, sans supprimer les faits précédents."></textarea></div></div><div class="actions" style="margin-top:14px"><button class="secondary">Déclarer l’incident</button></div></form><div id="incidentResult"></div>
      <div class="incident-list">${order.incidents.length ? order.incidents.map((incident) => `<article class="incident"><div><strong>${escapeHtml(incidentCategoryLabels[incident.category] || incident.category)}</strong> ${badge(incident.status === 'resolved' ? 'Résolu' : 'Ouvert')}<p>${escapeHtml(incident.description)}</p><small>${escapeHtml(formatDate(incident.created_at))} · ${escapeHtml(incident.opened_by)} · gravité ${escapeHtml((incidentSeverityLabels[incident.severity] || incident.severity).toLowerCase())}</small>${incident.resolution ? `<p><strong>Résolution :</strong> ${escapeHtml(incident.resolution)}</p>` : ''}</div><a class="button secondary" href="/app/incidents/${escapeHtml(incident.id)}">Ouvrir le dossier</a></article>`).join('') : '<p class="subtitle">Aucun incident déclaré.</p>'}</div>
    </section>`;

  const revealTrackingLink = $('revealTrackingLink');
  if (revealTrackingLink) revealTrackingLink.addEventListener('click', async () => {
    revealTrackingLink.disabled = true;
    try {
      const result = await api(`/api/app/orders/${encodeURIComponent(id)}/tracking-link/reveal`, { method: 'POST' });
      const fullUrl = publicLink(result.trackingLink.path);
      try { await navigator.clipboard.writeText(fullUrl); } catch (_error) { /* Le lien reste affiché ci-dessous. */ }
      $('trackingLinkResult').innerHTML = `<div class="notice success">Lien prêt${navigator.clipboard ? ' et copie demandée' : ''} : <a href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener">ouvrir le suivi client</a>.</div>`;
    } catch (error) {
      $('trackingLinkResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
      revealTrackingLink.disabled = false;
    }
  });

  const rotateTrackingLink = $('rotateTrackingLink');
  if (rotateTrackingLink) rotateTrackingLink.addEventListener('click', async () => {
    const expiresInDays = Number($('trackingTtl').value);
    if (!(await uiConfirm('Créer un nouveau lien de suivi ?', { message: 'L’ancien lien cessera immédiatement de fonctionner.', tone: 'danger', confirmLabel: 'Renouveler le lien' }))) return;
    rotateTrackingLink.disabled = true;
    try {
      await api(`/api/app/orders/${encodeURIComponent(id)}/tracking-link/rotate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays, expectedVersion: trackingLink.version, idempotencyKey: actionKey('tracking-link-rotate') }),
      });
      await reload();
    } catch (error) {
      $('trackingLinkResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      rotateTrackingLink.disabled = false;
    }
  });

  const revokeTrackingLink = $('revokeTrackingLink');
  if (revokeTrackingLink) revokeTrackingLink.addEventListener('click', async () => {
    const reason = await uiPrompt('Révoquer le lien de suivi', { label: 'Motif de la révocation', placeholder: 'Ex. : lien partagé par erreur', minLength: 8, minLengthMessage: 'Le motif doit contenir au moins 8 caractères.' }, { tone: 'danger', confirmLabel: 'Révoquer', message: 'Le client ne pourra plus suivre sa livraison avec ce lien.' });
    if (!reason) return;
    if (reason.trim().length < 8) {
      $('trackingLinkResult').innerHTML = '<div class="notice error">Le motif doit contenir au moins 8 caractères.</div>';
      return;
    }
    revokeTrackingLink.disabled = true;
    try {
      await api(`/api/app/orders/${encodeURIComponent(id)}/tracking-link/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), expectedVersion: trackingLink.version, idempotencyKey: actionKey('tracking-link-revoke') }),
      });
      await reload();
    } catch (error) {
      $('trackingLinkResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      revokeTrackingLink.disabled = false;
    }
  });

  const paymentConfigure = $('paymentConfigure');
  if (paymentConfigure) paymentConfigure.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
    button.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(event.currentTarget, 'payment-configure', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/configure`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const removePaymentRequirement = $('removePaymentRequirement');
  if (removePaymentRequirement) removePaymentRequirement.addEventListener('click', async () => {
    const reason = await uiPrompt('Retirer l’encaissement', { label: 'Pourquoi cet encaissement n’est-il plus requis ?', placeholder: 'Ex. : commande déjà payée en ligne', minLength: 3 }, { confirmLabel: 'Retirer' });
    if (!reason) return;
    removePaymentRequirement.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(removePaymentRequirement, 'payment-remove', { reason });
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      removePaymentRequirement.disabled = false;
    }
  });

  const paymentCollect = $('paymentCollect');
  if (paymentCollect) paymentCollect.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(event.currentTarget, 'payment-collect', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/collect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const paymentReconcile = $('paymentReconcile');
  if (paymentReconcile) paymentReconcile.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
    button.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(event.currentTarget, 'payment-reconcile', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const reversePayment = $('reversePayment');
  if (reversePayment) reversePayment.addEventListener('click', async () => {
    const reason = await uiPrompt('Annuler la saisie d’encaissement', { label: 'Pourquoi cette saisie doit-elle être annulée ?', placeholder: 'Ex. : montant saisi par erreur', minLength: 3 }, { tone: 'danger', confirmLabel: 'Annuler la saisie', cancelLabel: 'Retour' });
    if (!reason) return;
    reversePayment.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(reversePayment, 'payment-reverse', { reason });
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/reverse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      reversePayment.disabled = false;
    }
  });

  const paymentAdjustment = $('paymentAdjustment');
  if (paymentAdjustment) paymentAdjustment.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button');
    if (!(await uiConfirm(`${paymentAdjustmentLabels[values.adjustmentType]} de ${formatMoney(values.amountMinor, 'XOF')}`, { message: 'Cette écriture sera ajoutée au rapprochement de la commande.', confirmLabel: 'Enregistrer' }))) return;
    button.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(form, 'payment-adjustment', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/adjustments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  root.querySelectorAll('.reverse-adjustment').forEach((button) => button.addEventListener('click', async () => {
    const reason = (await uiPrompt('Corriger une écriture', { label: 'Pourquoi cette écriture doit-elle être corrigée ?', placeholder: 'Ex. : remise appliquée deux fois', minLength: 10, minLengthMessage: 'Expliquez en 10 caractères minimum.' }, { message: 'Une écriture inverse est créée ; l’original reste visible.', confirmLabel: 'Créer l’écriture inverse' })) || '';
    if (reason.trim().length < 10) return;
    const effectiveDate = new Date(Date.now() - (new Date().getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
    button.disabled = true;
    try {
      const values = { adjustmentId: button.dataset.adjustmentId, reason: reason.trim(), effectiveDate };
      const idempotencyKey = idempotencyKeyFor(button, 'payment-adjustment-reverse', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/adjustments/${encodeURIComponent(button.dataset.adjustmentId)}/reverse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: values.reason, effectiveDate, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  }));

  const reassignForm = $('reassignForm');
  if (reassignForm) reassignForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const driverId = Number(new FormData(event.currentTarget).get('driverId'));
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      await api(`/api/app/orders/${encodeURIComponent(id)}/reassign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId }),
      });
      await reload();
    } catch (error) {
      $('reassignResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const transitionForm = $('transitionForm');
  if (transitionForm) transitionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (reasonRequiredStatuses.includes(values.toStatus) && String(values.reason || '').trim().length < 5) {
      $('transitionResult').innerHTML = '<div class="notice error">Expliquez la raison de cette étape.</div>';
      return;
    }
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(event.currentTarget, 'transition', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('transitionResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const generateOtp = $('generateOtp');
  if (generateOtp) generateOtp.addEventListener('click', async () => {
    generateOtp.disabled = true;
    try {
      const idempotencyKey = generateOtp.dataset.idempotencyKey || actionKey('otp');
      generateOtp.dataset.idempotencyKey = idempotencyKey;
      const result = await api(`/api/app/orders/${encodeURIComponent(id)}/otp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey }),
      });
      $('otpGenerated').innerHTML = `<div class="otp-code"><span>Code à transmettre au destinataire</span><strong>${escapeHtml(result.code)}</strong><small>Expire le ${escapeHtml(formatDate(result.expiresAt))} · ${escapeHtml(result.attemptsRemaining)} essais</small></div>`;
      generateOtp.textContent = 'Régénérer et invalider l’ancien code';
      delete generateOtp.dataset.idempotencyKey;
      generateOtp.disabled = false;
    } catch (error) {
      $('otpGenerated').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      generateOtp.disabled = false;
    }
  });

  const verifyOtp = $('verifyOtp');
  if (verifyOtp) verifyOtp.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const code = String(new FormData(event.currentTarget).get('code') || '').trim();
      const idempotencyKey = idempotencyKeyFor(event.currentTarget, 'otp-verify', { code });
      await api(`/api/app/orders/${encodeURIComponent(id)}/otp/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('otpResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  $('incidentForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const idempotencyKey = idempotencyKeyFor(event.currentTarget, 'incident', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/incidents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, idempotencyKey }),
      });
      await reload();
    } catch (error) {
      $('incidentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

}

const incidentSeverityLabels = { low: 'Faible', medium: 'Moyenne', high: 'Élevée' };
const incidentEventLabels = {
  opened: 'Incident déclaré', note_added: 'Note ajoutée', assigned: 'Responsable attribué',
  resolved: 'Incident résolu', retention_hold_placed: 'Gel de conservation activé',
  retention_hold_released: 'Gel de conservation levé',
};

async function renderIncidentDetail(id) {
  setHeader('Incident', 'Dossier imprimable et historique certifié');
  await mountIncidentDossier(page, id);
  if (new URLSearchParams(location.search).get('print') === '1') setTimeout(() => window.print(), 400);
}

// Dossier d'incident monté dans une page ou dans le tiroir d'Opérations.
// opts.drawer : sans en-tête de page (le tiroir a le sien) ; opts.refresh :
// appelé après une action à la place du simple re-montage.
async function mountIncidentDossier(root, id, opts = {}) {
  const $q = (sel) => root.querySelector(sel);
  const dossier = await api(`/api/app/incidents/${encodeURIComponent(id)}`);
  const incident = dossier.incident;
  const activeHold = dossier.holds.find((hold) => hold.status === 'active');
  const holdOverdue = activeHold && new Date(activeHold.review_due_at).getTime() < Date.now();
  const canControl = ['owner', 'manager'].includes(context.user.role);
  const reviewDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const chainNotice = dossier.eventChainValid === true
    ? '<div class="notice success">Historique certifié : aucune modification détectée.</div>'
    : dossier.eventChainValid === false
      ? '<div class="notice error">Cet historique a peut-être été modifié. Contactez le support avant de l’utiliser comme preuve.</div>'
      : '<div class="notice">Incident ancien : l’historique n’est pas certifié.</div>';
  root.innerHTML = `${opts.drawer ? '' : `<div class="page-header print-hidden"><div><a href="/app/operations?vue=incidents">← Retour aux incidents</a><h1 style="margin-top:12px">Incident n° ${escapeHtml(incident.id)}</h1><p class="subtitle">${escapeHtml(orderCode(incident.order_reference, incident.order_id))} · ouvert le ${escapeHtml(formatDate(incident.created_at))}</p></div><div class="actions"><button class="secondary" id="printIncident">Imprimer / enregistrer en PDF</button>${canControl ? `<a class="button secondary" href="/api/app/incidents/${escapeHtml(incident.id)}/export">Télécharger le PDF</a>` : ''}</div></div>`}
    <section class="card incident-report"><div class="page-header"><div><h2>${escapeHtml(incidentCategoryLabels[incident.category] || incident.category)}</h2><p class="subtitle">Gravité ${escapeHtml(incidentSeverityLabels[incident.severity] || incident.severity)}</p></div>${badge(incident.status === 'resolved' ? 'Résolu' : 'Ouvert')}</div>
      <div class="detail-grid"><div class="detail"><span>Client</span><strong>${escapeHtml(incident.customer_name || '—')}</strong><small>${escapeHtml(incident.customer_phone || '')}</small></div><div class="detail"><span>Livreur</span><strong>${escapeHtml(incident.driver_name)}</strong><small>${escapeHtml(incident.driver_vehicle_type || '')}</small></div><div class="detail"><span>Responsable</span><strong>${escapeHtml(incident.assigned_to || 'Non attribué')}</strong></div><div class="detail"><span>Commande</span><strong>${escapeHtml(orderCode(incident.order_reference, incident.order_id))} · ${escapeHtml(incident.order_status)}</strong></div><div class="detail" style="grid-column:span 2"><span>Destination</span><strong>${escapeHtml([incident.neighborhood, incident.landmark, incident.delivery_address].filter(Boolean).join(' — ') || '—')}</strong></div></div>
      <h3>Déclaration initiale</h3><p class="immutable-fact">${escapeHtml(incident.description)}</p><small>Déclarée par ${escapeHtml(incident.opened_by || 'Compte supprimé')} le ${escapeHtml(formatDate(incident.created_at))}. Ce texte ne peut plus être modifié.</small>
      ${incident.resolution ? `<h3>Résolution</h3><p>${escapeHtml(incident.resolution)}</p><small>Résolu par ${escapeHtml(incident.resolved_by || 'Compte supprimé')} le ${escapeHtml(formatDate(incident.resolved_at))}</small>` : ''}
    </section>
    <section class="card" style="margin-top:18px"><h2>Protection des données (litige)</h2>${activeHold ? `<div class="notice ${holdOverdue ? 'error' : 'warning'}"><strong>${holdOverdue ? 'Révision en retard.' : 'Données protégées.'}</strong> Les données de cette commande ne seront pas supprimées. ${holdOverdue ? 'À réexaminer depuis le' : 'À réexaminer le'} ${escapeHtml(formatDate(activeHold.review_due_at))}.<br><small>Motif : ${escapeHtml(activeHold.reason)}</small></div>${canControl ? '<form id="releaseHold" class="print-hidden"><div class="field"><label>Pourquoi retirer la protection ?</label><textarea name="reason" minlength="10" maxlength="2000" required placeholder="Ex. : litige réglé à l’amiable le 12/10"></textarea></div><button class="secondary" style="margin-top:12px">Retirer la protection</button></form>' : ''}` : `<p class="subtitle">En cas de réclamation ou de litige, protégez les données de cette commande pour qu’elles ne soient jamais supprimées.</p>${canControl ? `<form id="placeHold" class="print-hidden" style="margin-top:14px"><div class="form-grid"><div class="field full"><label>Pourquoi protéger ces données ?</label><textarea name="reason" minlength="10" maxlength="2000" required placeholder="Ex. : réclamation du client, litige sur le paiement, demande de la police…"></textarea></div><div class="field"><label>À réexaminer le</label><input name="reviewDueAt" type="date" value="${reviewDate}" required /></div></div><button class="danger" style="margin-top:12px">Protéger les données</button></form>` : ''}`}<div id="holdResult"></div>${dossier.holds.length ? `<details><summary>Historique des protections (${dossier.holds.length})</summary><ul>${dossier.holds.map((hold) => `<li>${escapeHtml(hold.status === 'active' ? 'Actif' : 'Levé')} · ${escapeHtml(formatDate(hold.placed_at))} · ${escapeHtml(hold.placed_by || 'Compte supprimé')} — ${escapeHtml(hold.reason)}${hold.release_reason ? ` · Levée : ${escapeHtml(hold.release_reason)}` : ''}</li>`).join('')}</ul></details>` : ''}</section>
    <section class="card print-hidden" style="margin-top:18px"><h2>Traiter l’incident</h2>${canControl ? `<form id="assignIncident"><div class="field"><label>Responsable</label><select name="userId" required><option value="">Sélectionner</option>${dossier.members.map((member) => `<option value="${escapeHtml(member.id)}" ${String(member.id) === String(incident.assigned_to_user_id) ? 'selected' : ''}>${escapeHtml(member.display_name)} — ${escapeHtml(roleLabels[member.role] || member.role)}</option>`).join('')}</select></div><button class="secondary" style="margin-top:12px">Attribuer</button></form>` : ''}<form id="incidentNote" style="margin-top:18px"><div class="field"><label>Ajouter une note</label><textarea name="note" minlength="3" maxlength="2000" required placeholder="Ex. : client rappelé à 14 h, il sera présent demain matin."></textarea></div><button class="secondary" style="margin-top:12px">Ajouter la note</button></form>${incident.status === 'open' ? '<form id="resolveIncidentForm" style="margin-top:18px"><div class="field"><label>Comment l’incident a-t-il été réglé ?</label><textarea name="resolution" minlength="5" maxlength="2000" required placeholder="Ex. : colis relivré le lendemain, client satisfait."></textarea></div><button class="primary" style="margin-top:12px">Marquer comme résolu</button></form>' : ''}<div id="incidentActionResult"></div></section>
    <section class="card" style="margin-top:18px"><h2>Historique de l’incident</h2>${chainNotice}${['owner', 'manager'].includes(context.user.role) ? `<p class="subtitle print-hidden" style="margin:0 0 10px"><a href="/api/app/incidents/${escapeHtml(incident.id)}/export?format=json">Télécharger les données certifiées (JSON)</a> — pour un expert ou un avocat : chaque événement y est signé par empreinte.</p>` : ''}<ol class="timeline">${dossier.events.length ? dossier.events.map((event) => `<li><strong>${escapeHtml(incidentEventLabels[event.event_type] || event.event_type)}</strong><small>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor_name)}</small>${event.body ? `<p>${escapeHtml(event.body)}</p>` : ''}${event.event_type === 'assigned' && event.details?.assignedToName ? `<p>Responsable : ${escapeHtml(event.details.assignedToName)}</p>` : ''}</li>`).join('') : '<li>Aucun événement d’intégrité disponible.</li>'}</ol></section>
    ${dossier.evidence.some((item) => !item.superseded_at && !item.deleted_at) ? `<section class="card" style="margin-top:18px"><h2>Preuves de livraison</h2><div class="evidence-grid">${dossier.evidence.filter((item) => !item.superseded_at && !item.deleted_at).map((item) => `<article class="evidence-card"><strong>${item.evidence_type === 'photo' ? 'Photo de remise' : 'Signature'}</strong><a href="/api/app/evidence/${escapeHtml(item.id)}" target="_blank" rel="noopener"><img src="/api/app/evidence/${escapeHtml(item.id)}" alt="Preuve ${escapeHtml(item.evidence_type)}" /></a><small title="Empreinte : ${escapeHtml(item.content_sha256)}">Fichier d’origine certifié</small></article>`).join('')}</div></section>` : ''}
    <section class="card" style="margin-top:18px"><h2>Historique de la commande</h2><ol class="timeline">${dossier.orderEvents.map((event) => `<li><strong>${escapeHtml(event.to_status)}</strong><small>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor_name)}</small>${event.reason ? `<p>${escapeHtml(event.reason)}</p>` : ''}</li>`).join('')}</ol></section>`;

  $q('#printIncident')?.addEventListener('click', () => window.print());
  const bindForm = (formId, url, prefix) => {
    const form = $q(`#${formId}`);
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const idempotencyKey = idempotencyKeyFor(form, prefix, values);
        await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, idempotencyKey }) });
        if (opts.refresh) await opts.refresh(); else await mountIncidentDossier(root, id, opts);
      } catch (error) {
        $q(formId.includes('Hold') ? '#holdResult' : '#incidentActionResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        button.disabled = false;
      }
    });
  };
  bindForm('assignIncident', `/api/app/incidents/${encodeURIComponent(id)}/assign`, 'incident-assign');
  bindForm('incidentNote', `/api/app/incidents/${encodeURIComponent(id)}/notes`, 'incident-note');
  bindForm('resolveIncidentForm', `/api/app/incidents/${encodeURIComponent(id)}/resolve`, 'incident-resolve');
  bindForm('placeHold', `/api/app/incidents/${encodeURIComponent(id)}/retention-hold`, 'retention-hold');
  bindForm('releaseHold', `/api/app/incidents/${encodeURIComponent(id)}/retention-hold/release`, 'retention-release');
}

async function renderOperationsMap() {
  if (window.TraxoFleetMap) {
    setHeader('Carte d’exploitation', 'Votre équipe sur le terrain.');
    return window.TraxoFleetMap.render(page, { api, context, openOrderDrawer, openRunDrawer, openRequestDrawer, uiToast });
  }
  setHeader('Carte d’exploitation', 'Vos livreurs et vos livraisons en direct');
  page.classList.add('page-map');
  const bikeSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>';
  const playIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  const calIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
  const pinIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
  const truckIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17h4V5H2v12h3"/><path d="M20 17h1a1 1 0 0 0 1-1v-3.34a1 1 0 0 0-.3-.71l-2.65-2.65a1 1 0 0 0-.71-.3H14v8h1"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>';
  // Regroupe les états opérationnels détaillés en 4 statuts affichés (maquette) :
  // En cours (vert), GPS ancien (ambre), Incident (rouge), Hors ligne (gris).
  const statusBucket = (state) => {
    if (state === 'incident') return 'incident';
    if (state === 'stale') return 'stale';
    if (['offline', 'off_duty', 'inactive'].includes(state)) return 'offline';
    return 'active';
  };
  const bucketMeta = {
    active: { label: 'En cours', dot: '#16a34a' },
    stale: { label: 'Signal ancien', dot: '#d97706' },
    incident: { label: 'Incident', dot: '#e11d2a' },
    offline: { label: 'Hors ligne', dot: '#94a3b8' },
  };
  const vehicleIsCar = (driver) => /v[ée]hic|voit|car|auto|camion|truck/i.test(String(driver.vehicleType || ''));
  let fleetFilter = 'all';
  page.innerHTML = `<div class="ops">
    <div id="operationsMap" aria-label="Carte des livreurs et destinations"></div>

    <aside class="ops-panel ops-float" id="opsPanel" aria-label="Panneau des opérations">
      <div class="ops-bar" data-drag="opsPanel">
        <span class="ops-grip" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg></span>
        <span class="ops-bar-title">Flotte</span>
        <button type="button" class="ops-mini" data-collapse="opsPanel" title="Replier / déplier"><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
      </div>
      <div id="opsPanelBody"><div class="ops-loading">Chargement des opérations…</div></div>
    </aside>

    <aside class="ops-panel ops-float ops-kpis-panel" id="opsKpisPanel" aria-label="Résumé des opérations" hidden>
      <div class="ops-bar" data-drag="opsKpisPanel">
        <span class="ops-grip" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg></span>
        <span class="ops-bar-title">Résumé</span>
        <button type="button" class="ops-mini" data-collapse="opsKpisPanel" title="Replier / déplier"><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
        <button type="button" class="ops-mini" data-close="opsKpisPanel" title="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </div>
      <div class="ops-kpis" id="opsKpis"></div>
    </aside>

    <div class="ops-cluster ops-cluster-top">
      <div class="ops-layers" role="group" aria-label="Fond de carte">
        <button type="button" class="ops-layer-btn active" data-layer="street">Plan</button>
        <button type="button" class="ops-layer-btn" data-layer="satellite">Satellite</button>
        <button type="button" class="ops-layer-btn" data-layer="hybrid">Hybride</button>
      </div>
      <button type="button" class="ops-icon-btn ops-kpi-toggle" id="kpiToggle" aria-expanded="false" title="Résumé des opérations"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg><span>Résumé</span></button>
    </div>

    <div class="ops-cluster ops-cluster-actions" role="group" aria-label="Contrôles de la carte">
      <button type="button" class="ops-icon-btn" id="fitMap" title="Tout afficher"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>
      <button type="button" class="ops-icon-btn" id="locateOperator" title="Ma position"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg></button>
      <button type="button" class="ops-icon-btn" id="refreshMap" title="Actualiser"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg></button>
    </div>

    <div class="ops-legend" id="opsLegend">
      <button type="button" class="ops-legend-x" id="legendClose" aria-label="Masquer la légende" title="Masquer la légende"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      <span class="ops-leg"><i class="dot" style="background:#16a34a"></i>En cours</span>
      <span class="ops-leg"><i class="dot" style="background:#d97706"></i>Signal ancien</span>
      <span class="ops-leg"><i class="dot" style="background:#e11d2a"></i>Incident</span>
      <span class="ops-leg"><i class="dot" style="background:#94a3b8"></i>Hors ligne</span>
    </div>
    <button type="button" class="ops-icon-btn ops-legend-toggle" id="legendToggle" title="Légende"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></button>

    <p class="ops-status" id="mapUpdate" role="status">Chargement des opérations…</p>
    <div class="ops-service" id="mapServiceNotice"></div>
  </div>`;

  if (typeof L === 'undefined') throw new Error('La carte n’a pas pu être chargée. Rechargez la page.');
  // Vue initiale (avant recadrage sur la flotte) : Abidjan si le navigateur
  // est à l'heure ivoirienne, Cotonou sinon.
  const defaultCenter = (() => {
    try { if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'Africa/Abidjan') return [5.35, -4.01]; } catch (_) { /* fuseau inconnu */ }
    return [6.37, 2.43];
  })();
  const map = L.map('operationsMap', { zoomControl: false, attributionControl: true }).setView(defaultCenter, 11);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

  const fleetLayer = L.featureGroup().addTo(map);
  const destinationLayer = L.featureGroup().addTo(map);
  const sequenceLayer = L.layerGroup().addTo(map);
  const liveRouteLayer = L.layerGroup().addTo(map);
  const operatorLayer = L.layerGroup().addTo(map);
  const replayLayer = L.layerGroup().addTo(map);
  let liveRoute = null; // { driverId, runId, distanceMeters, durationSeconds } ou { driverId, unavailable, reason }
  const replay = { active: false, driverId: null, positions: [], roadGeometry: null, index: 0, playing: false, timer: null, marker: null, dayStart: null, prevAuto: true, speed: 1 };

  let baseStreet = null;
  let baseSatellite = null;
  let baseLabels = null;
  let baseRoads = null;
  let layersConfigured = false;
  let activeLayer = 'street';
  let snapshot = null;
  let selectedDriverId = '';
  let isolate = false;
  let showDestinations = true;
  let autoRefresh = true;
  let refreshTimer = null;
  let refreshing = false;

  const panelBody = document.getElementById('opsPanel').querySelector('#opsPanelBody');
  const mapUpdate = document.getElementById('mapUpdate');

  const ordersForDriver = (driver) => {
    const seen = new Set();
    const result = [];
    for (const run of driver.runs || []) {
      for (const stop of run.stops || []) {
        if (seen.has(String(stop.id))) continue;
        seen.add(String(stop.id));
        result.push({ ...stop, run });
      }
    }
    for (const order of driver.unplannedOrders || []) {
      if (seen.has(String(order.id))) continue;
      seen.add(String(order.id));
      result.push({ ...order, run: null });
    }
    return result;
  };
  const selectedDriver = () => snapshot?.drivers.find((driver) => String(driver.id) === String(selectedDriverId));

  function configureLayers() {
    if (layersConfigured) return;
    const cfg = snapshot.mapConfig;
    baseStreet = (window.TraxoMapBase ? window.TraxoMapBase.baseLayer(cfg.base)
      : L.tileLayer(cfg.base.url, { maxZoom: cfg.base.maxZoom, attribution: cfg.base.attribution })).addTo(map);
    if (cfg.satellite) baseSatellite = L.tileLayer(cfg.satellite.url, { maxZoom: 20, maxNativeZoom: cfg.satellite.maxNativeZoom || 18, attribution: cfg.satellite.attribution });
    if (cfg.labels) baseLabels = L.tileLayer(cfg.labels.url, { maxZoom: cfg.labels.maxZoom, attribution: cfg.labels.attribution, pane: 'overlayPane' });
    if (cfg.roads) baseRoads = L.tileLayer(cfg.roads.url, { maxZoom: 20, maxNativeZoom: cfg.roads.maxNativeZoom || 18, attribution: cfg.roads.attribution, pane: 'overlayPane' });
    // Désactive les fonds indisponibles.
    document.querySelectorAll('.ops-layer-btn').forEach((btn) => {
      if (btn.dataset.layer === 'satellite' && !baseSatellite) btn.disabled = true;
      if (btn.dataset.layer === 'hybrid' && !baseSatellite) btn.disabled = true;
    });
    layersConfigured = true;
  }

  function setLayer(name) {
    if (name === 'satellite' && !baseSatellite) return;
    if (name === 'hybrid' && !baseSatellite) return;
    [baseStreet, baseSatellite, baseRoads, baseLabels].forEach((layer) => { if (layer && map.hasLayer(layer)) map.removeLayer(layer); });
    if (name === 'street') { baseStreet.addTo(map); }
    else if (name === 'satellite') { baseSatellite.addTo(map); }
    else if (name === 'hybrid') { baseSatellite.addTo(map); if (baseRoads) baseRoads.addTo(map); if (baseLabels) baseLabels.addTo(map); }
    activeLayer = name;
    document.querySelectorAll('.ops-layer-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.layer === name));
  }

  function renderKpis() {
    const s = snapshot.summary;
    const online = s.onlineDrivers != null
      ? s.onlineDrivers
      : snapshot.drivers.filter((driver) => statusBucket(driver.operationalState) === 'active').length;
    const tiles = [
      { label: 'Livreurs en ligne', value: online, dot: '#16a34a' },
      { label: 'Demandes en attente', value: s.pendingRequests || 0, dot: '#d97706' },
      { label: 'Commandes actives', value: s.activeOrders, dot: '#2563eb' },
      { label: 'Tournées ouvertes', value: s.openRuns, dot: '#94a3b8' },
      { label: 'Signal ancien', value: s.staleDrivers, dot: '#d97706' },
      { label: 'Incidents ouverts', value: s.openIncidents, dot: '#e11d2a' },
    ];
    document.getElementById('opsKpis').innerHTML = tiles.map((t) => `<div class="ops-kpi">
      <span class="ops-kpi-label"><i class="ops-kpi-dot" style="background:${t.dot}"></i>${escapeHtml(t.label)}</span>
      <strong>${escapeHtml(t.value)}</strong></div>`).join('');
  }

  const chevRight = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  const searchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

  function driverPlace(driver) {
    const firstStop = (driver.runs || []).flatMap((run) => run.stops || [])[0] || (driver.unplannedOrders || [])[0];
    if (firstStop) return firstStop.neighborhood || firstStop.landmark || firstStop.deliveryAddress || 'Destination à préciser';
    return driver.position ? 'Position GPS reçue' : 'Sans position';
  }

  function fleetListHtml() {
    const drivers = snapshot.drivers;
    const counts = { all: drivers.length, active: 0, stale: 0, incident: 0, offline: 0 };
    drivers.forEach((driver) => { counts[statusBucket(driver.operationalState)] += 1; });
    const filtered = fleetFilter === 'all' ? drivers : drivers.filter((driver) => statusBucket(driver.operationalState) === fleetFilter);
    const chip = (key, label, dot) => `<button type="button" class="ops-fchip ${fleetFilter === key ? 'active' : ''}" data-filter="${key}">${dot ? `<i class="ops-fchip-dot" style="background:${dot}"></i>` : ''}${label}</button>`;
    const cards = filtered.map((driver) => {
      const b = statusBucket(driver.operationalState);
      const meta = bucketMeta[b];
      const age = driver.lastUpdate ? formatAge(driver.lastUpdate) : 'pas encore de position';
      const icon = vehicleIsCar(driver) ? truckIcon : bikeSvg;
      const sel = String(selectedDriverId) === String(driver.id);
      return `<button type="button" class="ops-dcard ${sel ? 'sel' : ''}" data-action="select" data-id="${escapeHtml(driver.id)}">
        <span class="ops-dcard-av bucket-${b}">${icon}</span>
        <span class="ops-dcard-main">
          <span class="ops-dcard-top"><strong>${escapeHtml(driver.name)}</strong><span class="ops-badge2 bucket-${b}"><i style="background:${meta.dot}"></i>${meta.label}</span></span>
          <small class="ops-dcard-sub">${escapeHtml(driver.vehicleType || 'Véhicule')} · ${escapeHtml(loadText(driver.activeOrders, driver.capacity))}</small>
          <small class="ops-dcard-loc"><span class="ops-dcard-pin">${pinIcon}</span>${escapeHtml(driverPlace(driver))} · ${escapeHtml(age)}</small>
        </span>
        <span class="ops-dcard-chev">${chevRight}</span>
      </button>`;
    }).join('');
    return `<div class="ops-fleet-head"><strong>Flotte active</strong><span class="ops-count">${escapeHtml(drivers.length)} véhicule${drivers.length > 1 ? 's' : ''}</span></div>
      <div class="ops-search-wrap"><span class="ops-search-ic">${searchIcon}</span><input type="search" class="ops-search" id="driverSearch" placeholder="Rechercher un livreur, un véhicule…" autocomplete="off"/></div>
      <div class="ops-fchips">
        ${chip('all', 'Tous', null)}
        ${chip('active', 'En cours', '#16a34a')}
        ${chip('stale', 'Signal ancien', '#d97706')}
        ${chip('incident', 'Incident', '#e11d2a')}
        ${chip('offline', 'Hors ligne', '#94a3b8')}
      </div>
      <div class="ops-driver-list" id="driverList">${cards || '<div class="ops-empty">Aucun livreur pour ce filtre.</div>'}</div>
      <div class="ops-fleet-foot">
        <label class="ops-chk">${TraxoUI.switchHtml({ id: 'toggleDest', checked: showDestinations, small: true })} Destinations</label>
        <label class="ops-chk">${TraxoUI.switchHtml({ id: 'toggleAuto', checked: autoRefresh, small: true })} Actualisation auto</label>
      </div>`;
  }

  function detailHtml(driver) {
    const speedKmh = driver.position?.speedKnots != null && Number.isFinite(Number(driver.position.speedKnots))
      ? Number(driver.position.speedKnots) * 1.852 : null;
    const phone = String(driver.phone || '').replace(/[^+\d]/g, '');
    const runCards = (driver.runs || []).map((run) => `<section class="ops-run"><div class="ops-run-head"><div><strong>${escapeHtml(run.name)}</strong><small>${escapeHtml(formatDateOnly(run.serviceDate))} · ${escapeHtml(run.completedStops)} sur ${escapeHtml(run.totalStops)} arrêt${Number(run.totalStops) > 1 ? 's' : ''} livré${Number(run.completedStops) > 1 ? 's' : ''}</small></div>${badge(runStatusLabels[run.status] || run.status)}</div>
      ${run.stops.length ? `<ol class="ops-stops">${run.stops.map((stop) => `<li><span class="stop-number">${escapeHtml(stop.sequence)}</span><div class="ops-stop-main"><strong>${escapeHtml(stop.customerName || `Commande n° ${stop.id}`)}</strong><small>${escapeHtml(stop.neighborhood || stop.landmark || stop.deliveryAddress || 'Destination à compléter')} · ${escapeHtml(stop.status)}</small>${stop.openIncidents ? `<span class="ops-inc">${escapeHtml(stop.openIncidents)} incident(s)</span>` : ''}</div><button type="button" class="ops-link" data-action="open-order" data-id="${escapeHtml(stop.id)}">Voir</button></li>`).join('')}</ol>` : '<p class="ops-empty">Aucun arrêt restant.</p>'}
      <button type="button" class="button secondary" data-action="open-run" data-id="${escapeHtml(run.id)}">Ouvrir la tournée</button></section>`).join('');
    const unplanned = (driver.unplannedOrders || []).length ? `<section class="ops-run"><strong class="ops-run-title">Hors tournée</strong><ol class="ops-stops">${driver.unplannedOrders.map((order) => `<li><span class="stop-number">•</span><div class="ops-stop-main"><strong>${escapeHtml(order.customerName || `Commande n° ${order.id}`)}</strong><small>${escapeHtml(order.neighborhood || order.landmark || order.deliveryAddress || 'Destination à compléter')} · ${escapeHtml(order.status)}</small></div><button type="button" class="ops-link" data-action="open-order" data-id="${escapeHtml(order.id)}">Voir</button></li>`).join('')}</ol></section>` : '';
    const b = statusBucket(driver.operationalState);
    const meta = bucketMeta[b];
    const icon = vehicleIsCar(driver) ? truckIcon : bikeSvg;
    const accuracyVal = driver.position?.accuracy != null && Number.isFinite(Number(driver.position.accuracy)) ? Math.round(Number(driver.position.accuracy)) : null;
    const accuracyNote = accuracyVal == null ? '' : (accuracyVal <= 20 ? 'Bonne' : accuracyVal <= 60 ? 'Correcte' : 'Approximative');
    return `<div class="ops-detail-head">
        <button type="button" class="ops-back" data-action="back" title="Retour à la flotte"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
        <strong class="ops-detail-title">Détails du livreur</strong>
      </div>
      <div class="ops-detail-id">
        <span class="ops-dcard-av bucket-${b}">${icon}</span>
        <div class="ops-detail-idmain"><strong>${escapeHtml(driver.name)}</strong><small>${escapeHtml(driver.vehicleType || 'Véhicule')} · ${escapeHtml(loadText(driver.activeOrders, driver.capacity))}</small></div>
        <span class="ops-badge2 bucket-${b}"><i style="background:${meta.dot}"></i>${meta.label}</span>
      </div>
      <div class="ops-metrics">
        <div class="ops-metric"><span>Dernière position</span><strong>${escapeHtml(driverPlace(driver))}</strong><em>${driver.position ? escapeHtml(formatAge(driver.position.timestamp)) : 'Indisponible'}</em></div>
        <div class="ops-metric"><span>Précision GPS</span><strong>${accuracyVal == null ? '—' : `${accuracyVal} m`}</strong><em>${escapeHtml(accuracyNote)}</em></div>
        <div class="ops-metric"><span>Vitesse</span><strong>${speedKmh == null ? '—' : `${speedKmh.toFixed(0)} km/h`}</strong><em>&nbsp;</em></div>
        <div class="ops-metric"><span>Incidents</span><strong>${escapeHtml(driver.openIncidents)}</strong><em>${driver.openIncidents ? 'À traiter' : 'Aucun'}</em></div>
      </div>
      <div class="ops-detail-actions">
        <button type="button" class="button secondary" data-action="center" ${driver.position ? '' : 'disabled'}>Centrer</button>
        <button type="button" class="button ${isolate ? 'accent' : 'secondary'}" data-action="isolate">${isolate ? 'Voir toute la flotte' : 'Voir ce livreur seul'}</button>
        ${phone ? `<a class="button secondary" href="tel:${escapeHtml(phone)}">Appeler</a>` : ''}
        <button type="button" class="button ${replay.active && String(replay.driverId) === String(driver.id) ? 'accent' : 'primary'}" data-action="replay">Voir le trajet</button>
      </div>
      <div id="opsReplay" class="ops-replay-slot"></div>
      ${driver.position?.stale ? '<div class="ops-note warning">Position de plus de 10 minutes : ne pas présenter comme du direct.</div>' : !driver.position ? '<div class="ops-note warning">Pas encore de position GPS pour ce livreur : elle apparaîtra dès qu’il se connectera à son appli.</div>' : ''}
      <div id="opsLiveRoute" class="ops-liveroute-slot">${liveRouteInfoHtml()}</div>
      ${runCards || '<div class="ops-empty">Aucune tournée ouverte.</div>'}${unplanned}`;
  }

  function renderPanel() {
    const driver = selectedDriver();
    panelBody.innerHTML = driver ? detailHtml(driver) : fleetListHtml();
    if (!driver) {
      const search = document.getElementById('driverSearch');
      if (search) search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        document.querySelectorAll('#driverList .ops-dcard').forEach((card) => {
          const name = card.querySelector('strong')?.textContent.toLowerCase() || '';
          const sub = card.querySelector('.ops-dcard-sub')?.textContent.toLowerCase() || '';
          card.style.display = (name.includes(q) || sub.includes(q)) ? '' : 'none';
        });
      });
      panelBody.querySelectorAll('[data-filter]').forEach((btn) => btn.addEventListener('click', () => {
        fleetFilter = btn.dataset.filter;
        renderPanel();
      }));
      document.getElementById('toggleDest')?.addEventListener('change', (event) => { showDestinations = event.target.checked; redrawMap(); });
      document.getElementById('toggleAuto')?.addEventListener('change', (event) => { autoRefresh = event.target.checked; scheduleRefresh(); });
    } else if (replay.active && String(replay.driverId) === String(driver.id)) {
      renderReplayUI();
    }
  }

  function suspendAutoForReplay() {
    if (!replay.suspended) { replay.prevAuto = autoRefresh; replay.suspended = true; }
    autoRefresh = false;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  }

  function todayMidnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

  function replayWindow(key) {
    const now = Date.now();
    // « Jour » = une journée civile précise (00:00 → 23:59 locale), jamais une
    // fenêtre glissante de 24 h : sinon les trajets d'hier et d'aujourd'hui se
    // mélangent à l'affichage.
    if (key === 'day') {
      const start = replay.dayStart != null ? replay.dayStart : todayMidnight();
      const end = Math.min(start + 24 * 60 * 60000, now);
      return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
    }
    if (key === 'custom') {
      const from = replay.customFrom ? new Date(replay.customFrom).toISOString() : new Date(now - 3 * 60 * 60000).toISOString();
      const to = replay.customTo ? new Date(replay.customTo).toISOString() : new Date(now).toISOString();
      return { from, to };
    }
    const minutes = { 30: 30, 60: 60, 180: 180 }[key] || 60;
    return { from: new Date(now - minutes * 60000).toISOString(), to: new Date(now).toISOString() };
  }

  const winLabels = { 30: '30 min', 60: '1 h', 180: '3 h' };

  function periodDayMidnight(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

  function renderPeriodCalendar() {
    const base = replay.pickerMonth != null ? new Date(replay.pickerMonth) : new Date(replay.pickerDay != null ? replay.pickerDay : todayMidnight());
    const y = base.getFullYear();
    const m = base.getMonth();
    const monthName = new Date(y, m, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // lundi = 0
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = todayMidnight();
    const nextDisabled = new Date(y, m + 1, 1).getTime() > today;
    let cells = '';
    for (let i = 0; i < firstDow; i += 1) cells += '<span class="opscal-cell empty"></span>';
    for (let d = 1; d <= daysInMonth; d += 1) {
      const ts = new Date(y, m, d).setHours(0, 0, 0, 0);
      const sel = replay.pickerDay != null && ts === replay.pickerDay;
      cells += `<button type="button" class="opscal-cell ${sel ? 'sel' : ''}" data-cal-day="${ts}" ${ts > today ? 'disabled' : ''}>${d}</button>`;
    }
    return `<div class="opscal">
      <div class="opscal-head"><button type="button" class="opscal-nav" data-cal-nav="-1" aria-label="Mois précédent">‹</button><strong>${escapeHtml(monthName.charAt(0).toUpperCase() + monthName.slice(1))}</strong><button type="button" class="opscal-nav" data-cal-nav="1" aria-label="Mois suivant" ${nextDisabled ? 'disabled' : ''}>›</button></div>
      <div class="opscal-dow">${['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="opscal-grid">${cells}</div>
    </div>`;
  }

  function renderPeriodPicker() {
    const dayTs = replay.pickerDay != null ? replay.pickerDay : todayMidnight();
    const dayStr = new Date(dayTs).toLocaleDateString('fr-FR');
    return `<div class="ops-period" role="dialog" aria-label="Choisir une période">
      <div class="ops-period-head"><strong>Période</strong><button type="button" class="ops-period-x" data-period-close aria-label="Fermer">✕</button></div>
      <div class="ops-period-presets">
        <button type="button" class="ops-chip" data-preset="30">30 min</button>
        <button type="button" class="ops-chip" data-preset="60">1 h</button>
        <button type="button" class="ops-chip" data-preset="180">3 h</button>
        <button type="button" class="ops-chip" data-preset="today">Aujourd’hui</button>
        <button type="button" class="ops-chip" data-preset="yesterday">Hier</button>
      </div>
      <div class="ops-period-custom">
        <div class="ops-period-title">Journée sélectionnée</div>
        <div class="ops-period-range">
          <label>Jour<input type="text" value="${escapeHtml(dayStr)}" readonly></label>
          <label>De<input type="time" id="periodFrom" value="${escapeHtml(replay.pickerFromTime || '00:00')}"></label>
          <label>À<input type="time" id="periodTo" value="${escapeHtml(replay.pickerToTime || '23:59')}"></label>
        </div>
        ${renderPeriodCalendar()}
      </div>
      <div class="ops-period-foot"><button type="button" class="button primary" data-period-apply>Rejouer ce jour</button><button type="button" class="button secondary" data-period-reset>Réinitialiser</button></div>
    </div>`;
  }

  function applyPeriod() {
    const from = document.getElementById('periodFrom');
    const to = document.getElementById('periodTo');
    if (from) replay.pickerFromTime = from.value || '00:00';
    if (to) replay.pickerToTime = to.value || '23:59';
    const day = replay.pickerDay != null ? replay.pickerDay : todayMidnight();
    const ft = replay.pickerFromTime || '00:00';
    const tt = replay.pickerToTime || '23:59';
    const fullDay = ft === '00:00' && (tt === '23:59' || tt === '24:00');
    replay.pickerOpen = false;
    if (fullDay) { replay.dayStart = day; startReplay('day'); return; }
    const [fh, fm] = ft.split(':').map(Number);
    const [th, tm] = tt.split(':').map(Number);
    const fromTs = day + (fh * 60 + fm) * 60000;
    const toTs = day + (th * 60 + tm) * 60000;
    if (toTs <= fromTs) { replay.statusText = 'L’heure de fin doit suivre l’heure de début.'; replay.pickerOpen = true; renderReplayUI(); return; }
    replay.dayStart = day;
    replay.customFrom = new Date(fromTs).toISOString();
    replay.customTo = new Date(toTs).toISOString();
    startReplay('custom');
  }

  function renderReplayUI() {
    const slot = document.getElementById('opsReplay');
    if (!slot) return;
    const hasTrack = replay.positions.length > 0;
    const todayActive = String(replay.windowKey) === 'day' && replay.dayStart === todayMidnight();
    const yesterdayActive = String(replay.windowKey) === 'day' && replay.dayStart === todayMidnight() - 86400000;
    slot.innerHTML = `<div class="ops-replay">
      <div class="ops-replay-windows">
        ${['30', '60', '180'].map((k) => `<button type="button" class="ops-win ${String(replay.windowKey) === k ? 'active' : ''}" data-win="${k}">${winLabels[k]}</button>`).join('')}
        <button type="button" class="ops-win ${todayActive ? 'active' : ''}" data-win-today>Aujourd’hui</button>
        <button type="button" class="ops-win ${yesterdayActive ? 'active' : ''}" data-win-yesterday>Hier</button>
        <button type="button" class="ops-win ops-win-period ${replay.pickerOpen ? 'active' : ''}" data-period-toggle>${calIcon} Période</button>
        <button type="button" class="ops-win ops-win-close" data-replay-close title="Fermer le rejeu">Fermer</button>
      </div>
      ${replay.pickerOpen ? renderPeriodPicker() : ''}
      <div class="ops-replay-status">${escapeHtml(replay.statusText || 'Choisissez une période pour rejouer le trajet — « Hier » ou une date précise dans « Période ».')}</div>
      ${hasTrack ? `<div class="ops-replay-controls">
        <button type="button" class="ops-replay-play" id="opsReplayPlay">${replay.playing ? pauseIcon : playIcon}</button>
        <input type="range" id="opsReplayRange" min="0" max="${replay.positions.length - 1}" value="${replay.index}" aria-label="Position dans le trajet"/>
      </div>
      <div class="ops-replay-speedrow">
        <span class="ops-replay-speedlbl">Vitesse</span>
        <div class="ops-seg" role="group" aria-label="Vitesse de lecture">${[1, 2, 4, 8].map((s) => `<button type="button" class="ops-seg-btn ${Number(replay.speed || 1) === s ? 'active' : ''}" data-speed="${s}">${s}×</button>`).join('')}</div>
      </div>
      <div class="ops-replay-read" id="opsReplayRead"></div>` : ''}
    </div>`;

    slot.querySelectorAll('[data-win]').forEach((btn) => btn.addEventListener('click', () => startReplay(btn.dataset.win)));
    slot.querySelector('[data-win-today]')?.addEventListener('click', () => { replay.dayStart = todayMidnight(); startReplay('day'); });
    slot.querySelector('[data-win-yesterday]')?.addEventListener('click', () => { replay.dayStart = todayMidnight() - 86400000; startReplay('day'); });
    slot.querySelector('[data-replay-close]')?.addEventListener('click', closeReplay);
    slot.querySelector('[data-period-toggle]')?.addEventListener('click', () => {
      replay.pickerOpen = !replay.pickerOpen;
      if (replay.pickerOpen) {
        replay.pickerDay = replay.dayStart != null ? replay.dayStart : todayMidnight();
        replay.pickerMonth = periodDayMidnight(replay.pickerDay);
        if (replay.pickerFromTime == null) replay.pickerFromTime = '00:00';
        if (replay.pickerToTime == null) replay.pickerToTime = '23:59';
      }
      renderReplayUI();
    });
    slot.querySelector('[data-period-close]')?.addEventListener('click', () => { replay.pickerOpen = false; renderReplayUI(); });
    slot.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      replay.pickerOpen = false;
      if (p === 'today') { replay.dayStart = todayMidnight(); startReplay('day'); }
      else if (p === 'yesterday') { replay.dayStart = todayMidnight() - 86400000; startReplay('day'); }
      else startReplay(p);
    }));
    slot.querySelectorAll('[data-cal-day]').forEach((btn) => btn.addEventListener('click', () => {
      replay.pickerFromTime = (document.getElementById('periodFrom') || {}).value || replay.pickerFromTime;
      replay.pickerToTime = (document.getElementById('periodTo') || {}).value || replay.pickerToTime;
      replay.pickerDay = Number(btn.dataset.calDay);
      renderReplayUI();
    }));
    slot.querySelectorAll('[data-cal-nav]').forEach((btn) => btn.addEventListener('click', () => {
      const base = new Date(replay.pickerMonth != null ? replay.pickerMonth : todayMidnight());
      base.setDate(1);
      base.setMonth(base.getMonth() + Number(btn.dataset.calNav));
      replay.pickerMonth = base.getTime();
      renderReplayUI();
    }));
    slot.querySelector('[data-period-apply]')?.addEventListener('click', applyPeriod);
    slot.querySelector('[data-period-reset]')?.addEventListener('click', () => {
      replay.pickerDay = todayMidnight();
      replay.pickerMonth = todayMidnight();
      replay.pickerFromTime = '00:00';
      replay.pickerToTime = '23:59';
      renderReplayUI();
    });

    if (hasTrack) {
      slot.querySelector('#opsReplayPlay').addEventListener('click', togglePlay);
      slot.querySelector('#opsReplayRange').addEventListener('input', (event) => { stopPlay(); replay.index = Number(event.target.value); drawReplayFrame(); });
      slot.querySelectorAll('[data-speed]').forEach((btn) => btn.addEventListener('click', () => {
        replay.speed = Number(btn.dataset.speed) || 1;
        const playing = replay.playing;
        if (playing) stopPlay();
        slot.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', b === btn));
        if (playing) togglePlay();
      }));
      drawReplayFrame();
    }
  }

  async function startReplay(windowKey) {
    const driver = selectedDriver();
    if (!driver) return;
    stopPlay();
    replay.active = true; replay.driverId = driver.id; replay.windowKey = windowKey;
    replay.positions = []; replay.roadGeometry = null; replay.index = 0; replay.statusText = 'Chargement de l’historique…';
    suspendAutoForReplay();
    renderReplayUI();
    try {
      const { from, to } = replayWindow(windowKey);
      const data = await api(`/api/app/drivers/${encodeURIComponent(driver.id)}/track?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (data.status === 'not_configured') { replay.statusText = 'Le service GPS n’est pas configuré.'; replay.positions = []; }
      else if (data.status === 'no_device') { replay.statusText = 'Aucun appareil GPS n’est associé à ce livreur.'; replay.positions = []; }
      else {
        replay.positions = data.positions || [];
        replay.roadGeometry = Array.isArray(data.roadGeometry) && data.roadGeometry.length > 1 ? data.roadGeometry : null;
        const matchNote = replay.roadGeometry && data.match
          ? ` · tracé routier (${data.match.matchedPoints}/${data.match.totalPoints})`
          : '';
        replay.statusText = replay.positions.length
          ? `${replay.positions.length} point(s)${data.cleaned ? ` · ${data.cleaned} nettoyé(s)` : ''}${matchNote} · ${new Date(data.from).toLocaleTimeString('fr-FR')} → ${new Date(data.to).toLocaleTimeString('fr-FR')}${data.truncated ? ' (tronqué)' : ''}`
          : 'Aucune position enregistrée sur cette période.';
      }
      replay.index = Math.max(0, replay.positions.length - 1);
      drawReplayTrail();
      renderReplayUI();
    } catch (error) {
      replay.positions = []; replay.statusText = `Échec : ${error.message}`;
      replayLayer.clearLayers();
      renderReplayUI();
    }
  }

  function drawReplayTrail() {
    replayLayer.clearLayers();
    const pts = replay.positions.map((position) => [position.latitude, position.longitude]);
    const road = replay.roadGeometry;
    if (road) {
      // Tracé calé sur les routes (OSRM map-matching) : la ligne rouge suit la voirie réelle.
      L.polyline(road, { color: '#e11d2a', weight: 4, opacity: 0.9 }).addTo(replayLayer);
      // Points GPS bruts nettoyés, en gris pâle pour référence.
      if (pts.length > 1) L.polyline(pts, { color: '#111', weight: 2, opacity: 0.18, dashArray: '4 6' }).addTo(replayLayer);
    } else if (pts.length > 1) {
      L.polyline(pts, { color: '#111', weight: 3, opacity: 0.45 }).addTo(replayLayer);
    }
    if (pts.length) {
      L.circleMarker(pts[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#197044', fillOpacity: 1 }).addTo(replayLayer).bindTooltip('Départ');
      L.circleMarker(pts[pts.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#e11d2a', fillOpacity: 1 }).addTo(replayLayer).bindTooltip('Fin');
      replay.marker = L.circleMarker(pts[replay.index] || pts[0], { radius: 8, color: '#111', weight: 3, fillColor: '#facc15', fillOpacity: 1 }).addTo(replayLayer);
      map.fitBounds(road && road.length > 1 ? road.concat(pts) : pts, { padding: [60, 60], maxZoom: 16 });
    } else {
      replay.marker = null;
    }
  }

  function drawReplayFrame() {
    const position = replay.positions[replay.index];
    if (!position || !replay.marker) return;
    replay.marker.setLatLng([position.latitude, position.longitude]);
    const read = document.getElementById('opsReplayRead');
    if (read) {
      const kmh = position.speedKnots != null ? `${(position.speedKnots * 1.852).toFixed(0)} km/h` : '—';
      read.textContent = `${position.timestamp ? new Date(position.timestamp).toLocaleString('fr-FR') : '—'} · ${kmh}`;
    }
    const range = document.getElementById('opsReplayRange');
    if (range && Number(range.value) !== replay.index) range.value = replay.index;
  }

  function stopPlay() {
    replay.playing = false;
    if (replay.timer) { clearInterval(replay.timer); replay.timer = null; }
    const btn = document.getElementById('opsReplayPlay');
    if (btn) btn.innerHTML = playIcon;
  }
  function togglePlay() {
    if (replay.playing) { stopPlay(); return; }
    if (replay.index >= replay.positions.length - 1) replay.index = 0;
    replay.playing = true;
    const btn = document.getElementById('opsReplayPlay');
    if (btn) btn.innerHTML = pauseIcon;
    const interval = Math.max(40, Math.round(220 / (Number(replay.speed) || 1)));
    replay.timer = setInterval(() => {
      if (replay.index >= replay.positions.length - 1) { stopPlay(); return; }
      replay.index += 1; drawReplayFrame();
    }, interval);
  }
  function closeReplay() {
    stopPlay();
    replay.active = false; replay.driverId = null; replay.positions = []; replay.roadGeometry = null; replay.marker = null; replay.windowKey = null; replay.statusText = null; replay.dayStart = null;
    replayLayer.clearLayers();
    if (replay.suspended) { autoRefresh = replay.prevAuto; replay.suspended = false; }
    renderPanel();
    refreshLiveRoute();
    scheduleRefresh();
  }

  // Itinéraire live : trace calée sur route (OSRM) depuis la position actuelle
  // du livreur sélectionné jusqu'aux arrêts de sa tournée active. Best-effort :
  // sans position fraîche ou sans moteur, on n'affiche rien de faux.
  function clearLiveRoute() { liveRoute = null; liveRouteLayer.clearLayers(); }

  function liveRouteInfoHtml() {
    const driver = selectedDriver();
    if (!liveRoute || !driver || String(liveRoute.driverId) !== String(driver.id)) return '';
    if (liveRoute.unavailable) {
      const reasons = {
        driver_position_unavailable: 'Position du livreur trop ancienne pour tracer l’itinéraire.',
        route_not_found: 'Aucun itinéraire routier trouvé jusqu’à la destination.',
        provider_disabled: 'Itinéraire indisponible pour le moment.',
        not_enough_points: 'Pas assez de points pour tracer un itinéraire.',
      };
      return `<div class="ops-liveroute unavailable">${escapeHtml(reasons[liveRoute.reason] || (liveRoute.planned ? 'Itinéraire prévisionnel indisponible pour l’instant.' : 'Itinéraire en direct indisponible pour le moment.'))}</div>`;
    }
    const km = liveRoute.distanceMeters != null ? (liveRoute.distanceMeters / 1000).toFixed(1) : '—';
    const min = liveRoute.durationSeconds != null ? Math.round(liveRoute.durationSeconds / 60) : null;
    const title = liveRoute.planned
      ? `Itinéraire prévisionnel · ${escapeHtml(km)} km`
      : `Itinéraire en direct · ${escapeHtml(km)} km restants`;
    return `<div class="ops-liveroute ${liveRoute.planned ? 'planned' : ''}"><span class="ops-liveroute-dot"></span><div><strong>${title}</strong><small>${min != null ? `~${min} min de route` : 'durée indisponible'} · durée routière brute, hors arrêts et remise</small></div></div>`;
  }

  function updateLiveRouteInfo() {
    const el = document.getElementById('opsLiveRoute');
    if (el) el.innerHTML = liveRouteInfoHtml();
  }

  async function refreshLiveRoute() {
    const driver = selectedDriver();
    if (!driver || replay.active) { clearLiveRoute(); updateLiveRouteInfo(); return; }
    const runs = driver.runs || [];
    // Tournée du jour : active en priorité (itinéraire live rouge depuis la
    // position GPS), sinon planifiée/brouillon (itinéraire prévisionnel bleu
    // sur routes réelles à travers tous les arrêts).
    const openRun = runs.find((run) => run.status === 'active')
      || runs.find((run) => run.status === 'planned')
      || runs.find((run) => run.status === 'draft');
    if (!openRun) { clearLiveRoute(); updateLiveRouteInfo(); return; }
    const isActive = openRun.status === 'active';
    try {
      const data = await api(`/api/app/runs/${encodeURIComponent(openRun.id)}/route`);
      const current = selectedDriver();
      // Le livreur a pu être désélectionné ou un rejeu lancé pendant l'appel.
      if (!current || String(current.id) !== String(driver.id) || replay.active) return;
      const route = data.route;
      liveRouteLayer.clearLayers();
      if (route && route.status === 'ok' && route.geometry?.value?.coordinates?.length >= 2) {
        const coords = route.geometry.value.coordinates.map(([lng, lat]) => [lat, lng]);
        L.polyline(coords, { color: isActive ? '#e11d2a' : '#2563eb', weight: 5, opacity: 0.9 }).addTo(liveRouteLayer);
        liveRoute = { driverId: driver.id, runId: openRun.id, planned: !isActive, distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds };
      } else {
        liveRoute = { driverId: driver.id, runId: openRun.id, planned: !isActive, unavailable: true, reason: route?.failure?.code || 'unavailable' };
      }
      updateLiveRouteInfo();
    } catch (error) {
      liveRouteLayer.clearLayers();
      liveRoute = { driverId: driver.id, planned: !isActive, unavailable: true, reason: 'unavailable' };
      updateLiveRouteInfo();
    }
  }

  function markerHtml(driver, selected) {
    return `<span class="veh-marker state-${escapeHtml(driver.operationalState)} ${selected ? 'selected' : ''}">${bikeSvg}</span>`;
  }

  function redrawMap({ fit = false } = {}) {
    fleetLayer.clearLayers();
    destinationLayer.clearLayers();
    sequenceLayer.clearLayers();
    const driver = selectedDriver();
    const allBounds = [];
    const visibleDrivers = isolate && driver ? snapshot.drivers.filter((d) => String(d.id) === String(driver.id)) : snapshot.drivers;

    for (const item of visibleDrivers) {
      if (!item.position) continue;
      const point = [item.position.latitude, item.position.longitude];
      const selected = driver && String(driver.id) === String(item.id);
      const icon = L.divIcon({ className: 'operations-div-icon', html: markerHtml(item, selected), iconSize: [36, 36], iconAnchor: [18, 18] });
      const marker = L.marker(point, { icon, title: item.name }).addTo(fleetLayer)
        .bindTooltip(escapeHtml(item.name), { direction: 'top', offset: [0, -16] });
      marker.on('click', () => { selectedDriverId = String(item.id); redrawMap(); renderPanel(); });
      allBounds.push(point);
    }

    if (showDestinations) {
      const sources = isolate && driver ? [driver] : snapshot.drivers;
      for (const item of sources) {
        for (const order of ordersForDriver(item)) {
          if (!order.destination) continue;
          const isSel = driver && String(item.id) === String(driver.id);
          const label = isSel && order.sequence != null ? String(order.sequence) : '•';
          const point = [order.destination.latitude, order.destination.longitude];
          const icon = L.divIcon({ className: 'operations-div-icon', html: `<span class="destination-map-marker ${isSel ? 'selected' : ''}">${escapeHtml(label)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
          L.marker(point, { icon, title: order.customerName || `Commande ${order.id}` }).addTo(destinationLayer)
            .bindPopup(`<strong>${escapeHtml(order.customerName || `Commande n° ${order.id}`)}</strong><br>${escapeHtml(order.neighborhood || order.landmark || order.deliveryAddress || '')}<br><small>${escapeHtml(item.name)} · ${escapeHtml(order.status)}</small>`);
          allBounds.push(point);
        }
      }
      if (driver) {
        (driver.runs || []).forEach((run, runIndex) => {
          const runPoints = (run.stops || []).filter((stop) => stop.destination).map((stop) => [stop.destination.latitude, stop.destination.longitude]);
          if (runIndex === 0 && driver.position) runPoints.unshift([driver.position.latitude, driver.position.longitude]);
          // Ligne pointillée = ordre des arrêts à vol d'oiseau (repère). L'itinéraire
          // routier réel du livreur actif est tracé en rouge plein par refreshLiveRoute().
          if (runPoints.length > 1) L.polyline(runPoints, { color: '#8a94a6', weight: 2.5, dashArray: '6 9', opacity: 0.6 }).addTo(sequenceLayer);
        });
      }
    }
    if (fit && allBounds.length) map.fitBounds(allBounds, { padding: [60, 60], maxZoom: 15 });
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (!autoRefresh || !snapshot || document.hidden) return;
    refreshTimer = setTimeout(async () => { await loadSnapshot(false); scheduleRefresh(); }, Math.max(10, Number(snapshot.refreshAfterSeconds || 15)) * 1000);
  }

  async function loadSnapshot(fit = false) {
    if (refreshing) return;
    refreshing = true;
    document.getElementById('refreshMap').disabled = true;
    mapUpdate.textContent = 'Actualisation en cours…';
    try {
      snapshot = await api('/api/app/operations-map');
      configureLayers();
      renderKpis();
      if (!snapshot.drivers.some((driver) => String(driver.id) === String(selectedDriverId))) selectedDriverId = '';
      const notice = document.getElementById('mapServiceNotice');
      const parts = [];
      if (snapshot.locationService.status !== 'online') parts.push(`<div class="ops-note warning">${escapeHtml(snapshot.locationService.message)}</div>`);
      if (snapshot.summary.ordersTruncated) parts.push('<div class="ops-note warning">Plus de 500 commandes actives : certaines ne sont pas affichées ici.</div>');
      notice.innerHTML = parts.join('');
      renderPanel();
      redrawMap({ fit });
      refreshLiveRoute();
      mapUpdate.textContent = `Actualisé à ${new Date(snapshot.generatedAt).toLocaleTimeString('fr-FR')} · dans ${snapshot.refreshAfterSeconds}s`;
      scheduleRefresh();
    } catch (error) {
      mapUpdate.textContent = `Échec de l’actualisation : ${error.message}`;
      document.getElementById('mapServiceNotice').innerHTML = `<div class="ops-note error">${escapeHtml(error.message)}</div>`;
    } finally {
      refreshing = false;
      document.getElementById('refreshMap').disabled = false;
    }
  }

  // Interactions du panneau (délégation, car le contenu est reconstruit).
  document.getElementById('opsPanel').addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    if (action === 'select') { if (replay.active) closeReplay(); clearLiveRoute(); selectedDriverId = trigger.dataset.id; isolate = false; redrawMap(); renderPanel(); const d = selectedDriver(); if (d?.position) map.setView([d.position.latitude, d.position.longitude], Math.max(map.getZoom(), 14)); refreshLiveRoute(); }
    else if (action === 'back') { if (replay.active) closeReplay(); clearLiveRoute(); selectedDriverId = ''; isolate = false; redrawMap(); renderPanel(); }
    else if (action === 'center') { const d = selectedDriver(); if (d?.position) map.setView([d.position.latitude, d.position.longitude], 15); }
    else if (action === 'open-run' || action === 'open-order') {
      // Tiroirs ouverts sur place : on reste sur la carte.
      const onChange = () => document.getElementById('refreshMap')?.click();
      if (action === 'open-run') openRunDrawer(trigger.dataset.id, { onChange });
      else openOrderDrawer(trigger.dataset.id, { onChange });
    }
    else if (action === 'isolate') { isolate = !isolate; redrawMap({ fit: true }); renderPanel(); refreshLiveRoute(); }
    else if (action === 'replay') {
      if (replay.active && String(replay.driverId) === String(selectedDriverId)) { closeReplay(); }
      else { clearLiveRoute(); replay.active = true; replay.driverId = selectedDriverId; replay.windowKey = null; replay.positions = []; replay.statusText = null; suspendAutoForReplay(); renderPanel(); }
    }
  });

  document.querySelectorAll('.ops-layer-btn').forEach((btn) => btn.addEventListener('click', () => setLayer(btn.dataset.layer)));
  // Résumé : ouvert par défaut sur grand écran, fermé sur mobile ; mémorisé.
  const kpiPanel = document.getElementById('opsKpisPanel');
  const kpiButton = document.getElementById('kpiToggle');
  const setKpis = (open) => {
    kpiPanel.hidden = !open;
    kpiButton.setAttribute('aria-expanded', String(open));
    kpiButton.classList.toggle('active', open);
    try { localStorage.setItem('traxo.ops.kpis', open ? '1' : '0'); } catch { /* ignore */ }
  };
  (() => {
    let saved = null;
    try { saved = localStorage.getItem('traxo.ops.kpis'); } catch { /* ignore */ }
    const open = saved == null ? window.matchMedia('(min-width: 1100px)').matches : saved === '1';
    kpiPanel.hidden = !open; kpiButton.setAttribute('aria-expanded', String(open)); kpiButton.classList.toggle('active', open);
  })();
  kpiButton.addEventListener('click', () => setKpis(kpiPanel.hidden));

  // Panneaux flottants : repli + déplacement (souris/tactile), position mémorisée par appareil.
  const opsEl = page.querySelector('.ops');
  const readStore = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const writeStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ } };
  function setupFloat(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const bar = el.querySelector('.ops-bar');
    const storeKey = `traxo.ops.${id}`;
    const saved = readStore(storeKey);
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      el.style.left = `${saved.left}px`; el.style.top = `${saved.top}px`; el.style.right = 'auto';
    }
    if (saved?.collapsed) el.classList.add('collapsed');
    let dragging = false; let startX = 0; let startY = 0; let originLeft = 0; let originTop = 0;
    bar.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      const parent = opsEl.getBoundingClientRect();
      originLeft = rect.left - parent.left; originTop = rect.top - parent.top;
      startX = event.clientX; startY = event.clientY;
      el.style.left = `${originLeft}px`; el.style.top = `${originTop}px`; el.style.right = 'auto';
      el.classList.add('dragging');
      bar.setPointerCapture(event.pointerId);
    });
    bar.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, opsEl.clientWidth - el.offsetWidth);
      const maxTop = Math.max(0, opsEl.clientHeight - el.offsetHeight);
      const left = Math.min(maxLeft, Math.max(0, originLeft + (event.clientX - startX)));
      const top = Math.min(maxTop, Math.max(0, originTop + (event.clientY - startY)));
      el.style.left = `${left}px`; el.style.top = `${top}px`;
    });
    const endDrag = (event) => {
      if (!dragging) return;
      dragging = false; el.classList.remove('dragging');
      try { bar.releasePointerCapture(event.pointerId); } catch { /* déjà relâché */ }
      writeStore(storeKey, { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0, collapsed: el.classList.contains('collapsed') });
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
    el.querySelector('[data-collapse]')?.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      writeStore(storeKey, { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0, collapsed: el.classList.contains('collapsed') });
    });
    el.querySelector('[data-close]')?.addEventListener('click', () => {
      if (id === 'opsKpisPanel') { setKpis(false); return; }
      el.hidden = true;
    });
  }
  setupFloat('opsPanel');
  setupFloat('opsKpisPanel');

  // Légende : visible par défaut, masquable ; le choix est mémorisé.
  const legendEl = document.getElementById('opsLegend');
  const setLegend = (open) => { legendEl.hidden = !open; try { localStorage.setItem('traxo.ops.legend', open ? '1' : '0'); } catch { /* ignore */ } };
  try { if (localStorage.getItem('traxo.ops.legend') === '0') legendEl.hidden = true; } catch { /* ignore */ }
  document.getElementById('legendToggle').addEventListener('click', () => setLegend(true));
  document.getElementById('legendClose').addEventListener('click', () => setLegend(false));
  document.getElementById('fitMap').addEventListener('click', () => redrawMap({ fit: true }));
  document.getElementById('refreshMap').addEventListener('click', () => loadSnapshot(false));
  document.getElementById('locateOperator').addEventListener('click', () => { mapUpdate.textContent = 'Recherche de votre position…'; map.locate({ setView: false, enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }); });
  map.on('locationfound', (event) => {
    operatorLayer.clearLayers();
    L.circleMarker(event.latlng, { radius: 8, color: '#111', weight: 2, fillColor: '#e11d2a', fillOpacity: 0.9 }).addTo(operatorLayer).bindTooltip('Votre position');
    L.circle(event.latlng, { radius: event.accuracy, color: '#e11d2a', weight: 1, fillOpacity: 0.06 }).addTo(operatorLayer);
    map.setView(event.latlng, Math.max(map.getZoom(), 15));
    mapUpdate.textContent = `Votre position (précision ≈ ${Math.round(event.accuracy)} m).`;
  });
  map.on('locationerror', (event) => { mapUpdate.textContent = event.code === 1 ? 'Autorisez la localisation dans le navigateur.' : 'Position non obtenue.'; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = null; }
    else if (autoRefresh) loadSnapshot(false);
  });

  await loadSnapshot(true);
  setTimeout(() => map.invalidateSize(), 0);
}

const driverVehicleOptions = ['Moto', 'Tricycle', 'Voiture', 'Vélo', 'Camionnette'];
const fleetIcons = {
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="m2 2 20 20"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18v14H3z"/><path d="M3 10h18"/><path d="M3 15h18"/><path d="M9 5v14"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  userx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5"/><path d="m22 8-5 5"/></svg>',
};

// Pastille de l'en-tête : logo de l'entreprise, sinon initiales de l'utilisateur.
function paintCompanyAvatar() {
  const el = document.getElementById('userAvatar');
  if (!el || !context) return;
  const logo = context.company && context.company.logoUrl;
  el.classList.toggle('has-logo', !!logo);
  if (logo) el.innerHTML = `<img src="${escapeHtml(logo)}" alt="">`;
  else el.textContent = String(context.user.name || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase() || '?';
}

// Logo : redimensionné dans le navigateur (512 px max, WebP ou PNG) pour
// rester léger à l'envoi comme à l'affichage.
function readLogoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) { reject(new Error('Choisissez une image PNG, JPEG ou WebP.')); return; }
    if (file.size > 8 * 1024 * 1024) { reject(new Error('Image trop lourde (8 Mo maximum).')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 512 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      let dataUrl = canvas.toDataURL('image/webp', 0.9);
      if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/png');
      resolve(dataUrl);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
    img.src = url;
  });
}

// ---- Recherche globale (Ctrl/⌘ K) ------------------------------------
// Module public/search.js : données cherchées côté serveur (/api/app/search,
// numéros partiels, codes, contacts et lieux des clients), pages et actions
// filtrées ici selon le rôle. Flèches, Entrée, Échap ; la fiche exacte s'ouvre.
function palettePages() {
  const manager = ['owner', 'manager'].includes(context?.user?.role);
  const p = (title, href, path, keywords = '') => ({ title, href, path, keywords });
  return [
    p('Carte d’exploitation', '/app/carte', ['Au quotidien'], 'map livreurs position'),
    p('Tableau de bord', '/app', ['Au quotidien'], 'dashboard statistiques'),
    p('Commandes', '/app/operations?vue=commandes', ['Opérations'], 'livraisons'),
    p('Demandes', '/app/operations?vue=demandes', ['Opérations'], 'liens clients'),
    p('Tournées', '/app/operations?vue=tournees', ['Opérations'], 'itinéraires'),
    p('Incidents', '/app/operations?vue=incidents', ['Opérations'], 'problèmes'),
    p('Livreurs', '/app/livreurs', ['Au quotidien']),
    p('Clients', '/app/clients', ['Au quotidien'], 'carnet contacts'),
    p('Rapports et exports', '/app/rapports', ['Pilotage'], 'csv excel export bilan'),
    ...(manager ? [p('Équipe et accès', '/app/equipe', ['Espace de travail'], 'membres rôles invitations')] : []),
    p('Paramètres', '/app/parametres', ['Espace de travail'], 'réglages entreprise'),
    p('Sécurité du compte', '/app/parametres?section=security', ['Paramètres'], 'double authentification mot de passe'),
    p('Facturation', '/app/parametres?section=billing', ['Paramètres'], 'facturation portefeuille recharge solde paiement abonnement'),
    p('Notifications', '/app/notifications', ['Compte']),
  ];
}
function paletteActions() {
  const canWrite = context?.user?.role !== 'viewer';
  const a = (title, extra) => ({ title, path: ['Action'], ...extra });
  return canWrite ? [
    a('Nouvelle commande', { href: '/app/nouvelle-commande', keywords: 'créer livraison' }),
    a('Nouvelle demande (lien client)', { href: '/app/operations?vue=creer', keywords: 'lien position' }),
    a('Déclarer un incident', { run: () => pickOrderForIncident(), keywords: 'problème' }),
    ...(window.TraxoSupport ? [a('Contacter le support', { run: () => window.TraxoSupport.open(), keywords: 'aide demande assistance' })] : []),
  ] : [];
}
function openCommandPalette(initialQuery = '') {
  if (!window.TraxoSearch) { uiToast?.('La recherche n’a pas pu se charger. Rechargez la page.'); return; }
  window.TraxoSearch.open({ api, pages: palettePages(), actions: paletteActions(), initialQuery });
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    if (!document.getElementById('page')) return;
    event.preventDefault();
    openCommandPalette();
  }
});

// ---- Dialogues et notifications maison --------------------------------
// Remplacent alert/confirm/prompt du navigateur : même style que l'appli,
// accessibles au clavier (Échap annule, Entrée valide) et sur mobile.
const uiIcons = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
};

function uiToast(message, type = 'info', { timeout = 4200 } = {}) {
  let stack = document.getElementById('uiToasts');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'uiToasts';
    stack.className = 'ui-toasts';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = `ui-toast ${type}`;
  toast.innerHTML = `<span class="ui-toast-ic">${uiIcons[type] || uiIcons.info}</span><span class="ui-toast-msg">${escapeHtml(message)}</span><button type="button" class="ui-toast-x" aria-label="Fermer">×</button>`;
  const dismiss = () => { toast.classList.add('out'); setTimeout(() => toast.remove(), 220); };
  toast.querySelector('.ui-toast-x').addEventListener('click', dismiss);
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('in'));
  if (timeout) setTimeout(dismiss, type === 'error' ? timeout + 2500 : timeout);
  return dismiss;
}

// Fenêtre de dialogue générique : résout avec la valeur choisie (ou null).
function uiDialog({ title, message = '', tone = 'default', confirmLabel = 'Confirmer', cancelLabel = 'Annuler', field = null }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'ui-dialog-backdrop';
    const fieldHtml = field ? `<label class="ui-dialog-label" for="uiDialogField">${escapeHtml(field.label || '')}</label>
      <textarea id="uiDialogField" rows="3" maxlength="${Number(field.maxLength) || 1000}" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(field.value || '')}</textarea>
      <p class="ui-dialog-err" id="uiDialogErr" hidden></p>` : '';
    backdrop.innerHTML = `<div class="ui-dialog ${tone}" role="alertdialog" aria-modal="true" aria-labelledby="uiDialogTitle">
      <div class="ui-dialog-ic">${uiIcons[tone === 'danger' ? 'warning' : 'info']}</div>
      <h2 id="uiDialogTitle">${escapeHtml(title)}</h2>
      ${message ? `<p class="ui-dialog-msg">${escapeHtml(message)}</p>` : ''}
      ${fieldHtml}
      <div class="ui-dialog-actions"><button type="button" class="button secondary" data-ui="cancel">${escapeHtml(cancelLabel)}</button><button type="button" class="button ${tone === 'danger' ? 'danger-solid' : 'primary'}" data-ui="ok">${escapeHtml(confirmLabel)}</button></div>
    </div>`;
    const input = () => backdrop.querySelector('#uiDialogField');
    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.remove('in');
      setTimeout(() => backdrop.remove(), 160);
      if (previous && previous.focus) previous.focus({ preventScroll: true });
      resolve(value);
    };
    const accept = () => {
      if (!field) return finish(true);
      const value = input().value.trim();
      const min = Number(field.minLength) || 0;
      if (value.length < min) {
        const err = backdrop.querySelector('#uiDialogErr');
        err.hidden = false;
        err.textContent = field.minLengthMessage || `Au moins ${min} caractères.`;
        input().focus();
        return undefined;
      }
      return finish(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); finish(field ? null : false); }
      if (event.key === 'Enter' && (!field || event.ctrlKey || event.metaKey)) { event.preventDefault(); accept(); }
    };
    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) finish(field ? null : false); });
    backdrop.querySelector('[data-ui="cancel"]').addEventListener('click', () => finish(field ? null : false));
    backdrop.querySelector('[data-ui="ok"]').addEventListener('click', accept);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('in'));
    (field ? input() : backdrop.querySelector('[data-ui="ok"]')).focus();
  });
}
const uiConfirm = (title, options = {}) => uiDialog({ title, ...options });
const uiPrompt = (title, field, options = {}) => uiDialog({ title, field, confirmLabel: 'Valider', ...options });

function openModal(title, bodyHtml, footHtml = '', { className = '' } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal ${escapeHtml(className)}" role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="modal-close" type="button" aria-label="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div>
    <div class="modal-body">${bodyHtml}</div>
    ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}
  </div>`;
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  function close() { backdrop.remove(); document.removeEventListener('keydown', onKey); }
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  return { backdrop, close };
}

// Livreurs : rendu dans public/drivers.js (kit « Livreurs Premium »).
async function renderDrivers() {
  setHeader('Livreurs', 'Une équipe prête à prendre la route');
  await window.TraxoDrivers.render(page, { api, setHeader, uiToast, uiConfirm, publicLink, context, vehicleTypes: driverVehicleOptions });
}

// Équipe et accès : rendu dans public/team.js (kit « Équipe »).
async function renderTeam() {
  setHeader('Équipe et accès', 'Les personnes qui travaillent avec vous.');
  await window.TraxoTeam.render(page, { api, context });
}

const setIcons = {
  whatsapp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.4L3 21z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .8c-1-.5-1.6-1.1-2.1-2.1l.8-1-1-2L9 9.5z"/></svg>',
};

const traxoRoleLabels = { owner: 'Propriétaire', manager: 'Administrateur', operator: 'Opérateur', viewer: 'Lecture seule', driver: 'Livreur' };

// Pictogrammes Lucide (licence ISC) du kit Paramètres.
const txPaths = {
  'bike': '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  'crown': '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  'credit-card': '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
  'building-2': '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  'package-check': '<path d="m16 16 2 2 4-4"/><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m7.5 4.27 9 5.15"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" x2="12" y1="22" y2="12"/>',
  'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'upload': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  'check': '<path d="M20 6 9 17l-5-5"/>',
  'circle-dot': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'mail': '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  'user-round': '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  'lock-keyhole': '<circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
  'monitor': '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  'smartphone': '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'bell': '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  'package': '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
};
const txIcon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${txPaths[name] || ''}</svg>`;

const settingsTabs = [
  { key: 'overview', label: 'Vue d’ensemble' },
  { key: 'general', label: 'Général', editors: true },
  { key: 'deliveries', label: 'Livraisons' },
  { key: 'team', label: 'Équipe & permissions', editors: true },
  { key: 'security', label: 'Sécurité' },
  { key: 'billing', label: 'Facturation' },
];
const txMoney = (n) => Number(n || 0).toLocaleString('fr-FR');
const txPlural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const txInitials = (text) => String(text || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

async function renderSettings() {
  setHeader('Paramètres', 'Votre entreprise, à votre façon.');
  const canEdit = ['owner', 'manager'].includes(context.user.role);
  const tabs = [
    ...settingsTabs.filter((t) => canEdit || !t.editors),
    ...(context.user.isPlatformAdmin ? [{ key: 'support', label: 'Support TRAXO' }, { key: 'whatsapp', label: 'WhatsApp TRAXO' }, { key: 'vigilance', label: 'Vigilance TRAXO' }, { key: 'billingadmin', label: 'Tarifs TRAXO' }] : []),
  ];
  const params = new URLSearchParams(location.search);
  let section = (params.get('section') || 'overview').toLowerCase();
  // Ancien comparateur de formules : remplacé par le portefeuille.
  if (section === 'plans') section = 'billing';
  if (!tabs.some((t) => t.key === section)) section = 'overview';
  // Formulaire en cours : renvoie true s'il reste des modifications non enregistrées.
  let isDirty = () => false;

  page.innerHTML = `<div id="traxo-settings">
      <nav class="tx-settings-tabs" aria-label="Rubriques des paramètres">${tabs.map((t) => `<button type="button" data-route="${t.key}">${escapeHtml(t.label)}</button>`).join('')}</nav>
      <div id="txContent"></div>
    </div>`;
  const root = document.getElementById('traxo-settings');
  const content = document.getElementById('txContent');

  if (window.__txBeforeUnload) window.removeEventListener('beforeunload', window.__txBeforeUnload);
  window.__txBeforeUnload = (event) => { if (document.body.contains(root) && isDirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', window.__txBeforeUnload);

  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-route]');
    if (target && root.contains(target)) go(target.dataset.route);
  });

  async function go(route) {
    if (route === section) return;
    if (isDirty() && !(await uiConfirm('Quitter sans enregistrer ?', { message: 'Vos modifications de cette rubrique seront perdues.', confirmLabel: 'Quitter sans enregistrer', cancelLabel: 'Rester ici' }))) return;
    section = route;
    try { history.replaceState(null, '', `/app/parametres?section=${route}`); } catch { /* ignore */ }
    activateNavigation(); // Facturation a sa propre entrée de menu
    load();
    root.scrollIntoView({ block: 'start' });
  }

  async function load() {
    isDirty = () => false;
    root.dataset.screen = section;
    const active = section;
    root.querySelectorAll('.tx-settings-tabs button').forEach((b) => {
      const yes = b.dataset.route === active;
      b.classList.toggle('tx-selected', yes);
      if (yes) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    content.innerHTML = '<div class="loading-state" style="padding:40px">Chargement…</div>';
    const views = { overview, general, deliveries, team, security, billing, whatsapp: renderWhatsApp, vigilance: renderVigilance, support: renderSupportDesk, billingadmin: renderBillingAdmin };
    try {
      await views[section](content);
      if (context.company.activationStatus === 'preview' && ['general', 'deliveries', 'team', 'billing'].includes(section)) {
        content.insertAdjacentHTML('afterbegin', `<div class="tx-preview-note" role="note">${txIcon('eye')}<span><strong>Votre espace est en mode aperçu.</strong> Vous pouvez tout consulter ; les réglages de l’entreprise pourront être enregistrés une fois l’espace activé. La sécurité de votre compte reste modifiable dès maintenant.</span></div>`);
      }
    } catch (error) {
      content.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
  }

  // ---- Briques communes -------------------------------------------------
  const txButton = (html, attrs = '', kind = '') => `<button type="button" class="tx-button ${kind}" ${attrs}>${html}</button>`;
  const heading = (title, desc, action = '', eyebrow = '') => `<div class="tx-heading"><div>${eyebrow ? `<span class="tx-eyebrow">${escapeHtml(eyebrow)}</span>` : ''}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(desc)}</p></div>${action}</div>`;
  const infoStrip = (text) => `<p class="tx-info-strip">${txIcon('circle-help')}<span>${text}</span></p>`;
  const toggleRow = (id, title, desc, on, disabled = false) => `<div class="tx-setting-row"><div><label for="tx-${id}">${escapeHtml(title)}</label><p>${escapeHtml(desc)}</p></div>${TraxoUI.switchHtml({ id: `tx-${id}`, name: id, checked: on, disabled })}</div>`;
  const savebar = (label) => `<div class="tx-savebar"><span class="tx-save-status" aria-live="polite">${txIcon('check')} Aucune modification en attente</span><div class="tx-inline-actions"><button type="button" class="tx-button tx-button-quiet" data-reset disabled>Annuler</button><button type="submit" class="tx-button tx-button-primary" data-save disabled>${escapeHtml(label)}</button></div></div>`;
  const logoBox = (url, alt = 'Logo de l’entreprise') => (url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">` : `<span class="tx-org-initials">${escapeHtml(txInitials(context.company.name))}</span>`);

  // Barre d'enregistrement : suit l'écart avec l'état enregistré, annule, enregistre.
  function mountSavebar(form, { snapshot, save, reset, savedMessage }) {
    let initial = snapshot();
    const bar = form.querySelector('.tx-savebar');
    const status = bar.querySelector('.tx-save-status');
    const saveBtn = bar.querySelector('[data-save]');
    const resetBtn = bar.querySelector('[data-reset]');
    const label = saveBtn.textContent;
    let busy = false;
    const dirty = () => snapshot() !== initial;
    const refresh = () => {
      const d = dirty();
      bar.classList.toggle('tx-dirty', d);
      status.innerHTML = `${txIcon(d ? 'circle-dot' : 'check')} ${d ? 'Modifications non enregistrées' : 'Aucune modification en attente'}`;
      saveBtn.disabled = !d || busy;
      resetBtn.disabled = !d || busy;
    };
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    resetBtn.addEventListener('click', () => { reset(); refresh(); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!dirty() || !form.reportValidity()) return;
      busy = true; saveBtn.textContent = 'Enregistrement…'; refresh();
      try {
        await save();
        initial = snapshot();
        uiToast(savedMessage, 'success');
      } catch (error) {
        uiToast(error.message, 'error');
      } finally {
        busy = false; saveBtn.textContent = label; refresh();
      }
    });
    isDirty = () => document.body.contains(form) && dirty();
    refresh();
    return { refresh };
  }

  // ---- Vue d'ensemble ---------------------------------------------------
  async function overview(box) {
    const [wallet, sec, fleet] = await Promise.all([
      api('/api/app/billing/wallet').catch(() => null),
      api('/api/app/account/security').catch(() => null),
      api('/api/app/drivers').catch(() => []),
    ]);
    const drivers = (Array.isArray(fleet) ? fleet : []).filter((d) => d.active).length;
    const roleLabel = traxoRoleLabels[context.user.role] || context.user.role;
    const quick = [
      canEdit && ['general', 'building-2', 'Votre entreprise', 'Logo, coordonnées et préférences de votre espace.'],
      ['deliveries', 'package-check', 'Vos livraisons', 'Choisissez comment créer et valider les commandes.'],
      canEdit && ['team', 'users', 'Votre équipe', 'Invitez vos collaborateurs et donnez les bons accès.'],
      ['security', 'shield-check', 'Votre sécurité', 'Gérez les connexions et protégez votre compte.'],
      !canEdit && ['billing', 'credit-card', 'Votre facturation', 'Le solde de votre espace et le prix par commande.'],
    ].filter(Boolean);
    const ws = wallet ? walletSummaryHtml(wallet) : null;
    const walletCard = wallet
      ? `<div class="tx-subscription"><span class="tx-eyebrow">Paiement à la commande</span><h2>${wallet.balance < 0 ? '−' : ''}${txMoney(Math.abs(wallet.balance))} F</h2><p>${escapeHtml(ws.line || 'Solde de votre portefeuille.')}</p><div class="tx-subscription-price"><strong>${txMoney(wallet.month.nextUnitPrice)} F</strong><span>par commande · ${txPlural(wallet.month.orders, 'commande', 'commandes')} ce mois-ci</span></div>${txButton(`Gérer mon portefeuille ${txIcon('arrow-right')}`, 'data-route="billing"')}</div>`
      : '';
    const waCallout = sec && sec.loginCodes && sec.whatsappChannel && !sec.twoFactorEnabled && !sec.phoneInternational && sec.codeChannel !== 'email'
      ? `<div class="tx-security-callout tx-callout-wa">${txIcon('smartphone')}<div><h3>Vos codes sur WhatsApp</h3><p>Ajoutez votre numéro : vos codes de connexion arrivent plus vite que par e-mail.</p><button type="button" class="tx-text-button" data-route="security">Ajouter mon numéro WhatsApp</button></div></div>`
      : '';
    const callout = sec && !sec.twoFactorEnabled
      ? `<div class="tx-security-callout">${txIcon('shield-check')}<div><h3>Un compte mieux protégé</h3><p>Ajoutez une seconde vérification à la connexion.</p><button type="button" class="tx-text-button" data-route="security">Configurer la double authentification</button></div></div>`
      : sec ? `<div class="tx-security-callout tx-callout-ok">${txIcon('shield-check')}<div><h3>Double authentification activée</h3><p>Un code de votre application est demandé à chaque connexion.</p><button type="button" class="tx-text-button" data-route="security">Voir la sécurité du compte</button></div></div>` : '';
    box.innerHTML = `${heading('Votre espace, vos règles.', 'Tout ce qu’il faut pour adapter TRAXO à votre quotidien.', '', 'Les paramètres de votre entreprise')}
      <section class="tx-panel">
        <div class="tx-org"><div class="tx-org-logo">${logoBox(context.company.logoUrl)}</div><div><h2>${escapeHtml(context.company.name)}</h2><div class="tx-org-meta"><span>${escapeHtml(context.company.slug || '')}</span><span aria-hidden="true">·</span><span class="tx-badge">Espace de travail</span></div></div>${canEdit ? txButton('Modifier le profil', 'data-route="general"') : ''}</div>
        <div class="tx-stats">
          <div class="tx-stat">${txIcon('bike')}<div><strong>${drivers}</strong><small>${drivers > 1 ? 'Livreurs actifs' : 'Livreur actif'}</small></div></div>
          <div class="tx-stat">${txIcon('crown')}<div><strong>${escapeHtml(roleLabel)}</strong><small>Votre rôle</small></div></div>
          <div class="tx-stat">${txIcon('credit-card')}<div><strong>${wallet ? `${wallet.balance < 0 ? '−' : ''}${txMoney(Math.abs(wallet.balance))} F` : '—'}</strong><small>Votre solde</small></div></div>
        </div>
      </section>
      <div class="tx-overview-grid">
        <section><div class="tx-section-label"><h2>Les essentiels</h2><span class="tx-muted"><small>À portée de main</small></span></div>
          <div class="tx-quick-grid">${quick.map(([r, i, t, d]) => `<button class="tx-quick" data-route="${r}" type="button"><span class="tx-quick-icon">${txIcon(i)}</span><strong>${t}</strong><p>${d}</p>${txIcon('arrow-up-right')}</button>`).join('')}</div>
        </section>
        <aside class="tx-overview-aside"><div class="tx-section-label"><h2>Votre portefeuille</h2></div>
          ${walletCard}
          ${waCallout}${callout}
        </aside>
      </div>`;
  }

  // ---- Général ------------------------------------------------------------
  async function general(box) {
    const c = await api('/api/app/company');
    const tzLabels = {
      'Africa/Porto-Novo': 'Bénin — Cotonou, Porto-Novo (GMT+1)', 'Africa/Abidjan': 'Côte d’Ivoire — Abidjan (GMT)',
      'Africa/Accra': 'Ghana — Accra (GMT)', 'Africa/Lagos': 'Nigeria — Lagos (GMT+1)', 'Africa/Lome': 'Togo — Lomé (GMT)',
      'Africa/Ouagadougou': 'Burkina Faso — Ouagadougou (GMT)', 'Africa/Dakar': 'Sénégal — Dakar (GMT)', 'Africa/Bamako': 'Mali — Bamako (GMT)',
      'Africa/Niamey': 'Niger — Niamey (GMT+1)', 'Africa/Douala': 'Cameroun — Douala (GMT+1)', 'Africa/Kinshasa': 'RD Congo — Kinshasa (GMT+1)',
      UTC: 'Temps universel (UTC)', 'Europe/Paris': 'France — Paris (GMT+1 / +2 en été)',
    };
    const saved = { name: c.name || '', slug: c.slug || '', adminEmail: c.admin_email || '', timezone: c.timezone || 'Africa/Porto-Novo' };
    // logo : undefined = inchangé, null = à retirer, chaîne = nouvelle image (data URL)
    let logoDraft;
    const field = (label, name, value, type, help, full, extra = '') => `<label class="tx-field ${full ? 'tx-field-full' : ''}" for="tx-${name}">${label}<input id="tx-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra}>${help ? `<small>${help}</small>` : ''}</label>`;
    box.innerHTML = `${heading('Votre entreprise', 'Gardez vos informations à jour, pour votre équipe et vos clients.')}
      <form id="txGeneralForm" novalidate>
        <div class="tx-form-layout">
          <section class="tx-panel">
            <div class="tx-panel-head"><div><h2>Profil de l’entreprise</h2><p>Les informations qui présentent votre activité.</p></div></div>
            <div class="tx-panel-body">
              <div class="tx-logo-editor"><div class="tx-org-logo" id="txLogoPreview">${logoBox(context.company.logoUrl)}</div><div><div class="tx-inline-actions">${txButton(`${txIcon('upload')} ${context.company.logoUrl ? 'Changer le logo' : 'Importer un logo'}`, 'id="txLogoPick"')}${txButton('Retirer', `id="txLogoRemove" ${context.company.logoUrl ? '' : 'hidden'}`, 'tx-button-quiet')}</div><small>PNG, JPEG ou WebP · 8 Mo maximum. Affiché sur les pages de suivi de vos clients.</small><input type="file" accept="image/png,image/jpeg,image/webp" id="txLogoFile" hidden></div></div>
              <div class="tx-fields">
                ${field('Nom de l’entreprise', 'name', saved.name, 'text', '', false, 'required minlength="2" maxlength="120"')}
                ${field('Identifiant de l’espace', 'slug', saved.slug, 'text', 'Lettres minuscules, chiffres et tirets.', false, 'required minlength="2" maxlength="80" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" autocapitalize="off" spellcheck="false"')}
                ${field('E-mail administratif', 'adminEmail', saved.adminEmail, 'email', 'Pour les informations importantes concernant votre espace.', true, 'maxlength="160"')}
                <label class="tx-field tx-field-full" for="tx-timezone">Fuseau horaire<select id="tx-timezone" name="timezone">${(c.timezones || []).map((tz) => `<option value="${escapeHtml(tz)}" ${tz === saved.timezone ? 'selected' : ''}>${escapeHtml(tzLabels[tz] || tz)}</option>`).join('')}</select><small>Utilisé pour afficher vos horaires et vos rapports.</small></label>
              </div>
            </div>
          </section>
          <aside class="tx-form-aside">
            <section class="tx-panel tx-panel-body"><span class="tx-eyebrow">Votre espace</span><h2>Les repères utiles</h2>
              <dl class="tx-detail-list"><div><dt>N° de l’espace</dt><dd>#${escapeHtml(c.id)}</dd></div><div><dt>Propriétaire</dt><dd>${escapeHtml(c.owner_name || '—')}</dd></div><div><dt>Votre rôle</dt><dd>${escapeHtml(traxoRoleLabels[context.user.role] || context.user.role)}</dd></div><div><dt>Livreurs actifs</dt><dd>${escapeHtml(c.active_drivers ?? 0)}</dd></div><div><dt>Création</dt><dd>${escapeHtml(formatDateOnly(c.created_at))}</dd></div></dl>
            </section>
            <div class="tx-aside-note">${txIcon('eye')}<div><strong>Ce que vos clients voient</strong>Votre logo et le nom de votre entreprise apparaissent sur leurs pages de demande et de suivi.</div></div>
          </aside>
        </div>
        ${savebar('Enregistrer les modifications')}
      </form>`;
    const form = box.querySelector('#txGeneralForm');
    const preview = box.querySelector('#txLogoPreview');
    const pick = box.querySelector('#txLogoPick');
    const removeBtn = box.querySelector('#txLogoRemove');
    const fileInput = box.querySelector('#txLogoFile');
    const values = () => Object.fromEntries(new FormData(form));
    const paintLogo = () => {
      const url = logoDraft === undefined ? context.company.logoUrl : logoDraft;
      preview.innerHTML = logoBox(url, 'Aperçu du logo');
      removeBtn.hidden = !url;
    };
    pick.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try { logoDraft = await readLogoFile(file); paintLogo(); bar.refresh(); } catch (error) { uiToast(error.message, 'error'); }
    });
    removeBtn.addEventListener('click', () => { logoDraft = context.company.logoUrl ? null : undefined; paintLogo(); bar.refresh(); });
    const bar = mountSavebar(form, {
      snapshot: () => JSON.stringify([values(), logoDraft === undefined ? 'same' : logoDraft === null ? 'none' : logoDraft.length]),
      reset: () => {
        form.elements.name.value = saved.name; form.elements.slug.value = saved.slug;
        form.elements.adminEmail.value = saved.adminEmail; form.elements.timezone.value = saved.timezone;
        logoDraft = undefined; paintLogo();
      },
      savedMessage: 'Profil enregistré.',
      save: async () => {
        const data = values();
        data.slug = String(data.slug || '').trim().toLowerCase();
        const changed = ['name', 'slug', 'adminEmail', 'timezone'].some((k) => String(data[k] || '').trim() !== saved[k]);
        if (changed) {
          const result = await api('/api/app/company', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
          Object.assign(saved, { name: result.name, slug: result.slug, adminEmail: result.admin_email || '', timezone: result.timezone });
          context.company.name = result.name; context.company.slug = result.slug;
          form.elements.slug.value = result.slug;
        }
        if (logoDraft === null) {
          await api('/api/app/company/logo', { method: 'DELETE' });
          context.company.logoUrl = null;
        } else if (typeof logoDraft === 'string') {
          const result = await api('/api/app/company/logo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: logoDraft }) });
          context.company.logoUrl = result.logoUrl;
        }
        logoDraft = undefined; paintLogo();
        pick.innerHTML = `${txIcon('upload')} ${context.company.logoUrl ? 'Changer le logo' : 'Importer un logo'}`;
        paintCompanyAvatar();
      },
    });
  }

  // ---- Livraisons ---------------------------------------------------------
  async function deliveries(box) {
    const [rules, proofs] = await Promise.all([api('/api/app/settings/deliveries'), api('/api/app/settings/proofs')]);
    const savedRules = { ...rules };
    const savedProofs = { photoMode: proofs.photo_proof_mode || 'off', signatureMode: proofs.signature_proof_mode || 'off' };
    const ro = !canEdit;
    const proofRow = (name, title, desc, value) => `<div class="tx-setting-row tx-proof-row"><div><span class="tx-row-title" id="tx-${name}-label">${escapeHtml(title)}</span><p>${escapeHtml(desc)}</p></div>
      <div class="tx-segmented tx-proof-choice" role="radiogroup" aria-labelledby="tx-${name}-label">${[['off', 'Désactivée'], ['optional', 'Facultative'], ['required', 'Obligatoire']].map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${value === v ? 'checked' : ''} ${ro ? 'disabled' : ''}><span>${l}</span></label>`).join('')}</div></div>`;
    box.innerHTML = `${heading('Vos règles de livraison', 'Définissez comment votre équipe crée, valide et clôture les livraisons.')}
      <form id="txDeliveriesForm" novalidate>
        <div class="tx-settings-columns">
          <section class="tx-panel"><div class="tx-panel-head"><div><span class="tx-eyebrow">À la réception</span><h2>Création des demandes</h2><p>Choisissez comment recevoir les informations.</p></div></div><div class="tx-panel-body">
            ${toggleRow('customerFormEnabled', 'Laisser le client remplir sa demande', 'Vous envoyez un lien : le client renseigne ses informations et partage sa position exacte.', rules.customerFormEnabled, ro)}
            ${toggleRow('internalEntryEnabled', 'Permettre la saisie par votre équipe', 'Vos collaborateurs créent eux-mêmes une commande pour le client.', rules.internalEntryEnabled, ro)}
            ${toggleRow('manualValidation', 'Vérifier les demandes reçues par lien', 'Activé : une demande arrive « À vérifier » et votre équipe la valide. Désactivé : elle est validée dès l’envoi du client.', rules.manualValidation, ro || !rules.customerFormEnabled)}
          </div></section>
          <section class="tx-panel"><div class="tx-panel-head"><div><span class="tx-eyebrow">Avant le départ</span><h2>Validation des commandes</h2><p>Gardez la main sur les départs en livraison.</p></div></div><div class="tx-panel-body">
            ${toggleRow('driverAssignmentRequired', 'Affecter un livreur pour valider', 'Une demande ne peut être validée qu’en choisissant son livreur : la commande est créée dans la foulée.', rules.driverAssignmentRequired, ro)}
            ${toggleRow('allowEditAfterValidation', 'Laisser le client corriger après validation', 'Tant que la commande n’est pas créée, le client peut encore modifier sa demande depuis son lien.', rules.allowEditAfterValidation, ro)}
            ${toggleRow('showFullRoute', 'Montrer au client tout le trajet du livreur', 'Le client voit aussi la collecte et les autres arrêts, sans le nom ni l’adresse des autres clients. Désactivé : il voit son livreur seulement quand celui-ci vient chez lui.', rules.showFullRoute, ro)}
          </div></section>
        </div>
        <section class="tx-panel tx-proofs-panel"><div class="tx-panel-head"><div><span class="tx-eyebrow">À l’arrivée</span><h2>Preuves de livraison</h2><p>Ce que le livreur doit fournir pour clôturer une livraison dans son application.</p></div></div><div class="tx-panel-body">
          ${proofRow('photoMode', 'Photo du colis livré', 'Une photo prise au moment de la remise.', savedProofs.photoMode)}
          ${proofRow('signatureMode', 'Signature du client', 'Le client signe sur l’écran du livreur.', savedProofs.signatureMode)}
        </div></section>
        ${infoStrip('Ces règles s’appliquent aux nouvelles demandes et aux prochaines livraisons. Les commandes déjà en cours ne changent pas.')}
        <p class="tx-error" id="txDeliveryError" role="alert" hidden></p>
        ${ro ? infoStrip('Seul un propriétaire ou un manager peut modifier ces règles.') : savebar('Enregistrer les règles')}
      </form>`;
    if (ro) return;
    const form = box.querySelector('#txDeliveriesForm');
    const err = box.querySelector('#txDeliveryError');
    const keys = ['customerFormEnabled', 'internalEntryEnabled', 'manualValidation', 'driverAssignmentRequired', 'allowEditAfterValidation', 'showFullRoute'];
    const current = () => ({
      rules: Object.fromEntries(keys.map((k) => [k, form.elements[k].checked])),
      proofs: { photoMode: form.elements.photoMode.value, signatureMode: form.elements.signatureMode.value },
    });
    const syncDependencies = () => {
      form.elements.manualValidation.disabled = !form.elements.customerFormEnabled.checked;
      err.hidden = true;
    };
    form.addEventListener('change', syncDependencies);
    mountSavebar(form, {
      snapshot: () => JSON.stringify(current()),
      reset: () => {
        keys.forEach((k) => { form.elements[k].checked = savedRules[k]; });
        form.elements.photoMode.value = savedProofs.photoMode; form.elements.signatureMode.value = savedProofs.signatureMode;
        syncDependencies();
      },
      savedMessage: 'Règles enregistrées.',
      save: async () => {
        const next = current();
        if (!next.rules.customerFormEnabled && !next.rules.internalEntryEnabled) {
          err.textContent = 'Gardez au moins une façon de créer une livraison : le lien client ou la saisie par votre équipe.';
          err.hidden = false;
          throw new Error('Aucune façon de créer une livraison n’est activée.');
        }
        if (keys.some((k) => next.rules[k] !== savedRules[k])) {
          const result = await api('/api/app/settings/deliveries', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next.rules) });
          keys.forEach((k) => { savedRules[k] = result[k]; });
        }
        if (next.proofs.photoMode !== savedProofs.photoMode || next.proofs.signatureMode !== savedProofs.signatureMode) {
          const result = await api('/api/app/settings/proofs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next.proofs) });
          savedProofs.photoMode = result.photo_proof_mode; savedProofs.signatureMode = result.signature_proof_mode;
        }
      },
    });
  }

  // ---- Équipe & permissions -----------------------------------------------
  // Résumé ; les invitations, rôles et accès se gèrent dans Équipe et accès.
  async function team(box) {
    const data = await api('/api/app/team');
    const members = (data.members || []).filter((m) => m.role !== 'driver');
    const drivers = (data.members || []).length - members.length;
    const pending = (data.invitations || []).filter((i) => i.state === 'pending' && i.role !== 'driver');
    const stateBadge = (state) => (state === 'active' ? '<span class="tx-badge tx-badge-green">Actif</span>' : '<span class="tx-badge">Suspendu</span>');
    const memberRow = (m) => `<div class="tx-member-row"><div class="tx-person"><span class="tx-avatar">${escapeHtml(txInitials(m.displayName || m.email || '?'))}</span><div><strong>${escapeHtml(m.displayName || m.email || 'Membre')}${m.me ? ' <span class="tx-muted">· Vous</span>' : ''}</strong><p>${escapeHtml(m.email || m.phone || '')}</p></div></div><span>${escapeHtml(traxoRoleLabels[m.role] || m.role)}</span><span>${stateBadge(m.state)}</span></div>`;
    const inviteRow = (i) => `<div class="tx-member-row"><div class="tx-person"><span class="tx-avatar">${txIcon('mail')}</span><div><strong>${escapeHtml(i.displayName || i.email || i.phone)}</strong><p>${escapeHtml(i.email || i.phone || '')} · valable jusqu’au ${escapeHtml(formatDate(i.expiresAt))}</p></div></div><span>${escapeHtml(traxoRoleLabels[i.role] || i.role)}</span><span><span class="tx-badge tx-badge-amber">Invitation en attente</span></span></div>`;
    const roles = [
      ['crown', 'Propriétaire', 'Tous les accès, y compris la facturation et la propriété du compte.'],
      ['users', 'Administrateur', 'L’équipe, les livreurs, les exports et les réglages. La facturation reste au propriétaire.'],
      ['user-round', 'Opérateur', 'Les demandes, les commandes, les tournées et les incidents.'],
      ['eye', 'Lecture seule', 'Consulte l’activité sans rien modifier.'],
    ];
    box.innerHTML = `${heading('Équipe et permissions', 'Chacun sait ce qu’il peut faire, et vous gardez le contrôle.', `<a class="tx-button tx-button-primary" href="/app/equipe?inviter=1">${txIcon('plus')} Inviter une personne</a>`)}
      <section class="tx-panel"><div class="tx-panel-head"><div><h2>Membres de l’espace <span class="tx-badge">${members.length + pending.length}</span></h2><p>Les personnes qui accèdent à votre espace TRAXO.</p></div><a class="tx-button tx-button-quiet" href="/app/equipe">Gérer les accès ${txIcon('arrow-right')}</a></div>
        <div class="tx-member-row tx-table-head"><span>Membre</span><span>Rôle</span><span>Statut</span></div>
        ${members.map(memberRow).join('')}${pending.map(inviteRow).join('')}
      </section>
      <section class="tx-panel tx-role-section"><h2>Qui peut faire quoi ?</h2><div class="tx-role-grid">${roles.map(([i, t, d]) => `<div class="tx-role">${txIcon(i)}<h3>${t}</h3><p>${d}</p></div>`).join('')}</div></section>
      ${infoStrip(`Les livreurs${drivers ? ` (${drivers})` : ''} rejoignent l’équipe depuis la page <a href="/app/livreurs">Livreurs</a>, avec un QR code. Pour inviter, changer un rôle ou suspendre un accès, ouvrez <a href="/app/equipe">Équipe et accès</a>.`)}`;
  }

  // ---- Sécurité -----------------------------------------------------------
  // Notifications du navigateur : réglage propre à cet appareil (pas au compte).
  function deviceNotifRow() {
    const n = TraxoUI.notifications;
    const perm = n.permission();
    const desc = perm === 'unsupported' ? 'Ce navigateur ne permet pas les notifications.'
      : perm === 'denied' ? 'Bloquées par le navigateur : autorisez-les dans les réglages du site (icône à gauche de l’adresse), puis rechargez la page.'
        : 'Une alerte sur cet ordinateur ou ce téléphone pour chaque nouvelle demande, commande à affecter ou incident, même si TRAXO est dans un autre onglet.';
    return toggleRow('deviceNotif', 'Notifications sur cet appareil', desc, n.enabled(), perm === 'unsupported' || perm === 'denied');
  }

  async function security(box) {
    const s = await api('/api/app/account/security');
    const days = s.passwordChangedAt ? Math.max(0, Math.round((Date.now() - new Date(s.passwordChangedAt).getTime()) / 86400000)) : null;
    const pwdSub = days == null ? 'Jamais modifié depuis la création du compte.' : days === 0 ? 'Modifié aujourd’hui.' : `Dernière modification il y a ${txPlural(days, 'jour', 'jours')}.`;
    const channelNote = !s.loginCodes ? 'La vérification par code n’est pas active sur ce serveur : la connexion se fait avec le mot de passe (et la double authentification si elle est activée).'
      : s.twoFactorEnabled
      ? 'Votre double authentification est active : c’est le code de votre application qui est demandé, pas un code par e-mail ou WhatsApp.'
      : s.whatsappChannel ? 'Demandés à la connexion depuis un nouvel appareil.' : 'Demandés à la connexion depuis un nouvel appareil. WhatsApp est momentanément indisponible : les codes partent par e-mail.';
    const currentChannel = s.codeChannel || (s.phoneInternational ? 'whatsapp' : 'email');
    box.innerHTML = `${heading('Sécurité du compte', 'Choisissez comment vous connecter et gardez un œil sur vos accès.')}
      <div class="tx-form-layout">
        <div class="tx-stack">
          <section class="tx-panel tx-codes-panel" id="txCodes"><div class="tx-panel-head"><div><h2>Codes de connexion</h2><p>${escapeHtml(channelNote)}</p></div></div><div class="tx-panel-body">
            <form id="txPhoneForm" class="tx-codes-form" novalidate>
              <fieldset class="tx-codes-choice"><legend>Où recevoir vos codes ?</legend>
                <label class="tx-code-opt"><input type="radio" name="codeChannel" value="whatsapp" ${currentChannel === 'whatsapp' ? 'checked' : ''}><span>${txIcon('smartphone')}<strong>Sur WhatsApp</strong><small>Le plus rapide. L’e-mail reste en secours.</small></span></label>
                <label class="tx-code-opt"><input type="radio" name="codeChannel" value="email" ${currentChannel === 'email' ? 'checked' : ''}><span>${txIcon('mail')}<strong>Par e-mail</strong><small>${escapeHtml(context.user.email)}</small></span></label>
              </fieldset>
              <label class="tx-field" for="txPhone" id="txPhoneField" ${currentChannel === 'whatsapp' ? '' : 'hidden'}>Votre numéro WhatsApp<input id="txPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="01 97 12 34 56" value="${escapeHtml(s.phone || '')}"><small>Au Bénin, saisissez simplement vos 10 chiffres. Ailleurs, ajoutez l’indicatif (+33…).</small></label>
              ${s.phone && !s.phoneInternational ? '<p class="tx-error">Ce numéro n’a pas d’indicatif : enregistrez-le de nouveau pour recevoir vos codes sur WhatsApp.</p>' : ''}
              <button type="submit" class="tx-button tx-button-primary" id="txPhoneSave" disabled>Enregistrer</button>
            </form>
          </div></section>
          <section class="tx-panel"><div class="tx-panel-head"><div><h2>Connexion et protection</h2><p>${escapeHtml(context.user.email)}${s.googleLinked ? ' · compte Google relié' : ''}</p></div></div><div class="tx-panel-body">
            <div class="tx-setting-row"><div class="tx-row-with-icon">${txIcon('lock-keyhole')}<div><h3>Mot de passe</h3><p>${escapeHtml(pwdSub)}</p></div></div>${txButton('Modifier', 'id="txPwd"')}</div>
            <div class="tx-setting-row"><div class="tx-row-with-icon">${txIcon('shield-check')}<div><h3>Double authentification</h3><p>${s.twoFactorEnabled ? `Un code de votre application à chaque connexion · ${txPlural(s.recoveryCodesLeft, 'code de secours restant', 'codes de secours restants')}.` : 'Un code de votre application en plus de votre mot de passe.'}</p><span class="tx-badge ${s.twoFactorEnabled ? 'tx-badge-green' : 'tx-badge-red'}">${s.twoFactorEnabled ? 'Activée' : 'À activer'}</span></div></div>${s.twoFactorEnabled ? `<div class="tx-inline-actions">${txButton('Nouveaux codes', 'id="txMfaCodes"')}${txButton('Désactiver', 'id="txMfaOff"', 'tx-button-quiet')}</div>` : txButton('Configurer', 'id="txMfaOn"', 'tx-button-primary')}</div>
            <div class="tx-setting-row"><div class="tx-row-with-icon">${txIcon('monitor')}<div><h3>Sessions actives</h3><p>${txPlural(s.activeSessions, 'appareil connecté', 'appareils connectés')} à votre compte.</p></div></div>${txButton('Voir', 'id="txSessions"')}</div>
            ${toggleRow('loginAlerts', 'M’avertir des nouvelles connexions', 'Recevez un e-mail lorsqu’un appareil se connecte à votre compte.', s.loginAlerts)}
            ${deviceNotifRow()}
          </div></section>
        </div>
        <aside class="tx-form-aside"><section class="tx-panel tx-panel-body tx-security-aside"><div class="tx-security-title">${txIcon('shield-check')}<h2>Une étape de plus.<br>Une protection en plus.</h2></div><p class="tx-muted tx-aside-text">Même si quelqu’un connaît votre mot de passe, il lui faudra aussi le code de votre application d’authentification.</p><div class="tx-session">${txIcon('smartphone')}<div><strong>Votre application habituelle</strong><p>Google Authenticator, Microsoft Authenticator, Authy ou 1Password.</p></div></div></section></aside>
      </div>`;
    const refresh = () => security(box);
    box.querySelector('#txPwd').addEventListener('click', () => openPasswordModal(refresh));
    box.querySelector('#txMfaOn')?.addEventListener('click', () => openMfaSetup(refresh));
    box.querySelector('#txMfaOff')?.addEventListener('click', () => openMfaDisable(refresh));
    box.querySelector('#txMfaCodes')?.addEventListener('click', () => openMfaNewCodes(refresh));
    box.querySelector('#txSessions').addEventListener('click', () => openSessionsModal(refresh));
    const alerts = box.querySelector('#tx-loginAlerts');
    alerts.addEventListener('change', async () => {
      alerts.disabled = true;
      try {
        await api('/api/app/account/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginAlerts: alerts.checked }) });
        uiToast(alerts.checked ? 'Vous serez averti par e-mail des nouvelles connexions.' : 'Alertes de connexion désactivées.', 'success');
      } catch (error) { alerts.checked = !alerts.checked; uiToast(error.message, 'error'); }
      alerts.disabled = false;
    });
    const deviceNotif = box.querySelector('#tx-deviceNotif');
    deviceNotif.addEventListener('change', async () => {
      const result = await TraxoUI.notifications.setEnabled(deviceNotif.checked);
      if (result === 'granted') {
        uiToast('Notifications activées sur cet appareil.', 'success');
        TraxoUI.notifications.show('Notifications TRAXO activées', { body: 'Vous serez prévenu des nouvelles demandes, des commandes à affecter et des incidents.', tag: 'traxo-test' });
      } else if (result === 'off') uiToast('Notifications désactivées sur cet appareil.', 'success');
      else { deviceNotif.checked = false; uiToast(result === 'denied' ? 'Le navigateur a bloqué les notifications.' : 'Notifications non activées.', 'warning'); refresh(); }
    });
    const phoneForm = box.querySelector('#txPhoneForm');
    const phoneSave = box.querySelector('#txPhoneSave');
    const phoneField = box.querySelector('#txPhoneField');
    let saved = { phone: s.phone || '', channel: currentChannel };
    const draft = () => ({ phone: phoneForm.elements.phone.value.trim(), channel: phoneForm.elements.codeChannel.value });
    const changed = () => { const d = draft(); return d.channel !== saved.channel || (d.channel === 'whatsapp' && d.phone !== saved.phone); };
    phoneForm.addEventListener('input', () => { phoneSave.disabled = !changed(); });
    phoneForm.addEventListener('change', () => {
      const wa = phoneForm.elements.codeChannel.value === 'whatsapp';
      phoneField.hidden = !wa;
      if (wa && !phoneForm.elements.phone.value.trim()) phoneForm.elements.phone.focus();
      phoneSave.disabled = !changed();
    });
    phoneForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const d = draft();
      if (d.channel === 'whatsapp' && !d.phone) { uiToast('Indiquez votre numéro WhatsApp.', 'error'); phoneForm.elements.phone.focus(); return; }
      phoneSave.disabled = true;
      try {
        const body = d.channel === 'whatsapp' ? { phone: d.phone, codeChannel: 'whatsapp' } : { codeChannel: 'email' };
        const result = await api('/api/app/account/phone', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        saved = { phone: result.phone || '', channel: result.codeChannel || d.channel };
        phoneForm.elements.phone.value = result.phone || '';
        uiToast(saved.channel === 'whatsapp' ? 'C’est noté : vos prochains codes arriveront sur WhatsApp.' : 'C’est noté : vos prochains codes arriveront par e-mail.', 'success');
      } catch (error) { uiToast(error.message, 'error'); phoneSave.disabled = false; }
    });
    if (new URLSearchParams(location.search).get('focus') === 'codes') box.querySelector('#txCodes')?.scrollIntoView({ block: 'start' });
    isDirty = () => document.body.contains(phoneForm) && changed();
  }

  // ---- Facturation : portefeuille prépayé -----------------------------------
  // Page complète dans public/billing.js (kit « Facturation TRAXO » V2.2).
  // Ici, seulement le résumé affiché dans la vue d'ensemble.
  const walletStates = {
    ok: ['tx-wallet-ok', 'Solde suffisant'],
    low: ['tx-wallet-low', 'Solde bas'],
    overdraft: ['tx-wallet-over', 'Découvert'],
    blocked: ['tx-wallet-over', 'Solde épuisé'],
  };
  function walletSummaryHtml(w) {
    const [cls, label] = walletStates[w.state] || walletStates.ok;
    const covered = w.month.nextUnitPrice > 0 ? Math.max(0, Math.floor(w.balance / w.month.nextUnitPrice)) : null;
    let line = covered != null && w.balance > 0 ? `De quoi couvrir environ ${txPlural(covered, 'commande', 'commandes')} au prix actuel.` : '';
    if (w.state === 'overdraft') line = `Vous utilisez votre découvert (jusqu’à ${txMoney(w.overdraft.amount)} F). Rechargez pour continuer sans interruption.`;
    if (w.state === 'blocked') line = 'Découvert atteint : rechargez pour créer de nouvelles commandes.';
    if (w.trial.active) line = `Essai gratuit en cours${w.trial.endsAt ? ` jusqu’au ${new Date(w.trial.endsAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}` : ''} : vos commandes ne sont pas débitées.`;
    return { cls, label, line };
  }

  async function billing(box) {
    if (!window.TraxoBilling) throw new Error('La facturation n’a pas pu être chargée. Rechargez la page.');
    await window.TraxoBilling.render(box, { api, context, uiToast, setHeader, activateNavigation });
  }

  // ---- Facturation TRAXO (administrateur plateforme) -----------------------
  // Réglages appliqués à toutes les entreprises, sans redéploiement, et
  // corrections ponctuelles d'un portefeuille.
  async function renderBillingAdmin(box) {
    const { settings } = await api('/api/app/platform/billing/settings');
    const num = (name, value, label, help = '', attrs = '') => `<label class="tx-field" for="txb-${name}">${escapeHtml(label)}<input id="txb-${name}" name="${name}" type="number" inputmode="numeric" value="${value}" ${attrs}>${help ? `<small>${escapeHtml(help)}</small>` : ''}</label>`;
    box.innerHTML = `${heading('Tarifs TRAXO', 'Prix, découvert, bonus et Rapport Premium, pour toutes les entreprises.', '', 'Équipe TRAXO')}
      <form class="tx-panel tx-form" id="txBillingForm">
        ${toggleRow('enforcement', 'Bloquer au-delà du découvert', 'Refuse la création de commandes quand le solde dépasse le découvert. À activer une fois le paiement en ligne ouvert.', settings.enforcement)}
        ${toggleRow('freeDuringTrial', 'Commandes gratuites pendant l’essai', 'Aucun débit pendant les 3 jours d’essai.', settings.freeDuringTrial)}
        ${toggleRow('pricesIncludeTax', 'Prix affichés TTC', 'Désactivé : les prix sont affichés hors taxes.', settings.pricesIncludeTax)}
        <h2 class="tx-form-title">Prix par commande, selon le rang dans le mois</h2>
        <div id="txTiers"></div>
        <button type="button" class="tx-text-button" id="txAddTier">Ajouter un palier</button>
        <h2 class="tx-form-title">Bonus de recharge</h2>
        <div id="txBonus"></div>
        <button type="button" class="tx-text-button" id="txAddBonus">Ajouter un palier de bonus</button>
        <h2 class="tx-form-title">Portefeuille</h2>
        <div class="tx-fields">
          ${num('overdraftOrders', settings.overdraftOrders, 'Découvert (en commandes)', 'Ex. 10 : le solde peut descendre de 10 commandes sous zéro.', 'min="0" max="1000"')}
          ${num('lowBalanceOrders', settings.lowBalanceOrders, 'Alerte de solde bas (en commandes)', '', 'min="0" max="1000"')}
          ${num('minRecharge', settings.minRecharge, 'Recharge minimale (F)', '', 'min="100"')}
          ${num('suggestedRecharge', settings.suggestedRecharge, 'Recharge conseillée (F)', '', 'min="100"')}
          ${num('maxRecharge', settings.maxRecharge, 'Recharge maximale (F)', '', 'min="100"')}
        </div>
        <h2 class="tx-form-title">Rapport Premium</h2>
        <div class="tx-fields">
          ${num('premium.freeReports', settings.premium.freeReports, 'Rapports offerts', 'Au total, par entreprise.', 'min="0"')}
          ${num('premium.reportPrice', settings.premium.reportPrice, 'Prix d’un rapport (F)', '', 'min="0"')}
          ${num('premium.monthPrice', settings.premium.monthPrice, 'Prix du mois illimité (F)', '', 'min="0"')}
        </div>
        <p class="tx-error" id="txBillingErr" role="alert" hidden></p>
        <div class="tx-inline-actions"><button type="submit" class="tx-button tx-button-primary">Enregistrer les réglages</button></div>
      </form>
      <form class="tx-panel tx-form" id="txAdjustForm">
        <h2 class="tx-form-title">Corriger un portefeuille</h2>
        <p class="tx-muted">Geste commercial ou correction. Montant positif pour créditer, négatif pour débiter. Le motif est conservé dans l’historique de l’entreprise.</p>
        <div class="tx-fields">
          ${num('companyId', '', 'Numéro de l’espace', 'Visible dans le support et la vigilance (#…).', 'min="1" required')}
          ${num('amount', '', 'Montant (F)', '', 'required')}
          <label class="tx-field tx-field-full" for="txb-note">Motif<input id="txb-note" name="note" type="text" maxlength="300" required></label>
        </div>
        <p class="tx-error" id="txAdjustErr" role="alert" hidden></p>
        <div class="tx-inline-actions"><button type="submit" class="tx-button tx-button-primary">Enregistrer la correction</button></div>
      </form>`;
    const form = box.querySelector('#txBillingForm');
    const state = { tiers: settings.tiers.map((t) => ({ ...t })), bonus: settings.rechargeBonus.map((b) => ({ ...b })) };
    const paintTiers = () => {
      box.querySelector('#txTiers').innerHTML = state.tiers.map((t, i) => {
        const last = i === state.tiers.length - 1;
        return `<div class="tx-rule-row" data-tier="${i}"><label class="tx-field">Jusqu’à la commande n°<input type="number" min="1" data-k="upTo" value="${last ? '' : t.upTo}" ${last ? 'disabled placeholder="sans limite"' : ''}></label><label class="tx-field">Prix (F)<input type="number" min="0" data-k="price" value="${t.price}"></label>${state.tiers.length > 1 ? `<button type="button" class="tx-text-button" data-remove-tier="${i}">Retirer</button>` : ''}</div>`;
      }).join('');
    };
    const paintBonus = () => {
      box.querySelector('#txBonus').innerHTML = state.bonus.length ? state.bonus.map((b, i) => `<div class="tx-rule-row" data-bonus="${i}"><label class="tx-field">Dès (F)<input type="number" min="1" data-k="from" value="${b.from}"></label><label class="tx-field">Bonus (%)<input type="number" min="0" max="100" data-k="percent" value="${b.percent}"></label><button type="button" class="tx-text-button" data-remove-bonus="${i}">Retirer</button></div>`).join('') : '<p class="tx-muted">Aucun bonus.</p>';
    };
    paintTiers(); paintBonus();
    box.querySelector('#txTiers').addEventListener('input', (event) => { const row = event.target.closest('[data-tier]'); if (row) state.tiers[row.dataset.tier][event.target.dataset.k] = Number(event.target.value); });
    box.querySelector('#txBonus').addEventListener('input', (event) => { const row = event.target.closest('[data-bonus]'); if (row) state.bonus[row.dataset.bonus][event.target.dataset.k] = Number(event.target.value); });
    box.querySelector('#txTiers').addEventListener('click', (event) => { const b = event.target.closest('[data-remove-tier]'); if (!b) return; state.tiers.splice(Number(b.dataset.removeTier), 1); state.tiers[state.tiers.length - 1].upTo = null; paintTiers(); });
    box.querySelector('#txBonus').addEventListener('click', (event) => { const b = event.target.closest('[data-remove-bonus]'); if (!b) return; state.bonus.splice(Number(b.dataset.removeBonus), 1); paintBonus(); });
    box.querySelector('#txAddTier').addEventListener('click', () => {
      const last = state.tiers[state.tiers.length - 1];
      const prev = state.tiers.length > 1 ? state.tiers[state.tiers.length - 2].upTo : 0;
      last.upTo = (prev || 0) + 500;
      state.tiers.push({ upTo: null, price: last.price });
      paintTiers();
    });
    box.querySelector('#txAddBonus').addEventListener('click', () => { const last = state.bonus[state.bonus.length - 1]; state.bonus.push({ from: last ? last.from * 2 : 5000, percent: last ? last.percent + 5 : 5 }); paintBonus(); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const errBox = box.querySelector('#txBillingErr'); errBox.hidden = true;
      const v = (name) => Number(form.elements[name].value);
      const payload = {
        enforcement: form.elements.enforcement.checked, freeDuringTrial: form.elements.freeDuringTrial.checked, pricesIncludeTax: form.elements.pricesIncludeTax.checked,
        tiers: state.tiers.map((t, i) => ({ upTo: i === state.tiers.length - 1 ? null : t.upTo, price: t.price })),
        rechargeBonus: state.bonus,
        overdraftOrders: v('overdraftOrders'), lowBalanceOrders: v('lowBalanceOrders'), minRecharge: v('minRecharge'), suggestedRecharge: v('suggestedRecharge'), maxRecharge: v('maxRecharge'),
        premium: { freeReports: v('premium.freeReports'), reportPrice: v('premium.reportPrice'), monthPrice: v('premium.monthPrice') },
      };
      if (payload.enforcement && !settings.enforcement && !(await uiConfirm('Activer le blocage ?', { message: 'Les entreprises au-delà de leur découvert ne pourront plus créer de commandes tant qu’elles n’auront pas rechargé.', confirmLabel: 'Activer le blocage', tone: 'danger' }))) return;
      try {
        const out = await api('/api/app/platform/billing/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: payload }) });
        Object.assign(settings, out.settings);
        uiToast('Réglages de facturation enregistrés. Ils s’appliquent à toutes les entreprises.', 'success');
      } catch (error) { errBox.textContent = error.message; errBox.hidden = false; }
    });
    box.querySelector('#txAdjustForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const f = event.currentTarget;
      const errBox = box.querySelector('#txAdjustErr'); errBox.hidden = true;
      const amount = Math.round(Number(f.elements.amount.value));
      if (!(await uiConfirm(`${amount > 0 ? 'Créditer' : 'Débiter'} ${txMoney(Math.abs(amount))} F ?`, { message: `Espace #${f.elements.companyId.value} · ${f.elements.note.value}`, confirmLabel: 'Enregistrer' }))) return;
      try {
        const out = await api('/api/app/platform/billing/adjustments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: f.elements.companyId.value.trim(), amount, note: f.elements.note.value.trim() }) });
        uiToast(`Correction enregistrée. Nouveau solde de l’espace : ${txMoney(out.wallet.balance)} F.`, 'success');
        f.reset();
      } catch (error) { errBox.textContent = error.message; errBox.hidden = false; }
    });
  }

  // ---- WhatsApp TRAXO (administrateur plateforme) ------------------------
  // ---- Vigilance TRAXO (administrateur plateforme) ------------------------
  // Cas qui concernent plusieurs entreprises : essais gratuits réutilisés,
  // numéros de livreur présents dans plusieurs espaces.
  // Bureau du support TRAXO : toutes les demandes, réponses, notes internes, statuts.
  async function renderSupportDesk(box) {
    const deskParams = new URLSearchParams(location.search);
    const desk = { filter: 'open', q: '', id: deskParams.get('demande'), upload: null, busy: false };
    const labels = { received: 'Reçue', in_progress: 'En cours', waiting_customer: 'Réponse attendue', resolved: 'Résolue' };
    const tone = { received: 'tx-badge', in_progress: 'tx-badge tx-badge-blue', waiting_customer: 'tx-badge tx-badge-red', resolved: 'tx-badge tx-badge-green' };
    const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const stillHere = () => document.body.contains(box) && section === 'support';
    async function list() {
      if (!stillHere()) return;
      const data = await api(`/api/app/platform/support/tickets?status=${desk.filter}&q=${encodeURIComponent(desk.q)}`);
      const c = data.counts || {};
      const filters = [['open', 'Ouvertes', (c.received || 0) + (c.in_progress || 0) + (c.waiting_customer || 0)], ['received', 'Reçues', c.received || 0], ['in_progress', 'En cours', c.in_progress || 0], ['waiting_customer', 'Réponse attendue', c.waiting_customer || 0], ['resolved', 'Résolues', c.resolved || 0], ['all', 'Toutes', Object.values(c).reduce((a, b) => a + b, 0)]];
      box.innerHTML = `${heading('Support TRAXO', 'Les demandes des entreprises, une discussion par sujet. Les notes internes ne sont jamais visibles du client.')}
        <section class="tx-panel sd"><div class="sd-tools"><div class="sd-filters" role="group" aria-label="Statut">${filters.map(([k, n, v]) => `<button type="button" data-filter="${k}" aria-pressed="${desk.filter === k}">${n}<em>${v}</em></button>`).join('')}</div>
          <input type="search" class="sd-q" placeholder="Référence, sujet ou entreprise…" value="${escapeHtml(desk.q)}" aria-label="Rechercher une demande"></div>
          <div class="sd-list">${data.tickets.length ? data.tickets.map((t) => `<button type="button" class="sd-row" data-open="${escapeHtml(t.id)}"><span class="sd-ref">${escapeHtml(t.reference)}${t.unread ? '<i class="sd-dot" aria-label="Nouveau message client"></i>' : ''}</span><span class="sd-main"><strong>${escapeHtml(t.subject)}</strong><small>${escapeHtml(t.companyName)} · ${escapeHtml(t.categoryLabel)}${t.assignedTo ? ` · ${escapeHtml(t.assignedTo)}` : ''}</small></span><span class="${tone[t.status]}">${labels[t.status]}</span><span class="sd-when">${escapeHtml(formatDate(t.lastActivityAt))}</span></button>`).join('') : '<p class="tx-muted sd-empty">Aucune demande pour ce filtre.</p>'}</div></section>`;
      box.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { desk.filter = b.dataset.filter; list(); }));
      let timer;
      box.querySelector('.sd-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { desk.q = e.target.value; list().then(() => { const q = box.querySelector('.sd-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }); }, 300); });
      box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { desk.id = b.dataset.open; detail(); }));
    }
    async function detail() {
      if (!stillHere()) return;
      try { history.replaceState(null, '', `/app/parametres?section=support&demande=${encodeURIComponent(desk.id)}`); } catch { /* ignore */ }
      const data = await api(`/api/app/platform/support/tickets/${encodeURIComponent(desk.id)}`);
      const t = data.ticket;
      const evLabel = (e) => (e.kind === 'created' ? 'Demande créée' : e.kind === 'reopened' ? 'Rouverte par le client' : e.kind === 'assigned' ? 'Attribution modifiée' : `Statut : ${labels[e.to] || e.to}`);
      const items = [...data.messages.map((m) => ({ at: m.createdAt, m })), ...data.events.map((e) => ({ at: e.at, e }))].sort((a, b) => (new Date(a.at) - new Date(b.at)) || (a.e && !b.e ? -1 : !a.e && b.e ? 1 : 0));
      const file = (f) => {
        const url = `/api/app/platform/support/files/${encodeURIComponent(f.id)}`;
        if (f.kind === 'image') return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHtml(f.name)}" class="sd-img"></a>`;
        if (f.kind === 'audio') return `<audio controls preload="none" src="${url}"></audio>`;
        return `<a href="${url}?download=1">${escapeHtml(f.name)}</a>`;
      };
      box.innerHTML = `<div class="sd-back"><button type="button" class="tx-button tx-button-quiet" data-back>← Toutes les demandes</button></div>
        <section class="tx-panel sd"><div class="sd-head"><div><span class="sd-ref">${escapeHtml(t.reference)} · ${escapeHtml(t.categoryLabel)} · ${escapeHtml(t.companyName)} (espace #${escapeHtml(t.companyId)})</span><h2>${escapeHtml(t.subject)}</h2><small class="tx-muted">Ouverte par ${escapeHtml(t.createdBy || '—')} · ${escapeHtml(formatDate(t.createdAt))}</small></div>
          <div class="sd-ctrl"><label>Statut<select data-status>${Object.entries(labels).map(([k, n]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>Attribuée à<input data-assign value="${escapeHtml(t.assignedTo || '')}" placeholder="Facultatif" maxlength="80"></label></div></div>
          <div class="sd-thread">${items.map((it) => it.e ? `<p class="sd-event">${escapeHtml(evLabel(it.e))} · ${escapeHtml(formatDate(it.e.at))}</p>`
            : `<div class="sd-msg ${it.m.author === 'support' ? 'mine' : ''} ${it.m.internal ? 'internal' : ''}"><small>${it.m.internal ? 'Note interne · ' : ''}${escapeHtml(it.m.authorLabel)} · ${escapeHtml(formatDate(it.m.createdAt))}</small>${it.m.body ? `<p>${escapeHtml(it.m.body)}</p>` : ''}${it.m.attachments.map(file).join('')}</div>`).join('')}</div>
          <form class="sd-reply" novalidate><textarea name="message" rows="4" maxlength="5000" placeholder="Votre réponse au client…" aria-label="Réponse"></textarea>
            <div class="sd-file-line"></div>
            <div class="sd-reply-tools"><label class="sd-check"><input type="checkbox" name="internal"> Note interne (invisible du client)</label>
              <label>Après l’envoi<select name="status"><option value="">Statut inchangé</option><option value="waiting_customer">Réponse attendue du client</option><option value="resolved">Résolue</option><option value="in_progress">En cours</option></select></label>
              <label class="tx-button tx-button-quiet sd-attach">Joindre<input type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf,audio/*"></label>
              <button type="submit" class="tx-button tx-button-primary">Envoyer</button></div></form></section>`;
      const form = box.querySelector('.sd-reply');
      const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).replace(/-/g, '');
      box.querySelector('[data-back]').addEventListener('click', () => { desk.id = null; try { history.replaceState(null, '', '/app/parametres?section=support'); } catch { /* ignore */ } list(); });
      box.querySelector('[data-status]').addEventListener('change', async (e) => { try { await post(`/api/app/platform/support/tickets/${t.id}/status`, { status: e.target.value }); uiToast('Statut mis à jour.'); detail(); } catch (error) { uiToast(error.message, 'error'); } });
      box.querySelector('[data-assign]').addEventListener('change', async (e) => { try { await post(`/api/app/platform/support/tickets/${t.id}/assign`, { assignee: e.target.value }); uiToast('Attribution enregistrée.'); } catch (error) { uiToast(error.message, 'error'); } });
      form.querySelector('input[type="file"]').addEventListener('change', async (e) => {
        const f = e.target.files[0]; e.target.value = ''; if (!f) return;
        const line = form.querySelector('.sd-file-line'); line.textContent = `Envoi de ${f.name}…`;
        try {
          const res = await fetch(`/api/app/platform/support/uploads?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
          const out = await res.json(); if (!res.ok) throw new Error(out.error || 'Envoi impossible.');
          desk.upload = out; line.textContent = `Pièce jointe : ${out.name}`;
        } catch (error) { desk.upload = null; line.textContent = error.message; }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); if (desk.busy) return;
        const fd = new FormData(form);
        desk.busy = true; form.querySelector('[type="submit"]').disabled = true;
        try {
          await post(`/api/app/platform/support/tickets/${t.id}/messages`, { message: fd.get('message'), internal: fd.get('internal') === 'on', status: fd.get('status') || undefined, uploadId: desk.upload?.id, idempotencyKey: key });
          desk.upload = null; desk.busy = false; uiToast(fd.get('internal') === 'on' ? 'Note interne ajoutée.' : 'Réponse envoyée au client.'); detail();
        } catch (error) { desk.busy = false; form.querySelector('[type="submit"]').disabled = false; uiToast(error.message, 'error'); }
      });
      const thread = box.querySelector('.sd-thread'); thread.scrollTop = thread.scrollHeight;
    }
    if (desk.id && /^\d{1,18}$/.test(desk.id)) await detail(); else await list();
  }

  async function renderVigilance(box) {
    const data = await api('/api/app/platform/signals');
    const list = data.signals || [];
    const open = list.filter((x) => !x.reviewedAt);
    box.innerHTML = `${heading('Vigilance TRAXO', 'Ce qui mérite un regard, d’une entreprise à l’autre. Chaque entreprise ne voit jamais les données des autres.')}
      <section class="tx-panel"><div class="tx-panel-head"><div><h2>${open.length ? txPlural(open.length, 'point à vérifier', 'points à vérifier') : 'Rien à vérifier pour le moment'}</h2><p>Essais gratuits réutilisés et numéros de livreur partagés entre plusieurs espaces.</p></div></div>
      <div class="tx-panel-body">${list.length ? list.map((x) => `<div class="tx-setting-row"><div class="tx-row-with-icon">${txIcon('shield-check')}<div><h3>${escapeHtml(x.title)}${x.companyName ? ` · ${escapeHtml(x.companyName)}` : ''}</h3><p>${escapeHtml(x.detail)}</p><p class="tx-muted"><small>${escapeHtml(formatDate(x.at))}</small></p></div></div>${x.reviewedAt ? '<span class="tx-badge tx-badge-green">Vérifié</span>' : txButton('C’est vérifié', `data-review="${escapeHtml(x.id)}"`)}</div>`).join('') : '<p class="tx-muted">Aucun signal pour l’instant.</p>'}</div></section>`;
    box.querySelectorAll('[data-review]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api(`/api/app/platform/signals/${encodeURIComponent(b.dataset.review)}/review`, { method: 'POST' }); renderVigilance(box); } catch (error) { b.disabled = false; uiToast(error.message, 'error'); }
    }));
  }

  async function renderWhatsApp(box) {
    let timer = null;
    const stillHere = () => document.body.contains(box) && section === 'whatsapp';
    const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const steps = (last) => `<ol class="wa-steps"><li>Sur le téléphone du numéro TRAXO, ouvrez <strong>WhatsApp</strong>.</li><li>Touchez <strong>⋮</strong> (ou <strong>Réglages</strong> sur iPhone) puis <strong>Appareils connectés</strong>.</li><li>Touchez <strong>Connecter un appareil</strong>.</li><li>${last}</li></ol>`;
    async function paint() {
      clearTimeout(timer);
      if (!stillHere()) return;
      const s = await api('/api/app/whatsapp');
      let body = '';
      if (!s.enabled) {
        body = '<div class="notice warning">Le canal WhatsApp n’est pas configuré sur ce serveur (clé de chiffrement manquante).</div>';
      } else if (s.status === 'connected') {
        body = `<div class="tx-setting-row"><div class="tx-row-with-icon">${setIcons.whatsapp}<div><h3>Relié : ${escapeHtml(s.number || '')} <span class="tx-badge tx-badge-green">Actif</span></h3><p>Depuis le ${escapeHtml(formatDate(s.since))} · ${escapeHtml(s.sentLastHour)} message${s.sentLastHour > 1 ? 's' : ''} envoyé${s.sentLastHour > 1 ? 's' : ''} cette heure (limite ${escapeHtml(s.maxPerHour)})</p></div></div><button class="tx-button" type="button" id="waLogout">Délier</button></div>
          <form id="waTest" class="wa-form"><div class="field"><label for="waTestPhone">Envoyer un message de test</label><input id="waTestPhone" type="tel" inputmode="tel" placeholder="+229 01 97 12 34 56" required></div><button class="button secondary" type="submit">Envoyer le test</button></form>
          <p class="tx-wa-note">Les codes de connexion peuvent désormais être reçus sur WhatsApp par les utilisateurs dont le numéro est renseigné avec l’indicatif. L’e-mail reste disponible en secours.</p>`;
      } else if (s.status === 'pairing') {
        body = `<div class="wa-code" aria-live="polite">${escapeHtml(s.pairingCode || '')}</div>${steps('Touchez <strong>Connecter avec le numéro de téléphone</strong>, puis saisissez ce code.')}<p class="tx-wa-note">Le code expire au bout de quelques minutes. La page se met à jour toute seule.</p><button class="button secondary small" id="waCancel">Annuler</button>`;
      } else if (s.status === 'qr') {
        body = `<div class="wa-qr">${s.qr ? `<img src="${escapeHtml(s.qr)}" width="240" height="240" alt="QR code de liaison WhatsApp">` : '<div class="loading-state">Préparation du QR code…</div>'}</div>${steps('Scannez ce QR code.')}<button class="button secondary small" id="waCancel">Annuler</button>`;
      } else if (s.status === 'connecting') {
        body = `<div class="loading-state" style="padding:24px">Connexion à WhatsApp…</div>${s.slow ? '<p class="tx-wa-note">WhatsApp met du temps à répondre. Vérifiez le réseau du serveur ou recommencez dans quelques minutes.</p>' : ''}<button class="button secondary small" id="waCancel">Annuler</button>`;
      } else {
        body = `<div class="notice warning"><strong>Numéro dédié uniquement.</strong> Cette liaison utilise un client WhatsApp non officiel : WhatsApp peut restreindre ou bannir le numéro. N’utilisez jamais un numéro personnel ou professionnel important.</div>
          <form id="waLinkCode" class="wa-form"><div class="field"><label for="waPhone">Numéro WhatsApp de TRAXO</label><input id="waPhone" type="tel" inputmode="tel" value="+229 01 40 05 67 66" required></div><button class="button primary" type="submit">Recevoir un code de liaison</button></form>
          <p class="tx-wa-note">Ou, si l’ordinateur est à côté du téléphone : <button class="button secondary small" id="waLinkQr" type="button">Afficher un QR code</button></p>`;
      }
      box.innerHTML = `${heading('WhatsApp TRAXO', 'Le numéro qui envoie les codes de connexion. Réservé à l’administrateur de la plateforme.', '', 'Plateforme')}
        <section class="tx-panel"><div class="tx-panel-body tx-wa">${s.lastError && s.status !== 'connected' ? `<div class="notice error">${escapeHtml(s.lastError)}</div>` : ''}${body}</div></section>`;
      box.querySelector('#waLinkCode')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await post('/api/app/whatsapp/link', { method: 'code', phone: box.querySelector('#waPhone').value }); } catch (error) { uiToast(error.message, 'error'); }
        paint();
      });
      box.querySelector('#waLinkQr')?.addEventListener('click', async () => {
        try { await post('/api/app/whatsapp/link', { method: 'qr' }); } catch (error) { uiToast(error.message, 'error'); }
        paint();
      });
      box.querySelector('#waCancel')?.addEventListener('click', async () => { await post('/api/app/whatsapp/cancel').catch(() => {}); paint(); });
      box.querySelector('#waLogout')?.addEventListener('click', async () => {
        if (!(await uiConfirm('Délier ce numéro WhatsApp ?', { message: 'Les codes ne pourront plus être envoyés sur WhatsApp tant qu’un numéro n’est pas relié à nouveau.', tone: 'danger', confirmLabel: 'Délier' }))) return;
        try { await post('/api/app/whatsapp/logout'); uiToast('Numéro délié.', 'success'); } catch (error) { uiToast(error.message, 'error'); }
        paint();
      });
      box.querySelector('#waTest')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const button = e.target.querySelector('button');
        button.disabled = true;
        try { await post('/api/app/whatsapp/test', { phone: box.querySelector('#waTestPhone').value }); uiToast('Message de test envoyé.', 'success'); } catch (error) { uiToast(error.message, 'error'); }
        button.disabled = false;
      });
      if (['qr', 'pairing', 'connecting'].includes(s.status)) timer = setTimeout(paint, 3000);
    }
    await paint();
  }

  // ---- Double authentification -----------------------------------------
  const mfaCodeField = (id, label = 'Code à 6 chiffres') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" class="mfa-input" inputmode="numeric" autocomplete="one-time-code" maxlength="9" placeholder="123 456" required></div>`;

  function showRecoveryCodes(codes, onDone) {
    const text = `Codes de secours TRAXO (${context.user.email})\nChaque code ne fonctionne qu’une fois.\n\n${codes.join('\n')}\n`;
    const modal = openModal('Vos codes de secours',
      `<p class="subtitle" style="margin:0 0 14px">Gardez-les en lieu sûr : ils permettent de vous connecter si vous perdez votre téléphone. <strong>Ils ne seront plus affichés.</strong></p>
       <ol class="mfa-codes">${codes.map((code) => `<li>${escapeHtml(code)}</li>`).join('')}</ol>
       <div class="mfa-code-acts"><button type="button" class="button secondary small" id="mfaCopy">Copier</button><button type="button" class="button secondary small" id="mfaDownload">Télécharger (.txt)</button></div>`,
      '<button class="button primary" type="button" id="mfaDone">J’ai enregistré mes codes</button>');
    modal.backdrop.querySelector('#mfaCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); uiToast('Codes copiés.', 'success'); } catch { uiToast('Copie impossible : utilisez le téléchargement.', 'warning'); }
    });
    modal.backdrop.querySelector('#mfaDownload').addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      link.download = 'traxo-codes-de-secours.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
    modal.backdrop.querySelector('#mfaDone').addEventListener('click', () => { modal.close(); onDone(); });
  }

  async function openMfaSetup(onDone) {
    let setup;
    try { setup = await api('/api/app/account/2fa/setup', { method: 'POST' }); }
    catch (error) { uiToast(error.message, 'error'); return; }
    const modal = openModal('Activer la double authentification',
      `<ol class="mfa-steps">
         <li><strong>Installez une application d’authentification</strong><span>Google Authenticator, Microsoft Authenticator, Authy ou 1Password.</span></li>
         <li><strong>Scannez ce QR code</strong><span>Ou saisissez la clé manuellement.</span>
           <div class="mfa-qr">${setup.qrSvg}</div>
           <div class="mfa-secret"><code>${escapeHtml(setup.secret)}</code><button type="button" class="button secondary small" id="mfaCopySecret">Copier la clé</button></div></li>
         <li><strong>Saisissez le code affiché</strong><form id="mfaEnableForm">${mfaCodeField('mfaEnableCode')}</form></li>
       </ol><div id="modalResult"></div>`,
      '<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button primary" type="submit" form="mfaEnableForm">Activer</button>');
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    modal.backdrop.querySelector('#mfaCopySecret').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(setup.secret.replace(/\s+/g, '')); uiToast('Clé copiée.', 'success'); } catch { uiToast('Copie impossible.', 'warning'); }
    });
    modal.backdrop.querySelector('#mfaEnableForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = modal.backdrop.querySelector('button.primary');
      button.disabled = true;
      try {
        const result = await api('/api/app/account/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: modal.backdrop.querySelector('#mfaEnableCode').value }) });
        modal.close();
        uiToast('Double authentification activée.', 'success');
        showRecoveryCodes(result.recoveryCodes, onDone);
      } catch (error) {
        modal.backdrop.querySelector('#modalResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        button.disabled = false;
      }
    });
    setTimeout(() => modal.backdrop.querySelector('#mfaEnableCode')?.focus(), 50);
  }

  function openMfaDisable(onDone) {
    const modal = openModal('Désactiver la double authentification',
      `<p class="subtitle" style="margin:0 0 14px">Votre compte ne sera plus protégé que par le mot de passe.</p>
       <form id="mfaDisableForm"><div class="field"><label for="mfaDisablePwd">Mot de passe</label><input id="mfaDisablePwd" type="password" autocomplete="current-password" required></div>${mfaCodeField('mfaDisableCode', 'Code à 6 chiffres ou code de secours')}</form><div id="modalResult"></div>`,
      '<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button danger-solid" type="submit" form="mfaDisableForm">Désactiver</button>');
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    modal.backdrop.querySelector('#mfaDisableForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = modal.backdrop.querySelector('button.danger-solid');
      button.disabled = true;
      try {
        await api('/api/app/account/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: modal.backdrop.querySelector('#mfaDisablePwd').value, code: modal.backdrop.querySelector('#mfaDisableCode').value }) });
        modal.close();
        uiToast('Double authentification désactivée.', 'success');
        onDone();
      } catch (error) {
        modal.backdrop.querySelector('#modalResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        button.disabled = false;
      }
    });
  }

  function openMfaNewCodes(onDone) {
    const modal = openModal('Générer de nouveaux codes de secours',
      `<p class="subtitle" style="margin:0 0 14px">Les anciens codes ne fonctionneront plus.</p><form id="mfaCodesForm">${mfaCodeField('mfaCodesCode')}</form><div id="modalResult"></div>`,
      '<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button primary" type="submit" form="mfaCodesForm">Générer</button>');
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    modal.backdrop.querySelector('#mfaCodesForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await api('/api/app/account/2fa/recovery-codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: modal.backdrop.querySelector('#mfaCodesCode').value }) });
        modal.close();
        showRecoveryCodes(result.recoveryCodes, onDone);
      } catch (error) {
        modal.backdrop.querySelector('#modalResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      }
    });
  }

  function openPasswordModal(onDone) {
    const modal = openModal('Modifier le mot de passe',
      `<form id="pwdForm"><label class="tx-field" for="pwdCurrent">Mot de passe actuel<input id="pwdCurrent" name="currentPassword" type="password" autocomplete="current-password" required></label><label class="tx-field" for="pwdNew">Nouveau mot de passe<input id="pwdNew" name="newPassword" type="password" autocomplete="new-password" minlength="10" required><small>10 caractères minimum.</small></label><label class="tx-field" for="pwdConfirm">Confirmez le nouveau mot de passe<input id="pwdConfirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="10" required></label></form><p class="tx-dialog-note">Par sécurité, vos autres sessions seront déconnectées.</p><p class="tx-error" id="pwdErr" role="alert" hidden></p>`,
      '<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button primary" type="submit" form="pwdForm">Enregistrer</button>', { className: 'tx-modal' });
    const err = modal.backdrop.querySelector('#pwdErr');
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    modal.backdrop.querySelector('#pwdForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.currentTarget));
      if (data.newPassword !== data.confirmPassword) { err.textContent = 'Les deux nouveaux mots de passe ne correspondent pas.'; err.hidden = false; return; }
      const btn = modal.backdrop.querySelector('button.primary'); btn.disabled = true;
      try {
        await api('/api/app/account/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword }) });
        modal.close();
        uiToast('Mot de passe mis à jour. Vos autres sessions ont été fermées.', 'success');
        onDone();
      } catch (error) { err.textContent = error.message; err.hidden = false; btn.disabled = false; }
    });
    setTimeout(() => modal.backdrop.querySelector('#pwdCurrent')?.focus(), 50);
  }

  async function openSessionsModal(onDone) {
    const modal = openModal('Vos sessions actives',
      '<p class="tx-dialog-intro">Les appareils actuellement connectés à votre compte. Fermez ceux que vous ne reconnaissez pas.</p><div id="sessList"><div class="loading-state">Chargement…</div></div>',
      '<button class="button secondary" type="button" id="sessOthers" hidden>Fermer les autres sessions</button><button class="button primary" data-modal-close type="button">Fermer</button>', { className: 'tx-modal' });
    const close = () => { modal.close(); onDone(); };
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', close);
    modal.backdrop.querySelector('.modal-close').addEventListener('click', onDone);
    const device = (ua) => {
      if (!ua) return { icon: 'monitor', label: 'Appareil inconnu' };
      const browser = /edg\//i.test(ua) ? 'Edge' : /opr\/|opera/i.test(ua) ? 'Opera' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Navigateur';
      const os = /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iPhone / iPad' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : '';
      return { icon: /mobile|android|iphone/i.test(ua) ? 'smartphone' : 'monitor', label: os ? `${browser} · ${os}` : browser };
    };
    async function paint() {
      const listBox = modal.backdrop.querySelector('#sessList');
      if (!listBox) return;
      try {
        const list = await api('/api/app/account/sessions');
        const others = list.filter((s) => !s.current).length;
        modal.backdrop.querySelector('#sessOthers').hidden = others === 0;
        listBox.innerHTML = list.length ? `<div class="tx-session-list">${list.map((s) => {
          const d = device(s.userAgent);
          return `<div class="tx-session">${txIcon(d.icon)}<div><strong>${escapeHtml(d.label)}</strong><p>Ouverte le ${escapeHtml(formatDate(s.createdAt))} · expire le ${escapeHtml(formatDateOnly(s.expiresAt))}</p>${s.current ? '<span class="tx-badge tx-badge-green">Cet appareil</span>' : ''}</div>${s.current ? '' : `<button type="button" class="tx-text-button" data-close-session="${escapeHtml(s.id)}">Fermer</button>`}</div>`;
        }).join('')}</div>` : '<div class="notice">Aucune session active.</div>';
        listBox.querySelectorAll('[data-close-session]').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true;
          try { await api('/api/app/account/sessions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.closeSession }) }); uiToast('Session fermée.', 'success'); paint(); } catch (error) { uiToast(error.message, 'error'); b.disabled = false; }
        }));
      } catch (error) { listBox.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`; }
    }
    modal.backdrop.querySelector('#sessOthers').addEventListener('click', async (event) => {
      if (!(await uiConfirm('Fermer toutes les autres sessions ?', { message: 'Les autres appareils devront se reconnecter, avec un code de vérification.', tone: 'danger', confirmLabel: 'Fermer les autres sessions' }))) return;
      event.currentTarget.disabled = true;
      try { const r = await api('/api/app/account/sessions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'others' }) }); uiToast(r.closed ? `${txPlural(r.closed, 'session fermée', 'sessions fermées')}.` : 'Aucune autre session à fermer.', 'success'); } catch (error) { uiToast(error.message, 'error'); }
      event.currentTarget.disabled = false;
      paint();
    });
    paint();
  }

  await load();
}

const opsIco = {
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  form: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v3"/><path d="M9 13h4"/><path d="M9 17h2"/><path d="M17 15v4"/><path d="M15 17h4"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  ride: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17" r="3"/><circle cx="18.5" cy="17" r="3"/><path d="M8.5 17h7l3-6h2"/><path d="M6 11h6l2 3"/><path d="M12 7h3l1 2"/></svg>',
};

// ---- Espace de travail Opérations (table type ClickUp) : utilitaires ----
const crmIcons = {
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.5V19l4 2v-8.5z"/></svg>',
  group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M6 12h12M10 18h4"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
};

function crmInitials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}
// Numéro métier lisible : la référence CMD-AAAA-NNNN si présente, sinon repli
// sur l'identifiant technique.
// Charge d'un livreur, lisible sans calcul : « 25 colis · capacité 3 ».
function colisCount(n) { const v = Number(n) || 0; return v === 0 ? 'aucun colis' : `${v} colis`; }
function loadText(active, capacity) { return `${colisCount(active)} · capacité ${Number(capacity) || 0}`; }
function orderCode(reference, id) {
  return reference || `CMD-${id}`;
}
function crmAvatar(name, opts) {
  if (!name) return '<span class="crm-muted">—</span>';
  const o = opts || {};
  const badge = o.photoUrl
    ? `<span class="crm-av-badge crm-av-photo"><img src="${escapeHtml(o.photoUrl)}" alt="" loading="lazy"></span>`
    : `<span class="crm-av-badge">${escapeHtml(crmInitials(name))}</span>`;
  const dotState = o.online === 'online' ? 'online' : o.online === 'stale' ? 'stale' : '';
  const dot = o.online != null
    ? `<span class="crm-av-dot ${dotState}" title="${o.online === 'online' ? 'En ligne' : o.online === 'stale' ? 'Signal ancien' : 'Hors ligne'}"></span>`
    : '';
  return `<span class="crm-av"><span class="crm-av-wrap">${badge}${dot}</span>${escapeHtml(name)}</span>`;
}
function crmChip(label, color) {
  if (label == null || label === '') return '<span class="crm-muted">—</span>';
  return `<span class="crm-chip crm-${color || crmChipColor(label)}">${escapeHtml(label)}</span>`;
}
function crmChipColor(label) {
  const s = String(label).toLowerCase();
  if (/livr|résol|resolu|validé|valide|terminé|convert|complèt|complet|payé|disponible/.test(s)) return 'green';
  if (/incident|échec|echec|ouvert|retard|haute|urgent|perdu|endommag|impossible|refus/.test(s)) return 'red';
  if (/attente|à valider|a valider|préparation|preparation|qualifi|planifi|brouillon\b/.test(s)) return 'amber';
  if (/cours|livraison|récupér|recuper|tournée|confirm|nouveau|projection|suivi|escalad/.test(s)) return 'blue';
  if (/brouillon|archiv|annul|non partag/.test(s)) return 'grey';
  return 'grey';
}
const crmOrderSeq = ['En préparation', 'Confirmée', 'Vers la collecte', 'Récupérée', 'En tournée', 'En livraison', 'Arrivée', 'Livrée'];
function crmOrderStatusColor(status) {
  const map = { 'Livrée': 'green', 'Confirmée': 'amber', 'En préparation': 'amber', 'Vers la collecte': 'amber', 'Récupérée': 'blue', 'En tournée': 'blue', 'En livraison': 'blue', 'Arrivée': 'blue', 'Brouillon': 'grey', 'Échec': 'red', 'Retour': 'amber', 'Retournée': 'grey', 'Annulée': 'grey' };
  return map[status] || 'grey';
}
function crmOrderProgress(status) {
  if (status === 'Livrée') return { pct: 100, tone: '' };
  if (['Annulée', 'Retournée'].includes(status)) return { pct: 100, tone: 'grey' };
  if (['Échec', 'Retour'].includes(status)) return { pct: 45, tone: 'red' };
  const i = crmOrderSeq.indexOf(status);
  return { pct: i < 0 ? 8 : Math.max(8, Math.round((i / (crmOrderSeq.length - 1)) * 100)), tone: '' };
}
function crmProgressBar(pct, tone) {
  return `<span class="crm-prog"><i class="${tone || ''}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>`;
}
// Demandes : dérivations depuis les données réelles (pas de champ inventé).
function reqShared(r) { return r.location_lat != null && r.location_lng != null && Number.isFinite(Number(r.location_lat)); }
function reqValidated(r) { return r.status === 'Confirmée' || r.validated_at != null; }
// Mini-stepper (suivi incident) : n segments, remplis jusqu'à `done`.
function crmMiniSteps(done, total, tone) {
  let html = '';
  for (let i = 0; i < total; i += 1) {
    const on = i < done;
    html += `${i ? `<span class="crm-ms-line ${on ? tone || 'ok' : ''}"></span>` : ''}<span class="crm-ms-dot ${on ? tone || 'ok' : ''}"></span>`;
  }
  return `<span class="crm-ms">${html}</span>`;
}

// Panneau détail coulissant d'une commande (données réelles).
// Tiroir d'une commande : résumé + TOUTES les actions (plus de page séparée).
// Le contenu défile ; un menu collant permet de sauter à chaque section.
// opts.onChange : rappelé après une action (rafraîchit la liste).
// Modifier le colis et la collecte d'une commande (avant la récupération du colis).
function openPickupEditor(o, onSaved) {
  const has = Boolean(o.pickup_address || o.pickup_name || o.pickup_lat != null);
  const modal = openModal('Colis et collecte', `<form id="pkForm" class="pk-form" novalidate>
      <div class="field"><label>Type de colis</label><select name="packageType"><option value="">Non précisé</option>${packageTypeOptions.map(([v, l]) => `<option value="${v}" ${o.package_type === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></div>
      <div class="field"><label>Contenu</label><input name="packageDescription" maxlength="240" value="${escapeHtml(o.package_description || '')}" placeholder="Ex. 2 robes dans un sac"></div>
      <label class="pk-check"><input type="checkbox" name="pickupEnabled" ${has ? 'checked' : ''}> Le colis est à récupérer ailleurs</label>
      <div id="pkFields" ${has ? '' : 'hidden'}>
        <div class="field"><label>Nom du lieu</label><input name="pickupName" maxlength="120" value="${escapeHtml(o.pickup_name || '')}" placeholder="Ex. Boutique Awa"></div>
        <div class="field"><label>Quartier ou repère</label><input name="pickupAddress" maxlength="240" value="${escapeHtml(o.pickup_address || '')}" placeholder="Ex. Dantokpa, allée des tissus"></div>
        <div class="field"><label>Téléphone sur place</label><input name="pickupPhone" type="tel" maxlength="30" value="${escapeHtml(o.pickup_phone || '')}"></div>
        <div class="field"><label>Colis prêt à partir de</label><input name="pickupReady" maxlength="80" value="${escapeHtml(o.pickup_ready || '')}" placeholder="Ex. 14 h"></div>
        ${o.pickup_lat != null ? '<p class="muted">La position exacte enregistrée est conservée.</p>' : ''}
      </div>
      <div id="pkError" role="alert"></div>
    </form>`, '<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button primary" id="pkSave" type="button">Enregistrer</button>');
  const form = modal.backdrop.querySelector('#pkForm');
  form.pickupEnabled.addEventListener('change', () => { modal.backdrop.querySelector('#pkFields').hidden = !form.pickupEnabled.checked; });
  modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
  modal.backdrop.querySelector('#pkSave').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const body = {
      packageType: data.packageType || undefined, packageDescription: data.packageDescription,
      pickupEnabled: form.pickupEnabled.checked, pickupName: data.pickupName, pickupAddress: data.pickupAddress,
      pickupPhone: data.pickupPhone, pickupPhoneCountry: 'BJ', pickupReady: data.pickupReady,
      pickupLat: o.pickup_lat, pickupLng: o.pickup_lng,
    };
    button.disabled = true;
    try {
      await api(`/api/app/orders/${encodeURIComponent(o.id)}/pickup`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      modal.close();
      uiToast('Colis et collecte mis à jour.', 'success');
      onSaved();
    } catch (error) {
      modal.backdrop.querySelector('#pkError').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });
}

async function openOrderDrawer(orderId, opts = {}) {
  const existing = document.querySelector('.crm-drawer-wrap');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.className = 'crm-drawer-wrap';
  wrap.innerHTML = '<div class="crm-drawer-backdrop"></div><aside class="crm-drawer wide" role="dialog" aria-modal="true" aria-label="Commande"><div class="loading-state" style="padding:40px">Chargement…</div></aside>';
  const drawer = wrap.querySelector('.crm-drawer');
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event) => { if (event.key === 'Escape' && !event.target.closest('input, textarea, select')) close(); };
  wrap.querySelector('.crm-drawer-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));

  const secIc = {
    client: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 17V5H2v12"/><path d="M14 9h4l4 4v4h-6"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
    track: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  };

  const paint = async (scrollTop = 0) => {
    const o = await api(`/api/app/orders/${encodeURIComponent(orderId)}`);
    const zone = o.neighborhood || o.landmark || '—';
    // delivery_address reprend déjà zone + repère (+ consigne) pour les commandes
    // issues d'une demande : on ne le concatène plus, pour éviter les doublons.
    const place = [o.neighborhood, o.landmark].filter(Boolean).join(' · ');
    const address = place || o.delivery_address || '—';
    const instructions = o.notes || '—';
    const rank = crmOrderSeq.indexOf(o.status);
    const eventFor = (status) => (o.events || []).find((e) => e.to_status === status);
    const steps = [
      { label: 'Confirmée', at: eventFor('Confirmée') },
      { label: 'Récupérée', at: eventFor('Récupérée') },
      { label: 'En livraison', at: eventFor('En livraison') },
      { label: 'Livrée', at: eventFor('Livrée') },
    ];
    const stepRank = [1, 2, 4, 6];
    const stepsHtml = steps.map((step, idx) => {
      const done = rank >= stepRank[idx];
      return `<div class="crm-step ${done ? 'done' : ''}"><span class="crm-step-dot">${done ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span><strong>${escapeHtml(step.label)}</strong><small>${step.at ? escapeHtml(formatDate(step.at.created_at)) : '—'}</small></div>`;
    }).join('');
    const history = (o.events || []).slice().reverse().map((e) => `<li><span class="crm-hist-dot ${e.to_status === 'Livrée' ? 'ok' : ''}"></span><div><strong>${escapeHtml(formatDate(e.created_at))}</strong><span>${escapeHtml(e.to_status || '')}${e.from_status ? ` <em class="crm-muted">depuis ${escapeHtml(e.from_status)}</em>` : ''}${e.reason ? ` — ${escapeHtml(e.reason)}` : ''}</span><small>${escapeHtml(e.actor_name || 'Système')}</small></div></li>`).join('') || '<li class="crm-muted">Aucun événement.</li>';
    const evidence = (o.evidence || []).length ? (o.evidence || []).map((f) => `<span class="crm-file">${escapeHtml(f.evidence_type === 'signature' ? 'Signature' : 'Photo')}</span>`).join(' ') : '—';
    const phone = String(o.customer_phone || '').replace(/[^+\d]/g, '');
    const creator = (o.events && o.events.length) ? o.events[0].actor_name : null;
    const canAdvance = !o.isTerminal && (o.allowedTransitions || []).length > 0;
    const linkUsable = ['active', 'terminal'].includes(o.trackingLink?.state);
    drawer.innerHTML = `
      <div class="crm-drawer-head">
        <div><div class="crm-drawer-title">${escapeHtml(orderCode(o.reference, o.id))} ${crmChip(o.status, crmOrderStatusColor(o.status))}</div>
          <small>Créée le ${escapeHtml(formatDate(o.created_at))}${creator ? ` par ${escapeHtml(creator)}` : ''}</small></div>
        <div class="crm-drawer-headact">
          ${opts.onBack ? `<button class="crm-icobtn od-back" type="button" id="odBack" title="${escapeHtml(opts.backLabel || 'Retour')}" aria-label="${escapeHtml(opts.backLabel || 'Retour')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>` : ''}
          <button class="crm-drawer-close crm-icobtn" type="button" aria-label="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <nav class="od-nav" aria-label="Sections de la commande"></nav>
      <div class="crm-drawer-body">
        <section data-od="Résumé"><div class="crm-sec-head"><h4><span class="crm-sec-ic">${secIc.client}</span>Client</h4><a class="crm-seclink" href="/app/clients">Voir le client</a></div>
          <div class="crm-kv"><span>Nom</span><strong>${escapeHtml(o.customer_name || '—')}</strong></div>
          <div class="crm-kv"><span>Téléphone</span><strong>${phone ? `<a href="tel:${escapeHtml(phone)}">${escapeHtml(o.customer_phone)}</a>` : '—'}</strong></div>
          <div class="crm-kv"><span>Adresse</span><strong>${escapeHtml(address)}</strong></div>
        </section>
        <section><h4><span class="crm-sec-ic">${secIc.truck}</span>Livraison</h4>
          <div class="crm-kv"><span>Zone</span><strong>${escapeHtml(zone)}</strong></div>
          <div class="crm-kv"><span>Livreur</span><strong>${o.driver_name ? crmAvatar(o.driver_name, { photoUrl: o.driver_photo, online: o.driver_online }) : '—'}${o.driver_vehicle_type ? ` <span class="crm-muted">· ${escapeHtml(o.driver_vehicle_type)}</span>` : ''}</strong></div>
          <div class="crm-kv"><span>Créneau</span><strong>${escapeHtml(o.requested_time || '—')}</strong></div>
        </section>
        <section><div class="crm-sec-head"><h4><span class="crm-sec-ic">${secIc.doc}</span>Colis et collecte</h4>${['En préparation', 'Confirmée', 'Vers la collecte'].includes(o.status) ? '<button class="crm-seclink" type="button" id="odEditPickup">Modifier</button>' : ''}</div>
          <div class="crm-kv"><span>Colis</span><strong>${escapeHtml([packageTypeLabels[o.package_type], o.package_description].filter(Boolean).join(' · ') || '—')}</strong></div>
          ${o.pickup_address || o.pickup_name || o.pickup_lat != null ? `<div class="crm-kv"><span>Collecte</span><strong>${escapeHtml([o.pickup_name, o.pickup_address].filter(Boolean).join(' · ') || 'Position sur la carte')}${o.pickup_ready ? ` <span class="crm-muted">· prêt à ${escapeHtml(o.pickup_ready)}</span>` : ''}</strong></div>
          ${o.pickup_phone ? `<div class="crm-kv"><span>Sur place</span><strong><a href="tel:${escapeHtml(String(o.pickup_phone).replace(/[^+\d]/g, ''))}">${escapeHtml(o.pickup_phone)}</a></strong></div>` : ''}`
          : '<div class="crm-kv"><span>Collecte</span><strong>Le colis part de chez vous</strong></div>'}
        </section>
        <section><h4><span class="crm-sec-ic">${secIc.track}</span>Suivi de la commande</h4><div class="crm-steps">${stepsHtml}</div></section>
        <section><h4><span class="crm-sec-ic">${secIc.doc}</span>Détails de la commande</h4>
          <div class="crm-kv"><span>Instructions</span><strong>${escapeHtml(instructions)}</strong></div>
          <div class="crm-kv"><span>Pièces jointes</span><strong>${evidence}</strong></div>
        </section>
        <div class="od-actions" id="odActions"><div class="loading-state">Chargement des actions…</div></div>
        <section data-od="Historique" id="odHistory"><h4><span class="crm-sec-ic">${secIc.note}</span>Historique</h4><ul class="crm-hist">${history}</ul></section>
      </div>
      <div class="crm-drawer-foot">
        ${linkUsable ? '<button class="button secondary" type="button" id="odCopyLink">Copier le lien de suivi</button>' : '<button class="button secondary" type="button" id="odGoIncident">Déclarer un incident</button>'}
        ${canAdvance ? '<button class="button primary" type="button" id="odAdvance">Mettre à jour le statut</button>' : '<button class="button primary" type="button" id="odGoHistory">Voir l’historique</button>'}
      </div>`;
    drawer.querySelector('.crm-drawer-close').addEventListener('click', close);
    drawer.querySelector('#odBack')?.addEventListener('click', () => { close(); opts.onBack(); });
    drawer.querySelector('#odEditPickup')?.addEventListener('click', () => openPickupEditor(o, () => paint(drawer.querySelector('.crm-drawer-body')?.scrollTop || 0)));
    const body = drawer.querySelector('.crm-drawer-body');
    await mountOrderActions(drawer.querySelector('#odActions'), o.id, {
      order: o,
      refresh: async () => {
        await paint(body.scrollTop);
        if (typeof opts.onChange === 'function') opts.onChange();
      },
    });
    // Sections d'action : titre = entrée du menu.
    drawer.querySelectorAll('#odActions > section.card').forEach((section) => {
      const title = section.querySelector('h2')?.textContent || '';
      const short = /statut/i.test(title) ? 'Statut' : /Changer de livreur/i.test(title) ? 'Livreur' : /suivi/i.test(title) ? 'Lien client'
        : /Paiement/i.test(title) ? 'Paiement' : /Incidents/i.test(title) ? 'Incidents' : /code|Preuve/i.test(title) ? 'Preuves' : '';
      if (short && !drawer.querySelector(`[data-od="${short}"]`)) section.dataset.od = short;
    });
    const sections = [...body.querySelectorAll('[data-od]')];
    const nav = drawer.querySelector('.od-nav');
    nav.innerHTML = sections.map((section, i) => `<button type="button" data-i="${i}">${escapeHtml(section.dataset.od)}</button>`).join('');
    const goTo = (section, focus) => {
      if (!section) return;
      body.scrollTo({ top: section.offsetTop - body.offsetTop - 8, behavior: 'smooth' });
      if (focus) setTimeout(() => section.querySelector(focus)?.focus({ preventScroll: true }), 350);
    };
    // Menu : met en évidence la section visible (ligne de repère au tiers
    // du panneau, pour que les dernières sections soient aussi reconnues).
    let pinnedUntil = 0;
    const setActive = (current) => nav.querySelectorAll('button').forEach((button, i) => button.classList.toggle('on', i === current));
    const markActive = () => {
      if (Date.now() < pinnedUntil) return;
      const line = body.scrollTop + body.clientHeight * 0.3;
      let current = 0;
      sections.forEach((section, i) => { if (section.offsetTop - body.offsetTop <= line) current = i; });
      setActive(current);
    };
    nav.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
      const i = Number(button.dataset.i);
      pinnedUntil = Date.now() + 900;
      setActive(i);
      goTo(sections[i]);
    }));
    body.addEventListener('scroll', markActive, { passive: true });
    const byName = (name) => sections.find((section) => section.dataset.od === name);
    drawer.querySelector('#odAdvance')?.addEventListener('click', () => goTo(byName('Statut'), 'select'));
    drawer.querySelector('#odGoHistory')?.addEventListener('click', () => goTo(byName('Historique')));
    drawer.querySelector('#odGoIncident')?.addEventListener('click', () => goTo(byName('Incidents'), 'textarea'));
    drawer.querySelector('#odCopyLink')?.addEventListener('click', () => {
      goTo(byName('Lien client'));
      drawer.querySelector('#revealTrackingLink')?.click();
    });
    body.scrollTop = scrollTop;
    markActive();
    if (opts.focusSection && !scrollTop) {
      const target = byName(opts.focusSection);
      opts.focusSection = null;
      if (target) {
        pinnedUntil = Date.now() + 1500;
        setActive(sections.indexOf(target));
        setTimeout(() => goTo(target, 'textarea'), 260);
      }
    }
  };

  try {
    await paint();
  } catch (error) {
    drawer.innerHTML = `<div class="crm-drawer-head"><div class="crm-drawer-title">Erreur</div><button class="crm-drawer-close" type="button">✕</button></div><div class="crm-drawer-body"><div class="notice error">${escapeHtml(error.message)}</div></div>`;
    drawer.querySelector('.crm-drawer-close').addEventListener('click', close);
  }
}

// « Nouvel incident » : un incident se déclare toujours sur une commande.
// On choisit la commande, puis son tiroir s'ouvre directement sur Incidents.
async function pickOrderForIncident(onChange) {
  const modal = openModal('Déclarer un incident', `<p class="subtitle" style="margin:0 0 12px">Choisissez la commande concernée.</p>
    <label class="crm-search pick-search"><span>${fleetIcons.search}</span><input type="search" id="pickOrderQ" placeholder="Client, numéro, quartier, livreur…" autocomplete="off"></label>
    <ul class="pick-list" id="pickOrderList"><li class="crm-muted">Chargement…</li></ul>`);
  let orders = [];
  try { orders = (await api('/api/app/orders')).filter((o) => !['Livrée', 'Retournée', 'Annulée'].includes(o.status)); } catch (error) { orders = []; }
  const list = modal.backdrop.querySelector('#pickOrderList');
  const draw = (q) => {
    const rows = orders.filter((o) => `${o.reference || ''} ${o.id} ${o.customer_name || ''} ${o.neighborhood || ''} ${o.driver_name || ''}`.toLowerCase().includes(q)).slice(0, 30);
    list.innerHTML = rows.length ? rows.map((o) => `<li><button type="button" data-id="${escapeHtml(o.id)}"><span><strong>${escapeHtml(o.customer_name || 'Client')}</strong><small>${escapeHtml(orderCode(o.reference, o.id))} · ${escapeHtml(o.neighborhood || o.landmark || '—')}${o.driver_name ? ` · ${escapeHtml(o.driver_name)}` : ''}</small></span>${crmChip(o.status, crmOrderStatusColor(o.status))}</button></li>`).join('')
      : '<li class="crm-muted">Aucune commande en cours ne correspond.</li>';
    list.querySelectorAll('button[data-id]').forEach((button) => button.addEventListener('click', () => {
      modal.close();
      openOrderDrawer(button.dataset.id, { onChange, focusSection: 'Incidents' });
    }));
  };
  draw('');
  const input = modal.backdrop.querySelector('#pickOrderQ');
  input.addEventListener('input', () => draw(input.value.trim().toLowerCase()));
  input.focus();
}

// Tiroir d'une tournée : aperçu (avancement, carte des arrêts), ordre de passage
// (glisser-déposer enregistré aussitôt, optimisation sur routes réelles),
// colis du livreur restés hors tournée, historique ; l'état se change depuis le
// pied du tiroir. Remplace l'ancienne page /app/tournees/:id.
// opts.onChange : rappelé après une action (rafraîchit la liste).
const runTerminalOrderStatuses = ['Livrée', 'Retournée', 'Annulée'];
const runActionLabels = {
  planned: 'Planifier la tournée', active: 'Démarrer la tournée', completed: 'Terminer la tournée',
  draft: 'Repasser en préparation', cancelled: 'Annuler la tournée',
};
const runStatusTone = { draft: 'grey', planned: 'indigo', active: 'blue', completed: 'green', cancelled: 'grey' };

async function openRunDrawer(runId, opts = {}) {
  const existing = document.querySelector('.crm-drawer-wrap');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.className = 'crm-drawer-wrap';
  wrap.innerHTML = '<div class="crm-drawer-backdrop"></div><aside class="crm-drawer wide" role="dialog" aria-modal="true" aria-label="Tournée"><div class="loading-state" style="padding:40px">Chargement…</div></aside>';
  const drawer = wrap.querySelector('.crm-drawer');
  let miniMap = null;
  const close = () => { if (miniMap) { miniMap.remove(); miniMap = null; } wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event) => { if (event.key === 'Escape' && !event.target.closest('input, textarea, select')) close(); };
  wrap.querySelector('.crm-drawer-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));

  const ic = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
    stops: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H12"/></svg>',
    add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M12 12v6M9 15h6"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 4-1 3M20 9l-3 1M18 4l-2 2M3 21l11-11"/><path d="m12 7 5 5"/></svg>',
  };
  let notice = null;
  const refreshList = () => { if (typeof opts.onChange === 'function') opts.onChange(); };

  const eventText = (run, event) => {
    const d = event.details || {};
    if (event.event_type === 'status_changed') return `${runStatusLabels[d.fromStatus] || d.fromStatus} → ${runStatusLabels[d.toStatus] || d.toStatus}${d.reason ? ` · ${d.reason}` : ''}`;
    if (event.event_type === 'order_added') return `Commande n° ${d.orderId} ajoutée (arrêt ${d.sequence})`;
    if (event.event_type === 'order_removed') return `Commande n° ${d.orderId} retirée`;
    if (event.event_type === 'stops_reordered') return d.method === 'osrm_road_network' ? 'Itinéraire optimisé sur routes réelles' : `${d.stopIds?.length || 0} arrêts réordonnés`;
    return `${run.driver_name} · ${formatDateOnly(run.service_date)}`;
  };

  const paint = async (scrollTop = 0) => {
    const run = await api(`/api/app/runs/${encodeURIComponent(runId)}`);
    const stops = run.stops || [];
    const done = stops.filter((stop) => runTerminalOrderStatuses.includes(stop.order_status)).length;
    const noGps = stops.filter((stop) => stop.destination_lat == null || stop.destination_lng == null).length;
    const pct = stops.length ? Math.round((done / stops.length) * 100) : 0;
    const canReorder = run.canReorderStops && stops.length > 1;
    const eligible = run.canEditStops ? (run.eligibleOrders || []) : [];
    const phone = String(run.driver_phone || '').replace(/[^+\d]/g, '');
    const transitions = run.allowedTransitions || [];
    const forward = ['active', 'completed', 'planned'].find((status) => transitions.includes(status));
    const others = transitions.filter((status) => status !== forward && status !== 'cancelled');

    const stopRow = (stop, index) => {
      const terminal = runTerminalOrderStatuses.includes(stop.order_status);
      const place = stop.neighborhood || stop.landmark || stop.delivery_address || 'Destination à préciser';
      return `<li class="rd-stop${terminal ? ' done' : ''}" data-id="${escapeHtml(stop.id)}">
        ${canReorder ? `<span class="rd-grip" title="Glisser pour déplacer" aria-hidden="true">${ic.grip}</span>` : ''}
        <span class="rd-num">${terminal ? ic.check : index + 1}</span>
        <button type="button" class="rd-main" data-order="${escapeHtml(stop.order_id)}" title="Ouvrir la commande">
          <strong>${escapeHtml(stop.customer_name || 'Client')}</strong>
          <small>${escapeHtml(orderCode(stop.order_reference, stop.order_id))} · ${escapeHtml(place)}${stop.requested_time ? ` · ${escapeHtml(stop.requested_time)}` : ''}</small>
        </button>
        <span class="rd-tags">${stop.destination_lat == null ? crmChip('Sans GPS', 'red') : ''}${crmChip(stop.order_status, crmOrderStatusColor(stop.order_status))}</span>
        ${canReorder || run.canEditStops ? `<span class="rd-acts">
          ${canReorder ? `<button type="button" class="crm-icobtn" data-move="up" ${index === 0 ? 'disabled' : ''} aria-label="Monter">${ic.up}</button><button type="button" class="crm-icobtn" data-move="down" ${index === stops.length - 1 ? 'disabled' : ''} aria-label="Descendre">${ic.down}</button>` : ''}
          ${run.canEditStops ? `<button type="button" class="crm-icobtn rd-remove" data-remove="${escapeHtml(stop.id)}" aria-label="Retirer de la tournée" title="Retirer de la tournée">${ic.remove}</button>` : ''}
        </span>` : ''}
      </li>`;
    };

    drawer.innerHTML = `
      <div class="crm-drawer-head">
        <div><div class="crm-drawer-title">${escapeHtml(run.name)} ${crmChip(runStatusLabels[run.status] || run.status, runStatusTone[run.status])}</div>
          <small>Commandes du jour du livreur, regroupées automatiquement</small></div>
        <div class="crm-drawer-headact"><button class="crm-drawer-close crm-icobtn" type="button" aria-label="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
      </div>
      <nav class="od-nav" aria-label="Sections de la tournée"></nav>
      <div class="crm-drawer-body">
        <div id="rdNotice">${notice ? `<div class="notice ${notice.type}">${escapeHtml(notice.text)}</div>` : ''}</div>
        <section data-od="Aperçu">
          <h4><span class="crm-sec-ic">${ic.overview}</span>Aperçu</h4>
          <div class="rd-driver">${crmAvatar(run.driver_name, {})}<span class="crm-muted">${escapeHtml(run.vehicle_type || 'Véhicule')}</span>${phone ? `<a class="rd-call" href="tel:${escapeHtml(phone)}">Appeler</a>` : ''}</div>
          <div class="rd-progress"><div><strong>${escapeHtml(done)} / ${escapeHtml(stops.length)}</strong> colis terminés</div>${crmProgressBar(pct, run.status === 'cancelled' ? 'grey' : '')}</div>
          <div class="rd-kpis">
            <div><span>Arrêts</span><strong>${escapeHtml(stops.length)}</strong></div>
            <div><span>Restants</span><strong>${escapeHtml(stops.length - done)}</strong></div>
            <div class="${noGps ? 'warn' : ''}"><span>Sans position GPS</span><strong>${escapeHtml(noGps)}</strong></div>
          </div>
          ${stops.length - noGps > 0 ? '<div class="rd-map" id="rdMap" aria-label="Carte des arrêts"></div>' : ''}
        </section>
        <section data-od="Arrêts">
          <div class="crm-sec-head"><h4><span class="crm-sec-ic">${ic.stops}</span>Ordre de passage</h4>
            ${canReorder ? `<button type="button" class="button secondary rd-optimize" id="rdOptimize">${ic.wand} Optimiser</button>` : ''}</div>
          <p class="rd-hint">${!stops.length ? '' : canReorder ? 'Glissez un arrêt (ou utilisez les flèches) : l’ordre est enregistré aussitôt.' : run.canReorderStops ? '' : 'L’ordre est verrouillé pendant l’exécution.'}</p>
          ${stops.length ? `<ol class="rd-stops" id="rdStops">${stops.map(stopRow).join('')}</ol>` : '<div class="empty">Aucun colis pour l’instant. Une commande affectée à ce livreur pour ce jour s’ajoute ici automatiquement.</div>'}
        </section>
        ${eligible.length ? `<section data-od="À ajouter">
          <h4><span class="crm-sec-ic">${ic.add}</span>Colis du livreur hors tournée</h4>
          <p class="rd-hint">${escapeHtml(eligible.length)} commande(s) de ${escapeHtml(run.driver_name)} ne sont dans aucune tournée.</p>
          <ul class="rd-eligible">${eligible.map((order) => `<li><div><strong>${escapeHtml(order.customer_name || 'Client')}</strong><small>N° ${escapeHtml(order.id)} · ${escapeHtml(order.neighborhood || order.landmark || order.delivery_address || 'Destination à préciser')} · ${escapeHtml(order.status)}</small></div><button type="button" class="button secondary" data-add="${escapeHtml(order.id)}">Ajouter</button></li>`).join('')}</ul>
        </section>` : ''}
        <section data-od="Historique">
          <h4><span class="crm-sec-ic">${ic.note}</span>Historique</h4>
          <ul class="crm-hist">${(run.events || []).slice().reverse().map((event) => `<li><span class="crm-hist-dot ${event.event_type === 'status_changed' && event.details?.toStatus === 'completed' ? 'ok' : ''}"></span><div><strong>${escapeHtml(runEventLabels[event.event_type] || event.event_type)}</strong><span>${escapeHtml(eventText(run, event))}</span><small>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor_name)}</small></div></li>`).join('') || '<li class="crm-muted">Aucun événement.</li>'}</ul>
        </section>
      </div>
      ${transitions.length ? `<div class="crm-drawer-foot rd-foot" id="rdFoot">
        ${['draft', 'planned'].includes(run.status) ? '<p class="rd-auto">Rien à valider : la tournée démarre toute seule dès que le livreur part avec un colis.</p>' : ''}
        ${transitions.includes('cancelled') ? '<button type="button" class="button danger" id="rdCancel">Annuler</button>' : ''}
        ${others.map((status) => `<button type="button" class="button secondary" data-to="${status}">${escapeHtml(runActionLabels[status] || runStatusLabels[status])}</button>`).join('')}
        ${forward ? `<button type="button" class="button ${['draft', 'planned'].includes(run.status) ? 'secondary' : 'primary'}" data-to="${forward}">${escapeHtml(runActionLabels[forward])}</button>` : ''}
      </div>` : ''}`;

    const body = drawer.querySelector('.crm-drawer-body');
    drawer.querySelector('.crm-drawer-close').addEventListener('click', close);
    const say = (type, text) => { notice = { type, text }; const el = drawer.querySelector('#rdNotice'); el.innerHTML = `<div class="notice ${type}">${escapeHtml(text)}</div>`; };
    const repaint = async (next) => { notice = next || null; await paint(body.scrollTop); refreshList(); };

    // Menu de sections (même comportement que le tiroir commande).
    const sections = [...body.querySelectorAll('[data-od]')];
    const nav = drawer.querySelector('.od-nav');
    nav.innerHTML = sections.map((section, i) => `<button type="button" data-i="${i}">${escapeHtml(section.dataset.od)}</button>`).join('');
    let pinnedUntil = 0;
    const setActive = (current) => nav.querySelectorAll('button').forEach((button, i) => button.classList.toggle('on', i === current));
    const markActive = () => {
      if (Date.now() < pinnedUntil) return;
      const line = body.scrollTop + body.clientHeight * 0.3;
      let current = 0;
      sections.forEach((section, i) => { if (section.offsetTop - body.offsetTop <= line) current = i; });
      setActive(current);
    };
    nav.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
      const i = Number(button.dataset.i);
      pinnedUntil = Date.now() + 900;
      setActive(i);
      body.scrollTo({ top: sections[i].offsetTop - body.offsetTop - 8, behavior: 'smooth' });
    }));
    body.addEventListener('scroll', markActive, { passive: true });

    // Carte des arrêts : numéros dans l'ordre de passage, reliés à vol d'oiseau.
    if (miniMap) { miniMap.remove(); miniMap = null; }
    const mapEl = drawer.querySelector('#rdMap');
    if (mapEl && typeof L !== 'undefined') {
      const points = [];
      miniMap = L.map(mapEl, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
      const created = miniMap;
      if (window.TraxoMapBase) window.TraxoMapBase.load().then((config) => { if (miniMap === created) window.TraxoMapBase.baseLayer(config.base).addTo(created); });
      stops.forEach((stop, index) => {
        const lat = Number(stop.destination_lat);
        const lng = Number(stop.destination_lng);
        if (stop.destination_lat == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
        const terminal = runTerminalOrderStatuses.includes(stop.order_status);
        points.push([lat, lng]);
        L.marker([lat, lng], {
          icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<span class="rd-pin${terminal ? ' done' : ''}">${index + 1}</span>` }),
          title: stop.customer_name || '',
        }).addTo(created);
      });
      if (points.length > 1) L.polyline(points, { color: '#17181c', weight: 2, opacity: 0.55, dashArray: '5 6' }).addTo(created);
      // Recadrage après l'ouverture animée du tiroir ; ignoré si la carte a
      // été retirée entre-temps (tiroir redessiné ou fermé).
      const frame = () => {
        if (miniMap !== created) return;
        created.invalidateSize({ animate: false });
        if (points.length === 1) created.setView(points[0], 15, { animate: false });
        else created.fitBounds(points, { padding: [26, 26], maxZoom: 16, animate: false });
      };
      frame();
      setTimeout(frame, 280);
    }

    // Ouvrir une commande (avec retour vers la tournée).
    body.querySelectorAll('.rd-main').forEach((button) => button.addEventListener('click', () => {
      close();
      openOrderDrawer(button.dataset.order, { onChange: opts.onChange, onBack: () => openRunDrawer(runId, opts), backLabel: 'Retour à la tournée' });
    }));

    // Ordre de passage : enregistré dès qu'il change.
    const saveOrder = async (stopIds, message) => {
      try {
        await api(`/api/app/runs/${encodeURIComponent(runId)}/reorder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stopIds, expectedVersion: run.version, idempotencyKey: actionKey('run-reorder') }),
        });
        await repaint({ type: 'success', text: message || 'Ordre de passage enregistré.' });
      } catch (error) {
        await repaint({ type: 'error', text: error.message });
      }
    };
    const list = body.querySelector('#rdStops');
    const currentIds = () => [...list.querySelectorAll('.rd-stop')].map((li) => Number(li.dataset.id));
    if (list && canReorder) {
      list.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => {
        const ids = stops.map((stop) => Number(stop.id));
        const id = Number(button.closest('.rd-stop').dataset.id);
        const index = ids.indexOf(id);
        const target = button.dataset.move === 'up' ? index - 1 : index + 1;
        if (index < 0 || target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        body.querySelectorAll('[data-move]').forEach((b) => { b.disabled = true; });
        saveOrder(ids);
      }));
      if (typeof Sortable !== 'undefined') {
        Sortable.create(list, {
          handle: '.rd-grip', animation: 160, ghostClass: 'rd-ghost',
          onEnd: (event) => { if (event.oldIndex !== event.newIndex) saveOrder(currentIds()); },
        });
      }
    }
    body.querySelector('#rdOptimize')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      say('info', 'Calcul de l’itinéraire le plus court sur les routes…');
      try {
        const suggestion = await api(`/api/app/runs/${encodeURIComponent(runId)}/suggestion`);
        if (!suggestion.available) {
          say('warning', `${suggestion.reason}${suggestion.missingOrderIds?.length ? ` Commandes concernées : ${suggestion.missingOrderIds.join(', ')}.` : ''}`);
          button.disabled = false;
          return;
        }
        const road = suggestion.method === 'osrm_road_network';
        await saveOrder(suggestion.stopIds, road
          ? `Itinéraire optimisé sur routes réelles : ~${suggestion.distanceKm} km${suggestion.durationMin != null ? `, ~${suggestion.durationMin} min de conduite` : ''}.`
          : `Ordre indicatif à vol d’oiseau : ~${suggestion.distanceKm} km (routage réel indisponible).`);
      } catch (error) {
        say('error', error.message);
        button.disabled = false;
      }
    });
    body.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', async () => {
      const stop = stops.find((item) => String(item.id) === button.dataset.remove);
      if (!stop || !(await uiConfirm(`Retirer ${orderCode(stop.order_reference, stop.order_id)} de la tournée ?`, { message: 'La commande reste affectée au livreur et son historique est conservé.', confirmLabel: 'Retirer' }))) return;
      button.disabled = true;
      try {
        await api(`/api/app/runs/${encodeURIComponent(runId)}/stops/${encodeURIComponent(stop.id)}/remove`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion: run.version, idempotencyKey: actionKey('run-remove') }),
        });
        await repaint({ type: 'success', text: 'Colis retiré de la tournée.' });
      } catch (error) {
        await repaint({ type: 'error', text: error.message });
      }
    }));
    body.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/app/runs/${encodeURIComponent(runId)}/orders`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: Number(button.dataset.add), expectedVersion: run.version, idempotencyKey: actionKey('run-add') }),
        });
        await repaint({ type: 'success', text: 'Colis ajouté à la tournée.' });
      } catch (error) {
        await repaint({ type: 'error', text: error.message });
      }
    }));

    // Changement d'état depuis le pied du tiroir.
    const foot = drawer.querySelector('#rdFoot');
    const changeStatus = async (toStatus, reason, button) => {
      if (button) button.disabled = true;
      try {
        await api(`/api/app/runs/${encodeURIComponent(runId)}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toStatus, reason: reason || '', expectedVersion: run.version, idempotencyKey: actionKey('run-status') }),
        });
        await repaint({ type: 'success', text: `Tournée : ${runStatusLabels[toStatus] || toStatus}.` });
      } catch (error) {
        say('error', error.message);
        body.scrollTo({ top: 0, behavior: 'smooth' });
        if (button) button.disabled = false;
      }
    };
    foot?.querySelectorAll('[data-to]').forEach((button) => button.addEventListener('click', async () => {
      const toStatus = button.dataset.to;
      if (!(await uiConfirm(`${runActionLabels[toStatus] || runStatusLabels[toStatus]} ?`, { message: ({ planned: 'La tournée est prête pour le départ ; l’ordre de passage reste modifiable.', active: 'Le livreur voit la tournée et l’ordre de passage est verrouillé.', completed: 'La tournée sera clôturée.', draft: 'La tournée repasse en préparation : vous pourrez ajouter ou retirer des colis.' })[toStatus] || '', confirmLabel: runActionLabels[toStatus] || 'Confirmer' }))) return;
      changeStatus(toStatus, '', button);
    }));
    foot?.querySelector('#rdCancel')?.addEventListener('click', () => {
      foot.innerHTML = `<form class="rd-cancel" id="rdCancelForm">
        <label for="rdReason">Motif de l’annulation</label>
        <textarea id="rdReason" maxlength="1000" required placeholder="Ex. : livreur indisponible, colis reportés à demain (10 caractères minimum)"></textarea>
        <div class="rd-cancel-actions"><button type="button" class="button secondary" id="rdCancelBack">Retour</button><button type="submit" class="button danger">Confirmer l’annulation</button></div>
      </form>`;
      const form = foot.querySelector('#rdCancelForm');
      foot.querySelector('#rdReason').focus();
      foot.querySelector('#rdCancelBack').addEventListener('click', () => paint(body.scrollTop));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const reason = foot.querySelector('#rdReason').value.trim();
        if (reason.length < 10) { say('error', 'Expliquez brièvement la raison de l’annulation (10 caractères minimum).'); return; }
        changeStatus('cancelled', reason, form.querySelector('button[type="submit"]'));
      });
    });

    body.scrollTop = scrollTop;
    markActive();
  };

  try {
    await paint();
  } catch (error) {
    drawer.innerHTML = `<div class="crm-drawer-head"><div class="crm-drawer-title">Erreur</div><button class="crm-drawer-close" type="button">✕</button></div><div class="crm-drawer-body"><div class="notice error">${escapeHtml(error.message)}</div></div>`;
    drawer.querySelector('.crm-drawer-close').addEventListener('click', close);
  }
}

// Tiroir d'un incident : le dossier complet (actions, gel, chronologies),
// avec impression et export depuis l'en-tête. opts.onChange : rafraîchit la liste.
async function openIncidentDrawer(incidentId, opts = {}) {
  const existing = document.querySelector('.crm-drawer-wrap');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.className = 'crm-drawer-wrap';
  wrap.innerHTML = '<div class="crm-drawer-backdrop"></div><aside class="crm-drawer wide" role="dialog" aria-modal="true" aria-label="Incident"><div class="loading-state" style="padding:40px">Chargement…</div></aside>';
  const drawer = wrap.querySelector('.crm-drawer');
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event) => { if (event.key === 'Escape' && !event.target.closest('input, textarea, select')) close(); };
  wrap.querySelector('.crm-drawer-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  const canControl = ['owner', 'manager'].includes(context.user.role);
  const printIc = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>';
  const dlIc = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
  const paint = async (scrollTop = 0) => {
    const { incident } = await api(`/api/app/incidents/${encodeURIComponent(incidentId)}`);
    drawer.innerHTML = `
      <div class="crm-drawer-head">
        <div><div class="crm-drawer-title">INC-${escapeHtml(incident.id)} ${crmChip(incident.status === 'resolved' ? 'Résolu' : 'Ouvert', incident.status === 'resolved' ? 'green' : 'red')}</div>
          <small>${escapeHtml(orderCode(incident.order_reference, incident.order_id))} · ouvert le ${escapeHtml(formatDate(incident.created_at))}</small></div>
        <div class="crm-drawer-headact">
          <a class="crm-icobtn" href="/app/incidents/${escapeHtml(incident.id)}?print=1" target="_blank" rel="noopener" title="Imprimer / PDF" aria-label="Imprimer ou enregistrer en PDF">${printIc}</a>
          ${canControl ? `<a class="crm-icobtn" href="/api/app/incidents/${escapeHtml(incident.id)}/export" title="Télécharger le dossier (PDF)" aria-label="Télécharger le dossier en PDF">${dlIc}</a>` : ''}
          <button class="crm-drawer-close crm-icobtn" type="button" aria-label="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="crm-drawer-body incident-drawer-body" id="incDrawerBody"></div>
      <div class="crm-drawer-foot"><button type="button" class="button secondary" id="incOpenOrder">Voir la commande</button></div>`;
    drawer.querySelector('.crm-drawer-close').addEventListener('click', close);
    drawer.querySelector('#incOpenOrder').addEventListener('click', () => {
      close();
      openOrderDrawer(incident.order_id, { onChange: opts.onChange, onBack: () => openIncidentDrawer(incidentId, opts), backLabel: 'Retour à l’incident' });
    });
    const body = drawer.querySelector('#incDrawerBody');
    await mountIncidentDossier(body, incidentId, {
      drawer: true,
      refresh: async () => {
        await paint(body.scrollTop);
        if (typeof opts.onChange === 'function') opts.onChange();
      },
    });
    body.scrollTop = scrollTop;
  };
  try {
    await paint();
  } catch (error) {
    drawer.innerHTML = `<div class="crm-drawer-head"><div class="crm-drawer-title">Erreur</div><button class="crm-drawer-close" type="button">✕</button></div><div class="crm-drawer-body"><div class="notice error">${escapeHtml(error.message)}</div></div>`;
    drawer.querySelector('.crm-drawer-close').addEventListener('click', close);
  }
}

// Panneau détail coulissant d'une demande client (aperçu rapide, comme la commande).
// opts.onChange : rappelé après un changement de statut (refus / archivage) pour rafraîchir la liste.
async function openRequestDrawer(requestId, opts = {}) {
  const existing = document.querySelector('.crm-drawer-wrap');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.className = 'crm-drawer-wrap';
  wrap.innerHTML = '<div class="crm-drawer-backdrop"></div><aside class="crm-drawer"><div class="loading-state" style="padding:40px">Chargement…</div></aside>';
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  wrap.querySelector('.crm-drawer-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  try {
    const r = await api(`/api/app/requests/${encodeURIComponent(requestId)}`);
    const assignable = !r.order_id && ['À vérifier', 'Informations à compléter', 'Validée'].includes(r.status);
    // Livreurs chargés seulement si l'on peut affecter depuis ce tiroir.
    const drivers = assignable ? await api('/api/app/drivers').catch(() => []) : [];
    const phone = String(r.customer_phone || '').replace(/[^+\d]/g, '');
    const shared = r.location_lat != null && r.location_lng != null;
    const validated = r.status === 'Confirmée' || r.validated_at != null;
    const secIc = {
      client: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
      doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg>',
      truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 17V5H2v12"/><path d="M14 9h4l4 4v4h-6"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
    };
    const canAct = !r.order_id && r.status !== 'Archivée' && r.status !== 'Refusée';
    const editable = !r.order_id && ['À vérifier', 'Informations à compléter'].includes(r.status);
    const photoIds = Array.isArray(r.photo_ids) ? r.photo_ids : [];
    const photoSrc = (photoId) => `/api/app/requests/${encodeURIComponent(r.id)}/photos/${encodeURIComponent(photoId)}`;
    const footer = r.order_id
      ? `${r.token ? '<button class="button secondary" type="button" id="reqCopyLink">Copier le lien client</button>' : ''}<button class="button primary" type="button" id="reqOpenOrder">Voir la commande</button>`
      : canAct
        ? `<div class="req-morewrap">
            <button class="button secondary" type="button" id="reqMore" aria-haspopup="true" aria-expanded="false">Autres actions</button>
            <div class="req-morepop" id="reqMorePop" hidden role="menu">
              ${editable ? '<button type="button" class="req-morepop-item" data-validate="1" role="menuitem">Valider sans affecter</button>' : ''}
              <button type="button" class="req-morepop-item danger" data-status="Refusée" role="menuitem">Refuser</button>
              <button type="button" class="req-morepop-item" data-status="Archivée" role="menuitem">Archiver</button>
            </div>
          </div>
          ${assignable
            ? `<button class="button primary" type="button" id="reqAssign" disabled>${editable ? 'Valider et affecter' : 'Affecter le livreur'}</button>`
            : `${r.token ? '<button class="button primary" type="button" id="reqCopyLink">Copier le lien à envoyer au client</button>' : ''}`}`
        : '<button class="button secondary" type="button" id="reqClose">Fermer</button>';
    const usableDrivers = drivers.filter((d) => d.active && !['inactive', 'off_duty', 'incident'].includes(d.operationalState));
    const assignHtml = assignable ? `<div class="req-assign">
        <label for="reqDriver">Livreur à affecter</label>
        <select id="reqDriver"${usableDrivers.length ? '' : ' disabled'}>
          <option value="">${usableDrivers.length ? 'Sélectionner un livreur' : 'Aucun livreur disponible'}</option>
          ${drivers.map((d) => {
            const off = !d.active || ['inactive', 'off_duty', 'incident'].includes(d.operationalState);
            return `<option value="${escapeHtml(d.id)}"${off ? ' disabled' : ''}>${escapeHtml(d.name)} — ${escapeHtml(driverStateLabels[d.operationalState] || d.operationalState)} — ${escapeHtml(loadText(d.activeOrders, d.capacity))}</option>`;
          }).join('')}
        </select>
        <p class="req-assign-msg" id="reqAssignMsg" role="status" aria-live="polite">${editable ? 'Après validation, le client ne peut plus modifier sa demande.' : 'Demande déjà validée : informations du client verrouillées.'}</p>
      </div>` : '';
    wrap.querySelector('.crm-drawer').innerHTML = `
      <div class="crm-drawer-head">
        <div><div class="crm-drawer-title">DEM-${escapeHtml(r.id)} ${requestStatusChip(r.status)}</div>
          <small>Créée le ${escapeHtml(formatDate(r.created_at))}${r.submitted_at ? ` · remplie par le client le ${escapeHtml(formatDate(r.submitted_at))}` : ' · lien pas encore rempli'}</small></div>
        <div class="crm-drawer-headact">
          <button class="crm-drawer-close crm-icobtn" type="button" aria-label="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="crm-drawer-body">
        <section><h4><span class="crm-sec-ic">${secIc.client}</span>Client</h4>
          <div class="crm-kv"><span>Nom</span><strong>${escapeHtml(r.customer_name || 'En attente du client')}</strong></div>
          <div class="crm-kv"><span>Téléphone</span><strong>${phone ? `<a href="tel:${escapeHtml(phone)}">${escapeHtml(r.customer_phone)}</a>` : '—'}</strong></div>
          <div class="crm-kv"><span>Créneau souhaité</span><strong>${escapeHtml(r.requested_time || '—')}</strong></div>
        </section>
        <section><h4><span class="crm-sec-ic">${secIc.pin}</span>Localisation</h4>
          <div class="crm-kv"><span>Zone / quartier</span><strong>${escapeHtml(r.neighborhood || '—')}</strong></div>
          <div class="crm-kv"><span>Repère</span><strong>${escapeHtml(r.landmark || '—')}</strong></div>
          <div class="crm-kv"><span>Position GPS</span><strong>${shared ? crmChip('Partagée', 'green') : crmChip('Manquante', 'red')}</strong></div>
          <div class="crm-kv"><span>Précision</span><strong>${r.location_accuracy != null
            ? `± ${escapeHtml(Math.round(r.location_accuracy).toLocaleString('fr-FR'))} m${r.location_accuracy > 150 ? ` ${crmChip('Imprécise', 'red')}` : ''}`
            : (shared ? 'Placée par le client' : '—')}</strong></div>
        </section>
        <section><h4><span class="crm-sec-ic">${secIc.doc}</span>Détails</h4>
          <div class="crm-kv"><span>Consigne pour le livreur</span><strong>${escapeHtml(r.notes || 'Aucune')}</strong></div>
          <div class="crm-kv"><span>Photos</span><strong>${photoIds.length
            ? `<span class="req-photos">${photoIds.map((photoId, i) => `<a href="${photoSrc(photoId)}" target="_blank" rel="noopener"><img src="${photoSrc(photoId)}" alt="Photo du lieu ${i + 1}" loading="lazy" /></a>`).join('')}</span>`
            : 'Aucune'}</strong></div>
        </section>
        ${r.order_id ? `<section><h4><span class="crm-sec-ic">${secIc.truck}</span>Commande créée</h4>
          <div class="crm-kv"><span>Commande</span><strong>${escapeHtml(orderCode(r.order_reference, r.order_id))}</strong></div>
          <div class="crm-kv"><span>Livreur</span><strong>${r.driver_name ? crmAvatar(r.driver_name) : '—'}</strong></div>
          <div class="crm-kv"><span>Statut</span><strong>${crmChip(r.order_status, crmOrderStatusColor(r.order_status))}</strong></div>
        </section>` : ''}
      </div>
      <div class="crm-drawer-foot${assignable ? ' req-foot' : ''}">${assignHtml}<div class="req-foot-actions">${footer}</div></div>`;
    wrap.querySelector('.crm-drawer-close').addEventListener('click', close);
    // Affectation directe depuis le tiroir (sans passer par la fiche).
    const assignBtn = wrap.querySelector('#reqAssign');
    const driverSelect = wrap.querySelector('#reqDriver');
    if (assignBtn && driverSelect) {
      driverSelect.addEventListener('change', () => { assignBtn.disabled = !driverSelect.value; });
      assignBtn.addEventListener('click', async () => {
        const driverId = driverSelect.value;
        if (!driverId) return;
        const driverName = driverSelect.selectedOptions[0]?.textContent.split(' — ')[0] || 'ce livreur';
        const question = editable
          ? `Valider la demande DEM-${r.id} et l’affecter à ${driverName} ? Les informations du client seront verrouillées.`
          : `Affecter la demande DEM-${r.id} à ${driverName} ?`;
        if (!(await uiConfirm(question, { confirmLabel: 'Confirmer' }))) return;
        const msg = wrap.querySelector('#reqAssignMsg');
        assignBtn.disabled = true;
        driverSelect.disabled = true;
        assignBtn.textContent = 'Affectation…';
        try {
          await api(`/api/app/requests/${encodeURIComponent(r.id)}/convert`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId }),
          });
          if (typeof opts.onChange === 'function') opts.onChange();
          openRequestDrawer(r.id, opts);
        } catch (error) {
          msg.textContent = error.message;
          msg.classList.add('err');
          driverSelect.disabled = false;
          assignBtn.disabled = !driverSelect.value;
          assignBtn.textContent = editable ? 'Valider et affecter' : 'Affecter le livreur';
        }
      });
    }
    wrap.querySelector('#reqCopyLink')?.addEventListener('click', async () => {
      const url = publicLink(`/demande/${r.token}`);
      try { await navigator.clipboard.writeText(url); uiToast('Lien client copié.', 'success'); }
      catch { uiToast(url, 'info', { timeout: 9000 }); }
    });
    wrap.querySelector('#reqOpenOrder')?.addEventListener('click', () => {
      wrap.querySelector('.crm-drawer-backdrop').click();
      openOrderDrawer(r.order_id, { onChange: opts.onChange, onBack: () => openRequestDrawer(requestId, opts), backLabel: 'Retour à la demande' });
    });
    wrap.querySelector('#reqClose')?.addEventListener('click', () => wrap.querySelector('.crm-drawer-backdrop').click());
    // « Autres actions » : popover Refuser / Archiver.
    const moreBtn = wrap.querySelector('#reqMore');
    if (moreBtn) {
      const pop = wrap.querySelector('#reqMorePop');
      moreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const willOpen = pop.hidden;
        pop.hidden = !willOpen;
        moreBtn.setAttribute('aria-expanded', String(willOpen));
      });
      // Referme le popover en cliquant ailleurs dans le tiroir (nettoyé avec le tiroir).
      wrap.addEventListener('click', (event) => {
        if (!pop.hidden && !event.target.closest('.req-morewrap')) {
          pop.hidden = true;
          moreBtn.setAttribute('aria-expanded', 'false');
        }
      });
      const validateItem = pop.querySelector('[data-validate]');
      if (validateItem) validateItem.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!(await uiConfirm(`Valider la demande DEM-${r.id} ?`, { message: 'Le client ne pourra plus modifier ses informations. Vous pourrez affecter un livreur ensuite.', confirmLabel: 'Valider' }))) return;
        pop.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
          await api(`/api/app/requests/${encodeURIComponent(r.id)}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          close();
          if (typeof opts.onChange === 'function') opts.onChange();
        } catch (error) {
          pop.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          uiToast(error.message, 'error');
        }
      });
      pop.querySelectorAll('[data-status]').forEach((btn) => {
        btn.addEventListener('click', async (event) => {
          event.stopPropagation();
          const status = btn.dataset.status;
          const message = status === 'Refusée'
            ? `Refuser la demande DEM-${r.id} ? Elle sera marquée comme refusée et quittera la file active.`
            : `Archiver la demande DEM-${r.id} ? Elle quittera la file active (réversible via l’onglet Archives).`;
          if (!(await uiConfirm(message, { tone: /refus|archiv/i.test(message) ? 'danger' : 'default', confirmLabel: 'Confirmer' }))) return;
          pop.querySelectorAll('[data-status]').forEach((b) => { b.disabled = true; });
          try {
            await api(`/api/app/requests/${encodeURIComponent(r.id)}/status`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status }),
            });
            close();
            if (typeof opts.onChange === 'function') opts.onChange();
          } catch (error) {
            pop.querySelectorAll('[data-status]').forEach((b) => { b.disabled = false; });
            uiToast(error.message, 'error');
          }
        });
      });
    }
  } catch (error) {
    wrap.querySelector('.crm-drawer').innerHTML = `<div class="crm-drawer-head"><div class="crm-drawer-title">Erreur</div><button class="crm-drawer-close" type="button">✕</button></div><div class="crm-drawer-body"><div class="notice error">${escapeHtml(error.message)}</div></div>`;
    wrap.querySelector('.crm-drawer-close').addEventListener('click', close);
  }
}

// Opérations : table, vues et fiche dans public/ops.js (kit « Operations
// Premium ») ; les actions restent dans les tiroirs ci-dessus.
async function renderOperations() {
  setHeader('Opérations', 'De la demande à la livraison.');
  const vue = new URLSearchParams(location.search).get('vue');
  if (!window.TraxoOps) return vue === 'creer' ? renderOperationsCreate() : renderOperationsWorkspace(vue);
  // Accueil et Nouvelle livraison : kit « Entrée » ; la table de suivi : kit « Operations ».
  if (!vue || vue === 'creer') {
    setHeader('Opérations', 'Démarrez une livraison et suivez l’activité.');
    return window.TraxoOps.renderEntry(page, { api, publicLink, actionKey }, vue === 'creer' ? 'new' : 'home');
  }
  await window.TraxoOps.render(page, {
    api, uiToast, uiConfirm, openModal, context, packageTypes: packageTypeOptions, actionKey, publicLink,
    openOrderDrawer, openIncidentDrawer, openRunDrawer, openRequestDrawer, openPickupEditor,
    newIncident: (onChange) => pickOrderForIncident(onChange),
  });
}

// Niveau 2 : « Créer un formulaire » — deux façons de capter un client.
function renderOperationsCreate() {
  page.innerHTML = `
    <div class="ops-breadcrumb"><a href="/app/operations">Opérations</a><span class="sep">›</span><span>Nouvelle livraison</span></div>
    <div class="page-header"><div><h1>Nouvelle livraison</h1><p class="subtitle">Comment voulez-vous obtenir l’adresse du client ?</p></div></div>
    <div class="ops-create">
      <div class="ops-create-card">
        <span class="ops-create-ic">${opsIco.pin}</span>
        <h3>Le client la donne lui-même</h3>
        <p>Vous lui envoyez un lien (WhatsApp, SMS). Il indique son nom, son téléphone et sa position exacte depuis son téléphone. Vous validez ensuite.</p>
        <button type="button" class="button primary" id="opsGenLink">Créer le lien ${opsIco.arrow}</button>
        <span class="ops-create-art"><img src="/img/ops-share-location.webp" alt="" loading="lazy"/></span>
      </div>
      <a class="ops-create-card ops-create-link" href="/app/nouvelle-commande">
        <span class="ops-create-ic">${opsIco.ride}</span>
        <h3>Vous la saisissez</h3>
        <p>Vous connaissez déjà le client : saisissez ses coordonnées et choisissez un livreur. Le client reçoit un lien pour suivre sa livraison.</p>
        <span class="button primary">Saisir la commande ${opsIco.arrow}</span>
        <span class="ops-create-art"><img src="/img/ops-assign-rider.webp" alt="" loading="lazy"/></span>
      </a>
    </div>
    <div id="opsLinkPanel"></div>`;

  document.getElementById('opsGenLink').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    const panel = document.getElementById('opsLinkPanel');
    panel.innerHTML = '<div class="card ops-linkpanel"><div class="loading-state">Génération du lien…</div></div>';
    try {
      const result = await api('/api/app/request-links', { method: 'POST', body: JSON.stringify({ idempotencyKey: actionKey('request-link') }) });
      const fullUrl = publicLink(result.path);
      const waText = encodeURIComponent(`Bonjour, pour organiser votre livraison, merci de remplir vos informations ici : ${fullUrl}`);
      panel.innerHTML = `<div class="card ops-linkpanel">
        <strong class="ops-linkpanel-title">Lien prêt : envoyez-le au client</strong>
        <p class="ops-modal-note" style="margin:6px 0 14px">Il remplit ses informations et partage sa position. Le lien est valable 7 jours. Vous serez prévenu dès qu’il l’aura rempli.</p>
        <div class="ops-linkout"><input type="text" readonly value="${escapeHtml(fullUrl)}" id="capLink" aria-label="Lien à envoyer au client"/><button type="button" class="button secondary" id="capCopy">Copier</button></div>
        <div class="ops-linkactions"><a class="button primary" target="_blank" rel="noopener" href="https://wa.me/?text=${waText}">Partager sur WhatsApp</a><a class="button secondary" target="_blank" rel="noopener" href="${escapeHtml(fullUrl)}">Ouvrir l’aperçu</a></div>
      </div>`;
      panel.querySelector('#capCopy').addEventListener('click', (copyEvent) => {
        const field = panel.querySelector('#capLink');
        field.select();
        try { navigator.clipboard?.writeText(field.value); } catch (_error) { /* le lien reste sélectionné */ }
        copyEvent.currentTarget.textContent = 'Copié';
      });
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      panel.innerHTML = `<div class="card ops-linkpanel"><div class="notice error">${escapeHtml(error.message)}</div></div>`;
    } finally {
      btn.disabled = false;
    }
  });
}

// Niveau 2 bis : le suivi de l'activité (table segmentée).
async function renderOperationsWorkspace(initialSegment) {
  page.classList.add('page-crm');
  const valid = ['commandes', 'incidents', 'tournees', 'demandes'];
  let segment = valid.includes(initialSegment) ? initialSegment : 'commandes';
  let raw = [];
  let query = '';
  let sort = null;
  let group = null;
  let filter = null;
  let pageN = 1;
  const pageSizeOptions = [10, 25, 50, 100];
  let pageSize = (() => { try { const v = Number(localStorage.getItem('traxo.crmPerPage')); return pageSizeOptions.includes(v) ? v : 10; } catch { return 10; } })();
  const scopeState = { demandes: 'active', incidents: 'open' };
  let counts = {};
  const crmSelected = new Set();

  const cfg = {
    commandes: {
      title: 'Commandes', newLabel: 'Nouvelle commande', newHref: '/app/nouvelle-commande',
      placeholder: 'Rechercher une commande, un client…', countKey: 'orders',
      endpoint: () => '/api/app/orders', drawerFn: (id) => openOrderDrawer(id, { onChange: loadSegment }), href: (r) => `/app/commandes/${r.id}`,
      statusValues: ['Confirmée', 'En préparation', 'Vers la collecte', 'Récupérée', 'En tournée', 'En livraison', 'Arrivée', 'Livrée', 'Échec', 'Retour', 'Retournée', 'Annulée'],
      groupCols: [['status', 'Statut'], ['zone', 'Zone'], ['driver', 'Livreur']],
      groupVal: (r, k) => k === 'status' ? r.status : k === 'zone' ? (r.neighborhood || r.landmark || '—') : (r.driver_name || '—'),
      filterTest: (r, v) => r.status === v,
      text: (r) => `${r.reference || ''} ${r.id} ${r.customer_name || ''} ${r.customer_phone || ''} ${r.neighborhood || ''} ${r.driver_name || ''} ${r.status || ''}`.toLowerCase(),
      columns: [
        { key: 'id', label: 'N° Commande', cell: (r) => `<span class="crm-code">${escapeHtml(orderCode(r.reference, r.id))}</span>`, sortVal: (r) => Number(r.id) },
        { key: 'client', label: 'Client', cell: (r) => `<div class="crm-strong">${escapeHtml(r.customer_name || '—')}</div>${r.customer_phone ? `<div class="crm-sub">${escapeHtml(r.customer_phone)}</div>` : ''}`, sortVal: (r) => (r.customer_name || '').toLowerCase() },
        { key: 'zone', label: 'Zone', cell: (r) => escapeHtml(r.neighborhood || r.landmark || '—'), sortVal: (r) => (r.neighborhood || '').toLowerCase() },
        { key: 'driver', label: 'Livreur', cell: (r) => crmAvatar(r.driver_name, { photoUrl: r.driver_photo, online: r.driver_online }), sortVal: (r) => (r.driver_name || '').toLowerCase() },
        { key: 'status', label: 'Statut', cell: (r) => crmChip(r.status, crmOrderStatusColor(r.status)), sortVal: (r) => r.status },
        { key: 'date', label: 'Date', cell: (r) => escapeHtml(formatDate(r.created_at)), sortVal: (r) => +new Date(r.created_at) },
        { key: 'suivi', label: 'Suivi', cell: (r) => { const p = crmOrderProgress(r.status); return crmProgressBar(p.pct, p.tone); } },
      ],
    },
    incidents: {
      title: 'Incidents', newLabel: 'Nouvel incident', newAction: () => pickOrderForIncident(loadSegment), placeholder: 'Rechercher un incident, une commande…', countKey: 'open_incidents',
      endpoint: () => `/api/app/incidents?scope=${encodeURIComponent(scopeState.incidents)}`, drawerFn: (id) => openIncidentDrawer(id, { onChange: loadSegment }), href: (r) => `/app/incidents/${r.id}`,
      statusValues: ['open', 'resolved'], statusLabelMap: { open: 'Ouvert', resolved: 'Résolu' },
      groupCols: [['status', 'Statut'], ['severity', 'Priorité'], ['assignee', 'Assigné à']],
      groupVal: (r, k) => k === 'status' ? (r.status === 'resolved' ? 'Résolu' : 'Ouvert') : k === 'severity' ? (incidentSeverityLabels[r.severity] || r.severity) : (r.assigned_to || r.driver_name || 'Non attribué'),
      filterTest: (r, v) => r.status === v,
      text: (r) => `${r.id} ${incidentCategoryLabels[r.category] || r.category} ${r.order_reference || ''} ${r.order_id} ${r.customer_name || ''} ${r.driver_name || ''} ${r.status || ''}`.toLowerCase(),
      columns: [
        { key: 'id', label: 'N° Incident', cell: (r) => `<span class="crm-code">INC-${escapeHtml(r.id)}</span>`, sortVal: (r) => Number(r.id) },
        { key: 'type', label: 'Type', cell: (r) => escapeHtml(incidentCategoryLabels[r.category] || r.category), sortVal: (r) => r.category },
        { key: 'order', label: 'Commande liée', cell: (r) => `<span class="crm-code">${escapeHtml(orderCode(r.order_reference, r.order_id))}</span>`, sortVal: (r) => Number(r.order_id) },
        { key: 'zone', label: 'Zone', cell: (r) => escapeHtml(r.neighborhood || '—') },
        { key: 'assignee', label: 'Assigné à', cell: (r) => (r.assigned_to || r.driver_name) ? crmAvatar(r.assigned_to || r.driver_name, r.assigned_to ? {} : { photoUrl: r.driver_photo, online: r.driver_online }) : '<span class="crm-muted">Non attribué</span>' },
        { key: 'severity', label: 'Priorité', cell: (r) => { const lbl = incidentSeverityLabels[r.severity] || r.severity; return crmChip(lbl, /haut|crit|élev|eleve|urgent/i.test(lbl || '') ? 'red' : /moy/i.test(lbl || '') ? 'amber' : 'grey'); } },
        { key: 'status', label: 'Statut', cell: (r) => crmChip(r.status === 'resolved' ? 'Résolu' : 'Ouvert', r.status === 'resolved' ? 'green' : 'red'), sortVal: (r) => r.status },
        { key: 'date', label: 'Date', cell: (r) => escapeHtml(formatDate(r.created_at)), sortVal: (r) => +new Date(r.created_at) },
        { key: 'suivi', label: 'Suivi', cell: (r) => { const s = r.status; if (s === 'resolved') return crmMiniSteps(4, 4, 'ok'); if (s === 'escalated') return crmMiniSteps(2, 4, 'amber'); if (s === 'in_progress') return crmMiniSteps(2, 4, ''); return crmMiniSteps(1, 4, 'red'); } },
      ],
    },
    tournees: {
      title: 'Tournées', newLabel: '', newHref: null, placeholder: 'Rechercher une tournée, un livreur…', countKey: 'open_runs',
      endpoint: () => '/api/app/runs', drawerFn: (id) => openRunDrawer(id, { onChange: loadSegment }), href: (r) => `/app/tournees/${r.id}`,
      statusValues: ['draft', 'planned', 'active', 'completed', 'cancelled'], statusLabelMap: runStatusLabels,
      groupCols: [['status', 'État'], ['driver', 'Livreur']],
      groupVal: (r, k) => k === 'status' ? (runStatusLabels[r.status] || r.status) : (r.driver_name || '—'),
      filterTest: (r, v) => r.status === v,
      text: (r) => `${r.name || ''} ${r.id} ${r.driver_name || ''} ${r.status || ''}`.toLowerCase(),
      columns: [
        { key: 'name', label: 'N° Tournée', cell: (r) => `<div class="crm-strong">${escapeHtml(r.name || `TRN-${r.id}`)}</div><div class="crm-sub">N° ${escapeHtml(r.id)}</div>`, sortVal: (r) => (r.name || '').toLowerCase() },
        { key: 'driver', label: 'Livreur', cell: (r) => crmAvatar(r.driver_name, { photoUrl: r.driver_photo, online: r.driver_online }), sortVal: (r) => (r.driver_name || '').toLowerCase() },
        { key: 'date', label: 'Date', cell: (r) => escapeHtml(formatDateOnly(r.service_date)), sortVal: (r) => r.service_date || '' },
        { key: 'stops', label: 'Arrêts', cell: (r) => `${escapeHtml(r.terminal_stop_count)} / ${escapeHtml(r.stop_count)}`, sortVal: (r) => Number(r.stop_count) },
        { key: 'prog', label: 'Progression', cell: (r) => { const total = Number(r.stop_count) || 0; const done = Number(r.terminal_stop_count) || 0; return crmProgressBar(total ? Math.round((done / total) * 100) : 0, ''); } },
        { key: 'status', label: 'État', cell: (r) => crmChip(runStatusLabels[r.status] || r.status, r.status === 'active' ? 'blue' : r.status === 'completed' ? 'green' : r.status === 'planned' ? 'indigo' : 'grey'), sortVal: (r) => r.status },
      ],
    },
    demandes: {
      title: 'Demandes', newLabel: 'Nouvelle demande', newHref: '/app/operations?vue=creer', placeholder: 'Rechercher une demande, un client…', countKey: 'active_requests',
      endpoint: () => `/api/app/requests?scope=${encodeURIComponent(scopeState.demandes)}`, drawerFn: (id) => openRequestDrawer(id, { onChange: loadSegment }), href: (r) => `/app/demandes/${r.id}`,
      rowArchive: { title: 'Archiver', confirm: (id) => `Archiver la demande DEM-${id} ?`, endpoint: (id) => `/api/app/requests/${encodeURIComponent(id)}/status`, body: { status: 'Archivée' } },
      statusValues: [], statusLabelMap: requestStatusLabels, filterTest: (r, v) => r.status === v,
      groupCols: [['status', 'Statut'], ['zone', 'Zone'], ['position', 'Position GPS']],
      groupVal: (r, k) => k === 'status' ? requestStatusLabel(r.status) : k === 'zone' ? (r.neighborhood || '—') : (reqShared(r) ? 'Partagée' : 'Manquante'),
      text: (r) => `${r.id} ${r.customer_name || ''} ${r.customer_phone || ''} ${r.neighborhood || ''} ${requestStatusLabel(r.status)}`.toLowerCase(),
      columns: [
        { key: 'id', label: 'N° Demande', cell: (r) => `<span class="crm-code">DEM-${escapeHtml(r.id)}</span>`, sortVal: (r) => Number(r.id) },
        { key: 'client', label: 'Client', cell: (r) => `<div class="crm-strong">${escapeHtml(r.customer_name || 'En attente du client')}</div>${r.customer_phone ? `<div class="crm-sub">${escapeHtml(r.customer_phone)}</div>` : ''}`, sortVal: (r) => (r.customer_name || '').toLowerCase() },
        { key: 'zone', label: 'Zone', cell: (r) => `${escapeHtml(r.neighborhood || '—')}${r.landmark ? `<div class="crm-sub">${escapeHtml(r.landmark)}</div>` : ''}`, sortVal: (r) => (r.neighborhood || '').toLowerCase() },
        { key: 'position', label: 'Position GPS', cell: (r) => reqShared(r) ? crmChip('Partagée', 'green') : crmChip(r.submitted_at ? 'Manquante' : '—', r.submitted_at ? 'red' : 'grey'), sortVal: (r) => reqShared(r) ? 0 : 1 },
        { key: 'status', label: 'Statut', cell: (r) => requestStatusChip(r.status), sortVal: (r) => r.status },
        { key: 'date', label: 'Date', cell: (r) => escapeHtml(formatDate(r.created_at)), sortVal: (r) => +new Date(r.created_at) },
      ],
    },
  };

  const c = () => cfg[segment];
  const emptyDrop = () => document.querySelectorAll('.crm-drop').forEach((d) => d.remove());
  document.addEventListener('click', emptyDrop);

  function shell() {
    const co = c();
    page.innerHTML = `
      <div class="crm-tabs" id="crmTabs"></div>
      <div class="crm-tools">
        <label class="crm-search"><span>${fleetIcons.search}</span><input type="search" id="crmSearch" placeholder="${escapeHtml(co.placeholder)}" value="${escapeHtml(query)}" autocomplete="off"/></label>
        <div class="crm-tool-wrap"><button class="crm-btn" id="crmFilter">${crmIcons.filter} Filtrer<span class="crm-b" id="crmFilterN" hidden></span></button></div>
        <div class="crm-tool-wrap"><button class="crm-btn" id="crmGroup">${crmIcons.group} Grouper par</button></div>
        <div class="crm-tool-wrap"><button class="crm-btn" id="crmSort">${crmIcons.sort} Trier</button></div>
        ${co.newAction ? `<button type="button" class="crm-new" id="crmNewAction">${fleetIcons.plus} ${escapeHtml(co.newLabel)}</button>` : co.newHref ? `<a class="crm-new" href="${escapeHtml(co.newHref)}">${fleetIcons.plus} ${escapeHtml(co.newLabel)}</a>` : ''}
      </div>
      <div class="crm-chips" id="crmChips"></div>
      <div class="cli-bulk" id="crmBulk" hidden></div>
      <div class="crm-card"><div class="crm-scroll"><table class="crm-table"><thead id="crmHead"></thead><tbody id="crmBody"></tbody></table></div></div>
      <div class="crm-foot" id="crmFoot"></div>`;
    renderTabs();
    document.getElementById('crmSearch').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); pageN = 1; renderAll(); });
    document.getElementById('crmFilter').addEventListener('click', (e) => { e.stopPropagation(); openFilterMenu(e.currentTarget); });
    document.getElementById('crmGroup').addEventListener('click', (e) => { e.stopPropagation(); openGroupMenu(e.currentTarget); });
    document.getElementById('crmSort').addEventListener('click', (e) => { e.stopPropagation(); openSortMenu(e.currentTarget); });
    document.getElementById('crmNewAction')?.addEventListener('click', () => co.newAction());
  }

  function renderTabs() {
    const el = document.getElementById('crmTabs');
    const tabs = valid.map((k) => {
      const n = counts[cfg[k].countKey];
      return `<button class="crm-tab ${k === segment ? 'active' : ''}" data-seg="${k}">${escapeHtml(cfg[k].title)}${n != null ? `<span class="n">${escapeHtml(n)}</span>` : ''}</button>`;
    }).join('');
    el.innerHTML = `${tabs}<span class="crm-tool-wrap"><button class="crm-tab-add" id="crmQuickCreate" type="button" title="Créer" aria-label="Créer">${crmIcons.plus}</button></span>`;
    el.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => switchSeg(b.dataset.seg)));
    const add = document.getElementById('crmQuickCreate');
    if (add) add.addEventListener('click', (e) => {
      e.stopPropagation();
      makeDrop(add, [
        { value: 'commande', label: 'Nouvelle commande', onPick: () => { location.href = '/app/nouvelle-commande'; } },
        { value: 'demande', label: 'Nouvelle demande (formulaire client)', onPick: () => { location.href = '/app/operations?vue=creer'; } },
      ]);
    });
  }

  function switchSeg(k) {
    if (k === segment) return;
    segment = k; query = ''; sort = null; group = null; filter = null; pageN = 1; crmSelected.clear();
    try { history.replaceState(null, '', `/app/operations?vue=${k}`); } catch { /* ignore */ }
    shell(); loadSegment();
  }

  function makeDrop(anchor, items) {
    emptyDrop();
    const drop = document.createElement('div');
    drop.className = 'crm-drop';
    drop.innerHTML = items.map((it) => `<button data-v="${escapeHtml(it.value)}" class="${it.active ? 'active' : ''}">${escapeHtml(it.label)}</button>`).join('');
    anchor.parentElement.appendChild(drop);
    drop.addEventListener('click', (e) => { e.stopPropagation(); const b = e.target.closest('[data-v]'); if (b) { drop.remove(); const hit = items.find((i) => String(i.value) === b.dataset.v); if (hit) hit.onPick(); } });
  }
  function openFilterMenu(anchor) {
    const co = c();
    const vals = co.statusValues && co.statusValues.length ? co.statusValues : [...new Set(raw.map((r) => r.status).filter(Boolean))];
    const items = vals.map((v) => ({ value: v, label: (co.statusLabelMap && co.statusLabelMap[v]) || v, active: filter && filter.value === v, onPick: () => { filter = { value: v, label: (co.statusLabelMap && co.statusLabelMap[v]) || v, test: (r) => co.filterTest(r, v) }; pageN = 1; renderAll(); } }));
    items.unshift({ value: '__none', label: 'Aucun filtre', active: !filter, onPick: () => { filter = null; pageN = 1; renderAll(); } });
    makeDrop(anchor, items);
  }
  function openGroupMenu(anchor) {
    const co = c();
    const items = co.groupCols.map(([k, label]) => ({ value: k, label, active: group === k, onPick: () => { group = group === k ? null : k; renderAll(); } }));
    items.unshift({ value: '__none', label: 'Aucun regroupement', active: !group, onPick: () => { group = null; renderAll(); } });
    makeDrop(anchor, items);
  }
  function openSortMenu(anchor) {
    const co = c();
    const items = co.columns.filter((col) => col.sortVal).map((col) => ({ value: col.key, label: col.label + (sort && sort.key === col.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''), active: sort && sort.key === col.key, onPick: () => { sort = (sort && sort.key === col.key) ? { key: col.key, dir: -sort.dir } : { key: col.key, dir: 1 }; renderAll(); } }));
    makeDrop(anchor, items);
  }

  function openPerPageMenu(anchor) {
    emptyDrop();
    const drop = document.createElement('div');
    drop.className = 'crm-drop crm-drop-up crm-drop-right';
    drop.innerHTML = pageSizeOptions.map((n) => `<button data-v="${n}" class="${n === pageSize ? 'active' : ''}">${n} par page</button>`).join('');
    anchor.parentElement.appendChild(drop);
    drop.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('[data-v]');
      if (!b) return;
      drop.remove();
      pageSize = Number(b.dataset.v);
      try { localStorage.setItem('traxo.crmPerPage', String(pageSize)); } catch {}
      pageN = 1;
      renderBody();
    });
  }

  function computeRows() {
    const co = c();
    let out = raw.slice();
    if (query) out = out.filter((r) => co.text(r).includes(query));
    if (filter) out = out.filter((r) => filter.test(r));
    if (sort) { const col = co.columns.find((k) => k.key === sort.key); if (col && col.sortVal) out.sort((a, b) => { const va = col.sortVal(a); const vb = col.sortVal(b); return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir; }); }
    return out;
  }

  function renderChips() {
    const el = document.getElementById('crmChips');
    const chips = [];
    if (filter) chips.push(`<span class="crm-fchip">Statut est ${escapeHtml(filter.label)} <button data-x="filter">✕</button></span>`);
    if (group) { const g = c().groupCols.find(([k]) => k === group); chips.push(`<span class="crm-fchip alt">Groupé par ${escapeHtml(g ? g[1] : group)} <button data-x="group">✕</button></span>`); }
    el.innerHTML = chips.join('');
    const nEl = document.getElementById('crmFilterN');
    if (nEl) { if (filter) { nEl.textContent = '1'; nEl.hidden = false; } else { nEl.hidden = true; } }
    el.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => { if (b.dataset.x === 'filter') filter = null; else group = null; pageN = 1; renderAll(); }));
  }

  function renderHead() {
    const co = c();
    const sortIco = (col) => {
      if (!col.sortVal) return '';
      const active = sort && sort.key === col.key;
      const dir = active ? (sort.dir > 0 ? 'up' : 'down') : '';
      return `<span class="crm-sortic ${active ? 'on ' + dir : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m8 9 4-4 4 4"/><path d="m16 15-4 4-4-4"/></svg></span>`;
    };
    const cells = co.columns.map((col) => `<th data-sort="${col.sortVal ? col.key : ''}"><span class="crm-th">${escapeHtml(col.label)}${sortIco(col)}</span></th>`).join('');
    const head = document.getElementById('crmHead');
    head.innerHTML = `<tr><th class="crm-cbcol"><span class="crm-cb" id="crmHeadCb" title="Tout sélectionner"></span></th>${cells}<th class="crm-actcol"></th></tr>`;
    head.querySelectorAll('[data-sort]').forEach((th) => { if (th.dataset.sort) th.addEventListener('click', () => { const k = th.dataset.sort; sort = (sort && sort.key === k) ? { key: k, dir: -sort.dir } : { key: k, dir: 1 }; renderAll(); }); });
    document.getElementById('crmHeadCb')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const rows = [...document.querySelectorAll('#crmBody tr[data-id]')];
      const allOn = rows.length > 0 && rows.every((tr) => crmSelected.has(String(tr.dataset.id)));
      rows.forEach((tr) => {
        const id = String(tr.dataset.id);
        if (allOn) crmSelected.delete(id); else crmSelected.add(id);
        tr.classList.toggle('crm-rowsel', !allOn);
        tr.querySelector('.crm-cb')?.classList.toggle('on', !allOn);
      });
      syncHeadCb();
      refreshCrmBulk();
    });
    syncHeadCb();
  }

  function syncHeadCb() {
    const cb = document.getElementById('crmHeadCb');
    if (!cb) return;
    const rows = [...document.querySelectorAll('#crmBody tr[data-id]')];
    cb.classList.toggle('on', rows.length > 0 && rows.every((tr) => crmSelected.has(String(tr.dataset.id))));
  }

  function stripHtml(html) { const d = document.createElement('div'); d.innerHTML = String(html == null ? '' : html); return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
  function csvCell(value) { const t = value == null ? '' : String(value); return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }

  function refreshCrmBulk() {
    const bar = document.getElementById('crmBulk');
    if (!bar) return;
    if (!crmSelected.size) { bar.hidden = true; bar.innerHTML = ''; return; }
    const co = c();
    bar.hidden = false;
    bar.innerHTML = `<span class="cli-bulk-count">${crmSelected.size} sélectionné${crmSelected.size > 1 ? 's' : ''}</span>
      <div class="cli-bulk-actions">
        <button type="button" class="cli-bulk-btn" data-b="export">Exporter (CSV)</button>
        ${co.rowArchive ? '<button type="button" class="cli-bulk-btn danger" data-b="archive">Archiver</button>' : ''}
        <button type="button" class="cli-bulk-btn ghost" data-b="clear">Effacer</button>
      </div>`;
    bar.querySelector('[data-b="export"]').addEventListener('click', () => exportCrmSelection(co));
    bar.querySelector('[data-b="archive"]')?.addEventListener('click', () => archiveCrmSelection(co));
    bar.querySelector('[data-b="clear"]').addEventListener('click', () => {
      crmSelected.clear();
      document.querySelectorAll('#crmBody tr[data-id]').forEach((tr) => { tr.classList.remove('crm-rowsel'); tr.querySelector('.crm-cb')?.classList.remove('on'); });
      syncHeadCb(); refreshCrmBulk();
    });
  }

  function exportCrmSelection(co) {
    const chosen = raw.filter((r) => crmSelected.has(String(r.id)));
    const header = ['ID', ...co.columns.map((col) => col.label)];
    const lines = [header.map(csvCell).join(';')];
    chosen.forEach((r) => { lines.push([r.id, ...co.columns.map((col) => stripHtml(col.cell(r)))].map(csvCell).join(';')); });
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${segment}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function archiveCrmSelection(co) {
    if (!co.rowArchive) return;
    const ids = [...crmSelected];
    if (!ids.length || !(await uiConfirm(`${co.rowArchive.title} ${ids.length} élément(s) ?`, { message: 'Ils quitteront la file active (réversible depuis les archives).', confirmLabel: co.rowArchive.title }))) return;
    try {
      await Promise.all(ids.map((id) => api(co.rowArchive.endpoint(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(co.rowArchive.body),
      })));
      crmSelected.clear(); refreshCrmBulk();
      await loadSegment();
    } catch (error) { uiToast(error.message || 'Action impossible.', 'error'); }
  }

  function rowHtml(r, co) {
    const cells = co.columns.map((col) => `<td>${col.cell(r)}</td>`).join('');
    const eye = co.drawerFn ? `<button data-act="view" title="Aperçu">${crmIcons.eye}</button>` : `<button data-act="open" title="Ouvrir">${crmIcons.eye}</button>`;
    const trash = co.rowArchive ? `<button data-act="archive" class="crm-rowact-danger" title="${escapeHtml(co.rowArchive.title)}">${crmIcons.trash}</button>` : '';
    const on = crmSelected.has(String(r.id));
    return `<tr data-id="${escapeHtml(r.id)}" class="${on ? 'crm-rowsel' : ''}"><td class="crm-cbcol"><span class="crm-cb ${on ? 'on' : ''}"></span></td>${cells}<td class="crm-actcol"><span class="crm-rowact">${eye}<button data-act="open" title="Ouvrir la fiche">${crmIcons.edit}</button>${trash}</span></td></tr>`;
  }

  async function rowArchive(co, id) {
    if (!co.rowArchive) return;
    if (!(await uiConfirm(co.rowArchive.confirm(id), { confirmLabel: co.rowArchive.title }))) return;
    try {
      await api(co.rowArchive.endpoint(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(co.rowArchive.body),
      });
      await loadSegment();
    } catch (error) {
      uiToast(error.message, 'error');
    }
  }

  function renderBody() {
    const co = c();
    const all = computeRows();
    const body = document.getElementById('crmBody');
    const colspan = co.columns.length + 2;
    if (!all.length) { body.innerHTML = `<tr><td colspan="${colspan}"><div class="crm-empty">${raw.length ? 'Aucun élément ne correspond.' : 'Rien à afficher ici pour le moment.'}</div></td></tr>`; renderFoot(0); return; }
    let html = '';
    if (group) {
      const groups = new Map();
      all.forEach((r) => { const key = co.groupVal(r, group); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); });
      html = [...groups.entries()].map(([key, list]) => `<tr class="crm-grouprow"><td colspan="${colspan}">${escapeHtml(key)} <span class="crm-gcount">${list.length}</span></td></tr>${list.map((r) => rowHtml(r, co)).join('')}`).join('');
      renderFoot(all.length);
    } else {
      const start = (pageN - 1) * pageSize;
      html = all.slice(start, start + pageSize).map((r) => rowHtml(r, co)).join('');
      renderFoot(all.length);
    }
    body.innerHTML = html;
    body.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        const id = tr.dataset.id;
        if (act && act.dataset.act === 'view') { (co.drawerFn || openOrderDrawer)(id); return; }
        if (act && act.dataset.act === 'archive') { e.stopPropagation(); rowArchive(co, id); return; }
        if (act && act.dataset.act === 'open') { location.href = co.href({ id }); return; }
        if (e.target.closest('.crm-cb')) {
          e.stopPropagation();
          const on = !crmSelected.has(String(id));
          if (on) crmSelected.add(String(id)); else crmSelected.delete(String(id));
          e.target.closest('.crm-cb').classList.toggle('on', on);
          tr.classList.toggle('crm-rowsel', on);
          syncHeadCb();
          refreshCrmBulk();
          return;
        }
        if (co.drawerFn) co.drawerFn(id); else location.href = co.href({ id });
      });
    });
    syncHeadCb();
    refreshCrmBulk();
  }

  function renderFoot(total) {
    const el = document.getElementById('crmFoot');
    if (!el) return;
    const pages = group ? 1 : Math.max(1, Math.ceil(total / pageSize));
    if (pageN > pages) pageN = pages;
    let pager = '';
    if (!group) {
      const btn = (p, label, cls, disabled) => `<button class="crm-pg ${cls || ''}" data-p="${p}"${disabled ? ' disabled' : ''}>${label}</button>`;
      let nums = '';
      for (let i = 1; i <= pages; i += 1) nums += btn(i, i, i === pageN ? 'active' : '');
      pager = `${btn(Math.max(1, pageN - 1), '‹', 'crm-pg-arrow', pageN <= 1)}${nums}${btn(Math.min(pages, pageN + 1), '›', 'crm-pg-arrow', pageN >= pages)}`;
    }
    const chev = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    el.innerHTML = `<span>${escapeHtml(total)} résultat${total > 1 ? 's' : ''}</span><div class="crm-page"><span class="crm-perwrap"><button class="crm-per" id="crmPer" type="button">${pageSize} par page ${chev}</button></span>${pager}</div>`;
    el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { pageN = Number(b.dataset.p); renderBody(); }));
    const perBtn = document.getElementById('crmPer');
    if (perBtn) perBtn.addEventListener('click', (e) => { e.stopPropagation(); openPerPageMenu(perBtn); });
  }

  function renderAll() { renderChips(); renderHead(); renderBody(); }

  async function loadSegment() {
    const co = c();
    document.getElementById('crmBody').innerHTML = `<tr><td colspan="${co.columns.length + 2}"><div class="loading-state">Chargement…</div></td></tr>`;
    renderHead();
    try { raw = await api(co.endpoint()); pageN = 1; renderAll(); }
    catch (error) { document.getElementById('crmBody').innerHTML = `<tr><td colspan="${co.columns.length + 2}"><div class="notice error">${escapeHtml(error.message)}</div></td></tr>`; }
  }

  try { counts = await api('/api/app/summary'); } catch { counts = {}; }
  shell();
  await loadSegment();
  // Arrivée depuis une notification (…?vue=demandes&demande=56) : ouvre le
  // tiroir de cette demande, puis retire le paramètre de l'URL.
  const focusParams = new URLSearchParams(location.search);
  const focusRequest = focusParams.get('demande');
  const focusOrder = focusParams.get('commande');
  const focusRun = focusParams.get('tournee');
  const focusIncident = focusParams.get('incident');
  if (segment === 'demandes' && /^\d{1,18}$/.test(focusRequest || '')) {
    focusParams.delete('demande');
    history.replaceState(null, '', `${location.pathname}?${focusParams.toString()}`);
    openRequestDrawer(focusRequest, { onChange: loadSegment });
  } else if (segment === 'commandes' && /^\d{1,18}$/.test(focusOrder || '')) {
    focusParams.delete('commande');
    history.replaceState(null, '', `${location.pathname}?${focusParams.toString()}`);
    openOrderDrawer(focusOrder, { onChange: loadSegment });
  } else if (segment === 'tournees' && /^\d{1,18}$/.test(focusRun || '')) {
    focusParams.delete('tournee');
    history.replaceState(null, '', `${location.pathname}?${focusParams.toString()}`);
    openRunDrawer(focusRun, { onChange: loadSegment });
  } else if (segment === 'incidents' && /^\d{1,18}$/.test(focusIncident || '')) {
    focusParams.delete('incident');
    history.replaceState(null, '', `${location.pathname}?${focusParams.toString()}`);
    openIncidentDrawer(focusIncident, { onChange: loadSegment });
  }
}

function customerStatusBadge(status) {
  const type = status === 'active' ? 'success' : status === 'do_not_contact' ? 'warning' : '';
  return `<span class="badge ${type}">${escapeHtml(customerStatusLabels[status] || status || '—')}</span>`;
}

function loadingState(label) {
  return `<div class="loading-state" role="status" aria-live="polite">
    <span>${escapeHtml(label)}</span><div class="loading-lines" aria-hidden="true"><i></i><i></i><i></i></div>
  </div>`;
}

function paginationState(raw, itemCount) {
  const currentPage = Math.max(1, Number(raw?.page) || 1);
  const limit = Math.max(1, Number(raw?.limit) || Math.max(itemCount, 1));
  const total = Number(raw?.total ?? raw?.total_count);
  const declaredPages = Number(raw?.total_pages ?? raw?.totalPages);
  const totalPages = Number.isFinite(declaredPages) && declaredPages > 0
    ? declaredPages
    : Number.isFinite(total) ? Math.max(1, Math.ceil(total / limit)) : currentPage;
  return {
    currentPage,
    totalPages,
    total: Number.isFinite(total) ? total : null,
    hasPrevious: raw?.has_previous ?? raw?.hasPrevious ?? currentPage > 1,
    hasNext: raw?.has_next ?? raw?.hasNext ?? currentPage < totalPages,
  };
}

const CUSTOMER_STAGES = {
  nouveau: { label: 'Nouveau', plural: 'Nouveaux', dot: '#7c3aed', bg: '#f3e8ff', text: '#6b21a8' },
  actif: { label: 'Actif', plural: 'Actifs', dot: '#16a34a', bg: '#e7f6ec', text: '#15803d' },
  a_relancer: { label: 'À relancer', plural: 'À relancer', dot: '#d97706', bg: '#fdf0dd', text: '#b45309' },
  inactif: { label: 'Inactif', plural: 'Inactifs', dot: '#94a3b8', bg: '#eef1f5', text: '#64748b' },
};
const CUSTOMER_AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#16a34a', '#db2777', '#d97706', '#4f46e5', '#0d9488'];

function customerCode(row) {
  const code = String(row.customer_code || '');
  if (/^CL-\d+/i.test(code)) return code.toUpperCase();
  return `CL-${String(row.id).padStart(4, '0')}`;
}
function customerInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function customerAvatarColor(row) {
  const key = String(row.id || row.display_name || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return CUSTOMER_AVATAR_COLORS[hash % CUSTOMER_AVATAR_COLORS.length];
}
function customerStage(row) {
  return CUSTOMER_STAGES[row.stage] ? row.stage : 'inactif';
}
function customerActivity(row) {
  const at = row.last_order_at || row.last_activity_at || row.updated_at;
  const dateStr = at ? formatDate(at) : '—';
  let event = 'Aucune activité récente';
  const last = row.last_order_at ? new Date(row.last_order_at).getTime() : null;
  if (last != null && Number.isFinite(last)) {
    const age = Date.now() - last;
    if (row.last_order_status === 'Livrée') event = 'Commande livrée';
    else if (age <= 3 * 86400000) event = 'Nouvelle commande';
    else if (age <= 30 * 86400000) event = `Commande ${row.last_order_status || 'en cours'}`;
    else event = 'Aucune activité récente';
  }
  return { dateStr, event };
}
function customerStageBadge(row) {
  const meta = CUSTOMER_STAGES[customerStage(row)];
  return `<span class="cli-badge" style="background:${meta.bg};color:${meta.text}"><i style="background:${meta.dot}"></i>${meta.label}</span>`;
}
function customerAvatarHtml(row, cls = 'cli-av') {
  return `<span class="${cls}" style="background:${customerAvatarColor(row)}">${escapeHtml(customerInitials(row.display_name))}</span>`;
}

async function renderCustomers() {
  setHeader('Clients', 'Gérez vos clients, suivez leurs commandes et leurs lieux de livraison.');
  page.classList.add('page-crm');
  const ic = {
    crm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    pipeline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="4" x2="6" y2="20"/><line x1="12" y1="4" x2="12" y2="14"/><line x1="18" y1="4" x2="18" y2="18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
    sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h10"/><path d="M11 9h7"/><path d="M11 13h4"/><path d="m3 17 3 3 3-3"/><path d="M6 18V4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M9 6h.01M15 6h.01M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/></svg>',
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };

  const initial = new URLSearchParams(location.search);
  const state = {
    view: ['crm', 'gallery', 'pipeline'].includes(initial.get('vue')) ? initial.get('vue') : 'crm',
    q: initial.get('q') || '',
    stage: ['nouveau', 'actif', 'a_relancer', 'inactif'].includes(initial.get('stage')) ? initial.get('stage') : '',
    sort: ['recent', 'oldest', 'name', 'orders'].includes(initial.get('sort')) ? initial.get('sort') : 'recent',
    page: Math.max(1, Number(initial.get('page')) || 1),
    perPage: [10, 20, 50].includes(Number(initial.get('per'))) ? Number(initial.get('per')) : 10,
  };
  const SORT_LABELS = { recent: 'Activité récente', oldest: 'Plus ancien', name: 'Nom (A→Z)', orders: 'Nb de commandes' };

  page.innerHTML = `<div class="cli">
    <div class="cli-toolbar">
      <div class="cli-tabs" role="tablist">
        <button type="button" class="cli-tab" data-view="crm">${ic.crm}<span>Liste</span></button>
        <button type="button" class="cli-tab" data-view="gallery">${ic.gallery}<span>Cartes</span></button>
        <button type="button" class="cli-tab" data-view="pipeline">${ic.pipeline}<span>Par étape</span></button>
      </div>
      <div class="cli-tools">
        <div class="cli-search"><span class="cli-search-ic">${ic.search}</span><input type="search" id="cliQuery" placeholder="Rechercher un client, un téléphone ou une adresse…" autocomplete="off" value="${escapeHtml(state.q)}"></div>
        <div class="cli-menu" id="cliFilterMenu"><button type="button" class="cli-tool-btn" id="cliFilterBtn">${ic.filter}<span>Filtrer</span><b class="cli-caret"></b></button></div>
        <div class="cli-menu" id="cliSortMenu"><button type="button" class="cli-tool-btn" id="cliSortBtn">${ic.sort}<span>Trier par</span><b class="cli-caret"></b></button></div>
        <button type="button" class="button primary cli-new" id="cliNew">${ic.plus}<span>Nouveau client</span></button>
      </div>
    </div>
    <div id="cliBulk" class="cli-bulk" hidden></div>
    <div id="cliBody" class="cli-body" aria-live="polite"></div>
  </div>`;

  const body = document.getElementById('cliBody');
  const bulk = document.getElementById('cliBulk');
  const queryInput = document.getElementById('cliQuery');
  let loading = false;
  const selected = new Set();
  let currentRows = [];

  // Barre d'actions groupées : apparaît dès la première sélection (CRM).
  const refreshBulk = () => {
    if (!selected.size) { bulk.hidden = true; bulk.innerHTML = ''; return; }
    bulk.hidden = false;
    bulk.innerHTML = `<span class="cli-bulk-count">${selected.size} sélectionné${selected.size > 1 ? 's' : ''}</span>
      <div class="cli-bulk-actions">
        <button type="button" class="cli-bulk-btn" data-bulk="export">Exporter (CSV)</button>
        <button type="button" class="cli-bulk-btn danger" data-bulk="archive">Archiver</button>
        <button type="button" class="cli-bulk-btn ghost" data-bulk="clear">Effacer</button>
      </div>`;
    bulk.querySelector('[data-bulk="export"]').addEventListener('click', exportSelectedCsv);
    bulk.querySelector('[data-bulk="archive"]').addEventListener('click', archiveSelected);
    bulk.querySelector('[data-bulk="clear"]').addEventListener('click', () => {
      selected.clear();
      body.querySelectorAll('.cli-row-check').forEach((c) => { c.checked = false; c.closest('tr')?.classList.remove('sel'); });
      const all = body.querySelector('#cliAll'); if (all) all.checked = false;
      refreshBulk();
    });
  };

  const csvCell = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const exportSelectedCsv = () => {
    const chosen = currentRows.filter((r) => selected.has(String(r.id)));
    const header = ['Code', 'Nom', 'Secteur', 'Téléphone', 'Statut', 'Commandes', 'Lieux', 'Dernière activité'];
    const lines = [header.join(';')];
    chosen.forEach((r) => {
      const act = customerActivity(r);
      lines.push([customerCode(r), r.display_name || '', r.sector || '', r.primary_phone || '',
        CUSTOMER_STAGES[customerStage(r)].label, r.order_count, r.location_count, act.dateStr].map(csvCell).join(';'));
    });
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const archiveSelected = async () => {
    const ids = [...selected];
    if (!ids.length || !(await uiConfirm(`Archiver ${ids.length} client(s) ?`, { message: 'Ils n’apparaîtront plus dans la liste par défaut.', confirmLabel: 'Archiver' }))) return;
    try {
      await Promise.all(ids.map((id) => api(`/api/app/crm/customers/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }),
      })));
      selected.clear(); refreshBulk(); load();
    } catch (error) { uiToast(error.message || 'Archivage impossible.', 'error'); }
  };

  const archiveOne = async (id) => {
    if (!(await uiConfirm('Archiver ce client ?', { message: 'Il n’apparaîtra plus dans la liste par défaut.', confirmLabel: 'Archiver' }))) return;
    try {
      await api(`/api/app/crm/customers/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }),
      });
      selected.delete(String(id)); refreshBulk(); load();
    } catch (error) { uiToast(error.message || 'Archivage impossible.', 'error'); }
  };

  // Menu « ⋮ » par ligne / carte.
  const openKebab = (btn, id) => {
    document.querySelectorAll('.cli-kebab-pop').forEach((p) => p.remove());
    const pop = document.createElement('div');
    pop.className = 'cli-kebab-pop';
    pop.innerHTML = `
      <a class="cli-kebab-item" href="/app/clients/${encodeURIComponent(id)}">Ouvrir la fiche</a>
      <a class="cli-kebab-item" href="/app/nouvelle-commande">Nouvelle commande</a>
      <button type="button" class="cli-kebab-item" data-act="merge">Fusionner un doublon</button>
      <button type="button" class="cli-kebab-item danger" data-act="archive">Archiver</button>`;
    btn.parentElement.style.position = 'relative';
    btn.parentElement.appendChild(pop);
    pop.querySelector('[data-act="merge"]').addEventListener('click', () => { pop.remove(); openMergeModal(id); });
    pop.querySelector('[data-act="archive"]').addEventListener('click', () => { pop.remove(); archiveOne(id); });
    const away = (event) => { if (!pop.contains(event.target) && event.target !== btn) { pop.remove(); document.removeEventListener('click', away); } };
    setTimeout(() => document.addEventListener('click', away), 0);
  };

  // Modale de fusion : liste les doublons (même téléphone) et fusionne dans la fiche courante.
  const openMergeModal = async (targetId) => {
    const target = currentRows.find((r) => String(r.id) === String(targetId));
    const targetName = target ? (target.display_name || customerCode(target)) : `#${targetId}`;
    const overlay = document.createElement('div');
    overlay.className = 'cli-modal-overlay';
    overlay.innerHTML = `<div class="cli-modal" role="dialog" aria-modal="true" aria-label="Fusionner un doublon">
      <div class="cli-modal-head"><strong>Fusionner un doublon</strong><button type="button" class="cli-modal-x" aria-label="Fermer">✕</button></div>
      <div class="cli-modal-body">
        <p class="cli-merge-lead">Les fiches ci-dessous partagent un téléphone avec <strong>${escapeHtml(targetName)}</strong>. La fusion bascule leur historique (commandes, demandes) vers cette fiche ; le doublon devient une redirection.</p>
        <div id="cliMergeList">${loadingState('Recherche des doublons…')}</div>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    overlay.querySelector('.cli-modal-x').addEventListener('click', close);
    const listEl = overlay.querySelector('#cliMergeList');
    try {
      const { duplicates } = await api(`/api/app/crm/customers/${encodeURIComponent(targetId)}/duplicates`);
      if (!duplicates || !duplicates.length) {
        listEl.innerHTML = '<div class="cli-empty" style="padding:24px 12px"><strong>Aucun doublon détecté.</strong><p>Aucune autre fiche ne partage ce téléphone.</p></div>';
        return;
      }
      listEl.innerHTML = `<ul class="cli-merge-list">${duplicates.map((d) => `<li class="cli-merge-row" data-src="${escapeHtml(d.id)}">
        <div class="cli-merge-info"><strong>${escapeHtml(d.display_name || 'Client sans nom')}</strong><small>${escapeHtml(customerCode(d))} · ${escapeHtml(d.primary_phone || '—')} · ${formatInteger(d.order_count)} cmd</small></div>
        <button type="button" class="button secondary cli-merge-btn">Fusionner ici</button></li>`).join('')}</ul>`;
      listEl.querySelectorAll('.cli-merge-row').forEach((row) => {
        row.querySelector('.cli-merge-btn').addEventListener('click', async () => {
          if (!(await uiConfirm('Fusionner ce doublon ?', { message: 'Son historique bascule dans la fiche courante et l’ancienne fiche devient une redirection.', tone: 'danger', confirmLabel: 'Fusionner' }))) return;
          const b = row.querySelector('.cli-merge-btn'); b.disabled = true; b.textContent = 'Fusion…';
          try {
            await api(`/api/app/crm/customers/${encodeURIComponent(targetId)}/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: Number(row.dataset.src) }) });
            row.remove(); load();
            if (!listEl.querySelector('.cli-merge-row')) close();
          } catch (err) { b.disabled = false; b.textContent = 'Fusionner ici'; uiToast(err.message || 'Fusion impossible.', 'error'); }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="notice error">${escapeHtml(err.message || 'Erreur de chargement des doublons.')}</div>`;
    }
  };

  const syncUrl = () => {
    const p = new URLSearchParams();
    if (state.view !== 'crm') p.set('vue', state.view);
    if (state.q) p.set('q', state.q);
    if (state.stage) p.set('stage', state.stage);
    if (state.sort !== 'recent') p.set('sort', state.sort);
    if (state.page > 1) p.set('page', String(state.page));
    if (state.perPage !== 10) p.set('per', String(state.perPage));
    history.replaceState(null, '', `/app/clients${p.toString() ? `?${p}` : ''}`);
  };
  const syncTabs = () => {
    document.querySelectorAll('.cli-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
  };

  const pagerHtml = (pagination) => {
    const total = pagination.total ?? 0;
    const from = total === 0 ? 0 : (state.page - 1) * state.perPage + 1;
    const to = Math.min(total, state.page * state.perPage);
    const totalPages = pagination.totalPages || 1;
    const nums = [];
    const push = (n) => nums.push(`<button type="button" class="cli-page ${n === state.page ? 'active' : ''}" data-page="${n}">${n}</button>`);
    if (totalPages <= 7) { for (let n = 1; n <= totalPages; n += 1) push(n); }
    else {
      push(1);
      let start = Math.max(2, state.page - 1);
      let end = Math.min(totalPages - 1, state.page + 1);
      if (state.page <= 3) { start = 2; end = 5; }
      if (state.page >= totalPages - 2) { start = totalPages - 4; end = totalPages - 1; }
      if (start > 2) nums.push('<span class="cli-ellipsis">…</span>');
      for (let n = start; n <= end; n += 1) push(n);
      if (end < totalPages - 1) nums.push('<span class="cli-ellipsis">…</span>');
      push(totalPages);
    }
    return `<div class="cli-pager">
      <span class="cli-pager-info">Affichage de ${from} à ${to} sur ${formatInteger(total)} clients</span>
      <div class="cli-pager-nav">
        <button type="button" class="cli-page cli-arrow" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>‹</button>
        ${nums.join('')}
        <button type="button" class="cli-page cli-arrow" data-page="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''}>›</button>
      </div>
      <div class="cli-perpage"><select id="cliPer">${[10, 20, 50].map((n) => `<option value="${n}" ${state.perPage === n ? 'selected' : ''}>${n} par page</option>`).join('')}</select></div>
    </div>`;
  };

  const crmRow = (row) => {
    const act = customerActivity(row);
    return `<tr data-id="${escapeHtml(row.id)}">
      <td class="cli-check"><input type="checkbox" class="cli-row-check" aria-label="Sélectionner ${escapeHtml(row.display_name || '')}"></td>
      <td class="cli-id">${escapeHtml(customerCode(row))}</td>
      <td><div class="cli-name">${customerAvatarHtml(row)}<span class="cli-name-main"><strong>${escapeHtml(row.display_name || 'Client sans nom')}</strong><small>${escapeHtml(row.sector || '—')}</small></span></div></td>
      <td><span class="cli-inline">${ic.phone}${escapeHtml(row.primary_phone || '—')}</span></td>
      <td>${customerStageBadge(row)}</td>
      <td class="cli-num">${formatInteger(row.order_count)}</td>
      <td><span class="cli-inline">${ic.pin}${escapeHtml(row.primary_locality || row.primary_neighborhood || '—')}</span></td>
      <td><div class="cli-activity"><strong>${escapeHtml(act.dateStr)}</strong><small>${escapeHtml(act.event)}</small></div></td>
      <td class="cli-actions"><a class="cli-open" href="/app/clients/${encodeURIComponent(row.id)}">${ic.ext}<span>Ouvrir la fiche</span></a><button type="button" class="cli-kebab" aria-label="Plus d'actions">⋮</button></td>
    </tr>`;
  };

  const galleryCard = (row) => {
    const act = customerActivity(row);
    return `<article class="cli-gcard">
      <div class="cli-gcard-head">${customerAvatarHtml(row, 'cli-av cli-av-lg')}<div class="cli-gcard-id"><small>${escapeHtml(customerCode(row))}</small><strong>${escapeHtml(row.display_name || 'Client sans nom')}</strong></div>${customerStageBadge(row)}</div>
      <div class="cli-gcard-grid">
        <div class="cli-inline">${ic.phone}${escapeHtml(row.primary_phone || '—')}</div>
        <div class="cli-inline">${ic.building}${escapeHtml(row.sector || '—')}</div>
        <div class="cli-inline">${ic.cart}${formatInteger(row.order_count)} commandes</div>
        <div class="cli-inline">${ic.pin}${formatInteger(row.location_count)} lieux connus</div>
      </div>
      <div class="cli-gcard-foot">
        <div class="cli-inline cli-gcard-act">${ic.cal}<div><small>Dernière activité</small><strong>${escapeHtml(act.dateStr)}</strong></div></div>
        <a class="cli-open" href="/app/clients/${encodeURIComponent(row.id)}">${ic.ext}<span>Ouvrir la fiche</span></a>
        <button type="button" class="cli-kebab" aria-label="Plus d'actions">⋮</button>
      </div>
    </article>`;
  };

  const pipeCard = (row) => {
    const act = customerActivity(row);
    const st = customerStage(row);
    return `<article class="cli-pcard" data-id="${escapeHtml(row.id)}" data-href="/app/clients/${encodeURIComponent(row.id)}">
      <div class="cli-pcard-head">${customerAvatarHtml(row)}<div class="cli-pcard-id"><small>${escapeHtml(customerCode(row))}</small><strong>${escapeHtml(row.display_name || 'Client sans nom')}</strong><small>${escapeHtml(row.sector || '—')}</small></div><span class="cli-pcard-chev">${ic.chev}</span></div>
      <div class="cli-pcard-meta">
        <div class="cli-inline">${ic.pin}${escapeHtml(row.primary_locality || row.primary_neighborhood || '—')}</div>
        <div class="cli-inline">${ic.cart}${formatInteger(row.order_count)} commandes</div>
        <div class="cli-inline">${ic.clock}Dernière activité : ${escapeHtml(act.dateStr)}</div>
      </div>
      <span class="cli-tag" style="background:${CUSTOMER_STAGES[st].bg};color:${CUSTOMER_STAGES[st].text}">${CUSTOMER_STAGES[st].label}</span>
    </article>`;
  };

  const bindRows = () => {
    body.querySelectorAll('.cli-pcard[data-href]').forEach((el) => el.addEventListener('click', (event) => {
      if (event.target.closest('a,button') || el.classList.contains('cli-dragging')) return;
      location.href = el.dataset.href;
    }));
    // Sélection CRM (persistante entre pages)
    const rowCheck = (c) => {
      const id = c.closest('tr')?.dataset.id;
      if (!id) return;
      if (c.checked) selected.add(String(id)); else selected.delete(String(id));
      c.closest('tr').classList.toggle('sel', c.checked);
      refreshBulk();
      const all = body.querySelector('#cliAll');
      if (all) all.checked = [...body.querySelectorAll('.cli-row-check')].every((x) => x.checked);
    };
    body.querySelectorAll('.cli-row-check').forEach((c) => {
      const id = c.closest('tr')?.dataset.id;
      if (id && selected.has(String(id))) { c.checked = true; c.closest('tr').classList.add('sel'); }
      c.addEventListener('change', () => rowCheck(c));
    });
    const all = body.querySelector('#cliAll');
    if (all) {
      all.checked = body.querySelectorAll('.cli-row-check').length > 0 && [...body.querySelectorAll('.cli-row-check')].every((x) => x.checked);
      all.addEventListener('change', () => {
        body.querySelectorAll('.cli-row-check').forEach((c) => { c.checked = all.checked; const id = c.closest('tr')?.dataset.id; if (id) { if (all.checked) selected.add(String(id)); else selected.delete(String(id)); } c.closest('tr').classList.toggle('sel', all.checked); });
        refreshBulk();
      });
    }
    // Menus « ⋮ »
    body.querySelectorAll('.cli-kebab').forEach((btn) => btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.closest('[data-id]')?.dataset.id;
      if (id) openKebab(btn, id);
    }));
    body.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
      const n = Number(b.dataset.page);
      if (!b.disabled && n >= 1) { state.page = n; load(); }
    }));
    body.querySelector('#cliPer')?.addEventListener('change', (event) => { state.perPage = Number(event.target.value) || 10; state.page = 1; load(); });
    if (state.view === 'pipeline') initPipelineDnD();
    refreshBulk();
  };

  // Glisser-déposer du pipeline (SortableJS) : déposer une carte dans une autre
  // colonne fige le stade en manuel (surcharge). Nécessite Sortable chargé.
  function initPipelineDnD() {
    if (typeof Sortable === 'undefined') return;
    body.querySelectorAll('.cli-col-body').forEach((col) => {
      // eslint-disable-next-line no-new
      Sortable.create(col, {
        group: 'cli-pipe',
        animation: 150,
        ghostClass: 'cli-pcard-ghost',
        draggable: '.cli-pcard',
        onStart: (event) => event.item.classList.add('cli-dragging'),
        onEnd: async (event) => {
          setTimeout(() => event.item.classList.remove('cli-dragging'), 0);
          const toStage = event.to?.dataset.stage;
          const fromStage = event.from?.dataset.stage;
          const id = event.item?.dataset.id;
          event.to?.querySelector('.cli-col-empty')?.remove();
          if (!toStage || !id || toStage === fromStage) return;
          try {
            await api(`/api/app/crm/customers/${encodeURIComponent(id)}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pipelineStage: toStage }),
            });
            const row = currentRows.find((r) => String(r.id) === String(id));
            if (row) row.stage = toStage;
            // Met à jour l'étiquette de stade et les compteurs de colonne.
            const meta = CUSTOMER_STAGES[toStage];
            const tag = event.item.querySelector('.cli-tag');
            if (tag && meta) { tag.textContent = meta.label; tag.style.background = meta.bg; tag.style.color = meta.text; }
            body.querySelectorAll('.cli-col').forEach((section) => {
              const count = section.querySelectorAll('.cli-pcard').length;
              const el = section.querySelector('.cli-col-count'); if (el) el.textContent = count;
            });
          } catch (error) {
            uiToast(error.message || 'Déplacement impossible.', 'error');
            load();
          }
        },
      });
    });
  }

  const load = async () => {
    if (loading) return;
    loading = true;
    syncUrl();
    syncTabs();
    body.setAttribute('aria-busy', 'true');
    body.innerHTML = loadingState('Chargement des clients…');
    const params = new URLSearchParams();
    if (state.q.trim()) params.set('q', state.q.trim());
    if (state.stage) params.set('stage', state.stage);
    params.set('sort', state.sort);
    if (state.view === 'pipeline') { params.set('limit', '200'); params.set('page', '1'); }
    else { params.set('limit', String(state.perPage)); params.set('page', String(state.page)); }
    try {
      const result = await api(`/api/app/crm/customers?${params}`);
      const rows = Array.isArray(result.customers) ? result.customers : [];
      currentRows = rows;
      const pagination = result.pagination || {};
      const stageCounts = result.stageCounts || { nouveau: 0, actif: 0, a_relancer: 0, inactif: 0 };
      if (state.view === 'pipeline') {
        const groups = { nouveau: [], actif: [], a_relancer: [], inactif: [] };
        rows.forEach((r) => { groups[customerStage(r)].push(r); });
        body.innerHTML = `<div class="cli-pipe">${Object.keys(CUSTOMER_STAGES).map((st) => {
          const meta = CUSTOMER_STAGES[st];
          const cards = groups[st].map(pipeCard).join('');
          return `<section class="cli-col">
            <header class="cli-col-head"><span class="cli-col-dot" style="background:${meta.dot}"></span><strong>${meta.plural}</strong><span class="cli-col-count">${stageCounts[st] ?? groups[st].length}</span></header>
            <div class="cli-col-body" data-stage="${st}">${cards || '<div class="cli-col-empty">Aucun client</div>'}</div>
          </section>`;
        }).join('')}</div>`;
      } else if (!rows.length) {
        body.innerHTML = `<div class="cli-empty"><strong>${state.q || state.stage ? 'Aucun client ne correspond.' : 'Aucun client enregistré.'}</strong><p>${state.q || state.stage ? 'Modifiez la recherche ou les filtres.' : 'Les fiches apparaissent à partir des commandes, ou créez un client.'}</p></div>`;
      } else if (state.view === 'gallery') {
        body.innerHTML = `<div class="cli-gallery">${rows.map(galleryCard).join('')}</div>${pagerHtml(pagination)}`;
      } else {
        body.innerHTML = `<div class="cli-table-wrap"><table class="cli-table">
          <thead><tr>
            <th class="cli-check"><input type="checkbox" id="cliAll" aria-label="Tout sélectionner"></th>
            <th>N° client</th><th>Nom du client</th><th>Téléphone</th><th>Statut</th><th>Commandes</th><th>Lieux connus</th><th>Dernière activité</th><th>Actions</th>
          </tr></thead>
          <tbody>${rows.map(crmRow).join('')}</tbody>
        </table></div>${pagerHtml(pagination)}`;
      }
      bindRows();
    } catch (error) {
      body.innerHTML = `<div class="notice error" role="alert"><strong>Impossible de charger les clients.</strong><p>${escapeHtml(error.message)}</p><button class="secondary" id="cliRetry" type="button">Réessayer</button></div>`;
      document.getElementById('cliRetry')?.addEventListener('click', load);
    } finally {
      body.removeAttribute('aria-busy');
      loading = false;
    }
  };

  // Onglets de vue
  document.querySelectorAll('.cli-tab').forEach((tab) => tab.addEventListener('click', () => {
    if (state.view === tab.dataset.view) return;
    state.view = tab.dataset.view; state.page = 1; load();
  }));
  // Recherche (léger debounce)
  let searchTimer = null;
  queryInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = queryInput.value; state.page = 1; load(); }, 280);
  });
  // Menus Filtrer / Trier
  const buildMenu = (menuEl, items, current, onPick) => {
    const btn = menuEl.querySelector('button');
    let open = false;
    const close = () => { menuEl.querySelector('.cli-pop')?.remove(); open = false; btn.classList.remove('active'); };
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (open) { close(); return; }
      document.querySelectorAll('.cli-pop').forEach((p) => p.remove());
      const pop = document.createElement('div');
      pop.className = 'cli-pop';
      pop.innerHTML = items.map((it) => `<button type="button" class="cli-pop-item ${it.value === current() ? 'active' : ''}" data-value="${it.value}">${escapeHtml(it.label)}</button>`).join('');
      menuEl.appendChild(pop);
      open = true; btn.classList.add('active');
      pop.querySelectorAll('[data-value]').forEach((b) => b.addEventListener('click', () => { onPick(b.dataset.value); close(); }));
    });
    document.addEventListener('click', (event) => { if (open && !menuEl.contains(event.target)) close(); });
  };
  buildMenu(document.getElementById('cliFilterMenu'),
    [{ value: '', label: 'Tous les statuts' }, { value: 'nouveau', label: 'Nouveau' }, { value: 'actif', label: 'Actif' }, { value: 'a_relancer', label: 'À relancer' }, { value: 'inactif', label: 'Inactif' }],
    () => state.stage, (v) => { state.stage = v; state.page = 1; document.getElementById('cliFilterBtn').classList.toggle('has-value', Boolean(v)); load(); });
  buildMenu(document.getElementById('cliSortMenu'),
    Object.keys(SORT_LABELS).map((k) => ({ value: k, label: SORT_LABELS[k] })),
    () => state.sort, (v) => { state.sort = v; load(); });
  // Nouveau client
  document.getElementById('cliNew').addEventListener('click', () => openNewCustomerModal(load));

  syncTabs();
  await load();
}

function openNewCustomerModal(onCreated) {
  const overlay = document.createElement('div');
  overlay.className = 'cli-modal-overlay';
  overlay.innerHTML = `<div class="cli-modal" role="dialog" aria-modal="true" aria-label="Nouveau client">
    <div class="cli-modal-head"><strong>Nouveau client</strong><button type="button" class="cli-modal-x" aria-label="Fermer">✕</button></div>
    <form id="cliNewForm" class="cli-modal-body">
      <label class="field"><span>Nom du client *</span><input name="displayName" type="text" maxlength="200" required autocomplete="off" placeholder="Ex. Boutique Tendance"></label>
      <label class="field"><span>Secteur d'activité</span><input name="sector" type="text" maxlength="120" autocomplete="off" placeholder="Ex. Commerce de détail"></label>
      <label class="field"><span>Téléphone</span><input name="phone" type="tel" maxlength="320" autocomplete="off" placeholder="Ex. 229 97 00 00 00"></label>
      <div class="cli-modal-err" hidden></div>
      <div class="cli-modal-foot"><button type="button" class="button secondary" id="cliNewCancel">Annuler</button><button type="submit" class="button primary">Créer le client</button></div>
    </form>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.cli-modal-x').addEventListener('click', close);
  overlay.querySelector('#cliNewCancel').addEventListener('click', close);
  const form = overlay.querySelector('#cliNewForm');
  const err = overlay.querySelector('.cli-modal-err');
  form.querySelector('input[name="displayName"]').focus();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const displayName = String(values.get('displayName') || '').trim();
    if (!displayName) { err.hidden = false; err.textContent = 'Le nom du client est requis.'; return; }
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true; submit.textContent = 'Création…';
    try {
      await api('/api/app/crm/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, sector: values.get('sector') || '', phone: values.get('phone') || '' }),
      });
      close();
      if (typeof onCreated === 'function') onCreated();
    } catch (error) {
      err.hidden = false; err.textContent = error.message || 'Création impossible.';
      submit.disabled = false; submit.textContent = 'Créer le client';
    }
  });
}

function contactMarkup(contact) {
  return `<li><div><strong>${escapeHtml(contactKindLabels[contact.kind] || contact.kind || 'Contact')}</strong>${contact.is_primary ? ' <span class="badge success">Principal</span>' : ''}
    <p>${escapeHtml(contact.value_display || 'Non renseigné')}</p><small>${escapeHtml(contact.label || contact.contact_name || '')}${contact.is_active === false ? ' · Inactif' : ''}</small></div></li>`;
}

function locationMarkup(place) {
  const description = [place.neighborhood, place.locality].filter(Boolean).join(' · ');
  return `<article class="crm-subcard"><div class="customer-card-heading"><h3>${escapeHtml(place.label || 'Lieu de livraison')}</h3>${place.is_active === false ? '<span class="badge">Archivé</span>' : ''}</div>
    ${description ? `<p><strong>${escapeHtml(description)}</strong></p>` : ''}${place.address_text ? `<p>${escapeHtml(place.address_text)}</p>` : ''}
    ${place.landmark ? `<p><strong>Repère :</strong> ${escapeHtml(place.landmark)}</p>` : ''}${place.delivery_instructions ? `<p><strong>Instructions :</strong> ${escapeHtml(place.delivery_instructions)}</p>` : ''}
    <small>Dernière utilisation : ${escapeHtml(formatDate(place.last_used_at))}</small></article>`;
}

async function renderCustomerDetail(id) {
  setHeader('Fiche client', 'Contacts, lieux et historique opérationnel');
  page.classList.add('page-crm');
  page.innerHTML = `<section class="card">${loadingState('Chargement de la fiche client…')}</section>`;
  try {
    const result = await api(`/api/app/crm/customers/${encodeURIComponent(id)}`);
    const customer = result.customer || {};
    const contacts = Array.isArray(result.contacts) ? result.contacts : [];
    const locations = Array.isArray(result.locations) ? result.locations : [];
    const orders = Array.isArray(result.orders) ? result.orders : [];
    const interactions = Array.isArray(result.interactions) ? result.interactions : [];
    setHeader(customer.display_name || 'Fiche client', 'Contacts, lieux et historique opérationnel');

    const phone = contacts.find((ct) => ct.kind === 'phone' && ct.value_display)?.value_display || null;
    const telHref = phone ? String(phone).replace(/[^+\d]/g, '') : '';
    const lastOrderAt = orders.reduce((max, o) => { const t = new Date(o.created_at).getTime(); return t > max ? t : max; }, 0);
    const avatarRow = { id: customer.id, display_name: customer.display_name };

    const tabAperçu = `
      <div class="fiche-grid">
        <section class="fiche-card"><div class="fiche-card-head"><h3>Informations</h3><button type="button" class="fiche-edit-btn" id="ficheEdit">Modifier</button></div><dl class="fiche-dl">
          <div><dt>Secteur</dt><dd>${escapeHtml(customer.sector || '—')}</dd></div>
          <div><dt>Langue préférée</dt><dd>${escapeHtml(customer.preferred_language || 'Non renseignée')}</dd></div>
          <div><dt>Création de la fiche</dt><dd>${escapeHtml(formatDate(customer.created_at))}</dd></div>
          <div><dt>Téléphone principal</dt><dd>${escapeHtml(phone || '—')}</dd></div>
        </dl>${customer.service_notes ? `<div class="notice"><strong>Note de service</strong><p>${escapeHtml(customer.service_notes)}</p></div>` : ''}</section>
        <section class="fiche-card"><h3>Résumé</h3><div class="fiche-mini">
          <div><span>Commandes</span><strong>${formatInteger(orders.length)}</strong></div>
          <div><span>Lieux connus</span><strong>${formatInteger(locations.length)}</strong></div>
          <div><span>Contacts</span><strong>${formatInteger(contacts.length)}</strong></div>
          <div><span>Interactions</span><strong>${formatInteger(interactions.length)}</strong></div>
        </div></section>
      </div>`;
    const tabContacts = contacts.length
      ? `<section class="fiche-card"><ul class="crm-contact-list">${contacts.map(contactMarkup).join('')}</ul></section>`
      : '<div class="cli-empty"><strong>Aucun contact enregistré.</strong><p>Les contacts s\'ajoutent à partir des commandes.</p></div>';
    const tabLieux = locations.length
      ? `<p class="section-hint" style="margin:0 2px 12px">Les coordonnées GPS restent protégées et ne sont pas affichées ici.</p><div class="crm-subcard-list">${locations.map(locationMarkup).join('')}</div>`
      : '<div class="cli-empty"><strong>Aucun lieu enregistré.</strong><p>Les lieux de livraison apparaissent à partir des commandes.</p></div>';
    const tabCommandes = orders.length
      ? `<section class="fiche-card"><div class="table-wrap"><table class="cli-table"><thead><tr><th>Commande</th><th>Créée le</th><th>Destination</th><th>Livreur</th><th>État</th></tr></thead><tbody>${orders.map((order) => `<tr><td><a href="/app/commandes/${encodeURIComponent(order.id)}"><strong>${escapeHtml(orderCode(order.reference, order.id))}</strong></a></td><td>${escapeHtml(formatDate(order.created_at))}</td><td>${escapeHtml(order.neighborhood || order.landmark || '—')}</td><td>${escapeHtml(order.driver_name || '—')}</td><td>${badge(order.status)}</td></tr>`).join('')}</tbody></table></div></section>`
      : '<div class="cli-empty"><strong>Aucune commande liée.</strong><p>Créez une commande pour ce client.</p></div>';
    const tabActivite = interactions.length
      ? `<section class="fiche-card"><ol class="timeline">${interactions.map((interaction) => `<li><strong>${escapeHtml(interactionPurposeLabels[interaction.purpose] || interaction.purpose || 'Échange')}</strong><span>${escapeHtml(interactionChannelLabels[interaction.channel] || interaction.channel || 'Canal non précisé')}${interaction.outcome ? ` · ${escapeHtml(interactionOutcomeLabels[interaction.outcome] || interaction.outcome)}` : ''}</span><small>${escapeHtml(formatDate(interaction.occurred_at))}</small>${interaction.summary ? `<p>${escapeHtml(interaction.summary)}</p>` : ''}</li>`).join('')}</ol></section>`
      : '<div class="cli-empty"><strong>Aucune interaction enregistrée.</strong><p>L\'historique des échanges apparaîtra ici.</p></div>';
    const tabs = { apercu: tabAperçu, contacts: tabContacts, lieux: tabLieux, commandes: tabCommandes, activite: tabActivite };

    page.innerHTML = `<div class="fiche">
      <a class="fiche-back" href="/app/clients">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>'} Retour aux clients</a>
      <header class="fiche-head">
        ${customerAvatarHtml(avatarRow, 'cli-av cli-av-lg')}
        <div class="fiche-head-main"><h1>${escapeHtml(customer.display_name || 'Client sans nom')}</h1><p>${escapeHtml(customerCode(customer))}${customer.sector ? ` · ${escapeHtml(customer.sector)}` : ''}</p></div>
        ${customerStatusBadge(customer.status)}
        <div class="fiche-actions">
          <a class="button secondary" href="/app/nouvelle-commande">Nouvelle commande</a>
          ${telHref ? `<a class="button secondary" href="tel:${escapeHtml(telHref)}">Appeler</a>` : ''}
          <button type="button" class="button secondary" id="ficheArchive">Archiver</button>
        </div>
      </header>
      <nav class="fiche-tabs" id="ficheTabs">
        <button type="button" class="fiche-tab active" data-tab="apercu">Aperçu</button>
        <button type="button" class="fiche-tab" data-tab="contacts">Contacts <span class="fiche-tabn">${formatInteger(contacts.length)}</span></button>
        <button type="button" class="fiche-tab" data-tab="lieux">Lieux <span class="fiche-tabn">${formatInteger(locations.length)}</span></button>
        <button type="button" class="fiche-tab" data-tab="commandes">Commandes <span class="fiche-tabn">${formatInteger(orders.length)}</span></button>
        <button type="button" class="fiche-tab" data-tab="activite">Activité <span class="fiche-tabn">${formatInteger(interactions.length)}</span></button>
      </nav>
      <div class="fiche-body" id="ficheBody">${tabs.apercu}</div>
    </div>`;

    const bodyEl = document.getElementById('ficheBody');
    document.querySelectorAll('.fiche-tab').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('.fiche-tab').forEach((t) => t.classList.toggle('active', t === tab));
      bodyEl.innerHTML = tabs[tab.dataset.tab] || '';
    }));
    document.getElementById('ficheArchive')?.addEventListener('click', async () => {
      if (!(await uiConfirm('Archiver ce client ?', { message: 'Il n’apparaîtra plus dans la liste par défaut.', confirmLabel: 'Archiver' }))) return;
      try {
        await api(`/api/app/crm/customers/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }) });
        location.href = '/app/clients';
      } catch (error) { uiToast(error.message || 'Archivage impossible.', 'error'); }
    });

    // Édition en ligne de la fiche (nom, secteur, note de service).
    const showEditForm = () => {
      bodyEl.innerHTML = `<section class="fiche-card"><h3>Modifier la fiche</h3>
        <form id="ficheEditForm" class="fiche-form">
          <label>Nom du client<input name="displayName" maxlength="160" required value="${escapeHtml(customer.display_name || '')}"></label>
          <label>Secteur<input name="sector" maxlength="120" value="${escapeHtml(customer.sector || '')}" placeholder="Ex. Restauration, e-commerce…"></label>
          <label>Note de service<textarea name="serviceNotes" maxlength="2000" rows="4" placeholder="Contexte, préférences, consignes de livraison…">${escapeHtml(customer.service_notes || '')}</textarea></label>
          <p class="fiche-form-msg" id="ficheEditMsg" role="alert" hidden></p>
          <div class="fiche-form-actions">
            <button type="submit" class="button">Enregistrer</button>
            <button type="button" class="button secondary" id="ficheEditCancel">Annuler</button>
          </div>
        </form></section>`;
      document.getElementById('ficheEditCancel').addEventListener('click', () => { bodyEl.innerHTML = tabs.apercu; });
      document.getElementById('ficheEditForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const msg = document.getElementById('ficheEditMsg');
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
          await api(`/api/app/crm/customers/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              displayName: form.displayName.value.trim(),
              sector: form.sector.value.trim(),
              serviceNotes: form.serviceNotes.value.trim(),
            }),
          });
          await renderCustomerDetail(id);
        } catch (error) {
          submitBtn.disabled = false;
          msg.textContent = error.message || 'Enregistrement impossible.';
          msg.hidden = false;
        }
      });
    };
    // Délégation : le bouton « Modifier » est ré-injecté à chaque retour sur l'onglet Aperçu.
    bodyEl.addEventListener('click', (event) => { if (event.target.closest('#ficheEdit')) showEditForm(); });
  } catch (error) {
    page.innerHTML = `<div class="page-header"><div><a href="/app/clients">← Retour aux clients</a><h1 style="margin-top:12px">Fiche client</h1></div></div><div class="notice error" role="alert"><strong>Impossible de charger cette fiche.</strong><p>${escapeHtml(error.message)}</p><button class="secondary" id="retryCustomerDetail" type="button">Réessayer</button></div>`;
    document.getElementById('retryCustomerDetail')?.addEventListener('click', () => renderCustomerDetail(id));
  }
}

function currentPortoNovoMonth() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

function monthPeriod(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error('Sélectionnez un mois valide.');
  const [year, month] = value.split('-').map(Number);
  if (month < 1 || month > 12) throw new Error('Sélectionnez un mois valide.');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${value}-01`, to: `${value}-${String(lastDay).padStart(2, '0')}` };
}

function metricNumber(metric) {
  return metric?.status === 'available' && Number.isFinite(Number(metric.value)) ? formatInteger(metric.value) : 'Non calculable';
}

function reportsMarkup(metrics) {
  const outcomes = metrics.volumes?.outcomes || {};
  const deliveryRate = metrics.delivery?.deliveryRate;
  const incidents = metrics.incidents || {};
  const delays = metrics.delays || {};
  const currencies = Array.isArray(metrics.collections?.currencies) ? metrics.collections.currencies : [];
  const exclusionCount = Object.values(metrics.dataQuality?.exclusions || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return `<section class="grid report-stats" aria-label="Indicateurs du mois">
      <article class="stat"><span>Commandes créées</span><strong>${metricNumber(metrics.volumes?.ordersCreated)}</strong></article>
      <article class="stat"><span>Commandes prises en charge</span><strong>${metricNumber(metrics.volumes?.ordersPickedUp)}</strong></article>
      <article class="stat"><span>Commandes clôturées</span><strong>${metricNumber(metrics.volumes?.closed)}</strong></article>
      <article class="stat"><span>Taux de livraison</span><strong>${deliveryRate?.status === 'available' ? formatPercent(deliveryRate.value) : 'Non calculable'}</strong><small>Livrées ÷ (livrées + retournées)</small></article>
    </section>
    <div class="report-grid">
      <section class="card"><h2>Issue des commandes clôturées</h2><dl class="report-breakdown"><div><dt>Livrées</dt><dd>${formatCount(outcomes.delivered)}</dd></div><div><dt>Retournées</dt><dd>${formatCount(outcomes.returned)}</dd></div><div><dt>Annulées</dt><dd>${formatCount(outcomes.cancelled)}</dd></div></dl><p class="section-hint">Les commandes annulées ne sont pas utilisées pour calculer le taux de livraison.</p></section>
      <section class="card"><h2>Incidents</h2><dl class="report-breakdown"><div><dt>Ouverts pendant le mois</dt><dd>${metricNumber(incidents.opened)}</dd></div><div><dt>Résolus pendant le mois</dt><dd>${metricNumber(incidents.resolved)}</dd></div><div><dt>Encore ouverts à la date du rapport</dt><dd>${metricNumber(incidents.openAtAsOf)}</dd></div></dl><p class="section-hint">Un incident décrit un contexte opérationnel. Il ne prouve pas une faute du livreur.</p></section>
      <section class="card"><h2>Respect des créneaux</h2>${delays.status === 'available' ? `<dl class="report-breakdown"><div><dt>Livraisons en retard</dt><dd>${formatPercent(delays.lateRate)}</dd></div><div><dt>Retard médian</dt><dd>${delays.lateCount === 0 ? 'Aucun retard' : `${formatCount(delays.medianLateMinutes)} min`}</dd></div><div><dt>Échantillon fiable</dt><dd>${formatCount(delays.reliableSampleSize)}</dd></div></dl>` : `<div class="metric-unavailable"><strong>Non calculable</strong><p>Les créneaux et heures d’arrivée fiables sont insuffisants pour publier cet indicateur.</p></div>`}</section>
      <section class="card"><h2>Charge actuelle</h2><dl class="report-breakdown"><div><dt>Colis ouverts</dt><dd>${formatCount(metrics.load?.openParcelCount)}</dd></div><div><dt>Colis en cours</dt><dd>${formatCount(metrics.load?.inProgressParcelCount)}</dd></div><div><dt>Livreurs avec une charge</dt><dd>${formatCount(metrics.load?.driversWithLoad)}</dd></div></dl><p class="section-hint">Photo de la charge au moment de l’ouverture du rapport, pas une mesure de productivité.</p></section>
    </div>
    <section class="card crm-section"><div class="section-heading"><div><h2>Encaissements par devise</h2><p class="section-hint">Les devises ne sont jamais additionnées ni converties entre elles.</p></div><button class="secondary" type="button" id="exportReportBtn" aria-describedby="exportHint">Exporter vers Excel</button></div><p id="exportHint" class="section-hint">Télécharge les commandes du mois (identifiant, statut, zone, livreur, tournée, encaissement, incidents) au format Excel. Les données personnelles des clients ne sont pas incluses.</p><p id="exportStatus" class="section-hint" role="status" aria-live="polite"></p>${currencies.length ? `<div class="collection-grid">${currencies.map((entry) => `<article class="crm-subcard"><h3>${escapeHtml(entry.currency)}</h3><dl class="report-breakdown"><div><dt>Attendu sur les commandes clôturées</dt><dd>${escapeHtml(formatMinorMoney(entry.expectedForClosedOrdersMinor, entry.currency))}</dd></div><div><dt>Collecté brut</dt><dd>${escapeHtml(formatMinorMoney(entry.collectedGrossMinor, entry.currency))}</dd></div><div><dt>Net après corrections</dt><dd>${escapeHtml(formatMinorMoney(entry.netCollectedMinor, entry.currency))}</dd></div></dl></article>`).join('')}</div>` : '<div class="empty compact-empty">Aucun encaissement pour cette période.</div>'}</section>
    ${exclusionCount ? `<div class="notice warning"><strong>Qualité des données à surveiller.</strong> ${formatInteger(exclusionCount)} élément${exclusionCount > 1 ? 's ont' : ' a'} été exclu${exclusionCount > 1 ? 's' : ''} des calculs car les informations nécessaires étaient incomplètes ou contradictoires.</div>` : '<div class="notice success">Aucune exclusion de données signalée pour les indicateurs calculés.</div>'}
    <div class="notice"><strong>Lecture responsable :</strong> ces chiffres servent à suivre les opérations. Aucun score, classement ou sanction automatique des livreurs n’est produit.</div>`;
}

// --- Rapports : assistant d'export en 3 étapes (choisir → configurer → télécharger) ---
const REPORT_ICONS = {
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M6 16V9a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v0"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z"/><path d="M12 9v4M12 17h.01"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
};
// Illustrations isométriques « 3D » (SVG inline, aucune image) pour les cartes.
const REPORT_ART = {
  orders: '<svg viewBox="0 0 140 130" fill="none" aria-hidden="true"><ellipse cx="70" cy="114" rx="44" ry="8" fill="#0b1b3a" opacity=".06"/><path d="M70 26 112 50 70 74 28 50Z" fill="#f4f7fb"/><path d="M28 50 70 74 70 116 28 92Z" fill="#d9e0ea"/><path d="M112 50 70 74 70 116 112 92Z" fill="#c4cdda"/><path d="M49 38 70 50 91 38 70 26Z" fill="#e11d2a" opacity=".92"/><path d="M28 70 70 94 70 104 28 80Z" fill="#e11d2a"/><path d="M112 70 70 94 70 104 112 80Z" fill="#b3141f"/></svg>',
  routes: '<svg viewBox="0 0 150 130" fill="none" aria-hidden="true"><ellipse cx="75" cy="116" rx="52" ry="8" fill="#0b1b3a" opacity=".06"/><path d="M18 34 54 24 54 100 18 110Z" fill="#eef2f7"/><path d="M54 24 96 34 96 110 54 100Z" fill="#e0e7f0"/><path d="M96 34 132 24 132 100 96 110Z" fill="#eef2f7"/><path d="M54 24V100M96 34v76" stroke="#cfd8e3" stroke-width="1.5"/><path d="M34 92Q40 60 66 66T108 50" stroke="#e11d2a" stroke-width="3" fill="none" stroke-linecap="round" stroke-dasharray="1 7"/><circle cx="34" cy="92" r="5" fill="#16233f"/><path d="M108 30c-8 0-14 6-14 13 0 9 14 21 14 21s14-12 14-21c0-7-6-13-14-13Z" fill="#e11d2a"/><circle cx="108" cy="43" r="5" fill="#fff"/></svg>',
  incidents: '<svg viewBox="0 0 132 130" fill="none" aria-hidden="true"><ellipse cx="60" cy="116" rx="40" ry="7" fill="#0b1b3a" opacity=".06"/><path d="M30 16h46l18 18v74H30Z" fill="#f4f7fb" stroke="#e2e8f0" stroke-width="2"/><path d="M76 16v18h18Z" fill="#e2e8f0"/><path d="M42 52h30M42 64h38M42 76h22" stroke="#cfd8e3" stroke-width="3.4" stroke-linecap="round"/><path d="M96 58l24 44H72Z" fill="#e11d2a"/><path d="M96 74v13M96 94v.5" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/></svg>',
  clients: '<svg viewBox="0 0 150 130" fill="none" aria-hidden="true"><ellipse cx="75" cy="116" rx="50" ry="8" fill="#0b1b3a" opacity=".06"/><circle cx="45" cy="54" r="15" fill="#cfd8e3"/><path d="M21 102a24 24 0 0 1 48 0Z" fill="#cfd8e3"/><circle cx="105" cy="54" r="15" fill="#dbe2ec"/><path d="M81 102a24 24 0 0 1 48 0Z" fill="#dbe2ec"/><circle cx="75" cy="46" r="19" fill="#e11d2a"/><path d="M44 106a31 31 0 0 1 62 0Z" fill="#e11d2a"/></svg>',
};
const REPORT_SOURCES = [
  { key: 'orders', dataset: 'operations', label: 'Commandes', icon: 'box',
    desc: 'Exportez vos commandes, leur statut, leur affectation et leurs informations de livraison.', list: '/api/app/orders?trash=all' },
  { key: 'routes', dataset: 'routes', label: 'Tournées', icon: 'route',
    desc: 'Exportez vos tournées, leurs livreurs, leurs arrêts et leur état.', list: '/api/app/runs' },
  { key: 'incidents', dataset: 'incidents', label: 'Incidents', icon: 'alert',
    desc: 'Exportez les incidents signalés et leur état de traitement.', list: '/api/app/incidents' },
  { key: 'clients', dataset: 'customers', label: 'Clients', icon: 'users',
    desc: 'Exportez les clients enregistrés et leurs informations utiles.', list: '/api/app/crm/customers' },
];
// Colonnes d'export par source. Les colonnes de base sont toujours incluses par
// le contrat serveur ; les « sensibles » sont facultatives (inclusion tracée).
const REPORT_COLUMNS = {
  orders: {
    base: [
      { key: 'reference', label: 'ID commande' }, { key: 'created_at', label: 'Date de création' },
      { key: 'status', label: 'Statut' }, { key: 'destination_zone', label: 'Zone' },
      { key: 'driver_reference', label: 'Livreur' }, { key: 'run_reference', label: 'Tournée' },
      { key: 'requested_window', label: 'Créneau souhaité' }, { key: 'delivered_at', label: 'Livrée le' },
      { key: 'incident_count', label: 'Nb incidents' },
    ],
    sensitive: [
      { key: 'customer_name', label: 'Client', on: true }, { key: 'customer_phone', label: 'Téléphone', on: false },
      { key: 'delivery_address', label: 'Adresse', on: false }, { key: 'delivery_instructions', label: 'Instructions', on: false },
    ],
  },
  clients: {
    base: [
      { key: 'customer_reference', label: 'ID client' }, { key: 'destination_zone', label: 'Zone' },
      { key: 'order_count', label: 'Commandes' }, { key: 'completed_order_count', label: 'Commandes livrées' },
      { key: 'last_order_at', label: 'Dernière commande' },
    ],
    sensitive: [{ key: 'customer_name', label: 'Nom', on: true }, { key: 'customer_phone', label: 'Téléphone', on: false }],
  },
  incidents: {
    base: [
      { key: 'incident_id', label: 'ID incident' }, { key: 'order_id', label: 'Commande' },
      { key: 'category', label: 'Type' }, { key: 'severity', label: 'Gravité' }, { key: 'status', label: 'Statut' },
      { key: 'opened_at', label: 'Ouvert le' }, { key: 'resolved_at', label: 'Résolu le' }, { key: 'resolution_code', label: 'Résolution' },
    ],
    sensitive: [],
  },
  routes: {
    base: [
      { key: 'run_reference', label: 'ID tournée' }, { key: 'service_date', label: 'Date' },
      { key: 'driver_reference', label: 'Livreur' }, { key: 'status', label: 'Statut' },
      { key: 'stop_count', label: 'Arrêts' }, { key: 'order_count', label: 'Commandes' },
      { key: 'started_at', label: 'Début' }, { key: 'completed_at', label: 'Fin' },
    ],
    sensitive: [],
  },
};
// Correspondance entre les filtres UI et les filtres réellement appliqués au
// fichier exporté (via le contrat). Les autres filtres n'affinent que l'aperçu.
const REPORT_EXPORT_FILTER_MAP = {
  orders: { status: 'status', zone: 'destination_zone' },
  clients: { status: 'activity_status' },
  incidents: { status: 'status', type: 'category' },
  routes: { status: 'status' },
};
// Filtres (menus déroulants) par source, alimentés par les valeurs réelles.
const REPORT_FILTERS = {
  orders: [{ k: 'status', label: 'Tous les statuts' }, { k: 'zone', label: 'Toutes les zones' }, { k: 'driver', label: 'Tous les livreurs' }],
  clients: [{ k: 'status', label: 'Tous les statuts' }, { k: 'type', label: 'Tous les types' }, { k: 'zone', label: 'Toutes les zones' }],
  routes: [{ k: 'status', label: 'Tous les statuts' }, { k: 'driver', label: 'Tous les livreurs' }],
  incidents: [{ k: 'status', label: 'Tous les statuts' }, { k: 'type', label: 'Tous les types' }],
};

function reportStepper(active) {
  const steps = [['1', 'Choisir les données'], ['2', 'Configurer l’export'], ['3', 'Télécharger']];
  return `<ol class="rep-steps">${steps.map(([n, label], i) => {
    const idx = i + 1;
    const state = idx < active ? 'done' : (idx === active ? 'current' : 'todo');
    const dot = state === 'done'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      : n;
    return `<li class="rep-step ${state}"><span class="rep-step-dot">${dot}</span><span class="rep-step-label">${idx}. ${escapeHtml(label)}</span></li>`;
  }).join('')}</ol>`;
}

function reportSetSource(key) {
  const url = key ? `/app/rapports?source=${encodeURIComponent(key)}` : '/app/rapports';
  history.pushState({}, '', url);
  renderReports();
}

async function renderReports() {
  setHeader('Rapports', 'Vos données, au même endroit.');
  if (window.TraxoReports) return window.TraxoReports.render(page, { api, context, uiToast });
  page.classList.remove('page-crm');
  const sourceKey = new URLSearchParams(location.search).get('source');
  const source = REPORT_SOURCES.find((s) => s.key === sourceKey);
  if (!source) return reportStepStart();
  return reportStepConfigure(source);
}

// Étape 1 — choisir la source.
function reportStepStart() {
  page.innerHTML = `<div class="rep">
    ${reportStepper(1)}
    <div class="rep-head"><span class="rep-rule"></span><h1>Quels rapports souhaitez-vous exporter ?</h1><p>Sélectionnez le type de données que vous souhaitez exporter depuis TRAXO.</p></div>
    <div class="rep-sources">${REPORT_SOURCES.map((s) => `
      <button type="button" class="rep-source" data-source="${s.key}">
        <span class="rep-source-body">
          <span class="rep-source-ic">${REPORT_ICONS[s.icon]}</span>
          <strong>${escapeHtml(s.label)}</strong>
          <small>${escapeHtml(s.desc)}</small>
          <span class="rep-source-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
        </span>
        <span class="rep-source-art" aria-hidden="true">${REPORT_ART[s.key] || ''}</span>
      </button>`).join('')}</div>
  </div>`;
  page.querySelectorAll('.rep-source').forEach((btn) => btn.addEventListener('click', () => reportSetSource(btn.dataset.source)));
}

// Étape 2 — configurer et générer.
async function reportStepConfigure(source) {
  const firstOfThisMonth = `${currentPortoNovoMonth()}-01`;
  const today = new Date().toISOString().slice(0, 10);
  const cols = REPORT_COLUMNS[source.key] || { base: [], sensitive: [] };
  const filtersDef = REPORT_FILTERS[source.key] || [];

  page.innerHTML = `<div class="rep">
    ${reportStepper(2)}
    <div class="rep-head"><span class="rep-rule"></span><h1>Configurer l’export</h1><p>Affinez les données à exporter puis choisissez votre format.</p></div>
    <section class="rep-config" id="repShell">${loadingState('Chargement de l’aperçu…')}</section>
    <div class="rep-back"><button type="button" class="link-btn" id="repBack">← Changer de source</button></div>
  </div>`;
  document.getElementById('repBack').addEventListener('click', () => reportSetSource(null));

  // Charge les données réelles puis construit la barre + le tableau.
  let allRows = [];
  let loadError = null;
  try { allRows = reportExtractRows(source.key, await api(source.list)); }
  catch (error) { loadError = error.message || 'Aperçu indisponible.'; }

  const distinct = (k) => [...new Set(allRows.map((r) => r.f && r.f[k]).filter((v) => v && v !== '—'))].sort();
  const filtersHtml = filtersDef.map((f) => `<div class="rep-sel"><select data-filter="${f.k}"><option value="">${escapeHtml(f.label)}</option>${distinct(f.k).map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}</select></div>`).join('');
  const colSummary = cols.base.length + cols.sensitive.filter((c) => c.on).length;

  document.getElementById('repShell').innerHTML = `
    <div class="rep-config-bar">
      <div class="rep-source-tag"><span class="rep-source-ic sm">${REPORT_ICONS[source.icon]}</span>Source : <strong>${escapeHtml(source.label)}</strong></div>
      <div class="rep-period"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg><input type="date" id="repFrom" value="${firstOfThisMonth}"><span>→</span><input type="date" id="repTo" value="${today}"></div>
      ${filtersHtml}
      <input type="search" id="repSearch" class="rep-search" placeholder="Rechercher…">
      <div class="rep-format" role="group" aria-label="Format">
        <button type="button" class="rep-fmt active" data-fmt="csv">CSV</button>
        <button type="button" class="rep-fmt" data-fmt="xlsx">Excel</button>
        <button type="button" class="rep-fmt" data-fmt="premium">Premium</button>
      </div>
      <div class="rep-fields-wrap">
        <button type="button" class="button secondary" id="repFieldsBtn">Choisir les champs</button>
        <div class="rep-fields-pop" id="repFieldsPop" hidden></div>
      </div>
      <button type="button" class="button primary rep-gen" id="repGenerate">Générer l’export <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
    </div>
    <div class="rep-preview" id="repPreview"></div>
    <p class="rep-msg" id="repMsg" hidden></p>`;

  // Format segmenté.
  let format = 'csv';
  document.querySelectorAll('.rep-fmt').forEach((btn) => btn.addEventListener('click', () => {
    format = btn.dataset.fmt;
    document.querySelectorAll('.rep-fmt').forEach((b) => b.classList.toggle('active', b === btn));
  }));

  // Sélecteur de colonnes.
  const sensitiveState = new Map(cols.sensitive.map((c) => [c.key, c.on]));
  const fieldsPop = document.getElementById('repFieldsPop');
  const fieldsBtn = document.getElementById('repFieldsBtn');
  const rowsHtml = [
    ...cols.base.map((c) => `<label class="rep-field-row"><input type="checkbox" checked disabled><span>${escapeHtml(c.label)}</span><small>Toujours incluse</small></label>`),
    ...cols.sensitive.map((c) => `<label class="rep-field-row"><input type="checkbox" data-col="${c.key}" ${c.on ? 'checked' : ''}><span>${escapeHtml(c.label)}</span><small>Sensible</small></label>`),
  ].join('');
  fieldsPop.innerHTML = `<div class="rep-fields-head">Colonnes à exporter</div>${rowsHtml || '<div class="rep-field-row"><span>Colonnes standard</span></div>'}`;
  fieldsPop.querySelectorAll('input[data-col]').forEach((cb) => cb.addEventListener('change', () => sensitiveState.set(cb.dataset.col, cb.checked)));
  fieldsBtn.addEventListener('click', (e) => { e.stopPropagation(); fieldsPop.hidden = !fieldsPop.hidden; });
  document.addEventListener('click', (e) => { if (!e.target.closest('.rep-fields-wrap')) fieldsPop.hidden = true; });

  // Aperçu filtré.
  const preview = document.getElementById('repPreview');
  const activeFilters = () => filtersDef.map((f) => [f.k, document.querySelector(`select[data-filter="${f.k}"]`)?.value || '']).filter(([, v]) => v);
  const renderPreview = () => {
    if (loadError) { preview.innerHTML = `<div class="notice error">${escapeHtml(loadError)}</div>`; return; }
    const from = document.getElementById('repFrom').value;
    const to = document.getElementById('repTo').value;
    const q = document.getElementById('repSearch').value.trim().toLowerCase();
    const fils = activeFilters();
    const filtered = allRows.filter((r) => {
      const d = (r._date || '').slice(0, 10);
      if (from && d && d < from) return false;
      if (to && d && d > to) return false;
      if (q && !r._search.includes(q)) return false;
      for (const [k, v] of fils) if ((r.f && r.f[k]) !== v) return false;
      return true;
    });
    preview.dataset.count = String(filtered.length);
    preview.innerHTML = reportPreviewTable(source.key, filtered);
  };
  renderPreview();
  ['repFrom', 'repTo'].forEach((id) => document.getElementById(id).addEventListener('change', renderPreview));
  document.getElementById('repSearch').addEventListener('input', renderPreview);
  document.querySelectorAll('select[data-filter]').forEach((sel) => sel.addEventListener('change', renderPreview));

  // Génération.
  document.getElementById('repGenerate').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const msg = document.getElementById('repMsg');
    const from = document.getElementById('repFrom').value;
    const to = document.getElementById('repTo').value;
    if (!from || !to) { msg.hidden = false; msg.className = 'rep-msg err'; msg.textContent = 'Choisissez une période (du / au).'; return; }
    const exclusiveTo = new Date(new Date(`${to}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
    const sensitiveColumns = [...sensitiveState.entries()].filter(([, on]) => on).map(([k]) => k);
    // Filtres réellement appliqués au fichier (ceux que le contrat prend en charge).
    const fmap = REPORT_EXPORT_FILTER_MAP[source.key] || {};
    const exportFilters = {};
    for (const [k, v] of activeFilters()) if (fmap[k]) exportFilters[fmap[k]] = v;
    const label = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Génération…';
    msg.hidden = true;
    try {
      const response = await fetch('/api/app/crm/exports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset: source.dataset, purpose: `Export ${source.label} depuis Rapports`, period: { from, to: exclusiveTo }, filters: exportFilters, sensitiveColumns, format }),
      });
      if (response.status === 401) { location.href = '/app/login'; return; }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Export impossible pour le moment.');
      }
      const blob = await response.blob();
      const rowCount = Number(response.headers.get('X-Export-Row-Count') || preview.dataset.count || 0);
      const bytes = Number(response.headers.get('X-Export-Bytes') || blob.size || 0);
      const colCount = cols.base.length + sensitiveColumns.length;
      reportStepResult(source, { blob, rowCount, bytes, colCount, from, to, format, filterCount: Object.keys(exportFilters).length });
    } catch (error) {
      btn.disabled = false; btn.innerHTML = label;
      msg.hidden = false; msg.className = 'rep-msg err'; msg.textContent = error.message || 'Export impossible.';
    }
  });
}

// Rend une cellule de l'aperçu : texte simple, badge, ou deux lignes.
function reportCell(cell, first) {
  if (cell == null) return '<td>—</td>';
  if (typeof cell === 'string') return `<td>${first ? `<strong>${escapeHtml(cell)}</strong>` : escapeHtml(cell)}</td>`;
  if (cell.badge === 'order') return `<td>${badge(cell.v)}</td>`;
  if (cell.badge === 'client') return `<td>${customerStatusBadge(cell.v)}</td>`;
  if (cell.badge) return `<td><span class="rep-pill">${escapeHtml(cell.v || '—')}</span></td>`;
  if (cell.sub) return `<td><div class="rep-cell2"><strong>${escapeHtml(cell.v || '—')}</strong><small>${escapeHtml(cell.sub)}</small></div></td>`;
  return `<td>${first ? `<strong>${escapeHtml(cell.v || '—')}</strong>` : escapeHtml(cell.v || '—')}</td>`;
}

// Extrait des lignes normalisées pour l'aperçu selon la source.
function reportExtractRows(key, data) {
  const arr = Array.isArray(data) ? data : (data.items || data.customers || data.orders || data.runs || data.incidents || []);
  return arr.map((r) => {
    if (key === 'orders') {
      return {
        _date: r.created_at, f: { status: r.status || '', zone: r.neighborhood || '', driver: r.driver_name || '' },
        _search: [r.reference, r.customer_name, r.neighborhood, r.driver_name, r.status].filter(Boolean).join(' ').toLowerCase(),
        cells: [orderCode(r.reference, r.id), formatDate(r.created_at), { v: r.customer_name || '—' }, { v: r.neighborhood || '—' }, { v: r.driver_name || '—' }, { badge: 'order', v: r.status }, { v: '—' }, formatDate(r.updated_at)],
      };
    }
    if (key === 'clients') {
      const phone = r.primary_phone || r.phone || '—';
      const zone = r.primary_locality || r.locality || '—';
      return {
        _date: r.last_activity_at || r.last_order_at || r.created_at, f: { status: r.status || '', zone: zone === '—' ? '' : zone, type: r.sector || '' },
        _search: [r.customer_code, r.display_name, phone, r.status, r.sector].filter(Boolean).join(' ').toLowerCase(),
        cells: [r.customer_code || `#${r.id}`, { v: r.display_name || '—' }, { v: phone }, { badge: 'client', v: r.status }, { v: r.sector || '—' }, { v: String(r.order_count ?? '—') }, { v: String(r.location_count ?? r.locations_count ?? '—') }, formatDate(r.last_order_at), formatDate(r.created_at)],
      };
    }
    if (key === 'routes') {
      return {
        _date: r.service_date || r.created_at, f: { status: r.status || '', driver: r.driver_name || '' },
        _search: [r.name, r.driver_name, r.status].filter(Boolean).join(' ').toLowerCase(),
        cells: [r.name || `T-${r.id}`, { v: r.driver_name || '—' }, { badge: 'route', v: r.status }, { v: String(r.stop_count ?? r.stops?.length ?? '—') }, formatDate(r.service_date || r.created_at)],
      };
    }
    // incidents
    return {
      _date: r.created_at || r.opened_at, f: { status: r.status || '', type: r.category || '' },
      _search: [r.category, r.status, r.customer_name].filter(Boolean).join(' ').toLowerCase(),
      cells: [`#${r.id}`, { v: r.category || '—' }, { badge: 'incident', v: r.status }, { v: r.customer_name || (r.order_id ? `Commande ${r.order_id}` : '—') }, formatDate(r.created_at || r.opened_at)],
    };
  });
}

function reportPreviewTable(key, rows) {
  const heads = {
    orders: ['ID commande', 'Date de création', 'Client', 'Zone', 'Livreur', 'Statut', 'Tournée', 'Dernière mise à jour'],
    clients: ['ID client', 'Nom', 'Téléphone', 'Statut', 'Type', 'Commandes', 'Lieux connus', 'Dernière commande', 'Date de création'],
    routes: ['ID tournée', 'Livreur', 'Statut', 'Arrêts', 'Date'],
    incidents: ['ID incident', 'Type', 'Statut', 'Contexte', 'Date'],
  }[key];
  if (!rows.length) return '<div class="cli-empty"><strong>Aucune donnée ne correspond à vos filtres.</strong><p>Élargissez la période ou la recherche.</p></div>';
  const shown = rows.slice(0, 12);
  return `<div class="rep-preview-meta">${formatInteger(rows.length)} ligne${rows.length > 1 ? 's' : ''}${rows.length > shown.length ? ` · aperçu des ${shown.length} premières` : ''}</div>
    <div class="table-wrap"><table class="cli-table rep-table"><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${shown.map((r) => `<tr>${r.cells.map((cell, i) => reportCell(cell, i === 0)).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// Étape 3 — export prêt.
function reportStepResult(source, info) {
  const ext = info.format === 'csv' ? 'csv' : 'xlsx';
  const suffix = info.format === 'premium' ? '-premium' : '';
  const fileName = `${source.key}-${info.from}_${info.to}${suffix}.${ext}`;
  const formatLabel = info.format === 'csv' ? 'CSV' : (info.format === 'premium' ? 'Premium (Excel)' : 'Excel');
  const fileTag = info.format === 'csv' ? 'CSV' : 'XLS';
  const sizeKo = Math.max(1, Math.round(info.bytes / 1024));
  const url = URL.createObjectURL(info.blob);
  const filterCount = info.filterCount || 0;
  page.innerHTML = `<div class="rep">
    ${reportStepper(3)}
    <div class="rep-head"><span class="rep-rule"></span><h1>Export prêt</h1><p>Votre fichier a été généré avec succès.</p></div>
    <div class="rep-result">
      <section class="rep-card">
        <div class="rep-card-head"><span class="rep-card-ic red">${REPORT_ICONS.box}</span><h3>Résumé de l’export</h3></div>
        <dl class="rep-summary">
          <div><dt>Source</dt><dd>${escapeHtml(source.label)}</dd></div>
          <div><dt>Période</dt><dd>${escapeHtml(info.from)} → ${escapeHtml(info.to)}</dd></div>
          <div><dt>Filtres</dt><dd>${filterCount ? `${filterCount} filtre${filterCount > 1 ? 's' : ''} appliqué${filterCount > 1 ? 's' : ''}` : 'Aucun'}</dd></div>
          <div><dt>Format</dt><dd>${formatLabel}</dd></div>
          <div><dt>Colonnes</dt><dd>${formatInteger(info.colCount)}</dd></div>
          <div><dt>Lignes</dt><dd>${formatInteger(info.rowCount)}</dd></div>
        </dl>
      </section>
      <section class="rep-card">
        <div class="rep-card-head"><span class="rep-card-ic green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span><h3>Votre fichier est prêt</h3></div>
        <p class="rep-sub">Téléchargez votre fichier pour l’enregistrer sur votre appareil.</p>
        <div class="rep-file"><span class="rep-file-ic">${fileTag}</span><div><strong>${escapeHtml(fileName)}</strong><small>${formatInteger(info.rowCount)} lignes · ${sizeKo} Ko</small></div></div>
        <a class="button primary rep-dl" href="${url}" download="${escapeHtml(fileName)}">Télécharger le fichier</a>
        <button type="button" class="button secondary rep-again" id="repAgain">Créer un autre export</button>
        <p class="rep-note">Le téléchargement reste disponible tant que vous gardez cette page ouverte.</p>
      </section>
    </div>
  </div>`;
  document.getElementById('repAgain').addEventListener('click', () => { URL.revokeObjectURL(url); reportSetSource(source.key); });
}

async function start() {
  try {
    context = await api('/api/app/context');
    document.getElementById('companyName').textContent = context.company.name;
    document.getElementById('topCompany').textContent = context.company.name;
    const crumbCompany = document.getElementById('topCrumbCompany'); if (crumbCompany) crumbCompany.textContent = context.company.name;
    document.getElementById('topRole').textContent = roleLabels[context.user.role] || context.user.role;
    document.getElementById('userName').textContent = context.user.name || context.user.email;
    document.getElementById('userEmail').textContent = context.user.email;
    document.getElementById('umAvatar').textContent = String(context.user.name || context.user.email || '?').trim().charAt(0).toUpperCase();
    document.getElementById('umCompany').textContent = context.company.name;
    document.getElementById('umRole').textContent = roleLabels[context.user.role] || context.user.role;
    document.getElementById('umCompanyItems').hidden = !['owner', 'manager'].includes(context.user.role);
    paintCompanyAvatar();
    if (!['owner', 'manager'].includes(context.user.role)) {
      document.querySelector('[data-route="/app/equipe"]')?.remove();
    }
    activateNavigation();
    try { window.TraxoSupport?.init({ api, context, toast: uiToast }); } catch (error) { console.error('support', error); }
    try { window.TraxoBilling?.mountGauge({ api, context }); } catch (error) { console.error('facturation', error); }
    const path = location.pathname;
    const detail = path.match(/^\/app\/demandes\/(\d+)$/);
    if (detail) { location.replace(`/app/operations?vue=demandes&demande=${encodeURIComponent(detail[1])}`); return; }
    const orderDetail = path.match(/^\/app\/commandes\/(\d+)$/);
    if (orderDetail) return await renderOrderDetail(orderDetail[1]);
    const incidentDetail = path.match(/^\/app\/incidents\/(\d+)$/);
    if (incidentDetail) return await renderIncidentDetail(incidentDetail[1]);
    const runDetail = path.match(/^\/app\/tournees\/(\d+)$/);
    if (runDetail) { location.replace(`/app/operations?vue=tournees&tournee=${encodeURIComponent(runDetail[1])}`); return; }
    if (/^\/app\/clients(\/(\d+|nouveau))?$/.test(path) && window.TraxoClients) {
      setHeader('Clients', 'Vos clients, leurs lieux et leurs commandes.');
      return await window.TraxoClients.render(page, { api, context, uiConfirm });
    }
    const customerDetail = path.match(/^\/app\/clients\/(\d+)$/);
    if (customerDetail) return await renderCustomerDetail(customerDetail[1]);
    if (path === '/app') return await renderDashboard();
    if (path === '/app/operations') return await renderOperations();
    // Les anciennes pages liste sont remplacées par les onglets du CRM Opérations.
    // On y redirige toute entrée directe (lien obsolète, favori) pour une nav cohérente.
    if (path === '/app/demandes') { location.replace('/app/operations?vue=demandes'); return; }
    if (path === '/app/commandes') { location.replace('/app/operations?vue=commandes'); return; }
    if (path === '/app/tournees') { location.replace('/app/operations?vue=tournees'); return; }
    if (path === '/app/incidents') { location.replace('/app/operations?vue=incidents'); return; }
    if (path === '/app/nouvelle-commande') return await renderNewOrder();
    if (path === '/app/carte') return await renderOperationsMap();
    if (path === '/app/livreurs') return await renderDrivers();
    if (path === '/app/equipe') return await renderTeam();
    if (path === '/app/clients') return await renderCustomers();
    if (path === '/app/rapports') return await renderReports();
    if (path === '/app/parametres') return await renderSettings();
    if (path === '/app/notifications') return await renderNotificationsCenter();
  } catch (error) {
    renderError(error);
  }
}

document.getElementById('menuButton').addEventListener('click', () => sidebar.classList.toggle('open'));
document.getElementById('cpTrigger')?.addEventListener('click', () => openCommandPalette());
if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) { const kbd = document.querySelector('.cp-trigger-kbd'); if (kbd) kbd.textContent = '⌘ K'; }
document.addEventListener('click', (event) => {
  if (window.innerWidth <= 900 && sidebar.classList.contains('open') && !sidebar.contains(event.target) && !event.target.closest('#menuButton')) {
    sidebar.classList.remove('open');
  }
});

// Repli de la sidebar (desktop), état mémorisé par appareil.
const appShell = document.querySelector('.app-shell');
try { if (localStorage.getItem('traxo.sidebarCollapsed') === '1') appShell.classList.add('sidebar-collapsed'); } catch { /* stockage indisponible */ }
document.getElementById('sidebarToggle')?.addEventListener('click', () => {
  const collapsed = appShell.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('traxo.sidebarCollapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
});

// Mes espaces : une personne peut appartenir à plusieurs entreprises (son
// propre espace et ceux qui l'ont invitée). La liste n'apparaît que s'il y en a plusieurs.
async function loadSpaces() {
  const box = document.getElementById('umSpaces'); const list = document.getElementById('umSpacesList');
  if (!box || box.dataset.loaded) return;
  box.dataset.loaded = '1';
  try {
    const data = await api('/api/app/account/spaces');
    if (!data.spaces || data.spaces.length < 2) return;
    list.innerHTML = data.spaces.map((sp) => `<button type="button" class="user-pop-item um-space-item${sp.current ? ' current' : ''}" role="menuitemradio" aria-checked="${sp.current}" data-space="${escapeHtml(sp.id)}" ${sp.suspended ? 'disabled' : ''}>
        <span class="um-space-logo" aria-hidden="true">${sp.logoUrl ? `<img src="${escapeHtml(sp.logoUrl)}" alt="">` : escapeHtml((sp.name || '?').slice(0, 1).toUpperCase())}</span>
        <span><strong>${escapeHtml(sp.name)}</strong><small>${escapeHtml(sp.suspended ? 'Accès suspendu' : sp.roleLabel)}</small></span>${sp.current ? '<em>Actuel</em>' : ''}</button>`).join('');
    box.hidden = false;
    list.querySelectorAll('[data-space]').forEach((b) => b.addEventListener('click', async () => {
      if (b.classList.contains('current')) return;
      b.disabled = true;
      try { const out = await api('/api/app/account/spaces/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: b.dataset.space }) }); location.href = out.redirect || '/app'; }
      catch (error) { b.disabled = false; uiToast(error.message, 'error'); }
    }));
  } catch { /* liste facultative */ }
}

// Menu utilisateur (topbar).
const userMenuBtn = document.getElementById('userMenuBtn');
const userMenu = document.getElementById('userMenu');
userMenuBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  const open = userMenu.hasAttribute('hidden');
  // Un seul panneau à la fois : ouvrir le compte ferme les notifications.
  if (open) document.dispatchEvent(new CustomEvent('traxo:close-popovers', { detail: 'account' }));
  if (open) { userMenu.removeAttribute('hidden'); loadSpaces(); } else userMenu.setAttribute('hidden', '');
  userMenuBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('traxo:close-popovers', (event) => {
  if (event.detail === 'account' || !userMenu || userMenu.hasAttribute('hidden')) return;
  userMenu.setAttribute('hidden', '');
  userMenuBtn.setAttribute('aria-expanded', 'false');
});
document.addEventListener('click', (event) => {
  if (userMenu && !userMenu.hasAttribute('hidden') && !event.target.closest('.user-menu')) {
    userMenu.setAttribute('hidden', '');
    userMenuBtn.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { userMenu?.setAttribute('hidden', ''); userMenuBtn?.setAttribute('aria-expanded', 'false'); } });

// Cloche de notifications : agrège les éléments actionnables (demandes à
// vérifier, commandes à affecter, incidents, tournées brouillon, rétentions).
// ---- Notifications (cloche, centre, préférences) -----------------------------
const tnIcons = {
  incident: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  requests: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  assign: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>',
  run: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  delivered: '<path d="M20 6 9 17l-5-5"/>',
  client: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
  security: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  support: '<path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/><path d="M21 16v2a4 4 0 0 1-4 4h-5"/>',
  vigilance: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  billing: '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/>',
  sliders: '<path d="M21 5H3"/><path d="M15 12H3"/><path d="M17 19H3"/><circle cx="19" cy="12" r="2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  checks: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  arrowUpRight: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
};
const tnIcon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${tnIcons[name] || ''}</svg>`;
const tnTone = { incident: 'tn-red', requests: 'tn-blue', assign: 'tn-sand', run: 'tn-purple', delivered: 'tn-green', client: 'tn-neutral', security: 'tn-red', vigilance: 'tn-sand', support: 'tn-blue', billing: 'tn-sand' };
const tnCategoryLabels = { incidents: 'Incident de livraison', requests: 'Demandes clients', deliveries: 'Livraisons', runs: 'Tournées', clients: 'Clients', security: 'Sécurité', billing: 'Facturation' };
const tnTime = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''; };
function tnDayGroup(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return { key: 'old', label: 'Plus anciennes', date: '' };
  const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const date = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  if (day(d) === day(now)) return { key: 'today', label: 'Aujourd’hui', date };
  if (day(d) === day(yesterday)) return { key: 'yesterday', label: 'Hier', date };
  return { key: day(d), label: d.toLocaleDateString('fr-FR', { weekday: 'long' }), date };
}
function tnRowsHtml(items, { withCta = false, selectedId = null, limit = Infinity } = {}) {
  let lastGroup = null;
  return items.slice(0, limit).map((it, i) => {
    const g = tnDayGroup(it.at);
    const head = g.key !== lastGroup ? `<div class="tn-group">${escapeHtml(g.label)}<span>${escapeHtml(g.date)}</span></div>` : '';
    lastGroup = g.key;
    const tag = it.priority === 'action' ? '<em class="tn-priority">À traiter</em>' : it.priority === 'security' ? '<em class="tn-priority sec">Sécurité</em>' : '';
    return `${head}<div class="tn-row ${it.read ? '' : 'tn-unread'} ${selectedId === it.id ? 'tn-selected' : ''}" role="link" tabindex="0" data-nid="${escapeHtml(it.id)}" style="--i:${i}">
      <span class="tn-type ${tnTone[it.type] || 'tn-neutral'}">${tnIcon(it.type)}</span>
      <span class="tn-row-main"><span class="tn-row-title">${escapeHtml(it.title)}</span><p>${escapeHtml(it.summary)}</p>
        <span class="tn-row-meta">${it.meta ? `<span>${escapeHtml(it.meta)}</span>` : ''}${tag}</span>
        ${withCta && it.cta ? `<a class="tn-cta" href="${escapeHtml(it.href)}" data-open="${escapeHtml(it.id)}">${escapeHtml(it.cta)} ${tnIcon('arrowUpRight')}</a>` : ''}</span>
      <span class="tn-row-end"><time>${escapeHtml(tnTime(it.at))}</time>${it.read ? '' : '<span class="tn-dot" aria-label="Non lue"></span>'}</span>
    </div>`;
  }).join('');
}
const tnEmpty = (title, text) => `<div class="tn-empty"><span class="tn-empty-icon">${tnIcon('inbox')}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
const tnSetState = (ids, action) => api('/api/app/notifications/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, action }) });
const tnFilterTab = (items, tab) => {
  if (tab === 'later') return items.filter((it) => it.later && !it.archived);
  if (tab === 'archived') return items.filter((it) => it.archived);
  const active = items.filter((it) => !it.archived && !it.later);
  if (tab === 'action') return active.filter((it) => it.priority !== 'info');
  if (tab === 'unread') return active.filter((it) => !it.read);
  return active;
};

async function initNotifications() {
  const btn = document.getElementById('notifBtn');
  const pop = document.getElementById('notifPop');
  const dot = document.getElementById('notifDot');
  if (!btn || !pop || !dot) return;
  pop.classList.add('tn-pop');
  let open = false;
  let tab = 'action';
  let data = { items: [], counts: { action: 0, all: 0, unread: 0 } };
  let undo = null;

  const paintDot = () => {
    const n = data.counts.unread || 0;
    dot.hidden = n === 0;
    dot.textContent = n > 99 ? '99+' : n ? String(n) : '';
    btn.setAttribute('aria-label', n ? `Notifications, ${n} non lue${n > 1 ? 's' : ''}` : 'Notifications');
  };
  const close = () => { pop.setAttribute('hidden', ''); open = false; btn.setAttribute('aria-expanded', 'false'); };
  let animate = false;
  const render = () => {
    paintDot();
    if (!open) return;
    const shown = tnFilterTab(data.items, tab);
    const c = data.counts;
    const tabBtn = (key, label, n) => `<button type="button" data-tab="${key}" aria-pressed="${tab === key}">${label}<span>${n}</span></button>`;
    pop.innerHTML = `<div class="tn-pop-head"><div><h2>Notifications${c.unread ? ` <span>${c.unread}</span>` : ''}</h2><p>Votre activité, au bon moment.</p></div>
        <div><a class="tn-icon" href="/app/notifications?vue=preferences" title="Mes préférences" aria-label="Mes préférences">${tnIcon('sliders')}</a><button type="button" class="tn-icon" data-close aria-label="Fermer">${tnIcon('x')}</button></div></div>
      <div class="tn-tabs" role="group" aria-label="Filtrer">${tabBtn('action', 'À traiter', c.action)}${tabBtn('all', 'Toutes', c.all)}${tabBtn('unread', 'Non lues', c.unread)}</div>
      <div class="tn-list${animate ? ' tn-anim' : ''}" id="tnList">${shown.length ? tnRowsHtml(shown, { limit: 4 }) : tab === 'unread' ? tnEmpty('Tout est lu', 'Aucune notification non lue pour le moment.') : tnEmpty('Rien à traiter', 'Vous êtes à jour. Les nouvelles demandes et les incidents apparaîtront ici.')}</div>
      <div class="tn-pop-footer">${undo ? `<span class="tn-undo">${undo.count} notification${undo.count > 1 ? 's' : ''} marquée${undo.count > 1 ? 's' : ''} comme lue${undo.count > 1 ? 's' : ''}<button type="button" data-undo>Annuler</button></span>`
        : `<button type="button" class="tn-link" data-readall ${c.unread ? '' : 'disabled'}>${tnIcon('checks')} Tout marquer comme lu</button>`}
        <a class="tn-link red" href="/app/notifications">Ouvrir le centre ${tnIcon('arrowUpRight')}</a></div>`;
    animate = false;
    TraxoUI.mountNotifyCard(pop.querySelector('#tnList'), {
      prepend: true,
      title: 'Ne manquez aucune demande',
      text: 'Soyez prévenu d’une nouvelle demande ou d’un incident, même dans un autre onglet.',
      onDone: (result) => {
        if (result === 'granted') TraxoUI.notifications.show('Notifications TRAXO activées', { body: 'Vous serez prévenu des nouvelles demandes, des commandes à affecter et des incidents.', tag: 'traxo-test' });
        else if (result === 'denied') uiToast('Notifications bloquées. Vous pourrez les autoriser dans les réglages du navigateur.', 'warning');
      },
    });
  };
  const openItem = async (id) => {
    const it = data.items.find((x) => x.id === id);
    if (!it) return;
    if (!it.read) await tnSetState([id], 'read').catch(() => {});
    location.href = it.href;
  };
  pop.addEventListener('click', async (event) => {
    event.stopPropagation();
    const t = event.target;
    if (t.closest('[data-close]')) { close(); btn.focus(); return; }
    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) { tab = tabBtn.dataset.tab; animate = true; render(); return; }
    if (t.closest('[data-readall]')) {
      const ids = data.items.filter((it) => !it.read && !it.archived && !it.later).map((it) => it.id);
      if (!ids.length) return;
      data.items.forEach((it) => { if (ids.includes(it.id)) it.read = true; });
      data.counts.unread = 0;
      undo = { ids, count: ids.length };
      render();
      tnSetState(ids, 'read').catch(() => load());
      setTimeout(() => { if (undo && undo.ids === ids) { undo = null; render(); } }, 7000);
      return;
    }
    if (t.closest('[data-undo]') && undo) {
      const ids = undo.ids;
      undo = null;
      await tnSetState(ids, 'unread').catch(() => {});
      load();
      return;
    }
    const row = t.closest('[data-nid]');
    if (row && !t.closest('a')) openItem(row.dataset.nid);
  });
  pop.addEventListener('keydown', (event) => {
    const row = event.target.closest('[data-nid]');
    if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openItem(row.dataset.nid); }
  });

  // Notifications du navigateur : uniquement pour ce qui apparaît après l'ouverture de TRAXO.
  const ALERT_TYPES = new Set(['requests', 'assign', 'incident', 'security']);
  let knownIds = null;
  const alertNew = (items) => {
    const ids = new Set(items.map((it) => it.id));
    if (!knownIds) { knownIds = ids; return; }
    const fresh = items.filter((it) => !knownIds.has(it.id) && ALERT_TYPES.has(it.type) && !it.read);
    knownIds = ids;
    if (!fresh.length || !TraxoUI.notifications.enabled() || document.visibilityState === 'visible') return;
    if (fresh.length === 1) TraxoUI.notifications.show(fresh[0].title, { body: fresh[0].summary, tag: fresh[0].id, data: { url: fresh[0].href } });
    else TraxoUI.notifications.show(`${fresh.length} nouvelles notifications TRAXO`, { body: fresh.slice(0, 3).map((it) => it.title).join('\n'), tag: 'traxo-batch', data: { url: '/app/notifications' } });
  };
  const load = async () => {
    try {
      const next = await api('/api/app/notifications');
      const changed = JSON.stringify([next.items, next.counts]) !== JSON.stringify([data.items, data.counts]);
      data = next;
      alertNew(data.items);
      // Pas de nouveau rendu si rien n'a changé : la liste ouverte ne clignote pas.
      if (changed) render();
      document.dispatchEvent(new CustomEvent('traxo:notifications', { detail: data }));
    } catch { /* silencieux */ }
  };
  window.__tnReload = load;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    open = !open;
    if (open) {
      document.dispatchEvent(new CustomEvent('traxo:close-popovers', { detail: 'notifications' }));
      pop.removeAttribute('hidden'); animate = true; render(); load();
    } else close();
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('traxo:close-popovers', (event) => { if (event.detail !== 'notifications' && open) close(); });
  document.addEventListener('click', (event) => { if (open && !event.target.closest('.notif-menu')) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && open) { close(); btn.focus(); } });
  await load();
  setInterval(load, 60000);
}
initNotifications();

async function renderNotificationsCenter() {
  const params = new URLSearchParams(location.search);
  if (params.get('vue') === 'preferences') return renderNotificationPrefs();
  setHeader('Notifications', 'Ce qui demande votre attention');
  let data = await api('/api/app/notifications');
  let tab = params.get('onglet') || 'action';
  let query = '';
  let type = 'all';
  let selected = null;
  let limit = 30;
  let animate = true;
  page.innerHTML = `<div class="tn-page">
    <a class="tn-back" href="/app">${tnIcon('arrowLeft')} Tableau de bord</a>
    <div class="tn-page-heading"><div><span class="tn-eyebrow">${escapeHtml(context.company.name)}</span><h1>Votre centre de notifications</h1><p>Retrouvez ce qui demande votre attention, puis reprenez votre activité.</p></div>
      <a class="tn-btn" href="/app/notifications?vue=preferences">${tnIcon('sliders')} Mes préférences</a></div>
    <div id="tnSummary"></div>
    <div class="tn-layout"><section class="tn-card"><div class="tn-tabs" id="tnTabs" role="group" aria-label="Filtrer"></div>
      <div class="tn-filters"><label>${tnIcon('search')}<input id="tnSearch" type="search" placeholder="Rechercher dans les notifications" aria-label="Rechercher dans les notifications"></label>
        <select id="tnType" aria-label="Type"><option value="all">Tous les types</option>${Object.entries(tnCategoryLabels).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</select></div>
      <div class="tn-results" id="tnResults"></div></section>
      <aside id="tnDetail"></aside></div></div>`;
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const list = () => tnFilterTab(data.items, tab).filter((it) => (type === 'all' || it.category === type)
    && (!query || norm(`${it.title} ${it.summary} ${it.meta} ${it.ref}`).includes(norm(query))));
  const paint = () => {
    const c = data.counts;
    document.getElementById('tnSummary').innerHTML = `<div class="tn-summary"><span class="tn-summary-dot"></span><strong>${c.action} notification${c.action > 1 ? 's' : ''} à traiter</strong><span>sur l’ensemble de votre espace</span>${c.unread ? `<button type="button" class="tn-link" id="tnReadAll">${tnIcon('checks')} Tout marquer comme lu</button>` : ''}</div>`;
    const tabs = [['action', 'À traiter', c.action], ['all', 'Toutes', c.all], ['unread', 'Non lues', c.unread], ['later', 'Plus tard', c.later], ['archived', 'Archivées', c.archived]];
    document.getElementById('tnTabs').innerHTML = tabs.map(([k, l, n]) => `<button type="button" data-tab="${k}" aria-pressed="${tab === k}">${l}<span>${n}</span></button>`).join('');
    const shown = list();
    const results = document.getElementById('tnResults');
    results.classList.toggle('tn-anim', animate);
    animate = false;
    results.innerHTML = shown.length
      ? `${tnRowsHtml(shown, { withCta: true, selectedId: selected, limit })}${shown.length > limit ? `<button type="button" class="tn-more" id="tnMore">Afficher ${Math.min(30, shown.length - limit)} de plus</button>` : ''}`
      : tnEmpty(query ? 'Aucun résultat' : tab === 'archived' ? 'Aucune archive' : tab === 'later' ? 'Rien de côté' : 'Tout est à jour', query ? 'Essayez un autre mot ou un autre type.' : 'Les nouvelles notifications apparaîtront ici.');
    paintDetail();
  };
  const paintDetail = () => {
    const box = document.getElementById('tnDetail');
    const it = data.items.find((x) => x.id === selected);
    if (!it) {
      box.innerHTML = `<div class="tn-detail tn-detail-empty"><span class="tn-empty-icon">${tnIcon('inbox')}</span><h2>Choisissez une notification</h2><p class="tn-note">Son détail et l’action à mener s’affichent ici.</p></div>`;
      return;
    }
    const received = new Date(it.at);
    box.innerHTML = `<div class="tn-detail" aria-live="polite">
      <div class="tn-detail-top"><span class="tn-type ${tnTone[it.type] || 'tn-neutral'}">${tnIcon(it.type)}</span><button type="button" class="tn-icon" data-deselect aria-label="Fermer le détail">${tnIcon('x')}</button></div>
      <span class="tn-eyebrow">${escapeHtml(tnCategoryLabels[it.category] || 'Notification')}</span>
      <h2>${escapeHtml(it.title)}</h2><p>${escapeHtml(it.detail || it.summary)}</p>
      <dl><div><dt>Élément concerné</dt><dd>${escapeHtml(it.ref || it.summary)}</dd></div>
        <div><dt>Reçu</dt><dd>${escapeHtml(Number.isFinite(received.getTime()) && received.getTime() > 0 ? received.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }) : '—')}</dd></div>
        <div><dt>État de lecture</dt><dd>${it.read ? 'Lu' : 'Non lu'}${it.priority === 'action' ? ' · Action toujours attendue' : ''}${it.archived ? ' · Archivée' : it.later ? ' · Gardée pour plus tard' : ''}</dd></div></dl>
      <a class="tn-btn primary" href="${escapeHtml(it.href)}">${escapeHtml(it.cta || 'Ouvrir')} ${tnIcon('arrowUpRight')}</a>
      <div class="tn-detail-actions">
        <button type="button" data-act="${it.archived ? 'unarchive' : 'archive'}">${tnIcon(it.archived ? 'undo' : 'archive')} ${it.archived ? 'Restaurer' : 'Archiver'}</button>
        <button type="button" data-act="unread">${tnIcon('mail')} Marquer comme non lu</button>
        ${it.archived ? '' : `<button type="button" data-act="${it.later ? 'unlater' : 'later'}">${tnIcon('clock')} ${it.later ? 'Remettre dans la liste' : 'Garder pour plus tard'}</button>`}
      </div>
      <p class="tn-note">Marquer comme lu ou archiver ne clôture pas l’élément : la demande, l’incident ou la tournée reste à traiter dans TRAXO.</p></div>`;
  };
  const reload = async () => { data = await api('/api/app/notifications'); paint(); if (window.__tnReload) window.__tnReload(); };
  const apply = async (ids, action, patch) => {
    data.items.forEach((it) => { if (ids.includes(it.id)) Object.assign(it, patch); });
    paint();
    try { await tnSetState(ids, action); } catch (error) { uiToast(error.message, 'error'); }
    reload();
  };
  page.addEventListener('click', async (event) => {
    const t = event.target;
    const tb = t.closest('#tnTabs [data-tab]');
    if (tb) { tab = tb.dataset.tab; limit = 30; animate = true; paint(); return; }
    if (t.closest('#tnMore')) { limit += 30; paint(); return; }
    if (t.closest('#tnReadAll')) {
      const ids = data.items.filter((it) => !it.read && !it.archived && !it.later).map((it) => it.id);
      await apply(ids, 'read', { read: true });
      uiToast(`${ids.length} notification${ids.length > 1 ? 's' : ''} marquée${ids.length > 1 ? 's' : ''} comme lue${ids.length > 1 ? 's' : ''}.`, 'success');
      return;
    }
    if (t.closest('[data-deselect]')) { selected = null; paint(); return; }
    const act = t.closest('#tnDetail [data-act]');
    if (act && selected) {
      const a = act.dataset.act;
      const patch = { archive: { archived: true, read: true }, unarchive: { archived: false }, later: { later: true, read: true }, unlater: { later: false }, unread: { read: false } }[a];
      const id = selected;
      if (a === 'archive' || a === 'later') selected = null;
      await apply([id], a, patch);
      uiToast({ archive: 'Notification archivée.', unarchive: 'Notification restaurée.', later: 'Gardée pour plus tard.', unlater: 'Remise dans la liste.', unread: 'Marquée comme non lue.' }[a], 'success');
      return;
    }
    const open = t.closest('[data-open]');
    if (open) { const it = data.items.find((x) => x.id === open.dataset.open); if (it && !it.read) { event.preventDefault(); await tnSetState([it.id], 'read').catch(() => {}); location.href = it.href; } return; }
    const row = t.closest('#tnResults [data-nid]');
    if (row) {
      selected = row.dataset.nid;
      const it = data.items.find((x) => x.id === selected);
      if (it && !it.read) { it.read = true; data.counts.unread = Math.max(0, data.counts.unread - 1); tnSetState([it.id], 'read').then(() => window.__tnReload && window.__tnReload()).catch(() => {}); }
      paint();
      if (window.matchMedia('(max-width: 860px)').matches) document.getElementById('tnDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  page.addEventListener('keydown', (event) => {
    const row = event.target.closest('#tnResults [data-nid]');
    if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); row.click(); }
  });
  document.getElementById('tnSearch').addEventListener('input', (e) => { query = e.target.value; limit = 30; paint(); });
  document.getElementById('tnType').addEventListener('change', (e) => { type = e.target.value; limit = 30; paint(); });
  paint();
}

async function renderNotificationPrefs() {
  setHeader('Notifications', 'Vos préférences');
  const prefs = await api('/api/app/notifications/preferences');
  const saved = JSON.stringify({ categories: prefs.categories, digest: prefs.digest, digestHour: prefs.digestHour, digestDay: prefs.digestDay, timezone: prefs.timezone });
  let state = JSON.parse(saved);
  const catRows = [
    ['incidents', 'Incidents de livraison', 'Adresse à préciser, client injoignable, colis endommagé…'],
    ['requests', 'Demandes des clients', 'Formulaires reçus à valider, regroupés en une notification.'],
    ['deliveries', 'Affectations et livraisons', 'Commandes à affecter, confirmées par le client, récapitulatif des livraisons terminées.'],
    ['runs', 'Tournées', 'Tournées encore en préparation.'],
    ['clients', 'Clients à relancer', 'Clients sans commande depuis plus d’un mois.'],
  ];
  const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const tzLabel = { 'Africa/Porto-Novo': 'Bénin — Cotonou (GMT+1)', 'Africa/Abidjan': 'Côte d’Ivoire — Abidjan (GMT)', 'Africa/Lome': 'Togo — Lomé (GMT)', 'Africa/Lagos': 'Nigeria — Lagos (GMT+1)', 'Africa/Dakar': 'Sénégal — Dakar (GMT)', 'Europe/Paris': 'France — Paris', UTC: 'UTC' };
  page.innerHTML = `<div class="tn-page">
    <a class="tn-back" href="/app/notifications">${tnIcon('arrowLeft')} Centre de notifications</a>
    <div class="tn-page-heading"><div><span class="tn-eyebrow">Mon compte</span><h1>Mes notifications</h1><p>Choisissez ce qui mérite votre attention. Ces réglages ne concernent que vous.</p></div></div>
    <form class="tn-settings" id="tnPrefs">
      <section class="tn-settings-card"><div class="tn-settings-head"><h2>Dans TRAXO</h2><p>Les catégories affichées dans la cloche et le centre. Les masquer ne supprime rien : les éléments restent à traiter dans leurs pages.</p></div>
        ${catRows.map(([k, t, d]) => `<div class="tn-setting-row"><div><label for="tn-cat-${k}">${escapeHtml(t)}</label><small>${escapeHtml(d)}</small></div>${TraxoUI.switchHtml({ id: `tn-cat-${k}`, name: k, checked: state.categories[k] !== false })}</div>`).join('')}
        <div class="tn-setting-row"><div><label>Sécurité du compte</label><small>Nouvelles connexions à votre compte.</small></div><span class="tn-always">Toujours actives</span></div>
        <div class="tn-setting-row"><div><label for="tn-device">Sur cet appareil</label><small>Une alerte du navigateur quand TRAXO est ouvert dans un autre onglet.</small></div>${TraxoUI.switchHtml({ id: 'tn-device', checked: TraxoUI.notifications.enabled(), disabled: ['unsupported', 'denied'].includes(TraxoUI.notifications.permission()) })}</div>
      </section>
      <section class="tn-settings-card"><div class="tn-settings-head"><span class="tn-type tn-blue">${tnIcon('mail')}</span><h2>Récapitulatif par e-mail</h2><p>Un seul e-mail avec ce qui reste à traiter et que vous n’avez pas encore lu. Rien n’est envoyé s’il n’y a rien.</p></div>
        <div class="tn-segmented" role="group" aria-label="Fréquence">${[['off', 'Désactivé'], ['daily', 'Chaque jour'], ['weekly', 'Chaque semaine']].map(([v, l]) => `<button type="button" data-digest="${v}" aria-pressed="${state.digest === v}">${l}</button>`).join('')}</div>
        <div class="tn-fields" id="tnDigestFields">
          <label class="tn-field" id="tnDayWrap">Jour<select id="tnDay">${days.map((d, i) => `<option value="${i + 1}" ${state.digestDay === i + 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label class="tn-field">Heure<select id="tnHour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${state.digestHour === h ? 'selected' : ''}>${String(h).padStart(2, '0')} h 00</option>`).join('')}</select></label>
          <label class="tn-field" style="grid-column:1/-1">Fuseau horaire<select id="tnTz">${(prefs.timezones || []).map((tz) => `<option value="${escapeHtml(tz)}" ${state.timezone === tz ? 'selected' : ''}>${escapeHtml(tzLabel[tz] || tz)}</option>`).join('')}</select></label>
          <label class="tn-field" style="grid-column:1/-1">Envoyé à<input value="${escapeHtml(prefs.email || '')}" readonly></label>
        </div>
        ${prefs.emailConfigured ? '' : '<p class="tn-note">L’envoi d’e-mails n’est pas encore configuré sur ce serveur : le récapitulatif partira dès qu’il le sera.</p>'}
        <div class="tn-security-note">${tnIcon('security')}<span>Les alertes de sécurité par e-mail (nouvelle connexion) se règlent dans Paramètres › Sécurité.</span></div>
      </section>
      <div class="tn-save" id="tnSave"><span id="tnSaveText">Aucune modification en attente</span><button type="submit" class="tn-btn primary" id="tnSaveBtn" disabled>Enregistrer</button></div>
    </form></div>`;
  const form = document.getElementById('tnPrefs');
  const paintDigest = () => {
    form.querySelectorAll('[data-digest]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.digest === state.digest)));
    document.getElementById('tnDigestFields').hidden = state.digest === 'off';
    document.getElementById('tnDayWrap').hidden = state.digest !== 'weekly';
  };
  const refresh = () => {
    const dirty = JSON.stringify(state) !== saved;
    document.getElementById('tnSave').classList.toggle('dirty', dirty);
    document.getElementById('tnSaveText').textContent = dirty ? 'Modifications non enregistrées' : 'Aucune modification en attente';
    document.getElementById('tnSaveBtn').disabled = !dirty;
  };
  form.addEventListener('click', (e) => { const b = e.target.closest('[data-digest]'); if (b) { state.digest = b.dataset.digest; paintDigest(); refresh(); } });
  form.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'tn-device') {
      const result = await TraxoUI.notifications.setEnabled(t.checked);
      if (!['granted', 'off'].includes(result)) { t.checked = false; uiToast(result === 'denied' ? 'Le navigateur a bloqué les notifications.' : 'Notifications non activées.', 'warning'); }
      else uiToast(result === 'granted' ? 'Notifications activées sur cet appareil.' : 'Notifications désactivées sur cet appareil.', 'success');
      return;
    }
    if (t.name && t.name in state.categories) state.categories[t.name] = t.checked;
    if (t.id === 'tnHour') state.digestHour = Number(t.value);
    if (t.id === 'tnDay') state.digestDay = Number(t.value);
    if (t.id === 'tnTz') state.timezone = t.value;
    refresh();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = document.getElementById('tnSaveBtn');
    button.disabled = true;
    try {
      await api('/api/app/notifications/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
      uiToast('Préférences enregistrées.', 'success');
      if (window.__tnReload) window.__tnReload();
      renderNotificationPrefs();
    } catch (error) { uiToast(error.message, 'error'); refresh(); }
  });
  window.addEventListener('beforeunload', (e) => { if (document.body.contains(form) && JSON.stringify(state) !== saved) { e.preventDefault(); e.returnValue = ''; } });
  paintDigest();
}

start();
