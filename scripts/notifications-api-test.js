// Centre de notifications : éléments calculés depuis l'état métier, état de lecture
// par utilisateur, préférences validées côté serveur.
const assert = require('assert');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));

async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, status: res.status, data: await res.json().catch(() => ({})) };
}

async function login(userAgent) {
  const res = await fetch(`${base}/app/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(userAgent ? { 'User-Agent': userAgent } : {}) },
    body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }),
  });
  return cookieOf(res, 'delivery_session');
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const staff = await login('Mozilla/5.0 (Windows NT 10.0) Chrome/120');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  try {
    // 1. Liste et compteurs
    let r = await call('GET', '/api/app/notifications', { cookie: staff });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.data.items) && r.data.counts, 'items + compteurs');
    for (const key of ['action', 'all', 'unread', 'later', 'archived']) assert.strictEqual(typeof r.data.counts[key], 'number', key);
    assert.strictEqual((await call('GET', '/api/app/notifications')).status, 401, 'connexion requise');

    // 2. Une demande confirmée par le client apparaît comme « à affecter »
    r = await call('POST', '/api/app/requests/prefilled', { cookie: staff, body: { customerName: `Notif ${marker}`, customerPhone: '01 97 55 66 77', customerPhoneCountry: 'BJ', neighborhood: 'Gbégamey' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const requestId = r.data.id;
    const pub = `/api/public/requests/${encodeURIComponent(r.data.token)}`;
    r = await call('POST', `${pub}/unlock`, { body: { code: '6677' } });
    const device = cookieOf(r.res, 'traxo_req');
    r = await call('POST', `${pub}/confirm`, { cookie: device, body: { customerName: `Notif ${marker}`, customerPhone: '01 97 55 66 77', customerPhoneCountry: 'BJ', neighborhood: 'Gbégamey', shareLocation: true, locationLat: 6.37, locationLng: 2.41, locationAccuracy: 20 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await call('GET', '/api/app/notifications', { cookie: staff });
    const assign = r.data.items.find((it) => it.id === `assign-${requestId}`);
    assert.ok(assign, 'notification d’affectation');
    assert.strictEqual(assign.title, 'Commande confirmée par le client');
    assert.strictEqual(assign.meta, 'Position partagée');
    assert.strictEqual(assign.priority, 'action');
    assert.strictEqual(assign.read, false);

    // 3. Les demandes à vérifier sont regroupées en une seule notification
    const cid = (await pool.query('SELECT company_id FROM customer_requests WHERE id = $1', [requestId])).rows[0].company_id;
    await pool.query(
      `INSERT INTO customer_requests (company_id, token, status, customer_name, customer_phone, neighborhood, submitted_at, expires_at)
       SELECT $1, md5(random()::text || g), 'À vérifier', 'Groupe ' || g, '+22990000000', 'Test', NOW(), NOW() + INTERVAL '2 days' FROM generate_series(1, 3) g`,
      [cid]
    );
    r = await call('GET', '/api/app/notifications', { cookie: staff });
    const grouped = r.data.items.filter((it) => it.type === 'requests');
    assert.strictEqual(grouped.length, 1, 'une seule notification pour les demandes');
    assert.ok(/\d+ demandes attendent/.test(grouped[0].title), grouped[0].title);

    // 4. Lu / non lu, archivé, plus tard ; les compteurs suivent
    const id = assign.id;
    const before = r.data.counts;
    assert.strictEqual((await call('POST', '/api/app/notifications/state', { cookie: staff, body: { ids: [id], action: 'read' } })).status, 200);
    r = await call('GET', '/api/app/notifications', { cookie: staff });
    assert.strictEqual(r.data.items.find((it) => it.id === id).read, true);
    assert.strictEqual(r.data.counts.unread, before.unread - 1, 'non lues décrémentées');
    await call('POST', '/api/app/notifications/state', { cookie: staff, body: { ids: [id], action: 'read' } });
    assert.strictEqual((await call('GET', '/api/app/notifications', { cookie: staff })).data.counts.unread, before.unread - 1, 'idempotent');
    await call('POST', '/api/app/notifications/state', { cookie: staff, body: { ids: [id], action: 'unread' } });
    assert.strictEqual((await call('GET', '/api/app/notifications', { cookie: staff })).data.counts.unread, before.unread);

    await call('POST', '/api/app/notifications/state', { cookie: staff, body: { ids: [id], action: 'archive' } });
    r = await call('GET', '/api/app/notifications', { cookie: staff });
    let item = r.data.items.find((it) => it.id === id);
    assert.ok(item.archived && item.read, 'archivé et lu');
    assert.strictEqual(r.data.counts.archived, before.archived + 1);
    assert.strictEqual(r.data.counts.action, before.action - 1, 'retiré de « À traiter »');
    await call('POST', '/api/app/notifications/state', { cookie: staff, body: { ids: [id], action: 'unarchive' } });
    await call('POST', '/api/app/notifications/state', { cookie: staff, body: { ids: [id], action: 'later' } });
    r = await call('GET', '/api/app/notifications', { cookie: staff });
    item = r.data.items.find((it) => it.id === id);
    assert.ok(item.later && !item.archived);
    assert.strictEqual(r.data.counts.later, before.later + 1);
    await call('POST', '/api/app/notifications/state', { cookie: staff, body: { ids: [id], action: 'unlater' } });

    // Lire une notification ne traite jamais la demande
    assert.strictEqual((await pool.query('SELECT status FROM customer_requests WHERE id = $1', [requestId])).rows[0].status, 'Validée');

    // Entrées invalides
    for (const body of [{ ids: [], action: 'read' }, { ids: [id], action: 'delete' }, { ids: ['../x'], action: 'read' }, { ids: new Array(301).fill(id).map((v, i) => `${v}${i}`), action: 'read' }]) {
      assert.strictEqual((await call('POST', '/api/app/notifications/state', { cookie: staff, body })).status, 400, JSON.stringify(body).slice(0, 60));
    }

    // 5. Préférences : validation, catégories masquées, sécurité toujours visible
    r = await call('GET', '/api/app/notifications/preferences', { cookie: staff });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.timezones.includes(r.data.timezone), 'fuseau par défaut valide');
    const prefs = { categories: { incidents: true, requests: true, deliveries: false, runs: true, clients: true }, digest: 'weekly', digestHour: 9, digestDay: 5, timezone: r.data.timezone };
    assert.strictEqual((await call('PUT', '/api/app/notifications/preferences', { cookie: staff, body: { ...prefs, categories: { incidents: true } } })).status, 400, 'catégories complètes');
    assert.strictEqual((await call('PUT', '/api/app/notifications/preferences', { cookie: staff, body: { ...prefs, digestHour: 24 } })).status, 400, 'heure');
    assert.strictEqual((await call('PUT', '/api/app/notifications/preferences', { cookie: staff, body: { ...prefs, digest: 'hourly' } })).status, 400, 'fréquence');
    assert.strictEqual((await call('PUT', '/api/app/notifications/preferences', { cookie: staff, body: { ...prefs, timezone: 'Mars/Olympus' } })).status, 400, 'fuseau');
    r = await call('PUT', '/api/app/notifications/preferences', { cookie: staff, body: prefs });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    r = await call('GET', '/api/app/notifications/preferences', { cookie: staff });
    assert.deepStrictEqual([r.data.digest, r.data.digestHour, r.data.digestDay, r.data.categories.deliveries], ['weekly', 9, 5, false]);
    r = await call('GET', '/api/app/notifications', { cookie: staff });
    assert.ok(!r.data.items.some((it) => it.category === 'deliveries'), 'catégorie désactivée masquée');

    // Une connexion depuis un autre appareil reste signalée, même si tout est désactivé
    await login('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');
    await call('PUT', '/api/app/notifications/preferences', { cookie: staff, body: { ...prefs, categories: Object.fromEntries(Object.keys(prefs.categories).map((k) => [k, false])) } });
    r = await call('GET', '/api/app/notifications', { cookie: staff });
    const security = r.data.items.filter((it) => it.category === 'security');
    assert.ok(security.length >= 1 && r.data.items.every((it) => it.category === 'security'), 'sécurité toujours active');
    assert.ok(security.some((it) => /iPhone/.test(it.summary)), 'appareil identifié');
    assert.ok(!security.some((it) => /Windows/.test(it.summary)), 'pas d’alerte pour l’appareil courant');
    assert.strictEqual(new Set(security.map((it) => it.summary)).size, security.length, 'une alerte par appareil');

    // Remise à l'état par défaut
    await call('PUT', '/api/app/notifications/preferences', { cookie: staff, body: { categories: { incidents: true, requests: true, deliveries: true, runs: true, clients: true }, digest: 'off', digestHour: 8, digestDay: 1, timezone: prefs.timezone } });
    await pool.query(`UPDATE customer_requests SET archived_at = NOW() WHERE customer_name LIKE 'Groupe %' AND company_id = $1`, [cid]);

    console.log('Notifications : regroupement, affectation, lu/archivé/plus tard, préférences, sécurité OK');
  } finally {
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
