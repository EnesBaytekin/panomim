# ---- build: pure-Go static binary (modernc.org/sqlite → CGO gerekmez) ----
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/panomim ./cmd/panomim \
    && mkdir -p /out/data

# ---- run: distroless (kabuk yok, CA sertifikaları + tzdata dahil) ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build --chown=nonroot:nonroot /out/panomim /panomim
COPY --from=build --chown=nonroot:nonroot /out/data /data
VOLUME /data
EXPOSE 8443
USER nonroot:nonroot
ENTRYPOINT ["/panomim"]
CMD ["-addr", ":8443", "-data", "/data"]
