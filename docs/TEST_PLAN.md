# Plan de tests fonctionnels

## Test A — demande client complète

1. Créer un lien de formulaire.
2. Ouvrir le lien sur un téléphone HTTPS.
3. Remplir nom, téléphone, quartier et créneau.
4. Autoriser la position.
5. Vérifier la précision et le marqueur.
6. Envoyer.
7. Vérifier la demande côté entreprise.

## Test B — GPS refusé

Refuser la permission et vérifier que l’application demande un repère et ne prétend pas connaître la position.

## Test C — GPS imprécis

Déplacer le marqueur et vérifier que la position modifiée est enregistrée avec une précision adaptée.

## Test D — disponibilité livreur

Vérifier les états en ligne, position ancienne, hors ligne et plusieurs livraisons actives.

## Test E — sécurité

- ouvrir une demande inexistante ;
- modifier un token ;
- appeler un endpoint admin sans session ;
- vérifier qu’aucun secret Traccar n’est présent dans le navigateur ;
- vérifier qu’une entreprise ne lit pas les données d’une autre.

## Test F — reprise

- redéployer `delivery-app` ;
- vérifier que les demandes et commandes restent présentes ;
- arrêter temporairement Traccar ;
- vérifier que l’interface affiche une position ancienne ou indisponible sans planter.

## Test G — confirmation et modification client

- vérifier la redirection vers la page de confirmation ;
- modifier la demande avec le token d'édition ;
- valider côté entreprise puis vérifier que l'édition est bloquée ;
- tester expiration, révocation et double soumission.

## Test H — tournée multi-colis

- affecter plusieurs commandes au même livreur ;
- ordonner puis réordonner les arrêts ;
- vérifier le recalcul des estimations ;
- vérifier que chaque client ne voit que sa commande.

## Test I — cartes

- tester ma position, recentrage, vue complète et suivi automatique ;
- tester carte et satellite avec les attributions obligatoires ;
- simuler position ancienne, point aberrant et coupure réseau ;
- vérifier la distinction trajet réalisé, position actuelle et route restante ;
- vérifier que le suivi précis s'arrête après la livraison.

## Test J — CRM, statistiques et exports

- vérifier les vues filtrées et les relations client/livraison/livreur ;
- recalculer manuellement un échantillon d'indicateurs ;
- vérifier les feuilles et filtres d'un export Excel ;
- vérifier qu'un rôle non autorisé ne peut pas exporter ;
- vérifier la journalisation de chaque export.
