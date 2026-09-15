# Spécification — export CRM Excel et confidentialité

Statut : contrat de référence, lot équipe D  
Version : 1.0.0  
Périmètre : SaaS multi-entreprises de livraison, Bénin  
Format : `.xlsx` uniquement

## 1. Décisions retenues

1. Un export appartient à **une seule entreprise**, un utilisateur, un rôle et une période bornée. Le serveur ne doit jamais accepter un `company_id` libre sans le confronter à l’entreprise de la session.
2. Les droits suivent le moindre privilège :
   - `owner` et `manager` : exports de gestion autorisés ;
   - `operator` : opérations uniquement, sur 31 jours maximum ;
   - `driver` : aucun export en masse.
3. La période est obligatoire, exprimée en dates `AAAA-MM-JJ`, avec début inclus et fin exclue, dans le fuseau `Africa/Porto-Novo`.
4. Les exports standards ne contiennent **jamais** l’historique GPS détaillé, les coordonnées latitude/longitude, la géométrie d’itinéraire ni les identifiants techniques Traccar.
5. Les colonnes et filtres sont déterminés côté serveur par un profil versionné. Le navigateur ne peut pas envoyer une liste arbitraire de champs SQL.
6. Les données textuelles non fiables sont écrites comme du texte XLSX, jamais comme des formules. Une neutralisation visible est appliquée aux préfixes de formule dangereux.
7. Aucun dépassement n’est tronqué silencieusement : le serveur refuse l’export et demande de réduire la période ou les filtres.
8. Le fichier expire après 24 heures. Une autorisation de téléchargement est nominative, liée à l’entreprise et valable 5 minutes.
9. Deux empreintes SHA-256 sont conservées : une pour la demande canonique et une pour les octets exacts du fichier final.
10. Le fichier n’est jamais placé dans `public/`, envoyé en pièce jointe ni rendu accessible par une URL permanente.

Ces règles appliquent la minimisation et la limitation de conservation recommandées par l’APDP. Une validation juridique locale reste requise avant mise en production, notamment pour les finalités, durées d’audit et demandes de droits.

## 2. Profils et colonnes minimales

Les identifiants affichés sont des références métier. Les clés internes, secrets, jetons et identifiants Traccar ne sont jamais exportés.

### `operations`

Rôles : `owner`, `manager`, `operator`.

Colonnes par défaut :

- `order_id`
- `created_at`
- `requested_window`
- `status`
- `destination_zone`
- `driver_reference`
- `run_reference`
- `delivered_at`
- `delivery_duration_minutes`
- `payment_status`
- `incident_count`

### `customers`

Rôles : `owner`, `manager`.

Colonnes par défaut :

- `customer_reference`
- `destination_zone`
- `order_count`
- `completed_order_count`
- `last_order_at`

### `payments`

Rôles : `owner`, `manager`.

Colonnes par défaut :

- `order_id`
- `currency`
- `expected_amount_minor`
- `collected_amount_minor`
- `adjusted_amount_minor`
- `payment_status`
- `payment_method`
- `collected_at`
- `reconciled_at`

Les montants restent des entiers dans l’unité monétaire mineure et la devise est toujours explicite. Aucun numéro de compte ou portefeuille mobile n’est inclus.

### `incidents`

Rôles : `owner`, `manager`.

Colonnes par défaut :

- `incident_id`
- `order_id`
- `category`
- `severity`
- `status`
- `opened_at`
- `resolved_at`
- `resolution_code`

Les commentaires libres, preuves, photos et signatures sont exclus du profil standard.

### `drivers_summary`

Rôles : `owner`, `manager`.

Colonnes par défaut :

- `driver_reference`
- `driver_name`
- `vehicle_type`
- `assigned_order_count`
- `completed_order_count`
- `returned_order_count`
- `incident_count`
- `active_delivery_minutes`

Ce profil fournit des agrégats de travail, pas le trajet détaillé du livreur.

### Données sensibles facultatives

Un `owner` ou `manager` peut demander les seules colonnes sensibles prévues par le profil : nom, téléphone, adresse ou instructions de livraison selon le jeu de données. Cette demande exige :

- un motif métier explicite d’au moins 10 caractères ;
- une nouvelle vérification du rôle au téléchargement ;
- une trace d’audit de la liste exacte des colonnes ;
- la même expiration de 24 heures.

L’opérateur ne reçoit jamais ces colonnes dans un export en masse. Le GPS détaillé reste interdit, même avec ce mécanisme. Un éventuel export GPS futur devra être un produit séparé, soumis à une finalité précise, une approbation renforcée et une durée plus courte.

## 3. Contrat de demande

Contrat logique prévu pour un futur endpoint `POST /api/crm/exports` :

```json
{
  "dataset": "operations",
  "period": {
    "from": "2026-08-01",
    "to": "2026-09-01"
  },
  "filters": {
    "status": ["delivered", "returned"]
  },
  "sensitiveColumns": [],
  "purpose": "Pilotage mensuel des livraisons"
}
```

Le client **ne fournit pas** `companyId`, `actorId`, `role`, `requestedAt`, `expiresAt` ni les empreintes. Le serveur les injecte depuis la session et son horloge. La bibliothèque de contrat les exige parce qu’elle représente l’objet serveur déjà enrichi.

Réponse asynchrone recommandée :

```json
{
  "exportId": "exp_opaque",
  "status": "requested",
  "requestFingerprintSha256": "64_caracteres_hexadecimaux",
  "expiresAt": "2026-09-16T10:00:00.000Z"
}
```

Consultation : `GET /api/crm/exports/:exportId`.  
Téléchargement : `POST /api/crm/exports/:exportId/download-grant`, puis URL opaque à usage limité.  
Annulation : `POST /api/crm/exports/:exportId/cancel` tant que le statut le permet.

À chaque lecture ou téléchargement, le serveur vérifie de nouveau : session active, appartenance à l’entreprise, rôle suffisant, propriétaire logique de l’export et non-expiration. Le contrôle `company_id` doit exister dans toutes les sources et jointures ; une défense supplémentaire par Row-Level Security PostgreSQL est recommandée lors d’un lot base de données dédié.

## 4. Construction sûre du XLSX

Le futur générateur doit produire un paquet Office Open XML conforme et respecter ces invariants :

- extension `.xlsx`, type MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` ;
- valeurs provenant d’un utilisateur écrites en `shared string` ou `inlineStr` ;
- aucun élément SpreadsheetML de formule `<f>` pour ces valeurs ;
- aucune macro, relation externe, connexion de données, DDE, objet incorporé, nom défini ou feuille cachée ;
- aucun hyperlien actif ; une URL ou un téléphone est une simple chaîne de texte ;
- en-têtes stables issus du contrat, première ligne figée et filtre visuel autorisé ;
- horodatages exportés en ISO 8601 avec indication du fuseau dans une feuille visible `_Informations` ;
- valeurs numériques métier écrites comme nombres uniquement lorsqu’elles proviennent de champs typés et validés ;
- toutes les feuilles visibles ;
- `_Informations` indique l’entreprise, l’export, la période, les filtres, le fuseau, la version du contrat, la date de génération et l’empreinte de demande ;
- l’empreinte du fichier n’est pas inscrite dans le fichier lui-même, afin d’éviter une dépendance circulaire.

### Neutralisation des formules

Avant l’écriture, toute chaîne commençant par `=`, `+`, `-`, `@`, tabulation, retour chariot, saut de ligne ou leurs variantes pleine largeur est préfixée par une apostrophe. La détection tient compte d’un BOM et des espaces/contrôles placés avant le caractère. Cette défense s’ajoute au typage texte XLSX ; elle ne le remplace pas.

Une cellule contenant NUL ou dépassant 32 767 caractères est refusée. Les données ne sont pas raccourcies en silence. Les champs libres longs ne font de toute façon pas partie des profils par défaut.

## 5. Limites de volume

Limites opérationnelles du produit :

| Limite | Valeur |
|---|---:|
| Lignes de données par feuille | 50 000 |
| Lignes de données par classeur | 100 000 |
| Feuilles par classeur | 8 |
| Colonnes par feuille | 30 |
| Taille finale estimée/autorisée | 50 Mio |
| Période `operator` | 31 jours |
| Période `owner`/`manager` | 366 jours |

Ces seuils sont volontairement inférieurs aux limites techniques d’Excel. Ils protègent la mémoire du serveur et les téléphones/ordinateurs modestes. Un dépassement retourne `EXPORT_TOO_LARGE` avec la recommandation de réduire période ou filtres. Le découpage automatique en plusieurs archives n’est pas retenu en V1 : il complique la traçabilité et augmente les copies de données personnelles.

Le comptage doit précéder la génération. La génération future devra être asynchrone, en flux, avec une limite de concurrence par entreprise et une limite globale de travailleurs. Aucun fichier partiel n’est publié.

## 6. Audit, empreintes et cycle de vie

États autorisés :

```text
requested -> generating -> ready -> downloaded
    |            |           |
    +----------> failed      +-> expired
    +----------> cancelled
```

Les événements d’audit sont ajoutés sans réécriture et contiennent au minimum :

- `export_id`, `company_id`, `actor_user_id`, rôle ;
- jeu de données, période, filtres, motif et colonnes ;
- version du contrat et empreinte SHA-256 de la demande ;
- statut, dates de demande, fin, téléchargement, expiration et suppression ;
- nombre de lignes, feuilles, octets ;
- empreinte SHA-256 des octets du fichier final ;
- code d’échec technique, sans contenu métier ni trace complète d’exception.

L’audit ne contient jamais les lignes exportées, les positions GPS, le jeton de téléchargement ni un chemin de stockage public. Les accès de téléchargement peuvent conserver une empreinte réduite de l’adresse IP et un agent utilisateur tronqué si cette collecte est documentée et justifiée ; ils ne sont pas obligatoires pour le contrat V1.

L’empreinte de demande porte sur une sérialisation JSON canonique comprenant entreprise, acteur, rôle, jeu de données, période, filtres, colonnes, motif, version et mode de confidentialité. Deux demandes identiques produisent la même empreinte. L’empreinte du fichier porte sur ses octets exacts après fermeture du paquet XLSX.

Le fichier est supprimé au plus tard 24 heures après la demande, qu’il ait été téléchargé ou non. Les métadonnées d’audit suivent une politique de conservation distincte à faire valider par l’entreprise et le conseil juridique ; elles ne prolongent pas la conservation du fichier.

## 7. Cas d’erreur stables

| Code | HTTP futur | Effet utilisateur |
|---|---:|---|
| `INVALID_REQUEST` | 400 | Corriger la demande. |
| `INVALID_PERIOD` | 400 | Choisir une période valide et bornée. |
| `PERIOD_TOO_LARGE` | 422 | Réduire la période. |
| `UNKNOWN_DATASET` | 400 | Profil non pris en charge. |
| `FORBIDDEN_EXPORT` | 403 | Rôle insuffisant. |
| `FORBIDDEN_SENSITIVE_EXPORT` | 403 | Données sensibles refusées pour ce rôle. |
| `PURPOSE_REQUIRED` | 422 | Fournir un motif métier explicite. |
| `FORBIDDEN_COLUMN` | 403 | Colonne non prévue par le profil. |
| `FORBIDDEN_FILTER` | 403 | Filtre non prévu par le profil. |
| `GPS_DETAIL_FORBIDDEN` | 403 | Utiliser uniquement les agrégats autorisés. |
| `EXPORT_TOO_LARGE` | 413 | Réduire période ou filtres ; aucun tronquage. |
| `CELL_TOO_LONG` | 422 | Corriger la donnée source. |
| `CELL_CONTAINS_NUL` | 422 | Corriger la donnée source. |
| `EXPORT_EXPIRED` | 410 | Relancer un nouvel export. |
| `EXPORT_NOT_READY` | 409 | Attendre la fin de génération. |
| `TENANT_SCOPE_MISMATCH` | 404 | Ne rien révéler sur une autre entreprise. |
| `GENERATION_FAILED` | 500 | Échec audité, fichier partiel détruit. |

Une ressource appartenant à une autre entreprise retourne `404` et non `403`, afin de ne pas confirmer son existence.

## 8. Tests requis avant intégration

Le test autonome `scripts/crm-export-contract-test.js` vérifie sans réseau :

- matrice rôles/jeux de données ;
- entreprise, acteur et période obligatoires ;
- bornes de 31 et 366 jours, année bissextile comprise ;
- absence de colonnes GPS dans chaque profil ;
- contrôle des colonnes sensibles et du motif ;
- liste blanche des filtres, de leurs types et de leur taille ;
- neutralisation des préfixes de formule ASCII, contrôle et pleine largeur ;
- rejet NUL et cellule trop longue ;
- interdiction des fonctions actives du classeur ;
- sérialisation canonique et empreintes SHA-256 ;
- limites de volume et absence de tronquage ;
- expiration déterministe ;
- audit sans données brutes ni GPS.

Commande directe :

```powershell
node scripts/crm-export-contract-test.js
```

Tests d’intégration à ajouter avec le futur générateur, dans le lot qui sera explicitement autorisé :

1. ouvrir le XLSX généré comme paquet ZIP et confirmer l’absence de `<f>`, `externalLinks`, macros et relations externes ;
2. injecter des valeurs malveillantes dans chaque colonne textuelle et confirmer leur rendu inerte ;
3. créer deux entreprises contenant des références identiques et prouver l’absence de fuite croisée ;
4. révoquer le rôle après génération et refuser le téléchargement ;
5. supprimer automatiquement le fichier expiré et conserver seulement l’audit ;
6. simuler arrêt du processus, disque plein et stockage indisponible sans publier de fichier partiel ;
7. comparer l’empreinte téléchargée avec l’empreinte enregistrée ;
8. mesurer mémoire et durée aux limites 50 000/100 000 lignes.

## 9. Déclencheurs de révision

Réexaminer ce contrat si l’un de ces événements survient :

- ajout d’un rôle ou d’un jeu de données ;
- demande d’export GPS, preuve, photo, signature ou commentaire libre ;
- export supérieur à 100 000 lignes ou 50 Mio ;
- changement de la réglementation béninoise ou des prescriptions APDP ;
- stockage externe, envoi par courriel ou partage inter-entreprises ;
- ajout d’un générateur XLSX, d’une file de travaux ou de Row-Level Security ;
- export automatisé récurrent ou intégration avec un tiers.

## 10. Sources officielles et primaires

- [Secrétariat général du Gouvernement du Bénin — Loi n° 2017-20 portant Code du numérique](https://sgg.gouv.bj/doc/loi-2017-20/download)
- [Secrétariat général du Gouvernement du Bénin — Loi n° 2020-35 modifiant le Code du numérique](https://sgg.gouv.bj/recherche/?begin=&end=&keywords=Code+du+num%C3%A9rique&type=loi)
- [APDP Bénin — Guide de mise en conformité, minimisation et conservation](https://archive.apdp.bj/wp-content/uploads/2022/01/GUIDE-DE-MISE-EN-CONFORMITE_Pt_YD_revu.pdf)
- [Microsoft — Caractéristiques et limites d’Excel](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits)
- [Microsoft — Présentation des formules Excel](https://support.microsoft.com/en-US/Excel/get-started/overview-of-formulas-in-excel)
- [ECMA-376 — Office Open XML](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
- [OWASP — CSV/Formula Injection](https://community.owasp.org/attacks/CSV_Injection)
- [NIST FIPS 180-4 — Secure Hash Standard](https://csrc.nist.gov/pubs/fips/180-4/upd1/final)
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

## 11. Hors périmètre de ce lot

Ce lot ne génère pas encore de vrai fichier XLSX, ne crée pas d’endpoint, de table ou de tâche asynchrone et n’ajoute aucune dépendance. Il fixe le contrat vérifiable que ces futures briques devront respecter. Toute implantation devra faire l’objet d’un lot séparé avec fichiers autorisés explicitement.
