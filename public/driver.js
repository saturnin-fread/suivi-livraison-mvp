const page = document.getElementById('driverPage');
let context;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[character]));
const formatDate = (value) => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const formatMoney = (value, currency = 'XOF') => value == null ? '—' : new Intl.NumberFormat('fr-FR', {
  style: 'currency', currency, maximumFractionDigits: 0,
}).format(Number(value));
const terminalStatuses = ['Livrée', 'Retournée', 'Annulée'];
const transitionLabels = {
  'Récupérée': 'Colis récupéré', 'En tournée': 'Commencer la tournée', 'En livraison': 'Aller vers ce client',
  'Arrivée': 'Je suis arrivé', 'Échec': 'Signaler un échec', 'Retour': 'Retourner le colis',
};
const incidentLabels = {
  client_injoignable: 'Client injoignable', adresse: 'Adresse ou accès', colis: 'Problème de colis',
  paiement: 'Paiement', vehicule: 'Véhicule', gps: 'GPS ou connexion', autre: 'Autre',
};
const paymentStatusLabels = {
  pending: 'À encaisser', collected: 'Encaissé', discrepancy: 'Écart à traiter',
  reconciled: 'Rapproché', not_required: 'Aucun encaissement requis', reversed: 'Annulé',
};
const paymentMethodLabels = {
  cash: 'Espèces', mobile_money: 'Mobile Money', card: 'Carte', bank_transfer: 'Virement', other: 'Autre',
};

function badge(status) {
  const type = status === 'Livrée' ? 'success' : ['Échec', 'Retour', 'Retournée', 'Annulée'].includes(status) ? 'danger' : ['Arrivée'].includes(status) ? 'warning' : '';
  return `<span class="badge ${type}">${escapeHtml(status)}</span>`;
}

function actionKey(prefix) {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

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

function renderError(error) {
  page.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
}

async function renderList() {
  const history = new URLSearchParams(location.search).get('scope') === 'history';
  document.getElementById(history ? 'historyLink' : 'activeLink').classList.add('active');
  const orders = await api(`/api/driver/orders?scope=${history ? 'history' : 'active'}`);
  page.innerHTML = `<div class="driver-title"><h1>${history ? 'Historique' : 'Mes livraisons'}</h1><p class="subtitle">${history ? 'Commandes terminées qui vous étaient affectées.' : 'Uniquement les commandes qui vous sont affectées.'}</p></div>
    <section class="delivery-list">${orders.length ? orders.map((order) => `<a class="delivery-card" href="/driver/commandes/${escapeHtml(order.id)}">
      <div class="delivery-card-head"><div><h2>${escapeHtml(order.customer_name || 'Client')}</h2><p>Commande n° ${escapeHtml(order.id)}</p></div>${badge(order.status)}</div>
      <p><strong>${escapeHtml(order.neighborhood || order.delivery_address || 'Destination à préciser')}</strong>${order.landmark ? ` · ${escapeHtml(order.landmark)}` : ''}</p>
      <p>${escapeHtml(order.requested_time || 'Créneau non précisé')}${order.expected_amount_minor != null ? ` · À encaisser : ${escapeHtml(formatMoney(order.expected_amount_minor, order.payment_currency))}` : ''}</p>
    </a>`).join('') : `<div class="card empty">${history ? 'Aucune livraison terminée.' : 'Aucune livraison active ne vous est affectée.'}</div>`}</section>`;
}

async function renderDetail(id) {
  document.querySelector('.driver-nav').hidden = true;
  document.body.style.paddingBottom = '0';
  const order = await api(`/api/driver/orders/${encodeURIComponent(id)}`);
  const destinationLink = order.destination_lat != null && order.destination_lng != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${order.destination_lat},${order.destination_lng}`)}`
    : null;
  const canCollectPayment = order.expected_amount_minor != null
    && order.payment_status === 'pending'
    && ['En livraison', 'Arrivée'].includes(order.status);
  const canVerifyOtp = order.status === 'Arrivée' && !order.proof_id;
  const paymentBlocksDelivery = order.expected_amount_minor != null
    && ['pending', 'discrepancy'].includes(order.payment_status);
  const hasActiveOtp = Boolean(order.active_otp_expires_at);
  page.innerHTML = `<a class="driver-back" href="/driver">← Mes livraisons</a>
    <div class="page-header"><div><h1>${escapeHtml(order.customer_name || 'Client')}</h1><p class="subtitle">Commande n° ${escapeHtml(order.id)}</p></div>${badge(order.status)}</div>
    <section class="card driver-detail-grid">
      <div class="detail"><span>Téléphone</span><strong>${escapeHtml(order.customer_phone || '—')}</strong></div>
      <div class="detail"><span>Destination</span><strong>${escapeHtml(order.delivery_address || order.neighborhood || '—')}</strong></div>
      <div class="detail"><span>Repère</span><strong>${escapeHtml(order.landmark || '—')}</strong></div>
      <div class="detail"><span>Créneau</span><strong>${escapeHtml(order.requested_time || '—')}</strong></div>
      ${order.notes ? `<div class="detail"><span>Instructions</span><strong>${escapeHtml(order.notes)}</strong></div>` : ''}
    </section>
    <div class="driver-actions">
      ${order.customer_phone ? `<a class="button secondary" href="tel:${escapeHtml(order.customer_phone)}">Appeler le client</a>` : ''}
      ${destinationLink ? `<a class="button secondary" target="_blank" rel="noopener" href="${destinationLink}">Ouvrir l’itinéraire</a>` : ''}
    </div>
    ${order.expected_amount_minor != null ? `<section class="card driver-section"><h2>Encaissement</h2>
      <div class="driver-detail-grid"><div class="detail"><span>Montant attendu</span><strong>${escapeHtml(formatMoney(order.expected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>État</span><strong>${escapeHtml(paymentStatusLabels[order.payment_status] || order.payment_status || 'À encaisser')}</strong></div>${order.collected_amount_minor != null ? `<div class="detail"><span>Montant déclaré</span><strong>${escapeHtml(formatMoney(order.collected_amount_minor, order.payment_currency))}</strong></div><div class="detail"><span>Mode</span><strong>${escapeHtml(paymentMethodLabels[order.collection_method] || order.collection_method || '—')}</strong></div>` : ''}</div>
      ${order.payment_status === 'discrepancy' ? `<div class="notice error"><strong>Écart à traiter par un responsable.</strong> La remise reste bloquée.${order.discrepancy_reason ? ` Motif : ${escapeHtml(order.discrepancy_reason)}` : ''}</div>` : ''}
      ${canCollectPayment ? `<form id="paymentForm" class="driver-form"><div class="field"><label>Somme réellement reçue en FCFA</label><input name="amountMinor" type="number" min="0" step="1" value="${escapeHtml(order.expected_amount_minor)}" required /></div><div class="field"><label>Mode d’encaissement</label><select name="method"><option value="cash">Espèces</option><option value="mobile_money">Mobile Money</option><option value="card">Carte</option><option value="bank_transfer">Virement</option><option value="other">Autre</option></select></div><div class="field"><label>Référence facultative</label><input name="reference" maxlength="120" placeholder="Transaction Mobile Money, reçu…" /></div><div class="field" id="discrepancyField" hidden><label>Pourquoi le montant diffère-t-il ?</label><textarea name="discrepancyReason" minlength="5" maxlength="1000" placeholder="Ex. client sans monnaie suffisante"></textarea></div><div class="notice warning">Vérifiez la somme avant de confirmer. Une différence devra être validée par un responsable et bloquera la remise.</div><button class="primary">Confirmer l’encaissement</button></form><div id="paymentResult"></div>` : order.payment_status === 'pending' ? '<p class="notice">La saisie sera disponible à partir de l’étape « En livraison ».</p>' : ''}
    </section>` : ''}
    ${canVerifyOtp ? `<section class="card driver-section"><h2>Confirmer la remise</h2><p>Demandez au client le code à 6 chiffres reçu pour cette commande.</p><p class="subtitle">Le portail livreur n’affiche et ne génère jamais ce code.</p>${hasActiveOtp ? `<div class="notice success">Un code est actif jusqu’au ${escapeHtml(formatDate(order.active_otp_expires_at))}.</div>` : '<div class="notice warning">Aucun code actif. Demandez à l’exploitation d’en générer un pour le client.</div>'}${paymentBlocksDelivery ? '<div class="notice error">La remise est bloquée tant que l’encaissement ou son écart n’est pas finalisé.</div>' : ''}<form id="otpForm" class="driver-form"><div class="field"><label>Code donné par le client</label><input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="000000" required /></div><button class="primary" ${!hasActiveOtp || paymentBlocksDelivery ? 'disabled' : ''}>Valider la remise au client</button></form><div id="otpResult"></div></section>` : ''}
    ${order.proof_id ? `<section class="card driver-section"><h2>Remise confirmée</h2><div class="notice success">Le code client a été vérifié le ${escapeHtml(formatDate(order.proof_verified_at))}. Cette livraison est terminée.</div></section>` : ''}
    ${!order.isTerminal ? `<section class="card driver-section"><h2>Mettre à jour l’étape</h2><div class="driver-actions">${order.allowedTransitions.map((status) => `<button class="${['Échec', 'Retour'].includes(status) ? 'danger' : 'primary'} transition" data-status="${escapeHtml(status)}">${escapeHtml(transitionLabels[status] || status)}</button>`).join('')}</div><div id="transitionResult"></div></section>` : ''}
    <section class="card driver-section"><h2>Signaler un incident</h2>
      <form id="incidentForm"><div class="field"><label>Type</label><select name="category">${Object.entries(incidentLabels).map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}</select></div>
      <div class="field" style="margin-top:12px"><label>Gravité</label><select name="severity"><option value="low">Faible</option><option value="medium" selected>Moyenne</option><option value="high">Élevée</option></select></div>
      <div class="field" style="margin-top:12px"><label>Ce qui s’est passé</label><textarea name="description" minlength="5" maxlength="2000" required></textarea></div>
      <button class="danger" style="margin-top:12px">Envoyer l’incident</button></form><div id="incidentResult"></div>
      ${order.incidents.length ? `<div class="incident-list">${order.incidents.map((incident) => `<article class="incident"><div><strong>${escapeHtml(incidentLabels[incident.category] || incident.category)}</strong><p>${escapeHtml(incident.description)}</p><small>${escapeHtml(formatDate(incident.created_at))}</small></div>${badge(incident.status === 'resolved' ? 'Résolu' : 'Ouvert')}</article>`).join('')}</div>` : ''}
    </section>`;

  document.querySelectorAll('.transition').forEach((button) => button.addEventListener('click', async () => {
    const toStatus = button.dataset.status;
    let reason = '';
    if (['Échec', 'Retour'].includes(toStatus)) {
      reason = prompt('Expliquez la raison (au moins 5 caractères) :') || '';
      if (reason.length < 5) return;
    }
    if (!confirm(`Confirmer l’étape « ${toStatus} » ?`)) return;
    document.querySelectorAll('.transition').forEach((item) => { item.disabled = true; });
    try {
      await api(`/api/driver/orders/${encodeURIComponent(id)}/transition`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toStatus, reason, idempotencyKey: actionKey('driver-transition') }),
      });
      await renderDetail(id);
    } catch (error) {
      document.getElementById('transitionResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      document.querySelectorAll('.transition').forEach((item) => { item.disabled = false; });
    }
  }));

  const paymentForm = document.getElementById('paymentForm');
  if (paymentForm) {
    const amountInput = paymentForm.elements.amountMinor;
    const discrepancyField = document.getElementById('discrepancyField');
    const discrepancyInput = paymentForm.elements.discrepancyReason;
    const updateDiscrepancy = () => {
      const differs = Number(amountInput.value) !== Number(order.expected_amount_minor);
      discrepancyField.hidden = !differs;
      discrepancyInput.required = differs;
    };
    amountInput.addEventListener('input', updateDiscrepancy);
    updateDiscrepancy();
    paymentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"], button:not([type])');
      button.disabled = true;
      event.currentTarget.dataset.actionKey ||= actionKey('driver-payment');
      try {
        const payload = Object.fromEntries(new FormData(event.currentTarget));
        payload.idempotencyKey = event.currentTarget.dataset.actionKey;
        await api(`/api/driver/orders/${encodeURIComponent(id)}/payment/collect`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        await renderDetail(id);
      } catch (error) {
        document.getElementById('paymentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        button.disabled = false;
      }
    });
  }

  const otpForm = document.getElementById('otpForm');
  if (otpForm) otpForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    event.currentTarget.dataset.actionKey ||= actionKey('driver-otp');
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      payload.idempotencyKey = event.currentTarget.dataset.actionKey;
      await api(`/api/driver/orders/${encodeURIComponent(id)}/otp/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      await renderDetail(id);
    } catch (error) {
      document.getElementById('otpResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      event.currentTarget.dataset.actionKey = '';
      button.disabled = false;
    }
  });

  document.getElementById('incidentForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(event.currentTarget));
      payload.idempotencyKey = actionKey('driver-incident');
      await api(`/api/driver/orders/${encodeURIComponent(id)}/incidents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      await renderDetail(id);
    } catch (error) {
      document.getElementById('incidentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });
}

async function start() {
  try {
    context = await api('/api/driver/context');
    document.getElementById('driverName').textContent = context.driver.name;
    document.getElementById('companyName').textContent = context.company.name;
    const detail = location.pathname.match(/^\/driver\/commandes\/(\d+)$/);
    if (detail) return await renderDetail(detail[1]);
    return await renderList();
  } catch (error) {
    renderError(error);
  }
}
start();
