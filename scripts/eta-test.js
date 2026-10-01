// Estimation d'arrivée : phases, fourchettes, livraisons avant, collecte, calage.
const assert = require('assert');
const { computeEta, learnedParameters } = require('../lib/eta');

const now = new Date('2026-10-01T14:00:00Z');
const min = (iso) => Math.round((new Date(iso) - now) / 60000);
const route = (minutes, km = 4) => ({ durationSeconds: minutes * 60, distanceMeters: km * 1000 });

// Dernier trajet, proche : heure précise
let e = computeEta({ now, status: 'En livraison', route: route(12) });
assert.deepStrictEqual([e.phase, e.precision, e.minutes, min(e.earliest), min(e.latest)], ['onway', 'exact', 12, 12, 12]);

// Dernier trajet, loin : fourchette
e = computeEta({ now, status: 'En livraison', route: route(40) });
assert.strictEqual(e.precision, 'range');
assert.deepStrictEqual([min(e.earliest), min(e.latest)], [32, 48], '± 20 %');

// Position ancienne : jamais d'heure précise
e = computeEta({ now, status: 'En livraison', route: route(10), stale: true });
assert.strictEqual(e.precision, 'range');
assert.strictEqual(e.stale, true);

// Deux livraisons avant : 2 × 5 min d'arrêt ajoutées, fourchette
e = computeEta({ now, status: 'En tournée', deliveriesBefore: 2, route: route(20) });
assert.deepStrictEqual([e.phase, e.minutes, e.deliveriesBefore, e.precision], ['onway', 30, 2, 'range']);

// Collecte en cours : temps de collecte ajouté
e = computeEta({ now, status: 'Vers la collecte', hasPickup: true, route: route(25) });
assert.deepStrictEqual([e.phase, e.minutes], ['pickup', 35]);

// Avant le départ, avec collecte : + collecte + mise en route
e = computeEta({ now, status: 'Confirmée', hasPickup: true, route: route(20) });
assert.deepStrictEqual([e.phase, e.minutes, e.precision], ['scheduled', 35, 'range']);

// Sans trajet : créneau demandé, sinon rien d'inventé
e = computeEta({ now, status: 'Confirmée', requestedTime: '15 h – 17 h' });
assert.deepStrictEqual([e.precision, e.requestedTime], ['slot', '15 h – 17 h']);
e = computeEta({ now, status: 'Confirmée' });
assert.strictEqual(e.precision, 'none');
assert.ok(!('earliest' in e), 'aucune heure inventée');

// Arrivé
assert.strictEqual(computeEta({ now, status: 'Arrivée' }).phase, 'arrived');

// Calage appris : trafic × 1,5 et arrêts de 8 min
const learned = learnedParameters({ serviceSamples: [480, 470, 500, 490, 480], trafficSamples: [1.5, 1.4, 1.6, 1.5, 1.5] });
assert.deepStrictEqual(learned, { serviceSeconds: 480, trafficFactor: 1.5 });
e = computeEta({ now, status: 'En tournée', deliveriesBefore: 1, route: route(20), learned });
assert.strictEqual(e.minutes, 38, '20 × 1,5 + 8');
// Trop peu d'échantillons : valeurs par défaut ; valeurs absurdes bornées
assert.deepStrictEqual(learnedParameters({ serviceSamples: [300, 300] }), {});
assert.strictEqual(learnedParameters({ trafficSamples: [9, 9, 9, 9, 9] }).trafficFactor, 2.5);

console.log('Estimation d’arrivée : phases, fourchettes, livraisons avant, collecte, calage OK');
