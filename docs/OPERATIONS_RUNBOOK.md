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
npm run test:smoke
npm run test:driver
```

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

Exécuter les scénarios fonctionnels l'un après l'autre. Ils créent des données temporaires identifiables dans la base `delivery` et les suppriment dans un bloc de nettoyage final.

## Restaurer la compréhension du système

Lire dans cet ordre :

1. `docs/README.md`
2. `docs/PRODUCT_WORKFLOW.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATA_MODEL.md`
5. `docs/DELIVERY_RUNS.md`
6. `docs/OFFLINE_OPERATIONS.md`
7. `server.js`
8. `public/app.js`
9. `public/request.html`

## Secrets

Les secrets sont uniquement dans Railway Variables. En cas de fuite : faire tourner le secret, redéployer les services dépendants et vérifier n8n.
