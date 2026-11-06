# Panomim — Web Tabanlı Tree/Mindmap Todo Uygulaması

> Cozy, mantar pano + not kağıdı estetikli; Go backend + gömülü frontend, SQLite, realtime collaboration.

## Mimari Genel Bakış

```
panomim/
├── cmd/panomim/main.go          # entrypoint, TLS, graceful shutdown
├── internal/
│   ├── config/config.go        # flag/env ayarları
│   ├── db/db.go                # SQLite (modernc - pure Go, CGO yok), migrasyonlar
│   ├── auth/                   # argon2id, JWT access (15dk), refresh rotation (15g), middleware
│   ├── boards/                 # pano CRUD + paylaşım (viewer/editor)
│   ├── nodes/                  # tree CRUD, alanlar (fields), dosyalar
│   ├── realtime/               # WebSocket hub: presence + canlı op yayınları
│   ├── prefs/                  # kullanıcı başına pano/pan-zoom/görünüm tercihleri
│   └── server/server.go        # router, middleware zinciri, embed, güvenlik headerları
├── web/
│   ├── embed.go                # go:embed all:static
│   └── static/                 # index.html, css/app.css, js/* (framework yok, ES modules)
├── data/                       # çalışma zamanı: panomim.db, certs (git'e girmez)
├── Dockerfile / docker-compose.yml
├── scripts/smoke.sh            # uçtan uca API smoke testi
└── scripts/e2e/                # Playwright tarayıcı testleri (tek kullanıcı + realtime)
```

**Teknoloji seçimleri:**
- `modernc.org/sqlite` → CGO yok, tek binary hedefine uygun
- `chi` router, `golang-jwt/v5`, `coder/websocket`, `golang.org/x/crypto/argon2`
- Frontend: vanilla ES modules + el yapımı CSS (tema değişkenleri) → gömülü, offline, bağımlılıksız

## Veri Modeli (SQLite)

- `users(id, username UNIQUE, password_hash PHC/argon2id, created_at)`
- `refresh_tokens(id, user_id, token_hash sha256, family_id, device_id, expires_at, revoked_at, created_at)` → rotasyon + reuse-detection (family iptali)
- `boards(id, owner_id, name, created_at, updated_at)`
- `board_members(board_id, user_id, role: viewer|editor, PK(board_id,user_id))`
- `nodes(id, board_id, parent_id→nodes, title, position REAL (kardeş sırası),
   x REAL, y REAL, w REAL(0=auto), h REAL(0=auto), hue INT NULL(soft pastel), done INT, created_at, updated_at)`
  - birden fazla root: `parent_id IS NULL`
- `node_fields(id, node_id, type: text|date|time|datetime|link|image, value, position)`
- `files(id TEXT uuid, board_id, uploader_id, name, mime, size, data BLOB)` → görsel alanları için
- `user_board_prefs(user_id, board_id, prefs JSON {tab, panX, panY, zoom, collapsed[]}, updated_at)`
- `users.last_board_id` + `meta(key,value)` (JWT secret vb.)

## Kimlik Doğrulama Akışı (best practice)

1. `POST /api/auth/register` → argon2id (64MB, t=3, p=2 — OWASP uyumlu)
2. `POST /api/auth/login` → **access token** (JWT HS256, 15 dk, body'de; bellekte tutulur, localStorage'a yazılmaz) + **refresh token** (32B random, sha256 DB'de; `HttpOnly; Secure; SameSite=Strict` cookie, 15 gün)
3. `POST /api/auth/refresh` → her çağrıda refresh **rotate** edilir (yeni cookie). Süre kayan: her kullanımda +15 gün → aynı cihaz aktif olduğu sürece parola sorulmaz
4. Rotasyonda eski token tekrar kullanılırsa (reuse) → tüm `family` iptal edilir (token theft koruması)
5. Client: 401'de tek seferlik refresh + retry; proaktif timer (12 dk) ile sessiz yenileme
6. `POST /api/auth/logout` → o cihazın session'ı iptal
7. WS için URL'de token sızmasını önlemek amacıyla 30sn'lik tek kullanımlık **ticket** endpoint'i

## Gerçek Zamanlı (Google Docs hissi)

- `GET /api/ws/ticket` + `WS /api/ws?board_id&ticket`
- Hub: board başına client seti; presence (girip/çıkan kullanıcılar, avatar renkleri)
- Her REST mutasyonu `X-Client-Id` header'ı taşır → op tüm board client'larına broadcast, kendi tab'ı kendi op'unu yok sayar
- Seçim paylaşımı: bir not seçilince diğerlerinde renkli isimli kontur
- Viewer rolü mutasyon op'ları alamaz (sunucu zorunlu tutar)

## API Taslağı

```
POST   /api/auth/register | login | refresh | logout
GET    /api/me
GET    /api/boards                        (kendi + paylaşılan, rol bilgisiyle)
POST   /api/boards                        {name}
GET    /api/boards/{id}                   (üyeler + online durum)
PATCH  /api/boards/{id}                   {name}                    (owner)
DELETE /api/boards/{id}                                             (owner)
POST   /api/boards/{id}/share             {username, role}          (owner)
PATCH  /api/boards/{id}/members/{uid}     {role}                    (owner)
DELETE /api/boards/{id}/members/{uid}                               (owner)
GET    /api/boards/{id}/nodes             (tüm ağaç + alanlar)
POST   /api/boards/{id}/nodes             {parentId?, title?, x?, y?}
PATCH  /api/nodes/{id}                    {title,x,y,w,h,hue,done,position}
DELETE /api/nodes/{id}?withChildren=1     (çocuk varsa 409 → onay gerekir)
POST   /api/nodes/{id}/fields             PATCH/DELETE /api/fields/{id}
POST   /api/files (multipart)             GET /api/files/{id} (board üyeliği kontrollü)
GET/PUT /api/boards/{id}/prefs            (pan/zoom, tab, collapsed durumları)
```

## Uygulama Fazları (her faz: kod → derle → test → geç)

- [x] **F0** Proje kurulumu: go.mod, bağımlılıklar, iskelet → `go build` ✅
- [x] **F1** DB katmanı + migrasyonlar → migrasyon unit testi ✅
- [x] **F2** Auth: argon2id, JWT, refresh rotasyonu, rate limit, middleware → unit + curl testleri ✅
- [x] **F3** Panolar + paylaşım API → curl testleri (rol kontrolü dahil) ✅
- [x] **F4** Node/alan/dosya API'leri + döngü koruması → curl testleri ✅
- [x] **F5** Realtime hub + presence → Go WS client testi ✅
- [x] **F6** Tercihler (pan/zoom, son pano) ✅
- [x] **F7** Sunucu montajı: embed, güvenlik headerları, TLS (otomatik self-signed + autocert opsiyonu) → https smoke ✅
- [x] **F8** Frontend iskeleti: tema (dark/light), auth ekranları, responsive layout + hamburger ✅
- [x] **F9** Sidebar pano listesi (kendi + paylaşılan), pano yönetimi, paylaşım diyaloğu ✅
- [x] **F10** Liste görünümü: VSCode tarzı tree, aç/kapa, + root/+ child, inline edit ✅
- [x] **F11** Mindmap: corkboard, notlar (word-wrap, auto-height), SVG eğriler (parent→child incelip renk geçişi, notların arkasında), pan/zoom, edit/view modu ✅
- [x] **F12** Mindmap edit: sürükle-bırak reparent, sil (çocuk uyarısı), hue renk seçici, boyutlandırma, alan editörü ✅
- [x] **F13** Realtime client entegrasyonu + presence göstergeleri → iki tarayıcılı E2E (paylaşım, canlı op, presence, uzak seçim, viewer kısıtları) ✅
- [x] **F14** Docker + README + uçtan uca smoke test → Dockerfile (distroless), compose, README, smoke.sh + Playwright E2E geçti ✅

## Tasarım Dili (cozy)

- Sıcak krem/kâğıt tonları (light), koyu çikolata-kömür (dark); 6 renk soft-pastel not paleti (hue kaydırıcı)
- Mantar pano dokusu: CSS ile nokta/kumaş dokusu + notlarda hafif kağıt gölgesi, yuvarlak köşeler
- Sistem font yığını (offline); Yuuntuvarak yumuşak radius, subtle animasyonlar
- Responsive: ≥900px sabit sidebar; altında hamburger + drawer overlay

## Dağıtım

- `go build` → tek binary, frontend gömülü; varsayılan HTTPS (self-signed otomatik üretim), `-http` dev modu, `-https-domain` → Let's Encrypt autocert
- `docker compose up` (volume: `./data`)
- HSTS, CSP (`script-src 'self'`), X-Frame-Options, nosniff
