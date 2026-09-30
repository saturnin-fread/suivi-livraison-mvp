/* Composants partagés du back-office et de l'appli livreur :
   interrupteur tactile, carte « Activer les notifications », notifications du navigateur. */
(function () {
  'use strict';

  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // L'input reste la source de vérité (id, name, checked, événement change).
  function switchHtml(options) {
    var o = options || {};
    return '<span class="tg' + (o.small ? ' tg-sm' : '') + '"><input class="tg-input" type="checkbox" role="switch"'
      + (o.id ? ' id="' + esc(o.id) + '"' : '')
      + (o.name ? ' name="' + esc(o.name) + '"' : '')
      + (o.checked ? ' checked' : '')
      + (o.disabled ? ' disabled' : '')
      + (o.label ? ' aria-label="' + esc(o.label) + '"' : '')
      + '><span class="tg-track"><span class="tg-knob"><span class="tg-dots">' + new Array(13).join('<i></i>') + '</span></span></span></span>';
  }

  var PREF_KEY = 'traxo.desktopNotif';
  var LATER_KEY = 'traxo.desktopNotif.later';
  var LATER_MS = 7 * 24 * 3600 * 1000;
  var read = function (key) { try { return localStorage.getItem(key); } catch (_e) { return null; } };
  var write = function (key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (_e) { /* stockage indisponible */ } };

  var notifications = {
    supported: function () { return 'Notification' in window && window.isSecureContext !== false; },
    permission: function () { return this.supported() ? Notification.permission : 'unsupported'; },
    // Activées = autorisées par le navigateur ET non coupées par l'utilisateur dans TRAXO.
    enabled: function () { return this.permission() === 'granted' && read(PREF_KEY) !== 'off'; },
    // La carte ne s'affiche que si le navigateur n'a encore rien décidé et que « Plus tard » date de plus de 7 jours.
    shouldAsk: function () {
      if (this.permission() !== 'default') return false;
      var later = Number(read(LATER_KEY) || 0);
      return !later || Date.now() - later > LATER_MS;
    },
    later: function () { write(LATER_KEY, String(Date.now())); },
    request: function () {
      var self = this;
      if (!self.supported()) return Promise.resolve('unsupported');
      return Promise.resolve(Notification.requestPermission()).then(function (result) {
        if (result === 'granted') write(PREF_KEY, 'on');
        return result;
      });
    },
    setEnabled: function (on) {
      var self = this;
      if (!on) { write(PREF_KEY, 'off'); return Promise.resolve('off'); }
      write(PREF_KEY, 'on');
      return self.permission() === 'granted' ? Promise.resolve('granted') : self.request();
    },
    // Affiche une notification (via le service worker si présent : indispensable sur Android).
    show: function (title, options) {
      if (!this.enabled()) return Promise.resolve(false);
      var opts = Object.assign({ icon: '/favicon.png', badge: '/favicon.png', lang: 'fr' }, options || {});
      var fallback = function () {
        try {
          var n = new Notification(title, opts);
          n.onclick = function () { window.focus(); if (opts.data && opts.data.url) location.href = opts.data.url; n.close(); };
          return true;
        } catch (_e) { return false; }
      };
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        return navigator.serviceWorker.ready.then(function (reg) { return reg.showNotification(title, opts).then(function () { return true; }); }).catch(fallback);
      }
      return Promise.resolve(fallback());
    },
  };

  var BELL = '<svg viewBox="0 0 448 512" aria-hidden="true"><path d="M224 0c-17.7 0-32 14.3-32 32V51.2C119 66 64 130.6 64 208v18.8c0 47-17.3 92.4-48.5 127.6l-7.4 8.3c-8.4 9.4-10.4 22.9-5.3 34.4S19.4 416 32 416H416c12.6 0 24-7.4 29.2-18.9s3.1-25-5.3-34.4l-7.4-8.3C401.3 319.2 384 273.9 384 226.8V208c0-77.4-55-142-128-156.8V32c0-17.7-14.3-32-32-32zm45.3 493.3c12-12 18.7-28.3 18.7-45.3H224 160c0 17 6.7 33.3 18.7 45.3s28.3 18.7 45.3 18.7s33.3-6.7 45.3-18.7z"/></svg>';

  // Carte « Activer les notifications ». onDone(résultat) est appelé après le choix.
  function mountNotifyCard(container, options) {
    var o = options || {};
    if (!container || !notifications.shouldAsk()) return null;
    var card = document.createElement('div');
    card.className = 'nt-card';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Notifications');
    card.innerHTML = '<span class="nt-card-bell">' + BELL + '</span><strong>' + esc(o.title || 'Activer les notifications') + '</strong>'
      + '<p>' + esc(o.text || '') + '</p>'
      + '<div class="nt-card-acts"><button type="button" class="nt-allow">Activer</button><button type="button" class="nt-later">Plus tard</button></div>';
    card.addEventListener('click', function (event) { event.stopPropagation(); });
    card.querySelector('.nt-allow').addEventListener('click', function () {
      notifications.request().then(function (result) {
        card.remove();
        if (o.onDone) o.onDone(result);
      });
    });
    card.querySelector('.nt-later').addEventListener('click', function () {
      notifications.later();
      card.remove();
      if (o.onDone) o.onDone('later');
    });
    if (o.prepend) container.prepend(card); else container.appendChild(card);
    return card;
  }

  window.TraxoUI = { switchHtml: switchHtml, notifications: notifications, mountNotifyCard: mountNotifyCard };
})();
