# Portefeuille prépayé (paiement à la commande)

Code : `server/modules/billing/` (`service.js` pour les règles, `payments.js` pour
les prestataires, `routes.js` pour l'API). Schéma : `server/migrations/0003_wallet.sql`.
Test : `scripts/billing-test.js`.

## Règles

| Règle | Valeur par défaut | Réglage |
|---|---|---|
| Débit | une fois par commande, **à sa création** (une commande a toujours un livreur) | — |
| Prix dégressif selon le rang de la commande dans le mois | 1–300 : 25 F · 301–1 500 : 20 F · au-delà : 15 F | `tiers` |
| Essai gratuit (3 jours) | commandes non débitées | `freeDuringTrial` |
| Annulation avant le départ (« En préparation », « Confirmée ») | remboursée | — |
| Annulation après le départ | non remboursée (le suivi a eu lieu) | — |
| Découvert autorisé | l'équivalent de 10 commandes | `overdraftOrders` |
| Alerte de solde bas | moins de 20 commandes couvertes | `lowBalanceOrders` |
| Blocage au-delà du découvert | **désactivé** tant que le paiement en ligne n'est pas ouvert | `enforcement` |
| Recharge | de 1 000 F à 2 000 000 F, 5 000 F conseillés | `minRecharge`, `maxRecharge`, `suggestedRecharge` |
| Bonus de recharge (plus haut palier atteint) | +5 % dès 5 000 F · +10 % dès 20 000 F · +15 % dès 50 000 F | `rechargeBonus` |
| Prix affichés | TTC | `pricesIncludeTax` |
| Rapport Premium | 2 offerts au total, puis 1 500 F le rapport ou 2 500 F les 30 jours | `premium` |

Le rang dans le mois compte les commandes débitées (une commande remboursée
compte quand même). Le mois suit le fuseau de Porto-Novo.

Les réglages se modifient sans redéployer, par l'équipe TRAXO :
`PUT /api/app/platform/billing/settings` (`{ "settings": { … } }`). Seules les
valeurs changées sont stockées (`billing_settings.overrides`). Un réglage
incohérent est refusé.

## Garanties

- **Journal** (`wallet_entries`) : on n'y modifie ni n'y efface aucune ligne.
  Un déclencheur l'interdit, sauf quand l'entreprise elle-même est supprimée.
  Chaque ligne porte le solde obtenu après elle.
- **Solde** (`wallets.balance`) : il est mis à jour dans la même transaction
  que la ligne, sous verrou. Il doit toujours valoir la somme du journal ; le
  test le vérifie.
- **Une commande** n'est débitée qu'une fois et remboursée au plus une fois
  (index uniques).
- **Le débit fait partie de la transaction de création** : si le solde est
  insuffisant (blocage activé), la commande n'est pas créée (HTTP 402,
  `code: wallet_insufficient`).
- **Une transaction Kkiapay** ne crédite qu'une seule recharge (index unique).
  Une recharge déjà créditée n'est jamais recréditée.

## Recharge avec Kkiapay

1. `POST /api/app/billing/recharges { amount }` (propriétaire ou responsable) :
   le serveur crée la recharge (`REC-AAAA-XXXXXXXX`, en attente) et renvoie les
   paramètres du widget. Seule la clé publique y figure, avec la référence en
   `data`.
2. Le navigateur ouvre le widget Kkiapay (Mobile Money, carte). En cas de
   succès, il reçoit un `transactionId`.
3. `POST /api/app/billing/recharges/:id/confirm { transactionId }` : le serveur
   **revérifie la transaction auprès de l'API Kkiapay**
   (`/api/v1/transactions/status`, clés publique, privée et secrète). Il crédite
   le portefeuille si les trois conditions sont remplies :
   - le statut est `SUCCESS` ;
   - le montant est suffisant ;
   - la référence renvoyée correspond, quand l'API la renvoie.

   Le bonus est crédité dans une ligne séparée. Si le navigateur se ferme avant
   la confirmation, la même route peut être rappelée plus tard.

Variables Railway : `KKIAPAY_PUBLIC_KEY`, `KKIAPAY_PRIVATE_KEY`,
`KKIAPAY_SECRET_KEY`, et `KKIAPAY_SANDBOX` (`false` pour encaisser réellement ;
bac à sable par défaut). Sans ces clés, la recharge en ligne est indisponible
(503).

En développement et dans les tests, `BILLING_TEST_PAYMENTS=on` active un
prestataire de test qui accepte toute recharge. Il n'est jamais disponible en
production.

**À valider quand les clés seront là**, avec un vrai paiement en bac à sable :
- les champs exacts de la réponse de vérification (`status`, `amount`,
  `state`) ;
- l'ajout du webhook Kkiapay (notification serveur à serveur), utile si le
  navigateur se ferme juste après le paiement ;
- la fermeture du widget sans payer : la page s'appuie sur
  `addKkiapayCloseListener` s'il existe, pour rendre le bouton « Payer »
  de nouveau utilisable.

## Rapport Premium (Excel enrichi)

Le CSV et le SVG restent gratuits. L'Excel enrichi suit ces règles :

- **2 rapports offerts au total** par entreprise (`premium.freeReports`). Un
  rapport n'est décompté qu'une fois le classeur réellement produit : une
  sélection vide ou une erreur ne consomme rien.
- **Aucun rapport offert** si l'essai gratuit a déjà servi ailleurs
  (`trial_status = 'used_elsewhere'`). Les mêmes clés anti-abus s'appliquent :
  adresse, numéro et appareil.
- **Ensuite, deux options**, payées depuis le portefeuille par le propriétaire
  ou un responsable :
  - **1 500 F le rapport**, avec un accord explicite (`pay: 'report'`, bouton
    « Payer 1 500 F et préparer ») ;
  - **2 500 F pour 30 jours illimités** (`POST /api/app/reports/premium/month`),
    prolongés de 30 jours si le mois est déjà en cours, sans renouvellement
    automatique.
- **Pas de découvert** pour un achat Premium : il faut le solde. Le découvert
  sert à finir une journée de livraisons, pas à payer une option.

Données : `company_export_access.premium_free_used` et `premium_month_until`
(migration `0004`). Les paiements apparaissent dans le journal sous les types
`premium_report` et `premium_month`.

## Page Facturation (Paramètres › Facturation)

Front : `public/billing.js` et `public/billing.css`, d'après le kit
« Facturation TRAXO » V2.2. Toutes les valeurs viennent de l'API. Un solde
ou un volume inconnu s'affiche « — », jamais 0.

- **Portefeuille** : le solde, le bouton Recharger, l'activité du mois et
  les trois derniers mouvements. L'activité compte les commandes débitées
  par jour depuis le 1er (`month.daily` dans `GET /api/app/billing/wallet`).
  Les commandes de l'essai gratuit n'y figurent pas.
- **Mouvements** : `GET /api/app/billing/movements` accepte `category`,
  `q`, `month` (`AAAA-MM`), `page` et `pageSize`. Sans recherche, les débits
  de commandes sont regroupés par jour. Le détail d'un jour est servi par
  `GET /api/app/billing/movements/day/AAAA-MM-JJ`. L'export
  `GET /api/app/billing/movements.csv` contient toutes les lignes filtrées,
  sans regroupement. Le séparateur est `;` et une cellule qui commence par
  `=`, `+`, `-` ou `@` est neutralisée. Ces trois routes sont réservées au
  propriétaire et aux responsables.
- **Tarifs & bonus** : les paliers, la progression vers le palier suivant et
  les bonus de recharge.
- **Recharge en deux étapes** : on choisit le montant, puis on le confirme.
  - Paiement ouvert : le widget Kkiapay s'ouvre ; le solde ne change
    qu'après vérification par le serveur.
  - Paiement fermé (cas actuel) : « Préparer ma demande » ouvre une demande
    au support déjà remplie (`TraxoSupport.compose`). Rien n'est envoyé avant
    que la personne relise et valide.
- **Jauge d'utilisation** : elle est dans la navigation, pour le propriétaire
  et les responsables. Elle mesure la progression entre deux paliers de prix
  du mois ; ce n'est ni un crédit restant ni un quota.

**« Commandes offertes » (présentation seulement).** Le portefeuille reste
en FCFA et aucun quota n'est créé. Le calcul :

    achetées = ⌊montant ÷ P⌋
    total    = ⌊(montant + bonus) ÷ P⌋
    offertes = total − achetées

P est le prix le plus élevé de la grille (25 F aujourd'hui). La page
l'affiche comme une estimation, avec astérisque. Une commande facturée à un
palier inférieur coûte moins cher : le crédit couvre alors davantage de
commandes. L'économie équivalente vaut bonus ÷ (montant + bonus). Ce n'est
pas le taux du bonus.

**Alerte de solde bas** : `PUT /api/app/billing/preferences` prend
`{ alertEnabled, threshold }`. Le seuil est en francs ; `null` revient au
seuil par défaut, soit `lowBalanceOrders` commandes au prix de la prochaine.
Ce seuil sert aussi à l'état « Solde bas » de la page. Sous le seuil, une
notification « À traiter » apparaît dans la cloche du propriétaire et des
responsables, à condition que l'espace ait déjà été crédité (recharge ou
correction TRAXO). Elle réapparaît après chaque recharge si le solde redescend.
Aucune recharge automatique n'est déclenchée. Données :
`wallets.low_balance_alert` et `wallets.low_balance_threshold`
(migration `0005`).

## Correction par l'équipe TRAXO

`POST /api/app/platform/billing/adjustments { companyId, amount, note }` sert aux
gestes commerciaux et aux corrections. Le montant est signé et le motif est
obligatoire. La correction est journalisée et tracée dans `audit_logs`.

## Hors périmètre (à décider)

- **Factures** : au Bénin, les factures doivent être normalisées (e-MECeF). Un
  reçu de recharge n'en est pas une. À voir avec un comptable avant de facturer
  réellement.
- La TVA (prix TTC ou HT) reste à trancher : le réglage `pricesIncludeTax` ne
  change aujourd'hui que l'affichage.
