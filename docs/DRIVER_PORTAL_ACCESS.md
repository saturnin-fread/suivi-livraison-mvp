# Espace livreur et contrôle d'accès

## Objectif

Donner au livreur un espace mobile minimal sans lui ouvrir l'interface d'exploitation de l'entreprise ni les commandes d'un autre livreur.

## Activation du compte

1. Un propriétaire ou manager choisit un profil livreur encore sans compte.
2. Le serveur génère un token aléatoire et ne conserve que son empreinte.
3. Le lien expire après 48 heures et ne peut être utilisé qu'une fois.
4. Le livreur choisit un mot de passe de 12 à 128 caractères.
5. Le compte est lié à une appartenance entreprise et à un seul `driver_id`.

Une adresse déjà utilisée ne reçoit pas une seconde invitation dans cette première version. Le support multi-entreprises d'un même utilisateur nécessitera un sélecteur d'organisation et sera traité séparément.

## Autorisations

| Action | Propriétaire | Manager | Opérateur | Livreur |
| --- | --- | --- | --- | --- |
| Inviter un manager | Oui | Non | Non | Non |
| Inviter opérateur/livreur | Oui | Oui | Non | Non |
| Consulter toutes les commandes de l'entreprise | Oui | Oui | Oui | Non |
| Consulter ses commandes affectées | — | — | — | Oui |
| Modifier une commande d'un autre livreur | Non applicable | Non applicable | Non applicable | Jamais |
| Avancer une étape terrain autorisée | Oui | Oui | Oui | Oui, sur ses commandes |
| Annuler ou déclarer livrée sans preuve | Selon règles métier | Selon règles métier | Selon règles métier | Non |
| Signaler un incident | Oui | Oui | Oui | Oui, sur ses commandes |
| Déclarer la somme réellement reçue | Oui | Oui | Oui | Oui, sur ses commandes |
| Rapprocher ou annuler un encaissement | Oui | Oui | Non | Jamais |
| Générer ou voir le code client | Oui | Oui | Oui | Jamais |
| Saisir le code donné par le client | Oui | Oui | Oui | Oui, sur ses commandes |

## Défense côté serveur

- Le rôle n'est jamais accepté depuis le navigateur comme preuve d'autorisation.
- Chaque requête livreur recalcule la session, le rôle, le profil associé et son état actif.
- Chaque lecture ou mutation d'une commande contient simultanément `company_id` et `driver_id` dans la requête SQL.
- Une commande étrangère répond comme introuvable afin de ne pas confirmer son existence.
- Les routes `/api/app/*` restent interdites aux comptes livreurs.
- Les transitions, incidents, encaissements et tentatives OTP sont idempotents et audités.
- Le code OTP n'est jamais renvoyé par une route livreur et n'est jamais écrit dans les journaux.
- Un écart financier déclaré par le livreur bloque la remise jusqu'au rapprochement par un propriétaire ou manager.

## Périmètre de cette première version

Le livreur peut voir sa file active et son historique, appeler le client, ouvrir un itinéraire externe, avancer les étapes permises, déclarer l'encaissement réel, saisir le code reçu par le client et signaler un incident. Le fonctionnement hors connexion et les preuves photo/signature seront ajoutés dans les lots suivants après leur propre contrôle de sécurité.

## Références

- OWASP Authorization Cheat Sheet : refus par défaut et permission vérifiée à chaque requête.
- OWASP API Security API1:2023 : contrôle d'autorisation au niveau de chaque objet.
- OWASP Forgot Password Cheat Sheet : token aléatoire, stocké de manière sûre, temporaire et à usage unique.
- NIST SP 800-63B : usage unique, durée limitée et limitation des essais pour les secrets courts.
- OWASP Transaction Authorization Cheat Sheet : ordre des étapes et autorisation contrôlés côté serveur.
