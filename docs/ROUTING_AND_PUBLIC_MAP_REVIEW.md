# Revue indépendante — routage et carte publique client

Statut : **NO-GO en l'état pour activer une route ou une ETA publique**  
Date de revue : 15 septembre 2026  
Périmètre : prochain lot « passerelle de routage + évolution du suivi public »  
Nature : revue statique indépendante, sans modification du code d'exécution

## 1. Portée et sources inspectées

La revue porte sur :

- `server.js`, en particulier le cache Traccar, `GET /api/app/operations-map`, `GET /api/tracking/:token`, les liens de suivi et la gestion globale des erreurs ;
- `public/tracking.html` ;
- `docs/MAPS_AND_ROUTING_PLAN.md` ;
- `docs/QUALITY_AND_PRIVACY_GATES.md`.

Cette revue ne vaut ni test d'intrusion, ni validation juridique, ni preuve d'un comportement en production. Le feu vert exige les tests locaux et publics décrits plus bas sur le commit réellement déployé.

## 2. Décision synthétique

L'architecture proposée dans `MAPS_AND_ROUTING_PLAN.md` est cohérente : passerelle neutre, provenance obligatoire, distinction carte entreprise/carte client, absence d'ETA inventée et repli explicite. Le lot ne doit cependant pas être activé publiquement avant fermeture des risques P0 et P1 ci-dessous.

Les principaux bloqueurs observés dans le code actuel sont :

1. `GET /api/tracking/:token` restitue la position précise pour tout état non terminal. Il n'existe pas encore d'allowlist de la fenêtre opérationnelle autorisée.
2. Le lien de suivi expire, mais le schéma observé ne possède pas de révocation ou rotation explicite.
3. Le suivi public appelle directement Traccar deux fois toutes les dix secondes, par navigateur, sans cache partagé, limitation de débit ou coupe-circuit dédié.
4. Les coordonnées Traccar renvoyées au client ne sont pas validées par une plage serveur avant restitution. Les destinations de la carte entreprise sont vérifiées comme nombres finis, mais pas bornées à `[-90,90]` et `[-180,180]` dans la construction de réponse observée.
5. La page publique ne fixe pas explicitement `Referrer-Policy`, n'arrête pas le rafraîchissement en arrière-plan et ne fournit pas encore toutes les informations textuelles nécessaires quand la carte ou les tuiles sont indisponibles.
6. La rétention/purge générale et la limitation d'abus sont déjà classées absentes dans la revue transversale. Elles bloquent une ouverture publique multi-entreprises.

La carte entreprise actuelle constitue une base utile, mais sa réussite ne prouve pas la sûreté de la future carte client : les deux contrats doivent rester séparés, chacun avec sa propre allowlist.

### État après intégration du premier correctif

Le même jour, le lot a fermé les constats immédiats suivants : allowlist GPS à partir de `En tournée`, retrait terminal, DTO public séparé, validation des coordonnées, instantané Traccar partagé, pause en arrière-plan, vue textuelle, référent limité à l'origine et endpoint routier filtré par entreprise. Les tests locaux couvrent également le mobile, la destination propre au client et le fournisseur routier désactivé.

La décision reste **NO-GO pour activer OSRM ou une ETA publique**. La révocation/rotation des liens, la limitation de débit, le coupe-circuit fournisseur, la purge approuvée et le banc terrain Bénin restent à fermer avant cette activation. Les constats ci-dessous sont conservés comme trace de la revue initiale ; cet addendum indique lesquels ont déjà reçu un premier correctif vérifié localement.

## 3. Priorisation des risques

### P0 — arrêt immédiat ou fonction désactivée

| ID | Risque | Constat ou scénario | Barrière obligatoire | Preuve de fermeture |
|---|---|---|---|---|
| P0-01 | GPS public hors fenêtre utile | Le code actuel exclut seulement les états terminaux ; un lien peut donc suivre le livreur avant le départ utile, pendant une préparation, un échec ou un retour | Définir une allowlist serveur des états et conditions autorisant le GPS, avec refus par défaut ; retirer les coordonnées dès réaffectation, retour, annulation, fin ou révocation | Tests paramétrés sur chaque état, avant/pendant/après tournée, retour, échec, réaffectation et expiration ; aucune coordonnée hors fenêtre |
| P0-02 | Fuite d'autres arrêts ou clients | Une route complète de tournée, une séquence, des legs ou une ETA trop détaillée permettraient de déduire les autres livraisons | Construire un DTO public indépendant depuis une allowlist ; ne jamais sérialiser l'objet entreprise puis supprimer des champs ; exclure arrêts, séquences, legs, géométrie multi-arrêts, capacité, incidents, identité et destination d'autrui | Test JSON récursif et test sémantique avec une tournée d'au moins trois clients ; chaque token ne révèle qu'une commande |
| P0-03 | Fuite inter-entreprises | Toute future route par `runId`, `orderId` ou clé de cache peut mélanger les données de deux sociétés | Toutes les lectures joignent et filtrent `company_id` ; l'appartenance de la tournée, de la commande, du livreur et des arrêts est vérifiée dans la même requête ; cache d'instantané métier indexé au minimum par entreprise, objet et version | Matrice entreprise A/B sur chaque endpoint et chaque état de cache ; aucun `2xx`, aucune différence révélant l'existence d'un objet étranger |
| P0-04 | Token porteur ou secret fournisseur exposé | Un token de suivi donne accès au GPS ; une clé serveur ou une URL complète peut fuiter par log, erreur, référent, analytique ou réponse | Aucun token/secret dans logs, métriques, traces, erreurs ou appels tiers ; `Referrer-Policy: origin` sur le suivi afin de ne transmettre que l'origine requise par les tuiles OSM, jamais le chemin porteur du token ; secrets de routage uniquement côté serveur ; éventuel jeton de tuiles navigateur public, limité par domaine et portée | Scan canari des logs et réponses, inspection réseau navigateur, tests d'erreur fournisseur ; zéro token ou secret retrouvé |

### P1 — pas de mise en production du lot

| ID | Risque | Constat ou scénario | Barrière obligatoire | Preuve de fermeture |
|---|---|---|---|---|
| P1-01 | Coordonnées invalides ou trompeuses | Le suivi restitue les valeurs Traccar sans contrôle de plage ; la destination entreprise n'est pas bornée dans le DTO observé | Schéma serveur commun : latitude finie `[-90,90]`, longitude finie `[-180,180]`, précision finie et positive avec maximum documenté, horodatage valide ; distinguer absent, invalide, aberrant et ancien | Tests NaN, infini, chaînes, valeurs limites, lat/lng inversées, `(0,0)`, eau/hors zone, précision extrême et date future |
| P1-02 | Amplification vers Traccar ou fournisseur de routage | Chaque page publique effectue actuellement deux appels Traccar toutes les dix secondes ; un trafic ou scraping multiplie la charge | Limites par IP et token, cache/coalescence côté serveur, quota global, coupe-circuit, fréquence bornée et suspension quand l'onglet est masqué ; la route publique utilise un instantané déjà calculé et non un gros calcul synchrone | Test de charge et test `429` ; nombre d'appels fournisseur plafonné et mesuré ; aucune tempête après reprise |
| P1-03 | Lien non révocable ou trop durable | Le lien observé expire à 30 jours, sans champ de révocation dans `tracking_links` | Révocation immédiate, rotation possible, ancien token invalidé, expiration adaptée à la finalité et réponse uniforme pour faux/expiré/révoqué | Tests faux, expiré, révoqué, rotatif, ancien après rotation et accès concurrent |
| P1-04 | Cache de données privées mal borné | Une clé incomplète ou un cache HTTP peut resservir une route, position ou ETA à un autre client | `Cache-Control: private, no-store` pour toutes les API et pages personnalisées ; aucun cache service worker ; caches serveur séparés entre données techniques partageables et instantanés métier ; clé comprenant fournisseur, profil, version de graphe, coordonnées normalisées et contraintes, puis entreprise/objet/version pour les résultats métier | Tests chaud/froid/expiré et A/B ; inspection navigateur/CDN ; aucune réponse privée dans Cache Storage ou cache partagé |
| P1-05 | Fallback silencieux ou fausse précision | Ligne droite, ancien calcul ou durée par défaut présentés comme route/ETA réelle | Statuts normalisés `ready`, `stale`, `partial`, `unavailable` ; aucune ligne droite appelée « itinéraire » ; ancien calcul daté et marqué ; aucune ETA si préconditions non réunies | Pannes, route introuvable, matrice partielle et cache expiré montrent un état explicite sans heure inventée |
| P1-06 | Provenance insuffisante | Une distance/durée sans source empêche audit, comparaison et contestation | Chaque calcul conserve fournisseur, profil, version de graphe, entrée normalisée, `calculatedAt`, `validUntil`, méthode ETA, unités, avertissements, rattachement réseau, fallback et version de tournée | Tests de contrat refusant toute réponse `ready` incomplète ; instantané immuable retrouvé par version |
| P1-07 | Rétention non maîtrisée | Les durées définitives et la purge générale ne sont pas approuvées/automatisées | Registre approuvé pour token, cache de route, instantané décisionnel, géométrie, position et logs ; purge idempotente avec simulation, rapport sans PII et respect des gels ; aucune coordonnée exacte dans les logs ordinaires | Exécution de purge sur données synthétiques puis sauvegarde restaurée ; objets échus absents, objets gelés intacts |
| P1-08 | Page publique inutilisable sans carte ou pour certains utilisateurs | Le statut existe, mais les mises à jour ne sont pas annoncées et les fonctions prévues n'ont pas encore d'alternative complète | Contenu textuel équivalent, `aria-live="polite"`, focus visible, commandes clavier, erreurs compréhensibles, reflow 320 px, zoom 200/400 %, Android réel, état utile sans tuiles ni géolocalisation | axe sans critique/sérieuse, NVDA/TalkBack, clavier, 320/360/390 px, réseau 2G et tuiles bloquées |
| P1-09 | Exposition inutile après fin | Le serveur retire les coordonnées en état terminal, mais le navigateur continue son intervalle et la carte reste initialisée | Arrêter flux/minuteur, retirer marqueur/géométrie, vider l'état applicatif sensible et remplacer la zone carte par un état terminal ; aucun stockage local/session de coordonnées | Test transition en direct vers chaque état terminal sans rechargement ; mémoire applicative et requêtes réseau vérifiées |
| P1-10 | Erreurs et logs trop riches | Le gestionnaire global journalise l'objet erreur brut ; les erreurs fournisseurs peuvent contenir une configuration ou une URL | Journalisation structurée par allowlist ; catégorie fournisseur, code, latence et corrélation seulement ; aucune stack brute/URL complète/en-tête/corps en production | Injection d'erreurs canaris ; scan automatique des logs et réponses négatif |

### P2 — pilote possible avec contournement documenté

| ID | Risque | Barrière attendue avant généralisation |
|---|---|---|
| P2-01 | GPS ancien ou imprécis | Afficher âge, précision et source ; geler le marqueur ; élargir ou retirer l'ETA ; ne jamais utiliser seul contre un livreur |
| P2-02 | Tuiles ou satellite indisponibles | Mode texte/liste, attribution permanente, retour automatique au fond rues, fournisseur conforme avant SLA commercial |
| P2-03 | Charge mobile, batterie et données | Pause en arrière-plan, actualisation adaptative, géométrie simplifiée, satellite désactivé sur réseau faible, bouton manuel de reprise |
| P2-04 | Carte difficile à manipuler | Actions essentielles hors carte, cibles tactiles adaptées, bouton « ma position » local au navigateur et facultatif |
| P2-05 | Graphe routier ancien | Date/version visible en diagnostic, routes sentinelles avant bascule, ancienne version conservée pour rollback |

## 4. Contrats de données obligatoires

### 4.1 Contrat entreprise

Le contrat entreprise peut contenir les livreurs et arrêts de l'entreprise connectée, sous réserve du rôle. Il doit :

- filtrer chaque table et chaque jointure par `company_id` ;
- vérifier l'autorisation de l'objet demandé, pas seulement la présence d'une session ;
- ne jamais exposer `traccar_unique_id`, identifiants de fournisseur, clés ou mots de passe ;
- distinguer GPS réel, destination client, route calculée, trace réalisée et simple suggestion ;
- annoncer troncature/pagination au lieu d'omettre silencieusement des commandes ;
- exposer un âge et une précision valides, pas seulement une coordonnée ;
- offrir une vue liste équivalente à la carte.

### 4.2 Contrat public client

Le contrat public doit être créé explicitement et ne doit pas réutiliser le DTO entreprise. Allowlist maximale proposée :

- état public de la commande ;
- position courante ou dernière position autorisée du livreur ;
- âge, précision et nature de cette position ;
- destination du client concerné, si nécessaire à l'expérience ;
- fenêtre d'arrivée, confiance, date de calcul et avertissement autorisé ;
- date de dernière mise à jour ;
- instruction ou contact de secours défini par l'entreprise.

Sont interdits :

- identifiants internes de commande, tournée, arrêt, appareil ou fournisseur ;
- identité, téléphone, adresse, destination ou colis d'un autre client ;
- nombre et ordre des arrêts précédents/suivants ;
- `sequence`, `legs`, matrice, route complète ou géométrie passant par les autres arrêts ;
- capacité/charge du livreur, incidents, paiements et notes internes ;
- historique GPS détaillé.

Une ETA publique doit être produite côté serveur depuis l'instantané interne, puis réduite à une fourchette. Le navigateur public ne doit jamais recevoir les données nécessaires pour recalculer la tournée.

### 4.3 Provenance distance/durée

Une réponse interne `ready` ou une ETA publique `available` n'est valide que si l'instantané source contient :

- fournisseur et profil ;
- version/date des données cartographiques ;
- version de tournée et empreinte des entrées ;
- distance en mètres et durée en secondes ;
- date de calcul, date d'expiration et version de méthode ;
- âge/qualité de la position de départ ;
- distance de rattachement des points au réseau ;
- indicateur de fallback et avertissements ;
- statut explicite de chaque segment ou cellule inaccessible.

La réponse publique n'expose qu'une provenance minimisée, par exemple « calculée à 10:30, données routières, sans trafic en direct », sans nommer les autres étapes.

## 5. Fournisseur : timeout, cache et repli

Valeurs initiales à valider par charge et terrain :

- route simple : délai total serveur de 3 secondes maximum ;
- petite matrice : délai total de 5 secondes maximum, puis traitement asynchrone ;
- aucune relance en boucle ; au plus une relance avec aléa pour une erreur transitoire et seulement si le budget total le permet ;
- ouverture du coupe-circuit après 5 échecs consécutifs ou taux d'erreur supérieur à 50 % sur une fenêtre de 30 secondes ; essai contrôlé après 60 secondes ;
- cache de calcul vivant court, recommandé 5 à 15 minutes selon usage, toujours marqué par âge ;
- cache négatif de quelques secondes pour éviter une rafale sur une route introuvable ;
- aucune route ancienne présentée comme nouvelle ; état `stale` et date obligatoires ;
- aucune grosse matrice dans une requête publique ; limite explicite du nombre de points ;
- une panne routage ne bloque ni les commandes ni l'ordre déjà confirmé ;
- une panne Traccar conserve les informations métier, retire l'état « en direct » et n'invente pas de position.

Ces valeurs sont des garde-fous techniques initiaux, pas un SLA commercial. Le banc terrain et les métriques de production peuvent les resserrer sans affaiblir les garanties de confidentialité.

## 6. Conservation et minimisation

Avant données réelles, le responsable produit doit approuver une durée et une finalité pour chaque catégorie :

| Catégorie | Règle minimale |
|---|---|
| Token de suivi | Expirant et révocable ; empreinte plutôt que token brut si le schéma évolue ; ancien token inutilisable après rotation |
| Réponse/caches publics | Aucun cache HTTP, CDN ou service worker ; aucun stockage local des coordonnées |
| Cache technique de routage | Court, borné, sans nom/téléphone/note ; coordonnées normalisées seulement si nécessaires |
| Instantané ayant servi à une décision | Immuable, lié à l'entreprise/commande/tournée/version, durée alignée sur la finalité opérationnelle ou le litige approuvé |
| Historique GPS Traccar | Politique propre, plus courte que « indéfinie », agrégation lorsque le détail n'est plus requis, gel ciblé et justifié |
| Logs et métriques | Pas de coordonnées exactes, token, URL porteuse, téléphone, nom ou notes ; tranches d'âge/précision et identifiants pseudonymisés seulement |

La purge doit couvrir base, cache, files, exports temporaires et sauvegardes selon leur procédure. Un gel de litige bloque seulement les objets ciblés et ne réactive jamais l'exposition publique du GPS.

## 7. Observabilité requise

### Métriques autorisées

- latence et résultat par opération/fournisseur ;
- taux de route trouvée, partielle, inaccessible et expirée ;
- cache hit/miss/stale et nombre de calculs coalescés ;
- ouverture/fermeture du coupe-circuit ;
- appels, délais, `429`, `5xx` et quotas ;
- âge et précision GPS par tranches ;
- reconnexions, silence du flux et bascule Traccar REST ;
- réponses publiques par statut général, sans token ni coordonnées ;
- refus d'autorisation et tentatives inter-entreprises pseudonymisées.

### Alertes minimales

- fuite canari de token, secret ou coordonnée : P0 immédiat ;
- tentative inter-entreprises répétée ;
- hausse des routes impossibles ou des fallbacks ;
- p90 route simple supérieur à 1,5 seconde sur la cible ou dépassements du budget serveur ;
- fournisseur indisponible, coupe-circuit ouvert, quota à 70/85/95 % ;
- âge GPS anormal au niveau du service ;
- purge ou rotation de token en échec ;
- attribution de fond de carte absente après changement de configuration.

Chaque alerte doit avoir un responsable, une procédure et un délai d'action. Les journaux ordinaires ne contiennent jamais le payload fournisseur brut.

## 8. Matrice go/no-go du prochain lot

| Domaine | GO seulement si | NO-GO si |
|---|---|---|
| Multi-tenant | 100 % des tests entreprise A/B, rôles et objets réussissent à froid et avec cache chaud | Un objet étranger est visible ou son existence déductible |
| Public | DTO allowlist indépendant et tests à trois clients | Autre arrêt, ordre, leg, géométrie multi-arrêts ou donnée interne visible |
| Fenêtre GPS | Allowlist serveur documentée et testée sur tous les états | Coordonnée renvoyée avant/après la fenêtre utile ou après révocation |
| Tokens | Aléatoires, expirants, révocables, rotatifs, jamais journalisés, référent limité à l'origine | Token dans log, métrique, chemin de référent, analytique, erreur ou appel tiers |
| Coordonnées | Plages, types, précision, horodatage et anomalies validés côté serveur | Valeur non finie/hors bornes acceptée ou fausse précision affichée |
| Routage | Fournisseur neutre, provenance complète, route réelle identifiable | Ligne droite ou ancien calcul présenté comme route fraîche |
| ETA | Fourchette, confiance, source, âge, hypothèses et indisponibilité explicites | Heure unique inventée ou déduction des autres arrêts |
| Résilience | Timeout, coupe-circuit, cache borné, fallback sûr, quota et charge vérifiés | Panne fournisseur bloque le métier ou provoque une rafale |
| Rétention | Registre approuvé et purge testée, gels respectés | Conservation indéfinie ou purge non vérifiable |
| Mobile/a11y | 320/360/390 px, clavier, NVDA/TalkBack, 2G et mode sans carte réussis | Parcours essentiel dépend uniquement de la carte ou violation critique/sérieuse |
| Observabilité | Métriques/alertes utiles sans PII ni secrets | Erreur brute, coordonnée, token ou secret dans les logs |

Décision finale du lot : **GO uniquement avec zéro P0 et zéro P1 ouverts**. Un P2 peut rester en pilote fermé seulement avec contournement sûr, responsable nommé et échéance écrite.

## 9. Plan de vérification local

### Tests automatisés obligatoires

1. Tests unitaires du contrat normalisé : unités, statuts, provenance, coordonnées, temps, profils, réponses invalides.
2. Tests d'intégration fournisseur : succès, timeout, `429`, `4xx`, `5xx`, JSON invalide, route absente, matrice partielle, cache frais/expiré, coupe-circuit et reprise.
3. Tests d'autorisation : entreprise A/B, rôle, objet, tournée, commande, chauffeur, cache froid/chaud et requêtes simultanées.
4. Tests publics à trois clients sur une même tournée : chaque token ne reçoit que son état, sa destination autorisée, la position autorisée et sa fourchette.
5. Tests de cycle : préparation, confirmation, récupération, tournée, livraison, échec, retour, terminal, réaffectation, expiration, révocation et rotation.
6. Tests de logs canaris : token, coordonnée, secret factice, téléphone et URL porteuse injectés ; aucun ne doit apparaître.
7. Tests accessibilité automatisés puis manuels ; page utilisable carte masquée.
8. Tests réseau : hors ligne, 2G, 400 ms, perte de paquets, onglet masqué, reprise simultanée et tuiles bloquées.
9. Test charge : plusieurs tokens sur le même livreur ; les appels Traccar/routage restent coalescés et plafonnés.
10. Test purge/rotation sur données synthétiques, avec un objet gelé et un non gelé.

### Banc terrain minimal

Le moteur retenu doit atteindre les seuils du plan existant sur un corpus béninois versionné : au moins 95 % de trajets routables, zéro traversée physiquement impossible dans les routes sentinelles, p90 inférieur à 1,5 seconde pour une route simple, p90 inférieur à 3 secondes pour une matrice de 25 points, puis erreur médiane de durée inférieure à 20 % après calibration pilote.

Une capture d'écran d'une route plausible ne suffit pas : le corpus, le résultat brut normalisé, la version du graphe et la comparaison terrain doivent être archivés.

## 10. Vérification publique après déploiement

Le commit déployé doit être identifié avant test. Les preuves publiques doivent inclure :

1. santé de l'application et version déployée ;
2. tests A/B avec comptes et commandes synthétiques isolés ;
3. token valide, faux, expiré, révoqué et ancien après rotation ;
4. inspection du payload et des en-têtes `Cache-Control` et `Referrer-Policy` ;
5. transition d'une livraison active vers chaque état terminal sans rechargement ;
6. fournisseur routage indisponible, Traccar indisponible et tuiles bloquées ;
7. test mobile Android réel, 320/360/390 px et faible réseau ;
8. charge contrôlée confirmant limitation, coalescence, cache et absence de tempête ;
9. inspection des logs Railway expurgés après tous les scénarios ;
10. absence de données de test résiduelles et rapport daté lié au commit.

Un test public ne doit jamais utiliser le token, le téléphone ou la position réelle d'un client ou d'un livreur.

## 11. Séquence recommandée avant implémentation

1. Fermer P0-01 : fenêtre GPS serveur et retrait immédiat côté navigateur.
2. Fermer P0-04/P1-03 : révocation/rotation, limitation et en-têtes de confidentialité.
3. Introduire les schémas de coordonnées partagés et les tests d'anomalies.
4. Implémenter l'adaptateur de routage uniquement côté serveur, avec contrat et provenance testés.
5. Ajouter timeout, cache, coalescence, coupe-circuit, quotas et métriques avant l'interface.
6. Produire la route entreprise en lecture seule, sans ETA publique.
7. Valider le banc terrain Bénin et la distinction route/trace/suggestion.
8. Créer ensuite un DTO public séparé, minimal, testé contre la fuite des autres arrêts.
9. N'activer l'ETA publique qu'après calibration, purge, accessibilité et vérification publique complète.

## 12. Conclusion de la revue

Le prochain lot peut commencer en développement, mais l'activation publique du routage ou d'une ETA est **NO-GO** tant que les quatre P0 et les P1 ne sont pas fermés et prouvés. La première correction doit porter sur la fenêtre d'exposition GPS, pas sur le dessin de la route. La carte entreprise et la carte client doivent continuer à évoluer comme deux produits de données distincts partageant seulement des services internes sûrs.
