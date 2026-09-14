# Erreurs et cas limites à traiter

## Formulaire client

| Cas | Comportement attendu |
|---|---|
| GPS refusé | Permettre quartier + repère + téléphone, afficher que la position est manquante |
| GPS imprécis | Afficher la précision et proposer de déplacer le marqueur |
| GPS hors délai | Afficher la date de mesure, ne pas présenter la position comme actuelle |
| Téléphone invalide | Demander une correction sans perdre les autres champs |
| Double clic sur envoyer | Empêcher les doublons avec désactivation et idempotence serveur |
| Mauvaise connexion | Conserver les champs et proposer de réessayer |
| Lien expiré | Afficher un message et un moyen de contacter l’entreprise |
| Client revient plus tard | Recharger la demande sans écraser des données validées sans avertissement |
| Client modifie pendant la validation | Refuser la version obsolète et recharger l'état validé |
| Token d'édition partagé | Permettre la révocation et tracer la modification sans exposer les secrets |

## Entreprise

| Cas | Comportement attendu |
|---|---|
| Aucun livreur disponible | Autoriser la mise en attente ou le choix manuel d’un livreur en tournée |
| Position du livreur ancienne | Ne pas le classer comme disponible en temps réel |
| Plusieurs livraisons | Afficher le nombre actif et la zone, sans bloquer automatiquement l’affectation |
| Deux opérateurs modifient la même demande | Vérifier le statut côté serveur et signaler le conflit |
| Commande annulée après affectation | Libérer la commande et recalculer la disponibilité du livreur |
| Adresse introuvable | Utiliser coordonnées + repères + appel client |
| Tournée réordonnée | Recalculer les estimations, demander confirmation et tracer l'auteur |
| Colis sans GPS individuel | Afficher une position déduite clairement identifiée |
| Estimation impossible | Afficher le statut et la dernière position sans inventer une heure d'arrivée |
| Double clic sur une étape | Retourner le même résultat grâce à la clé d'idempotence |
| Deux opérateurs avancent la même commande | Verrouiller la ligne puis refuser l'action devenue incohérente |
| Mauvais code de remise | Décrémenter les essais, ne jamais journaliser le code et révoquer après la limite |
| Code expiré ou régénéré | Refuser la remise et demander un nouveau code |
| Livraison sans preuve | Interdire le passage manuel à `Livrée` |
| Incident résolu | Conserver la déclaration initiale et ajouter la résolution séparément |
| Montant attendu modifié après collecte | Refuser et demander d'abord une annulation motivée |
| Somme reçue différente | Exiger un motif et un rapprochement responsable avant remise |
| Double déclaration de collecte | Retourner le même résultat sans doubler le montant |
| Encaissement saisi par erreur | Permettre l'annulation avant fin de livraison et garder les deux événements |
| Correction après livraison terminée | Refuser l'annulation simple et exiger un futur ajustement comptable |
| Invitation déjà utilisée ou expirée | Refuser sans recréer ni modifier le compte |
| E-mail déjà associé à un compte | Refuser l'invitation tant que le sélecteur multi-entreprises n'existe pas |
| Profil livreur déjà lié | Empêcher la création d'un second compte pour le même profil |
| Livreur désactivé avec session ouverte | Refuser immédiatement toutes les API livreur |
| Livreur modifie l'identifiant d'une commande | Filtrer aussi par `driver_id` et répondre comme si la commande était introuvable |
| Manager tente d'inviter ou révoquer un manager | Refuser ; cette autorité reste au propriétaire |

## Cartographie et temps réel

| Cas | Comportement attendu |
|---|---|
| Position Traccar ancienne | Afficher l'âge de la position et arrêter le suivi automatique |
| GPS saute de plusieurs kilomètres | Écarter le point aberrant de l'ETA et conserver l'anomalie pour diagnostic |
| WebSocket interrompu | Passer temporairement au rafraîchissement contrôlé et se reconnecter progressivement |
| Fournisseur de carte indisponible | Conserver les informations textuelles et proposer de réessayer |
| Itinéraire non calculable | Utiliser une distance indicative clairement marquée, sans tracer une fausse route |
| Permission de localisation client refusée | Ne pas redemander en boucle et expliquer comment l'activer |
| Livraison terminée | Cesser d'exposer la position précise du livreur |
| Plusieurs clients dans la tournée | Ne jamais envoyer les autres arrêts dans l'API publique |

## Système

- Les appels Traccar doivent avoir un timeout.
- Les erreurs internes ne doivent pas exposer les identifiants.
- Les endpoints publics doivent être limités en débit.
- Les endpoints d’entreprise doivent vérifier l’entreprise de l’utilisateur, pas seulement l’identifiant de l’objet.
- Les opérations de conversion demande → commande doivent être transactionnelles.
- Chaque erreur importante doit posséder un identifiant de corrélation dans les logs.
