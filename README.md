# Suivi livraison — SaaS métier en construction

Application multi-entreprises de préparation et de suivi des livraisons, reliée à Traccar pour la géolocalisation.

## Espaces

- `/app` : espace de gestion de l'entreprise ;
- `/admin` : administration de la plateforme, séparée des entreprises ;
- `/driver` : espace mobile d'un livreur invité, limité à ses commandes affectées ;
- `/demande/:token` : collecte des informations du destinataire ;
- `/suivi/:token` : suivi public d'une commande, limité à ce client.

## Prérequis

- Node.js 18+ ;
- une base **PostgreSQL** accessible (locale ou hébergée) dont l’URL va dans `DATABASE_URL` ;
- un compte **Traccar** pour la géolocalisation (optionnel pour démarrer ; la carte reste vide sans lui).

## Démarrage

```bash
npm install
cp .env.example .env      # puis remplir DATABASE_URL, ADMIN_USER/PASSWORD, PLATFORM_ADMIN_*, secrets
npm start
```

Au premier démarrage, le serveur **crée et met à jour le schéma automatiquement** (migrations idempotentes exécutées au boot) et amorce l’entreprise et les comptes de démonstration à partir des variables `ADMIN_*` / `PLATFORM_ADMIN_*`. Aucune commande de migration séparée n’est nécessaire.

Puis ouvrir l’espace entreprise :

```text
http://localhost:3000/app/login
```

## Tests

```bash
npm run test:syntax   # vérifie la syntaxe de tout le code (rapide, sans base)
npm run test:runs     # scénarios tournées (nécessite un serveur lancé + DATABASE_URL + ADMIN_*)
npm run test:routing  # adaptateur de routage OSRM (unitaire, sans réseau)
```

Les scénarios `test:*` de bout en bout attendent l’application démarrée et une base joignable (voir `SMOKE_BASE_URL`, par défaut `http://127.0.0.1:3000`). `docs/TEST_PLAN.md` détaille la stratégie de test.

## Architecture et documentation

Le code métier tient dans `server.js` (API Express + migrations au boot), le front dans `public/` (`app.js`, `app.css`), et les briques réutilisables dans `lib/`. Le dossier `docs/` documente le modèle de données, la machine à états des commandes, les tournées, le routage, la facturation et les runbooks d’exploitation — commencer par `docs/ARCHITECTURE.md`.

Le lien de démonstration n’existe que si `DEMO_TRACKING_ENABLED=true` et si un jeton local explicite est fourni. Ce mode est refusé en production Railway.

Le serveur utilise un compte Traccar côté serveur pour récupérer la dernière position. Les identifiants Traccar ne sont jamais envoyés au navigateur.

La base `delivery` reste la source de vérité métier. Traccar reste la source de vérité GPS.

Les liens clients expirent, peuvent être renouvelés ou révoqués, et ne sont plus exposés dans les listes courantes. Leur secret est chiffré pour l’affichage explicite et leur recherche publique utilise une empreinte. La procédure de migration et de retour arrière est décrite dans `docs/TRACKING_LINK_MIGRATION_RUNBOOK.md`.
