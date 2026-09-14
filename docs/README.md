# Documentation du SaaS de suivi de livraison

Cette documentation est la source de reprise du projet. Elle décrit le fonctionnement métier, l’architecture, les décisions, les risques et les procédures de déploiement.

## Documents

- [Plan d'action priorisé](ROADMAP.md)
- [Vision et parcours métier](PRODUCT_WORKFLOW.md)
- [Cycle d'exécution des commandes](ORDER_STATE_MACHINE.md)
- [Encaissement et rapprochement](PAYMENT_RECONCILIATION.md)
- [Espace livreur et contrôle d'accès](DRIVER_PORTAL_ACCESS.md)
- [Tournées multi-colis](DELIVERY_RUNS.md)
- [Fonctionnement hors connexion du livreur](OFFLINE_OPERATIONS.md)
- [Architecture technique](ARCHITECTURE.md)
- [Modèle de données](DATA_MODEL.md)
- [Erreurs et cas limites](ERRORS_AND_EDGE_CASES.md)
- [Plan de tests](TEST_PLAN.md)
- [Procédure d’exploitation et reprise](OPERATIONS_RUNBOOK.md)
- [Décisions prises](DECISIONS.md)
- [Historique des changements](CHANGELOG.md)

## État au 15 septembre 2026

- Traccar 6.15.3 est déployé sur Railway.
- Le téléphone test Traccar utilise l’identifiant `61779795`.
- Le TCP Proxy GPS utilisé est `thomas.proxy.rlwy.net:14240` vers le port interne `5055`.
- PostgreSQL contient une base `traccar` pour Traccar et une base `delivery` pour l’application métier.
- `delivery-app` est déployé sur Railway.
- Le suivi public fonctionne avec un lien de démonstration.
- Le formulaire client avec position GPS, repères et créneau fonctionne en version prototype.
- `/app` est l'espace entreprise et `/admin` reste réservé à l'administration de la plateforme.
- La fondation multi-entreprises, la navigation `/app`, la séparation `/admin` et la confirmation modifiable sont déployées en première version.
- La sélection dynamique, la conversion demande → commande, l'exécution par étapes, les incidents et la preuve OTP disposent d'une première version.
- L'encaissement à la livraison, les écarts et le rapprochement disposent d'une première version auditée.
- Les invitations à usage unique et l'espace mobile cloisonné du livreur disposent d'une première version testée.
- Les actions terrain sensibles, les preuves complémentaires, les dossiers d'incident et les tournées multi-colis disposent d'une première version testée.
- La page `/app/tournees` permet de créer, corriger, ordonner, planifier, démarrer, annuler et terminer une tournée avec historique.
- Les transitions et incidents peuvent attendre une reprise réseau contrôlée sur le téléphone du livreur ; les actions sensibles restent en ligne.
- Le prochain lot traite les ajustements financiers postérieurs à une commande terminée.
- WhatsApp/WAHA n’est pas encore intégré.

## Règle de confidentialité

Ne jamais écrire ici de mot de passe, clé API, token Railway, identifiant WhatsApp ou valeur secrète. Les secrets restent dans Railway Variables ou dans un gestionnaire de secrets.
