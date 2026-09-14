const page = document.getElementById('page');
const sidebar = document.getElementById('sidebar');
let context;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[character]));

const formatDate = (value) => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const formatMoney = (value, currency = 'XOF') => value == null ? '—' : new Intl.NumberFormat('fr-FR', {
  style: 'currency', currency, maximumFractionDigits: 0,
}).format(Number(value));

function badge(status) {
  const type = ['Livrée', 'Disponible', 'Confirmée'].includes(status) ? 'success'
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
const roleLabels = { owner: 'Propriétaire', manager: 'Manager', operator: 'Opérateur', driver: 'Livreur' };

function renderPaymentSection(order) {
  const configured = Boolean(order.payment_account_id);
  const canConfigure = !order.isTerminal && (!configured || ['pending', 'not_required'].includes(order.payment_status));
  const canCollect = configured && order.payment_status === 'pending' && ['En livraison', 'Arrivée'].includes(order.status);
  const canControl = ['owner', 'manager'].includes(context.user.role);
  const canReconcile = canControl && ['collected', 'discrepancy'].includes(order.payment_status);
  const canReverse = canControl && ['collected', 'discrepancy'].includes(order.payment_status) && !order.isTerminal;
  const events = order.paymentEvents || [];
  return `<section class="card" style="margin-top:18px"><h2>Encaissement à la livraison</h2>
    ${configured ? `<div class="detail-grid"><div class="detail"><span>Montant attendu</span><strong>${escapeHtml(formatMoney(order.expected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>État financier</span><strong>${badge(paymentStatusLabels[order.payment_status] || order.payment_status)}</strong></div><div class="detail"><span>Montant reçu</span><strong>${escapeHtml(formatMoney(order.collected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>Mode</span><strong>${escapeHtml(paymentMethodLabels[order.collection_method] || order.collection_method || '—')}</strong></div><div class="detail"><span>Référence</span><strong>${escapeHtml(order.collection_reference || '—')}</strong></div><div class="detail"><span>Rapprochement</span><strong>${escapeHtml(formatDate(order.reconciled_at))}</strong></div></div>${order.discrepancy_reason ? `<div class="notice error"><strong>Écart déclaré :</strong> ${escapeHtml(order.discrepancy_reason)}</div>` : ''}` : '<p class="subtitle">Aucun paiement ne sera exigé tant qu’un montant n’est pas configuré.</p>'}
    ${canConfigure ? `<form id="paymentConfigure" style="margin-top:18px"><div class="form-grid"><div class="field"><label>Montant attendu en FCFA</label><input name="expectedAmountMinor" type="number" min="1" step="1" value="${configured && order.payment_status !== 'not_required' ? escapeHtml(order.expected_amount_minor) : ''}" required /></div><input type="hidden" name="currency" value="XOF" /></div><div class="actions" style="margin-top:12px"><button class="secondary">${configured ? 'Modifier le montant attendu' : 'Exiger un encaissement'}</button>${configured && order.payment_status === 'pending' ? '<button class="danger" type="button" id="removePaymentRequirement">Retirer cette exigence</button>' : ''}</div></form>` : ''}
    ${canCollect ? `<form id="paymentCollect" style="margin-top:18px"><h3>Déclarer la somme reçue</h3><div class="form-grid"><div class="field"><label>Montant reçu en FCFA</label><input name="amountMinor" type="number" min="0" step="1" value="${escapeHtml(order.expected_amount_minor)}" required /></div><div class="field"><label>Mode d’encaissement</label><select name="method"><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="card">Carte</option><option value="bank_transfer">Virement</option><option value="other">Autre</option></select></div><div class="field"><label>Référence facultative</label><input name="reference" maxlength="120" placeholder="Référence Mobile Money, reçu…" /></div><div class="field"><label>Motif en cas d’écart</label><textarea name="discrepancyReason" placeholder="Obligatoire si le montant reçu diffère"></textarea></div></div><div class="actions" style="margin-top:12px"><button class="primary">Enregistrer l’encaissement</button></div></form>` : configured && order.payment_status === 'pending' ? '<p class="notice">L’encaissement pourra être déclaré lorsque la commande sera « En livraison » ou « Arrivée ».</p>' : ''}
    ${canReconcile ? `<form id="paymentReconcile" style="margin-top:18px"><div class="field"><label>Note de rapprochement ${order.payment_status === 'discrepancy' ? '(obligatoire)' : '(facultative)'}</label><textarea name="note" placeholder="Contrôle de caisse, justification de l’écart…"></textarea></div><div class="actions" style="margin-top:12px"><button class="primary">Marquer comme rapproché</button>${canReverse ? '<button class="danger" type="button" id="reversePayment">Annuler la saisie</button>' : ''}</div></form>` : ''}
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
    </section>
    <section class="card" style="margin-top:18px"><h2>Accès rapides</h2><div class="actions"><a class="button primary" href="/app/demandes">Nouvelle demande client</a><a class="button secondary" href="/app/nouvelle-commande">Commande directe</a><a class="button secondary" href="/app/carte">Carte d’exploitation</a></div></section>`;
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
    ${request.order_id ? `<section class="card" style="margin-top:18px"><h2>Commande créée</h2><div class="detail-grid"><div class="detail"><span>Commande</span><strong>N° ${escapeHtml(request.order_id)}</strong></div><div class="detail"><span>Livreur</span><strong>${escapeHtml(request.driver_name)}</strong></div><div class="detail"><span>Statut</span><strong>${escapeHtml(request.order_status)}</strong></div></div><div class="actions" style="margin-top:18px"><a class="button primary" target="_blank" rel="noopener" href="/suivi/${escapeHtml(request.tracking_token)}">Ouvrir le suivi</a><a class="button secondary" href="/app/commandes">Voir les commandes</a></div></section>` : ''}
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
  page.innerHTML = `<div class="page-header"><div><h1>Commandes</h1><p class="subtitle">Ouvrez une commande pour exécuter la livraison, déclarer un incident ou confirmer la remise.</p></div><a class="button primary" href="/app/nouvelle-commande">Nouvelle commande</a></div><section class="card">${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Commande</th><th>Client</th><th>Zone</th><th>Livreur</th><th>Statut</th><th>Suivi</th></tr></thead><tbody>${orders.map((order) => `<tr data-href="/app/commandes/${escapeHtml(order.id)}"><td>N° ${escapeHtml(order.id)}<br><small>${escapeHtml(formatDate(order.created_at))}</small></td><td><strong>${escapeHtml(order.customer_name || '—')}</strong><br><small>${escapeHtml(order.customer_phone || '')}</small></td><td>${escapeHtml(order.neighborhood || order.landmark || '—')}</td><td>${escapeHtml(order.driver_name)}</td><td>${badge(order.status)}</td><td>${order.tracking_token ? `<a href="/suivi/${escapeHtml(order.tracking_token)}" target="_blank" rel="noopener">Ouvrir</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucune commande pour le moment.</div>'}</section>`;
  document.querySelectorAll('tr[data-href]').forEach((row) => row.addEventListener('click', (event) => {
    if (event.target.closest('a, button, input, select')) return;
    location.href = row.dataset.href;
  }));
}

async function renderOrderDetail(id) {
  setHeader('Commande', 'Exécution, preuve de remise et incidents');
  const order = await api(`/api/app/orders/${encodeURIComponent(id)}`);
  const destination = [order.neighborhood, order.landmark, order.delivery_address].filter(Boolean).join(' — ') || '—';
  const incidentOptions = Object.entries(incidentCategoryLabels)
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
  page.innerHTML = `
    <div class="page-header"><div><a href="/app/commandes">← Retour aux commandes</a><h1 style="margin-top:12px">Commande n° ${escapeHtml(order.id)}</h1><p class="subtitle">Mise à jour ${escapeHtml(formatDate(order.updated_at))}</p></div>${badge(order.status)}</div>
    <section class="card"><h2>Livraison</h2><div class="detail-grid">
      <div class="detail"><span>Client</span><strong>${escapeHtml(order.customer_name || '—')}</strong></div>
      <div class="detail"><span>Téléphone</span><strong>${escapeHtml(order.customer_phone || '—')}</strong></div>
      <div class="detail"><span>Créneau</span><strong>${escapeHtml(order.requested_time || '—')}</strong></div>
      <div class="detail"><span>Livreur</span><strong>${escapeHtml(order.driver_name)} · ${escapeHtml(order.driver_vehicle_type || '')}</strong></div>
      <div class="detail" style="grid-column:span 2"><span>Destination et instructions</span><strong>${escapeHtml(destination)}</strong></div>
    </div><div class="actions" style="margin-top:18px">${order.tracking_token ? `<a class="button secondary" href="/suivi/${escapeHtml(order.tracking_token)}" target="_blank" rel="noopener">Ouvrir le suivi client</a>` : ''}</div></section>

    ${renderPaymentSection(order)}

    ${!order.isTerminal && order.allowedTransitions.length ? `<section class="card" style="margin-top:18px"><h2>Faire avancer la livraison</h2><p class="subtitle">Seules les étapes compatibles avec l’état actuel sont proposées.</p><form id="transitionForm" style="margin-top:16px"><div class="form-grid"><div class="field"><label>Nouvelle étape</label><select name="toStatus" required><option value="">Choisir une étape</option>${order.allowedTransitions.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join('')}</select></div><div class="field"><label>Motif ou observation</label><textarea name="reason" placeholder="Obligatoire pour un échec, retour ou une annulation"></textarea></div></div><div class="actions" style="margin-top:16px"><button class="primary">Enregistrer l’étape</button></div></form><div id="transitionResult"></div></section>` : ''}

    ${order.requiresOtpForDelivery ? `<section class="card" style="margin-top:18px"><h2>Confirmer la remise avec un code</h2><p class="subtitle">Le code est valable 30 minutes et ne peut être utilisé qu’une fois. Communiquez-le au destinataire par un canal fiable.</p>${order.paymentBlocksDelivery ? '<div class="notice error">Finalisez l’encaissement ou son rapprochement avant de confirmer la livraison.</div>' : ''}<div class="actions" style="margin-top:16px"><button class="secondary" id="generateOtp">Générer un code de remise</button></div><div id="otpGenerated"></div><form id="verifyOtp" style="margin-top:18px"><div class="field"><label>Code communiqué par le destinataire</label><input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="000000" required /></div><div class="actions" style="margin-top:12px"><button class="primary" ${order.paymentBlocksDelivery ? 'disabled' : ''}>Confirmer la livraison</button></div></form><div id="otpResult"></div></section>` : ''}
    ${order.proof_id ? `<section class="card" style="margin-top:18px"><h2>Preuve de remise</h2><div class="notice success">Remise confirmée par code à usage unique le ${escapeHtml(formatDate(order.proof_verified_at))}.</div></section>` : ''}

    <section class="card" style="margin-top:18px"><h2>Incidents</h2><form id="incidentForm"><div class="form-grid"><div class="field"><label>Type</label><select name="category">${incidentOptions}</select></div><div class="field"><label>Gravité</label><select name="severity"><option value="low">Faible</option><option value="medium" selected>Moyenne</option><option value="high">Élevée</option></select></div><div class="field full"><label>Description factuelle</label><textarea name="description" maxlength="2000" required placeholder="Décrivez ce qui s’est passé, sans supprimer les faits précédents."></textarea></div></div><div class="actions" style="margin-top:14px"><button class="secondary">Déclarer l’incident</button></div></form><div id="incidentResult"></div>
      <div class="incident-list">${order.incidents.length ? order.incidents.map((incident) => `<article class="incident"><div><strong>${escapeHtml(incidentCategoryLabels[incident.category] || incident.category)}</strong> ${badge(incident.status === 'resolved' ? 'Résolu' : 'Ouvert')}<p>${escapeHtml(incident.description)}</p><small>${escapeHtml(formatDate(incident.created_at))} · ${escapeHtml(incident.opened_by)} · gravité ${escapeHtml(incident.severity)}</small>${incident.resolution ? `<p><strong>Résolution :</strong> ${escapeHtml(incident.resolution)}</p>` : ''}</div>${incident.status === 'open' ? `<button class="secondary resolveIncident" data-incident-id="${escapeHtml(incident.id)}">Résoudre</button>` : ''}</article>`).join('') : '<p class="subtitle">Aucun incident déclaré.</p>'}</div>
    </section>

    <section class="card" style="margin-top:18px"><h2>Chronologie</h2><ol class="timeline">${order.events.map((event) => `<li><div>${badge(event.to_status)}${event.from_status ? `<span class="timeline-from"> depuis ${escapeHtml(event.from_status)}</span>` : ''}</div><strong>${escapeHtml(event.actor_name)}</strong><small>${escapeHtml(formatDate(event.created_at))}</small>${event.reason ? `<p>${escapeHtml(event.reason)}</p>` : ''}</li>`).join('')}</ol></section>`;

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

  document.querySelectorAll('.resolveIncident').forEach((button) => button.addEventListener('click', async () => {
    const resolution = prompt('Comment cet incident a-t-il été résolu ?');
    if (!resolution) return;
    button.disabled = true;
    try {
      const idempotencyKey = idempotencyKeyFor(button, 'incident-resolution', { resolution });
      await api(`/api/app/incidents/${encodeURIComponent(button.dataset.incidentId)}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution, idempotencyKey }),
      });
      await renderOrderDetail(id);
    } catch (error) {
      document.getElementById('incidentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  }));
}

async function renderDrivers() {
  setHeader('Livreurs', 'Disponibilité, charge et état GPS');
  const drivers = await api('/api/app/drivers');
  page.innerHTML = `<div class="page-header"><div><h1>Livreurs</h1><p class="subtitle">Les livreurs disponibles sont placés en premier.</p></div></div><section class="card">${drivers.length ? `<div class="table-wrap"><table><thead><tr><th>Livreur</th><th>État</th><th>Charge</th><th>GPS</th><th>Dernière position</th><th>Disponibilité manuelle</th></tr></thead><tbody>${drivers.map((driver) => `<tr><td><strong>${escapeHtml(driver.name)}</strong><br><small>${escapeHtml(driver.vehicleType)}</small></td><td>${badge(driverStateLabels[driver.operationalState] || driver.operationalState)}</td><td>${escapeHtml(driver.activeOrders)} / ${escapeHtml(driver.capacity)}</td><td>${escapeHtml(driver.trackerStatus)}</td><td>${escapeHtml(formatDate(driver.lastUpdate))}</td><td><select class="availability" data-driver-id="${escapeHtml(driver.id)}"><option value="available" ${driver.availabilityStatus === 'available' ? 'selected' : ''}>Disponible</option><option value="pause" ${driver.availabilityStatus === 'pause' ? 'selected' : ''}>Pause</option><option value="off_duty" ${driver.availabilityStatus === 'off_duty' ? 'selected' : ''}>Hors service</option><option value="incident" ${driver.availabilityStatus === 'incident' ? 'selected' : ''}>Incident</option></select></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucun livreur enregistré.</div>'}<div id="driverResult"></div></section>`;
  document.querySelectorAll('.availability').forEach((select) => select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      await api(`/api/app/drivers/${encodeURIComponent(select.dataset.driverId)}/availability`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: select.value }),
      });
      document.getElementById('driverResult').innerHTML = '<div class="notice success">Disponibilité mise à jour.</div>';
      setTimeout(() => renderDrivers(), 500);
    } catch (error) {
      document.getElementById('driverResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      select.disabled = false;
    }
  }));
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

function renderPlaceholder(title, description, items) {
  setHeader(title, description);
  page.innerHTML = `<div class="page-header"><div><h1>${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(description)}</p></div></div><section class="card placeholder"><h2>Prévu dans la feuille de route</h2><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p>Cette page est séparée dès maintenant afin d’éviter d’empiler toutes les fonctions dans un seul écran.</p></section>`;
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
    if (path === '/app') return await renderDashboard();
    if (path === '/app/demandes') return await renderRequests();
    if (path === '/app/nouvelle-commande') return await renderNewOrder();
    if (path === '/app/commandes') return await renderOrders();
    if (path === '/app/carte') return renderPlaceholder('Carte d’exploitation', 'Flotte, destinations et tournées', ['Tous les livreurs autorisés', 'Arrêts et parcours restant', 'Filtres et incidents']);
    if (path === '/app/livreurs') return await renderDrivers();
    if (path === '/app/equipe') return await renderTeam();
    if (path === '/app/clients') return renderPlaceholder('Clients', 'CRM opérationnel', ['Historique des commandes', 'Lieux et repères', 'Interactions et incidents']);
    if (path === '/app/rapports') return renderPlaceholder('Rapports', 'Analyses et exports', ['Suivi mensuel', 'Indicateurs vérifiables', 'Exports Excel']);
    if (path === '/app/parametres') return renderPlaceholder('Paramètres', 'Configuration de l’entreprise', ['Utilisateurs et rôles', 'Règles de livraison', 'Conservation des données']);
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
