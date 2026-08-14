# Individual Application for Finance — Nissan Gezina

An online version of the BB Motor Group / Nissan Gezina paper finance application.
The customer fills it in on their phone, and the completed application arrives in your
inbox as a formatted email with their signature and supporting documents attached.

- **Front end** — plain HTML/CSS/JS, hosted free on GitHub Pages.
- **Back end** — one Cloudflare Worker that emails through Resend. Same pattern as the
  Jaxtech site's `/api/enquiry`.

Nothing to build, no framework, no npm install for the site itself.

---

## What the customer sees

Nine steps, mirroring the paper form:

| # | Step | Notes |
|---|------|-------|
| 1 | Wish list | Vehicle, instalment budget, balloon, trade-in |
| 2 | Identity | SA ID number, citizenship, language, population group |
| 3 | Your details | Name, contact, address, marital status, property |
| 4 | Employment | Employer, occupation, period, retrenchment question |
| 5 | Income | Gross, commission, allowance, net, other income |
| 6 | Expenses | All 16 expense lines from the paper form |
| 7 | Banking | Account details plus the IDX statement consent |
| 8 | Contact person | The relative not living with the applicant |
| 9 | Declarations | A–H, the four NCA consents, signature, documents |

Things that make it easier to complete than the paper version:

- **SA ID number is checked as they type** (13 digits, valid date, Luhn check digit) and
  the date of birth, age and gender are read back to them. A mistyped ID is the single
  most common reason a bank rejects an application, and it's caught here.
- **Totals calculate themselves** — total income, total expenses, and what's left over
  each month, updated live.
- **Answers save to the phone as they go**, so a customer can stop and come back.
  ID numbers, bank account numbers and the signature are deliberately *never* saved.
- **Irrelevant questions stay hidden** — spouse fields only appear if married, bond
  fields only if they own property, and so on.
- **Signature by finger** on a canvas, attached to your email as a PNG.
- **Optional document upload** — ID copy, payslips, bank statements, proof of address.
  Max 4 MB per file, 12 MB in total.

## What you receive

One email per application containing every field, laid out section by section, with:

- A summary strip at the top: net income, expenses, surplus, instalment budget.
- **A warnings box** when something needs your eye before it goes to the banks — a
  retrenchment notice in the last 6 months, declared expenses exceeding declared income,
  or any of declarations A–H left unconfirmed.
- Call / WhatsApp / Email buttons for the applicant.
- The signature and any uploaded documents as attachments.
- A short reference like `BB-260814-4F2A` for the phone.

The applicant separately gets a plain confirmation email with that reference. It
deliberately does not repeat their ID or banking details.

---

## Deploying

### 1. The back end (Cloudflare Worker)

You need a Resend API key. [resend.com](https://resend.com) is free up to 3 000 emails
a month, which is far more than this will ever use.

```bash
cd worker
npx wrangler login
npx wrangler secret put RESEND_API_KEY     # paste your key when prompted
npx wrangler deploy
```

That prints your Worker URL, e.g. `https://bbfinance.jaxtech.workers.dev`.

Check it's alive:

```bash
curl https://bbfinance.jaxtech.workers.dev/api/health
# {"ok":true,"email":true,"storage":false,"turnstile":false,...}
```

**Sender address.** `onboarding@resend.dev` works immediately but only delivers to the
address that owns the Resend account — fine for testing. For live use, verify a domain
in Resend and set `FROM_EMAIL` in `wrangler.toml` to something like
`Nissan Gezina Finance <finance@yourdomain.co.za>`.

**Optional — rate limiting and a stored copy.** Without a KV namespace the Worker still
works; it just can't rate-limit and keeps no copy.

```bash
npx wrangler kv namespace create APPLICATIONS
```

Paste the printed id into the `[[kv_namespaces]]` block in `wrangler.toml`, uncomment it,
and deploy again. Stored copies are masked (`••••7890`) and expire after 90 days unless
you set `STORE_FULL = "true"`.

### 2. The front end (GitHub Pages)

Point `CONFIG.endpoint` at the top of `app.js` at your Worker, then:

**Settings → Pages → Source: Deploy from a branch → `main` / root.**

The form lands at `https://nageljakes.github.io/SAVehiclefinanceapp/`.

Set `ALLOWED_ORIGINS` in `wrangler.toml` to that origin so only your own page can post
to the Worker, and redeploy.

### 3. Branding

Drop a logo at `assets/logo.png` (about 34 px tall) and it appears in the header
automatically. The accent colour is `--red` at the top of `styles.css`.

---

## Configuration reference

**`app.js`** — the `CONFIG` block at the top:

| Key | What it does |
|-----|--------------|
| `endpoint` | Your Worker's `/api/application` URL |
| `phone` | Number behind the "Call" buttons |
| `whatsapp` | International format, digits only — `082…` → `2782…` |

**`worker/wrangler.toml`**:

| Setting | Default | What it does |
|---------|---------|--------------|
| `NOTIFY_EMAIL` | `nageljakes@gmail.com` | Where applications land. Comma-separate for several |
| `FROM_EMAIL` | `onboarding@resend.dev` | Must be Resend-verified |
| `ALLOWED_ORIGINS` | GitHub Pages origin | CORS allowlist. Blank allows any origin |
| `STORE_FULL` | `false` | `true` keeps unmasked copies in KV |
| `RESEND_API_KEY` | *(secret)* | Required — `wrangler secret put` |
| `TURNSTILE_SECRET` | *(secret)* | Optional bot protection |

---

## A note on the data

This form collects ID numbers, salaries and bank account numbers — everything an
identity thief wants, arriving in a Gmail inbox. Worth knowing:

- Email between the Worker and Gmail is encrypted in transit, but it sits **unencrypted
  in your mailbox** afterwards. Anyone with access to that inbox has every applicant's
  ID and banking details. Put 2FA on it if it isn't already, and think about a dedicated
  address rather than a personal one.
- The Worker keeps no copy by default. `STORE_FULL = "false"` masks the sensitive
  fields even when KV is switched on.
- Nothing sensitive is written to the customer's browser storage.
- Under POPIA you're the responsible party for this data. The form takes explicit
  consent, and the footer tells applicants how to have their details removed — keep
  that address working.

If this grows beyond a handful of applications a week, the right next step is a proper
lead inbox behind a login (like the Jaxtech `/leads` dashboard) rather than email as
the system of record.

---

## Testing before you go live

The quickest end-to-end check is to submit a real application to yourself:

1. Open the Pages URL on your phone.
2. Fill it in with your own details and a valid ID number.
3. Confirm the email arrives, with the signature attached and the totals correct.

The Worker's validation can be exercised directly:

```bash
curl -X POST https://bbfinance.jaxtech.workers.dev/api/application \
  -H 'Content-Type: application/json' \
  -d '{"surname":"Test"}'
# {"error":"Some required details are missing.","problems":[...]}
```

## Files

```
index.html          the form
styles.css          styling
app.js              validation, steps, signature, submit  ← CONFIG at the top
worker/worker.js    Cloudflare Worker: validate, email, store
worker/wrangler.toml deployment config
```
