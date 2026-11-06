#!/usr/bin/env sh
# Panomim — tek komutla kurulum.
#
# Kullanım (kurulum ve güncelleme — aynı komut):
#   sudo bash install.sh <alan-adiniz>            # domain + Let's Encrypt (443)
#   sudo bash install.sh                          # domain'siz, self-signed (8443)
#   VERSION=v1.0.0 sudo bash install.sh <alan>    # belirli sürüm (varsayılan: latest)
#
# Yapar: doğru mimariyi seçer → indirir → bütünlük kontrolü → binary'yi kurar →
# panomim kullanıcısı + veri dizini + /etc/panomim/env + systemd servisi →
# zaten kuruluysa yeni sürümü yükler ve servisi yeniden başlatır (günceller).
set -eu

DOMAIN="${1:-}"
VERSION="${VERSION:-latest}"
REPO="EnesBaytekin/panomim"
BASE="https://github.com/${REPO}/releases/${VERSION}/download"

# curl yoksa wget'e düş (minimal Debian için)
fetch() { # url hedef
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    echo "hata: curl veya wget yok — apt install curl" >&2
    exit 1
  fi
}

# 1) mimari tespiti
case "$(uname -m)" in
  x86_64|amd64)  ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l|armv6l) ARCH="armv7" ;;
  *) echo "hata: desteklenmeyen mimari: $(uname -m)" >&2; exit 1 ;;
esac
BIN="panomim-linux-${ARCH}"

# 2) root kontrolü
if [ "$(id -u)" -ne 0 ]; then
  echo "hata: root olarak çalıştır →  sudo bash install.sh ${DOMAIN}" >&2
  exit 1
fi

# 3) indir + doğrula + kur
echo "→ ${BIN} indiriliyor (${VERSION})…"
fetch "${BASE}/${BIN}" "/tmp/${BIN}"
fetch "${BASE}/SHA256SUMS" /tmp/panomim-SHA256SUMS
(cd /tmp && grep " ${BIN}$" /tmp/panomim-SHA256SUMS | sha256sum -c -)
install -Dm755 "/tmp/${BIN}" /usr/local/bin/panomim
rm -f "/tmp/${BIN}" /tmp/panomim-SHA256SUMS

# 4) kullanıcı + veri dizini
id panomim >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin panomim
install -d -o panomim -g panomim /var/lib/panomim

# 5) yapılandırma
install -d /etc/panomim
if [ -n "$DOMAIN" ]; then
  cat > /etc/panomim/env <<EOF
PANOMIM_ADDR=:443
PANOMIM_DATA=/var/lib/panomim
PANOMIM_HTTP=false
PANOMIM_HTTPS_DOMAIN=${DOMAIN}
EOF
  URL="https://${DOMAIN}"
else
  cat > /etc/panomim/env <<EOF
PANOMIM_ADDR=:8443
PANOMIM_DATA=/var/lib/panomim
PANOMIM_HTTP=false
EOF
  URL="https://<sunucu-ip>:8443 (self-signed)"
fi
chmod 600 /etc/panomim/env

# 6) systemd servisi
cat > /etc/systemd/system/panomim.service <<'EOF'
[Unit]
Description=Panomim
After=network-online.target
Wants=network-online.target

[Service]
User=panomim
Group=panomim
EnvironmentFile=/etc/panomim/env
ExecStart=/usr/local/bin/panomim
Restart=always
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

# 7) başlat / güncelle (restart: kuruluysa yeniden başlatır, değilse başlatır)
systemctl daemon-reload
systemctl enable panomim
systemctl restart panomim

echo
echo "✓ panomim kuruldu / güncellendi → ${URL}"
echo "  durum: systemctl status panomim"
echo "  log:   journalctl -u panomim -f"
