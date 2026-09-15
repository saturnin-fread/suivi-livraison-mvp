# Plan cartes, itinéraires et estimations

Statut : proposition d’architecture à valider  
Date de l’étude : 15 septembre 2026  
Périmètre : Bénin d’abord, puis Afrique de l’Ouest

## 1. Résultat recherché

Le produit doit fournir trois expériences différentes sans mélanger leurs données :

1. **Client final** : sa commande, l’état de son colis, la position autorisée du livreur, la fraîcheur de cette position et une fourchette d’arrivée compréhensible. Il ne voit aucun autre client, arrêt ou colis.
2. **Livreur** : son manifeste, l’ordre opérationnel confirmé, le prochain arrêt et les informations utiles à l’exécution. Il peut continuer à travailler avec une connexion instable.
3. **Entreprise** : une carte de contrôle montrant ses livreurs, tournées, destinations, incidents, progression et parcours restant, avec prévisualisation avant toute réorganisation.

Une carte est une aide opérationnelle, pas une preuve absolue. Une position GPS, une route calculée et une ETA doivent toujours conserver leur origine, leur horodatage, leur qualité et leurs hypothèses.

## 2. Principes non négociables

- `delivery-app` reste la seule porte d’entrée métier pour les navigateurs.
- Les identifiants Traccar et les clés secrètes des fournisseurs ne sont jamais inclus dans une réponse métier. Un jeton cartographique conçu pour le navigateur doit être public, limité au domaine et au seul usage nécessaire.
- Toute lecture est filtrée par `company_id`; un client public est limité au token de sa commande.
- La position précise du livreur cesse d’être exposée au client après livraison, annulation, retour ou expiration du lien.
- L’ordre proposé n’est jamais appliqué sans confirmation humaine.
- Une ETA est une **fourchette**, jamais une promesse à la minute.
- Une route routière ne doit jamais être remplacée silencieusement par une ligne droite.
- Une position ancienne est affichée comme ancienne; elle ne devient pas « en direct » par simple rafraîchissement de la page.
- L’indisponibilité du moteur routier ne doit pas empêcher l’entreprise de voir ses commandes ni le livreur d’exécuter un ordre déjà confirmé.
- Les fonds de carte et images satellite doivent respecter les licences, attributions et règles de cache du fournisseur.
- Les autres arrêts d’une tournée ne doivent pas être déductibles de l’API publique, même indirectement par des identifiants, une géométrie complète ou des détails d’ETA.

## 3. État du produit observé

### Déjà présent

- PostgreSQL contient les commandes, livreurs, tournées `delivery_runs`, arrêts ordonnés `delivery_stops` et événements de tournée.
- Une tournée peut regrouper plusieurs colis; l’ordre est versionné et réorganisable manuellement.
- Une suggestion géométrique à vol d’oiseau existe pour les tournées en préparation. Elle est volontairement présentée comme indicative et limitée à 50 arrêts.
- Le portail livreur reçoit le manifeste confirmé et distingue les commandes hors tournée.
- Le suivi public utilise un token et ne renvoie plus la position après un état terminal.
- Traccar reste la source de vérité des appareils et positions; ses accès restent côté serveur.
- Leaflet est utilisé pour l’affichage cartographique.

### Lot cartographique livré et vérifié

Le premier lot cartographique est désormais intégré et déployé. Il ajoute notamment :

- `GET /api/app/operations-map`, filtré par entreprise;
- les livreurs, positions, tournées ouvertes, arrêts restants, commandes hors tournée et incidents;
- un rafraîchissement annoncé toutes les 15 secondes;
- une configuration de fond de carte et un calque satellite facultatif;
- des contrôles « Tout afficher », « Ma position », « Centrer sur le livreur » et « Actualiser »;
- des tests de cloisonnement, mobile et absence d’identifiant Traccar dans la réponse.

Ce lot a passé les tests locaux et publics de cloisonnement, charge active, incidents, ordre des arrêts, ressources Leaflet locales et affichage mobile. Les routes et ETA restent volontairement absentes tant qu’un moteur routier et son protocole de qualification terrain ne sont pas validés.

### Écarts à combler

- Les positions sont encore lues par appels REST périodiques; Traccar recommande son WebSocket pour les mises à jour en direct.
- Aucun moteur routier n’est actuellement la source des distances ou durées.
- La suggestion à vol d’oiseau ne connaît ni routes, sens interdits, surfaces, créneaux, capacité réelle, durée de service, trafic ou fermeture terrain.
- Il n’existe pas encore de route calculée immuable liée à une version de tournée.
- L’entreprise ne voit pas encore clairement trois objets séparés : trajet réalisé, position actuelle et trajet restant.
- L’ETA ne possède pas encore de contrat expliquant sa méthode, sa confiance et son âge.
- Les pages publiques utilisent encore directement le serveur de tuiles communautaire OSM; ce service n’a aucun SLA et interdit le préchargement hors ligne.
- Les routes et matrices n’ont pas encore de cache serveur, coupe-circuit, budget de coût ni mécanisme de repli explicite.

## 4. Décisions proposées

### D1 — Introduire une passerelle neutre de routage

`delivery-app` ne doit connaître ni le format OSRM, ni celui de Valhalla, Mapbox ou Google. Une petite interface interne normalise :

- `snap` : rattacher une coordonnée au réseau routier;
- `route` : calculer un parcours dans un ordre imposé;
- `matrix` : calculer distances et durées entre plusieurs points;
- `match` : rattacher une trace GPS au réseau routier, uniquement pour analyse interne;
- `health` : exposer la santé et la version des données cartographiques.

L’optimisation métier reste séparée. Elle consomme une matrice et applique les contraintes de livraison. Cette séparation permet de changer de moteur sans changer les écrans, les tournées ou l’API publique.

### D2 — Comparer OSRM et Valhalla sur un corpus terrain avant le choix final

Le choix proposé est conditionnel :

1. déployer temporairement OSRM et Valhalla avec le même extrait OSM régional;
2. tester des trajets réels à Cotonou, Abomey-Calavi, Porto-Novo, Ouidah et sur des axes interurbains;
3. comparer route trouvée, distance, durée, demi-tours, traversées impossibles, voies privées, pistes, latérite et comportement moto;
4. retenir OSRM si sa simplicité répond aux seuils de qualité; retenir Valhalla si ses profils moto/scooter améliorent matériellement les résultats.

**Préférence initiale** : OSRM auto-hébergé en MLD pour le pilote, car son API Route/Table/Match est simple et performante. **Condition de bascule** : Valhalla devient prioritaire si le banc d’essai moto montre moins d’itinéraires impossibles ou des durées sensiblement plus proches du terrain.

### D3 — Ne pas utiliser OSRM Trip comme optimiseur métier final

Le service Trip d’OSRM résout une approximation du voyageur de commerce; à partir de dix points il utilise une heuristique et le résultat n’est pas garanti comme le plus rapide. Il ne modélise pas toutes les contraintes du SaaS.

Pour le premier pilote :

- la matrice routière remplace les distances à vol d’oiseau;
- l’algorithme actuel devient une **proposition routière**;
- les créneaux, priorités et capacités sont validés par des règles métier explicites;
- une insertion d’urgence teste toutes les positions possibles dans la tournée et présente l’impact;
- une confirmation humaine reste obligatoire.

Pour une optimisation avancée multi-véhicules, évaluer ensuite jsprit auto-hébergé ou une API commerciale. jsprit sait modéliser capacité, créneaux, flotte hétérogène, collecte/livraison et tâches non affectées, mais ajoute un service Java et une charge d’exploitation.

### D4 — Calculer une ETA explicable et versionnée

Une ETA interne doit additionner :

1. le trajet routier depuis la dernière position GPS fiable;
2. les trajets entre les arrêts restant avant le client;
3. une durée de service par arrêt;
4. les attentes imposées par les créneaux;
5. un facteur de prudence mesuré et versionné par zone/période, seulement après un volume de données suffisant.

La réponse publique ne révèle ni le nombre, ni l’emplacement, ni l’identité des arrêts précédents. Elle ne renvoie que la fourchette calculée et ses explications autorisées.

Niveaux de confiance proposés :

| Niveau | Conditions minimales | Affichage client |
|---|---|---|
| `high` | GPS récent, précision acceptable, route trouvée, tournée confirmée, données récentes | Fourchette resserrée |
| `medium` | GPS ou carte imparfaite, mais route et ordre utilisables | Fourchette élargie |
| `low` | Position ancienne, destination approximative ou hypothèses fortes | Estimation très prudente avec avertissement |
| `unavailable` | Pas de route, pas de position exploitable ou service en panne | Aucun horaire inventé |

Déclencheurs de recalcul : changement d’ordre, changement de statut, nouvel arrêt, déplacement significatif du livreur, position redevenue fraîche, ou expiration du calcul. Un recalcul périodique seul ne suffit pas.

### D5 — Utiliser un flux temps réel côté serveur

Architecture proposée :

```text
Traccar /api/socket
  → passerelle delivery-app authentifiée côté serveur
  → filtrage des appareils autorisés par entreprise
  → instantané de dernière position
  → SSE vers l’interface entreprise et, séparément, vers le lien public
  → repli en lecture REST espacée si le flux est indisponible
```

SSE est suffisant pour envoyer des positions du serveur vers le navigateur et plus simple à reconnecter qu’un second WebSocket. Les actions utilisateur continuent de passer par les API HTTP normales.

Règles de flux :

- reconnexion exponentielle avec aléa;
- détection de silence et état `degraded`;
- numéro de séquence ou horodatage monotone pour ignorer les messages hors ordre;
- aucun secret Traccar dans le navigateur;
- reprise par un instantané complet après reconnexion;
- une seule position au maximum par livreur et par intervalle d’affichage afin de limiter bande passante et mouvements visuels;
- si plusieurs réplicas applicatifs sont déployés, ajouter un bus partagé; ne pas l’ajouter prématurément pour un seul réplica.

### D6 — Satellite légal, facultatif et interchangeable

- Ne jamais intégrer des URL de tuiles Google non documentées ou copiées depuis Google Maps.
- Conserver un contrat de fournisseur configurable : URL, attribution, zoom maximal, conditions et date de validation.
- Mapbox Satellite est une option légale documentée, avec token restreint par domaine et attribution visible.
- Le satellite est désactivé tant qu’aucun fournisseur conforme n’est configuré.
- Aucun préchargement ou mode hors ligne n’est activé sans droit contractuel explicite.
- Le calque « rues » et le calque « satellite » sont indépendants du moteur de routage.

### D7 — Ne pas dépendre des tuiles communautaires OSM pour un SLA commercial

Le serveur `tile.openstreetmap.org` peut servir le pilote à faible volume si sa politique est respectée, mais il est best-effort, sans SLA, peut bloquer un usage nuisible et interdit la collecte massive ou le mode hors ligne.

Avant la commercialisation :

- choisir un fournisseur de tuiles avec contrat commercial ou auto-héberger;
- conserver l’attribution OSM visible;
- ne pas coder l’URL en dur;
- respecter les en-têtes de cache;
- prévoir un lien « Signaler un problème de carte »;
- surveiller erreurs, latence et consommation.

### D8 — Conserver des instantanés routiers auditables

Chaque calcul utilisé pour décider ou communiquer une ETA doit conserver au minimum :

- entreprise, tournée et version de tournée;
- empreinte normalisée des entrées;
- fournisseur, profil et version des données cartographiques;
- position source et son âge, sans recopier inutilement tout l’historique;
- ordre des arrêts internes;
- distance, durée, géométrie et statut du calcul;
- hypothèses, avertissements et cellules inaccessibles;
- date de calcul et expiration;
- version de la méthode ETA.

Une nouvelle version crée un nouvel instantané; elle ne réécrit pas celui ayant servi à une décision antérieure.

## 5. Comparatif des options

Les tarifs ci-dessous ont été vérifiés le 15 septembre 2026 et doivent être revérifiés avant achat.

| Option | Coût observable | Auto-hébergement | SLA | Limites importantes | Confidentialité / exploitation | Avis |
|---|---:|---|---|---|---|---|
| OSRM | Logiciel BSD; coût de calcul, volume et sauvegarde | Oui, images officielles | Aucun SLA logiciel; dépend de notre hébergeur | Profils préparés avant exécution; Trip approximatif; profil moto à concevoir/tester | Les coordonnées restent dans notre infrastructure | Premier candidat du pilote si le corpus terrain passe |
| Valhalla | Logiciel MIT; coût d’infrastructure | Oui, images officielles | Aucun SLA logiciel; dépend de notre hébergeur | Plus de réglages et d’exploitation; validation locale nécessaire | Coordonnées internes; modèles dynamiques et modes plus riches | Candidat fort pour motos/scooters et évolutions avancées |
| GraphHopper hébergé | Free non commercial; Basic 69 €/mois, Standard 199 €, Premium 479 € hors TVA | Le moteur routier oui; jsprit pour optimisation | 99,5 % sur les plans payants | 30/80/200 lieux par requête et 2/10/20 véhicules d’optimisation selon plan; quotas crédits | Les requêtes API, corps, en-têtes et IP sont stockés jusqu’à 5 semaines | Bon accélérateur commercial, mais coût fixe et transfert de données |
| GraphHopper + jsprit auto-hébergés | Logiciels Apache 2.0; coût JVM et exploitation | Oui | Notre SLO uniquement | Service Java supplémentaire, tuning et matrice à fournir | Très bon contrôle des données | À envisager quand les contraintes VRP dépassent le pilote |
| Mapbox | Directions/Optimization : 100 000 requêtes gratuites puis 2 $/1 000 au premier palier; Matrix facturée par élément | Atlas sur contrat, sinon service hébergé | 99,9 % avec commande contractuelle active | Matrix 25 × 25; Optimization v2 est en bêta; coût par élément | Traitement principal aux États-Unis; politique et DPA à examiner | Bon satellite et bon secours hébergé; ne pas dépendre de v2 bêta pour le cœur |
| Google Routes | Essentials : 10 000 gratuites puis 5 $/1 000; Pro : 5 000 puis 10 $/1 000 au premier palier | Non pour le service Maps | SLO 99,9 % pour les services couverts | Matrix 625 éléments, ou 100 avec trafic optimal; facturation par élément | Coordonnées envoyées à Google; conditions et restrictions de contenu à valider | Qualité/SLA potentiellement élevés, coût et verrouillage plus forts |
| Google Route Optimization | Single vehicle : 5 000 gratuites puis 10 $/1 000; Fleet : 1 000 puis 30 $/1 000 au premier palier | Non | Selon services couverts et contrat | Coût supérieur; dépendance fournisseur | Données de flotte transmises au fournisseur | Option de montée en gamme, pas le socle du pilote |

Les montants commerciaux ne comprennent pas le coût des fonds de carte ou du satellite lorsqu’ils sont facturés séparément.

## 6. Architecture cible progressive

```text
Traccar Client
  → Traccar
      → WebSocket privé → delivery-app → SSE filtré → entreprise
                                   └── SSE/API filtrée → client d’une commande

PostgreSQL delivery
  → commandes + destinations + tournées + versions + événements
  → delivery-app
      → routing-adapter
          → OSRM ou Valhalla privé
          → fournisseur hébergé facultatif et contrôlé
      → route/ETA snapshot versionné

Navigateur
  → Leaflet local
  → fournisseur de tuiles rues
  → fournisseur satellite facultatif
```

Le moteur routier ne doit pas être publiquement accessible. `delivery-app` lui impose authentification interne, délais, limites de points et validation des coordonnées.

## 7. Contrats API proposés

Les noms ci-dessous constituent une cible; ils devront être rapprochés des routes déjà existantes avant implémentation.

### 7.1 Contrat interne du fournisseur

```text
RoutingProvider.health() → ProviderHealth
RoutingProvider.snap(input) → SnapResult
RoutingProvider.route(input) → RouteResult
RoutingProvider.matrix(input) → MatrixResult
RoutingProvider.match(input) → MatchResult
```

Entrée commune :

```json
{
  "profile": "motorcycle",
  "coordinates": [{ "lat": 6.37, "lng": 2.43 }],
  "departureAt": "2026-09-15T10:00:00+01:00",
  "units": "metric",
  "requestId": "opaque-id"
}
```

Sortie normalisée d’une route :

```json
{
  "status": "ok",
  "distanceMeters": 12450,
  "durationSeconds": 1980,
  "geometry": { "format": "polyline6", "value": "..." },
  "legs": [{ "fromIndex": 0, "toIndex": 1, "distanceMeters": 12450, "durationSeconds": 1980 }],
  "snappedPoints": [{ "inputIndex": 0, "distanceMeters": 18 }],
  "quality": { "fallbackUsed": false, "warnings": [] },
  "source": {
    "provider": "osrm",
    "profile": "driving-benin-v1",
    "mapDataVersion": "2026-09-08",
    "calculatedAt": "2026-09-15T09:00:00Z"
  }
}
```

Une cellule de matrice doit avoir l’un des statuts `ok`, `estimated`, `unreachable` ou `error`. Une valeur de repli géométrique ne peut jamais porter le statut `ok`.

### 7.2 Instantané de carte entreprise

```http
GET /api/app/operations-map?driverId=&runId=&status=&updatedAfter=
```

Réponse :

- `generatedAt`, `snapshotVersion`, `refreshAfterSeconds`;
- santé de Traccar, du moteur routier et des tuiles;
- livreurs autorisés et dernière position exploitable;
- tournées ouvertes, progression et arrêts restants;
- commandes hors tournée;
- résumé et indicateur de troncature;
- aucune clé, mot de passe ou identifiant technique Traccar.

Évolution recommandée : pagination ou réponse différentielle au lieu d’un tableau global limité arbitrairement à 500 commandes.

### 7.3 Route restante d’une tournée

```http
GET /api/app/runs/:runId/route?version=:runVersion
```

```json
{
  "runId": 42,
  "runVersion": 7,
  "status": "ready",
  "distanceRemainingMeters": 18420,
  "durationRemainingSeconds": 3120,
  "geometry": { "format": "polyline6", "value": "..." },
  "legs": [],
  "confidence": "medium",
  "source": {},
  "warnings": []
}
```

Statuts : `ready`, `calculating`, `stale`, `partial`, `unavailable`.

### 7.4 Prévisualisation d’un réordonnancement

```http
POST /api/app/runs/:runId/reorder-preview
Idempotency-Key: <clé opaque>
```

```json
{
  "expectedVersion": 7,
  "stopIds": [12, 15, 14],
  "reason": "Client 15 disponible avant midi"
}
```

La réponse compare avant/après : distance, durée, retards probables, créneaux violés, capacité, arrêts devenus inaccessibles et qualité du calcul. Elle ne modifie rien.

La route de confirmation existante doit exiger la version attendue, une clé d’idempotence et une raison; un conflit de version renvoie `409` avec invitation à recharger.

### 7.5 Proposition d’insertion d’une commande

```http
POST /api/app/runs/:runId/insertion-preview
```

Entrée : commande, version de tournée et contraintes. Sortie : au maximum trois positions d’insertion, chacune avec impact et avertissements. Aucune insertion automatique dans une tournée active.

### 7.6 ETA interne

```http
GET /api/app/orders/:orderId/eta
```

```json
{
  "status": "available",
  "arrivalWindow": {
    "earliest": "2026-09-15T11:20:00+01:00",
    "latest": "2026-09-15T11:50:00+01:00"
  },
  "confidence": "medium",
  "calculatedAt": "2026-09-15T09:15:00Z",
  "validUntil": "2026-09-15T09:20:00Z",
  "positionAgeSeconds": 35,
  "methodVersion": "eta-v1",
  "reasons": ["route_found", "confirmed_run", "no_live_traffic"],
  "warnings": []
}
```

### 7.7 Suivi public

```http
GET /api/tracking/:token
GET /api/tracking/:token/stream
```

Le contrat public peut inclure :

- statut de la commande;
- position courante ou dernière position autorisée;
- âge et précision de la position;
- destination du client;
- fourchette d’arrivée et confiance;
- date de dernière mise à jour.

Il exclut impérativement : autres arrêts, ordre interne, identité des autres clients, route complète de la tournée, capacité du livreur, identifiants internes et historique GPS détaillé.

## 8. Règles multi-colis et réordonnancement

### Contraintes dures

- destination exploitable ou traitement manuel explicite;
- capacité du véhicule;
- état de la commande compatible;
- arrêt déjà livré jamais réordonné;
- arrêt verrouillé par l’exploitation conservé;
- retrait avant livraison pour un colis collecté;
- horaires de travail et contraintes réglementaires configurées;
- version de tournée identique au moment de confirmer.

### Objectifs souples, par ordre proposé

1. minimiser les livraisons hors créneau;
2. respecter les priorités et engagements clients;
3. minimiser la durée totale;
4. minimiser la distance et les demi-tours;
5. équilibrer la charge seulement lors de l’affectation multi-livreurs;
6. limiter les changements d’un ordre déjà communiqué.

### Interaction entreprise

- afficher l’ordre actuel et la proposition côte à côte;
- montrer les gains et risques, pas seulement « optimisé »;
- permettre d’épingler un arrêt;
- permettre un glisser-déposer manuel;
- recalculer sans enregistrer;
- confirmer avec motif;
- journaliser l’auteur, l’ancienne version, la nouvelle version et la méthode;
- avertir les clients concernés seulement après confirmation.

## 9. ETA : méthode et honnêteté d’affichage

### Version 1, sans trafic en direct

```text
durée routière restante
+ service aux arrêts précédents
+ attente de créneau
+ marge de prudence par zone
= centre de la fourchette
```

La largeur de la fourchette augmente avec :

- âge et précision GPS;
- destination déplacée loin du réseau routier;
- route partielle ou point inaccessible;
- route non pavée ou cartographie peu fiable;
- absence d’historique local;
- nombre d’arrêts encore susceptibles d’être modifiés;
- coupure du service de routage.

### Calibration future

- mesurer séparément temps de conduite, attente et service;
- comparer estimé/réel par zone, heure, jour et type de véhicule;
- imposer un minimum d’échantillons avant correction;
- borner les facteurs afin qu’une anomalie ne déforme pas toutes les ETA;
- versionner les coefficients;
- exclure les traces manifestement aberrantes;
- ne jamais utiliser automatiquement ces mesures pour sanctionner un livreur.

## 10. Résilience réseau adaptée au terrain

### Navigateur entreprise

- conserver seulement la coque statique nécessaire au redémarrage;
- ne jamais mettre en cache les réponses privées ou positions dans le cache HTTP du service worker;
- afficher le dernier instantané en mémoire avec son âge pendant une coupure courte;
- arrêter l’animation « en direct » dès que le flux est silencieux;
- proposer un bouton de reconnexion et un mode liste sans carte;
- charger les marqueurs avant les géométries lourdes;
- désactiver le satellite par défaut sur réseau faible;
- ne pas précharger des tuiles hors écran.

### Portail livreur

- conserver la tournée confirmée et ses identifiants utiles dans IndexedDB pour lecture hors ligne;
- mettre en file uniquement les actions déjà déclarées sûres, avec même clé d’idempotence au rejeu;
- afficher `en attente`, `synchronisé` ou `à vérifier` pour chaque action;
- ne jamais inventer une nouvelle route si le moteur est inaccessible;
- conserver la dernière route confirmée en indiquant sa date;
- limiter taille et durée de la file, puis demander une vérification humaine.

### Serveur

- délai court par appel fournisseur;
- maximum de points par type de requête;
- coupe-circuit après échecs répétés;
- cache serveur indexé par profil, coordonnées normalisées, contraintes et version des données;
- réponse `stale` explicite si un ancien calcul est réutilisé;
- repli du temps réel vers REST avec fréquence limitée;
- tâches asynchrones pour les grosses matrices;
- métriques par fournisseur : latence, taux de route trouvée, erreurs, coût et cellules inaccessibles;
- conservation de la précédente version de graphe pour retour arrière.

### Mise à jour des données OSM

- construire les graphes hors du service de production;
- valider un jeu de routes sentinelles avant activation;
- basculer de manière atomique vers la nouvelle version;
- conserver la version précédente;
- afficher la date du graphe dans les diagnostics;
- cadence initiale hebdomadaire, à ajuster selon changements terrain et coût d’exploitation.

## 11. Cas d’erreur à traiter

| Situation | Comportement attendu |
|---|---|
| Destination sans GPS | Demander correction ou repère; ne pas optimiser silencieusement |
| Coordonnée dans l’eau ou hors zone | Bloquer le calcul, proposer vérification manuelle |
| Point trop loin d’une route | Retour `partial` avec distance de rattachement; pas de fausse précision |
| Route introuvable | Marquer l’arrêt inaccessible; garder l’ordre manuel |
| Cellule de matrice `null` | Exclure la proposition concernée et expliquer pourquoi |
| Fournisseur en délai dépassé | Ouvrir le coupe-circuit; servir un calcul ancien marqué `stale` si autorisé |
| Quota ou crédit épuisé | Désactiver les nouveaux calculs coûteux, alerter l’exploitation, préserver les routes confirmées |
| Position GPS ancienne | Geler l’icône, afficher l’âge, élargir ou retirer l’ETA |
| Saut GPS impossible | Ignorer pour ETA, conserver l’anomalie technique, attendre confirmation |
| Messages hors ordre | Garder celui dont le temps de mesure/numéro de séquence est le plus récent |
| WebSocket Traccar coupé | Reconnexion progressive puis lecture REST limitée |
| SSE navigateur coupé | Reconnexion avec dernier identifiant d’événement puis instantané complet |
| Tournée modifiée pendant une prévisualisation | `409 version_conflict`, aucune écriture |
| Deux confirmations simultanées | Une seule version gagne; l’autre recharge et compare |
| Arrêt livré inclus dans un nouvel ordre | Requête refusée |
| Créneau impossible | Proposition autorisée uniquement avec avertissement bloquant et arbitrage humain |
| Capacité dépassée | Proposition refusée |
| Données OSM obsolètes | Avertissement interne et ticket de correction terrain |
| Satellite indisponible | Retour automatique au fond rues sans bloquer les opérations |
| Tuiles OSM communautaires bloquées | Mode liste opérationnel et fournisseur de remplacement |
| Client après livraison | Aucune position précise ni route restante |
| Token public expiré | `410` ou page d’expiration, sans donnée métier |
| Plus de 50 arrêts | Calcul asynchrone ou découpage; aucun appel synchrone géant |
| Réseau 2G intermittent | Payload différentiel, géométrie simplifiée, satellite désactivé |

## 12. Plan de tests

### 12.1 Tests unitaires

- normalisation OSRM et Valhalla vers le même contrat;
- lat/lng inversées, NaN, limites géographiques et précision;
- conversion mètres/secondes et fuseau `Africa/Porto-Novo`;
- cellules `ok`, `estimated`, `unreachable`, `error`;
- calcul de fourchette et élargissement par niveau de confiance;
- exclusion des arrêts terminés;
- empreinte stable des entrées et version de méthode;
- aucune ETA quand les préconditions ne sont pas réunies.

### 12.2 Tests d’intégration

- délai dépassé, 429, 5xx, réponse invalide et reprise du fournisseur;
- cache frais, cache expiré et calcul ancien marqué `stale`;
- changement de version de tournée pendant le calcul;
- prévisualisation sans écriture;
- confirmation idempotente;
- matrice partielle et arrêt inaccessible;
- WebSocket Traccar interrompu/reconnecté;
- SSE repris après déconnexion;
- source de données et avertissements présents dans chaque calcul.

### 12.3 Sécurité et confidentialité

- un compte d’entreprise ne reçoit aucun livreur, arrêt ou itinéraire d’une autre entreprise;
- un token public ne peut charger qu’une commande;
- le JSON public ne contient ni nombre d’arrêts précédents, ni séquence, ni géométrie multi-arrêts;
- aucune réponse ne contient clé fournisseur, mot de passe ou `traccar_unique_id`;
- les journaux masquent tokens, téléphones et coordonnées selon leur usage;
- la position disparaît après état terminal ou expiration;
- les URL satellite et restrictions de domaine n’exposent aucun secret serveur.

### 12.4 Banc d’essai terrain Bénin

Constituer un corpus versionné comportant au minimum :

- centres urbains denses;
- quartiers sans adressage formel;
- pistes et routes en latérite;
- sens uniques, terre-pleins et demi-tours;
- ponts, lagunes, ferries et voies non traversables;
- entrées de marchés, résidences et voies privées;
- trajets moto et voiture;
- axes Cotonou–Calavi, Cotonou–Porto-Novo, Cotonou–Ouidah et liaisons secondaires;
- points GPS imprécis de 20, 50 et 100 mètres;
- zones avec faible couverture de données.

Mesures :

- taux de route trouvée;
- kilomètres et minutes estimés contre terrain;
- nombre d’itinéraires manifestement impossibles;
- distance de rattachement au réseau;
- latence p50/p90/p99;
- mémoire et temps de construction du graphe;
- effet du profil moto;
- stabilité après mise à jour OSM.

Seuils initiaux de passage proposés :

- au moins 95 % des trajets de référence routables;
- zéro traversée physiquement impossible dans les routes sentinelles;
- p90 inférieur à 1,5 seconde pour une route simple sur l’infrastructure cible;
- p90 inférieur à 3 secondes pour une matrice de 25 points;
- erreur absolue médiane de durée inférieure à 20 % après calibration pilote;
- aucune fuite inter-entreprise ou inter-client dans les tests automatisés.

Ces seuils sont des objectifs du produit, pas des garanties fournies par les moteurs.

### 12.5 Interface et accessibilité

- mobile 360/390 px sans débordement;
- carte utilisable au clavier et actions disponibles aussi en liste;
- attribution toujours visible;
- « Ma position », « Tout afficher », « Recentrer », sélection de calque et suivi automatique;
- couleurs doublées de formes/labels;
- trajet réalisé, route restante et position courante visuellement distincts;
- position ancienne annoncée textuellement;
- mode satellite facultatif et retour au fond rues;
- réseau lent, perte du flux, reprise et données obsolètes.

### 12.6 Charge et chaos

- 50 arrêts par tournée et plusieurs tournées simultanées;
- plusieurs centaines de livreurs via réponses différentielles;
- redémarrage du moteur pendant des calculs;
- bascule de version du graphe;
- perte DNS, latence élevée et quota fournisseur;
- reconnexions simultanées après coupure mobile;
- contrôle des coûts et des volumes de matrice.

## 13. Phases d’exécution

### Phase 0 — Stabiliser le lot carte existant

- terminer les tests syntaxe, API, isolation, mobile et régression;
- vérifier les fonds configurables et attributions;
- documenter les variables sans valeur secrète;
- déployer et figer un point de retour arrière.

Sortie : carte entreprise fiable sans route ni ETA inventée.

### Phase 1 — Banc d’essai routier

- préparer le corpus terrain;
- déployer OSRM MLD et Valhalla isolément;
- mesurer qualité, moto, coût et exploitation;
- produire une décision signée avec résultats.

Sortie : moteur principal choisi et moteur alternatif identifié.

### Phase 2 — Passerelle et routes en lecture seule

- implémenter le contrat fournisseur;
- ajouter santé, délais, limites, cache et version des données;
- calculer route/distance d’une tournée confirmée;
- afficher la route restante côté entreprise uniquement;
- conserver l’ordre humain existant.

Sortie : distances routières réelles, sans optimisation automatique.

### Phase 3 — Prévisualisation et multi-colis

- matrice routière;
- proposition d’ordre avec contraintes;
- insertion d’urgence;
- comparaison avant/après;
- version, idempotence, motif et audit;
- recalcul après confirmation.

Sortie : réordonnancement explicable et réversible par nouvelle version.

### Phase 4 — Temps réel robuste

- WebSocket Traccar côté serveur;
- instantané et SSE entreprise;
- reprise REST contrôlée;
- âge, précision, anomalies et mode dégradé;
- montée multi-réplica seulement si nécessaire.

Sortie : positions en direct sans exposer Traccar.

### Phase 5 — ETA interne puis publique

- ETA interne avec service, créneaux et confiance;
- comparaison terrain silencieuse pendant le pilote;
- calibration prudente;
- exposition publique d’une fourchette seulement après seuils de qualité;
- arrêt automatique après état terminal.

Sortie : estimation utile, mesurée et honnête.

### Phase 6 — Fonds commerciaux et satellite

- contrat fournisseur de tuiles;
- token restreint, attribution et budget;
- satellite/hybride facultatif;
- tests de repli et réseau faible;
- fin de dépendance commerciale au serveur communautaire OSM.

Sortie : calques légaux et résilients.

### Phase 7 — Optimisation avancée

- décider si l’optimisation mono-livreur suffit;
- si nécessaire, évaluer jsprit, GraphHopper hébergé ou Google Fleet;
- ajouter multi-véhicules, dépôts, horaires, compétences et coûts;
- conserver une validation humaine et une explication des tâches non affectées.

Sortie : optimisation de flotte seulement après preuve de besoin et de rentabilité.

## 14. Observabilité et budgets

Tableau de bord minimal :

- positions reçues/minute et âge p50/p95;
- connexions/reconnexions Traccar;
- clients SSE actifs;
- routes et matrices par fournisseur;
- taux de cache;
- latence p50/p90/p99;
- routes introuvables et cellules inaccessibles;
- ETA disponible/indisponible par cause;
- erreur ETA contre réel;
- consommation payante et projection mensuelle;
- version de graphe active;
- taux de repli et durée en mode dégradé.

Alertes : moteur indisponible, graphe trop ancien, hausse des routes introuvables, quota à 70/85/95 %, âge GPS anormal, fuite potentielle de filtre entreprise, ou attribution manquante après changement de calque.

## 15. Déclencheurs de réévaluation

Revoir les choix si :

- le pilote dépasse 50 arrêts par tournée de manière régulière;
- plusieurs réplicas applicatifs deviennent nécessaires;
- l’erreur ETA reste supérieure au seuil après calibration;
- OSRM échoue significativement sur les trajets moto;
- un SLA contractuel devient obligatoire;
- les coûts d’une API hébergée deviennent inférieurs à l’exploitation interne;
- une réglementation ou un contrat impose une région de traitement;
- le satellite devient un élément commercial critique;
- le produit s’étend à plusieurs pays avec politiques de conduite différentes.

## 16. Sources officielles

### OpenStreetMap et Leaflet

- [Politique officielle des tuiles OpenStreetMap](https://operations.osmfoundation.org/policies/tiles/)
- [Référence Leaflet : localisation, ajustement de vue, tuiles et contrôle des calques](https://leafletjs.com/reference)

### Traccar

- [API Traccar et WebSocket](https://www.traccar.org/traccar-api/)
- [Référence officielle Traccar](https://www.traccar.org/api-reference)
- [Spécification OpenAPI Traccar](https://www.traccar.org/api-reference/openapi.yaml)

### OSRM

- [API HTTP OSRM : Route, Table, Match et Trip](https://project-osrm.org/docs/v26.4.0/http)
- [Projet, licence et déploiement Docker OSRM](https://github.com/Project-OSRM/osrm-backend)
- [Profils de routage OSRM](https://project-osrm.org/docs/v26.4.0/profiles)

### Valhalla

- [Vue d’ensemble des API Valhalla](https://valhalla.github.io/valhalla/api/)
- [Service de matrice temps-distance Valhalla](https://valhalla.github.io/valhalla/api/matrix/)
- [Routage et modèles de coût Valhalla](https://valhalla.github.io/valhalla/api/turn-by-turn/overview/)
- [Projet, licence et auto-hébergement Valhalla](https://github.com/valhalla/valhalla)

### GraphHopper et jsprit

- [Tarifs, limites et SLA GraphHopper](https://www.graphhopper.com/pricing/)
- [Moteur GraphHopper auto-hébergeable](https://github.com/graphhopper/graphhopper)
- [Politique de confidentialité GraphHopper](https://www.graphhopper.com/privacy/)
- [Optimiseur open source jsprit](https://github.com/graphhopper/jsprit)

### Mapbox

- [API Matrix Mapbox](https://docs.mapbox.com/api/navigation/matrix/)
- [API Optimization v2 Mapbox, actuellement en bêta](https://docs.mapbox.com/api/navigation/optimization/)
- [Tarification Mapbox](https://www.mapbox.com/pricing)
- [SLA Mapbox](https://www.mapbox.com/legal/sla)
- [Mapbox Satellite et attribution](https://docs.mapbox.com/data/tilesets/reference/mapbox-satellite/)
- [Politique de confidentialité Mapbox](https://www.mapbox.com/legal/privacy)

### Google Maps Platform

- [Vue d’ensemble de Compute Routes](https://developers.google.com/maps/documentation/routes/compute-route-over)
- [Compute Route Matrix et limites](https://developers.google.com/maps/documentation/routes/compute_route_matrix)
- [Route Optimization API](https://developers.google.com/maps/documentation/route-optimization/overview)
- [Tarification Google Maps Platform](https://developers.google.com/maps/billing-and-pricing/pricing)
- [SLA Google Maps Platform](https://cloud.google.com/maps-platform/terms/sla)

### Résilience web

- [Spécification W3C Service Workers](https://www.w3.org/TR/service-workers/)
- [Spécification W3C IndexedDB](https://www.w3.org/TR/IndexedDB/)
