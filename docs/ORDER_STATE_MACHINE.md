# Cycle d'exécution d'une livraison

## Transitions autorisées

```text
En préparation → Confirmée → Récupérée → En tournée → En livraison → Arrivée
       │              │            │             │              │          │
       └──────────────┴────────────┴─────────────┴──────────────┴────→ Annulée/Retour/Échec

Arrivée + OTP valide → Livrée
Échec → En livraison ou Retour
Retour → Retournée
```

Les états `Livrée`, `Retournée` et `Annulée` sont terminaux. Le passage à `Livrée` n'est pas une transition manuelle : il est effectué dans la même transaction que la validation de la preuve OTP.

## Garanties

- Chaque action sensible possède une clé d'idempotence fournie par le navigateur.
- Une répétition avec la même clé et les mêmes paramètres rend le même résultat sans nouvel effet.
- Une même clé avec des paramètres différents est refusée.
- La ligne de commande est verrouillée pendant la vérification et la modification de son état.
- Un motif est obligatoire pour échec, retour, livraison retournée et annulation.
- Les événements de statut ne sont jamais modifiés par les écrans métier.

## Preuve OTP

- six chiffres générés côté serveur ;
- secret stocké uniquement sous forme salée et hachée ;
- validité de 30 minutes ;
- cinq essais maximum ;
- une répétition réseau d'une tentative échouée ne consomme pas un deuxième essai ;
- un nouveau code révoque l'ancien ;
- un code correct est consommé une seule fois ;
- aucune valeur OTP n'est écrite dans les journaux ;
- après livraison, l'API publique ne renvoie plus la position du livreur.

Le code est actuellement affiché une fois à l'opérateur afin qu'il puisse le transmettre. L'intégration WAHA devra le remettre directement au destinataire et conserver uniquement le résultat d'envoi.

## Incidents

Un incident conserve sa catégorie, sa gravité, sa description, son auteur, sa date et sa résolution. La résolution complète l'incident sans effacer la déclaration initiale.

## Références de conception

- AWS Builders' Library, idempotence et répétitions sûres : https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
- PostgreSQL, verrouillage des lignes : https://www.postgresql.org/docs/18/explicit-locking.html
- OWASP, autorisation d'une transaction : https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
- NIST SP 800-63B, OTP à usage unique et limitation des essais : https://pages.nist.gov/800-63-4/sp800-63b.html
- OWASP, exclusion des secrets dans les journaux : https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
