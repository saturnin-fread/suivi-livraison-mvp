# Contrat des indicateurs opérationnels CRM

## Portée

Ce contrat accompagne `lib/crm-metrics.js`. Il définit des calculs purs, déterministes et explicables pour le pilotage d'une entreprise de livraison. Il ne crée ni route HTTP, ni requête PostgreSQL, ni décision automatique.

Version : `crm-metrics.v1`  
Fuseau métier : `Africa/Porto-Novo`  
Bornes temporelles : début inclus, fin exclue — `[start, end)`

Les agrégats servent à comprendre l'exploitation. Ils ne constituent ni une comptabilité légale, ni une preuve autonome de faute, ni un outil de notation du personnel.

## Principes non négociables

1. Toutes les lignes portent le même `company_id` que le calcul demandé. Une ligne étrangère ou sans entreprise fait échouer tout le calcul : aucun mélange silencieux.
2. Les instants sont des ISO 8601 avec `Z` ou décalage explicite et sont stockés en `timestamptz`. Les journées et mois sont découpés à minuit dans `Africa/Porto-Novo`.
3. La période est toujours `[startInclusive, endExclusive)` afin qu'un événement à la frontière n'apparaisse pas dans deux rapports.
4. Une donnée absente n'est jamais remplacée par zéro, une date courante ou une estimation. Les tableaux absents valent « aucune ligne fournie » ; les champs manquants produisent une exclusion documentée.
5. Un ratio de dénominateur nul vaut `not_calculable` avec `value: null`, jamais `0 %`.
6. Une formule, sa population, son unité, son numérateur/dénominateur et ses exclusions accompagnent le chiffre.
7. Les monnaies sont agrégées séparément. Aucune conversion implicite entre XOF et une autre devise.
8. Aucun score composite, podium, classement, sanction, suspension ou réduction d'affectation automatique des livreurs.
9. Un incident, un retard ou un défaut GPS ne suffit jamais à attribuer une faute. Toute conséquence humaine exige l'examen des faits sources, du contexte et un droit de correction.

## Interface pure

```js
const { calculateCrmMetrics } = require('./lib/crm-metrics');

const result = calculateCrmMetrics({
  companyId: '42',
  period: {
    startInclusive: '2026-08-31T23:00:00.000Z', // 01/09 00:00 à Porto-Novo
    endExclusive: '2026-09-30T23:00:00.000Z',   // 01/10 00:00 à Porto-Novo
  },
  asOf: '2026-09-15T11:00:00.000Z',
  orders,
  statusEvents,
  paymentAccounts,
  paymentEvents,
  paymentAdjustments,
  incidents,
  drivers,
  runs,
  stops,
}, {
  delayMinimumSampleSize: 10,
  delayMinimumCoverage: 0.8,
});
```

Les champs camelCase et leurs équivalents PostgreSQL snake_case sont acceptés pour faciliter l'adaptation. La fonction ne modifie pas les tableaux reçus, n'accède pas au réseau, à la base, à l'horloge machine ou aux variables d'environnement.

`asOf` est injecté par l'appelant. Une requête de production doit produire un instantané cohérent à cet instant ; le calcul ne prétend pas reconstruire arbitrairement le passé à partir de colonnes d'état courant.

## Sources minimales par famille

| Famille | Sources | Date d'attribution |
|---|---|---|
| Volumes | `orders`, `order_status_events` | création ou premier événement métier |
| Taux de remise | premiers événements `Livrée` et `Retournée` | clôture |
| Retards | premier `Arrivée`, créneau structuré et fiabilité explicite | arrivée |
| Encaissements | `order_payment_accounts`, `payment_events`, `payment_adjustments` | événement ou `effective_date` |
| Incidents | `delivery_incidents` | ouverture, résolution ou instantané `asOf` |
| Charge | `delivery_runs`, `delivery_stops`, état courant des commandes et capacité | instantané `asOf` |
| Activité livreur | affectation valable au moment de chaque événement | événement |

L'adaptateur SQL devra renommer ou laisser les colonnes snake_case. Il devra lire toutes les lignes utiles, y compris celles antérieures à la période lorsqu'elles sont nécessaires pour déterminer le premier événement ou l'affectation valable.

## Définitions des indicateurs

### Volumes

- `orders_created` : commandes dont `created_at` appartient à la période.
- `orders_picked_up` : commandes dont le premier événement `Récupérée` appartient à la période. Les rejeux ne doublent pas le volume.
- `orders_closed` : commandes dont le premier événement terminal cohérent appartient à la période.
- Issues affichées séparément : `delivered`, `returned`, `cancelled`.

Deux issues terminales différentes pour une même commande signalent une incohérence. La commande est exclue des clôtures au lieu de choisir arbitrairement une issue.

### Taux de livraison

```text
Livrée / (Livrée + Retournée)
```

La population est la cohorte clôturée pendant la période avec une issue `Livrée` ou `Retournée`. Une annulation n'est pas assimilée à un échec de remise et reste visible séparément. Le rapport affiche toujours les deux volumes avec le taux.

### Retards et ponctualité

Un retard n'est calculable que si :

- le premier événement `Arrivée` est valide et porte une attestation explicite de fiabilité préparée par la couche métier ;
- `promised_window_end` est structuré, horodaté avec fuseau et marqué `promised_window_reliable = true` par la couche de préparation ;
- la création ou dernière validation du créneau est horodatée avant son échéance ;
- le créneau n'a pas été modifié après l'arrivée ;
- l'échantillon fiable atteint par défaut 10 opérations ;
- la couverture fiable atteint par défaut 80 % des arrivées candidates.

Sinon, `status` vaut `no_population`, `insufficient_sample` ou `insufficient_coverage`, et tous les résultats de retard restent `null`. Les diagnostics de couverture restent visibles.

Quand le calcul est disponible :

- `lateRate` = arrivées après la fin du créneau / échantillon fiable ;
- `lateNumerator` et `lateDenominator` rendent ce taux recalculable sans interpréter le texte de la formule ;
- `medianLateMinutes` et `p90LateMinutes` utilisent uniquement les retards strictement positifs ;
- les quantiles suivent la méthode déterministe du rang le plus proche ;
- arriver avant l'échéance donne zéro minute, jamais une avance négative.

Le champ texte historique `requested_time` n'est pas fiable pour cet indicateur. Il faut d'abord introduire des bornes structurées et une provenance de validation.

### Encaissements

Par devise :

```text
net = collectes
    - annulations de collecte
    + ajustements entrants
    - ajustements sortants
```

- `payment_events.event_type = collected` alimente les collectes brutes ;
- `event_type = reversed` annule une collecte ;
- les ajustements utilisent `effective_date`, pas leur date technique de saisie ;
- `expectedForClosedOrdersMinor` additionne le montant attendu des commandes clôturées dans la période ;
- les montants sont des entiers sûrs dans l'unité minimale ; les chaînes décimales renvoyées par `pg` pour un `BIGINT` sont acceptées après validation stricte ;
- une devise absente/invalide ou un montant invalide est exclu et signalé ;
- aucun rapprochement implicite et aucune conversion monétaire.

Ces chiffres décrivent le ledger opérationnel et ne remplacent pas les états comptables.

### Incidents

- incidents ouverts dans la période ;
- incidents résolus dans la période ;
- incidents encore ouverts à `asOf` ;
- commandes distinctes concernées ;
- catégories factuelles ;
- commandes avec incident pour 100 commandes prises en charge, seulement avec dénominateur non nul.

Pour ce dernier ratio, une commande avec incident qui n'a pas été prise en charge dans la même cohorte reste visible dans le volume d'incidents mais n'entre pas au numérateur. Une résolution antérieure à l'ouverture ou avec un horodatage invalide est exclue du flux résolu et du stock ouvert, puis signalée comme incohérence.

La catégorie `unknown` est légitime. Le nombre rattaché à un livreur est nommé `incidentContexts` : il décrit le contexte d'une commande affectée au moment du signalement, pas une responsabilité.

### Charge

La charge est un instantané : arrêts déjà créés et encore affectés à `asOf`, commandes non terminales et tournées `planned` ou `active`. Une affectation créée après `asOf` n'est jamais comptée.

- `openParcelCount` inclut planifié et actif ;
- `inProgressParcelCount` inclut seulement les tournées actives ;
- `capacityUse = openParcels / declaredCapacity` lorsque la capacité est un entier positif ;
- une capacité absente donne `null`, pas une capacité inventée.

La charge aide le dispatch. Elle ne mesure pas la productivité mensuelle.

### Activité livreur

La sortie par livreur contient uniquement des faits contextualisés :

- affectations créées ;
- tournées commencées ;
- commandes prises en charge ;
- commandes livrées ;
- commandes retournées ;
- incidents rattachés au contexte de l'affectation.

Pour un événement de commande, le livreur n'est attribué que s'il existe exactement une affectation active à cet instant (`stop.created_at <= événement < stop.removed_at`). Zéro ou plusieurs candidats entraînent une exclusion. L'ordre du tableau est l'identifiant croissant, explicitement pas une performance.

Ne pas ajouter sans nouveau cadrage : vitesse moyenne, immobilité supposée, détours « suspects », temps connecté, GPS hors service, score global ou comparaison punitive.

## Données absentes et qualité

`dataQuality.exclusions` fournit des compteurs techniques sans donnée personnelle. Exemples :

- horodatage absent ou invalide ;
- commande ou tournée manquante ;
- capacité absente ;
- conflit d'issue terminale ;
- doublon d'identifiant de commande ;
- événement de statut sans commande source ;
- affectation absente ou ambiguë ;
- créneau non fiable ou modifié après arrivée ;
- devise, montant ou direction d'écriture invalide.

Une exclusion n'est pas imputée automatiquement à un utilisateur. L'interface doit donner accès à une liste filtrée des faits à corriger, soumise aux mêmes contrôles multi-entreprises.

## Invariants d'intégration

- La requête SQL filtre chaque table et chaque jointure par `company_id` ; la vérification pure est une seconde barrière, pas un remplacement de l'autorisation serveur.
- Le snapshot de charge doit être lu dans une transaction cohérente ou depuis une vue portant `data_as_of`.
- Les agrégats matérialisés restent reconstructibles depuis les événements sources et portent `contract_version`.
- Toute modification de formule crée une nouvelle version ; elle ne réécrit pas silencieusement l'historique.
- Les corrections métier sont append-only ou auditables ; un tableau de bord ne lit pas un cache sans `data_as_of` et état de fraîcheur.
- Les sorties détaillées par livreur suivent les rôles, l'audit d'accès et les règles de conservation du SaaS.
- Les graphiques affichent période, fuseau, définition, volumes et couverture. Le clic mène aux faits sources autorisés.
- Aucun seuil du module ne déclenche une notification disciplinaire, une suspension, une rémunération ou une affectation.

## Tests déterministes

`node scripts/crm-metrics-test.js` couvre sans réseau :

- frontière de jour à Porto-Novo et période `[start, end)` ;
- déduplication par premier événement ;
- incohérences terminales ;
- dénominateur nul ;
- retard fiable, échantillon et couverture insuffisants ;
- ledger d'encaissement, date effective et séparation des devises ;
- stock et flux d'incidents ;
- charge active ;
- réaffectation d'un livreur dans le temps ;
- rejet d'une ligne étrangère ou sans entreprise ;
- tableaux absents sans donnée inventée.

## Sources officielles et primaires

- [IANA — Time Zone Database](https://www.iana.org/time-zones) et [zone.tab](https://data.iana.org/time-zones/tzdb/zone.tab) : identifiants de fuseau ; le Bénin utilise `Africa/Porto-Novo`.
- [PostgreSQL — Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html) : `timestamptz` est conservé en UTC puis affiché dans le fuseau actif ; PostgreSQL s'appuie sur les noms IANA.
- [Node.js — Internationalization support](https://nodejs.org/api/intl.html) : `Intl.DateTimeFormat` repose sur les données ICU ; l'image de production doit conserver les données nécessaires au fuseau nommé.
- [Nations Unies — Principes fondamentaux de la statistique officielle](https://unstats.un.org/fpos) : transparence sur les sources, méthodes, qualité et confidentialité. Ces principes sont utilisés ici comme référence méthodologique, pas comme qualification des chiffres du SaaS en « statistiques officielles ».
- [OIT/JRC — Algorithmic Management practices in regular workplaces](https://www.ilo.org/publications/algorithmic-management-practices-regular-workplaces-case-studies-logistics) : le secteur logistique illustre les gains opérationnels mais aussi les risques pour la qualité du travail et de surveillance intrusive.
- [OCDE — Human-centred values and fairness](https://oecd.ai/en/dashboards/ai-principles/P6) et [Transparency and explainability](https://oecd.ai/en/dashboards/ai-principles/P7) : supervision humaine, information compréhensible et possibilité de contester un résultat automatisé. Le présent module n'est pas un système d'IA ; ces garde-fous sont transposés aux usages décisionnels des indicateurs.

## Fichiers de ce lot

- `lib/crm-metrics.js`
- `scripts/crm-metrics-test.js`
- `docs/CRM_METRICS_CONTRACT.md`
