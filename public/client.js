// Briques partagées des pages client : en-tête, icônes, champ GPS, photos.
(function () {
  // Icônes Lucide (ISC).
  const ICONS = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>',
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
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
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

  // Marque de l'entreprise : son logo s'il existe, sinon son initiale.
  function brandMark(name, logoUrl) {
    const safe = typeof logoUrl === 'string' && /^\/brand\/logo\/\d+(\?v=\d+)?$/.test(logoUrl) ? logoUrl : '';
    return safe
      ? `<span class="cl-brand-mark has-logo" aria-hidden="true"><img src="${esc(safe)}" alt=""></span>`
      : `<span class="cl-brand-mark" aria-hidden="true">${esc(name[0].toUpperCase())}</span>`;
  }

  function renderHeader(root, companyName, rightHtml, logoUrl) {
    const name = String(companyName || '').trim() || 'Livraison';
    root.innerHTML = `<div class="cl-brand">${brandMark(name, logoUrl)}<span class="cl-brand-name">${esc(name)}</span></div><div class="cl-head-right">${rightHtml || ''}</div>`;
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
  // Au-delà de 150 m (position par IP ou réseau, typique d'un ordinateur),
  // le point n'aide pas le livreur : il faut placer l'épingle soi-même.
  // Le premier relevé d'un téléphone vient souvent du réseau (± 100 à 500 m),
  // avant que la puce GPS ne se cale : on écoute donc la position quelques
  // secondes et on garde le meilleur relevé, comme une appli GPS en continu.
  const GPS_MAX_ACCURACY_M = 150;
  const GPS_GOOD_ACCURACY_M = 25;     // assez précis : on s'arrête tout de suite
  const GPS_SETTLE_MS = 8000;         // relevé acceptable : on s'arrête après 8 s
  const GPS_MAX_WAIT_MS = 25000;      // au plus 25 s d'affinage sur téléphone
  const GPS_DESKTOP_WAIT_MS = 6000;   // un ordinateur n'a pas de puce GPS : inutile d'attendre
  const hasFinePointer = () => window.matchMedia && window.matchMedia('(pointer: fine)').matches && !window.matchMedia('(pointer: coarse)').matches;
  let qrLib = null;
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLib) {
      qrLib = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/qrcode/qrcode.js';
        script.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('qrcode')));
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    return qrLib;
  }
  function createGpsField(root, { initial, onChange, handoff = false } = {}) {
    let position = initial && Number.isFinite(Number(initial.latitude)) ? {
      latitude: Number(initial.latitude), longitude: Number(initial.longitude),
      accuracy: initial.accuracy == null ? null : Number(initial.accuracy),
    } : null;
    const imprecise = () => Boolean(position && position.accuracy != null && position.accuracy > GPS_MAX_ACCURACY_M);
    const usable = () => (position && !imprecise() ? position : null);
    let map = null;
    let marker = null;
    let busy = false;
    let error = '';
    let stopWatch = null;

    root.innerHTML = `<div class="cl-gps" id="gpsBox" role="group" aria-labelledby="gpsTitle">
        <div class="cl-gps-text"><strong id="gpsTitle">Position GPS *</strong><span id="gpsSub" aria-live="polite"></span></div>
        <button type="button" class="cl-btn outline sm" id="gpsBtn"></button>
      </div>
      <div class="cl-gps-map" id="gpsMap" hidden aria-label="Carte : déplacez l’épingle si besoin"></div>
      <p class="cl-hint" id="gpsHint"></p>
      <button type="button" class="cl-btn outline sm" id="gpsConfirm" hidden>L’épingle est au bon endroit</button>
      <div class="cl-handoff" id="gpsHandoff" hidden>
        <div class="cl-handoff-qr" id="gpsQr" aria-hidden="true"></div>
        <div class="cl-handoff-text"><strong>Continuez sur votre téléphone</strong>
          <span>Scannez ce code avec l’appareil photo de votre téléphone : sa puce GPS donne une position bien plus précise qu’un ordinateur. Remplissez ensuite le formulaire depuis le téléphone.</span>
          <button type="button" class="cl-linkbtn" id="gpsCopy">Copier le lien</button></div>
      </div>`;
    const box = root.querySelector('#gpsBox');
    const sub = root.querySelector('#gpsSub');
    const button = root.querySelector('#gpsBtn');
    const mapEl = root.querySelector('#gpsMap');
    const hint = root.querySelector('#gpsHint');
    const confirmBtn = root.querySelector('#gpsConfirm');
    const handoffEl = root.querySelector('#gpsHandoff');
    // Sur ordinateur, proposer de continuer sur le téléphone (lien de la page,
    // sans paramètre) : utile seulement tant que le lien n'est lié à aucun appareil.
    const offerHandoff = handoff && hasFinePointer();
    let qrDrawn = false;
    function drawQr() {
      if (qrDrawn || !offerHandoff) return;
      const url = `${location.origin}${location.pathname}`;
      loadQrLib().then((qrcode) => {
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        root.querySelector('#gpsQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        qrDrawn = true;
      }).catch(() => { handoffEl.hidden = true; });
      root.querySelector('#gpsCopy').onclick = async (event) => {
        try { await navigator.clipboard.writeText(url); event.target.textContent = 'Lien copié'; } catch (_) { event.target.textContent = url; }
      };
    }
    const meters = (m) => (m >= 1000 ? `${Math.round(m / 1000)} km` : `${Math.round(m)} m`);

    function paint() {
      box.classList.toggle('ok', Boolean(usable()) && !error && !busy);
      box.classList.toggle('err', !busy && (Boolean(error) || imprecise()));
      if (busy) {
        sub.textContent = position && position.accuracy != null
          ? `Affinage de la position… ± ${meters(position.accuracy)} pour l’instant. Restez immobile, à l’extérieur si possible.`
          : 'Recherche de votre position…';
      } else if (error) sub.textContent = error;
      else if (imprecise()) {
        sub.textContent = hasFinePointer()
          ? `Position estimée par le réseau (± ${meters(position.accuracy)}) : un ordinateur n’a pas de GPS. Placez l’épingle sur votre lieu de livraison, ou ouvrez ce lien sur votre téléphone.`
          : `Position trop imprécise (± ${meters(position.accuracy)}). Placez l’épingle exactement sur votre lieu de livraison, ou réessayez à l’extérieur.`;
      } else if (position) {
        sub.textContent = position.accuracy != null
          ? `Position partagée · précision d’environ ${Math.round(position.accuracy)} m`
          : 'Position partagée · confirmée sur la carte';
      } else sub.textContent = 'Partagez votre position depuis le lieu de livraison.';
      button.textContent = busy ? (position ? 'Utiliser cette position' : 'Localisation…') : position ? 'Actualiser' : 'Partager ma position';
      button.disabled = busy && !position;
      hint.textContent = busy ? 'La précision s’améliore en général en quelques secondes.'
        : imprecise() ? 'Déplacez l’épingle sur la carte, ou confirmez-la si elle est déjà au bon endroit.'
          : position ? 'Si l’épingle n’est pas au bon endroit, déplacez-la sur la carte.' : 'Requis pour envoyer votre demande.';
      confirmBtn.hidden = busy || !imprecise();
      mapEl.hidden = !position;
      // Proposé dès que l'ordinateur donne une position imprécise (ou aucune).
      handoffEl.hidden = !offerHandoff || busy || usable() != null || !(imprecise() || error);
      if (!handoffEl.hidden) drawQr();
    }

    function showMap({ recenter = true } = {}) {
      if (!position || typeof window.L === 'undefined') return;
      const latLng = [position.latitude, position.longitude];
      // Zoom adapté à la précision : large si la position est approximative.
      const zoom = !position.accuracy ? 17 : position.accuracy > 3000 ? 12 : position.accuracy > GPS_MAX_ACCURACY_M ? 16 : 17;
      mapEl.hidden = false;
      if (!map) {
        map = L.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(latLng, zoom);
        const created = map;
        if (window.TraxoMapBase) window.TraxoMapBase.load().then((config) => window.TraxoMapBase.layerSwitcher(created, config, { position: 'topright' }));
        marker = L.marker(latLng, { draggable: true, keyboard: true, title: 'Point de livraison' }).addTo(map);
        marker.on('dragstart', () => { if (stopWatch) stopWatch(false); });
        marker.on('dragend', () => {
          const point = marker.getLatLng();
          position = { latitude: point.lat, longitude: point.lng, accuracy: null };
          error = '';
          paint();
          if (onChange) onChange(position);
        });
      } else {
        marker.setLatLng(latLng);
        if (recenter) map.setView(latLng, zoom);
      }
      setTimeout(() => map.invalidateSize(), 60);
    }

    // Épingle confirmée à la main : même traitement qu'un déplacement.
    confirmBtn.addEventListener('click', () => {
      if (!position) return;
      position = { latitude: position.latitude, longitude: position.longitude, accuracy: null };
      error = '';
      paint();
      if (onChange) onChange(position);
    });

    function locate() {
      if (busy && stopWatch) { stopWatch(true); return; }
      if (!navigator.geolocation) {
        error = 'La localisation n’est pas disponible sur cet appareil.';
        paint();
        return;
      }
      busy = true;
      error = '';
      const previous = position;
      position = null;
      paint();
      const started = Date.now();
      const maxWait = hasFinePointer() ? GPS_DESKTOP_WAIT_MS : GPS_MAX_WAIT_MS;
      let best = null;
      let watchId = null;
      let timer = null;
      let settle = null;
      let ended = false;
      let lastFailure = null;
      const finish = (keep) => {
        if (ended) return;
        ended = true;
        busy = false;
        stopWatch = null;
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        clearTimeout(timer);
        clearTimeout(settle);
        if (keep === false) { paint(); return; } // épingle déplacée pendant l'affinage
        if (best) { position = best; showMap(); }
        else if (!error) {
          position = previous;
          error = lastFailure && lastFailure.code === 2
            ? 'Position introuvable. Vérifiez que la localisation du téléphone est activée.'
            : 'La recherche a pris trop de temps. Réessayez à l’extérieur ou près d’une fenêtre.';
        }
        paint();
        if (onChange) onChange(usable());
      };
      stopWatch = finish;
      watchId = navigator.geolocation.watchPosition((result) => {
        if (ended) return;
        const fix = { latitude: result.coords.latitude, longitude: result.coords.longitude, accuracy: result.coords.accuracy };
        const firstFix = !best;
        if (!best || (fix.accuracy != null && fix.accuracy < best.accuracy)) {
          best = fix;
          position = best;
          showMap({ recenter: firstFix });
          paint();
        }
        const elapsed = Date.now() - started;
        if (best.accuracy <= GPS_GOOD_ACCURACY_M || (best.accuracy <= GPS_MAX_ACCURACY_M && elapsed >= GPS_SETTLE_MS)) finish(true);
      }, (failure) => {
        if (ended) return;
        // Refus : on s'arrête. Erreur passagère (GPS pas encore calé, signal
        // perdu un instant) : on continue d'écouter jusqu'à la fin du délai.
        if (failure && failure.code === 1) {
          position = previous;
          error = 'Accès refusé. Autorisez la localisation dans votre navigateur, puis réessayez.';
          finish(true);
          return;
        }
        lastFailure = failure;
      }, { enableHighAccuracy: true, timeout: maxWait, maximumAge: 0 });
      // Un relevé acceptable arrivé tôt : on s'arrête dès que les 8 s sont écoulées.
      settle = setTimeout(() => { if (best && best.accuracy <= GPS_MAX_ACCURACY_M) finish(true); }, GPS_SETTLE_MS + 50);
      timer = setTimeout(() => finish(true), maxWait);
    }

    button.addEventListener('click', locate);
    paint();
    if (position) showMap();
    return { get: usable, imprecise, focus: () => (imprecise() ? mapEl.scrollIntoView({ block: 'center' }) : button.focus()) };
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

  // L'autorisation vient du cookie HttpOnly posé à l'envoi (même appareil).
  function uploadPhoto(token, blob) {
    return fetchJson(`/api/public/requests/${encodeURIComponent(token)}/photos`, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob,
    }).then((result) => {
      if (!result.ok) throw new Error(result.data.error || 'Envoi de la photo impossible.');
      return result.data.id;
    });
  }

  function deletePhoto(token, id) {
    return fetchJson(`/api/public/requests/${encodeURIComponent(token)}/photos/${encodeURIComponent(id)}`, {
      method: 'DELETE',
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

  // ---- Téléphone : indicatif pays avec drapeau --------------------------
  // Drapeaux SVG (flag-icons, MIT) : les émojis drapeaux ne s'affichent pas sous Windows.
  const COUNTRIES = [
    ['BJ', 'Bénin', '229'], ['TG', 'Togo', '228'], ['NG', 'Nigeria', '234'], ['NE', 'Niger', '227'],
    ['BF', 'Burkina Faso', '226'], ['CI', 'Côte d’Ivoire', '225'], ['GH', 'Ghana', '233'], ['SN', 'Sénégal', '221'],
    ['ML', 'Mali', '223'], ['GN', 'Guinée', '224'], ['CM', 'Cameroun', '237'], ['GA', 'Gabon', '241'],
    ['CG', 'Congo', '242'], ['CD', 'RD Congo', '243'], ['TD', 'Tchad', '235'], ['MA', 'Maroc', '212'],
    ['FR', 'France', '33'], ['BE', 'Belgique', '32'], ['CH', 'Suisse', '41'], ['CA', 'Canada', '1'],
    ['US', 'États-Unis', '1'], ['GB', 'Royaume-Uni', '44'], ['CN', 'Chine', '86'],
  ];
  const PHONE_EXAMPLES = { BJ: '01 97 12 34 56', TG: '90 12 34 56', CI: '07 07 07 07 07', SN: '77 123 45 67', NG: '803 123 4567', FR: '6 12 34 56 78' };
  const country = (code) => COUNTRIES.find((c) => c[0] === code) || COUNTRIES[0];
  const flag = (code) => `<img class="cl-flag" src="/vendor/flags/${code.toLowerCase()}.svg" alt="" width="22" height="16" loading="lazy" />`;

  function phoneFieldHtml(d) {
    const [code, name, dial] = country(d.phone_country || 'BJ');
    return `<div class="cl-phone" id="phoneField">
        <button type="button" class="cl-cc" id="ccBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Indicatif : ${esc(name)} +${esc(dial)}">${flag(code)}<span>+${esc(dial)}</span>${icon('chevronDown')}</button>
        <input class="cl-input" id="f-phone" name="customerPhone" type="tel" inputmode="tel" autocomplete="tel-national" required placeholder="${esc(PHONE_EXAMPLES[code] || 'Numéro de téléphone')}" value="${esc(d.phone_national || '')}" />
        <input type="hidden" name="customerPhoneCountry" id="f-phone-cc" value="${esc(code)}" />
        <ul class="cl-cc-list" id="ccList" role="listbox" aria-label="Choisir l’indicatif du pays" hidden>
          ${COUNTRIES.map(([c, n, dl]) => `<li role="option" tabindex="-1" data-cc="${c}" aria-selected="${c === code}">${flag(c)}<span class="cl-cc-name">${esc(n)}</span><span class="cl-cc-dial">+${dl}</span></li>`).join('')}
        </ul>
      </div>`;
  }

  function wirePhoneField(root) {
    const button = root.querySelector('#ccBtn');
    const list = root.querySelector('#ccList');
    const input = root.querySelector('#f-phone');
    const hidden = root.querySelector('#f-phone-cc');
    const hint = root.querySelector('#phoneHint');
    if (!button || !list) return;
    const paintHint = () => { hint.textContent = hidden.value === 'BJ' ? 'Pour vous joindre à l’arrivée. Au Bénin : 10 chiffres commençant par 01.' : 'Pour vous joindre à l’arrivée.'; };
    const close = () => { list.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    const open = () => {
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      const selected = list.querySelector('[aria-selected="true"]') || list.firstElementChild;
      selected.focus();
    };
    const choose = (code) => {
      const [c, n, dl] = country(code);
      hidden.value = c;
      button.innerHTML = `${flag(c)}<span>+${esc(dl)}</span>${icon('chevronDown')}`;
      button.setAttribute('aria-label', `Indicatif : ${n} +${dl}`);
      input.placeholder = PHONE_EXAMPLES[c] || 'Numéro de téléphone';
      list.querySelectorAll('[data-cc]').forEach((li) => li.setAttribute('aria-selected', String(li.dataset.cc === c)));
      paintHint();
      close();
      input.focus();
    };
    button.addEventListener('click', (event) => { event.stopPropagation(); if (list.hidden) open(); else close(); });
    list.addEventListener('click', (event) => { const li = event.target.closest('[data-cc]'); if (li) choose(li.dataset.cc); });
    list.addEventListener('keydown', (event) => {
      const items = [...list.querySelectorAll('[data-cc]')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); (items[index + 1] || items[0]).focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); (items[index - 1] || items[items.length - 1]).focus(); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (items[index]) choose(items[index].dataset.cc); }
      else if (event.key === 'Escape') { close(); button.focus(); }
    });
    document.addEventListener('click', (event) => { if (!list.hidden && !event.target.closest('#phoneField')) close(); });
    // « 00229… » collé → « +229… » (le serveur reconnaît alors l'indicatif).
    input.addEventListener('blur', () => { input.value = input.value.trim().replace(/^00(?=\d)/, '+'); });
    paintHint();
  }

  // Erreur renvoyée par le serveur sur un champ précis.
  function markFieldError(form, field, message) {
    const ids = { customerPhone: ['#f-phone', '#phoneHint'], pickupAddress: ['#f-pk-address', '#pkAddressHint'], pickupPhone: ['#f-pk-phone', '#pkPhoneHint'] };
    const [inputSel, hintSel] = ids[field] || [];
    const input = inputSel ? form.querySelector(inputSel) : null;
    if (!input) return;
    input.setAttribute('aria-invalid', 'true');
    const hint = form.querySelector(hintSel);
    if (hint) { hint.textContent = message; hint.classList.add('err'); }
    input.focus();
    input.addEventListener('input', () => { input.setAttribute('aria-invalid', 'false'); if (hint) hint.classList.remove('err'); }, { once: true });
  }

  // ---- Champs du formulaire (création et modification) -----------------
  const PACKAGE_TYPES = [['colis', 'Un colis'], ['documents', 'Des documents'], ['repas', 'Un repas'], ['fragile', 'Un objet fragile'], ['vetements', 'Des vêtements'], ['autre', 'Autre chose']];
  function requestFieldsHtml(d = {}) {
    const v = (key) => esc(d[key] || '');
    return `
      <section class="cl-sec">
        <div class="cl-sec-head"><span class="cl-sec-num">01</span><h2 class="cl-sec-title">Vos coordonnées</h2></div>
        <div class="cl-row">
          <div class="cl-field"><label for="f-name">Nom et prénom *</label><input class="cl-input" id="f-name" name="customerName" autocomplete="name" required value="${v('customer_name')}" /></div>
          <div class="cl-field"><label for="f-phone">Téléphone *</label>${phoneFieldHtml(d)}<p class="cl-hint" id="phoneHint">Pour vous joindre à l’arrivée.</p></div>
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
      </section>
      <section class="cl-sec">
        <div class="cl-sec-head"><span class="cl-sec-num">03</span><h2 class="cl-sec-title">Votre colis</h2></div>
        <p class="cl-sec-sub">Facultatif, mais utile au livreur pour prévoir la place et le soin.</p>
        <div class="cl-field"><span class="cl-label" id="pkgTypeLabel">Ce que vous attendez</span>
          <div class="cl-chips" role="radiogroup" aria-labelledby="pkgTypeLabel">${PACKAGE_TYPES.map(([value, label]) => `<label class="cl-chip"><input type="radio" name="packageType" value="${value}" ${d.package_type === value ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div>
        </div>
        <div class="cl-field"><label for="f-pkg">Contenu <em>(facultatif)</em></label><input class="cl-input" id="f-pkg" name="packageDescription" maxlength="240" placeholder="Ex. 2 robes, un carton d’environ 5 kg" value="${v('package_description')}" /></div>
        <label class="cl-check" for="f-pickup"><input type="checkbox" id="f-pickup" name="pickupEnabled" value="true" ${d.pickup_enabled ? 'checked' : ''}><span><strong>Le colis est à récupérer ailleurs</strong><small>Le livreur passera d’abord le chercher, puis viendra chez vous.</small></span></label>
        <div class="cl-pickup" id="pickupBox" ${d.pickup_enabled ? '' : 'hidden'}>
          <div class="cl-row">
            <div class="cl-field"><label for="f-pk-name">Chez qui ? <em>(facultatif)</em></label><input class="cl-input" id="f-pk-name" name="pickupName" maxlength="120" placeholder="Ex. Boutique Mado, Tante Rose" value="${v('pickup_name')}" /></div>
            <div class="cl-field"><label for="f-pk-phone">Son téléphone <em>(facultatif)</em></label><input class="cl-input" id="f-pk-phone" name="pickupPhone" type="tel" inputmode="tel" maxlength="24" placeholder="01 97 12 34 56" value="${v('pickup_phone')}" /><p class="cl-hint" id="pkPhoneHint">Pour que le livreur la prévienne.</p></div>
          </div>
          <div class="cl-field"><label for="f-pk-address">Où le récupérer ? *</label><input class="cl-input" id="f-pk-address" name="pickupAddress" maxlength="240" placeholder="Ex. Dantokpa, allée des tissus, porte 3" value="${v('pickup_address')}" /><p class="cl-hint" id="pkAddressHint">Un quartier et un repère suffisent.</p></div>
          <div class="cl-field"><label for="f-pk-ready">Prêt à partir à <em>(facultatif)</em></label><input class="cl-input" id="f-pk-ready" name="pickupReady" maxlength="80" placeholder="Ex. à partir de 14 h" value="${v('pickup_ready')}" /></div>
          ${d.pickup_lat != null && d.pickup_lng != null ? `<input type="hidden" name="pickupLat" value="${esc(d.pickup_lat)}"><input type="hidden" name="pickupLng" value="${esc(d.pickup_lng)}">` : ''}
        </div>
      </section>`;
  }

  // Colis : la case « à récupérer ailleurs » ouvre les champs de collecte.
  function wirePackageFields(root) {
    const toggle = root.querySelector('#f-pickup');
    const box = root.querySelector('#pickupBox');
    if (!toggle || !box) return;
    const sync = () => {
      box.hidden = !toggle.checked;
      const address = box.querySelector('#f-pk-address');
      address.required = toggle.checked;
      if (toggle.checked && !address.value) address.focus();
    };
    toggle.addEventListener('change', sync);
    box.querySelector('#f-pk-address').required = toggle.checked;
    // Un second clic sur le type déjà choisi le retire (ce n'est pas obligatoire).
    root.querySelectorAll('.cl-chip input').forEach((radio) => {
      radio.addEventListener('mousedown', () => { radio.dataset.was = radio.checked ? '1' : ''; });
      radio.addEventListener('click', () => { if (radio.dataset.was === '1') { radio.checked = false; radio.dataset.was = ''; } });
    });
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
    icon, esc, initials, isCar, formatTime, renderHeader, brandMark, fetchJson, requestTokenFromPath,
    createGpsField, createPhotoPicker, compressImage, uploadPhoto, deletePhoto,
    requestFieldsHtml, readFields, firstMissing, wirePhoneField, markFieldError, phoneFieldHtml, wirePackageFields,
  };
})();
