#!/usr/bin/env sh
# panomim Docker imajını derler.
#
#   ./build.sh              → panomim:latest derler
#   ./build.sh v1.2 etiket  → panomim:v1.2 + panomim:latest derler
#   IMAGE=benim/panomim ./build.sh   → farklı image adı
#
# İmaj tek makinede derlenip başka makineye kaynak kod olmadan taşınabilir:
#   docker save panomim:latest | gzip > panomim-image.tar.gz
#   (hedef makinede)  docker load < panomim-image.tar.gz && docker compose up -d
set -eu

IMAGE="${IMAGE:-panomim}"
TAG="${1:-latest}"

cd "$(dirname "$0")"

docker build -t "$IMAGE:$TAG" .

# varsayılan etiket her zaman "latest" olsun ki docker-compose.yml doğrudan çalışsın
if [ "$TAG" != "latest" ]; then
    docker tag "$IMAGE:$TAG" "$IMAGE:latest"
fi

echo
echo "Hazır: $IMAGE:$TAG"
echo "Taşımak için : docker save $IMAGE:$TAG | gzip > $IMAGE-$TAG.tar.gz"
echo "Kurulum      : docker load < $IMAGE-$TAG.tar.gz && docker compose up -d"
