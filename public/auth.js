/* Comportements partagés des pages d'accès (connexion, inscription, code). */
(function () {
  'use strict';

  var ICONS = {
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  };

  function showBanner(text, type) {
    var banner = document.getElementById('banner');
    if (!banner) return;
    banner.className = 'ax-banner ' + (type === 'success' ? 'success' : 'error');
    banner.setAttribute('role', type === 'success' ? 'status' : 'alert');
    banner.innerHTML = (type === 'success' ? ICONS.success : ICONS.error) + '<span></span>';
    banner.querySelector('span').textContent = text;
    banner.hidden = false;
  }

  // Afficher / masquer le mot de passe
  document.querySelectorAll('[data-toggle-pw]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.getAttribute('data-toggle-pw'));
      var visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      btn.textContent = visible ? 'Afficher' : 'Masquer';
      btn.setAttribute('aria-pressed', String(!visible));
      input.focus();
    });
  });

  // Bouton en cours d'envoi : empêche le double envoi sur connexion lente.
  function setBusy(button, busy) {
    if (!button) return;
    var label = button.querySelector('[data-label]');
    if (busy) {
      button.classList.add('is-loading');
      button.disabled = true;
      if (label && button.dataset.busy) { label.dataset.idle = label.textContent; label.textContent = button.dataset.busy; }
    } else {
      button.classList.remove('is-loading');
      button.disabled = false;
      if (label && label.dataset.idle) label.textContent = label.dataset.idle;
    }
  }
  document.querySelectorAll('form[data-busy-form]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (event.defaultPrevented || !form.checkValidity()) return;
      if (form.dataset.sending === '1') { event.preventDefault(); return; }
      form.dataset.sending = '1';
      setBusy(form.querySelector('.ax-submit'), true);
      // Animation plein écran : camion pour la connexion, livreur pressé pour la création de compte.
      if (form.dataset.loader && window.TraxoLoader) {
        event.preventDefault();
        window.TraxoLoader.submitWith(form, { kind: form.dataset.loader, message: form.dataset.loaderMessage });
      }
    });
  });
  // Retour arrière (cache du navigateur) : on réactive les boutons.
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    document.querySelectorAll('form[data-busy-form]').forEach(function (form) {
      form.dataset.sending = '';
      setBusy(form.querySelector('.ax-submit'), false);
    });
    busy(false);
  });

  // Écran de chargement plein écran (module partagé loaders.js)
  function busy(on, message, kind) {
    if (!window.TraxoLoader) return;
    if (on) window.TraxoLoader.show({ kind: kind || 'speeder', message: message });
    else window.TraxoLoader.hide();
  }

  // Bouton Google : affiché seulement si le serveur est configuré.
  var googleButtons = document.querySelectorAll('[data-google]');
  if (googleButtons.length) {
    fetch('/app/auth/config', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (config) {
      if (config.supportEmail) {
        document.querySelectorAll('[data-support]').forEach(function (a) { a.href = 'mailto:' + config.supportEmail; });
      }
      if (!config.google) return;
      document.querySelectorAll('[data-google-block]').forEach(function (el) { el.hidden = false; });
      googleButtons.forEach(function (link) {
        link.addEventListener('click', function (event) {
          var remember = document.getElementById('remember');
          var url = link.getAttribute('href').split('?')[0] + '?from=' + (link.dataset.google || 'login') + (remember && remember.checked ? '&remember=1' : '');
          event.preventDefault();
          busy(true, 'Ouverture de Google…');
          window.location.href = url;
        });
      });
    }).catch(function () { /* bouton laissé masqué */ });
  }

  // Champ de code à 6 cases : saisie, collage, remplissage automatique (SMS/e-mail).
  function mountOtp(root, hidden, onComplete) {
    var boxes = Array.prototype.slice.call(root.querySelectorAll('input'));
    function value() { return boxes.map(function (b) { return b.value; }).join(''); }
    function sync() {
      hidden.value = value();
      boxes.forEach(function (b) { b.classList.toggle('filled', Boolean(b.value)); });
      root.classList.remove('has-error');
      if (hidden.value.length === boxes.length && onComplete) onComplete(hidden.value);
    }
    function fill(from, digits) {
      for (var i = 0; i < digits.length && from + i < boxes.length; i += 1) boxes[from + i].value = digits[i];
      var next = Math.min(from + digits.length, boxes.length - 1);
      boxes[next].focus();
      sync();
    }
    boxes.forEach(function (box, index) {
      box.addEventListener('input', function () {
        var digits = box.value.replace(/\D/g, '');
        box.value = '';
        if (digits) fill(index, digits.split(''));
        else sync();
      });
      box.addEventListener('keydown', function (event) {
        if (event.key === 'Backspace' && !box.value && index > 0) { boxes[index - 1].value = ''; boxes[index - 1].focus(); sync(); event.preventDefault(); }
        if (event.key === 'ArrowLeft' && index > 0) { boxes[index - 1].focus(); event.preventDefault(); }
        if (event.key === 'ArrowRight' && index < boxes.length - 1) { boxes[index + 1].focus(); event.preventDefault(); }
      });
      box.addEventListener('paste', function (event) {
        var text = (event.clipboardData || window.clipboardData).getData('text') || '';
        var digits = text.replace(/\D/g, '').slice(0, boxes.length);
        if (!digits) return;
        event.preventDefault();
        fill(0, digits.split(''));
      });
      box.addEventListener('focus', function () { box.select(); });
    });
    return {
      focus: function () { (boxes.find(function (b) { return !b.value; }) || boxes[boxes.length - 1]).focus(); },
      error: function () { boxes.forEach(function (b) { b.value = ''; }); sync(); root.classList.add('has-error'); boxes[0].focus(); },
    };
  }

  window.TraxoAuth = { showBanner: showBanner, setBusy: setBusy, busy: busy, mountOtp: mountOtp };
})();
