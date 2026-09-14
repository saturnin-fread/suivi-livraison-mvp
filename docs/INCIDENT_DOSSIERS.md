# Dossiers d'incident et gel de conservation

## Finalité

Un incident est un dossier rattaché à une commande. La déclaration d'origine et sa résolution ne sont jamais réécrites. Les appels, constats, attributions et décisions ultérieures sont ajoutés dans `incident_events`.

Chaque événement contient l'acteur, l'heure serveur, le type, le contenu, une clé d'idempotence et une empreinte reliée à l'événement précédent. Cette chaîne détecte une modification ou une suppression dans la chronologie ; elle ne remplace ni les sauvegardes ni le contrôle des administrateurs de base de données.

## Accès et responsabilités

- tout membre d'exploitation peut consulter un dossier et ajouter une note factuelle ;
- seuls un propriétaire ou un manager peuvent attribuer le dossier, exporter toutes ses données et gérer un gel de conservation ;
- le livreur peut déclarer un incident uniquement sur sa commande, mais n'accède pas au dossier interne complet ;
- chaque export est inscrit dans l'audit avec l'utilisateur et l'empreinte du manifeste.

## Gel de conservation

Le gel s'applique à toute la commande et à ses incidents, événements, paiements et preuves. Il exige un motif et une date de prochaine révision dans les douze mois. Cette date est un rappel de gouvernance, pas une expiration automatique : seul un propriétaire ou manager peut lever le gel avec un nouveau motif.

Le système ne fixe pas une durée juridique universelle. L'entreprise responsable des données doit documenter les durées normales et les délais applicables dans son pays et son activité. Un futur mécanisme de purge devra toujours exclure les commandes ayant un gel actif, puis anonymiser ou supprimer les autres données arrivées à échéance.

## Export

La page du dossier peut être imprimée ou enregistrée en PDF. L'export JSON contient les faits de l'incident, la commande, les événements de statut, les paiements, les preuves de remise, les métadonnées des fichiers et l'historique des gels. Les binaires photo/signature restent dans les routes privées ; le JSON conserve leurs empreintes SHA-256. Les clés d'idempotence, empreintes de requêtes, secrets et identifiants techniques Traccar sont exclus des réponses.

Le manifeste exporté contient sa propre empreinte canonique et le résultat de vérification de la chaîne d'événements. Une chaîne invalide doit déclencher une investigation avant d'utiliser le dossier.

## Références

- CNIL, durées de conservation : définir une durée selon la finalité, archiver séparément les données probatoires et supprimer ou anonymiser à échéance.
- CNIL, tracer les opérations : journaliser les accès et opérations, protéger les traces et adapter la durée en cas de contentieux.
- OWASP Logging Cheat Sheet : enregistrer qui, quand, où et quoi, protéger les journaux et détecter leur altération.
- NIST SP 800-61r3 : préserver l'intégrité des dossiers d'incident et appliquer une chaîne de conservation lorsque nécessaire.
