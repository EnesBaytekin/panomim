#!/usr/bin/env sh
# todoer Docker imajını derler.
#
#   ./build.sh              → todoer:latest derler
#   ./build.sh v1.2 etiket  → todoer:v1.2 + todoer:latest derler
#   IMAGE=benim/todoer ./build.sh   → farklı image adı
#
# İmaj tek makinede derlenip başka makineye kaynak kod olmadan taşınabilir:
#   docker save todoer:latest | gzip > todoer-image.tar.gz
#   (hedef makinede)  docker load < todoer-image.tar.gz && docker compose up -d
set -eu

IMAGE="${IMAGE:-todoer}"
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
