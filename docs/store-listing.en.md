# Chrome Web Store listing (English)

English version of `store-listing.md`, ready to paste into the Chrome Web Store
Developer Console. Store build: `npm run zip:store` → archive in `.output/`
(variant **without** CourseHunter — manifest lists only Udemy and Coursera).

---

## Name

**Alex Apps Subtitle Translator**

(publisher name in the Developer Console can also be "Alex Apps")

## Short description (max 132 characters)

> Translate English Udemy and Coursera subtitles into Ukrainian or Russian — dual subtitles over the video player

## Detailed description

```
Watch English-language Udemy and Coursera courses with subtitles in your own
language.

The extension translates a lecture's English subtitles on the fly and shows
them over the video — as dual subtitles (original + translation, perfect for
learning English alongside the course) or translation only.

FEATURES
• Translation into Ukrainian or Russian — choose your language in the settings
• Dual subtitles: English original + translation at the same time
• Smart translation: lines are joined into full sentences before translating,
  so the result is coherent instead of word-by-word
• Caching: each lecture is translated once, so re-watching is instant
• Two engines: Google Translate (default) or on-device Chrome AI
  (translation never leaves your computer, Chrome 138+)
• Adjustable font size and display mode
• No telemetry: the extension collects no data and runs no servers of its own

HOW TO USE
1. Open a course lecture on Udemy or Coursera
2. The extension automatically finds the English subtitles and translates them
3. Language and display mode are in the extension popup

This extension is not affiliated with Udemy, Inc. or Coursera, Inc. To
translate, subtitle text is sent to the translation service you selected
(see the privacy policy).
```

## Category

Education

## Listing language

English (Russian and Ukrainian listings can be added later)

---

## "Privacy practices" form answers

**Single purpose description:**
> Translates English course subtitles on Udemy and Coursera into Ukrainian or
> Russian and displays them over the video player.

**Permissions justification:**

| Permission | Justification |
|---|---|
| `storage` | Store user settings (language, mode) and a local cache of translated subtitles |
| `https://*.udemy.com/*` | Read lecture subtitles on Udemy pages and display the translation over the player |
| `https://*.udemycdn.com/*`, `https://udemy-captions.s3.amazonaws.com/*` | Download the subtitle files (.vtt) that Udemy links to |
| `https://www.coursera.org/*` | Read lecture subtitles on Coursera pages and download their VTT files |
| `https://translate.googleapis.com/*` | Send subtitle text for translation |

_Console-ready prose (paste verbatim into the Developer Console fields):_

**`storage` justification field:**
```
Stores user settings (target language, display mode, font size) and a local cache of translated subtitle lines so each lecture is translated only once. No data leaves the device.
```

**Host permission justification field:**
```
udemy.com — reading the lecture's subtitle track and displaying the translation over the player. udemycdn.com and udemy-captions.s3.amazonaws.com — downloading the subtitle (.vtt) files referenced by Udemy.
www.coursera.org — reading the lecture's subtitle track, downloading its subtitle (.vtt) files, and displaying the translation over the player.
translate.googleapis.com — sending subtitle text for translation.
```

**Data usage disclosures:**
- Website content (subtitle text) → sent to a third-party translation service;
  not sold, not used for purposes unrelated to the core feature, not used to
  determine creditworthiness.
- Nothing else is collected: no PII, health, financial, authentication,
  communications, location, web history, or user activity.

**Privacy policy URL:** publish `PRIVACY.md` (e.g. GitHub Pages or a gist) and
paste the link.

---

## Screenshots (need 1–5, 1280×800 or 640×400)

Capture manually:
1. Udemy lecture with dual subtitles (original + translation) — main screenshot
2. Coursera lecture with dual subtitles
3. Settings popup
4. "Translation only" mode

## Notes for reviewer

> The extension reads the lecture's caption track (VTT) that Udemy or Coursera
> already serves to the logged-in user, translates it via the selected
> translation service, and renders the translation in an overlay. It does not
> download videos, does not bypass DRM, and does not collect any user data.
