# Frontend E2E: auth -> boards -> list tree -> mindmap -> realtime basics.
import os, re, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8443")
USER = "u" + str(int(time.time()))[-7:]
FAILS = []

def check(name, cond, extra=""):
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name} {extra}")
    if not cond:
        FAILS.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROME", "/usr/bin/google-chrome"), headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 850})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    console_err = []
    page.on("console", lambda m: console_err.append(m.text) if m.type == "error" else None)

    # ---------- auth ----------
    page.goto(BASE)
    page.wait_for_selector(".auth-card", timeout=8000)
    check("auth card shown", page.locator(".auth-card").count() == 1)

    page.click("text=hesabın yok mu? kaydol")
    page.fill('input[placeholder="kullanıcı adı"]', USER)
    page.fill('input[placeholder="parola"] >> nth=0', "alicepass123")
    page.fill('input[placeholder="parola (tekrar)"]', "alicepass123")
    page.click("button:has-text('Hesap oluştur')")
    page.wait_for_selector(".sidebar", timeout=8000)
    check("app shell after register", True)
    check("empty board list note", page.locator(".board-empty").first.inner_text().find("henüz pano yok") >= 0)

    # ---------- create board ----------
    page.once("dialog", lambda d: d.accept("Ev İşleri"))
    page.click('button[title="yeni pano"]')
    page.wait_for_selector(".board-item.active", timeout=8000)
    check("board created & active", "Ev İşleri" in page.locator(".board-item.active").inner_text())
    check("board title in header", "Ev İşleri" in page.locator(".board-title").inner_text())

    # ---------- list view: add root + child ----------
    page.wait_for_selector(".empty-state")
    page.click("button:has-text('İlk görevi ekle')")
    page.wait_for_selector("input.tree-edit")
    page.fill("input.tree-edit", "Alışveriş")
    page.keyboard.press("Enter")
    page.wait_for_selector(".tree-row:has-text('Alışveriş')")
    check("root task added", True)

    page.hover(".tree-row >> nth=0")
    page.click('button[title="alt görev ekle"]')
    page.wait_for_selector("input.tree-edit")
    page.fill("input.tree-edit", "Süt al")
    page.keyboard.press("Enter")
    page.wait_for_selector(".tree-row:has-text('Süt al')")
    rows = page.locator(".tree-row").count()
    check("child task added", rows == 2, f"rows={rows}")
    kids = page.locator(".tree-kids .tree-row").count()
    check("child indented (.tree-kids)", kids == 1)

    # toggle done on root
    page.click(".tree-row >> nth=0 >> button.check")
    page.wait_for_selector(".tree-row >> nth=0 >> button.check.done")
    check("done toggled", True)

    # ---------- mindmap view ----------
    page.click('button.tab:has-text("Zihin Haritası")')
    page.wait_for_selector(".mindmap-view.active", timeout=5000)
    time.sleep(0.6)
    notes = page.locator(".note").count()
    check("notes rendered", notes == 2, f"notes={notes}")
    edges = page.locator(".mm-edges path").count()
    check("edge paths (parent->child, 2 halves)", edges == 2, f"paths={edges}")

    # edit mode + drag
    page.click("#mm-edit-toggle")
    time.sleep(0.2)
    canvas_cls = page.locator(".mm-canvas").get_attribute("class")
    check("edit mode on", "edit" in canvas_cls)
    note = page.locator(".note").first
    bb = note.bounding_box()
    cx, cy = bb["x"] + bb["width"] / 2, bb["y"] + 12
    drag_id = page.evaluate(f"document.elementFromPoint({cx}, {cy}).closest('.note').dataset.id")
    sel = f".note[data-id='{drag_id}']"
    before = page.eval_on_selector(sel, "e => e.getAttribute('style')")
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 90, cy + 60, steps=10)
    page.mouse.up()
    page.wait_for_timeout(600)
    after = page.eval_on_selector(sel, "e => e.getAttribute('style')")
    check("note dragged (style changed)", before != after, f"\n  before={before}\n  after={after}")

    # add a note via toolbar
    page.click("#mm-add")
    time.sleep(0.5)
    notes2 = page.locator(".note").count()
    check("toolbar +Not adds note", notes2 == 3, f"notes={notes2}")

    # zoom label updates on wheel
    page.mouse.move(700, 400)
    page.mouse.wheel(0, -240)
    time.sleep(0.4)
    zl = page.locator("#mm-zoom-label").inner_text()
    check("zoom label updates", zl != "100%", f"zoom={zl}")

    # ---------- theme ----------
    page.click(".sidebar-head .icon-btn")
    theme = page.evaluate("document.documentElement.getAttribute('data-theme')")
    check("theme toggled", theme == "dark", f"theme={theme}")
    page.click(".sidebar-head .icon-btn")
    theme = page.evaluate("document.documentElement.getAttribute('data-theme')")
    check("theme back to light", theme == "light")

    # ---------- reload: session + last board persist ----------
    page.reload()
    page.wait_for_selector(".sidebar", timeout=8000)
    check("session survives reload (refresh cookie)", True)
    page.wait_for_selector(".board-item.active", timeout=8000)
    check("last board re-opened", "Ev İşleri" in page.locator(".board-item.active").inner_text())
    # prefs.tab was mindmap when we left? we toggled theme only; tab stayed mindmap
    time.sleep(0.6)
    mm_active = page.evaluate("document.querySelector('.view.mindmap-view').classList.contains('active')")
    check("tab pref restored (mindmap)", mm_active)

    # ---------- errors ----------
    check("no page errors", not errors, "; ".join(errors[:3]))
    real_console = [e for e in console_err if "401" not in e and "favicon" not in e.lower()]
    check("no console errors", not real_console, "; ".join(real_console[:3]))

    browser.close()

print()
if FAILS:
    print("FAILED:", len(FAILS), FAILS)
    sys.exit(1)
print("ALL FRONTEND TESTS PASSED")
