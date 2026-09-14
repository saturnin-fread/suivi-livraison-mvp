# Modèle de données métier

## Tables actuelles

### `companies`

Entreprise cliente. Toutes les données métier doivent être rattachées à `company_id`.

### `drivers`

Livreur lié à une entreprise et à un `traccar_unique_id`, avec capacité, véhicule et disponibilité opérationnelle.

### `orders`

Commande validée, avec statut, client, destination, demande d'origine et livreur affecté.

### `tracking_links`

Token public unique, date d’expiration et commande associée.

### `customer_requests`

Demande non encore convertie en commande : nom, téléphone, créneau, position, précision GPS, quartier, repère et notes.

### `users`, `company_memberships` et `sessions`

Comptes, rôles par entreprise et sessions de connexion. Pour le rôle `driver`, l'appartenance référence aussi le profil livreur autorisé. L'espace plateforme reste séparé de l'espace entreprise.

### `user_invitations`

Invitation temporaire à usage unique : entreprise, e-mail normalisé, rôle, profil livreur facultatif, empreinte du token, créateur, expiration, acceptation ou révocation.

### `audit_logs`

Journal minimal des actions sensibles déjà utilisé pour les demandes, commandes et disponibilités.

### `order_status_events`

Chronologie append-only des transitions de commande, avec acteur, motif, clé d'idempotence et empreinte de la requête.

### `delivery_otp_challenges`, `delivery_otp_attempts` et `delivery_proofs`

Défis OTP temporaires, tentatives idempotentes et preuves de remise durables. Le code en clair n'est jamais stocké.

### `delivery_evidence_files`

Métadonnées et contenu privé actif des preuves photo/signature. Une seule preuve active existe par commande et type. Lors d'un remplacement, l'ancienne ligne conserve son empreinte, son auteur et son horodatage mais son contenu binaire est supprimé. Les règles `photo_proof_mode` et `signature_proof_mode` de l'entreprise définissent si chaque preuve est désactivée, facultative ou obligatoire.

### `delivery_incidents`

Déclarations factuelles et résolutions d'incidents rattachées à une commande, avec responsable facultatif.

### `incident_events`

Chronologie append-only des notes, attributions, résolutions et gels. Chaque événement contient l'empreinte du précédent afin de détecter une altération de la chaîne.

### `order_retention_holds`

Historique des gels de conservation appliqués au dossier complet d'une commande : motif, auteur, date de révision, levée et justification.

### `order_payment_accounts` et `payment_events`

État courant de l'encaissement d'une commande et ledger append-only de ses configurations, collectes, écarts, annulations et rapprochements.

## Tables à ajouter ensuite

```text
roles
customer_request_links
customer_request_revisions
customers
customer_locations
driver_shifts
driver_status_events
delivery_runs
delivery_run_orders
delivery_stops
packages
customer_interactions
notifications_log
audit_logs
export_logs
subscriptions
plans
```

## Règles

- Un token public doit être aléatoire, non séquentiel et expirabile.
- Une entreprise ne doit jamais accéder aux lignes d’une autre entreprise.
- Une demande client n’est pas automatiquement une commande.
- Une position doit conserver son horodatage et sa précision.
- Les données de localisation doivent avoir une durée de conservation définie.
- Le token de consultation et le token de modification d'une demande doivent être distincts, secrets, expirables et révocables.
- Une tournée ordonne plusieurs arrêts et un arrêt peut contenir plusieurs colis destinés au même lieu.
- La position d'un colis sans traceur est une position déduite de son état et de son porteur.
- Les changements de statut, affectations, preuves et incidents sont historisés sans écraser les événements précédents.
- Les statistiques agrégées ne remplacent jamais les données sources et doivent conserver une méthode de calcul documentée.
- Chaque export est rattaché à l'utilisateur, l'entreprise, la période et les filtres utilisés.
