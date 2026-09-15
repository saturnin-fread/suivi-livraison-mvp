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

## Parcours livreur

- seules les tournées `Planifiée` et `En cours` du livreur connecté sont visibles ;
- une tournée active reste visible même si sa date est ancienne, afin de ne pas masquer une tournée non clôturée ;
- les tournées planifiées en retard restent visibles jusqu'à traitement, ainsi que celles des quatorze prochains jours ;
- les arrêts reprennent exactement l'ordre confirmé par l'exploitation ;
- le premier colis non terminal est signalé comme prochain arrêt et la progression est recalculée à chaque lecture ;
- les commandes affectées qui ne figurent dans aucune tournée visible restent dans une section « Hors tournée » ;
- ouvrir une commande affiche son rang et sa tournée, sans bloquer un changement d'ordre nécessaire sur le terrain.

Le portail n'affiche pas encore de durée ou d'heure d'arrivée calculée. L'ordre est une instruction opérationnelle, pas une preuve que la route est optimale. Le client final ne reçoit jamais ce manifeste ni les autres arrêts.

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
GET  /api/driver/runs
```

Toutes les lectures et écritures sont filtrées par `company_id`. L'API livreur filtre en plus par `driver_id`. Le lien public ne reçoit jamais les autres arrêts d'une tournée.

## Étapes suivantes

- file d'actions terrain hors connexion et reprise idempotente ;
- moteur routier avec matrice route/temps, dépôt, capacité et créneaux structurés ;
- carte entreprise : position réelle, arrêts restants et route planifiée visuellement distincts ;
- recalcul et notification contrôlée après une modification de tournée active.

## Références de conception

- Google Routes : une optimisation renvoie un ordre explicite de waypoints et considère notamment temps, distance et virages : https://developers.google.com/maps/documentation/routes/opt-way
- Mapbox Optimization : une solution de tournée distingue séquence, ETA, attente et durée de service, ainsi que les arrêts non servis : https://docs.mapbox.com/api/navigation/optimization/
- MDN `aria-live` : les mises à jour dynamiques importantes doivent être annoncées sans déplacer le focus : https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live
