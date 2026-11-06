# Panomim — İyileştirme Planı (feat/improvements)

> Branch: `feat/improvements`. Ana geliştirme main'de DEĞİL; her faz bittikçe test edilip main'e PR ile alınır.
> Her faz: kod → derle (`go build ./...`) → test (`go vet ./... && go test ./...`) → geçmeden sonraki faza geçilmez.

## Faz 0 — Altyapı (TAMAM ✅)
- [x] Sürümlü migration sistemi (ALTER TABLE + backfill desteği) — commit `4bd951f`
- [x] `feat/improvements` branch açıldı

## Faz 1 — Not kağıdı görünümü (mindmap) ✅
- [x] 1.1 Başlık tam genişlikte word-wrap; butonlar üstte overlay (float), tüm yüksekliği kaplamaz, başlığı sıkıştırmaz
- [x] 1.2 Not boyutu içerikle otomatik büyür; en küçük boyut içeriği kapsar (içerikten küçük kalınamaz)
- [x] 1.3 Varsayılan not şekli = kare (yazı rahat sığacak boyut)
- [x] 1.4 "+" butonu alan ekle/düzenle panelini açsın; alan-ekle butonunun simgesi "+" olsun; "alt not ekle" 3-nokta menüsüne taşınsın (farklı simge)
- [x] 1.5 Alanlar ekleme sırasına göre tek listede (text/image/date/… karışık), sürükle-bırak ile sıralama; hepsi tek not içinde

## Faz 2 — Mobil düzeltmeler ✅
- [x] 2.1 Mobilde "not ekle" → alan/textarea + klavye açılmıyor → düzelt (senkron focus; mindmap'te eklenen not otomatik başlık düzenlemeye geçer)
- [x] 2.2 Profil → "çıkış yap" ikonu mobil hamburger menüde görünmüyor → düzelt (⏻ → 🚪)

## Faz 3 — Profil görseli + aktif kullanıcılar ✅
- [x] 3.1 Profil resmine tıkla → sayfa içi büyük popup + "düzenle" (resim seç)
- [x] 3.2 Aktif kullanıcılar (sağ üst avatarlar) → mini açılır panel; avatar → büyük görüntü (sadece izleme)

## Faz 4 — Arkadaş sistemi (backend + frontend)
- [ ] 4.1 DB: `friends` + `friend_requests` (migration v8)
- [ ] 4.2 API: istek gönder, istek listele, kabul/reddet, arkadaş listesi, ortak panolar
- [ ] 4.3 Frontend: profil → arkadaşlar → kullanıcı adıyla ekle → istek/onay → arkadaş listesi → arkadaş seç → ortak panolar → "pano paylaş" → pano seç → paylaş (arkadaş otomatik seçili, rol ayarla) → geri
- [ ] 4.4 Modal/overlay panel yapısı (arka karartma, focus, dışına tıklayınca kapan)

## Faz 5 — i18n (TR/EN)
- [ ] 5.1 Dil altyapısı (sözlük + dil state)
- [ ] 5.2 Tüm metinleri TR/EN çevir
- [ ] 5.3 Dil + tema seçici login ekranında (giriş öncesi)

## Bitiş
- [ ] Tüm fazlar commit + push (yalnızca EnesBaytekin adına, atıf yok)
- [ ] Release (v1.1.0) + kullanıcıya güncelleme talimatı
