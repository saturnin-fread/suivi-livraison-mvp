# Espace livreur et contrôle d'accès

## Objectif

Donner au livreur un espace mobile minimal sans lui ouvrir l'interface d'exploitation de l'entreprise ni les commandes d'un autre livreur.

## Activation du compte (invitation par QR)

1. Un propriétaire ou un responsable affiche le QR code du livreur (Livreurs ›
   profil › Inviter). Le livreur doit avoir un téléphone sur son profil.
2. Le serveur crée une invitation : un jeton aléatoire (lien `/rejoindre/…`)
   et un code de secours `TX-XXXXXXXX`, dont seules les empreintes sont
   conservées. Validité : 15 minutes, usage unique. Une nouvelle invitation
   remplace la précédente.
3. **Le mode de vérification est figé à la création** :
   - `whatsapp` : si le canal WhatsApp est relié, le livreur reçoit un code
     à 6 chiffres sur le numéro de son profil (5 essais, 10 minutes). Si
     WhatsApp tombe ensuite, le code reste exigé : l'invitation ne passe
     jamais sans vérification. Le responsable affiche alors un nouveau QR.
   - `in_person` : sans WhatsApp, le QR seul ne suffit pas. Après le scan,
     le téléphone du livreur affiche un numéro à 4 chiffres. Le même numéro
     apparaît sur l'écran du responsable avec « Oui, c'est … / Ce n'est pas
     lui ». La session ne s'ouvre que pour le téléphone qui a scanné, et
     seulement après la confirmation. Un nouveau scan remplace la demande
     précédente. Un refus annule l'invitation (le QR a pu fuiter).
4. Le compte livreur (sans mot de passe ni e-mail réel) est lié à une
   appartenance entreprise et à un seul `driver_id`. L'ancien téléphone est
   déconnecté ; la session dure 90 jours.

Routes : `POST /api/app/drivers/:id/invitation` (création),
`GET /api/app/drivers/:id/invitation` (état vu par le responsable),
`POST /api/app/drivers/:id/invitation/pairing` (confirmer ou refuser, avec le
numéro affiché), `POST /api/public/driver-invitations/:ref/accept` (code
WhatsApp, ou demande de confirmation), `POST
/api/public/driver-invitations/:ref/pairing` (le téléphone attend la
confirmation). Test : `scripts/driver-join-test.js`.

Historique : le test d'intrusion du staging (Shannon, 9 octobre 2026,
AUTHZ-01) a montré que, sans WhatsApp, le QR seul ouvrait une session.
Corrigé par la confirmation du responsable (migration `0006`).

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
