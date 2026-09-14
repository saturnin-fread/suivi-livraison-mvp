const page = document.getElementById('page');
const sidebar = document.getElementById('sidebar');
let context;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[character]));

const formatDate = (value) => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

function badge(status) {
  const type = status === 'Confirmée' ? 'success' : status === 'Refusée' ? 'danger' : status === 'À vérifier' ? 'warning' : '';
  return `<span class="badge ${type}">${escapeHtml(status || '—')}</span>`;
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
  page.innerHTML = `<div class="page-header"><div><h1>Commandes</h1><p class="subtitle">Suivez les commandes créées et leurs affectations.</p></div><a class="button primary" href="/app/nouvelle-commande">Nouvelle commande</a></div><section class="card">${orders.length ? `<div class="table-wrap"><table><thead><tr><th>Commande</th><th>Client</th><th>Zone</th><th>Livreur</th><th>Statut</th><th>Suivi</th></tr></thead><tbody>${orders.map((order) => `<tr><td>N° ${escapeHtml(order.id)}<br><small>${escapeHtml(formatDate(order.created_at))}</small></td><td><strong>${escapeHtml(order.customer_name || '—')}</strong><br><small>${escapeHtml(order.customer_phone || '')}</small></td><td>${escapeHtml(order.neighborhood || order.landmark || '—')}</td><td>${escapeHtml(order.driver_name)}</td><td>${badge(order.status)}</td><td>${order.tracking_token ? `<a href="/suivi/${escapeHtml(order.tracking_token)}" target="_blank" rel="noopener">Ouvrir</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucune commande pour le moment.</div>'}</section>`;
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
    activateNavigation();
    const path = location.pathname;
    const detail = path.match(/^\/app\/demandes\/(\d+)$/);
    if (detail) return await renderRequestDetail(detail[1]);
    if (path === '/app') return await renderDashboard();
    if (path === '/app/demandes') return await renderRequests();
    if (path === '/app/nouvelle-commande') return await renderNewOrder();
    if (path === '/app/commandes') return await renderOrders();
    if (path === '/app/carte') return renderPlaceholder('Carte d’exploitation', 'Flotte, destinations et tournées', ['Tous les livreurs autorisés', 'Arrêts et parcours restant', 'Filtres et incidents']);
    if (path === '/app/livreurs') return await renderDrivers();
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
