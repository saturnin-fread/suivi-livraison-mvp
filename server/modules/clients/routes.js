// Carnet clients (CRM) : liste, fiche, contacts, lieux, notes, doublons et
// fusion, actions groupées, corbeille et export CSV. Les tables CRM sont
// protégées par la RLS (withCompanyTransaction).
const crypto = require('crypto');
const { neutralizeSpreadsheetText } = require('../../../lib/crm-export-contract');

module.exports = function registerClients(app, deps) {
  const {
    pool, asyncRoute, requireCompanyApi, requireCompanyRoles, withCompanyTransaction,
    writeAudit, runQueries, digest, trashPurge, normalizeCustomerPhone, buildExportCsv,
    CUSTOMER_STAGES, CUSTOMER_CHANNELS, TRASH_HELD_REASON,
  } = deps;

  app.get('/api/app/crm/customers', requireCompanyApi, asyncRoute(async (req, res) => {
    const pageNumber = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    // all=1 : le carnet complet (jusqu'à 2 000 fiches) pour filtrer, trier et
    // regrouper dans la page Clients ; sinon pagination serveur (Rapports…).
    const allMode = req.query.all === '1';
    const limit = allMode ? 2000 : Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const query = String(req.query.q || '').trim().slice(0, 120);
    const allowedStatuses = ['active', 'do_not_contact', 'archived', 'merged', 'anonymized'];
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'État client invalide.' });
    }
    const allowedStages = ['nouveau', 'actif', 'a_relancer', 'inactif'];
    const stage = req.query.stage && allowedStages.includes(String(req.query.stage)) ? String(req.query.stage) : null;
    const sortMap = {
      recent: 'last_activity_at DESC NULLS LAST, updated_at DESC, id DESC',
      oldest: 'last_activity_at ASC NULLS FIRST, id ASC',
      name: 'display_name ASC, id ASC',
      orders: 'order_count DESC, id DESC',
    };
    const sort = sortMap[String(req.query.sort)] ? String(req.query.sort) : 'recent';
    // removed=1 : la corbeille du carnet (fiches supprimées), réservée aux responsables.
    const removed = req.query.removed === '1';
    if (removed && !['owner', 'manager'].includes(req.auth.role)) return res.status(403).json({ error: 'Seuls les responsables voient la corbeille du carnet.' });

    const result = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
      const values = [req.auth.company_id, query ? `%${query}%` : null, removed ? null : status];
      const filters = `c.company_id = $1
        AND ($2::text IS NULL OR c.display_name ILIKE $2 OR EXISTS (
          SELECT 1 FROM customer_contacts search_contact
          WHERE search_contact.company_id = c.company_id
            AND search_contact.customer_id = c.id
            AND search_contact.is_active = TRUE
            AND search_contact.value_display ILIKE $2
        ))
        AND ($3::text IS NULL OR c.status = $3)
        ${removed ? `AND c.removed_at IS NOT NULL AND c.status NOT IN ('merged', 'anonymized')` : `AND c.removed_at IS NULL
        -- Par défaut on masque les fiches archivées/fusionnées/anonymisées ;
        -- elles restent accessibles via un filtre de statut explicite.
        AND ($3::text IS NOT NULL OR c.status NOT IN ('archived', 'merged', 'anonymized'))`}`;
      // Stade d'engagement dérivé (Nouveau / Actif / À relancer / Inactif) à partir de
      // l'ancienneté de la dernière commande, de la date de création et du nombre de
      // commandes — distinct de c.status (actif/ne pas contacter/archivé).
      const baseCte = `
        WITH base AS (
          SELECT c.id, c.customer_code, c.customer_type, c.sector, c.pipeline_stage,
                 c.display_name, c.status, c.created_at, c.updated_at, c.main_city, c.removed_at,
                 primary_contact.value_display AS primary_phone,
                 primary_email.value_display AS primary_email,
                 tag_list.names AS tags, loc_text.search AS location_search,
                 COUNT(DISTINCT o.id) FILTER (WHERE o.status NOT IN ('Livrée', 'Annulée', 'Retournée'))::int AS active_order_count,
                 loc.locality AS primary_locality, loc.neighborhood AS primary_neighborhood,
                 lastord.status AS last_order_status, lastord.created_at AS last_order_at,
                 COUNT(DISTINCT o.id)::int AS order_count,
                 COUNT(DISTINCT l.id) FILTER (WHERE l.is_active = TRUE)::int AS location_count,
                 COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'open')::int AS open_incident_count
          FROM customers c
          LEFT JOIN LATERAL (
            SELECT cc.value_display FROM customer_contacts cc
            WHERE cc.company_id = c.company_id AND cc.customer_id = c.id
              AND cc.kind = 'phone' AND cc.is_active = TRUE
            ORDER BY cc.is_primary DESC, cc.id ASC LIMIT 1
          ) primary_contact ON TRUE
          LEFT JOIN LATERAL (
            SELECT ce.value_display FROM customer_contacts ce
            WHERE ce.company_id = c.company_id AND ce.customer_id = c.id
              AND ce.kind = 'email' AND ce.is_active = TRUE
            ORDER BY ce.is_primary DESC, ce.id ASC LIMIT 1
          ) primary_email ON TRUE
          LEFT JOIN LATERAL (
            SELECT array_agg(t.name ORDER BY t.name) AS names FROM customer_tags ct
            JOIN crm_tags t ON t.company_id = ct.company_id AND t.id = ct.tag_id AND t.archived_at IS NULL
            WHERE ct.company_id = c.company_id AND ct.customer_id = c.id
          ) tag_list ON TRUE
          LEFT JOIN LATERAL (
            SELECT string_agg(concat_ws(' ', cl2.label, cl2.neighborhood, cl2.locality, cl2.address_text, cl2.landmark), ' ') AS search
            FROM customer_locations cl2
            WHERE cl2.company_id = c.company_id AND cl2.customer_id = c.id AND cl2.is_active = TRUE
          ) loc_text ON TRUE
          LEFT JOIN LATERAL (
            SELECT cl.locality, cl.neighborhood FROM customer_locations cl
            WHERE cl.company_id = c.company_id AND cl.customer_id = c.id AND cl.is_active = TRUE
            ORDER BY cl.last_used_at DESC NULLS LAST, cl.id DESC LIMIT 1
          ) loc ON TRUE
          LEFT JOIN LATERAL (
            SELECT o2.status, o2.created_at FROM orders o2
            WHERE o2.company_id = c.company_id AND o2.customer_id = c.id
            ORDER BY o2.created_at DESC LIMIT 1
          ) lastord ON TRUE
          LEFT JOIN orders o ON o.company_id = c.company_id AND o.customer_id = c.id
          LEFT JOIN customer_locations l ON l.company_id = c.company_id AND l.customer_id = c.id
          LEFT JOIN delivery_incidents i ON i.company_id = c.company_id AND i.order_id = o.id
          WHERE ${filters}
          GROUP BY c.id, primary_contact.value_display, primary_email.value_display, tag_list.names, loc_text.search,
                   loc.locality, loc.neighborhood, lastord.status, lastord.created_at
        ),
        auto AS (
          SELECT *,
            COALESCE(last_order_at, created_at) AS last_activity_at,
            CASE
              WHEN last_order_at IS NULL AND created_at >= NOW() - INTERVAL '30 days' THEN 'nouveau'
              WHEN last_order_at IS NULL THEN 'inactif'
              WHEN created_at >= NOW() - INTERVAL '21 days' AND order_count <= 2 THEN 'nouveau'
              WHEN last_order_at >= NOW() - INTERVAL '30 days' THEN 'actif'
              WHEN last_order_at >= NOW() - INTERVAL '90 days' THEN 'a_relancer'
              ELSE 'inactif'
            END AS auto_stage
          FROM base
        ),
        staged AS (
          SELECT *,
            -- Surcharge manuelle (glisser-déposer) prioritaire sur le stade auto.
            COALESCE(NULLIF(pipeline_stage, ''), auto_stage) AS stage,
            CASE WHEN NULLIF(pipeline_stage, '') IS NOT NULL THEN 'manual' ELSE 'auto' END AS stage_source
          FROM auto
        )`;
      const stageFilter = stage ? ` WHERE stage = $${values.length + 1}` : '';
      const scopedValues = stage ? [...values, stage] : values;
      const listValues = [...scopedValues, limit, (pageNumber - 1) * limit];
      const [countResult, rowsResult, stageCountsResult] = await runQueries(client, [
        () => client.query(`${baseCte} SELECT COUNT(*)::int AS total FROM staged${stageFilter}`, scopedValues),
        () => client.query(`${baseCte} SELECT * FROM staged${stageFilter} ORDER BY ${sortMap[sort]} LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues),
        () => client.query(`${baseCte} SELECT stage, COUNT(*)::int AS total FROM staged GROUP BY stage`, values),
      ]);
      const stageCounts = { nouveau: 0, actif: 0, a_relancer: 0, inactif: 0 };
      for (const row of stageCountsResult.rows) if (row.stage in stageCounts) stageCounts[row.stage] = row.total;
      return { total: countResult.rows[0].total, customers: rowsResult.rows, stageCounts };
    });
    const totalPages = Math.max(1, Math.ceil(result.total / limit));
    return res.json({
      customers: result.customers,
      stageCounts: result.stageCounts,
      pagination: {
        page: pageNumber,
        limit,
        total: result.total,
        totalPages,
        hasPrevious: pageNumber > 1,
        hasNext: pageNumber < totalPages,
        sort,
        stage,
      },
    });
  }));

  // --- Carnet clients -----------------------------------------------------
  // Téléphone comparé sur ses 8 derniers chiffres : le même numéro saisi avec ou
  // sans +229 est reconnu. Un doublon bloque l'enregistrement, sauf si l'équipe
  // confirme que le numéro est partagé (allowDuplicate) : rien n'est fusionné.
  const phoneKey = (value) => String(value || '').replace(/\D/g, '').slice(-8);
  async function findPhoneDuplicate(client, companyId, phone, exceptId = null) {
    const key = phoneKey(phone);
    if (key.length < 8) return null;
    const found = await client.query(
      `SELECT c.id, c.customer_code, c.display_name, c.status FROM customers c
       JOIN customer_contacts cc ON cc.company_id = c.company_id AND cc.customer_id = c.id
         AND cc.kind = 'phone' AND cc.is_active = TRUE
       WHERE c.company_id = $1 AND c.removed_at IS NULL AND c.status NOT IN ('merged', 'anonymized')
         AND ($3::bigint IS NULL OR c.id <> $3)
         AND right(regexp_replace(COALESCE(cc.value_normalized, cc.value_display), '[^0-9]', '', 'g'), 8) = $2
       ORDER BY c.id LIMIT 1`,
      [companyId, key, exceptId]
    );
    return found.rows[0] || null;
  }
  function duplicateError(dup) {
    return Object.assign(new Error(`Ce numéro appartient déjà à ${dup.display_name} (${dup.customer_code}${dup.status === 'archived' ? ', archivé' : ''}).`), {
      statusCode: 409, payload: { code: 'DUPLICATE_PHONE', duplicate: { id: String(dup.id), code: dup.customer_code, name: dup.display_name, archived: dup.status === 'archived' } },
    });
  }
  function parsePhoneInput(raw, country) {
    const text = String(raw || '').trim();
    if (!text) return { value: null };
    const parsed = normalizeCustomerPhone({ customerPhone: text, customerPhoneCountry: country || 'BJ' });
    if (!parsed) return { error: 'Ce numéro de téléphone semble incorrect (ex. : 01 97 12 34 56).' };
    return { value: parsed };
  }
  async function upsertPrimaryContact(client, auth, customerId, kind, value) {
    const existing = await client.query(
      `SELECT id FROM customer_contacts WHERE company_id = $1 AND customer_id = $2 AND kind = $3 AND is_active = TRUE
       ORDER BY is_primary DESC, id ASC LIMIT 1`,
      [auth.company_id, customerId, kind]
    );
    if (!value) {
      if (existing.rows[0]) await client.query('UPDATE customer_contacts SET is_active = FALSE, is_primary = FALSE, updated_at = NOW() WHERE id = $1 AND company_id = $2', [existing.rows[0].id, auth.company_id]);
      return;
    }
    const normalized = kind === 'phone' ? value.replace(/[^\d+]/g, '') : value.toLowerCase();
    if (existing.rows[0]) {
      await client.query(
        `UPDATE customer_contacts SET value_display = $1, value_normalized = $2, is_primary = TRUE,
           updated_by_user_id = $3, updated_at = NOW(), version = version + 1 WHERE id = $4 AND company_id = $5`,
        [value, normalized, auth.user_id || null, existing.rows[0].id, auth.company_id]
      );
    } else {
      await client.query(
        `INSERT INTO customer_contacts (company_id, customer_id, kind, value_display, value_normalized, is_primary, created_by_user_id, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $6)`,
        [auth.company_id, customerId, kind, value, normalized, auth.user_id || null]
      );
    }
  }
  async function setCustomerTags(client, auth, customerId, names) {
    const clean = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
    await client.query('DELETE FROM customer_tags WHERE company_id = $1 AND customer_id = $2', [auth.company_id, customerId]);
    for (const name of clean) {
      const tag = await client.query(
        `SELECT id FROM crm_tags WHERE company_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL ORDER BY id LIMIT 1`,
        [auth.company_id, name]
      );
      const tagId = tag.rows[0]?.id || (await client.query(
        `INSERT INTO crm_tags (company_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [auth.company_id, name, auth.user_id || null]
      )).rows[0].id;
      await client.query(
        `INSERT INTO customer_tags (company_id, customer_id, tag_id, assigned_by_user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [auth.company_id, customerId, tagId, auth.user_id || null]
      );
    }
  }
  const textField = (value, max) => {
    const t = String(value ?? '').replace(/\s+$/g, '').trim();
    return t ? t.slice(0, max) : null;
  };

  // Création manuelle d'un client (bouton « Nouveau client ») : le nom suffit.
  app.post('/api/app/crm/customers', requireCompanyApi, asyncRoute(async (req, res) => {
    const b = req.body || {};
    const displayName = String(b.displayName ?? b.display_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!displayName) return res.status(400).json({ error: 'Le nom du client est requis.', field: 'displayName' });
    const phone = parsePhoneInput(b.phone, b.phoneCountry);
    if (phone.error) return res.status(400).json({ error: phone.error, field: 'phone' });
    const email = textField(b.email, 200);
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Cette adresse e-mail semble incorrecte.', field: 'email' });
    const customerType = b.customerType === 'organization' ? 'organization' : 'person';
    const stage = CUSTOMER_STAGES.includes(b.stage) ? b.stage : null;
    const channel = CUSTOMER_CHANNELS.includes(b.preferredChannel) ? b.preferredChannel : null;
    const language = textField(b.preferredLanguage, 35);
    if (language && language.length < 2) return res.status(400).json({ error: 'Langue : 2 à 35 caractères.', field: 'preferredLanguage' });
    try {
      const created = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
        if (phone.value && b.allowDuplicate !== true) {
          const dup = await findPhoneDuplicate(client, req.auth.company_id, phone.value);
          if (dup) throw duplicateError(dup);
        }
        const inserted = await client.query(
          `INSERT INTO customers (company_id, customer_code, customer_type, sector, display_name, status, pipeline_stage,
             preferred_language, preferred_channel, main_city, driver_instructions,
             created_by_user_id, updated_by_user_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $11, NOW(), NOW())
           RETURNING id`,
          [req.auth.company_id, `MANUAL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, customerType,
            textField(b.sector ?? b.customer_type, 120), displayName, stage, language, channel,
            textField(b.city, 120), textField(b.driverInstructions, 1000), req.auth.user_id || null]
        );
        const id = inserted.rows[0].id;
        await client.query(`UPDATE customers SET customer_code = $1 WHERE id = $2 AND company_id = $3`, [`CL-${String(id).padStart(4, '0')}`, id, req.auth.company_id]);
        if (phone.value) await upsertPrimaryContact(client, req.auth, id, 'phone', phone.value);
        if (email) await upsertPrimaryContact(client, req.auth, id, 'email', email);
        if (Array.isArray(b.tags)) await setCustomerTags(client, req.auth, id, b.tags);
        return id;
      });
      await writeAudit(req.auth, 'customer', created, 'created', {});
      return res.status(201).json({ id: created, customer_code: `CL-${String(created).padStart(4, '0')}` });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...(error.payload || {}) });
      throw error;
    }
  }));

  // Mise à jour légère d'un client : stade de pipeline (glisser-déposer) et/ou
  // statut (archivage). pipelineStage = null réinitialise en mode auto.
  app.patch('/api/app/crm/customers/:id', requireCompanyApi, asyncRoute(async (req, res) => {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId < 1) return res.status(404).json({ error: 'Client introuvable.' });
    const sets = [];
    const values = [];
    if ('pipelineStage' in (req.body || {})) {
      const raw = req.body.pipelineStage;
      if (raw === null || raw === '') {
        sets.push(`pipeline_stage = NULL`);
      } else if (['nouveau', 'actif', 'a_relancer', 'inactif'].includes(String(raw))) {
        values.push(String(raw));
        sets.push(`pipeline_stage = $${values.length}`);
      } else {
        return res.status(400).json({ error: 'Étape commerciale inconnue.' });
      }
    }
    if ('status' in (req.body || {})) {
      const status = String(req.body.status);
      if (!['active', 'archived', 'do_not_contact'].includes(status)) {
        return res.status(400).json({ error: 'Statut client invalide.' });
      }
      values.push(status);
      sets.push(`status = $${values.length}`);
      sets.push(status === 'archived' ? 'archived_at = COALESCE(archived_at, NOW())' : 'archived_at = NULL');
    }
    if ('customerType' in (req.body || {})) {
      values.push(req.body.customerType === 'organization' ? 'organization' : 'person');
      sets.push(`customer_type = $${values.length}`);
    }
    if ('mainCity' in (req.body || {})) {
      values.push(textField(req.body.mainCity, 120));
      sets.push(`main_city = $${values.length}`);
    }
    if ('driverInstructions' in (req.body || {})) {
      const text = textField(req.body.driverInstructions, 1000);
      values.push(text);
      sets.push(`driver_instructions = $${values.length}`);
    }
    if ('defaultLocationId' in (req.body || {})) {
      const locId = req.body.defaultLocationId ? String(req.body.defaultLocationId) : null;
      if (locId && !/^\d{1,18}$/.test(locId)) return res.status(400).json({ error: 'Lieu introuvable.' });
      values.push(locId);
      sets.push(`default_location_id = (SELECT l.id FROM customer_locations l WHERE l.id = $${values.length}::bigint AND l.company_id = customers.company_id AND l.customer_id = customers.id)`);
    }
    // Coordonnées et étiquettes : tables liées, traitées dans la même transaction.
    const contactChanges = {};
    if ('phone' in (req.body || {})) {
      const phone = parsePhoneInput(req.body.phone, req.body.phoneCountry);
      if (phone.error) return res.status(400).json({ error: phone.error, field: 'phone' });
      contactChanges.phone = phone.value;
    }
    if ('email' in (req.body || {})) {
      const email = textField(req.body.email, 200);
      if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Cette adresse e-mail semble incorrecte.', field: 'email' });
      contactChanges.email = email;
    }
    const tagChange = Array.isArray(req.body?.tags) ? req.body.tags : null;
    if (!sets.length && (Object.keys(contactChanges).length || tagChange)) sets.push('display_name = display_name');
    if ('displayName' in (req.body || {})) {
      const name = String(req.body.displayName || '').trim();
      if (name.length < 1 || name.length > 160) return res.status(400).json({ error: 'Le nom doit contenir entre 1 et 160 caractères.' });
      values.push(name);
      sets.push(`display_name = $${values.length}`);
    }
    if ('sector' in (req.body || {})) {
      const sector = String(req.body.sector || '').trim();
      if (sector.length > 120) return res.status(400).json({ error: 'Secteur trop long (120 caractères max).' });
      values.push(sector || null);
      sets.push(`sector = $${values.length}`);
    }
    if ('preferredChannel' in (req.body || {})) {
      const channel = req.body.preferredChannel;
      if (channel !== null && channel !== '' && !['call', 'whatsapp', 'sms', 'email'].includes(String(channel))) {
        return res.status(400).json({ error: 'Canal de contact inconnu.' });
      }
      values.push(channel ? String(channel) : null);
      sets.push(`preferred_channel = $${values.length}`);
    }
    if ('preferredLanguage' in (req.body || {})) {
      const language = String(req.body.preferredLanguage || '').trim();
      if (language && (language.length < 2 || language.length > 35)) return res.status(400).json({ error: 'Langue : 2 à 35 caractères.' });
      values.push(language || null);
      sets.push(`preferred_language = $${values.length}`);
    }
    if ('serviceNotes' in (req.body || {})) {
      const notes = String(req.body.serviceNotes || '').trim();
      if (notes.length > 2000) return res.status(400).json({ error: 'Notes trop longues (2000 caractères max).' });
      values.push(notes || null);
      sets.push(`service_notes = $${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Aucune modification fournie.' });
    values.push(req.auth.user_id || null);
    const updatedBy = `$${values.length}`;
    values.push(customerId);
    const idParam = `$${values.length}`;
    values.push(req.auth.company_id);
    const companyParam = `$${values.length}`;
    let result;
    try {
      result = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
        if (contactChanges.phone && req.body.allowDuplicate !== true) {
          const dup = await findPhoneDuplicate(client, req.auth.company_id, contactChanges.phone, customerId);
          if (dup) throw duplicateError(dup);
        }
        const updated = await client.query(
          `UPDATE customers SET ${sets.join(', ')}, updated_by_user_id = ${updatedBy}, updated_at = NOW(), version = version + 1
           WHERE id = ${idParam} AND company_id = ${companyParam} AND removed_at IS NULL RETURNING id`,
          values
        );
        if (!updated.rows[0]) return updated;
        if ('phone' in contactChanges) await upsertPrimaryContact(client, req.auth, customerId, 'phone', contactChanges.phone);
        if ('email' in contactChanges) await upsertPrimaryContact(client, req.auth, customerId, 'email', contactChanges.email);
        if (tagChange) await setCustomerTags(client, req.auth, customerId, tagChange);
        return updated;
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...(error.payload || {}) });
      throw error;
    }
    if (!result.rows[0]) return res.status(404).json({ error: 'Client introuvable.' });
    const changed = Object.keys(req.body || {}).filter((k) => !['phoneCountry', 'allowDuplicate'].includes(k));
    await writeAudit(req.auth, 'customer', customerId, 'updated', { fields: changed });
    return res.json({ id: result.rows[0].id });
  }));

  // Actions groupées du carnet : étape, archivage, restauration, suppression
  // (retrait logique réversible : la fiche quitte toutes les vues, ses
  // commandes et son historique restent).
  app.post('/api/app/crm/customers/bulk', requireCompanyApi, requireCompanyRoles('owner', 'manager', 'operator'), asyncRoute(async (req, res) => {
    const action = String(req.body?.action || '');
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((v) => /^\d{1,18}$/.test(v)))];
    if (!ids.length || ids.length > 1000) return res.status(400).json({ error: 'Sélectionnez entre 1 et 1 000 fiches.' });
    if (['remove', 'unremove'].includes(action) && !['owner', 'manager'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Seuls les responsables peuvent supprimer une fiche client.' });
    }
    const sql = {
      stage: `UPDATE customers SET pipeline_stage = $3, updated_at = NOW(), version = version + 1
              WHERE company_id = $1 AND id = ANY($2::bigint[]) AND removed_at IS NULL AND status NOT IN ('merged', 'anonymized') RETURNING id`,
      archive: `UPDATE customers SET status = 'archived', archived_at = NOW(), updated_at = NOW(), version = version + 1
                WHERE company_id = $1 AND id = ANY($2::bigint[]) AND removed_at IS NULL AND status IN ('active', 'do_not_contact') RETURNING id`,
      restore: `UPDATE customers SET status = 'active', archived_at = NULL, updated_at = NOW(), version = version + 1
                WHERE company_id = $1 AND id = ANY($2::bigint[]) AND removed_at IS NULL AND status = 'archived' RETURNING id`,
      remove: `UPDATE customers SET removed_at = NOW(), removed_by_user_id = $3, updated_at = NOW()
               WHERE company_id = $1 AND id = ANY($2::bigint[]) AND removed_at IS NULL AND status NOT IN ('merged', 'anonymized') RETURNING id`,
      unremove: `UPDATE customers SET removed_at = NULL, removed_by_user_id = NULL, updated_at = NOW()
                 WHERE company_id = $1 AND id = ANY($2::bigint[]) AND removed_at IS NOT NULL RETURNING id`,
    }[action];
    if (!sql) return res.status(400).json({ error: 'Action inconnue.' });
    const params = [req.auth.company_id, ids];
    if (action === 'stage') {
      const stage = req.body.stage;
      if (stage !== null && !CUSTOMER_STAGES.includes(stage)) return res.status(400).json({ error: 'Étape inconnue.' });
      params.push(stage);
    }
    if (action === 'remove') params.push(req.auth.user_id || null);
    const result = await withCompanyTransaction(pool, req.auth.company_id, (client) => client.query(sql, params));
    const done = result.rows.map((r) => String(r.id));
    if (done.length) {
      await pool.query(
        `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
         SELECT $1, $2, 'customer', x, $3, $4 FROM unnest($5::bigint[]) AS x`,
        [req.auth.company_id, req.auth.user_id || null, `bulk_${action}`, action === 'stage' ? { stage: params[2] } : {}, done]
      );
    }
    return res.json({ done, skipped: ids.filter((id) => !done.includes(id)) });
  }));

  // Corbeille du carnet : suppression définitive des fiches supprimées. Les
  // commandes et demandes du client restent dans Opérations, sans lien vers la fiche.
  app.post('/api/app/crm/customers/purge', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((v) => /^\d{1,18}$/.test(v)))];
    if (!ids.length || ids.length > 1000) return res.status(400).json({ error: 'Sélectionnez entre 1 et 1 000 fiches.' });
    const out = await withCompanyTransaction(pool, req.auth.company_id,
      (client) => trashPurge.purgeIds(client, 'clients', req.auth.company_id, ids, { userId: req.auth.user_id || null }));
    return res.json({ done: out.done, skipped: out.held.map((id) => ({ id, reason: TRASH_HELD_REASON })) });
  }));

  // Export CSV du carnet (résultats filtrés ou sélection explicite) : réservé
  // aux responsables, journalisé, cellules « formule » neutralisées. Notes et
  // consignes ne sont pas exportées.
  const CUSTOMER_STAGE_LABELS = { nouveau: 'Nouveau', actif: 'Actif', a_relancer: 'À relancer', inactif: 'Inactif' };
  app.post('/api/app/crm/customers/export', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((v) => /^\d{1,18}$/.test(v)))];
    if (!ids.length || ids.length > 2000) return res.status(400).json({ error: 'Rien à exporter : sélectionnez entre 1 et 2 000 fiches.' });
    const rows = await withCompanyTransaction(pool, req.auth.company_id, async (client) => (await client.query(
      `SELECT c.id, c.customer_type, c.display_name, c.status, c.pipeline_stage, c.created_at,
              COALESCE(c.main_city, loc.locality) AS city,
              (SELECT cc.value_display FROM customer_contacts cc WHERE cc.company_id = c.company_id AND cc.customer_id = c.id
                 AND cc.kind = 'phone' AND cc.is_active = TRUE ORDER BY cc.is_primary DESC, cc.id LIMIT 1) AS phone,
              (SELECT ce.value_display FROM customer_contacts ce WHERE ce.company_id = c.company_id AND ce.customer_id = c.id
                 AND ce.kind = 'email' AND ce.is_active = TRUE ORDER BY ce.is_primary DESC, ce.id LIMIT 1) AS email,
              (SELECT COUNT(*)::int FROM orders o WHERE o.company_id = c.company_id AND o.customer_id = c.id) AS order_count,
              (SELECT MAX(o.created_at) FROM orders o WHERE o.company_id = c.company_id AND o.customer_id = c.id) AS last_order_at,
              (SELECT COUNT(*)::int FROM customer_locations l WHERE l.company_id = c.company_id AND l.customer_id = c.id AND l.is_active = TRUE) AS location_count
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT cl.locality FROM customer_locations cl WHERE cl.company_id = c.company_id AND cl.customer_id = c.id AND cl.is_active = TRUE
         ORDER BY cl.last_used_at DESC NULLS LAST, cl.id DESC LIMIT 1
       ) loc ON TRUE
       WHERE c.company_id = $1 AND c.id = ANY($2::bigint[]) AND c.removed_at IS NULL
         AND c.status NOT IN ('merged', 'anonymized')
       ORDER BY c.display_name, c.id`,
      [req.auth.company_id, ids]
    )).rows);
    const days = (d) => (Date.now() - new Date(d).getTime()) / 86400000;
    const stageOf = (r) => {
      if (r.pipeline_stage) return r.pipeline_stage;
      if (!r.last_order_at) return days(r.created_at) <= 30 ? 'nouveau' : 'inactif';
      if (days(r.created_at) <= 21 && r.order_count <= 2) return 'nouveau';
      if (days(r.last_order_at) <= 30) return 'actif';
      return days(r.last_order_at) <= 90 ? 'a_relancer' : 'inactif';
    };
    const safe = (v) => neutralizeSpreadsheetText(v == null ? '' : String(v));
    const keys = ['id', 'name', 'type', 'phone', 'email', 'stage', 'city', 'orders', 'locations', 'archived'];
    const labels = ['ID', 'Nom', 'Type', 'Téléphone', 'E-mail', 'Étape', 'Ville', 'Commandes', 'Lieux', 'Archivé'];
    const data = rows.map((r) => ({
      id: `CL-${String(r.id).padStart(4, '0')}`,
      name: safe(r.display_name),
      type: r.customer_type === 'organization' ? 'Entreprise' : 'Particulier',
      phone: safe(r.phone),
      email: safe(r.email),
      stage: CUSTOMER_STAGE_LABELS[stageOf(r)],
      city: safe(r.city),
      orders: r.order_count,
      locations: r.location_count,
      archived: r.status === 'archived' ? 'Oui' : 'Non',
    }));
    const csv = buildExportCsv(labels, keys, data);
    try {
      await pool.query(
        `INSERT INTO export_logs (company_id, actor_user_id, dataset, role, status, purpose, columns, row_count, artifact_bytes, artifact_sha256)
         VALUES ($1, $2, 'customers_csv', $3, 'downloaded', 'carnet_clients', $4, $5, $6, $7)`,
        [req.auth.company_id, req.auth.user_id || null, req.auth.role, JSON.stringify(keys), data.length,
          Buffer.byteLength(csv), crypto.createHash('sha256').update(csv).digest('hex')]
      );
    } catch (error) {
      console.warn('Échec d’écriture du journal d’export :', error.message);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(csv);
  }));

  async function ownCustomer(client, companyId, customerId) {
    if (!/^\d{1,18}$/.test(String(customerId))) return null;
    const r = await client.query('SELECT id FROM customers WHERE id = $1 AND company_id = $2 AND removed_at IS NULL', [customerId, companyId]);
    return r.rows[0] || null;
  }

  // Contacts supplémentaires (nom, téléphone, rôle).
  app.post('/api/app/crm/customers/:id/contacts', requireCompanyApi, asyncRoute(async (req, res) => {
    const name = textField(req.body?.name, 120);
    const role = textField(req.body?.role, 80);
    const phone = parsePhoneInput(req.body?.phone, req.body?.phoneCountry);
    if (!name) return res.status(400).json({ error: 'Indiquez le nom du contact.', field: 'name' });
    if (phone.error || !phone.value) return res.status(400).json({ error: phone.error || 'Indiquez le téléphone du contact.', field: 'phone' });
    const row = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
      if (!(await ownCustomer(client, req.auth.company_id, req.params.id))) return null;
      return (await client.query(
        `INSERT INTO customer_contacts (company_id, customer_id, kind, label, contact_name, value_display, value_normalized,
           is_primary, created_by_user_id, updated_by_user_id)
         VALUES ($1, $2, 'phone', $3, $4, $5, $6, FALSE, $7, $7) RETURNING id`,
        [req.auth.company_id, req.params.id, role, name, phone.value, phone.value.replace(/[^\d+]/g, ''), req.auth.user_id || null]
      )).rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Client introuvable.' });
    await writeAudit(req.auth, 'customer', req.params.id, 'contact_added', { name });
    return res.status(201).json({ id: String(row.id) });
  }));
  app.delete('/api/app/crm/customers/:id/contacts/:contactId', requireCompanyApi, asyncRoute(async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.contactId)) return res.status(404).json({ error: 'Contact introuvable.' });
    const result = await withCompanyTransaction(pool, req.auth.company_id, (client) => client.query(
      `UPDATE customer_contacts SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND customer_id = $3 AND is_primary = FALSE AND is_active = TRUE RETURNING contact_name`,
      [req.params.contactId, req.auth.company_id, req.params.id]
    ));
    if (!result.rows[0]) return res.status(404).json({ error: 'Contact introuvable (le contact principal se modifie dans les informations).' });
    await writeAudit(req.auth, 'customer', req.params.id, 'contact_removed', { name: result.rows[0].contact_name });
    return res.json({ ok: true });
  }));

  // Lieux de livraison. Modifier l'adresse efface la position GPS : une
  // ancienne précision ne doit pas rester attachée à une nouvelle adresse.
  function locationFields(b) {
    return {
      label: textField(b?.label, 100), locality: textField(b?.city, 200), neighborhood: textField(b?.neighborhood, 200),
      address: textField(b?.address, 1000), landmark: textField(b?.landmark, 500),
    };
  }
  app.post('/api/app/crm/customers/:id/locations', requireCompanyApi, asyncRoute(async (req, res) => {
    const f = locationFields(req.body);
    if (!f.label) return res.status(400).json({ error: 'Donnez un nom au lieu (ex. Domicile, Bureau).', field: 'label' });
    if (!f.address && !f.neighborhood) return res.status(400).json({ error: 'Indiquez une adresse ou un quartier.', field: 'address' });
    const row = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
      if (!(await ownCustomer(client, req.auth.company_id, req.params.id))) return null;
      const inserted = (await client.query(
        `INSERT INTO customer_locations (company_id, customer_id, label, locality, neighborhood, address_text, landmark,
           coordinate_source, created_by_user_id, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $8) RETURNING id`,
        [req.auth.company_id, req.params.id, f.label, f.locality, f.neighborhood, f.address, f.landmark, req.auth.user_id || null]
      )).rows[0];
      if (req.body?.isDefault === true) await client.query('UPDATE customers SET default_location_id = $1 WHERE id = $2 AND company_id = $3', [inserted.id, req.params.id, req.auth.company_id]);
      return inserted;
    });
    if (!row) return res.status(404).json({ error: 'Client introuvable.' });
    await writeAudit(req.auth, 'customer', req.params.id, 'location_added', { label: f.label });
    return res.status(201).json({ id: String(row.id) });
  }));
  app.patch('/api/app/crm/customers/:id/locations/:locationId', requireCompanyApi, asyncRoute(async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.locationId)) return res.status(404).json({ error: 'Lieu introuvable.' });
    const f = locationFields(req.body);
    if (!f.label) return res.status(400).json({ error: 'Donnez un nom au lieu.', field: 'label' });
    if (!f.address && !f.neighborhood) return res.status(400).json({ error: 'Indiquez une adresse ou un quartier.', field: 'address' });
    const result = await withCompanyTransaction(pool, req.auth.company_id, (client) => client.query(
      `UPDATE customer_locations SET
         label = $1, locality = $2, neighborhood = $3, address_text = $4, landmark = $5,
         latitude = CASE WHEN address_text IS NOT DISTINCT FROM $4 AND neighborhood IS NOT DISTINCT FROM $3 THEN latitude END,
         longitude = CASE WHEN address_text IS NOT DISTINCT FROM $4 AND neighborhood IS NOT DISTINCT FROM $3 THEN longitude END,
         accuracy_meters = CASE WHEN address_text IS NOT DISTINCT FROM $4 AND neighborhood IS NOT DISTINCT FROM $3 THEN accuracy_meters END,
         coordinate_source = CASE WHEN address_text IS NOT DISTINCT FROM $4 AND neighborhood IS NOT DISTINCT FROM $3 THEN coordinate_source END,
         coordinates_captured_at = CASE WHEN address_text IS NOT DISTINCT FROM $4 AND neighborhood IS NOT DISTINCT FROM $3 THEN coordinates_captured_at END,
         updated_by_user_id = $6, updated_at = NOW(), version = version + 1
       WHERE id = $7 AND company_id = $8 AND customer_id = $9 RETURNING id`,
      [f.label, f.locality, f.neighborhood, f.address, f.landmark, req.auth.user_id || null, req.params.locationId, req.auth.company_id, req.params.id]
    ));
    if (!result.rows[0]) return res.status(404).json({ error: 'Lieu introuvable.' });
    await writeAudit(req.auth, 'customer', req.params.id, 'location_updated', { label: f.label });
    return res.json({ id: String(result.rows[0].id) });
  }));

  // Notes internes datées (visibles par l'équipe, jamais par le client).
  app.post('/api/app/crm/customers/:id/notes', requireCompanyApi, asyncRoute(async (req, res) => {
    const text = textField(req.body?.text, 2000);
    if (!text || text.length < 2) return res.status(400).json({ error: 'Écrivez votre note.', field: 'text' });
    const row = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
      if (!(await ownCustomer(client, req.auth.company_id, req.params.id))) return null;
      const key = crypto.randomUUID();
      return (await client.query(
        `INSERT INTO customer_interactions (company_id, customer_id, channel, direction, purpose, summary, occurred_at,
           actor_user_id, visibility, idempotency_key, request_fingerprint)
         VALUES ($1, $2, 'internal', 'internal', 'other', $3, NOW(), $4, 'operations', $5, $6) RETURNING id, occurred_at`,
        [req.auth.company_id, req.params.id, text, req.auth.user_id || null, `note-${key}`, digest(`note:${key}:${text}`)]
      )).rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Client introuvable.' });
    return res.status(201).json({ id: String(row.id), at: row.occurred_at });
  }));

  // Doublons potentiels d'un client : autres fiches partageant un téléphone
  // normalisé identique.
  app.get('/api/app/crm/customers/:id/duplicates', requireCompanyApi, asyncRoute(async (req, res) => {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId < 1) return res.status(404).json({ error: 'Client introuvable.' });
    const rows = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
      const result = await client.query(
        `WITH me AS (
           SELECT DISTINCT value_normalized FROM customer_contacts
           WHERE company_id = $1 AND customer_id = $2 AND kind = 'phone'
             AND is_active = TRUE AND value_normalized IS NOT NULL AND value_normalized <> ''
         )
         SELECT c.id, c.customer_code, c.display_name, c.status,
                MIN(cc.value_display) AS primary_phone,
                (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.company_id AND o.customer_id = c.id)::int AS order_count
         FROM customers c
         JOIN customer_contacts cc ON cc.company_id = c.company_id AND cc.customer_id = c.id
           AND cc.kind = 'phone' AND cc.is_active = TRUE
         WHERE c.company_id = $1 AND c.id <> $2
           AND c.status NOT IN ('merged', 'anonymized')
           AND cc.value_normalized IN (SELECT value_normalized FROM me)
         GROUP BY c.id
         ORDER BY order_count DESC, c.id ASC
         LIMIT 20`,
        [req.auth.company_id, customerId]
      );
      return result.rows;
    });
    return res.json({ duplicates: rows });
  }));

  // Fusion douce : bascule l'historique (commandes, demandes) du doublon vers la
  // fiche cible et marque le doublon « merged » (redirection). Ne re-parente pas
  // les contacts/lieux (FK composites) : approche sûre pour le MVP.
  app.post('/api/app/crm/customers/:id/merge', requireCompanyApi, asyncRoute(async (req, res) => {
    const targetId = Number(req.params.id);
    const sourceId = Number(req.body?.sourceId);
    if (!Number.isInteger(targetId) || targetId < 1) return res.status(404).json({ error: 'Fiche cible introuvable.' });
    if (!Number.isInteger(sourceId) || sourceId < 1) return res.status(400).json({ error: 'Doublon invalide.' });
    if (targetId === sourceId) return res.status(400).json({ error: 'Impossible de fusionner une fiche avec elle-même.' });
    try {
      const merged = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
        const both = await client.query(
          `SELECT id, status FROM customers WHERE company_id = $1 AND id IN ($2, $3) FOR UPDATE`,
          [req.auth.company_id, targetId, sourceId]
        );
        const target = both.rows.find((row) => row.id === targetId);
        const source = both.rows.find((row) => row.id === sourceId);
        if (!target || !source) { const err = new Error('Fiche introuvable.'); err.code = 'NOT_FOUND'; throw err; }
        if (target.status === 'merged') { const err = new Error('La fiche cible est déjà fusionnée.'); err.code = 'BAD'; throw err; }
        if (source.status === 'merged') { const err = new Error('Ce doublon est déjà fusionné.'); err.code = 'BAD'; throw err; }
        await client.query(`UPDATE orders SET customer_id = $1 WHERE company_id = $2 AND customer_id = $3`, [targetId, req.auth.company_id, sourceId]);
        await client.query(`UPDATE customer_requests SET customer_id = $1 WHERE company_id = $2 AND customer_id = $3`, [targetId, req.auth.company_id, sourceId]);
        await client.query(
          `UPDATE customers SET status = 'merged', merged_into_customer_id = $1,
             updated_by_user_id = $2, updated_at = NOW(), version = version + 1
           WHERE company_id = $3 AND id = $4`,
          [targetId, req.auth.user_id || null, req.auth.company_id, sourceId]
        );
        return { targetId, sourceId };
      });
      return res.json({ ok: true, ...merged });
    } catch (error) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
      if (error.code === 'BAD') return res.status(409).json({ error: error.message });
      throw error;
    }
  }));

  app.get('/api/app/crm/customers/:id', requireCompanyApi, asyncRoute(async (req, res) => {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId < 1) return res.status(404).json({ error: 'Client introuvable.' });
    const result = await withCompanyTransaction(pool, req.auth.company_id, async (client) => {
      const customer = await client.query(
        `SELECT c.id, c.customer_code, c.customer_type, c.sector, c.display_name, c.status,
                c.preferred_language, c.preferred_channel, c.service_notes, c.created_at, c.updated_at,
                c.archived_at, c.removed_at, c.driver_instructions, c.main_city, c.default_location_id,
                c.pipeline_stage, c.created_from_request_id, c.merged_into_customer_id, c.version,
                u.display_name AS created_by_name
         FROM customers c LEFT JOIN users u ON u.id = c.created_by_user_id
         WHERE c.id = $1 AND c.company_id = $2`,
        [customerId, req.auth.company_id]
      );
      if (!customer.rows[0]) return null;
      const interactionVisibility = ['owner', 'manager'].includes(req.auth.role)
        ? ['operations', 'manager', 'dispute']
        : ['operations'];
      const [contacts, locations, orders, interactions, openIncidents, tags, activity, firstOrder] = await runQueries(client, [
        () => client.query(
          `SELECT id, kind, label, contact_name, value_display, is_primary,
                  is_active, verified_at, created_at, updated_at
           FROM customer_contacts
           WHERE company_id = $1 AND customer_id = $2 AND anonymized_at IS NULL
           ORDER BY is_primary DESC, is_active DESC, id ASC`,
          [req.auth.company_id, customerId]
        ),
        () => client.query(
          `SELECT id, label, neighborhood, locality, address_text, landmark,
                  delivery_instructions, verified_at, last_used_at, is_active,
                  archived_at, created_at, updated_at, coordinate_source,
                  (latitude IS NOT NULL) AS has_gps, accuracy_meters,
                  (SELECT COUNT(*)::int FROM orders lo WHERE lo.company_id = customer_locations.company_id AND lo.customer_location_id = customer_locations.id) AS order_count
           FROM customer_locations
           WHERE company_id = $1 AND customer_id = $2 AND anonymized_at IS NULL
           ORDER BY is_active DESC, last_used_at DESC NULLS LAST, id DESC`,
          [req.auth.company_id, customerId]
        ),
        () => client.query(
          `SELECT o.id, o.reference, o.status, o.neighborhood, o.landmark, o.created_at,
                  o.updated_at, d.name AS driver_name, cl.label AS location_label
           FROM orders o
           LEFT JOIN drivers d ON d.id = o.driver_id AND d.company_id = o.company_id
           LEFT JOIN customer_locations cl ON cl.company_id = o.company_id AND cl.id = o.customer_location_id
           WHERE o.company_id = $1 AND o.customer_id = $2
           ORDER BY o.created_at DESC, o.id DESC LIMIT 200`,
          [req.auth.company_id, customerId]
        ),
        () => client.query(
          `SELECT ci.id, ci.channel, ci.direction, ci.purpose, ci.outcome, ci.summary,
                  ci.occurred_at, ci.next_action_at, ci.visibility, u.display_name AS author_name
           FROM customer_interactions ci LEFT JOIN users u ON u.id = ci.actor_user_id
           WHERE ci.company_id = $1 AND ci.customer_id = $2 AND ci.anonymized_at IS NULL
             AND ci.visibility = ANY($3::text[])
           ORDER BY ci.occurred_at DESC, ci.id DESC LIMIT 100`,
          [req.auth.company_id, customerId, interactionVisibility]
        ),
        () => client.query(
          `SELECT COUNT(*)::int AS n FROM delivery_incidents i JOIN orders o ON o.id = i.order_id AND o.company_id = i.company_id
           WHERE i.company_id = $1 AND o.customer_id = $2 AND i.status <> 'resolved'`,
          [req.auth.company_id, customerId]
        ),
        () => client.query(
          `SELECT t.name FROM customer_tags ct
           JOIN crm_tags t ON t.company_id = ct.company_id AND t.id = ct.tag_id AND t.archived_at IS NULL
           WHERE ct.company_id = $1 AND ct.customer_id = $2 ORDER BY t.name`,
          [req.auth.company_id, customerId]
        ),
        () => client.query(
          `SELECT a.id, a.action, a.details, a.created_at, u.display_name AS author_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
           WHERE a.company_id = $1 AND a.entity_type = 'customer' AND a.entity_id = $2
           ORDER BY a.created_at DESC, a.id DESC LIMIT 60`,
          [req.auth.company_id, customerId]
        ),
        () => client.query(
          `SELECT MIN(created_at) AS first_at FROM orders WHERE company_id = $1 AND customer_id = $2`,
          [req.auth.company_id, customerId]
        ),
      ]);
      const finished = ['Livrée', 'Annulée', 'Retournée'];
      const orderRows = orders.rows;
      const lastOrder = orderRows[0] || null;
      const c = customer.rows[0];
      // Même règle que la liste : étape manuelle prioritaire, sinon dérivée.
      const now = Date.now();
      const days = (date) => (now - new Date(date).getTime()) / 86400000;
      let autoStage = 'inactif';
      if (!lastOrder) autoStage = days(c.created_at) <= 30 ? 'nouveau' : 'inactif';
      else if (days(c.created_at) <= 21 && orderRows.length <= 2) autoStage = 'nouveau';
      else if (days(lastOrder.created_at) <= 30) autoStage = 'actif';
      else if (days(lastOrder.created_at) <= 90) autoStage = 'a_relancer';
      const origin = c.created_from_request_id ? 'request'
        : String(c.customer_code || '').startsWith('AUTO-') ? 'order' : 'manual';
      return {
        customer: {
          ...c,
          tags: tags.rows.map((row) => row.name),
          stage: c.pipeline_stage || autoStage,
          stage_source: c.pipeline_stage ? 'manual' : 'auto',
          origin,
        },
        contacts: contacts.rows,
        locations: locations.rows,
        orders: orderRows,
        interactions: interactions.rows,
        activity: activity.rows,
        openIncidents: openIncidents.rows[0].n,
        counters: {
          orders: orderRows.length,
          active: orderRows.filter((o) => !finished.includes(o.status)).length,
          delivered: orderRows.filter((o) => o.status === 'Livrée').length,
          failed: orderRows.filter((o) => ['Annulée', 'Retournée'].includes(o.status)).length,
          firstOrderAt: firstOrder.rows[0].first_at,
          lastOrderAt: lastOrder ? lastOrder.created_at : null,
        },
      };
    });
    if (!result) return res.status(404).json({ error: 'Client introuvable.' });
    return res.json(result);
  }));
};
