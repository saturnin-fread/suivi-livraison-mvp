# Tournées multi-colis

## Objectif du premier lot

Une tournée regroupe plusieurs commandes déjà affectées au même livreur et fixe leur ordre opérationnel. Ce lot prépare la carte d'exploitation sans prétendre calculer encore un véritable itinéraire routier.

## Parcours entreprise

1. Ouvrir `/app/tournees`.
2. Créer un brouillon avec un nom, une date civile et un livreur actif.
3. Ajouter uniquement les commandes actives déjà affectées à ce livreur.
4. Déplacer manuellement les arrêts ou demander une proposition indicative.
5. Enregistrer explicitement l'ordre choisi.
6. Passer la tournée à `Planifiée`, puis `En cours` au départ réel.
7. Traiter chaque commande avec sa propre machine d'états et ses propres preuves.
8. Terminer la tournée lorsque toutes les commandes sont dans un état terminal.

## États

```text
Brouillon → Planifiée → En cours → Terminée
    ↓           ↓          ↓
 Annulée     Annulée    Annulée

Planifiée → Brouillon (correction avant départ)
```

- ajout et retrait de colis : uniquement en brouillon ;
- réorganisation : en brouillon ou planifiée ;
- démarrage : au moins un arrêt, livreur actif et aucune commande déjà terminale ;
- clôture : tous les arrêts doivent être `Livrée`, `Retournée` ou `Annulée` ;
- annulation : motif de 10 à 1 000 caractères, historique conservé et colis libérés.

## Intégrité et concurrence

- une commande ne peut appartenir qu'à une seule tournée active ;
- une seule tournée peut rester ouverte pour un livreur et une date donnée ;
- la capacité déclarée du livreur limite le nombre de colis du brouillon ;
- chaque mutation vérifie la version de la tournée pour détecter une modification faite par un autre opérateur ;
- chaque action possède une clé d'idempotence afin qu'un double clic ou une reprise réseau ne crée pas deux effets ;
- les retraits sont logiques : la ligne d'arrêt reste dans l'historique mais n'est plus active ;
- création, ajout, retrait, ordre et changement d'état produisent des événements append-only et un audit.

## Suggestion d'ordre actuelle

La première version essaie plusieurs points de départ et applique un plus-proche-voisin sur les distances de Haversine. Elle requiert une position GPS pour chaque destination et reste limitée à 50 arrêts.

Cette proposition :

- ne modifie jamais la tournée ;
- doit être confirmée manuellement ;
- exprime seulement une distance à vol d'oiseau entre arrêts ;
- ne connaît pas les routes, sens interdits, trafic, dépôts, horaires ni créneaux clients ;
- ne doit jamais être présentée comme un itinéraire, une durée ou une heure d'arrivée.

La documentation officielle OR-Tools distingue les problèmes de tournée, capacité et créneaux et précise qu'une solution peut être bonne sans être optimale : <https://developers.google.com/optimization/routing>. Les créneaux nécessitent une matrice de temps de trajet : <https://developers.google.com/optimization/routing/vrptw>. Une future version devra produire cette matrice avec un moteur routier, par exemple les services Route/Table d'OSRM : <https://project-osrm.org/docs/v5.24.0/api/>.

## Tables

- `delivery_runs` : livreur, date, état, version et clé de création ;
- `delivery_stops` : commande, position dans la tournée, retrait logique et affectation active ;
- `delivery_run_events` : historique append-only des actions.

## API interne

```text
GET  /api/app/runs
POST /api/app/runs
GET  /api/app/runs/:id
POST /api/app/runs/:id/orders
POST /api/app/runs/:id/stops/:stopId/remove
POST /api/app/runs/:id/reorder
GET  /api/app/runs/:id/suggestion
POST /api/app/runs/:id/status
```

Toutes les lectures et écritures sont filtrées par `company_id`. Le portail livreur et le lien public ne reçoivent pas encore les autres arrêts d'une tournée.

## Étapes suivantes

- file d'actions terrain hors connexion et reprise idempotente ;
- affichage au livreur de son ordre d'arrêts sans exposer les autres clients à un client final ;
- moteur routier avec matrice route/temps, dépôt, capacité et créneaux structurés ;
- carte entreprise : position réelle, arrêts restants et route planifiée visuellement distincts ;
- recalcul et notification contrôlée après une modification de tournée active.
