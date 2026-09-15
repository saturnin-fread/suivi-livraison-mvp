# Décisions d’architecture

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
