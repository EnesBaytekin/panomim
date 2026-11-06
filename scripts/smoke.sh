#!/usr/bin/env bash
# End-to-end API smoke test: register → login → boards → tree → sharing → prefs.
# Usage: scripts/smoke.sh [base-url]   (default http://127.0.0.1:8443)
set -euo pipefail
BASE="${1:-http://127.0.0.1:8443}"
J() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
FAIL() { echo "  ✗ $1"; exit 1; }
OK()   { echo "  ✓ $1"; }
TS=$(date +%s)

say()  { echo; echo "== $1 =="; }

say "auth: register two users"
R=$(curl -sf -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice-$TS\",\"password\":\"passw0rd123\"}") || FAIL "register alice"
A_TOKEN=$(echo "$R" | J "d['accessToken']")
[ -n "$A_TOKEN" ] || FAIL "alice token"
OK "alice registered"

R=$(curl -sf -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"bob-$TS\",\"password\":\"passw0rd123\"}")
B_TOKEN=$(echo "$R" | J "d['accessToken']")
OK "bob registered"

say "auth: duplicate + bad password rejected"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice-$TS\",\"password\":\"passw0rd123\"}")
[ "$CODE" = "409" ] || FAIL "duplicate register → $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice-$TS\",\"password\":\"wrong-pass\"}")
[ "$CODE" = "401" ] || FAIL "bad login → $CODE"
OK "409 ve 401 doğru"

say "auth: refresh rotation (cookie)"
R=$(curl -sf -c /tmp/cj_a -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"alice-$TS\",\"password\":\"passw0rd123\"}")
R=$(curl -sf -b /tmp/cj_a -c /tmp/cj_a -X POST "$BASE/api/auth/refresh")
R2_TOKEN=$(echo "$R" | J "d['accessToken']")
[ -n "$R2_TOKEN" ] || FAIL "refresh failed"
OK "refresh yeni access token verdi"

say "boards: create + list"
B=$(curl -sf -X POST "$BASE/api/boards" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"name":"İş Projeleri"}')
BID=$(echo "$B" | J "d['id']")
[ -n "$BID" ] || FAIL "board create"
LIST=$(curl -sf "$BASE/api/boards" -H "Authorization: Bearer $A_TOKEN")
COUNT=$(echo "$LIST" | J "len(d)")
[ "$COUNT" -ge 1 ] || FAIL "board list empty"
OK "pano #$BID oluşturuldu"

say "nodes: tree yapısı"
N1=$(curl -sf -X POST "$BASE/api/boards/$BID/nodes" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"title":"Root A","x":100,"y":50}')
N1ID=$(echo "$N1" | J "d['id']")
N2=$(curl -sf -X POST "$BASE/api/boards/$BID/nodes" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d "{\"title\":\"Child A1\",\"parentId\":$N1ID}")
N2ID=$(echo "$N2" | J "d['id']")
N3=$(curl -sf -X POST "$BASE/api/boards/$BID/nodes" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d "{\"title\":\"Grandchild\",\"parentId\":$N2ID}")
N3ID=$(echo "$N3" | J "d['id']")
TREE=$(curl -sf "$BASE/api/boards/$BID/nodes" -H "Authorization: Bearer $A_TOKEN")
NTOTAL=$(echo "$TREE" | J "len(d)")
[ "$NTOTAL" = "3" ] || FAIL "tree count → $NTOTAL"
PARENT=$(echo "$N2" | J "d['parentId']")
[ "$PARENT" = "$N1ID" ] || FAIL "parent link broken"
OK "3 düğümlük ağaç kuruldu (root→child→grandchild)"

say "nodes: cycle koruması"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/nodes/$N1ID" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d "{\"parentId\":$N3ID}")
[ "$CODE" = "400" ] || FAIL "cycle rejected → $CODE"
OK "kendi alt ağacına taşıma reddedildi"

say "nodes: update + done + hue"
U=$(curl -sf -X PATCH "$BASE/api/nodes/$N2ID" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"title":"Child A1 (düzenlendi)","done":true,"hue":35,"x":320,"y":140}')
DONE=$(echo "$U" | J "d['done']")
[ "$DONE" = "True" ] || FAIL "done flag"
OK "node güncellendi (title/done/hue/x/y)"

say "fields: tarih alanı ekle"
F=$(curl -sf -X POST "$BASE/api/nodes/$N1ID/fields" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"type":"date","value":"2026-12-24"}')
FID=$(echo "$F" | J "d['id']")
FTYPE=$(echo "$F" | J "d['type']")
[ "$FTYPE" = "date" ] || FAIL "field type"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/nodes/$N1ID/fields" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"type":"bogus","value":"x"}')
[ "$CODE" = "400" ] || FAIL "bad field type → $CODE"
OK "date alanı eklendi, geçersiz tip reddedildi"

say "delete: çocuk uyarısı (409) ve kademeli silme"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/nodes/$N1ID" -H "Authorization: Bearer $A_TOKEN")
[ "$CODE" = "409" ] || FAIL "delete w/ children → $CODE"
DEL=$(curl -sf -X DELETE "$BASE/api/nodes/$N1ID?withChildren=1" -H "Authorization: Bearer $A_TOKEN")
DN=$(echo "$DEL" | J "len(d['deleted'])")
[ "$DN" = "3" ] || FAIL "cascade → $DN"
OK "409 + 3 düğüm birlikte silindi"

say "sharing: bob viewer, sonra editor"
curl -sf -X POST "$BASE/api/boards/$BID/share" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d "{\"username\":\"bob-$TS\",\"role\":\"viewer\"}" > /dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/boards/$BID/nodes" -H "Authorization: Bearer $B_TOKEN" -H 'Content-Type: application/json' -d '{"title":"Bob was here"}')
[ "$CODE" = "403" ] || FAIL "viewer write → $CODE"
curl -sf -X POST "$BASE/api/boards/$BID/share" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d "{\"username\":\"bob-$TS\",\"role\":\"editor\"}" > /dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/boards/$BID/nodes" -H "Authorization: Bearer $B_TOKEN" -H 'Content-Type: application/json' -d '{"title":"Bob was here"}')
[ "$CODE" = "201" ] || FAIL "editor write → $CODE"
BLIST=$(curl -sf "$BASE/api/boards" -H "Authorization: Bearer $B_TOKEN")
SHARED=$(echo "$BLIST" | J "len([b for b in d if b['role']=='editor'])")
[ "$SHARED" -ge 1 ] || FAIL "shared board in bob's list"
OK "viewer 403 aldı, editor yazabildi, pano bob'un listesinde"

say "sharing: üye listesi sahibi içerir"
DETAIL=$(curl -sf "$BASE/api/boards/$BID" -H "Authorization: Bearer $A_TOKEN")
HAS_OWNER=$(echo "$DETAIL" | J "any(m['role']=='owner' for m in d['members'])")
[ "$HAS_OWNER" = "True" ] || FAIL "owner missing from members"
OK "board detail üye listesinde sahip (role=owner) var"

say "sharing: yabancı erişemez"
C_TOKEN=$(curl -sf -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d "{\"username\":\"eve-$TS\",\"password\":\"passw0rd123\"}" | J "d['accessToken']")
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/boards/$BID/nodes" -H "Authorization: Bearer $C_TOKEN")
[ "$CODE" = "403" ] || FAIL "stranger → $CODE"
OK "eve 403 aldı"

say "prefs: pan/zoom kaydı"
curl -sf -X PUT "$BASE/api/boards/$BID/prefs" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tab":"mindmap","panX":-120,"panY":40,"zoom":0.85,"collapsed":[1,2]}' > /dev/null
P=$(curl -sf "$BASE/api/boards/$BID/prefs" -H "Authorization: Bearer $A_TOKEN")
Z=$(echo "$P" | J "d['zoom']")
[ "$Z" = "0.85" ] || FAIL "prefs zoom → $Z"
OK "tercihler saklandı ve geri geldi"

say "last board"
curl -sf -X PUT "$BASE/api/me/last-board" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d "{\"boardId\":$BID}" > /dev/null
ME=$(curl -sf "$BASE/api/me" -H "Authorization: Bearer $A_TOKEN")
LB=$(echo "$ME" | J "d['lastBoardId']")
[ "$LB" = "$BID" ] || FAIL "last board → $LB"
OK "son pano hatırlandı"

say "logout: refresh token iptal olur"
curl -sf -b /tmp/cj_a -X POST "$BASE/api/auth/logout" > /dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cj_a -X POST "$BASE/api/auth/refresh")
[ "$CODE" = "401" ] || FAIL "logout then refresh → $CODE"
OK "logout sonrası refresh 401"

echo
echo "TÜM SMOKE TESTLERİ GEÇTİ ✓"
