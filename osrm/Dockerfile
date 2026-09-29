# OSRM (Bénin, Côte d'Ivoire) — moteur de calage sur route (map-matching) pour le rejeu GPS.
#
# Le graphe routier des pays couverts est préparé au build (extract -> partition ->
# customize, pipeline MLD) puis figé dans l'image. Le conteneur ne fait que
# servir osrm-routed. Rebuild périodique = données OSM plus récentes.
#
# Profil : par défaut « car » (les motos empruntent le même réseau routier au
# Bénin). Testable avec « bicycle » via l'argument PROFILE (inclut plus de
# petites voies, parfois utile là où l'OSM est pauvre — à qualifier terrain).

# ---- Étape 0 : récupération des extraits OSM -------------------------------
# Un extrait Geofabrik par pays couvert, fusionnés en un seul graphe (osmium).
# L'image osrm-backend est basée sur Alpine (pas d'apt) : téléchargement et
# fusion se font dans une étape Debian dédiée.
FROM debian:bookworm-slim AS fetch
ARG COUNTRIES="benin ivory-coast"
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates osmium-tool \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /data
RUN set -e; for c in $COUNTRIES; do \
      curl -fSL "https://download.geofabrik.de/africa/${c}-latest.osm.pbf" -o "${c}.osm.pbf"; \
    done; \
    osmium merge *.osm.pbf -o zones.osm.pbf --overwrite; \
    ls -lh zones.osm.pbf

# ---- Étape 1 : préparation du graphe ---------------------------------------
FROM ghcr.io/project-osrm/osrm-backend:v6.0.0 AS build

ARG PROFILE=car
WORKDIR /data
COPY --from=fetch /data/zones.osm.pbf /data/zones.osm.pbf

RUN osrm-extract -p "/opt/${PROFILE}.lua" zones.osm.pbf \
    && osrm-partition zones.osrm \
    && osrm-customize zones.osrm \
    # On ne garde que les fichiers .osrm* nécessaires au service.
    && rm -f zones.osm.pbf

# ---- Étape 2 : service -----------------------------------------------------
FROM ghcr.io/project-osrm/osrm-backend:v6.0.0

WORKDIR /data
COPY --from=build /data/ /data/

# Railway fournit $PORT et route le réseau privé en IPv6 : on écoute sur ::.
# --max-matching-size doit couvrir le plafond applicatif (100 points).
ENV OSRM_PORT=5000
EXPOSE 5000
CMD ["sh", "-c", "osrm-routed --algorithm mld --ip :: --port ${PORT:-$OSRM_PORT} --max-matching-size 1000 /data/zones.osrm"]
