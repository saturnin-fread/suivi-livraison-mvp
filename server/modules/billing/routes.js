// Facturation : formules d'abonnement actuelles (Paramètres > Facturation).
// Ce module accueillera le portefeuille prépayé (débit par commande) qui
// remplacera ces formules.

module.exports = function registerBilling(app, deps) {
  const {
    pool, asyncRoute, requireCompanyApi, requireCompanyRoles, writeAudit, sendEmail,
    renderEmailShell, escHtmlServer, normalizeEmail, publicBaseUrl,
  } = deps;

  // Source de vérité des formules. Les remises de cycle sont configurables via
  // l'environnement (hypothèses commerciales à valider avant production).
  const billingCycleDiscounts = {
    monthly: 0,
    quarterly: Math.min(0.9, Math.max(0, Number(process.env.BILLING_DISCOUNT_QUARTERLY) || 0.05)),
    yearly: Math.min(0.9, Math.max(0, Number(process.env.BILLING_DISCOUNT_YEARLY) || 0.10)),
  };
  const billingPlans = [
    { code: 'trial', name: 'Essai gratuit', microcopy: 'Découvrez TRAXO sans engagement.', kind: 'trial', monthly: 0, max: 0, capacityLabel: 'pendant 3 jours', tag: 'Première connexion uniquement', cta: 'Commencer l’essai', features: ['Toutes les fonctionnalités essentielles', 'Suivi de flotte en temps réel', 'Support par e-mail'] },
    { code: 'flexible', name: 'Flexible', microcopy: 'Pour les petites flottes.', kind: 'per_driver', monthly: 1000, max: 9, capacityLabel: '1 à 9 livreurs', features: ['1 à 9 livreurs', 'Fonctionnalités essentielles', 'Suivi de flotte', 'Support standard'] },
    { code: 'equipe', name: 'Équipe', microcopy: 'Un forfait pour toute votre équipe.', kind: 'flat', monthly: 10000, max: 12, capacityLabel: 'Jusqu’à 12 livreurs', features: ['Jusqu’à 12 livreurs', 'Fonctionnalités essentielles', 'Suivi de flotte avancé', 'Meilleur rapport capacité-prix', 'Support prioritaire'] },
    { code: 'croissance', name: 'Croissance', microcopy: 'Pour les flottes en expansion.', kind: 'flat', monthly: 18000, max: 25, capacityLabel: 'Jusqu’à 25 livreurs', features: ['Jusqu’à 25 livreurs', 'Fonctionnalités avancées', 'Suivi de flotte avancé', 'Rapports détaillés', 'Support prioritaire'] },
    { code: 'business', name: 'Business', microcopy: 'Pour les opérations structurées.', kind: 'flat', monthly: 30000, max: 50, capacityLabel: 'Jusqu’à 50 livreurs', compact: true, features: [] },
    { code: 'grande', name: 'Grande flotte', microcopy: 'Pour les grandes flottes et les besoins spécifiques.', kind: 'custom', monthly: null, max: null, capacityLabel: '51 livreurs et plus', compact: true, features: [] },
  ];
  function recommendPlanCode(n) {
    const count = Number(n) || 0;
    if (count <= 9) return 'flexible';
    if (count <= 12) return 'equipe';
    if (count <= 25) return 'croissance';
    if (count <= 50) return 'business';
    return 'grande';
  }
  function planCapacity(code) {
    const plan = billingPlans.find((p) => p.code === code);
    return plan && plan.max != null ? plan.max : Infinity;
  }

  app.get('/api/app/billing/plans', requireCompanyApi, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT plan_code, billing_cycle, trial_status, trial_ends_at,
              (SELECT COUNT(*)::int FROM drivers d WHERE d.company_id = c.id AND d.active = TRUE AND d.archived_at IS NULL) AS active_drivers,
              (SELECT COUNT(*)::int FROM driver_seat_usage u WHERE u.company_id = c.id
                 AND u.month = date_trunc('month', NOW() AT TIME ZONE 'Africa/Porto-Novo')::date) AS seats_month
       FROM companies c WHERE c.id = $1`,
      [req.auth.company_id]
    );
    const row = result.rows[0] || {};
    const activeDrivers = Number(row.active_drivers || 0);
    // Places : personnes différentes ayant travaillé dans le mois (supprimer puis
    // recréer des profils ne libère pas de place avant le mois suivant).
    const seatsThisMonth = Math.max(activeDrivers, Number(row.seats_month || 0));
    const recommended = recommendPlanCode(seatsThisMonth);
    return res.json({
      activeDrivers,
      seatsThisMonth,
      trial: { status: row.trial_status || null, endsAt: row.trial_ends_at || null },
      recommended,
      currentPlan: row.plan_code || recommended,
      billingCycle: row.billing_cycle || 'monthly',
      discounts: billingCycleDiscounts,
      plans: billingPlans.map((p) => ({ ...p, max: p.max === null ? null : p.max })),
    });
  }));

  // Calcul officiel d'une formule : équivalent mensuel et total de la période.
  const billingCycleMonths = { monthly: 1, quarterly: 3, yearly: 12 };
  function billingQuote(planCode, cycle, drivers) {
    const plan = billingPlans.find((p) => p.code === planCode);
    if (!plan || !billingCycleMonths[cycle] || plan.kind === 'trial' || plan.kind === 'custom') return null;
    const count = Math.max(1, Math.min(500, Math.round(Number(drivers) || 1)));
    const base = plan.kind === 'per_driver' ? plan.monthly * count : plan.monthly;
    const monthly = Math.round(base * (1 - (billingCycleDiscounts[cycle] || 0)));
    return {
      planCode, planName: plan.name, cycle, drivers: count, capacity: plan.max,
      fits: plan.max == null || count <= plan.max,
      monthlyBase: base, monthlyEquivalent: monthly, periodMonths: billingCycleMonths[cycle],
      periodTotal: monthly * billingCycleMonths[cycle], discount: billingCycleDiscounts[cycle] || 0, currency: 'XOF',
    };
  }
  app.get('/api/app/billing/quote', requireCompanyApi, asyncRoute(async (req, res) => {
    const quote = billingQuote(String(req.query.plan || ''), String(req.query.cycle || 'monthly'), req.query.drivers);
    if (!quote) return res.status(400).json({ error: 'Formule ou périodicité inconnue.' });
    return res.json(quote);
  }));

  app.post('/api/app/billing/plan', requireCompanyApi, requireCompanyRoles('owner'), asyncRoute(async (req, res) => {
    const planCode = String(req.body.planCode || '');
    const billingCycle = String(req.body.billingCycle || 'monthly');
    const plan = billingPlans.find((p) => p.code === planCode);
    if (!plan || plan.kind === 'trial' || plan.kind === 'custom') {
      return res.status(400).json({ error: 'Cette formule ne peut pas être sélectionnée directement.' });
    }
    if (!Object.prototype.hasOwnProperty.call(billingCycleDiscounts, billingCycle)) {
      return res.status(400).json({ error: 'Périodicité invalide.' });
    }
    const drivers = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM drivers WHERE company_id = $1 AND active = TRUE AND archived_at IS NULL) AS n,
              (SELECT COUNT(*)::int FROM driver_seat_usage WHERE company_id = $1
                 AND month = date_trunc('month', NOW() AT TIME ZONE 'Africa/Porto-Novo')::date) AS seats`,
      [req.auth.company_id]
    );
    const activeDrivers = drivers.rows[0].n;
    // Les places du mois comptent les personnes différentes qui ont livré, même
    // retirées depuis : retirer des profils ne permet pas de passer sous la limite.
    const seats = Math.max(activeDrivers, drivers.rows[0].seats);
    if (seats > planCapacity(planCode)) {
      return res.status(409).json({
        error: activeDrivers >= seats
          ? `Cette formule accepte moins de livreurs que vos ${activeDrivers} livreurs actifs. Retirez des livreurs ou choisissez une formule supérieure.`
          : `Ce mois-ci, ${seats} personnes différentes ont travaillé pour vous : cette formule n’en couvre pas autant. Vous pourrez la choisir à partir du mois prochain.`,
      });
    }
    await pool.query('UPDATE companies SET plan_code = $1, billing_cycle = $2, updated_at = NOW() WHERE id = $3', [planCode, billingCycle, req.auth.company_id]);
    await writeAudit(req.auth, 'company', req.auth.company_id, 'plan_changed', { planCode, billingCycle });
    return res.json({ planCode, billingCycle });
  }));

  // Demande de devis « Grande flotte » : envoyée par e-mail à l'équipe TRAXO
  // (SUPPORT_EMAIL, à défaut le premier administrateur plateforme).
  app.post('/api/app/billing/quote-request', requireCompanyApi, requireCompanyRoles('owner', 'manager'), asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const drivers = Math.round(Number(req.body.drivers));
    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Indiquez une adresse e-mail valide pour vous répondre.' });
    if (!Number.isInteger(drivers) || drivers < 1 || drivers > 100000) return res.status(400).json({ error: 'Indiquez le nombre de livreurs de votre flotte.' });
    const support = String(process.env.SUPPORT_EMAIL || '').trim();
    const recipient = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support)
      ? support
      : String(process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map(normalizeEmail).find(Boolean);
    if (!recipient) return res.status(503).json({ error: 'Les demandes de devis ne sont pas encore ouvertes. Réessayez plus tard.' });
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs
       WHERE company_id = $1 AND action = 'quote_requested' AND created_at > NOW() - INTERVAL '1 hour'`,
      [req.auth.company_id]
    );
    if (recent.rows[0].n >= 3) return res.status(429).json({ error: 'Votre demande a bien été reçue. Patientez avant d’en envoyer une nouvelle.' });
    const company = (await pool.query('SELECT name, slug FROM companies WHERE id = $1', [req.auth.company_id])).rows[0] || {};
    const lines = [
      `Entreprise : ${company.name || '—'} (espace #${req.auth.company_id}, ${company.slug || '—'})`,
      `Demandé par : ${req.auth.display_name || req.auth.email} <${req.auth.email}>`,
      `E-mail de réponse : ${email}`,
      `Livreurs : ${drivers}`,
      `Besoin : ${message || '—'}`,
    ];
    const result = await sendEmail({
      to: recipient,
      subject: `Devis Grande flotte — ${company.name || `espace #${req.auth.company_id}`} (${drivers} livreurs)`,
      html: renderEmailShell({
        baseUrl: publicBaseUrl(req),
        heading: 'Nouvelle demande de devis Grande flotte',
        introHtml: lines.map((l) => escHtmlServer(l)).join('<br>'),
        bodyHtml: '',
        footerNote: 'Répondez directement à l’adresse indiquée par le client.',
      }),
      text: lines.join('\n'),
    });
    if (!result || !result.sent) return res.status(502).json({ error: 'La demande n’a pas pu être envoyée. Réessayez dans quelques minutes.' });
    await writeAudit(req.auth, 'company', req.auth.company_id, 'quote_requested', { drivers });
    return res.status(201).json({ sent: true });
  }));
};
