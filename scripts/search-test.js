// Recherche globale : numéro complet, fragment, format international, codes
// CMD/DEM/TRN/INC, mots sans accents, informations de sous-section (lieu,
// contact), liens vers la fiche exacte, et cloisonnement entre entreprises.
const assert = require('assert');
const { Pool } = require('pg');
const { parseQuery, phoneMatches } = require('../server/modules/search/service');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { text }; }
  return { status: res.status, data };
}
const items = (r, key) => (r.data.groups || []).find((g) => g.key === key)?.items || [];

(async () => {
  // Analyse de la saisie (sans serveur)
  assert.strictEqual(parseQuery('97 42 18').phone, true);
  assert.strictEqual(parseQuery('+229 01 97 42 18 60').digits, '2290197421860');
  assert.strictEqual(parseQuery('Cadjèhoun').folded, 'cadjehoun');
  assert.deepStrictEqual(parseQuery('cmd-42').code, { kind: 'cmd', id: '42' });
  assert.strictEqual(parseQuery('a').tooShort, true);
  assert.ok(phoneMatches('+229 01 97 42 18 60', '4218'), 'fragment');
  assert.ok(phoneMatches('0197421860', '2290197421860'), 'saisie internationale, numéro local enregistré');
  assert.ok(phoneMatches('+229 97 42 18 60', '0197421860'), 'ancien et nouveau format');
  assert.ok(!phoneMatches('+229 01 96 00 00 00', '4218'));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  const tail = String(Date.now()).slice(-6);
  const digits8 = `97${tail}`; // 8 chiffres uniques
  const phone = `01 ${digits8.slice(0, 2)} ${digits8.slice(2, 4)} ${digits8.slice(4, 6)} ${digits8.slice(6, 8)}`;
  const created = { customers: [], orders: [], requests: [], drivers: [], runs: [], companies: [] };
  try {
    const cid = (await pool.query('SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1', [process.env.ADMIN_USER])).rows[0]?.company_id
      || (await pool.query('SELECT id FROM companies ORDER BY id LIMIT 1')).rows[0].id;

    // Client avec un lieu et un contact secondaire
    let r = await call('POST', '/api/app/crm/customers', { cookie: staff, body: { displayName: `Mariam Sànni ${marker}`, phone, phoneCountry: 'BJ' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const mariam = String(r.data.id); created.customers.push(mariam);
    r = await call('POST', `/api/app/crm/customers/${mariam}/locations`, { cookie: staff, body: { label: 'Boutique', city: 'Cotonou', neighborhood: `Zogbadjè${marker}`, address: 'Rue 9', landmark: 'Derrière la pharmacie' } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
    r = await call('POST', `/api/app/crm/customers/${mariam}/contacts`, { cookie: staff, body: { name: `Gardien${marker}`, phone: `01 95 ${tail.slice(0, 2)} ${tail.slice(2, 4)} ${tail.slice(4, 6)}`, phoneCountry: 'BJ' } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));

    // Livreur, commande, demande, tournée, incident
    const drv = (await pool.query(`INSERT INTO drivers (company_id, name, traccar_unique_id, phone) VALUES ($1, $2, $3, $4) RETURNING id`,
      [cid, `Joël Livreur ${marker}`, `srch-${marker}`, `+229 01 66 ${tail.slice(0, 2)} ${tail.slice(2, 4)} ${tail.slice(4, 6)}`])).rows[0].id;
    created.drivers.push(drv);
    const ord = (await pool.query(`INSERT INTO orders (company_id, driver_id, customer_name, customer_phone, delivery_address, neighborhood, notes, status)
      VALUES ($1, $2, $3, $4, 'Lot 12', 'Cadjèhoun', $5, 'En préparation') RETURNING id`,
      [cid, drv, `Mariam Sànni ${marker}`, `+229${digits8.replace(/^/, '01')}`, `Portail vert ${marker}`])).rows[0].id;
    created.orders.push(ord);
    const reqRow = (await pool.query(`INSERT INTO customer_requests (company_id, token, customer_name, customer_phone, neighborhood)
      VALUES ($1, $2, $3, $4, 'Akpakpa') RETURNING id`, [cid, `srch-${marker}`, `Demande ${marker}`, phone])).rows[0].id;
    created.requests.push(reqRow);

    // Fragment de 4 chiffres, avec ou sans espaces
    const frag = digits8.slice(4, 8);
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(frag)}`, { cookie: staff });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.mode, 'phone');
    assert.ok(items(r, 'clients').some((x) => x.id === mariam), 'client trouvé par fragment');
    assert.ok(items(r, 'orders').some((x) => x.id === String(ord)), 'commande trouvée par fragment');
    assert.ok(items(r, 'requests').some((x) => x.id === String(reqRow)), 'demande trouvée par fragment');
    const hit = items(r, 'clients').find((x) => x.id === mariam);
    assert.ok(hit.href.startsWith(`/app/clients/${mariam}`), 'lien vers la fiche exacte');
    assert.deepStrictEqual(hit.path.slice(0, 2), ['Clients', `Mariam Sànni ${marker}`]);

    r = await call('GET', `/api/app/search?q=${encodeURIComponent(`${frag.slice(0, 2)} ${frag.slice(2)}`)}`, { cookie: staff });
    assert.ok(items(r, 'clients').some((x) => x.id === mariam), 'fragment avec espace');

    // Numéro international complet → même client, classé en tête
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(`+229 ${phone}`)}`, { cookie: staff });
    assert.strictEqual(r.data.groups[0].items[0].id === mariam || r.data.groups[0].items[0].id === String(ord), true, 'correspondance exacte en tête');
    assert.ok(items(r, 'clients').some((x) => x.id === mariam && x.score >= 90), 'format international');
    // Ancien format sans « 01 »
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(digits8)}`, { cookie: staff });
    assert.ok(items(r, 'clients').some((x) => x.id === mariam), 'ancien format à 8 chiffres');

    // Contact secondaire (sous-section Contacts)
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(`95${tail}`)}`, { cookie: staff });
    const viaContact = items(r, 'clients').find((x) => x.id === mariam);
    assert.ok(viaContact, 'trouvé par le numéro d’un contact secondaire');
    assert.ok(viaContact.href.endsWith('?onglet=contacts'), 'ouvre l’onglet Contacts');

    // Lieu (sous-section Lieux), sans accent
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(`zogbadje${marker}`)}`, { cookie: staff });
    const viaPlace = items(r, 'clients').find((x) => x.id === mariam);
    assert.ok(viaPlace, 'trouvé par le quartier d’un lieu');
    assert.ok(viaPlace.href.endsWith('?onglet=places'), 'ouvre l’onglet Lieux');
    assert.strictEqual(viaPlace.path[2], 'Lieux');

    // Recherche libre : plusieurs mots répartis dans la fiche
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(`sanni ${marker} pharmacie`)}`, { cookie: staff });
    assert.ok(items(r, 'clients').some((x) => x.id === mariam), 'mots répartis entre nom et lieu');
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(`portail vert ${marker}`)}`, { cookie: staff });
    assert.ok(items(r, 'orders').some((x) => x.id === String(ord)), 'note de commande');
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(`joel ${marker}`)}`, { cookie: staff });
    assert.ok(items(r, 'drivers').some((x) => x.id === String(drv) && x.href === `/app/livreurs?livreur=${drv}`), 'livreur sans accent');

    // Codes
    r = await call('GET', `/api/app/search?q=CMD-${ord}`, { cookie: staff });
    assert.strictEqual(items(r, 'orders')[0]?.id, String(ord), 'code commande');
    assert.strictEqual(items(r, 'orders')[0].href, `/app/operations?vue=commandes&commande=${ord}`);
    r = await call('GET', `/api/app/search?q=dem ${reqRow}`, { cookie: staff });
    assert.strictEqual(items(r, 'requests')[0]?.id, String(reqRow), 'code demande');
    assert.strictEqual(items(r, 'orders').length, 0, 'un code DEM ne liste pas de commande');

    // Filtre par catégorie
    r = await call('GET', `/api/app/search?q=${frag}&scope=clients`, { cookie: staff });
    assert.ok(r.data.groups.every((g) => g.key === 'clients'));
    r = await call('GET', `/api/app/search?q=${frag}&scope=operations`, { cookie: staff });
    assert.ok(r.data.groups.every((g) => ['requests', 'runs', 'incidents'].includes(g.key)));

    // Saisies trop courtes ou piégées
    r = await call('GET', '/api/app/search?q=a', { cookie: staff });
    assert.deepStrictEqual(r.data.groups, []);
    r = await call('GET', `/api/app/search?q=${encodeURIComponent("%' OR 1=1 --")}`, { cookie: staff });
    assert.strictEqual(r.status, 200);
    r = await call('GET', `/api/app/search?q=${encodeURIComponent('%%')}`, { cookie: staff });
    assert.strictEqual(r.status, 200);
    assert.ok(!(r.data.groups || []).length, '« % » est un caractère, pas un joker');

    // Cloisonnement : une autre entreprise avec le même numéro n'apparaît jamais
    const other = (await pool.query(`INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Autre ${marker}`, `autre-${marker}`])).rows[0].id;
    created.companies.push(other);
    const odrv = (await pool.query(`INSERT INTO drivers (company_id, name, traccar_unique_id, phone) VALUES ($1, $2, $3, $4) RETURNING id`, [other, `Étranger ${marker}`, `srch-o-${marker}`, phone])).rows[0].id;
    const oord = (await pool.query(`INSERT INTO orders (company_id, driver_id, customer_name, customer_phone, status) VALUES ($1, $2, $3, $4, 'En préparation') RETURNING id`, [other, odrv, `Étranger ${marker}`, phone])).rows[0].id;
    created.foreign = { odrv, oord };
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(phone)}`, { cookie: staff });
    const all = r.data.groups.flatMap((g) => g.items.map((x) => `${g.key}:${x.id}`));
    assert.ok(!all.includes(`orders:${oord}`) && !all.includes(`drivers:${odrv}`), 'aucune donnée d’une autre entreprise');
    r = await call('GET', `/api/app/search?q=${encodeURIComponent(`etranger ${marker}`)}`, { cookie: staff });
    assert.deepStrictEqual(r.data.groups, [], 'aucune suggestion étrangère');

    // Authentification requise
    r = await call('GET', `/api/app/search?q=${frag}`);
    assert.ok([401, 302, 303].includes(r.status), `sans session : ${r.status}`);
    console.log('search-test: OK');
  } finally {
    if (created.foreign) {
      await pool.query('DELETE FROM orders WHERE id = $1', [created.foreign.oord]);
      await pool.query('DELETE FROM drivers WHERE id = $1', [created.foreign.odrv]);
    }
    if (created.companies.length) await pool.query('DELETE FROM companies WHERE id = ANY($1::bigint[])', [created.companies]).catch(() => {});
    if (created.requests.length) await pool.query('DELETE FROM customer_requests WHERE id = ANY($1::bigint[])', [created.requests]);
    if (created.orders.length) await pool.query('DELETE FROM orders WHERE id = ANY($1::bigint[])', [created.orders]).catch(() => pool.query('UPDATE orders SET archived_at = NOW() WHERE id = ANY($1::bigint[])', [created.orders]));
    if (created.customers.length) await pool.query('UPDATE customers SET removed_at = NOW() WHERE id = ANY($1::bigint[])', [created.customers]);
    if (created.drivers.length) await pool.query('UPDATE drivers SET active = FALSE, archived_at = NOW() WHERE id = ANY($1::bigint[])', [created.drivers]).catch(() => {});
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
