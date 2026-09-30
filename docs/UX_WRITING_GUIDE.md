# Guide de rédaction TRAXO

À relire avant d'écrire un libellé, un message d'erreur ou un écran. Le but :
qu'un gérant, un opérateur ou un livreur qui découvre TRAXO comprenne du
premier coup, sans formation — y compris sur un petit téléphone, en plein
soleil, avec une connexion lente.

## 1. Les 8 règles

1. **Écrire comme on parle au comptoir.** Mots courants, phrases courtes
   (15 mots max), voix active. « Le client ne peut plus modifier sa demande »,
   pas « Les informations sont verrouillées ».
2. **Un bouton = un verbe + ce qu'il fait.** « Créer la commande »,
   « Changer de livreur », « Désactiver le lien ». Jamais « OK », « Valider »
   seul, « Confirmer » seul ou « Soumettre ».
3. **Le bouton de confirmation répète l'action.** Fenêtre « Archiver ce
   client ? » → bouton « Archiver », pas « Oui ».
4. **Une erreur dit ce qui s'est passé et quoi faire.** « Ce numéro semble
   incomplet : au Bénin, 10 chiffres commençant par 01. » Pas « Entrée
   invalide ». Jamais de code technique, jamais de reproche.
5. **Un écran vide propose la suite.** « Aucune tournée aujourd'hui. Elle se
   crée seule dès qu'une commande est affectée à un livreur. »
6. **Un mot = une chose, partout.** Voir le glossaire ci-dessous. Si on dit
   « Commande » dans la liste, on ne dit pas « Course » dans le tiroir.
7. **Pas de jargon technique ni d'anglais.** Ni « tracking », « pipeline »,
   « gallery », « token », « GPS exploitable », « moteur d'itinéraire »,
   « idempotence », « payload ». Si la notion est nécessaire, on l'explique
   en une phrase.
8. **Les chiffres parlent seuls.** « 25 colis · capacité 3 » plutôt que
   « 25/3 » ; « il y a 5 min » plutôt qu'une heure brute quand c'est récent ;
   montants en « FCFA » avec espace fine des milliers (1 000 FCFA).

## 2. Ton

- **Vouvoiement** partout (clients, équipe, livreurs).
- Sobre et rassurant : pas de points d'exclamation en série, pas d'emoji dans
  l'interface, pas de superlatifs (« en toute simplicité », « puissant »).
- On parle **au nom de l'entreprise** sur les pages client (« Chicago Consulting
  Group vérifie vos informations »), au nom de TRAXO seulement dans le
  back-office.

## 3. Glossaire (termes imposés)

| Terme | Définition | À ne pas utiliser |
|---|---|---|
| **Demande** | Ce que le client remplit via le lien (ou que l'équipe prépare) avant validation. | formulaire, lead, capture |
| **Commande** | Livraison validée, avec ou sans livreur. Numéro `CMD-AAAA-NNNN`. | course, colis (pour l'objet), ordre |
| **Colis** | L'objet transporté ; unité de charge d'un livreur. | paquet, item |
| **Tournée** | Les commandes du jour d'un livreur, dans l'ordre de passage. Créée automatiquement. | run, circuit |
| **Arrêt** | Une commande dans une tournée. | stop |
| **Livreur** | Personne qui livre. | coursier, driver |
| **Lien de suivi** | Lien envoyé au client pour suivre sa livraison. | tracking, token |
| **Lien client** (demande) | Lien envoyé au client pour remplir sa demande. | formulaire client |
| **Position GPS** | Emplacement exact partagé depuis un téléphone. | coordonnées, géolocalisation |
| **Repère** | Indication pour trouver le lieu (« portail vert, près de la pharmacie »). | landmark |
| **Incident** | Problème pendant une livraison (client injoignable, colis abîmé…). | ticket, anomalie |
| **Paiement à la livraison** | Montant que le livreur encaisse à la remise. | encaissement (sauf compta), COD |
| **Preuve de livraison** | Photo ou signature prises à la remise. | preuve complémentaire |

### Statuts affichés

| Objet | Valeur technique | Libellé affiché |
|---|---|---|
| Demande | En attente d'informations | En attente du client |
| Demande | À vérifier | À valider |
| Demande | Informations à compléter | À compléter par le client |
| Demande | Validée | Validée |
| Demande | Confirmée | Commande créée |
| Tournée | draft | En préparation |
| Tournée | planned | Planifiée |
| Tournée | active | En cours |
| Tournée | completed | Terminée |
| Carte | stale | Signal ancien |

Les valeurs techniques restent inchangées en base : seul l'affichage suit ce
tableau (`requestStatusLabel`, `runStatusLabels` dans `public/app.js`).

## 4. Modèles prêts à l'emploi

- **Confirmation destructive** : titre = question (« Désactiver le lien de
  suivi ? »), message = conséquence (« Le client ne pourra plus suivre sa
  livraison. »), bouton = verbe (« Désactiver »), ton rouge.
- **Succès** (notification) : ce qui a changé, au passé. « Livreur changé. »
- **Aide sous un champ** : à quoi sert l'information ou son format attendu.
  « Pour vous joindre à l'arrivée. »
- **Champ facultatif** : « (facultatif) » dans le libellé ; les champs
  obligatoires portent « * ».

## 5. Accessibilité

- Toute icône seule a un `aria-label` ou un `title` en français.
- Le texte d'un lien dit où il mène (« Voir la commande », pas « ici »).
- Contraste suffisant ; ne jamais transmettre une information par la seule
  couleur (un statut rouge a aussi un mot).
