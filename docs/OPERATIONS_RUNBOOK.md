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
npm run test:runs
npm run test:smoke
npm run test:driver
```

Exécuter les trois scénarios fonctionnels l'un après l'autre. Ils créent des données temporaires identifiables dans la base `delivery` et les suppriment dans un bloc de nettoyage final.

## Restaurer la compréhension du système

Lire dans cet ordre :

1. `docs/README.md`
2. `docs/PRODUCT_WORKFLOW.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATA_MODEL.md`
5. `docs/DELIVERY_RUNS.md`
6. `server.js`
7. `public/app.js`
8. `public/request.html`

## Secrets

Les secrets sont uniquement dans Railway Variables. En cas de fuite : faire tourner le secret, redéployer les services dépendants et vérifier n8n.
