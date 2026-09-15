const page = document.getElementById('driverPage');
const connectivity = document.getElementById('driverConnectivity');
const connectivityTitle = document.getElementById('connectivityTitle');
const connectivityDetail = document.getElementById('connectivityDetail');
const syncButton = document.getElementById('syncDriverActions');
const outbox = document.getElementById('driverOutbox');
let context;
let queueOwner;
let syncInProgress = false;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[character]));
const formatDate = (value) => value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const formatDateOnly = (value) => value ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`)) : '—';
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
const runStatusLabels = { planned: 'Planifiée', active: 'En cours' };

function badge(status) {
  const type = status === 'Livrée' ? 'success' : ['Échec', 'Retour', 'Retournée', 'Annulée'].includes(status) ? 'danger' : ['Arrivée'].includes(status) ? 'warning' : '';
  return `<span class="badge ${type}">${escapeHtml(status)}</span>`;
}

function actionKey(prefix) {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

async function canvasBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function compressedPhoto(file) {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('Choisissez une photo JPEG ou PNG.');
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let quality = 0.82;
  let blob = await canvasBlob(canvas, 'image/jpeg', quality);
  while (blob && blob.size > 1100 * 1024 && quality > 0.45) {
    quality -= 0.1;
    blob = await canvasBlob(canvas, 'image/jpeg', quality);
  }
  if (!blob || blob.size > 1200 * 1024) throw new Error('La photo reste trop lourde. Recadrez-la ou réduisez sa résolution.');
  return blob;
}

async function uploadEvidence(orderId, type, blob, resultId) {
  requireOnline('Les preuves ne sont pas conservées sur le téléphone. Reconnectez-vous pour les envoyer.');
  const form = new FormData();
  form.append('file', blob, type === 'photo' ? 'preuve.jpg' : 'signature.png');
  form.append('idempotencyKey', actionKey(`driver-evidence-${type}`));
  const response = await fetch(`/api/driver/orders/${encodeURIComponent(orderId)}/evidence/${type}`, { method: 'POST', body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Impossible d’enregistrer la preuve.');
  document.getElementById(resultId).innerHTML = '<div class="notice success">Preuve enregistrée.</div>';
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...options });
  } catch (error) {
    error.networkFailure = true;
    throw error;
  }
  if (response.status === 401) {
    location.href = '/app/login';
    const error = new Error('Session expirée.');
    error.status = 401;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Une erreur est survenue.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function requireOnline(message = 'Cette action nécessite une connexion internet.') {
  if (!navigator.onLine) throw new Error(message);
}

function queueLabel(item) {
  return item.type === 'transition'
    ? `Étape « ${item.payload.toStatus} » — commande n° ${item.orderId}`
    : `Incident — commande n° ${item.orderId}`;
}

async function requestBackgroundSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if ('sync' in registration) await registration.sync.register('delivery-driver-sync');
  } catch (_error) {
    // La synchronisation manuelle et l’événement online restent disponibles.
  }
}

async function renderQueueState() {
  if (!queueOwner || !window.DriverQueue) return;
  let items;
  try {
    await DriverQueue.purgeExpired(queueOwner);
    items = await DriverQueue.list(queueOwner);
  } catch (_error) {
    connectivity.hidden = false;
    connectivity.classList.remove('online');
    connectivityTitle.textContent = 'Stockage hors ligne indisponible';
    connectivityDetail.textContent = 'Gardez une connexion active pour mettre à jour les livraisons.';
    syncButton.hidden = true;
    return;
  }
  const pending = items.filter((item) => item.status === 'pending').length;
  const attention = items.filter((item) => item.status === 'attention').length;
  const online = navigator.onLine;
  connectivity.hidden = online && items.length === 0;
  connectivity.classList.toggle('online', online && items.length > 0 && attention === 0);
  connectivityTitle.textContent = online ? 'Connexion disponible' : 'Vous êtes hors ligne';
  connectivityDetail.textContent = items.length
    ? `${pending} action${pending > 1 ? 's' : ''} à envoyer${attention ? ` · ${attention} à vérifier` : ''}`
    : 'Les actions sensibles restent bloquées jusqu’au retour du réseau.';
  syncButton.hidden = !online || pending === 0;
  syncButton.disabled = syncInProgress;
  syncButton.textContent = syncInProgress ? 'Synchronisation…' : 'Synchroniser';
  outbox.hidden = items.length === 0;
  outbox.innerHTML = items.length ? `<h2>Actions enregistrées sur ce téléphone</h2>
    <p class="subtitle">Elles sont supprimées après confirmation du serveur, ou automatiquement après 24 h.</p>
    ${items.map((item) => `<article class="outbox-item"><div><strong>${escapeHtml(queueLabel(item))}</strong><small>${escapeHtml(formatDate(item.createdAt))}</small>${item.status === 'attention' ? `<p>${escapeHtml(item.error || 'Cette action doit être vérifiée.')}</p>` : ''}</div><button type="button" data-remove-queued="${escapeHtml(item.idempotencyKey)}">Supprimer</button></article>`).join('')}` : '';
  outbox.querySelectorAll('[data-remove-queued]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Supprimer cette action non synchronisée ? Elle ne sera pas envoyée à l’entreprise.')) return;
    await DriverQueue.remove(button.dataset.removeQueued);
    await renderQueueState();
    const detail = location.pathname.match(/^\/driver\/commandes\/(\d+)$/);
    if (detail) await renderDetail(detail[1]);
  }));
  const pendingOrderIds = new Set(items.filter((item) => item.type === 'transition').map((item) => String(item.orderId)));
  const currentDetail = location.pathname.match(/^\/driver\/commandes\/(\d+)$/);
  if (currentDetail && pendingOrderIds.has(currentDetail[1])) {
    document.querySelectorAll('.transition').forEach((button) => { button.disabled = true; });
  }
}

async function queueAction(type, orderId, url, payload) {
  const queued = await DriverQueue.enqueue({
    type, owner: queueOwner, orderId, url, payload, idempotencyKey: payload.idempotencyKey,
  });
  await requestBackgroundSync();
  await renderQueueState();
  return queued;
}

async function sendOrQueue(type, orderId, url, payload) {
  if (!navigator.onLine) {
    await queueAction(type, orderId, url, payload);
    return { queued: true };
  }
  try {
    return { payload: await api(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }), queued: false };
  } catch (error) {
    if (error.networkFailure || error.status >= 500) {
      await queueAction(type, orderId, url, payload);
      return { queued: true };
    }
    throw error;
  }
}

async function flushQueuedActions() {
  if (!queueOwner || !navigator.onLine || syncInProgress) return;
  syncInProgress = true;
  await renderQueueState();
  try {
    const result = await DriverQueue.flush({ owner: queueOwner });
    await renderQueueState();
    if (result.sent > 0) {
      const target = document.getElementById('transitionResult') || document.getElementById('incidentResult');
      if (target) target.innerHTML = `<div class="notice success">${result.sent} action${result.sent > 1 ? 's' : ''} confirmée${result.sent > 1 ? 's' : ''} par le serveur.</div>`;
      const detail = location.pathname.match(/^\/driver\/commandes\/(\d+)$/);
      if (detail) await renderDetail(detail[1]); else await renderList();
    }
  } finally {
    syncInProgress = false;
    await renderQueueState();
  }
}

function renderError(error) {
  page.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
}

async function renderList() {
  const history = new URLSearchParams(location.search).get('scope') === 'history';
  document.querySelectorAll('.driver-nav a').forEach((link) => link.classList.remove('active'));
  document.getElementById(history ? 'historyLink' : 'activeLink').classList.add('active');
  const [orders, runs] = await Promise.all([
    api(`/api/driver/orders?scope=${history ? 'history' : 'active'}`),
    history ? Promise.resolve([]) : api('/api/driver/runs'),
  ]);
  const scheduledOrderIds = new Set(runs.flatMap((run) => run.stops.map((stop) => String(stop.order_id))));
  const unscheduledOrders = history ? orders : orders.filter((order) => !scheduledOrderIds.has(String(order.id)));
  const runMarkup = runs.map((run) => `<article class="run-manifest card">
    <div class="run-manifest-head"><div><span class="eyebrow">Tournée du ${escapeHtml(formatDateOnly(run.service_date))}</span><h2>${escapeHtml(run.name)}</h2></div>${badge(runStatusLabels[run.status] || run.status)}</div>
    <div class="run-progress" role="status" aria-label="${escapeHtml(`${run.completedStops} arrêts terminés sur ${run.totalStops}`)}"><span style="width:${run.totalStops ? Math.round((run.completedStops / run.totalStops) * 100) : 0}%"></span></div>
    <p class="subtitle">${escapeHtml(run.completedStops)} sur ${escapeHtml(run.totalStops)} arrêt${run.totalStops > 1 ? 's' : ''} terminé${run.completedStops > 1 ? 's' : ''}. L’ordre est opérationnel et ne constitue pas encore une estimation routière.</p>
    <ol class="run-stop-list">${run.stops.map((stop) => {
      const isNext = String(stop.id) === String(run.nextStopId);
      return `<li class="run-stop ${isNext ? 'next' : ''}" ${isNext ? 'aria-current="step"' : ''}><a href="/driver/commandes/${escapeHtml(stop.order_id)}"><span class="stop-number">${escapeHtml(stop.sequence)}</span><span class="stop-copy"><strong>${escapeHtml(stop.customer_name || 'Client')}</strong><small>${escapeHtml(stop.neighborhood || stop.landmark || stop.delivery_address || 'Destination à préciser')} · ${escapeHtml(stop.requested_time || 'Créneau non précisé')}</small>${isNext ? '<em>Prochain arrêt prévu</em>' : ''}</span>${badge(stop.order_status)}</a></li>`;
    }).join('')}</ol>
  </article>`).join('');
  page.innerHTML = `<div class="driver-title"><h1>${history ? 'Historique' : 'Mes livraisons'}</h1><p class="subtitle">${history ? 'Commandes terminées qui vous étaient affectées.' : 'Vos tournées planifiées, puis les commandes encore hors tournée.'}</p></div>
    ${runMarkup ? `<section class="run-manifests" aria-label="Tournées planifiées">${runMarkup}</section>` : ''}
    ${!history && runMarkup ? '<div class="driver-subtitle"><h2>Hors tournée</h2><p class="subtitle">Commandes affectées mais pas encore placées dans une tournée visible.</p></div>' : ''}
    <section class="delivery-list">${unscheduledOrders.length ? unscheduledOrders.map((order) => `<a class="delivery-card" href="/driver/commandes/${escapeHtml(order.id)}">
      <div class="delivery-card-head"><div><h2>${escapeHtml(order.customer_name || 'Client')}</h2><p>Commande n° ${escapeHtml(order.id)}</p></div>${badge(order.status)}</div>
      <p><strong>${escapeHtml(order.neighborhood || order.delivery_address || 'Destination à préciser')}</strong>${order.landmark ? ` · ${escapeHtml(order.landmark)}` : ''}</p>
      <p>${escapeHtml(order.requested_time || 'Créneau non précisé')}${order.expected_amount_minor != null ? ` · À encaisser : ${escapeHtml(formatMoney(order.expected_amount_minor, order.payment_currency))}` : ''}</p>
    </a>`).join('') : `<div class="card empty">${history ? 'Aucune livraison terminée.' : runMarkup ? 'Toutes vos livraisons actives sont classées dans les tournées ci-dessus.' : 'Aucune livraison active ne vous est affectée.'}</div>`}</section>`;
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
  const evidenceByType = Object.fromEntries((order.evidence || []).map((item) => [item.evidence_type, item]));
  const canAddEvidence = ['En livraison', 'Arrivée'].includes(order.status);
  const missingRequiredEvidence = [
    order.photo_proof_mode === 'required' && !evidenceByType.photo ? 'photo' : null,
    order.signature_proof_mode === 'required' && !evidenceByType.signature ? 'signature' : null,
  ].filter(Boolean);
  page.innerHTML = `<a class="driver-back" href="/driver">← Mes livraisons</a>
    <div class="page-header"><div><h1>${escapeHtml(order.customer_name || 'Client')}</h1><p class="subtitle">Commande n° ${escapeHtml(order.id)}</p></div>${badge(order.status)}</div>
    ${order.run ? `<section class="card run-context ${String(order.run.next_order_id) === String(order.id) ? 'next' : ''}"><span class="eyebrow">${escapeHtml(runStatusLabels[order.run.status] || order.run.status)} · ${escapeHtml(formatDateOnly(order.run.service_date))}</span><h2>${escapeHtml(order.run.name)}</h2><p>Arrêt ${escapeHtml(order.run.sequence)} sur ${escapeHtml(order.run.total_stops)}.${String(order.run.next_order_id) === String(order.id) ? ' C’est le prochain arrêt prévu.' : ' Un arrêt précédent peut encore être en attente.'}</p><p class="subtitle">L’ordre peut être adapté sur le terrain si nécessaire ; chaque commande conserve son propre statut et ses preuves.</p></section>` : ''}
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
    ${(order.photo_proof_mode !== 'off' || order.signature_proof_mode !== 'off') ? `<section class="card driver-section"><h2>Preuves complémentaires</h2><p class="subtitle">Photographiez le colis ou le lieu sans visage ni document d’identité. Demandez l’accord avant une signature.</p><div class="evidence-grid">${order.photo_proof_mode !== 'off' ? `<article class="evidence-card"><strong>Photo ${order.photo_proof_mode === 'required' ? '— obligatoire' : '— facultative'}</strong>${evidenceByType.photo ? `<img src="/api/driver/evidence/${escapeHtml(evidenceByType.photo.id)}" alt="Photo de remise" /><small>Déjà enregistrée. Une nouvelle photo la remplacera.</small>` : '<div class="evidence-empty">Aucune photo</div>'}${canAddEvidence ? '<label class="button secondary evidence-picker">Prendre ou choisir une photo<input id="photoEvidence" type="file" accept="image/jpeg,image/png" capture="environment" hidden /></label>' : ''}<div id="photoEvidenceResult"></div></article>` : ''}${order.signature_proof_mode !== 'off' ? `<article class="evidence-card"><strong>Signature ${order.signature_proof_mode === 'required' ? '— obligatoire' : '— facultative'}</strong>${evidenceByType.signature ? `<img src="/api/driver/evidence/${escapeHtml(evidenceByType.signature.id)}" alt="Signature du destinataire" /><small>Déjà enregistrée. Une nouvelle signature la remplacera.</small>` : ''}${canAddEvidence ? '<canvas id="signatureCanvas" class="signature-canvas" width="600" height="260" aria-label="Zone de signature"></canvas><div class="driver-actions"><button class="secondary" id="clearSignature" type="button">Effacer</button><button class="primary" id="saveSignature" type="button">Enregistrer</button></div>' : ''}<div id="signatureEvidenceResult"></div></article>` : ''}</div></section>` : ''}
    ${canVerifyOtp ? `<section class="card driver-section"><h2>Confirmer la remise</h2><p>Demandez au client le code à 6 chiffres reçu pour cette commande.</p><p class="subtitle">Le portail livreur n’affiche et ne génère jamais ce code.</p>${hasActiveOtp ? `<div class="notice success">Un code est actif jusqu’au ${escapeHtml(formatDate(order.active_otp_expires_at))}.</div>` : '<div class="notice warning">Aucun code actif. Demandez à l’exploitation d’en générer un pour le client.</div>'}${paymentBlocksDelivery ? '<div class="notice error">La remise est bloquée tant que l’encaissement ou son écart n’est pas finalisé.</div>' : ''}${missingRequiredEvidence.length ? `<div class="notice error">Preuve obligatoire manquante : ${escapeHtml(missingRequiredEvidence.join(' et '))}.</div>` : ''}<form id="otpForm" class="driver-form"><div class="field"><label>Code donné par le client</label><input name="code" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="000000" required /></div><button class="primary" ${!hasActiveOtp || paymentBlocksDelivery || missingRequiredEvidence.length ? 'disabled' : ''}>Valider la remise au client</button></form><div id="otpResult"></div></section>` : ''}
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
      const payload = { toStatus, reason, idempotencyKey: actionKey('driver-transition') };
      const result = await sendOrQueue('transition', id, `/api/driver/orders/${encodeURIComponent(id)}/transition`, payload);
      if (result.queued) {
        document.getElementById('transitionResult').innerHTML = '<div class="notice warning">Action enregistrée sur ce téléphone. Elle reste en attente de confirmation du serveur.</div>';
      } else await renderDetail(id);
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
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"], button:not([type])');
      button.disabled = true;
      form.dataset.actionKey ||= actionKey('driver-payment');
      try {
        requireOnline('Un encaissement doit être confirmé immédiatement par le serveur. Reconnectez-vous avant de continuer.');
        const payload = Object.fromEntries(new FormData(form));
        payload.idempotencyKey = form.dataset.actionKey;
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
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    form.dataset.actionKey ||= actionKey('driver-otp');
    try {
      requireOnline('Le code de remise doit être vérifié en direct. Reconnectez-vous avant de continuer.');
      const payload = Object.fromEntries(new FormData(form));
      payload.idempotencyKey = form.dataset.actionKey;
      await api(`/api/driver/orders/${encodeURIComponent(id)}/otp/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      await renderDetail(id);
    } catch (error) {
      document.getElementById('otpResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      form.dataset.actionKey = '';
      button.disabled = false;
    }
  });

  const photoInput = document.getElementById('photoEvidence');
  if (photoInput) photoInput.addEventListener('change', async () => {
    const result = document.getElementById('photoEvidenceResult');
    const picker = photoInput.closest('label');
    picker.style.pointerEvents = 'none';
    result.innerHTML = '<div class="notice">Compression et envoi…</div>';
    try {
      requireOnline('La photo ne sera pas conservée localement. Reconnectez-vous pour l’envoyer.');
      const blob = await compressedPhoto(photoInput.files[0]);
      await uploadEvidence(id, 'photo', blob, 'photoEvidenceResult');
      await renderDetail(id);
    } catch (error) {
      result.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      picker.style.pointerEvents = '';
    }
  });

  const signatureCanvas = document.getElementById('signatureCanvas');
  if (signatureCanvas) {
    const drawing = signatureCanvas.getContext('2d');
    drawing.lineWidth = 4;
    drawing.lineCap = 'round';
    drawing.strokeStyle = '#172033';
    let active = false;
    let signed = false;
    const point = (event) => {
      const rect = signatureCanvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * (signatureCanvas.width / rect.width), y: (event.clientY - rect.top) * (signatureCanvas.height / rect.height) };
    };
    signatureCanvas.addEventListener('pointerdown', (event) => { active = true; signed = true; signatureCanvas.setPointerCapture(event.pointerId); const p = point(event); drawing.beginPath(); drawing.moveTo(p.x, p.y); });
    signatureCanvas.addEventListener('pointermove', (event) => { if (!active) return; const p = point(event); drawing.lineTo(p.x, p.y); drawing.stroke(); });
    signatureCanvas.addEventListener('pointerup', () => { active = false; });
    document.getElementById('clearSignature').addEventListener('click', () => { drawing.clearRect(0, 0, signatureCanvas.width, signatureCanvas.height); signed = false; });
    document.getElementById('saveSignature').addEventListener('click', async (event) => {
      if (!signed) return document.getElementById('signatureEvidenceResult').innerHTML = '<div class="notice error">Faites signer dans la zone avant d’enregistrer.</div>';
      event.currentTarget.disabled = true;
      try {
        requireOnline('La signature ne sera pas conservée localement. Reconnectez-vous pour l’envoyer.');
        const blob = await canvasBlob(signatureCanvas);
        await uploadEvidence(id, 'signature', blob, 'signatureEvidenceResult');
        await renderDetail(id);
      } catch (error) {
        document.getElementById('signatureEvidenceResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
        event.currentTarget.disabled = false;
      }
    });
  }

  document.getElementById('incidentForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      payload.idempotencyKey = actionKey('driver-incident');
      const result = await sendOrQueue('incident', id, `/api/driver/orders/${encodeURIComponent(id)}/incidents`, payload);
      if (result.queued) {
        form.reset();
        document.getElementById('incidentResult').innerHTML = '<div class="notice warning">Incident enregistré sur ce téléphone. Il sera envoyé après reconnexion.</div>';
        button.disabled = false;
      } else await renderDetail(id);
    } catch (error) {
      document.getElementById('incidentResult').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      button.disabled = false;
    }
  });
}

async function start() {
  try {
    context = await api('/api/driver/context');
    queueOwner = `${context.company.id}:${context.user.id}:${context.driver.id}`;
    await DriverQueue.resumeSessionItems(queueOwner);
    document.getElementById('driverName').textContent = context.driver.name;
    document.getElementById('companyName').textContent = context.company.name;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/driver-sw.js', { scope: '/' }).catch(() => {});
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'driver-sync-requested') flushQueuedActions();
      });
    }
    window.addEventListener('online', flushQueuedActions);
    window.addEventListener('offline', renderQueueState);
    syncButton.addEventListener('click', flushQueuedActions);
    document.querySelector('.driver-header form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const items = await DriverQueue.list(queueOwner);
        if (items.length && !confirm(`${items.length} action${items.length > 1 ? 's' : ''} non synchronisée${items.length > 1 ? 's' : ''} sera${items.length > 1 ? 'ont' : ''} abandonnée${items.length > 1 ? 's' : ''}. Se déconnecter quand même ?`)) return;
        await DriverQueue.clearOwner(queueOwner);
      } catch (_error) { /* La session serveur sera tout de même fermée. */ }
      event.currentTarget.submit();
    });
    const detail = location.pathname.match(/^\/driver\/commandes\/(\d+)$/);
    if (detail) await renderDetail(detail[1]); else await renderList();
    await renderQueueState();
    if (navigator.onLine) await flushQueuedActions();
  } catch (error) {
    renderError(error);
  }
}
start();
