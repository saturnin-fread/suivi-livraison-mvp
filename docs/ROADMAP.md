# Plan d'action priorisé

Ce document est la feuille de route de référence. L'ordre des phases suit les dépendances métier et techniques. Une phase n'est considérée terminée que lorsque ses critères d'acceptation sont vérifiés.

## État de départ

Le prototype permet actuellement de :

- recevoir les positions d'un téléphone dans Traccar ;
- afficher la dernière position du livreur sur un lien public ;
- générer un formulaire client ;
- recueillir coordonnées, créneau, position GPS et repères ;
- lister sommairement les demandes dans une page d'administration technique.

Il ne constitue pas encore un SaaS multi-entreprises et la page `/admin` actuelle n'est pas l'interface finale.

## Phase 1 — Fondations du SaaS et navigation — première version livrée

### Objectif

Séparer les espaces et rendre toutes les données compatibles avec plusieurs entreprises avant d'enrichir les fonctionnalités.

### À réaliser

- créer l'espace entreprise `/app` avec un menu commun ;
- réserver `/admin` à l'administration de la plateforme ;
- créer les pages Tableau de bord, Demandes, Commandes, Carte, Livreurs, Clients, Rapports et Paramètres ;
- introduire entreprises, utilisateurs, appartenances et rôles ;
- rattacher chaque donnée métier à une entreprise ;
- appliquer les contrôles d'accès côté serveur ;
- conserver les écrans actuels en les répartissant dans les bonnes pages.

### Critères d'acceptation

- un utilisateur d'entreprise ne peut pas ouvrir `/admin` ;
- une entreprise ne peut jamais lire ou modifier les données d'une autre ;
- les fonctions ne sont plus empilées sur une page unique ;
- la navigation fonctionne sur mobile et ordinateur.

## Phase 2 — Cycle complet de la demande client — première version livrée

### Objectif

Permettre au client de transmettre, vérifier et modifier ses informations jusqu'à la validation de l'entreprise.

### À réaliser

- page de confirmation après l'envoi ;
- résumé des informations et position sur carte ;
- token d'édition distinct du token public ;
- bouton « Modifier mes informations » ;
- verrouillage dès que l'entreprise valide la demande ;
- états : lien créé, en attente client, à vérifier, informations à compléter, validée, refusée, expirée ;
- expiration, archivage et historique des modifications ;
- fiche détaillée d'une demande côté entreprise ;
- actions demander des précisions, valider, refuser et archiver.

### Critères d'acceptation

- un client peut corriger sa demande tant qu'elle n'est pas validée ;
- une demande validée ne peut plus être modifiée avec le lien client ;
- un double envoi ne crée pas deux demandes ;
- les demandes traitées quittent la file active mais restent consultables dans les archives.

## Phase 3 — Livreurs, appareils et création de commande — première version livrée

### Objectif

Transformer une demande validée en commande et sélectionner réellement un livreur.

### À réaliser

- synchroniser les appareils Traccar autorisés sans exposer les identifiants techniques ;
- créer les fiches livreurs et leur association à un appareil ;
- gérer disponibilité, pause, hors ligne, position ancienne, incident et charge active ;
- proposer une sélection dynamique des livreurs ;
- afficher zone, fraîcheur GPS, nombre de colis et capacité restante ;
- convertir demande → commande dans une transaction unique ;
- permettre une commande directe sur une page séparée ;
- générer le lien de suivi après validation et affectation.

### Critères d'acceptation

- le nom et l'identifiant Traccar ne sont plus saisis manuellement ;
- un livreur peut transporter plusieurs colis ;
- une affectation concurrente ou obsolète est détectée ;
- l'échec d'une étape ne laisse pas une commande partiellement créée.

## Phase 4 — Exécution et preuve de livraison — lots 1 et 2 livrés

### Objectif

Suivre le cycle réel d'une livraison et constituer un dossier vérifiable en cas de litige.

### À réaliser

- tournées, arrêts ordonnés et colis affectés ;
- étapes récupérée, en tournée, en livraison, arrivée, livrée, échec, retour et annulation ;
- raisons obligatoires pour échec, retour ou annulation ;
- preuve de remise : OTP en priorité, puis photo ou signature selon les besoins ;
- encaissement à la livraison et rapprochement ;
- journal append-only des changements, acteurs et horodatages ;
- chronologie d'incident et gel de conservation en cas de litige.

### Critères d'acceptation

- chaque changement important indique qui, quand et pourquoi ;
- une livraison ne peut être déclarée livrée sans la preuve exigée ;
- un incident peut être reconstitué sans modifier l'historique original.

## Phase 5 — Carte publique du client

### Objectif

Afficher seulement la livraison du client, avec une expérience claire et respectueuse de la vie privée.

### À réaliser

- marqueurs livreur et destination du client ;
- boutons ma position, recentrer sur le livreur et voir l'ensemble ;
- suivi automatique activable ;
- distance restante et fourchette d'arrivée ;
- progression de la commande et dernière mise à jour ;
- précision GPS et avertissement de position ancienne ;
- calques carte et satellite hybride via un fournisseur conforme ;
- mode connexion faible et reprise après coupure ;
- arrêt du suivi précis après livraison, annulation ou expiration ;
- aucune information sur les autres clients ou arrêts.

### Critères d'acceptation

- le client ne reçoit dans l'API que les données de sa commande ;
- aucun autre arrêt ou client n'est déductible de la réponse ;
- une position ancienne n'est jamais présentée comme actuelle ;
- l'estimation est affichée comme une fourchette et se recalcule.

## Phase 6 — Carte d'exploitation et tournées multi-colis

### Objectif

Donner à l'entreprise une tour de contrôle interactive.

### À réaliser

- positions en direct de tous les livreurs autorisés ;
- WebSocket Traccar côté serveur ou passerelle temps réel ;
- regroupement des marqueurs et filtres par zone, état, équipe et tournée ;
- destinations, dépôts, arrêts terminés et arrêts restants ;
- trajet réalisé, position courante et parcours planifié visuellement distincts ;
- panneau interactif livreur, colis et destination ;
- réorganisation manuelle des arrêts avec recalcul ;
- proposition semi-automatique d'une tournée selon distance, créneaux, priorité et capacité ;
- confirmation humaine avant toute modification ayant un impact client ;
- géofences pour départ, arrivée et événements utiles.

### Critères d'acceptation

- cliquer sur un livreur montre sa charge et son parcours restant ;
- cliquer sur un colis montre son état et sa destination ;
- une modification de tournée recalcule les estimations et est auditée ;
- le système distingue position réelle du livreur et position déduite du colis.

## Phase 7 — CRM opérationnel, analyses et exports

### Objectif

Relier clients, commandes, livreurs, communications, paiements et incidents dans une interface inspirée d'Airtable.

### À réaliser

- fiches liées, vues tableau, kanban, calendrier et carte ;
- recherche, filtres, tris, regroupements, tags et vues enregistrées ;
- historique client, lieux, préférences et réclamations ;
- fiche livreur avec activité, ponctualité, distances, incidents et qualité GPS ;
- tableaux de bord mensuels avec comparaison à la période précédente ;
- indicateurs de volume, réussite, retard, durée, distance, zones, charge, incidents et encaissements ;
- exploration d'un graphique vers les opérations sources ;
- exports XLSX multi-feuilles, CSV et rapports PDF ;
- contrôle des colonnes exportables selon le rôle et journal des exports ;
- dossier de preuve exportable pour un litige.

### Critères d'acceptation

- chaque indicateur peut être expliqué par ses données sources ;
- les anomalies GPS ne produisent pas automatiquement une sanction ;
- les exports respectent les filtres, l'entreprise et les permissions ;
- les statistiques agrégées restent séparées des positions GPS détaillées.

## Phase 8 — WhatsApp avec WAHA

### Objectif

Automatiser les communications après stabilisation du parcours métier.

### À réaliser

- modèles de messages par événement ;
- envoi du formulaire, demande de précision, confirmation, suivi et approche ;
- journal des envois, réponses et erreurs ;
- webhooks idempotents ;
- reprise manuelle si WAHA est indisponible ;
- paramètres et consentement par entreprise.

## Phase 9 — Onboarding, offres et facturation

### Objectif

Transformer le produit validé en SaaS commercial administrable.

### À réaliser

- création guidée d'une entreprise ;
- invitations et rôles ;
- forfaits et quotas : utilisateurs, livreurs, appareils, livraisons et conservation ;
- période d'essai, abonnement, factures et suspension contrôlée ;
- provisionnement technique Traccar par entreprise ;
- espace plateforme `/admin` pour support, abonnements et supervision ;
- aucun secret ni compte administrateur Traccar dans le navigateur.

## Phase 10 — Durcissement et pilote

### Objectif

Valider le produit sur de vraies tournées avant généralisation.

### À réaliser

- tests automatiques, sécurité, charge et faible connectivité ;
- sauvegarde et restauration vérifiées ;
- surveillance des erreurs et alertes ;
- politique de conservation, anonymisation et gel juridique ;
- tests avec une petite entreprise et plusieurs livreurs ;
- mesure des écarts entre estimations, positions et réalité terrain ;
- correction des parcours avant travail esthétique final.

## Prochain lot d'implémentation recommandé

Les phases 1 à 3 disposent désormais d'une première version exploitable : espaces séparés, isolation par entreprise, demande modifiable, affectation dynamique, conversion atomique et lien de suivi. Les invitations multi-utilisateurs, les conflits de capacité avancés et les règles d'archivage seront renforcés pendant le pilote.

Le prochain lot doit commencer la phase 4 dans cet ordre :

1. créer une vue mobile limitée pour le livreur avec permissions dédiées ;
2. compléter les preuves par photo ou signature configurable, sans les rendre obligatoires par défaut ;
3. constituer le dossier d'incident exportable et le gel de conservation ;
4. préparer les tournées et arrêts ordonnés nécessaires à la carte d'exploitation ;
5. tester les reprises hors connexion et les actions différées du livreur ;
6. ajouter les ajustements financiers postérieurs à une commande terminée.

## Règles transversales

- `delivery` est la source de vérité métier ; Traccar est la source de vérité GPS.
- Ne jamais écrire directement dans la base Traccar depuis l'application métier.
- n8n et WAHA automatisent des actions mais ne deviennent pas la source de vérité.
- Une donnée publique est filtrée côté serveur, jamais uniquement masquée dans l'interface.
- Toute action sensible est autorisée par rôle et auditée.
- Les interfaces doivent prévoir erreurs, annulation, reprise et conflit de modification.
- Les positions détaillées, preuves et statistiques ont des durées de conservation différentes.
- Les secrets restent dans les variables Railway ou un gestionnaire de secrets.
