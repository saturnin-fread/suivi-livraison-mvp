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

Comptes, rôles par entreprise et sessions de connexion. L'espace plateforme reste séparé de l'espace entreprise.

### `audit_logs`

Journal minimal des actions sensibles déjà utilisé pour les demandes, commandes et disponibilités.

### `order_status_events`

Chronologie append-only des transitions de commande, avec acteur, motif, clé d'idempotence et empreinte de la requête.

### `delivery_otp_challenges`, `delivery_otp_attempts` et `delivery_proofs`

Défis OTP temporaires, tentatives idempotentes et preuves de remise durables. Le code en clair n'est jamais stocké.

### `delivery_incidents`

Déclarations factuelles et résolutions d'incidents rattachées à une commande.

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
payments
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
