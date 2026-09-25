// Parcours client de bout en bout : GPS obligatoire, photos (3 max),
// validation sans livreur qui verrouille, puis affectation et accès au suivi
// depuis le même lien de demande.
const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const email = process.env.ADMIN_USER;
const password = process.env.ADMIN_PASSWORD;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response) {
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

// Plus petit JPEG valide (1×1) : suffisant pour la détection par signature.
const tinyJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
  'base64'
);

async function run() {
  ensure(email && password, 'ADMIN_USER et ADMIN_PASSWORD sont requis.');
  const login = await fetch(`${baseUrl}/app/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: email, password }),
  });
  ensure(login.status === 302, `Connexion attendue en 302, reçue ${login.status}.`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const authed = (extra = {}) => ({ Cookie: cookie, 'Content-Type': 'application/json', ...extra });

  const created = await json(await fetch(`${baseUrl}/api/app/request-links`, { method: 'POST', headers: { Cookie: cookie } }));
  ensure(created.response.status === 201 && created.payload.token, 'Création du formulaire impossible.');
  const token = created.payload.token;
  const publicUrl = `${baseUrl}/api/public/requests/${encodeURIComponent(token)}`;
  const form = { customerName: 'Koffi Adéola', customerPhone: '+229 01 97 12 34 56', neighborhood: 'Akpakpa, Cotonou', landmark: 'Portail vert', requestedTime: '15 h – 17 h', notes: 'Appelez à votre arrivée.' };

  // 1. Sans GPS : refusé.
  const noGps = await fetch(publicUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
  ensure(noGps.status === 400, `L'envoi sans GPS devait être refusé (400), reçu ${noGps.status}.`);

  // 2. Avec GPS : accepté, jeton de modification renvoyé.
  const submitted = await json(await fetch(publicUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...form, locationLat: 6.3703, locationLng: 2.4526, locationAccuracy: 12 }),
  }));
  ensure(submitted.response.ok && submitted.payload.editToken, 'Envoi avec GPS impossible ou jeton absent.');
  const editToken = submitted.payload.editToken;

  // 3. Photos : signature vérifiée, jeton exigé, plafond de 3.
  const photoUrl = `${publicUrl}/photos`;
  const upload = (body, headers = {}) => fetch(photoUrl, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...headers }, body });
  ensure((await upload(tinyJpeg)).status === 403, 'Une photo sans jeton de modification doit être refusée.');
  ensure((await upload(Buffer.from('pas une image, juste du texte'), { 'X-Edit-Token': editToken })).status === 400, 'Un faux JPEG doit être refusé.');
  const photoIds = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await json(await upload(tinyJpeg, { 'X-Edit-Token': editToken }));
    ensure(result.response.status === 201 && result.payload.id, `Photo ${i + 1} refusée (${result.response.status}).`);
    photoIds.push(result.payload.id);
  }
  ensure((await upload(tinyJpeg, { 'X-Edit-Token': editToken })).status === 409, 'Une 4e photo doit être refusée.');
  const del = await fetch(`${photoUrl}/${photoIds[2]}`, { method: 'DELETE', headers: { 'X-Edit-Token': editToken } });
  ensure(del.ok, 'Suppression de photo impossible.');
  const image = await fetch(`${photoUrl}/${photoIds[0]}`);
  ensure(image.ok && image.headers.get('content-type') === 'image/jpeg' && image.headers.get('x-content-type-options') === 'nosniff', 'Lecture de la photo par le client invalide.');

  // 4. Page client : étape « reçue », modifiable, entreprise et photos visibles.
  const received = await json(await fetch(`${publicUrl}?edit=${encodeURIComponent(editToken)}`));
  ensure(received.payload.stage === 'received' && received.payload.canEdit === true, 'La demande reçue doit rester modifiable.');
  ensure(received.payload.companyName && received.payload.photoIds.length === 2, 'Nom de l’entreprise ou photos absents de la page client.');
  const noGpsEdit = await fetch(publicUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, editToken, version: received.payload.version }) });
  ensure(noGpsEdit.status === 400, 'Une modification sans GPS doit être refusée.');
  const edited = await json(await fetch(publicUrl, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...form, landmark: 'Portail vert, près de la pharmacie', editToken, version: received.payload.version, locationLat: 6.3703, locationLng: 2.4526 }),
  }));
  ensure(edited.response.ok, `Modification avant validation refusée (${edited.response.status}).`);

  // 5. Validation SANS livreur : verrouille immédiatement.
  const list = await json(await fetch(`${baseUrl}/api/app/requests`, { headers: { Cookie: cookie } }));
  const requestId = list.payload.find((item) => item.token === token)?.id;
  ensure(requestId, 'Demande absente de la file entreprise.');
  const validated = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}/validate`, { method: 'POST', headers: authed() }));
  ensure(validated.response.ok && validated.payload.status === 'Validée', `Validation sans livreur impossible (${validated.response.status}).`);
  const again = await fetch(`${baseUrl}/api/app/requests/${requestId}/validate`, { method: 'POST', headers: authed() });
  ensure(again.status === 409, 'Une double validation doit être refusée.');
  const lockedEdit = await fetch(publicUrl, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...form, editToken, version: edited.payload.version, locationLat: 6.3703, locationLng: 2.4526 }),
  });
  ensure(lockedEdit.status === 409, `La modification après validation doit être bloquée (409), reçu ${lockedEdit.status}.`);
  ensure((await upload(tinyJpeg, { 'X-Edit-Token': editToken })).status === 403, 'Ajout de photo après validation doit être bloqué.');
  const validatedView = await json(await fetch(`${publicUrl}?edit=${encodeURIComponent(editToken)}`));
  ensure(validatedView.payload.stage === 'validated' && validatedView.payload.canEdit === false && validatedView.payload.order === null,
    'Après validation sans livreur : étape « validée », non modifiable, pas encore de suivi.');

  // 6. Affectation : le même lien donne accès au suivi.
  const drivers = await json(await fetch(`${baseUrl}/api/app/drivers`, { headers: { Cookie: cookie } }));
  const driver = drivers.payload.find((item) => item.active && !['off_duty', 'incident', 'inactive'].includes(item.operationalState));
  ensure(driver, 'Aucun livreur utilisable.');
  const converted = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}/convert`, {
    method: 'POST', headers: authed(), body: JSON.stringify({ driverId: driver.id }),
  }));
  ensure(converted.response.status === 201, `Affectation après validation impossible (${converted.response.status}).`);
  const assigned = await json(await fetch(publicUrl));
  ensure(assigned.payload.stage === 'assigned' && assigned.payload.order?.driver?.name === driver.name,
    'La page client doit afficher le livreur affecté.');
  ensure(assigned.payload.order.trackingPath === converted.payload.path, 'Le lien de suivi doit être accessible depuis la page de demande.');

  // 7. Suivi : entreprise, même numéro, étape de validation horodatée à la validation d'origine.
  const tracking = await json(await fetch(`${baseUrl}${converted.payload.path.replace('/suivi/', '/api/tracking/')}`));
  ensure(tracking.response.ok && tracking.payload.companyName === received.payload.companyName, 'Nom de l’entreprise absent du suivi.');
  ensure(tracking.payload.displayNumber === String(requestId), 'Le suivi doit reprendre le numéro de la demande.');
  ensure(tracking.payload.steps?.validatedAt
    && new Date(tracking.payload.steps.validatedAt).getTime() === new Date(validated.payload.validated_at).getTime(),
  'L’étape « Commande validée » doit garder l’heure de validation d’origine.');

  // 8. L'entreprise voit les photos.
  const detail = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}`, { headers: { Cookie: cookie } }));
  ensure(Array.isArray(detail.payload.photo_ids) && detail.payload.photo_ids.length === 2, 'Photos absentes de la fiche entreprise.');
  const opsImage = await fetch(`${baseUrl}/api/app/requests/${requestId}/photos/${detail.payload.photo_ids[0]}`, { headers: { Cookie: cookie } });
  ensure(opsImage.ok && opsImage.headers.get('content-type') === 'image/jpeg', 'L’entreprise ne peut pas afficher la photo.');
  ensure((await fetch(`${baseUrl}/api/app/requests/${requestId}/photos/abc`, { headers: { Cookie: cookie } })).status === 404, 'Identifiant de photo invalide mal géré.');

  console.log('Parcours client réussi : GPS obligatoire, photos, validation sans livreur, verrouillage, affectation et suivi.');
}

run().catch((error) => {
  console.error(`Parcours client échoué : ${error.message}`);
  process.exit(1);
});
