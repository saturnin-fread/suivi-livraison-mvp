/* Écran de chargement TRAXO (partagé : pages d'accès, configuration, back-office).
   TraxoLoader.show({ kind, message }) · TraxoLoader.hide() ·
   TraxoLoader.sequence(étapes) → Promise résolue à la fin de la séquence. */
(function () {
  'use strict';
  var TRUCK = '<div class="tx-truck" data-kind="truck" aria-hidden="true"><div class="tr-body"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 198 93"><path stroke-width="3" stroke="#282828" fill="#E5192B" d="M135 22.5H177.264C178.295 22.5 179.22 23.133 179.594 24.0939L192.33 56.8443C192.442 57.1332 192.5 57.4404 192.5 57.7504V89C192.5 90.3807 191.381 91.5 190 91.5H135C133.619 91.5 132.5 90.3807 132.5 89V25C132.5 23.6193 133.619 22.5 135 22.5Z"/><path stroke-width="3" stroke="#282828" fill="#7D7C7C" d="M146 33.5H181.741C182.779 33.5 183.709 34.1415 184.078 35.112L190.538 52.112C191.16 53.748 189.951 55.5 188.201 55.5H146C144.619 55.5 143.5 54.3807 143.5 53V36C143.5 34.6193 144.619 33.5 146 33.5Z"/><path stroke-width="2" stroke="#282828" fill="#282828" d="M150 65C150 65.39 149.763 65.8656 149.127 66.2893C148.499 66.7083 147.573 67 146.5 67C145.427 67 144.501 66.7083 143.873 66.2893C143.237 65.8656 143 65.39 143 65C143 64.61 143.237 64.1344 143.873 63.7107C144.501 63.2917 145.427 63 146.5 63C147.573 63 148.499 63.2917 149.127 63.7107C149.763 64.1344 150 64.61 150 65Z"/><rect stroke-width="2" stroke="#282828" fill="#FFFCAB" rx="1" height="7" width="5" y="63" x="187"/><rect stroke-width="2" stroke="#282828" fill="#282828" rx="1" height="11" width="4" y="81" x="193"/><rect stroke-width="3" stroke="#282828" fill="#DFDFDF" rx="2.5" height="90" width="121" y="1.5" x="6.5"/><rect stroke-width="2" stroke="#282828" fill="#DFDFDF" rx="2" height="4" width="6" y="84" x="1"/><path d="M40 34h54M40 46h38" stroke="#E5192B" stroke-width="6" stroke-linecap="round"/></svg></div><div class="tr-tires"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 30 30"><circle stroke-width="3" stroke="#282828" fill="#282828" r="13.5" cy="15" cx="15"/><circle fill="#DFDFDF" r="7" cy="15" cx="15"/></svg><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 30 30"><circle stroke-width="3" stroke="#282828" fill="#282828" r="13.5" cy="15" cx="15"/><circle fill="#DFDFDF" r="7" cy="15" cx="15"/></svg></div><div class="tr-road"></div><svg class="tr-lamp" viewBox="0 0 453.459 453.459" xmlns="http://www.w3.org/2000/svg" fill="#000"><path d="M252.882,0c-37.781,0-68.686,29.953-70.245,67.358h-6.917v8.954c-26.109,2.163-45.463,10.011-45.463,19.366h9.993c-1.65,5.146-2.507,10.54-2.507,16.017c0,28.956,23.558,52.514,52.514,52.514c28.956,0,52.514-23.558,52.514-52.514c0-5.478-0.856-10.872-2.506-16.017h9.992c0-9.354-19.352-17.204-45.463-19.366v-8.954h-6.149C200.189,38.779,223.924,16,252.882,16c29.952,0,54.32,24.368,54.32,54.32c0,28.774-11.078,37.009-25.105,47.437c-17.444,12.968-37.216,27.667-37.216,78.884v113.914h-0.797c-5.068,0-9.174,4.108-9.174,9.177c0,2.844,1.293,5.383,3.321,7.066c-3.432,27.933-26.851,95.744-8.226,115.459v11.202h45.75v-11.202c18.625-19.715-4.794-87.527-8.227-115.459c2.029-1.683,3.322-4.223,3.322-7.066c0-5.068-4.107-9.177-9.176-9.177h-0.795V196.641c0-43.174,14.942-54.283,30.762-66.043c14.793-10.997,31.559-23.461,31.559-60.277C323.202,31.545,291.656,0,252.882,0zM232.77,111.694c0,23.442-19.071,42.514-42.514,42.514c-23.442,0-42.514-19.072-42.514-42.514c0-5.531,1.078-10.957,3.141-16.017h78.747C231.693,100.736,232.77,106.162,232.77,111.694z"/></svg></div>';
  var SPEEDER = '<div class="tx-speeder" data-kind="speeder" aria-hidden="true"><div class="sp-body"><span><span></span><span></span><span></span><span></span></span><div class="sp-base"><span></span><div class="sp-face"></div></div></div><div class="sp-lines"><span></span><span></span><span></span><span></span></div></div>';
  var el = null;
  var timers = [];

  function ensure() {
    if (el && document.body.contains(el)) return el;
    el = document.getElementById('txBusy');
    if (el) el.remove();
    el = document.createElement('div');
    el.className = 'tx-busy';
    el.id = 'txBusy';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="tx-busy-inner" role="status" aria-live="polite"><div class="tx-busy-stage">' + SPEEDER + TRUCK + '</div><p>Chargement…</p><div class="tx-busy-bar" hidden><i></i></div></div>';
    document.body.appendChild(el);
    return el;
  }
  function setKind(kind) {
    ensure().querySelectorAll('[data-kind]').forEach(function (node) { node.classList.toggle('is-hidden', node.dataset.kind !== kind); });
  }
  function setMessage(text) {
    var p = ensure().querySelector('p');
    if (p.textContent === text) return;
    p.classList.add('is-fading');
    setTimeout(function () { p.textContent = text; p.classList.remove('is-fading'); }, 220);
  }
  function clear() { timers.forEach(clearTimeout); timers = []; }

  function show(opts) {
    var o = opts || {};
    clear();
    var node = ensure();
    setKind(o.kind === 'truck' ? 'truck' : 'speeder');
    node.querySelector('p').textContent = o.message || 'Chargement…';
    node.querySelector('.tx-busy-bar').hidden = true;
    node.classList.add('on');
    node.setAttribute('aria-hidden', 'false');
  }
  function hide() {
    clear();
    if (!el) return;
    el.classList.remove('on');
    el.setAttribute('aria-hidden', 'true');
  }
  // Séquence d'étapes { kind, message, ms } avec barre de progression.
  function sequence(steps) {
    clear();
    var total = steps.reduce(function (sum, s) { return sum + s.ms; }, 0);
    show({ kind: steps[0].kind, message: steps[0].message });
    var bar = el.querySelector('.tx-busy-bar');
    var fill = bar.querySelector('i');
    bar.hidden = false;
    fill.style.transition = 'none';
    fill.style.width = '0%';
    requestAnimationFrame(function () {
      fill.style.transition = 'width ' + total + 'ms linear';
      fill.style.width = '100%';
    });
    return new Promise(function (resolve) {
      var at = 0;
      steps.forEach(function (step, i) {
        if (i > 0) timers.push(setTimeout(function () { setKind(step.kind); setMessage(step.message); }, at));
        at += step.ms;
      });
      timers.push(setTimeout(resolve, total));
    });
  }
  // Soumission de formulaire avec animation : laisse l'animation se voir un
  // instant avant d'envoyer (le navigateur change ensuite de page).
  function submitWith(form, opts, delay) {
    show(opts);
    setTimeout(function () { HTMLFormElement.prototype.submit.call(form); }, delay == null ? 900 : delay);
  }
  window.addEventListener('pageshow', function (event) { if (event.persisted) hide(); });
  // Toute déconnexion affiche le camion.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute || form.dataset.loaderSkip) return;
    if (/\/(app|admin)\/logout$/.test(form.getAttribute('action') || '')) {
      event.preventDefault();
      submitWith(form, { kind: 'truck', message: 'Déconnexion… à bientôt.' }, 1100);
    }
  });
  window.TraxoLoader = { show: show, hide: hide, sequence: sequence, submitWith: submitWith };
})();
