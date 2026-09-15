# Plan CRM opérationnel, pilotage et exports

## Statut et périmètre

Ce document décrit la cible fonctionnelle de la phase CRM et pilotage. Il ne modifie ni le code d'exécution ni le schéma actuel.

Le CRM doit donner une expérience inspirée d'Airtable — fiches liées, vues configurables, filtres, regroupements et exploration — sans devenir une copie générique d'Airtable. Il reste spécialisé dans la livraison : demandes, clients, lieux, commandes, tournées, livreurs, interactions, encaissements et litiges.

Décisions structurantes :

- `delivery` reste la source de vérité métier ; Traccar reste la source GPS ;
- toute donnée est rattachée à `company_id` et filtrée côté serveur ;
- une statistique doit être explicable depuis les opérations sources ;
- une fiche client ne réécrit jamais l'adresse historique d'une ancienne commande ;
- un événement confirmé n'est pas supprimé pour corriger une erreur : la correction est historisée ;
- le téléphone, le nom et l'adresse ne sont pas des identifiants uniques fiables ;
- aucune donnée GPS brute n'entre par défaut dans un export CRM ;
- aucun score composite ni classement automatique des livreurs n'est prévu ;
- aucune décision disciplinaire ne peut être prise automatiquement à partir d'un indicateur ;
- les durées proposées ci-dessous sont des paramètres de départ à valider avec l'entreprise et, si nécessaire, l'APDP du Bénin ; elles ne constituent pas un avis juridique.

## Résultat attendu pour l'entreprise

L'espace `/app` doit permettre de répondre rapidement à six questions :

1. Qui est le client et comment le joindre ?
2. Quels lieux et repères a-t-il déjà utilisés ?
3. Où en sont ses demandes, commandes, paiements et réclamations ?
4. Quelles opérations requièrent une action maintenant ?
5. Comment l'activité évolue-t-elle sur une période clairement définie ?
6. Quelles données sources expliquent chaque chiffre ou litige ?

## Architecture fonctionnelle

```text
Clients ──< Contacts
   │
   ├──────< Lieux ──────< Commandes >────── Livreurs
   │                         │                  │
   ├──────< Interactions     ├──< Tentatives   ├──< Périodes de service
   │                         ├──< Paiements     └──< Événements de statut
   │                         ├──< Incidents
   │                         └──< Arrêts de tournée
   │
   └──────< Demandes client

Événements métier ──> vues analytiques versionnées ──> graphiques et exports
```

Les relations doivent être navigables dans les deux sens. Depuis une commande, l'utilisateur ouvre le client, le lieu, le livreur, la tournée, le paiement et le dossier d'incident. Depuis un client, il retrouve toutes les commandes et interactions autorisées.

## Modèle de données cible

### Principes de modélisation

- Clé primaire technique stable sur chaque objet.
- `company_id NOT NULL` sur toute table métier, y compris tables de liaison, vues enregistrées, exports et métriques matérialisées.
- Clés étrangères composites ou contrôles équivalents empêchant de relier deux objets d'entreprises différentes.
- Horodatages serveur en `timestamptz`; date civile et fuseau de l'entreprise conservés lorsque la journée de service a un sens métier.
- Montants en entier dans l'unité minimale avec code devise séparé.
- Coordonnées en nombres décimaux, avec source, précision et horodatage.
- Champs libres bornés en longueur ; catégories structurées pour les calculs.
- Archivage logique des référentiels encore cités par l'historique.
- Idempotence sur imports, interactions externes, créations d'exports et mutations sensibles.
- Les contraintes PostgreSQL protègent les invariants certains, pas les suppositions métier fragiles. Les ressemblances de nom, téléphone ou lieu déclenchent une suggestion de rapprochement, pas un rejet automatique.

### Tables actuelles réutilisées

| Table actuelle | Usage CRM |
|---|---|
| `companies` | propriétaire de toutes les données |
| `customer_requests` | entrée avant commande et source éventuelle d'un client |
| `orders` | dossier opérationnel de livraison |
| `drivers` | référentiel livreur et liaison Traccar |
| `delivery_runs`, `delivery_stops`, `delivery_run_events` | tournées et ordre confirmé |
| `order_status_events` | chronologie append-only des commandes |
| `delivery_incidents`, `incident_events` | litiges et chronologie factuelle |
| `order_payment_accounts`, `payment_events`, `payment_adjustments` | encaissement et corrections |
| `delivery_proofs`, `delivery_evidence_files` | preuves privées avec accès restreint |
| `audit_logs`, `order_retention_holds` | traçabilité et gel de conservation |

### `customers`

Une personne ou organisation destinataire réutilisable dans une entreprise.

| Champ | Règle |
|---|---|
| `id`, `company_id` | identité technique et isolation |
| `customer_code` | code lisible unique dans l'entreprise, jamais dérivé du téléphone |
| `customer_type` | `person` ou `organization` |
| `display_name` | nom d'usage, modifiable sans changer les anciennes commandes |
| `status` | `active`, `do_not_contact`, `archived` |
| `preferred_language` | facultatif, liste contrôlée |
| `service_notes` | facultatif, borné, sans données sensibles non nécessaires |
| `created_from_request_id` | provenance facultative |
| `created_at`, `updated_at`, `archived_at` | cycle de vie |

Règles :

- aucune unicité sur `display_name` ;
- aucune création silencieuse de doublon lors d'une répétition réseau ;
- l'archivage n'efface pas les commandes ;
- la fusion de deux clients exige une prévisualisation, une confirmation responsable et un événement `customer_merged` ; la fiche absorbée devient un alias historique ;
- une séparation après fusion doit être un processus assisté, pas une édition improvisée.

### `customer_contacts`

| Champ | Règle |
|---|---|
| `customer_id`, `company_id` | parent et isolation |
| `kind` | `phone`, `email`, `whatsapp`, `other` |
| `label` | domicile, bureau, assistant, autre |
| `contact_name` | utile pour une organisation ou un proche autorisé |
| `value_display` | valeur telle que confirmée par l'opérateur |
| `value_normalized` | recherche et détection de doublons, jamais affichée seule comme vérité |
| `is_primary` | contact principal de ce type pour cette fiche |
| `verified_at`, `verification_source` | confirmation éventuelle |
| `communication_status` | `allowed`, `transactional_only`, `do_not_contact`, `unknown` |
| `consent_source`, `consent_at`, `withdrawn_at` | seulement si le consentement est la base retenue |
| `active`, `created_at`, `updated_at` | cycle de vie |

Un même numéro peut être partagé par une famille, réattribué par un opérateur ou associé à plusieurs contacts d'une société. Il est indexé pour signaler les doublons, mais n'est pas une clé unique globale. Une restriction partielle peut garantir au maximum un contact principal actif par type et par client.

### `customer_locations`

Lieu réutilisable et compréhensible même sans adresse de rue officielle.

| Champ | Règle |
|---|---|
| `customer_id`, `company_id` | parent et isolation |
| `label` | maison, boutique, dépôt, bureau, autre |
| `neighborhood`, `locality`, `address_text` | l'adresse textuelle reste facultative |
| `landmark` | repère humain utile : portail, carrefour, enseigne, bâtiment |
| `delivery_instructions` | appel avant arrivée, étage, accès, horaires ; longueur bornée |
| `latitude`, `longitude` | facultatifs ensemble, jamais l'un sans l'autre |
| `accuracy_meters` | précision de la capture si disponible |
| `coordinate_source` | `customer_gps`, `map_pin`, `whatsapp_link`, `operator`, `import` |
| `verified_at`, `verified_by_user_id` | dernière validation humaine |
| `last_used_at`, `active` | pertinence opérationnelle |

Chaque commande copie un instantané du lieu utilisé (`destination_*_snapshot`). Modifier un lieu réutilisable ne déplace donc pas rétroactivement une livraison passée. Une table `customer_location_revisions` conserve les corrections importantes : ancienne valeur, nouvelle valeur, acteur, motif et heure.

Le rapprochement de lieux utilise proximité géographique, téléphone/client et texte normalisé comme indices. Il ne fusionne jamais automatiquement deux entrées proches dans un immeuble, un marché ou un quartier dense.

### Extensions de `customer_requests` et `orders`

À ajouter progressivement :

- `customer_id`, `customer_contact_id`, `customer_location_id` ;
- instantané du nom, du contact et de la destination au moment de la validation ;
- `source` : formulaire, commande directe, WhatsApp, import, API ;
- `service_date`, `promised_window_start`, `promised_window_end`, `company_timezone` ;
- `priority` structurée avec motif ;
- `cancelled_reason_category` et motif détaillé ;
- `confirmed_at`, `picked_up_at`, `first_arrived_at`, `completed_at` dérivés des événements ou matérialisés de façon contrôlée ;
- `last_customer_contact_at` pour la file de travail, jamais comme substitut à l'historique d'interactions.

Le créneau doit devenir un intervalle structuré. Le texte libre historique est conservé mais n'entre pas dans les KPI de ponctualité tant qu'il n'a pas été vérifié.

### `customer_interactions`

Journal des échanges utiles au service.

| Champ | Règle |
|---|---|
| `customer_id`, `order_id`, `incident_id` | au moins un contexte métier, selon le cas |
| `channel` | `call`, `whatsapp`, `sms`, `email`, `in_person`, `other` |
| `direction` | `inbound`, `outbound`, `internal` |
| `purpose` | confirmation, précision, approche, réclamation, paiement, autre |
| `occurred_at` | heure réelle déclarée ; `created_at` reste l'heure d'enregistrement |
| `actor_user_id` | utilisateur interne, facultatif pour événement automatisé |
| `external_provider`, `external_event_id` | déduplication WAHA/n8n sans en faire une source de vérité |
| `outcome` | joint, sans réponse, rappel demandé, information reçue, échec technique |
| `summary` | résumé factuel court, pas une transcription systématique |
| `next_action_at`, `assigned_to_user_id` | suivi opérationnel facultatif |
| `visibility` | exploitation, responsable, litige |

Le contenu complet des messages ou appels n'est pas stocké par défaut. Si un message devient une preuve de litige, son extraction est explicite, justifiée, protégée et soumise à la conservation du dossier.

### `delivery_attempts`

Cette table est nécessaire avant de calculer un taux de réussite au premier passage.

| Champ | Règle |
|---|---|
| `order_id`, `company_id`, `driver_id` | contexte |
| `attempt_number` | séquence unique par commande |
| `started_at`, `arrived_at`, `ended_at` | événements serveur |
| `outcome` | `delivered`, `customer_unavailable`, `address_issue`, `refused`, `vehicle_issue`, `rescheduled`, `other` |
| `cause_scope` | `customer`, `address`, `dispatch`, `driver`, `vehicle`, `technical`, `external`, `unknown` |
| `reason`, `evidence_event_id` | justification et source |
| `verified_by_user_id`, `verified_at` | revue éventuelle |

`cause_scope` sert à comprendre les causes, pas à attribuer automatiquement une faute. `unknown` est une valeur normale lorsqu'aucun fait ne permet de conclure.

### Référentiels complémentaires

- `tags` et tables de liaison : catégories propres à l'entreprise, couleurs et archivage ;
- `customer_aliases` : références absorbées lors d'une fusion ;
- `customer_merge_events` : historique et décision ;
- `driver_shifts` : périodes de service déclarées, sans suivi hors service ;
- `driver_status_events` : disponibilité et interruptions avec provenance ;
- `saved_views` : table, filtres, tris, groupements, colonnes, propriétaire, partage et version ;
- `metric_definitions` : clé, version, formule lisible, population, exclusions, fuseau, date d'effet ;
- `analytics_refreshes` : début, fin, version, état, source maximale et erreurs ;
- `export_jobs` : demande, filtres, format, état, expiration temporaire ;
- `export_logs` : acteur, entreprise, période, colonnes, nombre de lignes, empreinte et résultat ;
- `data_retention_policies` : catégorie, durée, action, validation et date d'effet.

## Écrans et navigation

### Menu CRM

```text
CRM
├── Vue d'ensemble
├── Clients
├── Contacts et relances
├── Lieux et repères
├── Commandes
├── Litiges
├── Livreurs — activité
├── Rapports mensuels
└── Exports
```

Chaque page possède son URL, un titre, une aide courte, un état vide utile et un retour vers la vue précédente. Les fonctions ne sont pas entassées sur un seul écran.

### Vue d'ensemble CRM

- tâches à traiter aujourd'hui ;
- demandes sans réponse ;
- commandes à confirmer ou en retard de mise à jour ;
- clients à rappeler ;
- litiges ouverts et gels à réviser ;
- encaissements à rapprocher ;
- raccourcis vers les vues enregistrées ;
- indicateurs du mois avec date de dernière actualisation.

### Vues type Airtable

Pour `Clients`, `Commandes`, `Interactions`, `Litiges` et `Livreurs` :

- grille paginée côté serveur ;
- recherche, filtres combinables, tri multiple, groupement et colonnes masquables ;
- vue Kanban uniquement lorsqu'un statut possède un cycle défini ;
- calendrier pour créneaux, relances et dates de service ;
- carte pour lieux agrégés ou opérations autorisées, sans historique GPS brut ;
- vue enregistrée personnelle ou partagée ;
- compteur total et compteur filtré ;
- sélection en masse limitée aux actions réversibles et autorisées ;
- fiche latérale ou page complète avec relations liées ;
- lien permanent qui conserve l'identifiant de la vue et non une requête SQL.

Une vue limite ce qui est présenté ou sélectionnable ; elle ne remplace jamais l'autorisation serveur. Les filtres sont représentés dans un langage applicatif avec champs et opérateurs autorisés, jamais par un fragment SQL fourni par le navigateur.

### Fiche client

Onglets :

1. résumé et prochaine action ;
2. contacts ;
3. lieux et repères ;
4. commandes et demandes ;
5. interactions ;
6. paiements ;
7. incidents et réclamations ;
8. historique des changements.

Actions sensibles : fusion, archivage, export des données personnelles et changement de statut nécessitent confirmation, motif lorsque pertinent et audit.

### Fiche livreur — activité

La fiche sépare :

- situation opérationnelle actuelle : disponibilité, charge, tournée, fraîcheur GPS ;
- historique de service : volumes, résultats et incidents vérifiés ;
- qualité des données : couverture GPS, champs manquants, événements non synchronisés ;
- contexte : zones, types de tournées, volume confié et changements du dispatch ;
- droit de réponse/correction : note du responsable et contestation du fait source.

La vitesse instantanée, les pauses supposées et le trajet hors période de service n'apparaissent pas dans le tableau de performance.

## Filtres communs

Tout rapport annonce le fuseau et applique une borne de début inclusive et une borne de fin exclusive.

- période prédéfinie ou personnalisée ;
- date de création, date de service, date de clôture ou date d'événement, explicitement choisie ;
- statut, résultat et cause ;
- client, contact ou segment ;
- livreur, équipe ou tournée ;
- zone, quartier, lieu ou rayon géographique autorisé ;
- source de la demande ;
- canal d'interaction ;
- présence d'incident, catégorie et gravité ;
- état de paiement, mode et écart ;
- qualité de données : GPS manquant/ancien, créneau non structuré, lieu non vérifié ;
- tags ;
- archivés inclus ou exclus.

Règles d'interface :

- afficher les filtres actifs sous forme de pastilles ;
- proposer « Réinitialiser » ;
- expliquer pourquoi une ligne est exclue ;
- distinguer `inconnu` de zéro et d'une chaîne vide ;
- conserver les filtres lors du retour d'une fiche ;
- avertir lorsqu'une vue enregistrée référence un champ retiré ;
- demander confirmation avant de remplacer une vue partagée.

## Dictionnaire des KPI

### Convention obligatoire

Chaque KPI possède : `metric_key`, version, nom, finalité, formule, numérateur, dénominateur, population, exclusions, dimension temporelle, fuseau, fraîcheur, propriétaire et lien d'exploration.

Une modification de formule crée une nouvelle version avec date d'effet. Les rapports historiques indiquent la version utilisée. Un ratio avec dénominateur nul affiche « Non calculable », jamais `0 %`.

Les volumes mensuels sont calculés selon `service_date` dans le fuseau de l'entreprise. Les flux d'activité peuvent utiliser la date de l'événement, mais l'écran doit le dire explicitement.

### KPI opérationnels prioritaires

| KPI | Définition précise | Précautions |
|---|---|---|
| Commandes créées | nombre de commandes dont `created_at` tombe dans la période | mesure d'entrée, pas de résultat |
| Commandes prises en charge | nombre de commandes ayant atteint `Récupérée` pendant la période | une commande comptée une fois |
| Livraisons clôturées | commandes devenues `Livrée`, `Retournée` ou `Annulée` pendant la période | afficher chaque issue séparément |
| Taux de remise | `Livrée / (Livrée + Retournée)` parmi les commandes clôturées avec tentative réelle | exclure les annulations avant prise en charge ; montrer les volumes |
| Taux d'annulation | `Annulée / commandes créées` pour la cohorte de création | ventiler avant/après prise en charge |
| Réussite au premier passage | commandes livrées lors de `attempt_number = 1` / commandes ayant au moins une tentative terminée | indisponible avant `delivery_attempts` fiable |
| Ponctualité d'arrivée | commandes avec `first_arrived_at <= promised_window_end` / commandes livrées ou arrivées ayant un créneau structuré et non modifié après arrivée | afficher le taux de couverture des créneaux ; ventiler les causes |
| Délai confirmation | médiane et P90 de `confirmed_at - created_at` | exclure dates invalides, afficher taille de l'échantillon |
| Durée opérationnelle | médiane et P90 de `completed_at - picked_up_at` | segmenter par zone et type de tournée |
| Retours | `Retournée / (Livrée + Retournée)` | catégoriser les causes, ne pas conclure sur le livreur seul |
| Incidents | incidents ouverts pour 100 commandes prises en charge | compter séparément commandes avec incident et nombre d'incidents |
| Temps de résolution | médiane et P90 de `resolved_at - created_at` des incidents résolus | afficher aussi les incidents encore ouverts |
| Encaissement conforme | commandes clôturées sans écart non résolu / commandes clôturées avec encaissement requis | distinguer montant, nombre et cause |
| Montant net encaissé | collecte d'origine + compléments - remboursements et écritures inverses selon le ledger | ne remplace pas la comptabilité SYSCOHADA |
| Charge active | colis actifs par livreur à un instant de référence | indicateur instantané, pas mensuel |
| Utilisation de capacité | somme des colis confiés / somme des capacités déclarées sur les tournées commencées | ne signifie pas productivité individuelle |
| Couverture GPS exploitable | positions fraîches et d'une précision acceptable / positions attendues pendant les périodes de service | KPI de qualité technique, jamais de mérite |
| Destination vérifiée | commandes avec coordonnées et repère confirmés / commandes créées | mesure de qualité du processus |

### KPI CRM

| KPI | Définition |
|---|---|
| Conversion demande → commande | demandes converties / demandes arrivées à une décision finale pour la cohorte de création |
| Délai de première prise en charge | médiane et P90 entre soumission et première interaction interne ou validation |
| Demandes à compléter | demandes actives marquées `Informations à compléter`, avec ancienneté |
| Clients récurrents | clients ayant au moins deux commandes sur les 12 derniers mois / clients ayant au moins une commande, après rapprochement vérifié |
| Taux de contact utile | interactions sortantes avec résultat `joint` ou `information_reçue` / interactions sortantes tentées |
| Réclamations pour 100 remises | clients ayant ouvert une réclamation / commandes livrées, sur une fenêtre de rattachement définie |
| Réutilisation d'un lieu vérifié | commandes utilisant un `customer_location_id` déjà validé / commandes de clients existants |
| Qualité des fiches | fiches actives possédant au moins un contact utilisable et un lieu ou une commande récente / fiches actives |

La « valeur client » monétaire ou le ciblage marketing ne sont pas inclus dans le premier CRM. Ils nécessitent une finalité, des règles de consentement et un cadrage commercial séparés.

### Analyse des livreurs : utile, contextualisée et contestable

Indicateurs autorisés pour le pilotage :

- volume affecté, pris en charge et livré ;
- résultats par cause vérifiée ;
- ponctualité uniquement sur créneaux structurés et avec contexte de dispatch ;
- durée médiane/P90 par zone ou type de tournée ;
- incidents par catégorie, en séparant déclarés, vérifiés et résolus ;
- écarts d'encaissement et leur résolution ;
- preuves requises complétées ;
- charge/capacité et réaffectations décidées par l'exploitation ;
- qualité de synchronisation GPS et nombre d'événements manquants comme données techniques.

Garde-fous :

- pas de note globale, podium, classement ou code couleur « bon/mauvais » ;
- pas de sanction, suspension ou baisse d'affectation automatique ;
- pas d'inférence de faute à partir d'une anomalie GPS, d'une vitesse, d'un retard ou d'une plainte non vérifiée ;
- pas de collecte hors période de service déclarée ;
- pas de KPI « temps immobile », « détours suspects », « vitesse moyenne » ou « heures connectées » sans finalité séparée, nécessité démontrée et validation juridique ;
- afficher le volume et la couverture avec chaque pourcentage ;
- afficher « échantillon insuffisant » sous 20 livraisons éligibles pour une comparaison individuelle ;
- ne comparer à une équipe que si le groupe possède au moins cinq livreurs éligibles ;
- permettre l'ouverture des opérations sources et la correction factuelle ;
- journaliser qui consulte ou exporte une analyse individuelle détaillée ;
- soumettre toute décision importante à une revue humaine documentée.

Une vue « causes contributives » doit distinguer au minimum : client injoignable, adresse/repère, dispatch ou changement de tournée, véhicule, problème technique/GPS, condition externe, incident colis/paiement et cause inconnue.

## Tableaux de bord mensuels

### Tableau « Direction opérationnelle »

- cartes : commandes, prises en charge, remises, retours, annulations, incidents ouverts ;
- volumes par semaine et issue ;
- taux de remise avec numérateur/dénominateur ;
- délai de confirmation et durée opérationnelle en médiane/P90 ;
- ponctualité et taux de couverture des créneaux ;
- zones avec volume, sans afficher une carte individuelle ;
- charge distribuée par équipe ;
- encaissements attendus, collectés, écarts, remboursements et net ;
- qualité des données : lieux vérifiés, GPS exploitable, champs manquants ;
- comparaison à la période précédente avec valeur absolue et relative.

### Tableau « Expérience client »

- conversion des demandes ;
- ancienneté de la file à vérifier ;
- délai de première prise en charge ;
- contact utile ;
- causes de seconde tentative ;
- réclamations et délai de résolution ;
- récurrence client ;
- zones ou lieux fréquemment difficiles à trouver.

### Tableau « Exploitation livreurs »

- effectif en service et capacité disponible ;
- répartition de charge ;
- progression des tournées ;
- issues et causes par équipe ;
- couverture technique GPS ;
- incidents vérifiés et écarts de paiement ;
- comparaison contextuelle, sans classement individuel.

### Règles graphiques

- titre, période, fuseau, définition et fraîcheur visibles ;
- axe zéro pour les barres, unités explicites, palette accessible et légende textuelle ;
- pas de graphique en secteurs au-delà de quelques catégories ;
- médiane/P90 pour les durées asymétriques ;
- intervalles et volumes plutôt qu'une précision trompeuse ;
- clic sur une valeur vers une liste filtrée des données sources ;
- les petites cellules susceptibles d'identifier une personne sont masquées ou regroupées ;
- les graphiques exportés gardent leur définition et leurs filtres.

## Calcul et fraîcheur des analyses

### Première étape

Calculer à la demande les petits agrégats à partir des tables métier et exposer une vue SQL documentée par famille de KPI.

### Montée en charge

Créer des vues matérialisées mensuelles par `company_id`, date de service, zone et dimensions autorisées. Elles sont régénérables à partir des faits ; elles ne deviennent pas une source de vérité.

- index unique complet requis avant un rafraîchissement concurrent ;
- une seule actualisation d'une même vue à la fois ;
- afficher `data_as_of` et `refreshed_at` ;
- conserver le dernier résultat valide si un rafraîchissement échoue, avec avertissement ;
- ne jamais mélanger deux versions d'une définition de KPI ;
- réconcilier quotidiennement agrégats et tables sources ;
- prévoir une reconstruction complète après correction de données.

Les tableaux quasi temps réel utilisent des requêtes opérationnelles dédiées. Les tendances mensuelles peuvent accepter une fraîcheur de quelques minutes ou un rafraîchissement planifié.

## Contrat d'export

### Principes communs

Un export est une photographie cohérente, pas une succession de pages susceptibles de changer pendant la génération.

Chaque demande d'export contient :

- entreprise et utilisateur ;
- rôle et profil d'export autorisé ;
- vue, filtres, tris, colonnes et fuseau ;
- borne temporelle et signification de la date ;
- `as_of` serveur ;
- version des KPI et du schéma d'export ;
- clé d'idempotence ;
- format et langue.

La génération utilise un instantané cohérent (`REPEATABLE READ` ou mécanisme équivalent), un tri stable avec identifiant en dernier critère et une pagination par curseur. Le manifeste final donne le nombre de lignes par feuille, les exclusions, les colonnes masquées, l'heure de génération et une empreinte SHA-256.

Les fichiers sont temporaires, privés, téléchargés par une URL courte et à usage contrôlé. Le fichier expire au plus tard après sept jours, avec 24 heures comme valeur par défaut. Son journal d'export persiste selon la politique d'audit.

### XLSX — format principal pour l'humain

Format Office Open XML `.xlsx`, sans macro, formule, lien externe ni contenu actif.

Feuilles possibles :

1. `Manifeste` ;
2. `Clients` ;
3. `Contacts` ;
4. `Lieux` ;
5. `Commandes` ;
6. `Tentatives` ;
7. `Interactions` ;
8. `Incidents` ;
9. `Paiements` ;
10. `Livreurs_KPI` ;
11. `Definitions_KPI`.

Règles :

- une ligne d'en-tête figée, filtre automatique et types de cellules explicites ;
- identifiants, téléphones et codes comme texte pour préserver zéros et grands nombres ;
- dates comme vraies dates avec colonne de fuseau, plus valeur ISO 8601 dans le manifeste ;
- montants numériques accompagnés de la devise et de la règle d'unité ;
- toutes les entrées utilisateur écrites comme cellules texte, jamais comme formules ;
- aucune photo/signature binaire, aucun OTP, aucun token, aucun secret, aucune clé d'idempotence ;
- aucune position GPS brute par défaut ; un export probatoire distinct suit les permissions du dossier d'incident ;
- colonnes et feuilles absentes plutôt que vides lorsque le rôle ne les autorise pas ;
- si une feuille dépasse la limite du tableur, découpage déterministe et signalé dans le manifeste ;
- validation du classeur généré par réouverture automatique avant mise à disposition.

### CSV — une vue ou une entité par fichier

Le CSV suit le format commun RFC 4180 : `text/csv`, UTF-8, en-tête présent, fins de ligne CRLF, virgule comme séparateur, champs contenant virgule/guillemet/saut de ligne entourés de guillemets et guillemets internes doublés.

Pour les utilisateurs francophones d'Excel, le produit recommande XLSX afin d'éviter les ambiguïtés de séparateur régional. Une éventuelle variante « CSV Excel » est nommée explicitement et testée séparément.

Protection contre l'injection de formules :

- toute donnée issue d'un client, utilisateur, import ou fournisseur est non fiable ;
- détecter après espaces de tête les préfixes `=`, `+`, `-`, `@`, tabulation, retour chariot, saut de ligne et variantes Unicode pleine largeur ;
- entourer chaque valeur textuelle de guillemets et doubler les guillemets internes ;
- neutraliser les cellules dangereuses avec une stratégie documentée et testée dans Excel et LibreOffice ;
- inscrire la stratégie et sa version dans le manifeste ;
- ne jamais proposer un mode CSV « brut et ouvrable dans Excel » ; aucune stratégie n'est universelle pour tous les tableurs et tous les réimports.

### Profils d'export

- `operational_summary` : commandes, statuts, zones, tournées et agrégats sans coordonnées brutes ;
- `customer_crm` : clients, contacts et lieux selon permission ;
- `finance_reconciliation` : paiements et ajustements, propriétaire/manager ;
- `driver_activity` : indicateurs contextualisés, propriétaire/manager ;
- `incident_dossier` : export probatoire existant et séparé ;
- `anonymized_analytics` : agrégats sans identifiants directs.

Un export personnalisé ne peut sélectionner que les colonnes permises par le profil et le rôle.

## Rôles et permissions

| Fonction | Propriétaire | Manager | Opérateur | Livreur | Admin plateforme |
|---|---:|---:|---:|---:|---:|
| Consulter clients/commandes de l'entreprise | oui | oui | oui | seulement ses commandes dans `/driver` | non par défaut |
| Modifier contacts et lieux | oui | oui | oui | non | non |
| Fusionner/archiver un client | oui | oui | non | non | non |
| Ajouter une interaction | oui | oui | oui | incident/action terrain seulement | non |
| Voir tableaux agrégés | oui | oui | vue opérationnelle limitée | vue personnelle éventuelle | métadonnées plateforme seulement |
| Voir analyse individuelle livreur | oui | oui | non par défaut | seulement ses propres faits validés | non |
| Export opérationnel filtré | oui | oui | option accordée par l'entreprise | non | non |
| Export CRM avec contacts | oui | oui | non par défaut | non | non |
| Export financier | oui | oui | non | non | non |
| Configurer KPI/rétention/permissions | oui | proposition possible | non | non | support technique sans contenu |
| Consulter un dossier d'incident complet | oui | oui | selon attribution | déclaration propre limitée | accès exceptionnel contrôlé |

L'admin plateforme n'obtient pas un accès général aux données métier. Un futur accès de support « bris de glace » exige motif, durée courte, approbation, bannière visible et audit renforcé.

Toutes les permissions sont appliquées par l'API. PostgreSQL Row-Level Security pourra fournir une défense supplémentaire avec un rôle applicatif non propriétaire et une politique par entreprise ; elle ne remplace pas les contrôles applicatifs ni les tests croisés.

## Traçabilité et reconstitution

Événements à auditer :

- création, modification, archivage et fusion client ;
- création ou modification d'un contact et changement `do_not_contact` ;
- modification d'un lieu ou de ses coordonnées ;
- import et résolution de doublons ;
- création, modification et partage d'une vue ;
- consultation détaillée d'une analyse individuelle sensible ;
- génération, téléchargement, expiration ou échec d'un export ;
- modification d'une définition de KPI ou d'une politique de conservation ;
- accès exceptionnel de support.

Chaque événement indique qui, quand, sur quelle entreprise, quelle action, quel objet, quel résultat et une corrélation technique. Les valeurs sensibles sont masquées ; mots de passe, tokens, OTP et secrets ne sont jamais journalisés.

Les journaux d'audit, événements métier et journaux techniques restent séparés selon leur finalité. Les traces sont protégées contre la modification, leurs accès sont eux-mêmes contrôlés et leur horloge serveur est la référence.

## Minimisation et conservation

### Matrice de départ à valider

| Catégorie | Finalité | Proposition initiale | Fin de durée |
|---|---|---:|---|
| Demande non convertie | préparer une commande | 90 jours après refus/expiration | suppression ou anonymisation |
| Contact et lieu client actif | exécuter et simplifier les livraisons | relation active puis revue à 24 mois sans activité | archivage puis suppression/anonymisation |
| Commande et événements | exécution, facturation, preuve | politique contractuelle/légale configurée | anonymisation sélective si possible |
| Position GPS brute | opération en cours et reconstitution limitée | 30 jours par défaut ; extension documentée, jamais indéfinie | purge ou agrégation |
| Agrégats GPS techniques | qualité du service | 12 mois sans trajectoire détaillée | agrégation/anonymisation |
| Interaction résumée | coordination et service client | 24 mois après dernière activité, à valider | suppression/anonymisation |
| Contenu de communication probatoire | litige précis | durée du dossier ou du gel | suppression après décision |
| Preuve photo/signature | remise/litige | selon politique de preuve, accès restreint | purge du binaire, empreinte selon politique |
| Incident et paiement | preuve et rapprochement | obligations applicables + gel éventuel | archivage/purge contrôlée |
| Fichier d'export | transfert ponctuel | 24 h par défaut, 7 jours maximum | suppression automatique |
| Journal d'export | responsabilité | 12 mois proposés, à valider | purge contrôlée |
| KPI agrégé | pilotage | 24 mois ou besoin justifié | agrégation plus large/anonymisation |

Un gel actif sur une commande suspend toute purge liée au dossier. Il ne justifie pas la conservation illimitée de données sans rapport avec le litige.

Avant mise en production : documenter responsable de traitement/sous-traitants, finalités, base légale, catégories de personnes, destinataires, transferts, durées, sécurité, droits et formalités APDP applicables. Les livreurs doivent être informés clairement de la géolocalisation, de ses horaires, finalités, destinataires, durées et mécanismes de contestation.

## Erreurs et cas limites

### Données CRM

- deux clients portent le même nom ou partagent un téléphone ;
- numéro réattribué, format local incomplet ou indicatif absent ;
- client organisation avec plusieurs destinataires ;
- lieu très proche mais distinct ; coordonnées en mer ou hors zone ;
- correction d'un lieu après une ancienne livraison ;
- client archivé encore référencé par une commande active ;
- fusion concurrente, fusion erronée ou fiche déjà absorbée ;
- interaction reçue deux fois par webhook ;
- message externe sans client identifiable ;
- champ libre contenant données sensibles ou injures ;
- import comportant colonnes inconnues, valeurs invalides ou doublons.

Réponse attendue : prévisualisation, avertissement explicite, aucune fusion silencieuse, transaction atomique, idempotence et possibilité de revenir à la source.

### KPI

- dénominateur nul ;
- données trop peu nombreuses ;
- créneau absent ou textuel ;
- événement manquant, horodatage futur ou ordre temporel impossible ;
- commande créée un mois et clôturée le mois suivant ;
- changement de fuseau de l'entreprise ;
- incident avec plusieurs catégories ;
- position GPS ancienne, imprécise ou aberrante ;
- changement de livreur ou de tournée pendant l'exécution ;
- retard causé par le client, le dispatch ou un événement externe ;
- correction rétroactive après publication d'un rapport ;
- rafraîchissement analytique partiel ou échoué.

Réponse attendue : exclure selon une règle versionnée, afficher couverture et fraîcheur, ne pas transformer l'inconnu en zéro, puis recalculer de façon reproductible.

### Exports

- zéro ligne ;
- millions de lignes ou dépassement d'une feuille ;
- téléchargement relancé après expiration ;
- permission retirée pendant la génération ;
- nom de fichier ou de feuille invalide ;
- accents, emoji, apostrophes, virgules, guillemets et sauts de ligne ;
- téléphone commençant par zéro ;
- identifiant numérique trop long pour Excel ;
- texte commençant par `=`, `+`, `-`, `@`, tabulation ou variante pleine largeur ;
- export concurrent en double ;
- erreur après création partielle ;
- changement des données pendant l'export ;
- absence d'espace temporaire ou bibliothèque XLSX en erreur.

Réponse attendue : tâche idempotente, état visible, fichier jamais publié avant validation complète, nettoyage des fragments, message exploitable, journal d'échec sans contenu sensible.

## Plan de tests

### Modèle et isolation

- créer deux entreprises avec clients, téléphones et lieux identiques ; vérifier l'absence de collision et de fuite ;
- tenter chaque relation croisée par identifiant entre entreprises ;
- vérifier qu'un téléphone partagé ne bloque pas la création mais produit une suggestion ;
- fusionner deux clients, contrôler les alias et empêcher la perte de commandes ;
- modifier un lieu et vérifier l'immuabilité de l'instantané d'une commande passée ;
- archiver puis restaurer une fiche encore référencée ;
- répéter webhooks et mutations avec la même clé d'idempotence ;
- provoquer deux modifications concurrentes et obtenir un conflit lisible.

### Autorisations

- tester chaque cellule de la matrice des rôles côté API, pas seulement dans l'interface ;
- vérifier qu'un opérateur ne récupère pas les colonnes cachées dans la réponse réseau ;
- vérifier qu'un livreur n'accède qu'à ses objets terrain ;
- vérifier que l'admin plateforme n'accède pas par défaut au contenu métier ;
- journaliser fusion, export, analyse individuelle et accès exceptionnel ;
- vérifier que la révocation d'un rôle s'applique à une tâche d'export encore en attente.

### Vues et recherche

- combiner filtres, tris, groupements et pagination sans doublon ni omission ;
- revenir d'une fiche en conservant la vue ;
- ouvrir une vue partagée avec un rôle plus faible et recalculer les colonnes autorisées ;
- supprimer ou renommer un champ utilisé par une vue ;
- tester valeurs nulles, accents, noms similaires et grands volumes ;
- vérifier qu'aucun fragment de filtre n'est interprété comme SQL.

### KPI et graphiques

- construire un jeu de données connu et recalculer chaque numérateur/dénominateur manuellement ;
- tester période vide, borne exacte de minuit et fin exclusive ;
- tester une commande traversant deux mois ;
- tester fuseau `Africa/Porto-Novo` puis un fuseau différent ;
- tester médiane et P90 sur effectifs pairs, impairs et valeurs extrêmes ;
- vérifier exclusions, couverture, taille d'échantillon et `Non calculable` ;
- vérifier qu'une anomalie GPS n'est jamais comptée comme faute ;
- comparer agrégat matérialisé et requête source ;
- interrompre un rafraîchissement puis conserver le dernier résultat avec avertissement ;
- changer une définition et vérifier la coexistence des versions ;
- depuis chaque graphique, retrouver exactement les lignes sources autorisées.

### XLSX

- ouvrir automatiquement le classeur généré et valider sa structure Open XML ;
- vérifier feuilles, en-têtes, types, dates, devises, filtres, lignes et manifeste ;
- vérifier que téléphones et grands identifiants restent du texte ;
- injecter des cellules malveillantes et confirmer l'absence de formule, macro et lien externe ;
- tester Excel et LibreOffice avec accents, emoji, apostrophes et sauts de ligne ;
- vérifier qu'une feuille interdite n'existe pas pour un rôle insuffisant ;
- comparer nombre de lignes, filtres et empreinte au manifeste ;
- simuler dépassement de feuille, interruption et nettoyage des fragments.

### CSV

- valider en-tête, UTF-8, CRLF, virgules, guillemets doublés et champs multilignes selon RFC 4180 ;
- tester toutes les amorces de formule OWASP, espaces de tête et variantes Unicode ;
- ouvrir dans Excel et LibreOffice sans exécution de formule ;
- réimporter avec un parseur CSV standard et documenter la neutralisation ;
- vérifier type MIME, nom, encodage et absence de secrets ;
- confirmer que le CSV respecte exactement la vue et les colonnes autorisées.

### Conservation et litiges

- purger une demande expirée sans affecter une commande ;
- purger les GPS bruts tout en conservant les agrégats autorisés ;
- activer un gel et vérifier l'exclusion de toutes les purges liées ;
- lever le gel avec motif puis reprendre le cycle normal ;
- expirer un fichier d'export et conserver uniquement son audit ;
- vérifier la reconstitution d'un incident à partir des événements et empreintes.

## Phases d'implémentation

### Phase CRM-0 — gouvernance et dictionnaire

- valider les finalités, rôles, durées et formalités APDP ;
- figer le dictionnaire des statuts, causes et KPI version 1 ;
- définir les profils d'export ;
- créer les jeux de données de référence et tests croisés.

Critère de sortie : chaque champ personnel et chaque KPI possède une finalité, un propriétaire et une durée.

### Phase CRM-1 — fondations clients

- ajouter clients, contacts, lieux et révisions ;
- relier demandes/commandes avec instantanés historiques ;
- recherche et suggestions de doublon ;
- archivage et fusion auditée ;
- import limité avec prévisualisation.

Critère de sortie : aucune ancienne commande ne change lors d'une correction de fiche et aucun doublon n'est fusionné sans humain.

### Phase CRM-2 — interface opérationnelle

- pages séparées, grille, fiche liée, filtres, tris et colonnes ;
- vues enregistrées personnelles puis partagées ;
- calendrier, Kanban limité et carte des lieux ;
- actions en masse sûres ;
- permissions par champ/profil.

Critère de sortie : un opérateur retrouve un client, son lieu et l'historique utile sans accéder aux données interdites.

### Phase CRM-3 — interactions et tentatives

- journal d'interactions ;
- relances et responsables ;
- idempotence WAHA/n8n sans automatisation commerciale ;
- tentatives structurées et causes ;
- droit de correction et revue des faits.

Critère de sortie : la réussite au premier passage et les causes peuvent être calculées sans interpréter du texte libre.

### Phase CRM-4 — analyses versionnées

- vues analytiques source ;
- dictionnaire de KPI visible ;
- tableaux mensuels et exploration vers les lignes ;
- fraîcheur, couverture et comparaisons ;
- garde-fous sur petits échantillons et analyses livreurs.

Critère de sortie : un échantillon est recalculable manuellement et aucun écran ne classe automatiquement les livreurs.

### Phase CRM-5 — exports fiables

- tâches d'export asynchrones et idempotentes ;
- XLSX multi-feuilles sans contenu actif ;
- CSV RFC 4180 neutralisé ;
- manifeste, empreinte, expiration et audit ;
- tests Excel/LibreOffice et gros volumes.

Critère de sortie : lignes, filtres, permissions et empreinte correspondent au manifeste, y compris après reprise.

### Phase CRM-6 — performance et optimisation

- mesures de requêtes et index par entreprise/période ;
- vues matérialisées seulement pour les agrégats coûteux ;
- rafraîchissement concurrent contrôlé ;
- cache privé par entreprise et invalidation ;
- limites, quotas et observabilité des exports ;
- revue d'usage avec une entreprise pilote et des livreurs informés.

Critère de sortie : les écrans prioritaires restent rapides sur le volume cible sans masquer une donnée périmée.

### Phase CRM-7 — conservation automatisée

- politiques configurées et approuvées ;
- prévisualisation de purge ;
- anonymisation, purge, gels et rapports ;
- tests de restauration et preuve de suppression ;
- revue périodique des accès et finalités.

Critère de sortie : aucune catégorie personnelle n'est conservée indéfiniment par défaut et un gel reste respecté.

## Définition de terminé du lot complet

- isolation multi-entreprise testée systématiquement ;
- relations clients/contacts/lieux/commandes cohérentes et historisées ;
- vues utilisables sur mobile et ordinateur, avec erreurs et reprises ;
- KPI versionnés, explicables, contextualisés et explorables ;
- aucun score ou classement automatique des livreurs ;
- export XLSX et CSV validé contre contenus malveillants ;
- permissions de colonnes et audit des exports testés ;
- durées, purge, anonymisation et gels documentés ;
- documentation d'exploitation et de restauration mise à jour avant déploiement ;
- validation pilote avec au moins un responsable d'exploitation et plusieurs livreurs.

## Références officielles et primaires consultées

- APDP Bénin, Code du numérique, Livre V : minimisation, protection par défaut, confidentialité et obligations du responsable : <https://apiprod.apdp.bj/storage/c46ab3f55e93d40c8545b70add0ea8c7/CODE-DU-NUMERIQUE-DU-BENIN_2018-version-APDP.pdf>
- APDP Bénin, guide de mise en conformité : minimisation, limitation de conservation, sécurité et registre : <https://archive.apdp.bj/wp-content/uploads/2022/01/GUIDE-DE-MISE-EN-CONFORMITE_Pt_YD_revu.pdf>
- Organisation internationale du Travail, protection des données personnelles des travailleurs : <https://www.ilo.org/resource/other/protection-workers%E2%80%99-personal-data>
- OWASP, CSV Injection : <https://owasp.org/www-community/attacks/CSV_Injection>
- OWASP, Logging Cheat Sheet : <https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html>
- RFC Editor, RFC 4180 — format commun CSV et type MIME : <https://www.rfc-editor.org/info/rfc4180/>
- Ecma International, ECMA-376 / ISO/IEC 29500 — Office Open XML : <https://ecma-international.org/publications-and-standards/standards/ecma-376/>
- Microsoft Learn, structure d'un document SpreadsheetML : <https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document>
- PostgreSQL, Row Security Policies : <https://www.postgresql.org/docs/17/ddl-rowsecurity.html>
- PostgreSQL, vues matérialisées : <https://www.postgresql.org/docs/17/rules-materializedviews.html>
- PostgreSQL, `COPY` et CSV : <https://www.postgresql.org/docs/17/sql-copy.html>
- Airtable, relations entre fiches : <https://support.airtable.com/articles/3370222027-linking-records-in-airtable>
- Airtable, vues et export CSV : <https://support.airtable.com/articles/5189551686-getting-started-with-airtable-views>

Ces références guident la conception. La conformité finale dépend des traitements réellement activés, des contrats, du pays d'activité et des formalités applicables.
