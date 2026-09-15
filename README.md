# Suivi livraison — SaaS métier en construction

Application multi-entreprises de préparation et de suivi des livraisons, reliée à Traccar pour la géolocalisation.

## Espaces

- `/app` : espace de gestion de l'entreprise ;
- `/admin` : administration de la plateforme, séparée des entreprises ;
- `/driver` : espace mobile d'un livreur invité, limité à ses commandes affectées ;
- `/demande/:token` : collecte des informations du destinataire ;
- `/suivi/:token` : suivi public d'une commande, limité à ce client.

## Démarrage

```bash
npm install
copy .env.example .env
npm start
```

Puis ouvrir l’espace entreprise :

```text
http://localhost:3000/app/login
```

Le lien de démonstration n’existe que si `DEMO_TRACKING_ENABLED=true` et si un jeton local explicite est fourni. Ce mode est refusé en production Railway.

Le serveur utilise un compte Traccar côté serveur pour récupérer la dernière position. Les identifiants Traccar ne sont jamais envoyés au navigateur.

La base `delivery` reste la source de vérité métier. Traccar reste la source de vérité GPS.

Les liens clients expirent, peuvent être renouvelés ou révoqués, et ne sont plus exposés dans les listes courantes. Leur secret est chiffré pour l’affichage explicite et leur recherche publique utilise une empreinte. La procédure de migration et de retour arrière est décrite dans `docs/TRACKING_LINK_MIGRATION_RUNBOOK.md`.
