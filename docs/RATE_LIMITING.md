# Limitation d’abus — pilote mémoire

## But et périmètre

`lib/rate-limit.js` fournit un premier garde-fou local pour les routes Express sensibles : connexion, création de demandes publiques, validation OTP et autres actions coûteuses. Il s’agit d’un **token bucket en mémoire**, sans dépendance supplémentaire et sans accès réseau.

Ce module ne remplace ni un pare-feu applicatif, ni les protections de Railway, ni une limitation distribuée. Il doit être activé route par route avec des quotas adaptés au risque et à l’expérience utilisateur.

État d’intégration au 15 septembre 2026 : `GET /api/tracking/:token` utilise le limiteur avant toute lecture Traccar, avec une politique IP et une politique jeton. Le navigateur respecte `Retry-After`. Le bucket mémoire impose une seule réplique `delivery-app` ; un backend Redis partagé existe désormais (`lib/redis-rate-limit.js`) et lève cette contrainte une fois `REDIS_URL` câblé (voir la section « Backend Redis partagé »).

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

## Backend Redis partagé (`lib/redis-rate-limit.js`)

Le backend Redis est disponible pour lever la limite « une seule réplique ». Il
est **activé uniquement si `REDIS_URL` est défini** sur `delivery-app` ; sinon le
bucket mémoire reste utilisé (pilote mono-réplique et développement local). Le
sélecteur est dans `server.js` (`trackingLimiter`), donc déployer ce code sans
`REDIS_URL` ne change strictement rien au comportement.

Choix d’implémentation :

1. même contrat de politique et mêmes clés HMAC opaques `rl_…` (aucune IP ni
   jeton brut n’atteint Redis) ;
2. `createRedisTokenBucket` expose la même interface (`inspect`/`consume`,
   asynchrones) et la même forme de décision que le bucket mémoire ; le
   middleware `await` désormais ces appels ;
3. recharge + consommation exécutées **atomiquement dans un script Lua** unique,
   pour que des réplicas concurrents ne dépassent pas le quota ;
4. chaque clé porte une **expiration** (`PEXPIRE`, dérivée de l’horizon de
   recharge) et un **préfixe versionné** `rl:<namespace>:` ;
5. réponses génériques et `Retry-After` inchangées ;
6. **panne Redis = `failMode` fermé** : une erreur d’`eval` remonte comme
   `redis_unavailable` et le middleware renvoie `503 rate_limit_unavailable`
   (comportement protecteur actuel préservé) ; la seule route protégée reste
   `GET /api/tracking/:token`, en amont de Traccar ;
7. le client (`ioredis`) est **injecté**, donc la librairie n’a aucune
   dépendance dure et se teste sans Redis réel.

Le secret HMAC (`RATE_LIMIT_KEY_SECRET`) doit être **partagé par tous les
réplicas** et rester stable entre redéploiements, sinon les quotas repartent de
zéro à chaque réplique.

Câblage attendu (à faire au moment de passer à plusieurs réplicas) :

```
REDIS_URL = ${{Redis-sPlS.REDIS_URL}}   # Redis dédié, séparé de n8n
```

Voir `docs/INFRA_ISOLATION_RUNBOOK.md` pour le service Redis dédié.

## Vérification

Les deux tests autonomes n’utilisent aucun réseau (le test Redis emploie un faux
serveur fidèle exécutant le même algorithme que le script Lua) :

```powershell
node scripts/rate-limit-test.js
node scripts/redis-rate-limit-test.js
```

Ils couvrent l’opacité des clés, la recharge, le calcul de `Retry-After`, le
plafond mémoire, le nettoyage, la composition IP + jeton, l’absence de double
consommation, l’isolement par préfixe et les modes de dégradation (dont la
panne Redis fermée).
