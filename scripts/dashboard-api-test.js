// API du tableau de bord : paramètres validés, forme de la réponse, filtre livreur.
const assert = require('assert');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
(async () => {
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('delivery_session='));
  assert.ok(cookie, 'connexion équipe');
  const get = async (q) => { const res = await fetch(`${base}/api/app/dashboard?${q}`, { headers: { Cookie: cookie } }); return { status: res.status, data: await res.json() }; };

  assert.strictEqual((await fetch(`${base}/api/app/dashboard`)).status, 401, 'connexion requise');
  let r = await get('period=7');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.range.days, 7);
  for (const tab of ['general', 'orders', 'deliveries', 'drivers', 'requests', 'routes', 'incidents']) {
    const t = r.data.tabs[tab];
    assert.ok(t && t.kpis.length === 4 && t.series.current.length === 7 && t.series.previous.length === 7 && t.distribution, tab);
    assert.strictEqual(t.distribution.total, t.distribution.items.reduce((a, x) => a + x.value, 0), `${tab} : total cohérent`);
  }
  assert.strictEqual(r.data.tabs.general.distribution.total, r.data.tabs.general.kpis[0].value, 'répartition = commandes créées');
  assert.strictEqual(r.data.heatmap.counts.length, 7);
  assert.ok(Array.isArray(r.data.drivers) && r.data.attention);

  assert.strictEqual((await get('period=30')).data.range.days, 30);
  assert.strictEqual((await get('period=12')).data.range.days, 7, 'période inconnue : 7 jours');
  r = await get(`from=${r.data.range.from}&to=${r.data.range.to}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await get('from=2026-09-10&to=2026-09-01')).status, 400, 'dates inversées');
  assert.strictEqual((await get('from=2025-01-01&to=2025-12-31')).status, 400, 'plus de 92 jours');
  assert.strictEqual((await get('from=2999-01-01&to=2999-01-02')).status, 400, 'dans le futur');
  assert.strictEqual((await get('from=bad&to=2026-09-01')).status, 400, 'date invalide');
  assert.strictEqual((await get('driver=abc')).status, 400, 'livreur invalide');
  assert.strictEqual((await get('driver=999999999')).status, 400, 'livreur d’une autre entreprise ou inconnu');

  const all = await get('period=30');
  if (all.data.drivers.length) {
    const id = all.data.drivers[0].id;
    const one = await get(`period=30&driver=${id}`);
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.data.driver, id);
    assert.ok(one.data.tabs.general.kpis[0].value <= all.data.tabs.general.kpis[0].value, 'filtre livreur : moins ou autant de commandes');
    const name = all.data.drivers[0].name;
    assert.ok(one.data.rows.orders.every((o) => o.driver === name), 'lignes du seul livreur');
  }
  console.log('API tableau de bord : périodes, validation, cohérence des totaux, filtre livreur OK');
})().catch((error) => { console.error(error); process.exit(1); });
