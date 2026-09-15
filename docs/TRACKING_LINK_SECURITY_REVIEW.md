# Revue de sécurité des liens publics de suivi

Date de la revue : 15 septembre 2026  
Périmètre : liens `/suivi/:token`, API `GET /api/tracking/:token`, création et restitution des liens dans l’espace entreprise, schéma `tracking_links`, journaux, cache et migration.  
Nature : revue indépendante ; aucun code d’exécution n’a été modifié.

## Décision

**NO-GO pour déployer l’état de travail inspecté, puis pour un lancement multi-entreprises avec des données réelles tant que les P0 ci-dessous ne sont pas corrigés et vérifiés localement puis sur l’URL publique.**

### Addendum d’intégration — 15 septembre 2026

Les cinq P0 de cette photographie ont ensuite été corrigés dans l’intégration centrale : migration `dual` puis `encrypted_only`, version attendue avec verrou de ligne, ledger `tracking_link_events`, retrait des chemins des listes, révélation unitaire auditée et démo refusée en production. Les tests locaux PostgreSQL couvrent aussi un succès + un conflit `409` lors de deux renouvellements réellement concurrents, ainsi que le rejeu tardif d’une ancienne révocation.

La décision devient **GO local / NO-GO public provisoire** jusqu’à réussite du déploiement en deux phases, du smoke test public et du contrôle de la colonne historique. Le P1 distribué reste ouvert : une seule réplique est autorisée tant que les quotas ne sont pas stockés dans Redis. La clé dédiée `TRACKING_TOKEN_SECRET` doit être créée avant la phase publique.

Le suivi actuel possède déjà de bons garde-fous : jetons générés avec un générateur cryptographique, requêtes SQL paramétrées, GPS masqué hors des états autorisés, DTO public limité à une commande, validation des coordonnées, `Cache-Control: private, no-store`, `Referrer-Policy: origin` et arrêt du rafraîchissement après un état terminal. Deux lots parallèles ont aussi ajouté une politique de cycle de vie, des routes de rotation/révocation, un stockage empreinté et chiffré ainsi qu’une limitation d’abus. La dernière version relue est syntaxiquement valide, mais conserve des défauts P0 de concurrence, révélation en masse et rollback de migration.

## Constats vérifiés dans le code

| État actuel | Preuve observée | Conséquence |
|---|---|---|
| Jeton suffisamment aléatoire | `randomToken(24)` utilise `crypto.randomBytes(...).toString('base64url')` dans `server.js`, soit 192 bits pour les liens créés | Bonne résistance à la devinette si le jeton n’est pas divulgué |
| Mode démo désactivé par défaut, mais secret de repli encore prévisible | `DEMO_TRACKING_ENABLED === 'true'` est désormais requis, ce qui est un progrès ; lorsque le mode est activé sans `DEMO_TRACKING_TOKEN`, une valeur intégrée au code reste utilisée et contourne `tracking_links` | Une erreur de configuration peut encore exposer le périphérique Traccar par défaut sans cycle de vie persistant |
| Stockage migré vers empreinte + chiffré | Les créations écrivent maintenant `token_hash`, `token_ciphertext` et une échéance de 7 jours ; la lecture publique cherche l’empreinte et contrôle révocation/expiration | Bonne intégration fonctionnelle de base, sous réserve des tests PostgreSQL et de rollback encore absents |
| Chiffrement récupérable et révélation en masse | AES-256-GCM protège contre une lecture isolée de la base, mais la clé peut retomber sur les secrets OTP/session. La liste des 100 commandes déchiffre et renvoie un chemin complet pour chaque lien actif | Une seule session opérateur ou extension navigateur compromise peut extraire tous les liens actifs de l’entreprise |
| Expiration harmonisée à la création | `lib/tracking-link-policy.js` et les deux créations appliquent désormais 7 jours par défaut, avec 30 jours maximum à la rotation | Progrès ; il manque encore l’extinction complète après la grâce terminale et les tests de migration réels |
| Révocation/rotation disponibles | Routes entreprise, verrou `FOR UPDATE`, motif, audit, empreinte et version sont présents ; la lecture publique refuse les états révoqué/expiré avec un message générique | Le cycle existe, mais sa concurrence et son idempotence ne résistent pas encore aux opérations successives |
| Une seule ligne par commande | `order_id` est `UNIQUE` | Le modèle empêche aujourd’hui de conserver plusieurs secrets actifs, mais aussi de représenter proprement l’historique dans la même table |
| GPS borné aux états opérationnels | `publicTrackingPositionStatuses` et le refus par défaut dans la route publique de `server.js` | Une commande en préparation, en échec ou terminée ne révèle pas la position du livreur |
| Cloisonnement partiellement assuré | Le suivi joint le livreur à la commande avec `d.company_id = o.company_id`, mais `tracking_links` ne porte pas `company_id` | Les données publiques sont liées par la commande, mais les futures mutations de lien n’ont pas encore de contrainte SQL multi-tenant propre |
| Cache HTTP protégé | Toutes les API reçoivent `private, no-store`; la page de suivi reçoit le même contrôle dans sa route serveur | Les caches conformes ne doivent pas conserver les réponses personnalisées |
| Référent réduit à l’origine | En-tête serveur et balise HTML `origin` | Le chemin contenant le jeton n’est pas transmis aux tuiles cartographiques ; l’origine reste visible |
| Limite de débit locale ajoutée | `/api/tracking/:token` applique désormais des quotas IP et jeton avec clés opaques, plafond de cardinalité, `Retry-After` et échec fermé | Bon socle pour un seul processus ; les compteurs restent en mémoire et ne sont ni partagés entre réplicas ni persistants lors d’un redémarrage |
| Pas d’audit du cycle de vie | La création de commande est auditée, pas la création/rotation/révocation/expiration du lien comme objets distincts | Impossible de démontrer qui a remplacé ou désactivé un accès public |

### Risques d’intégration résiduels à traiter avant toute exécution de migration publique

L’état inspecté combine des changements provenant de plusieurs équipes. Les modules isolés passent leurs tests unitaires et les chemins de création ont été raccordés pendant la revue. Trois défauts restent cependant déterminants :

1. au démarrage, les jetons historiques sont chiffrés/empreintés puis le champ compris par l’ancienne version est mis à `NULL` dans la même transaction ; un rollback Railway vers cette ancienne version ne pourrait plus servir ces liens ;
2. les routes ne demandent pas `expectedVersion`. Deux rotations de clés différentes sont sérialisées mais toutes deux réussissent : le second manager invalide immédiatement le lien que le premier vient de recevoir ;
3. une seule clé d’idempotence de rotation et une seule de révocation sont mémorisées sur la ligne. Une opération ultérieure efface ou remplace ce souvenir : le rejeu tardif d’une ancienne révocation peut alors révoquer un lien nouvellement roté.

**Conséquence : le script de migration au démarrage ne doit pas être exécuté sur la base publique avant un plancher de rollback sûr, un ledger d’opérations persistant et un smoke test transactionnel.** Les 27 tests de politique, les tests du limiteur et la vérification syntaxique prouvent les modules isolés, pas ces scénarios intégrés.

## Priorités

### P0 — blocants avant ouverture réelle

| ID | Risque | Correction obligatoire | Preuve de sortie |
|---|---|---|---|
| P0-01 | **Rollback destructif pour les liens historiques.** Le démarrage met `token=NULL`; l’ancienne version Railway ne sait lire que ce champ. | Déployer d’abord une version de compatibilité qui sait lire empreinte/chiffré sans effacer le clair, valider et sauvegarder, puis seulement nettoyer. Définir le plancher de rollback avant la suppression. | Lien historique valide avant/après migration, redémarrage et rollback simulé ; aucun retour possible vers une version incompatible. |
| P0-02 | **Concurrence de rotation non maîtrisée.** Sans `expectedVersion`, deux responsables peuvent recevoir successivement deux liens dont le premier est déjà invalide. | Exiger la version observée, verrouiller la ligne et refuser `409` toute version obsolète. Un seul gagnant pour deux clés différentes sur la même version. | Test à deux connexions : un `2xx`, un `409`; le lien rendu au gagnant reste valide. |
| P0-03 | **Idempotence non durable.** Seule la dernière clé de chaque action est stockée ; une rotation peut effacer le contexte d’une révocation, puis son rejeu tardif agit sur la nouvelle génération. | Créer un ledger append-only unique par `(company_id, action, idempotency_key)`, avec empreinte, génération/version ciblée, état et résultat. Un rejeu ancien restitue son résultat historique sans muter la génération courante. | Séquence révoquer → rotater → rejouer l’ancienne révocation : le nouveau lien reste valide et le rejeu est reconnu. Même exigence pour plusieurs rotations successives. |
| P0-04 | **Révélation en masse des secrets actifs.** La liste des commandes déchiffre chaque lien pour construire `trackingLink.path`. | La liste/détail standard ne renvoie que statut, expiration et version. Prévoir un endpoint explicite, unitaire, autorisé, limité et audité pour « copier/renvoyer le lien », ou choisir l’empreinte seule avec rotation contrôlée. | Inspection réseau d’une liste de 100 commandes : zéro secret/path porteur ; révélation unitaire auditée seulement. |
| P0-05 | **Mode démo conditionnel mais encore dangereux si activé sans secret explicite.** | Refuser de démarrer la démo sans jeton aléatoire explicite, l’interdire dans l’environnement production et utiliser seulement un appareil synthétique. | Aucun fallback intégré ; test de configuration et vérification Railway. |

### P1 — requis avant montée en charge

| ID | Risque | Correction attendue | Preuve de sortie |
|---|---|---|---|
| P1-01 | Politique post-clôture incomplète malgré le défaut actuel de 7 jours | Conserver le défaut de 7 jours et le plafond de 30 jours ; GPS coupé immédiatement à l’état terminal ; lien entièrement expiré ou révoqué au plus tard 24 h après clôture. Toute extension ou dérogation doit être explicite et auditée. | Tests aux bornes avec l’horloge PostgreSQL, report de livraison, clôture, extension et plafond. |
| P1-02 | Absence de limitation de débit distribuée | Limiter avant tout appel Traccar : par lien + IP, par lien, par IP sur jetons invalides et au niveau global. Stockage partagé dès qu’il existe plusieurs réplicas. Répondre `429` avec `Retry-After`; le navigateur applique temporisation et gigue. | Test de rafale et de charge : quotas cohérents entre réplicas, zéro appel Traccar après rejet, reprise contrôlée. |
| P1-03 | `tracking_links` ne porte pas l’entreprise | Ajouter `company_id NOT NULL`, le remplir depuis `orders`, puis imposer une relation composite `(company_id, order_id)` vers `orders(company_id, id)`. Toutes les mutations prennent l’entreprise de la session, jamais du corps. | Matrice A/B : un owner de A ne peut ni voir, ni révoquer, ni rotater, ni prolonger un lien de B, même avec les identifiants exacts. |
| P1-04 | Exploitation et rétention du futur ledger d’idempotence | Définir une durée de conservation supérieure à la fenêtre maximale de rejeu, un nettoyage par lots et des métriques sur conflits/rejeux. Ne jamais réutiliser une clé supprimée pour muter une génération plus récente. | Tests après rotation, expiration et purge simulée ; aucune ancienne requête ne peut affecter le lien courant. |
| P1-05 | Jeton présent dans le chemin URL | Vérifier/redacter les journaux Railway, proxy, APM et analytics. À terme, échanger le secret contre un cookie `HttpOnly`, `Secure`, `SameSite=Lax` limité au suivi, puis rediriger vers une URL propre ; pour les nouveaux liens, un secret en fragment peut éviter son envoi dans l’URL HTTP. | Canari injecté : absent des logs et référents. Après échange, la barre d’adresse et les requêtes suivantes ne contiennent plus le secret. |
| P1-06 | États invalides pas encore couverts par un contrat uniforme complet | Faux, malformé, expiré, révoqué, remplacé, entreprise suspendue et lien inconnu renvoient le même statut public `404`, même schéma minimal et temps de traitement comparable. Une panne générale reste un `503` uniforme. | Tests comparatifs de corps, en-têtes, taille et latence p50/p95 sans révélation de l’existence d’une commande. |
| P1-07 | Audit incomplet ou trop bavard lors du futur ajout | Journaliser le cycle de vie avec `link_id`, `company_id`, `order_id`, génération, acteur, rôle, action, motif, résultat, heure serveur, corrélation et clé d’idempotence ; ne jamais journaliser jeton, empreinte du jeton, URL complète, téléphone, coordonnées ou notes. Les accès de rafraîchissement sont agrégés, pas inscrits toutes les dix secondes. | Test canari et revue des logs : événements explicables, aucune donnée interdite. |
| P1-08 | Clé de chiffrement non dédiée | Rendre `TRACKING_TOKEN_SECRET` obligatoire, suffisamment longue, indépendante et versionnée ; supprimer les fallbacks OTP/session avant production. | Démarrage refusé sans clé dédiée ; restauration avec bonne clé, échec sûr avec mauvaise clé, procédure de rotation testée. |

### P2 — durcissement après fermeture des P0/P1

| ID | Amélioration | Critère |
|---|---|---|
| P2-01 | En-têtes de défense | CSP adaptée à Leaflet et au fournisseur de tuiles, `X-Content-Type-Options: nosniff`, protection anti-clicjacking et `Permissions-Policy` limitant la géolocalisation à la page de suivi. |
| P2-02 | Politique de référent plus stricte | Préférer `no-referrer` si le fournisseur de tuiles l’accepte. Sinon conserver `origin`, jamais `unsafe-url` ni une politique transmettant le chemin. |
| P2-03 | Détection d’abus sans pistage excessif | Alertes sur taux de `404`, `429`, rotations, révocations et erreurs Traccar ; identifiants techniques pseudonymes et IP tronquée/à durée courte si elle est réellement nécessaire. |
| P2-04 | Rotation de la clé d’empreinte | `hash_key_version`, lecture avec clé courante et précédente pendant une fenêtre bornée, puis réempreinte contrôlée sans rendre les liens valides au-delà de leur expiration. |

## Contrat cible du lien public

### Jeton et stockage

- Au moins 24 octets aléatoires issus de `crypto.randomBytes`, encodés en base64url.
- Un jeton correspond à une seule commande et à une seule entreprise.
- La base conserve `token_hash`, jamais le secret brut après la migration.
- Utiliser une clé `TRACKING_TOKEN_PEPPER` distincte des mots de passe administrateur, du secret de session, de l’OTP et des clés WAHA/Traccar. Conserver une version de clé.
- Le lien complet n’apparaît qu’à sa création/rotation et dans le canal de remise choisi. La page « commandes » n’envoie plus `tracking_token` dans ses réponses.
- Pour revoir le suivi depuis l’espace entreprise, utiliser un endpoint authentifié par commande qui restitue le même DTO sans secret public.
- Une rotation n’allonge pas l’expiration ; prolonger est une action séparée, motivée et auditée.

### Schéma recommandé sans multiplier les lignes actives

Conserver une ligne courante par commande évite de casser immédiatement les jointures actuelles :

```text
tracking_links
  id
  company_id
  order_id UNIQUE
  token_hash UNIQUE
  hash_key_version
  generation
  version
  active
  expires_at NOT NULL
  revoked_at
  revoked_by_user_id
  revocation_reason
  rotated_at
  created_at
  updated_at

tracking_link_events (append-only)
  id
  company_id
  tracking_link_id
  order_id
  generation
  event_type
  actor_user_id
  reason
  idempotency_key
  request_fingerprint
  correlation_id
  details minimisés
  created_at
```

La chronologie porte les actions, pas les anciens secrets ni leurs empreintes. La contrainte composite entre lien et commande empêche un rattachement inter-entreprises au niveau SQL. Une Row-Level Security PostgreSQL en refus par défaut peut ensuite servir de deuxième barrière ; elle ne remplace pas les filtres applicatifs.

### Rotation, révocation et idempotence

1. L’API entreprise reçoit `orderId`, `expectedVersion`, `reason` et une `Idempotency-Key`.
2. La transaction sélectionne le lien par `company_id + order_id FOR UPDATE`.
3. Elle recherche d’abord un événement possédant la même clé d’idempotence.
4. Même clé et même empreinte : même résultat logique. Même clé et autre empreinte : `409`.
5. Si `expectedVersion` est ancien, répondre `409` sans changer le lien.
6. La rotation produit un nouveau secret, remplace l’empreinte, incrémente génération/version, ajoute l’événement puis commit. L’ancien secret cesse de fonctionner au commit.
7. La révocation conserve la ligne et l’historique mais positionne `active=false` et `revoked_at`.

Un problème particulier existe avec la réponse d’une rotation : après un commit suivi d’une coupure réseau, le serveur ne peut pas reconstruire un secret aléatoire s’il n’en conserve que l’empreinte. Le mécanisme d’idempotence doit donc conserver, pour quelques minutes seulement, le résultat chiffré de l’opération avec une clé dédiée, ou retourner un résultat « rotation déjà appliquée » et permettre une nouvelle rotation explicite. Pour une expérience fiable, la première option est recommandée ; le contenu chiffré est purgé automatiquement et n’entre jamais dans les logs.

### Réponses publiques uniformes

| Situation | Réponse publique |
|---|---|
| Jeton valide avant départ | `200`, état d’attente, aucune position livreur |
| Jeton valide pendant un état GPS autorisé | `200`, DTO minimal de cette commande uniquement |
| Jeton valide après état terminal, pendant la courte grâce | `200`, message terminal, aucune coordonnée |
| Faux, malformé, expiré, révoqué, remplacé, société inaccessible | Même `404` et même message générique |
| Base ou service entièrement indisponible | `503` générique, sans indiquer si le jeton existe |
| Quota dépassé | `429`, `Retry-After`, sans appel au fournisseur |

Un jeton trop long, trop court ou contenant des caractères hors base64url est rejeté avant la base, mais avec la même réponse générique. Les erreurs SQL, piles, identifiants internes, nom d’entreprise et raisons de révocation ne sont jamais renvoyés.

### Limites initiales à valider par charge

Les valeurs suivantes sont un point de départ, pas une promesse contractuelle :

- `/api/tracking`: 30 requêtes/minute par couple lien + IP, avec petite rafale tolérée ;
- 180 requêtes/minute au total par lien ;
- 60 jetons invalides/minute par IP, puis ralentissement progressif ;
- plafond plus large par IP sur des liens valides afin de ne pas pénaliser les réseaux mobiles avec CGNAT ;
- quota global et coupe-circuit sur les appels Traccar ;
- aucune clé Redis contenant le jeton brut : utiliser `link_id` après validation ou une empreinte locale non journalisée.

Le navigateur interroge normalement toutes les dix secondes, suspend l’appel lorsque l’onglet est masqué, respecte `Retry-After` et ajoute une gigue afin que tous les clients ne repartent pas simultanément.

## Matrice d’abus réaliste

| Scénario | Vecteur probable | Impact | Prévention | Détection attendue |
|---|---|---|---|---|
| Lien envoyé au mauvais client sur WhatsApp | Erreur humaine/copier-coller | Consultation du colis et GPS pendant la fenêtre active | Révocation/rotation immédiate, aperçu avant envoi, destinataire partiellement masqué | Événement de rotation avec motif, sans numéro ni token |
| Capture d’écran ou transfert du lien | Support, groupe WhatsApp, téléphone partagé | Plusieurs personnes suivent le livreur | Durée courte, rotation, affichage minimal, bouton entreprise « désactiver » | Hausse des sessions distinctes par lien, sans blocage automatique |
| Jeton visible dans logs ou APM | Chemin URL collecté par proxy | Accès durable et réutilisable | Redaction de route, échange vers cookie/URL propre, hash en base | Test canari périodique des journaux |
| Accès au lien démo intégré | Configuration production incomplète | Position du périphérique par défaut | Démo refusée par défaut et isolée | Alerte au démarrage et test de configuration |
| Scraping massif d’un lien divulgué | Script sur `/api/tracking` | Charge application/Traccar et historique de déplacement | Limites distribuées, cache/coalescence, coupe-circuit | `429`, ratio appels publics/appels Traccar, anomalie par lien |
| Devinette de jetons | Rafale de valeurs aléatoires | Faible probabilité de succès, mais consommation de ressources | 192 bits ou plus, validation de format, limite par IP avant fournisseur | Taux de `404` et diversité de jetons invalides |
| Opérateur A tente de révoquer le lien de B | ID de commande deviné ou récupéré | Déni de service ou fuite inter-tenant | Session comme source de `company_id`, filtre et FK composite, tests A/B | Audit de refus par type d’action, sans identifiant étranger révélé |
| Deux managers rotent simultanément | Double clic, deux onglets, réseau lent | Premier nouveau lien invalidé immédiatement par le second | Verrou de ligne, `expectedVersion`, idempotence | Un succès, un rejeu identique ou un `409` explicite |
| Coupure après commit d’une rotation | Réseau mobile instable | Lien changé mais secret non reçu | Résultat chiffré temporaire associé à l’idempotence | Rejeu marqué `alreadyApplied`, même génération |
| Sauvegarde PostgreSQL copiée | Compte ou support compromis | Extraction de tous les liens | Empreintes uniquement, moindre privilège, chiffrement des sauvegardes | Audit d’accès aux sauvegardes hors application |
| Lien terminal conservé 30 jours | Historique navigateur/message | Métadonnées client inutiles après livraison | Grâce terminale courte et expiration automatique | Compteur de liens terminaux encore actifs |
| Référent envoyé à un domaine de tuiles | Politique absente ou régressée | Jeton transmis à un tiers | `origin` au minimum, idéalement `no-referrer`, test navigateur | Inspection réseau automatisée |
| Cache partagé renvoie une autre réponse | CDN/proxy mal configuré | Fuite d’une commande ou position | `private, no-store`, pas de service worker sur le suivi, CDN bypass | Test chaud/froid avec deux jetons et inspection des en-têtes |
| Position réelle utilisée dans un smoke test public | Mauvaises données de test | Données personnelles dans CI/logs | Entreprise, client, appareil et coordonnées synthétiques | Nettoyage vérifié et scan PII après test |

## Migration sans casser les liens existants

### Phase 0 — inventaire et filet de sécurité

- Sauvegarde restaurable de la base métier.
- Compter liens actifs, expirés, terminaux, sans expiration et âge maximal ; ne sortir aucun token dans le rapport.
- Vérifier la durée réelle la plus longue et fixer la fenêtre de compatibilité.
- Relever les journaux susceptibles de conserver l’URL complète.

### Phase 1 — schéma additif

- Ajouter les nouvelles colonnes comme nullables ainsi que `tracking_link_events`.
- Ajouter `UNIQUE (company_id, id)` sur `orders` si nécessaire.
- Remplir `tracking_links.company_id` depuis la commande.
- Ajouter la FK composite en `NOT VALID`, vérifier les anomalies, puis `VALIDATE CONSTRAINT` pour réduire le verrouillage de migration.
- Conserver temporairement `token` et la contrainte `order_id UNIQUE` : les anciennes versions continuent de fonctionner.

### Phase 2 — rétro-remplissage des empreintes

- Calculer `token_hash` pour chaque jeton existant avec la clé dédiée et renseigner `hash_key_version`.
- Initialiser `generation=1`, `version=1`, `active=true` pour les liens non expirés ; ne pas réactiver les liens échus.
- Comparer nombre total, nombre empreinté, unicité et jointure entreprise/commande avant de rendre les colonnes obligatoires.
- Ne jamais imprimer jeton ou empreinte dans la sortie de migration.

### Phase 3 — version de compatibilité

- Lecture publique : chercher d’abord par empreinte ; fallback temporaire vers la colonne brute uniquement pour une ligne héritée non migrée, avec métrique de comptage sans valeur.
- Écriture : durant la courte fenêtre de rollback, renseigner ancien champ et empreinte ; aucun endpoint de liste ne restitue le secret.
- Les liens déjà envoyés gardent exactement leur valeur et leur expiration : ils continuent de fonctionner après rétro-remplissage.
- Le rollback autorisé revient uniquement à cette version de compatibilité, jamais à une version ignorant les nouveaux états de révocation.

### Phase 4 — activation des contrôles

- Activer les APIs de révocation, rotation et prolongation avec rôles, version, verrou et idempotence.
- Faire respecter `active`, `revoked_at`, `expires_at` et génération dans une seule lecture publique.
- Mettre le rate limit devant Traccar et vérifier les réponses uniformes.
- Ajouter l’aperçu interne authentifié et retirer `tracking_token` des listes/détails entreprise.

### Phase 5 — suppression du clair

- Attendre la durée maximale des anciens liens, la fenêtre de rollback approuvée et zéro fallback observé pendant au moins une période complète.
- Arrêter l’écriture de `token`, la mettre à `NULL`, vérifier sauvegarde et restauration, puis supprimer la colonne dans une migration séparée.
- Avancer officiellement le « plancher de rollback » : aucune version antérieure à la lecture par empreinte ne peut être redéployée.
- La révocation/rotation d’un ancien lien pendant la transition suit les mêmes règles et ne le prolonge pas implicitement.

### Conditions d’arrêt ou de rollback

Rollback immédiat si un lien existant valide devient inaccessible, si un lien expiré/révoqué redevient valide, si deux secrets sont acceptés pour une commande, si une entreprise peut muter le lien d’une autre ou si un token apparaît dans les logs. La migration destructive ne commence jamais tant que les lectures fallback ne sont pas à zéro et que la sauvegarde restaurée n’a pas été testée.

## Plan de tests locaux

### Cycle de vie et stockage

- Créer un lien, vérifier l’entropie/format et l’absence de secret dans toutes les lectures entreprise ultérieures.
- Vérifier que le hash attendu retrouve le lien et qu’une variation d’un caractère échoue.
- Expirer à `NOW()`, juste avant et juste après la limite ; aucun calcul dépend de l’horloge du navigateur.
- Révoquer deux fois avec la même clé, puis avec une clé différente ; résultat stable et historique unique.
- Rotater puis tester ancien/nouveau secret avant et après commit.
- Prolonger avec motif, plafond et rôle ; vérifier qu’une rotation seule ne prolonge rien.

### Idempotence et concurrence

- Deux connexions effectuent la même rotation avec la même clé et empreinte.
- Même clé avec un motif ou une version différents.
- Deux clés différentes avec le même `expectedVersion`.
- Coupure simulée après commit puis rejeu.
- Révocation concurrente à une lecture publique et à une rotation.
- Crash avant commit : le secret précédent reste le seul accepté.

### Cloisonnement

- Deux entreprises possèdent chacune commande, livreur et lien.
- Tester toutes les mutations avec l’identifiant de l’autre entreprise et avec un `company_id` injecté dans URL/corps.
- Vérifier les contraintes SQL directement, puis avec le compte applicatif ; si RLS est activée, tester aussi le refus par défaut.
- Confirmer qu’un DTO public ne contient jamais `company_id`, identifiant Traccar, autre arrêt, tournée, téléphone ou notes privées.

### Abus, erreurs et en-têtes

- Faux, malformé, expiré, révoqué, remplacé, entreprise suspendue : même `404`, même JSON, mêmes en-têtes et latences comparables.
- Base hors ligne : `503` sans trace ni existence révélée.
- Rafale au-dessus de chaque quota, réplique A puis B, IPv4/IPv6, réseau NAT simulé.
- Vérifier `Cache-Control: private, no-store` sur `200`, `404`, `429` et `503` ainsi que sur la page HTML.
- Vérifier `Referrer-Policy` dans l’en-tête et le DOM ; la requête vers une origine de tuiles ne reçoit jamais le chemin.
- Vérifier qu’aucun service worker, Cache Storage ou CDN ne conserve le JSON de suivi.
- Scanner stdout/stderr, logs structurés, erreurs PostgreSQL, traces APM et événements d’audit avec un canari de jeton.

## Plan de tests sur l’URL publique

Utiliser exclusivement une entreprise, un client, un livreur Traccar et des coordonnées synthétiques dédiés aux tests.

1. Créer un lien par l’API entreprise et conserver le secret uniquement en mémoire du test.
2. Vérifier page et API avant départ, état GPS autorisé, échec, reprise et terminal.
3. Vérifier rotation, ancien secret refusé, nouveau secret accepté, puis révocation.
4. Vérifier expiration et réponses uniformes avec au moins cinq classes invalides.
5. Exécuter le test A/B multi-entreprises sur toutes les opérations de gestion.
6. Déclencher le quota sans toucher un appareil réel ; confirmer `429`, `Retry-After` et absence d’amplification Traccar.
7. Inspecter les en-têtes, le référent des tuiles, l’historique de navigation après échange et l’absence de cache.
8. Rechercher le canari dans les logs Railway/app/APM et dans les audits ; résultat attendu : zéro occurrence.
9. Nettoyer les données synthétiques et vérifier par requête que commandes, liens, événements et appareil de test ne restent pas actifs.

Les tests publics ne doivent jamais afficher un jeton, une URL complète, un téléphone ou une coordonnée réelle dans leur sortie. Les secrets ne sont pas passés comme argument de ligne de commande s’ils peuvent apparaître dans la liste des processus.

## Critères GO / NO-GO

### GO uniquement si

- tous les P0 sont fermés et prouvés sur un environnement public représentatif de la production ;
- tous les nouveaux liens sont empreintés, expirants, révocables et rotatifs ;
- les liens historiques valides passent la migration sans changer de valeur ;
- ancien secret invalide et nouveau secret valide sont atomiques ;
- aucun test A/B ne traverse une entreprise ;
- les quotas distribués protègent l’application et Traccar sans bloquer le rafraîchissement normal ;
- faux, expiré, révoqué et remplacé sont indistinguables publiquement ;
- pages et API ont les en-têtes attendus sur succès et erreur ;
- le test canari ne retrouve aucun token dans base en clair, API, log, audit, trace, cache ou référent ;
- la sauvegarde de migration a été restaurée et le plancher de rollback est documenté.

### NO-GO immédiat si

- le mode démo par défaut peut atteindre un appareil réel ;
- un lien révoqué/roté reste valide après commit ;
- un token brut apparaît dans une lecture courante, un log ou une sauvegarde après la phase de suppression ;
- deux rotations concurrentes laissent deux secrets valides ou invalident silencieusement le lien remis par l’autre opérateur ;
- un rôle ou une entreprise non autorisés peuvent gérer un lien ;
- un `404`, `410` ou message distinct révèle qu’une commande existe ;
- le rate limit est seulement en mémoire alors que plusieurs réplicas servent le trafic ;
- un cache ou un référent transmet une réponse ou un chemin porteur à un tiers ;
- le test public utilise une position réelle ou laisse des données synthétiques actives.

## Références de bonnes pratiques

- [OWASP API Security Top 10 2023](https://api-security.owasp.org/editions/2023/en/0x11-t10/) : autorisation objet/propriété, consommation de ressources, fonctions et flux métier sensibles.
- [OWASP — Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) : propriétés transposables aux liens porteurs — aléatoires, suffisamment longs, stockés sûrement, expirants, protégés contre l’automatisation et sans fuite de référent.
- [RFC 6750 — Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html) : risques de fuite des secrets placés dans les URL, historiques et journaux ; recommandation de ne pas transporter un bearer token dans une URL de page.
- [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html#name-no-store-2) : `no-store` interdit aux caches conformes de conserver ou réutiliser la requête/réponse, sans constituer à lui seul une garantie absolue de confidentialité.
- [W3C — Referrer Policy](https://www.w3.org/TR/referrer-policy/) : `no-referrer` omet le référent ; `origin` retire chemin et paramètres mais transmet l’origine.
- [OWASP — Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) : ne pas journaliser jetons d’accès, identifiants de session, secrets ou données personnelles sensibles.
- [PostgreSQL — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) : `SELECT ... FOR UPDATE` sérialise les modifications concurrentes d’une ligne jusqu’à la fin de la transaction.
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) : RLS peut fournir une défense supplémentaire en refus par défaut lorsqu’aucune politique n’autorise l’accès.
- [PostgreSQL — Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) : contraintes uniques et clés étrangères composites pour garantir l’intégrité inter-tables et multi-tenant.

## Fichier modifié

- `docs/TRACKING_LINK_SECURITY_REVIEW.md`
