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

Puis ouvrir :

```text
http://localhost:3000/suivi/demo-ccg-2026
```

Le serveur utilise un compte Traccar côté serveur pour récupérer la dernière position. Les identifiants Traccar ne sont jamais envoyés au navigateur.

La base `delivery` reste la source de vérité métier. Traccar reste la source de vérité GPS.
