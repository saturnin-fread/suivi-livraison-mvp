# Activer « Continuer avec Google » — pas à pas

Durée : 10 à 15 minutes. Tout se fait dans https://console.cloud.google.com,
projet **TRAXO** sélectionné en haut à gauche (comme sur votre capture).
Menu de gauche : **Google Auth Platform**.

> À la fin, vous aurez deux valeurs à copier dans Railway :
> **ID client** (se termine par `.apps.googleusercontent.com`) et **Code secret du client**.

---

## 1. Branding (ce que l'utilisateur voit sur l'écran Google)

Google Auth Platform → **Branding**

| Champ | Valeur |
|---|---|
| Nom de l'application | `TRAXO` |
| Adresse e-mail d'assistance utilisateur | `support@gettraxo.app` (ou votre Gmail si la liste ne le propose pas) |
| Logo de l'application | **Laisser vide pour l'instant** (un logo déclenche une vérification Google de plusieurs jours) |
| Page d'accueil de l'application | `https://app.gettraxo.app/app/login` |
| Lien vers les règles de confidentialité | `https://app.gettraxo.app/confidentialite` |
| Lien vers les conditions d'utilisation | `https://app.gettraxo.app/conditions` |
| Domaines autorisés | `gettraxo.app` (cliquer « Ajouter un domaine ») |
| Coordonnées du développeur | votre adresse e-mail |

→ **Enregistrer**.

## 2. Audience (qui peut se connecter)

Google Auth Platform → **Audience**

1. Type d'utilisateur : **Externe**.
2. État de publication : cliquez **Publier l'application** → **Confirmer**.
   - Tant que l'application est « En test », seuls les comptes ajoutés dans
     « Utilisateurs tests » peuvent se connecter (100 maximum).
   - Avec les seules autorisations de base (e-mail, nom), Google ne demande
     **pas** de vérification : la publication est immédiate.

## 3. Accès aux données (autorisations demandées)

Google Auth Platform → **Accès aux données** → **Ajouter ou supprimer des champs d'application**

Cocher uniquement :
- `.../auth/userinfo.email`
- `.../auth/userinfo.profile`
- `openid`

→ **Mettre à jour** → **Enregistrer**. (Rien d'autre : chaque autorisation en plus peut déclencher une vérification.)

## 4. Clients (l'écran de votre capture)

Google Auth Platform → **Clients** → **Créer un client**

| Champ | Valeur |
|---|---|
| Type d'application | **Application Web** (déjà sélectionné) |
| Nom | `TRAXO Web` (visible par vous seul) |
| Origines JavaScript autorisées | **Rien** (inutile : la connexion passe par le serveur) |
| URI de redirection autorisés → **+ Ajouter un URI** | `https://app.gettraxo.app/app/auth/google/callback` |

Attention à l'URI : exactement cette adresse, en `https`, sans espace ni `/` final.

→ **Créer**.

Une fenêtre s'ouvre avec **ID client** et **Code secret du client**.
**Copiez les deux tout de suite** (ou cliquez « Télécharger le fichier JSON ») :
Google n'affiche plus le code secret en entier après la fermeture de cette fenêtre.
Si vous l'avez perdu : ouvrez le client → « Ajouter un code secret », puis supprimez l'ancien.

## 5. Railway (où coller les valeurs)

https://railway.app → projet **TRAXO** → service **delivery-app** → onglet **Variables** → **+ New Variable** (deux fois) :

| Nom | Valeur |
|---|---|
| `GOOGLE_CLIENT_ID` | l'ID client (…`.apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | le code secret du client (commence souvent par `GOCSPX-`) |

→ **Deploy** (bandeau violet en haut). Environ 1 minute plus tard, le bouton
« Continuer avec Google » apparaît sur `/app/login` et `/app/register`.

Ne m'envoyez pas le code secret dans la conversation : collez-le directement dans Railway.

## 6. Vérifier

1. Ouvrir `https://app.gettraxo.app/app/login` en navigation privée.
2. « Continuer avec Google » → choisir un compte → retour sur TRAXO.
   - Nouveau compte : configuration guidée.
   - Compte existant avec la même adresse : connexion directe.

## En cas d'erreur

| Message Google | Cause | Correction |
|---|---|---|
| `redirect_uri_mismatch` | URI de l'étape 4 différent | Recopier exactement l'URI ; vérifier que `APP_BASE_URL` vaut `https://app.gettraxo.app` dans Railway |
| « Accès bloqué : l'application n'a pas terminé la procédure de validation » | Application encore « En test » | Étape 2 : Publier, ou ajouter le compte dans « Utilisateurs tests » |
| `invalid_client` | ID ou secret mal copié (espace en trop) | Recoller les deux variables dans Railway |
| Retour sur TRAXO avec « La connexion avec Google n'a pas abouti » | Session expirée (plus de 10 min) ou secret faux | Réessayer ; sinon vérifier le secret |
