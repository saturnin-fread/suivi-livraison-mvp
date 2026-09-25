// Parcours client de bout en bout : accès lié à l'appareil (cookie HttpOnly),
// téléphone validé avec indicatif, GPS obligatoire, photos (3 max), validation
// sans livreur qui verrouille, puis affectation et accès au suivi.
const crypto = require('node:crypto');
const { Pool } = require('pg');

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

  const context = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: cookie } }));
  ensure(/^https?:\/\//.test(context.payload.publicBaseUrl || ''), 'Le domaine canonique des liens doit être exposé.');
  const created = await json(await fetch(`${baseUrl}/api/app/request-links`, { method: 'POST', headers: { Cookie: cookie } }));
  ensure(created.response.status === 201 && created.payload.token, 'Création du formulaire impossible.');
  ensure(created.payload.url === `${context.payload.publicBaseUrl}/demande/${created.payload.token}`, 'Le lien partagé doit utiliser le domaine canonique.');
  const token = created.payload.token;
  const publicUrl = `${baseUrl}/api/public/requests/${encodeURIComponent(token)}`;
  const form = { customerName: 'Koffi Adéola', customerPhone: '01 97 12 34 56', customerPhoneCountry: 'BJ', neighborhood: 'Akpakpa, Cotonou', landmark: 'Portail vert', requestedTime: '15 h – 17 h', notes: 'Appelez à votre arrivée.' };
  const gps = { locationLat: 6.3703, locationLng: 2.4526, locationAccuracy: 12 };
  const post = (body) => fetch(publicUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // 1. Refus : sans GPS, ancien numéro béninois à 8 chiffres.
  ensure((await post(form)).status === 400, 'L’envoi sans GPS devait être refusé.');
  const oldNumber = await json(await post({ ...form, ...gps, customerPhone: '97123456' }));
  ensure(oldNumber.response.status === 400 && oldNumber.payload.field === 'customerPhone', 'Un numéro béninois à 8 chiffres (ancien plan) doit être refusé.');

  // 2. Envoi (numéro saisi avec l'indicatif collé, sans « + » : reconnu et
  // normalisé) : cookie d'appareil strict, aucun secret dans l'URL ni la réponse.
  const submitted = await post({ ...form, ...gps, customerPhone: '2290197123456' });
  const submittedBody = await submitted.json();
  ensure(submitted.ok, `Envoi valide refusé (${submitted.status}).`);
  const setCookie = submitted.headers.get('set-cookie') || '';
  ensure(/^traxo_req=/.test(setCookie), 'Cookie d’appareil absent.');
  ensure(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), 'Le cookie doit être HttpOnly et SameSite=Strict.');
  ensure(setCookie.includes(`Path=/api/public/requests/${token}`), 'Le cookie doit être limité au chemin de cette demande.');
  ensure(!submittedBody.redirect.includes('edit=') && !('editToken' in submittedBody), 'Aucun secret ne doit être renvoyé ni placé dans l’URL.');
  let device = setCookie.split(';')[0];
  const asDevice = (extra = {}) => ({ Cookie: device, ...extra });

  // 3. Un autre appareil avec le même lien ne voit rien.
  const stranger = await json(await fetch(publicUrl));
  ensure(stranger.payload.stage === 'other_device', 'Un autre appareil doit être reconnu comme tel.');
  const leaked = JSON.stringify(stranger.payload);
  ensure(!leaked.includes('Koffi') && !leaked.includes('97 12') && !leaked.includes('6.37'), 'Aucune donnée personnelle ne doit fuiter vers un autre appareil.');
  const forged = await json(await fetch(publicUrl, { headers: { Cookie: 'traxo_req=faux-secret' } }));
  ensure(forged.payload.stage === 'other_device', 'Un faux cookie ne doit rien ouvrir.');

  // 4. L'appareil d'origine : données complètes, téléphone normalisé.
  const received = await json(await fetch(publicUrl, { headers: asDevice() }));
  ensure(received.payload.stage === 'received' && received.payload.canEdit === true, 'La demande reçue doit rester modifiable sur l’appareil d’origine.');
  ensure(received.payload.customer_phone === '+229 01 97 12 34 56', `Téléphone mal normalisé : ${received.payload.customer_phone}`);
  ensure(received.payload.phone_country === 'BJ' && received.payload.phone_national === '01 97 12 34 56', 'Découpage indicatif / numéro incorrect pour le formulaire de modification.');

  // 5. Photos : cookie exigé, signature vérifiée, plafond de 3, lecture réservée.
  const photoUrl = `${publicUrl}/photos`;
  const upload = (body, headers = {}) => fetch(photoUrl, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...headers }, body });
  ensure((await upload(tinyJpeg)).status === 403, 'Une photo sans cookie d’appareil doit être refusée.');
  ensure((await upload(Buffer.from('pas une image, juste du texte'), asDevice())).status === 400, 'Un faux JPEG doit être refusé.');
  const photoIds = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await json(await upload(tinyJpeg, asDevice()));
    ensure(result.response.status === 201 && result.payload.id, `Photo ${i + 1} refusée (${result.response.status}).`);
    photoIds.push(result.payload.id);
  }
  ensure((await upload(tinyJpeg, asDevice())).status === 409, 'Une 4e photo doit être refusée.');
  ensure((await fetch(`${photoUrl}/${photoIds[2]}`, { method: 'DELETE', headers: asDevice() })).ok, 'Suppression de photo impossible.');
  const image = await fetch(`${photoUrl}/${photoIds[0]}`, { headers: asDevice() });
  ensure(image.ok && image.headers.get('content-type') === 'image/jpeg' && image.headers.get('x-content-type-options') === 'nosniff', 'Lecture de la photo par le client invalide.');
  ensure((await fetch(`${photoUrl}/${photoIds[0]}`)).status === 404, 'Un autre appareil ne doit pas pouvoir lire les photos.');

  // 6. Modification : cookie exigé, GPS exigé, téléphone revalidé.
  const put = (body, headers = {}) => fetch(publicUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  ensure((await put({ ...form, ...gps, version: received.payload.version })).status === 403, 'Une modification sans cookie doit être refusée.');
  ensure((await put({ ...form, version: received.payload.version }, asDevice())).status === 400, 'Une modification sans GPS doit être refusée.');
  const edited = await json(await put({ ...form, ...gps, customerPhone: '+228 90 12 34 56', customerPhoneCountry: 'TG', landmark: 'Portail vert, près de la pharmacie', version: received.payload.version }, asDevice()));
  ensure(edited.response.ok, `Modification avant validation refusée (${edited.response.status}).`);
  const afterEdit = await json(await fetch(publicUrl, { headers: asDevice() }));
  ensure(afterEdit.payload.customer_phone === '+228 90 12 34 56' && afterEdit.payload.phone_country === 'TG', 'Un numéro étranger saisi avec « + » doit être reconnu.');

  // 7. Anciens liens « ?edit=… » : échange unique contre un cookie, puis lien inutile.
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const legacy = crypto.randomBytes(24).toString('base64url');
    await pool.query('UPDATE customer_requests SET edit_token_hash = $1 WHERE token = $2', [crypto.createHash('sha256').update(legacy).digest('hex'), token]);
    const swapped = await fetch(`${publicUrl}?edit=${encodeURIComponent(legacy)}`);
    const swappedBody = await swapped.json();
    ensure(swappedBody.stage === 'received' && /^traxo_req=/.test(swapped.headers.get('set-cookie') || ''), 'Un ancien lien doit être échangé contre un cookie.');
    const replay = await json(await fetch(`${publicUrl}?edit=${encodeURIComponent(legacy)}`));
    ensure(replay.payload.stage === 'other_device', 'Un ancien lien déjà utilisé (copié) ne doit plus rien ouvrir.');
    ensure((await json(await fetch(publicUrl, { headers: asDevice() }))).payload.stage === 'other_device', 'L’échange doit invalider l’ancien secret.');
    await pool.end();
    // On poursuit avec le nouveau cookie issu de l'échange.
    device = (swapped.headers.get('set-cookie') || '').split(';')[0];
  }
  const deviceNow = device;

  // 8. Validation SANS livreur : verrouille immédiatement.
  const list = await json(await fetch(`${baseUrl}/api/app/requests`, { headers: { Cookie: cookie } }));
  const requestId = list.payload.find((item) => item.token === token)?.id;
  ensure(requestId, 'Demande absente de la file entreprise.');
  const validated = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}/validate`, { method: 'POST', headers: authed() }));
  ensure(validated.response.ok && validated.payload.status === 'Validée', `Validation sans livreur impossible (${validated.response.status}).`);
  ensure((await fetch(`${baseUrl}/api/app/requests/${requestId}/validate`, { method: 'POST', headers: authed() })).status === 409, 'Une double validation doit être refusée.');
  const current = await json(await fetch(publicUrl, { headers: { Cookie: deviceNow } }));
  ensure(current.payload.stage === 'validated' && current.payload.canEdit === false && current.payload.order === null, 'Après validation : étape « validée », non modifiable, pas encore de suivi.');
  ensure((await put({ ...form, ...gps, version: current.payload.version }, { Cookie: deviceNow })).status === 409, 'La modification après validation doit être bloquée.');
  ensure((await upload(tinyJpeg, { Cookie: deviceNow })).status === 403, 'Ajout de photo après validation doit être bloqué.');

  // 9. Affectation : le même lien donne accès au suivi (sur l'appareil d'origine seulement).
  const drivers = await json(await fetch(`${baseUrl}/api/app/drivers`, { headers: { Cookie: cookie } }));
  const driver = drivers.payload.find((item) => item.active && !['off_duty', 'incident', 'inactive'].includes(item.operationalState));
  ensure(driver, 'Aucun livreur utilisable.');
  const converted = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}/convert`, { method: 'POST', headers: authed(), body: JSON.stringify({ driverId: driver.id }) }));
  ensure(converted.response.status === 201, `Affectation après validation impossible (${converted.response.status}).`);
  const assigned = await json(await fetch(publicUrl, { headers: { Cookie: deviceNow } }));
  ensure(assigned.payload.stage === 'assigned' && assigned.payload.order?.trackingPath === converted.payload.path, 'Le lien de suivi doit être accessible depuis la page de demande.');
  ensure(!JSON.stringify((await json(await fetch(publicUrl))).payload).includes('/suivi/'), 'Le lien de suivi ne doit pas fuiter vers un autre appareil.');

  // 10. Suivi : entreprise, même numéro, heure de validation d'origine.
  const tracking = await json(await fetch(`${baseUrl}${converted.payload.path.replace('/suivi/', '/api/tracking/')}`));
  ensure(tracking.response.ok && tracking.payload.companyName, 'Nom de l’entreprise absent du suivi.');
  ensure(tracking.payload.displayNumber === String(requestId), 'Le suivi doit reprendre le numéro de la demande.');
  ensure(new Date(tracking.payload.steps?.validatedAt).getTime() === new Date(validated.payload.validated_at).getTime(), 'L’étape « Commande validée » doit garder l’heure de validation d’origine.');

  // 11. L'entreprise voit les photos ; la notification ouvre Opérations › Demandes.
  const detail = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}`, { headers: { Cookie: cookie } }));
  ensure(detail.payload.photo_ids?.length === 2, 'Photos absentes de la fiche entreprise.');
  const opsImage = await fetch(`${baseUrl}/api/app/requests/${requestId}/photos/${detail.payload.photo_ids[0]}`, { headers: { Cookie: cookie } });
  ensure(opsImage.ok && opsImage.headers.get('content-type') === 'image/jpeg', 'L’entreprise ne peut pas afficher la photo.');
  ensure((await fetch(`${baseUrl}/api/app/requests/${requestId}/photos/abc`, { headers: { Cookie: cookie } })).status === 404, 'Identifiant de photo invalide mal géré.');
  const pendingLink = await json(await fetch(`${baseUrl}/api/app/request-links`, { method: 'POST', headers: { Cookie: cookie } }));
  await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(pendingLink.payload.token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, ...gps }) });
  const notifications = await json(await fetch(`${baseUrl}/api/app/notifications`, { headers: { Cookie: cookie } }));
  ensure((notifications.payload.items || []).some((item) => item.type === 'requests'), 'Une demande à vérifier doit apparaître dans les notifications.');
  const requestLinks = (notifications.payload.items || []).filter((item) => item.type === 'requests').map((item) => item.href);
  ensure(requestLinks.every((href) => /^\/app\/operations\?vue=demandes&demande=\d+$/.test(href)), `Les notifications de demande doivent ouvrir Opérations › Demandes (${requestLinks.join(', ')}).`);

  console.log('Parcours client réussi : accès lié à l’appareil, téléphone, GPS, photos, validation, verrouillage, affectation et suivi.');
}

run().catch((error) => {
  console.error(`Parcours client échoué : ${error.message}`);
  process.exit(1);
});
