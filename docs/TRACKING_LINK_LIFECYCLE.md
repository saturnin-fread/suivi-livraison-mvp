# Cycle de vie des liens de suivi

## Portée de ce lot

Ce document décrit la politique pure préparée dans `lib/tracking-link-policy.js`. Elle ne modifie ni la base, ni les routes HTTP, ni les liens déjà déployés. L’intégration serveur et la migration SQL devront être réalisées dans un lot transactionnel séparé.

> Mise à jour d’intégration du 15 septembre 2026 : cette politique est maintenant raccordée à `server.js`, au schéma PostgreSQL, à l’interface entreprise et aux tests. Le présent document conserve la conception initiale ; la procédure réellement exécutable et son plancher de retour arrière sont dans `TRACKING_LINK_MIGRATION_RUNBOOK.md`.

## État actuel constaté

La table actuelle est créée ainsi :

```text
tracking_links
  id          BIGSERIAL PRIMARY KEY
  order_id    BIGINT NOT NULL UNIQUE
  token       TEXT NOT NULL UNIQUE
  expires_at  TIMESTAMPTZ NULL
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Conséquences :

- une commande ne peut avoir qu’une ligne de suivi ;
- le token est conservé en clair ;
- une expiration nulle est actuellement acceptée comme durée illimitée ;
- aucune révocation ou rotation n’est historisée ;
- l’ancien token ne peut être prouvé invalide après une rotation autrement qu’en écrasant sa valeur ;
- la lecture publique ne distingue pas une révocation d’une absence, ce qui est bon pour le message public mais insuffisant pour l’audit interne.

## Politique retenue

| Paramètre | Valeur | Motif |
|---|---:|---|
| durée par défaut | 7 jours | couvre les reports courants sans reproduire une exposition systématique de 30 jours |
| durée minimale | 15 minutes | permet un remplacement d’urgence sans lien quasi instantanément inutilisable |
| durée maximale | 30 jours | maintient la limite historique du MVP |
| ancienne ligne avec `expires_at = NULL` | `created_at + 30 jours` | compatibilité bornée ; aucun lien ne reste éternel |

Les durées hors bornes sont refusées. Elles ne sont pas silencieusement arrondies.

### Ordre d’évaluation

1. lien révoqué ou remplacé : `revoked` immédiatement ;
2. échéance atteinte : `expired` ;
3. commande `Livrée`, `Retournée` ou `Annulée` : `terminal` ;
4. sinon : `active` ;
5. donnée absente ou date inexploitable : `unavailable`, donc refus fermé.

La borne est exclusive : à `now === expires_at`, le lien est expiré.

### Effet public

| État | Détails opérationnels | Position | Rafraîchissement | Réponse publique |
|---|---|---|---|---|
| `active` | autorisés selon la politique métier de statut | selon le statut métier | oui | données minimales utiles |
| `terminal` | reçu final minimal | jamais | jamais | résultat final sans donnée GPS |
| `expired` | non | non | non | message générique |
| `revoked` | non | non | non | même message générique |
| `unavailable` | non | non | non | même message générique |

Le même code `TRACKING_LINK_UNAVAILABLE`, le même statut HTTP et le même texte doivent être utilisés pour un faux token, un lien expiré ou un lien révoqué. La réponse ne doit jamais expliquer lequel de ces cas s’est produit. Les journaux internes peuvent conserver la cause, sans token brut.

Le reçu terminal est compatible avec l’expérience actuelle : le client peut lire « remise », « retournée » ou « annulée », mais ne reçoit plus la position, le manifeste, l’ordre des arrêts ou l’identifiant Traccar. Si une entreprise exige une invalidation complète dès la clôture, l’intégration devra révoquer le lien dans la transaction terminale.

## Rotation et révocation

### Rotation immédiate

Une rotation est une seule transaction :

1. verrouiller le lien courant de la commande ;
2. enregistrer l’opération d’idempotence ;
3. générer le nouveau token avec un générateur cryptographiquement sûr ;
4. ne stocker que son empreinte ;
5. marquer l’ancien lien révoqué à l’instant `T` avec le motif `rotated` ;
6. activer le nouveau lien au même instant `T` ;
7. valider la transaction ;
8. retourner le token brut une seule fois au canal autorisé.

Il ne doit exister aucune fenêtre où les deux tokens sont actifs. Si l’écriture échoue, toute la transaction est annulée. Un token ancien est recherché par empreinte et sa ligne révoquée produit la réponse publique générique.

Une commande terminale ne peut pas recevoir un nouveau lien. Un lien expiré ou déjà révoqué peut être réémis seulement si la commande reste non terminale et si l’opérateur en a le droit.

### Révocation

La première révocation pose `revoked_at` et un motif interne contrôlé. Une répétition de la même action est sans effet. La révocation ne supprime pas la preuve d’existence du lien et ne doit pas être réversible ; une nouvelle communication nécessite une réémission avec un nouveau token.

## Idempotence

Les actions de rotation, réémission et révocation devront accepter une clé d’idempotence. La clé :

- contient de 8 à 200 caractères ASCII visibles sans espace ;
- est unique pour une intention métier ;
- est liée à une empreinte SHA-256 de l’action, de la commande, de la durée demandée et des paramètres influençant le résultat ;
- n’intègre jamais le token brut.

Décisions pures :

| Situation | Décision |
|---|---|
| aucune opération portant la clé | `proceed` |
| même clé, même empreinte, résultat terminé ou en échec | `replay` sans nouvelle mutation |
| même clé et même empreinte encore en traitement | `in_progress` ; conflit temporaire |
| même clé avec une autre empreinte | `conflict` |

Le résultat mémorisé ne doit pas conserver le nouveau token brut. Pour une rotation dont la première réponse a été perdue, le rejeu indique que la rotation a eu lieu, mais une nouvelle communication du secret exige une nouvelle rotation explicitement autorisée.

## Migration SQL cible

La migration d’intégration devra au minimum prévoir :

```text
tracking_links
  id
  order_id
  token_hash              UNIQUE NOT NULL
  state                   active | revoked
  expires_at              NOT NULL
  created_at
  revoked_at              NULL
  revocation_reason       NULL
  replaced_by_id          NULL REFERENCES tracking_links(id)
  created_by_user_id      NULL
```

Il faut retirer l’unicité absolue de `order_id` et la remplacer par une unicité partielle garantissant au plus une ligne `active` par commande. L’échéance ne doit pas être utilisée dans le prédicat d’index ; le changement d’état est explicite et transactionnel.

Migration progressive recommandée :

1. ajouter les nouveaux champs sans supprimer `token` ;
2. calculer `expires_at = created_at + 30 jours` pour les valeurs nulles ;
3. calculer `token_hash` pour les tokens historiques ;
4. faire temporairement une lecture double, empreinte d’abord puis ancien champ ;
5. basculer toutes les créations vers empreinte seule ;
6. vérifier l’absence de lien actif multiple et de valeur nulle ;
7. supprimer le token en clair après la fenêtre de retour arrière approuvée.

Les étapes 2 et 3 doivent être réalisées par lots contrôlés, avec comptage avant/après et sauvegarde testée. Aucun token ne doit apparaître dans les logs de migration.

## Cas limites obligatoires à l’intégration

- deux rotations concurrentes sur la même commande ;
- réponse réseau perdue puis rejeu idempotent ;
- rotation à l’instant exact d’expiration ;
- révocation simultanée avec lecture publique ;
- commande devenant terminale pendant une rotation ;
- ancien token essayé après rotation ;
- lien historique avec expiration nulle, date invalide ou création absente ;
- collision d’empreinte ou violation d’unicité ;
- horloges : la base fait foi avec une seule valeur transactionnelle de `NOW()` ;
- cache/CDN : réponses privées, `no-store`, et aucune donnée active réutilisée après révocation ;
- référents, analytics et erreurs : aucun token brut.

## Tests fournis dans ce lot

Exécution indépendante, sans base et sans réseau :

```powershell
node scripts/tracking-link-policy-test.js
```

Le test couvre les bornes, dates, compatibilité historique, précédence des états, messages publics uniformes, reçu terminal, révocation répétée, rotation immédiate, ancien token invalide, réémission non terminale, refus terminal et quatre issues d’idempotence.

## Critères avant branchement au serveur

- migration testée sur une copie représentative de la base ;
- ancien et nouveau formats lus pendant la transition ;
- rotation et révocation atomiques et cloisonnées par entreprise ;
- ancien token réellement refusé immédiatement ;
- faux, expiré et révoqué indiscernables publiquement ;
- aucune position hors fenêtre métier autorisée ;
- aucun token brut en base définitive, logs, audit, métriques ou empreinte d’idempotence ;
- tests de concurrence, régression, mobile et production publique réussis ;
- procédure de retour arrière documentée sans réactiver un ancien token.

## Références de conception

- [OWASP — Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) : messages cohérents, tokens aléatoires, suffisamment longs, stockés de manière sûre, à durée limitée et invalidés après usage. Le cas d’un lien de suivi n’est pas un mot de passe, mais les propriétés de sécurité d’un secret transmis par URL sont analogues.
- [IETF HTTPAPI — Idempotency-Key](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-07) : unicité de clé, empreinte de requête, durée de conservation publiée, rejeu d’un résultat et conflit lorsque la même clé désigne une charge différente.
