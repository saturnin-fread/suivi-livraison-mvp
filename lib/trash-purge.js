// Corbeille : suppression définitive, à la demande ou 30 jours après la mise
// à la corbeille. Une ligne sous gel légal (gel de commande actif, ou gel CRM,
// même levé : son historique doit rester rattaché) n'est jamais supprimée. Les fichiers (photos,
// preuves) sont stockés en base et partent avec leur ligne (ON DELETE CASCADE).
const TRASH_RETENTION_DAYS = 30;
// Les éléments déjà dans la corbeille avant l'arrivée de la purge gardent
// 30 jours pleins à partir de cette date : personne ne perd de données sans
// avoir vu l'avertissement.
const TRASH_PURGE_START = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(process.env.TRASH_PURGE_START || '') ? process.env.TRASH_PURGE_START : '2026-10-07T00:00:00Z';

// Date de suppression automatique, exprimée en SQL à partir de la colonne
// de mise à la corbeille.
const purgeAtSql = (col) => `(GREATEST(${col}, TIMESTAMPTZ '${TRASH_PURGE_START}') + INTERVAL '${TRASH_RETENTION_DAYS} days')`;
const purgeAtOf = (trashedAt) => {
  if (!trashedAt) return null;
  const from = Math.max(new Date(trashedAt).getTime(), Date.parse(TRASH_PURGE_START));
  return new Date(from + TRASH_RETENTION_DAYS * 86400000).toISOString();
};

const HELD_ORDER = `(EXISTS (SELECT 1 FROM order_retention_holds h WHERE h.order_id = o.id AND h.status = 'active')
  OR EXISTS (SELECT 1 FROM crm_retention_holds ch WHERE ch.company_id = o.company_id AND ch.order_id = o.id))`;

// Chaque source : sélection des lignes supprimables (dans la corbeille, pas
// gelées), puis suppression. `due` restreint aux lignes arrivées à échéance.
const SOURCES = {
  commandes: {
    entity: 'order',
    pick: (due) => `SELECT o.id FROM orders o WHERE o.company_id = $1 AND o.id = ANY($2::bigint[])
      AND o.archived_at IS NOT NULL ${due ? `AND ${purgeAtSql('o.archived_at')} <= NOW()` : ''} AND NOT ${HELD_ORDER}`,
    del: 'DELETE FROM orders WHERE company_id = $1 AND id = ANY($2::bigint[]) RETURNING id',
    due: `SELECT o.company_id, o.id FROM orders o WHERE o.archived_at IS NOT NULL AND ${purgeAtSql('o.archived_at')} <= NOW()`,
  },
  incidents: {
    entity: 'incident',
    pick: (due) => `SELECT i.id FROM delivery_incidents i WHERE i.company_id = $1 AND i.id = ANY($2::bigint[])
      AND i.archived_at IS NOT NULL ${due ? `AND ${purgeAtSql('i.archived_at')} <= NOW()` : ''}
      AND NOT EXISTS (SELECT 1 FROM crm_retention_holds ch WHERE ch.company_id = i.company_id AND ch.incident_id = i.id)`,
    del: 'DELETE FROM delivery_incidents WHERE company_id = $1 AND id = ANY($2::bigint[]) RETURNING id',
    due: `SELECT i.company_id, i.id FROM delivery_incidents i WHERE i.archived_at IS NOT NULL AND ${purgeAtSql('i.archived_at')} <= NOW()`,
  },
  demandes: {
    entity: 'customer_request',
    pick: (due) => `SELECT r.id FROM customer_requests r WHERE r.company_id = $1 AND r.id = ANY($2::bigint[])
      AND r.archived_at IS NOT NULL ${due ? `AND ${purgeAtSql('r.archived_at')} <= NOW()` : ''}`,
    // La commande issue d'une demande reste : elle perd seulement son lien.
    before: 'UPDATE orders SET customer_request_id = NULL WHERE company_id = $1 AND customer_request_id = ANY($2::bigint[])',
    del: 'DELETE FROM customer_requests WHERE company_id = $1 AND id = ANY($2::bigint[]) RETURNING id',
    due: `SELECT r.company_id, r.id FROM customer_requests r WHERE r.archived_at IS NOT NULL AND ${purgeAtSql('r.archived_at')} <= NOW()`,
  },
  clients: {
    entity: 'customer',
    rls: true,
    pick: (due) => `SELECT c.id FROM customers c WHERE c.company_id = $1 AND c.id = ANY($2::bigint[])
      AND c.removed_at IS NOT NULL ${due ? `AND ${purgeAtSql('c.removed_at')} <= NOW()` : ''}
      AND NOT EXISTS (SELECT 1 FROM crm_retention_holds ch WHERE ch.company_id = c.company_id AND ch.customer_id = c.id)`,
    // Les commandes et demandes du client restent (sans lien vers la fiche) ;
    // les fiches fusionnées dans celle-ci et l'historique de fusion partent avec elle.
    before: `WITH RECURSIVE stubs AS (
        SELECT id FROM customers WHERE company_id = $1 AND merged_into_customer_id = ANY($2::bigint[])
        UNION SELECT c.id FROM customers c JOIN stubs s ON c.merged_into_customer_id = s.id WHERE c.company_id = $1
      ), all_ids AS (SELECT unnest($2::bigint[]) AS id UNION SELECT id FROM stubs),
      ev AS (DELETE FROM customer_merge_events WHERE company_id = $1
               AND (source_customer_id IN (SELECT id FROM all_ids) OR target_customer_id IN (SELECT id FROM all_ids)) RETURNING 1),
      unlink AS (UPDATE customers SET merged_into_customer_id = NULL WHERE company_id = $1 AND id IN (SELECT id FROM stubs) RETURNING id)
      DELETE FROM customers WHERE company_id = $1 AND id IN (SELECT id FROM unlink)`,
    del: 'DELETE FROM customers WHERE company_id = $1 AND id = ANY($2::bigint[]) RETURNING id',
    due: `SELECT c.company_id, c.id FROM customers c WHERE c.removed_at IS NOT NULL AND ${purgeAtSql('c.removed_at')} <= NOW()`,
  },
};

// Supprime définitivement les ids donnés d'une entreprise (dans une
// transaction déjà ouverte, contexte d'entreprise posé). Renvoie { done, held }.
async function purgeIds(client, source, companyId, ids, { due = false, userId = null, reason = 'manual' } = {}) {
  const def = SOURCES[source];
  if (!def) throw new Error(`Source de corbeille inconnue : ${source}`);
  const allowed = (await client.query(def.pick(due), [companyId, ids])).rows.map((r) => String(r.id));
  if (!allowed.length) return { done: [], held: ids.filter((id) => !allowed.includes(id)) };
  if (def.before) await client.query(def.before, [companyId, allowed]);
  const done = (await client.query(def.del, [companyId, allowed])).rows.map((r) => String(r.id));
  await client.query(
    `INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
     SELECT $1, $2, $3, x, 'purged', $4 FROM unnest($5::bigint[]) AS x`,
    [companyId, userId, def.entity, { reason }, done]
  );
  return { done, held: ids.filter((id) => !done.includes(id)) };
}

// Purge automatique : toutes les entreprises, par lots, une seule instance à
// la fois (verrou consultatif). `withCompany(companyId, fn)` ouvre une
// transaction avec le contexte d'entreprise (RLS du CRM).
async function purgeExpired(pool, withCompany, { batch = 200 } = {}) {
  const lock = await pool.connect();
  const totals = {};
  try {
    const got = (await lock.query('SELECT pg_try_advisory_lock(7302100417) AS ok')).rows[0].ok;
    if (!got) return { skipped: true };
    try {
      for (const source of Object.keys(SOURCES)) {
        totals[source] = 0;
        let rows;
        if (SOURCES[source].rls) {
          // Tables sous RLS forcée : lecture entreprise par entreprise.
          rows = [];
          const companies = (await pool.query('SELECT id FROM companies ORDER BY id')).rows;
          for (const { id } of companies) {
            const found = await withCompany(String(id), (client) => client.query(`${SOURCES[source].due} AND c.company_id = $1 LIMIT ${Number(batch) * 10}`, [String(id)]));
            rows.push(...found.rows);
          }
        } else {
          rows = (await pool.query(`${SOURCES[source].due} LIMIT ${Number(batch) * 10}`)).rows;
        }
        const byCompany = new Map();
        for (const r of rows) { const k = String(r.company_id); if (!byCompany.has(k)) byCompany.set(k, []); byCompany.get(k).push(String(r.id)); }
        for (const [companyId, ids] of byCompany) {
          for (let i = 0; i < ids.length; i += batch) {
            const chunk = ids.slice(i, i + batch);
            const out = await withCompany(companyId, (client) => purgeIds(client, source, companyId, chunk, { due: true, reason: 'expired' }));
            totals[source] += out.done.length;
          }
        }
      }
    } finally {
      await lock.query('SELECT pg_advisory_unlock(7302100417)');
    }
  } finally {
    lock.release();
  }
  return totals;
}

module.exports = { TRASH_RETENTION_DAYS, TRASH_PURGE_START, SOURCES, purgeAtSql, purgeAtOf, purgeIds, purgeExpired };
