# Décisions d’architecture

## 2026-09-15 — Isolation des services de données du projet livraison

Le projet livraison ne partage plus son Postgres ni son Redis avec n8n. Deux
services dédiés sont provisionnés sur Railway (`Postgres-L9xy`, `Redis-sPlS`),
avec leurs propres volumes. Motifs : réduire le rayon d'impact (un incident n8n
ne doit pas atteindre les données livraison), séparer sauvegardes, rétention
légale et rôles PostgreSQL. La bascule Postgres se fait par `pg_dump`/restore car
le pilote contient des données à conserver ; l'ancienne base est gardée comme
repli jusqu'à confirmation. La procédure complète est dans
`docs/INFRA_ISOLATION_RUNBOOK.md`. Le Redis dédié sera câblé avec la migration du
rate-limiting, pas avant.

## 2026-09-15 — Liens de suivi à secret contrôlé

Un lien de suivi expire par défaut après sept jours et peut être révoqué ou renouvelé. Les listes entreprise n’exposent ni token ni URL. L’affichage unitaire est volontaire, autorisé et audité. Le token reste chiffré dans le coffre applicatif afin de permettre cet affichage ; une empreinte distincte sert à la recherche publique. Après validation de la phase compatible, la colonne historique en clair est vidée.

## 2026-09-15 — Concurrence et idempotence des liens

Renouvellement et révocation exigent une version attendue et une clé d’idempotence. Une transaction verrouille la ligne et inscrit le résultat logique dans `tracking_link_events`. Deux responsables agissant sur la même version obtiennent un seul succès et un conflit explicite ; le rejeu d’une ancienne révocation ne peut pas invalider une génération plus récente.

## 2026-09-15 — Limitation locale avant Redis

Le suivi public est protégé avant Traccar par des quotas IP et jeton, avec `429` et `Retry-After`. Le stockage étant en mémoire, une seule réplique `delivery-app` est autorisée pour le pilote. Redis devient obligatoire avant toute réplication horizontale.

## 2026-09-13 — Traccar comme moteur GPS

Traccar est utilisé pour recevoir les positions et gérer les appareils. La couche métier est développée séparément.

## 2026-09-13 — Railway

Railway est retenu pour le MVP afin de réutiliser l’environnement existant et déployer rapidement.

## 2026-09-13 — PostgreSQL séparé

Traccar utilise la base `traccar`. L’application métier utilise la base `delivery`. n8n conserve sa base existante.

## 2026-09-14 — Position plutôt qu’adresse

La latitude/longitude, la précision et l’horodatage deviennent prioritaires. L’adresse textuelle reste facultative et est remplacée ou complétée par quartier, repère et instructions.

## 2026-09-14 — Demande avant commande

Un formulaire client produit une `customer_request`. L’entreprise doit vérifier et confirmer avant de créer une commande et un lien de suivi final.

## 2026-09-14 — WAHA différé

WhatsApp/WAHA sera intégré après validation du parcours de demande, de la position et de l’affectation du livreur.

## 2026-09-14 — Séparation des interfaces

`/app` devient l'espace quotidien des entreprises. `/admin` est réservé à l'administration de la plateforme. Traccar reste interne par défaut et n'est pas l'interface commerciale du SaaS.

## 2026-09-14 — Intégration sélective de Traccar

Les fonctions GPS essentielles sont intégrées dans le SaaS via les API Traccar. L'interface Traccar complète n'est ni copiée ni exposée par défaut aux entreprises.

## 2026-09-14 — Deux cartes, deux niveaux de visibilité

La carte client ne montre que la commande et le livreur affecté. La carte entreprise présente la flotte, les destinations et les tournées de sa propre organisation.

## 2026-09-14 — Tournées multi-colis

Une tournée contient des arrêts ordonnés et plusieurs commandes. L'optimisation reste semi-automatique au départ et toute modification ayant un impact client nécessite une confirmation humaine.

## 2026-09-14 — CRM opérationnel intégré

Le CRM relie les clients, lieux, commandes, livreurs, communications, paiements et incidents. Il propose des vues inspirées d'Airtable, des analyses vérifiables et des exports contrôlés.

## 2026-09-14 — Preuve et prudence des indicateurs

La position GPS est un élément de contexte et non une preuve absolue. Les décisions en cas de litige utilisent une chronologie, les preuves de remise, la précision, les horodatages et l'audit. Aucun indicateur GPS ne sanctionne automatiquement un livreur.

## 2026-09-14 — Transitions explicites et idempotentes

Une commande suit une machine d'états côté serveur. Chaque mutation sensible porte une clé d'idempotence, verrouille la commande et écrit un événement distinct. L'interface ne peut donc pas inventer ou sauter une transition.

## 2026-09-14 — OTP comme première preuve de remise

La première preuve exigée est un code à six chiffres, limité en durée et en essais. Le passage à `Livrée` et la création de la preuve sont atomiques. Photo et signature resteront des options configurables, notamment pour éviter une collecte excessive de données personnelles.

## 2026-09-14 — Encaissement distinct du rapprochement

Le livreur ou l'opérateur déclare ce qui a réellement été reçu. Un propriétaire ou gestionnaire décide ensuite du rapprochement, particulièrement lorsqu'il existe un écart. Les montants XOF sont stockés comme entiers et toutes les corrections ajoutent un événement au lieu de réécrire l'historique.

## 2026-09-14 — Compte livreur lié et accès minimal

Un compte livreur référence exactement un profil `driver` de son entreprise. Il utilise `/driver`, ne peut pas ouvrir les API d'exploitation et chaque objet terrain est filtré simultanément par entreprise et par livreur. Les comptes sont activés par invitation temporaire à usage unique plutôt que par partage d'un mot de passe commun.

## 2026-09-14 — Séparation entre émission et saisie du code de remise

L'exploitation génère le code de remise et le destinataire le reçoit par un canal indépendant. Le livreur ne voit jamais ce code dans son portail : il saisit uniquement celui que le client lui communique. Le serveur impose l'ordre arrivée → encaissement décidé → code actif → preuve → livraison, avec expiration, cinq essais et usage unique.

## 2026-09-14 — Preuves complémentaires privées et minimales

Photo et signature sont désactivées par défaut. L'entreprise peut les rendre facultatives ou obligatoires, mais elles ne remplacent pas encore l'OTP. Les fichiers sont privés, limités et non exposés au client. Le pilote les conserve dans la base métier pour garantir la sauvegarde ; une migration vers un stockage objet privé est requise avant la montée en charge.

## 2026-09-14 — Incident immuable et conservation révisable

La déclaration d'un incident n'est jamais modifiée : tout complément devient un événement horodaté relié par empreinte au précédent. Le gel de conservation porte sur toute la commande, exige un motif et une date de révision, et ne se lève jamais automatiquement. Les durées légales restent configurées par le responsable de traitement selon sa juridiction ; le SaaS ne les invente pas.

## 2026-09-14 — Ordre de tournée humainement confirmé

La tournée est un objet métier versionné distinct des commandes. Une commande n'a qu'une affectation de tournée active et une tournée ouverte est unique par livreur et par date. L'algorithme actuel suggère seulement un ordre géométrique à vol d'oiseau et ne modifie rien sans confirmation. Une distance routière, un temps de trajet ou une ETA ne seront affichés qu'après intégration d'une matrice issue d'un véritable moteur routier.

## 2026-09-14 — Date de service sans conversion de fuseau

`service_date` est une date civile et non un instant. L'API la sérialise explicitement en `YYYY-MM-DD` afin d'empêcher le navigateur de l'afficher la veille selon le fuseau horaire.

## 2026-09-15 — Ajustements financiers immuables après clôture

L'encaissement finalisé ne peut plus être annulé ni réécrit. Un remboursement ou un complément crée une écriture distincte, et une erreur crée une écriture inverse liée. Les actions sont idempotentes, sérialisées par verrou et réservées aux responsables. Ce journal sert au suivi opérationnel et au litige, mais ne se substitue pas aux obligations comptables SYSCOHADA.

## 2026-09-15 — Fenêtre minimale d'exposition GPS au client

Le lien client ne reçoit pas la position du livreur pendant la préparation ou la simple récupération du colis. L'exposition est autorisée uniquement pendant `En tournée`, `En livraison` et `Arrivée`, puis suspendue en cas d'échec ou de retour et supprimée en état terminal. La destination du client peut rester visible avant le départ, mais aucun autre arrêt, ordre de tournée ou identifiant Traccar n'est envoyé.

## 2026-09-15 — Routage neutre et désactivé avant preuve terrain

Le domaine métier dépend d'un adaptateur et non directement d'OSRM. Une durée routière brute n'est pas une ETA. Le fournisseur de production reste désactivé jusqu'à la qualification d'un profil moto sur un corpus béninois versionné ; aucune ligne droite, route ancienne ou valeur par défaut ne sert de remplacement silencieux.

## 2026-09-15 — Manifeste livreur ordonné mais non coercitif

Le livreur voit exactement l'ordre confirmé par l'exploitation, sa progression et le prochain arrêt. L'ordre guide le travail mais ne bloque pas un détour terrain : client absent, route coupée ou urgence peuvent imposer une adaptation. Tant qu'un moteur routier fiable n'est pas intégré, aucune durée ni ETA n'est déduite de cet ordre. Les autres arrêts restent strictement absents de l'API publique du client.

## 2026-09-15 — Carte d'exploitation dégradée sans faux routage

La carte entreprise assemble côté serveur les positions Traccar et les objets de la base `delivery`, puis filtre la réponse par entreprise. Une indisponibilité GPS ne rend pas les commandes invisibles. La première ligne entre arrêts est volontairement pointillée et décrite comme un ordre opérationnel, jamais comme une route. Les distances routières et ETA attendront un moteur dédié dont la provenance et l'heure de calcul seront conservées.

## 2026-09-15 — Leaflet local et fonds cartographiques configurables

Leaflet est installé avec l'application et non chargé depuis un CDN au moment de la visite. Le fond OpenStreetMap standard reste un secours de pilote sans garantie commerciale. L'URL, l'attribution et le zoom sont configurables. Le satellite n'est affiché qu'avec un fournisseur autorisé ; aucune tuile d'un service tiers n'est extraite hors de ses conditions.

## 2026-09-15 — Reprise CRM sans fusion automatique

Chaque commande historique reçoit d'abord une fiche CRM distincte et idempotente. Un nom ou un téléphone similaire peut devenir une suggestion de doublon, mais jamais une fusion automatique. Cette prudence évite d'associer deux personnes différentes et permet de conserver les instantanés de commande comme preuve.

## 2026-09-15 — Double barrière d'isolation CRM

Toutes les routes CRM filtrent explicitement par l'entreprise de la session et définissent aussi `app.company_id` dans leur transaction PostgreSQL. RLS reste une défense future tant que la connexion applicative utilise un superutilisateur, car PostgreSQL autorise ce dernier à contourner les politiques. Le passage à un rôle HTTP non-superutilisateur fera l'objet d'un lot de migration séparé et réversible.

## 2026-09-15 — Indicateurs explicables, jamais disciplinaires

Les rapports indiquent leur période, population, formule et exclusions. Un dénominateur nul reste « non calculable ». Les incidents sont un contexte et ne prouvent pas une faute ; aucun score, classement, sanction ou affectation automatique de livreur n'est produit.

## 2026-09-16 — Carte plein écran (tour de contrôle) et satellite par défaut

La page Carte d'exploitation passe en composition « tour de contrôle » : la carte occupe tout l'espace, les commandes et la liste de la flotte deviennent des panneaux flottants en surimpression, et les indicateurs sont affichés à la demande (bouton « Résumé ») plutôt qu'en bandeau fixe. Le marqueur livreur est une icône SVG (aucun emoji).

Le fond satellite est désormais fourni par défaut via Esri World Imagery (gratuit, sans clé, attribution affichée), avec une couche de libellés Esri pour un mode « Hybride ». Cela remplace l'attente d'un fournisseur explicitement configuré : les variables `MAP_SATELLITE_TILE_URL`, `MAP_LABELS_TILE_URL` (et attributions/zoom associés) restent surchargées si un fournisseur payant devient nécessaire au volume. Aucune tuile n'est extraite hors des conditions d'usage de son fournisseur.

Le « replay » du trajet d'un livreur par durée n'est pas livré : l'application ne stocke aucun historique GPS local, les positions venant en direct de Traccar. L'emplacement UI existe (action désactivée et explicitée) et s'activera avec un endpoint dédié interrogeant l'historique Traccar, une fois Traccar branché et l'enregistrement des positions activé.
