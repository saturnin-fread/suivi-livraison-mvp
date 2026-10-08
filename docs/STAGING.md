# Environnement de recette (staging)

Un environnement isolé pour les tests (dont les tests de sécurité automatisés),
avec des données jetables. Il ne partage **rien** avec la production : projet
Railway séparé, base PostgreSQL dédiée, secrets distincts, aucun fournisseur
externe actif.

## Où

- Projet Railway : `traxo-staging`, environnement `staging` (séparé du projet
  de production).
- Branche Git : `staging` → seul le service de recette la déploie.
- Base : PostgreSQL du projet `traxo-staging`, vide au départ ; les migrations
  s'appliquent au démarrage.

## Ce qui change en staging (et seulement là)

Le code concerné est `server/core/staging.js` : il ne fait rien si
`RAILWAY_ENVIRONMENT_NAME` (fourni par Railway) ne vaut pas exactement `staging`.

| Réglage | Effet |
|---|---|
| automatique | `X-Robots-Tag: noindex` sur toutes les réponses, `/robots.txt` interdit tout |
| `STAGING_RATE_LIMITS=off` | limites anti-abus désactivées (connexion, inscription, liens publics…) |
| `STAGING_SEED=on` | comptes de recette et données fictives créés au démarrage (idempotent ; les mots de passe sont remis à chaque démarrage) |
| `STAGING_PASSWORD_*` | mots de passe des comptes de recette (variables Railway, jamais dans le dépôt) |

## Services externes : tous inactifs

- **E-mail** : aucun fournisseur (ni SMTP, ni Brevo, ni Resend). Aucun e-mail
  ne peut partir ; les codes de connexion par e-mail sont donc désactivés
  (`LOGIN_EMAIL_CODE=off`) et l'inscription ouvre la session directement.
- **WhatsApp** : `WHATSAPP_ENABLED=off`.
- **Paiement** : aucune clé Kkiapay, aucun prestataire de test ; la recharge en
  ligne répond 503 (comme la production aujourd'hui).
- **Google, GPS (Traccar), itinéraires (OSRM), tuiles vectorielles, recherche
  de lieux** : non configurés ou `disabled`.
- **Redis** : absent (limites en mémoire, désactivées de toute façon).

## Comptes de recette

Créés par le seed, sur le domaine réservé `staging-traxo.test` (aucune boîte
réelle) :

| Compte | Rôle | Espace |
|---|---|---|
| `ADMIN_USER` (owner-a@…) | propriétaire | A — Chicago Consulting Group |
| manager-a@… | responsable | A |
| operator-a@… | opérateur | A |
| viewer-a@… | lecture seule | A |
| owner-b@… | propriétaire | B — Livraisons Ganhi |
| operator-b@… | opérateur | B |
| `PLATFORM_ADMIN_USER` (platform@…) | administrateur plateforme (`/admin`, outils TRAXO) | T — Équipe TRAXO |

Chaque espace A et B a 2 livreurs, 6 commandes (tous statuts), 2 demandes,
3 clients et 5 000 F sur son portefeuille.

## Remettre à zéro

Supprimer et recréer la base du projet `traxo-staging`, puis redéployer : les
migrations et le seed recréent tout.
