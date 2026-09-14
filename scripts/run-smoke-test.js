const { Pool } = require('pg');

const nativeFetch = global.fetch;
global.fetch = (url, options = {}) => nativeFetch(url, {
  ...options,
  signal: options.signal || AbortSignal.timeout(30000),
});

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
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const driverIds = [];
  const orderIds = [];
  const runIds = [];
  let foreignCompanyId;
  try {
    const login = await fetch(`${baseUrl}/app/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: email, password }),
    });
    ensure(login.status === 302, `Connexion impossible (${login.status}).`);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    ensure(cookie, 'Cookie de session absent.');
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const context = await json(await fetch(`${baseUrl}/api/app/context`, { headers: { Cookie: cookie } }));
    ensure(context.response.ok && context.payload.company?.id, 'Contexte entreprise indisponible.');
    const companyId = context.payload.company.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const driver = await client.query(
        `INSERT INTO drivers (company_id, name, traccar_unique_id, capacity, availability_status, active)
         VALUES ($1, $2, $3, 4, 'available', TRUE) RETURNING id`,
        [companyId, `Livreur tournée ${marker}`, `run-smoke-${marker}`]
      );
      driverIds.push(driver.rows[0].id);
      const otherDriver = await client.query(
        `INSERT INTO drivers (company_id, name, traccar_unique_id, capacity, availability_status, active)
         VALUES ($1, $2, $3, 3, 'available', TRUE) RETURNING id`,
        [companyId, `Autre livreur ${marker}`, `run-smoke-other-${marker}`]
      );
      driverIds.push(otherDriver.rows[0].id);
      const destinations = [
        [6.3703, 2.3912], [6.4021, 2.3651], [6.4482, 2.3547], [6.5081, 2.3324], [6.5621, 2.3164],
      ];
      for (let index = 0; index < destinations.length; index += 1) {
        const order = await client.query(
          `INSERT INTO orders (
             company_id, driver_id, customer_name, customer_phone, delivery_address,
             neighborhood, requested_time, destination_lat, destination_lng, status
           ) VALUES ($1, $2, $3, '22900000000', $4, $4, $5, $6, $7, 'Confirmée') RETURNING id`,
          [companyId, driver.rows[0].id, `Client tournée ${index + 1} ${marker}`, `Zone test ${index + 1}`, `${8 + index} h - ${10 + index} h`, destinations[index][0], destinations[index][1]]
        );
        orderIds.push(order.rows[0].id);
      }
      const wrongDriverOrder = await client.query(
        `INSERT INTO orders (company_id, driver_id, customer_name, delivery_address, status)
         VALUES ($1, $2, $3, 'Zone test', 'Confirmée') RETURNING id`,
        [companyId, otherDriver.rows[0].id, `Mauvais livreur ${marker}`]
      );
      orderIds.push(wrongDriverOrder.rows[0].id);
      const foreignCompany = await client.query(
        `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
        [`Entreprise étrangère ${marker}`, `run-smoke-foreign-${marker}`]
      );
      foreignCompanyId = foreignCompany.rows[0].id;
      const foreignDriver = await client.query(
        `INSERT INTO drivers (company_id, name, traccar_unique_id) VALUES ($1, 'Livreur externe', $2) RETURNING id`,
        [foreignCompanyId, `foreign-${marker}`]
      );
      const foreignOrder = await client.query(
        `INSERT INTO orders (company_id, driver_id, customer_name, delivery_address, status)
         VALUES ($1, $2, 'Client externe', 'Hors périmètre', 'Confirmée') RETURNING id`,
        [foreignCompanyId, foreignDriver.rows[0].id]
      );
      orderIds.push(foreignOrder.rows[0].id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const serviceDate = new Date().toISOString().slice(0, 10);
    const createKey = `run-smoke-create:${marker}`;
    const created = await json(await fetch(`${baseUrl}/api/app/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ driverId: driverIds[0], name: `Tournée automatique ${marker}`, serviceDate, idempotencyKey: createKey }),
    }));
    ensure(created.response.status === 201 && created.payload.id, 'Création de tournée impossible.');
    ensure(created.payload.service_date === serviceDate, 'La date civile de la tournée a été décalée par le fuseau horaire.');
    runIds.push(created.payload.id);
    const repeatedCreate = await json(await fetch(`${baseUrl}/api/app/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ driverId: driverIds[0], name: `Tournée automatique ${marker}`, serviceDate, idempotencyKey: createKey }),
    }));
    ensure(repeatedCreate.response.ok && repeatedCreate.payload.alreadyApplied, 'La création répétée doit rester sans doublon.');
    const conflictingCreate = await fetch(`${baseUrl}/api/app/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ driverId: driverIds[0], name: 'Conflit volontaire', serviceDate, idempotencyKey: `run-smoke-conflict:${marker}` }),
    });
    ensure(conflictingCreate.status === 409, 'Deux tournées ouvertes le même jour pour le même livreur doivent être refusées.');

    let detail = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    const addKey = `run-smoke-add-1:${marker}`;
    const firstAdd = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: orderIds[0], expectedVersion: detail.version, idempotencyKey: addKey }),
    }));
    ensure(firstAdd.response.status === 201, 'Ajout du premier colis impossible.');
    const repeatedAdd = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: orderIds[0], expectedVersion: detail.version, idempotencyKey: addKey }),
    }));
    ensure(repeatedAdd.response.ok && repeatedAdd.payload.alreadyApplied, 'L’ajout répété doit rester sans doublon.');

    detail = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    const concurrent = await Promise.all([orderIds[1], orderIds[2]].map((orderId, index) => fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId, expectedVersion: detail.version, idempotencyKey: `run-smoke-concurrent-${index}:${marker}` }),
    })));
    ensure(concurrent.filter((response) => response.status === 201).length === 1 && concurrent.filter((response) => response.status === 409).length === 1,
      'Deux modifications concurrentes doivent produire un succès et un conflit de version.');
    detail = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    const missingConcurrentOrder = [orderIds[1], orderIds[2]].find((orderId) => !detail.stops.some((stop) => String(stop.order_id) === String(orderId)));
    const addMissing = await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: missingConcurrentOrder, expectedVersion: detail.version, idempotencyKey: `run-smoke-add-missing:${marker}` }),
    });
    ensure(addMissing.status === 201, 'Reprise après conflit impossible.');

    detail = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    const wrongDriver = await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: orderIds[5], expectedVersion: detail.version, idempotencyKey: `run-smoke-wrong-driver:${marker}` }),
    });
    ensure(wrongDriver.status === 409, 'Un colis affecté à un autre livreur doit être refusé.');
    const foreignOrder = await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: orderIds[6], expectedVersion: detail.version, idempotencyKey: `run-smoke-foreign:${marker}` }),
    });
    ensure(foreignOrder.status === 404, 'Un colis d’une autre entreprise doit rester invisible.');

    const secondDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const secondRun = await json(await fetch(`${baseUrl}/api/app/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ driverId: driverIds[0], name: `Tournée secondaire ${marker}`, serviceDate: secondDate, idempotencyKey: `run-smoke-create-2:${marker}` }),
    }));
    ensure(secondRun.response.status === 201, 'Création de la seconde tournée impossible.');
    runIds.push(secondRun.payload.id);
    const duplicateAssignment = await fetch(`${baseUrl}/api/app/runs/${secondRun.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: orderIds[0], expectedVersion: secondRun.payload.version, idempotencyKey: `run-smoke-duplicate:${marker}` }),
    });
    ensure(duplicateAssignment.status === 409, 'Un colis ne doit pas être actif dans deux tournées.');
    const secondAdd = await json(await fetch(`${baseUrl}/api/app/runs/${secondRun.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: orderIds[3], expectedVersion: secondRun.payload.version, idempotencyKey: `run-smoke-second-add:${marker}` }),
    }));
    ensure(secondAdd.response.status === 201, 'Ajout à la seconde tournée impossible.');
    const cancelled = await json(await fetch(`${baseUrl}/api/app/runs/${secondRun.payload.id}/status`, {
      method: 'POST', headers,
      body: JSON.stringify({ toStatus: 'cancelled', reason: 'Annulation contrôlée du test automatique', expectedVersion: secondAdd.payload.version, idempotencyKey: `run-smoke-cancel:${marker}` }),
    }));
    ensure(cancelled.response.ok && cancelled.payload.status === 'cancelled', 'Annulation de tournée impossible.');

    detail = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    const reclaimed = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: orderIds[3], expectedVersion: detail.version, idempotencyKey: `run-smoke-reclaim:${marker}` }),
    }));
    ensure(reclaimed.response.status === 201, 'Un colis libéré par annulation doit pouvoir être replanifié.');

    const overCapacity = await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: orderIds[4], expectedVersion: reclaimed.payload.version, idempotencyKey: `run-smoke-capacity:${marker}` }),
    });
    ensure(overCapacity.status === 409, 'La capacité déclarée du livreur doit être respectée.');

    detail = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    const orderBeforeSuggestion = detail.stops.map((stop) => String(stop.id));
    const suggestion = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/suggestion`, { headers: { Cookie: cookie } }));
    ensure(suggestion.response.ok && suggestion.payload.available && suggestion.payload.stopIds.length === 4, 'Suggestion géométrique indisponible.');
    const afterSuggestion = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    ensure(afterSuggestion.version === detail.version && afterSuggestion.stops.map((stop) => String(stop.id)).join(',') === orderBeforeSuggestion.join(','),
      'Une suggestion ne doit jamais modifier la tournée sans confirmation.');

    const reversedStopIds = [...detail.stops].reverse().map((stop) => Number(stop.id));
    const reorderKey = `run-smoke-reorder:${marker}`;
    const reordered = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/reorder`, {
      method: 'POST', headers,
      body: JSON.stringify({ stopIds: reversedStopIds, expectedVersion: detail.version, idempotencyKey: reorderKey }),
    }));
    ensure(reordered.response.ok, 'Réorganisation des arrêts impossible.');
    const repeatedReorder = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/reorder`, {
      method: 'POST', headers,
      body: JSON.stringify({ stopIds: reversedStopIds, expectedVersion: detail.version, idempotencyKey: reorderKey }),
    }));
    ensure(repeatedReorder.response.ok && repeatedReorder.payload.alreadyApplied, 'La réorganisation répétée doit rester sans doublon.');
    const staleReorder = await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/reorder`, {
      method: 'POST', headers,
      body: JSON.stringify({ stopIds: reversedStopIds, expectedVersion: detail.version, idempotencyKey: `run-smoke-stale:${marker}` }),
    });
    ensure(staleReorder.status === 409, 'Une version ancienne doit être refusée.');

    detail = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    const stopToCorrect = detail.stops[1];
    const removed = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/stops/${stopToCorrect.id}/remove`, {
      method: 'POST', headers,
      body: JSON.stringify({ expectedVersion: detail.version, idempotencyKey: `run-smoke-remove:${marker}` }),
    }));
    ensure(removed.response.ok, 'Correction par retrait impossible.');
    const addedBack = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ orderId: stopToCorrect.order_id, expectedVersion: removed.payload.version, idempotencyKey: `run-smoke-add-back:${marker}` }),
    }));
    ensure(addedBack.response.status === 201, 'Réajout après correction impossible.');

    const planned = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/status`, {
      method: 'POST', headers,
      body: JSON.stringify({ toStatus: 'planned', expectedVersion: addedBack.payload.version, idempotencyKey: `run-smoke-plan:${marker}` }),
    }));
    ensure(planned.response.ok && planned.payload.status === 'planned', 'Planification impossible.');
    detail = (await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}`, { headers: { Cookie: cookie } }))).payload;
    const blockedRemoval = await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/stops/${detail.stops[0].id}/remove`, {
      method: 'POST', headers,
      body: JSON.stringify({ expectedVersion: detail.version, idempotencyKey: `run-smoke-blocked-remove:${marker}` }),
    });
    ensure(blockedRemoval.status === 409, 'Le retrait après planification doit être refusé.');
    const plannedOrder = [...detail.stops].reverse().map((stop) => Number(stop.id));
    const plannedReorder = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/reorder`, {
      method: 'POST', headers,
      body: JSON.stringify({ stopIds: plannedOrder, expectedVersion: detail.version, idempotencyKey: `run-smoke-planned-reorder:${marker}` }),
    }));
    ensure(plannedReorder.response.ok, 'La correction d’ordre avant départ doit rester possible.');
    const active = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/status`, {
      method: 'POST', headers,
      body: JSON.stringify({ toStatus: 'active', expectedVersion: plannedReorder.payload.version, idempotencyKey: `run-smoke-start:${marker}` }),
    }));
    ensure(active.response.ok && active.payload.status === 'active', 'Démarrage de tournée impossible.');
    const prematureCompletion = await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/status`, {
      method: 'POST', headers,
      body: JSON.stringify({ toStatus: 'completed', expectedVersion: active.payload.version, idempotencyKey: `run-smoke-premature:${marker}` }),
    });
    ensure(prematureCompletion.status === 409, 'La clôture avant traitement de tous les colis doit être refusée.');
    await pool.query(`UPDATE orders SET status = 'Livrée', completed_at = NOW(), updated_at = NOW() WHERE id = ANY($1::bigint[])`, [orderIds.slice(0, 4)]);
    const completed = await json(await fetch(`${baseUrl}/api/app/runs/${created.payload.id}/status`, {
      method: 'POST', headers,
      body: JSON.stringify({ toStatus: 'completed', expectedVersion: active.payload.version, idempotencyKey: `run-smoke-complete:${marker}` }),
    }));
    ensure(completed.response.ok && completed.payload.status === 'completed', 'Clôture de tournée impossible après traitement des colis.');
    const activeAssignments = await pool.query(
      `SELECT COUNT(*)::int AS count FROM delivery_stops WHERE run_id = ANY($1::bigint[]) AND assignment_active = TRUE`,
      [runIds]
    );
    ensure(activeAssignments.rows[0].count === 0, 'Les tournées terminales doivent libérer leurs affectations actives.');
    const eventCount = await pool.query(
      `SELECT COUNT(*)::int AS count FROM delivery_run_events WHERE run_id = $1`,
      [created.payload.id]
    );
    ensure(eventCount.rows[0].count >= 10, 'L’historique de tournée est incomplet.');
    const listed = await json(await fetch(`${baseUrl}/api/app/runs`, { headers: { Cookie: cookie } }));
    ensure(listed.response.ok && listed.payload.some((item) => String(item.id) === String(created.payload.id) && item.status === 'completed'), 'Tournée absente de la liste finale.');
    console.log('Smoke tournées réussi : cloisonnement, concurrence, idempotence, corrections, suggestion, cycle de vie et historique.');
  } finally {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (runIds.length) {
        await client.query(`DELETE FROM audit_logs WHERE entity_type = 'delivery_run' AND entity_id = ANY($1::bigint[])`, [runIds]);
        await client.query('DELETE FROM delivery_runs WHERE id = ANY($1::bigint[])', [runIds]);
      }
      if (orderIds.length) await client.query('DELETE FROM orders WHERE id = ANY($1::bigint[])', [orderIds]);
      if (driverIds.length) await client.query('DELETE FROM drivers WHERE id = ANY($1::bigint[])', [driverIds]);
      if (foreignCompanyId) {
        await client.query('DELETE FROM drivers WHERE company_id = $1', [foreignCompanyId]);
        await client.query('DELETE FROM companies WHERE id = $1', [foreignCompanyId]);
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
  console.error(`Smoke tournées échoué : ${error.message}`);
  process.exitCode = 1;
});
