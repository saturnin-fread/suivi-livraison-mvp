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

function activateNavigation() {
  const pathname = location.pathname;
  document.querySelectorAll('.nav a').forEach((link) => {
    const route = link.dataset.route;
    link.classList.toggle('active', route === '/app' ? pathname === '/app' : pathname.startsWith(route));
  });
}

function renderError(error) {
  page.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
}

async function renderDashboard() {
  setHeader('Tableau de bord', 'Vue d’ensemble des opérations');
  const summary = await api('/api/app/summary');
  page.innerHTML = `
    <div class="page-header"><div><h1>Bonjour ${escapeHtml(context.user.name)}</h1><p class="subtitle">Voici les éléments qui demandent votre attention.</p></div><a class="button primary" href="/app/demandes">Gérer les demandes</a></div>
    <section class="grid stats">
      <article class="stat"><span>Demandes actives</span><strong>${escapeHtml(summary.active_requests)}</strong></article>
      <article class="stat"><span>À vérifier</span><strong>${escapeHtml(summary.to_review)}</strong></article>
      <article class="stat"><span>Commandes créées</span><strong>${escapeHtml(summary.orders)}</strong></article>
      <article class="stat"><span>Livreurs enregistrés</span><strong>${escapeHtml(summary.drivers)}</strong></article>
      <article class="stat"><span>Tournées ouvertes</span><strong>${escapeHtml(summary.open_runs)}</strong></article>
      <article class="stat"><span>Incidents ouverts</span><strong>${escapeHtml(summary.open_incidents)}</strong></article>
      <article class="stat"><span>Gels à réviser</span><strong>${escapeHtml(summary.overdue_holds)}</strong></article>
    </section>
    <section class="card" style="margin-top:18px"><h2>Accès rapides</h2><div class="actions"><a class="button primary" href="/app/demandes">Nouvelle demande client</a><a class="button secondary" href="/app/nouvelle-commande">Commande directe</a><a class="button secondary" href="/app/tournees">Préparer une tournée</a><a class="button secondary" href="/app/incidents">Dossiers d’incident</a><a class="button secondary" href="/app/carte">Carte d’exploitation</a></div></section>`;
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
    <div class="page-header"><div><a href="/app/demandes">← Retour aux demandes</a><h1 style="margin-top:12px">${escapeHtml(request.customer_name || 'Demande en attente')}</h1><p class="subtitle">Demande n° ${escapeHtml(request.id)} · ${escapeHtml(formatDate(request.created_at))}</p></div>${badge(request.status)}</div>
    <section class="card"><h2>Informations du client</h2><div class="detail-grid">
      <div class="detail"><span>Téléphone</span><strong>${escapeHtml(request.customer_phone || '—')}</strong></div>
      <div class="detail"><span>Zone ou quartier</span><strong>${escapeHtml(request.neighborhood || '—')}</strong></div>
      <div class="detail"><span>Créneau souhaité</span><strong>${escapeHtml(request.requested_time || '—')}</strong></div>
      <div class="detail"><span>Repère</span><strong>${escapeHtml(request.landmark || '—')}</strong></div>
      <div class="detail"><span>Position GPS</span><strong>${request.location_lat == null ? 'Non partagée' : `${escapeHtml(request.location_lat)}, ${escapeHtml(request.location_lng)}`}</strong></div>
      <div class="detail"><span>Précision</span><strong>${request.location_accuracy == null ? '—' : `${Math.round(request.location_accuracy)} m`}</strong></div>
      <div class="detail" style="grid-column:1/-1"><span>Instructions</span><strong>${escapeHtml(request.notes || 'Aucune')}</strong></div>
    </div></section>
    ${request.order_id ? `<section class="card" style="margin-top:18px"><h2>Commande créée</h2><div class="detail-grid"><div class="detail"><span>Commande</span><strong>N° ${escapeHtml(request.order_id)}</strong></div><div class="detail"><span>Livreur</span><strong>${escapeHtml(request.driver_name)}</strong></div><div class="detail"><span>Statut</span><strong>${escapeHtml(request.order_status)}</strong></div></div><div class="actions" style="margin-top:18px">${request.trackingLink?.path ? `<a class="button primary" target="_blank" rel="noopener" href="${escapeHtml(request.trackingLink.path)}">Ouvrir le suivi</a>` : ''}<a class="button secondary" href="/app/commandes">Voir les commandes</a></div></section>` : ''}
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
  const atCapacity = run.stops.length >= Number(run.capacity);
  const eventDescription = (event) => {
    if (event.event_type === 'status_changed') return `${runStatusLabels[event.details.fromStatus] || event.details.fromStatus} → ${runStatusLabels[event.details.toStatus] || event.details.toStatus}${event.details.reason ? ` · ${event.details.reason}` : ''}`;
    if (event.event_type === 'order_added') return `Commande n° ${event.details.orderId} ajoutée à l’arrêt ${event.details.sequence}`;
    if (event.event_type === 'order_removed') return `Commande n° ${event.details.orderId} retirée`;
    if (event.event_type === 'stops_reordered') return `${event.details.stopIds?.length || 0} arrêts réorganisés`;
    return `${run.driver_name} · ${formatDateOnly(run.service_date)}`;
  };
  page.innerHTML = `<div class="page-header"><div><a href="/app/tournees">← Retour aux tournées</a><h1 style="margin-top:12px">${escapeHtml(run.name)}</h1><p class="subtitle">${escapeHtml(formatDateOnly(run.service_date))} · ${escapeHtml(run.driver_name)} · capacité ${escapeHtml(run.capacity)} colis</p></div>${badge(runStatusLabels[run.status] || run.status)}</div>
    <section class="card"><div class="actions" style="justify-content:space-between"><div><h2 style="margin:0">Arrêts de la tournée</h2><p class="subtitle">${run.canReorderStops ? 'Déplacez les arrêts, puis confirmez explicitement le nouvel ordre.' : 'L’ordre est verrouillé pendant l’exécution.'}</p></div><span>${escapeHtml(run.stops.length)} / ${escapeHtml(run.capacity)} colis</span></div><div id="runNotice"></div><div id="runStops" style="margin-top:18px"></div>
      ${run.canReorderStops && run.stops.length > 1 ? `<div class="actions" style="margin-top:18px"><button class="secondary" id="suggestRunOrder">Proposer un ordre indicatif</button><button class="primary" id="saveRunOrder">Enregistrer cet ordre</button></div><div class="notice warning">La suggestion compare uniquement les positions GPS à vol d’oiseau. Elle ne connaît ni les routes, ni le trafic, ni les créneaux clients. L’équipe doit toujours la vérifier.</div>` : ''}
    </section>
    ${run.canEditStops ? `<section class="card" style="margin-top:18px"><h2>Ajouter un colis</h2>${atCapacity ? `<div class="notice warning">La capacité déclarée de ${escapeHtml(run.capacity)} colis est atteinte.</div>` : run.eligibleOrders.length ? `<form id="addRunOrder"><div class="field"><label>Commande affectée à ${escapeHtml(run.driver_name)}</label><select name="orderId" required><option value="">Sélectionner une commande</option>${run.eligibleOrders.map((order) => `<option value="${escapeHtml(order.id)}">N° ${escapeHtml(order.id)} — ${escapeHtml(order.customer_name || 'Client')} — ${escapeHtml(order.neighborhood || order.landmark || order.delivery_address || 'destination à préciser')}${order.destination_lat == null ? ' — GPS manquant' : ''}</option>`).join('')}</select></div><div class="actions" style="margin-top:14px"><button class="primary">Ajouter à la tournée</button></div></form>` : '<div class="empty">Aucune autre commande active et compatible pour ce livreur.</div>'}<div id="addRunOrderResult"></div></section>` : ''}
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

  const addForm = document.getElementById('addRunOrder');
  if (addForm) addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const orderId = new FormData(form).get('orderId');
    if (!orderId) return;
    button.disabled = true;
    try {
      await api(`/api/app/runs/${encodeURIComponent(id)}/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, expectedVersion: run.version, idempotencyKey: idempotencyKeyFor(form, 'run-add', { orderId }) }),
      });
      location.reload();
    } catch (error) {
      document.getElementById('addRunOrderResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });

  const suggestButton = document.getElementById('suggestRunOrder');
  if (suggestButton) suggestButton.addEventListener('click', async () => {
    suggestButton.disabled = true;
    try {
      const suggestion = await api(`/api/app/runs/${encodeURIComponent(id)}/suggestion`);
      if (!suggestion.available) {
        document.getElementById('runNotice').innerHTML = `<div class="notice warning">${escapeHtml(suggestion.reason)}${suggestion.missingOrderIds?.length ? ` Commandes concernées : ${escapeHtml(suggestion.missingOrderIds.join(', '))}.` : ''}</div>`;
        return;
      }
      const ranking = new Map(suggestion.stopIds.map((stopId, index) => [String(stopId), index]));
      localStops.sort((a, b) => ranking.get(String(a.id)) - ranking.get(String(b.id)));
      renderStopList();
      document.getElementById('runNotice').innerHTML = `<div class="notice warning"><strong>Proposition non enregistrée.</strong> Environ ${escapeHtml(suggestion.distanceKm)} km à vol d’oiseau entre les arrêts. ${escapeHtml(suggestion.warning)} Vérifiez l’ordre puis cliquez sur « Enregistrer cet ordre ».</div>`;
    } catch (error) {
      document.getElementById('runNotice').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
      suggestButton.disabled = false;
    }
  });

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
    <div class="page-header"><div><a href="/app/commandes">← Retour aux commandes</a><h1 style="margin-top:12px">Commande n° ${escapeHtml(order.id)}</h1><p class="subtitle">Mise à jour ${escapeHtml(formatDate(order.updated_at))}</p></div>${badge(order.status)}</div>
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
  page.innerHTML = `<div class="page-header print-hidden"><div><a href="/app/incidents">← Retour aux incidents</a><h1 style="margin-top:12px">Incident n° ${escapeHtml(incident.id)}</h1><p class="subtitle">Commande n° ${escapeHtml(incident.order_id)} · ouvert le ${escapeHtml(formatDate(incident.created_at))}</p></div><div class="actions"><button class="secondary" id="printIncident">Imprimer / enregistrer en PDF</button>${canControl ? `<a class="button secondary" href="/api/app/incidents/${escapeHtml(incident.id)}/export">Télécharger les données</a>` : ''}</div></div>
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
  const operatorLayer = L.layerGroup().addTo(map);
  const replayLayer = L.layerGroup().addTo(map);
  const replay = { active: false, driverId: null, positions: [], index: 0, playing: false, timer: null, marker: null, prevAuto: true };

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

  function replayWindow(key) {
    const now = Date.now();
    if (key === 'today') { const start = new Date(); start.setHours(0, 0, 0, 0); return { from: start.toISOString(), to: new Date(now).toISOString() }; }
    const minutes = { 30: 30, 60: 60, 180: 180 }[key] || 60;
    return { from: new Date(now - minutes * 60000).toISOString(), to: new Date(now).toISOString() };
  }

  const winLabels = { 30: '30 min', 60: '1 h', 180: '3 h', today: 'Aujourd’hui' };
  function renderReplayUI() {
    const slot = document.getElementById('opsReplay');
    if (!slot) return;
    const hasTrack = replay.positions.length > 0;
    slot.innerHTML = `<div class="ops-replay">
      <div class="ops-replay-windows">
        ${['30', '60', '180', 'today'].map((k) => `<button type="button" class="ops-win ${String(replay.windowKey) === k ? 'active' : ''}" data-win="${k}">${winLabels[k]}</button>`).join('')}
        <button type="button" class="ops-win ops-win-close" data-replay-close title="Fermer le rejeu">Fermer</button>
      </div>
      <div class="ops-replay-status">${escapeHtml(replay.statusText || 'Choisissez une période pour rejouer le trajet.')}</div>
      ${hasTrack ? `<div class="ops-replay-controls">
        <button type="button" class="ops-replay-play" id="opsReplayPlay">${replay.playing ? pauseIcon : playIcon}</button>
        <input type="range" id="opsReplayRange" min="0" max="${replay.positions.length - 1}" value="${replay.index}" aria-label="Position dans le trajet"/>
      </div>
      <div class="ops-replay-read" id="opsReplayRead"></div>` : ''}
    </div>`;
    slot.querySelectorAll('[data-win]').forEach((btn) => btn.addEventListener('click', () => startReplay(btn.dataset.win)));
    slot.querySelector('[data-replay-close]')?.addEventListener('click', closeReplay);
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
    replay.positions = []; replay.index = 0; replay.statusText = 'Chargement de l’historique…';
    suspendAutoForReplay();
    renderReplayUI();
    try {
      const { from, to } = replayWindow(windowKey);
      const data = await api(`/api/app/drivers/${encodeURIComponent(driver.id)}/track?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (data.status === 'not_configured') { replay.statusText = 'Le service GPS n’est pas configuré.'; replay.positions = []; }
      else if (data.status === 'no_device') { replay.statusText = 'Aucun appareil GPS n’est associé à ce livreur.'; replay.positions = []; }
      else {
        replay.positions = data.positions || [];
        replay.statusText = replay.positions.length
          ? `${replay.positions.length} point(s) · ${new Date(data.from).toLocaleTimeString('fr-FR')} → ${new Date(data.to).toLocaleTimeString('fr-FR')}${data.truncated ? ' (tronqué)' : ''}`
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
    if (pts.length > 1) L.polyline(pts, { color: '#111', weight: 3, opacity: 0.45 }).addTo(replayLayer);
    if (pts.length) {
      L.circleMarker(pts[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#197044', fillOpacity: 1 }).addTo(replayLayer).bindTooltip('Départ');
      L.circleMarker(pts[pts.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#e11d2a', fillOpacity: 1 }).addTo(replayLayer).bindTooltip('Fin');
      replay.marker = L.circleMarker(pts[replay.index] || pts[0], { radius: 8, color: '#111', weight: 3, fillColor: '#facc15', fillOpacity: 1 }).addTo(replayLayer);
      map.fitBounds(pts, { padding: [60, 60], maxZoom: 16 });
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
    replay.active = false; replay.driverId = null; replay.positions = []; replay.marker = null; replay.windowKey = null; replay.statusText = null;
    replayLayer.clearLayers();
    if (replay.suspended) { autoRefresh = replay.prevAuto; replay.suspended = false; }
    renderPanel();
    scheduleRefresh();
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
          if (runPoints.length > 1) L.polyline(runPoints, { color: run.status === 'active' ? '#e11d2a' : '#6b7280', weight: 3, dashArray: '7 9', opacity: run.status === 'active' ? 0.85 : 0.55 }).addTo(sequenceLayer);
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
    if (action === 'select') { if (replay.active) closeReplay(); selectedDriverId = trigger.dataset.id; isolate = false; redrawMap(); renderPanel(); const d = selectedDriver(); if (d?.position) map.setView([d.position.latitude, d.position.longitude], Math.max(map.getZoom(), 14)); }
    else if (action === 'back') { if (replay.active) closeReplay(); selectedDriverId = ''; isolate = false; redrawMap(); renderPanel(); }
    else if (action === 'center') { const d = selectedDriver(); if (d?.position) map.setView([d.position.latitude, d.position.longitude], 15); }
    else if (action === 'isolate') { isolate = !isolate; redrawMap({ fit: true }); renderPanel(); }
    else if (action === 'replay') {
      if (replay.active && String(replay.driverId) === String(selectedDriverId)) { closeReplay(); }
      else { replay.active = true; replay.driverId = selectedDriverId; replay.windowKey = null; replay.positions = []; replay.statusText = null; suspendAutoForReplay(); renderPanel(); }
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
async function renderDrivers() {
  setHeader('Livreurs', 'Ajout, accès, disponibilité et état GPS');
  const drivers = await api('/api/app/drivers');
  const canManage = ['owner', 'manager'].includes(context.user.role);
  const addForm = canManage ? `<section class="card" style="margin-bottom:18px">
      <h2>Ajouter un livreur</h2>
      <p class="subtitle">Créez la fiche du livreur. Renseignez son e-mail pour générer aussitôt un lien d’accès à son espace : un compte limité, rattaché à votre entreprise, sans accès à votre interface d’exploitation.</p>
      <form id="addDriver" class="form-grid">
        <div class="field"><label>Nom du livreur</label><input name="name" required maxlength="80" autocomplete="off"/></div>
        <div class="field"><label>Téléphone / WhatsApp</label><input name="phone" inputmode="tel" maxlength="40" autocomplete="off"/></div>
        <div class="field"><label>E-mail (accès livreur, optionnel)</label><input name="email" type="email" autocomplete="off"/></div>
        <div class="field"><label>Véhicule</label><select name="vehicleType">${driverVehicleOptions.map((option) => `<option value="${option}">${option}</option>`).join('')}</select></div>
        <div class="field"><label>Capacité (colis)</label><input name="capacity" type="number" min="1" max="50" value="3"/></div>
        <div class="field"><label>Identifiant GPS (optionnel)</label><input name="trackerId" maxlength="64" placeholder="Vide = généré automatiquement" autocomplete="off"/></div>
        <div class="field full"><div class="actions"><button class="primary" type="submit">Créer le livreur</button></div></div>
      </form>
      <div id="addDriverResult"></div>
    </section>` : '';
  page.innerHTML = `<div class="page-header"><div><h1>Livreurs</h1><p class="subtitle">${canManage ? 'Ajoutez vos livreurs et générez leur accès. ' : ''}Les livreurs disponibles sont placés en premier.</p></div></div>
    ${addForm}
    <section class="card">${drivers.length ? `<div class="table-wrap"><table><thead><tr><th>Livreur</th><th>État</th><th>Charge</th><th>Identifiant GPS</th><th>Dernière position</th><th>Disponibilité</th>${canManage ? '<th>Compte</th>' : ''}</tr></thead><tbody>${drivers.map((driver) => `<tr><td><strong>${escapeHtml(driver.name)}</strong><br><small>${escapeHtml(driver.vehicleType)}${driver.phone ? ` · ${escapeHtml(driver.phone)}` : ''}</small></td><td>${badge(driverStateLabels[driver.operationalState] || driver.operationalState)}${driver.active ? '' : ' <span class="badge">Désactivé</span>'}</td><td>${escapeHtml(driver.activeOrders)} / ${escapeHtml(driver.capacity)}</td><td><code>${escapeHtml(driver.uniqueId)}</code></td><td>${escapeHtml(formatDate(driver.lastUpdate))}</td><td><select class="availability" data-driver-id="${escapeHtml(driver.id)}" ${driver.active ? '' : 'disabled'}><option value="available" ${driver.availabilityStatus === 'available' ? 'selected' : ''}>Disponible</option><option value="pause" ${driver.availabilityStatus === 'pause' ? 'selected' : ''}>Pause</option><option value="off_duty" ${driver.availabilityStatus === 'off_duty' ? 'selected' : ''}>Hors service</option><option value="incident" ${driver.availabilityStatus === 'incident' ? 'selected' : ''}>Incident</option></select></td>${canManage ? `<td><button class="secondary toggle-driver" data-driver-id="${escapeHtml(driver.id)}" data-active="${driver.active ? '1' : '0'}">${driver.active ? 'Désactiver' : 'Réactiver'}</button></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucun livreur enregistré.</div>'}<div id="driverResult"></div></section>`;

  document.querySelectorAll('.availability').forEach((select) => select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      await api(`/api/app/drivers/${encodeURIComponent(select.dataset.driverId)}/availability`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: select.value }),
      });
      document.getElementById('driverResult').innerHTML = '<div class="notice success">Disponibilité mise à jour.</div>';
    } catch (error) {
      document.getElementById('driverResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      select.disabled = false;
    }
  }));

  document.querySelectorAll('.toggle-driver').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/app/drivers/${encodeURIComponent(button.dataset.driverId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: button.dataset.active === '0' }),
      });
      renderDrivers();
    } catch (error) {
      document.getElementById('driverResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  }));

  const form = document.getElementById('addDriver');
  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = document.getElementById('addDriverResult');
    const data = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    result.innerHTML = '';
    try {
      const driver = await api('/api/app/drivers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name, phone: data.phone, vehicleType: data.vehicleType, capacity: Number(data.capacity), trackerId: data.trackerId }),
      });
      let inviteBlock = '';
      const email = String(data.email || '').trim();
      if (email) {
        try {
          const invite = await api('/api/app/invitations', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, displayName: data.name, role: 'driver', driverId: driver.id }),
          });
          const url = `${location.origin}${invite.path}`;
          inviteBlock = `<div class="otp-code"><span>Lien d’accès à envoyer au livreur (valable 48 h, à usage unique)</span><input readonly value="${escapeHtml(url)}" id="inviteLink" style="text-align:center;margin-top:8px"/><div class="actions" style="justify-content:center;margin-top:10px"><button class="secondary" id="copyInvite" type="button">Copier le lien</button></div></div>`;
        } catch (inviteError) {
          inviteBlock = `<div class="notice warning">Livreur créé, mais l’accès n’a pas pu être généré : ${escapeHtml(inviteError.message)}. Vous pouvez réessayer depuis « Équipe et accès ».</div>`;
        }
      }
      result.innerHTML = `<div class="notice success">Livreur « ${escapeHtml(driver.name)} » créé. Identifiant GPS : <code>${escapeHtml(driver.traccar_unique_id)}</code>.</div>${inviteBlock}`;
      const copy = document.getElementById('copyInvite');
      if (copy) copy.addEventListener('click', () => { const field = document.getElementById('inviteLink'); field.select(); navigator.clipboard?.writeText(field.value); copy.textContent = 'Lien copié'; });
      form.reset();
      // On ne rafraîchit pas si un lien d'accès est affiché, pour ne pas l'effacer.
      if (!inviteBlock) setTimeout(() => renderDrivers(), 600);
    } catch (error) {
      result.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
      submit.disabled = false;
    }
  });
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

async function renderSettings() {
  setHeader('Paramètres', 'Règles de livraison de l’entreprise');
  const settings = await api('/api/app/settings/proofs');
  const canEdit = ['owner', 'manager'].includes(context.user.role);
  const modeOptions = (selected) => [
    ['off', 'Désactivée'], ['optional', 'Facultative'], ['required', 'Obligatoire'],
  ].map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
  page.innerHTML = `<div class="page-header"><div><h1>Paramètres</h1><p class="subtitle">Les preuves doivent rester proportionnées au risque de vos livraisons.</p></div></div>
    <section class="card"><h2>Preuves complémentaires de remise</h2><p>Le code client reste la preuve principale. Activez une photo ou une signature seulement si votre activité le justifie.</p><div class="notice">Une preuve « obligatoire » empêchera la validation finale tant que le livreur ne l’aura pas ajoutée. Les images restent privées.</div><form id="proofSettings"><div class="form-grid"><div class="field"><label>Photo de remise</label><select name="photoMode" ${canEdit ? '' : 'disabled'}>${modeOptions(settings.photo_proof_mode)}</select><small>Privilégiez le colis ou le lieu, sans visage ni document d’identité.</small></div><div class="field"><label>Signature du destinataire</label><select name="signatureMode" ${canEdit ? '' : 'disabled'}>${modeOptions(settings.signature_proof_mode)}</select><small>Ne demandez la signature que lorsqu’elle est réellement utile.</small></div></div>${canEdit ? '<div class="actions" style="margin-top:18px"><button class="primary">Enregistrer les règles</button></div>' : '<p class="notice">Seul un propriétaire ou manager peut modifier ces règles.</p>'}</form><div id="settingsResult"></div></section>`;
  const form = document.getElementById('proofSettings');
  if (canEdit) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      await api('/api/app/settings/proofs', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      document.getElementById('settingsResult').innerHTML = '<div class="notice success">Règles de preuve enregistrées.</div>';
    } catch (error) {
      document.getElementById('settingsResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  });
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
    document.getElementById('topRole').textContent = context.user.role;
    document.getElementById('userName').textContent = `${context.user.name} · ${context.user.email}`;
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
    if (path === '/app/demandes') return await renderRequests();
    if (path === '/app/nouvelle-commande') return await renderNewOrder();
    if (path === '/app/commandes') return await renderOrders();
    if (path === '/app/tournees') return await renderRuns();
    if (path === '/app/incidents') return await renderIncidents();
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
start();
