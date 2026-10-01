// Vigilance : calculs purs utilisés pour repérer les usages suspects.
// Aucune décision automatique lourde ici : ces fonctions disent seulement
// « à vérifier » ; le serveur crée un signal que le responsable examine.
'use strict';

const EARTH_M = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function validFix(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
}

function distanceMeters(a, b) {
  if (!validFix(a) || !validFix(b)) return null;
  const dLat = rad(Number(b.lat) - Number(a.lat));
  const dLng = rad(Number(b.lng) - Number(a.lng));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(Number(a.lat))) * Math.cos(rad(Number(b.lat))) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Remise déclarée loin du client : au-delà de 400 m, plus la marge d'imprécision
// du GPS (plafonnée à 300 m pour qu'un relevé très flou ne masque rien).
const FAR_DELIVERY_M = 400;
function farFromDestination(fix, destination) {
  const d = distanceMeters(fix, destination);
  if (d == null) return null;
  const accuracy = Math.min(300, Math.max(0, Number(fix.accuracy) || 0));
  return { distance: Math.round(d), far: d > FAR_DELIVERY_M + accuracy, threshold: FAR_DELIVERY_M + accuracy };
}

// Déplacement impossible entre deux relevés du même livreur : plus de 2 km
// à plus de 150 km/h (aucune moto ne fait ça en ville). Signe d'une position
// inventée ou d'un téléphone partagé entre deux personnes.
const IMPOSSIBLE_KMH = 150;
const IMPOSSIBLE_MIN_M = 2000;
function impossibleJump(prev, cur) {
  const d = distanceMeters(prev, cur);
  if (d == null) return null;
  const dt = (new Date(cur.at).getTime() - new Date(prev.at).getTime()) / 1000;
  if (!Number.isFinite(dt) || dt <= 0) return null;
  const kmh = (d / dt) * 3.6;
  return { distance: Math.round(d), seconds: Math.round(dt), kmh: Math.round(kmh), impossible: d > IMPOSSIBLE_MIN_M && kmh > IMPOSSIBLE_KMH };
}

// Même personne derrière plusieurs adresses : « a.b+essai@gmail.com » et
// « ab@gmail.com » aboutissent à la même boîte.
function canonicalEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at < 1) return value;
  let local = value.slice(0, at);
  let domain = value.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

// Encaissements inférieurs au montant attendu : on parle d'habitude à partir
// de 3 écarts en 30 jours pour le même livreur.
const CASH_GAP_REPEAT = 3;
function cashGapPattern(gaps) {
  const short = gaps.filter((g) => Number(g.collected) < Number(g.expected));
  const total = short.reduce((sum, g) => sum + (Number(g.expected) - Number(g.collected)), 0);
  return { count: short.length, totalMinor: total, repeated: short.length >= CASH_GAP_REPEAT };
}

module.exports = {
  distanceMeters, farFromDestination, impossibleJump, canonicalEmail, cashGapPattern, validFix,
  FAR_DELIVERY_M, IMPOSSIBLE_KMH, CASH_GAP_REPEAT,
};
