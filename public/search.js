// Recherche globale TRAXO (Ctrl/⌘ K) — kit « Navigation, recherche et support ».
// Les données viennent de GET /api/app/search (numéros, codes, mots dans toute
// la fiche, cloisonné par entreprise) ; les pages et actions sont filtrées ici.
// Une réponse plus ancienne n'écrase jamais celle d'une saisie plus récente.
(function () {
  'use strict';
  const svg = (inner, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const IC = {
    search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    arrow: svg('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
    all: svg('<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>'),
    client: svg('<path d="M16 2v2"/><path d="M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/><path d="M8 2v2"/><circle cx="12" cy="11" r="3"/><rect x="3" y="4" width="18" height="18" rx="2"/>', 1.7),
    order: svg('<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>', 1.7),
    request: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>', 1.7),
    run: svg('<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>', 1.7),
    incident: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 1.7),
    driver: svg('<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>', 1.7),
    page: svg('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>', 1.7),
    action: svg('<path d="M5 12h14"/><path d="M12 5v14"/>', 1.9),
  };
  const CATS = [
    { key: 'all', label: 'Tout', icon: 'all' },
    { key: 'clients', label: 'Clients', icon: 'client' },
    { key: 'orders', label: 'Commandes', icon: 'order' },
    { key: 'operations', label: 'Opérations', icon: 'run' },
    { key: 'drivers', label: 'Livreurs', icon: 'driver' },
    { key: 'pages', label: 'Pages', icon: 'page' },
  ];
  const ICON_OF = { client: 'client', order: 'order', request: 'request', run: 'run', incident: 'incident', driver: 'driver', page: 'page', action: 'action' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const digits = (v) => String(v || '').replace(/\D/g, '');

  // Surligne les mots saisis (ou les chiffres d'un numéro) sans casser l'échappement.
  function mark(text, q) {
    const raw = String(text == null ? '' : text);
    if (!q) return esc(raw);
    const f = fold(raw);
    const ranges = [];
    const isPhone = /^[\d\s+().\-/]+$/.test(q) && digits(q).length >= 3;
    if (isPhone) {
      const d = digits(q); const map = []; let ds = '';
      for (let i = 0; i < raw.length; i += 1) if (/\d/.test(raw[i])) { map.push(i); ds += raw[i]; }
      let at = ds.indexOf(d);
      if (at < 0 && d.length >= 8) { const tail = d.slice(-8); at = ds.indexOf(tail); if (at >= 0) ranges.push([map[at], map[at + tail.length - 1] + 1]); }
      else if (at >= 0) ranges.push([map[at], map[at + d.length - 1] + 1]);
    } else {
      fold(q).split(/\s+/).filter((t) => t.length >= 2).forEach((t) => { let i = f.indexOf(t); while (i >= 0) { ranges.push([i, i + t.length]); i = f.indexOf(t, i + t.length); } });
    }
    if (!ranges.length) return esc(raw);
    ranges.sort((a, b) => a[0] - b[0]);
    let out = ''; let pos = 0;
    for (const [s, e] of ranges) { if (s < pos) continue; out += esc(raw.slice(pos, s)) + `<mark>${esc(raw.slice(s, e))}</mark>`; pos = e; }
    return out + esc(raw.slice(pos));
  }

  let openState = null;

  function open({ api, pages = [], actions = [], initialQuery = '' } = {}) {
    if (openState) { openState.input.focus(); return; }
    const opener = document.activeElement;
    const root = document.createElement('div');
    root.className = 'gs-layer';
    root.innerHTML = `<div class="gs" role="dialog" aria-modal="true" aria-label="Rechercher dans TRAXO">
        <div class="gs-input"><span class="gs-lens">${IC.search}</span>
          <input type="search" id="gsInput" placeholder="Rechercher dans TRAXO…" autocomplete="off" spellcheck="false" enterkeyhint="search" aria-controls="gsList" aria-autocomplete="list">
          <button type="button" class="gs-clear" data-act="clear" aria-label="Effacer la recherche" hidden>${IC.x}</button>
          <button type="button" class="gs-close" data-act="close" aria-label="Fermer la recherche">${IC.x}</button></div>
        <div class="gs-cats" role="group" aria-label="Catégories">${CATS.map((c) => `<button type="button" data-cat="${c.key}" aria-pressed="${c.key === 'all'}">${IC[c.icon]}${c.label}</button>`).join('')}</div>
        <div class="gs-list" id="gsList" role="listbox" aria-label="Résultats"></div>
        <div class="gs-foot"><span><kbd>↑</kbd><kbd>↓</kbd> Parcourir · <kbd>Entrée</kbd> Ouvrir</span><span><kbd>Échap</kbd> Fermer</span></div>
        <p class="gs-live" aria-live="polite"></p>
      </div>`;
    const input = root.querySelector('#gsInput');
    const list = root.querySelector('#gsList');
    const live = root.querySelector('.gs-live');
    const st = { cat: 'all', q: '', items: [], active: 0, seq: 0, timer: null, remote: null, loading: false, error: null };
    openState = { input };

    const pageMatches = () => {
      const q = fold(st.q.trim());
      const pool = [...pages.map((p) => ({ ...p, type: 'page' })), ...actions.map((a) => ({ ...a, type: 'action' }))];
      if (!q) return pool.slice(0, 9);
      const words = q.split(/\s+/).filter(Boolean);
      return pool.filter((p) => { const f = fold(`${p.title} ${(p.path || []).join(' ')} ${p.keywords || ''}`); return words.every((w) => f.includes(w)); }).slice(0, 6);
    };

    function build() {
      const groups = [];
      const q = st.q.trim();
      if (st.cat === 'all' || st.cat === 'pages') {
        const pm = pageMatches();
        if (pm.length) groups.push({ key: 'pages', label: q ? 'Pages et actions' : 'Accès rapide', items: pm });
      }
      if (st.cat !== 'pages' && st.remote && st.remote.query === q) {
        const remote = st.remote.groups.map((g) => ({ key: g.key, label: g.label, more: g.more, items: g.items }));
        if (q) { // les données passent avant les pages quand on cherche
          const pagesGroup = groups.shift();
          groups.push(...remote);
          if (pagesGroup) groups.push(pagesGroup);
        }
      }
      return groups;
    }

    function paint() {
      const q = st.q.trim();
      root.querySelector('.gs-clear').hidden = !st.q;
      const groups = build();
      st.items = groups.flatMap((g) => g.items);
      st.active = Math.min(st.active, Math.max(0, st.items.length - 1));
      let html = '';
      let i = 0;
      for (const g of groups) {
        html += `<div class="gs-group" role="presentation">${esc(g.label)}</div>`;
        for (const it of g.items) {
          const path = (it.path || []).map(esc).join(' › ');
          const sub = [it.subtitle, it.detail].filter(Boolean).join(' · ');
          html += `<a class="gs-row${i === st.active ? ' on' : ''}" role="option" id="gs-o${i}" aria-selected="${i === st.active}" data-i="${i}" href="${esc(it.href || '#')}">
              <span class="gs-tile">${IC[ICON_OF[it.type]] || IC.page}</span>
              <span class="gs-txt"><strong>${mark(it.title, q)}${it.urgent ? ' <em class="gs-flag">Urgente</em>' : ''}${it.archived ? ' <em class="gs-flag muted">Archivé</em>' : ''}</strong>${sub ? `<small>${mark(sub, q)}</small>` : ''}${path ? `<small class="gs-path">${path}</small>` : ''}</span>
              <span class="gs-go">${IC.arrow}</span></a>`;
          i += 1;
        }
        if (g.more) html += `<p class="gs-more">D’autres résultats existent : précisez votre recherche${st.cat === 'all' ? ' ou choisissez une catégorie' : ''}.</p>`;
      }
      const searching = q.length >= 2 && st.cat !== 'pages';
      if (searching && st.loading && !(st.remote && st.remote.query === q)) html += '<div class="gs-state"><span class="gs-spin" aria-hidden="true"></span>Recherche en cours…</div>';
      else if (searching && st.error) html += `<div class="gs-state error">${esc(st.error)} <button type="button" data-act="retry">Réessayer</button></div>`;
      else if (q && !st.items.length && (!searching || (st.remote && st.remote.query === q))) {
        html += `<div class="gs-state"><strong>Aucun résultat pour « ${esc(q)} ».</strong>Essayez un nom, une partie du numéro (ex. 4218), un code CMD-… ou un quartier.</div>`;
      } else if (!q) html += '<p class="gs-hint">Cherchez un client, un numéro (même partiel), une commande, un livreur ou une page.</p>';
      else if (q.length < 2 && st.cat !== 'pages') html += '<p class="gs-hint">Encore une lettre pour lancer la recherche.</p>';
      list.innerHTML = html;
      input.setAttribute('aria-activedescendant', st.items.length ? `gs-o${st.active}` : '');
      if (searching && st.remote && st.remote.query === q) {
        const n = st.remote.groups.reduce((s, g) => s + g.items.length, 0);
        live.textContent = n ? `${n} résultat${n > 1 ? 's' : ''}` : 'Aucun résultat';
      }
    }

    function setActive(i) {
      st.active = i;
      list.querySelectorAll('.gs-row').forEach((row, k) => { row.classList.toggle('on', k === i); row.setAttribute('aria-selected', String(k === i)); if (k === i) row.scrollIntoView({ block: 'nearest' }); });
      input.setAttribute('aria-activedescendant', `gs-o${i}`);
    }

    async function query() {
      const q = st.q.trim();
      if (st.cat === 'pages' || q.length < 2) { st.loading = false; st.error = null; paint(); return; }
      const seq = ++st.seq;
      st.loading = true; st.error = null; paint();
      try {
        const scope = st.cat === 'all' ? 'all' : st.cat;
        const data = await api(`/api/app/search?q=${encodeURIComponent(q)}&scope=${scope}`);
        if (seq !== st.seq || !openState) return; // saisie plus récente en cours
        st.remote = { ...data, query: q };
      } catch (error) {
        if (seq !== st.seq) return;
        st.error = error && error.status === 429 ? 'Trop de recherches d’un coup. Patientez quelques secondes.' : 'La recherche n’a pas abouti.';
      }
      if (seq === st.seq) { st.loading = false; paint(); }
    }
    const schedule = () => { clearTimeout(st.timer); st.timer = setTimeout(query, 160); };

    function choose(i) {
      const it = st.items[i]; if (!it) return;
      close(false);
      if (typeof it.run === 'function') it.run(); else if (it.href) location.href = it.href;
    }
    function close(restore = true) {
      clearTimeout(st.timer); st.seq += 1;
      document.removeEventListener('keydown', onKey, true);
      root.remove(); openState = null;
      if (restore && opener && opener.focus) opener.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); if (st.items.length) setActive((st.active + 1) % st.items.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (st.items.length) setActive((st.active - 1 + st.items.length) % st.items.length); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); if (st.items.length) choose(st.active); }
      else if (e.key === 'Tab') { // focus gardé dans la fenêtre
        const f = [...root.querySelectorAll('input, button:not([hidden]), a.gs-row')];
        const idx = f.indexOf(document.activeElement);
        if (e.shiftKey && idx <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && idx === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    }

    input.addEventListener('input', () => { st.q = input.value; st.active = 0; paint(); schedule(); });
    root.addEventListener('click', (e) => {
      const row = e.target.closest('.gs-row');
      if (row) { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return; e.preventDefault(); choose(Number(row.dataset.i)); return; }
      const cat = e.target.closest('[data-cat]');
      if (cat) { st.cat = cat.dataset.cat; root.querySelectorAll('[data-cat]').forEach((b) => b.setAttribute('aria-pressed', String(b === cat))); st.active = 0; st.remote = null; paint(); query(); input.focus(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') close();
      else if (act === 'clear') { input.value = ''; st.q = ''; st.remote = null; paint(); input.focus(); }
      else if (act === 'retry') query();
    });
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    list.addEventListener('mousemove', (e) => { const row = e.target.closest('.gs-row'); if (row && Number(row.dataset.i) !== st.active) setActive(Number(row.dataset.i)); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    if (initialQuery) { input.value = initialQuery; st.q = initialQuery; }
    paint(); if (st.q) query();
    input.focus();
  }

  window.TraxoSearch = { open, isOpen: () => Boolean(openState) };
})();
