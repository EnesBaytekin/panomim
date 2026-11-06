# Uçtan Uca (E2E) Testler

Tarayıcı tabanlı Playwright testleri. Sunucunun `http` modda çalışıyor olması gerekir:

```bash
go build -o /tmp/todoer ./cmd/todoer
/tmp/todoer -http -addr 127.0.0.1:8443 -data /tmp/todoer-test-data &
```

## Kurulum

```bash
python3 -m venv /tmp/venv
/tmp/venv/bin/pip install playwright
# Chrome/Chromium yolu: CHROME ortam değişkeniyle verilir (varsayılan /usr/bin/google-chrome)
```

## Çalıştırma

```bash
BASE=http://127.0.0.1:8443 CHROME=/usr/bin/google-chrome \
  /tmp/venv/bin/python scripts/e2e/fe_test.py      # tek kullanıcı: auth, tree, mindmap, tema, kalıcılık

BASE=http://127.0.0.1:8443 CHROME=/usr/bin/google-chrome \
  /tmp/venv/bin/python scripts/e2e/fe_realtime.py  # çok kullanıcı: paylaşım, canlı senkron, presence, roller
```

Notlar:
- Her çalıştırma benzersiz kullanıcı adları üretir; aynı veri dizisiyle tekrar çalıştırılabilir.
- Testler headless Chrome ister; `CHROME` değişkeni ile Chromium da kullanılabilir.
