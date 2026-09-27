# Privacy Policy — Full Page Screenshot

_Last updated: September 27, 2026_

Full Page Screenshot is a Chrome extension that captures screenshots of the
web page you're viewing. It is designed to work entirely on your device.

## What it collects

**Nothing.** The extension does not collect, transmit, sell or share any
personal data, browsing history, page content or screenshots. It contains no
analytics, tracking or advertising code and makes no network requests to the
developer or any third party.

## What it stores on your device

- **Screenshots you take** are processed locally in your browser. The five
  most recent captures are kept in the extension's own local storage
  (IndexedDB) so the preview tab can show them; older ones are deleted
  automatically. Files you download are saved by Chrome to your Downloads
  folder.
- **Your settings** (capture mode, image format and quality, delay, what
  happens after a capture) are kept in `chrome.storage.local`.
- **The result of the last capture** (for example an error message) is kept
  briefly in `chrome.storage.session`, which Chrome clears when the browser
  closes.

All of this stays on your computer and is removed when you uninstall the
extension.

## Permissions

- **activeTab** and **host access** — to capture the page you ask it to
  capture, including scrolling it and, on sites that show a page inside an
  embedded frame, reaching that frame.
- **scripting** — to run short-lived code in that page to scroll it, measure
  its layout, hide repeating fixed elements during the capture, show the
  area-selection overlay, and restore the page afterwards.
- **storage** — to remember your settings.

These permissions are used only to take the screenshot you request.

## Contact

Questions or concerns: open an issue at
<https://github.com/vinceservidad/full-page-screenshot/issues>.
