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

    const transition = async (toStatus, suffix, reason = '') => json(await fetch(`${baseUrl}/api/app/orders/${orderId}/transition`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus, reason, idempotencyKey: `smoke-transition-${suffix}-${requestToken}` }),
    }));

    const invalidTransition = await transition('Arrivée', 'invalid');
    ensure(invalidTransition.response.status === 409, 'Une transition incohérente devait être refusée.');

    const concurrentBody = JSON.stringify({
      toStatus: 'Récupérée', reason: '', idempotencyKey: `smoke-transition-concurrent-${requestToken}`,
    });
    const concurrentTransitions = await Promise.all([1, 2].map(async () => json(await fetch(`${baseUrl}/api/app/orders/${orderId}/transition`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: concurrentBody,
    }))));
    ensure(concurrentTransitions.every((item) => item.response.ok && item.payload.status === 'Récupérée'), 'Les répétitions concurrentes doivent produire le même résultat.');
    ensure(concurrentTransitions.some((item) => item.payload.alreadyApplied), 'Une répétition concurrente devait être reconnue sans doublon.');

    for (const [index, status] of ['En tournée', 'En livraison', 'Arrivée'].entries()) {
      const progressed = await transition(status, `step-${index}`);
      ensure(progressed.response.ok && progressed.payload.status === status, `Transition vers ${status} impossible.`);
    }

    const incidentKey = `smoke-incident-${requestToken}`;
    const incident = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/incidents`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'adresse', severity: 'low', description: 'Incident temporaire du test automatique',
        idempotencyKey: incidentKey,
      }),
    }));
    ensure(incident.response.status === 201 && incident.payload.id, 'Création de l’incident impossible.');
    const repeatedIncident = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/incidents`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'adresse', severity: 'low', description: 'Incident temporaire du test automatique',
        idempotencyKey: incidentKey,
      }),
    }));
    ensure(repeatedIncident.response.ok && repeatedIncident.payload.alreadyCreated, 'L’incident répété devait rester sans doublon.');

    const resolved = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/resolve`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: 'Résolution temporaire validée', idempotencyKey: `smoke-resolve-${requestToken}` }),
    }));
    ensure(resolved.response.ok && resolved.payload.status === 'resolved', 'Résolution de l’incident impossible.');

    const otpKey = `smoke-otp-${requestToken}`;
    const otp = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: otpKey }),
    }));
    ensure(otp.response.status === 201 && /^\d{6}$/.test(otp.payload.code), 'Génération OTP impossible.');
    const repeatedOtp = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: otpKey }),
    }));
    ensure(repeatedOtp.response.ok && repeatedOtp.payload.alreadyGenerated && repeatedOtp.payload.code === otp.payload.code, 'La répétition OTP doit rendre le même résultat.');

    const wrongCode = otp.payload.code === '000000' ? '111111' : '000000';
    const wrongOtpKey = `smoke-wrong-otp-${requestToken}`;
    const wrongOtp = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wrongCode, idempotencyKey: wrongOtpKey }),
    }));
    ensure(wrongOtp.response.status === 400 && wrongOtp.payload.attemptsRemaining === 4, 'Un mauvais OTP doit consommer exactement un essai.');
    const repeatedWrongOtp = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: wrongCode, idempotencyKey: wrongOtpKey }),
    }));
    ensure(repeatedWrongOtp.response.status === 400 && repeatedWrongOtp.payload.attemptsRemaining === 4 && repeatedWrongOtp.payload.alreadyAttempted, 'Une tentative OTP répétée ne doit pas consommer un second essai.');

    const verifyKey = `smoke-verify-otp-${requestToken}`;
    const verified = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: otp.payload.code, idempotencyKey: verifyKey }),
    }));
    ensure(verified.response.ok && verified.payload.status === 'Livrée' && verified.payload.proofId, 'Validation de la remise impossible.');
    const repeatedVerification = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}/otp/verify`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: otp.payload.code, idempotencyKey: verifyKey }),
    }));
    ensure(repeatedVerification.response.ok && repeatedVerification.payload.alreadyVerified, 'La validation OTP répétée doit rester sans doublon.');

    const orderDetail = await json(await fetch(`${baseUrl}/api/app/orders/${orderId}`, { headers: { Cookie: cookie } }));
    ensure(orderDetail.response.ok && orderDetail.payload.status === 'Livrée' && orderDetail.payload.proof_id, 'La preuve de remise est absente de la commande.');
    ensure(orderDetail.payload.events.length >= 5 && orderDetail.payload.incidents[0]?.status === 'resolved', 'Chronologie ou incident incomplet.');

    const privateAfterDelivery = await json(await fetch(`${baseUrl}${converted.payload.path.replace('/suivi/', '/api/tracking/')}`));
    ensure(privateAfterDelivery.response.ok && privateAfterDelivery.payload.status === 'completed', 'Le suivi public doit signaler la fin de livraison.');
    ensure(privateAfterDelivery.payload.latitude == null && privateAfterDelivery.payload.longitude == null, 'La position du livreur ne doit plus être exposée après livraison.');

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

    console.log('Smoke test réussi : demande, affectation, transitions, incidents, OTP, preuve et confidentialité après livraison.');
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
