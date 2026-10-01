// Livreurs TRAXO (kit « Livreurs Premium », données réelles).
// Quatre vues dans la même page, chacune avec son adresse :
//   /app/livreurs                     le répertoire
//   /app/livreurs?livreur=ID          le profil
//   /app/livreurs?nouveau=1           l'ajout en trois étapes
//   /app/livreurs?livreur=ID&acces=1  l'invitation par QR code
// Un livreur rejoint l'équipe en scannant un QR à usage unique (15 min) ;
// un seul téléphone est connecté à la fois.
(function () {
  'use strict';

  const P = {
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    arrowUpRight: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
    wifiOff: '<path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M5 12.86a10 10 0 0 1 5.17-2.69"/><path d="M19 12.86a10 10 0 0 0-2.01-1.52"/><path d="M2 8.82a15 15 0 0 1 4.18-2.65"/><path d="M22 8.82a15 15 0 0 0-11.29-3.76"/><path d="m2 2 20 20"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    call: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    send: '<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.03.94l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    party: '<path d="M5.8 11.3 2 22l10.7-3.79"/><path d="M4 3h.01"/><path d="M22 8h.01"/><path d="M15 2h.01"/><path d="M22 20h.01"/><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"/><path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11-.11.7-.72 1.22-1.43 1.22H17"/><path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98-.7.1-1.22.72-1.22 1.43V7"/><path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2z"/>',
  };
  const ic = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const pad2 = (n) => String(n).padStart(2, '0');
  const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
  const dayLabel = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const same = d.toDateString() === today.toDateString();
    const yesterday = new Date(today.getTime() - 86400000).toDateString() === d.toDateString();
    if (same) return `aujourd’hui à ${hhmm(iso)}`;
    if (yesterday) return `hier à ${hhmm(iso)}`;
    return `le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
  };
  const ago = (iso) => {
    const ms = iso ? Date.now() - new Date(iso).getTime() : NaN;
    if (!Number.isFinite(ms) || ms < 0) return '';
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'À l’instant';
    if (min < 60) return `Il y a ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `Il y a ${h} h`;
    return `Il y a ${Math.floor(h / 24)} j`;
  };
  // Couleurs d'avatar stables par personne (tons doux).
  const AVATAR_TONES = [['#e9eef9', '#4a5d8f'], ['#eaf2ec', '#3f6b52'], ['#fbefe6', '#8a5a36'], ['#f6eaf0', '#8b4466'], ['#efeaf7', '#5e4b8b'], ['#e8f3f3', '#356b6b']];
  const tone = (d) => AVATAR_TONES[Math.abs(Number(d.id) || 0) % AVATAR_TONES.length];

  let D = null; // dépendances fournies par app.js
  let S = null; // état de la page
  let popBound = false;

  // ---- États dérivés -------------------------------------------------------
  const OFFLINE = ['inactive', 'offline', 'stale', 'unknown', 'off_duty'];
  function activityOf(d) {
    if (d.suspended) return { key: 'suspended', label: 'Suspendu', icon: 'ban', tone: 'mute', sub: 'Accès coupé' };
    if (d.availabilityStatus === 'incident' || d.operationalState === 'incident') return { key: 'incident', label: 'Incident', icon: 'alert', tone: 'red', sub: d.lastUpdate ? ago(d.lastUpdate) : '' };
    if (d.operationalState === 'pause') return { key: 'pause', label: 'En pause', icon: 'pause', tone: 'amber', sub: d.lastUpdate ? ago(d.lastUpdate) : '' };
    if (!d.active || OFFLINE.includes(d.operationalState)) {
      const sub = d.availabilityStatus === 'off_duty' ? 'Hors service' : d.lastUpdate ? ago(d.lastUpdate) : 'Jamais connecté';
      return { key: 'offline', label: 'Hors ligne', icon: 'wifiOff', tone: 'mute', sub };
    }
    if (['busy', 'full'].includes(d.operationalState)) return { key: 'busy', label: 'En livraison', icon: 'bike', tone: 'blue', sub: ago(d.lastUpdate) };
    return { key: 'available', label: 'Disponible', icon: 'check', tone: 'green', sub: ago(d.lastUpdate) };
  }
  function accessOf(d) {
    if (d.accessState === 'suspended') return { key: 'suspended', label: 'Suspendu', icon: 'ban', tone: 'mute', sub: 'Plus de missions' };
    if (d.accessState === 'invited') return { key: 'invited', label: 'Invitation prête', icon: 'clock', tone: 'blue', sub: d.inviteExpiresAt ? `Valable jusqu’à ${hhmm(d.inviteExpiresAt)}` : 'À scanner' };
    if (d.accessState === 'active') return { key: 'active', label: 'Accès actif', icon: 'check', tone: 'green', sub: d.device ? 'Téléphone associé' : 'Aucun téléphone connecté' };
    return { key: 'none', label: 'À inviter', icon: 'phone', tone: 'amber', sub: 'QR à créer' };
  }
  const pendingAccess = (d) => ['none', 'invited'].includes(d.accessState);
  const badge = (b) => `<span class="dr-badge ${b.tone}">${ic(b.icon)}${esc(b.label)}</span>`;

  function avatar(d, size = '') {
    const [bg, fg] = tone(d);
    const url = d.hasPhoto && d.id ? `/api/app/drivers/${encodeURIComponent(d.id)}/photo?v=${d.photoVersion || 0}` : '';
    return url
      ? `<span class="dr-av ${size}"><img src="${url}" alt="" loading="lazy"></span>`
      : `<span class="dr-av ${size}" style="background:${bg};color:${fg}">${esc(initials(d.name))}</span>`;
  }

  // ---- Navigation interne --------------------------------------------------
  async function go(params = {}, { replace = false } = {}) {
    const unsaved = S.leaveGuard?.();
    if (unsaved) {
      const ok = await D.uiConfirm('Quitter sans enregistrer ?', { message: `${unsaved} Elles seront perdues si vous quittez cette page.`, confirmLabel: 'Quitter sans enregistrer', cancelLabel: 'Rester sur le profil' });
      if (!ok) return;
    }
    S.leaveGuard = null;
    const qs = new URLSearchParams(params).toString();
    const url = `/app/livreurs${qs ? `?${qs}` : ''}`;
    try { history[replace ? 'replaceState' : 'pushState'](null, '', url); } catch { /* ignore */ }
    route();
  }
  function route() {
    stopTimers();
    S.leaveGuard = null;
    const q = new URLSearchParams(location.search);
    window.scrollTo(0, 0);
    if (q.get('nouveau')) return S.canManage ? viewAdd() : go({}, { replace: true });
    const id = q.get('livreur');
    if (id) {
      const driver = S.drivers.find((d) => String(d.id) === String(id));
      if (!driver) { D.uiToast('Ce livreur n’est plus dans votre équipe.', 'warning'); return go({}, { replace: true }); }
      if (q.get('acces') && S.canManage) return viewInvite(driver);
      return viewProfile(driver);
    }
    return viewList();
  }
  async function reload() {
    S.drivers = await D.api('/api/app/drivers');
  }
  const timers = new Set();
  function stopTimers() { timers.forEach((t) => clearInterval(t)); timers.clear(); }
  function every(ms, fn) { const t = setInterval(fn, ms); timers.add(t); return t; }

  async function call(url, method = 'GET', body) {
    return D.api(url, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  // L'erreur serveur peut viser un champ précis : on la garde pour l'afficher au bon endroit.
  async function callRaw(url, method, body) {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (response.status === 401) { location.href = '/app/login'; throw new Error('Session expirée.'); }
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  // ---- Répertoire ------------------------------------------------------------
  function viewList() {
    D.setHeader('Livreurs', 'Une équipe prête à prendre la route');
    const all = S.drivers;
    const live = all.filter((d) => !d.suspended);
    const counts = { available: 0, busy: 0, offline: 0 };
    live.forEach((d) => { const k = activityOf(d).key; if (k === 'available') counts.available += 1; else if (k === 'busy') counts.busy += 1; else counts.offline += 1; });
    const toFinish = live.filter(pendingAccess).length;
    const zones = [...new Set(all.map((d) => d.zone).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
    if (S.zone && !zones.includes(S.zone)) S.zone = '';

    if (!all.length) {
      S.page.innerHTML = `<div class="dr dr-in">
        <div class="dr-heading"><div><h1>Livreurs</h1><p>Votre équipe sur le terrain. Chaque profil, chaque connexion.</p></div></div>
        <section class="dr-empty">
          <span class="dr-empty-ic">${ic('users')}</span>
          <h2>Votre équipe commence ici.</h2>
          <p>Un nom, un numéro de téléphone : votre livreur reçoit son accès personnel en un scan, et ne voit que ses propres livraisons.</p>
          ${S.canManage ? `<button class="dr-btn primary" type="button" data-act="add">${ic('plus')} Ajouter mon premier livreur</button>` : '<p class="dr-muted">Demandez au responsable de l’entreprise d’ajouter les livreurs.</p>'}
        </section>
      </div>`;
      bindCommon();
      return;
    }

    const people = live.slice(0, 4);
    S.page.innerHTML = `<div class="dr dr-in">
      <div class="dr-heading">
        <div><h1>Livreurs</h1><p>Votre équipe sur le terrain. Chaque profil, chaque connexion.</p></div>
        <div class="dr-actions">
          <button class="dr-btn" type="button" data-act="export">${ic('download')} Exporter</button>
          ${S.canManage ? `<button class="dr-btn primary" type="button" data-act="add">${ic('plus')} Ajouter un livreur</button>` : ''}
        </div>
      </div>
      <div class="dr-overview">
        <section class="dr-team">
          <span class="dr-eyebrow">Votre équipe</span>
          <div class="dr-summary">
            <span class="dr-big">${pad2(live.length)}</span>
            <p>${live.length > 1 ? 'livreurs pour faire avancer vos livraisons.' : 'livreur pour faire avancer vos livraisons.'}</p>
            <span class="dr-people" aria-hidden="true">${people.map((d) => avatar(d)).join('')}${live.length > 4 ? `<span class="dr-av more">+${live.length - 4}</span>` : ''}</span>
          </div>
          <div class="dr-counts"><span><b>${counts.available}</b>${counts.available > 1 ? 'disponibles' : 'disponible'}</span><span><b>${counts.busy}</b>en livraison</span><span><b>${counts.offline}</b>hors ligne</span></div>
        </section>
        ${toFinish ? `<section class="dr-access warm">
          <span class="dr-access-art" aria-hidden="true">${ic('qr')}</span>
          <div>
            <h2>${toFinish > 1 ? `${toFinish} accès à finaliser` : '1 accès à finaliser'}</h2>
            <p>Un scan, une confirmation. Votre livreur rejoint la bonne entreprise.</p>
            <button class="dr-link" type="button" data-tab="invites">${ic('arrowUpRight')} Gérer les invitations</button>
          </div>
        </section>` : `<section class="dr-access calm">
          <span class="dr-access-art" aria-hidden="true">${ic('shield')}</span>
          <div>
            <h2>Toute l’équipe est connectée.</h2>
            <p>Chaque livreur a son propre accès, sur un seul téléphone à la fois.</p>
          </div>
        </section>`}
      </div>
      <section class="dr-card dr-dir">
        <div class="dr-dir-head"><h2>Le répertoire</h2><span class="dr-muted">${plural(all.length, 'profil', 'profils')}</span></div>
        <div class="dr-tabs" role="tablist">${[
          ['all', 'Tous', all.length],
          ['invites', 'Invitations', live.filter(pendingAccess).length],
          ['suspended', 'Suspendus', all.filter((d) => d.suspended).length],
        ].map(([k, l, n]) => `<button type="button" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${l}<span>${n}</span></button>`).join('')}</div>
        <div class="dr-filters">
          <label class="dr-search">${ic('search')}<input type="search" id="drSearch" placeholder="Un nom, un téléphone, un identifiant…" value="${esc(S.query)}" autocomplete="off" aria-label="Rechercher un livreur"></label>
          ${zones.length ? `<label class="dr-select"><select id="drZone" aria-label="Zone"><option value="">Toutes les zones</option>${zones.map((z) => `<option ${S.zone === z ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>${ic('chevronDown')}</label>` : ''}
          <label class="dr-select"><select id="drActivity" aria-label="Activité">${[['', 'Toute l’activité'], ['available', 'Disponible'], ['busy', 'En livraison'], ['pause', 'En pause'], ['offline', 'Hors ligne']].map(([v, l]) => `<option value="${v}" ${S.activity === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${ic('chevronDown')}</label>
        </div>
        <div class="dr-table" role="table" aria-label="Livreurs">
          <div class="dr-thead" role="row">
            <button type="button" class="dr-sort" data-act="sort" role="columnheader" aria-sort="${S.sortDesc ? 'descending' : 'ascending'}">Livreur ${ic('chevronDown')}</button>
            <span role="columnheader">Activité</span><span role="columnheader">Zone</span><span role="columnheader">Colis / capacité</span><span role="columnheader">Accès à l’app</span><span></span>
          </div>
          <div id="drRows"></div>
        </div>
        <div class="dr-foot" id="drFoot"></div>
      </section>
    </div>`;
    paintRows();
    bindCommon();
    const search = S.page.querySelector('#drSearch');
    search.addEventListener('input', () => { S.query = search.value; paintRows(); });
    S.page.querySelector('#drZone')?.addEventListener('change', (e) => { S.zone = e.target.value; paintRows(); });
    S.page.querySelector('#drActivity').addEventListener('change', (e) => { S.activity = e.target.value; paintRows(); });
  }

  function filtered() {
    const q = S.query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return S.drivers.filter((d) => {
      if (S.tab === 'invites' && (d.suspended || !pendingAccess(d))) return false;
      if (S.tab === 'suspended' && !d.suspended) return false;
      if (S.zone && d.zone !== S.zone) return false;
      if (S.activity) {
        const k = activityOf(d).key;
        if (S.activity === 'offline' ? !['offline', 'suspended', 'incident'].includes(k) : k !== S.activity) return false;
      }
      if (!q) return true;
      const hay = `${d.name} ${d.code || ''} ${d.zone || ''} ${d.team || ''} ${d.vehicleType || ''} ${d.email || ''}`.toLowerCase();
      return hay.includes(q) || (digits.length >= 3 && String(d.phone || '').replace(/\D/g, '').includes(digits));
    }).sort((a, b) => (S.sortDesc ? -1 : 1) * a.name.localeCompare(b.name, 'fr'));
  }

  function paintRows() {
    const rows = filtered();
    const box = S.page.querySelector('#drRows');
    const foot = S.page.querySelector('#drFoot');
    if (!rows.length) {
      const why = S.tab === 'invites' ? 'Aucune invitation en attente : tout le monde a son accès.' : S.tab === 'suspended' ? 'Aucun profil suspendu.' : 'Aucun livreur ne correspond à cette recherche.';
      box.innerHTML = `<div class="dr-none">${esc(why)}${S.query || S.zone || S.activity ? ' <button class="dr-link" type="button" data-act="clear">Effacer les filtres</button>' : ''}</div>`;
    } else {
      box.innerHTML = rows.map((d) => {
        const a = activityOf(d);
        const acc = accessOf(d);
        const cap = Math.max(1, Number(d.capacity) || 1);
        const load = Math.min(100, Math.round((Number(d.activeOrders) || 0) / cap * 100));
        return `<a class="dr-row" role="row" href="/app/livreurs?livreur=${encodeURIComponent(d.id)}" data-open="${esc(d.id)}">
          <span class="dr-cell dr-who" role="cell">${avatar(d)}<span><strong>${esc(d.name)}</strong><small>${esc([d.vehicleType, d.code].filter(Boolean).join(' · '))}</small></span></span>
          <span class="dr-cell" role="cell" data-label="Activité">${badge(a)}<small>${esc(a.sub || '')}</small></span>
          <span class="dr-cell" role="cell" data-label="Zone">${d.zone ? `<span>${esc(d.zone)}</span>` : '<span class="dr-muted">Zone libre</span>'}<small>${esc(d.team || '')}</small></span>
          <span class="dr-cell dr-load" role="cell" data-label="Colis"><i style="--w:${load}%"></i><span>${Number(d.activeOrders) || 0} / ${cap}</span></span>
          <span class="dr-cell" role="cell" data-label="Accès">${badge(acc)}<small>${esc(acc.sub)}</small></span>
          <span class="dr-cell dr-chev" role="cell" aria-hidden="true">${ic('chevronRight')}</span>
        </a>`;
      }).join('');
    }
    foot.innerHTML = `<span>${rows.length} sur ${plural(S.drivers.length, 'livreur', 'livreurs')}</span>`;
  }

  function exportCsv() {
    const rows = filtered();
    const head = ['Identifiant', 'Nom', 'Téléphone', 'E-mail', 'Véhicule', 'Immatriculation', 'Zone', 'Équipe', 'Capacité', 'Colis en cours', 'Activité', 'Accès à l’app'];
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // pas de formule dans un tableur
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head, ...rows.map((d) => [d.code, d.name, d.phone, d.email, d.vehicleType, d.plate, d.zone, d.team, d.capacity, d.activeOrders, activityOf(d).label, accessOf(d).label])]
      .map((r) => r.map(cell).join(';'));
    const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `livreurs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    D.uiToast(`${plural(rows.length, 'livreur exporté', 'livreurs exportés')}.`, 'success');
  }

  function bindCommon() {
    S.page.onclick = (event) => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      const tab = event.target.closest('[data-tab]')?.dataset.tab;
      const open = event.target.closest('[data-open]');
      if (open && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) { event.preventDefault(); go({ livreur: open.dataset.open }); return; }
      if (tab) {
        const fromOverview = Boolean(event.target.closest('.dr-access'));
        S.tab = tab;
        viewList();
        if (fromOverview) S.page.querySelector('.dr-dir')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (act === 'add') go({ nouveau: '1' });
      else if (act === 'export') exportCsv();
      else if (act === 'sort') { S.sortDesc = !S.sortDesc; S.page.querySelector('.dr-sort')?.setAttribute('aria-sort', S.sortDesc ? 'descending' : 'ascending'); S.page.querySelector('.dr-sort')?.classList.toggle('desc', S.sortDesc); paintRows(); }
      else if (act === 'clear') { S.query = ''; S.zone = ''; S.activity = ''; viewList(); }
      else if (act === 'back') go({});
    };
  }

  // ---- Champs partagés (profil et ajout) --------------------------------------
  const field = (id, label, input, hint = '', cls = '') => `<div class="dr-field ${cls}"><label for="${id}">${label}</label>${input}${hint ? `<p class="dr-hint" data-hint-for="${id}">${hint}</p>` : `<p class="dr-hint" data-hint-for="${id}" hidden></p>`}</div>`;
  const text = (id, name, value, attrs = '') => `<input class="dr-input" id="${id}" name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
  const datalist = (id, values) => `<datalist id="${id}">${[...new Set(values.filter(Boolean))].map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  // Numéro béninois affiché sans indicatif (« +229 01 97… » ou ancien « 22901… »).
  const nationalBj = (value) => {
    const raw = String(value || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (/^\+?229/.test(raw.replace(/\s/g, '')) && digits.length >= 11) return digits.slice(3);
    return raw;
  };
  const phoneInput = (value) => `<div class="dr-phone ${/^\+(?!229)/.test(String(value || '').replace(/\s/g, '')) ? 'intl' : ''}"><span aria-hidden="true">+229</span><input class="dr-input" id="drPhone" name="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="01 00 00 00 00" maxlength="24" value="${esc(nationalBj(value))}" required></div>`;
  function vehicleSelect(selected) {
    return `<label class="dr-select wide"><select class="dr-input" id="drVehicle" name="vehicleType">${D.vehicleTypes.map((v) => `<option ${v === (selected || 'Moto') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>${ic('chevronDown')}</label>`;
  }
  function permissionRows(d) {
    return `<div class="dr-perms">
      <div class="dr-perm locked">${ic('lock')}<div><strong>Consulter et mettre à jour ses livraisons</strong><small>Uniquement celles qui lui sont confiées.</small></div></div>
      <label class="dr-perm"><input type="checkbox" name="canContact" ${d.canContact !== false ? 'checked' : ''}><div><strong>Appeler le destinataire</strong><small>Il voit le numéro du client pour ses propres livraisons.</small></div></label>
      <label class="dr-perm"><input type="checkbox" name="canReportIncident" ${d.canReportIncident !== false ? 'checked' : ''}><div><strong>Signaler un incident</strong><small>Un retard, une adresse introuvable, un colis non remis.</small></div></label>
    </div>
    <p class="dr-shield">${ic('shield')}L’accès livreur ne donne accès ni à la gestion de l’entreprise, ni à sa facturation.</p>`;
  }
  function showFieldError(root, fieldName, message) {
    const map = { name: 'drName', phone: 'drPhone', email: 'drEmail', vehicleType: 'drVehicle', capacity: 'drCapacity', trackerId: 'drTracker', plate: 'drPlate', zone: 'drZone2', team: 'drTeam' };
    const input = root.querySelector(`#${map[fieldName] || ''}`);
    if (!input) { D.uiToast(message, 'error'); return false; }
    input.setAttribute('aria-invalid', 'true');
    const hint = root.querySelector(`[data-hint-for="${input.id}"]`);
    if (hint) { hint.dataset.prev = hint.dataset.prev ?? hint.innerHTML; hint.hidden = false; hint.classList.add('err'); hint.textContent = message; }
    input.focus();
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      if (hint) { hint.classList.remove('err'); hint.innerHTML = hint.dataset.prev || ''; hint.hidden = !hint.dataset.prev; }
    }, { once: true });
    return true;
  }
  const readForm = (form) => {
    const data = Object.fromEntries(new FormData(form));
    Object.keys(data).forEach((k) => { data[k] = String(data[k] ?? '').trim(); });
    ['canContact', 'canReportIncident'].forEach((k) => {
      const box = form.querySelector(`[name="${k}"]`);
      if (box) data[k] = box.checked;
    });
    return data;
  };

  // ---- Profil ------------------------------------------------------------------
  function viewProfile(d) {
    D.setHeader('Livreurs', d.name);
    const a = activityOf(d);
    const ro = S.canManage ? '' : 'disabled';
    const others = S.drivers;
    S.page.innerHTML = `<div class="dr dr-in">
      <button class="dr-back" type="button" data-act="back">${ic('arrowLeft')} Tous les livreurs</button>
      <div class="dr-phead">
        <div class="dr-photo">${avatar(d, 'xl')}${S.canManage ? `<button type="button" class="dr-photo-btn" id="drPhotoBtn" aria-label="Changer la photo">${ic('camera')}</button><input type="file" id="drPhotoInput" accept="image/jpeg,image/png,image/webp" hidden>` : ''}</div>
        <div class="dr-ptitle"><h1>${esc(d.name)}</h1><p>${esc([d.code, d.team, d.zone].filter(Boolean).join(' · ') || d.vehicleType)}</p></div>
        <span class="dr-pstate">${badge(a)}</span>
      </div>
      <div class="dr-pgrid">
        <form class="dr-card dr-form" id="drForm" novalidate>
          <div class="dr-card-head"><div><h2>Profil et organisation</h2><p>Les bonnes informations, au même endroit.</p></div>${ic('user')}</div>
          <div class="dr-grid2">
            ${field('drName', 'Nom complet *', text('drName', 'name', d.name, `maxlength="80" autocomplete="off" required ${ro}`))}
            ${field('drPhone', 'Téléphone *', phoneInput(d.phone).replace('required', `required ${ro}`), d.accessState === 'active' ? 'Le changer déconnecte son téléphone actuel.' : 'Sert à vérifier son identité.')}
            ${field('drEmail', 'Adresse e-mail', text('drEmail', 'email', d.email, `type="email" placeholder="Facultatif" autocomplete="off" ${ro}`))}
            ${field('drCode', 'Identifiant du livreur', `<input class="dr-input ro" id="drCode" value="${esc(d.code || '—')}" readonly tabindex="-1">`, 'Conservé même si le téléphone change.')}
          </div>
          <hr class="dr-sep">
          <div class="dr-grid2">
            ${field('drVehicle', 'Véhicule', vehicleSelect(d.vehicleType).replace('name="vehicleType"', `name="vehicleType" ${ro}`))}
            ${field('drPlate', 'Immatriculation', text('drPlate', 'plate', d.plate, `maxlength="20" placeholder="Facultatif" autocomplete="off" ${ro}`))}
            ${field('drZone2', 'Zone principale', text('drZone2', 'zone', d.zone, `list="drZones" maxlength="80" placeholder="Ex. Akpakpa" autocomplete="off" ${ro}`))}
            ${field('drTeam', 'Équipe', text('drTeam', 'team', d.team, `list="drTeams" maxlength="80" placeholder="Ex. Équipe Est" autocomplete="off" ${ro}`))}
            ${field('drCapacity', 'Capacité maximale · colis', text('drCapacity', 'capacity', d.capacity, `type="number" min="1" max="500" inputmode="numeric" ${ro}`), 'Au-delà, on ne lui propose plus de nouvelle livraison.')}
            ${field('drAvail', 'Disponibilité', `<label class="dr-select wide"><select class="dr-input" id="drAvail" name="availability" ${ro || (d.suspended ? 'disabled' : '')}>${[['available', 'Disponible'], ['pause', 'En pause'], ['off_duty', 'Hors service'], ['incident', 'Incident en cours']].map(([v, l]) => `<option value="${v}" ${d.availabilityStatus === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${ic('chevronDown')}</label>`, 'Sert à choisir à qui confier les prochaines livraisons.')}
          </div>
          ${datalist('drZones', others.map((o) => o.zone))}${datalist('drTeams', others.map((o) => o.team))}
          ${field('drNote', 'Note interne', `<textarea class="dr-input" id="drNote" name="note" rows="3" maxlength="500" placeholder="Une consigne utile pour votre équipe…" ${ro}>${esc(d.note || '')}</textarea>`, 'Visible uniquement par les personnes qui gèrent les livreurs.', 'full')}
          <details class="dr-adv"><summary>${ic('chevronRight')} Traceur GPS</summary>
            ${field('drTracker', 'Identifiant du traceur', text('drTracker', 'trackerId', d.uniqueId, `maxlength="64" autocomplete="off" spellcheck="false" ${ro}`), 'À modifier seulement si le livreur utilise un boîtier GPS ou l’appli Traccar avec un autre identifiant.')}
          </details>
          <hr class="dr-sep">
          <h3 class="dr-h3">Ce que le livreur peut faire</h3>
          <fieldset class="dr-fs" ${ro}>${permissionRows(d)}</fieldset>
          ${S.canManage ? `<div class="dr-formfoot"><button class="dr-btn ghost" type="button" data-act="back">Retour</button><button class="dr-btn primary" type="submit" id="drSave" disabled>Enregistrer les modifications</button></div>` : '<p class="dr-muted" style="margin-top:18px">Seuls le propriétaire et les managers peuvent modifier ce profil.</p>'}
        </form>
        <aside class="dr-side">
          ${accessCard(d)}
          <section class="dr-card dr-recent"><h2>Ses dernières livraisons</h2><div id="drRecent"><div class="dr-skel"></div><div class="dr-skel"></div></div></section>
          ${S.canManage ? manageCard(d) : ''}
        </aside>
      </div>
    </div>`;
    bindCommon();
    bindProfile(d);
    loadRecent(d);
  }

  function accessCard(d) {
    const acc = accessOf(d);
    const head = `<div class="dr-card-head"><div><h2>Accès à l’application</h2><p>${d.suspended ? 'Coupé tant que le profil est suspendu.' : 'Son espace personnel pour suivre ses livraisons.'}</p></div></div>`;
    let body = '';
    if (acc.key === 'active') {
      body = `<div class="dr-acc-line">${badge(acc)}</div>
        <div class="dr-device">${ic('phone')}<div><strong>${d.device ? esc(d.device.label) : 'Aucun téléphone connecté'}</strong><small>${d.device ? `Connecté depuis ${esc(dayLabel(d.device.since))}` : 'Le compte existe ; il se reconnectera depuis son téléphone.'}</small></div></div>
        ${S.canManage ? `<button class="dr-btn full" type="button" data-act="replace">${ic('refresh')} Il change de téléphone</button><p class="dr-hint">Un nouveau QR associe le nouveau téléphone et déconnecte l’ancien.</p>` : ''}`;
    } else if (acc.key === 'invited') {
      body = `<div class="dr-acc-line">${badge(acc)}</div>
        <div class="dr-device">${ic('qr')}<div><strong>Invitation par QR code</strong><small>Valable jusqu’à ${esc(hhmm(d.inviteExpiresAt))}, une seule fois.</small></div></div>
        ${S.canManage ? `<button class="dr-btn dark full" type="button" data-act="invite">${ic('qr')} Afficher un QR à scanner</button><p class="dr-hint">Pour votre sécurité, le QR n’est montré qu’une fois. En afficher un nouveau remplace le précédent.</p>` : ''}`;
    } else if (acc.key === 'suspended') {
      body = `<div class="dr-acc-line">${badge(acc)}</div><p class="dr-hint">Il ne peut plus se connecter ni recevoir de livraison. Son historique est conservé.</p>`;
    } else {
      body = `<div class="dr-acc-line">${badge(acc)}</div>
        <div class="dr-device">${ic('qr')}<div><strong>Connexion par QR code</strong><small>Un code et un lien sont aussi proposés en secours.</small></div></div>
        ${S.canManage ? `<button class="dr-btn dark full" type="button" data-act="invite" ${d.phone ? '' : 'disabled'}>${ic('qr')} Inviter sur son téléphone</button><p class="dr-hint">${d.phone ? 'À faire à côté de lui : il scanne, vérifie, et c’est prêt.' : 'Ajoutez d’abord son numéro de téléphone.'}</p>` : ''}`;
    }
    return `<section class="dr-card dr-accesscard ${acc.key}">${head}${body}</section>`;
  }

  function manageCard(d) {
    return `<section class="dr-card dr-manage"><h2>Gestion du profil</h2>
      ${d.suspended
        ? `<p>Ce profil est suspendu. Réactivez-le pour lui confier de nouveau des livraisons.</p><button class="dr-btn full" type="button" data-act="reactivate">${ic('refresh')} Réactiver le profil</button>`
        : `<p>Suspendez l’accès si ce livreur quitte temporairement votre équipe. Son historique est conservé.</p><button class="dr-btn full dr-danger" type="button" data-act="suspend">${ic('ban')} Suspendre l’accès</button>`}
      <button class="dr-link dr-danger" type="button" data-act="archive">${ic('trash')} Retirer de l’équipe</button>
    </section>`;
  }

  async function loadRecent(d) {
    const box = S.page.querySelector('#drRecent');
    try {
      const data = await D.api(`/api/app/drivers/${encodeURIComponent(d.id)}/activity`);
      if (!box.isConnected) return;
      box.innerHTML = data.updates && data.updates.length
        ? `<ul class="dr-updates">${data.updates.map((u) => `<li><a href="/app/commandes/${encodeURIComponent(u.id)}"><span><strong>${esc(u.customerName || u.reference || `Commande ${u.id}`)}</strong><small>${esc(u.status)}</small></span><time>${esc(ago(u.at))}</time></a></li>`).join('')}</ul>`
        : '<p class="dr-muted">Pas encore de livraison. Elles apparaîtront ici dès sa première course.</p>';
    } catch {
      if (box.isConnected) box.innerHTML = '<p class="dr-muted">Impossible de charger ses livraisons pour le moment.</p>';
    }
  }

  function bindProfile(d) {
    const form = S.page.querySelector('#drForm');
    const save = S.page.querySelector('#drSave');
    const initial = JSON.stringify(readForm(form));
    const dirty = () => JSON.stringify(readForm(form)) !== initial;
    form.addEventListener('input', () => { if (save) save.disabled = !dirty(); });
    form.addEventListener('change', () => { if (save) save.disabled = !dirty(); });
    S.leaveGuard = () => (save && dirty() ? 'Vos modifications ne sont pas enregistrées.' : '');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!S.canManage || !dirty()) return;
      const data = readForm(form);
      const before = JSON.parse(initial);
      if (data.name.length < 2) { showFieldError(form, 'name', 'Indiquez son nom complet.'); return; }
      if (!data.phone) { showFieldError(form, 'phone', 'Le téléphone est nécessaire : il sert à vérifier son identité.'); return; }
      const phoneChanged = data.phone !== before.phone;
      if (phoneChanged && d.accessState === 'active') {
        const ok = await D.uiConfirm('Changer son numéro ?', { message: `Son téléphone actuel sera déconnecté. ${firstName(d.name)} devra scanner un nouveau QR code pour retrouver ses livraisons.`, confirmLabel: 'Changer le numéro' });
        if (!ok) return;
      }
      const body = {};
      ['name', 'email', 'plate', 'zone', 'team', 'note', 'trackerId', 'vehicleType'].forEach((k) => { if (data[k] !== before[k]) body[k] = data[k]; });
      if (phoneChanged) { body.phone = data.phone; body.phoneCountry = 'BJ'; }
      if (data.capacity !== before.capacity) body.capacity = Number(data.capacity);
      if (data.canContact !== before.canContact) body.canContact = data.canContact;
      if (data.canReportIncident !== before.canReportIncident) body.canReportIncident = data.canReportIncident;
      save.disabled = true;
      save.textContent = 'Enregistrement…';
      try {
        let accessReset = false;
        if (Object.keys(body).length) {
          const result = await callRaw(`/api/app/drivers/${encodeURIComponent(d.id)}`, 'PATCH', body);
          if (!result.ok) {
            save.textContent = 'Enregistrer les modifications';
            save.disabled = false;
            if (result.data.field === 'trackerId') form.querySelector('.dr-adv').open = true;
            if (!showFieldError(form, result.data.field, result.data.error || 'Enregistrement impossible.')) return;
            return;
          }
          accessReset = Boolean(result.data.accessReset);
        }
        if (data.availability !== before.availability) {
          await call(`/api/app/drivers/${encodeURIComponent(d.id)}/availability`, 'PATCH', { status: data.availability });
        }
        await reload();
        S.leaveGuard = null;
        D.uiToast(accessReset ? 'Profil enregistré. Son ancien téléphone est déconnecté : invitez-le de nouveau.' : 'Profil enregistré.', accessReset ? 'warning' : 'success');
        route();
      } catch (error) {
        save.textContent = 'Enregistrer les modifications';
        save.disabled = false;
        D.uiToast(error.message, 'error');
      }
    });

    const common = S.page.onclick;
    S.page.onclick = (event) => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (S.canManage && ['invite', 'replace', 'suspend', 'reactivate', 'archive'].includes(act)) profileAction(act);
      else common(event);
    };
    const profileAction = async (act) => {
      if (act === 'invite') { S.autoInvite = true; go({ livreur: d.id, acces: '1' }); }
      else if (act === 'replace') { S.replacement = true; S.autoInvite = true; go({ livreur: d.id, acces: '1' }); }
      else if (act === 'suspend') {
        const ok = await D.uiConfirm(`Suspendre ${firstName(d.name)} ?`, { message: 'Il est déconnecté tout de suite et ne reçoit plus de livraison. Son profil et son historique restent ; vous pourrez le réactiver à tout moment.', tone: 'danger', confirmLabel: 'Suspendre l’accès' });
        if (!ok) return;
        try { await call(`/api/app/drivers/${encodeURIComponent(d.id)}/suspend`, 'POST', {}); await reload(); D.uiToast(`${firstName(d.name)} est suspendu.`, 'success'); route(); } catch (error) { D.uiToast(error.message, 'error'); }
      } else if (act === 'reactivate') {
        try { await call(`/api/app/drivers/${encodeURIComponent(d.id)}/reactivate`, 'POST', {}); await reload(); D.uiToast(`${firstName(d.name)} fait de nouveau partie de l’équipe active.`, 'success'); route(); } catch (error) { D.uiToast(error.message, 'error'); }
      } else if (act === 'archive') {
        const ok = await D.uiConfirm(`Retirer ${d.name} de l’équipe ?`, { message: 'Son profil disparaît de la liste et son accès est coupé. Les livraisons passées restent dans l’historique. Sa place reste comptée jusqu’à la fin du mois.', tone: 'danger', confirmLabel: 'Retirer de l’équipe' });
        if (!ok) return;
        try { await call(`/api/app/drivers/${encodeURIComponent(d.id)}`, 'DELETE'); await reload(); D.uiToast(`${d.name} ne fait plus partie de l’équipe.`, 'success'); go({}, { replace: true }); } catch (error) { D.uiToast(error.message, 'error'); }
      }
    };

    // Photo : redimensionnée dans le navigateur avant l'envoi.
    const pick = S.page.querySelector('#drPhotoBtn');
    const input = S.page.querySelector('#drPhotoInput');
    if (pick && input) {
      pick.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { D.uiToast('Choisissez une photo au format JPEG, PNG ou WebP.', 'error'); return; }
        pick.disabled = true;
        try {
          const dataUrl = await resizeImage(file);
          await call(`/api/app/drivers/${encodeURIComponent(d.id)}/photo`, 'POST', { dataUrl });
          await reload();
          D.uiToast('Photo enregistrée.', 'success');
          const fresh = S.drivers.find((x) => String(x.id) === String(d.id));
          S.page.querySelector('.dr-photo .dr-av').outerHTML = avatar(fresh || d, 'xl');
        } catch (error) { D.uiToast(error.message, 'error'); } finally { pick.disabled = false; }
      });
    }
  }

  async function resizeImage(file, max = 320) {
    const bitmap = await createImageBitmap(file).catch(() => null);
    const source = bitmap || await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = URL.createObjectURL(file); });
    const w = source.width || source.naturalWidth;
    const h = source.height || source.naturalHeight;
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (bitmap && bitmap.close) bitmap.close();
    let quality = 0.86;
    let url = canvas.toDataURL('image/jpeg', quality);
    while (url.length > 230 * 1024 && quality > 0.35) { quality -= 0.12; url = canvas.toDataURL('image/jpeg', quality); }
    return url;
  }

  // ---- Ajout en trois étapes -------------------------------------------------
  const STEPS = ['Son profil', 'Son organisation', 'Son accès'];
  function viewAdd() {
    D.setHeader('Livreurs', 'Un nouveau livreur');
    if (!S.draft) S.draft = { step: 0, data: { vehicleType: 'Moto', capacity: '10', canContact: true, canReportIncident: true } };
    const { step, data } = S.draft;
    const stepper = `<ol class="dr-steps">${STEPS.map((label, i) => `<li class="${i < step ? 'done' : i === step ? 'current' : ''}"><span>${i < step ? ic('check') : i + 1}</span>${label}</li>`).join('')}</ol>`;
    let body = '';
    if (step === 0) {
      body = `<h2>Commençons par faire connaissance.</h2><p class="dr-lead">Son nom et son téléphone suffisent pour démarrer.</p>
        ${field('drName', 'Nom complet *', text('drName', 'name', data.name, 'maxlength="80" autocomplete="off" required'))}
        ${field('drPhone', 'Téléphone *', phoneInput(data.phone), 'Au Bénin : 10 chiffres commençant par 01.')}
        ${field('drEmail', 'Adresse e-mail', text('drEmail', 'email', data.email, 'type="email" placeholder="Facultatif" autocomplete="off"'))}
        ${field('drCode', 'Identifiant du livreur', '<input class="dr-input ro" id="drCode" value="Créé automatiquement" readonly tabindex="-1">', 'Conservé même si le téléphone change.')}
        <p class="dr-note">${ic('call')}Le numéro servira à vérifier son identité lors de sa première connexion.</p>`;
    } else if (step === 1) {
      body = `<h2>Où et comment il livre.</h2><p class="dr-lead">Tout se modifie plus tard, depuis son profil.</p>
        <div class="dr-grid2">
          ${field('drVehicle', 'Véhicule', vehicleSelect(data.vehicleType))}
          ${field('drPlate', 'Immatriculation', text('drPlate', 'plate', data.plate, 'maxlength="20" placeholder="Facultatif" autocomplete="off"'))}
          ${field('drZone2', 'Zone principale', text('drZone2', 'zone', data.zone, 'list="drZones" maxlength="80" placeholder="Ex. Akpakpa" autocomplete="off"'))}
          ${field('drTeam', 'Équipe', text('drTeam', 'team', data.team, 'list="drTeams" maxlength="80" placeholder="Facultatif" autocomplete="off"'))}
          ${field('drCapacity', 'Capacité maximale · colis', text('drCapacity', 'capacity', data.capacity, 'type="number" min="1" max="500" inputmode="numeric"'))}
        </div>
        ${datalist('drZones', S.drivers.map((o) => o.zone))}${datalist('drTeams', S.drivers.map((o) => o.team))}
        <h3 class="dr-h3">Ce qu’il pourra faire</h3>
        ${permissionRows(data)}`;
    } else {
      const where = [data.zone, data.team].filter(Boolean).join(' · ');
      body = `<h2>Dernière étape : son accès.</h2><p class="dr-lead">Son profil est prêt. Il ne reste qu’à le relier à son téléphone.</p>
        <div class="dr-recap">
          ${avatar({ id: 0, name: data.name }, 'lg')}
          <div><strong>${esc(data.name)}</strong><small>+229 ${esc(nationalBj(data.phone))}</small><small>${esc([data.vehicleType, where].filter(Boolean).join(' · '))}</small></div>
          <button class="dr-link" type="button" data-step="0">Modifier</button>
        </div>
        <ol class="dr-gestures">
          <li><span>1</span><div><strong>Vous affichez son QR code</strong><small>Juste après la création, sur cet écran.</small></div></li>
          <li><span>2</span><div><strong>Il le scanne avec son téléphone</strong><small>Avec l’appareil photo, sans rien installer.</small></div></li>
          <li><span>3</span><div><strong>Il confirme votre entreprise</strong><small>Ses livraisons s’ouvrent aussitôt.</small></div></li>
        </ol>`;
    }
    S.page.innerHTML = `<div class="dr dr-in dr-addwrap">
      <button class="dr-back" type="button" data-act="cancel">${ic('arrowLeft')} Tous les livreurs</button>
      <div class="dr-heading"><div><h1>Un nouveau livreur dans l’équipe</h1><p>Quelques informations, puis son accès personnel à TRAXO.</p></div></div>
      ${stepper}
      <form class="dr-card dr-wizard" id="drWizard" novalidate>
        ${body}
        <div class="dr-formfoot">
          <button class="dr-btn ghost" type="button" data-act="${step ? 'prev' : 'cancel'}">${step ? 'Retour' : 'Annuler'}</button>
          ${step < 2
            ? `<button class="dr-btn primary" type="submit">Continuer ${ic('arrowRight')}</button>`
            : `<span class="dr-final"><button class="dr-btn" type="button" data-act="createOnly">Créer sans inviter</button><button class="dr-btn primary" type="submit">${ic('qr')} Créer et afficher son QR</button></span>`}
        </div>
      </form>
    </div>`;
    const form = S.page.querySelector('#drWizard');
    const keep = () => { if (step < 2) Object.assign(data, readForm(form)); };
    form.querySelector('input:not([readonly])')?.focus();
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      keep();
      if (step === 0) {
        if (String(data.name || '').length < 2) { showFieldError(form, 'name', 'Indiquez son nom complet, tel qu’il apparaîtra au client.'); return; }
        const digits = String(data.phone || '').replace(/\D/g, '');
        if (digits.length < 8) { showFieldError(form, 'phone', 'Indiquez son numéro : il sert à vérifier que c’est bien lui.'); return; }
        if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { showFieldError(form, 'email', 'Cette adresse e-mail semble incomplète.'); return; }
      }
      if (step === 1) {
        const cap = Number(data.capacity);
        if (!Number.isInteger(cap) || cap < 1 || cap > 500) { showFieldError(form, 'capacity', 'Entre 1 et 500 colis.'); return; }
      }
      if (step < 2) { S.draft.step += 1; viewAdd(); return; }
      create(true, form);
    });
    S.page.onclick = (event) => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      const jump = event.target.closest('[data-step]')?.dataset.step;
      if (jump != null) { S.draft.step = Number(jump); viewAdd(); return; }
      if (act === 'prev') { keep(); S.draft.step -= 1; viewAdd(); }
      else if (act === 'cancel') { S.draft = null; go({}); }
      else if (act === 'createOnly') create(false, form);
    };
  }

  async function create(invite, form) {
    const { data } = S.draft;
    const buttons = [...form.querySelectorAll('.dr-formfoot button')];
    buttons.forEach((b) => { b.disabled = true; });
    const body = {
      name: data.name, phone: data.phone, phoneCountry: 'BJ', email: data.email || undefined,
      vehicleType: data.vehicleType, capacity: Number(data.capacity) || 10, plate: data.plate || undefined,
      zone: data.zone || undefined, team: data.team || undefined,
      canContact: data.canContact !== false, canReportIncident: data.canReportIncident !== false,
    };
    const result = await callRaw('/api/app/drivers', 'POST', body).catch((error) => ({ ok: false, data: { error: error.message } }));
    if (!result.ok) {
      buttons.forEach((b) => { b.disabled = false; });
      const stepOf = { name: 0, phone: 0, email: 0, vehicleType: 1, capacity: 1, plate: 1, zone: 1, team: 1 };
      if (result.status === 409 && result.data.driverId) {
        const ok = await D.uiConfirm('Ce livreur existe déjà', { message: result.data.error, confirmLabel: 'Ouvrir son profil' });
        if (ok) { S.draft = null; await reload(); go({ livreur: result.data.driverId }); }
        return;
      }
      if (result.data.field && stepOf[result.data.field] != null) {
        S.draft.step = stepOf[result.data.field];
        viewAdd();
        showFieldError(S.page.querySelector('#drWizard'), result.data.field, result.data.error);
        return;
      }
      D.uiToast(result.data.error || 'Impossible de créer ce livreur.', 'error');
      return;
    }
    S.draft = null;
    await reload();
    if (invite) { S.autoInvite = true; go({ livreur: result.data.id, acces: '1' }, { replace: true }); return; }
    D.uiToast(`${firstName(body.name)} fait partie de l’équipe. Invitez-le quand il sera à côté de vous.`, 'success');
    go({ livreur: result.data.id }, { replace: true });
  }

  // ---- Invitation par QR -----------------------------------------------------
  let qrLib = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLib) {
      qrLib = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/qrcode/qrcode.js';
        s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('qrcode')));
        s.onerror = () => { qrLib = null; reject(new Error('qrcode')); };
        document.head.appendChild(s);
      });
    }
    return qrLib;
  }

  function viewInvite(d) {
    D.setHeader('Livreurs', `Invitation de ${d.name}`);
    const replacement = Boolean(S.replacement) || d.accessState === 'active';
    const company = D.context?.company?.name || 'votre entreprise';
    const inv = S.invites[d.id] && new Date(S.invites[d.id].expiresAt) > new Date() ? S.invites[d.id] : null;
    S.page.innerHTML = `<div class="dr dr-in">
      <button class="dr-back" type="button" data-act="profile">${ic('arrowLeft')} Revenir au profil</button>
      <div class="dr-phead">
        <div class="dr-ptitle"><h1>${replacement ? 'Son nouveau téléphone, en un scan.' : 'Son accès TRAXO est prêt.'}</h1><p>${esc(d.name)} · ${esc(company)}</p></div>
        <span class="dr-pstate" id="drInvState">${inv ? badge({ tone: 'blue', icon: 'clock', label: 'Invitation prête' }) : ''}</span>
      </div>
      <section class="dr-card dr-invite">
        <div class="dr-qrside" id="drQrSide"></div>
        <div class="dr-steps-side">
          <span class="dr-eyebrow">Côté livreur</span>
          <h2>Trois gestes. Il est prêt.</h2>
          <ol class="dr-gestures">
            <li><span>1</span><div><strong>Scanner le QR code</strong><small>Avec l’appareil photo de son téléphone, sans rien installer.</small></div></li>
            <li><span>2</span><div><strong>Vérifier que c’est bien lui</strong><small id="drVerifyText">${inv && inv.verification === 'whatsapp' ? 'Un code arrive sur son WhatsApp, au numéro de son profil.' : 'Vous êtes à côté de lui : le QR montré en personne suffit.'}</small></div></li>
            <li><span>3</span><div><strong>Confirmer son entreprise</strong><small>Il retrouve son nom et accepte de rejoindre ${esc(company)}.</small></div></li>
          </ol>
          <p class="dr-shield">${ic('shield')}Cette invitation est réservée à ${esc(d.name)}. Elle ne fonctionne qu’une fois${replacement ? ' et déconnectera son ancien téléphone' : ''}.</p>
        </div>
      </section>
      <div class="dr-endbar"><button class="dr-btn primary" type="button" data-act="done">${ic('check')} Terminer et revenir aux livreurs</button></div>
    </div>`;
    S.page.onclick = (event) => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'profile') { S.replacement = false; go({ livreur: d.id }); }
      else if (act === 'done') { S.replacement = false; go({}); }
      else if (act === 'newqr') makeInvite(d, replacement);
      else if (act === 'revoke') revokeInvite(d);
      else if (act === 'copyCode') copy(S.invites[d.id]?.code, event.target.closest('button'), 'Code copié');
      else if (act === 'copyLink') copy(S.invites[d.id]?.url, event.target.closest('button'), 'Lien copié');
    };
    if (inv) paintQr(d, inv); else paintPrepare(d, replacement);
  }

  function paintPrepare(d, replacement) {
    const side = S.page.querySelector('#drQrSide');
    side.innerHTML = `<div class="dr-qrhead"><h2>Un scan pour rejoindre votre équipe.</h2><p>Le QR reste valable 15 minutes. Affichez-le quand ${esc(firstName(d.name))} est à côté de vous.</p></div>
      <div class="dr-qrbox empty">${ic('qr')}</div>
      <button class="dr-btn primary" type="button" data-act="newqr">${ic('qr')} Afficher son QR code</button>`;
    // Arrivée depuis l'ajout ou le bouton « Inviter » : on génère tout de suite.
    if (S.autoInvite) { S.autoInvite = false; makeInvite(d, replacement); }
  }

  async function makeInvite(d, replacement) {
    const side = S.page.querySelector('#drQrSide');
    const btn = side?.querySelector('[data-act="newqr"]');
    if (btn) btn.disabled = true;
    try {
      const inv = await call(`/api/app/drivers/${encodeURIComponent(d.id)}/invitation`, 'POST', { replacement });
      inv.url = D.publicLink(inv.path);
      inv.createdAt = Date.now();
      S.invites[d.id] = inv;
      if (!S.page.querySelector('#drQrSide')) return;
      const state = S.page.querySelector('#drInvState');
      if (state) state.innerHTML = badge({ tone: 'blue', icon: 'clock', label: 'Invitation prête' });
      const verify = S.page.querySelector('#drVerifyText');
      if (verify) verify.textContent = inv.verification === 'whatsapp' ? 'Un code arrive sur son WhatsApp, au numéro de son profil.' : 'Vous êtes à côté de lui : le QR montré en personne suffit.';
      paintQr(d, inv);
    } catch (error) {
      if (btn) btn.disabled = false;
      D.uiToast(error.message, 'error');
    }
  }

  async function revokeInvite(d) {
    const ok = await D.uiConfirm('Annuler cette invitation ?', { message: 'Le QR code, le code et le lien ne fonctionneront plus. Vous pourrez en créer un nouveau à tout moment.', confirmLabel: 'Annuler l’invitation', cancelLabel: 'Garder' });
    if (!ok) return;
    try {
      await call(`/api/app/drivers/${encodeURIComponent(d.id)}/invitation`, 'DELETE');
      delete S.invites[d.id];
      await reload();
      D.uiToast('Invitation annulée.', 'success');
      S.replacement = false;
      go({ livreur: d.id }, { replace: true });
    } catch (error) { D.uiToast(error.message, 'error'); }
  }

  async function copy(value, button, done) {
    if (!value || !button) return;
    try { await navigator.clipboard.writeText(value); } catch {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand && document.execCommand('copy');
      area.remove();
      if (!ok) { D.uiToast(`Copiez ce texte : ${value}`, 'info', { timeout: 12000 }); return; }
    }
    const label = button.innerHTML;
    button.innerHTML = `${ic('check')} ${done}`;
    setTimeout(() => { if (button.isConnected) button.innerHTML = label; }, 1800);
  }

  function paintQr(d, inv) {
    stopTimers();
    const side = S.page.querySelector('#drQrSide');
    const host = (() => { try { return new URL(inv.url).host; } catch { return location.host; } })();
    const wa = String(d.phone || '').replace(/\D/g, '');
    const waText = encodeURIComponent(`Bonjour ${firstName(d.name)}, voici ton accès TRAXO pour ${D.context?.company?.name || 'notre équipe'} : ${inv.url}\nValable 15 minutes, une seule fois.`);
    side.innerHTML = `<div class="dr-qrhead"><h2>Un scan pour rejoindre votre équipe.</h2><p>${esc(firstName(d.name))} ouvre l’appareil photo de son téléphone et vise ce code.</p></div>
      <div class="dr-qrbox" id="drQr" aria-label="QR code d’invitation"></div>
      <p class="dr-timer" id="drTimer">${ic('clock')}<span></span></p>
      <div class="dr-qractions">
        <button class="dr-btn" type="button" data-act="newqr">${ic('refresh')} Nouveau QR</button>
        <button class="dr-btn ghost" type="button" data-act="revoke">Annuler l’invitation</button>
      </div>
      <details class="dr-help">
        <summary>${ic('chevronRight')} Il n’arrive pas à scanner ?</summary>
        <div>
          <p>Sur son téléphone, il ouvre <strong>${esc(host)}/rejoindre</strong> et saisit ce code :</p>
          <div class="dr-code"><code>${esc(inv.code)}</code><button class="dr-btn small" type="button" data-act="copyCode">${ic('copy')} Copier</button></div>
          <div class="dr-helpbtns">
            <button class="dr-btn small" type="button" data-act="copyLink">${ic('copy')} Copier le lien</button>
            ${wa ? `<a class="dr-btn small" href="https://wa.me/${wa}?text=${waText}" target="_blank" rel="noopener">${ic('send')} L’envoyer sur son WhatsApp</a>` : ''}
          </div>
          <p class="dr-hint">À n’envoyer qu’à son numéro : toute personne qui ouvre ce lien dans les 15 minutes peut rejoindre votre équipe à sa place.</p>
        </div>
      </details>`;
    loadQr().then((qrcode) => {
      const qr = qrcode(0, 'M');
      qr.addData(inv.url);
      qr.make();
      const box = side.querySelector('#drQr');
      if (box) box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    }).catch(() => {
      const box = side.querySelector('#drQr');
      if (box) box.innerHTML = '<p class="dr-muted">Le QR n’a pas pu s’afficher. Utilisez le code ci-dessous.</p>';
      side.querySelector('.dr-help').open = true;
    });
    const end = new Date(inv.expiresAt).getTime();
    const timer = side.querySelector('#drTimer span');
    const tick = () => {
      const left = Math.max(0, Math.round((end - Date.now()) / 1000));
      if (!left) { expired(d); return; }
      timer.textContent = `Expire dans ${Math.floor(left / 60)} min ${pad2(left % 60)} s · usage unique`;
      side.querySelector('#drTimer').classList.toggle('late', left < 120);
    };
    tick();
    every(1000, tick);
    // Le livreur a-t-il rejoint ? On vérifie toutes les 5 s tant que le QR est affiché.
    every(5000, async () => {
      try {
        const list = await D.api('/api/app/drivers');
        const fresh = list.find((x) => String(x.id) === String(d.id));
        // Heures du serveur des deux côtés : la session du livreur est postérieure à l'invitation.
        const joinedAt = fresh?.device?.since ? new Date(fresh.device.since).getTime() : 0;
        const issuedAt = new Date(inv.expiresAt).getTime() - 15 * 60 * 1000 - 5000;
        if (fresh && fresh.accessState === 'active' && joinedAt >= issuedAt) {
          S.drivers = list;
          delete S.invites[d.id];
          joined(fresh);
        }
      } catch { /* réseau : on réessaie au prochain tour */ }
    });
  }

  function expired(d) {
    stopTimers();
    delete S.invites[d.id];
    const side = S.page.querySelector('#drQrSide');
    if (!side) return;
    const state = S.page.querySelector('#drInvState');
    if (state) state.innerHTML = badge({ tone: 'mute', icon: 'clock', label: 'QR expiré' });
    side.innerHTML = `<div class="dr-qrhead"><h2>Ce QR a expiré.</h2><p>Pour votre sécurité, un QR ne vit que 15 minutes. Affichez-en un nouveau quand ${esc(firstName(d.name))} est prêt.</p></div>
      <div class="dr-qrbox empty">${ic('clock')}</div>
      <button class="dr-btn primary" type="button" data-act="newqr">${ic('refresh')} Afficher un nouveau QR</button>`;
  }

  function joined(d) {
    stopTimers();
    S.replacement = false;
    const side = S.page.querySelector('#drQrSide');
    const state = S.page.querySelector('#drInvState');
    if (state) state.innerHTML = badge(accessOf(d));
    if (!side) return;
    side.innerHTML = `<div class="dr-joined">
      <span class="dr-joined-ic">${ic('check')}</span>
      <h2>C’est fait : ${esc(firstName(d.name))} a rejoint l’équipe.</h2>
      <p>${d.device ? `Connecté sur ${esc(d.device.label)}.` : 'Son téléphone est associé.'} Ses livraisons s’affichent déjà dans son application.</p>
      <button class="dr-btn" type="button" data-act="profile">Voir son profil</button>
    </div>`;
  }

  // ---- Point d'entrée -------------------------------------------------------
  async function render(page, deps) {
    D = deps;
    S = {
      page, drivers: [], tab: 'all', query: '', zone: '', activity: '', sortDesc: false,
      canManage: ['owner', 'manager'].includes(deps.context?.user?.role), invites: {}, draft: null, replacement: false, autoInvite: false,
    };
    page.classList.add('page-dr');
    page.innerHTML = '<div class="dr"><div class="dr-skel big"></div><div class="dr-skel"></div><div class="dr-skel"></div></div>';
    await reload();
    if (!popBound) {
      popBound = true;
      window.addEventListener('popstate', () => { if (S && location.pathname === '/app/livreurs') route(); });
      window.addEventListener('beforeunload', (event) => { const msg = S?.leaveGuard?.(); if (msg) { event.preventDefault(); event.returnValue = msg; } });
    }
    route();
  }

  window.TraxoDrivers = { render, _activityOf: activityOf, _accessOf: accessOf };
})();
