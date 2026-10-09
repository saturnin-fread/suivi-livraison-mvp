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
  // --- Mouvements (vue « Mouvements ») ---------------------------------------
  const movementView = (m) => ({
    ...entryView(m), type: m.type, count: m.count, day: m.day,
    unitPrice: m.type === 'day' ? (m.min_price === m.max_price ? m.min_price : null) : m.unit_price,
    unitPriceRange: m.type === 'day' && m.min_price !== m.max_price ? [m.min_price, m.max_price] : null,
  });
  const filtersOf = (query) => ({ category: query.category, q: query.q, month: query.month });
  app.get('/api/app/billing/movements', requireCompanyApi, requireCompanyRoles('owner', 'manager'), billingRoute(async (req, res) => {
    const [out, months] = await Promise.all([
      billing.movements(req.auth.company_id, { ...filtersOf(req.query), page: req.query.page, pageSize: req.query.pageSize, group: req.query.group !== '0' }),
      billing.movementMonths(req.auth.company_id),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ items: out.items.map(movementView), total: out.total, page: out.page, pageSize: out.pageSize, grouped: out.grouped, months });
  }));
  app.get('/api/app/billing/movements/day/:day', requireCompanyApi, requireCompanyRoles('owner', 'manager'), billingRoute(async (req, res) => {
    const orders = await billing.dayOrders(req.auth.company_id, req.params.day);
    res.set('Cache-Control', 'no-store');
    res.json({
      day: req.params.day,
      orders: orders.map((o) => ({ id: String(o.id), orderId: o.order_id ? String(o.order_id) : null, orderReference: o.order_reference, amount: o.amount, unitPrice: o.unit_price, refunded: o.refunded, createdAt: o.created_at })),
    });
  }));
  // Export CSV des mouvements filtrés (toutes les pages), une ligne par mouvement.
  const KIND_LABELS = {
    order_charge: 'Commande', order_refund: 'Remboursement', recharge: 'Recharge', bonus: 'Bonus de recharge',
    premium_report: 'Rapport Premium', premium_month: 'Rapport Premium (30 jours)', adjustment: 'Correction TRAXO',
  };
  const csvDate = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Porto-Novo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const csvText = (value) => {
    let s = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // pas de formule dans un tableur
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  app.get('/api/app/billing/movements.csv', requireCompanyApi, requireCompanyRoles('owner', 'manager'), billingRoute(async (req, res) => {
    const rows = await billing.exportMovements(req.auth.company_id, filtersOf(req.query));
    const header = ['Date', 'Type', 'Référence', 'Montant (F)', 'Solde après (F)', 'Prix unitaire (F)', 'Détail'];
    const lines = rows.map((r) => [
      csvText(csvDate.format(new Date(r.created_at))), csvText(KIND_LABELS[r.kind] || r.kind),
      csvText(r.order_reference || r.payment_reference || ''), String(Number(r.amount)), String(Number(r.balance_after)),
      r.unit_price == null ? '' : String(Number(r.unit_price)), csvText(r.note || ''),
    ].join(';'));
    await writeAudit(req.auth, 'wallet', req.auth.company_id, 'wallet_movements_exported', { rows: rows.length, ...filtersOf(req.query) });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Cache-Control', 'no-store');
    res.type('text/csv; charset=utf-8').attachment(`traxo-mouvements-${stamp}.csv`).send(`﻿${header.join(';')}\r\n${lines.join('\r\n')}`);
  }));

  // --- Préférences (alerte de solde bas) -------------------------------------
  app.put('/api/app/billing/preferences', requireCompanyApi, requireCompanyRoles('owner', 'manager'), billingRoute(async (req, res) => {
    const alert = await billing.savePreferences(req.auth.company_id, { alertEnabled: req.body?.alertEnabled, threshold: req.body?.threshold });
    await writeAudit(req.auth, 'wallet', req.auth.company_id, 'wallet_preferences_changed', { alertEnabled: alert.enabled, threshold: alert.custom ? alert.threshold : null });
    res.json({ alert });
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
