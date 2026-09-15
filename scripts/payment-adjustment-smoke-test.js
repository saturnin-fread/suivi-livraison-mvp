const crypto = require('node:crypto');
const { Pool } = require('pg');

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const email = process.env.ADMIN_USER;
const password = process.env.ADMIN_PASSWORD;
const nativeFetch = global.fetch;
global.fetch = (url, options = {}) => nativeFetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) });

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response) {
  return { response, payload: await response.json().catch(() => ({})) };
}

function hashPassword(value, salt) {
  return crypto.scryptSync(value, salt, 64).toString('hex');
}

function localDate(offsetDays = 0) {
  const date = new Date(Date.now() + (offsetDays * 86400000));
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

async function run() {
  ensure(email && password && process.env.DATABASE_URL, 'ADMIN_USER, ADMIN_PASSWORD et DATABASE_URL sont requis.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
  const marker = crypto.randomBytes(10).toString('hex');
  const ids = { orders: [], drivers: [] };
  let companyId;
  let operatorUserId;
  let foreignCompanyId;
  try {
    const login = await fetch(`${baseUrl}/app/login`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: email, password }),
    });
    ensure(login.status === 302, 'Connexion propriétaire impossible.');
    const ownerCookie = login.headers.get('set-cookie')?.split(';')[0];
    const context = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: ownerCookie } }));
    ensure(context.response.ok, 'Contexte entreprise indisponible.');
    companyId = context.payload.company.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const driver = await client.query(
        `INSERT INTO drivers (company_id, name, traccar_unique_id) VALUES ($1, $2, $3) RETURNING id`,
        [companyId, `Livreur ajustement ${marker}`, `payment-adjustment-${marker}`]
      );
      ids.drivers.push(driver.rows[0].id);
      const orders = await client.query(
        `INSERT INTO orders (company_id, driver_id, customer_name, delivery_address, status, completed_at, status_changed_at)
         VALUES
           ($1, $2, $3, 'Zone finance A', 'Livrée', NOW(), NOW()),
           ($1, $2, $4, 'Zone finance B', 'Confirmée', NULL, NOW())
         RETURNING id`,
        [companyId, driver.rows[0].id, `Client clôturé ${marker}`, `Client actif ${marker}`]
      );
      ids.orders.push(...orders.rows.map((row) => row.id));
      await client.query(
        `INSERT INTO order_payment_accounts (
           company_id, order_id, expected_amount_minor, currency, status, collected_amount_minor,
           collection_method, collected_at, reconciled_at
         ) VALUES
           ($1, $2, 5000, 'XOF', 'reconciled', 5000, 'cash', NOW(), NOW()),
           ($1, $3, 5000, 'XOF', 'collected', 5000, 'cash', NOW(), NULL)`,
        [companyId, ids.orders[0], ids.orders[1]]
      );
      const salt = crypto.randomBytes(16).toString('hex');
      const operatorPassword = `Operator-${marker}-Aa1!`;
      const operator = await client.query(
        `INSERT INTO users (email, display_name, password_salt, password_hash)
         VALUES ($1, 'Opérateur ajustement', $2, $3) RETURNING id`,
        [`payment-operator-${marker}@example.invalid`, salt, hashPassword(operatorPassword, salt)]
      );
      operatorUserId = operator.rows[0].id;
      await client.query(
        `INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'operator')`,
        [companyId, operatorUserId]
      );
      const foreignCompany = await client.query(
        `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
        [`Entreprise ajustement étrangère ${marker}`, `payment-adjustment-foreign-${marker}`]
      );
      foreignCompanyId = foreignCompany.rows[0].id;
      const foreignDriver = await client.query(
        `INSERT INTO drivers (company_id, name, traccar_unique_id) VALUES ($1, 'Livreur étranger', $2) RETURNING id`,
        [foreignCompanyId, `payment-adjustment-foreign-${marker}`]
      );
      ids.drivers.push(foreignDriver.rows[0].id);
      const foreignOrder = await client.query(
        `INSERT INTO orders (company_id, driver_id, customer_name, delivery_address, status, completed_at)
         VALUES ($1, $2, 'Client étranger', 'Hors périmètre', 'Livrée', NOW()) RETURNING id`,
        [foreignCompanyId, foreignDriver.rows[0].id]
      );
      ids.orders.push(foreignOrder.rows[0].id);
      await client.query(
        `INSERT INTO order_payment_accounts (company_id, order_id, expected_amount_minor, currency, status, collected_amount_minor, collection_method, collected_at)
         VALUES ($1, $2, 5000, 'XOF', 'collected', 5000, 'cash', NOW())`,
        [foreignCompanyId, foreignOrder.rows[0].id]
      );
      await client.query('COMMIT');

      const operatorLogin = await fetch(`${baseUrl}/app/login`, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user: `payment-operator-${marker}@example.invalid`, password: operatorPassword }),
      });
      ensure(operatorLogin.status === 302, 'Connexion opérateur impossible.');
      ids.operatorCookie = operatorLogin.headers.get('set-cookie')?.split(';')[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const endpoint = `${baseUrl}/api/app/orders/${ids.orders[0]}/payment/adjustments`;
    const headers = { Cookie: ownerCookie, 'Content-Type': 'application/json' };
    const payload = (overrides = {}) => ({
      adjustmentType: 'refund', amountMinor: 1000, method: 'cash', reference: 'Reçu test',
      reason: 'Remboursement commercial validé par le responsable', effectiveDate: localDate(),
      idempotencyKey: `payment-adjustment-refund:${marker}`, ...overrides,
    });

    const shortReason = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload({ reason: 'Court', idempotencyKey: `payment-short:${marker}` })) });
    ensure(shortReason.status === 400, 'Un motif trop court a été accepté.');
    const future = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload({ effectiveDate: localDate(1), idempotencyKey: `payment-future:${marker}` })) });
    ensure(future.status === 400, 'Une date future a été acceptée.');
    const beforeClosure = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload({ effectiveDate: localDate(-1), idempotencyKey: `payment-before-close:${marker}` })) });
    ensure(beforeClosure.status === 400, 'Une date antérieure à la clôture a été acceptée.');
    const activeOrder = await fetch(`${baseUrl}/api/app/orders/${ids.orders[1]}/payment/adjustments`, { method: 'POST', headers, body: JSON.stringify(payload({ idempotencyKey: `payment-active:${marker}` })) });
    ensure(activeOrder.status === 409, 'Une commande non terminée a accepté un ajustement.');
    const foreignOrder = await fetch(`${baseUrl}/api/app/orders/${ids.orders[2]}/payment/adjustments`, { method: 'POST', headers, body: JSON.stringify(payload({ idempotencyKey: `payment-foreign:${marker}` })) });
    ensure(foreignOrder.status === 404, 'Une commande étrangère a été révélée.');
    const operatorAttempt = await fetch(endpoint, {
      method: 'POST', headers: { Cookie: ids.operatorCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload({ idempotencyKey: `payment-operator:${marker}` })),
    });
    ensure(operatorAttempt.status === 403, 'Un opérateur a créé un ajustement comptable.');

    const refundPayload = payload();
    const refund = await json(await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(refundPayload) }));
    ensure(refund.response.status === 201 && refund.payload.resultingTotalMinor === 4000, 'Le remboursement n’a pas produit le total attendu.');
    const repeatedRefund = await json(await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(refundPayload) }));
    ensure(repeatedRefund.response.ok && repeatedRefund.payload.alreadyApplied, 'Le remboursement répété a été dupliqué.');
    const reusedKey = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...refundPayload, amountMinor: 900 }) });
    ensure(reusedKey.status === 409, 'Une clé idempotente a accepté des paramètres différents.');
    const excessive = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload({ amountMinor: 5000, idempotencyKey: `payment-excess:${marker}` })) });
    ensure(excessive.status === 409, 'Un remboursement supérieur au net a été accepté.');

    const concurrent = await Promise.all([0, 1].map((index) => fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify(payload({ amountMinor: 3000, reason: `Remboursement concurrent numéro ${index} validé`, idempotencyKey: `payment-concurrent-${index}:${marker}` })),
    })));
    ensure(concurrent.filter((response) => response.status === 201).length === 1 && concurrent.filter((response) => response.status === 409).length === 1,
      'Deux remboursements concurrents ont dépassé le solde disponible.');

    const additional = await json(await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify(payload({ adjustmentType: 'additional_collection', amountMinor: 2000, method: 'mobile_money', reference: 'MM-TEST', reason: 'Complément reçu après régularisation avec le client', idempotencyKey: `payment-additional:${marker}` })),
    }));
    ensure(additional.response.status === 201 && additional.payload.resultingTotalMinor === 3000, 'Le complément reçu n’a pas produit le total attendu.');
    const reversePayload = { reason: 'Correction de saisie du complément reçu par erreur', effectiveDate: localDate(), idempotencyKey: `payment-reverse-adjustment:${marker}` };
    const reversed = await json(await fetch(`${endpoint}/${additional.payload.id}/reverse`, { method: 'POST', headers, body: JSON.stringify(reversePayload) }));
    ensure(reversed.response.status === 201 && reversed.payload.resultingTotalMinor === 1000, 'L’écriture inverse n’a pas restauré le total.');
    const repeatedReverse = await json(await fetch(`${endpoint}/${additional.payload.id}/reverse`, { method: 'POST', headers, body: JSON.stringify(reversePayload) }));
    ensure(repeatedReverse.response.ok && repeatedReverse.payload.alreadyApplied, 'L’écriture inverse répétée a été dupliquée.');
    const secondReverse = await fetch(`${endpoint}/${additional.payload.id}/reverse`, {
      method: 'POST', headers, body: JSON.stringify({ ...reversePayload, idempotencyKey: `payment-second-reverse:${marker}` }),
    });
    ensure(secondReverse.status === 409, 'Un ajustement a reçu deux écritures inverses.');
    const mutationAttempt = await fetch(`${endpoint}/${refund.payload.id}`, { method: 'PUT', headers, body: '{}' });
    ensure(mutationAttempt.status === 404, 'Une route de modification d’écriture existe.');

    const detail = await json(await fetch(`${baseUrl}/api/app/orders/${ids.orders[0]}`, { headers: { Cookie: ownerCookie } }));
    ensure(detail.response.ok && detail.payload.paymentAdjustedTotalMinor === 1000 && detail.payload.paymentAdjustments.length === 4,
      'La fiche commande ne restitue pas le journal et le total ajusté.');
    const stored = await pool.query('SELECT COUNT(*)::int AS count FROM payment_adjustments WHERE order_id = $1', [ids.orders[0]]);
    ensure(stored.rows[0].count === 4, 'Le nombre d’écritures financières est incorrect.');
    const incident = await json(await fetch(`${baseUrl}/api/app/orders/${ids.orders[0]}/incidents`, {
      method: 'POST', headers,
      body: JSON.stringify({
        category: 'paiement', severity: 'medium',
        description: 'Vérification du journal financier après correction',
        idempotencyKey: `payment-adjustment-incident:${marker}`,
      }),
    }));
    ensure(incident.response.status === 201 && incident.payload.id, 'Le dossier de contrôle financier n’a pas été créé.');
    const dossier = await json(await fetch(`${baseUrl}/api/app/incidents/${incident.payload.id}/export`, { headers: { Cookie: ownerCookie } }));
    ensure(dossier.response.ok && dossier.payload.paymentAdjustments?.length === 4,
      'L’export de litige ne contient pas les ajustements financiers.');
    console.log('Smoke ajustements financiers réussi : droits, dates, idempotence, concurrence, remboursement, complément et écriture inverse.');
  } finally {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (ids.orders.length) {
        await client.query("DELETE FROM audit_logs WHERE entity_type = 'order' AND entity_id = ANY($1::bigint[])", [ids.orders]);
        await client.query('DELETE FROM orders WHERE id = ANY($1::bigint[])', [ids.orders]);
      }
      if (operatorUserId) {
        await client.query('DELETE FROM app_sessions WHERE user_id = $1', [operatorUserId]);
        await client.query('DELETE FROM users WHERE id = $1', [operatorUserId]);
      }
      if (ids.drivers.length) await client.query('DELETE FROM drivers WHERE id = ANY($1::bigint[])', [ids.drivers]);
      if (foreignCompanyId) await client.query('DELETE FROM companies WHERE id = $1', [foreignCompanyId]);
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
  console.error(`Smoke ajustements financiers échoué : ${error.message}`);
  process.exitCode = 1;
});
