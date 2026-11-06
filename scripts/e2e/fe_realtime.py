# F13: realtime multi-user E2E.
# A (owner) shares board with B (editor) via the UI share dialog;
# C (viewer) is shared via API. Verifies: share modal, shared board in
# B's sidebar, live op propagation both ways, presence avatars,
# remote selection hint, presence leave, viewer restrictions.
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8443")
TS = str(int(time.time()))[-7:]
USER_A, USER_B, USER_C = "ra" + TS, "rb" + TS, "rc" + TS
PASS = "paylass123"
BOARD = "Ortak Pano"
FAILS = []

def check(name, cond, extra=""):
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name} {extra}")
    if not cond:
        FAILS.append(name)

def api(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + token} if token else {})})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def register(page, user):
    page.goto(BASE)
    page.wait_for_selector(".auth-card", timeout=8000)
    page.click("text=hesabın yok mu? kaydol")
    page.fill('input[placeholder="kullanıcı adı"]', user)
    page.fill('input[placeholder="parola"] >> nth=0', PASS)
    page.fill('input[placeholder="parola (tekrar)"]', PASS)
    page.click("button:has-text('Hesap oluştur')")
    page.wait_for_selector(".sidebar", timeout=8000)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROME", "/usr/bin/google-chrome"), headless=True)

    errs_a, errs_b, errs_c = [], [], []
    con_a = browser.new_context(viewport={"width": 1280, "height": 850})
    con_b = browser.new_context(viewport={"width": 1280, "height": 850})
    page_a = con_a.new_page(); page_a.on("pageerror", lambda e: errs_a.append(str(e)))
    page_b = con_b.new_page(); page_b.on("pageerror", lambda e: errs_b.append(str(e)))

    # ---------- A: register, create board, first node ----------
    register(page_a, USER_A)
    page_a.once("dialog", lambda d: d.accept(BOARD))
    page_a.click('button[title="yeni pano"]')
    page_a.wait_for_selector(".board-item.active", timeout=8000)
    page_a.wait_for_selector(".empty-state", timeout=8000)
    page_a.click("button:has-text('İlk görevi ekle')")
    page_a.fill("input.tree-edit", "Samanlık")
    page_a.keyboard.press("Enter")
    page_a.wait_for_selector(".tree-row:has-text('Samanlık')")
    check("A: board + first node ready", True)

    # ---------- B: register (no boards yet) ----------
    register(page_b, USER_B)
    check("B: registered, empty shell", page_b.locator(".board-item").count() == 0)

    # ---------- A: share via UI dialog ----------
    page_a.click('button[title="pano menüsü"]')
    page_a.click("button.menu-item:has-text('Paylaş')")
    page_a.wait_for_selector(".modal.wide", timeout=5000)
    page_a.fill('.share-add input[placeholder="kullanıcı adı"]', USER_B)
    page_a.select_option(".share-add select", "editor")
    page_a.click(".share-add button:has-text('Ekle')")
    page_a.wait_for_selector(f".share-row:has-text('{USER_B}')", timeout=6000)
    check("A: share dialog lists B", USER_B in page_a.locator(f".share-row:has-text('{USER_B}')").inner_text())
    check("A: owner row has 'sahip' chip", page_a.locator(".share-row:has-text('sahip')").count() == 1)
    page_a.click(".modal-actions button:has-text('Kapat')")
    page_a.wait_for_selector(".board-item.active .share-badge", timeout=6000)
    check("A: sidebar share badge 👥1", "1" in page_a.locator(".board-item.active .share-badge").inner_text())

    # ---------- B: sees shared board, opens it ----------
    page_b.reload()
    page_b.wait_for_selector(".board-item:has-text('Ortak Pano')", timeout=8000)
    check("B: shared board in sidebar", True)
    page_b.click(".board-item:has-text('Ortak Pano')")
    page_b.wait_for_selector(".tree-row:has-text('Samanlık')", timeout=8000)
    check("B: sees A's node after open", True)
    check("B: editor role chip", "düzenleyici" in page_b.locator(".board-title").inner_text())

    # ---------- presence: both see 2 avatars ----------
    page_a.wait_for_function(
        "document.querySelectorAll('.presence-bar .presence-avatar').length === 2", timeout=9000)
    page_b.wait_for_function(
        "document.querySelectorAll('.presence-bar .presence-avatar').length === 2", timeout=9000)
    check("presence: 2 avatars on both sides", True)

    # ---------- live op: A creates → B receives ----------
    page_a.click(".tree-add-root")
    page_a.fill("input.tree-edit", "A kökü yeni")
    page_a.keyboard.press("Enter")
    page_b.wait_for_selector(".tree-row:has-text('A kökü yeni')", timeout=8000)
    check("live: A's new root appears in B", True)

    # ---------- live op: B creates → A receives ----------
    page_b.click(".tree-add-root")
    page_b.fill("input.tree-edit", "B kökü")
    page_b.keyboard.press("Enter")
    page_a.wait_for_selector(".tree-row:has-text('B kökü')", timeout=8000)
    check("live: B's new root appears in A", True)

    # ---------- live update: A renames → B sees ----------
    page_a.dblclick(".tree-row:has-text('Samanlık') .tree-title")
    page_a.wait_for_selector("input.tree-edit", timeout=5000)
    page_a.fill("input.tree-edit", "Samanlık yenilendi")
    page_a.keyboard.press("Enter")
    page_b.wait_for_selector(".tree-row:has-text('Samanlık yenilendi')", timeout=8000)
    check("live: rename propagates to B", True)

    # ---------- live update: A toggles done → B sees ----------
    page_a.click(".tree-row:has-text('A kökü yeni') button.check")
    page_b.wait_for_selector(".tree-row:has-text('A kökü yeni') button.check.done", timeout=8000)
    check("live: done toggle propagates to B", True)

    # ---------- remote selection: B selects → A sees hint ----------
    node_id = page_b.eval_on_selector(".tree-row:has-text('B kökü')", "e => e.dataset.id")
    page_b.click(".tree-row:has-text('B kökü') .tree-title")
    js = ("id => { const r = document.querySelector('.tree-row[data-id=\"' + id + '\"]');"
          " return !!r && (r.getAttribute('style') || '').includes('--sel-color'); }")
    page_a.wait_for_function(js, arg=node_id, timeout=8000)
    check("live: remote selection hint in A", True)

    # ---------- A switches to mindmap: 3 notes render ----------
    page_a.click('button.tab:has-text("Zihin Haritası")')
    page_a.wait_for_selector(".mindmap-view.active", timeout=5000)
    page_a.wait_for_function("document.querySelectorAll('.note').length === 3", timeout=6000)
    check("A: mindmap shows all 3 synced nodes", True)

    # ---------- presence leave: B closes → A back to 1 ----------
    page_b.close(); con_b.close()
    page_a.wait_for_function(
        "document.querySelectorAll('.presence-bar .presence-avatar').length === 1", timeout=9000)
    check("presence: leave updates A to 1 avatar", True)

    # ---------- viewer C: shared via API, restricted UI ----------
    api("POST", "/api/auth/register", body={"username": USER_C, "password": PASS})
    tok = api("POST", "/api/auth/login", body={"username": USER_A, "password": PASS})["accessToken"]
    boards = api("GET", "/api/boards", token=tok)
    bid = next(b["id"] for b in boards if b["name"] == BOARD)
    api("POST", f"/api/boards/{bid}/share", token=tok, body={"username": USER_C, "role": "viewer"})
    con_c = browser.new_context(viewport={"width": 1280, "height": 850})
    page_c = con_c.new_page(); page_c.on("pageerror", lambda e: errs_c.append(str(e)))
    page_c.goto(BASE)
    page_c.wait_for_selector(".auth-card", timeout=8000)
    page_c.fill('input[placeholder="kullanıcı adı"]', USER_C)
    page_c.fill('input[placeholder="parola"] >> nth=0', PASS)
    page_c.click("button:has-text('Giriş yap')")
    page_c.wait_for_selector(".sidebar", timeout=8000)
    page_c.wait_for_selector(".board-item:has-text('Ortak Pano')", timeout=8000)
    page_c.click(".board-item:has-text('Ortak Pano')")
    page_c.wait_for_selector(".tree-row:has-text('Samanlık yenilendi')", timeout=8000)
    check("C: viewer sees board content", True)
    check("C: viewer role chip", "görüntüleyici" in page_c.locator(".board-title").inner_text())
    check("C: no 'add root' button for viewer", page_c.locator(".tree-add-root").count() == 0)
    hidden = page_c.evaluate(
        "document.getElementById('mm-edit-toggle').style.display === 'none'")
    check("C: edit-mode button hidden for viewer", hidden)

    # ---------- errors ----------
    check("no page errors (A)", not errs_a, "; ".join(errs_a[:3]))
    check("no page errors (B)", not errs_b, "; ".join(errs_b[:3]))
    check("no page errors (C)", not errs_c, "; ".join(errs_c[:3]))

    browser.close()

print()
if FAILS:
    print("FAILED:", len(FAILS), FAILS)
    sys.exit(1)
print("ALL REALTIME TESTS PASSED")
