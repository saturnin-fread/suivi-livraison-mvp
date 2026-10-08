// Équipe et accès TRAXO (kit « Équipe », données réelles).
// Membres, invitations et matrice des droits. Toutes les règles (qui peut
// agir sur qui, rôle Lecture seule, suspension, retrait annulable) sont
// appliquées par le serveur ; l'écran ne fait que les refléter.
(function () {
  'use strict';

  // Icônes Lucide (licence ISC).
  const P = {
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    minus: '<path d="M5 12h14"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    crown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
    bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
    'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  };
  const ic = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[n] || ''}</svg>`;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  function lastSeen(m) {
    if (m.online) return 'En ligne';
    if (!m.lastSeenAt) return 'Jamais connecté';
    const min = Math.round((Date.now() - new Date(m.lastSeenAt).getTime()) / 60000);
    if (min < 60) return `Il y a ${Math.max(1, min)} min`;
    if (min < 24 * 60) return `Il y a ${Math.round(min / 60)} h`;
    if (min < 48 * 60) return 'Hier';
    return new Date(m.lastSeenAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  const ROLES = {
    owner: { name: 'Propriétaire', desc: 'Tous les droits, y compris la facturation et la propriété du compte.', tone: 'sand' },
    manager: { name: 'Administrateur', desc: 'Gère les livraisons, les clients, les exports, les réglages et les accès des opérateurs.', tone: 'purple' },
    operator: { name: 'Opérateur', desc: 'Crée les commandes, attribue les livreurs et suit les incidents.', tone: 'blue' },
    viewer: { name: 'Lecture seule', desc: 'Consulte l’activité sans rien modifier.', tone: 'gray' },
    driver: { name: 'Livreur', desc: 'Accède à ses livraisons dans l’application livreur.', tone: 'green' },
  };
  const MEMBER_STATE = { active: ['Actif', 'green'], suspended: ['Suspendu', 'gray'], disabled: ['Désactivé', 'gray'] };
  const INVITE_STATE = { pending: ['En attente', 'sand'], expired: ['Expirée', 'gray'], revoked: ['Annulée', 'gray'] };
  const HISTORY = {
    accepted: () => 'Invitation acceptée',
    role_changed: (d) => `Rôle modifié : ${ROLES[d.from]?.name || d.from} → ${ROLES[d.to]?.name || d.to}`,
    suspended: () => 'Accès suspendu',
    reactivated: () => 'Accès réactivé',
    removed: () => 'Accès retiré',
    restored: () => 'Retrait annulé',
  };
  const tag = (label, tone = 'gray') => `<span class="tm-tag ${tone}">${esc(label)}</span>`;
  const roleTag = (r) => tag(ROLES[r]?.name || r, ROLES[r]?.tone);

  async function render(page, deps) {
    const { api } = deps;
    const send = (url, body, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    page.classList.add('page-team');
    const st = {
      tab: 'members', query: '', role: 'all', state: 'all', page: 1, pageSize: 10, selected: new Set(),
      panel: '', memberId: null, confirm: null, flash: null, created: null, history: {}, busy: false,
      draft: { name: '', contact: '', role: 'operator', notify: true },
    };
    let data = { me: {}, members: [], invitations: [] };
    const root = document.createElement('div');
    root.className = 'tm';
    page.innerHTML = '';
    page.appendChild(root);
    const $ = (s) => root.querySelector(s);

    async function load() { data = await api('/api/app/team'); }
    const myRole = () => data.me.role;
    const member = () => data.members.find((m) => m.id === st.memberId);
    // Même règle que le serveur : ni soi-même, ni le propriétaire, ni un
    // livreur ; un administrateur ne gère pas un autre administrateur.
    const canManage = (m) => Boolean(m) && !m.me && !['owner', 'driver'].includes(m.role) && !(myRole() === 'manager' && m.role === 'manager');
    const canActInvite = (i) => !(myRole() === 'manager' && i.role === 'manager');
    const roleChoices = () => ['operator', ...(myRole() === 'owner' ? ['manager'] : []), 'viewer'];
    const contactOf = (m) => (m.role === 'driver' ? 'Application livreur' : m.email || m.phone || '—');
    const nameOf = (m) => m.displayName || m.driverName || m.email || 'Membre';

    function filtered() {
      const q = st.query.trim().toLowerCase();
      if (st.tab === 'invites') {
        return data.invitations.filter((i) => (st.role === 'all' || i.role === st.role) && (st.state === 'all' || i.state === st.state)
          && [i.displayName, i.email, i.phone].join(' ').toLowerCase().includes(q));
      }
      return data.members.filter((m) => (st.role === 'all' || m.role === st.role) && (st.state === 'all' || m.state === st.state)
        && [nameOf(m), m.email, m.phone].join(' ').toLowerCase().includes(q));
    }
    const flash = (text, tone = 'ok', undo = null) => { st.flash = { text, tone, undo }; };

    function draw() {
      const form = $('#tmInviteForm');
      if (form) {
        const f = new FormData(form);
        st.draft = { name: f.get('name') || '', contact: f.get('contact') || '', role: f.get('role') || 'operator', notify: f.get('notify') === 'on' };
      }
      const pending = data.invitations.filter((i) => i.state === 'pending').length;
      root.innerHTML = `
        <div class="tm-heading"><div><h1>Équipe et accès</h1><p>Ajoutez vos collègues et choisissez ce qu’ils peuvent faire.</p></div>
          <button type="button" class="tm-btn primary" data-act="invite">${ic('plus')}Inviter une personne</button></div>
        <div class="tm-tabs" role="tablist" aria-label="Vues de l’équipe">
          <button type="button" role="tab" data-tab="members" aria-selected="${st.tab === 'members'}">Membres <b>${data.members.length}</b></button>
          <button type="button" role="tab" data-tab="invites" aria-selected="${st.tab === 'invites'}">Invitations <b>${pending}</b></button>
          <button type="button" role="tab" data-tab="roles" aria-selected="${st.tab === 'roles'}">Rôles et droits</button>
        </div>
        <div id="tmFlash">${flashHtml()}</div>
        <div class="tm-grid ${st.panel ? 'open' : ''}">
          <div class="tm-main">${st.tab === 'roles' ? permissions() : `
            <div class="tm-toolbar">
              <label class="tm-search">${ic('search')}<input id="tmQuery" type="search" aria-label="Rechercher une personne" placeholder="Rechercher une personne…" value="${esc(st.query)}" autocomplete="off"></label>
              <div class="tm-filters">
                <select id="tmRole" aria-label="Filtrer par rôle"><option value="all">Tous les rôles</option>${Object.entries(ROLES).filter(([k]) => st.tab === 'members' || k !== 'owner').map(([k, r]) => `<option value="${k}" ${st.role === k ? 'selected' : ''}>${r.name}</option>`).join('')}</select>
                <select id="tmState" aria-label="Filtrer par statut"><option value="all">Tous les statuts</option>${Object.entries(st.tab === 'invites' ? INVITE_STATE : MEMBER_STATE).map(([k, [l]]) => `<option value="${k}" ${st.state === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
              </div>
            </div>
            <section class="tm-table-wrap"><div id="tmSelection"></div><div id="tmRows"></div></section>
            ${driverNote('Un livreur à ajouter ?', 'Son accès se crée depuis la page Livreurs, avec un QR code.')}`}
          </div>
          ${st.panel ? `<aside class="tm-panel" aria-label="${st.panel === 'member' ? 'Fiche membre' : 'Invitation'}">${panelHtml()}</aside>` : ''}
        </div>`;
      if (st.tab !== 'roles') rows();
    }
    function flashHtml() {
      if (!st.flash) return '';
      return `<div class="tm-flash ${st.flash.tone}" role="status"><span>${esc(st.flash.text)}</span>${st.flash.undo ? '<button type="button" class="tm-undo" data-act="undo">Annuler</button>' : ''}<button type="button" class="tm-icon" data-act="flash-close" aria-label="Fermer le message">${ic('x')}</button></div>`;
    }
    const driverNote = (title, text) => `<div class="tm-driver-note"><span class="tm-driver-symbol">${ic('bike')}</span><div><strong>${title}</strong><p>${text}</p></div><a href="/app/livreurs">Ouvrir Livreurs ${ic('arrow-up-right')}</a></div>`;

    function pagination(n) {
      const max = Math.max(1, Math.ceil(n / st.pageSize));
      return `<div class="tm-pagination"><span>${n ? (st.page - 1) * st.pageSize + 1 : 0}–${Math.min(st.page * st.pageSize, n)} sur ${n}</span>
        <label><select id="tmPageSize" aria-label="Lignes par page">${[5, 10, 20].map((s) => `<option value="${s}" ${s === st.pageSize ? 'selected' : ''}>${s}</option>`).join('')}</select>par page</label>
        <nav aria-label="Pagination"><button type="button" data-page="${st.page - 1}" aria-label="Page précédente" ${st.page === 1 ? 'disabled' : ''}>${ic('chevron-left')}</button><span>Page ${st.page} / ${max}</span><button type="button" data-page="${st.page + 1}" aria-label="Page suivante" ${st.page === max ? 'disabled' : ''}>${ic('chevron-right')}</button></nav></div>`;
    }

    function memberAvatar(m) {
      return `<span class="tm-avatar ${ROLES[m.role]?.tone || 'gray'}">${m.role === 'owner' ? ic('crown') : esc(initials(nameOf(m)))}</span>`;
    }

    function rows() {
      const ds = filtered();
      st.page = Math.min(st.page, Math.max(1, Math.ceil(ds.length / st.pageSize)));
      const shown = ds.slice((st.page - 1) * st.pageSize, st.page * st.pageSize);
      const isFiltered = st.query || st.role !== 'all' || st.state !== 'all';
      let table;
      if (st.tab === 'members') {
        table = `<table class="tm-table"><thead><tr><th class="tm-check"><input id="tmPickPage" type="checkbox" aria-label="Sélectionner les membres modifiables de cette page"></th><th>Personne</th><th>Rôle</th><th>Accès</th><th class="tm-last">Dernière activité</th><th></th></tr></thead><tbody>
          ${shown.map((m) => `<tr class="${m.id === st.memberId && st.panel === 'member' ? 'current' : ''}">
            <td class="tm-check"><input data-pick="${esc(m.id)}" type="checkbox" aria-label="Sélectionner ${esc(nameOf(m))}" ${st.selected.has(m.id) ? 'checked' : ''} ${canManage(m) ? '' : 'disabled'}></td>
            <td><button type="button" class="tm-name" data-member="${esc(m.id)}">${memberAvatar(m)}<span><strong>${esc(nameOf(m))}${m.me ? '<em>Vous</em>' : ''}</strong><small>${esc(contactOf(m))}</small></span></button></td>
            <td data-label="Rôle">${roleTag(m.role)}</td>
            <td data-label="Accès">${tag(...(MEMBER_STATE[m.state] || MEMBER_STATE.active))}</td>
            <td class="tm-last" data-label="Dernière activité">${m.online ? '<span class="tm-online"></span>' : ''}${esc(lastSeen(m))}</td>
            <td class="tm-row-action"><button type="button" class="tm-icon" data-member="${esc(m.id)}" aria-label="Ouvrir la fiche de ${esc(nameOf(m))}">${ic('arrow-up-right')}</button></td></tr>`).join('')}</tbody></table>`;
      } else {
        table = `<table class="tm-table tm-invites"><thead><tr><th>Personne</th><th>Rôle prévu</th><th>Statut</th><th>Validité</th><th></th></tr></thead><tbody>
          ${shown.map((i) => {
            const [label, tone] = INVITE_STATE[i.state] || INVITE_STATE.pending;
            const hours = Math.max(1, Math.ceil((new Date(i.expiresAt).getTime() - Date.now()) / 3600000));
            const acts = canActInvite(i) ? `${i.state === 'pending' ? `<button type="button" data-copy="${esc(i.id)}">${ic('copy')}Copier</button>` : ''}
              <button type="button" data-renew="${esc(i.id)}">${ic('rotate-ccw')}Renouveler</button>
              ${i.state !== 'revoked' ? `<button type="button" data-revoke="${esc(i.id)}" aria-label="Annuler l’invitation de ${esc(i.displayName)}">${ic('x')}</button>` : ''}` : '<span class="tm-dim">Réservée au propriétaire</span>';
            return `<tr><td><div class="tm-name">${'<span class="tm-avatar sand">' + ic(i.email ? 'mail' : 'send') + '</span>'}<span><strong>${esc(i.displayName)}</strong><small>${esc(i.email || i.phone || '')}${i.invitedBy ? ` · par ${esc(i.invitedBy)}` : ''}</small></span></div></td>
              <td data-label="Rôle">${roleTag(i.role)}</td><td data-label="Statut">${tag(label, tone)}</td>
              <td data-label="Validité">${i.state === 'pending' ? `${hours} h restantes` : i.state === 'expired' ? `Expirée le ${esc(day(i.expiresAt))}` : '—'}</td>
              <td class="tm-invite-actions">${acts}</td></tr>`;
          }).join('')}</tbody></table>`;
      }
      const empty = `<div class="tm-empty">${ic('users')}<h2>${isFiltered ? 'Aucun résultat.' : st.tab === 'invites' ? 'Aucune invitation pour le moment.' : 'Personne pour le moment.'}</h2><p>${isFiltered ? 'Essayez un autre nom ou modifiez les filtres.' : 'Invitez une personne pour travailler ensemble sur TRAXO.'}</p></div>`;
      $('#tmRows').innerHTML = (shown.length ? table : empty) + pagination(ds.length);
      const eligible = st.tab === 'members' ? ds.filter(canManage) : [];
      $('#tmSelection').innerHTML = st.selected.size ? `<div class="tm-selectionbar"><strong>${plural(st.selected.size, 'personne sélectionnée', 'personnes sélectionnées')}</strong>
        ${eligible.length > st.selected.size ? `<button type="button" class="tm-linkish" data-act="select-all">Sélectionner les ${eligible.length} résultats</button>` : ''}
        <div><button type="button" data-act="bulk-suspend">${ic('pause')}Suspendre</button><button type="button" data-act="bulk-reactivate">${ic('rotate-ccw')}Réactiver</button><button type="button" class="danger" data-act="bulk-remove">Retirer l’accès</button><button type="button" class="tm-icon" data-act="clear-selection" aria-label="Désélectionner">${ic('x')}</button></div></div>` : '';
      root.querySelectorAll('.tm-confirm').forEach((el) => el.remove());
      if (st.confirm) {
        const host = st.panel === 'member' && !st.confirm.bulk ? $('.tm-member-actions') : st.confirm.inviteId ? $('#tmSelection') : $('#tmSelection');
        host?.insertAdjacentHTML('beforeend', confirmHtml());
      }
      const pick = $('#tmPickPage');
      if (pick) {
        const pageEligible = shown.filter(canManage);
        pick.disabled = !pageEligible.length;
        pick.checked = pageEligible.length > 0 && pageEligible.every((m) => st.selected.has(m.id));
        pick.indeterminate = pageEligible.some((m) => st.selected.has(m.id)) && !pick.checked;
      }
    }

    function confirmHtml() {
      const c = st.confirm;
      const n = c.ids ? c.ids.length : 1;
      const text = {
        revoke: ['Annuler cette invitation ?', 'Le lien ne permettra plus de rejoindre votre équipe.'],
        renew: ['Remplacer ce lien d’invitation ?', 'L’ancien lien ne fonctionnera plus. Le nouveau sera valable 48 h.'],
        remove: [`Retirer l’accès de ${plural(n, 'personne', 'personnes')} ?`, 'Ces personnes ne pourront plus ouvrir votre espace. Leurs commandes et l’historique sont conservés. Annulable pendant une heure.'],
        suspend: [`Suspendre ${plural(n, 'accès', 'accès')} ?`, 'Ces personnes sont déconnectées tout de suite. Vous pourrez réactiver leur accès.'],
      }[c.type];
      return `<div class="tm-confirm" role="alert"><div><strong>${text[0]}</strong><p>${text[1]}</p></div><div><button type="button" class="tm-btn danger" data-act="confirm" ${st.busy ? 'disabled' : ''}>Confirmer</button><button type="button" class="tm-btn" data-act="cancel-confirm">Annuler</button></div></div>`;
    }

    function permissions() {
      // Reflète les règles réellement appliquées par le serveur.
      const yes = 1; const no = 0;
      const features = [
        ['Consulter les commandes, les clients et les rapports', [yes, yes, yes, yes]],
        ['Créer et modifier les commandes, demandes et clients', [yes, yes, yes, no]],
        ['Attribuer les livreurs et traiter les incidents', [yes, yes, yes, no]],
        ['Exporter les données', [yes, yes, 'Opérations, 31 jours', no]],
        ['Supprimer une fiche client', [yes, yes, no, no]],
        ['Inviter et gérer les membres', [yes, 'Sauf les administrateurs', no, no]],
        ['Modifier les paramètres de l’entreprise', [yes, yes, no, no]],
        ['Gérer la facturation et la propriété', [yes, no, no, no]],
      ];
      const mark = (v) => (typeof v === 'string'
        ? `<span class="tm-mark partial">${esc(v)}</span>`
        : `<span class="tm-mark ${v ? 'yes' : ''}">${ic(v ? 'check' : 'minus')}<span class="tm-sr">${v ? 'Autorisé' : 'Non autorisé'}</span></span>`);
      return `<section class="tm-permissions"><div class="tm-section-title"><h2>Qui peut faire quoi ?</h2><p>Choisissez le rôle le plus adapté au travail de chaque personne.</p></div>
        <div class="tm-permission-scroll"><table><thead><tr><th>Dans votre espace</th>${['owner', 'manager', 'operator', 'viewer'].map((r) => `<th>${roleTag(r)}</th>`).join('')}</tr></thead>
        <tbody>${features.map(([name, v]) => `<tr><td>${name}</td>${v.map((x) => `<td>${mark(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <div class="tm-roles-foot">${ic('shield-check')}Le rôle Propriétaire ne s’attribue pas par invitation. Chacun garde l’accès à son propre compte, même en lecture seule.</div></section>
        ${driverNote('Le livreur a son propre accès', 'Il voit ses livraisons dans son application. Il n’accède pas à cet espace de gestion.')}`;
    }

    function contactKind(v) {
      const t = String(v || '').trim();
      if (!t) return null;
      if (t.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? 'email' : 'bad';
      return /^\+?[\d\s().-]{8,25}$/.test(t) ? 'phone' : 'bad';
    }
    function notifyLabel(kind) {
      return kind === 'phone' ? 'Envoyer le lien par WhatsApp' : 'Envoyer le lien par e-mail';
    }

    function panelHtml() {
      if (st.panel === 'invite') {
        const d = st.draft;
        const kind = contactKind(d.contact);
        return `<div class="tm-panel-title"><div><span class="tm-eyebrow">Inviter un collègue</span><h2>Qui rejoint votre équipe ?</h2></div><button type="button" class="tm-icon" data-act="close-panel" aria-label="Fermer">${ic('x')}</button></div>
          <p class="tm-panel-copy">Choisissez ses droits, puis partagez-lui son lien d’invitation.</p>
          <form id="tmInviteForm" novalidate>
            <label class="tm-field">Nom<input name="name" required maxlength="100" autocomplete="off" placeholder="Nom et prénom" value="${esc(d.name)}"></label>
            <label class="tm-field">Téléphone ou e-mail<input name="contact" maxlength="120" autocomplete="off" inputmode="email" placeholder="01 97 12 34 56 ou nom@exemple.com" value="${esc(d.contact)}"><small>Il protège le lien : la personne le confirmera en rejoignant l’équipe.</small></label>
            <label class="tm-field">Rôle<select name="role" id="tmInviteRole">${roleChoices().map((k) => `<option value="${k}" ${d.role === k ? 'selected' : ''}>${ROLES[k].name}</option>`).join('')}</select></label>
            <div class="tm-role-desc" id="tmRoleDesc">${ic('shield-check')}<p>${esc(ROLES[d.role]?.desc || '')}</p></div>
            <button type="button" class="tm-text-btn" data-act="compare-roles">Comparer les rôles ${ic('arrow-right')}</button>
            <label class="tm-notify"><input type="checkbox" name="notify" ${d.notify ? 'checked' : ''}><span id="tmNotifyLabel">${notifyLabel(kind)}</span></label>
            <div class="tm-invite-info">${ic('clock')}<span>Le lien est valable 48 h et ne sert qu’une fois. Vous pourrez l’annuler à tout moment.</span></div>
            <p id="tmInviteError" class="tm-error" role="alert"></p>
            <button class="tm-btn primary full" type="submit" ${st.busy ? 'disabled' : ''}>${ic('link')}Créer l’invitation</button>
          </form>`;
      }
      if (st.panel === 'created') {
        const c = st.created;
        const sentText = c.sentBy === 'email' ? `Un e-mail est parti vers ${esc(c.contact)}.` : c.sentBy === 'whatsapp' ? `Le lien part sur le WhatsApp du ${esc(c.contact)}.` : 'Aucun message n’a été envoyé : partagez ce lien vous-même.';
        return `<div class="tm-panel-title"><div><span class="tm-success">${ic('check')}</span><h2>${c.renewed ? 'Le nouveau lien est prêt' : 'L’invitation est prête'}</h2></div><button type="button" class="tm-icon" data-act="close-panel" aria-label="Fermer">${ic('x')}</button></div>
          <p class="tm-panel-copy">${sentText}</p>
          <div class="tm-invite-summary"><span>${esc(c.name)}</span>${roleTag(c.role)}</div>
          <label class="tm-field">Lien d’invitation<input class="tm-copy-value" readonly value="${esc(c.url)}" aria-label="Lien d’invitation"></label>
          <button type="button" class="tm-btn primary full" data-act="copy-created">${ic('copy')}Copier le lien</button>
          <p class="tm-note">Valable jusqu’au ${esc(dateTime(c.expiresAt))}</p>
          <button type="button" class="tm-btn full" data-act="show-invites">Voir les invitations</button>`;
      }
      const m = member();
      if (!m) return '';
      const hist = st.history[m.id];
      return `<div class="tm-panel-title"><span class="tm-eyebrow">Fiche membre</span><button type="button" class="tm-icon" data-act="close-panel" aria-label="Fermer la fiche">${ic('x')}</button></div>
        <div class="tm-profile">${memberAvatar(m)}<h2>${esc(nameOf(m))}</h2><p>${esc(contactOf(m))}${m.role !== 'driver' && m.email && m.phone ? ` · ${esc(m.phone)}` : ''}</p>${tag(m.state === 'active' ? 'Accès actif' : 'Accès suspendu', m.state === 'active' ? 'green' : 'gray')}</div>
        <div class="tm-profile-info"><span>Dans l’équipe depuis</span><strong>${esc(day(m.joinedAt))}</strong></div>
        <div class="tm-profile-info"><span>Dernière activité</span><strong>${esc(lastSeen(m))}</strong></div>
        ${canManage(m) ? `<form id="tmRoleForm"><label class="tm-field">Rôle<select name="role" id="tmEditRole">${roleChoices().map((k) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${ROLES[k].name}</option>`).join('')}</select></label>
          <div class="tm-role-desc" id="tmRoleDesc">${ic('shield-check')}<p>${esc(ROLES[m.role]?.desc || '')}</p></div>
          <button class="tm-btn full" type="submit" ${st.busy ? 'disabled' : ''}>Enregistrer le rôle</button></form>
          <div class="tm-member-actions"><button type="button" class="tm-btn full" data-act="${m.state === 'active' ? 'suspend-member' : 'reactivate-member'}">${ic(m.state === 'active' ? 'pause' : 'rotate-ccw')}${m.state === 'active' ? 'Suspendre l’accès' : 'Réactiver l’accès'}</button><button type="button" class="tm-text-btn danger" data-act="remove-member">Retirer de l’équipe</button></div>`
        : `<div class="tm-protected">${ic(m.role === 'driver' ? 'bike' : 'shield-check')}<p>${m.me ? 'C’est votre accès : vous ne pouvez pas modifier votre propre rôle ici.' : m.role === 'owner' ? 'Ce compte possède l’espace. Son accès ne peut pas être retiré ici.' : m.role === 'driver' ? 'Ce membre utilise uniquement l’application livreur. Son accès se gère depuis la page Livreurs.' : 'Seul le propriétaire peut modifier un administrateur.'}</p></div>
          ${m.role === 'driver' ? '<a class="tm-btn full" href="/app/livreurs">Ouvrir Livreurs</a>' : ''}`}
        <section class="tm-history"><h3>Derniers changements</h3>${hist == null ? '<p class="tm-dim">Chargement…</p>' : hist.length ? hist.slice(0, 6).map((h) => `<p>${esc((HISTORY[h.action] || (() => h.action))(h.details || {}))}<small>${esc(h.actor)} · ${esc(dateTime(h.at))}</small></p>`).join('') : '<p class="tm-dim">Aucun changement enregistré.</p>'}</section>`;
    }

    async function openMember(id) {
      st.memberId = id; st.panel = 'member'; st.confirm = null;
      draw();
      $('.tm-panel [data-act="close-panel"]')?.focus({ preventScroll: true });
      if (window.innerWidth <= 850) $('.tm-panel')?.scrollIntoView({ block: 'start' });
      if (st.history[id] == null) {
        try { st.history[id] = await api(`/api/app/team/members/${encodeURIComponent(id)}/history`); } catch { st.history[id] = []; }
        if (st.panel === 'member' && st.memberId === id) draw();
      }
    }
    function changeTab(tab) {
      Object.assign(st, { tab, query: '', role: 'all', state: 'all', page: 1, confirm: null, panel: st.panel === 'invite' ? 'invite' : '', memberId: null });
      st.selected.clear();
      draw();
    }
    async function refresh() { await load(); st.history = {}; }

    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    }
    async function runMembers(ids, action) {
      const done = []; const failed = [];
      for (const id of ids) {
        const m = data.members.find((x) => x.id === id);
        if (!canManage(m)) continue;
        try {
          const r = await send(`/api/app/team/members/${encodeURIComponent(id)}/${action}`);
          done.push({ id, userId: m.userId, name: nameOf(m), result: r });
        } catch (error) { failed.push(`${nameOf(m)} : ${error.message}`); }
      }
      return { done, failed };
    }

    async function onConfirm() {
      const c = st.confirm;
      st.busy = true; rows();
      try {
        if (c.type === 'revoke') {
          await send(`/api/app/invitations/${encodeURIComponent(c.inviteId)}/revoke`);
          await refresh(); flash('Invitation annulée. Le lien ne fonctionne plus.');
        } else if (c.type === 'renew') {
          const r = await send(`/api/app/invitations/${encodeURIComponent(c.inviteId)}/renew`);
          const inv = data.invitations.find((i) => i.id === c.inviteId) || {};
          await refresh();
          st.created = { name: inv.displayName, role: inv.role, url: r.url, expiresAt: r.expiresAt, renewed: true, sentBy: null };
          st.panel = 'created';
          flash('Nouveau lien prêt. L’ancien est désactivé.');
        } else {
          const { done, failed } = await runMembers(c.ids, c.type === 'remove' ? 'remove' : 'suspend');
          await refresh();
          st.selected.clear();
          if (st.panel === 'member') { st.panel = ''; st.memberId = null; }
          const verb = c.type === 'remove' ? 'Accès retiré' : 'Accès suspendu';
          if (done.length) flash(`${verb} : ${done.map((d) => d.name).join(', ')}.${failed.length ? ` Non traité : ${failed.join(' ; ')}` : ''}`, failed.length ? 'warn' : 'ok', c.type === 'remove' ? done.map((d) => d.userId) : null);
          else flash(failed.join(' ; ') || 'Aucune personne modifiable dans la sélection.', 'error');
        }
      } catch (error) {
        flash(error.message, 'error');
      }
      st.busy = false; st.confirm = null;
      draw();
    }

    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const a = b.dataset.act;
      if (b.dataset.tab) return changeTab(b.dataset.tab);
      if (b.dataset.member) return openMember(b.dataset.member);
      if (b.dataset.page) { st.page = Number(b.dataset.page); return rows(); }
      if (b.dataset.copy) {
        const inv = data.invitations.find((i) => i.id === b.dataset.copy);
        try {
          const r = await send(`/api/app/invitations/${encodeURIComponent(b.dataset.copy)}/reveal`);
          if (await copyText(r.url)) { flash(`Lien de ${inv?.displayName || 'l’invitation'} copié.`); draw(); return; }
          st.created = { name: inv?.displayName, role: inv?.role, url: r.url, expiresAt: r.expiresAt, sentBy: null };
          st.panel = 'created'; draw();
          $('.tm-copy-value')?.select();
          flash('Le lien est sélectionné : copiez-le avec votre appareil.');
          $('#tmFlash').innerHTML = flashHtml();
        } catch (error) { flash(error.message, 'error'); draw(); }
        return;
      }
      if (b.dataset.renew || b.dataset.revoke) {
        st.confirm = { type: b.dataset.renew ? 'renew' : 'revoke', inviteId: b.dataset.renew || b.dataset.revoke };
        return rows();
      }
      if (a === 'invite') { st.panel = 'invite'; st.confirm = null; draw(); $('#tmInviteForm input')?.focus(); return; }
      if (a === 'close-panel') {
        const old = st.memberId; st.panel = ''; st.memberId = null; draw();
        (old ? root.querySelector(`[data-member="${CSS.escape(old)}"]`) : $('[data-act="invite"]'))?.focus({ preventScroll: true });
        return;
      }
      if (a === 'compare-roles') { st.tab = 'roles'; draw(); return; }
      if (a === 'show-invites') { st.panel = ''; changeTab('invites'); return; }
      if (a === 'copy-created') {
        if (await copyText(st.created.url)) flash('Lien copié.');
        else { $('.tm-copy-value')?.select(); flash('Le lien est sélectionné : copiez-le avec votre appareil.'); }
        $('#tmFlash').innerHTML = flashHtml();
        return;
      }
      if (a === 'flash-close') { st.flash = null; $('#tmFlash').innerHTML = ''; return; }
      if (a === 'clear-selection') { st.selected.clear(); st.confirm = null; return rows(); }
      if (a === 'select-all') { filtered().filter(canManage).forEach((m) => st.selected.add(m.id)); return rows(); }
      if (['bulk-suspend', 'bulk-remove', 'suspend-member', 'remove-member'].includes(a)) {
        const bulk = a.startsWith('bulk');
        const ids = (bulk ? [...st.selected] : [st.memberId]).filter((id) => canManage(data.members.find((m) => m.id === id)));
        if (!ids.length) { flash('Aucune personne modifiable dans la sélection.', 'warn'); draw(); return; }
        st.confirm = { type: a.includes('remove') ? 'remove' : 'suspend', ids, bulk };
        return rows();
      }
      if (a === 'bulk-reactivate' || a === 'reactivate-member') {
        const ids = a === 'bulk-reactivate' ? [...st.selected] : [st.memberId];
        const targets = ids.filter((id) => data.members.find((m) => m.id === id)?.state === 'suspended');
        if (!targets.length) { flash('Ces accès sont déjà actifs.', 'warn'); draw(); return; }
        const { done, failed } = await runMembers(targets, 'reactivate');
        await refresh(); st.selected.clear();
        flash(done.length ? `Accès réactivé : ${done.map((d) => d.name).join(', ')}.` : failed.join(' ; '), done.length ? 'ok' : 'error');
        draw();
        return;
      }
      if (a === 'cancel-confirm') { st.confirm = null; return rows(); }
      if (a === 'confirm' && st.confirm) return onConfirm();
      if (a === 'undo' && st.flash?.undo) {
        const userIds = st.flash.undo;
        st.flash = null;
        const failed = [];
        for (const userId of userIds) {
          try { await send('/api/app/team/members/restore', { userId }); } catch (error) { failed.push(error.message); }
        }
        await refresh();
        flash(failed.length ? failed[0] : 'Les accès ont été rétablis, avec leur rôle.', failed.length ? 'error' : 'ok');
        draw();
      }
    });
    root.addEventListener('input', (e) => {
      if (e.target.id === 'tmQuery') {
        st.query = e.target.value; st.page = 1; st.selected.clear(); st.confirm = null; rows();
      }
      if (e.target.form?.id === 'tmInviteForm') { const err = $('#tmInviteError'); if (err) err.textContent = ''; }
      if (e.target.name === 'contact' && e.target.form?.id === 'tmInviteForm') {
        $('#tmNotifyLabel').textContent = notifyLabel(contactKind(e.target.value));
      }
    });
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.pick) { if (t.checked) st.selected.add(t.dataset.pick); else st.selected.delete(t.dataset.pick); return rows(); }
      if (t.id === 'tmPickPage') {
        filtered().slice((st.page - 1) * st.pageSize, st.page * st.pageSize).filter(canManage)
          .forEach((m) => (t.checked ? st.selected.add(m.id) : st.selected.delete(m.id)));
        return rows();
      }
      if (t.id === 'tmPageSize') { st.pageSize = Number(t.value); st.page = 1; return rows(); }
      if (t.id === 'tmRole' || t.id === 'tmState') {
        if (t.id === 'tmRole') st.role = t.value; else st.state = t.value;
        st.page = 1; st.selected.clear(); st.confirm = null; return rows();
      }
      if (t.id === 'tmInviteRole' || t.id === 'tmEditRole') {
        $('#tmRoleDesc').innerHTML = `${ic('shield-check')}<p>${esc(ROLES[t.value]?.desc || '')}</p>`;
      }
    });
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (e.target.id === 'tmInviteForm') {
        const err = $('#tmInviteError');
        const name = String(f.get('name') || '').trim();
        const contact = String(f.get('contact') || '').trim();
        const kind = contactKind(contact);
        if (name.length < 2) { err.textContent = 'Indiquez le nom de la personne.'; return; }
        if (!kind) { err.textContent = 'Ajoutez son téléphone ou son adresse e-mail : il protège le lien.'; return; }
        if (kind === 'bad') { err.textContent = 'Vérifiez le téléphone ou l’adresse e-mail.'; return; }
        const body = { displayName: name, role: f.get('role'), notify: f.get('notify') === 'on' ? (kind === 'phone' ? 'whatsapp' : 'email') : '' };
        if (kind === 'email') body.email = contact; else { body.phone = contact; body.phoneCountry = 'BJ'; }
        st.busy = true;
        e.target.querySelector('[type="submit"]').disabled = true;
        try {
          const r = await send('/api/app/invitations', body);
          await refresh();
          st.created = { name, role: body.role, url: r.url, expiresAt: r.expiresAt, contact, sentBy: r.emailed ? 'email' : r.whatsapped ? 'whatsapp' : null };
          st.draft = { name: '', contact: '', role: 'operator', notify: true };
          st.panel = 'created'; st.busy = false;
          if (body.notify && !r.emailed && !r.whatsapped) flash(kind === 'phone' ? 'WhatsApp n’a pas pu envoyer le lien : copiez-le et partagez-le vous-même.' : 'L’e-mail n’a pas pu partir : copiez le lien et partagez-le vous-même.', 'warn');
          draw();
          $('.tm-panel [data-act="copy-created"]')?.focus();
        } catch (error) {
          st.busy = false;
          err.textContent = error.message;
          e.target.querySelector('[type="submit"]').disabled = false;
        }
        return;
      }
      if (e.target.id === 'tmRoleForm') {
        const m = member();
        const role = f.get('role');
        if (!canManage(m) || role === m.role) { flash('Le rôle est déjà celui-ci.', 'warn'); draw(); return; }
        st.busy = true;
        try {
          await send(`/api/app/team/members/${encodeURIComponent(m.id)}`, { role }, 'PATCH');
          await refresh();
          flash(`${nameOf(m)} est maintenant ${ROLES[role].name}.`);
        } catch (error) { flash(error.message, 'error'); }
        st.busy = false;
        await openMember(m.id);
      }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (st.panel || st.confirm)) { st.panel = ''; st.confirm = null; st.memberId = null; draw(); }
    });

    root.innerHTML = '<p class="tm-loading">Chargement de l’équipe…</p>';
    await load();
    if (new URLSearchParams(location.search).get('inviter') === '1') st.panel = 'invite';
    draw();
    if (st.panel === 'invite') $('#tmInviteForm input')?.focus();
  }

  window.TraxoTeam = { render };
}());
