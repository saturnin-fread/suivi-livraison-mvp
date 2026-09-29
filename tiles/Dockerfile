# Tuiles Bénin — fond de carte auto-hébergé (remplace tile.openstreetmap.org).
#
# Au build : on récupère le binaire go-pmtiles puis on extrait les pays couverts
# (region.geojson : Bénin et Côte d'Ivoire, avec une marge) depuis la build
# quotidienne mondiale de Protomaps (données OpenStreetMap, licence ODbL). L'extraction ne télécharge
# que les octets utiles (requêtes HTTP Range), pas la planète entière.
# Au runtime : `pmtiles serve` sert les tuiles vectorielles en Z/X/Y. Le service
# n'est joint que par delivery-app sur le réseau privé Railway (pas de domaine
# public nécessaire). Rebuild = données OSM plus récentes.

FROM alpine:3.20 AS build
ARG PMTILES_VERSION=1.31.2
ARG MAXZOOM=15
RUN apk add --no-cache curl ca-certificates tar
WORKDIR /data
COPY region.geojson /data/region.geojson
RUN curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" \
      -o /tmp/pmtiles.tar.gz \
    && mkdir /tmp/pm && tar -xzf /tmp/pmtiles.tar.gz -C /tmp/pm \
    && install -m 755 "$(find /tmp/pm -type f -name pmtiles | head -n 1)" /usr/local/bin/pmtiles \
    && pmtiles --help >/dev/null
# Les builds mondiales sont nommées AAAAMMJJ.pmtiles et ne sont conservées que
# quelques jours : on essaie la plus récente, puis on remonte jusqu'à 10 jours.
RUN set -e; now=$(date +%s); i=0; \
    while [ $i -le 10 ]; do \
      day=$(date -u -d "@$((now - i * 86400))" +%Y%m%d); \
      url="https://build.protomaps.com/${day}.pmtiles"; \
      if curl -fsI "$url" >/dev/null 2>&1; then \
        echo "Extraction depuis $url"; \
        pmtiles extract "$url" zones.pmtiles --region=/data/region.geojson --maxzoom="$MAXZOOM" --download-threads=8; \
        echo "$day" > build-date.txt; \
        break; \
      fi; \
      i=$((i + 1)); \
    done; \
    test -s zones.pmtiles || { echo "Aucune build Protomaps disponible"; exit 1; }; \
    pmtiles show zones.pmtiles; ls -lh zones.pmtiles

FROM alpine:3.20
COPY --from=build /usr/local/bin/pmtiles /usr/local/bin/pmtiles
COPY --from=build /data/zones.pmtiles /data/build-date.txt /data/
# Railway fournit $PORT ; réseau privé en IPv6 → écoute sur [::] (double pile).
ENV TILES_PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec pmtiles serve /data --interface '[::]' --port ${PORT:-$TILES_PORT} --cache-size 128"]
