# Adaptateur de routage

Statut : module interne prêt à intégrer, non branché à `server.js`.

Périmètre : route ordonnée et matrice distance/durée.

Dernière vérification : 15 septembre 2026

## Rôle

`lib/routing.js` isole le domaine de livraison du format propre à un moteur routier. Le reste de l’application peut ainsi manipuler un résultat stable sans connaître les URL, codes d’erreur ou structures JSON d’OSRM.

Le module fournit :

- un fournisseur `disabled`, prévu pour un déploiement sans moteur routier;
- un fournisseur `osrm`, appelé en HTTP ou HTTPS côté serveur;
- `route(input)` pour un parcours passant par les points dans l’ordre fourni;
- `matrix(input)` pour les distances et durées entre toutes les paires;
- `match(input)` pour caler une trace GPS bruitée sur le réseau routier (service Match d’OSRM);
- `health()` qui décrit uniquement la configuration locale, sans prétendre que le fournisseur est joignable;
- un petit cache mémoire TTL, remplaçable par un cache injecté.

Ce module ne calcule **aucune ETA**. Une durée OSRM représente une durée routière brute. Elle ne comprend ni les arrêts précédents, ni le temps de remise du colis, ni les créneaux, ni le trafic réel. Les résultats réussis portent donc l’avertissement `routing_duration_is_not_eta`.

## Installation dans le code serveur

### Mode désactivé

```js
const { createRoutingAdapter } = require('./lib/routing');

const routing = createRoutingAdapter({
  provider: 'disabled',
});
```

Un appel valide renvoie `status: "unavailable"`, des distances et durées à `null`, aucune géométrie et `failure.code: "provider_disabled"`. Il n’y a jamais de ligne droite présentée comme une route.

### Mode OSRM

```js
const routing = createRoutingAdapter({
  provider: 'osrm',
  baseUrl: process.env.ROUTING_OSRM_URL,
  profiles: {
    motorcycle: 'driving-benin-v1',
  },
  defaultProfile: 'motorcycle',
  timeoutMs: 5_000,
  maxRouteCoordinates: 50,
  maxMatrixCoordinates: 25,
  cacheTtlMs: 300_000,
  mapDataVersion: process.env.ROUTING_MAP_DATA_VERSION,
  providerVersion: process.env.ROUTING_PROVIDER_VERSION,
});
```

`baseUrl` doit être une URL `http` ou `https` sans identifiant, mot de passe, paramètre de requête ou fragment. Les secrets éventuels doivent être gérés par le réseau privé ou une couche d’accès interne, pas placés dans l’URL.

Le nom public du profil est séparé du profil préparé dans OSRM. Cela permet par exemple de conserver `motorcycle` dans le domaine métier tout en évaluant plusieurs graphes OSRM. Le profil OSRM doit avoir été préparé et qualifié sur le corpus terrain; le nom ne garantit pas à lui seul un comportement adapté aux motos.

## Entrées

```js
const result = await routing.route({
  profile: 'motorcycle',
  coordinates: [
    { lat: 6.3703, lng: 2.3912 },
    { lat: 6.4485, lng: 2.3557 },
  ],
});
```

Règles appliquées avant tout appel HTTP :

- `lat` et `lng` doivent être des nombres finis;
- latitude comprise entre `-90` et `90`;
- longitude comprise entre `-180` et `180`;
- deux points au minimum;
- limite distincte pour une route et une matrice;
- profil obligatoirement présent dans la table `profiles`;
- noms de profil limités aux lettres, chiffres, `_` et `-`.

Une erreur d’entrée lève `RoutingInputError` avec un `code` sûr et, si nécessaire, l’index du point fautif. Il s’agit d’une erreur du demandeur, pas d’une indisponibilité du fournisseur.

## Sortie d’une route

```json
{
  "status": "ok",
  "distanceMeters": 12450.4,
  "durationSeconds": 1980.2,
  "geometry": {
    "format": "geojson",
    "value": { "type": "LineString", "coordinates": [] }
  },
  "legs": [
    {
      "fromIndex": 0,
      "toIndex": 1,
      "distanceMeters": 12450.4,
      "durationSeconds": 1980.2
    }
  ],
  "snappedPoints": [
    { "inputIndex": 0, "distanceMeters": 8.2 }
  ],
  "quality": {
    "fallbackUsed": false,
    "warnings": ["routing_duration_is_not_eta"]
  },
  "source": {
    "provider": "osrm",
    "profile": "motorcycle",
    "providerProfile": "driving-benin-v1",
    "mapDataVersion": "benin-2026-09-08",
    "providerVersion": "osrm-6.0",
    "calculatedAt": "2026-09-15T08:30:00.000Z",
    "requestFingerprint": "empreinte-opaque",
    "cache": "miss"
  }
}
```

La provenance conserve le profil, la version déclarée du graphe, la version du moteur, l’heure du calcul et une empreinte opaque de la requête. Elle ne contient ni URL du fournisseur, ni secret, ni message brut reçu du réseau.

La géométrie OSRM est demandée en GeoJSON et contrôlée avant d’être acceptée. Distance, durée, segments, points rattachés et coordonnées de géométrie doivent être finis et cohérents.

## Sortie d’une matrice

`matrix(input)` utilise le service Table avec `annotations=duration,distance`. Il renvoie :

- `distancesMeters` et `durationsSeconds`, sous forme de matrices carrées;
- une liste `cells` avec indices source/destination;
- `status: "ok"` si toutes les cellules sont joignables;
- `status: "partial"` si au moins une cellule vaut `null` chez OSRM;
- `status: "unavailable"` si aucun résultat fiable ne peut être produit.

Une cellule non joignable garde `status: "unreachable"`, `distanceMeters: null` et `durationSeconds: null`. Aucun calcul géométrique de secours ne la transforme en cellule valide.

## Sortie d’un map-matching

`match(input)` accepte une liste `points` (ou `coordinates`) où chaque point porte
`lat`, `lng` et, si connue, une `accuracy` en mètres. La précision est convertie en
rayon de recherche OSRM, borné entre 4 et 50 m (défaut 15 m si absente). La requête
utilise le service Match avec `geometries=geojson`, `overview=full`, `tidy=true` et
`gaps=split`.

```json
{
  "status": "ok",
  "geometry": { "format": "geojson", "value": { "type": "LineString", "coordinates": [] } },
  "matchings": 1,
  "matchedPoints": 42,
  "totalPoints": 48,
  "confidence": 0.91,
  "distanceMeters": 3120.4,
  "durationSeconds": 486.0,
  "quality": { "fallbackUsed": false, "warnings": ["routing_duration_is_not_eta"] },
  "source": {}
}
```

`matchedPoints` compte les points effectivement calés (tracepoints non nuls),
`totalPoints` le nombre de points fournis, et `confidence` la moyenne des
confiances OSRM. Un échec (`NoMatch`, `NoSegment`, panne réseau) renvoie
`status: "unavailable"` avec `geometry: null` : l’appelant retombe sur la trace
GPS nettoyée, jamais sur une ligne inventée. La plafond applicatif par défaut est
de 100 points (`maxMatchCoordinates`, `ROUTING_MAX_MATCH_COORDINATES`).

## Dégradation et codes sûrs

Les pannes externes ne sont pas relancées vers l’appelant sous forme d’exception technique. Elles deviennent un résultat `unavailable` avec valeurs métier à `null`.

| Code | Sens | Reprise automatique raisonnable |
|---|---|---|
| `provider_disabled` | fournisseur volontairement désactivé | non |
| `provider_timeout` | délai d’attente dépassé | oui |
| `provider_unreachable` | transport ou DNS indisponible | oui |
| `provider_rate_limited` | HTTP 429 | oui, avec temporisation hors de ce module |
| `provider_http_error` | autre erreur HTTP | selon `failure.retryable` |
| `provider_invalid_response` | JSON ou structure incohérente | non, alerte exploitation |
| `provider_response_too_large` | limite de corps dépassée | non, revoir limite ou requête |
| `provider_rejected_request` | OSRM refuse la requête | non |
| `route_not_found` | OSRM `NoRoute` | non, contrôle manuel |
| `matrix_unavailable` | OSRM `NoTable` | non, contrôle manuel |

Le délai est imposé par `Promise.race` et `AbortController`; il reste donc effectif même si une implémentation HTTP injectée ignore le signal d’annulation. La taille du corps est vérifiée avant parsing lorsque l’en-tête est disponible, puis sur les octets réellement reçus.

Le module ne journalise rien. Il ne recopie jamais `error.message` ni le message détaillé OSRM dans sa sortie. Le service qui l’intègre doit également éviter de journaliser les URL complètes, car elles contiennent les coordonnées.

## Cache

Le cache mémoire fourni est borné en nombre d’entrées, applique un TTL, restitue des copies et utilise une politique LRU simple. Seuls les résultats exploitables sont mis en cache; une panne n’empêche donc pas une récupération rapide du fournisseur.

Pour injecter Redis ou un autre cache :

```js
const cache = {
  async get(opaqueKey) {
    // Retourner l'objet normalisé ou null.
  },
  async set(opaqueKey, normalizedResult, ttlMs) {
    // Conserver pendant ttlMs.
  },
};
```

Une panne du cache est ignorée : elle ne doit ni masquer une route valide, ni empêcher un nouvel appel au moteur. Les clés sont des empreintes SHA-256 tronquées; elles ne contiennent pas les coordonnées en clair.

## Options et limites par défaut

| Option | Défaut | Limite acceptée |
|---|---:|---:|
| `timeoutMs` | 5 000 ms | 1 à 120 000 ms |
| `cacheTtlMs` | 300 000 ms | 0 à 86 400 000 ms |
| `maxRouteCoordinates` | 50 | 2 à 500 |
| `maxMatrixCoordinates` | 25 | 2 à 100 |
| `maxResponseBytes` | 2 Mio | 1 Kio à 20 Mio |

Ces plafonds applicatifs doivent rester inférieurs ou égaux à la configuration réelle de l’instance OSRM. Une matrice plus grande devra passer plus tard par une tâche asynchrone contrôlée, pas par un appel web géant.

## Ce que ce lot ne fait pas

- aucun branchement à une route publique ou à `server.js`;
- aucune ETA, fenêtre d’arrivée ou promesse client;
- aucune optimisation automatique de l’ordre des arrêts;
- aucun repli à vol d’oiseau;
- aucun calcul `snap` ou `trip`;
- aucun cache périmé servi comme résultat frais;
- aucun coupe-circuit distribué;
- aucun test de qualité terrain du profil moto.

Ces limites sont volontaires. Le branchement futur devra d’abord ajouter un endpoint interne en lecture seule, des métriques agrégées sans coordonnées, puis conserver des instantanés versionnés lorsque le calcul influence une décision opérationnelle.

## Tests

Le test ciblé ne contacte aucun serveur réel. Toutes les réponses passent par une fonction HTTP injectée.

```powershell
node --check lib/routing.js
node --check scripts/routing-adapter-test.js
node scripts/routing-adapter-test.js
```

Couverture actuelle : fournisseur désactivé, validation des coordonnées/profils/limites, URL sûre, normalisation Route et Table, provenance, cache intégré et injecté, expiration, cellules inaccessibles, `NoRoute`, `NoTable`, réponse invalide, corps excessif, erreurs HTTP, erreur transport, délai d’attente et absence de fuite d’un secret simulé.

## Référence fournisseur

- [Documentation HTTP officielle OSRM — Route et Table](https://project-osrm.org/docs/v26.4.0/http)
- [Limites de configuration de `osrm-routed`](https://project-osrm.org/docs/v26.4.0/tools)
