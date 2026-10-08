// Support TRAXO : demandes (tickets).
// Une demande = un sujet, une référence TRX-…, un statut, sa propre discussion.
// Reste accessible en mode aperçu et en lecture seule (voir requireCompanyApi).
// Côté client (/api/app/support/*) et côté équipe TRAXO (/api/app/platform/support/*).
const express = require('express');
const { createSupport, SupportError, MAX_FILE_BYTES: SUPPORT_MAX_FILE_BYTES } = require('./service');

module.exports = function registerSupport(app, deps) {
  const {
    pool, asyncRoute, requireCompanyApi, requirePlatformAdminApi, writeAudit,
    sendEmail, renderEmailShell, escHtmlServer, normalizeEmail, publicBaseUrl,
  } = deps;

  function supportRecipient() {
    const configured = String(process.env.SUPPORT_EMAIL || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured)) return configured;
    return String(process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map(normalizeEmail).find(Boolean) || null;
  }
  async function notifySupport(kind, { ticket, message = '', auth = null } = {}) {
    if (!pool || !ticket) return;
    const base = publicBaseUrl(null);
    const company = (await pool.query('SELECT name FROM companies WHERE id = $1', [ticket.company_id])).rows[0] || {};
    const excerpt = String(message || '').slice(0, 1200);
    if (['ticket_created', 'customer_message', 'ticket_reopened'].includes(kind)) {
      const to = supportRecipient();
      if (!to) return;
      const title = { ticket_created: 'Nouvelle demande', customer_message: 'Nouveau message', ticket_reopened: 'Demande rouverte' }[kind];
      const lines = [`${ticket.reference} · ${ticket.subject}`, `Entreprise : ${company.name || '—'} (espace #${ticket.company_id})`, `De : ${auth?.display_name || auth?.email || '—'}`];
      await sendEmail({
        to,
        subject: `[${ticket.reference}] ${title} — ${ticket.subject}`,
        html: renderEmailShell({
          baseUrl: base, heading: `${title} au support`,
          introHtml: lines.map((l) => escHtmlServer(l)).join('<br>'),
          bodyHtml: excerpt ? `<p style="white-space:pre-wrap;margin:0">${escHtmlServer(excerpt)}</p>` : '<p style="margin:0">(pièce jointe seulement)</p>',
          ctaLabel: 'Ouvrir la demande', ctaUrl: base ? `${base}/app/parametres?section=support&demande=${ticket.id}` : undefined,
          footerNote: 'Répondez depuis TRAXO : la réponse par e-mail n’est pas encore rattachée à la demande.',
        }),
        text: [...lines, '', excerpt].join('\n'),
      }).catch((error) => console.error('support email', error.message));
      return;
    }
    // Réponse du support ou changement d'état : prévenir la personne qui a ouvert la demande.
    const owner = ticket.created_by_user_id ? (await pool.query('SELECT email, display_name FROM users WHERE id = $1', [ticket.created_by_user_id])).rows[0] : null;
    if (!owner?.email) return;
    const heading = kind === 'support_reply' ? 'Nouvelle réponse de l’équipe TRAXO'
      : ticket.status === 'resolved' ? 'Votre demande est résolue' : 'Nous attendons votre réponse';
    await sendEmail({
      to: owner.email,
      subject: `[${ticket.reference}] ${heading}`,
      html: renderEmailShell({
        baseUrl: base, heading,
        introHtml: `${escHtmlServer(ticket.reference)} · ${escHtmlServer(ticket.subject)}`,
        bodyHtml: '<p style="margin:0">Ouvrez TRAXO pour lire la réponse et continuer l’échange.</p>',
        ctaLabel: 'Voir ma demande', ctaUrl: base ? `${base}/app?support=${ticket.id}` : undefined,
        footerNote: 'Pour la sécurité de vos échanges, la réponse complète est consultable uniquement dans TRAXO.',
      }),
      text: `${heading}\n${ticket.reference} · ${ticket.subject}\n${base ? `${base}/app?support=${ticket.id}` : ''}`,
    }).catch((error) => console.error('support email', error.message));
  }
  const support = pool ? createSupport({ pool, notify: notifySupport }) : null;
  const supportRaw = express.raw({ type: () => true, limit: SUPPORT_MAX_FILE_BYTES + 1024 });
  function supportRoute(handler) {
    return asyncRoute(async (req, res) => {
      if (!support) return res.status(503).json({ error: 'Le support est momentanément indisponible.' });
      try { return await handler(req, res); } catch (error) {
        if (error instanceof SupportError) return res.status(error.status).json({ error: error.message, code: error.code });
        if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Ce fichier dépasse 10 Mo.' });
        throw error;
      }
    });
  }
  function sendSupportFile(res, f, download) {
    const inline = !download && ['image', 'audio'].includes(f.kind);
    res.set({
      'Content-Type': f.mime, 'Content-Length': String(f.size_bytes), 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,
    });
    return res.end(f.data);
  }
  app.get('/api/app/support/tickets', requireCompanyApi, supportRoute(async (req, res) => {
    res.json(await support.listTickets(req.auth, { tab: String(req.query.tab || 'open'), before: req.query.before || null }));
  }));
  app.post('/api/app/support/tickets', requireCompanyApi, supportRoute(async (req, res) => {
    const out = await support.createTicket(req.auth, req.body || {});
    if (!out.replayed) await writeAudit(req.auth, 'support_ticket', out.ticket.id, 'support_ticket_created', { reference: out.ticket.reference });
    res.status(out.replayed ? 200 : 201).json(out);
  }));
  app.get('/api/app/support/tickets/:id', requireCompanyApi, supportRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await support.getTicket(req.auth, req.params.id));
  }));
  app.post('/api/app/support/tickets/:id/messages', requireCompanyApi, supportRoute(async (req, res) => {
    const out = await support.postCustomerMessage(req.auth, req.params.id, req.body || {});
    res.status(out.replayed ? 200 : 201).json(out);
  }));
  app.post('/api/app/support/tickets/:id/read', requireCompanyApi, supportRoute(async (req, res) => {
    res.json(await support.readTicket(req.auth, req.params.id, req.body?.messageId));
  }));
  app.post('/api/app/support/tickets/:id/reopen', requireCompanyApi, supportRoute(async (req, res) => {
    const out = await support.reopen(req.auth, req.params.id);
    if (out.changed) await writeAudit(req.auth, 'support_ticket', out.ticket.id, 'support_ticket_reopened', {});
    res.json(out);
  }));
  app.post('/api/app/support/uploads', requireCompanyApi, supportRaw, supportRoute(async (req, res) => {
    res.status(201).json(await support.stageUpload(req.auth, req.body, String(req.query.name || '')));
  }));
  app.delete('/api/app/support/uploads/:id', requireCompanyApi, supportRoute(async (req, res) => {
    res.json(await support.discardUpload(req.auth, req.params.id));
  }));
  app.get('/api/app/support/files/:id', requireCompanyApi, supportRoute(async (req, res) => {
    sendSupportFile(res, await support.fileFor(req.auth, req.params.id), req.query.download === '1');
  }));
  app.get('/api/app/support/summary', requireCompanyApi, supportRoute(async (req, res) => {
    const unread = await support.unreadFor(req.auth);
    const configured = String(process.env.SUPPORT_EMAIL || '').trim();
    res.set('Cache-Control', 'no-store');
    res.json({ unread: unread.length, unreadTicketIds: unread.map((u) => String(u.id)), supportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured) ? configured : 'support@gettraxo.app' });
  }));
  // Côté équipe TRAXO (administrateur plateforme)
  app.get('/api/app/platform/support/tickets', requirePlatformAdminApi, supportRoute(async (req, res) => {
    res.json(await support.adminList({ status: String(req.query.status || 'open'), q: req.query.q }));
  }));
  app.get('/api/app/platform/support/tickets/:id', requirePlatformAdminApi, supportRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await support.adminTicket(req.params.id));
  }));
  app.post('/api/app/platform/support/tickets/:id/messages', requirePlatformAdminApi, supportRoute(async (req, res) => {
    const out = await support.adminReply(req.auth, req.params.id, req.body || {});
    res.status(out.replayed ? 200 : 201).json(out);
  }));
  app.post('/api/app/platform/support/tickets/:id/status', requirePlatformAdminApi, supportRoute(async (req, res) => {
    const out = await support.adminSetStatus(req.auth, req.params.id, String(req.body?.status || ''));
    if (out.changed) await writeAudit(req.auth, 'support_ticket', out.ticket.id, 'support_status_changed', { status: out.ticket.status });
    res.json(out);
  }));
  app.post('/api/app/platform/support/tickets/:id/assign', requirePlatformAdminApi, supportRoute(async (req, res) => {
    res.json(await support.adminAssign(req.params.id, req.body?.assignee));
  }));
  app.post('/api/app/platform/support/uploads', requirePlatformAdminApi, supportRaw, supportRoute(async (req, res) => {
    res.status(201).json(await support.stageUpload(req.auth, req.body, String(req.query.name || ''), { support: true }));
  }));
  app.get('/api/app/platform/support/files/:id', requirePlatformAdminApi, supportRoute(async (req, res) => {
    sendSupportFile(res, await support.fileFor(req.auth, req.params.id, { support: true }), req.query.download === '1');
  }));

  return { support };
};
