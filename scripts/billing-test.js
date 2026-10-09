// Portefeuille : débit à la création, essai gratuit, prix dégressif, remboursement
// avant départ, découvert et blocage, recharges (prestataire de test), bonus,
// corrections TRAXO, droits, intégrité du journal.
// Le serveur doit tourner avec BILLING_TEST_PAYMENTS=on.
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const { normalizeSettings, unitPriceFor, bonusFor } = require('../server/modules/billing/service');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}
const key = () => crypto.randomBytes(12).toString('hex');

// Règles pures : paliers, bonus, validation des réglages.
function unitChecks() {
  const s = normalizeSettings({});
  assert.deepStrictEqual([1, 300, 301, 1500, 1501, 9999].map((n) => unitPriceFor(s, n)), [25, 25, 20, 20, 15, 15], 'paliers par défaut');
  assert.deepStrictEqual([999, 4999, 5000, 20000, 60000].map((a) => bonusFor(s, a).bonus), [0, 0, 250, 2000, 9000], 'bonus par défaut');
  assert.throws(() => normalizeSettings({ tiers: [{ upTo: 10, price: 25 }, { upTo: 5, price: 20 }, { upTo: null, price: 15 }] }), /croissants/);
  assert.throws(() => normalizeSettings({ tiers: [{ upTo: 10, price: 25 }] }), /dernier palier/);
  assert.throws(() => normalizeSettings({ enforcement: 'oui' }), /blocage/);
  assert.throws(() => normalizeSettings({ minRecharge: 50 }), /minimale/);
}

(async () => {
  unitChecks();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const marker = Date.now().toString(36);
  const made = { users: [], companies: [], sessions: [] };
  const savedOverrides = (await pool.query('SELECT overrides FROM billing_settings WHERE id = TRUE')).rows[0].overrides;

  async function sessionFor(companyId, role, { platform = false } = {}) {
    const u = (await pool.query(`INSERT INTO users (email, display_name, password_salt, password_hash, is_platform_admin) VALUES ($1, $2, 'test', $3, $4) RETURNING id`,
      [`billing-${role}-${marker}-${made.users.length}@example.invalid`, `${role} ${marker}`, '0'.repeat(128), platform])).rows[0].id;
    made.users.push(u);
    await pool.query('INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, $3)', [companyId, u, role]);
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    made.sessions.push(hash);
    await pool.query(`INSERT INTO app_sessions (token_hash, user_id, company_id, scope, expires_at) VALUES ($1, $2, $3, 'company', NOW() + INTERVAL '20 minutes')`, [hash, u, companyId]);
    return `delivery_session=${token}`;
  }
  const newCompany = async (label) => {
    const id = (await pool.query('INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id', [`${label} ${marker}`, `${label.toLowerCase()}-${marker}`])).rows[0].id;
    made.companies.push(id);
    return id;
  };

  try {
    const cid = await newCompany('Facturation');
    const owner = await sessionFor(cid, 'owner');
    const operator = await sessionFor(cid, 'operator');
    const viewer = await sessionFor(cid, 'viewer');
    const traxoCo = await newCompany('TRAXO');
    const agent = await sessionFor(traxoCo, 'owner', { platform: true });
    const driverId = (await pool.query(`INSERT INTO drivers (company_id, name, traccar_unique_id, phone) VALUES ($1, $2, $3, '+22901970001') RETURNING id`, [cid, `Livreur ${marker}`, `bill-${marker}`])).rows[0].id;
    const settings = (patch) => call('PUT', '/api/app/platform/billing/settings', { cookie: agent, body: { settings: patch } });
    const order = async (n) => call('POST', '/api/app/orders', { cookie: owner, body: { customerName: `Client ${n} ${marker}`, neighborhood: 'Ganhi', driverId } });
    const wallet = async () => (await call('GET', '/api/app/billing/wallet', { cookie: owner })).data;

    // Réglages connus pour le test (et seulement modifiables par TRAXO).
    assert.strictEqual((await call('PUT', '/api/app/platform/billing/settings', { cookie: owner, body: { settings: {} } })).status, 403, 'réglages réservés à TRAXO');
    let r = await settings({ enforcement: false, tiers: [{ upTo: 2, price: 25 }, { upTo: null, price: 10 }], overdraftOrders: 1, freeDuringTrial: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await settings({ tiers: [{ upTo: 2, price: 25 }] })).status, 400, 'réglage incohérent refusé');

    // Portefeuille vide.
    let w = await wallet();
    assert.strictEqual(w.balance, 0); assert.strictEqual(w.month.nextUnitPrice, 25); assert.strictEqual(w.trial.active, false);
    assert.strictEqual((await call('GET', '/api/app/billing/wallet', { cookie: viewer })).status, 200, 'lecture seule : voit le solde');
    assert.strictEqual((await call('GET', '/api/app/billing/ledger', { cookie: viewer })).status, 403, 'lecture seule : pas l’historique');

    // 1re commande : 25 F.
    r = await order(1);
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    const o1 = r.data.orderId || r.data.id;
    w = await wallet();
    assert.strictEqual(w.balance, -25, 'débit de 25 F');
    let led = (await call('GET', '/api/app/billing/ledger', { cookie: owner })).data.entries;
    assert.strictEqual(led[0].kind, 'order_charge'); assert.strictEqual(led[0].orderId, String(o1));
    assert.ok(/^CMD-\d{4}-\d{4}$/.test(led[0].orderReference), 'référence de la commande dans l’historique');

    // Essai gratuit : pas de débit.
    await pool.query(`UPDATE companies SET trial_status = 'active', trial_ends_at = NOW() + INTERVAL '1 day' WHERE id = $1`, [cid]);
    r = await order(2);
    assert.strictEqual((await wallet()).balance, -25, 'essai gratuit : commande non débitée');
    await pool.query(`UPDATE companies SET trial_status = 'expired', trial_ends_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [cid]);

    // Prix dégressif : 2e commande facturée du mois à 25 F, 3e à 10 F.
    r = await order(3); const o3 = r.data.orderId || r.data.id;
    r = await order(4); const o4 = r.data.orderId || r.data.id;
    w = await wallet();
    assert.strictEqual(w.balance, -25 - 25 - 10, `palier dégressif (${w.balance})`);
    assert.strictEqual(w.month.orders, 3); assert.strictEqual(w.month.nextUnitPrice, 10);

    // Annulée avant départ : remboursée, une seule fois.
    r = await call('POST', `/api/app/orders/${o4}/transition`, { cookie: owner, body: { toStatus: 'Annulée', reason: 'Client injoignable', idempotencyKey: key() } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await wallet()).balance, -50, 'remboursement de 10 F');
    // Annulée après le départ : pas de remboursement.
    await pool.query(`UPDATE orders SET status = 'Vers la collecte' WHERE id = $1`, [o3]);
    r = await call('POST', `/api/app/orders/${o3}/transition`, { cookie: owner, body: { toStatus: 'Annulée', reason: 'Annulée en route', idempotencyKey: key() } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await wallet()).balance, -50, 'pas de remboursement après le départ');

    // Blocage : découvert d'1 commande (10 F), solde -50 → refus, sans commande créée.
    await settings({ enforcement: true });
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE company_id = $1', [cid])).rows[0].n;
    r = await order(5);
    assert.strictEqual(r.status, 402, JSON.stringify(r.data)); assert.strictEqual(r.data.code, 'wallet_insufficient');
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE company_id = $1', [cid])).rows[0].n, before, 'aucune commande créée');
    assert.strictEqual((await wallet()).state, 'blocked');

    // Recharges (prestataire de test).
    assert.strictEqual((await call('POST', '/api/app/billing/recharges', { cookie: operator, body: { amount: 5000 } })).status, 403, 'opérateur : pas de recharge');
    assert.strictEqual((await call('POST', '/api/app/billing/recharges', { cookie: owner, body: { amount: 500 } })).status, 400, 'sous le minimum');
    r = await call('POST', '/api/app/billing/recharges', { cookie: owner, body: { amount: 5000 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.checkout.provider, 'test'); assert.strictEqual(r.data.payment.bonus, 250, 'bonus 5 % dès 5 000 F');
    const p1 = r.data.payment.id;
    r = await call('POST', `/api/app/billing/recharges/${p1}/confirm`, { cookie: owner, body: { transactionId: `tx-${marker}` } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.credited, true);
    assert.strictEqual(r.data.wallet.balance, -50 + 5000 + 250, 'recharge et bonus crédités');
    r = await call('POST', `/api/app/billing/recharges/${p1}/confirm`, { cookie: owner, body: { transactionId: `tx-${marker}` } });
    assert.strictEqual(r.data.credited, false, 'confirmation rejouée : pas de double crédit');
    // Une même transaction ne crédite pas deux recharges.
    const p2 = (await call('POST', '/api/app/billing/recharges', { cookie: owner, body: { amount: 1000 } })).data.payment.id;
    r = await call('POST', `/api/app/billing/recharges/${p2}/confirm`, { cookie: owner, body: { transactionId: `tx-${marker}` } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.data)); assert.strictEqual(r.data.code, 'transaction_reused');
    // Paiement refusé : rien n'est crédité, la recharge passe en échec.
    r = await call('POST', `/api/app/billing/recharges/${p2}/confirm`, { cookie: owner, body: { transactionId: 'refuse' } });
    assert.strictEqual(r.status, 402);
    assert.strictEqual((await call('GET', `/api/app/billing/recharges/${p2}`, { cookie: owner })).data.payment.status, 'failed');
    // Recharge d'une autre entreprise : introuvable.
    const otherCo = await newCompany('Autre');
    const other = await sessionFor(otherCo, 'owner');
    assert.strictEqual((await call('POST', `/api/app/billing/recharges/${p1}/confirm`, { cookie: other, body: {} })).status, 404, 'isolée par entreprise');

    // Après recharge : création de nouveau possible.
    r = await order(6);
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    assert.strictEqual((await wallet()).balance, 5200 - 10);

    // Correction par TRAXO.
    assert.strictEqual((await call('POST', '/api/app/platform/billing/adjustments', { cookie: owner, body: { companyId: cid, amount: 1000, note: 'Geste commercial' } })).status, 403);
    assert.strictEqual((await call('POST', '/api/app/platform/billing/adjustments', { cookie: agent, body: { companyId: cid, amount: 1000, note: 'x' } })).status, 400, 'motif requis');
    r = await call('POST', '/api/app/platform/billing/adjustments', { cookie: agent, body: { companyId: cid, amount: 1000, note: 'Geste commercial test' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data)); assert.strictEqual(r.data.wallet.balance, 6190);

    // Intégrité : solde = somme du journal ; journal non modifiable.
    const audit = (await pool.query(`SELECT (SELECT balance FROM wallets WHERE company_id = $1) AS cached, (SELECT SUM(amount) FROM wallet_entries WHERE company_id = $1)::int AS journal`, [cid])).rows[0];
    assert.strictEqual(Number(audit.cached), audit.journal, 'solde = somme du journal');
    await assert.rejects(() => pool.query('UPDATE wallet_entries SET amount = 0 WHERE company_id = $1', [cid]), /journal/);
    await assert.rejects(() => pool.query('DELETE FROM wallet_entries WHERE company_id = $1', [cid]), /journal/);
    led = (await call('GET', '/api/app/billing/ledger?limit=2', { cookie: owner })).data;
    assert.strictEqual(led.entries.length, 2); assert.strictEqual(led.more, true, 'historique paginé');

    // Activité du mois : commandes débitées par jour, jours vides compris.
    w = await wallet();
    assert.strictEqual(w.month.daily.reduce((n, d) => n + d.orders, 0), 4, 'activité : 4 commandes débitées ce mois-ci');
    assert.strictEqual(w.month.daily[w.month.daily.length - 1].orders, 4, 'activité : aujourd’hui en dernier');
    assert.strictEqual(w.month.daily.length, new Date(w.month.daily[w.month.daily.length - 1].day).getUTCDate(), 'un point par jour depuis le 1er');
    assert.deepStrictEqual([w.alert.enabled, w.alert.custom, w.alert.threshold], [true, false, 20 * w.month.nextUnitPrice], 'seuil d’alerte par défaut');

    // Mouvements : regroupés par jour, filtrés, paginés, isolés par rôle.
    const mv = async (qs = '', cookie = owner) => call('GET', `/api/app/billing/movements${qs}`, { cookie });
    assert.strictEqual((await mv('', viewer)).status, 403, 'lecture seule : pas les mouvements');
    r = await mv();
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.total, 5, `4 débits regroupés + remboursement, recharge, bonus, correction (${r.data.total})`);
    const dayRow = r.data.items.find((i) => i.type === 'day');
    assert.deepStrictEqual([dayRow.count, dayRow.amount, dayRow.unitPrice, dayRow.unitPriceRange], [4, -70, null, [10, 25]], 'ligne du jour');
    assert.ok(r.data.months.length >= 1, 'mois disponibles');
    r = await mv('?category=orders');
    assert.deepStrictEqual([r.data.total, r.data.items[0].count], [1, 4], 'filtre commandes');
    assert.strictEqual((await mv('?category=refunds')).data.items[0].kind, 'order_refund', 'filtre remboursements');
    assert.strictEqual((await mv('?category=inconnu')).data.total, 5, 'catégorie inconnue ignorée');
    const ref1 = led.entries.length && (await pool.query(`SELECT order_reference FROM wallet_entries WHERE order_id = $1 AND kind = 'order_charge'`, [o1])).rows[0].order_reference;
    r = await mv(`?q=${encodeURIComponent(ref1)}`);
    assert.strictEqual(r.data.grouped, false, 'recherche : pas de regroupement');
    assert.ok(r.data.items.every((i) => i.orderReference === ref1) && r.data.total === 1, 'recherche par référence');
    assert.strictEqual((await mv('?q=%25')).data.total, 0, 'joker échappé');
    r = await mv('?pageSize=2&page=3');
    assert.deepStrictEqual([r.data.items.length, r.data.total, r.data.page], [1, 5, 3], 'pagination');
    assert.strictEqual((await mv('?month=2000-01')).data.total, 0, 'filtre période');
    assert.strictEqual((await mv(`?month=${w.month.daily[0].day.slice(0, 7)}`)).data.total, 5, 'mois en cours');
    r = await call('GET', `/api/app/billing/movements/day/${dayRow.day}`, { cookie: owner });
    assert.strictEqual(r.data.orders.length, 4, 'détail du jour');
    assert.strictEqual(r.data.orders.filter((o) => o.refunded).length, 1, 'commande remboursée signalée');
    assert.strictEqual((await call('GET', '/api/app/billing/movements/day/demain', { cookie: owner })).status, 400);
    assert.strictEqual((await call('GET', `/api/app/billing/movements/day/${dayRow.day}`, { cookie: other })).data.orders.length, 0, 'jour isolé par entreprise');

    // Export CSV : toutes les lignes filtrées, sans formule de tableur.
    await call('POST', '/api/app/platform/billing/adjustments', { cookie: agent, body: { companyId: cid, amount: 1, note: '=1+1 essai' } });
    const csvRes = await fetch(`${base}/api/app/billing/movements.csv`, { headers: { Cookie: owner } });
    const csv = await csvRes.text();
    assert.strictEqual(csvRes.status, 200); assert.ok(/text\/csv/.test(csvRes.headers.get('content-type')));
    assert.strictEqual(csv.trim().split('\r\n').length, 1 + 9, 'en-tête + 9 mouvements');
    assert.ok(csv.includes("'=1+1 essai") && !/;=1\+1/.test(csv), 'formule neutralisée');
    const csvOrders = await (await fetch(`${base}/api/app/billing/movements.csv?category=orders`, { headers: { Cookie: owner } })).text();
    assert.strictEqual(csvOrders.trim().split('\r\n').length, 1 + 4, 'export filtré : une ligne par commande');
    assert.strictEqual((await fetch(`${base}/api/app/billing/movements.csv`, { headers: { Cookie: viewer } })).status, 403);

    // Préférences : seuil d'alerte, notification au propriétaire seulement.
    const prefs = (body, cookie = owner) => call('PUT', '/api/app/billing/preferences', { cookie, body });
    assert.strictEqual((await prefs({ alertEnabled: true, threshold: 1000 }, operator)).status, 403);
    assert.strictEqual((await prefs({ alertEnabled: true, threshold: -5 })).status, 400);
    assert.strictEqual((await prefs({ threshold: 1000 })).status, 400, 'activation requise');
    r = await prefs({ alertEnabled: true, threshold: 10000 });
    assert.deepStrictEqual([r.status, r.data.alert.threshold, r.data.alert.custom], [200, 10000, true]);
    assert.strictEqual((await wallet()).state, 'low', 'sous le seuil choisi');
    const notif = async (cookie) => (await call('GET', '/api/app/notifications', { cookie })).data.items.filter((i) => i.type === 'billing');
    assert.strictEqual((await notif(owner)).length, 1, 'alerte de solde bas');
    assert.strictEqual((await notif(operator)).length, 0, 'pas d’alerte pour un opérateur');
    assert.strictEqual((await prefs({ alertEnabled: true, threshold: 10000 }, other)).status, 200);
    assert.strictEqual((await notif(other)).length, 0, 'espace jamais crédité : pas d’alerte');
    await prefs({ alertEnabled: false, threshold: 10000 });
    assert.strictEqual((await notif(owner)).length, 0, 'alerte désactivée');
    r = await prefs({ alertEnabled: true, threshold: null });
    assert.deepStrictEqual([r.data.alert.custom, r.data.alert.enabled], [false, true], 'retour au seuil par défaut');
    assert.strictEqual((await notif(owner)).length, 0, 'solde au-dessus du seuil par défaut');
    console.log('billing-test: OK');
  } finally {
    await pool.query(`UPDATE billing_settings SET overrides = $1 WHERE id = TRUE`, [JSON.stringify(savedOverrides)]).catch(() => {});
    if (made.sessions.length) await pool.query('DELETE FROM app_sessions WHERE token_hash = ANY($1::text[])', [made.sessions]).catch(() => {});
    // Données des entreprises de test : toutes les tables qui portent company_id.
    const tables = (await pool.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'company_id' AND table_schema = current_schema() AND table_name <> 'companies'`)).rows.map((t) => t.table_name);
    for (let pass = 0; pass < 6 && made.companies.length; pass += 1) {
      for (const t of tables) await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::bigint[])`, [made.companies]).catch(() => {});
    }
    if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [made.users]).catch(() => {});
    if (made.companies.length) await pool.query('DELETE FROM companies WHERE id = ANY($1::bigint[])', [made.companies]);
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
