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
    ${order.expected_amount_minor != null ? `<section class="card driver-section"><h2>Encaissement</h2><p><strong>${escapeHtml(formatMoney(order.expected_amount_minor, order.payment_currency))}</strong> attendu à la livraison.</p><p class="subtitle">État : ${escapeHtml(order.payment_status || 'À encaisser')}. La saisie terrain sera ajoutée dans le prochain lot sécurisé.</p></section>` : ''}
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
