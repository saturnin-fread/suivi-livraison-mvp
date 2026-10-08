// Rapports et exports — espace unique (kit « TRAXO Rapports »).
// Choix des familles, période et filtres partagés, aperçu calculé par le
// serveur, puis fichier : CSV (ZIP si plusieurs familles), synthèse SVG ou
// Excel enrichi (Rapport Premium : rapports offerts, puis payés depuis le portefeuille).
(function () {
  'use strict';
  const ICONS = {"package": "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\" /> <path d=\"M12 22V12\" /> <path d=\"m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7\" /> <path d=\"m7.5 4.27 9 5.15\" />", "route": "<circle cx=\"6\" cy=\"19\" r=\"3\" /> <path d=\"M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15\" /> <circle cx=\"18\" cy=\"5\" r=\"3\" />", "circle-alert": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\" /> <line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\" />", "contact": "<path d=\"M16 2v2\" /> <path d=\"M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2\" /> <path d=\"M8 2v2\" /> <circle cx=\"12\" cy=\"11\" r=\"3\" /> <rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\" />", "check": "<path d=\"M20 6 9 17l-5-5\" />", "columns-3": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /> <path d=\"M9 3v18\" /> <path d=\"M15 3v18\" />", "chevron-left": "<path d=\"m15 18-6-6 6-6\" />", "chevron-right": "<path d=\"m9 18 6-6-6-6\" />", "chevron-down": "<path d=\"m6 9 6 6 6-6\" />", "download": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /> <polyline points=\"7 10 12 15 17 10\" /> <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\" />", "check-check": "<path d=\"M18 6 7 17l-5-5\" /> <path d=\"m22 10-7.5 7.5L13 16\" />", "calendar": "<path d=\"M8 2v4\" /> <path d=\"M16 2v4\" /> <rect width=\"18\" height=\"18\" x=\"3\" y=\"4\" rx=\"2\" /> <path d=\"M3 10h18\" />", "filter": "<polygon points=\"22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3\" />", "search": "<circle cx=\"11\" cy=\"11\" r=\"8\" /> <path d=\"m21 21-4.3-4.3\" />", "x": "<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />"};
  const ic = (n) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ICONS.package}</svg>`;
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FAMILY_ICON = { orders: 'package', tours: 'route', incidents: 'circle-alert', clients: 'contact' };
  const GOOD = ['Livrée', 'Terminée', 'Résolu']; const BAD = ['Annulée', 'Échec', 'Retournée', 'Retour'];
  const PAGE = 6;
  // Dates du jour au Bénin (UTC+1, sans heure d'été).
  const today = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const dayFr = (d, year) => new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  const stampFr = (s) => { if (!s) return ''; const [d, t] = String(s).split(' '); return `${dayFr(d)}${t ? ` · ${t}` : ''}`; };

  async function render(page, deps) {
    const { api } = deps;
    page.classList.add('page-rp');
    page.innerHTML = '<div class="rp"><div class="rp-wrap"><div class="empty">Chargement de vos données…</div></div></div>';
    const root = page.querySelector('.rp');
    const $ = (s) => root.querySelector(s);
    let opts;
    try { opts = await api('/api/app/reports/options'); } catch (error) {
      root.innerHTML = `<div class="rp-wrap"><div class="empty">${esc(error.message || 'Rapports indisponibles.')}</div></div>`;
      return;
    }
    const F = Object.fromEntries(opts.families.map((f) => [f.key, f]));
    const allowedKeys = opts.families.filter((f) => f.allowed).map((f) => f.key);
    const legacy = { operations: 'orders', routes: 'tours', customers: 'clients', incidents: 'incidents' };
    const wanted = new URLSearchParams(location.search).get('source');
    const firstSource = legacy[wanted] || wanted;
    const S = {
      sources: new Set(firstSource && allowedKeys.includes(firstSource) ? [firstSource] : allowedKeys),
      active: null, format: 'csv', view: 'data', period: 'week', from: addDays(today(), -6), to: today(),
      zone: 'all', driver: 'all', query: '', status: {}, page: 1,
      fields: Object.fromEntries(opts.families.map((f) => [f.key, new Set(f.fields.filter((x) => !x.personal).map((x) => x.key))])),
      data: null, loading: false, error: null, excel: opts.excel, step: 'configure', snapshot: null, busy: false, notice: '',
    };
    const datesValid = () => /^\d{4}-\d{2}-\d{2}$/.test(S.from) && /^\d{4}-\d{2}-\d{2}$/.test(S.to) && S.from <= S.to;
    const tooLong = () => datesValid() && (Date.parse(`${S.to}T00:00:00Z`) - Date.parse(`${S.from}T00:00:00Z`)) / 86400000 + 1 > opts.maxDays;
    const periodLabel = () => `${dayFr(S.from, S.from.slice(0, 4) !== S.to.slice(0, 4))} – ${dayFr(S.to, true)}`;
    const fam = (k) => S.data?.families.find((x) => x.key === k);
    const count = () => (S.data ? S.data.families.reduce((a, x) => a + x.count, 0) : 0);
    const valid = () => S.sources.size > 0 && datesValid() && !tooLong() && count() > 0 && !S.loading && !S.error;
    // Excel possible : mois en cours, rapport offert, ou rapport payable par cette personne.
    const excelOk = () => ['month', 'free'].includes(S.excel?.state) || (S.excel?.state === 'paid' && opts.canPay && S.excel.canPayReport);
    const money = (n) => `${Number(n || 0).toLocaleString('fr-FR')} F`;
    const selectionBody = () => ({
      sources: [...S.sources], filters: { from: S.from, to: S.to, zone: S.zone, driver: S.driver, status: S.status, query: S.query },
      fields: Object.fromEntries([...S.sources].map((k) => [k, [...S.fields[k]]])),
    });

    // ---- Données : le serveur calcule toujours les lignes et les compteurs ----
    let seq = 0; let timer = null;
    function load(delay = 0) {
      clearTimeout(timer);
      if (!S.sources.size || !datesValid() || tooLong()) { seq += 1; S.data = null; S.loading = false; S.error = null; renderPreview(); renderFormats(); return; }
      S.loading = true;
      renderFormats();
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const data = await api('/api/app/reports/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selectionBody()) });
          if (mine !== seq) return; // une sélection plus récente a pris le relais
          S.data = data; S.error = null;
        } catch (error) {
          if (mine !== seq) return;
          S.data = null; S.error = error.message || 'Aperçu indisponible.';
        }
        S.loading = false;
        refresh();
      }, delay);
    }

    // ---- Rendu ----------------------------------------------------------
    const opt = (vals, selected, first) => `<option value="all">${esc(first)}</option>${vals.map((v) => {
      const val = typeof v === 'object' ? v.id : v; const label = typeof v === 'object' ? v.name : v;
      return `<option value="${esc(val)}" ${String(val) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('')}`;
    function sourceCards() {
      return opts.families.map((f) => {
        const on = S.sources.has(f.key); const n = fam(f.key)?.count;
        const sub = !f.allowed ? 'Réservé aux responsables' : !on ? 'Non inclus' : n == null ? '…' : `${n} élément${n > 1 ? 's' : ''}`;
        return `<button type="button" class="source" data-source="${f.key}" aria-pressed="${on}" ${f.allowed ? '' : 'disabled'}><span class="source-icon">${ic(FAMILY_ICON[f.key])}</span><span class="tick">${on ? ic('check') : ''}</span><span class="source-name">${esc(f.name)}</span><small>${sub}</small></button>`;
      }).join('');
    }
    function full() {
      if (S.step === 'ready') { ready(); return; }
      const allOn = allowedKeys.every((k) => S.sources.has(k));
      root.innerHTML = `<div class="rp-wrap"><div class="intro"><div><div class="eyebrow">RAPPORTS ET EXPORTS</div><h1>Vos données, prêtes pour la suite.</h1><p>Choisissez ce que vous souhaitez garder. TRAXO rassemble le tout.</p></div><div class="step-note"><b>01 / 02</b>Préparer votre export</div></div>
        <div class="layout"><div class="left">
          <section class="block"><div class="section-head"><h2>Que souhaitez-vous exporter ?</h2><button type="button" class="text-btn" data-action="all">${allOn ? 'Tout désélectionner' : 'Tout sélectionner'}</button></div>
            <div class="sources" id="rpSources">${sourceCards()}</div>
            <div class="period"><span>Sur quelle période ?</span><div class="seg" role="group" aria-label="Période">${[['week', '7 derniers jours'], ['month', 'Ce mois-ci'], ['custom', 'Personnaliser']].map(([k, n]) => `<button type="button" data-period="${k}" aria-pressed="${S.period === k}">${n}</button>`).join('')}</div></div>
            ${S.period === 'custom' ? `<div class="filters"><label>Du<input type="date" data-filter="from" value="${esc(S.from)}" max="${today()}"></label><label>Au<input type="date" data-filter="to" value="${esc(S.to)}" max="${today()}"></label></div>` : ''}
            <div class="filters"><label>Zone<select data-filter="zone">${opt(opts.zones, S.zone, 'Toutes les zones')}</select></label><label>Livreur<select data-filter="driver">${opt(opts.drivers, S.driver, 'Tous les livreurs')}</select></label></div>
            <p class="scope" id="rpScope"></p>
          </section>
          <section class="block preview-block"><div class="section-head"><div><h2>Un dernier coup d’œil</h2><small id="rpCount"></small></div><div class="seg" role="group" aria-label="Affichage"><button type="button" data-view="data" aria-pressed="${S.view === 'data'}">Données</button><button type="button" data-view="render" aria-pressed="${S.view === 'render'}">Rendu</button></div></div><div id="rpPreview"></div></section>
        </div><aside class="format-rail" aria-label="Format et téléchargement" id="rpFormats"></aside></div>
        <div id="rpFeedback" role="status" aria-live="polite" ${S.notice ? '' : 'hidden'}>${esc(S.notice)}</div></div>`;
      refresh();
    }
    // Mise à jour sans reconstruire les champs en cours de saisie.
    function refresh() {
      if (S.step === 'ready') return;
      const src = $('#rpSources'); if (src) src.innerHTML = sourceCards();
      const scope = $('#rpScope');
      if (scope) scope.innerHTML = `${datesValid() ? esc(periodLabel()) : 'Choisissez une date de début et une date de fin valides.'} · Commandes et incidents selon leur date de création, tournées selon leur date de service. Clients : ceux qui ont une commande créée sur cette période.<br>Les filtres suivent votre sélection. Vous choisissez aussi les colonnes de chaque famille.${!datesValid() ? '<span class="error" role="alert"><br>La date de fin doit être après la date de début.</span>' : tooLong() ? `<span class="error" role="alert"><br>La période est limitée à ${opts.maxDays} jours pour votre rôle.</span>` : ''}`;
      const c = $('#rpCount'); if (c) c.textContent = S.loading ? 'Mise à jour…' : `${count()} ligne${count() > 1 ? 's' : ''} dans votre sélection`;
      renderPreview(); renderFormats();
    }
    function renderPreview() {
      const el = $('#rpPreview'); if (!el) return;
      if (!S.sources.size) { el.innerHTML = '<div class="empty">Sélectionnez au moins une famille de données pour préparer votre export.</div>'; return; }
      if (S.error) { el.innerHTML = `<div class="empty">${esc(S.error)}<br><button type="button" class="text-btn" data-action="retry">Réessayer</button></div>`; return; }
      if (!S.data) { el.innerHTML = `<div class="empty">${S.loading ? 'Chargement de l’aperçu…' : 'Vérifiez votre sélection.'}</div>`; return; }
      if (S.view === 'render') {
        if (S.format === 'xlsx') { excelPreview(el); return; }
        if (S.format === 'svg') { el.innerHTML = `<div class="render-stage"><div id="svg-stage">${summarySvg(680)}</div><p class="scope">Une synthèse à partager, sans les coordonnées de vos clients.</p></div>`; return; }
        el.innerHTML = `<div class="render-stage"><div class="workbook"><div class="workbook-bar"><span>VOTRE DOSSIER D’EXPORT</span><span>${S.sources.size > 1 ? '.ZIP' : '.CSV'}</span></div><div class="sheet"><h3>Les détails, bien rangés.</h3><p class="period-label">Un fichier par famille de données, réuni dans un seul téléchargement.</p><div class="ready-list" style="margin-top:22px;margin-bottom:0">${S.data.families.map((x) => `<div><span>${esc(x.name)}.csv</span><span>${x.count} lignes</span></div>`).join('')}</div></div></div><p class="scope">Les identifiants sont conservés pour retrouver les liens entre vos données.</p></div>`;
        return;
      }
      if (!S.sources.has(S.active)) S.active = [...S.sources][0];
      const k = S.active; const f = fam(k); const def = F[k];
      if (!f) { el.innerHTML = '<div class="empty">Chargement…</div>'; return; }
      const fields = def.fields.filter((x) => S.fields[k].has(x.key));
      const pages = Math.max(1, Math.ceil(f.rows.length / PAGE));
      S.page = Math.min(Math.max(1, S.page), pages);
      const cell = (x, r) => {
        const v = r[x.key];
        if (x.key === 'status') return `<span class="status ${GOOD.includes(v) ? 'good' : BAD.includes(v) ? 'bad' : 'warn'}">${esc(v)}</span>`;
        if (x.type === 'date') return esc(stampFr(v));
        if (x.type === 'day') return esc(v ? dayFr(v) : '');
        if (x.type === 'money') return v === '' || v == null ? '—' : `${esc(new Intl.NumberFormat('fr-FR').format(Number(v)))} F`;
        return esc(v === '' || v == null ? '—' : v);
      };
      const tools = el.querySelector('.table-tools');
      const keepTools = tools && tools.dataset.family === k && document.activeElement && tools.contains(document.activeElement);
      const toolsHtml = `<div class="table-tools" data-family="${k}"><input type="search" data-query value="${esc(S.query)}" placeholder="Rechercher dans les données…" aria-label="Rechercher dans toutes les données exportées">
          ${f.statuses.length ? `<select data-status="${k}" aria-label="Statut des ${esc(def.name.toLowerCase())}">${opt(f.statuses, S.status[k] || 'all', 'Tous les statuts')}</select>` : ''}
          <details><summary>${ic('columns-3')}Colonnes</summary><div class="field-options">${def.fields.map((x) => `<label><input type="checkbox" data-field="${x.key}" ${S.fields[k].has(x.key) ? 'checked' : ''} ${x.required ? 'disabled' : ''}>${esc(x.label)}${x.required ? '<small>lié</small>' : x.personal ? '<small>personnel</small>' : ''}</label>`).join('')}</div></details></div>`;
      const body = `${f.rows.length ? `<div class="table-wrap"><table><thead><tr>${fields.map((x) => `<th scope="col">${esc(x.label)}</th>`).join('')}</tr></thead><tbody>${f.rows.slice((S.page - 1) * PAGE, S.page * PAGE).map((r) => `<tr>${fields.map((x) => `<td>${cell(x, r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">Aucun résultat pour ces filtres.<br><button type="button" class="text-btn" data-action="reset">Réinitialiser les filtres</button></div>'}
        <div class="pagination"><span>${f.rows.length ? `${(S.page - 1) * PAGE + 1}–${Math.min(S.page * PAGE, f.rows.length)} sur ${f.count}` : '0 résultat'} · Toutes les lignes seront exportées${f.previewLimited ? ' · aperçu limité aux 2 000 premières' : ''}</span>
          <div class="pages"><button type="button" data-page="${S.page - 1}" ${S.page === 1 ? 'disabled' : ''} aria-label="Page précédente">${ic('chevron-left')}</button><button type="button" aria-current="page" aria-label="Page ${S.page}">${S.page}</button><span>/ ${pages}</span><button type="button" data-page="${S.page + 1}" ${S.page === pages ? 'disabled' : ''} aria-label="Page suivante">${ic('chevron-right')}</button></div></div>`;
      const tabs = `<div class="tabs" role="tablist">${S.data.families.map((x) => `<button type="button" data-tab="${x.key}" aria-pressed="${S.active === x.key}">${esc(x.name)}<em>${x.count}</em></button>`).join('')}</div>`;
      if (keepTools) {
        // On garde la barre d'outils (saisie en cours) et on remplace le reste.
        el.querySelector('.tabs').outerHTML = tabs;
        const select = tools.querySelector('select[data-status]');
        if (select && document.activeElement !== select) select.outerHTML = `<select data-status="${k}" aria-label="Statut des ${esc(def.name.toLowerCase())}">${opt(f.statuses, S.status[k] || 'all', 'Tous les statuts')}</select>`;
        while (tools.nextSibling) tools.nextSibling.remove();
        tools.insertAdjacentHTML('afterend', body);
        return;
      }
      const wasOpen = Boolean(el.querySelector('details[open]'));
      el.innerHTML = `${tabs}${toolsHtml}${body}`;
      if (wasOpen) el.querySelector('details').open = true;
    }
    function excelPreview(el) {
      const os = fam('orders'); const has = Boolean(os);
      const delivered = has ? os.rows.filter((r) => r.status === 'Livrée').length : 0;
      const rate = has && os.rows.length ? `${Math.round((delivered / os.rows.length) * 100)} %` : '—';
      const items = S.data.families; const max = Math.max(1, ...items.map((x) => x.count));
      el.innerHTML = `<div class="render-stage"><div class="workbook"><div class="workbook-bar"><span>TRAXO_Bilan_activite.xlsx</span><span>EXCEL ENRICHI</span></div><div class="sheet"><div class="kicker">VOTRE BILAN D’ACTIVITÉ</div><h3>Votre activité en un regard.</h3><p class="period-label">${esc(periodLabel())}</p>
        <div class="metrics"><div><b>${has ? os.count : '—'}</b><span>Commandes</span></div><div><b>${rate}</b><span>Part livrée</span></div><div><b>${items.length + 1}</b><span>Onglets</span></div></div>
        <div class="mini-bars">${items.map((x) => `<div><div class="bar-label"><span>${esc(x.name)}</span><span>${x.count}</span></div><div class="bar-track"><div class="bar-fill ${x.key === 'orders' ? 'red' : ''}" style="width:${(x.count / max) * 100}%"></div></div></div>`).join('')}</div>
        <div class="formula">${ic('check-check')}Graphiques Excel modifiables · Calculs intégrés${has ? '' : ' · ajoutez Commandes pour les graphiques'}</div></div><div class="sheet-tabs"><b>Synthèse</b>${items.map((x) => `<span>${esc(x.name)}</span>`).join('')}</div></div>
        <div class="sample-line"><a class="text-btn" href="/files/TRAXO_Bilan_Activite_Exemple.xlsx" download>${ic('download')}Ouvrir un exemple Excel</a><span>Exemple fictif pour découvrir le classeur. Votre fichier, lui, contient vos vraies données.</span></div></div>`;
    }
    function summarySvg(w, items = S.data?.families || [], period = periodLabel()) {
      w = Math.max(220, Math.round(w)); const pad = w < 400 ? 22 : 32; const h = 205 + items.length * 59; const max = Math.max(1, ...items.map((x) => x.count));
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Synthèse des données sélectionnées"><rect width="${w}" height="${h}" fill="#fff"/><rect x="${pad}" y="27" width="27" height="3" rx="1.5" fill="#e81735"/><text x="${pad}" y="59" font-family="Arial,sans-serif" font-size="11" letter-spacing="2" fill="#a94c5a">TRAXO / RAPPORT</text><text x="${pad}" y="94" font-family="Arial,sans-serif" font-size="${w < 300 ? 17 : w < 400 ? 19 : 27}" fill="#283d35">Votre activité en bref.</text><text x="${pad}" y="119" font-family="Arial,sans-serif" font-size="12" fill="#718177">${esc(period)}</text>${items.map((x, i) => `<text x="${pad}" y="${161 + i * 59}" font-family="Arial,sans-serif" font-size="12" fill="#3b574a">${esc(x.name)}</text><text x="${w - pad}" y="${161 + i * 59}" text-anchor="end" font-family="Arial,sans-serif" font-size="13" fill="#3b574a">${x.count}</text><rect x="${pad}" y="${174 + i * 59}" width="${w - pad * 2}" height="8" rx="2" fill="#eef3ef"/><rect x="${pad}" y="${174 + i * 59}" width="${((w - pad * 2) * x.count) / max}" height="8" rx="2" fill="${x.key === 'orders' ? '#e95168' : '#699081'}"/>`).join('')}</svg>`;
    }
    function renderFormats() {
      const el = $('#rpFormats'); if (!el) return;
      const ex = S.excel || {};
      const untilFr = ex.monthUntil ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Africa/Porto-Novo' }).format(new Date(ex.monthUntil)) : '';
      let offer = '';
      if (S.format === 'xlsx') {
        let state;
        const recharge = '<a class="text-btn" href="/app/parametres?section=billing">Recharger mon portefeuille</a>';
        if (!ex.state) state = '<p><strong>L’Excel enrichi est momentanément indisponible.</strong><br>Le CSV et le SVG restent disponibles.</p>';
        else if (ex.state === 'month') state = `<p><strong>Rapports illimités jusqu’au ${esc(untilFr)}.</strong><br>Aucun renouvellement automatique.</p>`;
        else if (ex.state === 'free') state = `<p><strong>${ex.freeLeft} rapport${ex.freeLeft > 1 ? 's' : ''} offert${ex.freeLeft > 1 ? 's' : ''} sur ${ex.freeTotal}.</strong><br>Décompté seulement quand le classeur est produit.</p>`;
        else {
          const why = ex.trialReused ? 'Les rapports offerts ont déjà été utilisés avec cette adresse, ce numéro ou cet appareil.' : `Vos ${ex.freeTotal} rapports offerts sont utilisés.`;
          if (!opts.canPay) state = `<p><strong>${esc(why)}</strong><br>Le propriétaire ou un responsable peut payer un rapport (${money(ex.reportPrice)}) ou le mois illimité (${money(ex.monthPrice)}).</p>`;
          else {
            const low = !ex.canPayReport ? `<p class="error">Solde insuffisant (${money(ex.balance)}). ${recharge}</p>` : '';
            state = `<p><strong>${esc(why)}</strong><br>Ce rapport : ${money(ex.reportPrice)}, débités de votre portefeuille (solde : ${money(ex.balance)}).</p>${low}
              <button type="button" class="trial-btn" data-action="month" ${ex.canPayMonth ? '' : 'disabled'}>Mois illimité : ${money(ex.monthPrice)}</button><p>30 jours de rapports Excel, sans renouvellement automatique.</p>`;
          }
        }
        offer = `<div class="offer"><h3>Ouvrez Excel.<br>Le travail est déjà préparé.</h3><div class="benefits"><span>${ic('check')}Une synthèse prête à lire</span><span>${ic('check')}Des graphiques à personnaliser</span><span>${ic('check')}Des calculs qui suivent vos données</span></div>${state}</div>`;
      }
      const files = S.format === 'csv' ? (S.sources.size > 1 ? `1 ZIP · ${S.sources.size} CSV` : '1 fichier CSV') : S.format === 'svg' ? '1 synthèse SVG' : `1 classeur · ${S.sources.size + 1} onglets`;
      const blocker = !S.sources.size ? 'Sélectionnez des données à exporter.' : (!datesValid() || tooLong()) ? 'Vérifiez les dates de votre sélection.' : S.error ? 'L’aperçu n’a pas pu être calculé.' : (!S.loading && S.data && count() === 0) ? 'Aucune donnée ne correspond à vos filtres.' : '';
      const badge = ex.state === 'month' ? 'Mois actif' : ex.state === 'free' ? `${ex.freeLeft} offert${ex.freeLeft > 1 ? 's' : ''}` : ex.state === 'paid' ? money(ex.reportPrice) : 'Premium';
      el.innerHTML = `<h2>Et pour la suite ?</h2><p>Le bon fichier, selon votre besoin.</p>
        <div class="format-options">${[['csv', 'CSV', 'Données brutes', 'À trier et à réutiliser', 'Gratuit'], ['svg', 'SVG', 'Synthèse visuelle', 'À partager en un regard', 'Gratuit'], ['xlsx', 'XLSX', 'Excel enrichi', 'Graphiques et formules', badge]].map(([k, ext, title, sub, b]) => `<button type="button" class="format" data-format="${k}" aria-pressed="${S.format === k}"><span class="file-type">${ext}</span><span><strong>${title}</strong><small>${sub}</small></span><em>${b}</em></button>`).join('')}</div>
        ${offer}
        <div class="recap"><div><span>Période</span><b>${datesValid() ? esc(periodLabel()) : 'À vérifier'}</b></div><div><span>Contenu</span><b>${count()} lignes · ${S.sources.size} famille${S.sources.size > 1 ? 's' : ''}</b></div><div><span>Vous recevrez</span><b>${files}</b></div></div>
        ${blocker ? `<p class="error" role="alert">${blocker}</p>` : ''}
        <button type="button" class="primary" data-action="generate" ${!valid() || S.busy || (S.format === 'xlsx' && !excelOk()) ? 'disabled' : ''}>${ic('download')}${S.busy ? 'Préparation…' : S.format === 'xlsx' ? (ex.state === 'paid' ? `Payer ${money(ex.reportPrice)} et préparer` : 'Préparer mon classeur') : 'Préparer mon export'}</button>
        <p class="footnote">Toutes les lignes sélectionnées, pas seulement cette page.</p>`;
    }
    async function generate() {
      if (!valid() || (S.format === 'xlsx' && !excelOk())) return;
      S.busy = true; renderFormats();
      try {
        const pay = S.format === 'xlsx' && S.excel?.state === 'paid' ? 'report' : undefined;
        const res = await fetch('/api/app/reports/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...selectionBody(), format: S.format, pay }) });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          if (payload.excel) S.excel = payload.excel;
          throw new Error(payload.error || 'Le fichier n’a pas pu être créé. Réessayez, votre sélection est conservée.');
        }
        const blob = await res.blob();
        const name = ((res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'TRAXO_export';
        S.snapshot = { blob, name, format: S.format, period: periodLabel(), items: S.data.families.map((x) => ({ key: x.key, name: x.name, count: x.count })) };
        S.step = 'ready'; S.busy = false; S.notice = '';
        if (S.format === 'xlsx') api('/api/app/reports/options').then((o) => { S.excel = o.excel; }).catch(() => {});
        full(); window.scrollTo({ top: 0 });
      } catch (error) {
        S.busy = false; S.notice = error.message || 'Le fichier n’a pas pu être créé. Réessayez, votre sélection est conservée.';
        full();
      }
    }
    function download() {
      const sn = S.snapshot; if (!sn) return;
      const u = URL.createObjectURL(sn.blob); const a = document.createElement('a');
      a.href = u; a.download = sn.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 5000);
      const fb = $('#rpFeedback'); if (fb) { fb.hidden = false; fb.textContent = 'Le téléchargement est lancé.'; }
    }
    function ready() {
      const sn = S.snapshot;
      const kind = sn.format === 'xlsx' ? 'EXCEL ENRICHI' : sn.format === 'svg' ? 'SYNTHÈSE VISUELLE' : 'DONNÉES BRUTES';
      root.innerHTML = `<div class="rp-wrap"><section class="success fade-in"><div class="success-head"><div class="success-mark">${ic('check-check')}</div><div class="eyebrow">TOUT EST RASSEMBLÉ</div><h1>Votre export est prêt.</h1><p>Vos données sont regroupées. Vous pouvez les emporter.</p></div>
        <div class="ready-file"><div class="ready-visual"><div style="width:100%">${summarySvg(380, sn.items, sn.period)}</div></div>
          <div class="ready-copy"><div class="eyebrow">${kind}</div><h2>Votre activité,<br>à portée de main.</h2><p>${esc(sn.period)}</p>
            <div class="ready-list">${sn.items.map((x) => `<div><span>${esc(x.name)}</span><span>${x.count} lignes</span></div>`).join('')}</div>
            <button type="button" class="primary" data-action="download">${ic('download')}Télécharger mon fichier</button><p class="footnote">${esc(sn.name)}</p></div></div>
        <div class="thanks">Merci de faire avancer votre activité avec TRAXO.<small>Vos données restent disponibles quand vous en avez besoin.</small><button type="button" data-action="back">Revenir à ma sélection</button></div></section>
        <div id="rpFeedback" role="status" aria-live="polite" hidden></div></div>`;
    }

    // ---- Interactions -----------------------------------------------------
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.source) { const k = b.dataset.source; if (S.sources.has(k)) S.sources.delete(k); else S.sources.add(k); S.page = 1; full(); load(); return; }
      if (b.dataset.format) { S.format = b.dataset.format; S.view = b.dataset.format === 'csv' ? 'data' : 'render'; full(); return; }
      if (b.dataset.period) {
        S.period = b.dataset.period;
        if (S.period === 'week') { S.to = today(); S.from = addDays(S.to, -6); }
        if (S.period === 'month') { S.to = today(); S.from = `${S.to.slice(0, 8)}01`; }
        S.page = 1; full(); load(); return;
      }
      if (b.dataset.tab) { S.active = b.dataset.tab; S.page = 1; renderPreview(); return; }
      if (b.dataset.view) { S.view = b.dataset.view; full(); return; }
      if (b.dataset.page) { S.page = Number(b.dataset.page); renderPreview(); return; }
      switch (b.dataset.action) {
        case 'all': S.sources = allowedKeys.every((k) => S.sources.has(k)) ? new Set() : new Set(allowedKeys); S.page = 1; full(); load(); break;
        case 'reset': S.query = ''; S.zone = 'all'; S.driver = 'all'; S.status = {}; S.period = 'week'; S.to = today(); S.from = addDays(S.to, -6); full(); load(); break;
        case 'retry': load(); break;
        case 'month':
          b.disabled = true;
          try {
            S.excel = await api('/api/app/reports/premium/month', { method: 'POST' });
            S.notice = `Rapports illimités pendant 30 jours. ${money(S.excel.monthPrice)} débités de votre portefeuille.`;
          } catch (error) { S.notice = error.message || 'Achat impossible.'; }
          full(); break;
        case 'generate': generate(); break;
        case 'download': download(); break;
        case 'back': S.step = 'configure'; S.notice = ''; full(); break;
        default: break;
      }
    });
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.filter) { S[t.dataset.filter] = t.value; S.page = 1; refresh(); load(); return; }
      if (t.dataset.status) { S.status[t.dataset.status] = t.value; S.page = 1; load(); return; }
      if (t.dataset.field) {
        const k = S.active; const def = F[k].fields.find((x) => x.key === t.dataset.field);
        if (t.checked) S.fields[k].add(t.dataset.field); else S.fields[k].delete(t.dataset.field);
        if (def?.personal) load(); // colonnes personnelles : envoyées par le serveur seulement si cochées
        renderPreview();
      }
    });
    root.addEventListener('input', (e) => {
      if (!e.target.matches('[data-query]')) return;
      S.query = e.target.value; S.page = 1; load(350);
    });
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const d = root.querySelector('details[open]'); if (d) { d.open = false; d.querySelector('summary')?.focus(); } } });
    document.addEventListener('click', (e) => { const d = root.querySelector('details[open]'); if (d && !d.contains(e.target)) d.open = false; });

    full(); load();
  }
  window.TraxoReports = { render };
})();
