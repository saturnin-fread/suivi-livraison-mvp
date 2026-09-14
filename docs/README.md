# Documentation du SaaS de suivi de livraison

Cette documentation est la source de reprise du projet. Elle décrit le fonctionnement métier, l’architecture, les décisions, les risques et les procédures de déploiement.

## Documents

- [Plan d'action priorisé](ROADMAP.md)
- [Vision et parcours métier](PRODUCT_WORKFLOW.md)
- [Architecture technique](ARCHITECTURE.md)
- [Modèle de données](DATA_MODEL.md)
- [Erreurs et cas limites](ERRORS_AND_EDGE_CASES.md)
- [Plan de tests](TEST_PLAN.md)
- [Procédure d’exploitation et reprise](OPERATIONS_RUNBOOK.md)
- [Décisions prises](DECISIONS.md)
- [Historique des changements](CHANGELOG.md)

## État au 14 septembre 2026

- Traccar 6.15.3 est déployé sur Railway.
- Le téléphone test Traccar utilise l’identifiant `61779795`.
- Le TCP Proxy GPS utilisé est `thomas.proxy.rlwy.net:14240` vers le port interne `5055`.
- PostgreSQL contient une base `traccar` pour Traccar et une base `delivery` pour l’application métier.
- `delivery-app` est déployé sur Railway.
- Le suivi public fonctionne avec un lien de démonstration.
- Le formulaire client avec position GPS, repères et créneau fonctionne en version prototype.
- La page `/admin` actuelle est un écran technique provisoire et non l'espace final des entreprises.
- La fondation multi-entreprises, la navigation `/app`, la séparation `/admin` et la confirmation modifiable sont déployées en première version.
- La prochaine évolution prioritaire est la sélection dynamique détaillée des livreurs puis la conversion coordonnée demande → commande.
- WhatsApp/WAHA n’est pas encore intégré.

## Règle de confidentialité

Ne jamais écrire ici de mot de passe, clé API, token Railway, identifiant WhatsApp ou valeur secrète. Les secrets restent dans Railway Variables ou dans un gestionnaire de secrets.
