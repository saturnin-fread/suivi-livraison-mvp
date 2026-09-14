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
| Livreur déclare une somme sur un autre colis | Répondre comme introuvable et ne créer aucun événement financier |
| Livreur reçoit moins que prévu | Enregistrer le fait et son motif, puis bloquer la remise jusqu'au rapprochement responsable |
| Double appui sur l'encaissement terrain | Retourner le premier résultat avec la même clé d'idempotence |
| Livreur tente de générer le code client | Ne fournir aucune route livreur de génération ou de lecture du code |
| Mauvaise saisie OTP répétée après une coupure | Avec la même clé, ne consommer qu'un seul essai et retourner le même résultat |
| Fichier renommé en `.png` mais contenu invalide | Refuser selon la signature binaire, pas seulement le nom ou l'en-tête déclaré |
| Photo trop lourde | Compresser côté mobile, limiter côté serveur et expliquer comment reprendre |
| Photo/signature obligatoire absente | Bloquer la remise côté serveur et indiquer la preuve manquante |
| Mauvaise photo prise | Autoriser un remplacement avant remise, supprimer l'ancien binaire et conserver la trace |
| URL de preuve devinée | Exiger une session et contrôler `company_id` puis `driver_id` pour le portail terrain |
| Preuve sur lien client | Ne jamais inclure le fichier ni son identifiant dans l'API publique |
| Note d'incident envoyée deux fois | Retourner le premier événement sans doubler la chronologie |
| Deux responsables attribuent simultanément le dossier | Sérialiser sur l'incident et ne pas rejouer une ancienne action idempotente |
| Opérateur tente un gel ou un export complet | Refuser côté serveur ; réserver l'action au propriétaire ou manager |
| Gel déjà actif | Refuser un second gel et afficher la date de révision existante |
| Date de révision dépassée | Conserver le gel, le signaler comme à revoir et exiger une décision humaine |
| Levée répétée après une coupure | Retourner la première levée sans créer un second événement |
| Chaîne d'empreintes invalide | Signaler le dossier comme non vérifié et déclencher une investigation |
| Export de dossier | Journaliser l'auteur et l'empreinte, ne jamais inclure de secret ni de code OTP |
| Double création de tournée | Retourner la tournée créée avec la même clé, sans doublon |
| Deux tournées ouvertes même livreur/date | Refuser la seconde et indiquer la tournée déjà ouverte |
| Colis dans deux tournées | Autoriser une seule affectation active et conserver les affectations historiques |
| Colis d'un autre livreur ou d'une autre entreprise | Refuser côté serveur sans révéler les données étrangères |
| Capacité atteinte | Refuser l'ajout et afficher la capacité déclarée |
| Deux opérateurs modifient l'ordre | Accepter la première version et demander au second de recharger |
| Retrait d'un arrêt intermédiaire | Libérer le colis, conserver la trace et refermer la séquence sans collision |
| Suggestion avec GPS manquant | Lister les commandes concernées et ne modifier aucun arrêt |
| Suggestion géométrique | L'annoncer à vol d'oiseau, sans route, durée, trafic ni créneau garanti |
| Annulation de tournée | Exiger un motif, conserver les arrêts et libérer les affectations actives |
| Clôture prématurée | Refuser tant que tous les colis ne sont pas dans un état terminal |
| Date affichée la veille | Sérialiser la date civile sans conversion de fuseau horaire |

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
