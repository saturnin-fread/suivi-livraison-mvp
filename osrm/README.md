# OSRM Bénin (map-matching)

Moteur de routage/calage sur route pour le rejeu GPS. Sert le service **Match**
d'OSRM (colle une trace GPS bruitée au réseau routier) et, accessoirement,
Route et Table.

## Ce que ça corrige — et ce que ça ne corrige pas

Le rejeu affichait la trace GPS brute (points reliés par des droites), d'où des
zigzags qui ne suivent pas la voirie. Le map-matching remplace ça par la route
réelle **quand la rue existe dans OpenStreetMap**.

Limites à connaître (elles sont réelles, pas contournables par du code) :

- **Couverture OSM du Bénin.** OSRM ne peut caler que sur des routes présentes
  dans OpenStreetMap. Une rue non cartographiée sera soit ignorée (trou dans la
  trace), soit rattachée à la route voisine la plus proche (décalage). Sur les
  axes bien mappés (grands boulevards de Cotonou) le gain est net ; dans les
  quartiers peu mappés, le gain est partiel voire nul.
- **Densité des points GPS.** Le map-matching devine l'itinéraire entre deux
  points. Avec un intervalle de 5 min, une moto parcourt 1–2 km entre deux
  points : OSRM choisit alors l'itinéraire *le plus rapide*, pas forcément celui
  réellement emprunté. **Baisser l'intervalle (15–30 s) améliore bien plus la
  qualité que n'importe quel réglage OSRM.**

Le vrai levier de fond reste la complétude d'OSM au Bénin (y contribuer), pas le
moteur.

## Déploiement Railway

Service Docker dans le projet `enthusiastic-playfulness` (à côté de
`delivery-app` et `traccar`), même réseau privé.

- Source : ce dépôt, **Root Directory = `osrm`** (Railway lit `osrm/Dockerfile`).
- Le graphe est préparé au build : le premier déploiement prend quelques minutes.
- Réseau privé Railway = IPv6 : le conteneur écoute sur `::` (voir Dockerfile).

### Câblage côté delivery-app

Variables à définir sur `delivery-app` (le calage est best-effort : sans ces
variables, repli transparent sur la trace nettoyée) :

```
ROUTING_PROVIDER=osrm
ROUTING_OSRM_URL=http://<nom-service-osrm>.railway.internal:5000
ROUTING_OSRM_PROFILE=driving
ROUTING_MAP_DATA_VERSION=benin-<AAAA-MM-JJ>
ROUTING_PROVIDER_VERSION=osrm-6.0
```

`ROUTING_OSRM_URL` doit être une URL http/https **sans** identifiant, mot de
passe, paramètre ni fragment (contrainte de l'adaptateur `lib/routing.js`).

### Rafraîchir les données OSM

Redéployer le service : le build retélécharge l'extrait Geofabrik du Bénin et
reprépare le graphe. Penser à mettre à jour `ROUTING_MAP_DATA_VERSION`.

## Arguments de build

| Argument | Défaut | Rôle |
|---|---|---|
| `PBF_URL` | extrait Bénin Geofabrik | source OSM |
| `PROFILE` | `car` | profil OSRM (`car`, `bicycle`, `foot`) |

Les motos empruntent le réseau routier « car » au Bénin ; `bicycle` inclut plus
de petites voies et peut être testé là où l'OSM est pauvre, à qualifier terrain.
