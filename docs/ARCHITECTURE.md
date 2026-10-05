# Castify Architecture

## Components

```
┌──────────────┐      messages       ┌───────────────────┐
│  Side panel  │ ◄─────────────────► │ background.js (SW) │
│  (UI state)  │   GET_STATE etc.    │  queue engine      │
└──────────────┘                     │  AI calls          │
                                     │  backend sync      │
                                     └───────┬───┬───────┘
                                             │   │
                        ┌────────────────────┘   └────────────────────┐
                        ▼                                             ▼
              ┌──────────────────┐                          ┌──────────────────┐
              │ content/magellan │                          │ content/availity │
              │ .js              │                          │ .js              │
              └──────────────────┘                          └──────────────────┘
              magellanehr.com/*                             essentials.availity.com/*
```

- **Side panel** is dumb UI: renders state, sends commands, listens for broadcasts.
- **background.js** owns all state (`chrome.storage.local`: claims, billed, unbilled,
  queue, eventLog, settings) and the queue state machine. Content scripts never talk
  to each other directly.
- **Content scripts** are page adapters: scrape/fill/click, return structured results.
  They are defensive — every step returns `{ok, error}` and the queue converts
  failures into unbilled reasons instead of crashing.

## Queue state machine (one claim at a time)

```
ready → processing(auth) → auth_ok → processing(eligibility) → eligibility_ok
  → processing(fill) → filled → [auto: processing(submit) | review: awaiting_review]
  → billed ──(TCN)──► write-back note in Magellan
  └─ any step fails ──► unbilled {step, reason}
```

Review mode pauses at `awaiting_review`; the side panel's **Submit claim** / **Skip**
buttons resolve the gate via `REVIEW_DECISION`.

## Message protocol

Background ↔ side panel (via `chrome.runtime.sendMessage`):
`GET_STATE, SAVE_SETTINGS, SCAN_MAGELLAN, START_QUEUE{ids,mode}, STOP_QUEUE,
REVIEW_DECISION{decision}, AI_REVIEW_CLAIM{claim}, AI_SUGGEST{context},
GET_SKILL, SAVE_SKILL{text}, SYNC_BACKEND, CLEAR_DATA`

Background → content scripts (via `chrome.tabs.sendMessage`):
- Magellan: `CASTIFY_SCAN_MAGELLAN, CASTIFY_GOTO_AUTH_TAB{patientHref},
  CASTIFY_CHECK_AUTH{claim}, CASTIFY_WRITEBACK{claim,tcn,note}`
- Availity: `CASTIFY_NAVIGATE{target,url}, CASTIFY_ELIGIBILITY{claim,cfg},
  CASTIFY_FILL_CLAIM{claim,ctx}, CASTIFY_SUBMIT_CLAIM, CASTIFY_PAGE_ERRORS`

Broadcasts (background → side panel, `_broadcast: true`):
`QUEUE_STARTED, CLAIM_START, CLAIM_AUTH_OK, CLAIM_ELIG_OK, REVIEW_NEEDED,
CLAIM_BILLED{tcn}, CLAIM_UNBILLED{step,reason}, QUEUE_DONE, QUEUE_STOPPED, SCAN_DONE`

## Eligibility strategies (in order)

1. `id_dob` — Patient ID (member ID) + DOB
2. `name_dob` — last + first name + DOB ("without ID" search)
3. `name_dob_zip` — name + DOB + ZIP
First strategy that returns a response wins; coverage must parse as active.

## AI

`aiComplete()` posts to Anthropic (`claude-haiku-4-5-20251001` default) or OpenAI
(`gpt-4o-mini` default) with `skills/SKILL.md` (+ user edits stored as `skillText`)
as the system prompt. Only the claim under review is sent.

## Backend sync

`POST {backendUrl}/api/claims/batch` with `Authorization: Bearer {backendToken}`,
body `{billed, unbilled, claims, at}`. Fired after each queue run and on demand
from Options. See `server/README.md`.

## Tuning for site changes

- Availity menu navigation has direct-URL overrides in Options (`eligUrl`,
  `startClaimUrl`) — paste from the address bar.
- Magellan table scraping is header-text anchored (not position dependent).
- If Availity changes a field label, add the new label to the label list in
  `content/availity.js` (`findInputByLabels(...)` tries each in order).
