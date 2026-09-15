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

- vérifier le tri des livreurs utilisables avant les indisponibles ;
- vérifier que pause, hors service et incident empêchent l'affectation ;
- vérifier que la capacité et la charge active sont visibles ;
- répéter la conversion d'une même demande et vérifier qu'aucun doublon n'est créé.

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

## Test F2 — exécution et preuve

- refuser une transition qui saute des étapes ;
- envoyer deux fois simultanément la même action et vérifier un seul événement ;
- exiger un motif pour échec, retour et annulation ;
- générer deux fois la même requête OTP et obtenir le même résultat ;
- vérifier qu'un mauvais code retire exactement un essai ;
- vérifier qu'un nouveau code révoque l'ancien ;
- vérifier qu'un code correct crée une seule preuve et passe la commande à `Livrée` ;
- vérifier qu'après livraison le lien public ne contient plus latitude ni longitude ;
- créer puis résoudre un incident sans modifier sa description d'origine.

## Test F3 — encaissement et rapprochement

- configurer puis modifier un montant avant collecte ;
- retirer une exigence avec motif puis la réactiver ;
- répéter une même collecte et vérifier un seul événement ;
- annuler une saisie avant la fin de livraison ;
- refuser un écart sans justification ;
- enregistrer un écart et bloquer la remise OTP ;
- rapprocher l'écart avec un rôle autorisé puis permettre la remise ;
- vérifier la conservation de tous les événements financiers.

## Test F4 — dossier d'incident et conservation

- vérifier que l'ouverture crée le premier événement et que sa chaîne d'empreintes est valide ;
- ajouter puis répéter une note avec la même clé sans créer de doublon ;
- attribuer le dossier à un membre actif de l'entreprise ;
- refuser attribution, gel et export depuis une autre entreprise ou un rôle insuffisant ;
- activer un gel avec motif et date de révision, puis refuser un second gel actif ;
- exporter le dossier, vérifier son empreinte et la présence de ses sources ;
- lever le gel avec motif et vérifier l'idempotence ;
- résoudre l'incident sans altérer la déclaration initiale ;
- modifier volontairement un événement dans une base de test et vérifier que la chaîne devient invalide.

## Test F5 — ajustements financiers après clôture

- refuser une commande non terminée, une commande d'une autre entreprise et un rôle opérateur ;
- refuser un motif trop court, une date future et une date antérieure à la clôture ;
- rembourser une partie du montant et vérifier le total net ;
- répéter la requête avec la même clé sans créer une seconde écriture ;
- refuser la même clé avec des paramètres différents ;
- refuser un remboursement supérieur au total net ;
- envoyer deux remboursements concurrents et vérifier que le total ne devient jamais négatif ;
- ajouter un complément, puis le corriger avec une écriture inverse unique ;
- vérifier qu'aucune route ne modifie ou ne supprime une écriture existante ;
- vérifier la présence du journal dans la fiche commande et dans l'export d'incident.

## Test G — confirmation et modification client

- vérifier la redirection vers la page de confirmation ;
- modifier la demande avec le token d'édition ;
- valider côté entreprise puis vérifier que l'édition est bloquée ;
- tester expiration, révocation et double soumission.

## Test G2 — comptes et espace livreur

- créer une invitation livreur et vérifier son expiration à 48 heures ;
- activer le compte puis refuser une seconde utilisation du même lien ;
- vérifier la redirection du compte livreur vers `/driver` ;
- désactiver le profil pendant une session et vérifier le refus immédiat ;
- vérifier qu'un livreur ne peut pas appeler `/api/app/*` ;
- affecter deux commandes à deux livreurs et tenter de manipuler leurs identifiants ;
- vérifier que lecture, transition et incident sur la commande étrangère répondent comme introuvables ;
- répéter une transition et vérifier qu'un seul événement est créé.
- déclarer un encaissement exact puis répéter la requête sans créer un second mouvement ;
- déclarer un écart sans motif et vérifier son refus, puis avec motif et vérifier le blocage de la remise ;
- vérifier que seul un responsable peut rapprocher l'écart ;
- vérifier que le livreur ne peut ni générer ni lire le code de remise ;
- répéter une mauvaise saisie OTP avec la même clé et vérifier qu'un seul essai est consommé ;
- vérifier l'auteur livreur sur la collecte et la preuve, puis masquer toute commande étrangère.
- activer une photo obligatoire et vérifier qu'elle bloque la remise tant qu'elle manque ;
- refuser un fichier déguisé en image et un fichier trop lourd ;
- refuser l'ajout ou la lecture d'une preuve appartenant à un autre livreur ;
- répéter le même envoi et vérifier une seule preuve ;
- vérifier la lecture privée par le livreur affecté et l'entreprise, jamais par le lien client ;
- remplacer une preuve et vérifier que l'ancien contenu binaire n'est plus servi.

## Test H — tournée multi-colis

- créer une tournée puis répéter la requête avec la même clé sans doublon ;
- refuser une seconde tournée ouverte pour le même livreur et la même date ;
- affecter plusieurs commandes au même livreur et respecter sa capacité ;
- refuser un colis d'un autre livreur, d'une autre entreprise ou déjà actif dans une tournée ;
- envoyer deux ajouts concurrents avec la même version et obtenir exactement un conflit ;
- ordonner puis réordonner les arrêts, y compris lorsqu'ils sont planifiés ;
- retirer un arrêt intermédiaire en brouillon, vérifier la séquence puis le réajouter ;
- vérifier qu'une suggestion ne change ni l'ordre ni la version avant confirmation ;
- refuser la suggestion si une destination n'a pas de coordonnées ;
- annuler avec motif, libérer les colis et conserver l'historique ;
- refuser ajout et retrait après planification ;
- refuser la clôture avant que tous les colis soient terminaux ;
- vérifier que chaque client ne voit toujours que sa commande ;
- contrôler l'affichage de la date sur plusieurs fuseaux horaires.
- activer un compte livreur lié et vérifier qu'il ne voit que ses tournées planifiées ou actives ;
- vérifier que l'ordre du manifeste correspond exactement à l'ordre confirmé au bureau ;
- terminer le premier arrêt et vérifier le déplacement du prochain arrêt et la progression ;
- vérifier que les commandes non planifiées restent dans « Hors tournée » sans doublon ;
- ouvrir la fiche d'un arrêt et vérifier son rang et son contexte de tournée ;
- contrôler le manifeste sur un écran mobile de 390 px sans débordement horizontal.

## Test H2 — coupure réseau du livreur

- ouvrir une commande en ligne puis couper le réseau ;
- conserver une transition et un incident avec leurs clés d'idempotence ;
- refuser une seconde transition locale sur la même commande ;
- rétablir le réseau et vérifier un seul événement de statut et un seul incident ;
- provoquer un conflit serveur et conserver l'action en état « à vérifier » ;
- simuler une session expirée et ne jamais rejouer sous un autre compte ;
- refuser hors ligne l'encaissement, l'OTP, la photo et la signature ;
- vérifier la limite de 30 actions et l'expiration après 24 heures ;
- vérifier que Cache Storage ne contient aucune URL `/api/` ;
- vérifier `Cache-Control: private, no-store` sur toutes les API authentifiées.

## Test I — cartes

- vérifier que `GET /api/app/operations-map` exige une session d'exploitation et filtre simultanément par `company_id` ;
- vérifier qu'aucun identifiant technique Traccar n'est envoyé au navigateur ;
- vérifier la charge active, les incidents, les tournées ouvertes et l'ordre des arrêts ;
- vérifier qu'une commande livrée est exclue et qu'une commande sans latitude/longitude reste sans marqueur ;
- simuler une panne Traccar et conserver commandes, destinations et tournées avec un avertissement ;
- tester la carte d'exploitation à 390 px sans débordement horizontal ;
- tester le filtre des destinations et la sélection d'un livreur ;
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
