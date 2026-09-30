# Accès à TRAXO : inscription, connexion, vérification

## Parcours

1. **Inscription** (`/app/register`) : e-mail + mot de passe (10 caractères
   minimum), ou « Continuer avec Google ».
2. **Code par e-mail** (`/app/login/code`) : 6 chiffres, valable 10 minutes,
   5 essais, renvoi possible toutes les 30 s (5 envois au maximum). Le code est
   haché avec `OTP_PEPPER` ; il n'est jamais stocké en clair.
3. **Configuration guidée** (`/app/bienvenue`) : activité, ville, équipe. Tant
   qu'elle n'est pas terminée, le propriétaire y est renvoyé. Les entreprises
   existantes ne sont pas concernées (`onboarding_status = 'done'`).
4. **Connexion** (`/app/login`) :
   - appareil déjà vérifié (cookie `traxo_device`, 30 jours) → session directe ;
   - nouvel appareil → code par e-mail ;
   - double authentification active → code de l'application (remplace le code
     e-mail) ;
   - « Rester connecté pendant 30 jours » : session de 30 jours au maximum
     (durée fixe). Sinon : 12 heures.

Sans fournisseur d'e-mail configuré, le code par e-mail est désactivé
(la session s'ouvre directement).

## WhatsApp (code de connexion)

- Numéro dédié relié depuis **Paramètres › WhatsApp TRAXO** (visible seulement
  par l'administrateur plateforme : `PLATFORM_ADMIN_EMAILS`). Liaison par code
  (WhatsApp › Appareils connectés › Connecter avec le numéro de téléphone) ou QR.
- Session Baileys chiffrée en base (`whatsapp_auth`, clé `WHATSAPP_SECRET`, à
  défaut `MFA_SECRET`). Changer cette clé impose de relier le numéro à nouveau.
- Sur la page du code, « Recevoir le code sur WhatsApp » apparaît si le numéro
  de l'utilisateur est enregistré avec l'indicatif (+229…) et que le canal est relié.
- Garde-fous : 40 messages / heure (`WHATSAPP_MAX_PER_HOUR`), 25 s minimum par
  destinataire, indicateur « écrit… » avant l'envoi. `WHATSAPP_ENABLED=off` coupe le canal.
- Une seule instance du serveur doit tourner (sinon WhatsApp déconnecte l'autre).
- Client non officiel : risque de restriction du numéro. Canal de secours
  uniquement ; l'e-mail reste toujours disponible.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `BREVO_API_KEY` ou `SMTP_*` | Envoi des codes (déjà utilisé pour les autres e-mails). |
| `OTP_PEPPER` | Secret de hachage des codes. |
| `LOGIN_EMAIL_CODE` | `off` pour couper le code e-mail, `on` pour le forcer (tests). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Active « Continuer avec Google ». Sans elles, le bouton n'apparaît pas. |
| `APP_BASE_URL` | Sert à construire l'adresse de retour Google. |
| `PLATFORM_ADMIN_EMAILS` | Comptes (séparés par des virgules) qui voient Paramètres › WhatsApp TRAXO. |
| `WHATSAPP_SECRET`, `WHATSAPP_MAX_PER_HOUR`, `WHATSAPP_ENABLED` | Canal WhatsApp (voir ci-dessus). |
| `WHATSAPP_FAKE=outbox` | Tests locaux : messages WhatsApp écrits dans `EMAIL_OUTBOX_DIR`. |
| `EMAIL_OUTBOX_DIR` | Tests locaux uniquement : écrit les e-mails dans un dossier (ignoré en production). |

## Activer la connexion Google

1. Google Cloud Console → « API et services » → « Écran de consentement
   OAuth » : type **Externe**, nom « TRAXO », e-mail d'assistance, domaine
   `gettraxo.app`, liens vers `/confidentialite` et `/conditions`.
2. « Identifiants » → « Créer des identifiants » → **ID client OAuth** →
   « Application Web ».
3. URI de redirection autorisée :
   `https://app.gettraxo.app/app/auth/google/callback`
4. Copier l'ID client et le code secret dans Railway (`delivery-app`) :
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
5. Publier l'écran de consentement (sinon seuls les comptes « testeurs »
   peuvent se connecter).

Portées demandées : `openid email profile` (aucune vérification Google
supplémentaire n'est requise pour ces portées de base).

## Tests

```bash
LOGIN_EMAIL_CODE=on EMAIL_OUTBOX_DIR=/tmp/outbox node server.js   # serveur
EMAIL_OUTBOX_DIR=/tmp/outbox SMOKE_BASE_URL=http://127.0.0.1:3000 npm run test:auth
```
