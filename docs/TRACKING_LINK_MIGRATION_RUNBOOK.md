# Migration et retour arrière des liens de suivi

## But

Retirer les tokens en clair sans casser un lien déjà communiqué ni rendre possible le retour d’un lien révoqué. La migration est additive au démarrage et ne doit jamais imprimer un token, une empreinte ou une URL complète.

## Préconditions

- sauvegarde PostgreSQL restaurable vérifiée ;
- une seule réplique `delivery-app` ;
- `TRACKING_TOKEN_SECRET` et `RATE_LIMIT_KEY_SECRET` aléatoires, distincts et conservés ;
- `DEMO_TRACKING_ENABLED=false` ;
- dernière version antérieure identifiée ;
- tests `syntax`, `tracking-links`, `rate-limit` et `smoke` réussis sur une base isolée.

## Phase 1 — compatibilité réversible

Configurer `TRACKING_TOKEN_STORAGE_MODE=dual`, puis déployer la nouvelle application. Le démarrage ajoute les colonnes, remplit `company_id`, l’expiration, l’empreinte et le chiffrement, tout en conservant temporairement `tracking_links.token`.

Vérifier sans afficher de secret :

1. `/health` indique une base joignable ;
2. un lien historique fonctionne encore ;
3. renouvellement, révocation et réémission passent ;
4. deux renouvellements concurrents donnent exactement un succès et un `409` ;
5. les listes entreprise ne contiennent aucun chemin de suivi ;
6. le nombre de lignes protégées correspond au nombre de liens ;
7. les tests publics et le contrôle navigateur mobile réussissent.

À ce stade seulement, le retour vers la dernière version historique reste possible car la colonne en clair existe encore.

## Phase 2 — suppression du clair

Conserver exactement les mêmes secrets, puis configurer `TRACKING_TOKEN_STORAGE_MODE=encrypted_only` et redéployer. Le démarrage met à `NULL` le champ historique après avoir vérifié que chaque ligne possède son empreinte et son ciphertext.

Contrôler uniquement des compteurs : zéro token historique non nul, toutes les lignes protégées, santé verte, lien historique encore valide, renouvellement/révocation valides et smoke test complet réussi.

Le plancher de retour arrière avance alors à la première version compatible avec `token_hash` et `token_ciphertext`. **Ne jamais redéployer une version qui ne lit que `tracking_links.token`.** Un incident impose un retour vers la version compatible de phase 1 avec les mêmes secrets, pas vers l’ancien prototype.

## Rotation des secrets

`TRACKING_TOKEN_SECRET` chiffre les liens que l’entreprise peut afficher explicitement. Le perdre rend ces liens impossibles à restituer. Le remplacer sans migration rend les ciphertexts existants illisibles. Avant toute rotation, ajouter une version de clé et une lecture ancienne + nouvelle, réchiffrer par lots, vérifier, puis retirer l’ancienne clé. Ne jamais modifier directement la variable seule.

`RATE_LIMIT_KEY_SECRET` peut être remplacé sans invalider les liens, mais les compteurs en mémoire repartent de zéro au redémarrage.

## Arrêt et retour arrière

Arrêter immédiatement si :

- un ancien lien valide ne fonctionne plus ;
- un lien renouvelé ou révoqué reste actif ;
- un token apparaît dans une liste, un log ou un audit ;
- une entreprise agit sur le lien d’une autre ;
- deux opérations concurrentes réussissent sur la même version ;
- une ligne n’a ni empreinte ni ciphertext.

Conserver les preuves de contrôle sous forme de statuts et de compteurs uniquement. Ne jamais copier les valeurs secrètes dans la documentation ou un ticket.

## Passage à plusieurs répliques

Interdit avec le limiteur mémoire. Migrer d’abord les quotas IP et lien vers Redis avec des clés opaques et une opération atomique, puis exécuter un test de rafale réparti entre répliques.
