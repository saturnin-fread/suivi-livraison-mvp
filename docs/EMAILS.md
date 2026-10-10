# E-mails transactionnels

Modèles : kit « TRAXO Emails Premium », édition 02 (13 messages actuels A1–A13).
Code : `server/email/` (moteur + `templates/`), images : `public/brand/email-premium/v2/`
(servies à `https://app.gettraxo.app/brand/email-premium/v2/…`).

## Envoi

- Expéditeur : `TRAXO <notifications@gettraxo.app>` (`EMAIL_FROM` pour changer).
- Fournisseur, dans l'ordre : API Brevo (`BREVO_API_KEY`), SMTP (`SMTP_*`), Resend (`RESEND_API_KEY`).
  Hors production, `EMAIL_OUTBOX_DIR` écrit les e-mails dans un dossier (tests).
- Chaque e-mail part en HTML **et** en texte. Chemin SMTP vérifié : `multipart/alternative`.
  Chemin API Brevo (`htmlContent` + `textContent`) : à confirmer sur un e-mail reçu
  (Gmail › « Afficher l'original » › `Content-Type: multipart/alternative`).
- Aucun réessai automatique. Le récapitulatif A7 est marqué « envoyé » avant l'envoi :
  un échec ne provoque pas de rafale.
- Logs : identifiant du modèle et raison d'échec seulement (jamais le code, le lien ni le message).

## Sécurité du rendu

- Variables échappées une seule fois en HTML, brutes dans la version texte et l'objet (une ligne).
- Liens : `https` sur `gettraxo.app`, `app.gettraxo.app` ou l'hôte d'`APP_BASE_URL`, sans
  identifiants ni port. Un lien refusé ou une variable manquante bloque l'envoi
  (`template_error` dans les logs). En dehors de la production, `http://localhost` est accepté.
- Codes : six chiffres, jamais dans un lien ni un bouton.

## Retour à l'ancien gabarit

`EMAIL_TEMPLATES=legacy` dans les variables Railway : les 13 envois reprennent l'ancien
gabarit (`renderEmailShell`) sans changement de code. Supprimer la variable pour revenir au kit.

## Inventaire (confirmé dans le code)

| Modèle | Événement | Déclencheur (fichier) | Destinataire | Condition | Préférence |
|---|---|---|---|---|---|
| A1 | Inscription : code de confirmation | `sendLoginCodeEmail` purpose `signup` (server.js) | la personne qui s'inscrit | e-mail choisi comme canal | — |
| A2 | Connexion : code (nouvel appareil) | `sendLoginCodeEmail` (server.js) | titulaire du compte | appareil non reconnu, canal e-mail | — |
| A3 | Alerte de connexion | `notifyNewLogin` (server.js) — code, TOTP, Google | titulaire du compte | appareil non reconnu | `login_alerts` (Paramètres › Sécurité), activée par défaut |
| A4 | Mot de passe oublié | `POST /app/forgot` (server.js) | titulaire du compte | compte actif ; réponse identique sinon | — |
| A5 | Invitation d'équipe | `POST` invitations équipe (server.js) | personne invitée | case « par e-mail » cochée | — |
| A6 | Code d'invitation | `POST /api/public/invitations/:token/send-code` (server.js) | personne invitée | invitation avec e-mail | — |
| A7 | Récapitulatif des notifications | `runNotificationDigests` + `POST /api/app/notifications/digest` (modules/notifications) | membre (hors livreur) | au moins un élément non lu, non « info » ; 15 affichés | `notification_prefs.digest` quotidien / hebdo |
| A8 | Nouvelle demande de support | `notifySupport('ticket_created')` (modules/support) | `SUPPORT_EMAIL`, sinon 1er `PLATFORM_ADMIN_EMAILS` | — | — |
| A9 | Nouveau message client | `notifySupport('customer_message')` | équipe support | — | — |
| A10 | Demande rouverte | `notifySupport('ticket_reopened')` | équipe support | — | — |
| A11 | Réponse du support | `notifySupport('support_reply')` | auteur de la demande | réponse non interne | — |
| A12 | Demande résolue | `notifySupport('status_changed')` statut `resolved` | auteur de la demande | — | — |
| A13 | En attente du client | `notifySupport('status_changed')` statut `waiting_customer` | auteur de la demande | — | — |

Doublons connus entre un e-mail immédiat et le récapitulatif A7 (A7 reprend les éléments
non lus du centre de notifications) : alerte de connexion (A3 + élément « Sécurité ») et
réponse du support (A11 + élément « Support »).

Familles B (facturation) et C (compte, équipe, clients finaux) du kit : **non branchées**.
Elles attendent leurs règles produit (paiement Kkiapay, découvert, Premium, facture normalisée…).
