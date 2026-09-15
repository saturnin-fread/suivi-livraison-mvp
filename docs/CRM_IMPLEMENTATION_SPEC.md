# Spécification d’implémentation — fondation CRM

## Portée

Cette spécification accompagne `db/crm-schema.sql`. Le lot est uniquement une fondation de données : il ne branche aucune route Express, ne modifie aucune interface et ne déploie aucune migration.

Le schéma est additif et réexécutable. Il suppose que les tables métier actuelles `companies`, `users`, `customer_requests`, `orders`, `delivery_incidents` et `order_payment_accounts` existent déjà.

## Objectifs garantis par le schéma

1. Chaque ligne CRM appartient explicitement à une entreprise.
2. Une relation ne peut pas relier des objets de deux entreprises différentes.
3. Une commande passée conserve ses champs actuels comme instantané historique, même si la fiche client ou le lieu change.
4. Un téléphone, un nom ou une proximité GPS peut suggérer un doublon, mais ne déclenche jamais une fusion automatique.
5. Les interactions externes et mutations sensibles sont dédoublonnables.
6. Consentements, préférences opérationnelles et base juridique restent distincts.
7. Les politiques de conservation, gels et actions d’anonymisation sont explicites et auditables.
8. Les tags restent propres à l’entreprise et possèdent des tables de liaison référentielles plutôt qu’une relation polymorphe sans clé étrangère.

## Modèle livré

### Référentiel client

`customers` représente une personne ou une organisation. `customer_code` est unique dans l’entreprise et ne doit jamais être dérivé du téléphone. `display_name` n’est pas unique.

États :

- `active` : fiche utilisable ;
- `do_not_contact` : aucune communication non indispensable ;
- `archived` : plus proposée pour une nouvelle opération ;
- `merged` : fiche absorbée, redirigée vers `merged_into_customer_id` ;
- `anonymized` : identifiants directs retirés par une action contrôlée.

Une fiche fusionnée n’est pas supprimée. Elle garde son identifiant pour expliquer les anciennes relations.

### Contacts

`customer_contacts` conserve la valeur confirmée, une forme normalisée de recherche et éventuellement une empreinte. Une même valeur peut appartenir à plusieurs clients : famille, organisation, numéro partagé ou réattribué. Elle n’est donc pas globalement unique.

Une contrainte garantit au plus un contact principal actif par client et par type. Lors de l’anonymisation, la valeur affichable et la forme normalisée deviennent nulles, et le contact devient inactif.

Le chiffrement éventuel des valeurs au repos est une décision d’infrastructure et de gestion de clés ; le schéma ne prétend pas chiffrer une donnée simplement parce qu’elle est stockée dans PostgreSQL.

### Lieux et repères

`customer_locations` accepte un lieu sans adresse de rue : quartier, localité, repère humain, instructions et point GPS sont séparés. Latitude et longitude sont présentes ensemble ou absentes ensemble. Leur source et l’heure de capture sont obligatoires lorsqu’un point existe.

`customer_location_revisions` conserve les corrections importantes. Les états JSON peuvent contenir des données personnelles ; ils suivent donc la même politique de conservation que le lieu et peuvent être expurgés.

Modifier un lieu CRM ne doit jamais réécrire `orders.delivery_address`, `orders.destination_lat`, `orders.destination_lng`, `orders.neighborhood`, `orders.landmark` ou les autres données historiques de la commande.

### Interactions

`customer_interactions` journalise un résumé factuel de coordination : appel, WhatsApp, SMS, courriel, échange en personne ou note interne. Il peut être rattaché à un client, une commande, un incident et/ou un compte de paiement.

Le contenu intégral d’un message ou d’un appel n’est pas prévu. Une preuve de litige doit passer par le dossier probatoire dédié, avec justification, accès restreint et conservation propre.

Deux mécanismes empêchent les doublons :

- `(company_id, idempotency_key)` pour les écritures applicatives ;
- `(company_id, external_provider, external_event_id)` pour les événements WAHA/n8n.

Les références incident et paiement incluent aussi `order_id`. PostgreSQL peut ainsi prouver qu’elles appartiennent à la même commande et à la même entreprise.

### Consentements et préférences

`customer_consents` est un journal d’états successifs. Une nouvelle décision remplace logiquement la précédente grâce à `supersedes_consent_id` et `superseded_at`; l’ancienne ligne n’est pas écrasée.

La colonne `legal_basis` évite de présenter tout traitement comme reposant sur un consentement. Une communication strictement nécessaire à l’exécution d’une livraison peut relever du contrat ou d’une autre base validée, tandis qu’une communication commerciale exige son propre cadrage.

`customer_contact_preferences` représente le choix pratique par canal et finalité : autorisé, transactionnel seulement, ne pas contacter ou inconnu. Une préférence n’est pas à elle seule la preuve d’une base juridique.

### Tags

`crm_tags` est un référentiel par entreprise. Les liaisons sont séparées :

- `customer_tags` ;
- `customer_location_tags` ;
- `order_tags` ;
- `incident_tags` ;
- `payment_account_tags`.

Cette répétition est volontaire : elle conserve les clés étrangères, empêche les identifiants orphelins et interdit les liaisons entre entreprises.

### Détection et fusion de doublons

`customer_duplicate_candidates` stocke une suggestion avec signaux et niveau de confiance. La paire est toujours ordonnée par identifiant, ce qui empêche deux suggestions symétriques.

Cycle recommandé :

1. calculer les signaux sans décision automatique ;
2. afficher une prévisualisation des fiches, relations et conflits ;
3. demander un client cible, un motif et une confirmation responsable ;
4. verrouiller les deux fiches avec `SELECT … FOR UPDATE` ;
5. revérifier entreprise, versions et absence de fusion concurrente ;
6. déplacer les relations autorisées dans une seule transaction ;
7. créer `customer_merge_events` ;
8. passer la source à `merged` et renseigner `merged_into_customer_id` et `merged_by_event_id` ;
9. écrire l’audit CRM ;
10. valider la transaction.

Une séparation utilise un événement `split` qui référence la fusion d’origine. Elle doit rester assistée : après de nouvelles commandes ou modifications, un retour automatique à l’état antérieur pourrait perdre des données.

### Liens avec les opérations existantes

Le script ajoute six colonnes facultatives :

```text
orders.customer_id
orders.customer_contact_id
orders.customer_location_id
customer_requests.customer_id
customer_requests.customer_contact_id
customer_requests.customer_location_id
```

Les clés étrangères composites assurent la cohérence du locataire et du parent. Les anciennes lignes restent valides avec ces colonnes nulles.

Lors de la validation d’une demande :

- sélectionner ou créer le client après prévisualisation des doublons ;
- sélectionner/créer le contact et le lieu ;
- copier les informations confirmées dans les champs historiques de la commande ;
- rattacher les trois identifiants CRM ;
- ne jamais reconstruire une ancienne commande depuis la valeur actuelle de la fiche CRM.

### Conservation, gel et anonymisation

`crm_retention_policies` versionne une durée, son événement déclencheur, son action et sa justification. Une seule version courante existe par catégorie et entreprise.

`crm_retention_holds` suspend le traitement d’un client, d’une commande ou d’un incident. Une purge doit également rechercher les gels déjà présents dans `order_retention_holds`; créer une deuxième table ne remplace pas cette vérification.

`crm_privacy_actions` porte le cycle demande → prévisualisation → approbation → exécution → résultat. Les opérations sont idempotentes et indiquent leurs comptes de lignes, sans recopier les données effacées.

Anonymisation minimale d’un client :

- vérifier les gels CRM et métier dans la même transaction ;
- remplacer le nom par un pseudonyme technique non réversible ;
- retirer notes libres non nécessaires ;
- désactiver et vider contacts normalisés/affichables ;
- retirer coordonnées et instructions réutilisables des lieux ;
- expurger les états de révision contenant ces valeurs ;
- conserver les identifiants, montants et événements légalement nécessaires selon la politique validée ;
- ne jamais modifier silencieusement une preuve sous gel ;
- produire `crm_privacy_actions` et `crm_audit_events`.

Le schéma ne fixe aucune durée légale universelle. Chaque entreprise doit valider finalité, base, durée, destinataires et procédure avec les obligations applicables au Bénin.

### Audit

`crm_audit_events` est distinct des événements métier et du journal technique. Il conserve acteur, entreprise, action, objet, résultat, champs affectés, corrélation et chaîne d’empreintes.

Ne jamais placer dans `metadata` :

- token ou secret ;
- mot de passe ou OTP ;
- téléphone, courriel ou adresse en clair ;
- latitude/longitude précise ;
- contenu intégral d’une interaction ;
- copie des valeurs anonymisées.

L’application doit traiter ce journal comme append-only. Les droits SQL du rôle applicatif doivent refuser `UPDATE` et `DELETE`; un rôle de maintenance séparé applique la politique de conservation des audits.

La suppression d’une entreprise est volontairement bloquée tant que son audit CRM existe. Une clôture de compte doit donc suivre une procédure dédiée de conservation, export éventuel, anonymisation et purge approuvée ; un simple `DELETE` ne doit pas effacer silencieusement la trace des opérations sensibles.

## Isolation multi-entreprise

### Intégrité relationnelle

Chaque table possède `company_id`. Les objets réutilisables ont une unicité `(company_id, id)`. Les liaisons utilisent ces deux colonnes, parfois avec `customer_id` ou `order_id` supplémentaires, pour rendre impossible une référence vers une autre entreprise.

L’identifiant global seul ne suffit jamais dans une requête applicative. Toute lecture ou mutation conserve `company_id` dans son prédicat.

### Row-Level Security

Le script active et force RLS sur les nouvelles tables CRM. Avant toute requête métier, l’API doit ouvrir une transaction puis exécuter :

```sql
SELECT set_config('app.company_id', $1, true);
```

Le troisième argument `true` limite la valeur à la transaction. Sans contexte, la politique ne correspond à aucune ligne et PostgreSQL refuse par défaut l’accès.

RLS est une défense supplémentaire, pas le mécanisme d’authentification. Le serveur déduit toujours l’entreprise de la session authentifiée ; il n’accepte jamais un `company_id` envoyé librement par le navigateur.

Le rôle de migration possède un accès séparé. Le rôle HTTP ne doit être ni superutilisateur, ni propriétaire des tables, ni doté de `BYPASSRLS`. `FORCE ROW LEVEL SECURITY` couvre aussi le propriétaire ordinaire, mais pas un superutilisateur.

Attention : les vérifications référentielles et les erreurs d’unicité peuvent révéler l’existence d’une ligne cachée. Les identifiants publics sont aléatoires ou internes à une session autorisée, et les erreurs HTTP restent génériques.

## Index et charges visées

Les index suivent les chemins attendus :

- listes clients par entreprise, statut et dernière modification ;
- recherche exacte sur nom normalisé et contact normalisé ;
- lieux actifs et coordonnées présentes ;
- interactions par client, commande ou prochaine action ;
- déduplication fournisseur/idempotence ;
- consentement courant ;
- tags actifs ;
- suggestions de doublons en attente ;
- gels à réviser ;
- actions de confidentialité par état ;
- audit par date ou objet.

La recherche approximative, phonétique ou plein texte n’est pas activée dans ce lot. Elle devra être mesurée sur des données béninoises représentatives avant d’ajouter une extension ou un index coûteux. Un score ne fusionnera jamais seul deux fiches.

## Stratégie d’application

1. Sauvegarder la base et tester une restauration.
2. Vérifier que le schéma `public` n’accorde pas `CREATE` à un rôle non privilégié ; le script y crée volontairement ses objets et ne doit être exécuté que par le rôle de migration.
3. Appliquer le script sur une copie représentative.
4. Vérifier les noms de contraintes/index et l’espace disque.
5. Appliquer en période calme : les index initiaux ne sont pas construits `CONCURRENTLY` car le script est transactionnel.
6. Contrôler que les six colonnes ajoutées sont nulles sur les lignes historiques.
7. Valider les clés étrangères ajoutées `NOT VALID` après contrôle :

```sql
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_crm_fk;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_contact_crm_fk;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_location_crm_fk;
ALTER TABLE customer_requests VALIDATE CONSTRAINT customer_requests_customer_crm_fk;
ALTER TABLE customer_requests VALIDATE CONSTRAINT customer_requests_customer_contact_crm_fk;
ALTER TABLE customer_requests VALIDATE CONSTRAINT customer_requests_customer_location_crm_fk;
ALTER TABLE customers VALIDATE CONSTRAINT customers_merged_by_event_fk;
```

8. Créer un rôle applicatif non propriétaire, accorder uniquement les opérations nécessaires et tester RLS.
9. Brancher l’API par petits lots avec transactions et contexte locataire local.
10. Ne commencer le rapprochement des anciennes commandes qu’après prévisualisation et stratégie de retour arrière.

Le script entier peut être relancé : créations, colonnes, index, fonction, contraintes conditionnelles et politiques RLS sont idempotents.

## Tests d’acceptation déterministes à prévoir

### Migration

- appliquer le script deux fois sur PostgreSQL 17 ;
- comparer les catalogues après les deux exécutions ;
- appliquer avec commandes et demandes historiques ;
- vérifier qu’aucune donnée existante n’est modifiée ;
- valider toutes les contraintes `NOT VALID`.

### Isolation

- créer deux entreprises avec noms, téléphones, tags et lieux identiques ;
- définir `app.company_id` pour A et confirmer que B est invisible ;
- omettre le contexte et obtenir zéro ligne/refus ;
- tenter chaque clé étrangère croisée ;
- utiliser un rôle propriétaire, un rôle HTTP et un rôle de migration pour confirmer le comportement RLS attendu.

### Données et doublons

- partager volontairement un téléphone entre deux clients sans violation d’unicité ;
- refuser deux contacts principaux actifs du même type sur une fiche ;
- refuser latitude sans longitude, coordonnées hors limites ou GPS sans source/date ;
- créer une paire de doublons dans l’ordre inverse et confirmer son rejet ;
- fusionner avec versions cohérentes, puis simuler deux fusions concurrentes ;
- vérifier qu’une commande passée conserve son adresse après modification du lieu.

### Interactions et consentements

- rejouer une interaction avec la même clé et le même événement fournisseur ;
- refuser un incident ou paiement appartenant à une autre commande ;
- remplacer un consentement sans écraser l’ancien ;
- retirer un consentement avec date obligatoire ;
- appliquer `do_not_contact` sans bloquer la communication transactionnelle légalement nécessaire lorsque la politique l’autorise.

### Conservation

- calculer une échéance depuis chaque version de politique ;
- empêcher anonymisation ou purge sous gel CRM ou `order_retention_holds` ;
- anonymiser deux fois avec la même clé sans double mutation ;
- vérifier qu’aucun contact, lieu précis ou ancienne valeur de révision ne subsiste ;
- conserver un audit minimal ne contenant aucune valeur supprimée.

Tous ces tests utilisent une base éphémère locale, une horloge fixée et aucune requête réseau.

## Limites explicites

- aucune API ou interface CRM dans ce lot ;
- aucune migration de données historique automatique ;
- aucune fusion automatique ;
- aucune durée juridiquement validée par défaut ;
- aucun chiffrement de champ sans stratégie de clés ;
- aucun export Excel/CSV ;
- aucun KPI ni classement de livreur ;
- aucune activation de RLS sur les anciennes tables métier, qui nécessite un lot dédié et des tests de régression complets.

## Références officielles et primaires

- [PostgreSQL 17 — Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) : refus par défaut, propriétaire, `FORCE ROW LEVEL SECURITY` et `BYPASSRLS`.
- [PostgreSQL 17 — `CREATE POLICY`](https://www.postgresql.org/docs/17/sql-createpolicy.html) : `USING`, `WITH CHECK` et limites de confidentialité liées aux contraintes référentielles.
- [PostgreSQL 17 — fonctions de configuration](https://www.postgresql.org/docs/17/functions-admin.html) : `current_setting` et `set_config(..., true)` limité à la transaction.
- [PostgreSQL 17 — `ALTER TABLE`](https://www.postgresql.org/docs/17/sql-altertable.html) : clés étrangères composites, contraintes `NOT VALID` puis validation contrôlée.
- [APDP Bénin — Code du numérique, Livre V](https://apiprod.apdp.bj/storage/c46ab3f55e93d40c8545b70add0ea8c7/CODE-DU-NUMERIQUE-DU-BENIN_2018-version-APDP.pdf) : finalité, proportionnalité, durée, sécurité et droits concernant les données personnelles.
- [APDP Bénin — Guide de mise en conformité](https://archive.apdp.bj/wp-content/uploads/2022/01/GUIDE-DE-MISE-EN-CONFORMITE_Pt_YD_revu.pdf) : registre, minimisation, conservation, sécurité et organisation des responsabilités.

Cette architecture soutient la conformité mais ne la prouve pas. La mise en conformité dépend des traitements réellement activés, des contrats, des rôles, des durées validées et des formalités applicables.
