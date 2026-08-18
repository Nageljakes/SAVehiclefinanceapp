/* ==========================================================
   BB Motor Group / Nissan Gezina — finance application backend
   Cloudflare Worker. Receives the form, emails it via Resend.

   Bindings (see wrangler.toml):
     RESEND_API_KEY  secret    required for email
     NOTIFY_EMAIL    var       where applications land
     FROM_EMAIL      var       verified Resend sender
     APPLICATIONS    KV        optional — rate limiting + a redacted copy
     TURNSTILE_SECRET secret   optional — bot protection
     ALLOWED_ORIGINS var       optional — comma-separated CORS allowlist
     STORE_FULL      var       "true" to keep unredacted copies in KV
   ========================================================== */

const MAX_BODY      = 26 * 1024 * 1024;   // base64 inflates ~33%, so ~19 MB of files
const MAX_ATTACH    = 20 * 1024 * 1024;   // Resend caps total attachments at 40 MB
const RATE_MAX      = 4;                  // applications per IP...
const RATE_WINDOW   = 3600;               // ...per hour

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/application') {
      if (request.method === 'OPTIONS') return preflight(request, env);
      if (request.method !== 'POST') return json(request, env, { error: 'Method not allowed' }, 405);
      return handleApplication(request, env, ctx);
    }

    if (url.pathname === '/api/health') {
      return json(request, env, {
        ok: true,
        email: !!env.RESEND_API_KEY,
        storage: !!env.APPLICATIONS,
        turnstile: !!env.TURNSTILE_SECRET,
        notify: !!env.NOTIFY_EMAIL
      });
    }

    return new Response('Not found', { status: 404 });
  }
};

/* ══════════════════ Handler ══════════════════ */

async function handleApplication(request, env, ctx) {
  let data;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) {
      return json(request, env, { error: 'Those documents are too large to send in one go.' }, 413);
    }
    data = JSON.parse(raw);
  } catch {
    return json(request, env, { error: 'Invalid submission.' }, 400);
  }

  // Honeypot — bots fill it, people never see it.
  if (data.company_website || data.hp) return json(request, env, { ok: true, id: 'ignored' });

  if (env.TURNSTILE_SECRET && data.turnstileToken) {
    const ok = await verifyTurnstile(env, data.turnstileToken, request);
    if (!ok) return json(request, env, { error: 'Verification failed — please reload and try again.' }, 403);
  }

  const clean = sanitise(data);
  const problems = validate(clean);
  if (problems.length) {
    return json(request, env, { error: 'Some required details are missing.', problems }, 422);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (ip !== 'unknown' && await overRate(env, 'rate:' + ip)) {
    return json(request, env, { error: 'Too many applications from this connection — please call us instead.' }, 429);
  }

  const cf = request.cf || {};
  const record = {
    ...clean,
    id: reference(),
    receivedAt: new Date().toISOString(),
    ip,
    city: cf.city || null,
    region: cf.region || null,
    country: cf.country || null,
    userAgent: (request.headers.get('User-Agent') || '').slice(0, 300)
  };

  const attachments = buildAttachments(data, record);

  if (!env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not set — nothing was emailed.');
    return json(request, env, { error: 'The application desk is not reachable right now.' }, 503);
  }

  let emailed = false;
  try {
    emailed = await sendEmail(env, record, attachments);
  } catch (err) {
    console.error('Resend failed', err);
  }

  if (!emailed) {
    return json(request, env, { error: 'We could not deliver your application just now.' }, 502);
  }

  // Storage is a convenience copy, not the system of record — never let a
  // KV hiccup fail a submission the applicant has already had confirmed.
  if (env.APPLICATIONS) {
    ctx.waitUntil(
      env.APPLICATIONS.put(
        `app:${record.receivedAt}:${record.id}`,
        JSON.stringify(env.STORE_FULL === 'true' ? record : redact(record)),
        { expirationTtl: 60 * 60 * 24 * 90 }
      ).catch(err => console.error('KV write failed', err))
    );
  }

  // Confirmation to the applicant — best-effort, never blocks the response.
  ctx.waitUntil(sendConfirmation(env, record).catch(err => console.error('Confirmation failed', err)));

  return json(request, env, { ok: true, id: record.id });
}

/* ══════════════════ Cleaning and validation ══════════════════ */

const str = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
const money = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
};
const bool = (v) => v === true || v === 'true';

const TEXT_FIELDS = {
  vehicle: 200, residualBalloon: 120, tradeIn: 200,
  idNumber: 20, passportNumber: 40, citizenship: 40, countryOfResidence: 80, permitType: 80,
  langPref: 40, langOther: 60, ethnicGroup: 40,
  surname: 80, fullNames: 120, gender: 20, graduate: 10,
  cell: 40, homeTel: 40, email: 160, homeAddress: 300, suburb: 100, postalCode: 10,
  periodAtAddressYears: 4, periodAtAddressMonths: 4,
  maritalStatus: 20, dateMarried: 20, marriageType: 20,
  spouseSurname: 80, spouseFullNames: 120, spouseId: 20, spouseCell: 40, spouseDob: 20,
  rentProperty: 10, ownProperty: 10, bondedBank: 80, bondHolder: 20,
  employmentType: 40, selfEmployedNature: 200, companyName: 160, companyAddress: 300,
  companySuburb: 100, companyPostalCode: 10, landline: 40, hrNo: 40,
  occupation: 120, industry: 120, periodAtEmployerYears: 4, periodAtEmployerMonths: 4,
  salaryDate: 60, retrenchmentNotice: 10,
  otherIncomeSource: 160, settlementLetter: 10,
  accountHolder: 160, bankName: 80, branchCode: 20, accountNo: 40,
  accountType: 40, accountTypeOther: 60,
  relSurname: 80, relFullNames: 120, relAddress: 300, relCell: 40, relationship: 80,
  declarationExceptions: 2000, signedAt: 20, dateOfBirth: 20,
  page: 300, source: 300, submittedAt: 40
};

const EXPENSE_FIELDS = [
  'personalLoan', 'vehicleInstalments', 'policyInsurance', 'ratesWaterElectricity',
  'bondRent', 'creditCard', 'furnitureAccounts', 'clothingAccounts', 'overdraft',
  'telephone', 'transport', 'foodEntertainment', 'education', 'spousalChildSupport',
  'household', 'otherExpenses'
];

const MONEY_FIELDS = [
  'vehiclePrice', 'instalmentBudget', 'grossRemuneration', 'monthlyCommission', 'carAllowance',
  'netTakeHome', 'otherIncome', 'totalMonthlyIncome', 'propertyValue', 'outstandingBondValue',
  ...EXPENSE_FIELDS, 'totalMonthlyExpenses', 'monthlySurplus'
];

const BOOL_FIELDS = [
  'serviceFeeAck', 'creditBureauConsent',
  'nlrConsent', 'truthDeclaration', 'popiaConsent'
];

function sanitise(d) {
  const out = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) out[k] = str(d[k], max);
  for (const k of MONEY_FIELDS) out[k] = money(d[k]);
  for (const k of BOOL_FIELDS) out[k] = bool(d[k]);
  out.email = out.email.toLowerCase();
  out.age = Number.isFinite(+d.age) ? Math.trunc(+d.age) : null;
  out.declarationsConfirmed = Array.isArray(d.declarationsConfirmed)
    ? d.declarationsConfirmed.slice(0, 8).map(v => str(v, 2))
    : [];
  return out;
}

function validate(d) {
  const p = [];
  if (d.surname.length < 2)   p.push('surname');
  if (d.fullNames.length < 2) p.push('fullNames');
  if (d.cell.replace(/\D/g, '').length < 9) p.push('cell');
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) p.push('email');

  // A non-SA applicant may be applying on a passport instead.
  const hasSaId = /^\d{13}$/.test(d.idNumber) && luhnOk(d.idNumber);
  if (!hasSaId && !d.passportNumber) p.push('idNumber');

  if (!(d.instalmentBudget > 0)) p.push('instalmentBudget');
  if (!d.graduate) p.push('graduate');
  if (!d.periodAtAddressYears && !d.periodAtAddressMonths) p.push('periodAtAddress');
  if (!d.maritalStatus) p.push('maritalStatus');

  if (d.maritalStatus === 'Married') {
    if (d.spouseSurname.length < 2)   p.push('spouseSurname');
    if (d.spouseFullNames.length < 2) p.push('spouseFullNames');
    if (d.spouseCell.replace(/\D/g, '').length < 9) p.push('spouseCell');
    if (!d.spouseDob) p.push('spouseDob');
  }

  if (!d.ownProperty) p.push('ownProperty');
  if (d.ownProperty === 'Yes') {
    if (!(d.propertyValue > 0)) p.push('propertyValue');
    if (d.bondedBank.length < 2) p.push('bondedBank');
  }

  if (!d.periodAtEmployerYears && !d.periodAtEmployerMonths) p.push('periodAtEmployer');
  if (d.landline.replace(/\D/g, '').length < 9) p.push('landline');
  if (!d.salaryDate) p.push('salaryDate');
  if (d.companyAddress.length < 5) p.push('companyAddress');

  if (EXPENSE_FIELDS.reduce((s, k) => s + d[k], 0) <= 0) p.push('expenses');

  if (d.relSurname.length < 2)   p.push('relSurname');
  if (d.relFullNames.length < 2) p.push('relFullNames');
  if (d.relCell.replace(/\D/g, '').length < 9) p.push('relCell');

  if (!d.creditBureauConsent) p.push('creditBureauConsent');
  if (!d.truthDeclaration)    p.push('truthDeclaration');
  if (!d.popiaConsent)        p.push('popiaConsent');
  return p;
}

function luhnOk(s) {
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = parseInt(s[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** BB-250813-4F2A — short enough to read over the phone. */
function reference() {
  const d = new Date();
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(2)))
    .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `BB-${ymd}-${rnd}`;
}

/** Keeps the useful shape of an application without warehousing ID and bank numbers. */
function redact(r) {
  const tail = (v) => { const s = String(v || '').replace(/\s/g, ''); return s ? '••••' + s.slice(-4) : ''; };
  return {
    ...r,
    idNumber: tail(r.idNumber),
    passportNumber: tail(r.passportNumber),
    spouseId: tail(r.spouseId),
    accountNo: tail(r.accountNo)
  };
}

async function overRate(env, key) {
  if (!env.APPLICATIONS) return false;
  try {
    const n = parseInt(await env.APPLICATIONS.get(key) || '0', 10);
    if (n >= RATE_MAX) return true;
    await env.APPLICATIONS.put(key, String(n + 1), { expirationTtl: RATE_WINDOW });
  } catch {
    return false;   // never lock someone out because KV blipped
  }
  return false;
}

async function verifyTurnstile(env, token, request) {
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET);
    body.append('response', token);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) body.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const out = await res.json();
    return out.success === true;
  } catch (err) {
    console.error('Turnstile check failed open', err);
    return true;   // never block a real applicant because Cloudflare was slow
  }
}

/* ══════════════════ Attachments ══════════════════ */

function buildAttachments(raw, record) {
  const out = [];
  let bytes = 0;

  const sig = String(raw.signature || '');
  if (sig.startsWith('data:image/png;base64,')) {
    const content = sig.slice('data:image/png;base64,'.length);
    if (content.length < 2 * 1024 * 1024) {
      out.push({ filename: `signature-${record.surname || 'applicant'}.png`, content });
      bytes += content.length;
    }
  }

  const list = Array.isArray(raw.attachments) ? raw.attachments.slice(0, 20) : [];
  for (const f of list) {
    const content = String(f && f.content || '');
    if (!content) continue;
    if (bytes + content.length > MAX_ATTACH) {
      console.warn('Attachment limit reached — dropping', f.filename);
      break;
    }
    out.push({ filename: safeName(f.filename), content });
    bytes += content.length;
  }
  return out;
}

function safeName(name) {
  return String(name || 'document')
    .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '-')
    .slice(0, 100) || 'document';
}

/* ══════════════════ Email ══════════════════ */

async function sendEmail(env, r, attachments) {
  const to = (env.NOTIFY_EMAIL || 'nageljakes@gmail.com').split(',').map(s => s.trim()).filter(Boolean);
  const from = env.FROM_EMAIL || 'Finance Applications <onboarding@resend.dev>';
  const name = `${r.fullNames} ${r.surname}`.trim();

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to,
      // Email is optional now — an empty reply_to can cause Resend to
      // reject the whole request, so only send it when there's an address.
      ...(r.email ? { reply_to: r.email } : {}),
      subject: `Finance application — ${name}${r.vehicle ? ' — ' + r.vehicle : ''} [${r.id}]`,
      text: textBody(r),
      html: htmlBody(r),
      attachments
    })
  });

  if (!res.ok) {
    console.error('Resend error', res.status, await res.text());
    return false;
  }
  return true;
}

/** A short acknowledgement so the applicant knows it actually went through. */
async function sendConfirmation(env, r) {
  if (!env.RESEND_API_KEY || !r.email) return;
  const from = env.FROM_EMAIL || 'Nissan Gezina <onboarding@resend.dev>';
  const first = (r.fullNames || '').split(/\s+/)[0] || 'there';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [r.email],
      subject: `We have your finance application — ${r.id}`,
      text: [
        `Hi ${first},`,
        '',
        'Thank you — your finance application has reached our desk at Nissan Gezina.',
        '',
        `Reference:  ${r.id}`,
        `Vehicle:    ${r.vehicle || '—'}`,
        `Received:   ${new Date(r.receivedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}`,
        '',
        'One of our finance consultants will come back to you within one working day.',
        'Please keep your phone nearby — the banks sometimes call to verify a detail.',
        '',
        'For your security, this email does not repeat your ID or banking details.',
        '',
        'Nissan Gezina · BB Motor Group · FSP 49995'
      ].join('\n')
    })
  });
}

const R = (n) => {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-R ' : 'R ') + Math.abs(v).toLocaleString('en-ZA').replace(/,/g, ' ');
};
const dash = (v) => (v === 0 || v) && String(v).trim() !== '' ? v : '—';
const yn = (b) => (b ? 'Yes' : 'No');

/** Section definitions, shared by the text and HTML bodies. */
function sections(r) {
  const s = [];

  s.push(['Wish list', [
    ['Vehicle', dash(r.vehicle)],
    ['Vehicle price (RRP)', r.vehiclePrice ? R(r.vehiclePrice) : '—'],
    ['Instalment budget', r.instalmentBudget ? R(r.instalmentBudget) : '—'],
    ['Residual / balloon', dash(r.residualBalloon)],
    ['Trade-in', dash(r.tradeIn)]
  ]]);

  s.push(['Applicant', [
    ['ID number', dash(r.idNumber)],
    ['Passport', dash(r.passportNumber)],
    ['Date of birth', dash(r.dateOfBirth)],
    ['Age', dash(r.age)],
    ['Citizenship', dash(r.citizenship)],
    ['Country of residence', dash(r.countryOfResidence)],
    ['Permit type', dash(r.permitType)],
    ['Language', r.langOther || dash(r.langPref)],
    ['Population group', dash(r.ethnicGroup)],
    ['Surname', dash(r.surname)],
    ['Full names', dash(r.fullNames)],
    ['Gender', dash(r.gender)],
    ['Graduate', dash(r.graduate)],
    ['Cell', dash(r.cell)],
    ['Home tel', dash(r.homeTel)],
    ['Email', dash(r.email)],
    ['Home address', dash(r.homeAddress)],
    ['Suburb', dash(r.suburb)],
    ['Postal code', dash(r.postalCode)],
    ['Period at address', period(r.periodAtAddressYears, r.periodAtAddressMonths)]
  ]]);

  s.push(['Marital and property', [
    ['Marital status', dash(r.maritalStatus)],
    ['Date married', dash(r.dateMarried)],
    ['Regime', dash(r.marriageType)],
    ["Spouse's surname", dash(r.spouseSurname)],
    ["Spouse's full names", dash(r.spouseFullNames)],
    ["Spouse's contact number", dash(r.spouseCell)],
    ["Spouse's date of birth", dash(r.spouseDob)],
    ["Spouse's ID", dash(r.spouseId)],
    ['Rents the property', dash(r.rentProperty)],
    ['Owns property', dash(r.ownProperty)],
    ['Property value', r.propertyValue ? R(r.propertyValue) : '—'],
    ['Bonded by', dash(r.bondedBank)],
    ['Outstanding bond amount', r.ownProperty === 'Yes' ? R(r.outstandingBondValue) : '—'],
    ['Property in name of', dash(r.bondHolder)]
  ]]);

  s.push(['Employment', [
    ['Employment type', dash(r.employmentType)],
    ['Nature of business', dash(r.selfEmployedNature)],
    ['Company', dash(r.companyName)],
    ['Company address', dash(r.companyAddress)],
    ['Suburb', dash(r.companySuburb)],
    ['Postal code', dash(r.companyPostalCode)],
    ['Work contact number', dash(r.landline)],
    ['HR number', dash(r.hrNo)],
    ['Occupation', dash(r.occupation)],
    ['Industry', dash(r.industry)],
    ['Period at employer', period(r.periodAtEmployerYears, r.periodAtEmployerMonths)],
    ['Salary date', dash(r.salaryDate)],
    ['Retrenchment notice (6 months)', dash(r.retrenchmentNotice)]
  ]]);

  s.push(['Income (monthly)', [
    ['Gross remuneration', R(r.grossRemuneration)],
    ['Commission (incl. in gross)', R(r.monthlyCommission)],
    ['Car allowance (incl. in gross)', R(r.carAllowance)],
    ['Net take-home', R(r.netTakeHome)],
    ['Other income', R(r.otherIncome)],
    ['Source of other income', dash(r.otherIncomeSource)],
    ['TOTAL MONTHLY INCOME', R(r.totalMonthlyIncome)]
  ]]);

  s.push(['Expenses (monthly)', [
    ['Personal loans', R(r.personalLoan)],
    ['Vehicle instalments', R(r.vehicleInstalments)],
    ['Settlement letter may be drawn', dash(r.settlementLetter)],
    ['Policy / insurance', R(r.policyInsurance)],
    ['Rates, water, electricity', R(r.ratesWaterElectricity)],
    ['Bond / rent', R(r.bondRent)],
    ['Credit cards', R(r.creditCard)],
    ['Furniture accounts', R(r.furnitureAccounts)],
    ['Clothing accounts', R(r.clothingAccounts)],
    ['Overdraft', R(r.overdraft)],
    ['Telephone', R(r.telephone)],
    ['Transport', R(r.transport)],
    ['Food and entertainment', R(r.foodEntertainment)],
    ['Education', R(r.education)],
    ['Spousal / child support', R(r.spousalChildSupport)],
    ['Household', R(r.household)],
    ['Other', R(r.otherExpenses)],
    ['TOTAL MONTHLY EXPENSES', R(r.totalMonthlyExpenses)],
    ['SURPLUS BEFORE NEW INSTALMENT', R(r.monthlySurplus)]
  ]]);

  s.push(['Banking', [
    ['Account holder', dash(r.accountHolder)],
    ['Bank', dash(r.bankName)],
    ['Branch code', dash(r.branchCode)],
    ['Account number', dash(r.accountNo)],
    ['Account type', r.accountTypeOther || dash(r.accountType)]
  ]]);

  s.push(['Relative not living with applicant', [
    ['Surname', dash(r.relSurname)],
    ['Full names', dash(r.relFullNames)],
    ['Address', dash(r.relAddress)],
    ['Cell', dash(r.relCell)],
    ['Relationship', dash(r.relationship)]
  ]]);

  const missing = ['A','B','C','D','E','F','G','H'].filter(k => !r.declarationsConfirmed.includes(k));
  s.push(['Declarations', [
    ['Confirmed A–H', r.declarationsConfirmed.length === 8 ? 'All eight confirmed' : r.declarationsConfirmed.join(', ') || 'None'],
    ['NOT confirmed', missing.length ? missing.join(', ') : '—'],
    ['Details given', dash(r.declarationExceptions)],
    ['Monthly service fee understood', yn(r.serviceFeeAck)],
    ['Credit bureau enquiry consent', yn(r.creditBureauConsent)],
    ['NLR reporting consent', yn(r.nlrConsent)],
    ['Information declared true', yn(r.truthDeclaration)],
    ['POPIA processing consent', yn(r.popiaConsent)],
    ['Signed on', dash(r.signedAt)]
  ]]);

  // Banking is optional now and commonly left blank entirely — drop a section
  // rather than show a bare heading with nothing under it. Every other
  // section always has at least one required field, so this can't hide them.
  return s.filter(([, rows]) => rows.some(([, v]) => v !== '—'));
}

function period(y, m) {
  const yy = parseInt(y, 10) || 0, mm = parseInt(m, 10) || 0;
  if (!yy && !mm) return '—';
  return [yy ? yy + (yy === 1 ? ' year' : ' years') : '', mm ? mm + (mm === 1 ? ' month' : ' months') : '']
    .filter(Boolean).join(', ');
}

function textBody(r) {
  const out = [
    'INDIVIDUAL APPLICATION FOR FINANCE',
    `${r.fullNames} ${r.surname}`.trim(),
    `Reference: ${r.id}`,
    ''
  ];
  for (const [title, rows] of sections(r)) {
    out.push('─'.repeat(46), title.toUpperCase(), '');
    for (const [label, value] of rows) out.push(`${(label + ':').padEnd(34)}${value}`);
    out.push('');
  }
  out.push(
    '─'.repeat(46),
    `Received:  ${r.receivedAt}`,
    `Location:  ${[r.city, r.region, r.country].filter(Boolean).join(', ') || 'unknown'}`,
    `Source:    ${r.source || 'direct'}`,
    `Page:      ${r.page}`,
    '',
    'The applicant\'s signature and any supporting documents are attached.'
  );
  return out.join('\n');
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function htmlBody(r) {
  const name = esc(`${r.fullNames} ${r.surname}`.trim());
  const flags = [];
  if (r.retrenchmentNotice === 'Yes') flags.push('Retrenchment notice received in the last 6 months');
  if (r.monthlySurplus < 0) flags.push('Declared expenses exceed declared income');
  if (r.declarationsConfirmed.length < 8) flags.push('Not all declarations A–H were confirmed');

  const block = ([title, rows]) => `
    <h2 style="margin:28px 0 10px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#c3002f;font-weight:700;border-bottom:1px solid #eef1f4;padding-bottom:6px">${esc(title)}</h2>
    <table style="width:100%;border-collapse:collapse">
      ${rows.filter(([, v]) => v !== '—').map(([label, value]) => `
        <tr>
          <td style="padding:6px 16px 6px 0;color:#6b7783;font-size:13px;vertical-align:top;width:44%">${esc(label)}</td>
          <td style="padding:6px 0;color:#14181d;font-size:14px;font-weight:${/^[A-Z ]+$/.test(label) ? 700 : 500};white-space:pre-wrap">${esc(value)}</td>
        </tr>`).join('')}
    </table>`;

  return `<!doctype html><html><body style="margin:0;background:#f5f7f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<div style="max-width:680px;margin:24px auto;background:#fff;border:1px solid #dfe4e9;border-radius:14px;overflow:hidden">

  <div style="background:#c3002f;padding:22px 28px">
    <div style="color:#fff;font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;opacity:.85">Nissan Gezina &middot; BB Motor Group &middot; FSP 49995</div>
    <div style="color:#fff;font-size:21px;font-weight:700;margin-top:3px">Individual application for finance</div>
    <div style="color:#fff;font-size:15px;margin-top:6px;opacity:.9">${name} &middot; ${esc(r.id)}</div>
  </div>

  <div style="padding:20px 28px 8px">
    <table style="width:100%;border-collapse:collapse;background:#f5f7f9;border-radius:10px">
      <tr>
        <td style="padding:14px 16px;font-size:12px;color:#6b7783">Net income<div style="font-size:17px;color:#14181d;font-weight:700;margin-top:2px">${esc(R(r.totalMonthlyIncome))}</div></td>
        <td style="padding:14px 16px;font-size:12px;color:#6b7783">Expenses<div style="font-size:17px;color:#14181d;font-weight:700;margin-top:2px">${esc(R(r.totalMonthlyExpenses))}</div></td>
        <td style="padding:14px 16px;font-size:12px;color:#6b7783">Surplus<div style="font-size:17px;color:${r.monthlySurplus < 0 ? '#c0392b' : '#0f8a5f'};font-weight:700;margin-top:2px">${esc(R(r.monthlySurplus))}</div></td>
        <td style="padding:14px 16px;font-size:12px;color:#6b7783">Budget<div style="font-size:17px;color:#14181d;font-weight:700;margin-top:2px">${esc(r.instalmentBudget ? R(r.instalmentBudget) : '—')}</div></td>
      </tr>
    </table>

    ${flags.length ? `<div style="margin-top:14px;padding:12px 16px;background:#fffaf0;border-left:3px solid #e0a800;border-radius:8px">
      <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8a6d00;font-weight:700;margin-bottom:5px">Check before submitting to the banks</div>
      ${flags.map(f => `<div style="font-size:13px;color:#5c4a00;line-height:1.6">&bull; ${esc(f)}</div>`).join('')}
    </div>` : ''}

    <div style="margin-top:16px">
      <a href="tel:${esc(String(r.cell).replace(/[^\d+]/g, ''))}" style="display:inline-block;background:#c3002f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px;margin-right:6px">Call ${esc((r.fullNames || '').split(' ')[0])}</a>
      <a href="https://wa.me/${esc(String(r.cell).replace(/\D/g, '').replace(/^0/, '27'))}" style="display:inline-block;background:#f5f7f9;color:#14181d;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px;border:1px solid #dfe4e9${r.email ? ';margin-right:6px' : ''}">WhatsApp</a>
      ${r.email ? `<a href="mailto:${esc(r.email)}" style="display:inline-block;background:#f5f7f9;color:#14181d;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px;border:1px solid #dfe4e9">Email</a>` : ''}
    </div>
  </div>

  <div style="padding:0 28px 24px">
    ${sections(r).map(block).join('')}
  </div>

  <div style="padding:16px 28px;background:#fafcfd;border-top:1px solid #eef1f4;color:#8fa2b0;font-size:12px;line-height:1.7">
    Signature and supporting documents are attached to this email.<br>
    Received ${esc(r.receivedAt)}<br>
    ${esc([r.city, r.region, r.country].filter(Boolean).join(', ') || 'Location unknown')}<br>
    Ref ${esc(r.id)}
  </div>
</div></body></html>`;
}

/* ══════════════════ CORS ══════════════════ */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.length === 0 ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    ...(allowed.length ? { Vary: 'Origin' } : {})
  };
}

function json(request, env, obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) }
  });
}

function preflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
