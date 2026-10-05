# Castify User Guide

## Install the extension (2 minutes)

1. Open Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
2. Click **Load unpacked** → select the `castify/extension` folder.
3. Pin Castify to the toolbar. Click it → **Open side panel**.

## First-time setup (Options page)

1. Click the ⚙ in the side panel (or `chrome://extensions` → Castify → Details → Extension options).
2. **Submission defaults** — check organization, NPI, payer, POS; set your name (used in EHR notes).
3. **Center addresses** — verify the 7 centers; add more as needed. The center name must
   match the Center column in Magellan exactly.
4. **AI assistant** — paste an Anthropic (Claude) or OpenAI (ChatGPT) API key to enable
   pre-flight reviews and suggestions. Stored only in your browser.
5. **Backend (optional)** — if your admin gave you a backend URL + token, enter them here
   for multi-user sync and the hosted dashboard.

## Daily workflow

### Step 1 — Report: what can we bill?

1. Log in to **Magellan EHR** → Billing → Claims → **Ready to Bill**.
2. Open the Castify side panel → **Scan Magellan**.
3. Use the filters: search box, payer, CPT, center multi-select, "Ready only".
4. Read the stat cards: totals plus top-5 breakdowns by center, insurance, CPT.
5. Tick the claims you want to process (or leave all ticked).

### Step 2 + 3 — Submit

1. Go to the **Submit** tab. Choose the insurance (e.g. Aetna) and the mode:
   - **Review** (recommended at first): the extension fills everything, then waits for
     you to check the Availity form and press **Submit claim** or **Skip**.
   - **Auto**: submits right after a successful eligibility check, no approval.
2. Press **▶ Start submission**. Claims run **one by one**:
   `authorization → eligibility → fill → submit → TCN → EHR note`.
3. Watch the live log. Anything that fails lands in **Unbilled** with the exact reason
   (e.g. "CPT 97153 not in authorized codes", "Eligibility inactive as of DOS",
   "Enter a valid mailing address…" quoted from Availity).

### AI help

- **Report tab → AI pre-flight review**: select one claim, let the AI check it against
  the Skill file before you submit.
- **AI tab**: ask about an Availity error, or **Get workflow suggestions** based on
  your recent unbilled reasons.
- **Options → AI Skill file**: add your own rules as new scenarios appear
  (e.g. "Aetna requires the auth number without dashes"). The AI uses them from then on.

### Reports

**Export tab → Export Excel report** downloads:
`castify-report-YYYY-MM-DD.xlsx` with sheets: Summary, Billed, Unbilled,
Stats-Center, Stats-Payer, Stats-CPT, Event log.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "No open tab found for magellanehr.com" | Open Magellan and log in, then Scan again. |
| "Claims table not found" | Make sure you're on Billing → Claims with the Ready-to-Bill bucket visible. |
| "Could not reach the Eligibility form via menus" | In Options → Advanced, paste the direct Availity Eligibility URL (copy it from your address bar while on that page), same for Start-a-Claim. |
| Claim stuck "awaiting_review" | Press Submit claim / Skip in the Submit tab, or Stop the run. |
| TCN not written back to EHR | The note box wasn't found — the TCN is in the Billed tab; paste it manually this time and tell support which page you were on. |
| Availity validation error loop | Read the quoted error in the Unbilled reason; fix the source data (often the center address or rendering provider NPI in Options). |

## Safety notes

- Keep patient data in Chrome; the extension never uploads anything unless you
  configure the backend.
- Run the first real claims in **Review mode**.
- The extension never changes anything in Magellan except adding the submission note.
