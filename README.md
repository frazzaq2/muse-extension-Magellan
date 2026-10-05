# Castify — EHR → Availity Claim Assistant

A Chrome extension (Manifest V3) plus an optional self-hosted backend that automates
the medical-billing workflow:

**Magellan EHR "Ready to Bill" → authorization check → Availity eligibility →
Avillity claim fill → submit → TCN capture → write-back note in the EHR.**

## What's inside

```
castify/
  extension/          # the Chrome extension (load unpacked)
    manifest.json
    background.js     # service worker: one-by-one queue engine, AI calls, backend sync
    sidepanel.html/js/css  # compact command center (Report / Submit / Unbilled / Billed / AI / Export)
    popup.html        # toolbar launcher
    options.html/js   # settings: defaults, AI keys, Skill file editor, backend, center addresses
    content/
      magellan.js     # scrapes Ready-to-Bill, checks authorizations, writes back notes
      availity.js     # eligibility (3 fallback strategies), claim fill, submit, TCN capture
    skills/SKILL.md   # the AI instruction file — editable, improves over time
    lib/xlsx.full.min.js  # SheetJS (bundled, offline Excel export)
    icons/
  server/             # Node+Express+SQLite backend + dashboard (multi-user, VPS hosting)
  docs/
    USER_GUIDE.md     # install + daily workflow
    ARCHITECTURE.md   # how the pieces fit + message protocol
```

## The workflow (mirrors your video)

1. **Step 1 — Report.** Open Magellan → Billing → Claims (Ready to Bill), open the
   Castify side panel, click **Scan Magellan**. Filter by center (multi-select),
   payer, CPT; see stats by center / insurance / CPT; tick the claims to process.
2. **Step 2 — Authorization.** Pick the insurance (e.g. Aetna), choose a mode, hit
   **Start submission**. For each claim the extension opens the patient's
   authorizations tab and verifies: auth exists, DOS inside the auth period, CPT in
   the authorized code list, enough units remaining. Failures → Unbilled with the
   specific reason.
3. **Step 3 — Eligibility + submit.** On Availity it runs Eligibility & Benefits
   (Patient ID + DOB first, then name + DOB, then name + DOB + ZIP if the ID looks
   wrong). Inactive coverage → Unbilled. If active, it fills Start-a-Claim exactly
   like your video (org, payer, patient lookup, control number = MRN, POS 11,
   frequency 1, assignment A, filing CI, Dx F840, rendering provider, service
   facility address from the center table, service lines) and then:
   - **Auto mode** — submits immediately, captures the transaction ID.
   - **Review mode** — pauses; you check the form on Availity, then Submit or Skip.
4. **Write-back.** The TCN is written back into the EHR with your note template
   (default: `Claim submitted via Castify by {user} — Availity TCN {tcn} on {date}`).
5. **AI.** With an Anthropic or OpenAI key, the AI pre-flights claims against
   `skills/SKILL.md`, triages Availity errors, and suggests workflow improvements.
   Edit the Skill file in Options — your notes make it smarter over time.
6. **Reports.** One click exports a multi-sheet Excel workbook: Summary, Billed,
   Unbilled (with reasons), Stats-by-Center/Payer/CPT, event log.

## Privacy

All claim data stays in the browser (`chrome.storage.local`) unless you configure
the backend. The AI only receives the single claim you ask it to review. No
analytics, no third-party servers.

## Status / honest limitations

- Built from your 10-minute walkthrough (video had no audio track available, so
  narration-only details were inferred from your written spec).
- Magellan/Availity DOM selectors are defensive and text-anchored, but both sites
  are SPAs that change — if a step breaks, the queue marks the claim unbilled with
  the exact error instead of guessing, and the Options page has fields for direct
  Availity URLs as a fallback.
- The EHR write-back is best-effort: it looks for a note/activity composer on the
  page. If none is found, the TCN is kept in Castify and flagged for manual entry.
- First real run: use **Review mode** on 1–2 claims and watch each step before
  trusting Auto mode.

## Variants

- `v114-pos/castify-v1.1.4/` — stable **v1.1.4** base with only the **POS** button added
  (captures the encounter note's printable PDF and shows Place of Service).
  This is the recommended daily-driver build: load it unpacked in
  `edge://extensions` or `chrome://extensions`.

## Completing a fresh clone (binary files)

The automated push can't carry binary files, so these 8 are pushed as
placeholders / omitted — restore them from `castify-v1.1.4-pos.zip`
(everything is inside it):

- `extension/icons/icon16.png`, `icon48.png`, `icon128.png`
- `v114-pos/castify-v1.1.4/icons/icon16.png`, `icon48.png`, `icon128.png`
- `extension/lib/xlsx.full.min.js` — SheetJS, needed for Excel export
  (or download https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js)
- `v114-pos/castify-v1.1.4/lib/xlsx.full.min.js` — same file, second copy

How: on github.com open the target folder → **Add file** → **Upload files** →
drag the files in → **Commit changes**. Same-name uploads overwrite the
placeholders.
