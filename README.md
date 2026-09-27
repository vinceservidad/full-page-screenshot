# Full Page Screenshot — Chrome Extension

A Manifest V3 Chrome extension that captures a **full-page** screenshot — the
entire scrollable area of a page, including apps that scroll an inner panel and
editors that show the page in an embedded frame — then lets you copy or save it.

It works with only `activeTab`, `scripting`, `storage` and host access: no
`chrome.debugger` (which managed Chrome profiles often block) and no
`downloads` permission.

## Capture modes

- **Full page** — scrolls whatever actually scrolls (the page, the main app
  panel — including ones inside web components and bottom-anchored chat
  panels — or a large embedded iframe such as the Shopify theme editor
  preview), captures one viewport at a time and stitches them into one image.
  A docs site's scrollable sidebar won't be mistaken for the page.
- **Visible area** — what's on screen right now, with an optional 3–10 s delay
  so you can open a menu or tooltip first.
- **Select area** — drag a rectangle on the page; the size is shown while you
  drag. Esc cancels, a plain click lets you try again. Works over modal
  dialogs, and starting the drag doesn't close an open menu.

After a capture the image opens in a **preview tab** with **Copy** (⌘/Ctrl+C)
and **Download** (⌘/Ctrl+S). You can switch the popup's “After capture” option
to save straight to Downloads instead.

## How full-page capture handles real pages

- **Fixed elements** (cookie bars, chat bubbles, side tabs, floating
  sidebars — including ones inside web components) are hidden so they don't
  repeat down the image or get cut in half; a fixed header at the very top
  appears once. Full-viewport backgrounds, anything containing the scroller,
  and "fixed" elements that really scroll with the content are left alone.
- **Sticky headers/footers** are found from the DOM (translucent/blurred ones
  included) and by comparing neighbouring slices, then trimmed where slices
  overlap — never more than the overlap, so no content is lost.
- **Layout shifts** during the capture (a header switching to fixed, content
  collapsing above) are detected by matching the overlap and corrected.
- **Lazy images** get a moment to load before each slice; smooth scrolling and
  scroll snapping are disabled while capturing (JS smooth-scroll libraries are
  waited out); overlay scrollbars (macOS) are hidden so their thumb doesn't
  streak down the image; hover effects are switched off so a resting pointer
  doesn't highlight rows or pop tooltips into the capture.
- Your scroll position (including any containers it had to scroll), the
  page's styles and hidden elements are restored afterwards.
- The step between slices adapts to the page (~80% of the viewport when
  nothing is pinned), so captures take roughly 40% fewer shots than a fixed
  50% step.

While it runs, the toolbar badge shows progress (and a red `!` if something
went wrong — open the popup to see why). Stay on the tab and don't resize the
window — switching tabs stops the capture (Chrome only screenshots the visible
tab). **Esc** (on the page or in the popup) cancels while it's scrolling or
selecting; **Stop & save** in the popup keeps what's been captured so far
(useful on infinite-scroll feeds). Cancel in the popup also works while the
image is being saved.

## Keyboard shortcuts

- Full page: `Ctrl+Shift+Y` (macOS: `Cmd+Shift+Y`) by default. The popup shows
  the shortcut Chrome actually assigned — Chrome skips a default that clashes
  with another extension.
- Visible area and Select area have no default; assign them at
  `chrome://extensions/shortcuts` (the popup links there).

## Install (unpacked, for development)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder. (After updating the files,
   click the extension's reload icon there.)
4. Pin the extension, open any page, and click the icon.

The icons are already included; `python3 icons/generate_icons.py` only
regenerates them.

Files are named `screenshot-<hostname>-<YYYY-MM-DD_HH-MM-SS>.png` (`.jpg` for
JPEG; local time).

## How it works

| File                    | Role                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| `manifest.json`         | MV3 manifest, permissions, action popup, keyboard commands                |
| `background.js`         | Service worker: capture logic, stitching, and small page-injected helpers |
| `idb.js`                | IndexedDB hand-off of finished images to the preview tab (keeps last 5)   |
| `popup.html/js`         | Mode/format/delay options, progress, Stop & save / Cancel                 |
| `viewer.html/js`        | Preview tab: Copy to clipboard and Download                               |
| `icons/`                | Toolbar icons + generator script                                          |

## Notes & limitations

- Chrome-internal pages (`chrome://`, the Web Store, other extensions) can't be
  captured — a browser restriction. Local files need **Allow access to file
  URLs** in the extension's details.
- Chrome's PDF viewer can't be scrolled by extensions; full-page mode falls
  back to the visible area there. Pinch-zoom out before a full-page capture.
- Area selection isn't available on SVG/XML documents (use Visible area).
- Requires Chrome 116 or later.
- Very tall pages: Chrome images are limited to 32,767 px per side, so pages
  are captured up to that height at CSS resolution (a note in the preview — or
  in the popup right after a direct download — says when this happens). Infinite-scroll pages stop after 150 screens.
- Wide pages that scroll horizontally are captured at viewport width.
- With **Save straight to Downloads**, a second capture of the same page can
  trigger Chrome's “download multiple files” prompt in the address bar; allow
  it once per site. Every capture is also kept for the preview (last 5), so
  the popup's **Open preview** link works even if a download was blocked.
- Sticky sidebars (`position: sticky`, not full width) can still repeat down
  the image; fixed ones are handled.

## License

MIT — see [LICENSE](LICENSE).
