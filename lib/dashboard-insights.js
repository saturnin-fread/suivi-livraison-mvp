// Tableau de bord : calcul des indicateurs à partir des lignes réelles
// (commandes, demandes, tournées, incidents) déjà filtrées par entreprise et
// par livreur. Fonction pure : aucun accès à la base, testable seule.
//
// Définitions des dates métier (à ne pas mélanger) :
// - commande créée : orders.created_at ;
// - livraison terminée : premier événement « Livrée » ; retour : « Retournée » ;
// - durée de livraison : premier départ (« En tournée » ou « En livraison ») → « Livrée » ;
// - demande reçue : formulaire rempli (submitted_at) ou confirmation du client ;
// - tournée : date de service ; incident : date de signalement.
// Les répartitions par statut portent sur les commandes créées pendant la
// période (cohorte) : leur total est toujours égal au nombre de commandes créées.

const DAY_MS = 86400000;
const TERMINAL = new Set(['Livrée', 'Retournée', 'Annulée']);
const INCIDENT_LABELS = {
  client_injoignable: 'Client injoignable', adresse: 'Adresse à préciser', colis: 'Colis endommagé ou manquant',
  paiement: 'Paiement', vehicule: 'Véhicule', gps: 'GPS ou connexion', autre: 'Autre motif',
};
const WAITING_REQUESTS = new Set(['À vérifier', 'Informations à compléter', 'Validée']);
const HEAT_HOURS = [8, 10, 12, 14, 16];

const ms = (value) => {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};
const rate = (num, den) => (den ? (num / den) * 100 : null);

function localParts(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const cache = new Map();
  return (t) => {
    // Précision à la minute suffisante : on met en cache par tranche de 60 s.
    const key = Math.floor(t / 60000);
    let v = cache.get(key);
    if (!v) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      v = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[p.weekday] };
      if (cache.size > 50000) cache.clear();
      cache.set(key, v);
    }
    return v;
  };
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dateList(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Une commande a toujours un livreur : on distingue celles pas encore
// récupérées (en préparation, confirmées) de celles en cours de livraison.
const PENDING_ORDER = new Set(['En préparation', 'Confirmée', 'Vers la collecte']);
function orderGroup(o) {
  if (o.status === 'Livrée') return 'delivered';
  if (o.status === 'Annulée' || o.status === 'Retournée') return 'canceled';
  return PENDING_ORDER.has(o.status) ? 'pending' : 'progress';
}
function requestGroup(r) {
  if (r.orderId || r.status === 'Confirmée') return 'converted';
  if (WAITING_REQUESTS.has(r.status)) return 'waiting';
  return 'rejected';
}
function runGroup(r) {
  if (r.status === 'completed') return 'finished';
  if (r.status === 'active') return 'progress';
  if (r.status === 'cancelled') return 'canceled';
  return 'planned';
}

// Prépare les lignes brutes (dates locales, groupes) une seule fois.
function prepare(raw, tz) {
  const local = localParts(tz);
  const day = (t) => (t == null ? null : local(t).date);
  const orders = raw.orders.map((o) => {
    const createdMs = ms(o.created_at);
    const deliveredMs = ms(o.delivered_at);
    const outMs = ms(o.out_at);
    const minutes = deliveredMs && outMs && deliveredMs > outMs ? (deliveredMs - outMs) / 60000 : null;
    const lp = createdMs != null ? local(createdMs) : null;
    return {
      id: Number(o.id), reference: o.reference || `Commande n° ${o.id}`, client: o.customer_name || '', zone: o.neighborhood || '',
      driverId: o.driver_id == null ? null : Number(o.driver_id), status: o.status,
      createdMs, createdDay: lp ? lp.date : null, createdHour: lp ? lp.hour : null, createdWeekday: lp ? lp.weekday : null,
      deliveredMs, deliveredDay: day(deliveredMs), returnedDay: day(ms(o.returned_at)),
      minutes: minutes != null && minutes >= 1 && minutes <= 720 ? minutes : null,
      incidents: Number(o.incidents) || 0, group: orderGroup(o),
    };
  });
  const requests = raw.requests.map((r) => {
    const receivedMs = ms(r.submitted_at) ?? ms(r.customer_confirmed_at);
    return {
      id: Number(r.id), client: r.customer_name || '', zone: r.neighborhood || '', status: r.status,
      orderId: r.order_id == null ? null : Number(r.order_id), driverId: r.driver_id == null ? null : Number(r.driver_id),
      receivedMs, receivedDay: day(receivedMs), group: null,
    };
  }).filter((r) => r.receivedMs != null).map((r) => ({ ...r, group: requestGroup(r) }));
  const runs = raw.runs.map((r) => ({
    id: Number(r.id), name: r.name || `Tournée n° ${r.id}`, status: r.status, driverId: r.driver_id == null ? null : Number(r.driver_id),
    day: typeof r.service_date === 'string' ? r.service_date.slice(0, 10) : new Date(r.service_date).toISOString().slice(0, 10),
    total: Number(r.stops_total) || 0, done: Number(r.stops_done) || 0, group: runGroup(r),
  }));
  const incidents = raw.incidents.map((i) => {
    const createdMs = ms(i.created_at);
    return {
      id: Number(i.id), category: i.category || 'autre', label: INCIDENT_LABELS[i.category] || INCIDENT_LABELS.autre,
      open: i.status === 'open', orderId: i.order_id == null ? null : Number(i.order_id), reference: i.reference || '',
      client: i.customer_name || '', driverId: i.driver_id == null ? null : Number(i.driver_id), createdMs, day: day(createdMs),
    };
  });
  return { orders, requests, runs, incidents };
}

// Indicateurs d'une plage de jours locaux [from, to] (inclusifs).
function measure(ds, from, to) {
  const inR = (d) => d != null && d >= from && d <= to;
  const created = ds.orders.filter((o) => inR(o.createdDay));
  const delivered = ds.orders.filter((o) => inR(o.deliveredDay));
  const returned = ds.orders.filter((o) => inR(o.returnedDay));
  const q = ds.requests.filter((r) => inR(r.receivedDay));
  const r = ds.runs.filter((x) => inR(x.day));
  const inc = ds.incidents.filter((i) => inR(i.day));
  const drivers = new Set([...created, ...delivered].map((o) => o.driverId).filter((id) => id != null));
  const durations = delivered.map((o) => o.minutes).filter((m) => m != null);
  const count = (list, group) => list.filter((x) => x.group === group).length;
  const incidentOrders = new Set(inc.map((i) => i.orderId).filter(Boolean));
  return {
    created: created.length,
    cohortDelivered: count(created, 'delivered'),
    cohortProgress: count(created, 'progress'),
    cohortPending: count(created, 'pending'),
    cohortCanceled: count(created, 'canceled'),
    assigned: created.filter((o) => o.driverId != null).length,
    delivered: delivered.length,
    deliveryRate: rate(delivered.length, delivered.length + returned.length),
    activeDrivers: drivers.size,
    perDriver: drivers.size ? delivered.length / drivers.size : null,
    avgMinutes: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    noIncident: rate(delivered.filter((o) => !o.incidents).length, delivered.length),
    requests: q.length,
    converted: count(q, 'converted'),
    waiting: count(q, 'waiting'),
    rejected: count(q, 'rejected'),
    conversion: rate(count(q, 'converted'), q.length),
    runs: r.length,
    runsFinished: count(r, 'finished'),
    runsProgress: count(r, 'progress'),
    runsPlanned: count(r, 'planned'),
    runsCanceled: count(r, 'canceled'),
    stopsPerRun: r.length ? r.reduce((a, x) => a + x.total, 0) / r.length : null,
    incidents: inc.length,
    incidentsOpen: inc.filter((i) => i.open).length,
    incidentsClosed: inc.filter((i) => !i.open).length,
    incidentOrdersRate: rate(incidentOrders.size, created.length),
    lists: { created, delivered, q, r, inc },
  };
}

const TAB_SPECS = {
  general: [
    ['ordersCreated', 'Commandes créées', 'created', ''],
    ['deliveryRate', 'Taux de livraison', 'deliveryRate', '%', { hint: 'Livrées sur livraisons terminées (livrées + retournées)' }],
    ['activeDrivers', 'Livreurs actifs', 'activeDrivers', ''],
    ['openIncidents', 'Incidents à traiter', null, '', { invert: true, stock: 'openIncidents' }],
  ],
  orders: [
    ['ordersCreated', 'Commandes créées', 'created', ''],
    ['cohortDelivered', 'Livrées', 'cohortDelivered', ''],
    ['cohortOpen', 'En cours', (m) => m.cohortProgress + m.cohortPending, ''],
    ['cohortCanceled', 'Annulées ou retournées', 'cohortCanceled', '', { invert: true }],
  ],
  deliveries: [
    ['assigned', 'Livraisons affectées', 'assigned', ''],
    ['delivered', 'Terminées', 'delivered', ''],
    ['avgMinutes', 'Durée moyenne', 'avgMinutes', 'min', { invert: true, hint: 'Du départ du livreur à la remise' }],
    ['noIncident', 'Sans incident', 'noIncident', '%', { hint: 'Livraisons terminées sans incident signalé' }],
  ],
  drivers: [
    ['activeDrivers', 'Livreurs actifs', 'activeDrivers', ''],
    ['perDriver', 'Livraisons par livreur', 'perDriver', '', { decimals: 1 }],
    ['noIncident', 'Sans incident', 'noIncident', '%'],
    ['avgMinutes', 'Durée moyenne', 'avgMinutes', 'min', { invert: true }],
  ],
  requests: [
    ['requests', 'Demandes reçues', 'requests', ''],
    ['converted', 'Converties', 'converted', ''],
    ['waiting', 'À valider', 'waiting', '', { invert: true }],
    ['conversion', 'Taux de conversion', 'conversion', '%'],
  ],
  routes: [
    ['runs', 'Tournées', 'runs', ''],
    ['runsFinished', 'Terminées', 'runsFinished', ''],
    ['runsProgress', 'En cours', 'runsProgress', ''],
    ['stopsPerRun', 'Arrêts par tournée', 'stopsPerRun', '', { decimals: 1 }],
  ],
  incidents: [
    ['incidents', 'Incidents signalés', 'incidents', '', { invert: true }],
    ['incidentsOpen', 'Encore ouverts', 'incidentsOpen', '', { invert: true }],
    ['incidentsClosed', 'Clôturés', 'incidentsClosed', ''],
    ['incidentOrdersRate', 'Commandes concernées', 'incidentOrdersRate', '%', { invert: true, hint: 'Part des commandes créées touchées par un incident' }],
  ],
};
const SERIES = {
  general: ['Commandes créées', 'created'], orders: ['Commandes créées', 'created'],
  deliveries: ['Livraisons terminées', 'delivered'], drivers: ['Livraisons terminées', 'delivered'],
  requests: ['Demandes reçues', 'requests'], routes: ['Tournées', 'runs'], incidents: ['Incidents signalés', 'incidents'],
};
const pick = (m, key) => (typeof key === 'function' ? key(m) : m[key]);

function computeInsights({ raw, drivers, from, to, timezone, stock }) {
  const days = dateList(from, to);
  const prevFrom = addDays(from, -days.length);
  const prevTo = addDays(from, -1);
  const prevDays = dateList(prevFrom, prevTo);
  const ds = prepare(raw, timezone);
  const cur = measure(ds, from, to);
  const prev = measure(ds, prevFrom, prevTo);
  const daily = days.map((d) => measure(ds, d, d));
  const prevDaily = prevDays.map((d) => measure(ds, d, d));
  const driverName = new Map(drivers.map((d) => [Number(d.id), d.name]));

  const tabs = {};
  for (const [tab, specs] of Object.entries(TAB_SPECS)) {
    const kpis = specs.map(([key, label, source, unit, opt = {}]) => {
      if (opt.stock) {
        return { key, label, unit, value: stock[opt.stock] ?? 0, previous: null, stock: true, invert: Boolean(opt.invert), spark: null, hint: 'État actuel' };
      }
      return {
        key, label, unit, invert: Boolean(opt.invert), decimals: opt.decimals ?? (unit === '%' || unit === 'min' ? 1 : 0), hint: opt.hint || null,
        value: pick(cur, source), previous: pick(prev, source), spark: daily.map((m) => pick(m, source)),
      };
    });
    const [title, sKey] = SERIES[tab];
    tabs[tab] = {
      kpis,
      series: { title, current: daily.map((m) => m[sKey]), previous: prevDaily.map((m) => m[sKey]), total: cur[sKey], previousTotal: prev[sKey] },
    };
  }

  // Répartitions
  const cohortItems = [
    { label: 'Livrées', value: cur.cohortDelivered },
    { label: 'En livraison', value: cur.cohortProgress, accent: true },
    { label: 'À récupérer', value: cur.cohortPending },
    { label: 'Annulées ou retournées', value: cur.cohortCanceled },
  ];
  const deliveredBy = new Map();
  for (const o of cur.lists.delivered) if (o.driverId != null) deliveredBy.set(o.driverId, (deliveredBy.get(o.driverId) || 0) + 1);
  const driverItems = [...deliveredBy.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ label: driverName.get(id) || `Livreur n° ${id}`, value: n }));
  if (driverItems.length > 5) {
    const rest = driverItems.splice(4);
    driverItems.push({ label: `${rest.length} autres livreurs`, value: rest.reduce((a, x) => a + x.value, 0) });
  }
  const unassignedDelivered = cur.lists.delivered.filter((o) => o.driverId == null).length;
  if (unassignedDelivered) driverItems.push({ label: 'Sans livreur', value: unassignedDelivered });
  const byCategory = new Map();
  for (const i of cur.lists.inc) byCategory.set(i.label, (byCategory.get(i.label) || 0) + 1);
  const distributions = {
    general: { title: 'Répartition par statut', shape: 'fan', unit: 'commandes', items: cohortItems, note: 'Commandes créées pendant la période, selon leur statut actuel' },
    orders: { title: 'Statut des commandes', shape: 'bars', unit: 'commandes', items: cohortItems },
    deliveries: { title: 'Où en sont les commandes', shape: 'fan', unit: 'commandes', items: cohortItems },
    drivers: { title: 'Livraisons par livreur', shape: 'bars', unit: 'livraisons', items: driverItems },
    requests: { title: 'Suite donnée aux demandes', shape: 'ring', unit: 'demandes', items: [
      { label: 'Converties', value: cur.converted }, { label: 'À valider', value: cur.waiting, accent: true }, { label: 'Refusées ou archivées', value: cur.rejected }] },
    routes: { title: 'État des tournées', shape: 'bars', unit: 'tournées', items: [
      { label: 'Terminées', value: cur.runsFinished }, { label: 'En cours', value: cur.runsProgress, accent: true },
      { label: 'À lancer', value: cur.runsPlanned }, { label: 'Annulées', value: cur.runsCanceled }] },
    incidents: { title: 'Motifs des incidents', shape: 'ring', unit: 'signalements', items: [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })) },
  };
  for (const [tab, dist] of Object.entries(distributions)) {
    tabs[tab].distribution = { ...dist, total: dist.items.reduce((a, x) => a + x.value, 0) };
  }

  // Heures chargées : commandes créées, jour de semaine × créneau de 2 h (8 h – 18 h).
  const heat = Array.from({ length: 7 }, () => HEAT_HOURS.map(() => 0));
  let outside = 0;
  for (const o of cur.lists.created) {
    const slot = HEAT_HOURS.findIndex((h) => o.createdHour >= h && o.createdHour < h + 2);
    if (slot < 0 || o.createdWeekday == null) { outside += 1; continue; }
    heat[o.createdWeekday][slot] += 1;
  }

  // Équipe : affectées et livrées (cohorte des commandes créées), livrées (événement) pour le classement.
  const team = new Map();
  const member = (id) => {
    if (!team.has(id)) team.set(id, { id, name: driverName.get(id) || `Livreur n° ${id}`, assigned: 0, done: 0, delivered: 0, minutes: [], incidents: 0 });
    return team.get(id);
  };
  for (const o of cur.lists.created) if (o.driverId != null) { const m = member(o.driverId); m.assigned += 1; if (o.group === 'delivered') m.done += 1; }
  for (const o of cur.lists.delivered) if (o.driverId != null) { const m = member(o.driverId); m.delivered += 1; if (o.minutes != null) m.minutes.push(o.minutes); if (o.incidents) m.incidents += 1; }
  const teamRows = [...team.values()].map((m) => ({
    id: m.id, name: m.name, assigned: m.assigned, done: m.done, delivered: m.delivered,
    rate: rate(m.done, m.assigned), avgMinutes: m.minutes.length ? m.minutes.reduce((a, b) => a + b, 0) / m.minutes.length : null,
  })).sort((a, b) => b.delivered - a.delivered || b.assigned - a.assigned || a.name.localeCompare(b.name, 'fr'));

  const nameOf = (id) => (id == null ? null : driverName.get(id) || `Livreur n° ${id}`);
  const rows = {
    orders: cur.lists.created.sort((a, b) => b.createdMs - a.createdMs).map((o) => ({
      id: o.id, reference: o.reference, client: o.client, zone: o.zone, driver: nameOf(o.driverId), status: o.status, group: o.group, at: new Date(o.createdMs).toISOString(), day: o.createdDay,
    })),
    deliveries: cur.lists.delivered.sort((a, b) => b.deliveredMs - a.deliveredMs).map((o) => ({
      id: o.id, reference: o.reference, client: o.client, zone: o.zone, driver: nameOf(o.driverId), status: o.status, group: 'delivered',
      at: new Date(o.deliveredMs).toISOString(), day: o.deliveredDay, minutes: o.minutes == null ? null : Math.round(o.minutes), incidents: o.incidents,
    })),
    requests: cur.lists.q.sort((a, b) => b.receivedMs - a.receivedMs).map((r) => ({
      id: r.id, client: r.client, zone: r.zone, status: r.status, group: r.group, orderId: r.orderId, at: new Date(r.receivedMs).toISOString(), day: r.receivedDay,
    })),
    runs: cur.lists.r.sort((a, b) => b.day.localeCompare(a.day) || b.id - a.id).map((r) => ({
      id: r.id, name: r.name, driver: nameOf(r.driverId), status: r.status, group: r.group, total: r.total, done: r.done, day: r.day,
    })),
    incidents: cur.lists.inc.sort((a, b) => b.createdMs - a.createdMs).map((i) => ({
      id: i.id, label: i.label, open: i.open, orderId: i.orderId, reference: i.reference, client: i.client, driver: nameOf(i.driverId), at: new Date(i.createdMs).toISOString(), day: i.day,
    })),
    drivers: teamRows,
  };

  return {
    range: { from, to, days: days.length, dates: days, timezone },
    comparison: { from: prevFrom, to: prevTo },
    tabs,
    heatmap: { hours: HEAT_HOURS, counts: heat, outside, total: cur.lists.created.length },
    team: teamRows.slice(0, 4),
    rows,
  };
}

module.exports = { computeInsights, addDays, dateList, INCIDENT_LABELS };
