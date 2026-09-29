# Tuiles Bénin (fond de carte auto-hébergé)

Remplace `tile.openstreetmap.org`, dont la politique d'usage interdit un usage
commercial intensif (blocage possible sans préavis).

- **Données** : extrait Bénin de la build quotidienne Protomaps (OpenStreetMap,
  ODbL — l'attribution « © OpenStreetMap » doit rester visible sur la carte).
- **Format** : un seul fichier `benin.pmtiles` (tuiles vectorielles, zoom 0–15),
  figé dans l'image au build.
- **Service** : `pmtiles serve` expose `/benin/{z}/{x}/{y}.mvt`.
- **Rendu** : côté navigateur par `protomaps-leaflet` (Canvas), style clair,
  libellés en français quand OSM les a.

## Déploiement Railway

Service Docker dans le même projet que `delivery-app` et `osrm`.

- Source : ce dépôt, **Root Directory = `tiles`** (Railway lit `tiles/Dockerfile`).
- Pas de domaine public : delivery-app relaie les tuiles sur `/tiles/{z}/{x}/{y}.mvt`
  (même origine, cache navigateur 7 jours, cache mémoire côté serveur).
- Variable côté delivery-app : `TILES_INTERNAL_URL=http://<service>.railway.internal:8080`.
  Sans elle (ou si le service ne répond plus), l'app revient au fond raster
  `MAP_TILE_URL` (OSM par défaut) : mode dégradé, pas de carte blanche.
- Mise à jour des données : redéployer le service (≈ quelques minutes).
