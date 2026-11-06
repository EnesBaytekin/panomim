# Panomim Kurulum ve Dağıtım Rehberi

Panomim tek bir ikili dosyadan (veya tek konteynerden) çalışır; veritabanı, dosyalar ve
sertifikalar tek bir veri dizininde tutulur. Aşağıdaki adımlar sıfırdan bir sunucuya
kurulum için yeterlidir.

---

## 1. Yapılandırma (ortam değişkenleri)

Tüm ayarlar `PANOMIM_*` ortam değişkenlerinden okunur; aynı seçenek komut satırı
bayrağıyla da verilebilir (bayrak her zaman önceliklidir):

| Değişken              | Bayrak          | Varsayılan              | Açıklama |
|-----------------------|-----------------|-------------------------|----------|
| `PANOMIM_ADDR`         | `-addr`         | `:8443`                 | Dinleme adresi |
| `PANOMIM_DATA`         | `-data`         | `~/.local/share/panomim` | Veri dizini (db, sertifika, yüklenen dosyalar) |
| `PANOMIM_HTTP`         | `-http`         | `false`                 | Düz HTTP (yalnızca ters proxy arkası / geliştirme) |
| `PANOMIM_HTTPS_DOMAIN` | `-https-domain` | —                       | Let's Encrypt otomatik sertifika (80+443 açık olmalı) |
| `PANOMIM_CERT`         | `-cert`         | —                       | Kendi sertifikanız (PEM) |
| `PANOMIM_KEY`          | `-key`          | —                       | Sertifika anahtarı (PEM) |
| `PANOMIM_DEV`          | `-dev`          | `false`                 | Frontend'i diskten sun (geliştirme) |
| `PANOMIM_DEV_DIR`      | `-dev-dir`      | `web/static`            | `-dev` için statik dizin |
| `PANOMIM_ACCESS_TTL`   | —               | `15m`                   | Erişim token'ı ömrü |
| `PANOMIM_REFRESH_TTL`  | —               | `360h`                  | Oturum (refresh) ömrü |

Hazır şablon: [`.env.example`](.env.example) → `cp .env.example .env` yapıp düzenleyin.

> **Kural:** `PANOMIM_HTTP=false` (varsayılan) ise uygulama TLS ile çalışır:
> - `PANOMIM_HTTPS_DOMAIN` verildiyse Let's Encrypt kullanılır,
> - `PANOMIM_CERT` + `PANOMIM_KEY` verildiyse sizin sertifikanız kullanılır,
> - hiçbiri verilmediyse **otomatik self-signed sertifika** üretilir (tarayıcı bir
>   kez güven uyarısı gösterir; LAN/ev sunucusu için uygundur).

---

## 2. Docker ile kurulum (önerilen)

Gereksinim: Docker + Docker Compose v2.

`docker-compose.yml` hazır imajı (`panomim:latest`) çalıştırır; derleme için
`./build.sh` kullanılır. Böylece imaj bir makinede derlenip kaynak kod
olmadan başka makinelere taşınabilir.

```bash
git clone <repo-url> panomim && cd panomim     # ya da kaynak kodlu herhangi bir kopya
cp .env.example .env                          # gerekirse düzenleyin
./build.sh                                    # panomim:latest imajını derler
docker compose up -d                          # hazır imajı çalıştırır
```

Image adını değiştirmek için: `IMAGE=benim/panomim ./build.sh` ve `.env` dosyasına
`PANOMIM_IMAGE=benim/panomim:latest` yazın.

**Kod olmadan başka makineye kurulum:**

```bash
# imajı olan makinede:
docker save panomim:latest | gzip > panomim-latest.tar.gz

# hedef makinede (kaynak kod gerekmez; docker-compose.yml + .env yeterli):
docker load < panomim-latest.tar.gz
docker compose up -d
```

- Varsayılan: `http://<sunucu>:8443` (ters proxy arkası senaryosu, `PANOMIM_HTTP=true`).
- Doğrudan HTTPS istiyorsanız `.env` içinde:
  ```bash
  PANOMIM_HTTP=false
  # LAN / IP erişimi için (self-signed otomatik üretilir):
  # ekstra bir şey gerekmez
  # Alan adınız varsa:
  # PANOMIM_HTTPS_DOMAIN=todo.example.com   → 80 ve 443(8443 değil) açık olmalı
  ```
  ve `ports` bölümünde `443:8443` + `80:80` eşlemesi ekleyin (Let's Encrypt için).
- Veriler `panomim-data` isimli volume'da tutulur; yedeklemek için:
  ```bash
  docker run --rm -v panomim_panomim-data:/data -v $PWD:/yedek alpine tar czf /yedek/panomim-yedek.tar.gz /data
  ```

---

## 3. İkili dosya (binary) ile kurulum

Gereksinim: Go 1.26+ (CGO gerekmez).

```bash
git clone <repo-url> panomim && cd panomim
CGO_ENABLED=0 go build -o panomim ./cmd/panomim

# çalıştırma (HTTPS, otomatik self-signed sertifika):
./panomim
# → https://localhost:8443

# özel dizin + adres:
PANOMIM_DATA=/var/lib/panomim PANOMIM_ADDR=:443 ./panomim
```

### systemd servisi

`/etc/systemd/system/panomim.service`:

```ini
[Unit]
Description=Panomim todo uygulaması
After=network-online.target
Wants=network-online.target

[Service]
User=panomim
EnvironmentFile=/etc/panomim/env
ExecStart=/usr/local/bin/panomim
Restart=always
RestartSec=3
# Sertifikaları okuyabilmesi için (kendi sertifikanız varsa):
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

`/etc/panomim/env` (chmod 600):

```bash
PANOMIM_ADDR=:443
PANOMIM_DATA=/var/lib/panomim
PANOMIM_HTTP=false
# PANOMIM_HTTPS_DOMAIN=todo.example.com
```

```bash
sudo useradd -r -s /usr/sbin/nologin panomim
sudo mkdir -p /var/lib/panomim && sudo chown panomim /var/lib/panomim
sudo systemctl daemon-reload && sudo systemctl enable --now panomim
```

---

## 4. HTTPS senaryoları

| Senaryo | Yapılacak |
|---|---|
| **Ters proxy arkası** (Caddy, nginx, Traefik...) | `PANOMIM_HTTP=true`, TLS'i proxy sonlandırır. Proxy'nin WebSocket'i desteklemesi yeterli (upgrade header'ları). |
| **Alan adı + Let's Encrypt** | `PANOMIM_HTTP=false`, `PANOMIM_HTTPS_DOMAIN=alan.com`; 80 (ACME) ve 443 portlarını açın. |
| **Kendi sertifikanız** | `PANOMIM_HTTP=false`, `PANOMIM_CERT=/yol/fullchain.pem`, `PANOMIM_KEY=/yol/privkey.pem`. |
| **LAN / IP erişimi** | Hiçbir şey yapmayın: ilk çalıştırmada self-signed sertifika otomatik üretilir. |

---

## 5. Sık sorulanlar

**Verilerim nerede?** `PANOMIM_DATA` dizininde: `panomim.db` (her şey), `uploads/`
(görseller), `certs/` (sertifikalar). Yedek = bu dizini kopyalamak.

**Şifremi unuttum.** Kayıt ekranından aynı kullanıcı adıyla yeni hesap açabilirsiniz;
eski pano verilerine erişim gerekiyorsa db'yi düzenlemek gerekir (şifreler bcrypt
hash'iyle saklanır, geri okunamaz).

**Bağlantı kopunca ne olur?** Uygulama WebSocket bağlantısını otomatik yeniler;
çevrimdışıyken yapılan değişiklikler sonraki açılışta sunucudan tazelenir.

**Güncelleme:** yeni sürümü derleyin/konteyneri yeniden kurun — veritabanı şeması
otomatik göç ettirilir (`./build.sh && docker compose up -d`).
