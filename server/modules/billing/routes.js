// Facturation : portefeuille prépayé (paiement à la commande, recharges,
// historique), réglages et corrections pour l'équipe TRAXO.
const { createBilling, BillingError } = require('./service');
const { createPaymentProvider } = require('./payments');

module.exports = function registerBilling(app, deps) {
  const {
    pool, asyncRoute, requireCompanyApi, requireCompanyRoles, requirePlatformAdminApi, writeAudit,
  } = deps;

  const billing = pool ? createBilling({ pool, provider: createPaymentProvider(process.env) }) : null;
  function billingRoute(handler) {
    return asyncRoute(async (req, res) => {
      if (!billing) return res.status(503).json({ error: 'La facturation est momentanément indisponible.' });
      try { return await handler(req, res); } catch (error) {
        if (error instanceof BillingError) return res.status(error.status).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
        throw error;
      }
    });
  }
  const paymentView = (p) => p && ({
    id: String(p.id), reference: p.reference, provider: p.provider, amount: p.amount, bonus: p.bonus,
    status: p.status, createdAt: p.created_at, confirmedAt: p.confirmed_at,
  });
  const entryView = (e) => ({
    id: String(e.id), kind: e.kind, amount: e.amount, balanceAfter: e.balance_after, unitPrice: e.unit_price,
    orderId: e.order_id ? String(e.order_id) : null, orderReference: e.order_reference, paymentReference: e.payment_reference || null,
    note: e.note, createdAt: e.created_at,
  });

  // --- Portefeuille ---------------------------------------------------------
  app.get('/api/app/billing/wallet', requireCompanyApi, billingRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await billing.summary(req.auth.company_id));
  }));
  app.get('/api/app/billing/ledger', requireCompanyApi, requireCompanyRoles('owner', 'manager'), billingRoute(async (req, res) => {
    const before = /^\d{1,18}$/.test(String(req.query.before || '')) ? String(req.query.before) : null;
    const out = await billing.ledger(req.auth.company_id, { before, limit: req.query.limit });
    res.set('Cache-Control', 'no-store');
    res.json({ entries: out.entries.map(entryView), more: out.more });
  }));
  app.post('/api/app/billing/recharges', requireCompanyApi, requireCompanyRoles('owner', 'manager'), billingRoute(async (req, res) => {
    const out = await billing.createRecharge(req.auth.company_id, req.body?.amount, req.auth.user_id);
    await writeAudit(req.auth, 'wallet_payment', out.payment.id, 'recharge_started', { amount: out.payment.amount, provider: out.payment.provider });
    res.status(201).json({ payment: paymentView(out.payment), checkout: out.checkout });
  }));
  app.post('/api/app/billing/recharges/:id/confirm', requireCompanyApi, requireCompanyRoles('owner', 'manager'), billingRoute(async (req, res) => {
    if (!/^\d{1,18}$/.test(String(req.params.id))) return res.status(404).json({ error: 'Recharge introuvable.' });
    const out = await billing.confirmRecharge(req.auth.company_id, req.params.id, { transactionId: req.body?.transactionId });
    if (out.credited) await writeAudit(req.auth, 'wallet_payment', out.payment.id, 'recharge_credited', { amount: out.payment.amount, bonus: out.payment.bonus });
    res.json({ payment: paymentView(out.payment), credited: out.credited, wallet: await billing.summary(req.auth.company_id) });
  }));
  app.get('/api/app/billing/recharges/:id', requireCompanyApi, requireCompanyRoles('owner', 'manager'), billingRoute(async (req, res) => {
    if (!/^\d{1,18}$/.test(String(req.params.id))) return res.status(404).json({ error: 'Recharge introuvable.' });
    const p = await billing.payment(req.auth.company_id, req.params.id);
    if (!p) return res.status(404).json({ error: 'Recharge introuvable.' });
    res.json({ payment: paymentView(p) });
  }));

  // --- Équipe TRAXO : réglages et corrections -----------------------------
  app.get('/api/app/platform/billing/settings', requirePlatformAdminApi, billingRoute(async (_req, res) => {
    res.json({ settings: await billing.settings(pool, { fresh: true }) });
  }));
  app.put('/api/app/platform/billing/settings', requirePlatformAdminApi, billingRoute(async (req, res) => {
    const settings = await billing.saveSettings(req.body?.settings || {}, req.auth.user_id);
    await writeAudit(req.auth, 'billing_settings', 1, 'billing_settings_changed', { keys: Object.keys(req.body?.settings || {}) });
    res.json({ settings });
  }));
  app.post('/api/app/platform/billing/adjustments', requirePlatformAdminApi, billingRoute(async (req, res) => {
    const companyId = String(req.body?.companyId || '');
    if (!/^\d{1,18}$/.test(companyId)) return res.status(400).json({ error: 'Entreprise invalide.' });
    const entry = await billing.adjust(companyId, req.body?.amount, req.body?.note, req.auth.user_id);
    await writeAudit(req.auth, 'wallet', companyId, 'wallet_adjusted', { amount: entry.amount, entryId: String(entry.id) });
    res.status(201).json({ entry: entryView(entry), wallet: await billing.summary(companyId) });
  }));

  return { billing };
};
