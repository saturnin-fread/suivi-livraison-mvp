# Carte d'exploitation

## Rôle

La page `/app/carte` assemble deux sources sans les confondre :

- Traccar fournit la dernière position technique connue des appareils ;
- la base `delivery` fournit entreprises, livreurs, commandes, destinations, tournées, ordre des arrêts et incidents.

Le navigateur ne reçoit ni identifiant unique Traccar, ni identifiant d'appareil Traccar, ni identifiants d'une autre entreprise. L'API dédiée est `GET /api/app/operations-map` et exige une session d'exploitation, donc un compte livreur ne peut pas l'utiliser.

## Première version livrée

- vue de toute la flotte autorisée ;
- sélection d'un livreur sur la carte ou dans la liste ;
- état opérationnel, charge, fraîcheur GPS, précision, vitesse reçue et incidents ouverts ;
- tournées ouvertes, progression et arrêts restants dans l'ordre confirmé ;
- séparation des commandes hors tournée ;
- destinations positionnées et signalement implicite des destinations sans coordonnées ;
- boutons **Tout afficher**, **Ma position**, **Centrer sur le livreur** et **Actualiser** ;
- actualisation automatique toutes les quinze secondes, désactivable ;
- affichage ou masquage des destinations ;
- ligne pointillée reliant les arrêts dans leur ordre opérationnel ;
- fond cartographique interchangeable et calque satellite optionnel ;
- bibliothèque Leaflet servie localement par l'application pour ne pas dépendre d'un CDN au moment de l'ouverture.

## Ce que la ligne pointillée ne signifie pas

La ligne ne suit pas les routes. Elle ne tient compte ni des sens uniques, ni des voies impraticables, ni du trafic, ni des créneaux clients. Elle sert uniquement à rendre l'ordre des arrêts visible. Tant qu'un moteur de routage fiable n'est pas configuré, l'interface n'affiche ni distance routière, ni durée, ni ETA.

## Fraîcheur et panne GPS

- Une position de plus de dix minutes est marquée ancienne.
- Une panne Traccar ne masque pas les commandes et tournées métier : la carte affiche l'avertissement et conserve la vue opérationnelle disponible.
- Une latitude ou longitude absente reste `null`. Elle ne doit jamais être convertie en coordonnée zéro.
- Une position ancienne n'est jamais décrite comme « en direct ».

La première version interroge Traccar côté serveur lors du rafraîchissement. Les lectures simultanées sont regroupées et l'instantané technique est conservé cinq secondes en mémoire afin que plusieurs écrans ne multiplient pas les appels. Le passage futur à une passerelle WebSocket ne doit pas donner au navigateur un accès direct aux identifiants administrateur Traccar.

## Fonds cartographiques

Variables facultatives de `delivery-app` :

```text
MAP_TILE_URL
MAP_TILE_ATTRIBUTION
MAP_TILE_MAX_ZOOM
MAP_SATELLITE_TILE_URL
MAP_SATELLITE_ATTRIBUTION
MAP_SATELLITE_MAX_ZOOM
```

Sans configuration, le pilote utilise les tuiles standard OpenStreetMap avec attribution. Ce service est fourni sans garantie de disponibilité et ne doit pas être considéré comme le fournisseur cartographique final d'un SaaS commercial. Aucun téléchargement massif, préchargement hors ligne ou masquage d'attribution n'est autorisé.

Le mode satellite n'apparaît que si une URL et une attribution provenant d'un fournisseur autorisé sont configurées. Ne jamais réutiliser des tuiles Google ou d'un autre fournisseur en contournant ses conditions.

## Limites de volume

L'instantané renvoie au maximum 500 commandes actives et 100 tournées ouvertes. Si la limite des commandes est atteinte, l'interface l'indique. La montée en charge nécessitera des requêtes par fenêtre cartographique, du regroupement de marqueurs et des filtres serveur.

## Vérification

```powershell
npm run test:map
```

Avec Chrome et Playwright :

```powershell
$env:RUN_BROWSER_TEST='1'
$env:NODE_PATH='C:\Users\Saturnin001\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:CHROME_EXECUTABLE='C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:map
```

Le test couvre notamment le cloisonnement entre entreprises, les commandes terminales exclues, la tournée, l'ordre des arrêts, les incidents, une destination manquante, l'absence d'identifiant Traccar dans la réponse, les ressources Leaflet locales et l'affichage mobile.

## Références officielles

- Politique des tuiles standard OpenStreetMap : https://operations.osmfoundation.org/policies/tiles/
- Référence Leaflet, dont `locate`, `fitBounds` et les contrôles de calques : https://leafletjs.com/reference
- API Traccar et WebSocket : https://www.traccar.org/traccar-api/
- Services Route et Table d'OSRM : https://project-osrm.org/docs/v26.4.0/api/
- Géolocalisation du navigateur : https://developer.mozilla.org/docs/Web/API/Geolocation_API
