# Organisation des lots entre équipes IA

## But

Ce plan permet d’avancer en parallèle sans créer de versions incompatibles, de fuites inter-entreprises ni de déploiements concurrents. Les équipes produisent des lots bornés dans des fichiers disjoints ; l’intégrateur central reste seul responsable des fichiers partagés, des migrations ordonnées, des tests globaux et de Railway.

La vitesse vient du parallélisme de conception, de modules et de tests. Elle ne vient jamais de plusieurs équipes modifiant simultanément `server.js`, l’interface principale, la même table ou la production.

## Règles de fonctionnement

1. Chaque lot commence avec un contrat écrit : objectif, hors périmètre, entrées/sorties, fichiers réservés et critères d’acceptation.
2. Deux équipes ne reçoivent jamais le même fichier en écriture.
3. Les fichiers partagés sont réservés à l’intégrateur central.
4. Une équipe peut lire tout le dépôt, mais n’écrit que dans sa zone déclarée.
5. Chaque schéma ou API est additif et versionné ; aucune équipe ne détruit une donnée existante.
6. Les équipes n’utilisent ni secret de production, ni données personnelles réelles dans leurs tests.
7. Les recherches techniques s’appuient sur des sources officielles ou primaires et les décisions sont reliées à ces sources.
8. Aucun agent ne déploie, ne change une variable Railway, ne lance une migration de production ou ne restaure une sauvegarde.
9. Un seul déploiement coordonné est autorisé à la fois, après validation centrale.
10. Toute ambiguïté de propriété de fichier suspend l’écriture jusqu’à arbitrage central.

## Fichiers réservés à l’intégrateur central

Ces fichiers ne sont modifiés par aucune équipe de lot :

- `server.js` ;
- `public/app.js`, `public/app.css` et le shell de navigation partagé ;
- `package.json` et le fichier de verrouillage des dépendances ;
- `docs/README.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/ROADMAP.md`, `docs/CHANGELOG.md`, `docs/TEST_PLAN.md` et `docs/OPERATIONS_RUNBOOK.md` ;
- configuration Railway, variables, domaines, volumes et base de production.

Les équipes livrent des modules importables, des scripts autonomes, des migrations séparées et un manifeste d’intégration. L’intégrateur effectue ensuite les branchements minimaux dans les fichiers partagés.

## Dépendances globales

```text
Fondation multi-entreprise + authentification + audit
                    |
          +---------+----------+
          |                    |
         CRM                Dispatch
          |                    |
          +-------> Carte / ETA
          |
          +-------> Export Excel
          |
          +-------> WAHA / n8n
          |
          +-------> Facturation
                    |
              Sécurité / QA
                    |
              Documentation
                    |
          Validation et déploiement central
```

Sécurité/QA et Documentation suivent chaque lot dès sa conception, mais elles ne valident la version finale qu’une fois l’intégration centrale terminée.

## Matrice des équipes

| Équipe | Mission | Dépendances d’entrée | Zone d’écriture exclusive proposée | Livrable d’acceptation |
|---|---|---|---|---|
| CRM | clients, contacts, lieux, interactions, consentements, doublons assistés, métriques explicables | isolation entreprise, commandes/incidents/paiements | `db/crm-*.sql`, `lib/crm/**`, `routes/crm/**`, `scripts/crm-*`, `docs/CRM_*` hors docs centrales | migration réexécutable, API isolée, tests A/B, métriques recalculables |
| Dispatch | créneaux, service, capacité, propositions et confirmation humaine | commandes, livreurs, tournées ; routage fiable seulement s’il est qualifié | `lib/dispatch/**`, `routes/dispatch/**`, `scripts/dispatch-*`, `docs/DISPATCH_*` | aucun chevauchement/capacité contourné, conflit obsolète en `409`, aucune affectation automatique |
| Carte/ETA | couches cartographiques, routes, provenance, fraîcheur GPS, fourchettes ETA | carte existante, Traccar côté serveur, dispatch ; moteur routier qualifié | `lib/maps/**`, `lib/routing/**`, `routes/maps/**`, `public/maps/**`, `scripts/map-*`, `scripts/routing-*`, `docs/MAPS_*`, `docs/ROUTING_*` | aucune fuite d’autres clients, position ancienne signalée, ETA désactivable et jamais inventée |
| Export Excel | génération XLSX, file, stockage privé, téléchargement éphémère | CRM stable, rôles, audit, contrat `CRM_EXPORT_SECURITY_SPEC.md` | `lib/exports/**`, `routes/exports/**`, `db/export-*.sql`, `scripts/export-*`, `docs/EXPORT_*` | vrai XLSX inerte, mono-entreprise, bornes/quotas, suppression 24 h, empreintes vérifiées |
| WAHA/n8n | notifications transactionnelles, webhooks, reprise manuelle | états métier stabilisés, préférences CRM, modèles validés | `lib/integrations/waha/**`, `lib/integrations/n8n/**`, `routes/integrations/**`, `n8n/**`, `scripts/waha-*`, `docs/WAHA_*` | idempotence fournisseur, aucune source de vérité déplacée, erreurs/rejeu/audit testés |
| Facturation | offres, quotas, abonnement, suspension contrôlée, factures SaaS | entreprises/rôles stables, mesures d’usage fiables, audit | `lib/billing/**`, `routes/billing/**`, `db/billing-*.sql`, `scripts/billing-*`, `docs/BILLING_*` | calculs déterministes, idempotence paiement, grâce avant suspension, aucune perte de données |
| Sécurité/QA | menace, isolation, autorisation, concurrence, mobile, faible réseau, régression et charge | contrat de chaque équipe et version intégrée | `tests/security/**`, `tests/e2e/**`, `scripts/qa-*`, `docs/SECURITY_*`, `docs/QA_*` | preuves reproductibles, aucun secret/PII, scénarios négatifs et rapport de risque résiduel |
| Documentation/Reprise | runbooks, décisions, reprise, dictionnaires et procédures de transfert | livrables et résultats réels vérifiés | nouveaux `docs/*_RUNBOOK.md`, `docs/*_HANDOFF.md` explicitement attribués | une autre équipe peut reconstruire, tester, déployer et revenir sans mémoire orale |

Les chemins sont des réservations de principe. Avant chaque mission, l’intégrateur remplace les jokers par une liste exacte de fichiers autorisés. Si un chemin existe déjà hors de la zone annoncée, l’équipe propose un correctif sans l’appliquer.

## Lots et critères d’acceptation

### 1. CRM

Sous-lots ordonnés :

1. schéma idempotent et rôle PostgreSQL applicatif non-superutilisateur ;
2. lecture des clients et détails par entreprise ;
3. écritures avec idempotence, audit et concurrence ;
4. rapprochement historique sans fusion automatique ;
5. métriques versionnées et explicables ;
6. conservation, gels et demandes de confidentialité.

Acceptation : deux applications successives du schéma, anciennes données inchangées, contexte absent refusé, A ne voit jamais B, coordonnées précises absentes par défaut, chaque indicateur renvoie période/formule/qualité, et aucun score ne sanctionne un livreur.

### 2. Dispatch

Sous-lots : créneaux structurés, durée de service, capacité multidimensionnelle, réservations, propositions, confirmation humaine, puis persistance transactionnelle.

Acceptation : fuseau `Africa/Porto-Novo`, intervalles `[début, fin)`, charge et capacité explicites, proposition obsolète refusée, écriture atomique, motif d’exception, audit et aucune promesse d’ETA sans matrice routière qualifiée.

### 3. Carte et ETA

Sous-lots : contrôles carte et fraîcheur, visibilité client, carte exploitation, adaptateur routier, banc terrain Bénin, ETA interne, puis éventuelle fourchette publique.

Acceptation :

- le client reçoit uniquement son colis, sa destination et la position autorisée du livreur ;
- l’entreprise voit seulement sa flotte ;
- position réelle, route planifiée et ligne indicative sont distinctes ;
- fournisseur, profil, version des données, heure et confiance sont conservés ;
- panne du fournisseur dégrade l’affichage sans bloquer l’opération ;
- satellite absent tant qu’un fournisseur et ses droits ne sont pas validés ;
- aucune ETA publique avant résultats terrain acceptés.

### 4. Export Excel

Le contrat existant n’est pas le générateur. Le lot doit encore construire la tâche asynchrone, le classeur, le stockage privé, l’autorisation courte et l’effacement.

Acceptation :

- `.xlsx` réel et ouvrable, toutes feuilles visibles ;
- aucune formule `<f>`, macro, connexion, relation externe, hyperlien actif ou feuille cachée ;
- chaînes non fiables écrites comme texte et neutralisées ;
- aucune latitude/longitude ou historique GPS dans un profil standard ;
- période, rôle, entreprise, limite de volume et colonnes revérifiés côté serveur ;
- fichier partiel jamais publié, fichier final supprimé sous 24 heures ;
- accès révoqué si le rôle change ;
- empreinte téléchargée identique à l’audit.

### 5. WAHA/n8n

Sous-lots : modèles transactionnels, envoi de formulaire, demande de précision, confirmation, approche du livreur, réponses entrantes et reprise manuelle.

Acceptation : événement métier en source, clé d’idempotence de bout en bout, signature/authentification webhook, validation de schéma, limite de débit, temporisation et file d’échec, aucune donnée métier corrigée directement dans n8n, préférences respectées et téléphone normalisé sans apparaître dans les logs.

### 6. Facturation

Sous-lots : catalogue d’offres, période d’essai, compteurs d’usage, abonnement, facture, paiement, grâce, restriction puis reprise.

Acceptation : événements de paiement idempotents, montants/devise exacts, quotas expliqués, aucune suppression lors d’une suspension, accès lecture/export selon politique, reprise après paiement, séparation stricte entre administration plateforme et espace entreprise, et audit des changements de forfait.

### 7. Sécurité/QA

Cette équipe intervient à deux moments : revue du contrat avant code, puis test indépendant après intégration.

Acceptation minimale transversale :

- matrice rôles/routes/actions ;
- deux entreprises avec références identiques ;
- accès direct à un identifiant étranger ;
- concurrence et rejouabilité ;
- erreurs réseau, fournisseur et base ;
- mobile et faible connectivité ;
- limites de débit et volume ;
- absence de secrets/PII dans logs, erreurs et exports ;
- tests de restauration et rollback ;
- rapport des risques résiduels avec décision explicite.

### 8. Documentation/Reprise

Chaque lot produit : décision, état réel, configuration sans secrets, modèle de données, procédures d’essai, déploiement, rollback, observabilité, incidents connus et hors périmètre.

Acceptation : un nouvel opérateur peut installer sur une copie, identifier les sources de vérité, exécuter les tests, comprendre les portes d’activation et revenir au dernier état sain sans conversation historique.

## Protocole de remise de chaque équipe

Chaque équipe remet un manifeste court :

```text
Lot et version :
Commit ou état de départ :
Fichiers créés :
Fichiers modifiés :
Fichiers volontairement non touchés :
Contrat d’entrée/sortie :
Migration ou variable proposée :
Tests exécutés et résultats :
Cas non couverts :
Risques et retour arrière :
Sources officielles :
Actions réservées à l’intégrateur :
```

Une remise sans liste exacte de fichiers et résultats déterministes n’entre pas en intégration.

## Validation centrale

L’intégrateur effectue dans cet ordre :

1. vérifier que chaque équipe a respecté sa zone et qu’aucun secret n’est présent ;
2. relire les contrats et résoudre les divergences de noms, états, rôles et codes d’erreur ;
3. intégrer un seul lot à la fois dans les fichiers partagés ;
4. appliquer les migrations dans leur ordre sur une copie restaurée ;
5. exécuter tests unitaires, intégration, isolation, concurrence, navigateur mobile et régressions ;
6. faire contrôler Sécurité/QA sur la version **intégrée**, pas seulement sur les modules isolés ;
7. mettre à jour les documents centraux ;
8. créer une sauvegarde et une preuve de restauration ;
9. déployer une seule version candidate ;
10. franchir progressivement les portes d’activation avec observation et possibilité d’arrêt.

Un test réussi dans la branche d’une équipe ne vaut pas validation du produit. Seule la version assemblée et reliée à la base représentative peut être candidate au déploiement.

## Interdiction des déploiements parallèles non coordonnés

- un seul responsable possède le droit de lancer `railway up`, rollback, changement de variable ou migration ;
- aucun déploiement pendant qu’une autre migration, restauration ou vérification de production est en cours ;
- les lots CRM, export, WAHA et facturation ne modifient jamais simultanément la base ou les variables ;
- chaque déploiement possède un identifiant, une liste de migrations, une sauvegarde et une fenêtre d’observation ;
- si deux lots doivent sortir ensemble, ils sont d’abord réunis et testés comme **une seule version** ;
- une équipe qui détecte un incident informe l’intégrateur et s’arrête : elle ne tente ni correction directe en production ni rollback autonome.

## Références officielles

- [PostgreSQL 17 — Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) et [attributs de rôles](https://www.postgresql.org/docs/17/role-attributes.html) : isolation en profondeur et rôle applicatif sans contournement RLS.
- [PostgreSQL 17 — `pg_dump`](https://www.postgresql.org/docs/17/app-pgdump.html) : sauvegarde logique et restauration contrôlée avant migration.
- [Railway — Back Up and Restore Postgres](https://docs.railway.com/guides/postgres-backups-restores) : couches de sauvegarde et exercice de restauration.
- [Railway — Deployment Actions](https://docs.railway.com/deployments/deployment-actions) : rollback coordonné d’un déploiement.
- [OWASP — CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection) : risques de formules dans les données exportées.
- [Microsoft — caractéristiques et limites d’Excel](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits) et [formules SpreadsheetML](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-formulas) : limites et structure du futur XLSX.
