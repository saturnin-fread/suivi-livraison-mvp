# Limitation d’abus — pilote mémoire

## But et périmètre

`lib/rate-limit.js` fournit un premier garde-fou local pour les routes Express sensibles : connexion, création de demandes publiques, validation OTP et autres actions coûteuses. Il s’agit d’un **token bucket en mémoire**, sans dépendance supplémentaire et sans accès réseau.

Ce module ne remplace ni un pare-feu applicatif, ni les protections de Railway, ni une limitation distribuée. Il doit être activé route par route avec des quotas adaptés au risque et à l’expérience utilisateur.

État d’intégration au 15 septembre 2026 : `GET /api/tracking/:token` utilise le limiteur avant toute lecture Traccar, avec une politique IP et une politique jeton. Le navigateur respecte `Retry-After`. Cette configuration impose une seule réplique `delivery-app` jusqu’à la migration Redis.

## Garanties du pilote

- Chaque politique possède son propre quota : une politique IP et une politique jeton peuvent être appliquées ensemble.
- Toutes les politiques sont vérifiées avant de consommer un quota. Un refus par jeton ne consomme donc pas inutilement le quota IP.
- Les IP, identifiants et jetons bruts ne sont jamais conservés : seule une empreinte HMAC opaque `rl_…` entre dans les buckets.
- Aucun log n’est produit par le module. Les réponses ne contiennent ni clé, ni IP, ni jeton, ni nom de politique.
- Le nombre de buckets est plafonné par `maxEntries`. À saturation, une nouvelle clé est refusée avec `503` au lieu d’évincer un bucket actif et de permettre un contournement par rotation de clés.
- Le nettoyage est opportuniste et peut aussi être déclenché avec `sweep()`. Il ne crée aucun minuteur qui maintiendrait le processus Node actif.
- `Retry-After` est renvoyé en secondes avec `Cache-Control: no-store` pour les réponses `429` et `503`.
- L’horloge est injectable pour les tests déterministes.

## Exemple Express : IP + jeton

```js
const {
  createTokenBucket,
  createRateLimitMiddleware,
  createIpPolicy,
  createTokenPolicy,
} = require('./lib/rate-limit');

const ipBucket = createTokenBucket({
  capacity: 30,
  refillTokens: 30,
  refillIntervalMs: 60_000,
  maxEntries: 20_000,
});

const tokenBucket = createTokenBucket({
  capacity: 10,
  refillTokens: 10,
  refillIntervalMs: 60_000,
  maxEntries: 20_000,
});

const limiter = createRateLimitMiddleware({
  keySecret: process.env.RATE_LIMIT_KEY_SECRET,
  policies: [
    createIpPolicy({ limiter: ipBucket }),
    createTokenPolicy({
      limiter: tokenBucket,
      // Préférer un identifiant de jeton/session stable au jeton secret complet.
      key: (req) => req.auth?.sessionId,
      required: false,
    }),
  ],
});

app.post('/api/action-sensible', limiter, handler);
```

`RATE_LIMIT_KEY_SECRET` doit contenir au moins 16 octets aléatoires, idéalement 32, et rester identique entre les redéploiements. Sans secret fourni, le module en génère un au démarrage : les clés restent opaques, mais les quotas repartent à zéro à chaque redémarrage.

### Politique IP et proxy Railway

`createIpPolicy()` utilise `req.ip`. Cette valeur n’est fiable que si la configuration Express `trust proxy` correspond exactement au proxy de confiance. Ne jamais accepter directement un en-tête `X-Forwarded-For` fourni par le client dans une fonction `key`.

### Politique jeton

`createTokenPolicy()` exige volontairement une fonction `key`. Elle ne lit pas automatiquement l’en-tête `Authorization`, ce qui évite de faire circuler ou journaliser accidentellement un secret. Utiliser en priorité un identifiant de session ou de jeton déjà validé. Une route publique peut rendre cette politique optionnelle avec `required: false`, tout en conservant la politique IP obligatoire.

## Dégradation sûre

Le mode par défaut est `failMode: 'closed'` : erreur de résolution de clé, stockage saturé, horloge invalide ou résultat de limiteur incohérent produisent une réponse générique `503 rate_limit_unavailable` avec `Retry-After`. Une limite réellement atteinte produit `429 rate_limit_exceeded`.

`failMode: 'open'` existe pour une politique secondaire dont l’indisponibilité ne doit pas arrêter le service. Il ne doit être utilisé que si une autre politique obligatoire et fonctionnelle — généralement IP — protège encore la route. Par défaut, si aucune politique ne s’applique, le middleware refuse la requête. `requirePolicyMatch: false` doit rester exceptionnel.

## Réglage des quotas

Les quotas doivent être définis par flux et non globalement :

- connexion et OTP : faible capacité, recharge lente, combinaison IP + compte/session ;
- formulaire client : capacité modérée par IP et par jeton de formulaire ;
- consultation authentifiée : capacité plus élevée par session ;
- export ou calcul coûteux : coût supérieur via `cost` ou fonction `cost(req)`.

Ne pas sanctionner automatiquement une personne à partir d’un dépassement. Une adresse IP peut représenter tout un bureau, un opérateur mobile ou un réseau partagé. Les seuils doivent être observés et ajustés avec des métriques agrégées ne contenant aucune donnée de localisation, IP ou jeton brut.

## Limite essentielle : plusieurs réplicas

Chaque processus possède ses propres buckets. Avec deux réplicas, un client peut approximativement bénéficier de deux quotas et les redémarrages remettent les compteurs à zéro. Ce pilote est donc acceptable pour une seule réplique et une première protection applicative, mais **pas comme garantie distribuée**.

## Migration future vers Redis

Avant d’augmenter le nombre de réplicas :

1. conserver le contrat de politique et les clés HMAC opaques ;
2. remplacer le bucket mémoire par un magasin Redis partagé ;
3. exécuter consommation + recharge atomiquement, idéalement par script Lua ;
4. ajouter une expiration à chaque clé et un préfixe versionné ;
5. conserver les mêmes réponses génériques et `Retry-After` ;
6. définir explicitement la stratégie en cas de panne Redis, route par route ;
7. tester concurrence, expiration, bascule, latence et absence de fuite de clé.

Le secret HMAC doit alors être partagé par tous les réplicas. Redis ne doit toujours recevoir que les empreintes opaques, jamais les IP ou jetons bruts.

## Vérification

Le test autonome n’utilise aucun réseau :

```powershell
node scripts/rate-limit-test.js
```

Il couvre l’opacité des clés, la recharge, le calcul de `Retry-After`, le plafond mémoire, le nettoyage, la composition IP + jeton, l’absence de double consommation et les modes de dégradation.
