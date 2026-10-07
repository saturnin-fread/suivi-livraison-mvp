/* Page « Rejoindre l'équipe » : invitation par e-mail ou par téléphone,
   nouveau compte ou compte TRAXO existant, avec mot de passe ou Google. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var token = decodeURIComponent(location.pathname.split('/').pop() || '');
  var params = new URLSearchParams(location.search);
  var auth = window.TraxoAuth;
  var ROLE_HINTS = {
    owner: 'Accès complet à l’espace, facturation comprise.',
    manager: 'Gère l’équipe, les commandes, les livreurs et les réglages.',
    operator: 'Crée et suit les commandes, attribue les livreurs.',
    viewer: 'Consulte les commandes et les rapports, sans rien modifier.',
    driver: 'Reçoit ses livraisons et partage sa position pendant les tournées.',
  };
  var ERRORS = {
    google: 'La connexion avec Google n’a pas abouti. Réessayez, ou utilisez le code et un mot de passe.',
    google_cancel: 'Connexion avec Google annulée.',
    google_off: 'La connexion avec Google n’est pas disponible pour le moment. Utilisez le code et un mot de passe.',
    google_mismatch: 'Ce compte Google n’utilise pas l’adresse invitée. Choisissez le compte Google de cette adresse, ou utilisez le code.',
    google_other: 'Ce compte TRAXO est déjà relié à un autre compte Google. Utilisez celui-là, ou votre mot de passe.',
    code: 'Le code saisi ne correspond pas ou a expiré. Demandez-en un nouveau, puis réessayez.',
    locked: 'Trop d’essais : cette invitation est annulée. Demandez-en une nouvelle.',
    already_member: 'Vous faites déjà partie de cet espace. Connectez-vous pour l’ouvrir.',
    disabled: 'Ce compte a été désactivé. Contactez le responsable de votre entreprise.',
    driver_gone: 'Le profil livreur associé à cette invitation n’existe plus. Demandez une nouvelle invitation.',
    server: 'Un problème technique a interrompu l’opération. Réessayez dans un instant.',
  };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]; }); };
  var state = { existing: false, existingGoogle: false, channel: 'email', google: false, phoneInvite: false, timer: null };
  var otp = auth.mountOtp($('otp'), $('inviteCode'), function () { syncGoogle(); });

  function show(id) {
    ['ivLoading', 'ivReady', 'ivGone', 'ivDone'].forEach(function (k) { $(k).hidden = k !== id; });
    $('ivRoot').setAttribute('aria-busy', id === 'ivLoading' ? 'true' : 'false');
  }
  function banner(text, type) { auth.showBanner(text, type || 'error'); $('banner').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  function clearBanner() { $('banner').hidden = true; }

  function setExisting(on) {
    state.existing = on;
    $('newPassword').hidden = on;
    $('existingPassword').hidden = !on;
    $('ivAccount').hidden = !on;
    $('inviteSubmit').querySelector('[data-label]').textContent = on ? 'Rejoindre avec mon compte' : 'Créer mon accès et rejoindre';
    $('ivOr').textContent = on ? 'ou avec votre mot de passe' : 'ou avec un mot de passe';
    $('ivGoogleLabel').textContent = on ? 'Continuer avec Google' : 'Rejoindre avec Google';
  }
  // Invitation par téléphone : Google n'est possible qu'après le code WhatsApp
  // (il prouve que l'invitation est bien la vôtre).
  function syncGoogle() {
    if (!state.phoneInvite) return;
    var ready = /^\d{6}$/.test($('inviteCode').value);
    $('ivGoogleBtn').setAttribute('aria-disabled', String(!ready));
    $('ivGoogleHint').textContent = ready ? 'Code saisi : vous pouvez continuer avec Google.' : 'Saisissez d’abord le code reçu sur WhatsApp, puis continuez avec Google.';
  }

  function countdown(seconds) {
    clearInterval(state.timer);
    var left = seconds;
    var btn = $('sendCode');
    btn.disabled = true;
    var tick = function () {
      btn.textContent = left > 0 ? 'Nouveau code dans ' + left + ' s' : 'Renvoyer le code';
      if (left <= 0) { clearInterval(state.timer); btn.disabled = false; }
      left -= 1;
    };
    tick();
    state.timer = setInterval(tick, 1000);
  }

  function logoHtml(inv) {
    if (inv.companyLogoUrl) return '<img src="' + esc(inv.companyLogoUrl) + '" alt="" onerror="this.remove()">';
    return esc(String(inv.company_name || '?').trim().charAt(0).toUpperCase());
  }

  function render(inv) {
    var role = inv.role_label || inv.role;
    $('ivLogo').innerHTML = logoHtml(inv);
    $('ivCompany').textContent = inv.company_name;
    $('ivFrom').textContent = inv.invited_by ? 'Invitation de ' + inv.invited_by : 'Invitation à rejoindre';
    $('ivRole').textContent = role;
    $('title').textContent = 'Rejoindre ' + inv.company_name;
    var until = new Date(inv.expires_at).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    $('ivSub').innerHTML = 'Bonjour ' + esc(inv.display_name) + ', vous êtes invité·e comme <strong>' + esc(role.toLowerCase()) + '</strong>. '
      + esc(ROLE_HINTS[inv.role] || '') + ' <span class="iv-until">Lien valable jusqu’au ' + esc(until) + '.</span>';
    document.title = 'Rejoindre ' + inv.company_name + ' — TRAXO';

    state.channel = inv.verification;
    state.phoneInvite = Boolean(inv.needsEmail);
    state.google = Boolean(inv.google);
    state.existingGoogle = Boolean(inv.existingGoogle);
    $('codeLabel').textContent = state.channel === 'whatsapp' ? 'Code reçu sur WhatsApp' : 'Code reçu par e-mail';
    $('codeHint').textContent = state.channel === 'whatsapp'
      ? 'Un code part sur le WhatsApp du ' + (inv.phoneMasked || 'numéro invité') + ' pour confirmer que l’invitation est la vôtre.'
      : 'Un code part à ' + (inv.emailMasked || 'l’adresse invitée') + ' pour confirmer que l’invitation est la vôtre.';
    $('emailStep').hidden = !state.phoneInvite;
    $('ivAccountText').textContent = (inv.emailMasked ? inv.emailMasked + ' · ' : '') + inv.company_name
      + ' s’ajoute à vos espaces. Votre compte et vos autres espaces ne changent pas.';
    setExisting(Boolean(inv.existingAccount));

    if (state.google) {
      $('ivGoogleBlock').hidden = false;
      $('ivGoogleToken').value = token;
      if (state.phoneInvite) syncGoogle();
      else $('ivGoogleHint').textContent = 'Sans code ni mot de passe : choisissez le compte Google de ' + (inv.emailMasked || 'l’adresse invitée') + '.';
      // Compte créé avec Google : pas de mot de passe connu, Google passe devant.
      if (state.existingGoogle) $('ivGoogleHint').textContent = 'Votre compte TRAXO utilise Google : continuez avec lui, sans mot de passe.';
    }
    show('ivReady');
    var err = params.get('error');
    if (err && ERRORS[err]) banner(ERRORS[err], 'error');
  }

  function gone(message) {
    if (message) $('ivGoneText').textContent = message;
    document.title = 'Invitation expirée — TRAXO';
    show('ivGone');
  }

  // Indicateur simple : longueur + variété (la règle exacte reste celle du serveur).
  var meterWords = ['Trop court', 'Correct', 'Solide', 'Très solide'];
  $('invitePassword').addEventListener('input', function () {
    var v = this.value;
    var score = v.length < 10 ? 0 : 1 + (v.length >= 14 ? 1 : 0) + (/\s|[^\w]/.test(v) && /\d/.test(v) ? 1 : 0);
    $('ivMeter').dataset.score = v ? String(score) : '';
    $('ivMeterText').textContent = v ? meterWords[score] + (score === 0 ? ' : 10 caractères minimum.' : '.') : 'Une courte phrase est plus simple à retenir qu’un mot compliqué.';
  });

  $('sendCode').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    clearBanner();
    fetch('/api/public/invitations/' + encodeURIComponent(token) + '/send-code', { method: 'POST' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          if (res.d.resendIn) countdown(res.d.resendIn); else btn.disabled = false;
          banner(res.d.error || 'Envoi impossible.');
          return;
        }
        $('codeHint').textContent = res.d.channel === 'whatsapp'
          ? 'Code envoyé sur le WhatsApp du ' + res.d.phoneMasked + '. Il arrive dans quelques secondes.'
          : 'Code envoyé à ' + res.d.emailMasked + '. Pensez à regarder dans les indésirables.';
        countdown(res.d.resendIn || 60);
        otp.focus();
      })
      .catch(function () { btn.disabled = false; banner('Connexion impossible. Vérifiez votre réseau, puis réessayez.'); });
  });

  $('ivGoogleForm').addEventListener('submit', function (event) {
    if (state.phoneInvite) {
      if (!/^\d{6}$/.test($('inviteCode').value)) {
        event.preventDefault();
        banner('Saisissez d’abord le code à 6 chiffres reçu sur WhatsApp. Pas encore de code ? Touchez « Recevoir le code ».');
        otp.focus();
        return;
      }
      $('ivGoogleCode').value = $('inviteCode').value;
    }
    auth.busy(true, 'Ouverture de Google…');
  });

  $('inviteForm').addEventListener('submit', function (event) {
    event.preventDefault();
    clearBanner();
    var email = $('inviteEmail').value.trim();
    var code = $('inviteCode').value;
    var payload = { code: code, email: email };
    if (state.phoneInvite && !/^\S+@\S+\.\S+$/.test(email)) { $('inviteEmail').setAttribute('aria-invalid', 'true'); banner('Indiquez une adresse e-mail valide : elle vous servira à vous connecter.'); $('inviteEmail').focus(); return; }
    $('inviteEmail').removeAttribute('aria-invalid');
    if (!/^\d{6}$/.test(code)) { banner('Saisissez le code à 6 chiffres reçu. Pas encore de code ? Touchez « Recevoir le code ».'); otp.focus(); return; }
    if (state.existing) {
      payload.password = $('inviteCurrent').value;
      if (!payload.password) { banner('Saisissez le mot de passe de votre compte TRAXO' + (state.google ? ', ou continuez avec Google.' : '.')); $('inviteCurrent').focus(); return; }
    } else {
      payload.password = $('invitePassword').value;
      payload.passwordConfirmation = $('invitePassword2').value;
      if (payload.password.length < 10) { banner('Le mot de passe doit contenir au moins 10 caractères.'); $('invitePassword').focus(); return; }
      if (payload.password !== payload.passwordConfirmation) { banner('Les deux mots de passe ne correspondent pas.'); $('invitePassword2').focus(); return; }
    }
    var submit = $('inviteSubmit');
    auth.setBusy(submit, true);
    fetch('/api/public/invitations/' + encodeURIComponent(token) + '/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        auth.setBusy(submit, false);
        if (!res.ok) {
          if (res.d.code === 'EXISTING_ACCOUNT' && !state.existing) { setExisting(true); $('inviteCurrent').focus(); }
          if (res.d.field === 'code') otp.error();
          if (res.status === 410 || res.status === 423) { gone(res.d.error); return; }
          banner(res.d.error || 'Activation impossible.');
          return;
        }
        var login = String(res.d.redirect || '').indexOf('/app/login') === 0;
        $('ivDoneTitle').textContent = res.d.joinedExisting ? 'Espace ajouté à votre compte' : 'Bienvenue dans l’équipe';
        $('ivDoneText').textContent = login ? 'Connectez-vous pour l’ouvrir…' : 'Ouverture de votre espace…';
        show('ivDone');
        setTimeout(function () { location.href = res.d.redirect; }, 700);
      })
      .catch(function () { auth.setBusy(submit, false); banner('Connexion impossible. Vérifiez votre réseau, puis réessayez.'); });
  });

  fetch('/api/public/invitations/' + encodeURIComponent(token))
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) { if (res.ok) render(res.d); else gone(); })
    .catch(function () { gone('Impossible de vérifier l’invitation. Vérifiez votre connexion, puis rechargez la page.'); });
})();
