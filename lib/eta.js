// Estimation de l'heure d'arrivée chez le client, phase par phase.
// Fonction pure : l'appelant fournit le trajet calculé (OSRM) et les temps
// d'arrêt appris ; ce module décide de la phase, de la fourchette et du texte.
//
// Phases :
// - scheduled : le livreur n'est pas encore parti vers ce client ;
// - pickup    : il va chercher le colis au point de collecte ;
// - onway     : le colis est à bord, il reste éventuellement d'autres arrêts ;
// - arrived   : il est sur place ;
// - unknown   : pas assez d'informations (ni trajet, ni créneau).

const DEFAULTS = {
  serviceSeconds: 5 * 60, // temps passé à chaque arrêt (remise)
  pickupSeconds: 10 * 60, // temps passé à la collecte
  trafficFactor: 1,       // durée réelle / durée OSRM (appris par entreprise)
  exactUnderMinutes: 20,  // en dessous, sur le dernier trajet, on donne une heure précise
};

const PRE_DEPARTURE = new Set(['En préparation', 'Confirmée']);
const ON_BOARD = new Set(['Récupérée', 'En tournée', 'En livraison', 'Échec']);

function phaseFor(status, hasPickup) {
  if (status === 'Arrivée') return 'arrived';
  if (status === 'Vers la collecte') return 'pickup';
  if (PRE_DEPARTURE.has(status)) return hasPickup ? 'scheduled' : 'scheduled';
  if (ON_BOARD.has(status)) return 'onway';
  return 'unknown';
}

// Fourchette : ± 20 % du temps restant (5 min au moins), resserrée sur la fin.
function margin(minutes, { exact }) {
  if (exact) return 0;
  return Math.max(5, Math.round(minutes * 0.2));
}

function computeEta(input) {
  const opts = { ...DEFAULTS, ...(input.learned || {}) };
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const phase = phaseFor(input.status, Boolean(input.hasPickup));
  const deliveriesBefore = Math.max(0, Number(input.deliveriesBefore) || 0);
  const base = { phase, deliveriesBefore, computedAt: now.toISOString() };
  if (phase === 'arrived') return { ...base, minutes: 0, earliest: now.toISOString(), latest: now.toISOString(), precision: 'exact' };

  const route = input.route && Number.isFinite(Number(input.route.durationSeconds)) ? input.route : null;
  if (route) {
    let seconds = Number(route.durationSeconds) * opts.trafficFactor;
    seconds += deliveriesBefore * opts.serviceSeconds;
    if (phase === 'pickup' || (phase === 'scheduled' && input.hasPickup && !input.pickedUp)) seconds += opts.pickupSeconds;
    // Avant le départ, le livreur doit encore se mettre en route : on ajoute une marge.
    if (phase === 'scheduled') seconds += 5 * 60;
    const minutes = Math.max(1, Math.round(seconds / 60));
    const lastLeg = phase === 'onway' && deliveriesBefore === 0;
    const exact = lastLeg && minutes <= opts.exactUnderMinutes && !input.stale;
    const m = margin(minutes, { exact });
    const at = (min) => new Date(now.getTime() + min * 60000).toISOString();
    return {
      ...base,
      minutes,
      earliest: at(Math.max(1, minutes - m)),
      latest: at(minutes + m),
      precision: exact ? 'exact' : 'range',
      distanceMeters: Number.isFinite(Number(route.distanceMeters)) ? Number(route.distanceMeters) : null,
      stale: Boolean(input.stale),
    };
  }
  // Sans trajet calculable : le créneau demandé reste la meilleure indication.
  if (input.requestedTime) return { ...base, phase: phase === 'unknown' ? 'scheduled' : phase, requestedTime: String(input.requestedTime), precision: 'slot' };
  return { ...base, precision: 'none', reason: input.reason || 'no_route' };
}

// Temps d'arrêt et facteur trafic appris sur l'historique (médianes bornées).
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function learnedParameters({ serviceSamples = [], pickupSamples = [], trafficSamples = [] } = {}) {
  const out = {};
  const service = serviceSamples.length >= 5 ? median(serviceSamples) : null;
  if (service != null) out.serviceSeconds = Math.min(20 * 60, Math.max(2 * 60, service));
  const pickup = pickupSamples.length >= 5 ? median(pickupSamples) : null;
  if (pickup != null) out.pickupSeconds = Math.min(30 * 60, Math.max(3 * 60, pickup));
  const traffic = trafficSamples.length >= 5 ? median(trafficSamples) : null;
  if (traffic != null) out.trafficFactor = Math.min(2.5, Math.max(0.8, traffic));
  return out;
}

module.exports = { computeEta, learnedParameters, phaseFor, DEFAULTS };
