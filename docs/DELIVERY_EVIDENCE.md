# Preuves photo et signature

## Règle métier

Le code client reste la preuve principale. La photo et la signature sont désactivées par défaut puis configurables séparément comme `off`, `optional` ou `required` dans `/app/parametres`.

Une preuve obligatoire manquante bloque la validation OTP côté serveur. Une preuve facultative n'empêche jamais la remise. Le livreur ne peut ajouter une preuve que pendant les étapes `En livraison` ou `Arrivée` et uniquement sur une commande qui lui est affectée.

## Protection et corrections

- seuls JPEG et PNG sont acceptés ; le type déclaré et la signature binaire sont contrôlés ;
- taille maximale après compression : 1,2 Mo ; la photo est réduite côté mobile avant envoi ;
- le nom original n'est pas conservé et aucun chemin de fichier n'est accepté du navigateur ;
- le fichier est servi uniquement par une route authentifiée, avec contrôle entreprise/livreur, `no-store` et `nosniff` ;
- aucune preuve complémentaire n'est exposée sur le lien public du client ;
- une nouvelle prise remplace la précédente ; les métadonnées et l'audit restent, mais l'ancien contenu binaire est supprimé ;
- les doubles envois avec la même clé d'idempotence ne créent pas de doublon.

La consigne d'usage est de photographier le colis ou le lieu sans visage ni pièce d'identité et de demander l'accord avant une signature.

## Stockage MVP et évolution

Le fichier actif est stocké dans PostgreSQL `delivery` afin qu'il soit inclus dans la sauvegarde et ne dépende pas du disque éphémère du conteneur Railway. Cette solution est volontairement limitée à de petits fichiers et au pilote. Avant montée en charge, migrer le contenu vers un stockage objet privé avec URL signée courte, chiffrement, analyse anti-malware, quotas et politique de suppression automatisée. PostgreSQL conservera les métadonnées, empreintes et événements.

## Références

- OWASP File Upload Cheat Sheet : liste blanche, signature du fichier, limite de taille, nom généré, stockage privé et autorisation.
- ICO, principes de minimisation et limitation de conservation : ne collecter et conserver que ce qui est nécessaire à la finalité.
