# Politique d’affectation — créneaux, service et capacité

## Objet

`lib/dispatch-policy.js` fournit des fonctions pures et déterministes pour préparer une affectation de livraison. Le module vérifie uniquement des faits explicites : créneau client, temps de service planifié, capacité déclarée et collisions avec les autres réservations de service du livreur.

Il ne persiste rien, ne contacte aucun service, ne classe aucun livreur et ne déclenche jamais une affectation. Toute proposition admissible porte le statut `ready_for_human_confirmation` et exige une décision humaine explicite.

## Principes retenus

### 1. Heure civile de Porto-Novo

Les créneaux client sont saisis sous la forme stricte `YYYY-MM-DDTHH:mm` et portent toujours l’identifiant IANA `Africa/Porto-Novo`. Le module les transforme ensuite en instants UTC pour permettre les comparaisons.

L’identifiant géographique est préférable à une abréviation ou à un décalage écrit en dur. La base IANA représente l’historique et les changements des règles d’heure civile ; elle est régulièrement mise à jour. Node s’appuie sur ICU pour `Intl.DateTimeFormat`, dont la disponibilité doit être conservée dans l’image d’exécution.

Sources officielles :

- [IANA — Time Zone Database](https://www.iana.org/time-zones)
- [IANA — Time zone and daylight-saving data](https://www.iana.org/time-zones/tz-link)
- [Node.js — Internationalization support](https://nodejs.org/api/intl.html)

`validatePortoNovoTimeWindow()` refuse les dates inexistantes, les formats ambigus, une fin antérieure au début et les durées hors limites configurées. Un contrôle de délai minimal est possible avec une valeur `now` fournie par l’appelant. Aucun appel implicite à l’horloge système n’est effectué.

### 2. Créneau client et réservation de service sont différents

Le créneau client est l’intervalle pendant lequel la remise peut commencer et se terminer. La réservation de service est une heure de début planifiée explicitement par l’exploitation, plus un temps de remise/manutention validé.

Deux créneaux clients peuvent se chevaucher sans constituer automatiquement un conflit. Le conflit n’est déclaré que lorsque deux **réservations de service planifiées pour le même livreur** se chevauchent. Les intervalles sont semi-ouverts `[début, fin)` : une réservation finissant à 10 h et la suivante commençant à 10 h sont adjacentes, pas simultanées.

Inversement, l’absence de chevauchement ne prouve pas que l’enchaînement est réalisable : le livreur doit encore se déplacer entre les deux lieux. Tant qu’un temps routier fiable n’est pas fourni, le résultat reste seulement admissible à une revue humaine.

Les modèles officiels de tournée avec créneaux utilisent des fenêtres d’arrivée et une dimension de temps cumulative ; ils nécessitent notamment une matrice de temps de trajet. Ce lot n’en dispose pas et n’en invente pas.

Source officielle : [OR-Tools — Vehicle Routing Problem with Time Windows](https://developers.google.com/optimization/routing/vrptw)

### 3. Temps de service

`validateServiceDuration()` accepte un nombre entier de minutes dans les bornes configurées. Il représente uniquement le temps de remise, contrôle, encaissement ou manutention prévu sur place.

Il ne contient jamais :

- temps de trajet ;
- trafic ;
- attente probable ;
- durée calculée à vol d’oiseau ;
- ETA client.

La proposition vérifie que le service planifié tient entièrement dans le créneau client. Une durée routière ne devra être ajoutée plus tard que depuis un moteur routier identifié, avec provenance et niveau de confiance.

### 4. Capacité multidimensionnelle

`evaluateCapacity()` traite chaque dimension indépendamment. Le pilote peut n’utiliser que `parcelCount`, mais le contrat accepte aussi des dimensions explicites comme `weightKg` ou `volumeM3`. Les unités ne doivent jamais être mélangées.

Une limite doit exister pour chaque charge courante ou nouvelle. Le module calcule charge projetée, capacité restante et dépassement. Une capacité dépassée bloque la proposition ; elle n’est pas contournée silencieusement.

OR-Tools modélise également la capacité comme une quantité cumulative et recommande une dimension distincte pour chaque type de cargaison.

Source officielle : [OR-Tools — Capacity Constraints](https://developers.google.com/optimization/routing/cvrp)

## Contrat des fonctions

### Valider un créneau

```js
const check = validatePortoNovoTimeWindow({
  timeZone: 'Africa/Porto-Novo',
  startLocal: '2026-09-15T09:00',
  endLocal: '2026-09-15T11:00',
}, {
  now: '2026-09-15T06:00:00Z',
  minLeadMinutes: 60,
});
```

La valeur normalisée contient les deux heures locales, leurs équivalents UTC et la durée du créneau.

### Vérifier la capacité

```js
const capacity = evaluateCapacity({
  limits: { parcelCount: 8, weightKg: 120 },
  currentLoad: { parcelCount: 4, weightKg: 55 },
  additionalLoad: { parcelCount: 2, weightKg: 20 },
});
```

### Détecter un chevauchement

```js
const schedule = findScheduleOverlaps(
  {
    id: 'order-18',
    startAt: '2026-09-15T08:30:00Z',
    endAt: '2026-09-15T08:50:00Z',
  },
  activeDriverReservations,
);
```

Les instants absolus doivent contenir `Z` ou un décalage numérique. Une date locale sans fuseau est refusée.

### Préparer puis confirmer humainement

```js
const proposal = createDispatchProposal({
  orderId: 'order-18',
  driverId: 'driver-4',
  reservationId: 'reservation-order-18',
  window: {
    timeZone: 'Africa/Porto-Novo',
    startLocal: '2026-09-15T09:00',
    endLocal: '2026-09-15T11:00',
  },
  serviceMinutes: 20,
  plannedStartAt: '2026-09-15T08:30:00Z',
  capacity: {
    limits: { parcelCount: 8 },
    currentLoad: { parcelCount: 4 },
    additionalLoad: { parcelCount: 1 },
  },
  existingReservations: activeDriverReservations,
});

const decision = recordHumanDispatchDecision(proposal, {
  expectedProposalId: proposal.proposalId,
  decision: 'approve',
  actorId: 'operator-12',
  decidedAt: '2026-09-15T07:55:00Z',
});
```

`expectedProposalId` protège contre la confirmation d’un écran devenu obsolète. La décision retournée indique `persistencePerformed: false` : la future couche métier devra refaire les contrôles dans une transaction PostgreSQL avant l’écriture.

## Règles d’intégration future

Avant de créer réellement l’affectation :

1. charger dans la même entreprise la commande, le livreur, sa capacité et ses réservations actives ;
2. construire une nouvelle proposition depuis cet état courant ;
3. exiger l’action explicite d’un opérateur autorisé ;
4. vérifier `expectedProposalId` ;
5. reprendre un verrou ou une contrainte transactionnelle en base pour empêcher deux confirmations concurrentes ;
6. écrire l’affectation et son événement d’audit sans écraser l’historique ;
7. si l’état a changé, refuser par conflit et demander une nouvelle confirmation.

Le résultat d’un solveur ou d’une suggestion ne constitue pas une vérité opérationnelle. La documentation OR-Tools précise que les problèmes de tournée contraints peuvent être infaisables et que les solutions de problèmes complexes peuvent être bonnes sans être optimales.

Source officielle : [OR-Tools — Vehicle Routing](https://developers.google.com/optimization/routing)

## Décision humaine et absence de sanction automatique

Le module ignore volontairement notes, retards historiques, incidents, score arbitraire et autres métriques de performance. Elles ne participent ni à l’admissibilité ni à l’identifiant de proposition. Il ne suspend jamais un livreur, ne réduit pas automatiquement ses affectations et ne produit aucun classement.

Une approbation bloquée est refusée. Un rejet humain exige un motif, mais ce rejet ne doit pas devenir automatiquement une sanction ou une évaluation du livreur. Les responsabilités de l’opérateur et les règles d’escalade devront être documentées dans le produit ; cette séparation suit le principe de rôles et de surveillance humaine explicites du cadre NIST AI RMF.

Source officielle : [NIST — AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)

## Ce que ce lot ne prétend pas faire

- aucune ETA ;
- aucune route routière ;
- aucune prise en compte du trafic ou des routes impraticables ;
- aucune optimisation multi-livreurs ;
- aucune lecture Traccar ;
- aucune persistance PostgreSQL ;
- aucune affectation automatique ;
- aucune sanction ou notation automatique.

## Tests

Les tests sont déterministes et sans réseau :

```powershell
node scripts/dispatch-policy-test.js
```

Ils couvrent le fuseau de Porto-Novo, les dates invalides, le délai minimal, le temps de service, plusieurs dimensions de capacité, les intervalles adjacents ou chevauchants, la stabilité d’une proposition, le rejet d’une confirmation obsolète et l’absence d’influence des métriques de performance.
