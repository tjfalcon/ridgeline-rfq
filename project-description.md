# **FDE Application/Platform**

***FSL Version: V2.0.0***

## Guidelines

📌 **Important: Recordings must be submitted in MP4 format through a public Google Drive link.**

- Read the whole challenge and look through the sample data before you record. Prepare however you like.
- Record your **entire screen (with system clock visible)**
- Start recording once your environment and AI assistant are set up.
- Aim for 60 minutes or less; this is the ideal length. Going over 60 may reduce your score. **Going over 90 minutes is an automatic disqualification:** the challenge will not be reviewed, and you will not move forward in the process.
- The recording must be **one continuous take** — no pauses, edits, or interruptions
- Talk through your thinking the whole time. We evaluate your decisions as much as your code.
- AI coding assistants are allowed and expected. Show how you direct them, check their output and fix their mistakes.
- **Do not commit or show API keys or secrets.** Use environment variables. Visible secrets are an automatic disqualification.

Useful:

- Example recording: React Challenge

---

## AI Usage

AI coding assistants are allowed and expected. Show how you direct them, check their output, and fix their mistakes.

**Send the prompt in `ai_logging_prompt.txt` (in the data pack) as your first message**, as part of your setup. It makes your assistant log every exchange to `.chat-history/log.md`, which must be included in the submitted zip file. If you open a second assistant session, send it the same prompt.

---

## The Challenge

**Ridgeline Industrial Supply** (fictional) is a US distributor of industrial parts: about $800M in annual revenue, 40,000 products, 3 warehouses. About 400 requests for quotes (RFQs) arrive each week

Discovery found that the biggest delay isn't typing or AI work: **about 30% of quotes wait 4 to 6 hours for a regional manager to approve discounts over 15%.** Another team is building AI that turns RFQs into draft quotes. 

**Your job:** build the service that takes those draft quotes, applies pricing and stock checks, and routes them for approval so they go out faster, with a person still approving every quote.

**Constraints:**

- SAP (on premises) is the system of record. Writing to SAP takes months to approve, so your service must not write to it.
- You have read-only access to a nightly reporting database (products, customers, contract prices) and an hourly stock API.
- A person approves every quote before it reaches a customer.
- Ridgeline needs a full record of who approved what, and when.

## Sample Data

<aside>
<img src="https://s3-us-west-2.amazonaws.com/secure.notion-static.com/6c7b58b1-0498-4a6f-82fc-b4daa384967b/db.png" alt="https://s3-us-west-2.amazonaws.com/secure.notion-static.com/6c7b58b1-0498-4a6f-82fc-b4daa384967b/db.png" width="40px" /> You can download the sample data in the following here.

</aside>

- `draft_quotes.json`: 10 draft quotes as produced by the extraction team (some with low-confidence lines).
- `reporting_db/`: a read-only snapshot (SQLite or CSV) with products, customers and contract prices.
- `stock_api.md`: the stock API spec, plus a small mock server or fixture file.
- `approval_rules.md`: the current approval policy (discount thresholds, regional managers, backups when a manager is out).
- `ai_logging_prompt.txt`: the first message for your AI assistant (see **AI Usage**).

## Tasks

Stubs and mocks are fine where noted. When you stub something, say on the recording what you stubbed, why, and what the production version would do. We score your judgment, not completeness.

### Part 1: Plan *(3 Minutes)*

Before writing any code, say on the recording what you will build, what you will stub, and why. Clients may watch only Parts 1 and 5, so make them clear.

### Part 2: Build the service *(30 Minutes)*

Walk through the code you built. A simple data store is fine for quotes, approvals and the audit log (for example SQLite or a JSON file). Explain what you would use in production.

1. **Pricing and stock:** for each draft quote, apply contract pricing from the reporting database and check stock through the API. Handle stale or unavailable data clearly.
2. **Approval routing:** implement the approval policy as configurable rules: specialist sign-off only under the threshold, route to the right regional manager or VP above it, and fall back to a backup approver when the approver is out. Low-confidence lines from the extraction team always go to a specialist first.
3. **Review and approve:** a basic API where a specialist or manager can list quotes and approve or reject them. A UI is not required. *Stub OK:* editing a quote. Explain how an edit would reprice and reroute it.
4. **Audit:** record every action (who, what, when, and the status before and after).

### Part 3: Make it reliable *(10 Minutes)*

Show and explain:

1. What happens when the stock API is down or the reporting data is a day old. **Stock API calls must retry** (for example with a timeout and backoff). When retries are exhausted, the quote is marked with stock unavailable rather than blocked or guessed.
2. Duplicate drafts must be detected (`duplicate_of` in the output). *Stub OK:* preventing double approvals and lost quotes can be explained rather than built.
3. Role-based access (specialist versus manager). A simple check is enough, for example a user ID in a request header, where only a specialist or the routed approver can approve. Explain the production version.
4. Tests for the approval rules: at least one per approval tier, the backup approver, and a duplicate.

### Part 4: Take it to production *(8 Minutes)*

Show a diagram and explain:

1. How it is deployed and how it connects to Ridgeline's systems without writing to SAP.
2. What you would monitor, including time from draft to approval.
3. How Ridgeline would change approval rules without a code release.
4. What you would do with two more weeks.

### Part 5: Show it working *(5 Minutes)*

End your recording with a short demo, around 5 minutes: run your service on the sample draft quotes, show some that need only specialist sign-off and some routed to a manager or VP, and explain the one decision that matters most.

---

## Deliverables

Your repository must include these paths. Your code can use any layout.

```
README.md
.chat-history/
outputs/routing_results.json
```

### Deliverable 1: `outputs/routing_results.json`

Your service writes this file when it processes the sample drafts. It's a list with one object per draft, all 10 in the order of `draft_quotes.json`:

```json
[
  {
    "draft_id": "DQ-00000",
    "status": "approver_required",
    "net_total": 1234.56,
    "effective_discount_pct": 17.5,
    "approver_id": "U00",
    "specialist_review_flags": [
      {"line": 2, "reason": "extraction confidence 0.70"},
      {"line": null, "reason": "stock unavailable after retries"}
    ],
    "duplicate_of": null
  }
]
```

- `status`: `specialist_only` (no approver needed after the specialist), `approver_required`, or `duplicate`.
- `net_total`: USD, 2 decimals.
- `effective_discount_pct`: a percentage, 2 decimals (17.5 means 17.5%).
- `approver_id`: who approves after the specialist, with any backup already applied.
- `specialist_review_flags`: a list of `{line, reason}`; `line` is `null` for the whole quote, `reason` is your own wording. Include low-confidence lines and stale or unavailable stock or pricing data. Use `[]` when there are none.
- `duplicate_of`: the `draft_id` of the original draft.

Use `null` when a value doesn't apply.

### Deliverable 2: Tests

Tests for your approval rules: at least one per approval tier, the backup approver, and a duplicate. Use any language or test framework. The command that runs them goes under **How to Run** in your README.

### Deliverable 3: `README.md`

Use **exactly** these headings, in this order:

```markdown
# Ridgeline Quote Approvals
## Repository
## How to Run
## Approach
## Reliability
## Production
```

- **Repository:** the link to your public GitHub repository.
- **How to Run:** the commands that start the service, process the sample drafts, and run the tests.
- **Approach:** how pricing, stock checks and routing work, where the approval rules live, what you stubbed, and the one decision that matters most.
- **Reliability:** stock API retries, stale or unavailable data, duplicates, and roles.
- **Production:** your diagram as a Mermaid code block, and a few short bullets for each Part 4 point.

Also:

- `.chat-history/`: your AI assistant's log of the session (see **AI Usage**).
- `.env.example` (if your service reads environment variables): the variable names, for example the stock API URL or database path, with no values.

---

## How to submit *(about 3 minutes)*

At the end of your recording:

1. Finish the Part 5 demo.
2. Check that your repository has every path listed under **Deliverables**.
3. Commit and push your final work.
4. Zip your repository folder as `ridgeline-quote-approvals.zip`. Include `.chat-history/` and `.env.example` if you have one. Do not include `.env` (your real settings and secrets).

The submission form has **two fields**: the public Google Drive link to your MP4, and the zip file.

---

## Acceptance Criteria

- The recording opens with your plan and ends with a working demo on the sample draft quotes.
- Approval rules are configurable and covered by tests (at least each tier, the backup approver and a duplicate).
- Pricing comes from the reporting database; stock comes from the API; nothing writes to SAP.
- Every action is recorded in an audit log.
- Failures of the stock API or stale data are handled visibly, and stock API calls are retried before being marked unavailable.
- Every stub is explained in the recording.
- A production diagram is shown.
- No quote reaches a customer without human approval.
- `outputs/routing_results.json` follows the format in **Deliverable 1**.
- The submitted zip contains every path listed under **Deliverables**, and no `.env` file.

## How You're Scored

Each criterion is scored out of 10: Problem Framing & Scope; System Architecture & Integration; Workflow & Rules Logic; Reliability & Error Handling; Security, Audit & Access Control; Code Quality & Testing; Communication & Trade-offs; Time Management.