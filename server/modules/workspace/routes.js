// Espace de travail : corbeille réversible et vues enregistrées
// (Opérations et Clients).

module.exports = function registerWorkspace(app, deps) {
  const {
    pool, asyncRoute, requireCompanyApi, requireCompanyRoles, withCompanyTransaction,
    trashPurge, terminalOrderStatuses, CUSTOMER_STAGES,
  } = deps;

  // Rien n'est supprimé : la ligne quitte les listes actives et peut revenir.
  // Seuls les éléments clos peuvent y aller (commande terminée, incident résolu) ;
  // une demande y va par l'archivage existant.
  const OPS_SOURCES = ['commandes', 'demandes', 'incidents'];
  function opsIdList(raw) {
    if (!Array.isArray(raw)) return null;
    const ids = [...new Set(raw.map((v) => String(v)).filter((v) => /^\d{1,18}$/.test(v)))];
    return ids.length && ids.length <= 500 ? ids : null;
  }
  const opsTrashSql = {
    commandes: {
      trash: `UPDATE orders SET archived_at = NOW(), archived_by_user_id = $3, updated_at = NOW()
              WHERE company_id = $1 AND id = ANY($2::bigint[]) AND archived_at IS NULL
                AND status = ANY($4::text[]) RETURNING id`,
      restore: `UPDATE orders SET archived_at = NULL, archived_by_user_id = NULL, updated_at = NOW()
                WHERE company_id = $1 AND id = ANY($2::bigint[]) AND archived_at IS NOT NULL RETURNING id`,
      entity: 'order', refused: 'Seules les commandes livrées, annulées ou retournées peuvent aller dans la corbeille.',
    },
    incidents: {
      trash: `UPDATE delivery_incidents SET archived_at = NOW(), archived_by_user_id = $3, updated_at = NOW()
              WHERE company_id = $1 AND id = ANY($2::bigint[]) AND archived_at IS NULL AND status = 'resolved' RETURNING id`,
      restore: `UPDATE delivery_incidents SET archived_at = NULL, archived_by_user_id = NULL, updated_at = NOW()
                WHERE company_id = $1 AND id = ANY($2::bigint[]) AND archived_at IS NOT NULL RETURNING id`,
      entity: 'incident', refused: 'Seuls les incidents résolus peuvent aller dans la corbeille.',
    },
    demandes: {
      trash: `UPDATE customer_requests SET status_before_archive = status, status = 'Archivée', archived_at = NOW(),
                version = version + 1, updated_at = NOW()
              WHERE company_id = $1 AND id = ANY($2::bigint[]) AND archived_at IS NULL RETURNING id`,
      restore: `UPDATE customer_requests
                SET status = COALESCE(NULLIF(status_before_archive, 'Archivée'),
                      CASE WHEN submitted_at IS NOT NULL THEN 'À vérifier' ELSE 'En attente d’informations' END),
                    status_before_archive = NULL, archived_at = NULL, version = version + 1, updated_at = NOW()
                WHERE company_id = $1 AND id = ANY($2::bigint[]) AND archived_at IS NOT NULL RETURNING id`,
      entity: 'customer_request', refused: 'Cette demande est déjà dans la corbeille.',
    },
  };
  async function opsTrashAction(req, res, mode) {
    const source = String(req.body?.source || '');
    if (!OPS_SOURCES.includes(source)) return res.status(400).json({ error: 'Source inconnue.' });
    const ids = opsIdList(req.body?.ids);
    if (!ids) return res.status(400).json({ error: 'Sélectionnez entre 1 et 500 éléments.' });
    const def = opsTrashSql[source];
    const params = [req.auth.company_id, ids];
    if (mode === 'trash' && source !== 'demandes') params.push(req.auth.user_id || null);
    if (mode === 'trash' && source === 'commandes') params.push(terminalOrderStatuses);
    const result = await pool.query(def[mode], params);
    const done = result.rows.map((r) => String(r.id));
    if (done.length) {
      await pool.query(
        `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
         SELECT $1, $2, $3, x, $4, '{}'::jsonb FROM unnest($5::bigint[]) AS x`,
        [req.auth.company_id, req.auth.user_id || null, def.entity, mode === 'trash' ? 'trashed' : 'restored', done]
      );
    }
    const skipped = ids.filter((id) => !done.includes(id))
      .map((id) => ({ id, reason: mode === 'trash' ? def.refused : 'Élément introuvable dans la corbeille.' }));
    return res.json({ done, skipped });
  }
  app.post('/api/app/ops/trash', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'),
    asyncRoute((req, res) => opsTrashAction(req, res, 'trash')));
  app.post('/api/app/ops/restore', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'),
    asyncRoute((req, res) => opsTrashAction(req, res, 'restore')));
  // Suppression définitive depuis la corbeille : responsables seulement. Les
  // éléments sous gel légal sont refusés ; le reste part avec ses fichiers.
  const TRASH_HELD_REASON = 'Non supprimé : l’élément n’est plus dans la corbeille, ou un gel légal le protège.';
  app.post('/api/app/ops/purge', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
    const source = String(req.body?.source || '');
    if (!OPS_SOURCES.includes(source)) return res.status(400).json({ error: 'Source inconnue.' });
    const ids = opsIdList(req.body?.ids);
    if (!ids) return res.status(400).json({ error: 'Sélectionnez entre 1 et 500 éléments.' });
    const out = await withCompanyTransaction(pool, req.auth.company_id,
      (client) => trashPurge.purgeIds(client, source, req.auth.company_id, ids, { userId: req.auth.user_id || null }));
    return res.json({ done: out.done, skipped: out.held.map((id) => ({ id, reason: TRASH_HELD_REASON })) });
  }));

  // --- Opérations : vues enregistrées --------------------------------------
  // Une vue = une source + des réglages d'affichage (jamais de données). Elle
  // est personnelle, ou partagée avec l'équipe (responsables uniquement).
  const OPS_VIEW_SOURCES = ['commandes', 'demandes', 'tournees', 'incidents', 'clients'];
  const OPS_VIEW_MAX_PER_USER = 30;
  function sanitizeOpsViewConfig(raw) {
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const key = (v) => (typeof v === 'string' && /^[a-z][a-z_]{0,23}$/.test(v) ? v : null);
    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const list = (v, max, fn) => (Array.isArray(v) ? [...new Set(v.map(fn).filter(Boolean))].slice(0, max) : []);
    const out = {
      layout: c.layout === 'cards' ? 'cards' : 'table',
      density: c.density === 'compact' ? 'compact' : 'comfortable',
      pageSize: [5, 10, 20, 50].includes(Number(c.pageSize)) ? Number(c.pageSize) : 10,
      columns: list(c.columns, 20, key),
      pill: key(c.pill) || 'all',
      group: key(c.group),
      sort: c.sort && key(c.sort.key) ? { key: key(c.sort.key), dir: Number(c.sort.dir) < 0 ? -1 : 1 } : null,
      filters: {
        status: list(c.filters?.status, 20, (v) => text(v, 60)),
        zone: list(c.filters?.zone, 20, (v) => text(v, 80)),
        driver: list(c.filters?.driver, 20, (v) => (/^\d{1,18}$/.test(String(v)) ? String(v) : null)),
      },
    };
    return out;
  }
  // Vues du carnet clients : affichage, filtres, tri, colonnes, portée.
  function sanitizeClientsViewConfig(raw) {
    const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const key = (v) => (typeof v === 'string' && /^[a-z][a-z_]{0,23}$/.test(v) ? v : null);
    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const list = (v, max, fn) => (Array.isArray(v) ? [...new Set(v.map(fn).filter(Boolean))].slice(0, max) : []);
    const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
    return {
      layout: oneOf(c.layout, ['list', 'cards', 'stage'], 'list'),
      scope: oneOf(c.scope, ['current', 'archived'], 'current'),
      pageSize: [6, 12, 24].includes(Number(c.pageSize)) ? Number(c.pageSize) : 12,
      q: text(c.q, 120),
      columns: list(c.columns, 12, key),
      sort: oneOf(c.sort, ['recent', 'name', 'orders'], 'recent'),
      filters: {
        stage: list(c.filters?.stage, 4, (v) => (CUSTOMER_STAGES.includes(v) ? v : null)),
        city: list(c.filters?.city, 20, (v) => text(v, 80)),
        type: list(c.filters?.type, 2, (v) => (['person', 'organization'].includes(v) ? v : null)),
        frequency: oneOf(c.filters?.frequency, ['any', 'none', 'occasional', 'recurring'], 'any'),
      },
    };
  }
  function sanitizeViewConfig(source, raw) {
    return source === 'clients' ? sanitizeClientsViewConfig(raw) : sanitizeOpsViewConfig(raw);
  }
  function opsViewOut(row, userId) {
    return { id: String(row.id), source: row.source, name: row.name, config: row.config, shared: row.shared,
      mine: String(row.user_id) === String(userId), updatedAt: row.updated_at };
  }
  function opsViewName(raw) {
    const name = String(raw || '').replace(/\s+/g, ' ').trim();
    return name.length >= 1 && name.length <= 60 ? name : null;
  }
  app.get('/api/app/ops/views', requireCompanyApi, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT * FROM ops_views WHERE company_id = $1 AND (user_id = $2 OR shared)
       ORDER BY shared ASC, created_at ASC LIMIT 200`,
      [req.auth.company_id, req.auth.user_id]
    );
    return res.json(result.rows.map((row) => opsViewOut(row, req.auth.user_id)));
  }));
  app.post('/api/app/ops/views', requireCompanyApi, asyncRoute(async (req, res) => {
    const source = String(req.body?.source || '');
    if (!OPS_VIEW_SOURCES.includes(source)) return res.status(400).json({ error: 'Source inconnue.' });
    const name = opsViewName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Donnez un nom à la vue (60 caractères au plus).' });
    const shared = req.body?.shared === true;
    if (shared && !['owner', 'manager'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Seuls les responsables peuvent partager une vue avec l’équipe.' });
    }
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM ops_views WHERE company_id = $1 AND user_id = $2',
      [req.auth.company_id, req.auth.user_id]);
    if (count.rows[0].n >= OPS_VIEW_MAX_PER_USER) {
      return res.status(409).json({ error: `Vous avez atteint ${OPS_VIEW_MAX_PER_USER} vues. Supprimez-en une pour continuer.` });
    }
    const result = await pool.query(
      `INSERT INTO ops_views (company_id, user_id, source, name, config, shared)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.auth.company_id, req.auth.user_id, source, name, sanitizeViewConfig(source, req.body?.config), shared]
    );
    return res.status(201).json(opsViewOut(result.rows[0], req.auth.user_id));
  }));
  async function loadEditableOpsView(req) {
    if (!/^\d{1,18}$/.test(req.params.id)) return { status: 404 };
    const result = await pool.query('SELECT * FROM ops_views WHERE id = $1 AND company_id = $2', [req.params.id, req.auth.company_id]);
    const view = result.rows[0];
    const mine = view && String(view.user_id) === String(req.auth.user_id);
    if (!view || (!mine && !view.shared)) return { status: 404 };
    if (!mine && !['owner', 'manager'].includes(req.auth.role)) return { status: 403 };
    return { view };
  }
  app.patch('/api/app/ops/views/:id', requireCompanyApi, asyncRoute(async (req, res) => {
    const found = await loadEditableOpsView(req);
    if (found.status === 404) return res.status(404).json({ error: 'Vue introuvable.' });
    if (found.status === 403) return res.status(403).json({ error: 'Seuls les responsables peuvent modifier une vue d’équipe.' });
    const sets = [];
    const values = [];
    if ('name' in (req.body || {})) {
      const name = opsViewName(req.body.name);
      if (!name) return res.status(400).json({ error: 'Donnez un nom à la vue (60 caractères au plus).' });
      values.push(name); sets.push(`name = $${values.length}`);
    }
    if ('config' in (req.body || {})) { values.push(sanitizeViewConfig(found.view.source, req.body.config)); sets.push(`config = $${values.length}`); }
    if ('shared' in (req.body || {})) {
      if (!['owner', 'manager'].includes(req.auth.role)) return res.status(403).json({ error: 'Seuls les responsables peuvent partager une vue avec l’équipe.' });
      values.push(req.body.shared === true); sets.push(`shared = $${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Aucune modification fournie.' });
    values.push(found.view.id, req.auth.company_id);
    const result = await pool.query(
      `UPDATE ops_views SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length - 1} AND company_id = $${values.length} RETURNING *`,
      values
    );
    return res.json(opsViewOut(result.rows[0], req.auth.user_id));
  }));
  app.delete('/api/app/ops/views/:id', requireCompanyApi, asyncRoute(async (req, res) => {
    const found = await loadEditableOpsView(req);
    if (found.status === 404) return res.status(404).json({ error: 'Vue introuvable.' });
    if (found.status === 403) return res.status(403).json({ error: 'Seuls les responsables peuvent supprimer une vue d’équipe.' });
    await pool.query('DELETE FROM ops_views WHERE id = $1 AND company_id = $2', [found.view.id, req.auth.company_id]);
    return res.json({ ok: true });
  }));

  return { TRASH_HELD_REASON };
};
