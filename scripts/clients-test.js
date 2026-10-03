// Carnet clients : création (doublon de téléphone), modification, contacts,
// lieux (GPS effacé si l'adresse change), notes, actions groupées et
// annulation, export réservé aux responsables, vues enregistrées, et une
// seule fiche par client lors des commandes successives.
const assert = require('assert');
const { Pool } = require('pg');

const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const cookieOf = (res, name) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
async function call(method, url, { cookie, body } = {}) {
  const res = await fetch(`${base}${url}`, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { text }; }
  return { res, status: res.status, data };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const login = await fetch(`${base}/app/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }) });
  const staff = cookieOf(login, 'delivery_session');
  assert.ok(staff, 'connexion équipe');
  const marker = Date.now().toString(36);
  const tail = String(Date.now()).slice(-6);
  const phone = `01 96 ${tail.slice(0, 2)} ${tail.slice(2, 4)} ${tail.slice(4, 6)}`;
  const created = { customers: [], drivers: [], views: [] };
  try {
    const cid = (await pool.query('SELECT company_id FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1 LIMIT 1', [process.env.ADMIN_USER])).rows[0]?.company_id
      || (await pool.query('SELECT id FROM companies ORDER BY id LIMIT 1')).rows[0].id;

    // Création : nom seul suffit, téléphone et e-mail validés
    let r = await call('POST', '/api/app/crm/customers', { cookie: staff, body: { displayName: '' } });
    assert.strictEqual(r.status, 400, 'nom requis');
    r = await call('POST', '/api/app/crm/customers', { cookie: staff, body: { displayName: `Nom seul ${marker}` } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    created.customers.push(r.data.id);
    r = await call('POST', '/api/app/crm/customers', { cookie: staff, body: { displayName: `Mauvais ${marker}`, email: 'pas-un-mail' } });
    assert.strictEqual(r.status, 400, 'e-mail invalide');
    r = await call('POST', '/api/app/crm/customers', { cookie: staff, body: {
      displayName: `Awa ${marker}`, phone, phoneCountry: 'BJ', email: `awa-${marker}@example.com`, customerType: 'organization',
      stage: 'actif', city: 'Cotonou', sector: 'Restauration', preferredChannel: 'whatsapp', preferredLanguage: 'Fon',
      driverInstructions: 'Appeler en arrivant au portail bleu', tags: ['VIP', 'Bureau'],
    } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const awa = String(r.data.id);
    created.customers.push(awa);
    assert.match(r.data.customer_code, /^CL-\d{4,}$/);

    // Doublon de téléphone : bloqué, sauf confirmation explicite
    r = await call('POST', '/api/app/crm/customers', { cookie: staff, body: { displayName: `Autre ${marker}`, phone: `+229 ${phone}`, phoneCountry: 'BJ' } });
    assert.strictEqual(r.status, 409, 'doublon détecté avec indicatif');
    assert.strictEqual(r.data.code, 'DUPLICATE_PHONE');
    assert.strictEqual(r.data.duplicate.id, awa);
    r = await call('POST', '/api/app/crm/customers', { cookie: staff, body: { displayName: `Autre ${marker}`, phone, phoneCountry: 'BJ', allowDuplicate: true } });
    assert.strictEqual(r.status, 201, 'numéro partagé accepté sur confirmation');
    const shared = String(r.data.id);
    created.customers.push(shared);
    r = await call('PATCH', `/api/app/crm/customers/${created.customers[0]}`, { cookie: staff, body: { phone, phoneCountry: 'BJ' } });
    assert.strictEqual(r.status, 409, 'doublon détecté en modification');

    // Liste complète enrichie
    r = await call('GET', '/api/app/crm/customers?all=1', { cookie: staff });
    assert.strictEqual(r.status, 200);
    let row = r.data.customers.find((c) => String(c.id) === awa);
    assert.ok(row, 'fiche listée');
    assert.strictEqual(row.main_city, 'Cotonou');
    assert.strictEqual(row.primary_email, `awa-${marker}@example.com`);
    assert.deepStrictEqual(row.tags, ['Bureau', 'VIP']);
    assert.strictEqual(row.stage, 'actif');

    // Modification
    r = await call('PATCH', `/api/app/crm/customers/${awa}`, { cookie: staff, body: { mainCity: 'Porto-Novo', tags: ['VIP'], driverInstructions: 'Sonner deux fois', email: '' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));

    // Contacts
    r = await call('POST', `/api/app/crm/customers/${awa}/contacts`, { cookie: staff, body: { name: 'Koffi', phone: '01 97 00 11 22', phoneCountry: 'BJ', role: 'Gardien' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const contactId = r.data.id;
    r = await call('POST', `/api/app/crm/customers/${awa}/contacts`, { cookie: staff, body: { name: 'Sans numéro' } });
    assert.strictEqual(r.status, 400);

    // Lieux : création, lieu habituel, GPS effacé quand l'adresse change
    r = await call('POST', `/api/app/crm/customers/${awa}/locations`, { cookie: staff, body: { label: 'Bureau', city: 'Cotonou', neighborhood: 'Ganhi', address: 'Rue 12', landmark: 'Face à la banque', isDefault: true } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const locId = r.data.id;
    await pool.query(`UPDATE customer_locations SET latitude = 6.36, longitude = 2.42, coordinate_source = 'operator', coordinates_captured_at = NOW() WHERE id = $1`, [locId]);
    r = await call('PATCH', `/api/app/crm/customers/${awa}/locations/${locId}`, { cookie: staff, body: { label: 'Bureau principal', city: 'Cotonou', neighborhood: 'Ganhi', address: 'Rue 12', landmark: 'Face à la banque' } });
    assert.strictEqual(r.status, 200);
    let loc = (await pool.query('SELECT latitude FROM customer_locations WHERE id = $1', [locId])).rows[0];
    assert.ok(loc.latitude != null, 'GPS conservé si seule l’étiquette change');
    r = await call('PATCH', `/api/app/crm/customers/${awa}/locations/${locId}`, { cookie: staff, body: { label: 'Bureau principal', city: 'Cotonou', neighborhood: 'Ganhi', address: 'Rue 40', landmark: 'Face à la banque' } });
    loc = (await pool.query('SELECT latitude, coordinate_source FROM customer_locations WHERE id = $1', [locId])).rows[0];
    assert.strictEqual(loc.latitude, null, 'GPS effacé quand l’adresse change');
    assert.strictEqual(loc.coordinate_source, null);

    // Notes internes
    r = await call('POST', `/api/app/crm/customers/${awa}/notes`, { cookie: staff, body: { text: 'Préfère être livrée le matin.' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));

    // Fiche détaillée
    r = await call('GET', `/api/app/crm/customers/${awa}`, { cookie: staff });
    assert.strictEqual(r.status, 200);
    const d = r.data;
    assert.strictEqual(d.customer.main_city, 'Porto-Novo');
    assert.strictEqual(d.customer.driver_instructions, 'Sonner deux fois');
    assert.strictEqual(String(d.customer.default_location_id), String(locId));
    assert.deepStrictEqual(d.customer.tags, ['VIP']);
    assert.strictEqual(d.customer.stage, 'actif');
    assert.strictEqual(d.customer.origin, 'manual');
    assert.ok(!d.contacts.some((c) => c.kind === 'email' && c.is_active), 'e-mail retiré');
    assert.ok(d.contacts.some((c) => c.contact_name === 'Koffi'));
    assert.ok(d.interactions.some((i) => i.summary === 'Préfère être livrée le matin.' && i.author_name), 'note avec auteur');
    assert.ok(d.activity.some((a) => a.action === 'created'), 'activité : création');
    assert.ok(d.activity.some((a) => a.action === 'location_updated'), 'activité : lieu');
    assert.strictEqual(d.counters.orders, 0);

    r = await call('DELETE', `/api/app/crm/customers/${awa}/contacts/${contactId}`, { cookie: staff });
    assert.strictEqual(r.status, 200);

    // Une fiche par client : commandes successives depuis la fiche et par
    // même nom + même téléphone ; un autre nom sur le même numéro reste séparé.
    const driverId = (await pool.query(
      `INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active) VALUES ($1, $2, $3, '22900000077', TRUE) RETURNING id`,
      [cid, `Clients ${marker}`, `clients-${marker}`]
    )).rows[0].id;
    created.drivers.push(driverId);
    const order = async (body) => {
      const res = await call('POST', '/api/app/orders', { cookie: staff, body: { customerPhoneCountry: 'BJ', neighborhood: 'Ganhi', driverId, ...body } });
      assert.strictEqual(res.status, 201, JSON.stringify(res.data));
      return (await pool.query('SELECT customer_id, customer_location_id FROM orders WHERE id = $1', [res.data.orderId])).rows[0];
    };
    let o = await order({ customerName: `Awa ${marker}`, customerPhone: phone, customerId: awa });
    assert.strictEqual(String(o.customer_id), awa, 'commande rattachée à la fiche choisie');
    o = await order({ customerName: `awa  ${marker.toUpperCase()}`, customerPhone: `+229${phone.replace(/\s/g, '')}` });
    assert.notStrictEqual(String(o.customer_id), shared, 'jamais rattachée à la fiche partagée d’un autre nom');
    const o2 = await order({ customerName: `Awa ${marker}`, customerPhone: phone, landmark: 'Portail bleu' });
    assert.ok([awa].includes(String(o2.customer_id)), 'même nom et même téléphone : même fiche');
    const o3 = await order({ customerName: `Awa ${marker}`, customerPhone: phone, landmark: 'Portail bleu' });
    assert.strictEqual(String(o3.customer_location_id), String(o2.customer_location_id), 'même adresse : même lieu');
    const stranger = await order({ customerName: `Inconnu ${marker}`, customerPhone: phone });
    assert.ok(![awa, shared].includes(String(stranger.customer_id)), 'autre nom : nouvelle fiche, pas de fusion');
    created.customers.push(String(stranger.customer_id));
    r = await call('GET', `/api/app/crm/customers/${awa}`, { cookie: staff });
    assert.ok(r.data.counters.orders >= 3, 'commandes regroupées sur la fiche');
    assert.strictEqual(r.data.customer.name, undefined);
    assert.strictEqual(r.data.customer.display_name, `Awa ${marker}`, 'nom de la fiche non écrasé');
    const ignored = await order({ customerName: `Ignoré ${marker}`, customerPhone: '01 97 55 44 33', customerId: '999999999' });
    assert.ok(ignored.customer_id, 'identifiant inconnu ignoré, fiche créée');
    created.customers.push(String(ignored.customer_id));

    // Actions groupées et annulation
    const ids = [awa, shared];
    r = await call('POST', '/api/app/crm/customers/bulk', { cookie: staff, body: { action: 'stage', ids, stage: 'a_relancer' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.done.sort(), ids.slice().sort());
    r = await call('POST', '/api/app/crm/customers/bulk', { cookie: staff, body: { action: 'archive', ids } });
    assert.strictEqual(r.data.done.length, 2);
    r = await call('GET', '/api/app/crm/customers?all=1', { cookie: staff });
    assert.ok(!r.data.customers.some((c) => String(c.id) === awa), 'archivée hors du carnet courant');
    r = await call('GET', '/api/app/crm/customers?all=1&status=archived', { cookie: staff });
    assert.ok(r.data.customers.some((c) => String(c.id) === awa), 'visible dans Archivés');
    r = await call('POST', '/api/app/crm/customers/bulk', { cookie: staff, body: { action: 'restore', ids } });
    assert.strictEqual(r.data.done.length, 2, 'annulation de l’archivage');
    r = await call('POST', '/api/app/crm/customers/bulk', { cookie: staff, body: { action: 'remove', ids: [shared] } });
    assert.deepStrictEqual(r.data.done, [shared]);
    r = await call('GET', '/api/app/crm/customers?all=1&status=archived', { cookie: staff });
    assert.ok(!r.data.customers.some((c) => String(c.id) === shared), 'supprimée de toutes les vues');
    r = await call('PATCH', `/api/app/crm/customers/${shared}`, { cookie: staff, body: { mainCity: 'X' } });
    assert.strictEqual(r.status, 404, 'fiche supprimée non modifiable');
    r = await call('POST', '/api/app/crm/customers/bulk', { cookie: staff, body: { action: 'unremove', ids: [shared] } });
    assert.deepStrictEqual(r.data.done, [shared], 'annulation de la suppression');
    r = await call('POST', '/api/app/crm/customers/bulk', { cookie: staff, body: { action: 'explode', ids } });
    assert.strictEqual(r.status, 400);

    // Export CSV : résultats choisis, formules neutralisées
    await pool.query(`UPDATE customers SET display_name = '=HYPERLINK("x")' WHERE id = $1`, [shared]);
    r = await call('POST', '/api/app/crm/customers/export', { cookie: staff, body: { ids } });
    assert.strictEqual(r.status, 200);
    const lines = r.data.text.replace(/^﻿/, '').split('\r\n');
    assert.ok(lines[0].startsWith('ID,Nom,Type'), lines[0]);
    assert.strictEqual(lines.length, 3);
    assert.ok(!lines.some((l) => /,"?=HYPERLINK/.test(l)), 'formule neutralisée');
    assert.ok(lines.some((l) => l.includes('Entreprise') && l.includes('Porto-Novo')));

    // Vues enregistrées du carnet
    r = await call('POST', '/api/app/ops/views', { cookie: staff, body: { source: 'clients', name: `Relances ${marker}`, config: { layout: 'stage', scope: 'archived', pageSize: 24, q: 'awa', sort: 'orders', columns: ['phone', 'city'], filters: { stage: ['a_relancer', 'pirate'], type: ['person'], frequency: 'recurring' } } } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    created.views.push(r.data.id);
    assert.strictEqual(r.data.config.layout, 'stage');
    assert.strictEqual(r.data.config.scope, 'archived');
    assert.deepStrictEqual(r.data.config.filters.stage, ['a_relancer']);
    assert.strictEqual(r.data.config.filters.frequency, 'recurring');
    r = await call('PATCH', `/api/app/ops/views/${r.data.id}`, { cookie: staff, body: { config: { layout: 'cards', pageSize: 6 } } });
    assert.strictEqual(r.data.config.layout, 'cards');
    assert.strictEqual(r.data.config.pageSize, 6);
    console.log('clients-test: OK');
  } finally {
    if (created.views.length) await pool.query('DELETE FROM ops_views WHERE id = ANY($1::bigint[])', [created.views]);
    if (created.customers.length) {
      await pool.query(`UPDATE customers SET removed_at = NOW() WHERE id = ANY($1::bigint[])`, [created.customers]);
    }
    if (created.drivers.length) await pool.query('UPDATE drivers SET active = FALSE WHERE id = ANY($1::bigint[])', [created.drivers]);
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
