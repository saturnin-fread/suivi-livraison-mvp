# Modèle de données métier

## Tables actuelles

### `companies`

Entreprise cliente. Toutes les données métier doivent être rattachées à `company_id`.

### `drivers`

Livreur lié à une entreprise et à un `traccar_unique_id`.

### `orders`

Commande validée, avec statut, client et livreur affecté.

### `tracking_links`

Token public unique, date d’expiration et commande associée.

### `customer_requests`

Demande non encore convertie en commande : nom, téléphone, créneau, position, précision GPS, quartier, repère et notes.

## Tables à ajouter ensuite

```text
users
company_memberships
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
order_status_events
proofs_of_delivery
incidents
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
