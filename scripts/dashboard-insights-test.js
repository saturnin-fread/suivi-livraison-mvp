// Calculs du tableau de bord : dates métier, fuseau, cohortes, comparaison.
const assert = require('assert');
const { computeInsights } = require('../lib/dashboard-insights');

const tz = 'Africa/Porto-Novo'; // UTC+1
const drivers = [{ id: 1, name: 'Amadou Dossa' }, { id: 2, name: 'Aïcha Sanni' }];
const order = (id, driver, status, created, extra = {}) => ({ id, reference: `CMD-${id}`, customer_name: `Client ${id}`, neighborhood: 'Akpakpa', driver_id: driver, status, created_at: created, incidents: 0, ...extra });

const raw = {
  orders: [
    // Période courante : 24 – 30 sept.
    order(1, 1, 'Livrée', '2026-09-24T08:30:00Z', { out_at: '2026-09-24T09:00:00Z', delivered_at: '2026-09-24T09:40:00Z' }),
    order(2, 1, 'Livrée', '2026-09-25T10:00:00Z', { out_at: '2026-09-25T10:10:00Z', delivered_at: '2026-09-25T10:30:00Z', incidents: 1 }),
    order(3, 2, 'En livraison', '2026-09-26T11:00:00Z'),
    order(4, 2, 'Confirmée', '2026-09-30T13:00:00Z'),
    order(5, 2, 'Annulée', '2026-09-27T14:00:00Z'),
    // 23 h 30 UTC le 23 sept. = 00 h 30 le 24 à Cotonou : compte dans la période courante.
    order(6, 1, 'Retournée', '2026-09-23T23:30:00Z', { returned_at: '2026-09-24T12:00:00Z' }),
    // Créée pendant la période précédente, livrée pendant la courante.
    order(7, 2, 'Livrée', '2026-09-20T09:00:00Z', { out_at: '2026-09-24T09:00:00Z', delivered_at: '2026-09-24T09:50:00Z' }),
    // Période précédente : 17 – 23 sept.
    order(8, 1, 'Livrée', '2026-09-18T09:00:00Z', { delivered_at: '2026-09-18T10:00:00Z' }),
    // Durée absurde (plus de 12 h) : ignorée.
    order(9, 1, 'Livrée', '2026-09-28T07:00:00Z', { out_at: '2026-09-28T07:00:00Z', delivered_at: '2026-09-29T07:00:00Z' }),
  ],
  requests: [
    { id: 1, customer_name: 'A', status: 'Confirmée', submitted_at: '2026-09-25T09:00:00Z', order_id: 3 },
    { id: 2, customer_name: 'B', status: 'À vérifier', submitted_at: '2026-09-26T09:00:00Z' },
    { id: 3, customer_name: 'C', status: 'Refusée', submitted_at: '2026-09-27T09:00:00Z' },
    { id: 4, customer_name: 'D', status: 'En attente d’informations', submitted_at: null }, // lien jamais rempli
    { id: 5, customer_name: 'E', status: 'Validée', submitted_at: null, customer_confirmed_at: '2026-09-28T09:00:00Z' },
  ],
  runs: [
    { id: 1, name: 'T1', status: 'completed', driver_id: 1, service_date: '2026-09-24', stops_total: 4, stops_done: 4 },
    { id: 2, name: 'T2', status: 'active', driver_id: 2, service_date: '2026-09-30', stops_total: 2, stops_done: 1 },
    { id: 3, name: 'T0', status: 'completed', driver_id: 1, service_date: '2026-09-20', stops_total: 3, stops_done: 3 },
  ],
  incidents: [
    { id: 1, category: 'adresse', status: 'open', created_at: '2026-09-25T10:15:00Z', order_id: 2, reference: 'CMD-2', driver_id: 1 },
    { id: 2, category: 'client_injoignable', status: 'resolved', created_at: '2026-09-26T12:00:00Z', order_id: 3, reference: 'CMD-3', driver_id: 2 },
  ],
};

const r = computeInsights({ raw, drivers, from: '2026-09-24', to: '2026-09-30', timezone: tz, stock: { openIncidents: 3 } });
const kpi = (tab, key) => r.tabs[tab].kpis.find((k) => k.key === key);

assert.deepStrictEqual([r.range.days, r.comparison.from, r.comparison.to], [7, '2026-09-17', '2026-09-23']);
assert.strictEqual(r.range.dates.length, 7);

// Commandes créées (fuseau local) et comparaison
assert.strictEqual(kpi('general', 'ordersCreated').value, 7, 'commandes 1–6 et 9');
assert.strictEqual(kpi('general', 'ordersCreated').previous, 2, 'commandes 7 et 8');
assert.strictEqual(r.tabs.general.series.current[0], 2, 'le 24 : commandes 1 et 6 (minuit passé à Cotonou)');
assert.strictEqual(r.tabs.general.series.current.reduce((a, b) => a + b, 0), 7);

// Répartition = cohorte des commandes créées : total égal aux commandes créées
const dist = r.tabs.general.distribution;
assert.strictEqual(dist.total, 7);
assert.deepStrictEqual(dist.items.map((x) => x.value), [3, 1, 1, 2], 'livrées / en livraison / à récupérer / annulées ou retournées');

// Livraisons : date de l'événement « Livrée », pas de la création
assert.strictEqual(kpi('deliveries', 'delivered').value, 4, 'commandes 1, 2, 7 et 9');
assert.strictEqual(kpi('deliveries', 'delivered').previous, 1);
const rateK = kpi('general', 'deliveryRate');
assert.strictEqual(Math.round(rateK.value * 10) / 10, 80, '4 livrées sur 5 livraisons terminées (1 retour)');
assert.strictEqual(kpi('deliveries', 'avgMinutes').value, (40 + 20 + 50) / 3, 'durée > 12 h ignorée');
assert.strictEqual(kpi('deliveries', 'noIncident').value, 75);

// Stock : pas de comparaison inventée
assert.strictEqual(kpi('general', 'openIncidents').value, 3);
assert.strictEqual(kpi('general', 'openIncidents').previous, null);
assert.strictEqual(kpi('general', 'openIncidents').stock, true);

// Demandes : les liens jamais remplis ne sont pas « reçus »
assert.strictEqual(kpi('requests', 'requests').value, 4);
assert.deepStrictEqual(r.tabs.requests.distribution.items.map((x) => x.value), [1, 2, 1], 'convertie / à valider (À vérifier + Validée) / refusée');
assert.strictEqual(kpi('requests', 'conversion').value, 25);

// Tournées par date de service
assert.strictEqual(kpi('routes', 'runs').value, 2);
assert.strictEqual(kpi('routes', 'runs').previous, 1);
assert.strictEqual(kpi('routes', 'stopsPerRun').value, 3);

// Incidents
assert.strictEqual(kpi('incidents', 'incidents').value, 2);
assert.strictEqual(kpi('incidents', 'incidentsOpen').value, 1);

// Équipe : livrées sur la période (événement), taux sur la cohorte affectée
const amadou = r.rows.drivers.find((d) => d.id === 1);
assert.deepStrictEqual([amadou.assigned, amadou.done, amadou.delivered], [4, 3, 3], 'commandes 1, 2, 6, 9 affectées ; 1, 2, 9 livrées');
assert.strictEqual(r.tabs.drivers.distribution.total, 4);

// Heures chargées : 7 commandes, dont 1 hors 8 h – 18 h (00 h 30)
assert.strictEqual(r.heatmap.total, 7);
assert.strictEqual(r.heatmap.outside, 1);
assert.strictEqual(r.heatmap.counts.flat().reduce((a, b) => a + b, 0), 6);
// Commande 1 : jeudi 24 sept., 09 h 30 à Cotonou → jeudi, créneau 8 h
assert.strictEqual(r.heatmap.counts[3][0], 1);

// Lignes du tableau
assert.strictEqual(r.rows.orders.length, 7);
assert.strictEqual(r.rows.deliveries.length, 4);
assert.ok(r.rows.orders.every((o) => o.day >= '2026-09-24' && o.day <= '2026-09-30'));

// Rien sur une période vide : pas de taux inventé
const empty = computeInsights({ raw: { orders: [], requests: [], runs: [], incidents: [] }, drivers, from: '2026-09-24', to: '2026-09-24', timezone: tz, stock: { openIncidents: 0 } });
assert.strictEqual(empty.tabs.general.kpis.find((k) => k.key === 'deliveryRate').value, null);
assert.strictEqual(empty.tabs.general.distribution.total, 0);

console.log('Tableau de bord : dates métier, fuseau, cohortes, comparaison et heures chargées OK');
