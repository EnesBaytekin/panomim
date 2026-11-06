# Todoer Kurulum ve Dağıtım Rehberi

Todoer tek bir ikili dosyadan (veya tek konteynerden) çalışır; veritabanı, dosyalar ve
sertifikalar tek bir veri dizininde tutulur. Aşağıdaki adımlar sıfırdan bir sunucuya
kurulum için yeterlidir.

---

## 1. Yapılandırma (ortam değişkenleri)

Tüm ayarlar `TODOER_*` ortam değişkenlerinden okunur; aynı seçenek komut satırı
bayrağıyla da verilebilir (bayrak her zaman önceliklidir):

| Değişken              | Bayrak          | Varsayılan              | Açıklama |
|-----------------------|-----------------|-------------------------|----------|
| `TODOER_ADDR`         | `-addr`         | `:8443`                 | Dinleme adresi |
| `TODOER_DATA`         | `-data`         | `~/.local/share/todoer` | Veri dizini (db, sertifika, yüklenen dosyalar) |
| `TODOER_HTTP`         | `-http`         | `false`                 | Düz HTTP (yalnızca ters proxy arkası / geliştirme) |
| `TODOER_HTTPS_DOMAIN` | `-https-domain` | —                       | Let's Encrypt otomatik sertifika (80+443 açık olmalı) |
| `TODOER_CERT`         | `-cert`         | —                       | Kendi sertifikanız (PEM) |
| `TODOER_KEY`          | `-key`          | —                       | Sertifika anahtarı (PEM) |
| `TODOER_DEV`          | `-dev`          | `false`                 | Frontend'i diskten sun (geliştirme) |
| `TODOER_DEV_DIR`      | `-dev-dir`      | `web/static`            | `-dev` için statik dizin |
| `TODOER_ACCESS_TTL`   | —               | `15m`                   | Erişim token'ı ömrü |
| `TODOER_REFRESH_TTL`  | —               | `360h`                  | Oturum (refresh) ömrü |

Hazır şablon: [`.env.example`](.env.example) → `cp .env.example .env` yapıp düzenleyin.

> **Kural:** `TODOER_HTTP=false` (varsayılan) ise uygulama TLS ile çalışır:
> - `TODOER_HTTPS_DOMAIN` verildiyse Let's Encrypt kullanılır,
> - `TODOER_CERT` + `TODOER_KEY` verildiyse sizin sertifikanız kullanılır,
> - hiçbiri verilmediyse **otomatik self-signed sertifika** üretilir (tarayıcı bir
>   kez güven uyarısı gösterir; LAN/ev sunucusu için uygundur).

---

## 2. Docker ile kurulum (önerilen)

Gereksinim: Docker + Docker Compose v2.

```bash
git clone <repo-url> todoer && cd todoer
cp .env.example .env            # gerekirse düzenleyin
docker compose up -d --build
```

- Varsayılan: `http://<sunucu>:8443` (ters proxy arkası senaryosu, `TODOER_HTTP=true`).
- Doğrudan HTTPS istiyorsanız `.env` içinde:
  ```bash
  TODOER_HTTP=false
  # LAN / IP erişimi için (self-signed otomatik üretilir):
  # ekstra bir şey gerekmez
  # Alan adınız varsa:
  # TODOER_HTTPS_DOMAIN=todo.example.com   → 80 ve 443(8443 değil) açık olmalı
  ```
  ve `ports` bölümünde `443:8443` + `80:80` eşlemesi ekleyin (Let's Encrypt için).
- Veriler `todoer-data` isimli volume'da tutulur; yedeklemek için:
  ```bash
  docker run --rm -v todoer_todoer-data:/data -v $PWD:/yedek alpine tar czf /yedek/todoer-yedek.tar.gz /data
  ```

---

## 3. İkili dosya (binary) ile kurulum

Gereksinim: Go 1.26+ (CGO gerekmez).

```bash
git clone <repo-url> todoer && cd todoer
CGO_ENABLED=0 go build -o todoer ./cmd/todoer

# çalıştırma (HTTPS, otomatik self-signed sertifika):
./todoer
# → https://localhost:8443

# özel dizin + adres:
TODOER_DATA=/var/lib/todoer TODOER_ADDR=:443 ./todoer
```

### systemd servisi

`/etc/systemd/system/todoer.service`:

```ini
[Unit]
Description=Todoer todo uygulaması
After=network-online.target
Wants=network-online.target

[Service]
User=todoer
EnvironmentFile=/etc/todoer/env
ExecStart=/usr/local/bin/todoer
Restart=always
RestartSec=3
# Sertifikaları okuyabilmesi için (kendi sertifikanız varsa):
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

`/etc/todoer/env` (chmod 600):

```bash
TODOER_ADDR=:443
TODOER_DATA=/var/lib/todoer
TODOER_HTTP=false
# TODOER_HTTPS_DOMAIN=todo.example.com
```

```bash
sudo useradd -r -s /usr/sbin/nologin todoer
sudo mkdir -p /var/lib/todoer && sudo chown todoer /var/lib/todoer
sudo systemctl daemon-reload && sudo systemctl enable --now todoer
```

---

## 4. HTTPS senaryoları

| Senaryo | Yapılacak |
|---|---|
| **Ters proxy arkası** (Caddy, nginx, Traefik...) | `TODOER_HTTP=true`, TLS'i proxy sonlandırır. Proxy'nin WebSocket'i desteklemesi yeterli (upgrade header'ları). |
| **Alan adı + Let's Encrypt** | `TODOER_HTTP=false`, `TODOER_HTTPS_DOMAIN=alan.com`; 80 (ACME) ve 443 portlarını açın. |
| **Kendi sertifikanız** | `TODOER_HTTP=false`, `TODOER_CERT=/yol/fullchain.pem`, `TODOER_KEY=/yol/privkey.pem`. |
| **LAN / IP erişimi** | Hiçbir şey yapmayın: ilk çalıştırmada self-signed sertifika otomatik üretilir. |

---

## 5. Sık sorulanlar

**Verilerim nerede?** `TODOER_DATA` dizininde: `todoer.db` (her şey), `uploads/`
(görseller), `certs/` (sertifikalar). Yedek = bu dizini kopyalamak.

**Şifremi unuttum.** Kayıt ekranından aynı kullanıcı adıyla yeni hesap açabilirsiniz;
eski pano verilerine erişim gerekiyorsa db'yi düzenlemek gerekir (şifreler bcrypt
hash'iyle saklanır, geri okunamaz).

**Bağlantı kopunca ne olur?** Uygulama WebSocket bağlantısını otomatik yeniler;
çevrimdışıyken yapılan değişiklikler sonraki açılışta sunucudan tazelenir.

**Güncelleme:** yeni sürümü derleyin/konteyneri yeniden kurun — veritabanı şeması
otomatik göç ettirilir (`docker compose up -d --build`).
