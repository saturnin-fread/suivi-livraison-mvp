// Support TRAXO — panneau « demandes » (kit Navigation, recherche et support).
// Une demande = un sujet, une référence, un statut, sa propre discussion.
// Non modal : on peut consulter une livraison pendant l'échange. Réduire garde
// la vue et le brouillon ; fermer ne résout ni ne supprime rien. Les brouillons
// (texte + pièce jointe déjà téléversée) sont rangés par demande, par entreprise
// et par utilisateur, et survivent au changement de page.
(function () {
  'use strict';
  const svg = (inner, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const IC = {
    headset: svg('<path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/><path d="M21 16v2a4 4 0 0 1-4 4h-5"/>'),
    minus: svg('<path d="M5 12h14"/>', 2), x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 2),
    plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>', 2), back: svg('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>', 2),
    history: svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
    clip: svg('<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>'),
    mic: svg('<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>'),
    send: svg('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>', 2), mail: svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
    file: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
    clock: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'), check: svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
    inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    reply: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'), trash: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    retry: svg('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  };
  const STATUS_ICON = { received: 'inbox', in_progress: 'clock', waiting_customer: 'reply', resolved: 'check' };
  const CATEGORIES = [['deliveries', 'Livraisons'], ['drivers', 'Livreurs et application'], ['billing', 'Facturation'], ['account', 'Compte et accès'], ['other', 'Autre chose']];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
  const tz = 'Africa/Porto-Novo';
  const dayKey = (d) => new Intl.DateTimeFormat('fr-CA', { timeZone: tz }).format(new Date(d));
  const hm = (d) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(d));
  function when(d) {
    const t = new Date(d); const diff = (Date.now() - t.getTime()) / 60000;
    if (diff < 1) return 'À l’instant';
    if (diff < 60) return `Il y a ${Math.round(diff)} min`;
    const today = dayKey(Date.now()); const y = dayKey(Date.now() - 864e5);
    if (dayKey(t) === today) return `Aujourd’hui, ${hm(t)}`;
    if (dayKey(t) === y) return 'Hier';
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: tz }).format(t);
  }
  function dayLabel(d) {
    const k = dayKey(d);
    if (k === dayKey(Date.now())) return 'Aujourd’hui';
    if (k === dayKey(Date.now() - 864e5)) return 'Hier';
    return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(new Date(d));
  }
  const store = {
    get(k, area = 'local') { try { const raw = (area === 'session' ? sessionStorage : localStorage).getItem(k); return raw ? JSON.parse(raw) : null; } catch { return null; } },
    set(k, v, area = 'local') { try { (area === 'session' ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
    del(k, area = 'local') { try { (area === 'session' ? sessionStorage : localStorage).removeItem(k); } catch { /* ignore */ } },
  };

  let D = null; // dépendances : api, context, toast
  let ui = null; // éléments DOM
  const S = { open: false, minimized: false, view: 'home', ticketId: null, tab: 'open', history: false, list: null, listLoading: false, thread: null, threadError: null,
    notice: '', busy: false, sendError: '', summary: { unread: 0, unreadTicketIds: [], supportEmail: null }, rec: null, micReq: 0, opener: null };
  let drafts = {};
  let pollTimer = null; let summaryTimer = null;
  const keys = () => { const c = D.context; return { state: `traxo.support.state.${c.company.id}.${c.user.id}`, drafts: `traxo.support.drafts.${c.company.id}.${c.user.id}` }; };
  const saveState = () => store.set(keys().state, { open: S.open, minimized: S.minimized, view: S.view, ticketId: S.ticketId, tab: S.tab, history: S.history }, 'session');
  const saveDrafts = () => store.set(keys().drafts, drafts);
  const draftOf = (id) => { const k = id || 'new'; if (!drafts[k]) drafts[k] = { text: '', upload: null, key: null, ...(k === 'new' ? { subject: '', category: defaultCategory() } : {}) }; return drafts[k]; };
  function defaultCategory() {
    const p = location.pathname; const q = location.search;
    if (/section=billing/.test(q)) return 'billing';
    if (p.startsWith('/app/livreurs')) return 'drivers';
    if (p.startsWith('/app/equipe') || /section=security/.test(q)) return 'account';
    return 'deliveries';
  }

  // ---- Structure -----------------------------------------------------------
  function mount() {
    if (ui) return;
    const panel = document.createElement('aside');
    panel.className = 'sp'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false'); panel.setAttribute('aria-labelledby', 'spTitle');
    panel.innerHTML = `<header class="sp-top"><span class="sp-emblem">${IC.headset}</span><div><h2 id="spTitle">L’équipe TRAXO</h2><p>Vos demandes, au même endroit.</p></div>
        <div class="sp-actions"><button type="button" class="sp-icon" data-act="minimize" aria-label="Réduire le support">${IC.minus}</button><button type="button" class="sp-icon" data-act="close" aria-label="Fermer le support">${IC.x}</button></div></header>
      <div class="sp-body" id="spBody"></div>
      <footer class="sp-foot" id="spFoot"></footer>
      <p class="sp-live" aria-live="polite" id="spLive"></p>`;
    const pill = document.createElement('button');
    pill.type = 'button'; pill.className = 'sp-pill'; pill.hidden = true;
    pill.innerHTML = `${IC.headset}<span>Reprendre le support</span><i class="sp-pill-dot" hidden></i>`;
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.hidden = true; fileInput.accept = 'image/jpeg,image/png,image/webp,application/pdf,audio/*';
    document.body.append(panel, pill, fileInput);
    ui = { panel, pill, fileInput, body: panel.querySelector('#spBody'), foot: panel.querySelector('#spFoot'), live: panel.querySelector('#spLive') };
    panel.addEventListener('click', onClick);
    panel.addEventListener('submit', (e) => { e.preventDefault(); if (e.target.dataset.form === 'new') submitNew(); else sendMessage(); });
    panel.addEventListener('input', onInput);
    panel.addEventListener('change', onInput);
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('textarea')) { e.preventDefault(); S.view === 'new' ? submitNew() : sendMessage(); }
    });
    pill.addEventListener('click', () => open());
    fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; if (f) attach(f); });
  }

  // ---- Ouverture / fermeture ------------------------------------------------
  function open(ticketId) {
    mount();
    S.opener = document.activeElement && !ui.panel.contains(document.activeElement) ? document.activeElement : S.opener;
    S.open = true; S.minimized = false;
    if (ticketId) { stopRecording(true); S.view = 'thread'; S.ticketId = String(ticketId); S.thread = null; }
    document.dispatchEvent(new CustomEvent('traxo:close-popovers', { detail: 'support' }));
    document.getElementById('sidebar')?.classList.remove('open'); // tiroir mobile
    ui.panel.hidden = false; ui.pill.hidden = true;
    saveState(); render();
    if (S.view === 'thread') loadThread(); else loadList();
    requestAnimationFrame(() => (ui.panel.querySelector('[data-autofocus]') || ui.panel.querySelector('.sp-top .sp-icon')).focus({ preventScroll: true }));
  }
  function minimize() {
    stopRecording(true);
    S.open = false; S.minimized = true; ui.panel.hidden = true; ui.pill.hidden = false;
    stopPolling(); saveState(); ui.pill.focus();
  }
  function close() {
    stopRecording(true);
    S.open = false; S.minimized = false; if (ui) { ui.panel.hidden = true; ui.pill.hidden = true; }
    stopPolling(); saveState();
    if (S.opener && document.body.contains(S.opener)) S.opener.focus();
  }

  // ---- Données ----------------------------------------------------------------
  async function loadList(more = false) {
    S.listLoading = true; if (!more) render();
    try {
      const before = more && S.list?.nextBefore ? `&before=${encodeURIComponent(S.list.nextBefore)}` : '';
      const data = await D.api(`/api/app/support/tickets?tab=${S.tab}${before}`);
      S.list = more && S.list ? { ...data, tickets: [...S.list.tickets, ...data.tickets] } : data;
      S.listError = '';
    } catch (error) { S.listError = error.message || 'Vos demandes n’ont pas pu être chargées.'; }
    S.listLoading = false; render();
  }
  async function loadThread(silent = false) {
    const id = S.ticketId; if (!id) return;
    try {
      const data = await D.api(`/api/app/support/tickets/${encodeURIComponent(id)}`);
      if (S.ticketId !== id) return;
      const before = S.thread?.messages?.length || 0;
      S.thread = data; S.threadError = '';
      if (!silent || data.messages.length !== before) renderKeepComposer();
      const last = data.messages[data.messages.length - 1];
      if (last && Number(last.id) > Number(data.lastReadMessageId || 0) && S.open && document.visibilityState === 'visible') {
        D.api(`/api/app/support/tickets/${id}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: last.id }) }).then(refreshSummary).catch(() => {});
      }
      if (silent && data.messages.length > before) ui.live.textContent = 'Nouveau message dans la discussion.';
    } catch (error) {
      if (S.ticketId !== id) return;
      if (!silent) { S.threadError = error.status === 404 ? 'Cette demande est introuvable ou ne vous est pas accessible.' : (error.message || 'La discussion n’a pas pu être chargée.'); render(); }
    }
    startPolling();
    if (S.history && !S.list) loadList();
  }
  function startPolling() { stopPolling(); if (S.open && S.view === 'thread') pollTimer = setInterval(() => { if (document.visibilityState === 'visible') loadThread(true); }, 15000); }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  async function refreshSummary() {
    try { S.summary = await D.api('/api/app/support/summary'); } catch { return; }
    const n = S.summary.unread;
    const dot = document.getElementById('supportNavDot'); if (dot) dot.hidden = !n;
    const label = n ? `Contacter le support, ${n} réponse${n > 1 ? 's' : ''} non lue${n > 1 ? 's' : ''}` : 'Contacter le support';
    ['supportNavBtn', 'supportTopBtn'].forEach((id) => document.getElementById(id)?.setAttribute('aria-label', label));
    document.getElementById('supportTopBtn')?.classList.toggle('has-unread', Boolean(n));
    if (ui) { ui.pill.querySelector('.sp-pill-dot').hidden = !n; renderFoot(); }
  }

  // ---- Rendu -------------------------------------------------------------------
  const badge = (status, label) => `<span class="sp-badge s-${status}">${IC[STATUS_ICON[status]] || ''}${esc(label)}</span>`;
  function render() {
    if (!ui || !S.open) return;
    ui.panel.classList.toggle('with-history', S.view === 'thread' && S.history);
    if (S.view === 'new') ui.body.innerHTML = viewNew();
    else if (S.view === 'thread') ui.body.innerHTML = viewThread();
    else ui.body.innerHTML = viewHome();
    renderFoot();
    const box = ui.body.querySelector('.sp-messages'); if (box) box.scrollTop = box.scrollHeight;
  }
  // Rafraîchir la discussion sans perdre la saisie ni le focus du compositeur.
  function renderKeepComposer() {
    if (!ui || !S.open || S.view !== 'thread') return;
    const box = ui.body.querySelector('.sp-messages');
    if (!box || !S.thread) { render(); return; }
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const head = ui.body.querySelector('.sp-thread-head'); if (head) head.outerHTML = threadHead();
    box.innerHTML = messagesHtml();
    const comp = ui.body.querySelector('.sp-composer-wrap');
    const resolved = S.thread.ticket.status === 'resolved';
    if (comp && Boolean(comp.dataset.resolved === '1') !== resolved) comp.outerHTML = composerHtml();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  function renderFoot() {
    if (!ui) return;
    const email = S.summary.supportEmail;
    const t = S.view === 'thread' && S.thread ? S.thread.ticket : null;
    const subject = t ? `${t.reference} · ${t.subject}` : 'Demande d’aide TRAXO';
    ui.foot.innerHTML = `<span>${S.view === 'thread' && t ? `Référence ${esc(t.reference)}` : 'Réponse dans cet espace'}</span>${email ? `<a href="mailto:${esc(email)}?subject=${encodeURIComponent(subject)}">${IC.mail}Par e-mail</a>` : ''}`;
  }

  function viewHome() {
    const L = S.list; const c = L?.counts || { open: 0, resolved: 0, all: 0 };
    const tabs = [['open', 'Ouvertes', c.open], ['resolved', 'Résolues', c.resolved], ['all', 'Toutes', c.all]];
    let list;
    if (S.listError) list = `<div class="sp-empty">${esc(S.listError)}<button type="button" class="sp-link" data-act="reload">Réessayer</button></div>`;
    else if (!L) list = '<div class="sp-empty"><span class="sp-spin" aria-hidden="true"></span>Chargement de vos demandes…</div>';
    else if (!c.all) list = '<div class="sp-empty"><strong>Vous n’avez pas encore de demande.</strong>Besoin d’un coup de main ? Écrivez-nous.</div>';
    else if (!L.tickets.length) list = `<div class="sp-empty">${S.tab === 'resolved' ? 'Aucune demande résolue pour l’instant.' : 'Aucune demande en cours. Tout est réglé.'}</div>`;
    else {
      list = `<ul class="sp-list">${L.tickets.map((t) => `<li><button type="button" class="sp-ticket" data-ticket="${esc(t.id)}">
          <span class="sp-ticket-top"><span>${esc(t.reference)}</span><span>${esc(when(t.lastActivityAt))}</span></span>
          <strong>${esc(t.subject)}${t.unread ? '<i class="sp-unread" aria-label="Réponse non lue"></i>' : ''}</strong>
          ${t.preview ? `<span class="sp-preview">${t.lastFromSupport ? 'TRAXO : ' : 'Vous : '}${esc(t.preview)}</span>` : ''}
          <span class="sp-ticket-bottom">${badge(t.status, t.statusLabel)}${t.unread ? '<em>Nouvelle réponse</em>' : ''}</span></button></li>`).join('')}</ul>
        ${L.nextBefore ? '<button type="button" class="sp-more" data-act="more">Afficher plus</button>' : ''}`;
    }
    return `<section class="sp-hero"><span class="sp-eyebrow">SUPPORT TRAXO</span><h3>Comment peut-on vous aider ?</h3><p>Retrouvez nos réponses et avancez avec nous, demande par demande.</p>
        <button type="button" class="sp-primary" data-act="new" data-autofocus>${IC.plus}Nouvelle demande</button></section>
      <section class="sp-mine"><div class="sp-mine-head"><h3>Mes demandes</h3><span>${c.all} au total</span></div>
        <div class="sp-tabs" role="tablist">${tabs.map(([k, n, v]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${n}<em>${v}</em></button>`).join('')}</div>
        <div class="sp-list-wrap">${list}</div></section>`;
  }

  function attachmentHtml(d, scope) {
    const u = d.upload; if (!u) return '';
    if (u.state === 'uploading') return `<div class="sp-att"><span class="sp-att-ic">${u.kind === 'audio' ? IC.mic : IC.file}</span><span class="sp-att-name">${esc(u.name)}<small>Envoi… ${u.pct || 0} %</small><i class="sp-progress"><b style="width:${u.pct || 0}%"></b></i></span><button type="button" class="sp-icon sm" data-act="cancel-upload" data-scope="${scope}" aria-label="Annuler l’envoi du fichier">${IC.x}</button></div>`;
    if (u.state === 'error') return `<div class="sp-att error"><span class="sp-att-ic">${IC.file}</span><span class="sp-att-name">${esc(u.name)}<small>${esc(u.error || 'Le fichier n’a pas été envoyé.')}</small></span>${u.retryable ? `<button type="button" class="sp-icon sm" data-act="retry-upload" data-scope="${scope}" aria-label="Réessayer">${IC.retry}</button>` : ''}<button type="button" class="sp-icon sm" data-act="remove-upload" data-scope="${scope}" aria-label="Retirer le fichier">${IC.x}</button></div>`;
    const audio = u.kind === 'audio' ? `<audio controls preload="none" src="/api/app/support/files/${esc(u.id)}"></audio>` : '';
    return `<div class="sp-att"><span class="sp-att-ic">${u.kind === 'audio' ? IC.mic : IC.file}</span><span class="sp-att-name">${esc(u.name)}<small>${sizeText(u.size)} · prêt à envoyer</small>${audio}</span><button type="button" class="sp-icon sm" data-act="remove-upload" data-scope="${scope}" aria-label="Retirer ${esc(u.name)}">${IC.trash}</button></div>`;
  }
  function recordingHtml() {
    if (!S.rec) return '';
    if (S.rec.state === 'asking') return '<div class="sp-rec"><span class="sp-spin" aria-hidden="true"></span>Autorisez le micro pour enregistrer…<button type="button" data-act="rec-cancel">Annuler</button></div>';
    const s = Math.floor((Date.now() - S.rec.started) / 1000);
    return `<div class="sp-rec" role="status"><i class="sp-rec-dot" aria-hidden="true"></i>Enregistrement <span class="sp-rec-time">${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</span><button type="button" data-act="rec-stop">Arrêter</button><button type="button" data-act="rec-cancel">Annuler</button></div>`;
  }
  const tools = (scope) => `<button type="button" class="sp-icon" data-act="attach" data-scope="${scope}" aria-label="Joindre un fichier" title="Joindre un fichier (image, PDF, audio · 10 Mo)">${IC.clip}</button>
      <button type="button" class="sp-icon" data-act="record" data-scope="${scope}" aria-label="Enregistrer une note vocale" title="Note vocale" ${S.rec ? 'disabled' : ''}>${IC.mic}</button>`;

  function viewNew() {
    const d = draftOf('new');
    return `<div class="sp-bar"><button type="button" class="sp-link" data-act="home">${IC.back}Mes demandes</button></div>
      <form class="sp-form" data-form="new" novalidate>
        <h3>Que se passe-t-il ?</h3><p>Donnez-nous quelques détails pour que nous puissions vous aider.</p>
        <label>Sujet<input name="subject" maxlength="120" value="${esc(d.subject)}" placeholder="Ex. : mon livreur reste hors ligne" data-autofocus required></label>
        <label>Catégorie<select name="category">${CATEGORIES.map(([k, n]) => `<option value="${k}" ${d.category === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Votre message<textarea name="text" rows="5" maxlength="5000" placeholder="Décrivez ce que vous voyez, et depuis quand.">${esc(d.text)}</textarea></label>
        <div class="sp-drop">${attachmentHtml(d, 'new')}${recordingHtml()}</div>
        ${S.sendError ? `<p class="sp-error" role="alert">${esc(S.sendError)}</p>` : ''}
        <div class="sp-form-actions">${tools('new')}<button type="submit" class="sp-primary" ${S.busy || d.upload?.state === 'uploading' ? 'disabled' : ''}>${S.busy ? 'Envoi…' : 'Créer ma demande'}</button></div>
      </form>`;
  }

  function threadHead() {
    const t = S.thread.ticket;
    return `<div class="sp-thread-head"><span class="sp-ref">${esc(t.reference)} · ${esc(t.categoryLabel)}</span><h3>${esc(t.subject)}</h3>${badge(t.status, t.statusLabel)}</div>`;
  }
  function messagesHtml() {
    const { messages, events } = S.thread;
    const items = [...messages.map((m) => ({ type: 'm', at: m.createdAt, m })), ...events.filter((e) => e.kind !== 'created').map((e) => ({ type: 'e', at: e.at, e }))]
      .sort((a, b) => (new Date(a.at) - new Date(b.at)) || (a.type === b.type ? 0 : a.type === 'e' ? -1 : 1));
    let day = ''; let html = '';
    for (const it of items) {
      const k = dayKey(it.at);
      if (k !== day) { day = k; html += `<p class="sp-day">${esc(dayLabel(it.at))}</p>`; }
      if (it.type === 'e') {
        const e = it.e;
        const label = e.kind === 'reopened' ? 'Demande rouverte' : e.kind === 'status_changed' ? `Statut : ${e.toLabel}` : '';
        if (label) html += `<p class="sp-event">${esc(label)} · ${hm(e.at)}</p>`;
        continue;
      }
      const m = it.m; const mine = m.author === 'customer';
      const files = m.attachments.map((f) => {
        const url = `/api/app/support/files/${encodeURIComponent(f.id)}`;
        if (f.kind === 'image') return `<a class="sp-img" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(f.name)}" loading="lazy"></a>`;
        if (f.kind === 'audio') return `<audio controls preload="none" src="${url}" aria-label="Note vocale ${esc(f.name)}"></audio>`;
        return `<a class="sp-file" href="${url}?download=1">${IC.file}<span>${esc(f.name)}<small>${sizeText(f.size)}</small></span></a>`;
      }).join('');
      html += `<div class="sp-msg${mine ? ' mine' : ''}"><div class="sp-bubble">${m.body ? `<p>${esc(m.body)}</p>` : ''}${files}</div><small>${mine ? '' : `${esc(m.authorLabel)} · `}${hm(m.createdAt)}</small></div>`;
    }
    return html;
  }
  function composerHtml() {
    const t = S.thread.ticket;
    if (t.status === 'resolved') {
      return `<div class="sp-composer-wrap sp-resolved" data-resolved="1"><p>Cette demande est résolue. Le problème revient ? Reprenez cet échange.</p>
        <button type="button" class="sp-primary" data-act="reopen" ${S.busy ? 'disabled' : ''}>Rouvrir la demande</button><button type="button" class="sp-link" data-act="new">Un autre sujet ? Nouvelle demande</button></div>`;
    }
    const d = draftOf(t.id);
    return `<div class="sp-composer-wrap" data-resolved="0"><form class="sp-composer" data-form="reply" novalidate>
        <label class="sr-only" for="spReply">Votre réponse</label>
        <textarea id="spReply" name="text" rows="3" maxlength="5000" placeholder="Écrivez votre réponse…" data-autofocus>${esc(d.text)}</textarea>
        <div class="sp-drop">${attachmentHtml(d, t.id)}${recordingHtml()}</div>
        ${S.sendError ? `<p class="sp-error" role="alert">${esc(S.sendError)}</p>` : ''}
        <div class="sp-composer-tools">${tools(t.id)}<button type="submit" class="sp-primary sm" ${S.busy || d.upload?.state === 'uploading' ? 'disabled' : ''}>${S.busy ? 'Envoi…' : 'Envoyer'}${IC.send}</button></div>
      </form></div>`;
  }
  function viewThread() {
    const bar = `<div class="sp-bar"><button type="button" class="sp-link" data-act="home">${IC.back}Mes demandes</button><button type="button" class="sp-link" data-act="history" aria-pressed="${S.history}">${IC.history}Historique</button></div>`;
    let history = '';
    if (S.history) {
      const others = (S.list?.tickets || []);
      history = `<nav class="sp-history" aria-label="Autres demandes"><p>MES DEMANDES</p>${others.map((t) => `<button type="button" class="sp-hist" data-ticket="${esc(t.id)}" aria-current="${t.id === S.ticketId ? 'true' : 'false'}"><span>${esc(t.reference)}<em>${esc(when(t.lastActivityAt))}</em></span><strong>${esc(t.subject)}${t.unread ? '<i class="sp-unread" aria-label="Réponse non lue"></i>' : ''}</strong>${badge(t.status, t.statusLabel)}</button>`).join('') || '<small>Chargement…</small>'}<button type="button" class="sp-link sp-new-thread" data-act="new">${IC.plus}Nouvelle demande</button></nav>`;
    }
    let convo;
    if (S.threadError) convo = `<div class="sp-empty">${esc(S.threadError)}<button type="button" class="sp-link" data-act="home">Revenir à mes demandes</button></div>`;
    else if (!S.thread) convo = '<div class="sp-empty"><span class="sp-spin" aria-hidden="true"></span>Chargement de la discussion…</div>';
    else convo = `${S.notice ? `<p class="sp-notice" role="status">${esc(S.notice)}</p>` : ''}${threadHead()}<div class="sp-messages" tabindex="0" aria-label="Discussion">${messagesHtml()}</div>${composerHtml()}`;
    return `${bar}<div class="sp-split">${history}<div class="sp-convo">${convo}</div></div>`;
  }

  // ---- Interactions ----------------------------------------------------------------
  function onInput(e) {
    const form = e.target.closest('form[data-form]'); if (!form) return;
    const scope = form.dataset.form === 'new' ? 'new' : S.ticketId;
    const d = draftOf(scope);
    if (e.target.name === 'subject') d.subject = e.target.value;
    if (e.target.name === 'category') d.category = e.target.value;
    if (e.target.name === 'text') d.text = e.target.value;
    if (S.sendError) { S.sendError = ''; form.querySelector('.sp-error')?.remove(); }
    saveDrafts();
  }
  function onClick(e) {
    const t = e.target.closest('[data-act],[data-ticket],[data-tab]');
    if (!t || t.disabled) return;
    if (t.dataset.ticket) { goThread(t.dataset.ticket); return; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.list = null; saveState(); loadList(); return; }
    const scope = t.dataset.scope;
    switch (t.dataset.act) {
      case 'minimize': minimize(); break;
      case 'close': close(); break;
      case 'new': stopRecording(true); S.view = 'new'; S.sendError = ''; S.notice = ''; stopPolling(); saveState(); render(); focusFirst(); break;
      case 'home': stopRecording(true); S.view = 'home'; S.sendError = ''; S.notice = ''; stopPolling(); saveState(); render(); loadList(); break;
      case 'history': S.history = !S.history; saveState(); render(); if (S.history) loadList(); break;
      case 'reload': loadList(); break;
      case 'more': loadList(true); break;
      case 'attach': S.attachScope = scope; ui.fileInput.click(); break;
      case 'record': startRecording(scope); break;
      case 'rec-stop': stopRecording(false); break;
      case 'rec-cancel': stopRecording(true); renderDrop(); break;
      case 'remove-upload': removeUpload(scope); break;
      case 'cancel-upload': removeUpload(scope); break;
      case 'retry-upload': { const u = draftOf(scope).upload; if (u && u.file) upload(scope, u.file, u.name); break; }
      case 'reopen': reopen(); break;
      default: break;
    }
  }
  function goThread(id) {
    stopRecording(true);
    S.view = 'thread'; S.ticketId = String(id); S.thread = null; S.threadError = ''; S.sendError = ''; S.notice = '';
    saveState(); render(); loadThread();
  }
  const focusFirst = () => requestAnimationFrame(() => ui.panel.querySelector('[data-autofocus]')?.focus({ preventScroll: true }));
  function renderDrop() {
    const drop = ui?.body.querySelector('.sp-drop'); if (!drop) { render(); return; }
    const scope = S.view === 'new' ? 'new' : S.ticketId;
    drop.innerHTML = attachmentHtml(draftOf(scope), scope) + recordingHtml();
    const submit = ui.body.querySelector('form[data-form] [type="submit"]'); if (submit) submit.disabled = S.busy || draftOf(scope).upload?.state === 'uploading';
    ui.body.querySelectorAll('[data-act="record"]').forEach((b) => { b.disabled = Boolean(S.rec); });
  }

  // ---- Pièces jointes : téléversées dès le choix, rattachées à l'envoi ----------------
  function attach(file, nameOverride) {
    const scope = S.attachScope || (S.view === 'new' ? 'new' : S.ticketId);
    if (file.size > 10 * 1024 * 1024) { draftOf(scope).upload = { state: 'error', name: file.name, error: 'Ce fichier dépasse 10 Mo.', retryable: false }; saveDrafts(); renderDrop(); return; }
    upload(scope, file, nameOverride || file.name);
  }
  function upload(scope, file, name) {
    const d = draftOf(scope);
    if (d.upload?.id) D.api(`/api/app/support/uploads/${d.upload.id}`, { method: 'DELETE' }).catch(() => {});
    const u = { state: 'uploading', name, size: file.size, kind: /^audio\//.test(file.type) ? 'audio' : 'file', pct: 0, file };
    d.upload = u; renderDrop();
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    xhr.open('POST', `/api/app/support/uploads?name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && d.upload === u) { u.pct = Math.round((ev.loaded / ev.total) * 100); const bar = ui.body.querySelector('.sp-progress b'); if (bar) { bar.style.width = `${u.pct}%`; bar.closest('.sp-att-name').querySelector('small').textContent = `Envoi… ${u.pct} %`; } } };
    xhr.onload = () => {
      if (d.upload !== u) return;
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 201) { d.upload = { state: 'ready', id: data.id, name: data.name, size: data.size, kind: data.kind, mime: data.mime }; ui.live.textContent = `${data.name} est prêt à être envoyé.`; }
      else d.upload = { state: 'error', name, size: file.size, file, error: data.error || 'Le fichier n’a pas été envoyé.', retryable: xhr.status >= 500 || xhr.status === 429 || xhr.status === 0 };
      saveDrafts(); renderDrop();
    };
    xhr.onerror = () => { if (d.upload !== u) return; d.upload = { state: 'error', name, size: file.size, file, error: 'Connexion interrompue pendant l’envoi.', retryable: true }; renderDrop(); };
    xhr.send(file);
  }
  function removeUpload(scope) {
    const d = draftOf(scope); const u = d.upload;
    if (u?.xhr) u.xhr.abort();
    if (u?.id) D.api(`/api/app/support/uploads/${u.id}`, { method: 'DELETE' }).catch(() => {});
    d.upload = null; saveDrafts(); renderDrop();
  }

  // ---- Note vocale : micro ouvert sur clic, coupé à chaque sortie ------------------------
  function pickMime() {
    if (!window.MediaRecorder) return null;
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  }
  async function startRecording(scope) {
    if (S.rec) return;
    const mime = pickMime();
    if (mime === null || !navigator.mediaDevices?.getUserMedia) { micUnavailable(scope); return; }
    const req = ++S.micReq;
    S.rec = { state: 'asking', scope }; renderDrop();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { if (req === S.micReq) { S.rec = null; micUnavailable(scope); } return; }
    // Autorisation arrivée après fermeture, réduction ou changement de demande : on coupe tout de suite.
    const scopeNow = S.view === 'new' ? 'new' : S.ticketId;
    if (req !== S.micReq || !S.open || scopeNow !== scope) { stream.getTracks().forEach((t) => t.stop()); return; }
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    S.rec = { state: 'recording', scope, rec, stream, chunks, started: Date.now(), cancel: false };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const r = S.rec; if (!r || r.rec !== rec) return;
      S.rec = null; clearInterval(r.timer);
      if (r.cancel || !chunks.length) { renderDrop(); return; }
      const type = rec.mimeType || mime || 'audio/webm';
      const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
      const blob = new Blob(chunks, { type });
      const stamp = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date()).replace(':', 'h');
      S.attachScope = r.scope;
      attach(new File([blob], `note-vocale-${stamp}.${ext}`, { type }), `Note vocale ${stamp}.${ext}`);
    };
    rec.start(1000);
    S.rec.timer = setInterval(() => {
      const el = ui?.body.querySelector('.sp-rec-time'); if (!S.rec || !el) return;
      const s = Math.floor((Date.now() - S.rec.started) / 1000);
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s >= 300) stopRecording(false); // 5 minutes au plus
    }, 500);
    renderDrop();
  }
  function stopRecording(cancel) {
    S.micReq += 1; // annule une autorisation encore en attente
    const r = S.rec; if (!r) return;
    if (r.state === 'asking') { S.rec = null; return; }
    r.cancel = cancel; clearInterval(r.timer);
    try { r.rec.state !== 'inactive' ? r.rec.stop() : r.stream.getTracks().forEach((t) => t.stop()); } catch { r.stream?.getTracks().forEach((t) => t.stop()); }
    if (cancel) { S.rec = null; r.stream?.getTracks().forEach((t) => t.stop()); }
  }
  function micUnavailable(scope) {
    const d = draftOf(scope);
    d.upload = { state: 'error', name: 'Note vocale', error: 'Micro indisponible ou refusé. Vous pouvez joindre un fichier audio à la place.', retryable: false };
    renderDrop();
    ui.fileInput.accept = 'audio/*'; S.attachScope = scope;
    setTimeout(() => { ui.fileInput.accept = 'image/jpeg,image/png,image/webp,application/pdf,audio/*'; }, 30000);
  }

  // ---- Envois (idempotents : la même clé est rejouée jusqu'au succès) -------------------
  const post = (url, body) => D.api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  async function submitNew() {
    const d = draftOf('new');
    if (S.busy) return;
    if (!d.subject.trim()) { S.sendError = 'Donnez un sujet à votre demande.'; render(); ui.body.querySelector('[name="subject"]')?.focus(); return; }
    if (!d.text.trim() && d.upload?.state !== 'ready') { S.sendError = 'Décrivez le problème, ou joignez un fichier ou une note vocale.'; render(); ui.body.querySelector('[name="text"]')?.focus(); return; }
    d.key = d.key || newKey(); saveDrafts();
    S.busy = true; S.sendError = ''; renderDrop(); setSubmitLabel('Envoi…');
    try {
      const out = await post('/api/app/support/tickets', { subject: d.subject, category: d.category, message: d.text, uploadId: d.upload?.state === 'ready' ? d.upload.id : undefined, idempotencyKey: d.key });
      delete drafts.new; saveDrafts();
      S.busy = false; S.notice = 'Merci, votre demande a bien été envoyée. Vous retrouverez notre réponse ici.';
      S.list = null; S.view = 'thread'; S.ticketId = out.ticket.id; S.thread = null; saveState(); render(); loadThread();
      ui.live.textContent = `Demande ${out.ticket.reference} créée.`;
    } catch (error) {
      S.busy = false;
      if (error.payload?.code === 'UPLOAD_GONE') { d.upload = null; saveDrafts(); }
      S.sendError = error.status && error.status < 500 && error.payload?.error ? error.payload.error : 'Votre demande n’a pas été envoyée. Réessayez, votre brouillon est conservé.';
      render();
    }
  }
  async function sendMessage() {
    if (S.busy || !S.thread) return;
    const id = S.ticketId; const d = draftOf(id);
    if (!d.text.trim() && d.upload?.state !== 'ready') { ui.body.querySelector('#spReply')?.focus(); return; }
    d.key = d.key || newKey(); saveDrafts();
    S.busy = true; S.sendError = ''; setSubmitLabel('Envoi…');
    try {
      await post(`/api/app/support/tickets/${id}/messages`, { message: d.text, uploadId: d.upload?.state === 'ready' ? d.upload.id : undefined, idempotencyKey: d.key });
      delete drafts[id]; saveDrafts();
      S.busy = false; S.notice = '';
      if (S.ticketId === id) { await loadThread(true); render(); focusFirst(); }
    } catch (error) {
      S.busy = false;
      if (error.payload?.code === 'RESOLVED') { await loadThread(); return; }
      if (error.payload?.code === 'UPLOAD_GONE') { d.upload = null; saveDrafts(); }
      S.sendError = error.status && error.status < 500 && error.payload?.error ? error.payload.error : 'Votre message n’a pas été envoyé. Réessayez, votre brouillon est conservé.';
      if (S.ticketId === id) { const box = ui.body.querySelector('.sp-composer-wrap'); if (box) box.outerHTML = composerHtml(); }
    }
  }
  function setSubmitLabel(label) { const b = ui.body.querySelector('form[data-form] [type="submit"]'); if (b) { b.disabled = true; b.firstChild.textContent = label; } }
  async function reopen() {
    if (S.busy) return;
    S.busy = true; render();
    try { await post(`/api/app/support/tickets/${S.ticketId}/reopen`); S.busy = false; S.list = null; await loadThread(); render(); focusFirst(); ui.live.textContent = 'Demande rouverte.'; }
    catch (error) { S.busy = false; D.toast?.(error.message || 'La demande n’a pas pu être rouverte.', 'error'); render(); }
  }

  // ---- Démarrage -------------------------------------------------------------------
  function init(deps) {
    D = deps;
    drafts = store.get(keys().drafts) || {};
    // Brouillons sans fichier encore en cours d'envoi après rechargement : on les remet à zéro.
    Object.values(drafts).forEach((d) => { if (d && d.upload && d.upload.state !== 'ready') d.upload = null; });
    const saved = store.get(keys().state, 'session');
    if (saved) Object.assign(S, { view: saved.view || 'home', ticketId: saved.ticketId || null, tab: saved.tab || 'open', history: Boolean(saved.history) });
    ['supportNavBtn', 'supportTopBtn'].forEach((id) => document.getElementById(id)?.addEventListener('click', () => (S.open ? close() : open())));
    // Déconnexion : les brouillons de cet utilisateur ne restent pas sur l'appareil.
    document.querySelectorAll('form[action="/app/logout"]').forEach((f) => f.addEventListener('submit', () => { store.del(keys().drafts); store.del(keys().state, 'session'); }));
    // Un lien « …?support=ID » (cloche, e-mail) ouvre la demande sans quitter la page.
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href*="support="]');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      const m = a.getAttribute('href').match(/[?&]support=(\d{1,18})/);
      if (!m) return;
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('traxo:close-popovers', { detail: 'support' }));
      open(m[1]);
    });
    window.addEventListener('pagehide', () => stopRecording(true));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopRecording(false); });
    document.addEventListener('traxo:close-popovers', (e) => { if (e.detail !== 'support' && S.open && window.innerWidth <= 700) minimize(); });
    const params = new URLSearchParams(location.search);
    const target = params.get('support');
    if (target && /^\d{1,18}$/.test(target)) {
      params.delete('support');
      try { history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`); } catch { /* ignore */ }
      open(target);
    } else if (saved?.open) open();
    else if (saved?.minimized) { mount(); S.minimized = true; ui.pill.hidden = false; }
    refreshSummary();
    summaryTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshSummary(); }, 60000);
  }

  window.TraxoSupport = { init, open: (id) => open(id), close, isOpen: () => S.open };
})();
