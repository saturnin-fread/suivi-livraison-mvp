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
Moteur d'itinéraire   → ordre des arrêts, distances et durées
delivery-app          → filtrage par entreprise et par lien public
```

La carte client reçoit un sous-ensemble strict concernant une seule commande. La carte entreprise agrège uniquement les données de l'organisation connectée.

## Sources de vérité

- Base `delivery` : organisations, comptes, demandes, commandes, tournées, CRM, preuves, facturation et audit.
- Traccar : appareils, positions et événements GPS.
- n8n/WAHA : automatisation et communication, jamais stockage métier principal.

L'application ne modifie pas directement les tables internes de Traccar. Elle utilise ses API.

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
