'use strict';

const assert = require('node:assert/strict');
const { CONTRACT_VERSION, TIME_ZONE, calculateCrmMetrics, portoNovoDateKey } = require('../lib/crm-metrics');

const COMPANY = 'company-a';
const PERIOD = {
  startInclusive: '2026-08-31T23:00:00.000Z',
  endExclusive: '2026-09-30T23:00:00.000Z',
};
const AS_OF = '2026-09-15T11:00:00.000Z';

function row(values) {
  return { companyId: COMPANY, ...values };
}

function emptyInput(overrides = {}) {
  return {
    companyId: COMPANY,
    period: PERIOD,
    asOf: AS_OF,
    orders: [],
    statusEvents: [],
    paymentAccounts: [],
    paymentEvents: [],
    paymentAdjustments: [],
    incidents: [],
    drivers: [],
    runs: [],
    stops: [],
    ...overrides,
  };
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('le fuseau Porto-Novo détermine la date civile sans dépendre du fuseau machine', () => {
  assert.equal(TIME_ZONE, 'Africa/Porto-Novo');
  assert.equal(portoNovoDateKey('2026-09-30T23:30:00.000Z'), '2026-10-01');
  assert.equal(portoNovoDateKey('2026-09-30T22:59:59.999Z'), '2026-09-30');
});

test('les volumes et le taux de remise suivent les premiers événements métier', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [
      row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'Livrée' }),
      row({ id: 2, createdAt: '2026-09-02T08:00:00Z', status: 'Retournée' }),
      row({ id: 3, createdAt: '2026-09-03T08:00:00Z', status: 'Annulée' }),
      row({ id: 4, createdAt: '2026-08-30T08:00:00Z', status: 'Confirmée' }),
    ],
    statusEvents: [
      row({ orderId: 1, toStatus: 'Récupérée', createdAt: '2026-09-01T09:00:00Z' }),
      row({ orderId: 1, toStatus: 'Récupérée', createdAt: '2026-09-01T09:01:00Z' }),
      row({ orderId: 1, toStatus: 'Livrée', createdAt: '2026-09-01T10:00:00Z' }),
      row({ orderId: 2, toStatus: 'Récupérée', createdAt: '2026-09-02T09:00:00Z' }),
      row({ orderId: 2, toStatus: 'Retournée', createdAt: '2026-09-02T10:00:00Z' }),
      row({ orderId: 3, toStatus: 'Annulée', createdAt: '2026-09-03T09:00:00Z' }),
    ],
  }));

  assert.equal(result.contractVersion, CONTRACT_VERSION);
  assert.equal(result.volumes.ordersCreated.value, 3);
  assert.equal(result.volumes.ordersPickedUp.value, 2);
  assert.equal(result.volumes.closed.value, 3);
  assert.deepEqual(result.volumes.outcomes, { delivered: 1, returned: 1, cancelled: 1 });
  assert.equal(result.delivery.deliveryRate.value, 0.5);
  assert.equal(result.delivery.deliveryRate.denominator, 2);
});

test('un dénominateur nul reste non calculable et ne devient jamais zéro pourcent', () => {
  const result = calculateCrmMetrics(emptyInput());
  assert.equal(result.delivery.deliveryRate.status, 'not_calculable');
  assert.equal(result.delivery.deliveryRate.value, null);
  assert.equal(result.delivery.deliveryRate.denominator, 0);
  assert.equal(result.incidents.per100PickedUpOrders.value, null);
});

test('des issues terminales contradictoires excluent la commande au lieu de choisir arbitrairement', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'Retournée' })],
    statusEvents: [
      row({ orderId: 1, toStatus: 'Livrée', createdAt: '2026-09-01T10:00:00Z' }),
      row({ orderId: 1, toStatus: 'Retournée', createdAt: '2026-09-01T11:00:00Z' }),
    ],
  }));
  assert.equal(result.volumes.closed.value, 0);
  assert.equal(result.dataQuality.exclusions.orders_with_conflicting_terminal_events, 1);
});

test('les retards sont masqués si l’échantillon fiable ou sa couverture sont insuffisants', () => {
  const orders = [];
  const statusEvents = [];
  for (let id = 1; id <= 10; id += 1) {
    orders.push(row({
      id,
      createdAt: '2026-09-01T08:00:00Z',
      status: 'Arrivée',
      promisedWindowReliable: id !== 10,
      promisedWindowEnd: '2026-09-05T09:00:00Z',
      promisedWindowRecordedAt: '2026-09-04T09:00:00Z',
    }));
    statusEvents.push(row({
      orderId: id,
      toStatus: 'Arrivée',
      actualArrivalReliable: true,
      createdAt: id <= 5 ? '2026-09-05T08:55:00Z' : '2026-09-05T09:30:00Z',
    }));
  }
  const insufficientSample = calculateCrmMetrics(emptyInput({ orders, statusEvents }));
  assert.equal(insufficientSample.delays.status, 'insufficient_sample');
  assert.equal(insufficientSample.delays.lateRate, null);
  assert.equal(insufficientSample.delays.reliableSampleSize, 9);

  const insufficientCoverage = calculateCrmMetrics(emptyInput({ orders, statusEvents }), {
    delayMinimumSampleSize: 1,
    delayMinimumCoverage: 0.95,
  });
  assert.equal(insufficientCoverage.delays.status, 'insufficient_coverage');
  assert.equal(insufficientCoverage.delays.coverage, 0.9);
});

test('les retards fiables exposent volumes, taux, médiane et P90 explicables', () => {
  const orders = [];
  const statusEvents = [];
  for (let id = 1; id <= 10; id += 1) {
    orders.push(row({
      id,
      createdAt: '2026-09-01T08:00:00Z',
      status: 'Arrivée',
      promisedWindowReliable: true,
      promisedWindowEnd: '2026-09-05T09:00:00Z',
      promisedWindowRecordedAt: '2026-09-04T09:00:00Z',
    }));
    statusEvents.push(row({
      orderId: id,
      toStatus: 'Arrivée',
      actualArrivalReliable: true,
      createdAt: id <= 5
        ? '2026-09-05T08:55:00Z'
        : `2026-09-05T09:${String((id - 5) * 10).padStart(2, '0')}:00Z`,
    }));
  }
  const result = calculateCrmMetrics(emptyInput({ orders, statusEvents }));
  assert.equal(result.delays.status, 'available');
  assert.equal(result.delays.lateCount, 5);
  assert.equal(result.delays.lateRate, 0.5);
  assert.equal(result.delays.lateNumerator, 5);
  assert.equal(result.delays.lateDenominator, 10);
  assert.equal(result.delays.medianLateMinutes, 30);
  assert.equal(result.delays.p90LateMinutes, 50);
});

test('les encaissements utilisent le ledger, les dates effectives et ne mélangent pas les devises', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'Livrée' })],
    statusEvents: [row({ orderId: 1, toStatus: 'Livrée', createdAt: '2026-09-02T08:00:00Z' })],
    paymentAccounts: [row({ id: 10, orderId: 1, expectedAmountMinor: '12000', currency: 'XOF' })],
    paymentEvents: [
      row({ id: 20, orderId: 1, eventType: 'collected', amountMinor: '12000', currency: 'XOF', createdAt: '2026-09-02T08:05:00Z' }),
      row({ id: 21, orderId: 1, eventType: 'reversed', amountMinor: 2000, currency: 'XOF', createdAt: '2026-09-02T08:06:00Z' }),
      row({ id: 22, orderId: 1, eventType: 'collected', amountMinor: 15, currency: 'EUR', createdAt: '2026-09-02T08:07:00Z' }),
    ],
    paymentAdjustments: [
      row({ id: 30, orderId: 1, direction: 'inflow', amountMinor: 1000, currency: 'XOF', effectiveDate: '2026-09-10' }),
      row({ id: 31, orderId: 1, direction: 'outflow', amountMinor: 500, currency: 'XOF', effectiveDate: '2026-09-11' }),
      row({ id: 32, orderId: 1, direction: 'inflow', amountMinor: 999, currency: 'XOF', effectiveDate: '2026-10-01' }),
      row({ id: 33, orderId: 1, direction: 'inflow', amountMinor: 999, currency: 'XOF', effectiveDate: '2026-09-99' }),
    ],
  }));
  const xof = result.collections.currencies.find((item) => item.currency === 'XOF');
  const eur = result.collections.currencies.find((item) => item.currency === 'EUR');
  assert.equal(xof.expectedForClosedOrdersMinor, 12000);
  assert.equal(xof.netCollectedMinor, 10500);
  assert.equal(eur.netCollectedMinor, 15);
  assert.equal(result.dataQuality.exclusions.payment_adjustment_invalid_effective_date, 1);
});

test('les incidents distinguent ouverture, résolution, stock ouvert et contexte sans faute', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'En tournée' })],
    statusEvents: [row({ orderId: 1, toStatus: 'Récupérée', createdAt: '2026-09-01T09:00:00Z' })],
    incidents: [
      row({ id: 1, orderId: 1, category: 'adresse', createdAt: '2026-09-02T08:00:00Z', resolvedAt: '2026-09-03T08:00:00Z' }),
      row({ id: 2, orderId: 1, category: 'gps', createdAt: '2026-09-04T08:00:00Z', resolvedAt: null }),
      row({ id: 3, orderId: 1, category: 'gps', createdAt: '2026-08-01T08:00:00Z', resolvedAt: null }),
    ],
  }));
  assert.equal(result.incidents.opened.value, 2);
  assert.equal(result.incidents.resolved.value, 1);
  assert.equal(result.incidents.openAtAsOf.value, 2);
  assert.deepEqual(result.incidents.byCategory, { adresse: 1, gps: 1 });
  assert.match(result.incidents.attributionWarning, /ne prouve pas/);
});

test('le ratio incident exclut les commandes non prises en charge pendant la période', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [
      row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'En tournée' }),
      row({ id: 2, createdAt: '2026-09-01T08:00:00Z', status: 'Confirmée' }),
    ],
    statusEvents: [row({ orderId: 1, toStatus: 'Récupérée', createdAt: '2026-09-01T09:00:00Z' })],
    incidents: [
      row({ id: 1, orderId: 1, createdAt: '2026-09-02T08:00:00Z' }),
      row({ id: 2, orderId: 2, createdAt: '2026-09-02T09:00:00Z' }),
    ],
  }));
  assert.equal(result.incidents.ordersWithIncident, 2);
  assert.equal(result.incidents.per100PickedUpOrders.numerator, 1);
  assert.equal(result.incidents.per100PickedUpOrders.denominator, 1);
});

test('une résolution horodatée sans fuseau est exclue du stock au lieu d’être supposée ouverte', () => {
  const result = calculateCrmMetrics(emptyInput({
    incidents: [row({
      id: 1,
      orderId: 1,
      category: 'autre',
      createdAt: '2026-09-01T08:00:00Z',
      resolvedAt: '2026-09-02 08:00:00',
    })],
  }));
  assert.equal(result.incidents.opened.value, 1);
  assert.equal(result.incidents.resolved.value, 0);
  assert.equal(result.incidents.openAtAsOf.value, 0);
  assert.equal(result.dataQuality.exclusions.incident_resolved_at_invalid, 1);
});

test('une résolution antérieure à la création est exclue des flux et du stock', () => {
  const result = calculateCrmMetrics(emptyInput({
    incidents: [row({
      id: 1,
      orderId: 1,
      createdAt: '2026-09-02T08:00:00Z',
      resolvedAt: '2026-09-01T08:00:00Z',
    })],
  }));
  assert.equal(result.incidents.opened.value, 1);
  assert.equal(result.incidents.resolved.value, 0);
  assert.equal(result.incidents.openAtAsOf.value, 0);
  assert.equal(result.dataQuality.exclusions.incident_resolution_before_creation, 1);
});

test('la charge est un instantané de répartition et ignore les colis terminés', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [
      row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'En tournée' }),
      row({ id: 2, createdAt: '2026-09-01T08:00:00Z', status: 'Livrée' }),
      row({ id: 3, createdAt: '2026-09-01T08:00:00Z', status: 'Confirmée' }),
    ],
    drivers: [row({ id: 7, capacity: 4, availabilityStatus: 'busy' })],
    runs: [
      row({ id: 10, driverId: 7, status: 'active' }),
      row({ id: 11, driverId: 7, status: 'planned' }),
    ],
    stops: [
      row({ id: 1, runId: 10, orderId: 1, assignmentActive: true, createdAt: '2026-09-01T08:00:00Z' }),
      row({ id: 2, runId: 10, orderId: 2, assignmentActive: true, createdAt: '2026-09-01T08:00:00Z' }),
      row({ id: 3, runId: 11, orderId: 3, assignmentActive: true, createdAt: '2026-09-01T08:00:00Z' }),
    ],
  }));
  assert.equal(result.load.openParcelCount, 2);
  assert.equal(result.load.inProgressParcelCount, 1);
  assert.equal(result.load.drivers[0].capacityUse, 0.5);
  assert.match(result.load.warning, /pas une mesure de productivité/);
});

test('la charge ignore une affectation créée après l’instantané', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'Confirmée' })],
    drivers: [row({ id: 7, capacity: 2 })],
    runs: [row({ id: 10, driverId: 7, status: 'planned' })],
    stops: [row({
      id: 1,
      runId: 10,
      orderId: 1,
      assignmentActive: true,
      createdAt: '2026-09-16T08:00:00Z',
    })],
  }));
  assert.equal(result.load.openParcelCount, 0);
});

test('l’activité livreur est attribuée par l’affectation valable au moment de l’événement', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'Livrée' })],
    drivers: [row({ id: 7, capacity: 3 }), row({ id: 8, capacity: 3 })],
    runs: [
      row({ id: 10, driverId: 7, status: 'completed', startedAt: '2026-09-01T08:00:00Z' }),
      row({ id: 11, driverId: 8, status: 'planned' }),
    ],
    stops: [
      row({ id: 1, runId: 10, orderId: 1, assignmentActive: false, createdAt: '2026-09-01T07:00:00Z', removedAt: '2026-09-01T09:30:00Z' }),
      row({ id: 2, runId: 11, orderId: 1, assignmentActive: true, createdAt: '2026-09-01T09:30:00Z' }),
    ],
    statusEvents: [
      row({ orderId: 1, toStatus: 'Récupérée', createdAt: '2026-09-01T09:00:00Z' }),
      row({ orderId: 1, toStatus: 'Livrée', createdAt: '2026-09-01T10:00:00Z' }),
    ],
    incidents: [row({ id: 1, orderId: 1, category: 'adresse', createdAt: '2026-09-01T10:05:00Z' })],
  }));
  const driver7 = result.driverActivity.drivers.find((driver) => driver.driverId === '7');
  const driver8 = result.driverActivity.drivers.find((driver) => driver.driverId === '8');
  assert.equal(driver7.ordersPickedUp, 1);
  assert.equal(driver7.ordersDelivered, 0);
  assert.equal(driver8.ordersDelivered, 1);
  assert.equal(driver8.incidentContexts, 1);
  assert.equal(result.driverActivity.ranking, null);
  assert.equal(result.driverActivity.automaticDecision, false);
});

test('une ligne étrangère ou sans entreprise fait échouer le calcul au lieu de mélanger les données', () => {
  assert.throws(
    () => calculateCrmMetrics(emptyInput({ orders: [{ id: 1, companyId: 'company-b', createdAt: '2026-09-01T08:00:00Z' }] })),
    /Isolation multi-entreprises refusée/,
  );
  assert.throws(
    () => calculateCrmMetrics(emptyInput({ incidents: [{ id: 1, orderId: 1, createdAt: '2026-09-01T08:00:00Z' }] })),
    /Isolation multi-entreprises refusée/,
  );
});

test('les entrées absentes deviennent des collections vides sans inventer de données', () => {
  const result = calculateCrmMetrics({ companyId: COMPANY, period: PERIOD, asOf: AS_OF });
  assert.equal(result.volumes.ordersCreated.value, 0);
  assert.equal(result.collections.status, 'no_data');
  assert.equal(result.delays.status, 'no_population');
  assert.deepEqual(result.dataQuality.exclusions, {});
});

test('un doublon de commande est exclu au lieu de gonfler le volume', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [
      row({ id: 1, createdAt: '2026-09-01T08:00:00Z', status: 'Confirmée' }),
      row({ id: 1, createdAt: '2026-09-02T08:00:00Z', status: 'Confirmée' }),
    ],
  }));
  assert.equal(result.volumes.ordersCreated.value, 1);
  assert.equal(result.dataQuality.exclusions.duplicate_order_id, 1);
});

test('un événement orphelin ne gonfle ni les prises en charge ni les clôtures', () => {
  const result = calculateCrmMetrics(emptyInput({
    statusEvents: [
      row({ orderId: 999, toStatus: 'Récupérée', createdAt: '2026-09-01T09:00:00Z' }),
      row({ orderId: 999, toStatus: 'Livrée', createdAt: '2026-09-01T10:00:00Z' }),
    ],
  }));
  assert.equal(result.volumes.ordersPickedUp.value, 0);
  assert.equal(result.volumes.closed.value, 0);
  assert.equal(result.dataQuality.exclusions.pickup_event_order_missing, 1);
  assert.equal(result.dataQuality.exclusions.terminal_event_order_missing, 1);
});

test('un retard exige une arrivée attestée et une promesse enregistrée avant son échéance', () => {
  const orders = [
    row({
      id: 1,
      createdAt: '2026-09-01T08:00:00Z',
      promisedWindowReliable: true,
      promisedWindowEnd: '2026-09-05T09:00:00Z',
      promisedWindowRecordedAt: '2026-09-05T09:05:00Z',
    }),
    row({
      id: 2,
      createdAt: '2026-09-01T08:00:00Z',
      promisedWindowReliable: true,
      promisedWindowEnd: '2026-09-05T09:00:00Z',
      promisedWindowRecordedAt: '2026-09-04T09:00:00Z',
    }),
  ];
  const statusEvents = [
    row({ orderId: 1, toStatus: 'Arrivée', actualArrivalReliable: true, createdAt: '2026-09-05T09:30:00Z' }),
    row({ orderId: 2, toStatus: 'Arrivée', actualArrivalReliable: false, createdAt: '2026-09-05T09:30:00Z' }),
  ];
  const result = calculateCrmMetrics(emptyInput({ orders, statusEvents }), { delayMinimumSampleSize: 1 });
  assert.equal(result.delays.reliableSampleSize, 0);
  assert.equal(result.delays.exclusions.window_recorded_after_deadline, 1);
  assert.equal(result.delays.exclusions.arrival_not_explicitly_reliable, 1);
});

test('les bornes sont inclusives au début, exclusives à la fin et doivent être des minuits locaux', () => {
  const result = calculateCrmMetrics(emptyInput({
    orders: [
      row({ id: 1, createdAt: PERIOD.startInclusive, status: 'Confirmée' }),
      row({ id: 2, createdAt: PERIOD.endExclusive, status: 'Confirmée' }),
    ],
  }));
  assert.equal(result.volumes.ordersCreated.value, 1);
  assert.throws(
    () => calculateCrmMetrics(emptyInput({ period: { startInclusive: '2026-09-01T00:00:00Z', endExclusive: PERIOD.endExclusive } })),
    /minuits civils/,
  );
});

async function main() {
  for (const { name, run } of tests) {
    await run();
    process.stdout.write(`✓ ${name}\n`);
  }
  process.stdout.write(`\n${tests.length} tests déterministes des indicateurs CRM réussis.\n`);
}

main().catch((error) => {
  process.stderr.write(`Échec des tests CRM : ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
