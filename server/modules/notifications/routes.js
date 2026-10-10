// Notifications : centre de notifications, préférences et récapitulatifs e-mail.

module.exports = function registerNotifications(app, deps) {
  const {
    pool, asyncRoute, requireCompanyApi, writeAudit, support, companySignals, describeDevice,
    parseCookies, digest, emailConfigured, sendTemplatedEmail, emailBaseUrl, renderEmailShell, escHtmlServer,
    publicBaseUrl, companyTimezones, terminalOrderStatuses, DASHBOARD_TZ, billing,
  } = deps;

  // Les notifications sont calculées à partir de l'état métier (demandes, incidents,
  // commandes, tournées) : elles disparaissent quand l'élément est traité. L'état
  // lu / archivé / « plus tard » est propre à chaque utilisateur (notification_states)
  // et ne change jamais l'état métier.
  const NOTIFICATION_CATEGORIES = ['incidents', 'requests', 'deliveries', 'runs', 'clients'];
  const notificationIncidentLabels = {
    client_injoignable: 'Client injoignable', adresse: 'Adresse à préciser', colis: 'Colis endommagé ou manquant',
    paiement: 'Problème de paiement', vehicule: 'Problème de véhicule', gps: 'GPS ou connexion', autre: 'Incident signalé',
  };
  const notifKeyPattern = /^[a-z]+-[0-9a-f-]{1,40}$/;

  function frDateShort(value, timeZone = DASHBOARD_TZ) {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone }).format(new Date(value));
  }

  // Construit la liste des notifications actionnables d'une entreprise.
  async function buildNotificationItems(cid, { currentSessionHash = null, userId = null, role = null } = {}) {
    const [reqs, toAssign, unassigned, incidents, runs, relaunch, delivered, logins] = await Promise.all([
      pool.query(
        `SELECT id, customer_name, created_at, submitted_at FROM customer_requests
         WHERE company_id = $1 AND archived_at IS NULL AND status = 'À vérifier'
         ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 200`,
        [cid]
      ),
      pool.query(
        `SELECT r.id, r.customer_name, r.neighborhood, r.validated_at, r.customer_confirmed_at, (r.location_lat IS NOT NULL) AS has_location
         FROM customer_requests r LEFT JOIN orders o ON o.customer_request_id = r.id
         WHERE r.company_id = $1 AND r.archived_at IS NULL AND r.status = 'Validée' AND o.id IS NULL
         ORDER BY COALESCE(r.customer_confirmed_at, r.validated_at) DESC LIMIT 30`,
        [cid]
      ),
      pool.query(
        `SELECT id, customer_name, reference, created_at FROM orders
         WHERE company_id = $1 AND driver_id IS NULL AND status <> ALL($2::text[])
         ORDER BY created_at DESC LIMIT 30`,
        [cid, terminalOrderStatuses]
      ),
      pool.query(
        `SELECT i.id, i.category, i.created_at, i.description, o.id AS order_id, o.reference, o.customer_name, d.name AS driver_name
         FROM delivery_incidents i
         LEFT JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
         LEFT JOIN drivers d ON d.id = o.driver_id
         WHERE i.company_id = $1 AND i.status = 'open'
         ORDER BY i.created_at DESC LIMIT 30`,
        [cid]
      ),
      pool.query(
        `SELECT r.id, r.name, r.created_at, r.service_date, d.name AS driver_name
         FROM delivery_runs r LEFT JOIN drivers d ON d.id = r.driver_id
         WHERE r.company_id = $1 AND r.status = 'draft'
         ORDER BY r.created_at DESC LIMIT 20`,
        [cid]
      ),
      // Clients « à relancer » : même dérivation d'étape que la liste CRM.
      pool.query(
        `WITH base AS (
           SELECT c.id, c.display_name, c.pipeline_stage, c.created_at,
             (SELECT MAX(o.created_at) FROM orders o WHERE o.company_id = c.company_id AND o.customer_id = c.id) AS last_order_at,
             (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.company_id AND o.customer_id = c.id) AS order_count
           FROM customers c
           WHERE c.company_id = $1 AND c.status NOT IN ('archived', 'merged', 'anonymized')
         ), staged AS (
           SELECT id, display_name, last_order_at,
             COALESCE(NULLIF(pipeline_stage, ''), CASE
               WHEN last_order_at IS NULL AND created_at >= NOW() - INTERVAL '30 days' THEN 'nouveau'
               WHEN last_order_at IS NULL THEN 'inactif'
               WHEN created_at >= NOW() - INTERVAL '21 days' AND order_count <= 2 THEN 'nouveau'
               WHEN last_order_at >= NOW() - INTERVAL '30 days' THEN 'actif'
               WHEN last_order_at >= NOW() - INTERVAL '90 days' THEN 'a_relancer'
               ELSE 'inactif' END) AS stage
           FROM base
         )
         SELECT id, display_name, last_order_at FROM staged
         WHERE stage = 'a_relancer'
         ORDER BY last_order_at ASC NULLS LAST LIMIT 12`,
        [cid]
      ),
      // Livraisons terminées : un récapitulatif par jour (7 derniers jours), pas un message par arrêt.
      pool.query(
        `SELECT to_char((e.created_at AT TIME ZONE '${DASHBOARD_TZ}')::date, 'YYYY-MM-DD') AS day, COUNT(DISTINCT e.order_id)::int AS n, MAX(e.created_at) AS last_at
         FROM order_status_events e
         WHERE e.company_id = $1 AND e.to_status = 'Livrée' AND e.created_at >= NOW() - INTERVAL '7 days'
         GROUP BY 1 ORDER BY 1 DESC`,
        [cid]
      ),
      userId ? pool.query(
        `SELECT token_hash, user_agent, created_at FROM app_sessions
         WHERE user_id = $1 AND expires_at > NOW() AND (created_at >= NOW() - INTERVAL '7 days' OR token_hash = $2)
         ORDER BY created_at DESC LIMIT 40`,
        [userId, currentSessionHash || '']
      ) : Promise.resolve({ rows: [] }),
    ]);
    const items = [];
    if (reqs.rows.length) {
      const n = reqs.rows.length;
      const newest = reqs.rows[0];
      const oldest = reqs.rows[n - 1];
      const range = n > 1 ? `${frDateShort(oldest.submitted_at || oldest.created_at)} – ${frDateShort(newest.submitted_at || newest.created_at)}` : (newest.customer_name || 'Client à préciser');
      items.push({
        id: `requests-${newest.id}`, category: 'requests', type: 'requests', priority: 'action',
        title: n > 1 ? `${n} demandes attendent votre validation` : 'Nouvelle demande à valider',
        summary: n > 1 ? `Formulaires reçus · ${range}` : range,
        meta: n > 1 ? 'Demandes regroupées' : 'Formulaire client',
        detail: n > 1 ? `${n} clients ont rempli leur formulaire. Vérifiez leurs informations, puis validez-les ou affectez un livreur.` : 'Un client a rempli son formulaire. Vérifiez ses informations, puis validez la demande ou affectez un livreur.',
        ref: n > 1 ? `${n} demandes` : `Demande #${newest.id}`,
        at: newest.submitted_at || newest.created_at,
        href: n > 1 ? '/app/operations?vue=demandes' : `/app/operations?vue=demandes&demande=${newest.id}`,
        cta: n > 1 ? 'Examiner les demandes' : 'Voir la demande',
      });
    }
    for (const r of toAssign.rows) {
      const confirmed = Boolean(r.customer_confirmed_at);
      items.push({
        id: `assign-${r.id}`, category: 'deliveries', type: 'assign', priority: 'action',
        title: confirmed ? 'Commande confirmée par le client' : 'Demande validée, livreur à affecter',
        summary: [r.customer_name, r.neighborhood].filter(Boolean).join(' · ') || `Demande #${r.id}`,
        meta: confirmed ? (r.has_location ? 'Position partagée' : 'Position non partagée') : 'Validée',
        detail: confirmed
          ? `Le client a vérifié ses informations${r.has_location ? ' et partagé sa position' : ''}. Affectez un livreur pour lancer la livraison.`
          : 'La demande est validée. Affectez un livreur pour créer la commande.',
        ref: `Demande #${r.id}`,
        at: r.customer_confirmed_at || r.validated_at,
        href: `/app/operations?vue=demandes&demande=${r.id}`,
        cta: 'Affecter un livreur',
      });
    }
    for (const o of unassigned.rows) {
      items.push({
        id: `order-${o.id}`, category: 'deliveries', type: 'assign', priority: 'action',
        title: 'Commande sans livreur', summary: [o.reference, o.customer_name].filter(Boolean).join(' · ') || `Commande n° ${o.id}`,
        meta: 'À affecter', detail: 'Cette commande n’a pas encore de livreur.', ref: o.reference || `Commande n° ${o.id}`,
        at: o.created_at, href: `/app/operations?vue=commandes&commande=${o.id}`, cta: 'Voir la commande',
      });
    }
    for (const i of incidents.rows) {
      items.push({
        id: `incident-${i.id}`, category: 'incidents', type: 'incident', priority: 'action',
        title: notificationIncidentLabels[i.category] || 'Incident signalé',
        summary: [i.reference, i.customer_name].filter(Boolean).join(' · ') || `Incident n° ${i.id}`,
        meta: i.driver_name || '',
        detail: `${i.driver_name ? `${i.driver_name} a signalé` : 'Un incident a été signalé'} sur cette livraison. Consultez la commande pour organiser la suite.`,
        ref: [i.reference, i.customer_name].filter(Boolean).join(' · ') || `Incident n° ${i.id}`,
        at: i.created_at, href: `/app/incidents/${i.id}`, cta: 'Voir l’incident',
      });
    }
    for (const r of runs.rows) {
      items.push({
        id: `run-${r.id}`, category: 'runs', type: 'run', priority: 'action',
        title: 'Une tournée reste à préparer', summary: r.name || `Tournée n° ${r.id}`, meta: r.driver_name || '',
        detail: 'Cette tournée est en préparation : vérifiez l’ordre des arrêts, puis planifiez-la.',
        ref: r.name || `Tournée n° ${r.id}`, at: r.created_at, href: `/app/tournees/${r.id}`, cta: 'Voir la tournée',
      });
    }
    for (const d of delivered.rows) {
      items.push({
        id: `delivered-${d.day}`, category: 'deliveries', type: 'delivered', priority: 'info',
        title: `${d.n} livraison${d.n > 1 ? 's' : ''} terminée${d.n > 1 ? 's' : ''}`,
        summary: `Récapitulatif du ${frDateShort(`${d.day}T12:00:00Z`)}`, meta: 'Information',
        detail: 'Les livraisons remises ce jour-là. Aucune action n’est attendue.',
        ref: `Livraisons du ${frDateShort(`${d.day}T12:00:00Z`)}`, at: d.last_at, href: '/app/operations?vue=commandes', cta: 'Voir les commandes',
      });
    }
    for (const c of relaunch.rows) {
      items.push({
        id: `relaunch-${c.id}`, category: 'clients', type: 'client', priority: 'info',
        title: 'Client à relancer', summary: c.display_name || `Client n° ${c.id}`, meta: 'Sans commande depuis plus de 30 jours',
        detail: 'Ce client n’a pas commandé depuis plus d’un mois. Une relance peut le faire revenir.',
        ref: c.display_name || `Client n° ${c.id}`, at: c.last_order_at || new Date(0).toISOString(), href: `/app/clients/${c.id}`, cta: 'Voir le client',
      });
    }
    // Une alerte par appareil (le plus récent), jamais pour l'appareil utilisé en ce moment.
    const currentDevice = logins.rows.find((s) => currentSessionHash && s.token_hash === currentSessionHash);
    const seenDevices = new Set(currentDevice ? [describeDevice(currentDevice.user_agent)] : []);
    for (const s of logins.rows) {
      if (currentSessionHash && s.token_hash === currentSessionHash) continue;
      const device = describeDevice(s.user_agent);
      if (seenDevices.has(device)) continue;
      seenDevices.add(device);
      items.push({
        id: `login-${s.token_hash.slice(0, 12)}`, category: 'security', type: 'security', priority: 'security',
        title: 'Nouvelle connexion à votre compte', summary: describeDevice(s.user_agent), meta: 'Sécurité',
        detail: 'Un appareil s’est connecté à votre compte. Si ce n’était pas vous, fermez cette session et changez votre mot de passe.',
        ref: describeDevice(s.user_agent), at: s.created_at, href: '/app/parametres?section=security', cta: 'Voir mes sessions',
      });
    }
    // Vigilance : seulement pour ceux qui gèrent les livreurs.
    if (['owner', 'manager'].includes(role)) {
      for (const sig of await companySignals(cid, { days: 30, limit: 20 })) {
        items.push({
          id: `vigil-${sig.id}`, category: 'security', type: 'vigilance', priority: 'security',
          title: sig.title, summary: sig.summary, meta: 'Vigilance', detail: sig.detail,
          ref: sig.summary, at: sig.at, href: sig.href || '/app/livreurs', cta: sig.cta || 'Voir',
        });
      }
    }
    // Facturation : solde sous le seuil d'alerte choisi (propriétaire et responsables).
    if (billing && ['owner', 'manager'].includes(role)) {
      const low = await billing.lowBalanceNotice(cid).catch(() => null);
      if (low) {
        const money = (n) => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('fr-FR')} F`;
        items.push({
          id: `wallet-${low.key}`, category: 'billing', type: 'billing', priority: 'action',
          title: low.balance < 0 ? 'Votre portefeuille est à découvert' : 'Votre solde est bas',
          summary: `Solde : ${money(low.balance)} · alerte sous ${money(low.threshold)}`, meta: 'Facturation',
          detail: 'Rechargez votre portefeuille pour continuer à créer vos commandes sans interruption. Vous pouvez changer ce seuil dans Facturation › Préférences.',
          ref: 'Portefeuille', at: low.at, href: '/app/parametres?section=billing', cta: 'Recharger',
        });
      }
    }
    // Support : une réponse non lue ouvre directement la bonne demande. Même source
    // que la pastille du support : lire la demande retire la notification.
    if (support && userId) {
      for (const u of await support.unreadFor({ company_id: cid, user_id: userId, role }).catch(() => [])) {
        items.push({
          id: `support-${u.id}-${u.message_id}`, category: 'support', type: 'support', priority: 'action',
          title: 'Nouvelle réponse du support', summary: `${u.reference} · ${u.subject}`,
          meta: u.status === 'waiting_customer' ? 'Votre réponse attendue' : u.status === 'resolved' ? 'Résolue' : 'Support TRAXO',
          detail: 'L’équipe TRAXO vous a répondu. Ouvrez la demande pour lire la réponse et continuer l’échange.',
          ref: u.reference, at: u.created_at, href: `/app?support=${u.id}`, cta: 'Lire la réponse',
        });
      }
    }
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return items;
  }

  function defaultNotificationPrefs() {
    return { categories: Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, true])), digest: 'off', digestHour: 8, digestDay: 1, timezone: null };
  }
  async function notificationPrefs(userId, cid) {
    const row = (await pool.query('SELECT categories, digest, digest_hour, digest_day, timezone FROM notification_prefs WHERE user_id = $1 AND company_id = $2', [userId, cid])).rows[0];
    const prefs = defaultNotificationPrefs();
    if (row) {
      for (const c of NOTIFICATION_CATEGORIES) if (typeof row.categories?.[c] === 'boolean') prefs.categories[c] = row.categories[c];
      prefs.digest = row.digest; prefs.digestHour = row.digest_hour; prefs.digestDay = row.digest_day; prefs.timezone = row.timezone;
    }
    return prefs;
  }

  // Éléments + état propre à l'utilisateur, filtrés selon ses préférences
  // (la sécurité reste toujours visible).
  async function userNotifications(auth, currentSessionHash) {
    const [items, prefs, states] = await Promise.all([
      buildNotificationItems(auth.company_id, { currentSessionHash, userId: auth.user_id, role: auth.role }),
      notificationPrefs(auth.user_id, auth.company_id),
      pool.query('SELECT notif_key, read_at, archived_at, later_at FROM notification_states WHERE user_id = $1 AND company_id = $2', [auth.user_id, auth.company_id]),
    ]);
    const byKey = new Map(states.rows.map((r) => [r.notif_key, r]));
    const visible = items.filter((it) => it.category === 'security' || prefs.categories[it.category] !== false).map((it) => {
      const st = byKey.get(it.id) || {};
      return { ...it, read: Boolean(st.read_at), readAt: st.read_at || null, archived: Boolean(st.archived_at), later: Boolean(st.later_at) };
    });
    const active = visible.filter((it) => !it.archived && !it.later);
    const counts = {
      action: active.filter((it) => it.priority !== 'info').length,
      all: active.length,
      unread: active.filter((it) => !it.read).length,
      later: visible.filter((it) => it.later && !it.archived).length,
      archived: visible.filter((it) => it.archived).length,
    };
    return { items: visible, counts, prefs };
  }

  app.get('/api/app/notifications', requireCompanyApi, asyncRoute(async (req, res) => {
    const currentHash = digest(String(parseCookies(req).delivery_session || ''));
    const { items, counts } = await userNotifications(req.auth, currentHash);
    return res.json({ items, counts, generatedAt: new Date().toISOString() });
  }));

  // Lu / non lu / archivé / plus tard : idempotent, par utilisateur.
  app.post('/api/app/notifications/state', requireCompanyApi, asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(String))] : [];
    const action = String(req.body.action || '');
    const columns = { read: ['read_at', true], unread: ['read_at', false], archive: ['archived_at', true], unarchive: ['archived_at', false], later: ['later_at', true], unlater: ['later_at', false] };
    if (!ids.length || ids.length > 300 || ids.some((id) => !notifKeyPattern.test(id)) || !columns[action]) {
      return res.status(400).json({ error: 'Demande invalide.' });
    }
    const [column, on] = columns[action];
    await pool.query(
      `INSERT INTO notification_states (user_id, company_id, notif_key, ${column}, updated_at)
       SELECT $1, $2, k, CASE WHEN $4 THEN NOW() ELSE NULL END, NOW() FROM unnest($3::text[]) AS k
       ON CONFLICT (user_id, company_id, notif_key) DO UPDATE
         SET ${column} = CASE WHEN $4 THEN COALESCE(notification_states.${column}, NOW()) ELSE NULL END,
             updated_at = NOW()`,
      [req.auth.user_id, req.auth.company_id, ids, on]
    );
    // Archiver ou « plus tard » : l'élément est aussi considéré comme lu.
    if (on && (action === 'archive' || action === 'later')) {
      await pool.query(
        `UPDATE notification_states SET read_at = COALESCE(read_at, NOW()) WHERE user_id = $1 AND company_id = $2 AND notif_key = ANY($3::text[])`,
        [req.auth.user_id, req.auth.company_id, ids]
      );
    }
    return res.json({ ok: true, count: ids.length });
  }));

  app.get('/api/app/notifications/preferences', requireCompanyApi, asyncRoute(async (req, res) => {
    const prefs = await notificationPrefs(req.auth.user_id, req.auth.company_id);
    const company = (await pool.query('SELECT timezone FROM companies WHERE id = $1', [req.auth.company_id])).rows[0] || {};
    const user = (await pool.query('SELECT email FROM users WHERE id = $1', [req.auth.user_id])).rows[0] || {};
    return res.json({ ...prefs, timezone: prefs.timezone || company.timezone || DASHBOARD_TZ, timezones: companyTimezones, email: user.email, emailConfigured: emailConfigured() });
  }));

  app.put('/api/app/notifications/preferences', requireCompanyApi, asyncRoute(async (req, res) => {
    const body = req.body || {};
    const categories = {};
    for (const c of NOTIFICATION_CATEGORIES) {
      if (typeof body.categories?.[c] !== 'boolean') return res.status(400).json({ error: 'Préférences invalides.', field: c });
      categories[c] = body.categories[c];
    }
    const digestMode = String(body.digest || 'off');
    const hour = Number(body.digestHour);
    const day = Number(body.digestDay);
    const timezone = String(body.timezone || '');
    if (!['off', 'daily', 'weekly'].includes(digestMode) || !Number.isInteger(hour) || hour < 0 || hour > 23
      || !Number.isInteger(day) || day < 1 || day > 7 || !companyTimezones.includes(timezone)) {
      return res.status(400).json({ error: 'Préférences du récapitulatif invalides.' });
    }
    await pool.query(
      `INSERT INTO notification_prefs (user_id, company_id, categories, digest, digest_hour, digest_day, timezone, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, company_id) DO UPDATE SET categories = EXCLUDED.categories, digest = EXCLUDED.digest,
         digest_hour = EXCLUDED.digest_hour, digest_day = EXCLUDED.digest_day, timezone = EXCLUDED.timezone, updated_at = NOW()`,
      [req.auth.user_id, req.auth.company_id, JSON.stringify(categories), digestMode, hour, day, timezone]
    );
    await writeAudit(req.auth, 'user', req.auth.user_id, 'notification_prefs_changed', { digest: digestMode });
    return res.json({ categories, digest: digestMode, digestHour: hour, digestDay: day, timezone });
  }));

  // Récapitulatif e-mail d'un utilisateur (modèle A7) : éléments autorisés, non
  // lus, non archivés. 15 au plus dans l'e-mail ; le nombre annoncé est le total
  // et le lien général mène au reste. Rien à signaler : pas d'e-mail.
  const DIGEST_TYPE_LABELS = {
    incidents: 'Incident', requests: 'Demande client', deliveries: 'Livraison', runs: 'Tournée', clients: 'Client',
    security: 'Sécurité', billing: 'Facturation', support: 'Support',
  };
  async function buildUserDigest(auth, appBaseUrl = '', mode = null) {
    const { items } = await userNotifications(auth, null);
    const pending = items.filter((it) => !it.read && !it.archived && !it.later && it.priority !== 'info');
    if (!pending.length) return null;
    const baseUrl = String(appBaseUrl || '').replace(/\/+$/, '');
    const emailBase = baseUrl || emailBaseUrl(null);
    const itemPath = (href) => (String(href || '').startsWith('/') ? href : '/app/notifications');
    const shown = pending.slice(0, 15);
    const label = `notification${pending.length > 1 ? 's' : ''}`;
    const digestMode = mode || (await pool.query('SELECT digest FROM notification_prefs WHERE user_id = $1 AND company_id = $2', [auth.user_id, auth.company_id])).rows[0]?.digest;
    const vars = {
      nombre: String(pending.length), libelle_notifications: label,
      periode: digestMode === 'weekly' ? 'cette semaine' : 'aujourd’hui',
      elements: shown.map((it) => ({
        type_libelle: DIGEST_TYPE_LABELS[it.category] || 'Activité',
        titre: String(it.title || '').slice(0, 500), resume: String(it.summary || '').slice(0, 500),
        lien_libelle: it.cta || 'Ouvrir', lien_url: `${emailBase}${itemPath(it.href)}`,
      })),
      url_notifications: `${emailBase}/app/notifications`,
      url_preferences: `${emailBase}/app/notifications?vue=preferences`,
    };
    const legacy = () => {
      const rows = shown.map((it) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border:1px solid #eef1f5;border-radius:12px"><tr><td style="padding:12px 14px">
      <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#111827">${escHtmlServer(it.title)}</div>
      <div style="font-family:Arial,sans-serif;font-size:13px;color:#667085;margin-top:2px">${escHtmlServer(it.summary)}</div>
      ${baseUrl ? `<a href="${escHtmlServer(baseUrl + it.href)}" style="font-family:Arial,sans-serif;font-size:12px;font-weight:700;color:#e11d2a;text-decoration:none">${escHtmlServer(it.cta || 'Ouvrir')} →</a>` : ''}
    </td></tr></table>`).join('');
      const heading = `${pending.length} ${label} à traiter`;
      return {
        subject: `TRAXO — ${heading}`,
        html: renderEmailShell({
          baseUrl,
          heading: `Vous avez ${heading}`,
          introHtml: 'Voici ce qui attend votre attention dans votre espace TRAXO.',
          bodyHtml: rows,
          ctaLabel: baseUrl ? 'Ouvrir le centre de notifications' : undefined,
          ctaUrl: baseUrl ? `${baseUrl}/app/notifications` : undefined,
          footerNote: 'Vous recevez ce récapitulatif parce que vous l’avez activé dans vos préférences de notifications.',
        }),
        text: pending.map((it) => `- ${it.title} : ${it.summary}`).join('\n'),
      };
    };
    return { count: pending.length, vars, legacy };
  }

  app.post('/api/app/notifications/digest', requireCompanyApi, asyncRoute(async (req, res) => {
    const digestMail = await buildUserDigest(req.auth, publicBaseUrl(req));
    if (!digestMail) return res.json({ sent: false, reason: 'nothing_to_send', count: 0, configured: emailConfigured() });
    const result = await sendTemplatedEmail(req.auth.email, 'A7-recapitulatif-notifications', digestMail.vars, digestMail.legacy);
    return res.json({ ...result, count: digestMail.count, configured: emailConfigured(), recipient: req.auth.email });
  }));

  // Envoi planifié des récapitulatifs (quotidien ou hebdomadaire, à l'heure locale choisie).
  function localClock(timeZone, date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(date).map((p) => [p.type, p.value]));
    const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday] || 1;
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
  }
  async function runNotificationDigests() {
    if (!pool || !emailConfigured() || process.env.NOTIFICATION_DIGEST === 'off') return;
    const due = await pool.query(
      `SELECT p.user_id, p.company_id, p.digest, p.digest_hour, p.digest_day, COALESCE(p.timezone, c.timezone, '${DASHBOARD_TZ}') AS tz,
              p.last_digest_at, u.email, u.display_name, m.role
       FROM notification_prefs p
       JOIN users u ON u.id = p.user_id AND COALESCE(u.disabled, FALSE) = FALSE
       JOIN company_memberships m ON m.user_id = p.user_id AND m.company_id = p.company_id AND m.role <> 'driver'
       JOIN companies c ON c.id = p.company_id
       WHERE p.digest IN ('daily', 'weekly')`
    );
    const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    for (const row of due.rows) {
      try {
        const now = localClock(row.tz);
        if (now.hour < row.digest_hour) continue;
        if (row.digest === 'weekly' && now.weekday !== row.digest_day) continue;
        const last = row.last_digest_at ? localClock(row.tz, new Date(row.last_digest_at)).day : null;
        if (last === now.day) continue;
        if (row.digest === 'weekly' && row.last_digest_at && Date.now() - new Date(row.last_digest_at).getTime() < 6 * 24 * 3600 * 1000) continue;
        // Marqué avant l'envoi : un échec ne provoque pas de rafale d'e-mails.
        await pool.query('UPDATE notification_prefs SET last_digest_at = NOW() WHERE user_id = $1 AND company_id = $2', [row.user_id, row.company_id]);
        const mail = await buildUserDigest({ user_id: row.user_id, company_id: row.company_id, role: row.role, email: row.email }, base, row.digest);
        if (mail) await sendTemplatedEmail(row.email, 'A7-recapitulatif-notifications', mail.vars, mail.legacy);
      } catch (error) {
        console.error('Notification digest failed:', error.message);
      }
    }
  }

  return { runNotificationDigests };
};
