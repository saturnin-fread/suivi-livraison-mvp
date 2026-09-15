'use strict';

const fs = require('node:fs/promises');

function normalizePhone(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().replace(/[^\d+]/g, '');
  return normalized || null;
}

function boundedText(value, maximum, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text ? text.slice(0, maximum) : fallback;
}

function safeCoordinates(order) {
  const latitude = Number(order.destination_lat);
  const longitude = Number(order.destination_lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { latitude: null, longitude: null, accuracy: null };
  }
  const parsedAccuracy = Number(order.destination_accuracy);
  return {
    latitude,
    longitude,
    accuracy: Number.isFinite(parsedAccuracy) && parsedAccuracy >= 0 ? parsedAccuracy : null,
  };
}

async function applyCrmSchema(pool, schemaPath) {
  if (!pool) return;
  const sql = await fs.readFile(schemaPath, 'utf8');
  await pool.query(sql);
}

async function setCompanyContext(client, companyId) {
  await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyId)]);
}

async function withCompanyTransaction(pool, companyId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setCompanyContext(client, companyId);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensureOrderCrmSnapshot(client, orderId, actorUserId = null) {
  const orderResult = await client.query(
    `SELECT o.id, o.company_id, o.customer_request_id, o.customer_id,
            o.customer_name, o.customer_phone, o.delivery_address,
            o.neighborhood, o.landmark, o.notes, o.destination_lat,
            o.destination_lng, o.destination_accuracy, o.created_at,
            r.location_at
     FROM orders o
     LEFT JOIN customer_requests r
       ON r.id = o.customer_request_id AND r.company_id = o.company_id
     WHERE o.id = $1
     FOR UPDATE OF o`,
    [orderId]
  );
  const order = orderResult.rows[0];
  if (!order) throw new Error('Commande introuvable pendant la synchronisation CRM.');
  await setCompanyContext(client, order.company_id);
  const displayName = boundedText(order.customer_name, 200, `Client commande ${order.id}`);
  const coordinates = safeCoordinates(order);
  const neighborhood = boundedText(order.neighborhood, 200);
  const deliveryAddress = boundedText(order.delivery_address, 1000);
  const landmark = boundedText(order.landmark, 500);
  const instructions = boundedText(order.notes, 2000);

  const customer = await client.query(
    `INSERT INTO customers (
       company_id, customer_code, display_name, created_from_request_id,
       created_by_user_id, updated_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $5, $6, NOW())
     ON CONFLICT (company_id, customer_code) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       updated_by_user_id = COALESCE(EXCLUDED.updated_by_user_id, customers.updated_by_user_id),
       updated_at = NOW(),
       version = customers.version + 1
     RETURNING id`,
    [
      order.company_id,
      `AUTO-ORDER-${order.id}`,
      displayName,
      order.customer_request_id,
      actorUserId,
      order.created_at,
    ]
  );
  const customerId = customer.rows[0].id;

  let contactId = null;
  const phone = boundedText(order.customer_phone, 320, '');
  if (phone) {
    const existingContact = await client.query(
      `SELECT id FROM customer_contacts
       WHERE company_id = $1 AND customer_id = $2 AND kind = 'phone'
         AND is_primary = TRUE AND anonymized_at IS NULL
       ORDER BY id LIMIT 1`,
      [order.company_id, customerId]
    );
    if (existingContact.rows[0]) {
      contactId = existingContact.rows[0].id;
      await client.query(
        `UPDATE customer_contacts
         SET value_display = $1, value_normalized = $2, is_active = TRUE,
             updated_by_user_id = COALESCE($3, updated_by_user_id),
             updated_at = NOW(), version = version + 1
         WHERE id = $4 AND company_id = $5 AND customer_id = $6`,
        [phone, normalizePhone(phone), actorUserId, contactId, order.company_id, customerId]
      );
    } else {
      const insertedContact = await client.query(
        `INSERT INTO customer_contacts (
           company_id, customer_id, kind, value_display, value_normalized,
           is_primary, created_by_user_id, updated_by_user_id
         ) VALUES ($1, $2, 'phone', $3, $4, TRUE, $5, $5)
         RETURNING id`,
        [order.company_id, customerId, phone, normalizePhone(phone), actorUserId]
      );
      contactId = insertedContact.rows[0].id;
    }
  }

  const locationLabel = `Livraison commande ${order.id}`;
  const existingLocation = await client.query(
    `SELECT id FROM customer_locations
     WHERE company_id = $1 AND customer_id = $2 AND label = $3
     ORDER BY id LIMIT 1`,
    [order.company_id, customerId, locationLabel]
  );
  let locationId;
  const coordinateSource = coordinates.latitude == null ? null : (order.customer_request_id ? 'customer_gps' : 'operator');
  const capturedAt = coordinates.latitude == null ? null : (order.location_at || order.created_at);
  if (existingLocation.rows[0]) {
    locationId = existingLocation.rows[0].id;
    await client.query(
      `UPDATE customer_locations SET
         neighborhood = $1, address_text = $2, landmark = $3,
         delivery_instructions = $4, latitude = $5, longitude = $6,
         accuracy_meters = $7, coordinate_source = $8,
         coordinates_captured_at = $9, last_used_at = $10,
         updated_by_user_id = COALESCE($11, updated_by_user_id),
         updated_at = NOW(), version = version + 1
       WHERE id = $12 AND company_id = $13 AND customer_id = $14`,
      [neighborhood, deliveryAddress, landmark, instructions,
        coordinates.latitude, coordinates.longitude, coordinates.accuracy,
        coordinateSource, capturedAt, order.created_at, actorUserId,
        locationId, order.company_id, customerId]
    );
  } else {
    const insertedLocation = await client.query(
      `INSERT INTO customer_locations (
         company_id, customer_id, label, neighborhood, address_text, landmark,
         delivery_instructions, latitude, longitude, accuracy_meters,
         coordinate_source, coordinates_captured_at, last_used_at,
         created_by_user_id, updated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       RETURNING id`,
      [order.company_id, customerId, locationLabel, neighborhood,
        deliveryAddress, landmark, instructions, coordinates.latitude,
        coordinates.longitude, coordinates.accuracy, coordinateSource,
        capturedAt, order.created_at, actorUserId]
    );
    locationId = insertedLocation.rows[0].id;
  }

  await client.query(
    `UPDATE orders
     SET customer_id = $1, customer_contact_id = $2, customer_location_id = $3
     WHERE id = $4 AND company_id = $5`,
    [customerId, contactId, locationId, order.id, order.company_id]
  );
  if (order.customer_request_id) {
    await client.query(
      `UPDATE customer_requests
       SET customer_id = $1, customer_contact_id = $2, customer_location_id = $3
       WHERE id = $4 AND company_id = $5`,
      [customerId, contactId, locationId, order.customer_request_id, order.company_id]
    );
  }
  return { companyId: order.company_id, customerId, contactId, locationId };
}

async function synchronizeExistingOrders(pool) {
  if (!pool) return { synchronized: 0 };
  const candidates = await pool.query(
    `SELECT id, company_id FROM orders
     WHERE customer_id IS NULL
     ORDER BY id ASC`
  );
  for (const row of candidates.rows) {
    await withCompanyTransaction(pool, row.company_id, (client) => ensureOrderCrmSnapshot(client, row.id));
  }
  return { synchronized: candidates.rowCount };
}

module.exports = {
  applyCrmSchema,
  ensureOrderCrmSnapshot,
  setCompanyContext,
  synchronizeExistingOrders,
  withCompanyTransaction,
};
