# Exploitation et reprise

## Vérifier l’état des services

Dans Railway, contrôler :

- `delivery-app` ;
- `traccar` ;
- `Postgres` ;
- `Primary` ;
- `Worker` ;
- `Redis`.

## Vérifier l’application

```text
GET /health
GET /admin
GET /suivi/demo-ccg-2026
```

## Base de données métier

L'application `delivery-app` utilise la base PostgreSQL nommée `delivery`, distincte de la base par défaut éventuellement utilisée par n8n. Lors d'un accès externe pour un diagnostic ou un test, partir de `DATABASE_PUBLIC_URL` du service Postgres et conserver explicitement `/delivery` comme nom de base. Ne jamais exécuter un test de nettoyage sur l'URL dont le chemin ne désigne pas `delivery`.

Les petites preuves photo/signature du pilote sont incluses dans cette base. Surveiller sa taille et tester leur restauration avec les sauvegardes. Avant montée en charge, suivre `docs/DELIVERY_EVIDENCE.md` pour les migrer vers un stockage objet privé.

Les commandes sous gel actif dans `order_retention_holds` ne doivent être supprimées par aucune future purge. Contrôler régulièrement les dates `review_due_at`. Une date dépassée impose une révision humaine et ne lève jamais automatiquement le gel. Voir `docs/INCIDENT_DOSSIERS.md`.

Les tournées sont conservées dans `delivery_runs`, `delivery_stops` et `delivery_run_events`. Une suppression manuelle de tournée détruirait son historique ; en exploitation, utiliser l'annulation motivée. Voir `docs/DELIVERY_RUNS.md`.

Les corrections financières après clôture sont conservées dans `payment_adjustments`. Ne jamais modifier ou supprimer ces lignes manuellement : utiliser l'écriture inverse prévue dans la fiche commande. Ce journal opérationnel ne remplace pas la comptabilité légale. Voir `docs/PAYMENT_RECONCILIATION.md`.

La file hors connexion du livreur se trouve sur son téléphone, pas dans PostgreSQL. Une action affichée « en attente » n'est donc pas encore acquise par l'entreprise. Demander au livreur d'ouvrir `/driver` avec du réseau et d'utiliser **Synchroniser**. En cas de conflit « à vérifier », comparer d'abord l'état serveur avant de supprimer ou ressaisir l'action. Voir `docs/OFFLINE_OPERATIONS.md`.

## Accès aux interfaces

```text
/app/login   espace de connexion d'une entreprise
/app         opérations quotidiennes de l'entreprise
/app/tournees préparation et suivi des tournées multi-colis
/app/carte   flotte, destinations et ordre opérationnel restant
/driver      espace mobile d'un livreur invité et lié à son profil
/admin/login administration de la plateforme uniquement
```

`ADMIN_USER` et `ADMIN_PASSWORD` initialisent le propriétaire de l'entreprise de démonstration. `PLATFORM_ADMIN_USER` et `PLATFORM_ADMIN_PASSWORD` sont distincts et réservés à l'équipe qui exploite le SaaS.

## Redéployer

Depuis le dossier `suivi-livraison-mvp` :

```powershell
railway up --service delivery-app --environment production
```

## Tests avant et après déploiement

```powershell
npm run test:syntax
npm run test:payments
npm run test:runs
npm run test:map
npm run test:routing
npm run test:tracking-links
npm run test:rate-limit
npm run test:dispatch
npm run test:crm-metrics
npm run test:crm-export
npm run test:crm
npm run check:tracking-storage
npm run test:smoke
npm run test:driver
```

Avant de modifier le stockage des liens de suivi, suivre `docs/TRACKING_LINK_MIGRATION_RUNBOOK.md`. Ne jamais revenir à une version applicative qui ignore les états de révocation après le passage à `encrypted_only`. Conserver une seule réplique tant que la limitation de débit n’utilise pas Redis.

Avant le premier déploiement CRM, suivre `docs/CRM_ROLLOUT_RUNBOOK.md`. Le démarrage applique `db/crm-schema.sql`, puis reprend uniquement les commandes dont `customer_id` est encore vide. Une seconde exécution ne doit créer aucun doublon. Le rollback applicatif Railway ne supprime pas les tables ni les lignes CRM ; ne jamais tenter un rollback destructif automatique.

`npm run test:crm` refuse volontairement une URL d'application ou de base non locale. Il ne doit pas être contourné pour tester la production : utiliser un contrôle public en lecture et des données déjà autorisées après déploiement.

Le test navigateur hors connexion requiert Playwright et Chrome. Dans l'environnement Codex local :

```powershell
$env:NODE_PATH='C:\Users\Saturnin001\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node scripts/driver-offline-browser-test.js
```

Le contrôle visuel mobile du manifeste de tournée utilise le même environnement :

```powershell
$env:RUN_BROWSER_TEST='1'
$env:NODE_PATH='C:\Users\Saturnin001\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:CHROME_EXECUTABLE='C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:runs
```

Le contrôle de la carte d'exploitation utilise les mêmes variables Playwright avec `npm run test:map`. Les fonds de carte facultatifs sont décrits dans `docs/OPERATIONS_MAP.md`. En l'absence de fournisseur satellite autorisé, ne pas ajouter d'URL de tuiles récupérée dans une application tierce.

Le contrôle navigateur du suivi client est inclus dans `npm run test:smoke` lorsque `RUN_BROWSER_TEST=1`. Il vérifie notamment le mobile, le consentement de géolocalisation locale, l'absence de fuite du token par référent et le masquage de la position avant départ.

Le routage doit rester configuré avec `ROUTING_PROVIDER=disabled` jusqu'à ce qu'une instance OSRM privée, son profil moto et la version de ses données cartographiques aient passé le banc décrit dans `docs/MAPS_AND_ROUTING_PLAN.md`. Ne jamais utiliser le serveur public de démonstration OSRM comme dépendance de production. Une activation exige aussi `ROUTING_OSRM_URL`, `ROUTING_OSRM_PROFILE`, `ROUTING_MAP_DATA_VERSION` et `ROUTING_PROVIDER_VERSION`.

Exécuter les scénarios fonctionnels l'un après l'autre. Ils créent des données temporaires identifiables dans la base `delivery` et les suppriment dans un bloc de nettoyage final.

## Restaurer la compréhension du système

Lire dans cet ordre :

1. `docs/README.md`
2. `docs/PRODUCT_WORKFLOW.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATA_MODEL.md`
5. `docs/DELIVERY_RUNS.md`
6. `docs/OPERATIONS_MAP.md`
7. `docs/ROUTING_ADAPTER.md`
8. `docs/ROUTING_AND_PUBLIC_MAP_REVIEW.md`
9. `docs/TRACKING_LINK_MIGRATION_RUNBOOK.md`
10. `docs/CRM_IMPLEMENTATION_SPEC.md`
11. `docs/CRM_ROLLOUT_RUNBOOK.md`
12. `docs/AI_TEAM_WORKSTREAMS.md`
13. `docs/TRACKING_LINK_SECURITY_REVIEW.md`
14. `docs/OFFLINE_OPERATIONS.md`
15. `server.js`
16. `public/app.js`
17. `public/request.html`

## Secrets

Les secrets sont uniquement dans Railway Variables. En cas de fuite : faire tourner le secret, redéployer les services dépendants et vérifier n8n.
