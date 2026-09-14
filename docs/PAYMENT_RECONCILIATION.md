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
- Une commande terminée nécessite plus tard un événement d'ajustement comptable ; son historique initial ne doit pas être réécrit.

## Permissions

- Propriétaire, gestionnaire ou opérateur : configurer et enregistrer la collecte.
- Livreur : déclarer uniquement la somme reçue sur une commande qui lui est affectée et arrivée à l'étape de remise.
- Propriétaire ou gestionnaire : rapprocher un écart ou annuler une collecte.
- Les contrôles sont appliqués par l'API, indépendamment des boutons visibles.

## Traçabilité

Chaque configuration, retrait, collecte, annulation et rapprochement produit un `payment_event` append-only avec acteur, date, montant, devise et clé d'idempotence. Les références Mobile Money peuvent être conservées, mais aucun code secret ou justificatif sensible ne doit être enregistré dans les journaux.

Une répétition réseau portant la même clé d'idempotence retourne le premier résultat sans créer un second mouvement. Une commande étrangère au livreur répond comme introuvable.

## Références

- Stripe, montants en unités mineures et XOF sans décimales : https://docs.stripe.com/currencies
- OWASP, moindre privilège et refus par défaut : https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP, autorisation des opérations sensibles côté serveur : https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
