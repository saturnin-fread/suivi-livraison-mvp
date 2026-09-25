// Briques partagées des pages client : en-tête, icônes, champ GPS, photos.
(function () {
  // Icônes Lucide (ISC).
  const ICONS = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    locate: '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
    bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
    car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
    lock: '<circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
  };
  function icon(name, extraClass) {
    return `<svg class="ic${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '·';
    const first = parts[0][0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase();
  }

  function isCar(vehicleType) {
    return /v[ée]hic|voit|car|auto|camion|truck/i.test(String(vehicleType || ''));
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function renderHeader(root, companyName, rightHtml) {
    const name = String(companyName || '').trim() || 'Livraison';
    root.innerHTML = `<div class="cl-brand"><span class="cl-brand-mark" aria-hidden="true">${esc(name[0].toUpperCase())}</span><span class="cl-brand-name">${esc(name)}</span></div><div class="cl-head-right">${rightHtml || ''}</div>`;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  // Jeton de la demande : /demande/:token ou /demande/:token/confirmation.
  function requestTokenFromPath() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'demande' ? (parts[1] || '') : '';
  }

  // ---- Champ GPS (obligatoire) avec épingle ajustable -------------------
  function createGpsField(root, { initial, onChange } = {}) {
    let position = initial && Number.isFinite(Number(initial.latitude)) ? {
      latitude: Number(initial.latitude), longitude: Number(initial.longitude),
      accuracy: initial.accuracy == null ? null : Number(initial.accuracy),
    } : null;
    let map = null;
    let marker = null;
    let busy = false;
    let error = '';

    root.innerHTML = `<div class="cl-gps" id="gpsBox" role="group" aria-labelledby="gpsTitle">
        <div class="cl-gps-text"><strong id="gpsTitle">Position GPS *</strong><span id="gpsSub" aria-live="polite"></span></div>
        <button type="button" class="cl-btn outline sm" id="gpsBtn"></button>
      </div>
      <div class="cl-gps-map" id="gpsMap" hidden aria-label="Carte : déplacez l’épingle si besoin"></div>
      <p class="cl-hint" id="gpsHint"></p>`;
    const box = root.querySelector('#gpsBox');
    const sub = root.querySelector('#gpsSub');
    const button = root.querySelector('#gpsBtn');
    const mapEl = root.querySelector('#gpsMap');
    const hint = root.querySelector('#gpsHint');

    function paint() {
      box.classList.toggle('ok', Boolean(position) && !error);
      box.classList.toggle('err', Boolean(error));
      if (busy) sub.textContent = 'Recherche de votre position…';
      else if (error) sub.textContent = error;
      else if (position) {
        sub.textContent = position.accuracy != null
          ? `Position partagée · précision d’environ ${Math.round(position.accuracy)} m`
          : 'Position partagée · ajustée sur la carte';
      } else sub.textContent = 'Partagez votre position depuis le lieu de livraison.';
      button.textContent = busy ? 'Localisation…' : position ? 'Actualiser' : 'Partager ma position';
      button.disabled = busy;
      hint.textContent = position ? 'Si l’épingle n’est pas au bon endroit, déplacez-la sur la carte.' : 'Requis pour envoyer votre demande.';
      mapEl.hidden = !position;
    }

    function showMap() {
      if (!position || typeof window.L === 'undefined') return;
      const latLng = [position.latitude, position.longitude];
      mapEl.hidden = false;
      if (!map) {
        map = L.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(latLng, 17);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
        marker = L.marker(latLng, { draggable: true, keyboard: true, title: 'Point de livraison' }).addTo(map);
        marker.on('dragend', () => {
          const point = marker.getLatLng();
          position = { latitude: point.lat, longitude: point.lng, accuracy: null };
          error = '';
          paint();
          if (onChange) onChange(position);
        });
      } else {
        marker.setLatLng(latLng);
        map.setView(latLng, 17);
      }
      setTimeout(() => map.invalidateSize(), 60);
    }

    function locate() {
      if (!navigator.geolocation) {
        error = 'La localisation n’est pas disponible sur cet appareil.';
        paint();
        return;
      }
      busy = true;
      error = '';
      paint();
      navigator.geolocation.getCurrentPosition((result) => {
        busy = false;
        position = { latitude: result.coords.latitude, longitude: result.coords.longitude, accuracy: result.coords.accuracy };
        paint();
        showMap();
        if (onChange) onChange(position);
      }, (failure) => {
        busy = false;
        error = failure && failure.code === 1
          ? 'Accès refusé. Autorisez la localisation dans votre navigateur, puis réessayez.'
          : failure && failure.code === 3
            ? 'La recherche a pris trop de temps. Réessayez à l’extérieur ou près d’une fenêtre.'
            : 'Position introuvable. Vérifiez que la localisation du téléphone est activée.';
        paint();
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    }

    button.addEventListener('click', locate);
    paint();
    if (position) showMap();
    return { get: () => position, focus: () => button.focus() };
  }

  // ---- Photos : compression locale puis envoi binaire ------------------
  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* repli <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // JPEG ≤ ~650 Ko (le serveur accepte 700 Ko), côté long ≤ 1600 px.
  async function compressImage(file) {
    if (!/^image\//.test(file.type)) throw new Error('Ce fichier n’est pas une image.');
    const source = await loadBitmap(file);
    const width = source.width || source.naturalWidth;
    const height = source.height || source.naturalHeight;
    let scale = Math.min(1, 1600 / Math.max(width, height));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      const quality = attempt < 3 ? 0.82 - attempt * 0.1 : 0.6;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 650 * 1024) return blob;
      if (attempt >= 2) scale *= 0.8;
    }
    throw new Error('Cette photo est trop lourde, même après compression.');
  }

  function uploadPhoto(token, editToken, blob) {
    return fetchJson(`/api/public/requests/${encodeURIComponent(token)}/photos`, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Edit-Token': editToken }, body: blob,
    }).then((result) => {
      if (!result.ok) throw new Error(result.data.error || 'Envoi de la photo impossible.');
      return result.data.id;
    });
  }

  function deletePhoto(token, editToken, id) {
    return fetchJson(`/api/public/requests/${encodeURIComponent(token)}/photos/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'X-Edit-Token': editToken },
    }).then((result) => {
      if (!result.ok) throw new Error(result.data.error || 'Suppression impossible.');
    });
  }

  // items : [{ id?, url, blob? }]. onAdd(item) peut envoyer la photo et
  // renseigner item.id ; onRemove(item) peut la supprimer côté serveur.
  function createPhotoPicker(root, { max = 3, items = [], onAdd, onRemove, onError } = {}) {
    const list = items.map((item) => ({ ...item }));
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.hidden = true;

    function render() {
      root.innerHTML = `<div class="cl-photos">${list.map((item, index) => `<div class="cl-photo${item.busy ? ' busy' : ''}"><img src="${esc(item.url)}" alt="Photo du lieu ${index + 1}" /><button type="button" class="cl-photo-del" data-i="${index}" aria-label="Retirer la photo ${index + 1}"${item.busy ? ' disabled' : ''}>${icon('x')}</button></div>`).join('')}${list.length < max ? `<button type="button" class="cl-photo-add" aria-label="Ajouter une photo">${icon('plus')}</button>` : ''}</div>`;
      root.appendChild(input);
      const add = root.querySelector('.cl-photo-add');
      if (add) add.addEventListener('click', () => input.click());
      root.querySelectorAll('.cl-photo-del').forEach((button) => button.addEventListener('click', async () => {
        const item = list[Number(button.dataset.i)];
        if (!item) return;
        item.busy = true;
        render();
        try {
          if (onRemove) await onRemove(item);
          list.splice(list.indexOf(item), 1);
          if (item.blob && item.url) URL.revokeObjectURL(item.url);
        } catch (failure) {
          item.busy = false;
          if (onError) onError(failure.message);
        }
        render();
      }));
    }

    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []).slice(0, Math.max(0, max - list.length));
      input.value = '';
      for (const file of files) {
        let item = null;
        try {
          const blob = await compressImage(file);
          item = { blob, url: URL.createObjectURL(blob), busy: Boolean(onAdd) };
          list.push(item);
          render();
          if (onAdd) await onAdd(item);
          item.busy = false;
        } catch (failure) {
          if (item) {
            list.splice(list.indexOf(item), 1);
            URL.revokeObjectURL(item.url);
          }
          if (onError) onError(failure.message);
        }
        render();
      }
    });

    render();
    return { items: () => list };
  }

  // ---- Champs du formulaire (création et modification) -----------------
  function requestFieldsHtml(d = {}) {
    const v = (key) => esc(d[key] || '');
    return `
      <section class="cl-sec">
        <div class="cl-sec-head"><span class="cl-sec-num">01</span><h2 class="cl-sec-title">Vos coordonnées</h2></div>
        <div class="cl-row">
          <div class="cl-field"><label for="f-name">Nom et prénom *</label><input class="cl-input" id="f-name" name="customerName" autocomplete="name" required value="${v('customer_name')}" /></div>
          <div class="cl-field"><label for="f-phone">Téléphone *</label><input class="cl-input" id="f-phone" name="customerPhone" type="tel" inputmode="tel" autocomplete="tel" required value="${v('customer_phone')}" /><p class="cl-hint">Pour vous joindre à l’arrivée.</p></div>
        </div>
      </section>
      <section class="cl-sec">
        <div class="cl-sec-head"><span class="cl-sec-num">02</span><h2 class="cl-sec-title">Lieu de livraison</h2></div>
        <div class="cl-field"><label for="f-zone">Quartier ou zone *</label><input class="cl-input" id="f-zone" name="neighborhood" required placeholder="Ex. Akpakpa, Cotonou" value="${v('neighborhood')}" /></div>
        <div class="cl-field"><label for="f-landmark">Repère <em>(facultatif)</em></label><input class="cl-input" id="f-landmark" name="landmark" placeholder="Ex. portail vert, près de la pharmacie" value="${v('landmark')}" /></div>
        <div class="cl-field" id="gpsField"></div>
        <div class="cl-field"><label for="f-time">Créneau souhaité <em>(facultatif)</em></label><input class="cl-input" id="f-time" name="requestedTime" placeholder="Ex. 15 h – 17 h" value="${v('requested_time')}" /></div>
        <div class="cl-field"><label for="f-notes">Consigne pour le livreur <em>(facultatif)</em></label><textarea class="cl-input" id="f-notes" name="notes" placeholder="Ex. appelez à votre arrivée">${v('notes')}</textarea></div>
        <div class="cl-field"><span class="cl-label">Ajouter des photos du lieu <em>(facultatif · 3 maximum)</em></span><div id="photoField"></div></div>
      </section>`;
  }

  function readFields(form) {
    const data = Object.fromEntries(new FormData(form));
    Object.keys(data).forEach((key) => { data[key] = String(data[key] || '').trim(); });
    return data;
  }

  // Signale les champs obligatoires vides ; renvoie le premier fautif.
  function firstMissing(form) {
    let first = null;
    form.querySelectorAll('[required]').forEach((field) => {
      const empty = !String(field.value || '').trim();
      field.setAttribute('aria-invalid', empty ? 'true' : 'false');
      if (empty && !first) first = field;
    });
    return first;
  }

  window.TraxoClient = {
    icon, esc, initials, isCar, formatTime, renderHeader, fetchJson, requestTokenFromPath,
    createGpsField, createPhotoPicker, compressImage, uploadPhoto, deletePhoto,
    requestFieldsHtml, readFields, firstMissing,
  };
})();
