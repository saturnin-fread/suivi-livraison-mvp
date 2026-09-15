# Runbook — Isolation infrastructure (Postgres et Redis dédiés)

Objectif : sortir les données du projet livraison du Postgres partagé avec n8n,
et préparer un Redis dédié pour la limitation d'abus. Chaque service livraison
devient indépendant (rayon d'impact, sauvegardes, rétention et rôles séparés).

> Ce runbook décrit une opération **impactante sur le pilote en production**.
> Il se lit et s'exécute étape par étape. Aucune étape destructive n'est lancée
> sans validation explicite. L'ancienne base n'est jamais supprimée pendant la
> bascule : elle reste le filet de sécurité tant que la nouvelle n'est pas
> confirmée.

## Statut

- **Postgres : bascule effectuée le 2026-09-15.** `delivery-app` tourne sur le
  Postgres dédié (`Postgres-L9xy`), base `delivery`, via `DATABASE_URL` composé
  par variables de référence :
  `postgresql://${{Postgres-L9xy.PGUSER}}:${{Postgres-L9xy.PGPASSWORD}}@${{Postgres-L9xy.RAILWAY_PRIVATE_DOMAIN}}:5432/delivery`.
  Volumétries source/cible identiques (companies 6, orders 2, drivers 6,
  customer_requests 7, users 1, tracking_links 2, delivery_runs 1,
  payment_events 14). Connexion `/app` et données confirmées côté navigateur.
  Ancienne valeur, pour rollback :
  `postgresql://postgres:<ancien-mdp>@postgres.railway.internal:5432/delivery`.
- **Reste à faire :** retirer le proxy TCP temporaire du nouveau Postgres ;
  purger, après vérification qu'aucun workflow n8n ne les lit, les tables
  livraison orphelines présentes dans la base `railway` de n8n ; brancher le
  Redis dédié quand on passera à plusieurs répliques.

## Décision

- 2026-09-15 — Isolation des services de données du projet livraison.
  Le Postgres et le Redis utilisés par n8n ne sont plus partagés avec
  `delivery-app`. Deux services dédiés sont provisionnés. La bascule Postgres
  se fait par `pg_dump`/restore car le pilote contient des données à conserver.

## Inventaire Railway

Projet `enthusiastic-playfulness` — environnement `production`.

| Rôle | Nom Railway | Service ID | Image | Réseau |
|---|---|---|---|---|
| App métier | `delivery-app` | `4812fcf8-40a5-4692-8af9-3a174fc71ce6` | (déploiement CLI) | domaine public |
| **Ancien** Postgres (partagé n8n) | `Postgres` | `c75aa5bc-421b-4938-9a39-c96c5d2bc7c8` | postgres-ssl:16 | proxy TCP 5432 (`DATABASE_PUBLIC_URL`) |
| **Nouveau** Postgres dédié | `Postgres-L9xy` | `2137fc88-8ca3-4579-9188-cc60f58d44eb` | postgres-ssl:18 | interne seul (proxy à créer pour la migration) |
| Ancien Redis (partagé n8n) | `Redis` | `23fe758a-45fd-43ec-a855-db2acbc272b6` | railwayapp/redis | proxy TCP 6379 |
| **Nouveau** Redis dédié | `Redis-sPlS` | `f2b1ccd9-4e99-4be0-9e4e-640facf86f80` | redis:8.2 | interne seul |

> Les noms `Postgres-L9xy` / `Redis-sPlS` sont auto-générés (le renommage via API
> n'est pas supporté ; renommer dans le dashboard si souhaité — sans impact
> technique). Les IDs restent la référence stable.

## Contrainte outillage

- La connexion Railway de l'assistant ne lit **que les noms** de variables, pas
  leurs valeurs. Les étapes qui manipulent une chaîne de connexion (dump,
  restore) sont donc **exécutées par l'humain** via `railway` CLI + `psql`.
- Le nouveau Postgres est en **v18**, l'ancien en **v16**. Utiliser des outils
  client **PostgreSQL 18** (`pg_dump`, `psql`) : ils lisent une source v16 et
  écrivent dans une cible v18 sans problème. L'inverse (client v16 vers serveur
  v18) n'est pas garanti.

## Pré-requis locaux

```bash
# Outils client PostgreSQL 18
psql --version   # doit afficher 18.x
pg_dump --version

# Railway CLI authentifié et lié au projet/environnement
railway login
railway link --project df74a90c-9f57-4f81-b440-5cf819e813e3 --environment production
```

## Phase A — Récupérer les deux chaînes de connexion publiques

La migration se lance depuis ta machine : les deux bases doivent être joignables
en **public** (les hôtes `*.railway.internal` ne résolvent qu'à l'intérieur de
Railway).

1. **Ancien Postgres** — a déjà un proxy TCP public. Récupère son URL publique :

   ```bash
   railway variables --service Postgres | grep DATABASE_PUBLIC_URL
   ```

   Note-la comme `SOURCE_URL` (base `delivery`). Si la valeur pointe vers la base
   `railway` et non `delivery`, remplace le nom de base en fin d'URL par
   `delivery`, ou vérifie le nom réel avec `\l` une fois connecté.

2. **Nouveau Postgres** — pas encore de proxy public. Demande à l'assistant de
   créer un **proxy TCP temporaire** sur `Postgres-L9xy` (réversible), puis :

   ```bash
   railway variables --service Postgres-L9xy | grep DATABASE_PUBLIC_URL
   ```

   Note-la comme `TARGET_URL` (base par défaut `railway`).

> Ne colle jamais `SOURCE_URL`/`TARGET_URL` dans un chat ou un commit : ce sont
> des secrets. Garde-les dans des variables shell locales.

## Phase B — Sauvegarde de sécurité (obligatoire)

```bash
# Dump horodaté complet de la base source, gardé hors dépôt
pg_dump "$SOURCE_URL" --no-owner --no-privileges --format=custom \
  --file="delivery-$(date +%Y%m%d-%H%M%S).dump"
```

Vérifie que le fichier n'est pas vide (`ls -lh`). C'est ta restauration de repli.

## Phase C — Restauration dans le Postgres dédié

Le schéma se recrée seul au démarrage de l'app, mais ici on migre **données +
schéma existants** pour préserver le pilote. On restaure dans la base par défaut
`railway` du nouveau service (permet d'utiliser ensuite la variable de référence
propre `${{Postgres-L9xy.DATABASE_URL}}`).

```bash
# Restauration depuis le dump custom, sans propriétaires/ACL (rôles différents)
pg_restore --no-owner --no-privileges --no-acl \
  --dbname "$TARGET_URL" \
  "delivery-YYYYMMDD-HHMMSS.dump"
```

Quelques `WARNING`/`ERROR` sur des `COMMENT`/extensions absentes sont tolérables ;
une erreur sur une table ou une contrainte ne l'est pas → stopper et diagnostiquer.

## Phase D — Vérification avant bascule

Compare les volumétries source vs cible sur les tables clés :

```bash
for URL in "$SOURCE_URL" "$TARGET_URL"; do
  echo "== $URL =="
  psql "$URL" -c "
    SELECT 'companies'  AS t, count(*) FROM companies
    UNION ALL SELECT 'users',            count(*) FROM users
    UNION ALL SELECT 'orders',           count(*) FROM orders
    UNION ALL SELECT 'customer_requests',count(*) FROM customer_requests
    UNION ALL SELECT 'drivers',          count(*) FROM drivers
    UNION ALL SELECT 'tracking_links',   count(*) FROM tracking_links
    UNION ALL SELECT 'delivery_runs',    count(*) FROM delivery_runs
    UNION ALL SELECT 'payment_events',   count(*) FROM payment_events
    ORDER BY t;"
done
```

Les comp* doivent correspondre. Vérifie aussi que les séquences ont suivi :

```bash
psql "$TARGET_URL" -c "SELECT max(id) FROM orders;"
psql "$TARGET_URL" -c "SELECT nextval(pg_get_serial_sequence('orders','id'));"
# nextval doit être > max(id). pg_restore réaligne les séquences ; sinon :
#   SELECT setval(pg_get_serial_sequence('orders','id'), (SELECT max(id) FROM orders));
```

## Phase E — Bascule de `delivery-app`

Fenêtre de bascule courte. Idéalement, mettre l'app en pause écriture ou
prévenir qu'une brève coupure peut survenir.

1. L'assistant pointe `DATABASE_URL` de `delivery-app` vers le nouveau service
   par **variable de référence** (pas de secret en clair) :

   ```
   DATABASE_URL = ${{Postgres-L9xy.DATABASE_URL}}
   ```

   Railway redéploie `delivery-app` automatiquement.

2. Au démarrage, l'app rejoue ses migrations idempotentes (`CREATE TABLE IF NOT
   EXISTS`, `ALTER ... ADD COLUMN IF NOT EXISTS`) sur les données restaurées :
   aucune perte, seulement l'alignement du schéma.

3. Contrôles post-bascule :
   - logs de `delivery-app` sans erreur de connexion ni de migration ;
   - connexion `/app/login` avec un compte existant ;
   - une commande et un lien de suivi connus s'affichent correctement ;
   - une écriture (nouvelle demande de test) fonctionne.

## Phase F — Nettoyage

- Supprimer le **proxy TCP temporaire** du nouveau Postgres (réduire l'exposition)
  — sauf si un accès public volontaire est souhaité pour l'exploitation.
- Conserver l'ancienne base `delivery` **intacte** plusieurs jours (repli), puis,
  après confirmation, purger uniquement les tables du projet livraison qui y
  restaient (ne jamais toucher aux tables n8n de ce serveur partagé).
- Garder le dump `delivery-*.dump` hors dépôt, chiffré ou dans un stockage sûr.

## Rollback

Tant que l'ancienne base n'est pas purgée, revenir en arrière consiste à
repointer `DATABASE_URL` de `delivery-app` vers l'ancienne valeur (variable de
référence `${{Postgres.DATABASE_URL}}` ou l'URL d'origine) et redéployer. Les
écritures effectuées sur la nouvelle base pendant la fenêtre seraient alors
perdues : d'où l'intérêt d'une fenêtre courte et annoncée.

## Redis dédié (préparation, sans bascule immédiate)

`delivery-app` n'utilise pas encore Redis. Le câblage se fera avec la migration
du rate-limiting (voir `docs/RATE_LIMITING.md` et la tâche dédiée). Variable
cible prévue :

```
REDIS_URL = ${{Redis-sPlS.REDIS_URL}}
```

Aucune donnée à migrer côté Redis : le token bucket est actuellement en mémoire
de processus. Le passage à Redis est un changement de code, pas une migration.
