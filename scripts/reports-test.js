// Rapports unifiés : options, aperçu, filtres, Rapport Premium (Excel), et fichiers
// CSV / ZIP / SVG / XLSX (formules et graphiques natifs).
const assert = require('assert');
const JSZip = require('jszip');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body, raw } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
let savedTrial = null; let companyId = null;
// Crédit de test écrit comme une correction (journal et solde ensemble).
async function credit(pool, cid, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO wallets (company_id) VALUES ($1) ON CONFLICT DO NOTHING', [cid]);
    const w = (await client.query('SELECT balance FROM wallets WHERE company_id = $1 FOR UPDATE', [cid])).rows[0];
    const after = Number(w.balance) + amount;
    await client.query(`INSERT INTO wallet_entries (company_id, kind, amount, balance_after, note) VALUES ($1, 'adjustment', $2, $3, 'Test des rapports')`, [cid, amount, after]);
    await client.query('UPDATE wallets SET balance = $1 WHERE company_id = $2', [after, cid]);
    await client.query('COMMIT');
  } finally { client.release(); }
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  try {
    const cid = (await pool.query('SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1', [process.env.ADMIN_USER])).rows[0].company_id;
    await pool.query('DELETE FROM company_export_access WHERE company_id = $1', [cid]);
    savedTrial = (await pool.query('SELECT trial_status FROM companies WHERE id = $1', [cid])).rows[0].trial_status;
    companyId = cid;
    await pool.query('UPDATE companies SET trial_status = NULL WHERE id = $1', [cid]);
    let r = await call('GET', '/api/app/reports/options', { cookie: staff });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(r.data.families.map((f) => f.key), ['orders', 'tours', 'incidents', 'clients']);
    assert.ok(r.data.families.every((f) => f.allowed), 'propriétaire : toutes les familles');
    assert.strictEqual(r.data.excel.state, 'free', 'rapports offerts disponibles');
    assert.strictEqual(r.data.excel.freeLeft, 2, '2 rapports offerts');
    const filters = { from: day(-30), to: day(0) };
    const sel = { sources: ['orders', 'tours', 'incidents', 'clients'], filters };

    r = await call('POST', '/api/app/reports/preview', { cookie: staff, body: sel });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.families.length, 4);
    const orders = r.data.families.find((f) => f.key === 'orders');
    assert.ok(orders.count > 0, 'commandes sur la période');
    assert.ok(!orders.fields.includes('phone') && !orders.rows.some((x) => 'phone' in x), 'téléphone exclu par défaut');
    assert.ok(orders.fields.includes('id') && orders.fields.includes('clientId'), 'identifiants conservés');
    // Filtre de statut propre à la famille + recherche commune
    r = await call('POST', '/api/app/reports/preview', { cookie: staff, body: { ...sel, filters: { ...filters, status: { orders: 'Livrée' } } } });
    const delivered = r.data.families.find((f) => f.key === 'orders');
    assert.ok(delivered.rows.every((x) => x.status === 'Livrée'), 'statut appliqué aux commandes');
    const ref = orders.rows[0].id;
    r = await call('POST', '/api/app/reports/preview', { cookie: staff, body: { sources: ['orders'], filters: { ...filters, query: ref } } });
    assert.ok(r.data.families[0].rows.some((x) => x.id === ref), 'recherche par référence');
    // Colonnes personnelles seulement à la demande
    r = await call('POST', '/api/app/reports/preview', { cookie: staff, body: { sources: ['orders'], filters, fields: { orders: ['client', 'phone'] } } });
    assert.ok(r.data.families[0].fields.includes('phone'), 'téléphone ajouté volontairement');
    // Erreurs de sélection
    r = await call('POST', '/api/app/reports/preview', { cookie: staff, body: { sources: [], filters } });
    assert.strictEqual(r.data.code, 'NO_SOURCE');
    r = await call('POST', '/api/app/reports/preview', { cookie: staff, body: { sources: ['orders'], filters: { from: day(0), to: day(-3) } } });
    assert.strictEqual(r.data.code, 'BAD_PERIOD');

    // CSV d'une famille, ZIP de plusieurs, SVG
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, sources: ['orders'], format: 'csv' }, raw: true });
    assert.strictEqual(r.status, 200);
    const csv = r.buffer.toString('utf8');
    assert.ok(csv.startsWith('﻿"Commande";"Créée le"'), 'CSV UTF-8, point-virgule');
    assert.strictEqual(csv.trim().split('\r\n').length - 1, orders.count, 'toutes les lignes, pas seulement la page');
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, format: 'csv' }, raw: true });
    assert.strictEqual(r.headers.get('content-type'), 'application/zip');
    const zip = await JSZip.loadAsync(r.buffer);
    assert.deepStrictEqual(Object.keys(zip.files).sort(), ['Clients.csv', 'Commandes.csv', 'Incidents.csv', 'Tournees.csv']);
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, format: 'svg' }, raw: true });
    const svg = r.buffer.toString('utf8');
    assert.ok(svg.includes('<svg') && !/<script|href=/.test(svg), 'SVG sans script ni lien');

    // Rapport Premium : 2 offerts, décomptés seulement quand le classeur est produit.
    assert.strictEqual((await call('POST', '/api/app/reports/excel-trial', { cookie: staff })).status, 404, 'ancien essai de 7 jours retiré');
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, filters: { ...filters, query: 'aucune-correspondance-zz' }, format: 'xlsx' } });
    assert.strictEqual(r.status, 422, 'sélection vide');
    assert.strictEqual((await call('GET', '/api/app/reports/options', { cookie: staff })).data.excel.freeLeft, 2, 'un échec ne consomme rien');
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, format: 'xlsx' }, raw: true });
    assert.strictEqual(r.status, 200, r.buffer.toString().slice(0, 200));
    assert.strictEqual(r.headers.get('x-premium-via'), 'free');
    const firstBook = r.buffer;
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, format: 'xlsx' }, raw: true });
    assert.strictEqual(r.headers.get('x-premium-via'), 'free', '2e rapport offert');
    let ex = (await call('GET', '/api/app/reports/options', { cookie: staff })).data.excel;
    assert.deepStrictEqual([ex.state, ex.freeLeft], ['paid', 0], 'rapports offerts épuisés');
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, format: 'xlsx' } });
    assert.strictEqual(r.status, 402); assert.strictEqual(r.data.code, 'premium_required', 'payant sans accord explicite : refusé');
    // Solde insuffisant, puis suffisant (crédit de test écrit dans le journal).
    const firstEntry = Number((await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM wallet_entries')).rows[0].id);
    const balance = async () => Number((await pool.query('SELECT COALESCE((SELECT balance FROM wallets WHERE company_id = $1), 0) AS b', [cid])).rows[0].b);
    await credit(pool, cid, -(await balance()) + 1000);
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, format: 'xlsx', pay: 'report' } });
    assert.strictEqual(r.status, 402); assert.strictEqual(r.data.code, 'wallet_insufficient');
    await credit(pool, cid, 5000);
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, format: 'xlsx', pay: 'report' }, raw: true });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('x-premium-via'), 'paid');
    assert.strictEqual(await balance(), 6000 - 1500, 'rapport payé 1 500 F');
    // Mois illimité : 2 500 F, puis les rapports suivants ne coûtent rien.
    r = await call('POST', '/api/app/reports/premium/month', { cookie: staff });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.state, 'month');
    assert.ok(Math.abs(new Date(r.data.monthUntil) - Date.now() - 30 * 86400000) < 120000, '30 jours');
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, format: 'xlsx' }, raw: true });
    assert.strictEqual(r.headers.get('x-premium-via'), 'month');
    assert.strictEqual(await balance(), 6000 - 1500 - 2500, 'mois débité une fois');
    const kinds = (await pool.query(`SELECT kind, amount FROM wallet_entries WHERE company_id = $1 AND kind LIKE 'premium_%' AND id > $2 ORDER BY id`, [cid, firstEntry])).rows;
    assert.deepStrictEqual(kinds.map((k) => [k.kind, k.amount]), [['premium_report', -1500], ['premium_month', -2500]], 'journal du portefeuille');
    // Essai déjà utilisé ailleurs : aucun rapport offert.
    await pool.query('DELETE FROM company_export_access WHERE company_id = $1', [cid]);
    await pool.query(`UPDATE companies SET trial_status = 'used_elsewhere' WHERE id = $1`, [cid]);
    ex = (await call('GET', '/api/app/reports/options', { cookie: staff })).data.excel;
    assert.deepStrictEqual([ex.state, ex.freeTotal, ex.trialReused], ['paid', 0, true], 'essai réutilisé : pas de rapport offert');
    await pool.query('UPDATE companies SET trial_status = NULL WHERE id = $1', [cid]);
    r = { buffer: firstBook };
    const book = await JSZip.loadAsync(r.buffer);
    const wbXml = await book.file('xl/workbook.xml').async('string');
    for (const name of ['Synthèse', 'Commandes', 'Tournées', 'Incidents', 'Clients']) assert.ok(wbXml.includes(`name="${name}"`), `onglet ${name}`);
    const charts = Object.keys(book.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n));
    assert.strictEqual(charts.length, 2, 'deux graphiques natifs');
    const types = await book.file('[Content_Types].xml').async('string');
    assert.ok(types.includes('drawingml.chart+xml') && types.includes('drawing+xml'), 'types déclarés');
    const s1 = await book.file('xl/worksheets/sheet1.xml').async('string');
    assert.ok(/<drawing r:id=/.test(s1) && /COUNTIFS\(Commandes!/.test(s1), 'synthèse : formules et graphiques');
    // CSV toujours gratuit, même sans rapport offert.
    r = await call('POST', '/api/app/reports/export', { cookie: staff, body: { ...sel, sources: ['orders'], format: 'csv' }, raw: true });
    assert.strictEqual(r.status, 200, 'CSV toujours gratuit');
    const logs = await pool.query("SELECT COUNT(*)::int AS n FROM export_logs WHERE company_id = $1 AND dataset LIKE 'rapport:%' AND created_at > NOW() - INTERVAL '5 minutes'", [cid]);
    assert.ok(logs.rows[0].n >= 5, 'exports journalisés');
    r = await call('POST', '/api/app/reports/preview', { body: sel });
    assert.ok([401, 302, 403].includes(r.status), 'réservé à l’équipe');
    console.log('reports-test: OK');
  } finally {
    if (companyId) {
      await pool.query('DELETE FROM company_export_access WHERE company_id = $1', [companyId]).catch(() => {});
      await pool.query('UPDATE companies SET trial_status = $1 WHERE id = $2', [savedTrial, companyId]).catch(() => {});
    }
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
