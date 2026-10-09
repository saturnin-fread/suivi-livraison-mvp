// Portefeuille prépayé : la logique d'argent, sans HTTP.
//
// Règles (valeurs par défaut, modifiables par l'équipe TRAXO, voir DEFAULTS) :
// - chaque commande créée est débitée une fois, au prix du palier du mois
//   (prix dégressif : la 301e commande du mois coûte le prix du 2e palier) ;
// - pendant l'essai gratuit, les commandes ne sont pas débitées ;
// - annulée avant le départ du livreur, la commande est remboursée ;
// - le solde peut descendre sous zéro d'un découvert équivalent à N commandes,
//   pour ne pas bloquer une journée en cours ; au-delà, si le blocage est
//   activé, la création est refusée ;
// - une recharge (dès 1 000 F) peut donner droit à un bonus par palier.
// Tous les montants sont des entiers en francs CFA.
const crypto = require('crypto');

const TZ = 'Africa/Porto-Novo';

const DEFAULTS = Object.freeze({
  // Refuser les créations de commande au-delà du découvert. Désactivé tant que
  // le paiement en ligne n'est pas ouvert : les débits sont alors enregistrés
  // mais rien n'est bloqué.
  enforcement: false,
  // Prix par commande selon le rang de la commande dans le mois.
  tiers: [{ upTo: 300, price: 25 }, { upTo: 1500, price: 20 }, { upTo: null, price: 15 }],
  freeDuringTrial: true,
  overdraftOrders: 10,
  lowBalanceOrders: 20,
  minRecharge: 1000,
  maxRecharge: 2000000,
  suggestedRecharge: 5000,
  // Bonus offert sur une recharge, selon son montant (le plus haut palier atteint).
  rechargeBonus: [{ from: 5000, percent: 5 }, { from: 20000, percent: 10 }, { from: 50000, percent: 15 }],
  // Les prix affichés sont toutes taxes comprises.
  pricesIncludeTax: true,
  premium: { freeReports: 2, reportPrice: 1500, monthPrice: 2500 },
});

class BillingError extends Error {
  constructor(message, { status = 400, code = 'billing_error', details } = {}) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.code = code;
    if (details) this.details = details;
  }
}

const int = (value, { min = 0, max = 100000000 } = {}) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

// Valide et normalise des réglages (complets ou partiels) ; refuse plutôt que
// de deviner. Renvoie l'objet fusionné avec les valeurs par défaut.
function normalizeSettings(overrides = {}) {
  const s = { ...DEFAULTS, ...overrides, premium: { ...DEFAULTS.premium, ...(overrides.premium || {}) } };
  const fail = (field, message) => { throw new BillingError(message, { code: 'invalid_settings', details: { field } }); };
  if (typeof s.enforcement !== 'boolean') fail('enforcement', 'Le blocage doit être activé ou désactivé.');
  if (typeof s.freeDuringTrial !== 'boolean') fail('freeDuringTrial', 'Réglage d’essai invalide.');
  if (typeof s.pricesIncludeTax !== 'boolean') fail('pricesIncludeTax', 'Réglage de taxe invalide.');
  if (!Array.isArray(s.tiers) || !s.tiers.length || s.tiers.length > 10) fail('tiers', 'Indiquez de 1 à 10 paliers de prix.');
  let previous = 0;
  s.tiers = s.tiers.map((t, i) => {
    const last = i === s.tiers.length - 1;
    const price = int(t && t.price, { min: 0, max: 10000 });
    const upTo = last ? null : int(t && t.upTo, { min: 1 });
    if (price === null) fail('tiers', `Prix du palier ${i + 1} invalide.`);
    if (!last && (upTo === null || upTo <= previous)) fail('tiers', `Les paliers doivent être croissants (palier ${i + 1}).`);
    if (last && t && t.upTo != null) fail('tiers', 'Le dernier palier n’a pas de limite.');
    previous = upTo || previous;
    return { upTo, price };
  });
  for (const key of ['overdraftOrders', 'lowBalanceOrders']) {
    if (int(s[key], { max: 1000 }) === null) fail(key, 'Nombre de commandes invalide (0 à 1 000).');
  }
  if (int(s.minRecharge, { min: 100, max: 1000000 }) === null) fail('minRecharge', 'Recharge minimale invalide.');
  if (int(s.maxRecharge, { min: s.minRecharge, max: 10000000 }) === null) fail('maxRecharge', 'Recharge maximale invalide.');
  if (int(s.suggestedRecharge, { min: s.minRecharge, max: s.maxRecharge }) === null) fail('suggestedRecharge', 'Recharge conseillée invalide.');
  if (!Array.isArray(s.rechargeBonus) || s.rechargeBonus.length > 10) fail('rechargeBonus', 'Indiquez au plus 10 paliers de bonus.');
  let lastFrom = 0;
  s.rechargeBonus = s.rechargeBonus.map((b, i) => {
    const from = int(b && b.from, { min: 1 });
    const percent = int(b && b.percent, { min: 0, max: 100 });
    if (from === null || percent === null || from <= lastFrom) fail('rechargeBonus', `Palier de bonus ${i + 1} invalide.`);
    lastFrom = from;
    return { from, percent };
  });
  for (const key of ['freeReports', 'reportPrice', 'monthPrice']) {
    if (int(s.premium[key], { max: 1000000 }) === null) fail(`premium.${key}`, 'Réglage du rapport Premium invalide.');
  }
  return s;
}

// Prix de la n-ième commande du mois (n commence à 1).
function unitPriceFor(settings, n) {
  for (const t of settings.tiers) if (t.upTo === null || n <= t.upTo) return t.price;
  return settings.tiers[settings.tiers.length - 1].price;
}

function bonusFor(settings, amount) {
  let percent = 0;
  for (const b of settings.rechargeBonus) if (amount >= b.from) percent = b.percent;
  return { percent, bonus: Math.floor((amount * percent) / 100) };
}

// Catégories de la vue « Mouvements » (filtre) : type(s) du journal.
const MOVEMENT_CATEGORIES = Object.freeze({
  orders: ['order_charge'],
  refunds: ['order_refund'],
  recharges: ['recharge'],
  bonus: ['bonus'],
  premium: ['premium_report', 'premium_month'],
  adjustments: ['adjustment'],
});

// Filtres de mouvements reçus de la requête : valeurs inconnues ignorées.
function movementFilters({ category, q, month } = {}) {
  const kinds = MOVEMENT_CATEGORIES[String(category || '')] || null;
  const text = String(q || '').trim().slice(0, 60);
  const like = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.test(String(month || '')) ? String(month) : null;
  return { kinds, like, month: m };
}

function newReference(prefix) {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function createBilling({ pool, provider = null }) {
  let cache = null;
  async function settings(q = pool, { fresh = false } = {}) {
    if (!fresh && cache && cache.until > Date.now()) return cache.value;
    const row = (await q.query('SELECT overrides FROM billing_settings WHERE id = TRUE')).rows[0];
    let value;
    try { value = normalizeSettings(row ? row.overrides : {}); } catch (error) {
      // Réglages stockés devenus invalides : on retombe sur les valeurs par défaut
      // plutôt que de bloquer la création des commandes.
      console.error('Réglages de facturation invalides, valeurs par défaut utilisées :', error.message);
      value = normalizeSettings({});
    }
    cache = { value, until: Date.now() + 30000 };
    return value;
  }

  async function saveSettings(patch, userId) {
    const current = (await pool.query('SELECT overrides FROM billing_settings WHERE id = TRUE')).rows[0];
    const merged = { ...(current ? current.overrides : {}), ...patch };
    if (patch.premium) merged.premium = { ...((current && current.overrides.premium) || {}), ...patch.premium };
    const value = normalizeSettings(merged);
    await pool.query(
      `INSERT INTO billing_settings (id, overrides, updated_by, updated_at) VALUES (TRUE, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET overrides = EXCLUDED.overrides, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [JSON.stringify(merged), userId || null]
    );
    cache = null;
    return value;
  }

  // Verrouille le portefeuille (créé au besoin) pour la durée de la transaction.
  async function lockWallet(client, companyId) {
    await client.query('INSERT INTO wallets (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [companyId]);
    return (await client.query('SELECT company_id, balance FROM wallets WHERE company_id = $1 FOR UPDATE', [companyId])).rows[0];
  }

  // Écrit une ligne du journal et met à jour le solde (transaction en cours).
  async function post(client, wallet, entry) {
    const balanceAfter = Number(wallet.balance) + entry.amount;
    const row = (await client.query(
      `INSERT INTO wallet_entries (company_id, kind, amount, balance_after, order_id, order_reference, payment_id, unit_price, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [wallet.company_id, entry.kind, entry.amount, balanceAfter, entry.orderId || null, entry.orderReference || null,
        entry.paymentId || null, entry.unitPrice ?? null, entry.note || null, entry.userId || null]
    )).rows[0];
    await client.query('UPDATE wallets SET balance = $1, updated_at = NOW() WHERE company_id = $2', [balanceAfter, wallet.company_id]);
    wallet.balance = balanceAfter;
    return row;
  }

  async function monthCharges(q, companyId) {
    const row = (await q.query(
      `SELECT COUNT(*)::int AS n FROM wallet_entries
       WHERE company_id = $1 AND kind = 'order_charge'
         AND created_at >= (date_trunc('month', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`,
      [companyId]
    )).rows[0];
    return row.n;
  }

  async function trialActive(q, companyId) {
    const row = (await q.query(
      `SELECT trial_status = 'active' AND trial_ends_at > NOW() AS active, trial_ends_at FROM companies WHERE id = $1`,
      [companyId]
    )).rows[0];
    return { active: Boolean(row && row.active), endsAt: row ? row.trial_ends_at : null };
  }

  // Débit d'une commande, dans la transaction qui la crée. Renvoie la ligne du
  // journal, ou null si la commande n'est pas facturée (essai gratuit).
  async function chargeOrder(client, { companyId, orderId, orderReference, userId }) {
    const s = await settings(client);
    const wallet = await lockWallet(client, companyId);
    if (s.freeDuringTrial && (await trialActive(client, companyId)).active) return null;
    const already = (await client.query(`SELECT * FROM wallet_entries WHERE order_id = $1 AND kind = 'order_charge'`, [orderId])).rows[0];
    if (already) return already;
    const price = unitPriceFor(s, (await monthCharges(client, companyId)) + 1);
    if (s.enforcement && Number(wallet.balance) - price < -(s.overdraftOrders * price)) {
      throw new BillingError('Solde insuffisant : rechargez votre portefeuille pour créer de nouvelles commandes.', {
        status: 402, code: 'wallet_insufficient', details: { balance: Number(wallet.balance), price },
      });
    }
    return post(client, wallet, { kind: 'order_charge', amount: -price, unitPrice: price, orderId, orderReference, userId });
  }

  // Remboursement d'une commande annulée avant le départ du livreur.
  async function refundOrder(client, { companyId, orderId, userId, reason }) {
    const charge = (await client.query(
      `SELECT * FROM wallet_entries WHERE order_id = $1 AND kind = 'order_charge' AND company_id = $2`, [orderId, companyId]
    )).rows[0];
    if (!charge || Number(charge.amount) === 0) return null;
    const wallet = await lockWallet(client, companyId);
    const refunded = (await client.query(`SELECT id FROM wallet_entries WHERE order_id = $1 AND kind = 'order_refund'`, [orderId])).rows[0];
    if (refunded) return null;
    return post(client, wallet, {
      kind: 'order_refund', amount: -Number(charge.amount), unitPrice: charge.unit_price, orderId,
      orderReference: charge.order_reference, userId, note: reason ? String(reason).slice(0, 200) : 'Annulée avant le départ',
    });
  }

  // Commandes débitées par jour depuis le début du mois (fuseau de Porto-Novo),
  // jours sans commande compris, jusqu'à aujourd'hui.
  async function monthDaily(q, companyId) {
    return (await q.query(
      `WITH bounds AS (SELECT date_trunc('month', NOW() AT TIME ZONE '${TZ}')::date AS first, (NOW() AT TIME ZONE '${TZ}')::date AS today)
       SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS orders
       FROM bounds, generate_series(bounds.first, bounds.today, INTERVAL '1 day') AS d
       LEFT JOIN (
         SELECT (created_at AT TIME ZONE '${TZ}')::date AS day, COUNT(*) AS n FROM wallet_entries
         WHERE company_id = $1 AND kind = 'order_charge'
           AND created_at >= (date_trunc('month', NOW() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')
         GROUP BY 1
       ) c ON c.day = d::date
       ORDER BY d`,
      [companyId]
    )).rows;
  }

  // Seuil d'alerte effectif : celui choisi par l'entreprise, sinon N commandes
  // au prix de la prochaine commande.
  function alertOf(s, wallet, nextPrice) {
    const defaultThreshold = s.lowBalanceOrders * nextPrice;
    const custom = wallet.low_balance_threshold != null;
    return {
      enabled: wallet.low_balance_alert !== false,
      threshold: custom ? Number(wallet.low_balance_threshold) : defaultThreshold,
      custom, defaultThreshold,
    };
  }

  async function summary(companyId) {
    const s = await settings();
    await pool.query('INSERT INTO wallets (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [companyId]);
    const [wallet, count, trial, daily] = await Promise.all([
      pool.query('SELECT balance, low_balance_alert, low_balance_threshold FROM wallets WHERE company_id = $1', [companyId]).then((r) => r.rows[0]),
      monthCharges(pool, companyId),
      trialActive(pool, companyId),
      monthDaily(pool, companyId),
    ]);
    const balance = Number(wallet.balance);
    const nextPrice = unitPriceFor(s, count + 1);
    const floor = -(s.overdraftOrders * nextPrice);
    const ordersLeft = nextPrice > 0 ? Math.max(0, Math.floor((balance - floor) / nextPrice)) : null;
    const alert = alertOf(s, wallet, nextPrice);
    let state = 'ok';
    if (balance < 0) state = 'overdraft';
    else if (balance < alert.threshold) state = 'low';
    if (s.enforcement && ordersLeft === 0) state = 'blocked';
    return {
      currency: 'XOF', balance, state, ordersLeft, enforcement: s.enforcement,
      overdraft: { orders: s.overdraftOrders, amount: -floor },
      month: { orders: count, nextUnitPrice: nextPrice, daily },
      alert,
      trial: { active: trial.active && s.freeDuringTrial, endsAt: trial.endsAt },
      pricing: { tiers: s.tiers, rechargeBonus: s.rechargeBonus, pricesIncludeTax: s.pricesIncludeTax, premium: s.premium },
      recharge: {
        min: s.minRecharge, max: s.maxRecharge, suggested: s.suggestedRecharge,
        provider: provider ? provider.name : null, available: Boolean(provider),
      },
    };
  }

  async function ledger(companyId, { before = null, limit = 50 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = (await pool.query(
      `SELECT e.id, e.kind, e.amount, e.balance_after, e.order_id, e.order_reference, e.unit_price, e.note, e.created_at,
              p.reference AS payment_reference
       FROM wallet_entries e LEFT JOIN wallet_payments p ON p.id = e.payment_id
       WHERE e.company_id = $1 AND ($2::bigint IS NULL OR e.id < $2)
       ORDER BY e.id DESC LIMIT $3`,
      [companyId, before, lim + 1]
    )).rows;
    return { entries: rows.slice(0, lim), more: rows.length > lim };
  }

  // Requête commune aux mouvements filtrés ($1 entreprise, $2 types, $3 recherche, $4 mois).
  const MOVEMENT_BASE = `
    SELECT e.id, e.kind, e.amount, e.balance_after, e.order_id, e.order_reference, e.unit_price, e.note, e.created_at,
           p.reference AS payment_reference, (e.created_at AT TIME ZONE '${TZ}')::date AS day
    FROM wallet_entries e LEFT JOIN wallet_payments p ON p.id = e.payment_id
    WHERE e.company_id = $1
      AND ($2::text[] IS NULL OR e.kind = ANY($2))
      AND ($3::text IS NULL OR e.order_reference ILIKE $3 OR p.reference ILIKE $3 OR e.note ILIKE $3)
      AND ($4::text IS NULL OR (
        e.created_at >= (to_date($4, 'YYYY-MM')::timestamp AT TIME ZONE '${TZ}')
        AND e.created_at < ((to_date($4, 'YYYY-MM') + INTERVAL '1 month')::timestamp AT TIME ZONE '${TZ}')))`;

  // Mouvements de la vue « Mouvements » : filtrés, paginés. Sans recherche,
  // les débits de commandes sont regroupés par jour (une ligne « 36 commandes »),
  // le détail d'un jour restant consultable (dayOrders).
  async function movements(companyId, { category, q, month, page = 1, pageSize = 20, group = true } = {}) {
    const f = movementFilters({ category, q, month });
    const size = Math.max(1, Math.min(100, Number(pageSize) || 20));
    const current = Math.max(1, Math.min(10000, Number(page) || 1));
    const grouped = Boolean(group) && !f.like;
    const rows = (await pool.query(
      `WITH base AS (${MOVEMENT_BASE}), items AS (
         SELECT 'entry' AS type, id, kind, amount, balance_after, order_id, order_reference, unit_price, note, created_at,
                payment_reference, 1 AS count, NULL::text AS day, NULL::int AS min_price, NULL::int AS max_price
         FROM base WHERE NOT ($5 AND kind = 'order_charge')
         UNION ALL
         SELECT 'day', MAX(id), 'order_charge', SUM(amount)::int, NULL, NULL, NULL, NULL, NULL, MAX(created_at),
                NULL, COUNT(*)::int, to_char(day, 'YYYY-MM-DD'), MIN(unit_price), MAX(unit_price)
         FROM base WHERE $5 AND kind = 'order_charge' GROUP BY day
       )
       SELECT *, COUNT(*) OVER ()::int AS total FROM items ORDER BY created_at DESC, id DESC LIMIT $6 OFFSET $7`,
      [companyId, f.kinds, f.like, f.month, grouped, size, (current - 1) * size]
    )).rows;
    return { items: rows, total: rows.length ? rows[0].total : 0, page: current, pageSize: size, grouped };
  }

  // Commandes débitées un jour donné (détail d'une ligne regroupée).
  async function dayOrders(companyId, day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new BillingError('Jour invalide.', { code: 'invalid_day' });
    return (await pool.query(
      `SELECT e.id, e.order_id, e.order_reference, e.amount, e.unit_price, e.created_at,
              EXISTS (SELECT 1 FROM wallet_entries r WHERE r.order_id = e.order_id AND r.kind = 'order_refund') AS refunded
       FROM wallet_entries e
       WHERE e.company_id = $1 AND e.kind = 'order_charge' AND (e.created_at AT TIME ZONE '${TZ}')::date = $2::date
       ORDER BY e.id DESC LIMIT 1000`,
      [companyId, day]
    )).rows;
  }

  // Mouvements filtrés, un par ligne, pour l'export (toutes les pages).
  async function exportMovements(companyId, { category, q, month } = {}) {
    const f = movementFilters({ category, q, month });
    return (await pool.query(`${MOVEMENT_BASE} ORDER BY e.id DESC LIMIT 50000`, [companyId, f.kinds, f.like, f.month])).rows;
  }

  // Mois ayant au moins un mouvement (filtre « Période »), du plus récent au plus ancien.
  async function movementMonths(companyId) {
    return (await pool.query(
      `SELECT DISTINCT to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS month FROM wallet_entries
       WHERE company_id = $1 ORDER BY 1 DESC LIMIT 36`,
      [companyId]
    )).rows.map((r) => r.month);
  }

  // Préférences de l'entreprise : alerte de solde bas et son seuil (null = seuil par défaut).
  async function savePreferences(companyId, { alertEnabled, threshold } = {}) {
    if (typeof alertEnabled !== 'boolean') throw new BillingError('Indiquez si l’alerte est activée.', { code: 'invalid_preferences' });
    let value = null;
    if (threshold !== null && threshold !== undefined && threshold !== '') {
      value = int(threshold, { min: 0, max: 10000000 });
      if (value === null) throw new BillingError('Indiquez un seuil entre 0 et 10 000 000 F.', { code: 'invalid_threshold' });
    }
    await pool.query('INSERT INTO wallets (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [companyId]);
    await pool.query(
      `UPDATE wallets SET low_balance_alert = $2, low_balance_threshold = $3, low_balance_notified_at = NULL, updated_at = NOW() WHERE company_id = $1`,
      [companyId, alertEnabled, value]
    );
    return (await summary(companyId)).alert;
  }

  // Alerte de solde bas à afficher dans les notifications, ou null. La clé
  // change à chaque recharge : une alerte lue réapparaît après la recharge
  // suivante si le solde redescend. Un espace jamais crédité (ni recharge ni
  // correction TRAXO) n'est pas alerté : tant que le paiement en ligne n'est
  // pas ouvert, ce serait une alerte permanente que personne ne peut traiter.
  async function lowBalanceNotice(companyId) {
    const last = (await pool.query(
      `SELECT MAX(id) AS id FROM wallet_entries WHERE company_id = $1 AND kind IN ('recharge', 'adjustment') AND amount > 0`, [companyId]
    )).rows[0];
    if (!last.id) return null;
    const w = await summary(companyId);
    if (!w.alert.enabled || w.trial.active || w.balance >= w.alert.threshold) return null;
    const since = (await pool.query(
      `SELECT MIN(created_at) AS at FROM wallet_entries WHERE company_id = $1 AND balance_after < $2 AND id > COALESCE($3, 0)`,
      [companyId, w.alert.threshold, last.id]
    )).rows[0];
    return { key: String(last.id || 0), balance: w.balance, threshold: w.alert.threshold, state: w.state, at: since.at || new Date() };
  }

  async function createRecharge(companyId, amount, userId) {
    if (!provider) throw new BillingError('Le paiement en ligne n’est pas encore ouvert. Contactez le support pour recharger.', { status: 503, code: 'payments_unavailable' });
    const s = await settings();
    const value = int(amount, { min: 1 });
    if (value === null || value < s.minRecharge || value > s.maxRecharge) {
      throw new BillingError(`Indiquez un montant entre ${s.minRecharge.toLocaleString('fr-FR')} F et ${s.maxRecharge.toLocaleString('fr-FR')} F.`, { code: 'invalid_amount' });
    }
    const { bonus } = bonusFor(s, value);
    const payment = (await pool.query(
      `INSERT INTO wallet_payments (company_id, reference, provider, amount, bonus, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [companyId, newReference('REC'), provider.name, value, bonus, userId || null]
    )).rows[0];
    return { payment, checkout: provider.checkout(payment) };
  }

  // Confirme une recharge auprès du prestataire puis crédite le portefeuille.
  // Idempotent : une recharge déjà créditée est renvoyée telle quelle.
  async function confirmRecharge(companyId, paymentId, { transactionId } = {}) {
    if (!provider) throw new BillingError('Le paiement en ligne n’est pas encore ouvert.', { status: 503, code: 'payments_unavailable' });
    const found = (await pool.query('SELECT * FROM wallet_payments WHERE id = $1 AND company_id = $2', [paymentId, companyId])).rows[0];
    if (!found) throw new BillingError('Recharge introuvable.', { status: 404, code: 'not_found' });
    if (found.status === 'succeeded') return { payment: found, credited: false };
    if (found.provider !== provider.name) throw new BillingError('Cette recharge ne peut plus être confirmée.', { status: 409, code: 'provider_changed' });
    const verified = await provider.verify({ payment: found, transactionId });
    if (!verified.ok) {
      if (verified.final) {
        await pool.query(`UPDATE wallet_payments SET status = 'failed', failure_reason = $1 WHERE id = $2 AND status = 'pending'`, [verified.reason || 'refusé', found.id]);
      }
      throw new BillingError(verified.message || 'Le paiement n’a pas été confirmé.', { status: 402, code: 'payment_not_confirmed' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payment = (await client.query('SELECT * FROM wallet_payments WHERE id = $1 FOR UPDATE', [found.id])).rows[0];
      if (payment.status === 'succeeded') { await client.query('COMMIT'); return { payment, credited: false }; }
      const used = verified.transactionId
        ? (await client.query('SELECT id FROM wallet_payments WHERE provider = $1 AND provider_ref = $2 AND id <> $3', [payment.provider, verified.transactionId, payment.id])).rows[0]
        : null;
      if (used) throw new BillingError('Ce paiement a déjà servi à une autre recharge.', { status: 409, code: 'transaction_reused' });
      const updated = (await client.query(
        `UPDATE wallet_payments SET status = 'succeeded', provider_ref = $1, confirmed_at = NOW(), failure_reason = NULL WHERE id = $2 RETURNING *`,
        [verified.transactionId || null, payment.id]
      )).rows[0];
      const wallet = await lockWallet(client, companyId);
      await post(client, wallet, { kind: 'recharge', amount: payment.amount, paymentId: payment.id, userId: payment.created_by });
      if (payment.bonus > 0) {
        await post(client, wallet, { kind: 'bonus', amount: payment.bonus, paymentId: payment.id, note: 'Bonus de recharge' });
      }
      await client.query('UPDATE wallets SET low_balance_notified_at = NULL WHERE company_id = $1', [companyId]);
      await client.query('COMMIT');
      return { payment: updated, credited: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function payment(companyId, paymentId) {
    return (await pool.query('SELECT * FROM wallet_payments WHERE id = $1 AND company_id = $2', [paymentId, companyId])).rows[0] || null;
  }

  // Geste commercial ou correction par l'équipe TRAXO (montant signé).
  async function adjust(companyId, amount, note, userId) {
    const value = int(amount, { min: -10000000, max: 10000000 });
    if (!value) throw new BillingError('Montant invalide.', { code: 'invalid_amount' });
    const text = String(note || '').trim();
    if (text.length < 5) throw new BillingError('Expliquez la correction en au moins 5 caractères.', { code: 'note_required' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exists = (await client.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows[0];
      if (!exists) throw new BillingError('Entreprise introuvable.', { status: 404, code: 'not_found' });
      const wallet = await lockWallet(client, companyId);
      const entry = await post(client, wallet, { kind: 'adjustment', amount: value, note: text.slice(0, 300), userId });
      await client.query('COMMIT');
      return entry;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ---- Rapport Premium (Excel enrichi) ---------------------------------
  // N rapports offerts au total (aucun si l'essai gratuit a déjà servi
  // ailleurs), puis 1 rapport payé ou un mois illimité, débités du
  // portefeuille. Un achat Premium ne peut pas entamer le découvert : le
  // découvert sert à finir une journée de livraisons, pas aux options.
  async function premiumStatus(q, companyId) {
    const s = await settings(q);
    const row = (await q.query(
      `SELECT c.trial_status, COALESCE(a.premium_free_used, 0) AS used, a.premium_month_until AS until,
              COALESCE(w.balance, 0) AS balance
       FROM companies c
       LEFT JOIN company_export_access a ON a.company_id = c.id
       LEFT JOIN wallets w ON w.company_id = c.id
       WHERE c.id = $1`,
      [companyId]
    )).rows[0] || {};
    const trialReused = row.trial_status === 'used_elsewhere';
    const freeTotal = trialReused ? 0 : s.premium.freeReports;
    const used = Number(row.used || 0);
    const monthActive = Boolean(row.until && new Date(row.until).getTime() > Date.now());
    const freeLeft = Math.max(0, freeTotal - used);
    const balance = Number(row.balance || 0);
    return {
      state: monthActive ? 'month' : freeLeft > 0 ? 'free' : 'paid',
      freeTotal, freeUsed: Math.min(used, freeTotal), freeLeft, trialReused,
      monthUntil: monthActive ? row.until : null,
      reportPrice: s.premium.reportPrice, monthPrice: s.premium.monthPrice,
      balance, canPayReport: balance >= s.premium.reportPrice, canPayMonth: balance >= s.premium.monthPrice,
      paymentsAvailable: Boolean(provider),
    };
  }

  async function lockPremium(client, companyId) {
    await client.query('INSERT INTO company_export_access (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING', [companyId]);
    await client.query('SELECT company_id FROM company_export_access WHERE company_id = $1 FOR UPDATE', [companyId]);
  }

  async function payPremium(client, companyId, kind, price, { userId, note }) {
    const wallet = await lockWallet(client, companyId);
    if (Number(wallet.balance) < price) {
      throw new BillingError(`Solde insuffisant : il faut ${price.toLocaleString('fr-FR')} F sur votre portefeuille.`, {
        status: 402, code: 'wallet_insufficient', details: { balance: Number(wallet.balance), price },
      });
    }
    return post(client, wallet, { kind, amount: -price, unitPrice: price, userId, note });
  }

  // Décompte d'un rapport réellement produit (dans la transaction de l'export).
  // pay === 'report' : accord explicite pour payer ce rapport s'il n'est plus
  // couvert par le mois ou les rapports offerts.
  async function consumePremiumReport(client, companyId, { pay = null, userId, note } = {}) {
    await lockPremium(client, companyId);
    const st = await premiumStatus(client, companyId);
    if (st.state === 'month') return { via: 'month', status: st };
    if (st.state === 'free') {
      await client.query('UPDATE company_export_access SET premium_free_used = premium_free_used + 1, updated_at = NOW() WHERE company_id = $1', [companyId]);
      return { via: 'free', status: { ...st, freeUsed: st.freeUsed + 1, freeLeft: st.freeLeft - 1 } };
    }
    if (pay !== 'report') {
      throw new BillingError(st.trialReused
        ? 'Les rapports offerts ont déjà été utilisés avec cette adresse, ce numéro ou cet appareil.'
        : 'Vos rapports offerts sont utilisés. Ce rapport est payant.', { status: 402, code: 'premium_required', details: st });
    }
    const entry = await payPremium(client, companyId, 'premium_report', st.reportPrice, { userId, note });
    return { via: 'paid', entry, status: st };
  }

  // Mois illimité : 30 jours à partir de l'achat, ou prolongé de 30 jours s'il est en cours.
  async function buyPremiumMonth(companyId, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockPremium(client, companyId);
      const st = await premiumStatus(client, companyId);
      const entry = await payPremium(client, companyId, 'premium_month', st.monthPrice, { userId, note: 'Rapport Premium : 30 jours' });
      const row = (await client.query(
        `UPDATE company_export_access SET premium_month_until = GREATEST(COALESCE(premium_month_until, NOW()), NOW()) + INTERVAL '30 days', updated_at = NOW()
         WHERE company_id = $1 RETURNING premium_month_until`,
        [companyId]
      )).rows[0];
      await client.query('COMMIT');
      return { entry, monthUntil: row.premium_month_until };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Contrôle d'intégrité : le solde en cache doit valoir la somme du journal.
  async function audit(companyId) {
    const row = (await pool.query(
      `SELECT COALESCE((SELECT balance FROM wallets WHERE company_id = $1), 0) AS cached,
              COALESCE((SELECT SUM(amount) FROM wallet_entries WHERE company_id = $1), 0)::int AS journal`,
      [companyId]
    )).rows[0];
    return { cached: Number(row.cached), journal: Number(row.journal), ok: Number(row.cached) === Number(row.journal) };
  }

  return {
    settings, saveSettings, chargeOrder, refundOrder, summary, ledger,
    movements, dayOrders, exportMovements, movementMonths, savePreferences, lowBalanceNotice,
    createRecharge, confirmRecharge, payment, adjust, audit,
    premiumStatus: (companyId) => premiumStatus(pool, companyId), consumePremiumReport, buyPremiumMonth,
    get providerName() { return provider ? provider.name : null; },
  };
}

module.exports = { createBilling, normalizeSettings, unitPriceFor, bonusFor, BillingError, DEFAULTS, MOVEMENT_CATEGORIES };
