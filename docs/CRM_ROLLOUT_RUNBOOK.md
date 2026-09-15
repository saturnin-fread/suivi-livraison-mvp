# Runbook de déploiement et reprise du CRM

## Objet et état actuel

Ce document encadre l’application de `db/crm-schema.sql`, l’activation progressive du CRM et la reprise après incident. Il complète `CRM_IMPLEMENTATION_SPEC.md`, `CRM_METRICS_CONTRACT.md` et `CRM_EXPORT_SECURITY_SPEC.md`.

État à ne pas confondre :

- le schéma CRM est additif, transactionnel et conçu pour être réexécuté ;
- les fonctions pures de calcul et le contrat de sécurité des exports existent ;
- le contrat d’export définit droits, colonnes, limites, audit et neutralisation des formules ;
- **la génération réelle d’un fichier XLSX, son stockage temporaire, ses endpoints et sa file asynchrone ne sont pas encore implémentés**.

L’application métier utilise la base PostgreSQL `delivery`. Traccar, n8n, WAHA et leurs bases éventuelles ne sont jamais des cibles de cette migration.

## Responsabilités

| Rôle | Responsabilité |
|---|---|
| Responsable de déploiement | ouvre la fenêtre, consigne les versions, décide passage ou arrêt à chaque porte |
| Responsable base | sauvegarde, restauration d’essai, migration, contrôles de catalogues et contraintes |
| Responsable application | active les lectures puis écritures CRM et exécute les tests fonctionnels |
| Responsable sécurité/QA | contrôle isolation, rôles, absence de fuite et preuves d’acceptation |
| Responsable métier | valide les fiches, indicateurs et parcours sans fusion automatique |

Une même personne peut tenir plusieurs rôles au pilote, mais les validations et heures restent consignées.

## Principes non négociables

1. Aucun déploiement CRM sans sauvegarde **restaurée avec succès** sur une base de test.
2. Le schéma est appliqué d’abord sur une copie représentative, jamais découvert en production.
3. Une porte n’est franchie qu’après ses contrôles ; absence de preuve signifie arrêt.
4. Chaque requête applicative garde un prédicat `company_id`, même lorsque RLS est active.
5. Le navigateur ne choisit jamais librement `company_id` ; l’entreprise vient de la session authentifiée.
6. Aucune fusion automatique de clients par nom, téléphone ou proximité GPS.
7. Le retour arrière applicatif ne supprime pas les tables, colonnes ou données CRM.
8. Les logs et preuves de déploiement ne contiennent ni téléphone, adresse, coordonnées GPS, token, mot de passe ou chaîne de connexion.

## Préconditions

- version du code et identifiant du dernier déploiement sain consignés ;
- `db/crm-schema.sql` relu avec la version applicative candidate ;
- espace disque et connexions PostgreSQL vérifiés ;
- fenêtre calme choisie et personne responsable disponible ;
- sauvegardes Railway planifiées actives si le forfait le permet ;
- dump logique au format personnalisé créé et stocké hors du répertoire public ;
- restauration d’essai terminée sur une base distincte ;
- scripts de tests CRM, syntaxe et régressions métier réussis ;
- rôle de migration distinct du futur rôle HTTP applicatif ;
- procédure d’arrêt et déploiement précédent encore disponibles.

Avant toute commande, vérifier explicitement que le nom de base cible est `delivery`. Ne jamais copier une URL complète ou son mot de passe dans ce document, un ticket ou un journal partagé.

## Sauvegarde et restauration d’essai

### Protection minimale

Conserver au minimum deux couches :

1. une sauvegarde ou un point de restauration Railway du volume PostgreSQL ;
2. un dump logique portable créé avec `pg_dump --format=custom --no-owner`.

Un dump n’est accepté qu’après contrôle du code retour, de l’absence d’avertissement bloquant, de sa taille non nulle et de son empreinte SHA-256. Le fichier est chiffré ou placé dans un stockage privé avec accès limité.

### Exercice de restauration obligatoire

1. Créer une base temporaire ou un service PostgreSQL frère, jamais restaurer par-dessus `delivery`.
2. Restaurer avec `pg_restore --exit-on-error --no-owner`.
3. Comparer les comptes de lignes des tables principales et vérifier quelques commandes récentes.
4. Exécuter `ANALYZE` sur la copie restaurée.
5. Noter durée de restauration, âge de la sauvegarde, empreinte et résultat.
6. Détruire la copie uniquement après conservation des preuves non sensibles.

Railway recommande de tester la boucle complète de restauration ; une sauvegarde jamais restaurée reste non vérifiée. Un dump PostgreSQL est un instantané cohérent, mais son exécution doit être surveillée et ses avertissements examinés.

## Validation sur copie ou staging

### 1. Représentativité

La copie doit contenir :

- au moins deux entreprises ;
- commandes et demandes historiques ;
- livreurs, tournées, paiements et incidents ;
- valeurs volontairement similaires entre entreprises ;
- cas sans téléphone, sans GPS, sans adresse nommée et avec repère humain.

Les données réelles utilisées hors production doivent être anonymisées ou protégées selon leur finalité.

### 2. Idempotence de la migration

Appliquer `db/crm-schema.sql` une première fois, capturer uniquement les résultats techniques, puis l’appliquer une seconde fois sans modifier la base entre les deux passages.

Acceptation :

- les deux exécutions terminent avec succès ;
- aucun doublon de table, index, contrainte ou politique ;
- les six colonnes de liaison ajoutées aux commandes et demandes existent ;
- les anciennes lignes et leurs instantanés métier ne sont pas réécrits ;
- les tables CRM sont vides avant une opération de synchronisation explicitement activée ;
- les contraintes ajoutées `NOT VALID` peuvent être validées après contrôle ;
- les catalogues utiles sont identiques après le premier et le second passage.

Le caractère réexécutable protège contre une reprise de démarrage, mais ne justifie pas des exécutions concurrentes. Une seule migration CRM est autorisée à la fois.

### 3. Rapprochement historique

Le rapprochement des commandes historiques est un lot séparé de la création du schéma.

- commencer par une prévisualisation avec comptes par entreprise ;
- ne jamais fusionner deux clients automatiquement ;
- créer des liaisons idempotentes et auditables ;
- conserver les champs historiques de chaque commande comme instantané ;
- traiter par petits lots avec un point de reprise ;
- vérifier après chaque lot les lignes liées, ignorées, en erreur et étrangères ;
- arrêter si un même identifiant technique produit une relation inter-entreprises.

Une relance doit retrouver les liaisons déjà créées et ne produire ni deuxième client automatique, ni deuxième contact, ni deuxième lieu pour la même clé d’idempotence.

## Rôle PostgreSQL et RLS

Les politiques RLS du schéma ne deviennent une barrière réelle pour les requêtes HTTP que si l’application se connecte avec un rôle dédié :

- `LOGIN`, mais **pas** `SUPERUSER` ;
- **pas** propriétaire des tables ;
- **pas** `BYPASSRLS` ;
- droits limités aux tables, séquences et opérations nécessaires ;
- aucun droit de création de schéma, rôle, extension ou base ;
- aucune permission `UPDATE` ou `DELETE` sur le journal CRM append-only lorsque ces opérations ne sont pas requises.

Le rôle de migration reste séparé et plus privilégié. Le serveur ouvre une transaction, déduit l’entreprise de la session, puis définit le contexte local avec `set_config('app.company_id', ..., true)`. Le troisième argument limite la valeur à la transaction et évite sa réutilisation par une connexion mise en commun.

PostgreSQL précise que les superutilisateurs et les rôles `BYPASSRLS` contournent toujours RLS ; le propriétaire contourne normalement RLS malgré `ENABLE`, sauf `FORCE ROW LEVEL SECURITY`. Même avec `FORCE`, un superutilisateur continue de contourner les politiques. Tant que la connexion applicative utilise un superutilisateur, RLS doit être considérée comme **inactive pour cette connexion** et les filtres applicatifs `company_id` restent la seule barrière effective.

## Contrôles d’isolation entreprise

Effectuer ces tests avec le rôle HTTP non privilégié, puis répéter les contrôles applicatifs par API :

1. Entreprise A voit ses clients, contacts, lieux, interactions et indicateurs.
2. Avec le contexte A, les lignes de B sont absentes, même si nom, téléphone ou référence sont identiques.
3. Sans `app.company_id`, aucune ligne CRM n’est visible ni insérable.
4. Une insertion A référençant un client, une commande, un incident ou un paiement de B échoue.
5. Un identifiant appartenant à B demandé depuis A reçoit une réponse générique `404`, sans révéler son existence.
6. Les listes, détails, recherches, compteurs, exports futurs et tâches asynchrones filtrent toutes leurs sources et jointures par entreprise.
7. Les réponses CRM standard n’exposent pas latitude/longitude, identifiant Traccar, token ou secret.
8. La remise d’une connexion au pool ne conserve pas le contexte de l’entreprise précédente.
9. Un utilisateur désactivé ou dont le rôle a changé perd immédiatement les droits correspondants.

Les clés étrangères et contraintes d’unicité peuvent produire des signaux sur une ligne cachée ; les erreurs HTTP restent donc génériques et les identifiants publics opaques.

## Activation progressive

Les portes ci-dessous sont des états de déploiement. Les noms exacts de variables d’activation ne doivent être créés qu’avec leur implémentation ; ne pas inventer une variable Railway sans code qui la lit.

### Porte 0 — code dormant

- déployer les modules et tests sans route publique ni écriture CRM ;
- santé générale, authentification, commandes, tournées, carte et suivi client inchangés ;
- aucune création de donnée CRM.

### Porte 1 — schéma uniquement

- prendre la sauvegarde finale ;
- appliquer le schéma une seule fois par le rôle de migration ;
- réappliquer pour confirmer l’idempotence ;
- valider catalogues, contraintes et comptes de lignes ;
- laisser les fonctions CRM invisibles dans l’interface.

### Porte 2 — lecture CRM

- activer listes et détails en lecture seule pour une entreprise pilote ;
- conserver les données opérationnelles comme source de vérité ;
- contrôler recherches, pagination, périodes et absence de GPS détaillé ;
- comparer manuellement plusieurs fiches aux commandes sources.

### Porte 3 — écritures CRM contrôlées

- activer création/modification pour le seul pilote ;
- exiger transactions, clés d’idempotence, audit et contrôle de concurrence ;
- lancer le rapprochement historique par petits lots ;
- interdire fusion automatique, purge et anonymisation sans leur propre procédure validée.

### Porte 4 — indicateurs

- activer les métriques avec période, fuseau, version de contrat et instant de fraîcheur ;
- vérifier chaque chiffre par exploration des données sources ;
- afficher « non calculable » plutôt qu’un zéro inventé ;
- ne produire ni classement, sanction ou affectation automatique de livreur.

### Porte 5 — export futur

Ne pas ouvrir cette porte tant que le vrai générateur XLSX, la file de travaux, le stockage privé, l’expiration, les autorisations de téléchargement et les tests de paquet Open XML ne sont pas livrés. Le module de contrat actuel ne produit aucun classeur.

## Observabilité et contrôles après activation

### Mesures techniques sans données personnelles

- durée et résultat de chaque exécution de migration ;
- version du schéma et version applicative ;
- nombre de tables, contraintes non validées et erreurs par code ;
- lectures/écritures CRM par route, statut HTTP et entreprise pseudonymisée ;
- conflits d’idempotence et de concurrence ;
- temps de réponse p50/p95/p99 et saturation du pool PostgreSQL ;
- nombre de lignes rapprochées, ignorées et échouées par lot ;
- refus d’isolation, sans valeur métier ni identifiant étranger ;
- état de santé, redémarrages et identifiant de déploiement Railway.

### Alertes d’arrêt

Arrêter l’activation si :

- une entreprise lit ou modifie une donnée d’une autre ;
- un démarrage réexécute le rapprochement et crée des doublons ;
- les anciennes commandes sont modifiées ;
- une contrainte inter-entreprises peut être contournée ;
- une route accepte un `company_id` arbitraire du navigateur ;
- un secret ou une donnée personnelle apparaît dans un log ;
- le taux d’erreur, la latence ou les connexions dépassent le seuil convenu ;
- une sauvegarde ou son exercice de restauration n’est plus vérifiable.

## Retour arrière non destructif

### Incident applicatif sans corruption de données

1. Fermer la porte CRM concernée ou retirer l’accès dans l’interface.
2. Arrêter les travailleurs et rapprochements CRM ; attendre la fin ou l’annulation propre de la transaction active.
3. Conserver les tables, colonnes, politiques, événements et données déjà écrites.
4. Revenir au dernier déploiement compatible avec les colonnes CRM nullables.
5. Vérifier `/health` et les parcours non CRM.
6. Exporter les compteurs techniques de l’incident et ouvrir une analyse.

Le rollback Railway restaure l’image et les variables personnalisées d’un ancien déploiement ; il ne remet pas la base PostgreSQL à un état antérieur. Ne jamais supposer que le rollback applicatif annule une migration ou des écritures métier.

### Erreur de migration ou données suspectes

- arrêter les écritures ;
- créer une restauration dans une base ou un service frère ;
- comparer la source et la copie avant toute bascule ;
- préférer une correction additive ou la copie ciblée de lignes vérifiées ;
- ne restaurer l’ensemble de la production qu’après décision explicite, fenêtre annoncée et estimation de perte de données ;
- ne jamais exécuter `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, restauration `--clean` ou suppression de volume comme réflexe de rollback.

Les colonnes et tables CRM pourront être retirées uniquement par une migration ultérieure, séparée, sauvegardée, revue et autorisée après expiration des besoins de conservation.

## Feuille de contrôle du déploiement

```text
Version code :
Déploiement précédent :
Déploiement candidat :
Base vérifiée = delivery : oui/non
Sauvegarde Railway : date/référence
Dump logique : date/empreinte/stockage privé
Restauration d’essai : succès/échec, durée
Migration copie passage 1 :
Migration copie passage 2 :
Isolation A/B avec rôle HTTP :
Porte activée : 0 / 1 / 2 / 3 / 4 / 5
Tests de régression :
Décision : poursuivre / arrêter / revenir
Responsable et heure :
```

## Références officielles

- [PostgreSQL 17 — `pg_dump`](https://www.postgresql.org/docs/17/app-pgdump.html) et [sauvegardes SQL](https://www.postgresql.org/docs/17/backup-dump.html) : instantané cohérent, formats de dump et restauration.
- [PostgreSQL 17 — Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) : refus par défaut, `FORCE ROW LEVEL SECURITY`, propriétaire, superutilisateur et `BYPASSRLS`.
- [PostgreSQL 17 — attributs de rôles](https://www.postgresql.org/docs/17/role-attributes.html) : moindre privilège, `LOGIN`, superutilisateur et contournement RLS.
- [Railway — Back Up and Restore Postgres](https://docs.railway.com/guides/postgres-backups-restores) et [Backups](https://docs.railway.com/volumes/backups) : sauvegardes de volume, dumps logiques et exercice de restauration.
- [Railway — Deployment Actions](https://docs.railway.com/deployments/deployment-actions) : portée du rollback d’une image et de ses variables.
- [Microsoft — caractéristiques et limites d’Excel](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits) : limites techniques qui encadrent le futur générateur.
- [Microsoft — formules SpreadsheetML](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-formulas) et [OWASP — CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection) : traitement des formules et des entrées non fiables dans les futurs exports.
