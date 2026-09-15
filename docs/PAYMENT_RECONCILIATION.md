# Encaissement à la livraison et rapprochement

## Principe

L'encaissement est facultatif par commande. Lorsqu'il est activé, le montant attendu est enregistré en entier dans la plus petite unité monétaire. Pour le XOF, `5000` représente directement 5 000 FCFA car cette devise n'a pas de décimales.

## Cycle

```text
Non configuré
  → À encaisser
  → Encaissé sans écart ─────────────→ Rapproché
  → Écart à vérifier → décision responsable → Rapproché

À encaisser → exigence retirée → Non requis
Encaissé avant fin de livraison → annulation motivée → À encaisser
```

Une commande avec encaissement `À encaisser` ou `Écart à vérifier` ne peut pas être déclarée livrée par OTP. Une somme exacte `Encaissée` permet la remise et peut être rapprochée ensuite. Un écart nécessite d'abord la décision d'un propriétaire ou gestionnaire.

## Corrections

- Le montant attendu peut être modifié tant qu'aucune collecte n'a été enregistrée.
- Une exigence encore en attente peut être retirée avec un motif.
- Une saisie collectée peut être annulée avant la fin de la livraison, avec un motif.
- Après clôture, l'encaissement d'origine n'est plus modifiable et ne peut pas être supprimé.

## Ajustements après clôture

Une commande terminée dont l'encaissement est finalisé accepte deux écritures opérationnelles :

- `refund` : remboursement au client, qui réduit le total net sans jamais le rendre négatif ;
- `additional_collection` : complément reçu après la livraison, qui augmente le total net.

Chaque écriture conserve son auteur, le motif, le mode, une référence facultative, la date effective, la date de saisie et le total obtenu. Une erreur d'ajustement est corrigée par une nouvelle écriture `reversal` liée à l'écriture d'origine. Une écriture inverse ne peut pas être inversée à nouveau et une écriture d'origine ne peut recevoir qu'une seule correction inverse.

La date effective ne peut être ni future, ni antérieure à la clôture de la commande. Le motif doit contenir au moins dix caractères. Les opérations concurrentes verrouillent le compte de paiement afin que deux remboursements simultanés ne puissent pas dépasser le total disponible.

Le fuseau du pilote est `Africa/Porto-Novo`. Avant la commercialisation multi-pays, la date civile devra utiliser le fuseau configuré pour chaque entreprise.

## Permissions

- Propriétaire, gestionnaire ou opérateur : configurer et enregistrer la collecte.
- Livreur : déclarer uniquement la somme reçue sur une commande qui lui est affectée et arrivée à l'étape de remise.
- Propriétaire ou gestionnaire : rapprocher un écart ou annuler une collecte.
- Propriétaire ou gestionnaire : ajouter ou inverser un ajustement après clôture.
- Opérateur et livreur : consulter le résultat selon leur espace, sans créer d'ajustement après clôture.
- Les contrôles sont appliqués par l'API, indépendamment des boutons visibles.

## Traçabilité

Chaque configuration, retrait, collecte, annulation et rapprochement produit un `payment_event` append-only. Chaque correction postérieure produit un `payment_adjustment` append-only. Les deux journaux conservent l'acteur, la date, le montant, la devise et une clé d'idempotence. Les ajustements sont aussi inclus dans les dossiers d'incident exportables.

Les références Mobile Money peuvent être conservées, mais aucun code secret ou justificatif sensible ne doit être enregistré dans les journaux.

Une répétition réseau portant la même clé d'idempotence retourne le premier résultat sans créer un second mouvement. Une commande étrangère au livreur répond comme introuvable.

Ce journal est une preuve opérationnelle et une source de rapprochement. Il ne remplace ni la comptabilité légale, ni les pièces justificatives, ni les obligations définies par l'AUDCIF et le SYSCOHADA. Les exports comptables futurs devront être validés par le comptable de l'entreprise.

## Références

- Stripe, montants en unités mineures et XOF sans décimales : https://docs.stripe.com/currencies
- Stripe, répétition sûre des opérations avec clé d'idempotence : https://docs.stripe.com/api/idempotent_requests
- Modern Treasury, transactions finalisées immuables et écritures inverses : https://docs.moderntreasury.com/ledgers/docs/transaction-status-and-balances
- Modern Treasury, garanties d'immutabilité, atomicité et idempotence : https://docs.moderntreasury.com/ledgers/docs/ledgers-guarantees
- OHADA, Acte uniforme relatif au droit comptable et à l'information financière : https://www.ohada.org/acte-uniforme-relatif-au-droit-comptable-et-a-linformation-financiere-audcif/
- OWASP, moindre privilège et refus par défaut : https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP, autorisation des opérations sensibles côté serveur : https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
