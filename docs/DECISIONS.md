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
