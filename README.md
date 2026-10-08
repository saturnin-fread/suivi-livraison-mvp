# Suivi livraison — SaaS métier en construction

Application multi-entreprises de préparation et de suivi des livraisons, reliée à Traccar pour la géolocalisation.

## Espaces

- `/app` : espace de gestion de l'entreprise ;
- `/admin` : administration de la plateforme, séparée des entreprises ;
- `/driver` : espace mobile d'un livreur invité, limité à ses commandes affectées ;
- `/demande/:token` : collecte des informations du destinataire ;
- `/suivi/:token` : suivi public d'une commande, limité à ce client.

## Prérequis

- Node.js 20+ (22 en CI) ;
- **PostgreSQL** 16 dont l’URL va dans `DATABASE_URL` ;
- Traccar, OSRM, géocodage : facultatifs pour démarrer (la fonction concernée se désactive d’elle-même).

## Démarrage

```bash
npm install
cp .env.example .env      # remplir au minimum la section « Indispensables » et les comptes amorcés
npm start
```

Au démarrage, le serveur :

1. affiche la **configuration** active et signale ce qui manque (noms des variables, jamais les valeurs) ;
2. applique les **migrations** de `server/migrations/` qui ne l’ont pas encore été ;
3. amorce l’entreprise et les comptes à partir de `ADMIN_*` / `PLATFORM_ADMIN_*`.

Puis ouvrir `http://localhost:3000/app/login`.

## Migrations de base de données

- Un fichier par évolution : `server/migrations/NNNN_description.sql` (numéro suivant, minuscules).
- Chaque fichier s’applique **une seule fois**, dans une transaction, et reste tracé dans `schema_migrations`.
- On **ne modifie jamais** une migration déjà en production : on en ajoute une nouvelle. Le serveur prévient si un fichier appliqué a changé.
- `0001_baseline.sql` et `0002_crm.sql` reprennent le schéma historique ; ils sont idempotents.

## Tests

```bash
cp .env.test.example .env.test     # base PostgreSQL dédiée aux tests
node scripts/test-all.js           # toute la régression (≈ 45 suites)
node scripts/test-all.js --list    # lister les suites
node scripts/test-all.js --only team,trash
npm run test:syntax                # syntaxe seule, sans base
```

Le lanceur démarre lui-même les faux services (GPS, itinéraires, lieux) et un serveur neuf avant chaque suite d’intégration. La même régression tourne sur GitHub à chaque pull request (`.github/workflows/ci.yml`) : **une PR rouge ne se fusionne pas**, puisque Railway déploie `main` automatiquement.

## Organisation du code

| Dossier | Contenu |
|---|---|
| `server.js` | démarrage, socle HTTP (sessions, rôles, e-mail) et domaines pas encore extraits |
| `server/modules/<domaine>/` | un domaine métier : `routes.js` (API) et `service.js` (logique, base) |
| `server/core/` | socle partagé : migrations, configuration |
| `server/migrations/` | schéma de la base, fichiers numérotés |
| `lib/` | briques réutilisables par plusieurs domaines (routage, CRM, exports…) |
| `public/` | interface web (une page = un module JS + CSS) |
| `scripts/` | tests, faux services, lanceur de régression |
| `docs/` | documentation technique et runbooks |

Modules extraits : `support`, `search`, `reports`. Chacun exporte une fonction
`register…(app, deps)` appelée par `server.js` à l’endroit où vivaient ses routes
(l’ordre des routes Express est donc inchangé). Ses dépendances sont **explicites** :
tout ce qu’il utilise du socle lui est passé dans `deps`, rien n’est global.
Pour ajouter un domaine (facturation, communauté…), créer un dossier sur ce modèle.

## Architecture et documentation

Le schéma vit dans `server/migrations/`, l’API dans `server.js` et `server/modules/`, le front dans `public/` (`app.js`, `app.css`), et les briques réutilisables dans `lib/`. Le dossier `docs/` documente le modèle de données, la machine à états des commandes, les tournées, le routage, la facturation et les runbooks d’exploitation — commencer par `docs/ARCHITECTURE.md`.

Le lien de démonstration n’existe que si `DEMO_TRACKING_ENABLED=true` et si un jeton local explicite est fourni. Ce mode est refusé en production Railway.

Le serveur utilise un compte Traccar côté serveur pour récupérer la dernière position. Les identifiants Traccar ne sont jamais envoyés au navigateur.

La base `delivery` reste la source de vérité métier. Traccar reste la source de vérité GPS.

Les liens clients expirent, peuvent être renouvelés ou révoqués, et ne sont plus exposés dans les listes courantes. Leur secret est chiffré pour l’affichage explicite et leur recherche publique utilise une empreinte. La procédure de migration et de retour arrière est décrite dans `docs/TRACKING_LINK_MIGRATION_RUNBOOK.md`.
