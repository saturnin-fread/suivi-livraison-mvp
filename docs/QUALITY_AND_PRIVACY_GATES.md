# Barrières qualité, confidentialité et validation produit

## Objet et statut

Ce document définit les conditions minimales de validation des fonctions actuelles et prévues du SaaS de livraison : formulaire client, géolocalisation, suivi public, portail livreur et reprise hors ligne, carte d'exploitation, preuves, incidents, paiements, CRM/exports et notifications WhatsApp via WAHA.

Il s'agit d'un audit statique du dépôt au 15 septembre 2026, pas d'une certification, d'un test d'intrusion ni d'un avis juridique. Les durées légales et les bases autorisant les traitements doivent être décidées par l'entreprise responsable des données selon ses pays, contrats et activités. Les principes NIST, OCDE, W3C et OWASP ci-dessous servent de garde-fous génériques ; ils ne créent pas une règle locale imaginaire.

Statuts utilisés :

- **Couvert** : contrôle visible dans le code ou les tests existants ; il doit encore rester dans la non-régression.
- **Partiel** : bonne base, mais une condition de mise en production manque.
- **Absent** : aucun contrôle suffisant trouvé dans le dépôt.
- **Prévu** : fonctionnalité non terminée ; aucun feu vert ne peut être déduit de sa présence dans la feuille de route.

## Résumé de l'audit actuel

| Domaine | Statut | Éléments observés | Décision qualité |
|---|---|---|---|
| Cloisonnement entreprise/livreur | Couvert, à maintenir | Sessions serveur ; rôles ; filtres `company_id` et `driver_id` ; refus des objets étrangers dans les principaux parcours ; tests de fumée dédiés | Régression d'autorisation obligatoire à chaque nouvelle route |
| Sessions | Partiel | Cookie `HttpOnly`, `SameSite=Lax`, `Secure` sous HTTPS, durée de huit heures, révocation à la déconnexion | Ajouter protection CSRF, limitation des connexions, invalidation globale après changement de rôle/mot de passe et MFA pour les comptes sensibles |
| Mots de passe | Partiel | Sel individuel et `scrypt` ; longueur 12–128 pour les invitations | Paramètres `scrypt` non explicitement alignés sur un profil OWASP ; calibrer et versionner le schéma de hachage |
| APIs sensibles et cache | Couvert, à étendre aux pages | Les réponses `/api/*` portent `private, no-store`; les preuves portent aussi `nosniff` | Ajouter les en-têtes globaux CSP, anti-clicjacking, HSTS, Referrer-Policy et Permissions-Policy adaptés par page |
| Formulaire client | Partiel | Lien aléatoire, expiration de sept jours, modification versionnée, confirmation, alternative textuelle au GPS | Limitation de débit, longueurs/format téléphone, bornes GPS, notice de confidentialité, révocation et minimisation des réponses publiques manquent |
| Géolocalisation client | Partiel | Action explicite, précision affichée, délai, position ajustable, quartier/repère de secours | Expliquer finalité, destinataires, conservation et choix ; distinguer GPS mesuré et point déplacé ; valider latitude/longitude côté serveur |
| Suivi public | Partiel avec risque élevé | Lien aléatoire de trente jours ; arrêt de la position après état terminal ; aucune autre étape de tournée renvoyée | La position précise peut actuellement être renvoyée dans tout état non terminal : l'exposition doit être limitée à la fenêtre de livraison utile et révocable |
| Traccar | Partiel | Identifiants gardés côté serveur ; délai réseau de dix secondes ; données métier séparées | Le compte d'intégration semble large ; restreindre ses permissions, prévoir rotation et cache/fallback ; ne jamais exposer Traccar aux clients |
| Portail livreur | Couvert sur le socle | Compte individuel lié à un livreur ; permissions minimales ; manifeste limité à ses commandes ; actions sensibles imposées côté serveur | Tester systématiquement téléphone perdu/partagé, session révoquée, concurrence bureau-terrain et changement d'affectation |
| Reprise hors ligne | Partiel maîtrisé | Seulement transitions et incidents ; file FIFO, clés d'idempotence, limite 30, expiration 24 h, pas de cache API ; paiement/OTP/preuve restent en ligne | Vérifier altération IndexedDB, changement de compte, XSS, nettoyage réel, quota plein et conflit prolongé |
| OTP de remise | Couvert sur le socle | Code haché, expirant, cinq essais, usage unique, génération séparée du livreur, remise atomique | Ajouter limitation de débit globale et canal d'envoi sûr ; ne jamais mettre OTP, token ou téléphone complet dans les logs |
| Preuves photo/signature | Partiel avec risque élevé | Accès privé, taille 1,2 Mo, JPEG/PNG, signature binaire, remplacement audité, absence du suivi public | Décoder/réencoder, retirer EXIF, analyser le contenu, quotas, stockage objet privé, suppression automatisée et consentement/instruction explicite manquent |
| Incidents et litiges | Couvert sur le socle | Déclaration préservée, événements append-only chaînés, rôles, export audité, gel de conservation révisable | Tester la restauration, l'intégrité hors application, les accès aux exports et la purge hors gel ; le GPS ne doit jamais sanctionner seul |
| Paiements | Couvert sur le socle métier | Événements et ajustements append-only, idempotence, verrouillage, rôles, rapprochement des écarts | Revue financière indépendante, contrôle des exports, clôture journalière et test de restauration requis avant usage réel à grande échelle |
| Carte entreprise | En cours / partiel | Agrégation limitée à l'entreprise, âge/précision de position, tournées et destinations, fournisseur satellite configurable | Autorisation par objet, alternative textuelle, points aberrants, charge élevée, indisponibilité Traccar/cartes et licence des fonds restent des barrières |
| CRM, statistiques et exports | Prévu | Modèle métier et intentions documentés | Ne pas livrer avant définition des colonnes par rôle, minimisation, journal d'export, agrégation et prévention des formules malveillantes CSV/XLSX |
| WAHA / WhatsApp | Prévu, risque contractuel et sécurité élevé | WAHA et n8n ne sont pas sources de vérité selon l'architecture | Validation des conditions WhatsApp, accord/contact attendu, désinscription, HMAC, clé restreinte, déduplication, secours manuel et plafonds de coût obligatoires |
| Purge et cycle de vie | Absent hors file locale | Expirations de liens et gels présents, mais pas de purge générale automatisée observée | **No-go production multi-entreprises** tant qu'un registre de conservation et un job de purge vérifiable n'existent pas |
| Limitation des abus | Absente | Limites de taille sur JSON et fichiers, limites métier OTP | **No-go public** tant que login, formulaires, suivi, fichiers, exports et envoi de messages n'ont pas de quotas adaptés |
| Accessibilité | Partielle | HTML en français, structure simple, quelques régions `aria-live` dans le portail livreur | Plusieurs champs publics n'ont pas d'association `label`/`for`; cartes et mises à jour dynamiques nécessitent alternatives, focus et annonces |
| Observabilité | Partielle | Audit métier et identifiants de corrélation sur erreurs globales | Remplacer les erreurs brutes par un schéma allowlist ; métriques et alertes sans PII, secrets, tokens ni coordonnées précises |

## Invariants de confidentialité et de sûreté

Ces règles sont transversales et bloquent un lot même si son interface « fonctionne » :

1. Une requête authentifiée est refusée par défaut puis autorisée selon le rôle, l'entreprise, l'objet et, pour le livreur, l'affectation active.
2. Un lien public ne révèle qu'une commande. Il ne renvoie jamais les autres arrêts, clients, téléphones, colis ou incidents d'une tournée.
3. La position précise du livreur n'est visible par le client que pendant une fenêtre opérationnelle définie, après affectation utile et avant la fin/annulation/retour. En dehors de cette fenêtre, seul un état métier non localisant est affiché.
4. La position est un signal imparfait : âge, précision, source et anomalies doivent être visibles. Elle ne constitue jamais seule une preuve de faute, de présence ou de remise.
5. Toute action sensible est décidée côté serveur, idempotente lorsque rejouable, auditée sans secret et protégée contre les modifications concurrentes.
6. n8n, WAHA, Traccar, le navigateur et les fournisseurs cartographiques ne deviennent jamais la source de vérité métier.
7. Une information n'est collectée, exportée, journalisée ou envoyée que si une finalité documentée l'exige. Une donnée agrégée ou pseudonymisée remplace une donnée précise lorsqu'elle suffit.
8. Une suppression arrivée à échéance couvre la base active, le stockage de fichiers, les caches, les files, les exports temporaires et, selon une procédure séparée, l'expiration des sauvegardes. Un gel actif bloque la purge des éléments liés.
9. Aucun succès n'est simulé hors ligne : « enregistré sur ce téléphone » et « confirmé par le serveur » sont des états distincts.
10. Une panne d'un fournisseur ne doit pas créer une fausse ETA, une fausse remise, un double paiement ou une rafale de messages.

## Matrice de risques

| ID | Risque et scénario | Gravité | Contrôles actuels | Barrière obligatoire / preuve attendue |
|---|---|---:|---|---|
| R01 | Lecture ou mutation d'une autre entreprise par identifiant modifié | Critique | Filtres organisationnels largement présents | Tests automatisés croisés pour chaque route et chaque rôle ; aucun `2xx`; aucune différence révélant l'existence de l'objet |
| R02 | Le client suit le livreur avant le départ, après une interruption ou pour un autre trajet | Critique | Arrêt après états terminaux | Allowlist d'états exposant le GPS, expiration/révocation immédiate, test avant/pendant/après livraison et après réaffectation |
| R03 | Fuite d'un lien porteur dans historique, capture, journal, support ou messagerie | Élevée | Tokens aléatoires longs ; token d'édition haché | Tokens révocables/rotatifs, réponses minimales, `Referrer-Policy`, aucun token dans logs/analytics, édition sans secret durable dans l'URL |
| R04 | Brute force, scraping du suivi, soumissions massives, épuisement Traccar ou facture de messages | Élevée | Taille JSON/fichier et essais OTP bornés | Limites par IP + compte + token + opération, `429`, temporisation progressive, quotas de dépense et alertes |
| R05 | Coordonnées impossibles, texte géant, téléphone ambigu, formule injectée dans un export | Élevée | Quelques types et listes côté serveur | Schémas serveurs : lat. `[-90,90]`, long. `[-180,180]`, précision bornée, longueurs Unicode, téléphone normalisé, neutralisation CSV/XLSX |
| R06 | Vol de session ou action intersite à l'insu d'un opérateur | Élevée | Cookie sécurisé sous HTTPS et SameSite Lax | CSRF par token/en-tête + vérification Origin/Fetch Metadata, CSP, anti-clicjacking, rotation/invalidation de session, MFA responsables |
| R07 | Compromission des mots de passe après fuite de base ou attaques répétées | Élevée | scrypt + sel ; mot de passe long à l'invitation | Profil Argon2id/scrypt conforme et versionné, test de coût, limitation login, mots de passe compromis, MFA owner/platform admin |
| R08 | Photo malveillante, EXIF révélant un autre lieu, visage ou document inutile | Élevée | Magic bytes, taille, accès privé | Décodage/réencodage, suppression EXIF, scan, quotas, consigne sans visage/document, aperçu/correction et purge prouvée |
| R09 | File hors ligne rejouée sous le mauvais compte ou altérée sur téléphone partagé | Élevée | File par propriétaire, expiration, nettoyage à la déconnexion | Test changement de compte/session, signature du contexte serveur, refus de payload altéré, écran des actions en attente, effacement à distance si possible |
| R10 | Logs contenant téléphone, coordonnées, OTP, cookie, token, URL d'édition ou identifiants WAHA/Traccar | Élevée | Audit métier minimal ; OTP exclu par conception | Journalisation structurée allowlist, masquage, test canari de fuite, accès aux logs restreint/audité, durées bornées |
| R11 | Données conservées indéfiniment ou supprimées malgré un litige | Élevée | Expirations partielles et gel de conservation | Registre approuvé, purge automatisée idempotente, mode simulation, rapport de purge, exclusion des gels, test sur sauvegarde restaurée |
| R12 | Carte inutilisable au clavier/lecteur d'écran ou sur petit écran/faible réseau | Élevée | Quelques informations textuelles | Liste/tabulaire équivalente, actions hors carte, focus visible, annonces, reflow 320 px, contrôles tactiles et mode dégradé textuel |
| R13 | Point GPS aberrant ou ancien utilisé contre un livreur | Élevée | Âge et précision partiellement visibles | Détection d'anomalie non punitive, données brutes préservées selon politique, revue humaine, journal des corrections et droit de contestation interne |
| R14 | Double encaissement, correction destructive ou rapprochement non autorisé | Critique | Verrous, idempotence, journaux append-only, rôles | Tests concurrence/rejeu/coupure, rapprochement par rôle distinct, totaux recalculés, export vérifiable et restauration réussie |
| R15 | Export CRM contenant plus de données que permis ou transféré sans contrôle | Élevée | Fonction prévue, export incident audité | Colonnes allowlist par rôle/finalité, filtres entreprise, justification/trace d'export, expiration du fichier, agrégation par défaut |
| R16 | Message WhatsApp non sollicité, mauvais destinataire, contenu sensible ou envoi multiple | Élevée | Non implémenté | Vérification destinataire, base d'autorisation/attente documentée, STOP/désinscription, aperçu, idempotence, limite, journal sans contenu sensible |
| R17 | API ou tableau WAHA exposé ; faux webhook ; clé globale volée | Critique | Non implémenté | Réseau privé si possible, HTTPS, API key hachée et session-scoped, dashboard fermé, HMAC + anti-rejeu, rotation testée |
| R18 | Usage WAHA incompatible avec les conditions WhatsApp et suspension du numéro | Critique produit | Aucun arbitrage documenté | Revue datée des conditions applicables par le responsable produit ; voie officielle WhatsApp Business comme solution de repli ; décision écrite go/no-go |
| R19 | Fond OSM standard indisponible ou usage non conforme | Élevée disponibilité | Attribution visible | Fournisseur avec conditions/SLA adaptés avant commercialisation, cache conforme, bascule et mode textuel ; pas de préchargement interdit |
| R20 | Satellite sans licence/attribution ou fuite vers un fournisseur | Élevée | URL/attribution configurables | Contrat/licence, domaine allowlist, attribution, politique de données et test de panne avant activation |
| R21 | Sauvegarde inexploitable, restauration trop lente ou secrets non rotatifs | Critique continuité | Documentation d'exploitation partielle | RPO/RTO approuvés, restauration chronométrée, inventaire/rotation secrets, exercice perte de service et preuves de résultat |

## Critères d'acceptation par lot

### Lot A — socle sécurité et confidentialité transversal

- [ ] Toutes les routes figurent dans un inventaire indiquant public/entreprise/livreur/plateforme, rôles, objet et sensibilité.
- [ ] Les tests couvrent accès vertical et horizontal : entreprise A/B, livreur A/B, opérateur/manager/owner, compte désactivé, session expirée.
- [ ] Les mutations authentifiées disposent d'une protection CSRF indépendante de `SameSite`.
- [ ] Login, invitation, formulaire, suivi, OTP, fichiers, exports et futures notifications ont des limites différentes et observables.
- [ ] CSP déployée d'abord en rapport puis en blocage ; HSTS, anti-clicjacking, `nosniff`, Referrer-Policy et Permissions-Policy vérifiés.
- [ ] Les schémas de validation imposent type, format, longueur, plage et listes autorisées côté serveur.
- [ ] Aucun secret, cookie, OTP, token porteur, mot de passe, chaîne de connexion ou coordonnée précise n'apparaît dans les logs applicatifs.
- [ ] La restauration d'une sauvegarde et la rotation des secrets critiques ont été exécutées dans un environnement isolé.

**No-go** si une route sensible manque dans l'inventaire, si un test inter-entreprises réussit, ou si login/API publique restent sans limitation d'abus.

### Lot B — formulaire client et géolocalisation

- [ ] Avant la permission GPS, un texte court indique qui collecte, pourquoi, qui verra la position, pendant combien de temps selon la politique choisie, et comment demander correction/suppression.
- [ ] Le bouton GPS résulte d'un geste explicite ; aucun prompt au chargement ; un refus ne déclenche pas de boucle.
- [ ] Le parcours sans GPS reste complet avec quartier, repère et téléphone.
- [ ] Le marqueur affiche précision et heure de mesure ; un déplacement manuel change la source en « position ajustée » et ne conserve pas une fausse précision GPS.
- [ ] Latitude, longitude, précision et horodatage sont validés côté serveur ; coordonnées hors bornes, NaN et valeurs infinies sont refusées.
- [ ] Double envoi et reprise réseau ne créent qu'une demande ; les données saisies ne sont pas perdues lors d'une erreur récupérable.
- [ ] Le client peut revoir et corriger tant que l'entreprise n'a pas verrouillé la demande ; une version obsolète provoque un conflit explicite.
- [ ] Sans secret d'édition valide, la réponse publique ne contient pas plus que le strict état nécessaire.
- [ ] Lien initial et lien d'édition sont révocables ; expiration et contact de secours sont compréhensibles.
- [ ] Champs correctement nommés pour lecteur d'écran, erreurs liées aux champs et résumé d'erreurs annoncé.

**No-go** si le formulaire exige le GPS, si une coordonnée non valide entre en base, si un lien sans preuve d'édition restitue les données personnelles complètes, ou si la notice est absente.

### Lot C — suivi public du client

- [ ] Le payload est construit depuis une allowlist propre au client et ne contient aucun identifiant interne, téléphone livreur, incident, paiement ou autre arrêt.
- [ ] Le GPS précis n'est renvoyé que pendant les états expressément autorisés ; tests avant récupération, tournée active, livraison, terminal, annulation, retour et réaffectation.
- [ ] À la fin, le serveur cesse de renvoyer les coordonnées même si le navigateur conserve l'ancienne carte.
- [ ] Position actuelle, dernière position connue, âge et précision sont distingués ; au-delà du seuil de fraîcheur, aucune ETA n'est présentée comme fiable.
- [ ] Une ETA indique source, heure de calcul et fourchette ; l'absence de moteur routier produit « non disponible », jamais une heure inventée.
- [ ] Le lien est aléatoire, expirant, révocable et limité en débit ; un nouveau lien invalide l'ancien si le risque l'exige.
- [ ] La page fonctionne sans carte : statut, dernière mise à jour et contact/consigne restent disponibles.
- [ ] Les mises à jour dynamiques sont annoncées sans bavardage excessif (`aria-live="polite"`) et le rafraîchissement respecte la batterie/faible réseau.

**No-go** si un autre colis ou arrêt est visible, si le GPS reste exposé hors fenêtre utile, ou si le token apparaît dans un log/outil d'analyse.

### Lot D — portail livreur et mode hors ligne

- [ ] Le livreur ne voit que ses affectations actuelles ; une réaffectation ou désactivation invalide l'accès au prochain appel serveur.
- [ ] Les actions hors ligne autorisées sont limitées à une allowlist documentée ; paiement, OTP et preuve restent refusés sans serveur.
- [ ] Chaque action affiche « en attente », « confirmée », « conflit » ou « expirée » ; aucune ambiguïté avec un succès serveur.
- [ ] Rejeu FIFO avec même clé d'idempotence ; arrêt sur conflit ; aucune suppression silencieuse.
- [ ] Une file est liée à l'entreprise, l'utilisateur et le livreur ; une autre session ne peut ni la lire ni la rejouer.
- [ ] Déconnexion, changement de compte, expiration 24 h, quota plein et données IndexedDB modifiées sont testés.
- [ ] Cache Storage ne contient aucune API, commande, position, preuve, téléphone ou page personnalisée.
- [ ] Le service worker ancien est remplacé sans bloquer l'application et sans perdre une action encore visible à l'utilisateur.
- [ ] Sur faible réseau, les boutons empêchent les doubles gestes et restent tactiles, lisibles et accessibles au clavier.

**No-go** si une action peut être rejouée sous un autre compte, si une donnée sensible est mise en cache, ou si un paiement/OTP semble réussi hors ligne.

### Lot E — carte entreprise, tournées et estimations

- [ ] L'API agrège uniquement les livreurs, commandes, incidents et tournées de l'entreprise connectée.
- [ ] Une vue liste/tableau fournit les mêmes actions essentielles que la carte.
- [ ] Chaque point précise sa nature : GPS réel, destination client ou position métier déduite ; âge et précision sont visibles.
- [ ] Les autres utilisateurs de l'entreprise ne voient que les données nécessaires à leur rôle ; les coordonnées historiques détaillées ne sont pas incluses dans les statistiques ordinaires.
- [ ] Points aberrants, position ancienne, GPS absent, Traccar indisponible, tuiles indisponibles et plus de 500 commandes ont un comportement défini et testé.
- [ ] Route restante et trace réalisée sont visuellement et sémantiquement distinctes ; aucune ligne droite n'est nommée « itinéraire ».
- [ ] Ordre proposé, ordre confirmé et adaptation terrain restent distincts et audités ; aucune sanction automatique sur écart de route.
- [ ] Le fond cartographique et le satellite ont licence, attribution et politique fournisseur validées ; le fond OSM communautaire n'est pas traité comme un service avec SLA.
- [ ] Localiser l'opérateur est facultatif et n'envoie pas sa position au serveur si un recentrage local suffit.
- [ ] Charge, temps de réponse, fréquence de rafraîchissement, reconnexion progressive et consommation Traccar sont mesurés.

**No-go** si la réponse contient des objets d'une autre entreprise, si une route/ETA trompeuse est affichée, ou si le seul moyen d'agir est de manipuler la carte.

### Lot F — preuves photo, signature et OTP

- [ ] Preuves complémentaires désactivées par défaut ; nécessité documentée par l'entreprise ; OTP privilégié lorsqu'il suffit.
- [ ] Avant capture, consigne claire : colis/lieu seulement, pas de visage, pièce d'identité, écran de téléphone ou document financier.
- [ ] Le client est informé de la signature/photo demandée et peut signaler une erreur ; un mode alternatif existe selon la politique métier.
- [ ] Fichier contrôlé par décodage réel puis réencodé ; métadonnées EXIF retirées ; type, dimensions, taille et quotas imposés côté serveur.
- [ ] Stockage privé chiffré, nom généré, URL courte signée si stockage objet, accès objet par entreprise/livreur vérifié à chaque lecture.
- [ ] Remplacement avant remise supprime l'ancien binaire selon la politique tout en conservant une trace non sensible.
- [ ] Le suivi public et les exports ordinaires n'incluent ni fichier ni identifiant direct de preuve.
- [ ] Preuve obligatoire, paiement et OTP sont revérifiés dans la transaction finale ; aucun état `Livrée` manuel ne contourne la barrière.
- [ ] Mauvais code, code expiré/régénéré, rejeu et concurrence respectent essais, durée et usage unique.

**No-go** si un fichier non réencodé est servi, si EXIF reste présent, si une URL devinée donne accès, ou si une remise contourne OTP/preuve configurée.

### Lot G — incidents, litiges et conservation

- [ ] Déclaration initiale immuable ; note, attribution, résolution et gel sont de nouveaux événements datés/audités.
- [ ] Livreur limité à la déclaration sur sa commande ; dossier complet, gel et export réservés aux rôles définis.
- [ ] La chaîne d'intégrité est vérifiée à la lecture/export ; une anomalie bloque l'usage probatoire et déclenche une alerte.
- [ ] Le dossier distingue fait, déclaration, donnée GPS, précision, inférence et décision humaine.
- [ ] Aucune mesure disciplinaire automatique n'est prise depuis vitesse, retard, absence GPS ou déviation.
- [ ] Export manifeste les sources et empreintes sans secrets, OTP, clés d'idempotence, identifiants Traccar ni données hors dossier.
- [ ] Gel actif empêche purge de tous les objets liés ; date dépassée alerte sans lever automatiquement le gel.
- [ ] Levée motivée, accès/export journalisés, restauration et vérification de l'empreinte testées.

**No-go** si la déclaration d'origine est modifiable, si un opérateur insuffisant exporte/gèle, si un gel est ignoré ou si la chaîne invalide paraît « vérifiée ».

### Lot H — paiements et rapprochement

- [ ] Montants en unité mineure entière, devise explicite, plage bornée ; aucune virgule flottante dans le calcul comptable.
- [ ] Attendu, collecté, écart, rapprochement, remboursement, complément et inversion sont des événements distincts.
- [ ] Double clic, rejeu, coupure après commit, deux opérateurs et deux remboursements simultanés ne doublent jamais la valeur nette.
- [ ] Livreur/opérateur déclarent le fait ; owner/manager rapprochent ou corrigent selon la matrice approuvée.
- [ ] Écart non rapproché bloque la remise si telle est la règle ; message explique l'action attendue sans exposer de secret.
- [ ] Toute correction après clôture ajoute une écriture liée ; aucune modification/suppression de l'original.
- [ ] Totaux écran, API, export et requête SQL de contrôle concordent sur un échantillon et sur les bornes.
- [ ] L'export opérationnel est explicitement séparé de la comptabilité légale ; validation par le comptable de l'entreprise.

**No-go** pour argent réel si un test de concurrence échoue, si un rôle terrain corrige une clôture, si l'historique peut être réécrit ou si la restauration n'est pas testée.

### Lot I — CRM, statistiques et exports

- [ ] Dictionnaire de données : champ, source, finalité, sensibilité, rôles, durée, agrégation et propriétaire.
- [ ] Les vues appliquent l'entreprise et le rôle côté serveur, pas seulement en masquant des colonnes dans l'interface.
- [ ] Indicateurs recalculables depuis les événements sources ; définition, période, fuseau et exclusions visibles.
- [ ] Performances livreur contextualisées ; aucun classement disciplinaire automatique fondé uniquement sur GPS/retard.
- [ ] Export par défaut minimal et agrégé ; coordonnées détaillées, preuves, notes d'incident et téléphones demandent un droit/finalité distincts.
- [ ] CSV/XLSX neutralise les cellules commençant par `=`, `+`, `-` ou `@`; noms de fichiers/feuilles sûrs ; volumes bornés.
- [ ] Chaque export journalise acteur, filtres, colonnes, nombre de lignes, empreinte, date et résultat, sans copier le contenu dans le log.
- [ ] Fichier temporaire expire et n'est pas accessible par URL permanente ; test entreprise A/B et rôle insuffisant.
- [ ] Les graphiques ont tableau de données, libellés, légende non fondée sur la couleur seule et navigation clavier.

**No-go** si le filtrage n'est que visuel, si un export contient des coordonnées précises par défaut, si une formule s'exécute à l'ouverture, ou si l'export n'est pas audité.

### Lot J — notifications WhatsApp avec WAHA

- [ ] Décision produit écrite et datée confirmant que le mode d'intégration choisi respecte les conditions WhatsApp applicables ; réévaluation à chaque changement important de WAHA/WhatsApp.
- [ ] WAHA non exposé publiquement si évitable ; HTTPS, pare-feu, dashboard désactivé/restreint, clé API hachée et clé de session limitée à `send`.
- [ ] Webhooks authentifiés par HMAC, horodatés et protégés contre rejeu ; événement inconnu ignoré et journalisé sans contenu.
- [ ] n8n reçoit une référence métier, pas tous les détails ; aucune coordonnée, preuve, incident complet ou paiement dans un message sauf nécessité approuvée.
- [ ] Destinataire normalisé et confirmé ; aperçu du message ; modèle par événement ; pas d'envoi à un numéro récemment corrigé sans revalidation.
- [ ] Envoi idempotent par entreprise + commande + type + version ; accusé WAHA n'est pas confondu avec lecture humaine.
- [ ] File avec nombre de tentatives borné, backoff avec jitter, dead-letter, reprise manuelle et coupe-circuit ; panne n'empêche pas l'opération métier.
- [ ] Limites par entreprise/numéro/type, plafond de coût, alerte de rafale et arrêt d'urgence global.
- [ ] Consentement/base de contact appropriée et attente du client documentés ; mécanisme simple de refus/désinscription et liste d'opposition appliquée avant chaque envoi non indispensable.
- [ ] OTP jamais enregistré en clair dans logs, n8n, audit ou erreur ; contenu généré côté serveur, durée courte, aucune réponse entrante ne révèle une autre commande.
- [ ] Secrets rotatifs sans interruption ; test clé absente/fausse, HMAC faux, doublon, ordre inversé, timeout et suspension de session WAHA.
- [ ] Canal manuel de secours disponible et visible à l'entreprise.

**No-go** si les conditions d'usage ne sont pas validées, si l'API WAHA est publique sans protection, si un faux webhook passe, si un doublon envoie deux messages, ou si l'absence de WhatsApp bloque la livraison.

## Matrice de tests transversaux

### Accessibilité et mobile — cible WCAG 2.2 AA

| Test | Méthode | Réussite attendue |
|---|---|---|
| Analyse automatique | axe-core/outil équivalent sur login, demande, confirmation, suivi, portail livreur, carte, commande, incident, paiement, export | Zéro violation critique ou sérieuse ; chaque exception manuelle documentée |
| Clavier | Tab, Maj+Tab, Entrée, Espace, Échap, flèches sur composants applicables | Ordre logique, focus visible/non masqué, aucune trappe, toutes les actions possibles hors geste de carte |
| Lecteur d'écran | NVDA + Chrome au minimum, puis TalkBack + Chrome Android | Titres/repères cohérents, champs nommés, erreurs annoncées, statut dynamique utile, boutons carte explicités |
| Reflow | 320, 360, 390 px et zoom texte 200 % / page 400 % | Aucune perte de fonction ni défilement horizontal hors carte/tableau justifié ; vue alternative disponible |
| Toucher | Téléphone réel, une main, soleil/faible contraste | Cibles au moins 24×24 CSS px avec espacement WCAG AA ; viser 44×44 pour actions terrain fréquentes/irréversibles |
| Couleur | Simulations daltonisme/contraste | Statut jamais exprimé par couleur seule ; texte/icônes et focus atteignent les contrastes requis |
| Erreurs | Champs vides/invalides, conflit, timeout, refus GPS | Résumé clair, focus vers l'erreur, valeur conservée, consigne de correction, message non purement technique |
| Carte | Carte masquée puis navigation complète | Liste des livreurs/arrêts, statut et actions essentielles restent utilisables |

### Faible réseau, panne et reprise

Tester au minimum : hors ligne, 2G lente simulée, 400 ms de latence, perte de paquets, réponse interrompue après envoi, `429`, `502/503`, timeout Traccar, tuiles bloquées, WAHA indisponible et base momentanément indisponible.

Réussite attendue :

- aucun double objet, paiement, événement, preuve ou message ;
- aucune perte silencieuse d'une saisie affichée comme enregistrée ;
- statut local/serveur explicite et action de reprise ;
- délais d'attente bornés, annulation possible et reprise progressive ;
- page utile sans tuiles, satellite, Traccar ou WAHA ;
- batterie et données mobiles préservées : rafraîchissement suspendu en arrière-plan et fréquence adaptée ;
- pas de boucle infinie ni tempête de reconnexion.

### Abus et sécurité

- modifier tous les identifiants, tokens, rôles, `company_id`, `driver_id`, `run_id`, `order_id`, preuve et incident ;
- tester token aléatoire faux, expiré, révoqué, ancien après rotation, avec encodages inhabituels ;
- dépasser limites IP, compte, token et globales ; vérifier `429` et récupération sans blocage définitif d'un client légitime ;
- envoyer chaînes vides/immenses, Unicode, HTML, formules tableur, latitudes/longitudes extrêmes, nombres non finis et dates limites ;
- téléverser faux JPEG/PNG, polyglotte, image démesurée compressée, EXIF GPS, fichier tronqué et grand nombre de petits fichiers ;
- réutiliser clés d'idempotence avec même charge puis charge différente ; lancer deux mutations réellement simultanées ;
- modifier IndexedDB, changer d'utilisateur, expirer la session, révoquer le compte pendant une file en attente ;
- forger webhook WAHA, rejouer signature/horodatage, inverser l'ordre, dupliquer événement et provoquer une rafale ;
- vérifier CSP, CSRF, cookies, CORS par défaut, en-têtes, absence de stack/SQL/secrets dans les réponses.

### Autorisations minimales à automatiser

| Ressource/action | Public | Livreur affecté | Opérateur | Manager | Owner | Plateforme |
|---|---:|---:|---:|---:|---:|---:|
| Soumettre sa demande par lien valide | Oui, lien borné | — | — | — | — | — |
| Voir GPS de sa livraison | Oui, lien + fenêtre active | — | — | — | — | — |
| Voir autre arrêt de tournée | Jamais | Jamais | Entreprise seulement | Entreprise seulement | Entreprise seulement | Support exceptionnel audité uniquement |
| Modifier état terrain autorisé | Non | Sa commande | Entreprise | Entreprise | Entreprise | Non par défaut |
| Lire preuve privée | Non | Sa commande selon état | Selon politique | Oui, entreprise | Oui, entreprise | Support exceptionnel audité uniquement |
| Rapprocher/corriger paiement | Non | Non | Non | Oui | Oui | Non par défaut |
| Exporter dossier d'incident complet | Non | Non | Non | Oui | Oui | Support exceptionnel audité uniquement |
| Exporter CRM sensible | Non | Non | Selon colonnes | Selon colonnes | Oui selon finalité | Non par défaut |
| Configurer WAHA/secrets | Non | Non | Non | Limité | Oui | Administration technique distincte |

Chaque case « entreprise » exige encore un test entreprise A contre objet de B. Le support plateforme ne doit pas disposer d'un accès implicite aux données métier ; toute fonction d'assistance exceptionnelle doit être temporaire, motivée et auditée.

## Registre de conservation à faire approuver

Les valeurs déjà codées sont des limites techniques du MVP, pas des durées légales. Toute durée finale doit avoir un propriétaire, une finalité et une validation par l'entreprise responsable.

| Donnée | État actuel / maximum technique connu | Déclencheur de fin | Action cible | Gel possible |
|---|---|---|---|---:|
| Lien de formulaire initial | 7 jours | Expiration, révocation ou soumission | Invalider ; purger/anonymiser les demandes jamais remplies selon politique | Non en principe |
| Secret d'édition | Jusqu'à validation dans le flux actuel | Validation/refus/expiration/révocation | Invalider immédiatement puis supprimer l'empreinte devenue inutile | Non en principe |
| Lien de suivi | 30 jours actuellement | État terminal, révocation ou échéance | Cesser GPS immédiatement ; invalider le lien selon politique client | Oui si dossier, sans GPS public |
| Position GPS publique | Non stockée séparément par la page | Hors fenêtre active ou état terminal | Ne plus restituer, retirer du navigateur et de tout cache | Non pour l'exposition publique |
| Historique GPS Traccar détaillé | À définir | Fin de finalité opérationnelle/litige | Purger ou réduire en agrégats ; durée distincte des statistiques | Oui, ciblé si justifié |
| File hors ligne livreur | 24 h maximum | Confirmation, suppression, déconnexion ou expiration | Effacer de l'appareil | Non ; incident confirmé bascule côté serveur |
| OTP | 30 minutes, secret haché | Usage, révocation, essais épuisés, expiration | Rendre inutilisable ; purger le matériel d'authentification selon politique | Trace de résultat seulement |
| Photo/signature | À définir | Fin de preuve/réclamation | Supprimer binaire puis métadonnées selon calendrier | Oui |
| Incident et événements | À définir | Clôture + calendrier approuvé | Purger/anonymiser sauf gel actif | Oui |
| Paiements/ajustements | À définir avec comptable | Calendrier contractuel/comptable | Archivage/purge contrôlés, jamais réécriture | Oui selon litige |
| Journaux techniques | À définir, court | Échéance opérationnelle/sécurité | Purge automatique ; agrégats non identifiants séparés | Exception sécurité motivée |
| Audit métier | À définir | Calendrier approuvé | Archivage/purge avec intégrité vérifiable | Oui |
| Exports temporaires | À définir, très court | Téléchargement ou échéance | Suppression automatique et révocation URL | Copie dossier formelle gérée séparément |
| Messages WAHA/n8n | À définir au strict minimum | Résultat d'envoi traité | Conserver statut/référence, pas le contenu ni OTP si non nécessaire | Événement métier seulement |
| Sauvegardes | À définir avec RPO/RTO | Rotation de sauvegarde | Expiration automatique, chiffrement, restauration contrôlée | Procédure spéciale pour gel |

Le job de purge doit proposer un mode simulation, produire des comptes par catégorie sans PII, être idempotent, refuser de fonctionner si la configuration est absente/incohérente et vérifier les gels dans la même transaction que la suppression.

## Observabilité sans données sensibles

### Événements permis

- identifiant de corrélation aléatoire ;
- nom stable de l'opération et version ;
- résultat `success`, `denied`, `conflict`, `retry`, `failed` ;
- code HTTP, durée, taille par tranche, nombre d'objets ;
- identifiants internes pseudonymisés/empreintes rotatives si une corrélation est nécessaire ;
- rôle générique, jamais adresse e-mail complète ;
- âge/précision par tranche, jamais latitude/longitude dans les logs ordinaires ;
- fournisseur (`traccar`, `tiles`, `routing`, `waha`) et catégorie d'erreur normalisée ;
- compteur de limite, file, conflit, purge, export, gel, échec de signature et doublon.

### Données interdites dans les logs ordinaires

Mot de passe, cookie, session, API key, HMAC secret, chaîne de connexion, token de demande/suivi/édition/invitation, OTP, URL complète contenant un secret, en-têtes d'autorisation, corps de webhook, contenu WhatsApp, téléphone/e-mail complets, nom client, notes libres, photo/signature, coordonnées exactes et stack brute renvoyée au client.

### Alertes minimales

- hausse des échecs login/OTP et des `429` ;
- tentative répétée d'accès inter-entreprises ou rôle refusé ;
- export sensible inhabituel ;
- chaîne d'incident invalide ;
- purge en échec, gel dépassé, sauvegarde/restauration en échec ;
- double paiement empêché ou conflit financier ;
- position GPS anormalement ancienne à l'échelle du service, sans surveiller nominativement par défaut ;
- panne Traccar, fournisseur de cartes/routage ou WAHA ;
- webhook WAHA invalide/rejoué, file bloquée ou volume d'envoi anormal.

Les alertes doivent conduire à une procédure, un responsable et un délai interne. Un tableau rouge sans personne chargée d'agir n'est pas un contrôle.

## Seuils go/no-go

### Classification

- **P0 critique** : fuite inter-entreprises, GPS public hors fenêtre, secret exposé, faux webhook privilégié, preuve privée publique, paiement doublé/corrompu, purge ignorant un gel. Arrêt immédiat, rollback ou désactivation de la fonction.
- **P1 élevée** : abus public non limité, validation serveur insuffisante, CSRF sensible, rétention sans purge, preuve non assainie, blocage accessibilité d'un parcours essentiel, WAHA sans validation contractuelle. Pas de mise en production du lot.
- **P2 moyenne** : dégradation avec solution de secours sûre. Pilote possible seulement avec responsable, échéance et contournement documentés.
- **P3 faible** : amélioration sans impact immédiat sur confidentialité, intégrité, accessibilité essentielle ou continuité.

### Feu vert pour un lot

Un lot est **GO** seulement si :

- zéro P0 et zéro P1 ouvert dans son parcours ;
- 100 % de la matrice d'autorisation ciblée réussit, y compris entreprise A/B et livreur A/B ;
- zéro secret/OTP/token porteur/coordonnée exacte détecté dans les logs de test ;
- zéro violation accessibilité automatique critique/sérieuse et contrôles manuels du parcours essentiel réussis ;
- reflow à 320 px, téléphone Android réel et faible réseau validés sans perte ni faux succès ;
- idempotence et concurrence testées pour chaque mutation sensible ;
- règles de conservation configurées, purge testée en simulation puis sur données de test, gels respectés ;
- dépendances externes ont timeout, limite, reprise, mode dégradé, propriétaire et conditions d'usage documentés ;
- sauvegarde restaurée pour tout lot qui modifie données financières, preuves ou incidents ;
- preuves de test datées, version/commit, environnement, résultat et anomalies archivés.

### Feu vert pilote puis production

- **Pilote fermé** : quelques P2 peuvent rester avec contournement sûr, responsable et date ; aucune donnée réelle inutile ; support humain disponible.
- **Production multi-entreprises** : zéro P0/P1, aucune P2 sans acceptation écrite, purge et restauration automatisées, surveillance/astreinte définie, test d'intrusion indépendant réalisé, revue de confidentialité et conditions fournisseurs datée.
- **WAHA** : toujours no-go tant que la décision contractuelle et le plan de migration/secours vers une solution officiellement autorisée ne sont pas écrits.

## Preuves à conserver pour chaque validation

- commit et version déployée ;
- scénario, préconditions et données synthétiques utilisées ;
- résultats API/UI, sans secret ni donnée réelle ;
- captures expurgées pour mobile/accessibilité ;
- rapport d'autorisation, d'abus, d'axe et tests manuels ;
- métriques avant/après et comportement en panne ;
- résultat de purge/restauration ;
- risques résiduels, propriétaire, échéance et décision GO/NO-GO signée par le responsable produit.

## Sources primaires et officielles

- [OWASP — Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) : refus par défaut, moindre privilège, contrôle à chaque requête et tests d'autorisation.
- [OWASP — API4:2023 Unrestricted Resource Consumption](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/) : limites de débit, taille, pagination, ressources et coûts tiers.
- [OWASP — Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) : erreurs génériques, limitation des connexions et MFA.
- [OWASP — Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) : profils minimaux Argon2id/scrypt et migration versionnée.
- [OWASP — CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) : token/en-tête, Origin, Fetch Metadata et limites de SameSite.
- [OWASP — HTTP Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html) et [CSP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html) : cache, CSP, clicjacking, type MIME et politiques navigateur.
- [OWASP — Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) : validation allowlist, longueurs et plages côté serveur.
- [OWASP — File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) : type réel, taille, nom généré, stockage séparé et réécriture des images.
- [OWASP — Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) : événements utiles, données à exclure, accès et conservation des logs.
- [OWASP — Transaction Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html) : données significatives, séquence serveur, anti-rejeu et durée courte.
- [W3C — Geolocation](https://www.w3.org/TR/geolocation/) et [MDN — `getCurrentPosition`](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/getCurrentPosition) : permission explicite, finalité, protection, conservation, correction/suppression, HTTPS, précision et délai.
- [W3C — WCAG 2.2](https://www.w3.org/TR/WCAG22/) et [Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/) : cible AA, clavier, focus, erreurs, annonces, reflow et taille des cibles.
- [W3C — Service Workers](https://www.w3.org/TR/service-workers/) : fonctionnement de la coque hors ligne et contrôle du cache.
- [NIST SP 800-122](https://csrc.nist.gov/pubs/sp/800/122/final) : protection contextuelle des informations personnelles, contrôle d'accès, audit et réponse aux incidents.
- [NIST Privacy Framework](https://www.nist.gov/privacy-framework/privacy-framework) : gouvernance volontaire des risques de confidentialité, sans valeur de loi locale.
- [OCDE — principes de protection de la vie privée](https://www.oecd.org/en/topics/privacy-principles.html) : limitation de collecte, qualité, finalité, limitation d'usage, sécurité et responsabilité.
- [Traccar — API officielle](https://www.traccar.org/traccar-api/) : REST, WebSocket `/api/socket` et autorisation de session ; [permissions](https://www.traccar.org/permissions-groups/) pour limiter les objets accessibles.
- [WAHA — documentation sécurité officielle du projet](https://github.com/devlikeapro/waha-docs/blob/main/content/docs/how-to/security/index.md) : ne pas exposer l'API, clé hachée, clés de session restreintes, HMAC et HTTPS.
- [WhatsApp — Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms) et [Terms of Service](https://www.whatsapp.com/legal/terms-of-service) : responsabilité du fournisseur tiers, protection des données et interdiction des usages automatisés non autorisés. À vérifier à nouveau au moment du déploiement.
- [OpenStreetMap Foundation — Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) : attribution, restrictions d'usage et absence de SLA du serveur de tuiles standard.
- [Leaflet — référence officielle](https://leafletjs.com/reference) : localisation, ajustement de vue et contrôle des calques.

