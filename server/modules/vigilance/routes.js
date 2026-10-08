// Vigilance : consultation et suivi des signaux (fraude, anomalies) par le
// responsable, et signaux entre entreprises pour l'équipe TRAXO.
// La détection elle-même vit dans lib/vigilance.js.

module.exports = function registerVigilance(app, deps) {
  const {
    pool, asyncRoute, requireCompanyApi, requireCompanyRoles, writeAudit,
  } = deps;

  function moneyText(minor, currency) {
    try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'XOF', maximumFractionDigits: 0 }).format(Number(minor) || 0); } catch { return `${minor} ${currency || ''}`; }
  }
  // Textes rédigés pour le responsable : ce qui s'est passé, ce que ça peut vouloir dire.
  function describeSignal(row) {
    const d = row.details || {};
    const who = row.driver_name || 'Un livreur';
    const ref = row.order_reference || (row.order_id ? `Commande n° ${row.order_id}` : '');
    switch (row.kind) {
      case 'far_delivery': return {
        title: 'Remise déclarée loin du client', summary: [who, ref].filter(Boolean).join(' · '),
        detail: `${d.status === 'Livrée' ? 'La remise' : 'L’arrivée'} a été déclarée à ${d.distance >= 1000 ? `${(d.distance / 1000).toFixed(1).replace('.', ',')} km` : `${d.distance} m`} de l’adresse du client. Le client est peut-être venu à sa rencontre : vérifiez avec lui en cas de doute.`,
        href: row.order_id ? `/app/operations?vue=commandes&commande=${row.order_id}` : '/app/livreurs', cta: 'Voir la commande',
      };
      case 'impossible_speed': return {
        title: 'Position du livreur incohérente', summary: [who, ref].filter(Boolean).join(' · '),
        detail: `${(d.distance / 1000).toFixed(1).replace('.', ',')} km parcourus en ${Math.max(1, Math.round(d.seconds / 60))} min entre deux étapes, soit ${d.kmh} km/h : impossible en ville. Sa position est peut-être truquée, ou son accès est utilisé par quelqu’un d’autre.`,
        href: row.driver_id ? `/app/livreurs?livreur=${row.driver_id}` : '/app/livreurs', cta: 'Voir le livreur',
      };
      case 'cash_gap': return {
        title: 'Écarts d’encaissement répétés', summary: who,
        detail: `${d.count} encaissements inférieurs au montant attendu en 30 jours, ${moneyText(d.totalMinor, d.currency)} au total. Le motif donné pour chaque écart figure dans la commande.`,
        href: row.driver_id ? `/app/livreurs?livreur=${row.driver_id}` : '/app/livreurs', cta: 'Voir le livreur',
      };
      case 'photo_reused': return {
        title: 'Photo de remise déjà utilisée', summary: [who, ref].filter(Boolean).join(' · '),
        detail: `Une photo déjà envoyée pour une autre livraison${d.previousOrderId ? ` (n° ${d.previousOrderId})` : ''} a été proposée comme preuve. Elle a été refusée et une nouvelle photo a été demandée.`,
        href: row.order_id ? `/app/operations?vue=commandes&commande=${row.order_id}` : '/app/livreurs', cta: 'Voir la commande',
      };
      case 'shared_phone': return {
        title: 'Numéro de livreur présent dans plusieurs entreprises', summary: `Espace n° ${d.companyId}`,
        detail: `Le même numéro est enregistré comme livreur dans ${d.companies} entreprises. Cela peut être normal (livreur indépendant) ou un partage d’accès.`, href: '', cta: '',
      };
      case 'trial_reused': return {
        title: 'Essai gratuit déjà utilisé', summary: `Espace n° ${d.companyId}`,
        detail: `Cette inscription reprend ${d.method === 'phone' ? 'un numéro' : d.method === 'google' ? 'un compte Google ou un appareil' : 'une adresse ou un appareil'} déjà utilisé pour l’essai de l’espace n° ${d.priorCompanyId}. L’essai gratuit n’a pas été accordé.`, href: '', cta: '',
      };
      default: return { title: 'Point à vérifier', summary: who, detail: '', href: '/app/livreurs', cta: 'Voir' };
    }
  }
  async function companySignals(companyId, { driverId = null, includeReviewed = false, days = 30, limit = 50 } = {}) {
    const rows = (await pool.query(
      `SELECT s.*, d.name AS driver_name, o.reference AS order_reference
       FROM fraud_signals s
       LEFT JOIN drivers d ON d.id = s.driver_id AND d.company_id = s.company_id
       LEFT JOIN orders o ON o.id = s.order_id AND o.company_id = s.company_id
       WHERE s.company_id = $1 AND s.created_at > NOW() - make_interval(days => $2)
         AND ($3::bigint IS NULL OR s.driver_id = $3) AND ($4 OR s.reviewed_at IS NULL)
       ORDER BY s.created_at DESC LIMIT $5`,
      [companyId, days, driverId, includeReviewed, limit]
    )).rows;
    return rows.map((r) => ({ id: r.id, kind: r.kind, driverId: r.driver_id, orderId: r.order_id, at: r.created_at, reviewedAt: r.reviewed_at, ...describeSignal(r) }));
  }
  app.get('/api/app/drivers/:id/signals', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
    return res.json({ signals: await companySignals(req.auth.company_id, { driverId: req.params.id, includeReviewed: true, days: 90, limit: 20 }) });
  }));
  app.post('/api/app/signals/:id/review', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
    const result = await pool.query(
      'UPDATE fraud_signals SET reviewed_at = COALESCE(reviewed_at, NOW()), reviewed_by_user_id = COALESCE(reviewed_by_user_id, $3) WHERE id = $1 AND company_id = $2 RETURNING id, reviewed_at',
      [req.params.id, req.auth.company_id, req.auth.user_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Signal introuvable.' });
    await writeAudit(req.auth, 'fraud_signal', result.rows[0].id, 'reviewed', {});
    return res.json({ id: result.rows[0].id, reviewedAt: result.rows[0].reviewed_at });
  }));
  // Signaux entre entreprises : réservés à l'équipe TRAXO.
  app.get('/api/app/platform/signals', requireCompanyApi, asyncRoute(async (req, res) => {
    if (!req.auth.is_platform_admin) return res.status(403).json({ error: 'Réservé à l’équipe TRAXO.' });
    const rows = (await pool.query(
      `SELECT s.*, c.name AS company_name FROM fraud_signals s
       LEFT JOIN companies c ON c.id = (s.details->>'companyId')::bigint
       WHERE s.company_id IS NULL ORDER BY s.created_at DESC LIMIT 100`
    )).rows;
    return res.json({ signals: rows.map((r) => ({ id: r.id, kind: r.kind, at: r.created_at, reviewedAt: r.reviewed_at, companyName: r.company_name, ...describeSignal(r) })) });
  }));
  app.post('/api/app/platform/signals/:id/review', requireCompanyApi, asyncRoute(async (req, res) => {
    if (!req.auth.is_platform_admin) return res.status(403).json({ error: 'Réservé à l’équipe TRAXO.' });
    const result = await pool.query('UPDATE fraud_signals SET reviewed_at = COALESCE(reviewed_at, NOW()), reviewed_by_user_id = $2 WHERE id = $1 AND company_id IS NULL RETURNING id', [req.params.id, req.auth.user_id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Signal introuvable.' });
    return res.json({ id: result.rows[0].id, reviewed: true });
  }));

  return { companySignals };
};
