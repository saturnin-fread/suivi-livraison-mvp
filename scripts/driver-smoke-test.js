const { Pool } = require('pg');
const crypto = require('node:crypto');

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
  ensure(email && password && process.env.DATABASE_URL, 'ADMIN_USER, ADMIN_PASSWORD et DATABASE_URL sont requis.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
  const marker = crypto.randomBytes(12).toString('hex');
  const driverEmail = `smoke-driver-${marker}@example.invalid`;
  const driverPassword = `Test-${marker}-Aa1!`;
  const driverIds = [];
  const orderIds = [];
  let invitationId;
  let invitedUserId;

  try {
    const login = await fetch(`${baseUrl}/app/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: email, password }),
    });
    ensure(login.status === 302 && login.headers.get('location') === '/app', 'Connexion propriétaire impossible.');
    const ownerCookie = login.headers.get('set-cookie')?.split(';')[0];
    ensure(ownerCookie, 'Cookie propriétaire absent.');
    const context = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: ownerCookie } }));
    ensure(context.response.ok && context.payload.company?.id, 'Contexte entreprise indisponible.');

    const firstDriver = await pool.query(
      `INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active)
       VALUES ($1, $2, $3, '22900000001', TRUE) RETURNING id`,
      [context.payload.company.id, `Livreur test ${marker}`, `smoke-driver-${marker}-1`]
    );
    const secondDriver = await pool.query(
      `INSERT INTO drivers (company_id, name, traccar_unique_id, phone, active)
       VALUES ($1, $2, $3, '22900000002', TRUE) RETURNING id`,
      [context.payload.company.id, `Autre livreur ${marker}`, `smoke-driver-${marker}-2`]
    );
    driverIds.push(firstDriver.rows[0].id, secondDriver.rows[0].id);

    const duplicateAccountInvitation = await fetch(`${baseUrl}/api/app/invitations`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: context.payload.user.email, displayName: 'Compte existant', role: 'operator' }),
    });
    ensure(duplicateAccountInvitation.status === 409, 'Une invitation ne doit pas cibler une adresse déjà utilisée.');

    const invitation = await json(await fetch(`${baseUrl}/api/app/invitations`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: driverEmail,
        displayName: `Livreur test ${marker}`,
        role: 'driver',
        driverId: firstDriver.rows[0].id,
      }),
    }));
    ensure(invitation.response.status === 201 && invitation.payload.path, `Invitation livreur impossible : ${JSON.stringify(invitation.payload)}`);
    invitationId = invitation.payload.id;
    const invitationToken = invitation.payload.path.split('/').pop();

    const duplicateDriverInvitation = await fetch(`${baseUrl}/api/app/invitations`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `other-${driverEmail}`,
        displayName: 'Deuxième invitation interdite',
        role: 'driver',
        driverId: firstDriver.rows[0].id,
      }),
    });
    ensure(duplicateDriverInvitation.status === 409, 'Un profil livreur ne doit pas recevoir deux invitations actives.');

    const publicInvitation = await json(await fetch(`${baseUrl}/api/public/invitations/${encodeURIComponent(invitationToken)}`));
    ensure(publicInvitation.response.ok && publicInvitation.payload.role === 'driver', 'Invitation publique invalide.');
    const accepted = await json(await fetch(`${baseUrl}/api/public/invitations/${encodeURIComponent(invitationToken)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: driverPassword, passwordConfirmation: driverPassword }),
    }));
    ensure(accepted.response.status === 201 && accepted.payload.redirect === '/driver', `Activation livreur impossible : ${JSON.stringify(accepted.payload)}`);
    const acceptedCookie = accepted.response.headers.get('set-cookie')?.split(';')[0];
    ensure(acceptedCookie, 'La session livreur n’a pas été créée après activation.');
    const acceptedUser = await pool.query('SELECT id FROM users WHERE email = $1', [driverEmail]);
    invitedUserId = acceptedUser.rows[0]?.id;
    ensure(invitedUserId, 'Utilisateur livreur absent après activation.');

    const reusedInvitation = await fetch(`${baseUrl}/api/public/invitations/${encodeURIComponent(invitationToken)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: driverPassword, passwordConfirmation: driverPassword }),
    });
    ensure(reusedInvitation.status === 410, `Une invitation utilisée devait être refusée en 410, reçu ${reusedInvitation.status}.`);

    const driverLogin = await fetch(`${baseUrl}/app/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: driverEmail, password: driverPassword }),
    });
    ensure(driverLogin.status === 302 && driverLogin.headers.get('location') === '/driver', 'Le compte livreur ne redirige pas vers son espace.');
    const driverCookie = driverLogin.headers.get('set-cookie')?.split(';')[0] || acceptedCookie;
    const driverContext = await json(await fetch(`${baseUrl}/api/driver/context`, { headers: { Cookie: driverCookie } }));
    ensure(driverContext.response.ok && String(driverContext.payload.driver?.id) === String(driverIds[0]), 'Contexte livreur incorrect.');
    const driverPage = await fetch(`${baseUrl}/driver`, { headers: { Cookie: driverCookie }, redirect: 'manual' });
    ensure(driverPage.status === 200, 'L’espace mobile du livreur est inaccessible.');
    const forbiddenCompanyPage = await fetch(`${baseUrl}/app`, { headers: { Cookie: driverCookie }, redirect: 'manual' });
    ensure(forbiddenCompanyPage.status === 302 && forbiddenCompanyPage.headers.get('location') === '/driver', 'Un livreur ne doit pas ouvrir l’espace d’exploitation.');
    const forbiddenDriverPage = await fetch(`${baseUrl}/driver`, { headers: { Cookie: ownerCookie }, redirect: 'manual' });
    ensure(forbiddenDriverPage.status === 302 && forbiddenDriverPage.headers.get('location') === '/app', 'Un compte bureau ne doit pas utiliser l’interface livreur.');
    await pool.query('UPDATE drivers SET active = FALSE WHERE id = $1', [driverIds[0]]);
    const disabledDriverContext = await fetch(`${baseUrl}/api/driver/context`, { headers: { Cookie: driverCookie } });
    ensure(disabledDriverContext.status === 403, 'Un livreur désactivé ne doit plus agir avec une session existante.');
    await pool.query('UPDATE drivers SET active = TRUE WHERE id = $1', [driverIds[0]]);
    const forbiddenStaffApi = await fetch(`${baseUrl}/api/app/orders`, { headers: { Cookie: driverCookie } });
    ensure(forbiddenStaffApi.status === 403, 'Un livreur ne doit pas accéder à l’API d’exploitation.');

    for (const [index, driverId] of driverIds.entries()) {
      const created = await json(await fetch(`${baseUrl}/api/app/orders`, {
        method: 'POST',
        headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: `Client portail livreur ${marker}-${index + 1}`,
          customerPhone: `2290000000${index + 3}`,
          deliveryAddress: `Zone de test ${index + 1}`,
          driverId,
        }),
      }));
      ensure(created.response.status === 201 && created.payload.orderId, `Création de commande test impossible : ${JSON.stringify(created.payload)}`);
      orderIds.push(created.payload.orderId);
    }

    const ownOrders = await json(await fetch(`${baseUrl}/api/driver/orders`, { headers: { Cookie: driverCookie } }));
    ensure(ownOrders.response.ok && ownOrders.payload.some((order) => String(order.id) === String(orderIds[0])), 'La commande affectée est absente.');
    ensure(!ownOrders.payload.some((order) => String(order.id) === String(orderIds[1])), 'Une commande d’un autre livreur a été exposée.');
    const ownDetail = await fetch(`${baseUrl}/api/driver/orders/${orderIds[0]}`, { headers: { Cookie: driverCookie } });
    ensure(ownDetail.status === 200, 'Le livreur ne peut pas ouvrir sa commande.');
    const foreignDetail = await fetch(`${baseUrl}/api/driver/orders/${orderIds[1]}`, { headers: { Cookie: driverCookie } });
    ensure(foreignDetail.status === 404, `La commande d’un autre livreur devait être masquée, reçu ${foreignDetail.status}.`);
    const foreignTransition = await fetch(`${baseUrl}/api/driver/orders/${orderIds[1]}/transition`, {
      method: 'POST',
      headers: { Cookie: driverCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus: 'Récupérée', idempotencyKey: `driver-foreign-${marker}` }),
    });
    ensure(foreignTransition.status === 404, 'Un livreur a pu agir sur une commande étrangère.');

    const transitionKey = `driver-transition-${marker}`;
    const transitioned = await json(await fetch(`${baseUrl}/api/driver/orders/${orderIds[0]}/transition`, {
      method: 'POST',
      headers: { Cookie: driverCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus: 'Récupérée', idempotencyKey: transitionKey }),
    }));
    ensure(transitioned.response.ok && transitioned.payload.status === 'Récupérée', 'Transition livreur impossible.');
    const repeatedTransition = await json(await fetch(`${baseUrl}/api/driver/orders/${orderIds[0]}/transition`, {
      method: 'POST',
      headers: { Cookie: driverCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus: 'Récupérée', idempotencyKey: transitionKey }),
    }));
    ensure(repeatedTransition.response.ok && repeatedTransition.payload.alreadyApplied, 'La transition répétée a été dupliquée.');

    const incident = await json(await fetch(`${baseUrl}/api/driver/orders/${orderIds[0]}/incidents`, {
      method: 'POST',
      headers: { Cookie: driverCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'adresse', severity: 'medium', description: 'Repère difficile à identifier', idempotencyKey: `driver-incident-${marker}` }),
    }));
    ensure(incident.response.status === 201 && incident.payload.id, 'Signalement d’incident impossible.');
    const foreignIncident = await fetch(`${baseUrl}/api/driver/orders/${orderIds[1]}/incidents`, {
      method: 'POST',
      headers: { Cookie: driverCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'adresse', severity: 'low', description: 'Tentative étrangère', idempotencyKey: `driver-foreign-incident-${marker}` }),
    });
    ensure(foreignIncident.status === 404, 'Un incident a pu être créé sur une commande étrangère.');

    console.log('Smoke livreur réussi : invitation, session, cloisonnement, transitions et incidents.');
  } finally {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (orderIds.length) {
        await client.query("DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = ANY($1::bigint[])", [orderIds]);
        await client.query('DELETE FROM orders WHERE id = ANY($1::bigint[])', [orderIds]);
      }
      if (invitationId) await client.query("DELETE FROM audit_logs WHERE entity_type = 'user_invitation' AND entity_id = $1", [invitationId]);
      if (invitedUserId) {
        await client.query('DELETE FROM app_sessions WHERE user_id = $1', [invitedUserId]);
        await client.query('DELETE FROM users WHERE id = $1', [invitedUserId]);
      }
      if (invitationId) await client.query('DELETE FROM user_invitations WHERE id = $1', [invitationId]);
      if (driverIds.length) {
        await client.query("DELETE FROM audit_logs WHERE entity_type = 'driver' AND entity_id = ANY($1::bigint[])", [driverIds]);
        await client.query('DELETE FROM drivers WHERE id = ANY($1::bigint[])', [driverIds]);
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

run().catch((error) => {
  console.error(`Smoke livreur échoué : ${error.message}`);
  process.exitCode = 1;
});
