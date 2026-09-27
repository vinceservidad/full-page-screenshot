# Chrome Web Store listing — copy/paste sheet

Everything the developer dashboard asks for, in dashboard order. Images are in
this folder.

## Package

Upload `full-page-screenshot-<version>-webstore.zip` (manifest at the zip root;
built from the repo, not committed).

## Store listing tab

**Title** (from the manifest): Full Page Screenshot

**Summary** (from the manifest):
True full-page screenshots of any web page: the whole page, the visible area, or a selected region. Copy or save them.

**Description:**

```
Capture the entire page — not just what's on screen — in one click.

Full Page Screenshot scrolls whatever actually scrolls and stitches it into a single image: normal web pages, web apps that scroll an inner panel (mail, dashboards, admin tools, chat panels), and editors that show a page inside an embedded preview. Then copy it to the clipboard or download it as PNG or JPEG.

THREE WAYS TO CAPTURE
• Full page — the whole scrollable page, top to bottom
• Visible area — what's on screen, with an optional 3–10 second delay for menus and tooltips
• Select area — drag a rectangle; works over dialogs and without closing open menus

CLEAN RESULTS
• Fixed headers, cookie banners, chat bubbles and floating buttons don't repeat down the image
• Sticky headers appear once, even translucent ones
• Waits for lazy-loaded images; corrects layout shifts during the capture
• Scroll position and the page are restored afterwards

FAST AND IN CONTROL
• Keyboard shortcut (Ctrl+Shift+Y / ⌘⇧Y by default); set shortcuts for every mode
• Progress on the toolbar icon; Esc cancels; "Stop & save" keeps what's been captured on endless feeds
• Preview tab with Copy and Download, or save straight to Downloads

PRIVATE BY DESIGN
Screenshots are processed entirely on your device. No accounts, no uploads, no analytics, no tracking.

Open source (MIT): https://github.com/vinceservidad/full-page-screenshot
```

**Category:** Productivity → Tools (or the closest "Tools" category offered)

**Language:** English

**Graphic assets:**
- Store icon: `icon-128.png`
- Screenshots (1280×800, in this order): `screenshot-1-popup.png`, `screenshot-2-preview.png`, `screenshot-3-select.png`, `screenshot-4-progress.png`
- Small promo tile (440×280): `promo-small-440x280.png`
- Marquee (1400×560): optional, skipped

**Official URL / Homepage URL:** https://github.com/vinceservidad/full-page-screenshot
**Support URL:** https://github.com/vinceservidad/full-page-screenshot/issues

## Privacy practices tab

**Single purpose:**

```
Capture screenshots of the current web page — the full scrollable page, the visible area, or a region the user selects — and let the user copy or save the image.
```

**Permission justifications:**

- **activeTab**
  ```
  Captures the tab the user invokes the extension on (toolbar popup or keyboard shortcut) with chrome.tabs.captureVisibleTab.
  ```
- **scripting**
  ```
  Injects short-lived functions into the page being captured to scroll it one screen at a time, measure its layout, temporarily hide fixed elements that would otherwise repeat in every slice, show the area-selection overlay, and restore the page's scroll position and styles afterwards. No remote code; all functions are packaged with the extension.
  ```
- **storage**
  ```
  Saves the user's capture settings (mode, format, quality, delay, after-capture action) and the result of the last capture so the popup can show it.
  ```
- **Host permission (<all_urls>)**
  ```
  Full-page capture has to script whatever page the user chooses to capture, on any site. Many sites show the real page inside a cross-origin iframe (for example website and store theme editors), and activeTab doesn't grant access to those frames, so broad host access is needed to scroll them. Nothing is read or sent anywhere: screenshots are processed and stored locally.
  ```

**Are you using remote code?** No, I am not using remote code.

**Data usage:** leave every data type unchecked (the extension collects none), then tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/vinceservidad/full-page-screenshot/blob/main/PRIVACY.md

## Distribution tab

- Visibility: Public
- Regions: All regions
- Pricing: Free
