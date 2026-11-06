# Frontend E2E — batch-2 features:
#   auth screen polish (no tagline, centered), note content rules (no "null",
#   description as body, empty fields hidden), ⋯ menu (rename/color), done
#   toggle stability, edges following mid-drag, mindmap→list sync, list
#   drag&drop with persistent ordering, share dialog layout, touch gestures
#   (pinch zoom + grip drag).
import os, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8443")
USER = "f" + str(int(time.time()))[-7:]
FAILS = []
PASSW = "alicepass123"


def check(name, cond, extra=""):
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {name} {extra}")
    if not cond:
        FAILS.append(name)


def root_titles(page):
    return page.eval_on_selector_all(
        ".tree > .tree-row .tree-title", "els => els.map(e => e.textContent)")


def find_canvas_spot(page):
    return page.evaluate("""() => {
      for (let y = innerHeight - 50; y > 120; y -= 30)
        for (let x = 220; x < innerWidth - 60; x += 40) {
          const el = document.elementFromPoint(x, y);
          if (el && !el.closest('.note') && !el.closest('.popover')
              && !el.closest('.mm-toolbar')) return [x, y];
        }
      return [innerWidth - 60, innerHeight - 60];
    }""")


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROME", "/usr/bin/google-chrome"), headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 850})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    console_err = []
    page.on("console", lambda m: console_err.append(m.text) if m.type == "error" else None)

    # ---------- 1. auth screen polish ----------
    page.goto(BASE)
    page.wait_for_selector(".auth-card", timeout=8000)
    check("no 'sıcacık' tagline", "sıcacık" not in page.locator(".auth-page").inner_text())
    card = page.locator(".auth-card").bounding_box()
    vw = page.evaluate("innerWidth")
    off = abs((card["x"] + card["width"] / 2) - vw / 2)
    check("auth card centered", off < 25, f"off={off:.0f}px")

    # ---------- 2. register + board ----------
    page.click("text=hesabın yok mu? kaydol")
    page.fill('input[placeholder="kullanıcı adı"]', USER)
    page.fill('input[placeholder="parola"] >> nth=0', PASSW)
    page.fill('input[placeholder="parola (tekrar)"]', PASSW)
    page.click("button:has-text('Hesap oluştur')")
    page.wait_for_selector(".sidebar", timeout=8000)
    # yeni pano: tarayıcı prompt'u değil, sayfa içi modal
    page.click('button[title="yeni pano"]')
    page.wait_for_selector(".modal input.input", timeout=4000)
    page.fill(".modal input.input", "Batch2")
    page.click(".modal .btn.primary")
    page.wait_for_selector(".board-item.active", timeout=8000)

    # ---------- 3. list setup: root + child + 3 roots ----------
    page.wait_for_selector(".empty-state")
    page.click("button:has-text('İlk görevi ekle')")
    page.fill("input.tree-edit", "Market")
    page.keyboard.press("Enter")
    page.wait_for_selector(".tree-row:has-text('Market')")
    page.hover(".tree-row >> nth=0")
    page.click('button[title="alt görev ekle"]')
    page.fill("input.tree-edit", "Süt al")
    page.keyboard.press("Enter")
    page.wait_for_selector(".tree-row:has-text('Süt al')")
    for name in ("A Görevi", "B Görevi", "C Görevi"):
        page.click('button[title="Yeni köşe görev ekle"]')
        page.fill("input.tree-edit", name)
        page.keyboard.press("Enter")
        page.wait_for_selector(f".tree-row:has-text('{name}')")
    check("initial root order", root_titles(page) == ["Market", "A Görevi", "B Görevi", "C Görevi"], str(root_titles(page)))

    # ---------- 4. mindmap: note content rules + doodle accents ----------
    page.click('button.tab:has-text("Zihin Haritası")')
    page.wait_for_selector(".mindmap-view.active", timeout=5000)
    time.sleep(0.6)
    page.click("#mm-edit-toggle")
    time.sleep(0.3)
    note_texts = page.eval_on_selector_all(".note", "els => els.map(e => e.innerText)")
    check("no 'null' text on notes", not any("null" in t for t in note_texts), str(note_texts)[:120])
    mt = page.eval_on_selector(".note:has-text('Market') .note-title", "e => e.textContent")
    check("note main line = title", mt.strip() == "Market", mt)
    tape = page.eval_on_selector(".note", "e => getComputedStyle(e, '::before').content")
    check("washi tape accent", tape not in ("none", "normal"), tape)
    tilt = page.eval_on_selector(".note", "e => getComputedStyle(e).transform")
    check("playful tilt applied", tilt not in ("", "none"), tilt)

    # ---------- 5. done toggle x3 (stale-closure regression) ----------
    ns = ".note:has-text('Süt al')"
    for i, want in enumerate([True, False, True]):
        page.click(f"{ns} .note-check")
        time.sleep(0.45)
        has = page.eval_on_selector(ns, "e => e.classList.contains('done')")
        check(f"note done toggle #{i+1}", has == want, f"done={has}")
    page.click(f"{ns} .note-check")  # back to not-done
    time.sleep(0.4)

    # ---------- 6. ⋯ menu: open, rename, color ----------
    page.hover(ns)
    page.click(f"{ns} .note-btn[title='menü']")
    page.wait_for_selector(".popover.note-menu.show", timeout=4000)
    items = page.locator(".popover.note-menu .menu-item").all_inner_texts()
    check("menu items present", any("Sil" in it for it in items) and any("Renk" in it for it in items), str(items))
    page.click(".popover.note-menu .menu-item:has-text('Yeniden adlandır')")
    page.wait_for_selector("input.note-title-edit", timeout=4000)
    page.fill("input.note-title-edit", "Süt ve Ekmek")
    page.keyboard.press("Enter")
    time.sleep(0.5)
    t = page.eval_on_selector(".note:has-text('Süt ve Ekmek') .note-title", "e => e.textContent")
    check("menu rename works", t.strip() == "Süt ve Ekmek", t)

    page.hover(".note:has-text('Süt ve Ekmek')")
    page.click(".note:has-text('Süt ve Ekmek') .note-btn[title='menü']")
    page.wait_for_selector(".popover.note-menu.show", timeout=4000)
    page.click(".popover.note-menu .menu-item:has-text('Renk')")
    page.wait_for_selector(".color-swatches .swatch", timeout=4000)
    sw = page.locator(".color-swatches .swatch").count()
    check("color swatches shown", sw == 7, f"n={sw}")
    page.click(".color-swatches .swatch >> nth=2")
    time.sleep(0.4)
    hue = page.eval_on_selector(".note:has-text('Süt ve Ekmek')", "e => getComputedStyle(e).getPropertyValue('--hue')")
    check("color applied", hue.strip() not in ("", "35"), f"hue={hue}")

    # ---------- 6b. toolbar grupları + %100 sıfırlama + görüntüleme modu + silme seçenekleri ----------
    zlb = page.locator("#mm-zoom-label")
    page.click('button[title="yaklaştır"]')
    page.click('button[title="yaklaştır"]')
    time.sleep(0.3)
    zv = zlb.inner_text()
    check("zoom label shows percent", zv.endswith("%") and zv != "100%", zv)
    zlb.click()
    time.sleep(0.3)
    check("zoom label click resets to 100%", zlb.inner_text() == "100%", zlb.inner_text())
    gmap = dict(page.eval_on_selector_all(
        ".mm-toolbar .tb-group", "els => els.map(e => [e.dataset.group, getComputedStyle(e).display])"))
    check("toolbar groups visible in edit",
          gmap.get("mode") != "none" and gmap.get("actions") != "none" and gmap.get("zoom") != "none", str(gmap))

    # görüntüleme modunda araç butonları HİÇ yok olmalı (görünmez-tıklanır regresyonu)
    page.click("#mm-edit-toggle")
    time.sleep(0.4)
    tools = page.eval_on_selector_all(".note .note-tools button", "els => els.length")
    check("view mode has no note tools", tools == 0, f"n={tools}")
    page.click("#mm-edit-toggle")
    time.sleep(0.4)
    tools = page.eval_on_selector_all(".note .note-tools button", "els => els.length")
    check("edit mode has note tools", tools > 0, f"n={tools}")

    # alt notu olan notta üç silme seçeneği
    mk = ".note:has-text('Market')"
    page.hover(mk)
    page.click(f"{mk} .note-btn[title='menü']")
    page.wait_for_selector(".popover.note-menu.show", timeout=4000)
    mitems = page.locator(".popover.note-menu .menu-item").all_inner_texts()
    check("delete: subtree option", any("alt notlarını sil" in it for it in mitems), str(mitems)[:120])
    check("delete: only-this option", any("Sadece bu notu sil" in it for it in mitems), "")
    check("delete: children-to-root option", any("kök yap" in it for it in mitems), "")
    spot = find_canvas_spot(page)
    page.mouse.click(spot[0], spot[1])
    time.sleep(0.3)

    # not kağıdı rengi temalar arasında aynı
    page.click('button[title="tema değiştir"]')
    time.sleep(0.2)
    lum_d = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--note-lum').trim()")
    page.click('button[title="tema değiştir"]')
    time.sleep(0.2)
    lum_l = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--note-lum').trim()")
    check("note color same across themes", lum_d == lum_l == "78%", f"dark={lum_d} light={lum_l}")

    # ---------- 7. description via text field; empty field hidden ----------
    n2 = ".note:has-text('Süt ve Ekmek')"
    spot = find_canvas_spot(page)
    page.hover(n2)
    page.click(f"{n2} .note-btn[title='alan ekle / düzenle']")
    # fields-list is empty (no rows) until a field exists → wait for the add-row select instead
    page.wait_for_selector(".field-add select", timeout=4000)
    page.select_option(".field-add select", "text")
    page.click(".field-add button:has-text('+ Ekle')")
    page.wait_for_selector(".field-row input.input.small", timeout=4000)
    page.fill(".field-row input.input.small", "2 litre süt, 1 ekmek")
    time.sleep(1.2)  # debounced save (600ms)
    page.mouse.click(spot[0], spot[1])
    time.sleep(0.5)
    desc = page.eval_on_selector_all(f"{n2} .note-desc-line", "els => els.map(e => e.textContent)")
    check("description rendered as body", desc == ["2 litre süt, 1 ekmek"], str(desc))

    page.hover(n2)
    page.click(f"{n2} .note-btn[title='alan ekle / düzenle']")
    page.wait_for_selector(".field-add select", timeout=4000)
    page.select_option(".field-add select", "text")
    page.click(".field-add button:has-text('+ Ekle')")
    page.wait_for_selector(".field-row >> nth=1", timeout=4000)
    time.sleep(0.4)
    page.mouse.click(spot[0], spot[1])
    time.sleep(0.5)
    desc2 = page.eval_on_selector_all(f"{n2} .note-desc-line", "els => els.map(e => e.textContent)")
    chips2 = page.eval_on_selector_all(f"{n2} .field-chip", "els => els.length")
    check("empty text field hidden", desc2 == ["2 litre süt, 1 ekmek"] and chips2 == 0, f"desc={desc2} chips={chips2}")

    # ---------- 8. edges follow the note mid-drag ----------
    def edge_ds():
        return page.eval_on_selector_all(".mm-edges path", "els => els.map(e => e.getAttribute('d'))")
    before_ds = edge_ds()
    bb = page.locator(n2).bounding_box()
    cx, cy = bb["x"] + bb["width"] / 2, bb["y"] + 14
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 60, cy + 40, steps=6)
    mid_ds = edge_ds()
    page.mouse.move(cx + 130, cy + 90, steps=6)
    page.mouse.up()
    time.sleep(0.5)
    check("edges follow mid-drag", mid_ds != before_ds)
    check("edges settle after drop", edge_ds() != mid_ds)

    # ---------- 9. mindmap → list sync ----------
    page.hover(n2)
    page.click(f"{n2} .note-btn[title='menü']")
    page.wait_for_selector(".popover.note-menu.show", timeout=4000)
    page.click(".popover.note-menu .menu-item:has-text('Alt not ekle')")
    time.sleep(0.7)
    new_id = page.evaluate(
        "[...document.querySelectorAll('.note')]"
        ".filter(n => !n.querySelector('.note-title').textContent.trim())"
        ".map(n => n.dataset.id)[0]")
    nsn = f".note[data-id='{new_id}']"
    page.hover(nsn)
    page.click(f"{nsn} .note-btn[title='menü']")
    page.wait_for_selector(".popover.note-menu.show", timeout=4000)
    page.click(".popover.note-menu .menu-item:has-text('Yeniden adlandır')")
    page.wait_for_selector("input.note-title-edit", timeout=4000)
    page.fill("input.note-title-edit", "Kakao")
    page.keyboard.press("Enter")
    time.sleep(0.5)
    page.click('button.tab:has-text("Liste")')
    page.wait_for_selector(".view.list-view.active", timeout=5000)
    time.sleep(0.4)
    all_rows = page.eval_on_selector_all(".tree-row .tree-title", "els => els.map(e => e.textContent)")
    check("mindmap→list sync (Kakao visible)", any("Kakao" in r for r in all_rows), str(all_rows))
    under = page.eval_on_selector_all(
        '.tree-row:has(.tree-title:text-is("Süt ve Ekmek")) + .tree-kids .tree-title',
        "els => els.map(e => e.textContent)")
    check("Kakao nested under Süt ve Ekmek", under == ["Kakao"], str(under))

    # ---------- 10. list drag & drop ----------
    # A → after B
    src = page.locator('.tree-row:has(.tree-title:text-is("A Görevi")) .drag-grip')
    tgt = page.locator('.tree-row:has(.tree-title:text-is("B Görevi"))')
    sb, tb = src.bounding_box(), tgt.bounding_box()
    page.mouse.move(sb["x"] + 7, sb["y"] + sb["height"] / 2)
    page.mouse.down()
    page.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] * 0.85, steps=12)
    check("drop indicator (after)", page.evaluate("!!document.querySelector('.tree-row.drop-after')"))
    page.mouse.up()
    time.sleep(0.6)
    check("reorder within parent", root_titles(page) == ["Market", "B Görevi", "A Görevi", "C Görevi"], str(root_titles(page)))

    # C → inside A
    src = page.locator('.tree-row:has(.tree-title:text-is("C Görevi")) .drag-grip')
    tgt = page.locator('.tree-row:has(.tree-title:text-is("A Görevi"))')
    sb, tb = src.bounding_box(), tgt.bounding_box()
    page.mouse.move(sb["x"] + 7, sb["y"] + sb["height"] / 2)
    page.mouse.down()
    page.mouse.move(tb["x"] + tb["width"] * 0.5, tb["y"] + tb["height"] * 0.5, steps=12)
    check("drop indicator (into)", page.evaluate("!!document.querySelector('.tree-row.drop-into')"))
    page.mouse.up()
    time.sleep(0.6)
    akids = page.eval_on_selector_all(
        '.tree-row:has(.tree-title:text-is("A Görevi")) + .tree-kids .tree-title',
        "els => els.map(e => e.textContent)")
    check("drop inside → child", akids == ["C Görevi"], str(akids))

    # B → before Market
    src = page.locator('.tree-row:has(.tree-title:text-is("B Görevi")) .drag-grip')
    tgt = page.locator('.tree-row:has(.tree-title:text-is("Market"))')
    sb, tb = src.bounding_box(), tgt.bounding_box()
    page.mouse.move(sb["x"] + 7, sb["y"] + sb["height"] / 2)
    page.mouse.down()
    page.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] * 0.15, steps=12)
    check("drop indicator (before)", page.evaluate("!!document.querySelector('.tree-row.drop-before')"))
    page.mouse.up()
    time.sleep(0.6)
    check("reorder before first", root_titles(page) == ["B Görevi", "Market", "A Görevi"], str(root_titles(page)))

    # ---------- 11. persistence after reload ----------
    page.reload()
    page.wait_for_selector(".sidebar", timeout=8000)
    page.wait_for_selector('button.tab:has-text("Liste")', timeout=8000)
    page.click('button.tab:has-text("Liste")')  # tab pref may restore mindmap
    page.wait_for_selector(".tree-row", timeout=8000)
    time.sleep(0.6)
    check("order persists after reload", root_titles(page) == ["B Görevi", "Market", "A Görevi"], str(root_titles(page)))
    akids = page.eval_on_selector_all(
        '.tree-row:has(.tree-title:text-is("A Görevi")) + .tree-kids .tree-title',
        "els => els.map(e => e.textContent)")
    check("child persists after reload", akids == ["C Görevi"], str(akids))

    # ---------- 12. share dialog layout ----------
    page.click('button[title="pano menüsü"]')
    page.wait_for_selector(".menu-item:has-text('Paylaş')", timeout=4000)
    page.click(".menu-item:has-text('Paylaş')")
    page.wait_for_selector(".share-add", timeout=4000)
    w_in = page.locator('.share-add input.input').bounding_box()["width"]
    w_sel = page.locator('.share-add select.input').bounding_box()["width"]
    check("share username input wide", w_in >= 180, f"w={w_in:.0f}px")
    check("share role select sane", 80 <= w_sel <= 280, f"w={w_sel:.0f}px")
    page.click(".modal .btn:has-text('Kapat')")

    # ---------- 12b. profile panel: parola modalı + avatar yükleme ----------
    page.click(".user-chip")
    page.wait_for_selector(".popover .profile-head", timeout=4000)
    check("profile menu opens", page.locator(".popover .menu-item:has-text('Parola değiştir')").count() == 1)
    check("profile menu has logout", page.locator(".popover .menu-item:has-text('Çıkış yap')").count() == 1)

    page.click(".popover .menu-item:has-text('Parola değiştir')")
    page.wait_for_selector(".modal input[type='password']", timeout=4000)
    npw = page.locator(".modal input[type='password']").count()
    check("password modal has 3 fields", npw == 3, f"n={npw}")
    page.fill(".modal input[type='password'] >> nth=0", PASSW)
    page.fill(".modal input[type='password'] >> nth=1", "yeni-parola-99")
    page.fill(".modal input[type='password'] >> nth=2", "farkli-parola-9")
    page.click(".modal .btn.primary")
    page.wait_for_selector(".toast.error", timeout=4000)
    check("password mismatch rejected", True)
    page.click(".modal .btn.ghost")

    page.click(".user-chip")
    page.wait_for_selector(".popover .profile-head", timeout=4000)
    page.click(".popover .menu-item:has-text('Parola değiştir')")
    page.wait_for_selector(".modal input[type='password']", timeout=4000)
    page.fill(".modal input[type='password'] >> nth=0", "yanlis-eski-parola")
    page.fill(".modal input[type='password'] >> nth=1", "yeni-parola-99")
    page.fill(".modal input[type='password'] >> nth=2", "yeni-parola-99")
    page.click(".modal .btn.primary")
    page.wait_for_selector(".toast.error", timeout=4000)
    check("wrong current password rejected", True)
    page.click(".modal .btn.ghost")

    # avatar: minik png yükle → her yerde foto görünür
    png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                        "1f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082")
    open("/tmp/opencode/avatar-e2e.png", "wb").write(png)
    page.click(".user-chip")
    page.wait_for_selector(".popover .profile-head", timeout=4000)
    page.set_input_files(".popover input[type='file']", "/tmp/opencode/avatar-e2e.png")
    page.wait_for_selector(".toast:has-text('Profil fotoğrafı')", timeout=6000)
    time.sleep(0.8)
    photos = page.eval_on_selector_all(".avatar.photo", "els => els.length")
    check("avatar photo shown after upload", photos >= 1, f"n={photos}")

    # ---------- 12c. markdown dışa/içe aktarım ----------
    page.click('button[title="pano menüsü"]')
    page.wait_for_selector(".menu-item:has-text('Markdown dışa aktar')", timeout=4000)
    with page.expect_download() as dl:
        page.click(".menu-item:has-text('Markdown dışa aktar')")
    exported = open(dl.value.path(), encoding="utf-8").read()
    check("export has root bullet", "- [ ] Market" in exported, exported[:60])
    check("export nests child", "  - [ ] Süt ve Ekmek" in exported, exported[:80])

    open("/tmp/opencode/import-e2e.md", "w", encoding="utf-8").write(
        "# İçe Test\n- [x] Md Kök A\n  - Md Çocuk\n* [ ] Md Kök B\n")
    page.click('button[title="pano menüsü"]')
    page.wait_for_selector(".menu-item:has-text('Markdown içe aktar')", timeout=4000)
    with page.expect_file_chooser() as fc:
        page.click(".menu-item:has-text('Markdown içe aktar')")
    fc.value.set_files("/tmp/opencode/import-e2e.md")
    page.wait_for_selector(".toast:has-text('not eklendi')", timeout=8000)
    time.sleep(0.6)
    page.click('button.tab:has-text("Zihin Haritası")')
    page.wait_for_selector(".mindmap-view.active", timeout=5000)
    time.sleep(0.4)
    check("import created new root", page.locator(".note:has-text('Md Kök A')").count() == 1)
    check("import created child", page.locator(".note:has-text('Md Çocuk')").count() == 1)
    md_done = page.eval_on_selector(".note:has-text('Md Kök A')", "e => e.classList.contains('done')")
    check("import preserves done flag", bool(md_done))
    check("old data untouched by import", page.locator(".note:has-text('Market')").count() == 1)

    # ---------- 13. touch context: grip drag + pinch + always-visible tools ----------
    tctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    tpage = tctx.new_page()
    terr = []
    tpage.on("pageerror", lambda e: terr.append(str(e)))
    tpage.goto(BASE)
    tpage.wait_for_selector(".auth-card", timeout=8000)
    tpage.fill('input[placeholder="kullanıcı adı"]', USER)
    tpage.fill('input[placeholder="parola"]', PASSW)
    tpage.click("button[type=submit]")
    tpage.wait_for_selector(".sidebar", timeout=8000)
    tpage.click('button.hamburger')  # mobile: sidebar starts off-canvas
    tpage.click(".board-item:has-text('Batch2')")
    tpage.wait_for_selector(".board-title", timeout=8000)
    # tab pref may restore the mindmap tab (12c switched) → force list view
    tpage.click('button.tab:has-text("Liste")')
    tpage.wait_for_selector(".list-view.active .tree-row", timeout=8000)
    time.sleep(0.5)

    # grip drag on touch (synthetic touch pointer events)
    g0 = tpage.locator(".tree > .tree-row .drag-grip").nth(0).bounding_box()
    r1 = tpage.locator(".tree > .tree-row").nth(1).bounding_box()
    tpage.evaluate("""([gx, gy, tx, ty]) => {
      const pev = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch',
        isPrimary: true, clientX: x, clientY: y, button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
      }));
      pev(document.elementFromPoint(gx, gy), 'pointerdown', gx, gy);
      for (let i = 1; i <= 10; i++) {
        pev(window, 'pointermove', gx + (tx - gx) * i / 10, gy + (ty - gy) * i / 10);
      }
      pev(window, 'pointerup', tx, ty);
    }""", [g0["x"] + 7, g0["y"] + g0["height"] / 2, r1["x"] + r1["width"] / 2, r1["y"] + r1["height"] * 0.85])
    time.sleep(0.8)
    tt = tpage.eval_on_selector_all(".tree > .tree-row .tree-title", "els => els.map(e => e.textContent)")
    check("touch grip drag reorders", tt[:3] == ["Market", "B Görevi", "A Görevi"], str(tt))

    # pinch zoom
    tpage.click('button.tab:has-text("Zihin Haritası")')
    tpage.wait_for_selector(".mindmap-view.active", timeout=5000)
    time.sleep(0.5)
    z0 = tpage.locator("#mm-zoom-label").inner_text()
    tpage.evaluate("""() => {
      const vp = document.querySelector('.mindmap-view');
      const pev = (type, id, x, y) => vp.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch',
        isPrimary: id === 1, clientX: x, clientY: y, button: 0, buttons: 1,
      }));
      pev('pointerdown', 1, 200, 400);
      pev('pointerdown', 2, 260, 400);
      pev('pointermove', 1, 120, 400);
      pev('pointermove', 2, 340, 400);
      pev('pointerup', 1, 120, 400);
      pev('pointerup', 2, 340, 400);
    }""")
    time.sleep(0.4)
    z1 = tpage.locator("#mm-zoom-label").inner_text()
    check("pinch zoom works", z0 != z1, f"{z0} → {z1}")

    # note tools visible without hover on touch
    tpage.click("#mm-edit-toggle")
    time.sleep(0.3)
    op = tpage.eval_on_selector(".note .note-tools", "e => getComputedStyle(e).opacity")
    check("note tools visible on touch", float(op) == 1, f"opacity={op}")

    # ---------- errors ----------
    check("no page errors", not errors, "; ".join(errors[:3]))
    check("no touch page errors", not terr, "; ".join(terr[:3]))
    real_console = [e for e in console_err if "401" not in e and "favicon" not in e.lower()]
    check("no console errors", not real_console, "; ".join(real_console[:3]))

    browser.close()

print()
if FAILS:
    print("FAILED:", len(FAILS), FAILS)
    sys.exit(1)
print("ALL FEATURE TESTS PASSED")
