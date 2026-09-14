const { Pool } = require('pg');

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const email = process.env.ADMIN_USER;
const password = process.env.ADMIN_PASSWORD;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response) {
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function run() {
  ensure(email && password, 'ADMIN_USER et ADMIN_PASSWORD sont requis.');
  let requestToken;
  let requestId;
  let orderId;
  let pool;

  try {
    const login = await fetch(`${baseUrl}/app/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: email, password }),
    });
    ensure(login.status === 302, `Connexion attendue en 302, reçue ${login.status}.`);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    ensure(cookie, 'Cookie de session absent.');

    const context = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: cookie } }));
    ensure(context.response.ok && context.payload.company?.id, 'Contexte entreprise indisponible.');

    const platform = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie }, redirect: 'manual' });
    ensure(platform.status === 302 && platform.headers.get('location') === '/admin/login', 'Séparation /app et /admin invalide.');

    const created = await json(await fetch(`${baseUrl}/api/app/request-links`, {
      method: 'POST', headers: { Cookie: cookie },
    }));
    ensure(created.response.status === 201 && created.payload.token, 'Création du formulaire impossible.');
    requestToken = created.payload.token;

    const submitted = await json(await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(requestToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Test automatique',
        customerPhone: '22900000000',
        neighborhood: 'Zone de test',
        requestedTime: '15 h - 17 h',
        landmark: 'Repère de test',
        notes: 'Donnée temporaire supprimée à la fin du test',
        locationLat: 6.37,
        locationLng: 2.43,
        locationAccuracy: 12,
      }),
    }));
    ensure(submitted.response.ok && submitted.payload.redirect, 'Soumission publique impossible.');
    const confirmationUrl = new URL(submitted.payload.redirect, baseUrl);
    const editToken = confirmationUrl.searchParams.get('edit');
    ensure(editToken, 'Token de modification absent.');

    const details = await json(await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(requestToken)}?edit=${encodeURIComponent(editToken)}`));
    ensure(details.response.ok && details.payload.canEdit, 'La demande soumise devrait être modifiable.');

    const updated = await json(await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(requestToken)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        editToken,
        version: details.payload.version,
        customerName: 'Test automatique modifié',
        customerPhone: '22900000000',
        neighborhood: 'Zone de test',
        requestedTime: '16 h - 18 h',
        landmark: 'Repère corrigé',
        notes: 'Donnée temporaire',
        locationLat: 6.38,
        locationLng: 2.44,
        locationAccuracy: 10,
      }),
    }));
    ensure(updated.response.ok, 'Modification client impossible.');

    const list = await json(await fetch(`${baseUrl}/api/app/requests`, { headers: { Cookie: cookie } }));
    const request = list.payload.find((item) => item.token === requestToken);
    ensure(request, 'Demande absente de la file entreprise.');
    requestId = request.id;

    const drivers = await json(await fetch(`${baseUrl}/api/app/drivers`, { headers: { Cookie: cookie } }));
    ensure(drivers.response.ok && Array.isArray(drivers.payload), 'Liste des livreurs indisponible.');
    const driver = drivers.payload.find((item) => item.active && !['off_duty', 'incident', 'inactive'].includes(item.operationalState));
    ensure(driver, 'Aucun livreur utilisable pour convertir la demande.');

    const converted = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}/convert`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId: driver.id }),
    }));
    ensure(converted.response.status === 201 && converted.payload.orderId && converted.payload.path, 'Conversion en commande impossible.');
    orderId = converted.payload.orderId;

    const repeated = await json(await fetch(`${baseUrl}/api/app/requests/${requestId}/convert`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId: driver.id }),
    }));
    ensure(repeated.response.ok && repeated.payload.alreadyConverted && repeated.payload.orderId === orderId, 'La conversion répétée doit rester sans doublon.');

    const orders = await json(await fetch(`${baseUrl}/api/app/orders`, { headers: { Cookie: cookie } }));
    ensure(orders.response.ok && orders.payload.some((item) => item.id === orderId), 'Commande absente de la liste entreprise.');

    const locked = await fetch(`${baseUrl}/api/public/requests/${encodeURIComponent(requestToken)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        editToken,
        version: updated.payload.version,
        customerName: 'Modification interdite',
        customerPhone: '22900000000',
        neighborhood: 'Zone de test',
      }),
    });
    ensure(locked.status === 409, `La modification après validation devait être bloquée, reçue ${locked.status}.`);

    console.log('Smoke test réussi : isolation, demande, édition, affectation, conversion sans doublon et verrouillage.');
  } finally {
    if (requestToken && process.env.DATABASE_URL) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (!requestId) {
          const found = await client.query('SELECT id FROM customer_requests WHERE token = $1', [requestToken]);
          requestId = found.rows[0]?.id;
        }
        if (requestId) {
          const order = await client.query('SELECT id FROM orders WHERE customer_request_id = $1', [requestId]);
          orderId = order.rows[0]?.id || orderId;
          if (orderId) {
            await client.query("DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = $1", [orderId]);
            await client.query('DELETE FROM orders WHERE id = $1', [orderId]);
          }
          await client.query("DELETE FROM audit_logs WHERE entity_type = 'customer_request' AND entity_id = $1", [requestId]);
          await client.query('DELETE FROM customer_requests WHERE id = $1 AND token = $2', [requestId, requestToken]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
        await pool.end();
      }
    }
  }
}

run().catch((error) => {
  console.error(`Smoke test échoué : ${error.message}`);
  process.exitCode = 1;
});
