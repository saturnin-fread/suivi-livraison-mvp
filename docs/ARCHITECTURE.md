# Architecture technique

## Services Railway

| Service | Responsabilité |
|---|---|
| `traccar` | Réception GPS, appareils, positions et historique technique |
| `Postgres` | Serveur PostgreSQL partagé |
| Base `traccar` | Données internes Traccar |
| Base `delivery` | Données métier du SaaS |
| `delivery-app` | API métier, formulaires, espace entreprise et suivi public |
| `Primary` | n8n principal, à intégrer plus tard |
| `Worker` | workers n8n, à intégrer plus tard |
| `Redis` | disponible pour files et cache, pas encore requis pour le prototype |

## Flux de position

```text
Traccar Client
  → Railway TCP Proxy :14240
  → Traccar :5055
  → delivery-app appelle l’API Traccar côté serveur
  → navigateur reçoit uniquement les données publiques autorisées
```

Les identifiants Traccar ne doivent jamais être envoyés au navigateur.

## Espaces applicatifs

| Route | Public | Responsabilité |
|---|---|---|
| `/app` | Utilisateurs d'entreprise | Opérations quotidiennes de l'entreprise |
| `/app/tournees` | Utilisateurs d'entreprise | Préparation, ordre et cycle de vie des tournées |
| `/driver` | Livreurs liés à un profil | Exécution mobile et reprise limitée après coupure réseau |
| `/admin` | Administrateurs plateforme | Entreprises, offres, facturation, support et supervision |
| `/demande/:token` | Client invité | Saisie et modification contrôlée d'une demande |
| `/suivi/:token` | Client invité | Suivi limité à une commande |
| Traccar | Interne par défaut | Infrastructure GPS et outil de support avancé |

La page `/admin` du prototype sera déplacée vers les pages appropriées de `/app`. Elle ne définit pas l'architecture finale.

## Flux de demande client

```text
delivery-app crée un token de formulaire
  → client ouvre /demande/:token
  → navigateur demande la permission GPS
  → client envoie lat/lng/précision + repères
  → delivery-app stocke la demande
  → entreprise vérifie avant conversion en commande
```

## Assemblage cartographique

```text
Traccar API/WebSocket → positions et événements GPS
Base delivery         → colis, destinations, affectations et statuts
Suggestion actuelle  → ordre géométrique à confirmer, sans durée routière
Adaptateur de routage → fournisseur désactivé ou OSRM qualifié, distances et durées brutes avec provenance
delivery-app          → filtrage par entreprise et par lien public
```

La carte client reçoit un sous-ensemble strict concernant une seule commande. La carte entreprise agrège uniquement les données de l'organisation connectée.

La première carte entreprise utilise `GET /api/app/operations-map`. Le serveur charge les appareils et positions courantes depuis Traccar, les croise avec les seuls livreurs de `req.auth.company_id`, puis ajoute commandes, incidents et tournées issus de `delivery`. En cas d'échec Traccar, l'API renvoie un état GPS indisponible mais conserve les données métier. Le navigateur ne reçoit pas `traccar_unique_id`.

Le suivi public utilise un DTO distinct. Il ne reçoit que l'état de sa commande, sa propre destination, des informations minimales sur le livreur et la position courante autorisée. La position est masquée avant `En tournée` et supprimée après livraison, retour ou annulation. La politique de référent envoie uniquement l'origine du site aux tuiles, jamais le chemin contenant le token. Le token ne doit apparaître dans aucun cache partagé ou journal.

`lib/routing.js` encapsule le fournisseur. `GET /api/app/runs/:id/route` est une lecture réservée à l'entreprise propriétaire de la tournée. Une réponse porte fournisseur, profil, date, versions et avertissement ; la durée routière brute n'est jamais appelée ETA. Le fournisseur reste `disabled` tant que le profil moto et le graphe Bénin ne sont pas qualifiés.

## Sources de vérité

- Base `delivery` : organisations, comptes, demandes, commandes, tournées, CRM, preuves, facturation et audit.
- Traccar : appareils, positions et événements GPS.
- n8n/WAHA : automatisation et communication, jamais stockage métier principal.

L'application ne modifie pas directement les tables internes de Traccar. Elle utilise ses API.

## Reprise réseau du portail livreur

```text
action terrain sûre → tentative API
  → succès : confirmation serveur
  → coupure/5xx : IndexedDB pendant 24 h maximum
  → retour réseau : rejeu FIFO avec la même clé d'idempotence
  → conflit/autorisation : état à vérifier, sans suppression
```

Le service worker ne contient que la coque statique du portail. Les réponses authentifiées `/api/*`, positions, commandes et preuves portent `private, no-store` et ne sont jamais mises en cache. L'encaissement, l'OTP et les preuves exigent toujours le serveur en direct.

## Configuration requise de `delivery-app`

```text
TRACCAR_URL
TRACCAR_USER
TRACCAR_PASSWORD
TRACCAR_DEVICE_ID
DATABASE_URL
ADMIN_USER
ADMIN_PASSWORD
OTP_PEPPER
MAP_TILE_URL (facultatif)
MAP_TILE_ATTRIBUTION (facultatif)
MAP_TILE_MAX_ZOOM (facultatif)
MAP_SATELLITE_TILE_URL (facultatif)
MAP_SATELLITE_ATTRIBUTION (facultatif)
MAP_SATELLITE_MAX_ZOOM (facultatif)
ROUTING_PROVIDER (`disabled` ou `osrm`)
ROUTING_OSRM_URL (requis uniquement pour OSRM)
ROUTING_OSRM_PROFILE (profil préparé côté OSRM)
ROUTING_TIMEOUT_MS, ROUTING_CACHE_TTL_MS (facultatifs)
ROUTING_MAP_DATA_VERSION, ROUTING_PROVIDER_VERSION (provenance)
```

Les valeurs ne sont pas documentées ici volontairement.

## Déploiement local

```powershell
npm install
copy .env.example .env
npm start
```

## Déploiement Railway

Le dossier du projet est :

```text
suivi-livraison-mvp
```

Après authentification Railway :

```powershell
railway link --project df74a90c-9f57-4f81-b440-5cf819e813e3 --environment production
railway up --service delivery-app
```
