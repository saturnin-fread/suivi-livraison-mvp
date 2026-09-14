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

## Accès aux interfaces

```text
/app/login   espace de connexion d'une entreprise
/app         opérations quotidiennes de l'entreprise
/admin/login administration de la plateforme uniquement
```

`ADMIN_USER` et `ADMIN_PASSWORD` initialisent le propriétaire de l'entreprise de démonstration. `PLATFORM_ADMIN_USER` et `PLATFORM_ADMIN_PASSWORD` sont distincts et réservés à l'équipe qui exploite le SaaS.

## Redéployer

Depuis le dossier `suivi-livraison-mvp` :

```powershell
railway up --service delivery-app --environment production
```

## Restaurer la compréhension du système

Lire dans cet ordre :

1. `docs/README.md`
2. `docs/PRODUCT_WORKFLOW.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DATA_MODEL.md`
5. `server.js`
6. `public/admin.html`
7. `public/request.html`

## Secrets

Les secrets sont uniquement dans Railway Variables. En cas de fuite : faire tourner le secret, redéployer les services dépendants et vérifier n8n.
