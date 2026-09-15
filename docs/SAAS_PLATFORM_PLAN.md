# Plan de plateforme SaaS multi-entreprises

## Objet et périmètre

Ce document définit l'architecture cible de la plateforme de suivi de livraison pour plusieurs entreprises. Il couvre l'onboarding, les identités et rôles, l'isolement des données, les offres et quotas, l'abonnement, la suspension sans perte, l'accès contrôlé à Traccar, l'assistance au démarrage, l'audit et la réversibilité hors Railway.

Il ne décrit pas une migration SQL prête à exécuter et ne contient aucun secret. Les valeurs commerciales, juridiques et de conservation encore inconnues sont signalées comme décisions à prendre.

## Résumé exécutif

Architecture recommandée pour le pilote :

- conserver un **monolithe modulaire** `delivery-app` et une base métier PostgreSQL `delivery` ;
- faire de `delivery` la source de vérité des entreprises, abonnements, droits, opérations et audits ;
- garder Traccar comme moteur GPS, accessible uniquement côté serveur ;
- utiliser une identité globale par personne et des appartenances séparées à chaque entreprise ;
- appliquer l'isolement par `company_id` dans l'API, les contraintes SQL et, après préparation, PostgreSQL Row-Level Security en défense supplémentaire ;
- commencer par un onboarding assisté des premières entreprises, avec des accès support temporaires et audités ;
- proposer au départ un abonnement mensuel simple avec limites incluses, sans tarification à l'usage automatisée ;
- découpler les droits du fournisseur de paiement : un événement de paiement met à jour une projection locale, mais ne donne jamais directement accès aux fonctions ;
- ne jamais supprimer les données lors d'un impayé : passer progressivement de l'avertissement au blocage de nouvelles opérations, tout en permettant de terminer les livraisons actives, payer, exporter et réactiver ;
- automatiser des sauvegardes portables et tester régulièrement une restauration hors Railway.

Le modèle proposé évite les microservices et l'event sourcing complets à ce stade. Des journaux append-only ciblés et une file de traitements asynchrones suffisent jusqu'à ce que la charge ou l'équipe justifie une séparation.

## Diagnostic de l'existant

### Fondations déjà présentes

- `companies`, `users`, `company_memberships` et des sessions séparées entreprise/plateforme existent.
- Les rôles actuels sont `owner`, `manager`, `operator` et `driver`.
- Les principales lectures et écritures métier filtrent déjà par `company_id`.
- Le rôle livreur est également borné par `driver_id`.
- Les invitations sont temporaires, à usage unique et auditées.
- Les événements de commande, paiement, incident et tournée disposent déjà de mécanismes append-only et d'idempotence.
- `/app` est l'espace entreprise, `/driver` l'espace terrain et `/admin` l'espace plateforme.
- Les identifiants Traccar restent côté serveur.

### Écarts à corriger avant un SaaS commercial

1. Il n'existe pas encore de tables ni de règles pour plans, abonnements, droits, quotas, factures ou suspensions.
2. `/admin` authentifie un administrateur plateforme mais ne constitue pas encore une console de gestion SaaS.
3. Un utilisateur ayant plusieurs appartenances serait connecté automatiquement à la première entreprise trouvée. Il faut un sélecteur d'entreprise et un changement de contexte explicite.
4. Le parcours d'invitation doit permettre d'ajouter une appartenance à un utilisateur déjà existant, après authentification ou confirmation forte, au lieu de créer une deuxième identité.
5. Les contrôles `company_id` sont surtout applicatifs. Certaines relations SQL référencent un objet par son seul identifiant ; des clés étrangères composites doivent aussi garantir que l'objet lié appartient à la même entreprise.
6. La suppression en cascade depuis `companies` serait dangereuse pour l'audit et la suspension. Une entreprise ne doit pas être supprimable par les parcours normaux ; elle change d'état puis suit une procédure d'archivage contrôlée.
7. L'application utilise des identifiants Traccar globaux. Il manque un registre de provisionnement, de permissions et de réconciliation par entreprise.
8. Les tables sont créées au démarrage de l'application. Avant la commercialisation, les évolutions doivent passer par des migrations versionnées, réversibles lorsque possible et testées sur une copie.
9. Les mots de passe sont dérivés côté application, mais l'algorithme et ses paramètres doivent être vérifiés contre les recommandations OWASP, avec une trajectoire vers Argon2id et une migration progressive des anciennes empreintes.
10. Le cookie `SameSite=Lax` est une défense utile, mais ne remplace pas une protection CSRF complète pour les actions authentifiées.

## Architecture cible

```text
Clients web/mobile
  ├─ Espace entreprise /app
  ├─ Portail livreur /driver
  ├─ Liens client /demande et /suivi
  └─ Console plateforme /admin
             │
             ▼
delivery-app — monolithe modulaire
  ├─ Identités et appartenances
  ├─ Opérations de livraison
  ├─ Abonnements, droits et quotas
  ├─ Provisionnement GPS
  ├─ Support et audit
  └─ Adaptateurs paiement / messagerie / export
             │
     ┌───────┼──────────────┐
     ▼       ▼              ▼
PostgreSQL  Traccar API     File asynchrone
delivery    côté serveur    Redis/n8n si nécessaire
```

### Frontières de responsabilité

| Composant | Source de vérité | Ne doit pas devenir |
|---|---|---|
| `delivery` | entreprises, utilisateurs, abonnements, droits, commandes, preuves, audit | une copie des tables internes Traccar |
| Traccar | appareils, positions et événements GPS | l'interface commerciale ou la base métier |
| Fournisseur de paiement | paiements, factures et événements financiers qu'il traite | l'autorité directe d'accès à l'application |
| n8n/WAHA | orchestration et communication | le stockage principal des clients ou commandes |
| Railway | hébergement actuel et secrets d'environnement | une dépendance impossible à remplacer |

### Modules internes recommandés

1. `identity` : utilisateurs, sessions, MFA, récupération de compte.
2. `tenancy` : entreprises, appartenances, rôles, sélection du contexte.
3. `operations` : demandes, commandes, tournées, livreurs, preuves et incidents.
4. `entitlements` : plans versionnés, droits, quotas et compteurs.
5. `billing` : abonnements, factures locales, événements fournisseur et rapprochement.
6. `tracking` : registre Traccar, permissions, positions autorisées et réconciliation.
7. `support` : onboarding assisté, accès temporaires et interventions.
8. `audit` : journal sécurité/métier et exports contrôlés.

Les modules restent dans le même déploiement et communiquent par fonctions et transactions explicites. Une file asynchrone n'est introduite que pour les traitements pouvant être rejoués : webhooks, notifications, exports volumineux et réconciliation Traccar.

## Modèle multi-entreprises et isolement

### Identité et contexte actif

- `users` représente une personne globale ; l'e-mail normalisé peut rester unique.
- `company_memberships` représente ses droits dans une entreprise.
- Une même personne peut avoir plusieurs appartenances sans dupliquer son mot de passe.
- Après connexion, une appartenance unique ouvre directement l'entreprise ; plusieurs appartenances affichent un sélecteur.
- Le changement d'entreprise crée ou renouvelle une session avec un `active_company_id` validé côté serveur.
- Aucun endpoint métier n'accepte un `company_id` fourni par le navigateur comme autorité. L'entreprise vient de la session et de l'appartenance active.
- Les rôles plateforme sont distincts des rôles entreprise et ne sont jamais déduits d'une appartenance.

### Défenses cumulatives

1. **API** : refus par défaut, contrôle de session, rôle et propriété de l'objet à chaque requête.
2. **Requêtes SQL** : toutes les opérations métier incluent le `company_id` de la session.
3. **Contraintes SQL** : relations sensibles avec clés composites, par exemple `(company_id, driver_id)` vers `drivers(company_id, id)`.
4. **RLS PostgreSQL** : défense supplémentaire après création d'un rôle SQL d'exécution non propriétaire et sans `BYPASSRLS`.
5. **Tests inter-entreprises** : chaque endpoint est testé avec un identifiant valide appartenant à une autre entreprise.

PostgreSQL applique un refus par défaut lorsqu'une table a RLS activé sans politique applicable. Cependant, le propriétaire de la table et les rôles `BYPASSRLS` peuvent contourner RLS. La cible doit donc séparer :

- le rôle de migration, propriétaire des objets ;
- le rôle d'exécution, non propriétaire, soumis à `FORCE ROW LEVEL SECURITY` ;
- le rôle de sauvegarde, explicitement contrôlé pour produire un dump complet.

Avec un pool de connexions, le contexte d'entreprise doit être posé par transaction avec une valeur locale, puis disparaître à la fin de la transaction. Aucun contexte de locataire ne doit survivre au retour d'une connexion dans le pool.

### Stratégie de données

Le modèle recommandé reste **base partagée, schéma partagé, `company_id` obligatoire**. C'est le meilleur compromis pour le pilote et une petite équipe. Une base dédiée par entreprise ne sera envisagée que pour une obligation contractuelle, réglementaire ou un très grand client.

Les données globales autorisées sans `company_id` doivent être rares et documentées : catalogue de plans, versions de fonctionnalités, pays/devises et événements techniques plateforme.

## Onboarding des entreprises

### Choix recommandé pour le pilote

Onboarding **assisté** pour les 5 à 10 premières entreprises, puis passage progressif au libre-service. Deux ou trois personnes peuvent accompagner la configuration, mais elles ne partagent jamais de mot de passe et n'utilisent pas le compte du client.

### Parcours cible

1. **Prospect qualifié** : raison sociale, contact, pays, fuseau, devise, volume estimé, type de flotte.
2. **Création de l'organisation** : état `onboarding`, identifiant public non séquentiel et propriétaire désigné.
3. **Vérification du propriétaire** : e-mail vérifié, mot de passe robuste, acceptation des conditions et de la politique de confidentialité ; MFA exigée pour propriétaire et plateforme avant lancement payant.
4. **Choix de l'offre** : essai ou offre contractualisée ; limites affichées avant activation.
5. **Configuration métier** : horaires, zones, types de preuve, politique d'encaissement et conservation.
6. **Provisionnement Traccar** : espace logique, appareils autorisés, test d'une position et vérification de fraîcheur.
7. **Équipe** : invitations des responsables, opérateurs et livreurs ; aucun mot de passe partagé.
8. **Test guidé** : demande client, affectation, tournée, preuve, incident et export.
9. **Validation de mise en service** : checklist signée, contact support et rappel des responsabilités liées aux données de localisation.
10. **Passage à `active`** : activation des droits correspondant au plan.

### États d'onboarding

`lead` → `invited` → `identity_verified` → `configuring` → `pilot_ready` → `active`

États de sortie : `abandoned`, `rejected`, `duplicate`. Une reprise doit continuer à la dernière étape confirmée sans recréer l'entreprise, les appareils ou les invitations.

### Données minimales à collecter

- identité légale et nom commercial ;
- pays, fuseau, devise et langue ;
- contact propriétaire et contact facturation ;
- finalités de suivi, durée de conservation et responsable de traitement ;
- nombre prévu de comptes, livreurs, appareils et livraisons ;
- acceptation versionnée des documents contractuels.

Ne pas collecter pendant l'onboarding une pièce ou une donnée personnelle qui n'est pas nécessaire au contrat ou à la conformité retenue.

## Comptes, rôles et permissions

### Rôles entreprise proposés

| Action | Propriétaire | Gestionnaire | Opérateur | Finance/auditeur | Livreur |
|---|:---:|:---:|:---:|:---:|:---:|
| Paramètres légaux, offre et facturation | Oui | Lecture | Non | Lecture factures | Non |
| Inviter/révoquer un gestionnaire | Oui | Non | Non | Non | Non |
| Gérer opérateurs et livreurs | Oui | Oui | Non | Non | Non |
| Créer demandes, commandes et tournées | Oui | Oui | Oui | Lecture | Non |
| Affecter et réordonner une tournée | Oui | Oui | Oui | Non | Ses arrêts seulement |
| Clôturer un écart financier | Oui | Oui | Non | Oui si mandaté | Déclaration seulement |
| Ouvrir/traiter un incident | Oui | Oui | Oui | Lecture | Sur ses commandes |
| Geler une conservation ou exporter un dossier | Oui | Oui | Non | Oui si mandaté | Non |
| Export CRM global | Oui | Oui | Selon politique | Oui | Non |
| Voir la flotte | Oui | Oui | Oui | Non | Sa position et sa tournée |

Le rôle `operator` actuel peut être conservé pendant le pilote. Les rôles `finance` et `auditor` ne doivent être ajoutés qu'avec une matrice d'endpoints et des tests dédiés. Les permissions critiques restent côté serveur même si les boutons sont masqués.

### Rôles plateforme

- `platform_owner` : configuration globale et gestion des rôles plateforme ; accès très limité en nombre.
- `platform_support` : assistance temporaire, sans facturation ni secrets.
- `platform_billing` : abonnements et rapprochement, sans accès aux positions détaillées ni preuves.
- `platform_security_auditor` : lecture des journaux de sécurité, sans mutation métier.

Une personne ne reçoit pas implicitement tous les privilèges parce qu'elle travaille pour l'opérateur du SaaS.

### Exigences d'authentification

- Argon2id recommandé pour les nouveaux mots de passe ; migration lors de la prochaine connexion si une ancienne empreinte est détectée.
- MFA obligatoire pour plateforme et propriétaires avant commercialisation ; proposée aux gestionnaires.
- rotation de session après connexion, changement d'entreprise, changement de mot de passe, récupération et élévation support ;
- révocation de toutes les sessions après désactivation ou événement à risque ;
- réauthentification pour paiement, changement de propriétaire, export massif, création d'un accès support et suppression programmée ;
- protection CSRF par jeton ou stratégie équivalente, complétée par vérification `Origin`/Fetch Metadata ; `SameSite` seul ne suffit pas ;
- limitation de débit, délai progressif et alertes sur les connexions échouées ;
- réponses de connexion non révélatrices de l'existence d'un compte.

## Plans, droits et quotas

### Modèle recommandé

Commencer avec 2 ou 3 offres mensuelles simples : abonnement fixe + limites incluses. Mesurer l'usage dès le pilote, mais ne pas facturer automatiquement chaque événement avant de disposer de données fiables.

Objets cibles :

- `plans` : identité commerciale stable ;
- `plan_versions` : prix, devise, période et règles immuables pour une cohorte ;
- `features` : droits fonctionnels stables (`advanced_reports`, `evidence_photo`, etc.) ;
- `plan_entitlements` : droits et limites d'une version de plan ;
- `subscriptions` : entreprise, version de plan, état et dates ;
- `subscription_overrides` : dérogations motivées, datées et auditées ;
- `usage_events` : événements idempotents et append-only ;
- `usage_counters` : projection recalculable par entreprise et période ;
- `billing_provider_events` : réception dédupliquée des événements externes.

### Quotas initiaux

| Quota | Unité | Contrôle recommandé |
|---|---|---|
| Membres actifs | nombre | blocage transactionnel d'une nouvelle activation |
| Livreurs actifs | nombre | blocage d'une nouvelle activation, sans désactiver un livreur en tournée |
| Appareils GPS actifs | nombre | blocage du nouveau provisionnement |
| Livraisons créées | mois civil de l'entreprise | alerte à 80 %, dépassement explicite ou blocage des nouvelles créations selon offre |
| Stockage de preuves | octets | alerte, compression, archivage ; ne jamais supprimer silencieusement |
| Conservation GPS/preuves | durée | droit du plan borné par la politique légale de l'entreprise |
| Utilisation WAHA | messages ou conversations | compteur séparé, sans perdre le journal métier si WAHA échoue |

### Règles de quota

- Les limites sont vérifiées dans la même transaction que la création de la ressource.
- Deux requêtes concurrentes ne doivent pas dépasser une limite dure.
- Une baisse de plan n'efface ni ne désactive immédiatement les ressources excédentaires : elle empêche d'en créer de nouvelles et propose une résolution.
- Une livraison déjà active peut toujours être terminée, même si le quota est atteint entre-temps.
- Les compteurs sont recalculables depuis les événements sources et ne constituent pas l'unique preuve de facturation.
- Les dérogations ont un auteur, un motif, une expiration et une limite précise.

## Abonnement et facturation

### Indépendance du fournisseur

Créer un adaptateur de paiement avec des identifiants externes opaques. Le cœur métier ne dépend pas des noms d'état d'un fournisseur. Le fournisseur reste la source de vérité de la transaction qu'il traite ; `delivery` conserve une projection locale vérifiée qui pilote l'accès.

À la date de rédaction, Stripe ne liste pas le Bénin parmi ses pays/régions pris en charge et Paystack propose encore de notifier lors de son lancement au Bénin. En outre, la documentation Paystack des abonnements indique que les récurrences prennent en charge la carte et le prélèvement direct au Nigeria seulement. Le pilote ne doit donc pas dépendre de l'un de ces acteurs sans validation contractuelle du pays, de la devise XOF, des moyens de paiement et des versements.

Approche recommandée :

1. facturation mensuelle assistée avec facture locale et paiement bancaire ou Mobile Money rapproché par un agent autorisé ;
2. moteur interne d'abonnement et de droits identique quel que soit le canal ;
3. intégration ultérieure d'un prestataire disponible au Bénin via l'adaptateur ;
4. automatisation des récurrences seulement après tests de remboursement, échec, doublon, litige et réconciliation.

### États d'abonnement et mode d'accès

| État interne | Signification | Accès produit |
|---|---|---|
| `onboarding` | configuration avant essai | pages de configuration et test limité |
| `trialing` | essai daté | droits du plan d'essai, avertissements avant échéance |
| `active` | abonnement en règle | droits complets du plan |
| `grace` | paiement attendu pendant une tolérance | accès complet temporaire, rappels visibles |
| `restricted` | tolérance dépassée | aucune nouvelle demande/commande/tournée ; terminer l'activité en cours, lire, exporter et payer |
| `paused` | pause contractuelle | aucune nouvelle opération ; lecture, export, facturation et reprise disponibles |
| `cancel_at_period_end` | résiliation programmée | accès normal jusqu'à la date de fin |
| `canceled` | abonnement terminé | lecture/export pendant la fenêtre de sortie ; pas de nouvelle opération |
| `archived` | fenêtre de sortie terminée | accès support contrôlé seulement, selon conservation/anonymisation |

Un état séparé `company_operational_status` (`active`, `restricted`, `security_suspended`, `closed`) traite les suspensions de sécurité, légales ou abusives. Il ne faut pas confondre impayé et incident de sécurité.

### Webhooks et rapprochement

- Vérifier la signature sur le corps brut avant tout traitement.
- Accepter uniquement les types d'événements nécessaires.
- Stocker l'identifiant externe sous contrainte unique et rendre le traitement idempotent.
- Ne pas supposer l'ordre d'arrivée des événements ; récupérer l'objet fournisseur courant si nécessaire.
- Répondre rapidement au fournisseur, puis traiter les effets lourds de façon asynchrone.
- Conserver la version d'API, le type, la date de réception, l'état de traitement et une empreinte ; ne pas journaliser de secret ni de données de carte.
- Exécuter une réconciliation périodique entre abonnements locaux, factures et fournisseur.
- Toute modification manuelle produit un événement, un motif, un auteur et éventuellement une date d'expiration.

## Suspension sans perte

### Principe

Une suspension est un **contrôle d'accès réversible**, pas une suppression. Les données, historiques, preuves et audits restent intacts pendant leur durée de conservation.

### Séquence d'impayé proposée

1. `active` → `grace` après échéance non réglée ; avertir propriétaire et facturation.
2. `grace` → `restricted` après la tolérance décidée ; bloquer les nouvelles opérations.
3. Laisser un mode de vidage opérationnel : terminer les commandes et tournées déjà actives, sans nouvelle affectation.
4. Maintenir les liens clients déjà actifs jusqu'à leur état terminal ou expiration normale.
5. Autoriser connexion, paiement, factures, export et demande d'assistance.
6. À réception vérifiée du paiement, recalculer les droits et revenir à `active` sans reprovisionnement destructif.
7. En cas de résiliation, ouvrir une fenêtre de sortie avant archivage.

### Suspension de sécurité

Une compromission ou un abus peut exiger un blocage immédiat : révocation des sessions, blocage des mutations, arrêt des liens publics concernés et gel des preuves. Cette décision exige un motif, un auteur plateforme autorisé, un ticket, une revue et une procédure de contestation.

### Traccar pendant une suspension

- Ne pas supprimer les appareils ni l'historique.
- En `restricted`, accepter temporairement les positions nécessaires aux livraisons déjà actives.
- En `paused` ou `canceled`, désactiver l'exposition métier et, selon la politique retenue, suspendre le provisionnement ou délier les permissions sans effacer l'appareil.
- La réactivation doit être idempotente et réconcilier automatiquement les permissions attendues.

## Accès contrôlé à Traccar

### Politique par défaut

Les entreprises gèrent leurs opérations dans `/app`. Elles ne reçoivent ni compte administrateur Traccar, ni identifiants techniques globaux, ni accès direct aux autres appareils. `delivery-app` appelle l'API Traccar côté serveur et renvoie seulement les données autorisées.

### Provisionnement cible

Ajouter un registre métier :

- `traccar_tenants` : entreprise, utilisateur/groupe Traccar associé, état et dernière réconciliation ;
- `traccar_device_links` : entreprise, livreur, appareil Traccar, identifiant externe et état ;
- `traccar_provisioning_events` : opération, clé d'idempotence, résultat et erreur non sensible ;
- `traccar_permission_snapshots` : permissions attendues et observées pour détecter les dérives.

Pour chaque entreprise :

1. créer ou associer un utilisateur/groupe Traccar à droits minimaux ;
2. lier seulement ses appareils ;
3. activer `deviceReadonly` lorsque l'entreprise ne doit pas modifier les appareils ;
4. limiter le nombre d'appareils selon le plan ;
5. réconcilier régulièrement utilisateurs, appareils et permissions ;
6. signaler une différence avant de supprimer ou recréer quoi que ce soit.

Traccar précise que partager un objet peut donner des droits étendus sur celui-ci et que l'association à un groupe ne suffit pas à accorder des permissions utilisateur. Les liaisons utilisateur-objet doivent donc être explicites et testées.

### Accès avancé optionnel

Un accès Traccar direct en lecture seule peut devenir une option contractuelle pour un grand compte. Il exige un compte dédié, des appareils explicitement liés, une expiration, aucune administration serveur et des tests inter-entreprises. Il n'est pas recommandé pour le pilote.

### Accès technique du SaaS

- préférer un compte/API technique dédié au lieu d'un administrateur humain partagé ;
- conserver les secrets uniquement dans les variables d'environnement ou un gestionnaire de secrets ;
- documenter création, rotation, révocation et dépendances ;
- imposer HTTPS et réseau privé lorsque disponible ;
- timeouts, reprise progressive et coupe-circuit sur les appels ;
- ne jamais écrire directement dans la base Traccar.

## Support assisté au démarrage

### Modèle d'assistance

Chaque entreprise pilote reçoit :

- un responsable d'onboarding ;
- une checklist de mise en service ;
- une session de formation propriétaire/gestionnaire ;
- un canal de support et des délais annoncés ;
- une revue après les premières livraisons réelles.

### Accès support sécurisé

Ne jamais demander le mot de passe du client. Un agent support utilise son propre compte plateforme et crée un `support_grant` :

- entreprise ciblée ;
- ticket et motif obligatoires ;
- portée précise (`read_operations`, `assist_configuration`, etc.) ;
- lecture seule par défaut ;
- expiration courte, par exemple 30 à 60 minutes ;
- approbation du propriétaire pour les écritures non urgentes ;
- bannière visible « assistance en cours » ;
- journal de chaque consultation et mutation ;
- révocation immédiate possible.

Les opérations financières, exports massifs, preuves privées et positions historiques détaillées nécessitent une permission distincte et une réauthentification. Une élévation d'urgence « break glass » doit alerter le responsable sécurité et être revue après usage.

## Audit et traçabilité

### Événements à journaliser

- connexion, échec, déconnexion, récupération, MFA et révocation de session ;
- création, changement et suppression programmée d'une appartenance ;
- changement de rôle, de plan, de quota ou de dérogation ;
- activation, restriction, suspension, reprise, résiliation et archivage ;
- accès support, élévation et actions réalisées ;
- provisionnement ou changement de permission Traccar ;
- réception et traitement d'un événement de paiement ;
- export, restauration, purge, gel de conservation et migration.

### Contenu minimal

`event_id`, horodatage UTC, `company_id`, acteur réel, rôle, portée support éventuelle, action, type/identifiant d'objet, résultat, motif, identifiant de corrélation, origine et détails minimisés.

Ne pas stocker dans l'audit : mot de passe, cookie, token complet, clé API, code OTP, donnée de carte ou corps binaire de preuve. Les adresses IP et positions étant des données personnelles, leur collecte et leur conservation doivent être justifiées et limitées.

### Propriétés attendues

- écriture append-only pour les événements sensibles ;
- accès en lecture séparé et limité ;
- horodatage fiable ;
- alerte sur modifications de rôles plateforme, exports massifs et accès d'urgence ;
- politique de conservation différente pour audit sécurité, GPS, preuves et facturation ;
- export vérifiable par empreinte pour les dossiers de litige ;
- tests démontrant qu'une panne d'audit ne permet pas silencieusement une opération critique non tracée.

## Réversibilité et migration hors Railway

### Livrables de réversibilité

Le dépôt doit permettre de reconstruire l'environnement sans connaître de secret :

- versions d'exécution et d'images Docker épinglées ;
- migrations SQL ordonnées ;
- manifeste des services, ports, volumes, domaines et noms de variables sans valeurs ;
- procédure d'installation de `delivery-app`, PostgreSQL, Traccar, Redis, n8n et WAHA ;
- procédure de sauvegarde/restauration pour chaque stockage ;
- inventaire des dépendances externes et contrats de données ;
- tests de santé et tests fonctionnels reproductibles ;
- procédure DNS/TLS et retour arrière.

### Sauvegardes recommandées

Railway recommande de combiner sauvegardes de volume, restauration à un instant donné et dumps logiques. Les dumps `pg_dump` au format custom sont portables et restaurables sur un autre fournisseur.

Pour chaque environnement de production :

1. sauvegardes Railway planifiées du volume PostgreSQL ;
2. PITR si le plan et le budget le permettent ;
3. dump logique chiffré et stocké hors Railway pour `delivery` ;
4. dump séparé de la base `traccar` ;
5. export des preuves vers un stockage objet privé et inventaire de leurs empreintes avant montée en charge ;
6. export versionné des workflows n8n sans leurs secrets ;
7. sauvegarde chiffrée de la configuration WAHA conformément à sa procédure, séparée des données métier ;
8. restauration trimestrielle dans un environnement isolé et compte rendu signé.

Objectifs provisoires à décider avant le premier client payant : pilote `RPO ≤ 24 h`, `RTO ≤ 8 h` ; production payante cible `RPO ≤ 1 h`, `RTO ≤ 4 h`.

### Procédure de migration d'hébergeur

1. Geler les changements de schéma et vérifier les sauvegardes.
2. Déployer une cible de test avec les mêmes versions majeures.
3. Restaurer `delivery`, Traccar et les fichiers privés ; exécuter les migrations.
4. Recréer les variables depuis le gestionnaire de secrets, jamais depuis la documentation.
5. Tester isolement, authentification, appareils, positions, commandes, liens publics, preuves, facturation et webhooks.
6. Réduire le TTL DNS et annoncer une fenêtre de bascule.
7. Passer temporairement en mode de vidage ou lecture seule, prendre un dernier delta/dump et basculer.
8. Vérifier les files, compteurs et événements en attente avant réouverture.
9. Garder Railway en retour arrière pendant la période décidée, sans accepter deux sources d'écriture.
10. Détruire l'ancien environnement seulement après validation, délai contractuel et preuve de sauvegarde.

## Échecs et comportements attendus

| Échec | Comportement sûr |
|---|---|
| Invitation répétée ou lien expiré | résultat idempotent ou refus explicite, sans deuxième compte |
| Utilisateur déjà membre d'une autre entreprise | authentifier puis ajouter une appartenance ; proposer le sélecteur |
| `company_id` étranger dans l'URL ou le corps | ignorer comme autorité et répondre sans révéler l'objet |
| Rôle changé pendant une session | relire les droits ; refuser immédiatement et révoquer si nécessaire |
| Deux activations au dernier siège disponible | verrouiller/compter dans une transaction ; une seule réussit |
| Baisse de plan sous l'usage actuel | conserver les données, bloquer les nouvelles créations et guider la résolution |
| Quota atteint pendant une tournée | autoriser la fin de la tournée, refuser seulement une nouvelle opération |
| Webhook invalide | refuser avant traitement et journaliser sans corps sensible |
| Webhook dupliqué ou désordonné | dédupliquer, récupérer l'état courant et recalculer la projection |
| Fournisseur de paiement indisponible | conserver l'état actuel, accepter un rapprochement manuel contrôlé, ne pas suspendre sur simple timeout |
| Paiement reçu pendant suspension | vérifier puis réactiver idempotemment droits et permissions |
| Traccar indisponible | afficher position indisponible/ancienne, ne pas inventer une position et reprendre progressivement |
| Permission Traccar dérivée | alerter, comparer attendu/observé, corriger idempotemment sans suppression automatique |
| Agent support dépasse sa portée | refus côté serveur, alerte et clôture du grant |
| Sauvegarde créée mais jamais restaurée | considérer la sauvegarde non vérifiée et déclencher un exercice |
| Migration partielle | stopper les écritures, conserver une source unique, exécuter le retour arrière documenté |
| Entreprise suspendue | aucune suppression ; lecture, export, paiement et sortie contrôlée restent disponibles |
| Demande de suppression sous gel juridique | maintenir le gel, tracer la demande et soumettre à décision autorisée |

## Séquence d'implémentation

### Lot 0 — Décisions et filet de sécurité

- valider les décisions ouvertes en fin de document ;
- inventorier toutes les tables et routes par entreprise ;
- figer une matrice rôles/endpoints ;
- ajouter staging isolé, sauvegardes et exercice de restauration ;
- définir les migrations versionnées avant tout nouveau schéma SaaS.

**Sortie** : aucune donnée pilote n'est exposée et un retour arrière est démontré.

### Lot 1 — Identité et isolation renforcées

- utilisateur multi-entreprises, invitation d'un compte existant et sélecteur ;
- rôle SQL d'exécution distinct ;
- contraintes composites et tests inter-entreprises exhaustifs ;
- CSRF, rotation de session, MFA plateforme/propriétaire ;
- préparer RLS sur une table pilote avant généralisation.

**Sortie** : aucun identifiant manipulé ne traverse l'isolement, y compris avec concurrence et rôle changé.

### Lot 2 — Onboarding et console plateforme

- états d'onboarding et checklist ;
- création d'entreprise idempotente ;
- pages plateforme entreprises, contacts, santé et historique ;
- accès support temporaires ;
- aucun secret Traccar visible.

**Sortie** : une nouvelle entreprise peut être mise en service puis reprise après interruption sans doublon.

### Lot 3 — Plans, droits et quotas

- catalogue et versions de plans ;
- projection locale de droits ;
- compteurs recalculables ;
- limites transactionnelles et dérogations expirables ;
- messages clairs à 80 %, 100 % et dépassement.

**Sortie** : les droits sont testables indépendamment de tout prestataire de paiement.

### Lot 4 — Provisionnement Traccar par entreprise

- registre, compte/groupe minimal, appareils et permissions ;
- création/reprise idempotentes ;
- tâche de réconciliation et alertes de dérive ;
- suspension/réactivation sans suppression.

**Sortie** : une entreprise ne peut recevoir que les positions de ses appareils.

### Lot 5 — Abonnement et facturation assistée

- états d'abonnement, factures et rapprochement manuel ;
- notifications d'échéance ;
- grâce, restriction et réactivation ;
- journal financier sans données de carte.

**Sortie** : le pilote peut être facturé et réactivé sans dépendance à une récurrence non disponible localement.

### Lot 6 — Adaptateur de paiement automatisé

- choisir un prestataire validé au Bénin ;
- signatures, idempotence, désordre, reprises et réconciliation ;
- environnement de test puis petite cohorte ;
- portail de paiement et factures sans exposition des clés.

**Sortie** : les scénarios succès, échec, doublon, remboursement, contestation et panne sont testés.

### Lot 7 — Audit, export et sortie

- compléter l'audit plateforme et support ;
- export d'entreprise structuré et documenté ;
- conservation, anonymisation, gels et purge contrôlée ;
- exercice complet Railway → autre hébergeur.

**Sortie** : une entreprise peut récupérer ses données et le service peut être restauré ailleurs.

### Lot 8 — Pilote et optimisation

- 5 à 10 entreprises accompagnées ;
- mesurer support, erreurs, quotas et coût par entreprise ;
- revoir les offres sur données réelles ;
- automatiser uniquement les étapes stables ;
- décider si certains modules justifient un service séparé.

## Plan de tests d'acceptation

### Identité et permissions

- compte avec une, deux et aucune appartenance active ;
- ajout d'une entreprise à un utilisateur existant ;
- changement d'entreprise et rotation de session ;
- changement/révocation de rôle pendant une session ;
- MFA, récupération, réauthentification et CSRF ;
- matrice complète rôle × endpoint, refus par défaut compris.

### Isolement

- pour chaque ressource, lecture, écriture, export et téléchargement avec un identifiant d'une autre entreprise ;
- relations composites empêchant d'associer un livreur, appareil, commande ou preuve étranger ;
- RLS avec rôle d'exécution, propriétaire, sauvegarde et pool de connexions ;
- absence de fuite dans erreurs, métriques, recherches, exports, caches et logs.

### Plans et quotas

- changement de version de plan sans modifier l'historique ;
- 80 %, limite exacte, dépassement, baisse de plan et dérogation expirée ;
- deux créations concurrentes sur la dernière unité disponible ;
- fin d'une livraison active malgré quota ou restriction ;
- recalcul des compteurs depuis les événements.

### Abonnement

- essai, fin d'essai, grâce, impayé, restriction, pause, reprise et résiliation ;
- paiement pendant restriction et réactivation unique ;
- webhook signé/invalide, dupliqué, retardé et désordonné ;
- panne du prestataire sans suspension erronée ;
- rapprochement manuel à quatre yeux pour une correction sensible.

### Traccar

- provisionnement répété sans doublon ;
- appareils de deux entreprises et permissions croisées ;
- compte en lecture seule et limites d'appareils ;
- dérive manuelle détectée puis réconciliée ;
- suspension/réactivation ;
- indisponibilité, timeout et position ancienne.

### Support et audit

- grant expiré, révoqué, hors portée et lecture seule ;
- bannière et acteur réel visibles ;
- action d'urgence alertée et revue ;
- aucune donnée secrète dans les événements ;
- export audité et empreinte vérifiée.

### Réversibilité

- restauration de dumps `delivery` et `traccar` dans une cible vide ;
- restauration des preuves et vérification des empreintes ;
- reconstruction à partir du dépôt et des secrets injectés séparément ;
- bascule DNS, absence de double écriture et retour arrière ;
- mesure réelle du RPO/RTO.

## Décisions à prendre

| ID | Décision | Recommandation actuelle | Échéance |
|---|---|---|---|
| D1 | Onboarding assisté ou libre-service | assisté pour 5 à 10 entreprises, puis libre-service progressif | avant le premier nouveau pilote |
| D2 | Identité multi-entreprises | une identité globale, plusieurs appartenances et sélecteur | avant d'inviter un compte existant |
| D3 | Rôles supplémentaires | conserver les quatre rôles actuels, ajouter finance/auditeur seulement avec besoins réels | avant les exports financiers |
| D4 | Modèle tarifaire | forfait mensuel avec limites incluses ; mesurer les dépassements sans les facturer automatiquement au début | avant les contrats pilotes |
| D5 | Prestataire de paiement au Bénin | facturation assistée d'abord ; appel d'offres/validation locale avant intégration | avant paiement automatisé |
| D6 | Durée de grâce | proposer 7 jours, puis restriction sans perte ; à valider contractuellement | avant le premier abonnement payant |
| D7 | Fenêtre de sortie après résiliation | proposer 30 jours en lecture/export, sous réserve des règles de conservation | avant CGV/DPA |
| D8 | Accès direct à Traccar | aucun par défaut ; option lecture seule ultérieure pour grands comptes | après le pilote |
| D9 | Conservation GPS, preuves, audit et factures | durées distinctes validées juridiquement ; ne pas inventer une durée unique | avant données réelles à grande échelle |
| D10 | MFA | obligatoire plateforme et propriétaires, recommandée gestionnaires | avant commercialisation |
| D11 | Objectifs RPO/RTO | pilote 24 h/8 h, production payante cible 1 h/4 h selon budget | avant engagement de niveau de service |
| D12 | Suppression d'entreprise | aucune suppression directe ; fermeture, export, délai, purge/anonymisation contrôlée | avant console plateforme complète |

## Décisions d'architecture proposées

### ADR-SaaS-01 — Monolithe modulaire

**Statut : proposé.** Conserver un déploiement applicatif unique avec modules internes. Le coût opérationnel de microservices n'est pas justifié par l'équipe et le volume actuels. Réexaminer si plusieurs équipes doivent déployer indépendamment ou si un module présente une charge très différente.

### ADR-SaaS-02 — Base et schéma partagés avec défense en profondeur

**Statut : proposé.** `company_id` obligatoire, contrôles API, contraintes composites et RLS après préparation des rôles SQL. Ce choix simplifie le pilote mais exige des tests systématiques contre les fuites inter-entreprises.

### ADR-SaaS-03 — Droits locaux indépendants du paiement

**Statut : proposé.** Les webhooks mettent à jour une projection locale idempotente. L'autorisation consulte les droits locaux et non un appel réseau au fournisseur. Cela permet facturation manuelle, panne temporaire et changement de prestataire.

### ADR-SaaS-04 — Suspension réversible

**Statut : proposé.** Un impayé bloque progressivement les nouvelles opérations sans supprimer les données ni interrompre une livraison active. Une suspension de sécurité suit une voie séparée et peut être immédiate.

### ADR-SaaS-05 — Traccar interne et à privilège minimal

**Statut : proposé.** L'entreprise utilise `/app`. Traccar est provisionné et interrogé côté serveur avec permissions minimales, registre local et réconciliation. Aucun administrateur Traccar n'est remis au client par défaut.

## Sources primaires consultées

### Sécurité et isolation

- [OWASP — Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) : refus par défaut, moindre privilège et vérification à chaque requête.
- [OWASP — Business Logic Security](https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html) : propriété réévaluée à chaque action et refus d'un locataire/rôle fourni par le client.
- [OWASP — Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) : MFA et réauthentification des actions sensibles.
- [OWASP — Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) : Argon2id, sels et paramètres adaptatifs.
- [OWASP — Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) : lien entre session, authentification et autorisation.
- [OWASP — CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) : limites de `SameSite`, jetons, origine et Fetch Metadata.
- [OWASP — Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) : journal applicatif et minimisation des données sensibles.
- [OWASP — Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) : moindre privilège, rotation, révocation et absence de secrets dans les logs.
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) : politiques par ligne, refus par défaut et contournement par propriétaire/`BYPASSRLS`.
- [PostgreSQL — `pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html) : sauvegarde logique portable et interaction avec RLS.

### Abonnements et paiements

- [Stripe — Webhooks](https://docs.stripe.com/webhooks) : signature, doublons, désordre, réponse rapide et reprise.
- [Stripe — Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks) : coordination entre état d'abonnement et droits d'accès.
- [Stripe — Entitlements](https://docs.stripe.com/billing/entitlements) : projection locale recommandée des droits actifs.
- [Stripe — Trials](https://docs.stripe.com/billing/subscriptions/trials) : fin d'essai, pause et rappels.
- [Stripe — Global availability](https://stripe.com/global) : pays/régions actuellement pris en charge.
- [Paystack — Countries](https://paystack.com/countries) : état de disponibilité par pays, dont la liste d'attente du Bénin à la date de consultation.
- [Paystack — Subscriptions](https://paystack.com/docs/payments/subscriptions/) : plans, événements et moyens de paiement pris en charge pour les récurrences.

### Hébergement, sauvegarde et Traccar

- [Railway — Back Up and Restore Postgres](https://docs.railway.com/guides/postgres-backups-restores) : sauvegardes de volume, PITR, dumps logiques et exercices de restauration.
- [Railway — Variables](https://docs.railway.com/variables) : variables par service, partagées et références entre services.
- [Railway — Isolate Staging from Production](https://docs.railway.com/guides/isolate-staging-production) : séparation réseau, données et variables par environnement.
- [Traccar — Permissions and Groups](https://www.traccar.org/permissions-groups/) : permissions explicites et limites des associations de groupes.
- [Traccar — User Management](https://www.traccar.org/user-management/) : administrateur, manager, utilisateur, lecture seule et limites d'appareils.
- [Traccar — API Reference](https://www.traccar.org/api-reference/) : utilisateurs, appareils, permissions, positions et authentification API.

