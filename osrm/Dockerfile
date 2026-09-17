# OSRM Bénin — moteur de calage sur route (map-matching) pour le rejeu GPS.
#
# Le graphe routier du Bénin est préparé au build (extract -> partition ->
# customize, pipeline MLD) puis figé dans l'image. Le conteneur ne fait que
# servir osrm-routed. Rebuild périodique = données OSM plus récentes.
#
# Profil : par défaut « car » (les motos empruntent le même réseau routier au
# Bénin). Testable avec « bicycle » via l'argument PROFILE (inclut plus de
# petites voies, parfois utile là où l'OSM est pauvre — à qualifier terrain).

# ---- Étape 0 : récupération de l'extrait OSM -------------------------------
# L'image osrm-backend est basée sur Alpine (pas d'apt) ; on télécharge dans
# une petite étape dédiée qui dispose de curl et des certificats.
FROM alpine:3.20 AS fetch
ARG PBF_URL=https://download.geofabrik.de/africa/benin-latest.osm.pbf
RUN apk add --no-cache curl ca-certificates
WORKDIR /data
RUN curl -fSL "$PBF_URL" -o benin.osm.pbf

# ---- Étape 1 : préparation du graphe ---------------------------------------
FROM ghcr.io/project-osrm/osrm-backend:v6.0.0 AS build

ARG PROFILE=car
WORKDIR /data
COPY --from=fetch /data/benin.osm.pbf /data/benin.osm.pbf

RUN osrm-extract -p "/opt/${PROFILE}.lua" benin.osm.pbf \
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
