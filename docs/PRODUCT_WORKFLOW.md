# Vision et parcours métier

## Principe

La position GPS est la donnée principale. L’adresse textuelle est facultative et sert de contexte : quartier, repère, portail, boutique, étage ou instruction d’appel.

## Parcours cible

```text
Entreprise crée une demande
  → lien de formulaire client
  → client renseigne ses informations et partage sa position
  → page de confirmation modifiable tant que la demande n'est pas validée
  → entreprise vérifie et complète la demande
  → demande convertie en commande
  → livreur sélectionné selon disponibilité, zone, charge et position
  → commande placée dans une tournée éventuellement multi-colis
  → lien de suivi généré
  → livraison exécutée
  → preuve de remise ou incident
  → commande livrée, retournée ou annulée
```

## Acteurs

- Administrateur plateforme : entreprises, abonnements, sécurité, support.
- Administrateur entreprise : demandes, commandes, livreurs, utilisateurs.
- Opérateur entreprise : validation et affectation des livraisons.
- Livreur : téléphone Traccar actif, disponibilité, tournée.
- Client final : formulaire, position, créneau, repères, suivi public.

## États d’une demande

```text
En attente d’informations
À vérifier
Informations à compléter
Confirmée
Refusée
Expirée
```

## États d’une commande

```text
En préparation
Confirmée
Livreur affecté
En tournée
En livraison
Arrivée
Livrée
Annulée
```

## Localisation client

Le formulaire demande une autorisation explicite avant d’utiliser la géolocalisation. Il doit fonctionner en HTTPS et prévoir un mode de secours : quartier, repère et commentaire. Le marqueur doit pouvoir être déplacé pour corriger une position GPS imprécise.

## Livraisons groupées

Un livreur peut avoir plusieurs commandes actives dans une même zone. Il ne faut donc pas modéliser « livreur disponible = aucune commande ». La sélection doit tenir compte du nombre de livraisons, de la zone, de la fraîcheur de la position et de la capacité disponible.

L'entreprise prépare ensuite une tournée datée : elle ajoute les commandes du même livreur, vérifie les créneaux et confirme leur ordre. La proposition automatique actuelle est uniquement géométrique. Elle ne devient jamais l'ordre opérationnel sans action humaine.

## Coupure réseau pendant l'exécution

Une transition ou un incident saisi sur une commande déjà ouverte peut attendre localement le retour du réseau. Le portail affiche qu'il ne s'agit pas encore d'une confirmation serveur. Le code de remise, l'encaissement, la photo et la signature restent en ligne afin de vérifier immédiatement les règles de sécurité et de ne pas conserver de contenus sensibles sur le téléphone.

## Deux expériences cartographiques

### Carte client

Le client voit uniquement son colis, son point de livraison, le livreur affecté, la progression, la distance et une fourchette d'arrivée. Les autres clients, colis, destinations et arrêts restent invisibles.

### Carte entreprise

L'entreprise voit les livreurs et tournées de sa propre organisation. Elle peut sélectionner un livreur pour consulter sa charge, les arrêts terminés, le parcours restant et les incidents, ou sélectionner un colis pour consulter sa destination et son état.

## Position d'un colis

Sans traceur individuel, la position d'un colis est déduite : dépôt avant récupération, position du livreur pendant le transport, destination après remise. L'interface doit distinguer une position GPS réelle d'une position métier déduite.

## CRM et pilotage

Le produit relie clients, lieux, demandes, commandes, livreurs, tournées, communications, encaissements et incidents. Les tableaux de bord mensuels permettent d'explorer les opérations sources et d'exporter les données autorisées en Excel.
