# Panomim 🧷

Ağaç (tree) ve zihin haritası (mindmap) görünümlü, gerçek zamanlı işbirlikçi bir yapılacaklar uygulaması. Go ile yazılmış **tek binary**; frontend gömülü, veritabanı (SQLite) dosyada, harici bağımlılık yok.

> Sıcak krem tonlu “mantar pano + yapışkan not” estetiği; koyu çikolata dark tema; yumuşak pastel not renkleri.

## Özellikler

- **İki görünüm, aynı veri:** VSCode tarzı girintili liste (aç/kapa, + kök, + alt görev, inline düzenleme) ve sürüklenebilir notlarla mindmap (merkezden merkeze yumuşak eğriler, pan/zoom, düzenleme/görüntüleme modu)
- **Çoklu pano:** sol kenar çubuğunda kendi panolarınız + sizinle paylaşılanlar
- **Paylaşım:** pano başına *görüntüleyici* / *düzenleyici* rolleri (owner her zaman tam yetkili)
- **Gerçek zamanlı:** WebSocket ile canlı op yayını, çevrim içi kullanıcı baloncukları (presence), uzak seçim vurgusu; bağlantı kopunca otomatik yeniden bağlanma + resync
- **Not alanları:** metin, tarih, saat, tarih-saat, bağlantı, görsel (yüklenenler DB'de saklanır)
- **Kalıcılık:** pan/zoom konumu, aktif sekmeler, kapanan dal durumları ve son pano kullanıcı başına saklanır
- **Oturum:** 15 dakikalık access token (bellekte) + 15 günlük kayan refresh cookie; aynı cihazda aktif olduğunuz sürece parola sorulmaz
- **Temalar:** açık/koyu, sistem tercihi algılanır; mobilde hamburger menü (≤900px)

## Hızlı Başlangıç

### Tek binary

```bash
go build -o panomim ./cmd/panomim
./panomim
```

→ `https://localhost:8443` (otomatik üretilmiş self-signed sertifika ile). İlk açılışta **kaydol** ile hesap oluşturun — uygulama admin'sizdir, ilk kullanıcıyı siz yaratırsınız.

Veriler `~/.local/share/panomim` altında tutulur (`panomim.db`, sertifikalar).

### Docker

```bash
cp .env.example .env   # opsiyonel: ayarları .env ile verin
docker compose up --build
```

→ `http://localhost:8443` (compose varsayılanı ters proxy arkası için düz HTTP'dir;
`.env` içinde `PANOMIM_HTTP=false` yaparak doğrudan TLS'e geçebilirsiniz).

> 📦 **Sunucuya dağıtım** (Docker / binary / systemd, HTTPS senaryoları, `.env`,
> yedekleme) için ayrıntılı rehber: **[KURULUM.md](KURULUM.md)**

## Çalıştırma Modları

| Mod | Komut | Ne yapar |
|---|---|---|
| Varsayılan | `./panomim` | HTTPS, otomatik self-signed sertifika |
| Açık HTTP | `./panomim -http` | TLS'siz — geliştirme / ters proxy arkası |
| Kendi sertifikası | `./panomim -cert cert.pem -key key.pem` | Verilen PEM çiftiyle TLS |
| Let's Encrypt | `./panomim -https-domain example.com` | autocert; ACME için 80 portu da açılmalı |

### Bayraklar ve Ortam Değişkenleri

Her bayrağın `PANOMIM_*` ortam değişkeni karşılığı vardır (örn. `-addr` ↔ `PANOMIM_ADDR`);
ikisi birden verilirse bayrak kazanır. Tam liste için bkz. [KURULUM.md](KURULUM.md).

| Bayrak | Varsayılan | Açıklama |
|---|---|---|
| `-addr` | `:8443` | dinleme adresi |
| `-data` | `~/.local/share/panomim` | veri dizini (SQLite, sertifika, autocert önbelleği) |
| `-http` | `false` | düz HTTP (yalnızca geliştirme) |
| `-cert` / `-key` | boş | TLS PEM ikilisi; ikisi de verilmezse self-signed üretilir |
| `-https-domain` | boş | verilirse Let's Encrypt autocert etkinleşir |
| `-dev` | `false` | gömülü yerine diskten statik servis et (canlı frontend geliştirme) |
| `-dev-dir` | `web/static` | `-dev` ile kullanılacak dizin |

Geliştirme akışı (frontend değişiklikleri rebuild gerektirmez):

```bash
./panomim -http -dev -addr 127.0.0.1:8443
```

## Testler

```bash
go test ./...                      # birim testleri (auth, db, nodes, realtime)
scripts/smoke.sh [base-url]        # uçtan uca API smoke testi
scripts/e2e/                       # Playwright tarayıcı testleri (bkz. scripts/e2e/README.md)
```

## Mimari

```
cmd/panomim        entrypoint: TLS/autocert, graceful shutdown
internal/
  auth            argon2id parolalar, JWT access, refresh rotasyonu + reuse tespiti, rate limit
  boards          pano CRUD, üyelik ve roller
  nodes           ağaç düğümleri, alanlar, dosya yükleme, döngü koruması
  realtime        WebSocket hub: presence + op broadcast
  prefs           kullanıcı/pano tercihleri (pan, zoom, sekme, collapsed)
  server          router, güvenlik başlıkları (CSP, HSTS…), embed
web/static        frontend — framework'süz ES modülleri + el yapımı CSS
```

Seçimlerin özeti: `modernc.org/sqlite` (CGO'suz SQLite), `golang-jwt/v5`, `coder/websocket`, `golang.org/x/crypto/argon2`. Frontend derleme adımı olmadan `go:embed` ile binary'ye gömülür.

## Güvenlik Notları

- Parolalar **argon2id** (64 MB bellek, OWASP parametreleri) ile saklanır
- Refresh token: HttpOnly + Secure + SameSite=Strict cookie; DB'de yalnız sha256 özeti; **rotasyon + aile iptali** (eski token tekrar kullanılırsa oturum çalınmış sayılır ve aile tamamen iptal edilir)
- Access token yalnızca bellekte tutulur (XSS'e karşı localStorage kullanılmaz)
- WS bağlantısı 30 sn'lik tek kullanımlık ticket ile açılır (URL'de kalıcı token sızması olmaz)
- CSP `script-src 'self'`, HSTS, `X-Frame-Options: DENY`, `nosniff`

## API Kısa Başvuru

```
POST   /api/auth/register | login | refresh | logout
GET    /api/me                       PUT /api/me/last-board
GET|POST /api/boards                 GET|PATCH|DELETE /api/boards/{id}
POST   /api/boards/{id}/share        DELETE /api/boards/{id}/members/{uid}
GET|POST /api/boards/{id}/nodes      PATCH|DELETE /api/nodes/{id}   (?withChildren=1)
POST   /api/nodes/{id}/fields        PATCH|DELETE /api/fields/{id}
POST   /api/files                    GET /api/files/{id}
GET|PUT /api/boards/{id}/prefs       GET /api/ws/ticket   WS /api/ws?board_id=&ticket=
```

Tüm mutasyonlar `X-Client-Id` taşır; aynı panoya bağlı diğer istemciler ops'ı WebSocket'ten anında alır.
