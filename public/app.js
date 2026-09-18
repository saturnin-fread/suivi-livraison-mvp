const page = document.getElementById('page');
const sidebar = document.getElementById('sidebar');
let context;

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
  const type = ['Livrée', 'Disponible', 'Confirmée', 'Terminée'].includes(status) ? 'success'
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
const roleLabels = { owner: 'Propriétaire', manager: 'Manager', operator: 'Opérateur', driver: 'Livreur' };
const runStatusLabels = {
  draft: 'Brouillon', planned: 'Planifiée', active: 'En cours', completed: 'Terminée', cancelled: 'Annulée',
};
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
  return `<section class="card" style="margin-top:18px"><h2>Encaissement à la livraison</h2>
    ${configured ? `<div class="detail-grid"><div class="detail"><span>Montant attendu</span><strong>${escapeHtml(formatMoney(order.expected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>État financier</span><strong>${badge(paymentStatusLabels[order.payment_status] || order.payment_status)}</strong></div><div class="detail"><span>Montant reçu</span><strong>${escapeHtml(formatMoney(order.collected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>Mode</span><strong>${escapeHtml(paymentMethodLabels[order.collection_method] || order.collection_method || '—')}</strong></div><div class="detail"><span>Référence</span><strong>${escapeHtml(order.collection_reference || '—')}</strong></div><div class="detail"><span>Rapprochement</span><strong>${escapeHtml(formatDate(order.reconciled_at))}</strong></div></div>${order.discrepancy_reason ? `<div class="notice error"><strong>Écart déclaré :</strong> ${escapeHtml(order.discrepancy_reason)}</div>` : ''}` : '<p class="subtitle">Aucun paiement ne sera exigé tant qu’un montant n’est pas configuré.</p>'}
    ${canConfigure ? `<form id="paymentConfigure" style="margin-top:18px"><div class="form-grid"><div class="field"><label>Montant attendu en FCFA</label><input name="expectedAmountMinor" type="number" min="1" step="1" value="${configured && order.payment_status !== 'not_required' ? escapeHtml(order.expected_amount_minor) : ''}" required /></div><input type="hidden" name="currency" value="XOF" /></div><div class="actions" style="margin-top:12px"><button class="secondary">${configured ? 'Modifier le montant attendu' : 'Exiger un encaissement'}</button>${configured && order.payment_status === 'pending' ? '<button class="danger" type="button" id="removePaymentRequirement">Retirer cette exigence</button>' : ''}</div></form>` : ''}
    ${canCollect ? `<form id="paymentCollect" style="margin-top:18px"><h3>Déclarer la somme reçue</h3><div class="form-grid"><div class="field"><label>Montant reçu en FCFA</label><input name="amountMinor" type="number" min="0" step="1" value="${escapeHtml(order.expected_amount_minor)}" required /></div><div class="field"><label>Mode d’encaissement</label><select name="method"><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="card">Carte</option><option value="bank_transfer">Virement</option><option value="other">Autre</option></select></div><div class="field"><label>Référence facultative</label><input name="reference" maxlength="120" placeholder="Référence Mobile Money, reçu…" /></div><div class="field"><label>Motif en cas d’écart</label><textarea name="discrepancyReason" placeholder="Obligatoire si le montant reçu diffère"></textarea></div></div><div class="actions" style="margin-top:12px"><button class="primary">Enregistrer l’encaissement</button></div></form>` : configured && order.payment_status === 'pending' ? '<p class="notice">L’encaissement pourra être déclaré lorsque la commande sera « En livraison » ou « Arrivée ».</p>' : ''}
    ${canReconcile ? `<form id="paymentReconcile" style="margin-top:18px"><div class="field"><label>Note de rapprochement ${order.payment_status === 'discrepancy' ? '(obligatoire)' : '(facultative)'}</label><textarea name="note" placeholder="Contrôle de caisse, justification de l’écart…"></textarea></div><div class="actions" style="margin-top:12px"><button class="primary">Marquer comme rapproché</button>${canReverse ? '<button class="danger" type="button" id="reversePayment">Annuler la saisie</button>' : ''}</div></form>` : ''}
    ${order.isTerminal && configured ? `<section class="adjustment-panel"><h3>Ajustements après clôture</h3><p class="subtitle">L’encaissement d’origine reste inchangé. Chaque remboursement ou complément crée une nouvelle écriture traçable.</p><div class="detail-grid"><div class="detail"><span>Total d’origine</span><strong>${escapeHtml(formatMoney(order.collected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>Total net après ajustements</span><strong>${escapeHtml(formatMoney(order.paymentAdjustedTotalMinor, order.payment_currency))}</strong></div></div>${canAdjust ? `<details style="margin-top:14px"><summary>Enregistrer un ajustement</summary><form id="paymentAdjustment" style="margin-top:14px"><div class="form-grid"><div class="field"><label>Nature</label><select name="adjustmentType"><option value="refund">Remboursement au client</option><option value="additional_collection">Complément reçu</option></select></div><div class="field"><label>Montant en FCFA</label><input name="amountMinor" type="number" min="1" step="1" required /></div><div class="field"><label>Mode</label><select name="method"><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="card">Carte</option><option value="bank_transfer">Virement</option><option value="other">Autre</option></select></div><div class="field"><label>Date effective</label><input name="effectiveDate" type="date" max="${today}" value="${today}" required /></div><div class="field full"><label>Référence facultative</label><input name="reference" maxlength="120" placeholder="Reçu, transaction Mobile Money…" /></div><div class="field full"><label>Motif détaillé</label><textarea name="reason" minlength="10" maxlength="1000" required placeholder="Pourquoi cet ajustement est-il nécessaire ?"></textarea></div></div><div class="notice warning" style="margin-top:12px">Vérifiez le sens et le montant. Une erreur sera corrigée par une écriture inverse, jamais par suppression.</div><div class="actions" style="margin-top:12px"><button class="primary">Enregistrer l’ajustement</button></div></form></details>` : '<div class="notice">Seuls le propriétaire et les managers peuvent créer un ajustement après clôture.</div>'}${adjustments.length ? `<ol class="timeline adjustment-timeline">${adjustments.map((adjustment) => `<li><strong>${escapeHtml(paymentAdjustmentLabels[adjustment.adjustment_type] || adjustment.adjustment_type)}</strong><span>${adjustment.direction === 'inflow' ? '+' : '−'} ${escapeHtml(formatMoney(adjustment.amount_minor, adjustment.currency))} · ${escapeHtml(paymentMethodLabels[adjustment.method] || adjustment.method)}</span><small>Date effective : ${escapeHtml(adjustment.effective_date)} · saisi le ${escapeHtml(formatDate(adjustment.created_at))} · ${escapeHtml(adjustment.actor_name)}</small><p>${escapeHtml(adjustment.reason)}</p>${adjustment.reference ? `<small>Référence : ${escapeHtml(adjustment.reference)}</small>` : ''}${adjustment.reversed ? '<div class="notice">Cette écriture possède une correction inverse.</div>' : canAdjust && adjustment.adjustment_type !== 'reversal' ? `<button class="secondary reverse-adjustment" type="button" data-adjustment-id="${escapeHtml(adjustment.id)}">Corriger cette écriture</button>` : ''}</li>`).join('')}</ol>` : '<p class="subtitle">Aucun ajustement après clôture.</p>'}</section>` : ''}
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
  if (!response.ok) throw new Error(payload.error || 'Une erreur est survenue.');
  return payload;
}

function setHeader(title, hint) {
  document.getElementById('topTitle').textContent = title;
  document.getElementById('topHint').textContent = hint;
  document.title = `${title} — Livraisons`;
}

const operationsRoutes = ['/app/operations', '/app/demandes', '/app/nouvelle-commande', '/app/commandes', '/app/tournees', '/app/incidents'];
function activateNavigation() {
  const pathname = location.pathname;
  document.querySelectorAll('.nav a').forEach((link) => {
    const route = link.dataset.route;
    let active;
    if (route === '/app') active = pathname === '/app';
    else if (route === '/app/operations') active = operationsRoutes.some((base) => pathname === base || pathname.startsWith(`${base}/`));
    else active = pathname.startsWith(route);
    link.classList.toggle('active', active);
  });
}

function renderError(error) {
  page.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
}

async function renderDashboard() {
  setHeader('Tableau de bord', 'Vue d’ensemble des opérations');
  const summary = await api('/api/app/summary');
  page.innerHTML = `
    <div class="page-header"><div><h1>Bonjour ${escapeHtml(context.user.name)}</h1><p class="subtitle">Voici les éléments qui demandent votre attention.</p></div><a class="button primary" href="/app/operations?vue=demandes">Gérer les demandes</a></div>
    <section class="grid stats">
      <article class="stat"><span>Demandes actives</span><strong>${escapeHtml(summary.active_requests)}</strong></article>
      <article class="stat"><span>À vérifier</span><strong>${escapeHtml(summary.to_review)}</strong></article>
      <article class="stat"><span>Commandes créées</span><strong>${escapeHtml(summary.orders)}</strong></article>
      <article class="stat"><span>Livreurs enregistrés</span><strong>${escapeHtml(summary.drivers)}</strong></article>
      <article class="stat"><span>Tournées ouvertes</span><strong>${escapeHtml(summary.open_runs)}</strong></article>
      <article class="stat"><span>Incidents ouverts</span><strong>${escapeHtml(summary.open_incidents)}</strong></article>
      <article class="stat"><span>Gels à réviser</span><strong>${escapeHtml(summary.overdue_holds)}</strong></article>
    </section>
    <section class="card" style="margin-top:18px"><h2>Accès rapides</h2><div class="actions"><a class="button primary" href="/app/operations?vue=creer">Nouvelle demande client</a><a class="button secondary" href="/app/nouvelle-commande">Commande directe</a><a class="button secondary" href="/app/operations?vue=tournees">Voir les tournées</a><a class="button secondary" href="/app/operations?vue=incidents">Dossiers d’incident</a><a class="button secondary" href="/app/carte">Carte d’exploitation</a></div></section>`;
}

async function renderRequests() {
  setHeader('Demandes', 'Informations reçues avant création d’une commande');
  page.innerHTML = `
    <div class="page-header"><div><h1>Demandes clients</h1><p class="subtitle">Vérifiez et complétez les informations avant de lancer une livraison.</p></div><button class="primary" id="createLink">Générer un formulaire client</button></div>
    <div id="linkResult"></div>
    <section class="card"><div class="actions" style="justify-content:space-between;margin-bottom:16px"><h2 style="margin:0">File active</h2><div><button class="secondary" id="activeRequests">Actives</button> <button class="secondary" id="archivedRequests">Archives</button></div></div><div id="requestTable">Chargement…</div></section>`;

  const linkResult = document.getElementById('linkResult');
  document.getElementById('createLink').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api('/api/app/request-links', { method: 'POST' });
      const url = `${location.origin}${result.path}`;
      linkResult.innerHTML = `<div class="notice success"><strong>Formulaire créé.</strong><br><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a><div class="actions" style="margin-top:10px"><button class="secondary" id="copyLink">Copier le lien</button></div></div>`;
      document.getElementById('copyLink').addEventListener('click', async () => {
        await navigator.clipboard.writeText(url);
        document.getElementById('copyLink').textContent = 'Lien copié';
      });
      await loadRequestTable('active');
    } catch (error) {
      linkResult.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
      event.currentTarget.disabled = false;
    }
  });
  document.getElementById('activeRequests').addEventListener('click', () => loadRequestTable('active'));
  document.getElementById('archivedRequests').addEventListener('click', () => loadRequestTable('archived'));
  await loadRequestTable('active');
}

async function loadRequestTable(scope) {
  const target = document.getElementById('requestTable');
  target.textContent = 'Chargement…';
  try {
    const requests = await api(`/api/app/requests?scope=${encodeURIComponent(scope)}`);
    if (!requests.length) {
      target.innerHTML = `<div class="empty">Aucune demande ${scope === 'archived' ? 'archivée' : 'active'}.</div>`;
      return;
    }
    target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Zone / repère</th><th>Créneau</th><th>Statut</th><th>Mise à jour</th></tr></thead><tbody>${requests.map((request) => `
      <tr data-href="/app/demandes/${request.id}">
        <td><strong>${escapeHtml(request.customer_name || 'En attente du client')}</strong><br><small>${escapeHtml(request.customer_phone || '')}</small></td>
        <td>${escapeHtml(request.neighborhood || '—')}<br><small>${escapeHtml(request.landmark || '')}</small></td>
        <td>${escapeHtml(request.requested_time || '—')}</td><td>${badge(request.status)}</td><td>${escapeHtml(formatDate(request.updated_at))}</td>
      </tr>`).join('')}</tbody></table></div>`;
    target.querySelectorAll('tr[data-href]').forEach((row) => row.addEventListener('click', () => { location.href = row.dataset.href; }));
  } catch (error) {
    target.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  }
}

async function renderRequestDetail(id) {
  setHeader('Détail de la demande', 'Vérification avant affectation');
  const request = await api(`/api/app/requests/${encodeURIComponent(id)}`);
  const drivers = request.order_id ? [] : await api('/api/app/drivers');
  const convertible = ['À vérifier', 'Informations à compléter'].includes(request.status) && !request.order_id;
  page.innerHTML = `
    <div class="page-header"><div><a href="/app/operations?vue=demandes">← Retour aux demandes</a><h1 style="margin-top:12px">${escapeHtml(request.customer_name || 'Demande en attente')}</h1><p class="subtitle">Demande n° ${escapeHtml(request.id)} · ${escapeHtml(formatDate(request.created_at))}</p></div>${badge(request.status)}</div>
    <section class="card"><h2>Informations du client</h2><div class="detail-grid">
      <div class="detail"><span>Téléphone</span><strong>${escapeHtml(request.customer_phone || '—')}</strong></div>
      <div class="detail"><span>Zone ou quartier</span><strong>${escapeHtml(request.neighborhood || '—')}</strong></div>
      <div class="detail"><span>Créneau souhaité</span><strong>${escapeHtml(request.requested_time || '—')}</strong></div>
      <div class="detail"><span>Repère</span><strong>${escapeHtml(request.landmark || '—')}</strong></div>
      <div class="detail"><span>Position GPS</span><strong>${request.location_lat == null ? 'Non partagée' : `${escapeHtml(request.location_lat)}, ${escapeHtml(request.location_lng)}`}</strong></div>
      <div class="detail"><span>Précision</span><strong>${request.location_accuracy == null ? '—' : `${Math.round(request.location_accuracy)} m`}</strong></div>
      <div class="detail" style="grid-column:1/-1"><span>Instructions</span><strong>${escapeHtml(request.notes || 'Aucune')}</strong></div>
    </div></section>
    ${request.order_id ? `<section class="card" style="margin-top:18px"><h2>Commande créée</h2><div class="detail-grid"><div class="detail"><span>Commande</span><strong>N° ${escapeHtml(request.order_id)}</strong></div><div class="detail"><span>Livreur</span><strong>${escapeHtml(request.driver_name)}</strong></div><div class="detail"><span>Statut</span><strong>${escapeHtml(request.order_status)}</strong></div></div><div class="actions" style="margin-top:18px">${request.trackingLink?.path ? `<a class="button primary" target="_blank" rel="noopener" href="${escapeHtml(request.trackingLink.path)}">Ouvrir le suivi</a>` : ''}<a class="button secondary" href="/app/operations?vue=commandes">Voir les commandes</a></div></section>` : ''}
    ${convertible ? `<section class="card" style="margin-top:18px"><h2>Valider et affecter</h2><p class="subtitle">La création de la commande verrouillera les modifications du client.</p><div class="field" style="margin-top:16px"><label>Livreur</label><select id="conversionDriver"><option value="">Sélectionner un livreur</option>${drivers.map((driver) => {
      const unavailable = ['inactive', 'off_duty', 'incident'].includes(driver.operationalState);
      const state = driverStateLabels[driver.operationalState] || driver.operationalState;
      return `<option value="${escapeHtml(driver.id)}" ${unavailable ? 'disabled' : ''}>${escapeHtml(driver.name)} — ${escapeHtml(state)} — ${escapeHtml(driver.activeOrders)}/${escapeHtml(driver.capacity)} colis</option>`;
    }).join('')}</select></div><div class="actions" style="margin-top:16px"><button class="primary" id="convertRequest">Créer la commande et le suivi</button></div><div id="conversionResult"></div></section>` : ''}
    ${!request.order_id && request.status !== 'Archivée' ? `<section class="card" style="margin-top:18px"><h2>Autres actions</h2><div class="actions">
      <button class="secondary statusAction" data-status="Informations à compléter">Demander des précisions</button>
      <button class="danger statusAction" data-status="Refusée">Refuser</button>
      <button class="secondary statusAction" data-status="Archivée">Archiver</button>
    </div><div id="actionResult"></div></section>` : ''}`;

  if (convertible) document.getElementById('convertRequest').addEventListener('click', async () => {
    const driverId = document.getElementById('conversionDriver').value;
    if (!driverId) { document.getElementById('conversionResult').innerHTML = '<div class="notice error">Sélectionnez un livreur.</div>'; return; }
    if (!confirm('Créer la commande, affecter ce livreur et verrouiller les informations du client ?')) return;
    document.getElementById('convertRequest').disabled = true;
    try {
      const result = await api(`/api/app/requests/${encodeURIComponent(id)}/convert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId }),
      });
      document.getElementById('conversionResult').innerHTML = `<div class="notice success">Commande créée pour ${escapeHtml(result.driverName || 'le livreur')}. Redirection…</div>`;
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      document.getElementById('conversionResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      document.getElementById('convertRequest').disabled = false;
    }
  });
  document.querySelectorAll('.statusAction').forEach((button) => button.addEventListener('click', async () => {
    const status = button.dataset.status;
    const message = status === 'Confirmée' ? 'Confirmer cette demande et empêcher le client de la modifier ?' : `Passer cette demande au statut « ${status} » ?`;
    if (!confirm(message)) return;
    document.querySelectorAll('.statusAction').forEach((item) => { item.disabled = true; });
    try {
      await api(`/api/app/requests/${encodeURIComponent(id)}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      location.reload();
    } catch (error) {
      document.getElementById('actionResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      document.querySelectorAll('.statusAction').forEach((item) => { item.disabled = false; });
    }
  }));
}

async function renderNewOrder() {
  setHeader('Nouvelle commande', 'Création directe par l’entreprise');
  const drivers = await api('/api/app/drivers');
  page.innerHTML = `
    <div class="page-header"><div><h1>Créer une commande directe</h1><p class="subtitle">À utiliser lorsque l’entreprise possède déjà les informations du client.</p></div></div>
    <section class="card"><form id="orderForm"><div class="form-grid">
      <div class="field"><label>Nom du client</label><input name="customerName" required /></div>
      <div class="field"><label>Téléphone du client</label><input name="customerPhone" inputmode="tel" placeholder="229XXXXXXXX" /></div>
      <div class="field full"><label>Lieu et instructions de livraison</label><textarea name="deliveryAddress" required placeholder="Zone, repère, coordonnées ou instructions…"></textarea></div>
      <div class="field full"><label>Livreur</label><select name="driverId" required><option value="">Sélectionner un livreur</option>${drivers.map((driver) => `<option value="${escapeHtml(driver.id)}" ${['inactive', 'off_duty', 'incident'].includes(driver.operationalState) ? 'disabled' : ''}>${escapeHtml(driver.name)} — ${escapeHtml(driverStateLabels[driver.operationalState] || driver.operationalState)} — ${escapeHtml(driver.activeOrders)}/${escapeHtml(driver.capacity)} colis</option>`).join('')}</select></div>
    </div><div class="actions" style="margin-top:20px"><button class="primary">Créer le lien de suivi</button></div></form><div id="orderResult"></div></section>`;
  document.getElementById('orderForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/app/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
      });
      const url = `${location.origin}${result.path}`;
      document.getElementById('orderResult').innerHTML = `<div class="notice success">Commande créée. <a href="${escapeHtml(url)}" target="_blank" rel="noopener">Ouvrir le suivi</a></div>`;
      event.currentTarget.reset();
    } catch (error) {
      document.getElementById('orderResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  });
}

async function renderOrders() {
  setHeader('Commandes', 'Commandes confirmées et liens de suivi');
  const orders = await api('/api/app/orders');
  page.innerHTML = `<div class="page-header"><div><h1>Commandes</h1><p class="subtitle">Ouvrez une commande pour exécuter la livraison, déclarer un incident ou confirmer la remise.</p></div><a class="button primary" href="/app/nouvelle-commande">Nouvelle commande</a></div><section class="card">${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Commande</th><th>Client</th><th>Zone</th><th>Livreur</th><th>Statut</th><th>Suivi</th></tr></thead><tbody>${orders.map((order) => `<tr data-href="/app/commandes/${escapeHtml(order.id)}"><td>N° ${escapeHtml(order.id)}<br><small>${escapeHtml(formatDate(order.created_at))}</small></td><td><strong>${escapeHtml(order.customer_name || '—')}</strong><br><small>${escapeHtml(order.customer_phone || '')}</small></td><td>${escapeHtml(order.neighborhood || order.landmark || '—')}</td><td>${escapeHtml(order.driver_name)}</td><td>${badge(order.status)}</td><td>${order.trackingLink?.path ? `<a href="${escapeHtml(order.trackingLink.path)}" target="_blank" rel="noopener">Ouvrir</a>` : escapeHtml(order.trackingLink?.state === 'revoked' ? 'Révoqué' : '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucune commande pour le moment.</div>'}</section>`;
  document.querySelectorAll('tr[data-href]').forEach((row) => row.addEventListener('click', (event) => {
    if (event.target.closest('a, button, input, select')) return;
    location.href = row.dataset.href;
  }));
}

async function renderRuns() {
  setHeader('Tournées', 'Regrouper et ordonner les colis d’un livreur');
  const [runs, drivers] = await Promise.all([api('/api/app/runs'), api('/api/app/drivers')]);
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const selectableDrivers = drivers.filter((driver) => driver.active && !['inactive', 'off_duty', 'incident'].includes(driver.operationalState));
  page.innerHTML = `<div class="page-header"><div><h1>Tournées</h1><p class="subtitle">Un même livreur peut transporter plusieurs colis, dans un ordre confirmé par l’équipe.</p></div></div>
    <section class="card"><h2>Préparer une nouvelle tournée</h2><p class="subtitle">Une seule tournée ouverte par livreur et par date. Une seconde pourra être créée lorsque la première sera terminée ou annulée.</p>
      <form id="runForm" style="margin-top:18px"><div class="form-grid"><div class="field"><label>Nom de la tournée</label><input name="name" minlength="2" maxlength="120" value="Tournée du ${escapeHtml(new Date().toLocaleDateString('fr-FR'))}" required /></div><div class="field"><label>Date de service</label><input name="serviceDate" type="date" value="${escapeHtml(today)}" required /></div><div class="field full"><label>Livreur</label><select name="driverId" required><option value="">Sélectionner</option>${selectableDrivers.map((driver) => `<option value="${escapeHtml(driver.id)}">${escapeHtml(driver.name)} — ${escapeHtml(driverStateLabels[driver.operationalState] || driver.operationalState)} — capacité ${escapeHtml(driver.capacity)} colis</option>`).join('')}</select></div></div><div class="actions" style="margin-top:18px"><button class="primary">Créer le brouillon</button></div></form><div id="runCreateResult"></div>
    </section>
    <section class="card" style="margin-top:18px"><h2>Historique des tournées</h2>${runs.length ? `<div class="table-wrap"><table><thead><tr><th>Tournée</th><th>Date</th><th>Livreur</th><th>Progression</th><th>État</th></tr></thead><tbody>${runs.map((run) => `<tr data-href="/app/tournees/${escapeHtml(run.id)}"><td><strong>${escapeHtml(run.name)}</strong><br><small>N° ${escapeHtml(run.id)}</small></td><td>${escapeHtml(formatDateOnly(run.service_date))}</td><td>${escapeHtml(run.driver_name)}<br><small>${escapeHtml(run.vehicle_type || '')}</small></td><td>${escapeHtml(run.terminal_stop_count)} / ${escapeHtml(run.stop_count)} arrêts terminés</td><td>${badge(runStatusLabels[run.status] || run.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucune tournée créée.</div>'}</section>`;

  document.getElementById('runForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const values = Object.fromEntries(new FormData(form));
    const idempotencyKey = idempotencyKeyFor(form, 'run-create', values);
    button.disabled = true;
    try {
      const result = await api('/api/app/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, idempotencyKey }),
      });
      location.href = `/app/tournees/${encodeURIComponent(result.id)}`;
    } catch (error) {
      document.getElementById('runCreateResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });
  document.querySelectorAll('tr[data-href]').forEach((row) => row.addEventListener('click', () => { location.href = row.dataset.href; }));
}

async function renderRunDetail(id) {
  setHeader('Tournée', 'Préparation et ordre des arrêts');
  const run = await api(`/api/app/runs/${encodeURIComponent(id)}`);
  let localStops = [...run.stops];
  const eventDescription = (event) => {
    if (event.event_type === 'status_changed') return `${runStatusLabels[event.details.fromStatus] || event.details.fromStatus} → ${runStatusLabels[event.details.toStatus] || event.details.toStatus}${event.details.reason ? ` · ${event.details.reason}` : ''}`;
    if (event.event_type === 'order_added') return `Commande n° ${event.details.orderId} ajoutée à l’arrêt ${event.details.sequence}`;
    if (event.event_type === 'order_removed') return `Commande n° ${event.details.orderId} retirée`;
    if (event.event_type === 'stops_reordered') return `${event.details.stopIds?.length || 0} arrêts réorganisés`;
    return `${run.driver_name} · ${formatDateOnly(run.service_date)}`;
  };
  page.innerHTML = `<div class="page-header"><div><a href="/app/operations?vue=tournees">← Retour aux tournées</a><h1 style="margin-top:12px">${escapeHtml(run.name)}</h1><p class="subtitle">${escapeHtml(formatDateOnly(run.service_date))} · ${escapeHtml(run.driver_name)} · ${escapeHtml(run.stops.length)} colis</p></div>${badge(runStatusLabels[run.status] || run.status)}</div>
    <div class="notice info" style="margin-bottom:16px">Cette tournée regroupe <strong>automatiquement</strong> les commandes du jour de ${escapeHtml(run.driver_name)}. Un colis s’y ajoute dès qu’une commande lui est affectée à la création — rien à saisir ici.</div>
    <section class="card"><div class="actions" style="justify-content:space-between"><div><h2 style="margin:0">Ordre de passage</h2><p class="subtitle">${run.canReorderStops ? 'Optimisez l’itinéraire sur les routes réelles, ou ajustez l’ordre à la main.' : 'L’ordre est verrouillé pendant l’exécution.'}</p></div><span>${escapeHtml(run.stops.length)} colis</span></div><div id="runNotice"></div><div id="runStops" style="margin-top:18px"></div>
      ${run.canReorderStops && run.stops.length > 1 ? `<div class="actions" style="margin-top:18px"><button class="primary" id="optimizeRun">Optimiser l’itinéraire (routes réelles)</button><button class="secondary" id="saveRunOrder">Enregistrer l’ordre manuel</button></div>` : ''}
    </section>
    ${run.allowedTransitions.length ? `<section class="card" style="margin-top:18px"><h2>Faire avancer la tournée</h2><form id="runStatusForm"><div class="form-grid"><div class="field"><label>Nouvel état</label><select name="toStatus" required><option value="">Sélectionner</option>${run.allowedTransitions.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(runStatusLabels[status] || status)}</option>`).join('')}</select></div><div class="field"><label>Motif</label><textarea name="reason" maxlength="1000" placeholder="Obligatoire pour une annulation (10 caractères minimum)"></textarea></div></div><div class="actions" style="margin-top:14px"><button class="primary">Confirmer le changement</button></div></form><div id="runStatusResult"></div></section>` : ''}
    <section class="card" style="margin-top:18px"><h2>Historique</h2>${run.events.length ? `<ol class="timeline">${run.events.map((event) => `<li><strong>${escapeHtml(runEventLabels[event.event_type] || event.event_type)}</strong><span>${escapeHtml(eventDescription(event))}</span><small>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor_name)}</small></li>`).join('')}</ol>` : '<div class="empty">Aucun événement.</div>'}</section>`;

  const renderStopList = () => {
    const container = document.getElementById('runStops');
    if (!localStops.length) {
      container.innerHTML = '<div class="empty">Ajoutez les colis confiés à ce livreur.</div>';
      return;
    }
    container.innerHTML = `<div class="stop-list">${localStops.map((stop, index) => {
      const destination = stop.neighborhood || stop.landmark || stop.delivery_address || 'Destination à préciser';
      return `<article class="stop-card"><div class="stop-number">${index + 1}</div><div class="stop-main"><strong>Commande n° ${escapeHtml(stop.order_id)} · ${escapeHtml(stop.customer_name || 'Client')}</strong><span>${escapeHtml(destination)}</span><small>${escapeHtml(stop.requested_time || 'Créneau non renseigné')} · ${stop.destination_lat == null ? 'Position GPS manquante' : 'Position GPS disponible'} · ${escapeHtml(stop.order_status)}</small></div>${run.canReorderStops ? `<div class="stop-actions"><button class="secondary move-stop" data-direction="up" data-id="${escapeHtml(stop.id)}" ${index === 0 ? 'disabled' : ''} aria-label="Monter cet arrêt">↑</button><button class="secondary move-stop" data-direction="down" data-id="${escapeHtml(stop.id)}" ${index === localStops.length - 1 ? 'disabled' : ''} aria-label="Descendre cet arrêt">↓</button>${run.canEditStops ? `<button class="danger remove-stop" data-id="${escapeHtml(stop.id)}">Retirer</button>` : ''}</div>` : ''}</article>`;
    }).join('')}</div>`;
    container.querySelectorAll('.move-stop').forEach((button) => button.addEventListener('click', () => {
      const index = localStops.findIndex((stop) => String(stop.id) === button.dataset.id);
      const target = button.dataset.direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= localStops.length) return;
      [localStops[index], localStops[target]] = [localStops[target], localStops[index]];
      renderStopList();
    }));
    container.querySelectorAll('.remove-stop').forEach((button) => button.addEventListener('click', async () => {
      const stop = localStops.find((item) => String(item.id) === button.dataset.id);
      if (!stop || !confirm(`Retirer la commande n° ${stop.order_id} de ce brouillon ? Elle restera disponible et son historique sera conservé.`)) return;
      button.disabled = true;
      try {
        await api(`/api/app/runs/${encodeURIComponent(id)}/stops/${encodeURIComponent(stop.id)}/remove`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion: run.version, idempotencyKey: actionKey('run-remove') }),
        });
        location.reload();
      } catch (error) {
        document.getElementById('runNotice').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        button.disabled = false;
      }
    }));
  };
  renderStopList();

  const optimizeButton = document.getElementById('optimizeRun');
  if (optimizeButton) optimizeButton.addEventListener('click', async () => {
    optimizeButton.disabled = true;
    document.getElementById('runNotice').innerHTML = '<div class="notice">Calcul de l’itinéraire optimal…</div>';
    try {
      const suggestion = await api(`/api/app/runs/${encodeURIComponent(id)}/suggestion`);
      if (!suggestion.available) {
        document.getElementById('runNotice').innerHTML = `<div class="notice warning">${escapeHtml(suggestion.reason)}${suggestion.missingOrderIds?.length ? ` Commandes concernées : ${escapeHtml(suggestion.missingOrderIds.join(', '))}.` : ''}</div>`;
        optimizeButton.disabled = false;
        return;
      }
      await api(`/api/app/runs/${encodeURIComponent(id)}/reorder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stopIds: suggestion.stopIds, expectedVersion: run.version, idempotencyKey: actionKey('run-optimize') }),
      });
      const road = suggestion.method === 'osrm_road_network';
      const detail = road
        ? `Itinéraire optimisé sur routes réelles : ~${escapeHtml(suggestion.distanceKm)} km${suggestion.durationMin != null ? `, ~${escapeHtml(suggestion.durationMin)} min de conduite` : ''}.`
        : `Ordre indicatif à vol d’oiseau : ~${escapeHtml(suggestion.distanceKm)} km (routage réel indisponible).`;
      sessionStorage.setItem('traxo.runNotice', detail);
      location.reload();
    } catch (error) {
      document.getElementById('runNotice').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      optimizeButton.disabled = false;
    }
  });
  try {
    const carried = sessionStorage.getItem('traxo.runNotice');
    if (carried) { sessionStorage.removeItem('traxo.runNotice'); document.getElementById('runNotice').innerHTML = `<div class="notice success">${escapeHtml(carried)}</div>`; }
  } catch {}

  const saveOrderButton = document.getElementById('saveRunOrder');
  if (saveOrderButton) saveOrderButton.addEventListener('click', async () => {
    const stopIds = localStops.map((stop) => Number(stop.id));
    if (!confirm('Enregistrer cet ordre comme ordre opérationnel de la tournée ?')) return;
    saveOrderButton.disabled = true;
    try {
      await api(`/api/app/runs/${encodeURIComponent(id)}/reorder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stopIds, expectedVersion: run.version, idempotencyKey: idempotencyKeyFor(saveOrderButton, 'run-reorder', { stopIds }) }),
      });
      location.reload();
    } catch (error) {
      document.getElementById('runNotice').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      saveOrderButton.disabled = false;
    }
  });

  const statusForm = document.getElementById('runStatusForm');
  if (statusForm) statusForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const values = Object.fromEntries(new FormData(form));
    if (values.toStatus === 'cancelled' && String(values.reason || '').trim().length < 10) {
      document.getElementById('runStatusResult').innerHTML = '<div class="notice error">Expliquez brièvement la raison de l’annulation.</div>';
      return;
    }
    if (!confirm(`Passer cette tournée à l’état « ${runStatusLabels[values.toStatus] || values.toStatus} » ?`)) return;
    button.disabled = true;
    try {
      await api(`/api/app/runs/${encodeURIComponent(id)}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, expectedVersion: run.version, idempotencyKey: idempotencyKeyFor(form, 'run-status', values) }),
      });
      location.reload();
    } catch (error) {
      document.getElementById('runStatusResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });
}

async function renderOrderDetail(id) {
  setHeader('Commande', 'Exécution, preuve de remise et incidents');
  const order = await api(`/api/app/orders/${encodeURIComponent(id)}`);
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
  page.innerHTML = `
    <div class="page-header"><div><a href="/app/operations?vue=commandes">← Retour aux commandes</a><h1 style="margin-top:12px">Commande n° ${escapeHtml(order.id)}</h1><p class="subtitle">Mise à jour ${escapeHtml(formatDate(order.updated_at))}</p></div>${badge(order.status)}</div>
    <section class="card"><h2>Livraison</h2><div class="detail-grid">
      <div class="detail"><span>Client</span><strong>${escapeHtml(order.customer_name || '—')}</strong></div>
      <div class="detail"><span>Téléphone</span><strong>${escapeHtml(order.customer_phone || '—')}</strong></div>
      <div class="detail"><span>Créneau</span><strong>${escapeHtml(order.requested_time || '—')}</strong></div>
      <div class="detail"><span>Livreur</span><strong>${escapeHtml(order.driver_name)} · ${escapeHtml(order.driver_vehicle_type || '')}</strong></div>
      <div class="detail" style="grid-column:span 2"><span>Destination et instructions</span><strong>${escapeHtml(destination)}</strong></div>
    </div></section>

    <section class="card" style="margin-top:18px"><h2>Lien de suivi client</h2><p class="subtitle">Ce lien donne accès uniquement au colis concerné. Il n’est révélé qu’à votre demande et chaque affichage est enregistré.</p><div class="detail-grid"><div class="detail"><span>État du lien</span><strong>${escapeHtml(trackingStateLabels[trackingLink.state] || trackingLink.state)}</strong></div><div class="detail"><span>Expiration</span><strong>${escapeHtml(formatDate(trackingLink.expiresAt))}</strong></div></div><div class="actions" style="margin-top:18px">${trackingLinkUsable ? '<button class="secondary" type="button" id="revealTrackingLink">Afficher et copier</button>' : ''}${!order.isTerminal ? `<label class="field" style="max-width:190px"><span>Nouvelle durée</span><select id="trackingTtl"><option value="1">1 jour</option><option value="3">3 jours</option><option value="7" selected>7 jours</option><option value="14">14 jours</option><option value="30">30 jours</option></select></label><button class="primary" type="button" id="rotateTrackingLink">${trackingLinkUsable ? 'Renouveler le lien' : 'Créer un nouveau lien'}</button>` : ''}${trackingLinkUsable ? '<button class="danger" type="button" id="revokeTrackingLink">Révoquer</button>' : ''}</div><div id="trackingLinkResult"></div></section>

    ${renderPaymentSection(order)}

    ${!order.isTerminal && order.allowedTransitions.length ? `<section class="card" style="margin-top:18px"><h2>Faire avancer la livraison</h2><p class="subtitle">Seules les étapes compatibles avec l’état actuel sont proposées.</p><form id="transitionForm" style="margin-top:16px"><div class="form-grid"><div class="field"><label>Nouvelle étape</label><select name="toStatus" required><option value="">Choisir une étape</option>${order.allowedTransitions.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join('')}</select></div><div class="field"><label>Motif ou observation</label><textarea name="reason" placeholder="Obligatoire pour un échec, retour ou une annulation"></textarea></div></div><div class="actions" style="margin-top:16px"><button class="primary">Enregistrer l’étape</button></div></form><div id="transitionResult"></div></section>` : ''}

    ${(order.photo_proof_mode !== 'off' || order.signature_proof_mode !== 'off' || order.evidence?.length) ? `<section class="card" style="margin-top:18px"><h2>Preuves complémentaires</h2><p class="subtitle">Visibles uniquement par l’entreprise et le livreur affecté. Elles ne sont pas publiées sur le lien client.</p><div class="evidence-grid">${['photo', 'signature'].filter((type) => order[`${type}_proof_mode`] !== 'off' || evidenceByType[type]).map((type) => { const item = evidenceByType[type]; const label = type === 'photo' ? 'Photo de remise' : 'Signature'; const mode = order[`${type}_proof_mode`]; return `<article class="evidence-card"><strong>${label}</strong><small>${mode === 'required' ? 'Obligatoire' : 'Facultative'}</small>${item ? `<a target="_blank" rel="noopener" href="/api/app/evidence/${escapeHtml(item.id)}"><img src="/api/app/evidence/${escapeHtml(item.id)}" alt="${label}" /></a><small>Ajoutée le ${escapeHtml(formatDate(item.created_at))}</small>` : '<div class="evidence-empty">Pas encore ajoutée</div>'}</article>`; }).join('')}</div></section>` : ''}
    ${order.requiresOtpForDelivery ? `<section class="card" style="margin-top:18px"><h2>Confirmer la remise avec un code</h2><p class="subtitle">Le code est valable 30 minutes et ne peut être utilisé qu’une fois. Communiquez-le au destinataire par un canal fiable.</p>${order.paymentBlocksDelivery ? '<div class="notice error">Finalisez l’encaissement ou son rapprochement avant de confirmer la livraison.</div>' : ''}${missingRequiredEvidence.length ? `<div class="notice error">Preuve obligatoire manquante : ${escapeHtml(missingRequiredEvidence.join(' et '))}.</div>` : ''}<div class="actions" style="margin-top:16px"><button class="secondary" id="generateOtp">Générer un code de remise</button></div><div id="otpGenerated"></div><form id="verifyOtp" style="margin-top:18px"><div class="field"><label>Code communiqué par le destinataire</label><input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="000000" required /></div><div class="actions" style="margin-top:12px"><button class="primary" ${order.paymentBlocksDelivery || missingRequiredEvidence.length ? 'disabled' : ''}>Confirmer la livraison</button></div></form><div id="otpResult"></div></section>` : ''}
    ${order.proof_id ? `<section class="card" style="margin-top:18px"><h2>Preuve de remise</h2><div class="notice success">Remise confirmée par code à usage unique le ${escapeHtml(formatDate(order.proof_verified_at))}.</div></section>` : ''}

    <section class="card" style="margin-top:18px"><h2>Incidents</h2><form id="incidentForm"><div class="form-grid"><div class="field"><label>Type</label><select name="category">${incidentOptions}</select></div><div class="field"><label>Gravité</label><select name="severity"><option value="low">Faible</option><option value="medium" selected>Moyenne</option><option value="high">Élevée</option></select></div><div class="field full"><label>Description factuelle</label><textarea name="description" maxlength="2000" required placeholder="Décrivez ce qui s’est passé, sans supprimer les faits précédents."></textarea></div></div><div class="actions" style="margin-top:14px"><button class="secondary">Déclarer l’incident</button></div></form><div id="incidentResult"></div>
      <div class="incident-list">${order.incidents.length ? order.incidents.map((incident) => `<article class="incident"><div><strong>${escapeHtml(incidentCategoryLabels[incident.category] || incident.category)}</strong> ${badge(incident.status === 'resolved' ? 'Résolu' : 'Ouvert')}<p>${escapeHtml(incident.description)}</p><small>${escapeHtml(formatDate(incident.created_at))} · ${escapeHtml(incident.opened_by)} · gravité ${escapeHtml(incident.severity)}</small>${incident.resolution ? `<p><strong>Résolution :</strong> ${escapeHtml(incident.resolution)}</p>` : ''}</div><a class="button secondary" href="/app/incidents/${escapeHtml(incident.id)}">Ouvrir le dossier</a></article>`).join('') : '<p class="subtitle">Aucun incident déclaré.</p>'}</div>
    </section>

    <section class="card" style="margin-top:18px"><h2>Chronologie</h2><ol class="timeline">${order.events.map((event) => `<li><div>${badge(event.to_status)}${event.from_status ? `<span class="timeline-from"> depuis ${escapeHtml(event.from_status)}</span>` : ''}</div><strong>${escapeHtml(event.actor_name)}</strong><small>${escapeHtml(formatDate(event.created_at))}</small>${event.reason ? `<p>${escapeHtml(event.reason)}</p>` : ''}</li>`).join('')}</ol></section>`;

  const revealTrackingLink = document.getElementById('revealTrackingLink');
  if (revealTrackingLink) revealTrackingLink.addEventListener('click', async () => {
    revealTrackingLink.disabled = true;
    try {
      const result = await api(`/api/app/orders/${encodeURIComponent(id)}/tracking-link/reveal`, { method: 'POST' });
      const fullUrl = new URL(result.trackingLink.path, location.origin).href;
      try { await navigator.clipboard.writeText(fullUrl); } catch (_error) { /* Le lien reste affiché ci-dessous. */ }
      document.getElementById('trackingLinkResult').innerHTML = `<div class="notice success">Lien prêt${navigator.clipboard ? ' et copie demandée' : ''} : <a href="${escapeHtml(fullUrl)}" target="_blank" rel="noopener">ouvrir le suivi client</a>.</div>`;
    } catch (error) {
      document.getElementById('trackingLinkResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
      revealTrackingLink.disabled = false;
    }
  });

  const rotateTrackingLink = document.getElementById('rotateTrackingLink');
  if (rotateTrackingLink) rotateTrackingLink.addEventListener('click', async () => {
    const expiresInDays = Number(document.getElementById('trackingTtl').value);
    if (!confirm('Créer un nouveau lien ? L’ancien lien cessera immédiatement de fonctionner.')) return;
    rotateTrackingLink.disabled = true;
    try {
      await api(`/api/app/orders/${encodeURIComponent(id)}/tracking-link/rotate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays, expectedVersion: trackingLink.version, idempotencyKey: actionKey('tracking-link-rotate') }),
      });
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('trackingLinkResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      rotateTrackingLink.disabled = false;
    }
  });

  const revokeTrackingLink = document.getElementById('revokeTrackingLink');
  if (revokeTrackingLink) revokeTrackingLink.addEventListener('click', async () => {
    const reason = prompt('Pourquoi révoquer ce lien ? (au moins 8 caractères)');
    if (!reason) return;
    if (reason.trim().length < 8) {
      document.getElementById('trackingLinkResult').innerHTML = '<div class="notice error">Le motif doit contenir au moins 8 caractères.</div>';
      return;
    }
    revokeTrackingLink.disabled = true;
    try {
      await api(`/api/app/orders/${encodeURIComponent(id)}/tracking-link/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), expectedVersion: trackingLink.version, idempotencyKey: actionKey('tracking-link-revoke') }),
      });
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('trackingLinkResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      revokeTrackingLink.disabled = false;
    }
  });

  const paymentConfigure = document.getElementById('paymentConfigure');
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
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const removePaymentRequirement = document.getElementById('removePaymentRequirement');
  if (removePaymentRequirement) removePaymentRequirement.addEventListener('click', async () => {
    const reason = prompt('Pourquoi cet encaissement n’est-il plus requis ?');
    if (!reason) return;
    removePaymentRequirement.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(removePaymentRequirement, 'payment-remove', { reason });
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, idempotencyKey }),
      });
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      removePaymentRequirement.disabled = false;
    }
  });

  const paymentCollect = document.getElementById('paymentCollect');
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
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const paymentReconcile = document.getElementById('paymentReconcile');
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
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const reversePayment = document.getElementById('reversePayment');
  if (reversePayment) reversePayment.addEventListener('click', async () => {
    const reason = prompt('Pourquoi cette saisie d’encaissement doit-elle être annulée ?');
    if (!reason) return;
    reversePayment.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(reversePayment, 'payment-reverse', { reason });
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/reverse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, idempotencyKey }),
      });
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      reversePayment.disabled = false;
    }
  });

  const paymentAdjustment = document.getElementById('paymentAdjustment');
  if (paymentAdjustment) paymentAdjustment.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button');
    if (!confirm(`Confirmer : ${paymentAdjustmentLabels[values.adjustmentType]} de ${formatMoney(values.amountMinor, 'XOF')} ?`)) return;
    button.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(form, 'payment-adjustment', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/adjustments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, idempotencyKey }),
      });
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  document.querySelectorAll('.reverse-adjustment').forEach((button) => button.addEventListener('click', async () => {
    const reason = prompt('Pourquoi cette écriture doit-elle être corrigée ? (10 caractères minimum)') || '';
    if (reason.trim().length < 10) return;
    const effectiveDate = new Date(Date.now() - (new Date().getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
    if (!confirm('Créer l’écriture inverse ? L’original restera visible.')) return;
    button.disabled = true;
    try {
      const values = { adjustmentId: button.dataset.adjustmentId, reason: reason.trim(), effectiveDate };
      const idempotencyKey = idempotencyKeyFor(button, 'payment-adjustment-reverse', values);
      await api(`/api/app/orders/${encodeURIComponent(id)}/payment/adjustments/${encodeURIComponent(button.dataset.adjustmentId)}/reverse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: values.reason, effectiveDate, idempotencyKey }),
      });
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  }));

  const transitionForm = document.getElementById('transitionForm');
  if (transitionForm) transitionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (reasonRequiredStatuses.includes(values.toStatus) && String(values.reason || '').trim().length < 5) {
      document.getElementById('transitionResult').innerHTML = '<div class="notice error">Expliquez la raison de cette étape.</div>';
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
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('transitionResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const generateOtp = document.getElementById('generateOtp');
  if (generateOtp) generateOtp.addEventListener('click', async () => {
    generateOtp.disabled = true;
    try {
      const idempotencyKey = generateOtp.dataset.idempotencyKey || actionKey('otp');
      generateOtp.dataset.idempotencyKey = idempotencyKey;
      const result = await api(`/api/app/orders/${encodeURIComponent(id)}/otp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey }),
      });
      document.getElementById('otpGenerated').innerHTML = `<div class="otp-code"><span>Code à transmettre au destinataire</span><strong>${escapeHtml(result.code)}</strong><small>Expire le ${escapeHtml(formatDate(result.expiresAt))} · ${escapeHtml(result.attemptsRemaining)} essais</small></div>`;
      generateOtp.textContent = 'Régénérer et invalider l’ancien code';
      delete generateOtp.dataset.idempotencyKey;
      generateOtp.disabled = false;
    } catch (error) {
      document.getElementById('otpGenerated').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      generateOtp.disabled = false;
    }
  });

  const verifyOtp = document.getElementById('verifyOtp');
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
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('otpResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  document.getElementById('incidentForm').addEventListener('submit', async (event) => {
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
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('incidentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
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

async function renderIncidents(initialScope = 'open') {
  setHeader('Incidents', 'Dossiers, responsabilités et conservation');
  page.innerHTML = `<div class="page-header"><div><h1>Dossiers d’incident</h1><p class="subtitle">Les faits d’origine restent inchangés. Les compléments sont ajoutés dans une chronologie séparée.</p></div></div><section class="card"><div class="actions" id="incidentScopes" style="margin-bottom:16px"><button class="secondary" data-scope="open">Ouverts</button><button class="secondary" data-scope="resolved">Résolus</button><button class="secondary" data-scope="all">Tous</button></div><div id="incidentTable">Chargement…</div></section>`;
  const load = async (scope) => {
    const incidents = await api(`/api/app/incidents?scope=${encodeURIComponent(scope)}`);
    document.querySelectorAll('#incidentScopes button').forEach((button) => button.disabled = button.dataset.scope === scope);
    document.getElementById('incidentTable').innerHTML = incidents.length ? `<div class="table-wrap"><table><thead><tr><th>Incident</th><th>Commande</th><th>Client</th><th>Livreur</th><th>Responsable</th><th>État</th></tr></thead><tbody>${incidents.map((incident) => `<tr data-href="/app/incidents/${escapeHtml(incident.id)}"><td><strong>${escapeHtml(incidentCategoryLabels[incident.category] || incident.category)}</strong><br><small>${escapeHtml(incidentSeverityLabels[incident.severity] || incident.severity)} · ${escapeHtml(formatDate(incident.created_at))}</small></td><td>N° ${escapeHtml(incident.order_id)}<br><small>${escapeHtml(incident.order_status)}</small></td><td>${escapeHtml(incident.customer_name || '—')}<br><small>${escapeHtml(incident.neighborhood || incident.customer_phone || '—')}</small></td><td>${escapeHtml(incident.driver_name)}</td><td>${escapeHtml(incident.assigned_to || 'Non attribué')}</td><td>${badge(incident.status === 'resolved' ? 'Résolu' : 'Ouvert')}${incident.retention_hold_id ? '<br><span class="badge warning" style="margin-top:6px">Conservation gelée</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucun incident dans cette vue.</div>';
    document.querySelectorAll('tr[data-href]').forEach((row) => row.addEventListener('click', () => { location.href = row.dataset.href; }));
  };
  document.querySelectorAll('#incidentScopes button').forEach((button) => button.addEventListener('click', () => load(button.dataset.scope).catch(renderError)));
  await load(initialScope);
}

async function renderIncidentDetail(id) {
  setHeader('Dossier d’incident', 'Chronologie vérifiable et gel de conservation');
  const dossier = await api(`/api/app/incidents/${encodeURIComponent(id)}`);
  const incident = dossier.incident;
  const activeHold = dossier.holds.find((hold) => hold.status === 'active');
  const holdOverdue = activeHold && new Date(activeHold.review_due_at).getTime() < Date.now();
  const canControl = ['owner', 'manager'].includes(context.user.role);
  const reviewDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const chainNotice = dossier.eventChainValid === true
    ? '<div class="notice success">Intégrité de la chronologie vérifiée.</div>'
    : dossier.eventChainValid === false
      ? '<div class="notice error">L’intégrité de la chronologie ne peut pas être confirmée. Contactez le support avant d’utiliser ce dossier.</div>'
      : '<div class="notice">Dossier antérieur au journal d’intégrité : aucune chaîne d’événements disponible.</div>';
  page.innerHTML = `<div class="page-header print-hidden"><div><a href="/app/operations?vue=incidents">← Retour aux incidents</a><h1 style="margin-top:12px">Incident n° ${escapeHtml(incident.id)}</h1><p class="subtitle">Commande n° ${escapeHtml(incident.order_id)} · ouvert le ${escapeHtml(formatDate(incident.created_at))}</p></div><div class="actions"><button class="secondary" id="printIncident">Imprimer / enregistrer en PDF</button>${canControl ? `<a class="button secondary" href="/api/app/incidents/${escapeHtml(incident.id)}/export">Télécharger les données</a>` : ''}</div></div>
    <section class="card incident-report"><div class="page-header"><div><h2>${escapeHtml(incidentCategoryLabels[incident.category] || incident.category)}</h2><p class="subtitle">Gravité ${escapeHtml(incidentSeverityLabels[incident.severity] || incident.severity)}</p></div>${badge(incident.status === 'resolved' ? 'Résolu' : 'Ouvert')}</div>
      <div class="detail-grid"><div class="detail"><span>Client</span><strong>${escapeHtml(incident.customer_name || '—')}</strong><small>${escapeHtml(incident.customer_phone || '')}</small></div><div class="detail"><span>Livreur</span><strong>${escapeHtml(incident.driver_name)}</strong><small>${escapeHtml(incident.driver_vehicle_type || '')}</small></div><div class="detail"><span>Responsable du dossier</span><strong>${escapeHtml(incident.assigned_to || 'Non attribué')}</strong></div><div class="detail"><span>Commande</span><strong>N° ${escapeHtml(incident.order_id)} · ${escapeHtml(incident.order_status)}</strong></div><div class="detail" style="grid-column:span 2"><span>Destination</span><strong>${escapeHtml([incident.neighborhood, incident.landmark, incident.delivery_address].filter(Boolean).join(' — ') || '—')}</strong></div></div>
      <h3>Déclaration d’origine</h3><p class="immutable-fact">${escapeHtml(incident.description)}</p><small>Déclarée par ${escapeHtml(incident.opened_by || 'Compte supprimé')} le ${escapeHtml(formatDate(incident.created_at))}. Ce texte n’est pas modifiable.</small>
      ${incident.resolution ? `<h3>Résolution</h3><p>${escapeHtml(incident.resolution)}</p><small>Résolu par ${escapeHtml(incident.resolved_by || 'Compte supprimé')} le ${escapeHtml(formatDate(incident.resolved_at))}</small>` : ''}
    </section>
    <section class="card" style="margin-top:18px"><h2>Conservation du dossier</h2>${activeHold ? `<div class="notice ${holdOverdue ? 'error' : 'warning'}"><strong>${holdOverdue ? 'Révision du gel en retard.' : 'Gel actif.'}</strong> Aucune purge automatisée ne devra supprimer les données liées à cette commande. ${holdOverdue ? 'Une décision humaine est requise depuis le' : 'Révision prévue le'} ${escapeHtml(formatDate(activeHold.review_due_at))}.<br><small>Motif : ${escapeHtml(activeHold.reason)}</small></div>${canControl ? '<form id="releaseHold" class="print-hidden"><div class="field"><label>Motif de levée</label><textarea name="reason" minlength="10" maxlength="2000" required placeholder="Pourquoi le dossier peut-il reprendre son cycle normal de conservation ?"></textarea></div><button class="secondary" style="margin-top:12px">Lever le gel</button></form>' : ''}` : `<p class="subtitle">Aucun gel actif. Les règles normales de conservation s’appliqueront lorsqu’elles seront automatisées.</p>${canControl ? `<form id="placeHold" class="print-hidden"><div class="form-grid"><div class="field full"><label>Motif précis du gel</label><textarea name="reason" minlength="10" maxlength="2000" required placeholder="Réclamation, litige, contrôle ou demande officielle…"></textarea></div><div class="field"><label>Date de prochaine révision</label><input name="reviewDueAt" type="date" value="${reviewDate}" required /></div></div><button class="danger" style="margin-top:12px">Geler la conservation</button></form>` : ''}`}<div id="holdResult"></div>${dossier.holds.length ? `<details><summary>Historique des gels (${dossier.holds.length})</summary><ul>${dossier.holds.map((hold) => `<li>${escapeHtml(hold.status === 'active' ? 'Actif' : 'Levé')} · ${escapeHtml(formatDate(hold.placed_at))} · ${escapeHtml(hold.placed_by || 'Compte supprimé')} — ${escapeHtml(hold.reason)}${hold.release_reason ? ` · Levée : ${escapeHtml(hold.release_reason)}` : ''}</li>`).join('')}</ul></details>` : ''}</section>
    <section class="card print-hidden" style="margin-top:18px"><h2>Actions sur le dossier</h2>${canControl ? `<form id="assignIncident"><div class="field"><label>Responsable</label><select name="userId" required><option value="">Sélectionner</option>${dossier.members.map((member) => `<option value="${escapeHtml(member.id)}" ${String(member.id) === String(incident.assigned_to_user_id) ? 'selected' : ''}>${escapeHtml(member.display_name)} — ${escapeHtml(roleLabels[member.role] || member.role)}</option>`).join('')}</select></div><button class="secondary" style="margin-top:12px">Attribuer</button></form>` : ''}<form id="incidentNote" style="margin-top:18px"><div class="field"><label>Ajouter une note factuelle</label><textarea name="note" minlength="3" maxlength="2000" required placeholder="Appel effectué, constat, information reçue… La note restera dans l’historique."></textarea></div><button class="secondary" style="margin-top:12px">Ajouter à la chronologie</button></form>${incident.status === 'open' ? '<form id="resolveIncidentForm" style="margin-top:18px"><div class="field"><label>Résolution finale</label><textarea name="resolution" minlength="5" maxlength="2000" required placeholder="Décision prise, accord obtenu, correction effectuée…"></textarea></div><button class="primary" style="margin-top:12px">Marquer comme résolu</button></form>' : ''}<div id="incidentActionResult"></div></section>
    <section class="card" style="margin-top:18px"><h2>Chronologie du dossier</h2>${chainNotice}<ol class="timeline">${dossier.events.length ? dossier.events.map((event) => `<li><strong>${escapeHtml(incidentEventLabels[event.event_type] || event.event_type)}</strong><small>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor_name)}</small>${event.body ? `<p>${escapeHtml(event.body)}</p>` : ''}${event.event_type === 'assigned' && event.details?.assignedToName ? `<p>Responsable : ${escapeHtml(event.details.assignedToName)}</p>` : ''}</li>`).join('') : '<li>Aucun événement d’intégrité disponible.</li>'}</ol></section>
    ${dossier.evidence.some((item) => !item.superseded_at && !item.deleted_at) ? `<section class="card" style="margin-top:18px"><h2>Preuves complémentaires actives</h2><div class="evidence-grid">${dossier.evidence.filter((item) => !item.superseded_at && !item.deleted_at).map((item) => `<article class="evidence-card"><strong>${item.evidence_type === 'photo' ? 'Photo de remise' : 'Signature'}</strong><a href="/api/app/evidence/${escapeHtml(item.id)}" target="_blank" rel="noopener"><img src="/api/app/evidence/${escapeHtml(item.id)}" alt="Preuve ${escapeHtml(item.evidence_type)}" /></a><small>Empreinte : ${escapeHtml(item.content_sha256)}</small></article>`).join('')}</div></section>` : ''}
    <section class="card" style="margin-top:18px"><h2>Chronologie de la commande</h2><ol class="timeline">${dossier.orderEvents.map((event) => `<li><strong>${escapeHtml(event.to_status)}</strong><small>${escapeHtml(formatDate(event.created_at))} · ${escapeHtml(event.actor_name)}</small>${event.reason ? `<p>${escapeHtml(event.reason)}</p>` : ''}</li>`).join('')}</ol></section>`;

  document.getElementById('printIncident').addEventListener('click', () => window.print());
  const bindForm = (formId, url, prefix) => {
    const form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const idempotencyKey = idempotencyKeyFor(form, prefix, values);
        await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, idempotencyKey }) });
        await renderIncidentDetail(id);
      } catch (error) {
        document.getElementById(formId.includes('Hold') ? 'holdResult' : 'incidentActionResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
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
  setHeader('Carte d’exploitation', 'Tour de contrôle de la flotte en direct');
  page.classList.add('page-map');
  const bikeSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>';
  const playIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
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

    <div class="ops-legend" id="opsLegend" hidden>
      <span class="ops-leg"><i class="dot state-available"></i>Disponible</span>
      <span class="ops-leg"><i class="dot state-busy"></i>En course</span>
      <span class="ops-leg"><i class="dot state-full"></i>Complet</span>
      <span class="ops-leg"><i class="dot state-stale"></i>GPS ancien</span>
      <span class="ops-leg"><i class="dot state-incident"></i>Incident</span>
    </div>
    <button type="button" class="ops-icon-btn ops-legend-toggle" id="legendToggle" title="Légende"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></button>

    <p class="ops-status" id="mapUpdate" role="status">Chargement des opérations…</p>
    <div class="ops-service" id="mapServiceNotice"></div>
  </div>`;

  if (typeof L === 'undefined') throw new Error('La carte n’a pas pu être chargée. Rechargez la page.');
  const map = L.map('operationsMap', { zoomControl: false, attributionControl: true }).setView([6.37, 2.43], 11);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

  const fleetLayer = L.featureGroup().addTo(map);
  const destinationLayer = L.featureGroup().addTo(map);
  const sequenceLayer = L.layerGroup().addTo(map);
  const liveRouteLayer = L.layerGroup().addTo(map);
  const operatorLayer = L.layerGroup().addTo(map);
  const replayLayer = L.layerGroup().addTo(map);
  let liveRoute = null; // { driverId, runId, distanceMeters, durationSeconds } ou { driverId, unavailable, reason }
  const replay = { active: false, driverId: null, positions: [], roadGeometry: null, index: 0, playing: false, timer: null, marker: null, dayStart: null, prevAuto: true };

  let baseStreet = null;
  let baseSatellite = null;
  let baseLabels = null;
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
    baseStreet = L.tileLayer(cfg.base.url, { maxZoom: cfg.base.maxZoom, attribution: cfg.base.attribution }).addTo(map);
    if (cfg.satellite) baseSatellite = L.tileLayer(cfg.satellite.url, { maxZoom: cfg.satellite.maxZoom, attribution: cfg.satellite.attribution });
    if (cfg.labels) baseLabels = L.tileLayer(cfg.labels.url, { maxZoom: cfg.labels.maxZoom, attribution: cfg.labels.attribution, pane: 'overlayPane' });
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
    [baseStreet, baseSatellite, baseLabels].forEach((layer) => { if (layer && map.hasLayer(layer)) map.removeLayer(layer); });
    if (name === 'street') { baseStreet.addTo(map); }
    else if (name === 'satellite') { baseSatellite.addTo(map); }
    else if (name === 'hybrid') { baseSatellite.addTo(map); if (baseLabels) baseLabels.addTo(map); }
    activeLayer = name;
    document.querySelectorAll('.ops-layer-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.layer === name));
  }

  function renderKpis() {
    const s = snapshot.summary;
    document.getElementById('opsKpis').innerHTML = `
      <div class="ops-kpi"><span>Livreurs</span><strong>${escapeHtml(s.drivers)}</strong></div>
      <div class="ops-kpi"><span>Positions reçues</span><strong>${escapeHtml(s.locatedDrivers)}</strong></div>
      <div class="ops-kpi"><span>Commandes actives</span><strong>${escapeHtml(s.activeOrders)}</strong></div>
      <div class="ops-kpi"><span>Tournées ouvertes</span><strong>${escapeHtml(s.openRuns)}</strong></div>
      <div class="ops-kpi"><span>GPS à vérifier</span><strong>${escapeHtml(s.staleDrivers)}</strong></div>
      <div class="ops-kpi"><span>Incidents ouverts</span><strong>${escapeHtml(s.openIncidents)}</strong></div>`;
  }

  function fleetListHtml() {
    const drivers = snapshot.drivers;
    const located = snapshot.summary.locatedDrivers;
    const cards = drivers.map((driver) => {
      const state = driverStateLabels[driver.operationalState] || driver.operationalState;
      const age = driver.position ? formatAge(driver.position.timestamp) : 'sans position';
      return `<button type="button" class="ops-driver-card" data-action="select" data-id="${escapeHtml(driver.id)}">
        <span class="ops-driver-dot state-${escapeHtml(driver.operationalState)}"></span>
        <span class="ops-driver-main"><strong>${escapeHtml(driver.name)}</strong><small>${escapeHtml(driver.vehicleType || 'Véhicule')} · ${escapeHtml(driver.activeOrders)}/${escapeHtml(driver.capacity)} colis · ${escapeHtml(age)}</small></span>
        <span class="ops-driver-side">${badge(state)}${driver.openIncidents ? `<span class="ops-inc">${escapeHtml(driver.openIncidents)} incident(s)</span>` : ''}</span>
      </button>`;
    }).join('');
    return `<div class="ops-panel-head">
        <div><strong class="ops-panel-title">Flotte</strong><small>${escapeHtml(located)} / ${escapeHtml(drivers.length)} localisé(s)</small></div>
      </div>
      <div class="ops-panel-controls">
        <label class="ops-chk"><input type="checkbox" id="toggleDest" ${showDestinations ? 'checked' : ''}/> Destinations</label>
        <label class="ops-chk"><input type="checkbox" id="toggleAuto" ${autoRefresh ? 'checked' : ''}/> Actualisation auto</label>
      </div>
      <input type="search" class="ops-search" id="driverSearch" placeholder="Filtrer un livreur…" autocomplete="off"/>
      <div class="ops-driver-list" id="driverList">${cards || '<div class="ops-empty">Aucun livreur enregistré.</div>'}</div>`;
  }

  function detailHtml(driver) {
    const speedKmh = driver.position?.speedKnots != null && Number.isFinite(Number(driver.position.speedKnots))
      ? Number(driver.position.speedKnots) * 1.852 : null;
    const phone = String(driver.phone || '').replace(/[^+\d]/g, '');
    const runCards = (driver.runs || []).map((run) => `<section class="ops-run"><div class="ops-run-head"><div><strong>${escapeHtml(run.name)}</strong><small>${escapeHtml(formatDateOnly(run.serviceDate))} · ${escapeHtml(run.completedStops)}/${escapeHtml(run.totalStops)} arrêt(s)</small></div>${badge(runStatusLabels[run.status] || run.status)}</div>
      ${run.stops.length ? `<ol class="ops-stops">${run.stops.map((stop) => `<li><span class="stop-number">${escapeHtml(stop.sequence)}</span><div class="ops-stop-main"><strong>${escapeHtml(stop.customerName || `Commande n° ${stop.id}`)}</strong><small>${escapeHtml(stop.neighborhood || stop.landmark || stop.deliveryAddress || 'Destination à compléter')} · ${escapeHtml(stop.status)}</small>${stop.openIncidents ? `<span class="ops-inc">${escapeHtml(stop.openIncidents)} incident(s)</span>` : ''}</div><a href="/app/commandes/${escapeHtml(stop.id)}">Voir</a></li>`).join('')}</ol>` : '<p class="ops-empty">Aucun arrêt restant.</p>'}
      <a class="button secondary" href="/app/tournees/${escapeHtml(run.id)}">Ouvrir la tournée</a></section>`).join('');
    const unplanned = (driver.unplannedOrders || []).length ? `<section class="ops-run"><strong class="ops-run-title">Hors tournée</strong><ol class="ops-stops">${driver.unplannedOrders.map((order) => `<li><span class="stop-number">•</span><div class="ops-stop-main"><strong>${escapeHtml(order.customerName || `Commande n° ${order.id}`)}</strong><small>${escapeHtml(order.neighborhood || order.landmark || order.deliveryAddress || 'Destination à compléter')} · ${escapeHtml(order.status)}</small></div><a href="/app/commandes/${escapeHtml(order.id)}">Voir</a></li>`).join('')}</ol></section>` : '';
    return `<div class="ops-panel-head ops-detail-head">
        <button type="button" class="ops-back" data-action="back" title="Retour à la flotte"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg></button>
        <div><strong class="ops-panel-title">${escapeHtml(driver.name)}</strong><small>${escapeHtml(driver.vehicleType || 'Véhicule')} · ${escapeHtml(driver.activeOrders)}/${escapeHtml(driver.capacity)} colis</small></div>
        ${badge(driverStateLabels[driver.operationalState] || driver.operationalState)}
      </div>
      <div class="ops-metrics">
        <div class="ops-metric"><span>Dernière position</span><strong>${driver.position ? escapeHtml(formatAge(driver.position.timestamp)) : 'Indisponible'}</strong></div>
        <div class="ops-metric"><span>Précision</span><strong>${driver.position?.accuracy != null && Number.isFinite(Number(driver.position.accuracy)) ? `${Math.round(Number(driver.position.accuracy))} m` : '—'}</strong></div>
        <div class="ops-metric"><span>Vitesse</span><strong>${speedKmh == null ? '—' : `${speedKmh.toFixed(0)} km/h`}</strong></div>
        <div class="ops-metric"><span>Incidents</span><strong>${escapeHtml(driver.openIncidents)}</strong></div>
      </div>
      <div class="ops-detail-actions">
        <button type="button" class="button secondary" data-action="center" ${driver.position ? '' : 'disabled'}>Centrer</button>
        <button type="button" class="button ${isolate ? 'accent' : 'secondary'}" data-action="isolate">${isolate ? 'Voir toute la flotte' : 'Isoler ce livreur'}</button>
        ${phone ? `<a class="button secondary" href="tel:${escapeHtml(phone)}">Appeler</a>` : ''}
        <button type="button" class="button ${replay.active && String(replay.driverId) === String(driver.id) ? 'accent' : 'secondary'}" data-action="replay">Rejouer le trajet</button>
      </div>
      <div id="opsReplay" class="ops-replay-slot"></div>
      ${driver.position?.stale ? '<div class="ops-note warning">Position de plus de 10 minutes : ne pas présenter comme du direct.</div>' : !driver.position ? '<div class="ops-note warning">Aucune coordonnée GPS exploitable pour ce livreur.</div>' : ''}
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
        document.querySelectorAll('#driverList .ops-driver-card').forEach((card) => {
          const name = card.querySelector('strong')?.textContent.toLowerCase() || '';
          card.style.display = name.includes(q) ? '' : 'none';
        });
      });
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
  function dayLabel(ts) {
    const start = new Date(ts); start.setHours(0, 0, 0, 0);
    const diff = Math.round((start.getTime() - todayMidnight()) / 86400000);
    if (diff === 0) return 'Aujourd’hui';
    if (diff === -1) return 'Hier';
    return start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

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
  function renderReplayUI() {
    const slot = document.getElementById('opsReplay');
    if (!slot) return;
    const hasTrack = replay.positions.length > 0;
    slot.innerHTML = `<div class="ops-replay">
      <div class="ops-replay-windows">
        ${['30', '60', '180'].map((k) => `<button type="button" class="ops-win ${String(replay.windowKey) === k ? 'active' : ''}" data-win="${k}">${winLabels[k]}</button>`).join('')}
        <div class="ops-day-nav">
          <button type="button" class="ops-day-arrow" data-day-step="-1" title="Jour précédent" aria-label="Jour précédent">‹</button>
          <button type="button" class="ops-win ops-day-label ${String(replay.windowKey) === 'day' ? 'active' : ''}" data-day-play title="Rejouer cette journée complète">${escapeHtml(dayLabel(replay.dayStart != null ? replay.dayStart : todayMidnight()))}</button>
          <button type="button" class="ops-day-arrow" data-day-step="1" title="Jour suivant" aria-label="Jour suivant" ${(replay.dayStart == null || replay.dayStart >= todayMidnight()) ? 'disabled' : ''}>›</button>
        </div>
        <button type="button" class="ops-win ${replay.customOpen ? 'active' : ''}" data-replay-custom>Période…</button>
        <button type="button" class="ops-win ops-win-close" data-replay-close title="Fermer le rejeu">Fermer</button>
      </div>
      ${replay.customOpen ? `<div class="ops-replay-range">
        <label>Du<input type="datetime-local" id="replayFrom" value="${escapeHtml(replay.customFrom || '')}"/></label>
        <label>Au<input type="datetime-local" id="replayTo" value="${escapeHtml(replay.customTo || '')}"/></label>
        <button type="button" class="button secondary" id="replayApply">Rejouer</button>
      </div>` : ''}
      <div class="ops-replay-status">${escapeHtml(replay.statusText || 'Choisissez une période pour rejouer le trajet. Astuce : le trajet complet d’une journée est destiné aux tests ; le suivi par commande arrive avec la refonte Commandes.')}</div>
      ${hasTrack ? `<div class="ops-replay-controls">
        <button type="button" class="ops-replay-play" id="opsReplayPlay">${replay.playing ? pauseIcon : playIcon}</button>
        <input type="range" id="opsReplayRange" min="0" max="${replay.positions.length - 1}" value="${replay.index}" aria-label="Position dans le trajet"/>
      </div>
      <div class="ops-replay-read" id="opsReplayRead"></div>` : ''}
    </div>`;
    slot.querySelectorAll('[data-win]').forEach((btn) => btn.addEventListener('click', () => startReplay(btn.dataset.win)));
    slot.querySelector('[data-day-play]')?.addEventListener('click', () => {
      if (replay.dayStart == null) replay.dayStart = todayMidnight();
      startReplay('day');
    });
    slot.querySelectorAll('[data-day-step]').forEach((btn) => btn.addEventListener('click', () => {
      const base = replay.dayStart != null ? replay.dayStart : todayMidnight();
      const next = base + Number(btn.dataset.step) * 86400000;
      if (next > todayMidnight()) return; // pas de journée future
      replay.dayStart = next;
      startReplay('day');
    }));
    slot.querySelector('[data-replay-close]')?.addEventListener('click', closeReplay);
    slot.querySelector('[data-replay-custom]')?.addEventListener('click', () => { replay.customOpen = !replay.customOpen; renderReplayUI(); });
    slot.querySelector('#replayApply')?.addEventListener('click', () => {
      replay.customFrom = slot.querySelector('#replayFrom').value;
      replay.customTo = slot.querySelector('#replayTo').value;
      if (!replay.customFrom || !replay.customTo) { replay.statusText = 'Renseignez une date de début et de fin.'; renderReplayUI(); return; }
      startReplay('custom');
    });
    if (hasTrack) {
      slot.querySelector('#opsReplayPlay').addEventListener('click', togglePlay);
      slot.querySelector('#opsReplayRange').addEventListener('input', (event) => { stopPlay(); replay.index = Number(event.target.value); drawReplayFrame(); });
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
    replay.timer = setInterval(() => {
      if (replay.index >= replay.positions.length - 1) { stopPlay(); return; }
      replay.index += 1; drawReplayFrame();
    }, 220);
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
        provider_disabled: 'Moteur d’itinéraire non configuré.',
        not_enough_points: 'Pas assez de points pour tracer un itinéraire.',
      };
      return `<div class="ops-liveroute unavailable">${escapeHtml(reasons[liveRoute.reason] || 'Itinéraire live indisponible pour l’instant.')}</div>`;
    }
    const km = liveRoute.distanceMeters != null ? (liveRoute.distanceMeters / 1000).toFixed(1) : '—';
    const min = liveRoute.durationSeconds != null ? Math.round(liveRoute.durationSeconds / 60) : null;
    return `<div class="ops-liveroute"><span class="ops-liveroute-dot"></span><div><strong>Itinéraire live · ${escapeHtml(km)} km restants</strong><small>${min != null ? `~${min} min de route` : 'durée indisponible'} · durée routière brute, hors arrêts et remise</small></div></div>`;
  }

  function updateLiveRouteInfo() {
    const el = document.getElementById('opsLiveRoute');
    if (el) el.innerHTML = liveRouteInfoHtml();
  }

  async function refreshLiveRoute() {
    const driver = selectedDriver();
    if (!driver || replay.active) { clearLiveRoute(); updateLiveRouteInfo(); return; }
    const activeRun = (driver.runs || []).find((run) => run.status === 'active');
    if (!activeRun) { clearLiveRoute(); updateLiveRouteInfo(); return; }
    try {
      const data = await api(`/api/app/runs/${encodeURIComponent(activeRun.id)}/route`);
      const current = selectedDriver();
      // Le livreur a pu être désélectionné ou un rejeu lancé pendant l'appel.
      if (!current || String(current.id) !== String(driver.id) || replay.active) return;
      const route = data.route;
      liveRouteLayer.clearLayers();
      if (route && route.status === 'ok' && route.geometry?.value?.coordinates?.length >= 2) {
        const coords = route.geometry.value.coordinates.map(([lng, lat]) => [lat, lng]);
        L.polyline(coords, { color: '#e11d2a', weight: 5, opacity: 0.9 }).addTo(liveRouteLayer);
        liveRoute = { driverId: driver.id, runId: activeRun.id, distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds };
      } else {
        liveRoute = { driverId: driver.id, runId: activeRun.id, unavailable: true, reason: route?.failure?.code || 'unavailable' };
      }
      updateLiveRouteInfo();
    } catch (error) {
      liveRouteLayer.clearLayers();
      liveRoute = { driverId: driver.id, unavailable: true, reason: 'unavailable' };
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
    else if (action === 'isolate') { isolate = !isolate; redrawMap({ fit: true }); renderPanel(); refreshLiveRoute(); }
    else if (action === 'replay') {
      if (replay.active && String(replay.driverId) === String(selectedDriverId)) { closeReplay(); }
      else { clearLiveRoute(); replay.active = true; replay.driverId = selectedDriverId; replay.windowKey = null; replay.positions = []; replay.statusText = null; suspendAutoForReplay(); renderPanel(); }
    }
  });

  document.querySelectorAll('.ops-layer-btn').forEach((btn) => btn.addEventListener('click', () => setLayer(btn.dataset.layer)));
  document.getElementById('kpiToggle').addEventListener('click', (event) => {
    const panel = document.getElementById('opsKpisPanel');
    const open = panel.hasAttribute('hidden');
    if (open) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });

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
      el.setAttribute('hidden', '');
      document.getElementById('kpiToggle')?.setAttribute('aria-expanded', 'false');
    });
  }
  setupFloat('opsPanel');
  setupFloat('opsKpisPanel');

  document.getElementById('legendToggle').addEventListener('click', () => {
    const legend = document.getElementById('opsLegend');
    if (legend.hasAttribute('hidden')) legend.removeAttribute('hidden'); else legend.setAttribute('hidden', '');
  });
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

function openModal(title, bodyHtml, footHtml = '') {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
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

async function renderDrivers() {
  setHeader('Livreurs', 'Flotte, accès et disponibilité');
  const canManage = ['owner', 'manager'].includes(context.user.role);
  let drivers = await api('/api/app/drivers');
  let filter = 'all';
  let query = '';
  let view = (() => { try { return localStorage.getItem('traxo.fleetView'); } catch { return null; } })() || (window.innerWidth < 720 ? 'cards' : 'table');
  let openMenu = null;

  const vehicleOptions = (selected) => driverVehicleOptions.map((option) => `<option value="${option}" ${option === selected ? 'selected' : ''}>${option}</option>`).join('');
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase() || '?';
  const driverPhotoUrl = (driver) => driver.hasPhoto && driver.id ? `/api/app/drivers/${encodeURIComponent(driver.id)}/photo?v=${driver.photoVersion || 0}` : null;
  const avatarHtml = (driver) => {
    const url = driverPhotoUrl(driver);
    return url
      ? `<span class="avatar has-photo"><img src="${url}" alt="" loading="lazy"></span>`
      : `<span class="avatar">${escapeHtml(initials(driver.name))}</span>`;
  };
  const bucketOf = (driver) => {
    if (!driver.active) return 'inactive';
    if (['incident', 'off_duty', 'inactive'].includes(driver.operationalState)) return 'inactive';
    if (['offline', 'stale', 'pause'].includes(driver.operationalState)) return 'offline';
    if (['busy', 'full'].includes(driver.operationalState)) return 'busy';
    return 'available';
  };
  const tabs = [
    { key: 'all', label: 'Tous' },
    { key: 'available', label: 'Disponibles' },
    { key: 'busy', label: 'En course' },
    { key: 'offline', label: 'Hors ligne' },
    { key: 'inactive', label: 'Désactivés' },
  ];
  const countFor = (key) => key === 'all' ? drivers.length : drivers.filter((driver) => bucketOf(driver) === key).length;
  const matches = (driver) => (filter === 'all' || bucketOf(driver) === filter)
    && (!query || `${driver.name} ${driver.vehicleType} ${driver.phone || ''} ${driver.uniqueId}`.toLowerCase().includes(query));
  const accountChip = (driver) => driver.hasAccount
    ? `<span class="account-chip ok">${fleetIcons.check} Compte actif</span>`
    : driver.invitePending
      ? `<span class="account-chip pending">${fleetIcons.clock} Invitation envoyée</span>`
      : `<span class="account-chip none">${fleetIcons.userx} Sans compte</span>`;
  const availSelect = (driver) => `<select class="availability avail-select av-${escapeHtml(driver.availabilityStatus)}" data-id="${escapeHtml(driver.id)}" ${driver.active ? '' : 'disabled'} aria-label="Disponibilité">
      <option value="available" ${driver.availabilityStatus === 'available' ? 'selected' : ''}>Disponible</option>
      <option value="pause" ${driver.availabilityStatus === 'pause' ? 'selected' : ''}>Pause</option>
      <option value="off_duty" ${driver.availabilityStatus === 'off_duty' ? 'selected' : ''}>Hors service</option>
      <option value="incident" ${driver.availabilityStatus === 'incident' ? 'selected' : ''}>Incident</option>
    </select>`;
  const rowMenu = (driver) => canManage ? `<div class="row-menu"><button class="row-menu-btn" data-menu="${escapeHtml(driver.id)}" aria-label="Actions">${fleetIcons.dots}</button></div>` : '';

  page.innerHTML = `<div class="page-header">
      <div><h1>Livreurs</h1><p class="subtitle">Gérez votre flotte, les accès et la disponibilité.</p></div>
      ${canManage ? `<button class="button primary" id="addDriverBtn">${fleetIcons.plus} Ajouter un livreur</button>` : ''}
    </div>
    <section class="fleet-overview" id="fleetKpis"></section>
    <div class="fleet-toolbar">
      <div class="fleet-tabs" id="fleetTabs"></div>
      <div class="fleet-search"><span>${fleetIcons.search}</span><input type="search" id="fleetSearch" placeholder="Rechercher un livreur…" autocomplete="off"/></div>
      <div class="view-toggle" id="viewToggle">
        <button data-view="table" title="Vue tableau" aria-label="Vue tableau">${fleetIcons.table}</button>
        <button data-view="cards" title="Vue cartes" aria-label="Vue cartes">${fleetIcons.grid}</button>
      </div>
    </div>
    <div id="driverResult"></div>
    <section class="card" id="fleetList"></section>`;

  function donutSvg(segments, total) {
    const radius = 54; const center = 64; const stroke = 16; const circumference = 2 * Math.PI * radius; const gap = total > 1 ? 3 : 0;
    let offset = 0;
    const arcs = segments.filter((segment) => segment.value > 0).map((segment) => {
      const fraction = total ? segment.value / total : 0;
      const length = Math.max(0, fraction * circumference - gap);
      const arc = `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="${stroke}" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" stroke-linecap="round" transform="rotate(-90 ${center} ${center})"/>`;
      offset += fraction * circumference;
      return arc;
    }).join('');
    return `<svg viewBox="0 0 128 128" role="img" aria-label="Composition de la flotte">
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#eceef1" stroke-width="${stroke}"/>
      ${total ? arcs : ''}
      <text x="64" y="60" text-anchor="middle" class="donut-total">${total}</text>
      <text x="64" y="80" text-anchor="middle" class="donut-sub">livreur${total > 1 ? 's' : ''}</text>
    </svg>`;
  }

  function renderKpis() {
    const el = document.getElementById('fleetKpis');
    const available = drivers.filter((driver) => bucketOf(driver) === 'available').length;
    const busy = drivers.filter((driver) => bucketOf(driver) === 'busy').length;
    const offline = drivers.filter((driver) => bucketOf(driver) === 'offline').length;
    const inactive = drivers.filter((driver) => bucketOf(driver) === 'inactive').length;
    const withAccount = drivers.filter((driver) => driver.hasAccount).length;
    const located = drivers.filter((driver) => driver.lastUpdate).length;
    const capacity = drivers.reduce((sum, driver) => sum + Number(driver.capacity || 0), 0);
    const segments = [
      { label: 'Disponibles', value: available, color: '#157347' },
      { label: 'En course', value: busy, color: '#475569' },
      { label: 'Hors ligne', value: offline, color: '#a15c00' },
      { label: 'Désactivés', value: inactive, color: '#b42318' },
    ];
    const boxIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>';
    el.innerHTML = `
      <article class="card fleet-hero">
        <div class="fleet-donut">${donutSvg(segments, drivers.length)}</div>
        <div class="fleet-hero-legend">
          <h2>Composition de la flotte</h2>
          <ul>${segments.map((segment) => `<li><span class="lg-dot" style="background:${segment.color}"></span><span class="lg-label">${segment.label}</span><span class="lg-val">${segment.value}</span></li>`).join('')}</ul>
        </div>
      </article>
      <div class="fleet-kpis grid">
        <article class="stat fleet-kpi tone-green"><span class="kpi-ic">${fleetIcons.check}</span><div><strong>${withAccount}</strong><span>Comptes actifs</span></div></article>
        <article class="stat fleet-kpi tone-amber"><span class="kpi-ic">${fleetIcons.userx}</span><div><strong>${drivers.length - withAccount}</strong><span>Sans compte</span></div></article>
        <article class="stat fleet-kpi"><span class="kpi-ic">${fleetIcons.route}</span><div><strong>${located}</strong><span>GPS reçu</span></div></article>
        <article class="stat fleet-kpi"><span class="kpi-ic">${boxIcon}</span><div><strong>${capacity}</strong><span>Capacité totale</span></div></article>
      </div>`;
  }

  function renderTabs() {
    document.getElementById('fleetTabs').innerHTML = tabs.map((tab) => `<button class="fleet-tab ${filter === tab.key ? 'active' : ''}" data-tab="${tab.key}">${tab.label}<span class="count">${countFor(tab.key)}</span></button>`).join('');
  }

  function renderList() {
    const list = drivers.filter(matches);
    const container = document.getElementById('fleetList');
    if (!list.length) {
      container.className = 'card';
      container.innerHTML = `<div class="fleet-empty">${drivers.length ? 'Aucun livreur ne correspond à ce filtre.' : 'Aucun livreur enregistré. Cliquez sur « Ajouter un livreur ».'}</div>`;
      return;
    }
    if (view === 'cards') {
      container.className = '';
      container.innerHTML = `<div class="fleet-cards">${list.map((driver) => `<div class="fleet-card">
        <div class="fleet-card-top">
          ${avatarHtml(driver)}
          <div class="fleet-name"><div class="fleet-id"><strong>${escapeHtml(driver.name)}</strong><small>${escapeHtml(driver.vehicleType)}${driver.phone ? ` · ${escapeHtml(driver.phone)}` : ''}</small></div></div>
          ${rowMenu(driver)}
        </div>
        <div>${badge(driverStateLabels[driver.operationalState] || driver.operationalState)}${driver.active ? '' : ' <span class="badge">Désactivé</span>'} &nbsp; ${accountChip(driver)}</div>
        <div class="fleet-card-stats">
          <div class="fleet-card-stat"><span>Charge</span><strong>${escapeHtml(driver.activeOrders)} / ${escapeHtml(driver.capacity)}</strong></div>
          <div class="fleet-card-stat"><span>Identifiant GPS</span><strong class="mono">${escapeHtml(driver.uniqueId)}</strong></div>
          <div class="fleet-card-stat"><span>Dernière position</span><strong>${escapeHtml(formatAge(driver.lastUpdate))}</strong></div>
          <div class="fleet-card-stat"><span>GPS</span><strong>${escapeHtml(driver.trackerStatus)}</strong></div>
        </div>
        <div class="fleet-card-foot">${availSelect(driver)}</div>
      </div>`).join('')}</div>`;
      return;
    }
    container.className = 'card';
    container.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Livreur</th><th>État</th><th>Charge</th><th>Identifiant GPS</th><th>Dernière position</th><th>Compte</th><th>Disponibilité</th>${canManage ? '<th></th>' : ''}</tr></thead><tbody>${list.map((driver) => `<tr>
      <td><div class="fleet-name">${avatarHtml(driver)}<div class="fleet-id"><strong>${escapeHtml(driver.name)}</strong><small>${escapeHtml(driver.vehicleType)}${driver.phone ? ` · ${escapeHtml(driver.phone)}` : ''}</small></div></div></td>
      <td>${badge(driverStateLabels[driver.operationalState] || driver.operationalState)}${driver.active ? '' : ' <span class="badge">Désactivé</span>'}</td>
      <td>${escapeHtml(driver.activeOrders)} / ${escapeHtml(driver.capacity)}</td>
      <td><span class="mono">${escapeHtml(driver.uniqueId)}</span></td>
      <td>${escapeHtml(formatAge(driver.lastUpdate))}</td>
      <td>${accountChip(driver)}</td>
      <td>${availSelect(driver)}</td>
      ${canManage ? `<td>${rowMenu(driver)}</td>` : ''}
    </tr>`).join('')}</tbody></table></div>`;
  }

  function refreshView() { renderKpis(); renderTabs(); renderList(); }

  async function reload() {
    drivers = await api('/api/app/drivers');
    refreshView();
  }

  function notify(html) { document.getElementById('driverResult').innerHTML = html; }

  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }

  function openRowMenu(driver, anchor) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'menu-pop';
    menu.innerHTML = `
      <button data-act="edit">${fleetIcons.edit} Modifier</button>
      ${driver.hasAccount ? '' : `<button data-act="access">${fleetIcons.link} ${driver.invitePending ? 'Régénérer l’accès' : 'Créer l’accès livreur'}</button>`}
      <button data-act="toggle">${fleetIcons.power} ${driver.active ? 'Désactiver' : 'Réactiver'}</button>
      <hr/>
      <button data-act="delete" class="danger">${fleetIcons.trash} Supprimer</button>`;
    anchor.parentElement.appendChild(menu);
    openMenu = menu;
    menu.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-act]')?.dataset.act;
      if (!action) return;
      closeMenu();
      if (action === 'edit') openEditModal(driver);
      else if (action === 'access') openAccessModal(driver);
      else if (action === 'toggle') await toggleActive(driver);
      else if (action === 'delete') openDeleteModal(driver);
    });
  }

  async function toggleActive(driver) {
    try {
      await api(`/api/app/drivers/${encodeURIComponent(driver.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !driver.active }) });
      notify(`<div class="notice success">${escapeHtml(driver.name)} ${driver.active ? 'désactivé' : 'réactivé'}.</div>`);
      await reload();
    } catch (error) { notify(`<div class="notice error">${escapeHtml(error.message)}</div>`); }
  }

  function driverFormFields(driver = {}) {
    return `<div class="form-grid">
      <div class="field"><label>Nom du livreur</label><input name="name" required maxlength="80" value="${escapeHtml(driver.name || '')}" autocomplete="off"/></div>
      <div class="field"><label>Téléphone / WhatsApp</label><input name="phone" inputmode="tel" maxlength="40" value="${escapeHtml(driver.phone || '')}" autocomplete="off"/></div>
      <div class="field"><label>Véhicule</label><select name="vehicleType">${vehicleOptions(driver.vehicleType)}</select></div>
      <div class="field"><label>Capacité (colis)</label><input name="capacity" type="number" min="1" max="50" value="${escapeHtml(driver.capacity || 3)}"/></div>
      <div class="field full"><label>Identifiant GPS ${driver.id ? '' : '(optionnel)'}</label><input name="trackerId" maxlength="64" value="${escapeHtml(driver.uniqueId || '')}" placeholder="Vide = généré automatiquement" autocomplete="off"/></div>
    </div>`;
  }

  function openAddModal() {
    const modal = openModal('Ajouter un livreur',
      `<p class="subtitle" style="margin-top:0">Créez la fiche. Renseignez un e-mail pour générer aussitôt un lien d’accès à son espace (compte limité, rattaché à votre entreprise).</p>
       <form id="driverForm">${driverFormFields()}<div class="field full"><label>E-mail (accès livreur, optionnel)</label><input name="email" type="email" autocomplete="off"/></div></form>
       <div id="modalResult"></div>`,
      `<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button primary" id="driverSubmit" type="submit" form="driverForm">Créer le livreur</button>`);
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    modal.backdrop.querySelector('#driverForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const submit = modal.backdrop.querySelector('#driverSubmit');
      submit.disabled = true;
      try {
        const driver = await api('/api/app/drivers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: data.name, phone: data.phone, vehicleType: data.vehicleType, capacity: Number(data.capacity), trackerId: data.trackerId }) });
        const email = String(data.email || '').trim();
        if (email) {
          try {
            const invite = await api('/api/app/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName: data.name, role: 'driver', driverId: driver.id }) });
            showInviteLink(`${location.origin}${invite.path}`);
          } catch (inviteError) {
            notify(`<div class="notice warning">Livreur créé, mais l’accès n’a pas pu être généré : ${escapeHtml(inviteError.message)}.</div>`);
          }
        } else {
          notify(`<div class="notice success">Livreur « ${escapeHtml(driver.name)} » créé.</div>`);
        }
        modal.close();
        await reload();
      } catch (error) {
        modal.backdrop.querySelector('#modalResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        submit.disabled = false;
      }
    });
  }

  function driverPhotoSection(driver) {
    const url = driverPhotoUrl(driver);
    return `<div class="driver-photo-edit">
      <div class="driver-photo-preview" id="photoPreview">${url ? `<img src="${url}" alt="">` : `<span>${escapeHtml(initials(driver.name))}</span>`}</div>
      <div class="driver-photo-actions">
        <div class="driver-photo-title">Photo du livreur</div>
        <p class="subtitle" style="margin:2px 0 8px">JPEG, PNG ou WebP · 600 Ko max. La photo apparaît dans les listes et fiches.</p>
        <div class="driver-photo-btns">
          <button class="button secondary small" type="button" id="photoPick">${url ? 'Remplacer' : 'Importer une photo'}</button>
          <button class="button subtle small" type="button" id="photoRemove" ${url ? '' : 'hidden'}>Retirer</button>
        </div>
        <input type="file" id="photoInput" accept="image/jpeg,image/png,image/webp" hidden>
        <div id="photoMsg" class="driver-photo-msg"></div>
      </div>
    </div>`;
  }

  async function resizeImageToDataUrl(file, max = 320) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    let source = bitmap;
    if (!source) {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    const scale = Math.min(1, max / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, cw, ch);
    if (bitmap && bitmap.close) bitmap.close();
    let quality = 0.86;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    // La limite globale du body JSON est de 256 Ko : on garde la dataUrl
    // (base64 + enveloppe JSON) confortablement en dessous.
    while (dataUrl.length > 230 * 1024 && quality > 0.35) {
      quality -= 0.12;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    return dataUrl;
  }

  function wireDriverPhoto(root, driver) {
    const input = root.querySelector('#photoInput');
    const pick = root.querySelector('#photoPick');
    const remove = root.querySelector('#photoRemove');
    const preview = root.querySelector('#photoPreview');
    const msg = root.querySelector('#photoMsg');
    if (!input || !pick) return;
    const setBusy = (busy) => { pick.disabled = busy; if (remove) remove.disabled = busy; };
    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { msg.innerHTML = '<span class="err">Format non supporté.</span>'; return; }
      setBusy(true);
      msg.textContent = 'Traitement…';
      try {
        const dataUrl = await resizeImageToDataUrl(file);
        await api(`/api/app/drivers/${encodeURIComponent(driver.id)}/photo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }) });
        preview.innerHTML = `<img src="${dataUrl}" alt="">`;
        pick.textContent = 'Remplacer';
        if (remove) remove.hidden = false;
        msg.innerHTML = '<span class="ok">Photo enregistrée.</span>';
        driver.hasPhoto = true;
        await reload();
      } catch (error) {
        msg.innerHTML = `<span class="err">${escapeHtml(error.message)}</span>`;
      } finally { setBusy(false); }
    });
    if (remove) remove.addEventListener('click', async () => {
      setBusy(true);
      msg.textContent = 'Suppression…';
      try {
        await api(`/api/app/drivers/${encodeURIComponent(driver.id)}/photo`, { method: 'DELETE' });
        preview.innerHTML = `<span>${escapeHtml(initials(driver.name))}</span>`;
        pick.textContent = 'Importer une photo';
        remove.hidden = true;
        msg.innerHTML = '<span class="ok">Photo retirée.</span>';
        driver.hasPhoto = false;
        await reload();
      } catch (error) {
        msg.innerHTML = `<span class="err">${escapeHtml(error.message)}</span>`;
      } finally { setBusy(false); }
    });
  }

  function openEditModal(driver) {
    const modal = openModal('Modifier le livreur',
      `${driverPhotoSection(driver)}<form id="driverForm">${driverFormFields(driver)}</form><div id="modalResult"></div>`,
      `<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button primary" id="driverSubmit" type="submit" form="driverForm">Enregistrer</button>`);
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    wireDriverPhoto(modal.backdrop, driver);
    modal.backdrop.querySelector('#driverForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      const submit = modal.backdrop.querySelector('#driverSubmit');
      submit.disabled = true;
      try {
        await api(`/api/app/drivers/${encodeURIComponent(driver.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: data.name, phone: data.phone, vehicleType: data.vehicleType, capacity: Number(data.capacity), trackerId: data.trackerId }) });
        notify(`<div class="notice success">Livreur mis à jour.</div>`);
        modal.close();
        await reload();
      } catch (error) {
        modal.backdrop.querySelector('#modalResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        submit.disabled = false;
      }
    });
  }

  function openAccessModal(driver) {
    const modal = openModal('Créer l’accès livreur',
      `<p class="subtitle" style="margin-top:0">Un lien d’accès (valable 48 h, à usage unique) sera généré pour <strong>${escapeHtml(driver.name)}</strong>. Le livreur choisira son mot de passe et n’aura accès qu’à ses commandes.</p>
       <form id="accessForm"><div class="field"><label>E-mail du livreur</label><input name="email" type="email" required autocomplete="off"/></div></form>
       <div id="modalResult"></div>`,
      `<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button primary" id="accessSubmit" type="submit" form="accessForm">Générer le lien</button>`);
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    modal.backdrop.querySelector('#accessForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = String(new FormData(event.currentTarget).get('email') || '').trim();
      const submit = modal.backdrop.querySelector('#accessSubmit');
      submit.disabled = true;
      try {
        const invite = await api('/api/app/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, displayName: driver.name, role: 'driver', driverId: driver.id }) });
        modal.close();
        showInviteLink(`${location.origin}${invite.path}`);
        await reload();
      } catch (error) {
        modal.backdrop.querySelector('#modalResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        submit.disabled = false;
      }
    });
  }

  function openDeleteModal(driver) {
    const modal = openModal('Supprimer le livreur',
      `<p>Voulez-vous supprimer <strong>${escapeHtml(driver.name)}</strong> de la liste ? Son historique de commandes est conservé et l’opération reste réversible (archive).</p>`,
      `<button class="button secondary" data-modal-close type="button">Annuler</button><button class="button accent" id="confirmDelete" type="button">Supprimer</button>`);
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    modal.backdrop.querySelector('#confirmDelete').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try {
        await api(`/api/app/drivers/${encodeURIComponent(driver.id)}`, { method: 'DELETE' });
        notify(`<div class="notice success">${escapeHtml(driver.name)} supprimé de la liste.</div>`);
        modal.close();
        await reload();
      } catch (error) {
        notify(`<div class="notice error">${escapeHtml(error.message)}</div>`);
        modal.close();
      }
    });
  }

  function showInviteLink(url) {
    const modal = openModal('Lien d’accès du livreur',
      `<p class="subtitle" style="margin-top:0">À envoyer au livreur (par WhatsApp par exemple). Valable 48 h, à usage unique.</p>
       <input readonly value="${escapeHtml(url)}" id="inviteLinkField" style="text-align:center"/>`,
      `<button class="button secondary" data-modal-close type="button">Fermer</button><button class="button primary" id="copyInviteBtn" type="button">Copier le lien</button>`);
    modal.backdrop.querySelector('[data-modal-close]').addEventListener('click', modal.close);
    modal.backdrop.querySelector('#copyInviteBtn').addEventListener('click', (event) => {
      const field = modal.backdrop.querySelector('#inviteLinkField');
      field.select(); navigator.clipboard?.writeText(field.value); event.currentTarget.textContent = 'Lien copié';
    });
  }

  // Interactions globales (délégation).
  page.addEventListener('change', async (event) => {
    const select = event.target.closest('.availability');
    if (!select) return;
    select.disabled = true;
    try {
      await api(`/api/app/drivers/${encodeURIComponent(select.dataset.id)}/availability`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: select.value }) });
      notify('<div class="notice success">Disponibilité mise à jour.</div>');
      const driver = drivers.find((item) => String(item.id) === String(select.dataset.id));
      if (driver) driver.availabilityStatus = select.value;
      select.className = `availability avail-select av-${select.value}`;
    } catch (error) {
      notify(`<div class="notice error">${escapeHtml(error.message)}</div>`);
    } finally {
      select.disabled = false;
    }
  });
  page.addEventListener('click', (event) => {
    const menuBtn = event.target.closest('[data-menu]');
    if (menuBtn) {
      event.stopPropagation();
      if (openMenu && openMenu.previousElementSibling === menuBtn) { closeMenu(); return; }
      const driver = drivers.find((item) => String(item.id) === String(menuBtn.dataset.menu));
      if (driver) openRowMenu(driver, menuBtn);
      return;
    }
    if (!event.target.closest('.menu-pop')) closeMenu();
    const tab = event.target.closest('[data-tab]');
    if (tab) { filter = tab.dataset.tab; renderTabs(); renderList(); }
    const viewBtn = event.target.closest('[data-view]');
    if (viewBtn) { view = viewBtn.dataset.view; try { localStorage.setItem('traxo.fleetView', view); } catch { /* ignore */ } syncViewToggle(); renderList(); }
    if (event.target.closest('#addDriverBtn')) openAddModal();
  });
  const search = document.getElementById('fleetSearch');
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderList(); });

  function syncViewToggle() { document.querySelectorAll('#viewToggle button').forEach((button) => button.classList.toggle('active', button.dataset.view === view)); }

  syncViewToggle();
  refreshView();
}

async function renderTeam() {
  setHeader('Équipe et accès', 'Comptes, rôles et invitations');
  const [team, drivers] = await Promise.all([api('/api/app/team'), api('/api/app/drivers')]);
  const linkedDriverIds = new Set([
    ...team.members.filter((member) => member.driver_id).map((member) => String(member.driver_id)),
    ...team.invitations.filter((invitation) => invitation.driver_id).map((invitation) => String(invitation.driver_id)),
  ]);
  const availableDrivers = drivers.filter((driver) => driver.active && !linkedDriverIds.has(String(driver.id)));
  page.innerHTML = `<div class="page-header"><div><h1>Équipe et accès</h1><p class="subtitle">Chaque personne possède son propre compte. Ne partagez jamais le compte propriétaire.</p></div></div>
    <section class="card"><h2>Membres actifs</h2>${team.members.length ? `<div class="table-wrap"><table><thead><tr><th>Personne</th><th>Rôle</th><th>Profil livreur</th><th>État</th></tr></thead><tbody>${team.members.map((member) => `<tr><td><strong>${escapeHtml(member.display_name)}</strong><br><small>${escapeHtml(member.email)}</small></td><td>${escapeHtml(roleLabels[member.role] || member.role)}</td><td>${escapeHtml(member.driver_name || '—')}</td><td>${badge(member.disabled ? 'Désactivé' : 'Actif')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucun membre.</div>'}</section>
    <section class="card" style="margin-top:18px"><h2>Inviter une personne</h2><p class="subtitle">Le lien expire après 48 heures et ne fonctionne qu’une seule fois.</p>
      <form id="invitationForm" style="margin-top:18px"><div class="form-grid"><div class="field"><label>Nom</label><input name="displayName" minlength="2" maxlength="100" required /></div><div class="field"><label>Adresse e-mail</label><input name="email" type="email" required /></div><div class="field"><label>Rôle</label><select name="role" id="invitationRole"><option value="operator">Opérateur</option>${context.user.role === 'owner' ? '<option value="manager">Manager</option>' : ''}<option value="driver">Livreur</option></select></div><div class="field" id="driverField" hidden><label>Profil livreur associé</label><select name="driverId" id="invitationDriver"><option value="">Sélectionner</option>${availableDrivers.map((driver) => `<option value="${escapeHtml(driver.id)}">${escapeHtml(driver.name)}</option>`).join('')}</select></div></div><button class="primary" style="margin-top:16px">Créer l’invitation</button></form><div id="invitationResult"></div>
    </section>
    <section class="card" style="margin-top:18px"><h2>Invitations en attente</h2><div id="pendingInvitations">${team.invitations.length ? `<div class="table-wrap"><table><thead><tr><th>Personne</th><th>Rôle</th><th>Expiration</th><th>Action</th></tr></thead><tbody>${team.invitations.map((invitation) => `<tr><td><strong>${escapeHtml(invitation.display_name)}</strong><br><small>${escapeHtml(invitation.email)}</small></td><td>${escapeHtml(roleLabels[invitation.role] || invitation.role)}${invitation.driver_name ? `<br><small>${escapeHtml(invitation.driver_name)}</small>` : ''}</td><td>${escapeHtml(formatDate(invitation.expires_at))}</td><td><button class="danger revokeInvitation" data-id="${escapeHtml(invitation.id)}">Révoquer</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucune invitation en attente.</div>'}</div></section>`;

  const role = document.getElementById('invitationRole');
  const driverField = document.getElementById('driverField');
  const driverSelect = document.getElementById('invitationDriver');
  const updateDriverField = () => {
    const isDriver = role.value === 'driver';
    driverField.hidden = !isDriver;
    driverSelect.required = isDriver;
    if (!isDriver) driverSelect.value = '';
  };
  role.addEventListener('change', updateDriverField);
  updateDriverField();
  document.getElementById('invitationForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      const result = await api('/api/app/invitations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const url = `${location.origin}${result.path}`;
      document.getElementById('invitationResult').innerHTML = `<div class="notice success"><strong>Invitation créée.</strong><br><a target="_blank" rel="noopener" href="${escapeHtml(url)}">${escapeHtml(url)}</a><div class="actions" style="margin-top:10px"><button class="secondary" id="copyInvitation" type="button">Copier le lien</button></div></div>`;
      event.currentTarget.reset();
      updateDriverField();
      button.disabled = false;
      document.getElementById('copyInvitation').addEventListener('click', async () => {
        await navigator.clipboard.writeText(url);
        document.getElementById('copyInvitation').textContent = 'Lien copié';
      });
    } catch (error) {
      document.getElementById('invitationResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });
  document.querySelectorAll('.revokeInvitation').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Révoquer cette invitation ? Le lien ne fonctionnera plus.')) return;
    button.disabled = true;
    try {
      await api(`/api/app/invitations/${encodeURIComponent(button.dataset.id)}/revoke`, { method: 'POST' });
      await renderTeam();
    } catch (error) {
      button.disabled = false;
      document.getElementById('pendingInvitations').insertAdjacentHTML('afterbegin', `<div class="notice error">${escapeHtml(error.message)}</div>`);
    }
  }));
}

const settingsIcons = {
  entreprise: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/></svg>',
  preuves: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  carte: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" x2="9" y1="3" y2="18"/><line x1="15" x2="15" y1="6" y2="21"/></svg>',
  securite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  abonnement: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
};

async function renderSettings() {
  setHeader('Paramètres', 'Configuration de l’espace TRAXO');
  const settings = await api('/api/app/settings/proofs');
  const canEdit = ['owner', 'manager'].includes(context.user.role);
  const company = context.company;
  const isActive = (company.activationStatus || 'active') === 'active';
  const modeOptions = (selected) => [
    ['off', 'Désactivée'], ['optional', 'Facultative'], ['required', 'Obligatoire'],
  ].map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
  const initials = String(company.name || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase() || '?';
  const infoRow = (label, value) => `<div class="set-row"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;

  const sections = [
    { key: 'entreprise', label: 'Entreprise', body: `
      <div class="set-company"><span class="avatar">${escapeHtml(initials)}</span><div><strong>${escapeHtml(company.name)}</strong><small>${escapeHtml(company.slug || '')}</small></div></div>
      <div class="set-list">
        ${infoRow('Identifiant', `#${escapeHtml(company.id)}`)}
        ${infoRow('Votre rôle', escapeHtml(roleLabels[context.user.role] || context.user.role))}
        ${infoRow('Compte', escapeHtml(context.user.name))}
        ${infoRow('E-mail', escapeHtml(context.user.email))}
      </div>
      <p class="set-hint">Le changement de nom d’entreprise et le logo personnalisé arriveront prochainement.</p>` },
    { key: 'preuves', label: 'Preuves de remise', body: `
      <p class="set-lead">Le code client reste la preuve principale. Activez une photo ou une signature seulement si votre activité le justifie.</p>
      <div class="notice">Une preuve « obligatoire » empêche la validation finale tant que le livreur ne l’a pas ajoutée. Les images restent privées.</div>
      <form id="proofSettings"><div class="form-grid">
        <div class="field"><label>Photo de remise</label><select name="photoMode" ${canEdit ? '' : 'disabled'}>${modeOptions(settings.photo_proof_mode)}</select><small>Privilégiez le colis ou le lieu, sans visage ni pièce d’identité.</small></div>
        <div class="field"><label>Signature du destinataire</label><select name="signatureMode" ${canEdit ? '' : 'disabled'}>${modeOptions(settings.signature_proof_mode)}</select><small>Ne demandez la signature que lorsqu’elle est réellement utile.</small></div>
      </div>${canEdit ? '<div class="actions" style="margin-top:18px"><button class="primary">Enregistrer les règles</button></div>' : '<p class="notice">Seul un propriétaire ou manager peut modifier ces règles.</p>'}</form><div id="settingsResult"></div>` },
    { key: 'carte', label: 'Carte & GPS', body: `
      <p class="set-lead">Réglages de la carte d’exploitation et du suivi GPS.</p>
      <div class="set-list">
        ${infoRow('Fond par défaut', 'OpenStreetMap')}
        ${infoRow('Satellite', '<span class="account-chip ok">'+settingsIcons.preuves+' Esri World Imagery</span>')}
        ${infoRow('Mode hybride', 'Disponible')}
        ${infoRow('Suivi GPS', 'Traccar')}
      </div>
      <p class="set-hint">L’enrôlement automatique des téléphones (QR + device) sera activé avec votre domaine GPS dédié.</p>` },
    { key: 'securite', label: 'Sécurité', body: `
      <p class="set-lead">Protections déjà en place sur votre espace.</p>
      <div class="set-list">
        ${infoRow('Mots de passe', 'scrypt + sel unique')}
        ${infoRow('Sessions', 'cookie HttpOnly · jeton haché')}
        ${infoRow('Connexion', 'limitée (anti-force-brute)')}
        ${infoRow('Isolation', 'chaque entreprise est cloisonnée')}
      </div>
      <p class="set-hint">La vérification d’e-mail et la réinitialisation de mot de passe arriveront avec l’envoi d’e-mails.</p>` },
    { key: 'abonnement', label: 'Abonnement', body: `
      <div class="set-plan ${isActive ? 'ok' : 'preview'}">
        <div><span>Statut du compte</span><strong>${isActive ? 'Compte actif' : 'Aperçu'}</strong></div>
        <span class="badge ${isActive ? 'success' : 'warning'}">${isActive ? 'Actif' : 'Non activé'}</span>
      </div>
      <p class="set-lead">${isActive ? 'Toutes les fonctionnalités sont débloquées pour votre entreprise.' : 'Votre compte est en aperçu : vous pouvez naviguer, mais les fonctionnalités se débloquent après activation.'}</p>
      <p class="set-hint">La facturation en ligne (Mobile Money) sera branchée prochainement ; l’activation est manuelle pour l’instant.</p>` },
  ];

  page.innerHTML = `<div class="page-header"><div><h1>Paramètres</h1><p class="subtitle">Configuration de l’espace TRAXO.</p></div></div>
    <div class="settings-hub">
      <nav class="settings-nav" id="settingsNav" aria-label="Sections des paramètres">
        ${sections.map((section, index) => `<button class="settings-navitem ${index === 0 ? 'active' : ''}" data-sec="${section.key}">${settingsIcons[section.key]}<span>${section.label}</span></button>`).join('')}
      </nav>
      <div class="settings-panels" id="settingsPanels">
        ${sections.map((section, index) => `<section class="card settings-sec ${index === 0 ? '' : 'is-hidden'}" data-sec="${section.key}"><h2>${section.label}</h2>${section.body}</section>`).join('')}
      </div>
    </div>`;

  document.getElementById('settingsNav').addEventListener('click', (event) => {
    const item = event.target.closest('[data-sec]');
    if (!item) return;
    const key = item.dataset.sec;
    document.querySelectorAll('#settingsNav .settings-navitem').forEach((navItem) => navItem.classList.toggle('active', navItem.dataset.sec === key));
    document.querySelectorAll('#settingsPanels .settings-sec').forEach((section) => section.classList.toggle('is-hidden', section.dataset.sec !== key));
  });

  const form = document.getElementById('proofSettings');
  if (canEdit && form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      await api('/api/app/settings/proofs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      document.getElementById('settingsResult').innerHTML = '<div class="notice success">Règles de preuve enregistrées.</div>';
    } catch (error) {
      document.getElementById('settingsResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  });
}

// Illustrations Opérations, en SVG inline : vectoriel, léger, aux couleurs TRAXO.
const opsArt = {
  form: '<svg viewBox="0 0 240 210" fill="none" aria-hidden="true"><defs><radialGradient id="fBlob" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#f8cccc"/><stop offset="1" stop-color="#fdecec" stop-opacity="0"/></radialGradient><radialGradient id="fSh" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#243049" stop-opacity=".18"/><stop offset="1" stop-color="#243049" stop-opacity="0"/></radialGradient></defs><ellipse cx="126" cy="104" rx="98" ry="88" fill="url(#fBlob)"/><ellipse cx="122" cy="184" rx="60" ry="12" fill="url(#fSh)"/><g transform="rotate(-5 122 104)"><path d="M80 44h72l26 26v96a7 7 0 0 1-7 7H80a7 7 0 0 1-7-7V51a7 7 0 0 1 7-7z" fill="#fff" stroke="#e7ebf2" stroke-width="2"/><path d="M152 44v19a7 7 0 0 0 7 7h19z" fill="#eef1f6"/><g stroke="#e9edf3" stroke-width="7" stroke-linecap="round"><path d="M92 88h60"/><path d="M92 106h60"/><path d="M92 124h44"/></g><path d="M92 142h32" stroke="#e11d2a" stroke-width="7" stroke-linecap="round"/></g><g transform="translate(146 128)"><rect x="0" y="0" width="48" height="48" rx="15" fill="#e11d2a"/><g stroke="#fff" stroke-width="4.6" stroke-linecap="round"><path d="M24 14v20"/><path d="M14 24h20"/></g></g></svg>',
  package: '<svg viewBox="0 0 260 214" fill="none" aria-hidden="true"><defs><radialGradient id="pBlob" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#dbe3f0"/><stop offset="1" stop-color="#eef1f6" stop-opacity="0"/></radialGradient><radialGradient id="pSh" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#243049" stop-opacity=".18"/><stop offset="1" stop-color="#243049" stop-opacity="0"/></radialGradient><filter id="pToast" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#243049" flood-opacity="0.16"/></filter></defs><ellipse cx="120" cy="96" rx="104" ry="86" fill="url(#pBlob)"/><ellipse cx="120" cy="176" rx="62" ry="11" fill="url(#pSh)"/><path d="M64 78l56 32v58l-56-32z" fill="#dbe3ef" stroke="#c6cfdd" stroke-width="2" stroke-linejoin="round"/><path d="M176 78l-56 32v58l56-32z" fill="#c6d0e0" stroke="#c6cfdd" stroke-width="2" stroke-linejoin="round"/><path d="M120 46l56 32-56 32-56-32z" fill="#f5f8fc" stroke="#c6cfdd" stroke-width="2" stroke-linejoin="round"/><path d="M112 50L126 58L92 78L78 70Z" fill="#e11d2a"/><path d="M120 110L114 106.5L114 132L120 136Z" fill="#e11d2a"/><path d="M120 110L126 106.5L126 132L120 136Z" fill="#c81824"/><g filter="url(#pToast)" transform="translate(168 26)"><rect x="0" y="0" width="82" height="38" rx="11" fill="#fff"/><circle cx="21" cy="19" r="11" fill="#e11d2a"/><path d="M16 19l3.4 3.4L27 15" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><g stroke="#e6ebf2" stroke-width="4.5" stroke-linecap="round"><path d="M40 15h32"/><path d="M40 26h20"/></g></g><path d="M176 74c24-4 22-30 2-40" stroke="#f2b5b5" stroke-width="2.5" stroke-dasharray="1 8" stroke-linecap="round" fill="none"/></svg>',
  phone: '<svg viewBox="0 0 240 230" fill="none" aria-hidden="true"><defs><radialGradient id="phGlow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#e11d2a" stop-opacity=".26"/><stop offset="1" stop-color="#e11d2a" stop-opacity="0"/></radialGradient></defs><path d="M40 120c-16-46 26-92 78-88 46 4 74 40 70 84-4 44-44 66-92 64-30-1-46-24-56-60z" fill="#fbe3e4"/><ellipse cx="120" cy="160" rx="92" ry="30" stroke="#f3cccc" stroke-width="2" fill="none"/><circle cx="30" cy="160" r="4" fill="#e11d2a"/><circle cx="212" cy="150" r="3.5" fill="#f0a3a3"/><rect x="78" y="30" width="84" height="168" rx="16" fill="#fff" stroke="#c9ced8" stroke-width="3"/><rect x="105" y="38" width="30" height="5" rx="2.5" fill="#dfe4ec"/><rect x="86" y="50" width="68" height="124" rx="7" fill="#f6f8fb"/><g stroke="#dde3ec" stroke-width="3" stroke-linecap="round"><path d="M86 84h68"/><path d="M86 120h68"/><path d="M86 150h68"/><path d="M104 50v124"/><path d="M134 50v124"/><path d="M86 66l44 26"/></g><rect x="92" y="56" width="12" height="18" rx="2" fill="#fbdada"/><rect x="138" y="126" width="12" height="20" rx="2" fill="#fbdada"/><ellipse cx="120" cy="120" rx="26" ry="15" fill="url(#phGlow)"/><path d="M120 84c-14 0-25 11-25 25 0 17 25 37 25 37s25-20 25-37c0-14-11-25-25-25z" fill="#e11d2a"/><circle cx="120" cy="109" r="9" fill="#fff"/><circle cx="120" cy="109" r="4.5" fill="#e11d2a"/><circle cx="120" cy="186" r="5.5" fill="#e7ebf1"/><g stroke="#e11d2a" stroke-width="4" stroke-linecap="round" fill="none"><path d="M60 66a30 30 0 0 1 0 40"/><path d="M48 54a48 48 0 0 1 0 64"/></g><g stroke="#f2a6a6" stroke-width="4" stroke-linecap="round" fill="none"><path d="M180 66a30 30 0 0 0 0 40"/><path d="M192 54a48 48 0 0 0 0 64"/></g></svg>',
  scooter: '<svg viewBox="0 0 290 210" fill="none" aria-hidden="true"><path d="M44 150c-16-44 26-92 84-92 40 0 44 34 92 30 42-3 58 44 32 70-30 30-186 34-208-8z" fill="#fbe3e4"/><path d="M78 140c46 6 60-34 100-28 28 4 40-16 46-30" stroke="#ef8f8f" stroke-width="3.5" stroke-dasharray="1 10" stroke-linecap="round" fill="none"/><path d="M238 40c-11 0-20 9-20 20 0 14 20 30 20 30s20-16 20-30c0-11-9-20-20-20z" fill="#e11d2a"/><circle cx="238" cy="60" r="7" fill="#fff"/><circle cx="238" cy="60" r="3.5" fill="#e11d2a"/><ellipse cx="238" cy="96" rx="12" ry="3.5" fill="#e6b9b9" opacity=".5"/><g stroke="#f2a6a6" stroke-width="3" stroke-linecap="round"><path d="M258 30l7-8"/><path d="M262 44l9-4"/></g><g fill="none" stroke="#d51a26" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="94" cy="154" r="17" fill="#fff"/><circle cx="192" cy="154" r="17" fill="#fff"/><rect x="58" y="86" width="38" height="38" rx="5" fill="#fff"/><path d="M96 124c7 9 4 20-4 30"/><path d="M94 154c16-9 36-11 50-11"/><path d="M140 143c22 0 32-10 34-32"/><path d="M100 116h46c9 0 13 5 15 13"/><path d="M174 111l18 43"/><path d="M174 111l-13-6"/><path d="M176 128l11 6"/></g><circle cx="94" cy="154" r="5" fill="#d51a26"/><circle cx="192" cy="154" r="5" fill="#d51a26"/><g stroke="#f2a6a6" stroke-width="4.5" stroke-linecap="round"><path d="M26 120h24"/><path d="M16 136h34"/><path d="M30 150h18"/></g></svg>',
};
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
};

function crmInitials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
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
const crmOrderSeq = ['En préparation', 'Confirmée', 'Récupérée', 'En tournée', 'En livraison', 'Arrivée', 'Livrée'];
function crmOrderStatusColor(status) {
  const map = { 'Livrée': 'green', 'Confirmée': 'amber', 'En préparation': 'amber', 'Récupérée': 'blue', 'En tournée': 'blue', 'En livraison': 'blue', 'Arrivée': 'blue', 'Brouillon': 'grey', 'Échec': 'red', 'Retour': 'amber', 'Retournée': 'grey', 'Annulée': 'grey' };
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
async function openOrderDrawer(orderId) {
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
    const o = await api(`/api/app/orders/${encodeURIComponent(orderId)}`);
    const zone = o.neighborhood || o.landmark || '—';
    const address = [o.neighborhood, o.landmark, o.delivery_address].filter(Boolean).join(' · ') || '—';
    const rank = crmOrderSeq.indexOf(o.status);
    const eventFor = (status) => (o.events || []).find((e) => e.to_status === status);
    const steps = [
      { label: 'Confirmée', at: eventFor('Confirmée') },
      { label: 'Préparation', at: eventFor('Récupérée') },
      { label: 'En livraison', at: eventFor('En livraison') },
      { label: 'Livrée', at: eventFor('Livrée') },
    ];
    const stepRank = [1, 2, 4, 6];
    const stepsHtml = steps.map((s, idx) => {
      const done = rank >= stepRank[idx];
      return `<div class="crm-step ${done ? 'done' : ''}"><span class="crm-step-dot">${done ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}</span><strong>${escapeHtml(s.label)}</strong><small>${s.at ? escapeHtml(formatDate(s.at.created_at)) : '—'}</small></div>`;
    }).join('');
    const history = (o.events || []).slice().reverse().map((e) => `<li><span class="crm-hist-dot ${e.to_status === 'Livrée' ? 'ok' : ''}"></span><div><strong>${escapeHtml(formatDate(e.created_at))}</strong><span>${escapeHtml(e.to_status || '')}${e.reason ? ` — ${escapeHtml(e.reason)}` : ''}</span><small>${escapeHtml(e.actor_name || 'Système')}</small></div></li>`).join('') || '<li class="crm-muted">Aucun événement.</li>';
    const evidence = (o.evidence || []).length ? (o.evidence || []).map((f) => `<span class="crm-file">${escapeHtml(f.evidence_type === 'signature' ? 'Signature' : 'Photo')}</span>`).join(' ') : '—';
    const phone = String(o.customer_phone || '').replace(/[^+\d]/g, '');
    const creator = (o.events && o.events.length) ? o.events[0].actor_name : null;
    const secIc = {
      client: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 17V5H2v12"/><path d="M14 9h4l4 4v4h-6"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
      track: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg>',
      note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    };
    wrap.querySelector('.crm-drawer').innerHTML = `
      <div class="crm-drawer-head">
        <div><div class="crm-drawer-title">CMD-${escapeHtml(o.id)} ${crmChip(o.status, crmOrderStatusColor(o.status))}</div>
          <small>Créée le ${escapeHtml(formatDate(o.created_at))}${creator ? ` par ${escapeHtml(creator)}` : ''}</small></div>
        <div class="crm-drawer-headact">
          ${o.trackingLink && o.trackingLink.path ? `<a class="crm-icobtn" href="${escapeHtml(o.trackingLink.path)}" target="_blank" rel="noopener" title="Ouvrir le suivi client"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></a>` : ''}
          <button class="crm-drawer-close crm-icobtn" type="button" aria-label="Fermer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div class="crm-drawer-body">
        <section><div class="crm-sec-head"><h4><span class="crm-sec-ic">${secIc.client}</span>Client</h4><a class="crm-seclink" href="/app/clients">Voir le client</a></div>
          <div class="crm-kv"><span>Nom</span><strong>${escapeHtml(o.customer_name || '—')}</strong></div>
          <div class="crm-kv"><span>Téléphone</span><strong>${phone ? `<a href="tel:${escapeHtml(phone)}">${escapeHtml(o.customer_phone)}</a>` : '—'}</strong></div>
          <div class="crm-kv"><span>Adresse</span><strong>${escapeHtml(address)}</strong></div>
        </section>
        <section><h4><span class="crm-sec-ic">${secIc.truck}</span>Livraison</h4>
          <div class="crm-kv"><span>Zone</span><strong>${escapeHtml(zone)}</strong></div>
          <div class="crm-kv"><span>Livreur</span><strong>${o.driver_name ? crmAvatar(o.driver_name, { photoUrl: o.driver_photo, online: o.driver_online }) : '—'}</strong></div>
          <div class="crm-kv"><span>Créneau</span><strong>${escapeHtml(o.requested_time || '—')}</strong></div>
        </section>
        <section><h4><span class="crm-sec-ic">${secIc.track}</span>Suivi de la commande</h4><div class="crm-steps">${stepsHtml}</div></section>
        <section><h4><span class="crm-sec-ic">${secIc.doc}</span>Détails de la commande</h4>
          <div class="crm-kv"><span>Instructions</span><strong>${escapeHtml(o.delivery_address || '—')}</strong></div>
          <div class="crm-kv"><span>Pièces jointes</span><strong>${evidence}</strong></div>
          ${o.expected_amount_minor != null ? `<div class="crm-kv"><span>Paiement</span><strong>${escapeHtml((Number(o.expected_amount_minor) / 100).toLocaleString('fr-FR'))} ${escapeHtml(o.payment_currency || '')} · ${escapeHtml(o.payment_status || '')}</strong></div>` : ''}
        </section>
        <section><div class="crm-sec-head"><h4><span class="crm-sec-ic">${secIc.note}</span>Notes et historique</h4><a class="crm-seclink" href="/app/commandes/${escapeHtml(o.id)}">Voir tout</a></div><ul class="crm-hist">${history}</ul></section>
      </div>
      <div class="crm-drawer-foot">
        <a class="button secondary" href="/app/commandes/${escapeHtml(o.id)}">Plus d'actions</a>
        <a class="button primary" href="/app/commandes/${escapeHtml(o.id)}">Modifier la commande</a>
      </div>`;
    wrap.querySelector('.crm-drawer-close').addEventListener('click', close);
  } catch (error) {
    wrap.querySelector('.crm-drawer').innerHTML = `<div class="crm-drawer-head"><div class="crm-drawer-title">Erreur</div><button class="crm-drawer-close" type="button">✕</button></div><div class="crm-drawer-body"><div class="notice error">${escapeHtml(error.message)}</div></div>`;
    wrap.querySelector('.crm-drawer-close').addEventListener('click', close);
  }
}

// Panneau détail coulissant d'une demande client (aperçu rapide, comme la commande).
async function openRequestDrawer(requestId) {
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
    const phone = String(r.customer_phone || '').replace(/[^+\d]/g, '');
    const shared = r.location_lat != null && r.location_lng != null;
    const validated = r.status === 'Confirmée' || r.validated_at != null;
    const secIc = {
      client: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
      pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
      doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg>',
      truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 17V5H2v12"/><path d="M14 9h4l4 4v4h-6"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
    };
    const footer = r.order_id
      ? `<a class="button secondary" href="/app/demandes/${escapeHtml(r.id)}">Fiche demande</a><a class="button primary" href="/app/commandes/${escapeHtml(r.order_id)}">Voir la commande</a>`
      : `<a class="button secondary" href="/app/demandes/${escapeHtml(r.id)}">Autres actions</a><a class="button primary" href="/app/demandes/${escapeHtml(r.id)}">Valider et affecter</a>`;
    wrap.querySelector('.crm-drawer').innerHTML = `
      <div class="crm-drawer-head">
        <div><div class="crm-drawer-title">DEM-${escapeHtml(r.id)} ${crmChip(r.status)}</div>
          <small>Créée le ${escapeHtml(formatDate(r.created_at))}${r.submitted_at ? ' · via formulaire client' : ''}</small></div>
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
          <div class="crm-kv"><span>Position GPS</span><strong>${shared ? crmChip('Partagée', 'green') : crmChip('Non partagée', 'red')}</strong></div>
          <div class="crm-kv"><span>Précision</span><strong>${r.location_accuracy != null ? `± ${escapeHtml(Math.round(r.location_accuracy))} m` : '—'}</strong></div>
        </section>
        <section><h4><span class="crm-sec-ic">${secIc.doc}</span>Traitement</h4>
          <div class="crm-kv"><span>Source</span><strong>${r.submitted_at ? crmChip('Formulaire client', 'blue') : crmChip('Saisie interne', 'purple')}</strong></div>
          <div class="crm-kv"><span>Validation</span><strong>${validated ? crmChip('Validée', 'green') : crmChip('À valider', 'amber')}</strong></div>
          <div class="crm-kv"><span>Instructions</span><strong>${escapeHtml(r.notes || 'Aucune')}</strong></div>
        </section>
        ${r.order_id ? `<section><h4><span class="crm-sec-ic">${secIc.truck}</span>Commande créée</h4>
          <div class="crm-kv"><span>Commande</span><strong>CMD-${escapeHtml(r.order_id)}</strong></div>
          <div class="crm-kv"><span>Livreur</span><strong>${r.driver_name ? crmAvatar(r.driver_name) : '—'}</strong></div>
          <div class="crm-kv"><span>Statut</span><strong>${crmChip(r.order_status, crmOrderStatusColor(r.order_status))}</strong></div>
        </section>` : ''}
      </div>
      <div class="crm-drawer-foot">${footer}</div>`;
    wrap.querySelector('.crm-drawer-close').addEventListener('click', close);
  } catch (error) {
    wrap.querySelector('.crm-drawer').innerHTML = `<div class="crm-drawer-head"><div class="crm-drawer-title">Erreur</div><button class="crm-drawer-close" type="button">✕</button></div><div class="crm-drawer-body"><div class="notice error">${escapeHtml(error.message)}</div></div>`;
    wrap.querySelector('.crm-drawer-close').addEventListener('click', close);
  }
}

async function renderOperations() {
  setHeader('Opérations', 'Démarrez une livraison et suivez l’activité');
  const params = new URLSearchParams(location.search);
  const vue = params.get('vue');
  const workspaceSegments = ['commandes', 'demandes', 'tournees', 'incidents'];
  if (vue === 'creer') return renderOperationsCreate();
  if (workspaceSegments.includes(vue)) return renderOperationsWorkspace(vue);
  return renderOperationsHome();
}

// Niveau 1 : deux entrées d'action (façon maquette).
function renderOperationsHome() {
  page.innerHTML = `
    <div class="ops-accent"></div>
    <div class="page-header"><div><h1>Opérations</h1><p class="subtitle">Accédez rapidement aux outils essentiels.</p></div></div>
    <div class="ops-home">
      <a class="ops-home-card tint-red" href="/app/operations?vue=creer">
        <span class="ops-home-ic">${opsIco.form}</span>
        <h3>Créer un formulaire</h3>
        <p>Concevez et configurez la capture d’un nouveau client en quelques clics.</p>
        <span class="ops-home-arrow">${opsIco.arrow}</span>
        <span class="ops-home-art">${opsArt.form}</span>
      </a>
      <a class="ops-home-card tint-slate" href="/app/operations?vue=commandes">
        <span class="ops-home-ic">${opsIco.box}</span>
        <h3>Commandes</h3>
        <p>Gérez et suivez vos commandes, demandes, tournées et incidents en toute simplicité.</p>
        <span class="ops-home-arrow">${opsIco.arrow}</span>
        <span class="ops-home-art">${opsArt.package}</span>
      </a>
    </div>`;
}

// Niveau 2 : « Créer un formulaire » — deux façons de capter un client.
function renderOperationsCreate() {
  page.innerHTML = `
    <div class="ops-breadcrumb"><a href="/app/operations">Opérations</a><span class="sep">›</span><span>Créer un formulaire</span></div>
    <div class="page-header"><div><h1>Créer un formulaire</h1><p class="subtitle">Choisissez comment récupérer les informations du client.</p></div></div>
    <div class="ops-create">
      <div class="ops-create-card">
        <span class="ops-create-ic">${opsIco.pin}</span>
        <h3>Le client partage sa position</h3>
        <p>Envoyez un lien au client. Il remplit ses infos et partage sa position GPS exacte directement depuis son téléphone.</p>
        <button type="button" class="button primary" id="opsGenLink">Générer ce lien ${opsIco.arrow}</button>
        <span class="ops-create-art"><img src="/img/ops-share-location.webp" alt="" loading="lazy"/></span>
      </div>
      <a class="ops-create-card ops-create-link" href="/app/nouvelle-commande">
        <span class="ops-create-ic">${opsIco.ride}</span>
        <h3>Vous remplissez, il suit le livreur</h3>
        <p>Vous saisissez les infos du client vous-même. Il reçoit un lien pour suivre la position du livreur assigné en temps réel, sans révéler sa propre position.</p>
        <span class="button primary">Créer et assigner ${opsIco.arrow}</span>
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
      const fullUrl = new URL(result.path, location.origin).href;
      const waText = encodeURIComponent(`Bonjour, pour organiser votre livraison, merci de remplir vos informations ici : ${fullUrl}`);
      panel.innerHTML = `<div class="card ops-linkpanel">
        <strong class="ops-linkpanel-title">Lien prêt à envoyer</strong>
        <p class="ops-modal-note" style="margin:6px 0 14px">Le client remplit ses infos et épingle sa position. Valable 7 jours, une seule fois.</p>
        <div class="ops-linkout"><input type="text" readonly value="${escapeHtml(fullUrl)}" id="capLink" aria-label="Lien du formulaire"/><button type="button" class="button secondary" id="capCopy">Copier</button></div>
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

  const cfg = {
    commandes: {
      title: 'Commandes', newLabel: 'Nouvelle commande', newHref: '/app/nouvelle-commande',
      placeholder: 'Rechercher une commande, un client…', countKey: 'orders',
      endpoint: () => '/api/app/orders', drawerFn: openOrderDrawer, href: (r) => `/app/commandes/${r.id}`,
      statusValues: ['Confirmée', 'En préparation', 'Récupérée', 'En tournée', 'En livraison', 'Arrivée', 'Livrée', 'Échec', 'Retour', 'Retournée', 'Annulée'],
      groupCols: [['status', 'Statut'], ['zone', 'Zone'], ['driver', 'Livreur']],
      groupVal: (r, k) => k === 'status' ? r.status : k === 'zone' ? (r.neighborhood || r.landmark || '—') : (r.driver_name || '—'),
      filterTest: (r, v) => r.status === v,
      text: (r) => `${r.id} ${r.customer_name || ''} ${r.customer_phone || ''} ${r.neighborhood || ''} ${r.driver_name || ''} ${r.status || ''}`.toLowerCase(),
      columns: [
        { key: 'id', label: 'N° Commande', cell: (r) => `<span class="crm-code">CMD-${escapeHtml(r.id)}</span>`, sortVal: (r) => Number(r.id) },
        { key: 'client', label: 'Client', cell: (r) => `<div class="crm-strong">${escapeHtml(r.customer_name || '—')}</div>${r.customer_phone ? `<div class="crm-sub">${escapeHtml(r.customer_phone)}</div>` : ''}`, sortVal: (r) => (r.customer_name || '').toLowerCase() },
        { key: 'zone', label: 'Zone', cell: (r) => escapeHtml(r.neighborhood || r.landmark || '—'), sortVal: (r) => (r.neighborhood || '').toLowerCase() },
        { key: 'driver', label: 'Livreur', cell: (r) => crmAvatar(r.driver_name, { photoUrl: r.driver_photo, online: r.driver_online }), sortVal: (r) => (r.driver_name || '').toLowerCase() },
        { key: 'status', label: 'Statut', cell: (r) => crmChip(r.status, crmOrderStatusColor(r.status)), sortVal: (r) => r.status },
        { key: 'date', label: 'Date', cell: (r) => escapeHtml(formatDate(r.created_at)), sortVal: (r) => +new Date(r.created_at) },
        { key: 'suivi', label: 'Suivi', cell: (r) => { const p = crmOrderProgress(r.status); return crmProgressBar(p.pct, p.tone); } },
      ],
    },
    incidents: {
      title: 'Incidents', newLabel: 'Nouvel incident', newHref: '/app/operations?vue=incidents', placeholder: 'Rechercher un incident, une commande…', countKey: 'open_incidents',
      endpoint: () => `/api/app/incidents?scope=${encodeURIComponent(scopeState.incidents)}`, href: (r) => `/app/incidents/${r.id}`,
      statusValues: ['open', 'resolved'], statusLabelMap: { open: 'Ouvert', resolved: 'Résolu' },
      groupCols: [['status', 'Statut'], ['severity', 'Priorité'], ['assignee', 'Assigné à']],
      groupVal: (r, k) => k === 'status' ? (r.status === 'resolved' ? 'Résolu' : 'Ouvert') : k === 'severity' ? (incidentSeverityLabels[r.severity] || r.severity) : (r.assigned_to || r.driver_name || 'Non attribué'),
      filterTest: (r, v) => r.status === v,
      text: (r) => `${r.id} ${incidentCategoryLabels[r.category] || r.category} ${r.order_id} ${r.customer_name || ''} ${r.driver_name || ''} ${r.status || ''}`.toLowerCase(),
      columns: [
        { key: 'id', label: 'N° Incident', cell: (r) => `<span class="crm-code">INC-${escapeHtml(r.id)}</span>`, sortVal: (r) => Number(r.id) },
        { key: 'type', label: 'Type', cell: (r) => escapeHtml(incidentCategoryLabels[r.category] || r.category), sortVal: (r) => r.category },
        { key: 'order', label: 'Commande liée', cell: (r) => `<span class="crm-code">CMD-${escapeHtml(r.order_id)}</span>`, sortVal: (r) => Number(r.order_id) },
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
      endpoint: () => '/api/app/runs', href: (r) => `/app/tournees/${r.id}`,
      statusValues: ['draft', 'planned', 'active', 'completed', 'cancelled'],
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
      endpoint: () => `/api/app/requests?scope=${encodeURIComponent(scopeState.demandes)}`, drawerFn: openRequestDrawer, href: (r) => `/app/demandes/${r.id}`,
      statusValues: [], filterTest: (r, v) => r.status === v,
      groupCols: [['status', 'Statut'], ['zone', 'Zone'], ['position', 'Position client']],
      groupVal: (r, k) => k === 'status' ? (r.status || '—') : k === 'zone' ? (r.neighborhood || '—') : (reqShared(r) ? 'Partagée' : 'Non partagée'),
      text: (r) => `${r.id} ${r.customer_name || ''} ${r.customer_phone || ''} ${r.neighborhood || ''} ${r.status || ''}`.toLowerCase(),
      columns: [
        { key: 'id', label: 'N° Demande', cell: (r) => `<span class="crm-code">DEM-${escapeHtml(r.id)}</span>`, sortVal: (r) => Number(r.id) },
        { key: 'client', label: 'Client', cell: (r) => `<div class="crm-strong">${escapeHtml(r.customer_name || 'En attente du client')}</div>${r.customer_phone ? `<div class="crm-sub">${escapeHtml(r.customer_phone)}</div>` : ''}`, sortVal: (r) => (r.customer_name || '').toLowerCase() },
        { key: 'zone', label: 'Zone', cell: (r) => `${escapeHtml(r.neighborhood || '—')}${r.landmark ? `<div class="crm-sub">${escapeHtml(r.landmark)}</div>` : ''}`, sortVal: (r) => (r.neighborhood || '').toLowerCase() },
        { key: 'source', label: 'Source', cell: (r) => r.submitted_at ? crmChip('Formulaire client', 'blue') : crmChip('Saisie interne', 'purple'), sortVal: (r) => r.submitted_at ? 0 : 1 },
        { key: 'position', label: 'Position client', cell: (r) => reqShared(r) ? crmChip('Partagée', 'green') : crmChip('Non partagée', 'red'), sortVal: (r) => reqShared(r) ? 0 : 1 },
        { key: 'validation', label: 'Validation', cell: (r) => reqValidated(r) ? crmChip('Validée', 'green') : crmChip('À valider', 'amber'), sortVal: (r) => reqValidated(r) ? 0 : 1 },
        { key: 'acces', label: 'Accès client', cell: (r) => reqShared(r) ? crmChip('Projection + suivi', 'blue') : crmChip('Tracking livreur', 'indigo'), sortVal: (r) => reqShared(r) ? 0 : 1 },
        { key: 'status', label: 'Statut', cell: (r) => crmChip(r.status), sortVal: (r) => r.status },
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
        ${co.newHref ? `<a class="crm-new" href="${escapeHtml(co.newHref)}">${fleetIcons.plus} ${escapeHtml(co.newLabel)}</a>` : ''}
      </div>
      <div class="crm-chips" id="crmChips"></div>
      <div class="crm-card"><div class="crm-scroll"><table class="crm-table"><thead id="crmHead"></thead><tbody id="crmBody"></tbody></table></div></div>
      <div class="crm-foot" id="crmFoot"></div>`;
    renderTabs();
    document.getElementById('crmSearch').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); pageN = 1; renderAll(); });
    document.getElementById('crmFilter').addEventListener('click', (e) => { e.stopPropagation(); openFilterMenu(e.currentTarget); });
    document.getElementById('crmGroup').addEventListener('click', (e) => { e.stopPropagation(); openGroupMenu(e.currentTarget); });
    document.getElementById('crmSort').addEventListener('click', (e) => { e.stopPropagation(); openSortMenu(e.currentTarget); });
  }

  function renderTabs() {
    const el = document.getElementById('crmTabs');
    el.innerHTML = valid.map((k) => {
      const n = counts[cfg[k].countKey];
      return `<button class="crm-tab ${k === segment ? 'active' : ''}" data-seg="${k}">${escapeHtml(cfg[k].title)}${n != null ? `<span class="n">${escapeHtml(n)}</span>` : ''}</button>`;
    }).join('');
    el.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => switchSeg(b.dataset.seg)));
  }

  function switchSeg(k) {
    if (k === segment) return;
    segment = k; query = ''; sort = null; group = null; filter = null; pageN = 1;
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
    head.innerHTML = `<tr><th class="crm-cbcol"><span class="crm-cb"></span></th>${cells}<th class="crm-actcol"></th></tr>`;
    head.querySelectorAll('[data-sort]').forEach((th) => { if (th.dataset.sort) th.addEventListener('click', () => { const k = th.dataset.sort; sort = (sort && sort.key === k) ? { key: k, dir: -sort.dir } : { key: k, dir: 1 }; renderAll(); }); });
  }

  function rowHtml(r, co) {
    const cells = co.columns.map((col) => `<td>${col.cell(r)}</td>`).join('');
    const eye = co.drawerFn ? `<button data-act="view" title="Aperçu">${crmIcons.eye}</button>` : `<button data-act="open" title="Ouvrir">${crmIcons.eye}</button>`;
    return `<tr data-id="${escapeHtml(r.id)}"><td class="crm-cbcol"><span class="crm-cb"></span></td>${cells}<td class="crm-actcol"><span class="crm-rowact">${eye}<button data-act="open" title="Ouvrir la fiche">${crmIcons.edit}</button></span></td></tr>`;
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
        if (act && act.dataset.act === 'open') { location.href = co.href({ id }); return; }
        if (e.target.closest('.crm-cb')) { e.target.closest('.crm-cb').classList.toggle('on'); return; }
        if (co.drawerFn) co.drawerFn(id); else location.href = co.href({ id });
      });
    });
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

function customerListMarkup(customers, pagination, hasFilters) {
  if (!customers.length) {
    return `<div class="empty crm-empty"><strong>${hasFilters ? 'Aucun client ne correspond à cette recherche.' : 'Aucun client enregistré pour le moment.'}</strong>
      <p>${hasFilters ? 'Modifiez les critères ou affichez tous les clients.' : 'Les fiches apparaîtront ici à partir des commandes.'}</p>
      ${hasFilters ? '<button class="secondary" id="clearCustomerFilters" type="button">Effacer les filtres</button>' : '<a class="button primary" href="/app/nouvelle-commande">Créer une commande</a>'}
    </div>`;
  }
  const state = paginationState(pagination, customers.length);
  const totalLabel = state.total == null ? `${customers.length} client${customers.length > 1 ? 's' : ''} affiché${customers.length > 1 ? 's' : ''}` : `${formatInteger(state.total)} client${state.total > 1 ? 's' : ''}`;
  return `<div class="crm-list-meta"><p>${escapeHtml(totalLabel)}</p><p>Page ${escapeHtml(state.currentPage)} sur ${escapeHtml(state.totalPages)}</p></div>
    <div class="customer-list">${customers.map((customer) => `<article class="customer-card">
      <div class="customer-card-heading"><div><h2><a href="/app/clients/${encodeURIComponent(customer.id)}">${escapeHtml(customer.display_name || 'Client sans nom')}</a></h2><p>${escapeHtml(customer.primary_phone || 'Téléphone non renseigné')}</p></div>${customerStatusBadge(customer.status)}</div>
      <dl class="customer-summary">
        <div><dt>Commandes</dt><dd>${formatInteger(customer.order_count)}</dd></div>
        <div><dt>Lieux connus</dt><dd>${formatInteger(customer.location_count)}</dd></div>
        <div><dt>Incidents ouverts</dt><dd>${formatInteger(customer.open_incident_count)}</dd></div>
        <div><dt>Dernière commande</dt><dd>${escapeHtml(formatDate(customer.last_order_at))}</dd></div>
      </dl>
      <a class="customer-open" href="/app/clients/${encodeURIComponent(customer.id)}" aria-label="Ouvrir la fiche de ${escapeHtml(customer.display_name || 'ce client')}">Ouvrir la fiche <span aria-hidden="true">→</span></a>
    </article>`).join('')}</div>
    <nav class="pagination" aria-label="Pages de clients">
      <button class="secondary" id="customerPrevious" type="button" ${state.hasPrevious ? '' : 'disabled'}>Page précédente</button>
      <span>Page ${escapeHtml(state.currentPage)} sur ${escapeHtml(state.totalPages)}</span>
      <button class="secondary" id="customerNext" type="button" ${state.hasNext ? '' : 'disabled'}>Page suivante</button>
    </nav>`;
}

async function renderCustomers() {
  setHeader('Clients', 'Historique, contacts et lieux de livraison');
  const initial = new URLSearchParams(location.search);
  const initialStatus = ['active', 'do_not_contact', 'archived'].includes(initial.get('status')) ? initial.get('status') : '';
  page.innerHTML = `<div class="page-header"><div><h1>Clients</h1><p class="subtitle">Retrouvez les informations utiles issues des commandes, sans afficher les coordonnées GPS.</p></div></div>
    <section class="card crm-filter-card"><form id="customerSearch" class="crm-search" role="search">
      <div class="field"><label for="customerQuery">Nom ou téléphone</label><input id="customerQuery" name="q" type="search" value="${escapeHtml(initial.get('q') || '')}" maxlength="120" autocomplete="off" placeholder="Ex. Afi ou 97 00 00 00" /></div>
      <div class="field"><label for="customerStatus">État du client</label><select id="customerStatus" name="status"><option value="">Tous les états</option><option value="active" ${initialStatus === 'active' ? 'selected' : ''}>Actif</option><option value="do_not_contact" ${initialStatus === 'do_not_contact' ? 'selected' : ''}>Ne pas contacter</option><option value="archived" ${initialStatus === 'archived' ? 'selected' : ''}>Archivé</option></select></div>
      <div class="actions crm-search-actions"><button class="primary" type="submit">Rechercher</button><button class="secondary" id="resetCustomerSearch" type="button">Réinitialiser</button></div>
    </form></section>
    <section class="card crm-results" aria-labelledby="customerResultsTitle"><h2 id="customerResultsTitle">Résultats</h2><div id="customerResults" aria-live="polite"></div></section>`;

  const form = document.getElementById('customerSearch');
  const target = document.getElementById('customerResults');
  let currentPage = Math.max(1, Number(initial.get('page')) || 1);
  let loading = false;

  const clearFilters = () => {
    form.reset();
    document.getElementById('customerQuery').value = '';
    document.getElementById('customerStatus').value = '';
    currentPage = 1;
    loadCustomers();
  };
  const loadCustomers = async () => {
    if (loading) return;
    loading = true;
    target.setAttribute('aria-busy', 'true');
    target.innerHTML = loadingState('Chargement des clients…');
    const values = new FormData(form);
    const parameters = new URLSearchParams({ page: String(currentPage), limit: '20' });
    const query = String(values.get('q') || '').trim();
    const status = String(values.get('status') || '');
    if (query) parameters.set('q', query);
    if (status) parameters.set('status', status);
    try {
      const result = await api(`/api/app/crm/customers?${parameters}`);
      const customers = Array.isArray(result.customers) ? result.customers : [];
      target.innerHTML = customerListMarkup(customers, result.pagination || {}, Boolean(query || status));
      document.getElementById('clearCustomerFilters')?.addEventListener('click', clearFilters);
      document.getElementById('customerPrevious')?.addEventListener('click', () => { currentPage -= 1; loadCustomers(); });
      document.getElementById('customerNext')?.addEventListener('click', () => { currentPage += 1; loadCustomers(); });
    } catch (error) {
      target.innerHTML = `<div class="notice error" role="alert"><strong>Impossible de charger les clients.</strong><p>${escapeHtml(error.message)}</p><button class="secondary" id="retryCustomers" type="button">Réessayer</button></div>`;
      document.getElementById('retryCustomers')?.addEventListener('click', loadCustomers);
    } finally {
      target.removeAttribute('aria-busy');
      loading = false;
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); currentPage = 1; loadCustomers(); });
  document.getElementById('resetCustomerSearch').addEventListener('click', clearFilters);
  await loadCustomers();
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
  page.innerHTML = `<div class="page-header"><div><a href="/app/clients">← Retour aux clients</a><h1 style="margin-top:12px">Fiche client</h1></div></div><section class="card">${loadingState('Chargement de la fiche client…')}</section>`;
  try {
    const result = await api(`/api/app/crm/customers/${encodeURIComponent(id)}`);
    const customer = result.customer || {};
    const contacts = Array.isArray(result.contacts) ? result.contacts : [];
    const locations = Array.isArray(result.locations) ? result.locations : [];
    const orders = Array.isArray(result.orders) ? result.orders : [];
    const interactions = Array.isArray(result.interactions) ? result.interactions : [];
    setHeader(customer.display_name || 'Fiche client', 'Contacts, lieux et historique opérationnel');
    page.innerHTML = `<div class="page-header"><div><a href="/app/clients">← Retour aux clients</a><h1 style="margin-top:12px">${escapeHtml(customer.display_name || 'Client sans nom')}</h1><p class="subtitle">Référence ${escapeHtml(customer.customer_code || customer.id || id)}</p></div>${customerStatusBadge(customer.status)}</div>
      <section class="card"><h2>Informations principales</h2><div class="detail-grid"><div class="detail"><span>Nom</span><strong>${escapeHtml(customer.display_name || '—')}</strong></div><div class="detail"><span>Langue préférée</span><strong>${escapeHtml(customer.preferred_language || 'Non renseignée')}</strong></div><div class="detail"><span>Création de la fiche</span><strong>${escapeHtml(formatDate(customer.created_at))}</strong></div></div>${customer.service_notes ? `<div class="notice"><strong>Note de service</strong><p>${escapeHtml(customer.service_notes)}</p></div>` : ''}</section>
      <div class="crm-detail-columns">
        <section class="card"><h2>Contacts (${formatInteger(contacts.length)})</h2>${contacts.length ? `<ul class="crm-contact-list">${contacts.map(contactMarkup).join('')}</ul>` : '<div class="empty compact-empty">Aucun contact enregistré.</div>'}</section>
        <section class="card"><h2>Lieux de livraison (${formatInteger(locations.length)})</h2><p class="section-hint">Les coordonnées GPS restent protégées et ne sont pas affichées ici.</p>${locations.length ? `<div class="crm-subcard-list">${locations.map(locationMarkup).join('')}</div>` : '<div class="empty compact-empty">Aucun lieu enregistré.</div>'}</section>
      </div>
      <section class="card crm-section"><h2>Commandes (${formatInteger(orders.length)})</h2>${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Commande</th><th>Créée le</th><th>Destination</th><th>Livreur</th><th>État</th></tr></thead><tbody>${orders.map((order) => `<tr><td><a href="/app/commandes/${encodeURIComponent(order.id)}"><strong>N° ${escapeHtml(order.id)}</strong></a></td><td>${escapeHtml(formatDate(order.created_at))}</td><td>${escapeHtml(order.neighborhood || order.landmark || '—')}</td><td>${escapeHtml(order.driver_name || '—')}</td><td>${badge(order.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty compact-empty">Aucune commande liée.</div>'}</section>
      <section class="card crm-section"><h2>Interactions récentes (${formatInteger(interactions.length)})</h2>${interactions.length ? `<ol class="timeline">${interactions.map((interaction) => `<li><strong>${escapeHtml(interactionPurposeLabels[interaction.purpose] || interaction.purpose || 'Échange')}</strong><span>${escapeHtml(interactionChannelLabels[interaction.channel] || interaction.channel || 'Canal non précisé')}${interaction.outcome ? ` · ${escapeHtml(interactionOutcomeLabels[interaction.outcome] || interaction.outcome)}` : ''}</span><small>${escapeHtml(formatDate(interaction.occurred_at))}</small>${interaction.summary ? `<p>${escapeHtml(interaction.summary)}</p>` : ''}</li>`).join('')}</ol>` : '<div class="empty compact-empty">Aucune interaction enregistrée.</div>'}</section>`;
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

async function downloadOperationsExport(monthValue, button) {
  const status = document.getElementById('exportStatus');
  let period;
  try {
    period = monthPeriod(monthValue);
  } catch (error) {
    if (status) { status.textContent = error.message; status.classList.add('error-text'); }
    return;
  }
  // The export contract uses an exclusive upper bound: pass the first day of the
  // next month so the whole selected month is covered.
  const [year, month] = monthValue.split('-').map(Number);
  const exclusiveTo = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Export en cours…';
  if (status) { status.textContent = ''; status.classList.remove('error-text'); }
  try {
    const response = await fetch('/api/app/crm/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset: 'operations',
        purpose: 'Export mensuel des opérations',
        period: { from: period.from, to: exclusiveTo },
      }),
    });
    if (response.status === 401) { location.href = '/app/login'; return; }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Export impossible pour le moment.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `operations-${monthValue}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    if (status) { status.textContent = 'Export téléchargé.'; status.classList.remove('error-text'); }
  } catch (error) {
    if (status) { status.textContent = error.message; status.classList.add('error-text'); }
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function renderReports() {
  setHeader('Rapports', 'Indicateurs mensuels vérifiables');
  const requestedMonth = new URLSearchParams(location.search).get('month');
  const selectedMonth = /^\d{4}-\d{2}$/.test(requestedMonth || '') ? requestedMonth : currentPortoNovoMonth();
  page.innerHTML = `<div class="page-header"><div><h1>Rapports mensuels</h1><p class="subtitle">Analysez les opérations avec des indicateurs transparents et séparés par devise.</p></div></div>
    <section class="card report-filter-card"><form id="reportFilter" class="report-filter"><div class="field"><label for="reportMonth">Mois à analyser</label><input id="reportMonth" name="month" type="month" value="${escapeHtml(selectedMonth)}" required /></div><button class="primary" type="submit">Afficher le rapport</button></form></section>
    <div id="reportResults" aria-live="polite"></div>`;
  const form = document.getElementById('reportFilter');
  const target = document.getElementById('reportResults');
  let loading = false;
  const loadReport = async () => {
    if (loading) return;
    loading = true;
    target.setAttribute('aria-busy', 'true');
    target.innerHTML = `<section class="card">${loadingState('Calcul du rapport…')}</section>`;
    try {
      const period = monthPeriod(document.getElementById('reportMonth').value);
      const metrics = await api(`/api/app/crm/metrics?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`);
      target.innerHTML = reportsMarkup(metrics);
      const exportBtn = document.getElementById('exportReportBtn');
      exportBtn?.addEventListener('click', () => downloadOperationsExport(document.getElementById('reportMonth').value, exportBtn));
    } catch (error) {
      target.innerHTML = `<div class="notice error" role="alert"><strong>Impossible de calculer ce rapport.</strong><p>${escapeHtml(error.message)}</p><button class="secondary" id="retryReport" type="button">Réessayer</button></div>`;
      document.getElementById('retryReport')?.addEventListener('click', loadReport);
    } finally {
      target.removeAttribute('aria-busy');
      loading = false;
    }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); loadReport(); });
  await loadReport();
}

async function start() {
  try {
    context = await api('/api/app/context');
    document.getElementById('companyName').textContent = context.company.name;
    document.getElementById('topCompany').textContent = context.company.name;
    document.getElementById('topRole').textContent = roleLabels[context.user.role] || context.user.role;
    document.getElementById('userName').textContent = `${context.user.name} · ${context.user.email}`;
    document.getElementById('userAvatar').textContent = String(context.user.name || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase() || '?';
    if (!['owner', 'manager'].includes(context.user.role)) {
      document.querySelector('[data-route="/app/equipe"]')?.remove();
    }
    activateNavigation();
    const path = location.pathname;
    const detail = path.match(/^\/app\/demandes\/(\d+)$/);
    if (detail) return await renderRequestDetail(detail[1]);
    const orderDetail = path.match(/^\/app\/commandes\/(\d+)$/);
    if (orderDetail) return await renderOrderDetail(orderDetail[1]);
    const incidentDetail = path.match(/^\/app\/incidents\/(\d+)$/);
    if (incidentDetail) return await renderIncidentDetail(incidentDetail[1]);
    const runDetail = path.match(/^\/app\/tournees\/(\d+)$/);
    if (runDetail) return await renderRunDetail(runDetail[1]);
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
  } catch (error) {
    renderError(error);
  }
}

document.getElementById('menuButton').addEventListener('click', () => sidebar.classList.toggle('open'));
document.addEventListener('click', (event) => {
  if (window.innerWidth <= 900 && sidebar.classList.contains('open') && !sidebar.contains(event.target) && event.target.id !== 'menuButton') {
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

// Menu utilisateur (topbar).
const userMenuBtn = document.getElementById('userMenuBtn');
const userMenu = document.getElementById('userMenu');
userMenuBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  const open = userMenu.hasAttribute('hidden');
  if (open) userMenu.removeAttribute('hidden'); else userMenu.setAttribute('hidden', '');
  userMenuBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (event) => {
  if (userMenu && !userMenu.hasAttribute('hidden') && !event.target.closest('.user-menu')) {
    userMenu.setAttribute('hidden', '');
    userMenuBtn.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { userMenu?.setAttribute('hidden', ''); userMenuBtn?.setAttribute('aria-expanded', 'false'); } });

start();
