# Fonctionnement hors connexion du portail livreur

## Objectif du premier lot

Le portail livreur tolère une coupure courte pendant qu'une commande est déjà ouverte. Il ne prétend pas être une application totalement hors ligne : les données de commande authentifiées ne sont jamais copiées dans le cache du navigateur.

## Actions conservées temporairement

Deux actions JSON, déjà protégées côté serveur par une clé d'idempotence, peuvent rejoindre la file locale :

- changement d'étape d'une commande ;
- déclaration d'un incident.

Les actions sont rejouées dans leur ordre de saisie, une par une. La même clé d'idempotence est conservée pendant toutes les tentatives. Une transition en attente bloque une seconde transition locale sur la même commande.

## Actions qui restent obligatoirement en ligne

- vérification du code de remise : code expirant, essais limités et état financier à vérifier en direct ;
- déclaration d'un encaissement : mouvement financier à confirmer immédiatement ;
- photo ou signature : contenu sensible et volumineux qui ne doit pas rester dans le stockage local pendant le pilote.

L'interface explique ce blocage au livreur au lieu de simuler un succès.

## Stockage, confidentialité et durée

- IndexedDB conserve uniquement la requête nécessaire, son type, la commande, l'heure et la clé d'idempotence ;
- chaque élément est rattaché à l'entreprise, au compte et au profil livreur connectés ;
- maximum 30 actions par compte ;
- suppression après confirmation du serveur ;
- expiration et suppression automatiques après 24 heures ;
- nettoyage de la file du compte lors d'une déconnexion volontaire ;
- aucune réponse `/api/*`, commande, position, preuve ou donnée client n'est placée dans le cache du service worker.

Une description d'incident peut contenir des données personnelles. Le livreur doit éviter les informations non nécessaires et ne pas partager son téléphone pendant qu'une action attend la synchronisation.

## Synchronisation et erreurs

- retour au premier plan avec réseau : tentative automatique ;
- événement `online` : tentative automatique ;
- bouton **Synchroniser** : solution disponible sur tous les navigateurs compatibles IndexedDB ;
- Background Sync, lorsqu'il existe, demande à la page ouverte de lancer la reprise ; il ne rejoue jamais seul une action sous la session éventuelle d'un autre compte.

Les erreurs réseau et `5xx` restent en attente. Les réponses `400`, `401`, `403`, `404`, `409` ou `422` passent en état « à vérifier » et ne sont jamais supprimées silencieusement. Une erreur sur la première action arrête le lot afin de préserver l'ordre métier.

## Limites connues

- le premier affichage hors ligne d'une commande jamais ouverte n'est pas pris en charge ;
- après fermeture complète du navigateur, la reprise attend la réouverture du portail ;
- une action expirée après 24 heures doit être ressaisie après vérification de l'état réel dans l'entreprise ;
- la file locale n'est pas une source de vérité : seule la confirmation du serveur fait foi.

## Vérification

Le test `scripts/driver-offline-browser-test.js` couvre :

- une transition et un incident saisis sans réseau ;
- leur reprise et l'absence de doublon ;
- un conflit métier conservé pour intervention ;
- le refus d'un encaissement hors ligne ;
- l'absence de réponses API sensibles dans Cache Storage ;
- l'en-tête `Cache-Control: private, no-store` des API.

## Références de conception

- [MDN — IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [MDN — Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
- [web.dev — Service worker caching and HTTP caching](https://web.dev/articles/service-worker-caching-and-http-caching)
- [W3C — Service Workers](https://www.w3.org/TR/service-workers/)

Background Sync n'étant pas disponible partout, le produit ne dépend jamais de lui pour rendre une action récupérable.
