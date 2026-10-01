/* Configuration guidée après inscription (d'après le kit TRAXO Onboarding).
   Réponses gardées dans la session du navigateur pendant la saisie, puis
   enregistrées sur le serveur (POST /api/onboarding) au dernier écran. */
(function () {
  'use strict';

  var ICONS = {"importer":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#202124\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 16V3M7 8l5-5 5 5M4 15v6h16v-6\"/></svg>","fleche-gauche":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#202124\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 12H4M10 6l-6 6 6 6\"/></svg>","chevron":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#202124\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m6 9 6 6 6-6\"/></svg>","fleche-droite":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#202124\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 12h16M14 6l6 6-6 6\"/></svg>","valider":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#202124\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m5 12 4 4L19 6\"/></svg>"};
  var STORE_KEY = 'traxo-onboarding-v1';
  var container = document.getElementById('onboarding');
  container.innerHTML = '<div id="traxo-onboarding">'
    + '<header class="tx-header"><img class="tx-logo" src="/brand/traxo-logo.png" width="138" height="29" alt="TRAXO">'
    + '<div class="tx-header-side"><span class="tx-header-label">Configuration du compte</span>'
    + '<form method="post" action="/app/logout"><button type="submit" class="tx-logout">Se déconnecter</button></form></div></header>'
    + '<main class="tx-shell"><aside class="tx-guide"><p class="tx-guide-title">Faisons connaissance.</p><p class="tx-guide-desc">Les premiers réglages de votre compte, étape par étape.</p><ol class="tx-progress" aria-label="Étapes de configuration"></ol><p class="tx-guide-note">Vous pourrez modifier ces informations dans les paramètres de votre compte.</p></aside>'
    + '<div class="tx-content" aria-live="polite"></div></main>'
    + '<footer class="tx-footer"><span>TRAXO</span><span>Votre compte, à votre image.</span></footer></div>';
  var root = container.querySelector('#traxo-onboarding');

  function ic(name) { return (ICONS[name] || '').replace('<svg ', '<svg aria-hidden="true" focusable="false" '); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var countries = [['Bénin', '+229'], ['Côte d’Ivoire', '+225'], ['Togo', '+228'], ['Sénégal', '+221'], ['Burkina Faso', '+226'], ['Cameroun', '+237'], ['Gabon', '+241'], ['Guinée', '+224'], ['Mali', '+223'], ['Niger', '+227'], ['Congo', '+242'], ['République démocratique du Congo', '+243'], ['Ghana', '+233'], ['Nigeria', '+234'], ['France', '+33'], ['Canada', '+1'], ['Autre pays', '']];
  var categories = [['restaurant', 'Restaurant'], ['commerce', 'Commerce'], ['vente-en-ligne', 'Vente en ligne'], ['livraison', 'Service de livraison'], ['autre', 'Autre activité']];
  var fleets = ['Pas encore', '1', '2–5', '6–12', '13 et plus'];
  var state = { step: -1, visited: 0, business: '', category: '', country: '', otherCountry: '', city: '', name: '', phone: '', prefix: '+229', waCodes: true, fleet: '', logo: '', saving: false, saveError: '' };
  try { var old = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); if (old) Object.assign(state, old, { saving: false, saveError: '' }); } catch (e) { /* stockage bloqué */ }
  function save() { try { var copy = Object.assign({}, state); delete copy.saving; delete copy.saveError; sessionStorage.setItem(STORE_KEY, JSON.stringify(copy)); } catch (e) { /* ignoré */ } }

  var labels = ['Votre activité', 'Votre ville', 'Votre équipe'];
  var captions = ['Nom et activité', 'Lieu principal', 'Profil et livreurs'];
  function progress() {
    root.querySelector('.tx-progress').innerHTML = labels.map(function (x, i) {
      return '<li><button type="button" class="tx-step ' + (state.step === i ? 'active' : state.step > i ? 'done' : '') + '" data-step="' + i + '" ' + (i > state.visited ? 'disabled' : '') + ' ' + (state.step === i ? 'aria-current="step"' : '') + '><span class="tx-step-num">' + (state.step > i ? ic('valider') : i + 1) + '</span><span class="tx-step-text">' + x + '<small>' + captions[i] + '</small></span></button></li>';
    }).join('');
    root.querySelectorAll('[data-step]').forEach(function (b) { b.onclick = function () { syncInputs(); go(Number(b.dataset.step)); }; });
  }
  function welcome() {
    root.querySelector('.tx-content').innerHTML = '<div class="tx-welcome-copy"><p class="tx-welcome-eyebrow">Bienvenue sur TRAXO</p><h1 class="tx-welcome-title"><span class="tx-line"><span>Configurons</span></span><span class="tx-line"><span>votre <em>compte.</em></span></span></h1><p class="tx-welcome-description">Nous allons vous aider à préparer votre espace de livraison.<br>Pour commencer, dites-nous quelques mots sur votre activité.</p><ol class="tx-welcome-plan"><li><span>01</span><strong>Votre activité</strong><small>Le nom que vos clients connaissent.</small></li><li><span>02</span><strong>Votre ville</strong><small>L’endroit où vous travaillez.</small></li><li><span>03</span><strong>Votre équipe</strong><small>Vous et vos livreurs.</small></li></ol><div class="tx-welcome-bottom"><button type="button" class="tx-pill" id="tx-start">Configurer mon compte<span class="tx-pill-icon">' + ic('fleche-droite') + '</span></button><span class="tx-duration">3 étapes · Environ 2 minutes</span></div></div>';
    root.querySelector('#tx-start').onclick = function () { go(0); };
  }
  function field(label, name, placeholder, opts) { return '<div class="tx-field"><label class="tx-label" for="tx-' + name + '">' + label + '</label><input class="tx-input" id="tx-' + name + '" name="' + name + '" value="' + esc(state[name]) + '" placeholder="' + placeholder + '" ' + (opts || '') + '></div>'; }
  function actions(label) { return '<p class="tx-error" id="tx-error" role="alert" hidden></p><div class="tx-actions"><button class="tx-back" type="button">' + ic('fleche-gauche') + 'Retour</button><button class="tx-primary" type="button" data-continue>' + (label || 'Continuer') + ic('fleche-droite') + '</button></div>'; }

  function render() {
    root.classList.toggle('tx-welcome', state.step === -1);
    progress();
    if (state.step === -1) { welcome(); return; }
    var content = root.querySelector('.tx-content');
    if (state.step === 0) {
      content.innerHTML = '<form novalidate><p class="tx-kicker">Étape 1 sur 3</p><h1 class="tx-form-title">Parlez-nous de votre activité.</h1><p class="tx-form-desc">Ces informations permettront à vos clients de vous reconnaître sur leurs pages de suivi.</p>'
        + field('Nom de votre activité', 'business', 'Ex. : Maison Aïcha', 'autocomplete="organization" maxlength="70"')
        + '<div class="tx-field"><span class="tx-label" id="tx-category-label">Vous travaillez dans quel domaine ?</span><div class="tx-category-grid" role="group" aria-labelledby="tx-category-label">'
        + categories.map(function (c) { return '<button type="button" class="tx-category" data-category="' + c[0] + '" aria-pressed="' + (state.category === c[0]) + '"><span>' + c[1] + '</span><span class="tx-choice-dot" aria-hidden="true"></span></button>'; }).join('')
        + '</div></div><details class="tx-optional" ' + (state.logo ? 'open' : '') + '><summary>Ajouter un logo <span class="tx-label-note">Facultatif</span></summary><div class="tx-upload-row"><div class="tx-upload-thumb">' + (state.logo ? '<img src="' + esc(state.logo) + '" alt="Logo choisi">' : ic('importer')) + '</div><div><label class="tx-upload">' + (state.logo ? 'Changer le logo' : 'Ajouter un logo') + '<input type="file" accept="image/png,image/jpeg,image/webp" id="tx-logo-upload" aria-label="Ajouter votre logo"></label><p class="tx-upload-meta">PNG, JPG ou WebP · 2 Mo max.</p></div>' + (state.logo ? '<button type="button" class="tx-text-button" id="tx-remove-logo">Retirer</button>' : '') + '</div></details>'
        + actions() + '</form>';
      root.querySelectorAll('[data-category]').forEach(function (b) { b.onclick = function () { syncInputs(); state.category = b.dataset.category; save(); render(); root.querySelector('[data-category="' + state.category + '"]').focus({ preventScroll: true }); }; });
      root.querySelector('#tx-logo-upload').onchange = function (e) {
        var f = e.target.files[0];
        if (!f) return;
        if (['image/png', 'image/jpeg', 'image/webp'].indexOf(f.type) < 0 || f.size > 2 * 1024 * 1024) { error('Choisissez une image PNG, JPG ou WebP de moins de 2 Mo.'); return; }
        shrinkLogo(f).then(function (dataUrl) { state.logo = dataUrl; save(); render(); }).catch(function () { error('Cette image n’a pas pu être lue. Essayez un autre fichier.'); });
      };
      var del = root.querySelector('#tx-remove-logo');
      if (del) del.onclick = function () { state.logo = ''; save(); render(); };
    } else if (state.step === 1) {
      content.innerHTML = '<form novalidate><p class="tx-kicker">Étape 2 sur 3</p><h1 class="tx-form-title">Où se trouve votre activité ?</h1><p class="tx-form-desc">Indiquez votre ville principale. Vous pourrez aussi organiser des livraisons ailleurs.</p>'
        + '<div class="tx-field"><label class="tx-label" for="tx-country">Pays</label><div class="tx-select-wrap"><select class="tx-select" id="tx-country" name="country"><option value="">Sélectionner un pays</option>'
        + countries.map(function (c) { return '<option ' + (state.country === c[0] ? 'selected' : '') + '>' + c[0] + '</option>'; }).join('')
        + '</select>' + ic('chevron') + '</div></div><div id="tx-other-country-wrap" ' + (state.country === 'Autre pays' ? '' : 'hidden') + '>' + field('Nom du pays', 'otherCountry', 'Votre pays', 'autocomplete="country-name" maxlength="60"') + '</div>'
        + field('Ville principale', 'city', 'Ex. : Cotonou', 'autocomplete="address-level2" maxlength="70"') + '<p class="tx-hint">Votre ville suffit pour cette première configuration.</p>' + actions() + '</form>';
    } else if (state.step === 2) {
      content.innerHTML = '<form novalidate><p class="tx-kicker">Étape 3 sur 3</p><h1 class="tx-form-title">Qui organise les livraisons ?</h1><p class="tx-form-desc">Ajoutons votre profil et quelques repères sur votre équipe.</p>'
        + field('Votre prénom et votre nom', 'name', 'Prénom et nom', 'autocomplete="name" maxlength="80"')
        + '<div class="tx-field"><label class="tx-label" for="tx-phone">Votre numéro WhatsApp <span class="tx-label-note">Recommandé</span></label><div class="tx-phone"><input class="tx-input tx-prefix" aria-label="Indicatif international" name="prefix" value="' + esc(state.prefix) + '" inputmode="tel" maxlength="5"><input class="tx-input" id="tx-phone" name="phone" type="tel" autocomplete="tel-national" placeholder="01 97 12 34 56" value="' + esc(state.phone) + '" maxlength="20"></div>'
        + '<label class="tx-check"><input type="checkbox" id="tx-wa-codes" ' + (state.waCodes ? 'checked' : '') + '><span><strong>Recevoir mes codes de connexion sur WhatsApp</strong><small>Plus rapide que l’e‑mail. L’e‑mail reste disponible en secours.</small></span></label></div>'
        + '<div class="tx-field"><span class="tx-label" id="tx-fleet-label">Combien de livreurs travaillent avec vous ?</span><div class="tx-fleet" role="group" aria-labelledby="tx-fleet-label">'
        + fleets.map(function (x) { return '<button type="button" data-fleet="' + x + '" aria-pressed="' + (state.fleet === x) + '">' + x + '</button>'; }).join('')
        + '</div><p class="tx-hint">Une estimation suffit. Vous inviterez vos livreurs une fois dans votre espace.</p></div>' + actions('Vérifier mes informations') + '</form>';
      var wa = root.querySelector('#tx-wa-codes');
      if (wa) wa.onchange = function () { state.waCodes = wa.checked; save(); };
      root.querySelectorAll('[data-fleet]').forEach(function (b) { b.onclick = function () { syncInputs(); state.fleet = b.dataset.fleet; save(); render(); root.querySelector('[data-fleet="' + state.fleet + '"]').focus({ preventScroll: true }); }; });
    } else {
      var country = state.country === 'Autre pays' ? state.otherCountry : state.country;
      var cat = (categories.find(function (c) { return c[0] === state.category; }) || [])[1] || '';
      content.innerHTML = '<div class="tx-ready"><h1 class="tx-form-title">Votre configuration est prête.</h1><p class="tx-form-desc">Vérifiez ces informations avant de découvrir votre espace.</p>'
        + '<div class="tx-ready-company"><div class="tx-monogram">' + (state.logo ? '<img src="' + esc(state.logo) + '" alt="Logo de votre activité">' : esc(state.business.trim().slice(0, 1).toUpperCase())) + '</div><div><p class="tx-company-name">' + esc(state.business) + '</p><p class="tx-company-type">' + esc(cat) + '</p></div><button type="button" class="tx-text-button" data-edit="0" style="margin-left:auto">Modifier</button></div>'
        + '<dl class="tx-summary"><div class="tx-summary-row"><dt>Votre ville</dt><dd>' + esc(state.city) + ', ' + esc(country) + '</dd><button type="button" class="tx-text-button" data-edit="1">Modifier</button></div>'
        + '<div class="tx-summary-row"><dt>Responsable</dt><dd>' + esc(state.name) + '<br><span style="color:#777">' + (state.phone ? esc(state.prefix) + ' ' + esc(state.phone) + ' · codes ' + (state.waCodes ? 'sur WhatsApp' : 'par e‑mail') : 'Pas de numéro WhatsApp · codes par e‑mail') + '</span></dd><button type="button" class="tx-text-button" data-edit="2">Modifier</button></div>'
        + '<div class="tx-summary-row"><dt>Livreurs</dt><dd>' + (state.fleet === 'Pas encore' ? 'À ajouter plus tard' : esc(state.fleet) + (state.fleet === '1' ? ' livreur' : ' livreurs')) + '</dd><button type="button" class="tx-text-button" data-edit="2">Modifier</button></div></dl>'
        + '<button type="button" class="tx-primary tx-ready-cta" id="tx-launch" ' + (state.saving ? 'disabled' : '') + '>' + (state.saving ? 'Enregistrement…' : 'Découvrir TRAXO') + ic('fleche-droite') + '</button>'
        + (state.saveError ? '<p class="tx-save-error" role="alert">' + esc(state.saveError) + '</p>' : '')
        + '<p class="tx-ready-note">Vous pourrez tout modifier dans les paramètres.</p></div>';
      root.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { go(Number(b.dataset.edit)); }; });
      root.querySelector('#tx-launch').onclick = submit;
    }
    bind();
  }

  function error(msg, fieldName) {
    var el = root.querySelector('#tx-error');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    var target = fieldName ? root.querySelector('[name="' + fieldName + '"]') : null;
    if (target) { target.setAttribute('aria-invalid', 'true'); target.setAttribute('aria-describedby', 'tx-error'); target.focus({ preventScroll: true }); }
    el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  function syncInputs() { root.querySelectorAll('.tx-content input[name],.tx-content select[name]').forEach(function (el) { state[el.name] = el.value; }); save(); }
  function validate(step) {
    if (step === 0) {
      if (state.business.trim().length < 2) return ['Il nous manque le nom de votre activité.', 'business'];
      if (!state.category) return ['Choisissez l’activité qui vous correspond le mieux.'];
    }
    if (step === 1) {
      if (!state.country) return ['Choisissez le pays où vous travaillez.', 'country'];
      if (state.country === 'Autre pays' && !(state.otherCountry || '').trim()) return ['Quel est le nom de votre pays ?', 'otherCountry'];
      if (!state.city.trim()) return ['Indiquez votre ville principale.', 'city'];
    }
    if (step === 2) {
      if (state.name.trim().length < 2) return ['Comment pouvons-nous vous appeler ?', 'name'];
      var digits = state.phone.replace(/\D/g, '');
      if (state.phone.trim() && (digits.length < 6 || digits.length > 15 || !/^[\d\s().-]+$/.test(state.phone) || !/^[+][1-9]\d{0,3}$/.test(state.prefix))) return ['Ce numéro semble incomplet. Vérifiez aussi l’indicatif.', 'phone'];
      if (!state.fleet) return ['Choisissez une estimation, même si vous n’avez pas encore de livreur.'];
    }
    return null;
  }
  function advance() {
    syncInputs();
    var problem = validate(state.step);
    if (problem) return error(problem[0], problem[1]);
    go(state.step + 1);
  }
  function bind() {
    root.querySelectorAll('.tx-content input[name],.tx-content select[name]').forEach(function (el) {
      var update = function () {
        state[el.name] = el.value;
        el.removeAttribute('aria-invalid');
        el.removeAttribute('aria-describedby');
        if (el.name === 'country') {
          var match = countries.find(function (c) { return c[0] === el.value; });
          if (match && match[1]) state.prefix = match[1];
          root.querySelector('#tx-other-country-wrap').hidden = el.value !== 'Autre pays';
        }
        save();
      };
      el.addEventListener('input', update);
      el.addEventListener('change', update);
    });
    var next = root.querySelector('[data-continue]');
    if (next) next.addEventListener('click', advance);
    var form = root.querySelector('.tx-content form');
    if (form) {
      form.addEventListener('submit', function (e) { e.preventDefault(); advance(); });
      form.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT' && e.target.type !== 'file') { e.preventDefault(); advance(); } });
    }
    var back = root.querySelector('.tx-back');
    if (back) back.onclick = function () { syncInputs(); go(state.step - 1); };
  }
  function go(s) {
    state.step = Math.max(-1, Math.min(3, s));
    state.visited = Math.max(state.visited, Math.min(s, 2));
    state.saveError = '';
    save();
    render();
    var focusable = root.querySelector('.tx-content input, .tx-content select, .tx-content button');
    if (focusable) focusable.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  // Logo réduit dans le navigateur (512 px max) : envoi léger, même sur réseau mobile.
  function shrinkLogo(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 512 / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        var quality = 0.9;
        var data = canvas.toDataURL('image/webp', quality);
        if (data.indexOf('data:image/webp') !== 0) data = canvas.toDataURL('image/png');
        while (data.length > 230000 && quality > 0.4) { quality -= 0.15; data = canvas.toDataURL('image/webp', quality); }
        if (data.length > 230000) { reject(new Error('too_big')); return; }
        resolve(data);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }

  function submit() {
    if (state.saving) return;
    for (var i = 0; i < 3; i += 1) {
      var problem = validate(i);
      if (problem) { go(i); error(problem[0], problem[1]); return; }
    }
    state.saving = true;
    state.saveError = '';
    render();
    // Environ 12 s : le livreur pressé prépare l'espace, puis le camion le « livre ».
    var sequenceDone = window.TraxoLoader ? window.TraxoLoader.sequence([
      { kind: 'speeder', message: 'Nous créons votre espace…', ms: 3000 },
      { kind: 'speeder', message: 'Nous enregistrons votre activité et votre ville…', ms: 3000 },
      { kind: 'truck', message: 'Nous préparons votre carte d’exploitation…', ms: 3000 },
      { kind: 'truck', message: 'Votre espace arrive… presque prêt.', ms: 3000 },
    ]) : Promise.resolve();
    fetch('/api/onboarding', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business: state.business.trim(),
        category: state.category,
        country: state.country === 'Autre pays' ? (state.otherCountry || '').trim() : state.country,
        city: state.city.trim(),
        name: state.name.trim(),
        prefix: state.prefix.trim(),
        phone: state.phone.trim(),
        codeChannel: state.phone.trim() ? (state.waCodes ? 'whatsapp' : 'email') : undefined,
        fleet: state.fleet,
        logo: state.logo || undefined,
      }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
    }).then(function (res) {
      if (res.status === 401) { location.href = '/app/login?error=expired'; return; }
      if (res.status === 409 && res.data.redirect) { location.href = res.data.redirect; return; }
      if (!res.ok) throw Object.assign(new Error(res.data.error || 'save_failed'), { field: res.data.field });
      try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* ignoré */ }
      sequenceDone.then(function () { location.href = res.data.redirect || '/app'; });
    }).catch(function (err) {
      TraxoAuth.busy(false);
      state.saving = false;
      state.saveError = err && err.message && err.message !== 'save_failed' && err.message !== 'Failed to fetch'
        ? err.message
        : 'Vos informations n’ont pas pu être enregistrées. Vérifiez votre connexion puis réessayez.';
      var fieldStep = { business: 0, category: 0, logo: 0, country: 1, city: 1, name: 2, phone: 2, fleet: 2 }[err && err.field];
      if (fieldStep != null) { var msg = state.saveError; go(fieldStep); error(msg, err.field); return; }
      render();
    });
  }

  fetch('/api/onboarding', { credentials: 'same-origin' }).then(function (r) {
    if (r.status === 401) { location.href = '/app/login'; return null; }
    if (r.status === 409) return r.json().then(function (d) { location.href = d.redirect || '/app'; return null; });
    return r.json();
  }).then(function (prefill) {
    if (!prefill) return;
    ['name', 'business', 'city'].forEach(function (key) { if (!state[key] && prefill[key]) state[key] = prefill[key]; });
    if (!state.country && prefill.country) state.country = prefill.country;
    render();
  }).catch(function () { render(); });
  render();
})();
