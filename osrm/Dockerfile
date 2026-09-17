# OSRM Bénin — moteur de calage sur route (map-matching) pour le rejeu GPS.
#
# Le graphe routier du Bénin est préparé au build (extract -> partition ->
# customize, pipeline MLD) puis figé dans l'image. Le conteneur ne fait que
# servir osrm-routed. Rebuild périodique = données OSM plus récentes.
#
# Profil : par défaut « car » (les motos empruntent le même réseau routier au
# Bénin). Testable avec « bicycle » via l'argument PROFILE (inclut plus de
# petites voies, parfois utile là où l'OSM est pauvre — à qualifier terrain).

# ---- Étape 1 : préparation du graphe ---------------------------------------
FROM ghcr.io/project-osrm/osrm-backend:v6.0.0 AS build

ARG PBF_URL=https://download.geofabrik.de/africa/benin-latest.osm.pbf
ARG PROFILE=car

WORKDIR /data

# curl n'est pas garanti dans l'image ; on l'installe pour récupérer l'extrait.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fSL "$PBF_URL" -o benin.osm.pbf \
    && osrm-extract -p "/opt/${PROFILE}.lua" benin.osm.pbf \
    && osrm-partition benin.osrm \
    && osrm-customize benin.osrm \
    # On ne garde que les fichiers .osrm* nécessaires au service.
    && rm -f benin.osm.pbf

# ---- Étape 2 : service -----------------------------------------------------
FROM ghcr.io/project-osrm/osrm-backend:v6.0.0

WORKDIR /data
COPY --from=build /data/ /data/

# Railway fournit $PORT et route le réseau privé en IPv6 : on écoute sur ::.
# --max-matching-size doit couvrir le plafond applicatif (100 points).
ENV OSRM_PORT=5000
EXPOSE 5000
CMD ["sh", "-c", "osrm-routed --algorithm mld --ip :: --port ${PORT:-$OSRM_PORT} --max-matching-size 1000 /data/benin.osrm"]
