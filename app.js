/* ==========================================================
   Nissan Gezina — Individual Application for Finance
   Front-end behaviour. No dependencies, no build step.
   ========================================================== */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════
     CONFIG — the only lines you should need to edit
     ══════════════════════════════════════════════════════ */
  const CONFIG = {
    // Cloudflare Worker that emails the application. See worker/README.md.
    endpoint: 'https://bbfinance.jaxtech.workers.dev/api/application',

    // Dealership contact details, used by the Call / WhatsApp buttons.
    phone:    '+27 61 511 7494',
    whatsapp: '27615117494',
    waGreeting: "Hi, I'm busy with the online finance application for Nissan Gezina."
  };
  /* ════════════════════════════════════════════════════ */

  const MAX_FILE_BYTES  = 4  * 1024 * 1024;   // per document
  const MAX_TOTAL_BYTES = 12 * 1024 * 1024;   // all documents together
  const DRAFT_KEY = 'bb_finance_draft_v1';

  // Deliberately never written to localStorage. A shared or stolen phone
  // should not carry someone's ID and bank account number around.
  const SENSITIVE = ['idNumber', 'spouseId', 'accountNo', 'idxAccountNumber', 'passportNumber'];

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const form     = $('#app-form');
  const steps    = $$('.step');
  const total    = steps.length;
  const intro    = $('#intro');
  const progress = $('#progress');
  const statusEl = $('#form-status');
  let current = 0;
  let files = [];

  /* ══════════ Helpers ══════════ */

  const num = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  const rand = (n) => {
    const v = Math.round(n);
    return (v < 0 ? '-R ' : 'R ') + Math.abs(v).toLocaleString('en-ZA').replace(/,/g, ' ');
  };

  const groupDigits = (v) => {
    const clean = String(v).replace(/[^\d.]/g, '');
    if (!clean) return '';
    const [whole, dec] = clean.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return dec != null ? grouped + '.' + dec.slice(0, 2) : grouped;
  };

  function setError(id, msg) {
    const el = $('#e-' + id);
    if (el) el.textContent = msg || '';
    const input = $('#f-' + id);
    if (input) input.classList.toggle('invalid', !!msg);
  }

  function clearErrors(scope) {
    $$('.err', scope).forEach(e => (e.textContent = ''));
    $$('.invalid', scope).forEach(e => e.classList.remove('invalid'));
  }

  /* ══════════ SA ID number ══════════
     13 digits: YYMMDD SSSS C A Z, with a Luhn check digit.
     Catching a typo here saves a rejected application later. */

  function luhnOk(s) {
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
      let d = parseInt(s[i], 10);
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  function parseSaId(id) {
    const s = String(id || '').replace(/\D/g, '');
    if (s.length !== 13) return { ok: false, reason: 'An SA ID number is 13 digits.' };

    const yy = +s.slice(0, 2), mm = +s.slice(2, 4), dd = +s.slice(4, 6);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      return { ok: false, reason: "That doesn't look right — check the date of birth in the first six digits." };
    }

    // Two-digit year: pick the century that puts the birthday in the past.
    const nowYY = new Date().getFullYear() % 100;
    const year = yy <= nowYY ? 2000 + yy : 1900 + yy;
    const dob = new Date(Date.UTC(year, mm - 1, dd));
    if (dob.getUTCMonth() !== mm - 1 || dob.getUTCDate() !== dd) {
      return { ok: false, reason: 'That date of birth does not exist.' };
    }

    if (!luhnOk(s)) return { ok: false, reason: "That ID number fails its check digit — please re-type it." };

    let age = new Date().getUTCFullYear() - year;
    const bMonth = mm - 1;
    const nowD = new Date();
    if (nowD.getUTCMonth() < bMonth || (nowD.getUTCMonth() === bMonth && nowD.getUTCDate() < dd)) age--;

    return {
      ok: true,
      dob: dob.toISOString().slice(0, 10),
      age,
      gender: +s[6] >= 5 ? 'Male' : 'Female',
      citizen: s[10] === '0' ? 'SA citizen' : 'Permanent resident'
    };
  }

  function wireIdNumber() {
    const el = $('#f-idNumber');
    const out = $('#id-derived');
    if (!el) return;

    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '').slice(0, 13);
      setError('idNumber', '');
      if (el.value.length < 13) { out.textContent = ''; return; }

      const r = parseSaId(el.value);
      if (!r.ok) { out.textContent = ''; setError('idNumber', r.reason); return; }

      out.textContent = `Born ${r.dob} · ${r.age} years old · ${r.gender} · ${r.citizen}`;

      // Fill gender for them, but never overwrite a choice already made.
      const g = form.querySelector(`input[name="gender"][value="${r.gender}"]`);
      if (g && !form.querySelector('input[name="gender"]:checked')) g.checked = true;

      if (r.age < 18) setError('idNumber', 'Applicants must be 18 or older to apply for credit.');
    });

    const sp = $('#f-spouseId');
    if (sp) sp.addEventListener('input', () => {
      sp.value = sp.value.replace(/\D/g, '').slice(0, 13);
      setError('spouseId', '');
      if (sp.value.length === 13) {
        const r = parseSaId(sp.value);
        if (!r.ok) setError('spouseId', r.reason);
      }
    });
  }

  /* ══════════ Money inputs and live totals ══════════ */

  function wireMoney() {
    $$('input[data-money]').forEach(el => {
      el.addEventListener('input', () => {
        const pos = el.selectionStart, before = el.value.length;
        el.value = groupDigits(el.value);
        // Keep the caret roughly where the applicant left it after regrouping.
        const shift = el.value.length - before;
        try { el.setSelectionRange(pos + shift, pos + shift); } catch (e) {}
        recalc();
      });
      el.addEventListener('blur', () => { el.value = groupDigits(el.value); recalc(); });
    });
  }

  function recalc() {
    const income = num($('#f-netTakeHome').value) + num($('#f-otherIncome').value);
    let expenses = 0;
    $$('input[data-expense]').forEach(el => { expenses += num(el.value); });

    const ti = $('#total-income'), te = $('#total-expenses'), ts = $('#total-surplus');
    if (ti) ti.textContent = rand(income);
    if (te) te.textContent = rand(expenses);

    if (ts) {
      const surplus = income - expenses;
      ts.textContent = rand(surplus);
      const card = $('#surplus-card');
      card.classList.toggle('negative', surplus < 0);
      $('#surplus-sub').textContent = surplus < 0
        ? 'your expenses exceed your income — please double-check'
        : 'income less expenses, before the new instalment';
    }
  }

  /* ══════════ Conditional sections ══════════ */

  function reveal(id, show) {
    const el = $('#rv-' + id);
    if (el) el.hidden = !show;
  }

  function wireConditionals() {
    const on = (name, fn) => {
      $$(`input[name="${name}"]`).forEach(el => el.addEventListener('change', fn));
      fn();
    };
    const val = (name) => {
      const el = form.querySelector(`input[name="${name}"]:checked`);
      return el ? el.value : '';
    };

    on('citizenship',    () => reveal('citizenship', val('citizenship') === 'Other'));
    on('langPref',       () => reveal('langPref',    val('langPref') === 'Other'));
    on('maritalStatus',  () => reveal('married',     val('maritalStatus') === 'Married'));
    on('ownProperty',    () => reveal('ownProperty', val('ownProperty') === 'Yes'));
    on('employmentType', () => reveal('selfEmployed', val('employmentType') === 'Self-employed'));
    on('accountType',    () => reveal('accountType', val('accountType') === 'Other'));

    const idxSame = $('#f-idxSameAccount');
    const syncIdx = () => { $('#rv-idx').hidden = idxSame.checked; };
    idxSame.addEventListener('change', syncIdx);
    syncIdx();

    // Echo the applicant's name into the IDX consent wording, so they can see
    // exactly whose statements they are authorising.
    const echo = () => {
      const n = [$('#f-fullNames').value, $('#f-surname').value].filter(Boolean).join(' ').trim();
      $('#idx-name-echo').textContent = n || 'the applicant';
    };
    ['f-fullNames', 'f-surname'].forEach(id => $('#' + id).addEventListener('input', echo));

    // Declarations: an unticked box means "this one isn't true for me",
    // which the bank needs explained rather than treated as an error.
    const decls = $$('#declarations input[type="checkbox"]');
    const syncDecl = () => {
      const missing = decls.filter(c => !c.checked).length;
      $('#decl-details-wrap').hidden = missing === 0;
    };
    decls.forEach(c => c.addEventListener('change', syncDecl));
    $('#tick-all').addEventListener('click', () => {
      decls.forEach(c => { c.checked = true; });
      syncDecl();
      saveDraft();
    });
    syncDecl();
  }

  /* ══════════ Signature pad ══════════ */

  const sig = { drawn: false, ctx: null, canvas: null, resize: () => {} };

  function initSignature() {
    const canvas = $('#sigpad');
    if (!canvas) return;
    sig.canvas = canvas;

    // The pad lives inside a hidden step until the applicant gets there, and a
    // hidden canvas measures zero — so this runs again on the way into step 9.
    function size() {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      // Re-sizing clears the canvas, so keep what was already drawn.
      const prev = sig.drawn ? canvas.toDataURL() : null;
      canvas.width  = Math.round(r.width  * dpr);
      canvas.height = Math.round(r.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#14181d';
      sig.ctx = ctx;
      if (prev) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height);
        img.src = prev;
      }
    }

    let drawing = false;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    };

    const start = (e) => {
      e.preventDefault();
      drawing = true;
      const { x, y } = pos(e);
      sig.ctx.beginPath();
      sig.ctx.moveTo(x, y);
    };
    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const { x, y } = pos(e);
      sig.ctx.lineTo(x, y);
      sig.ctx.stroke();
      if (!sig.drawn) {
        sig.drawn = true;
        canvas.parentElement.classList.add('signed');
        setError('signature', '');
      }
    };
    const end = () => { drawing = false; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    $('#sig-clear').addEventListener('click', () => {
      sig.ctx.clearRect(0, 0, canvas.width, canvas.height);
      sig.drawn = false;
      canvas.parentElement.classList.remove('signed');
    });

    sig.resize = size;
    size();
    window.addEventListener('resize', size);
  }

  /* ══════════ Supporting documents ══════════ */

  function wireFiles() {
    const input = $('#f-files');
    const zone  = $('#dropzone');
    const list  = $('#filelist');

    const kb = (b) => b < 1024 * 1024
      ? Math.round(b / 1024) + ' KB'
      : (b / 1024 / 1024).toFixed(1) + ' MB';

    function render() {
      list.innerHTML = '';
      files.forEach((f, i) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'fname';
        name.textContent = f.name;
        const size = document.createElement('span');
        size.className = 'fsize';
        size.textContent = kb(f.size);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = 'Remove';
        rm.addEventListener('click', () => { files.splice(i, 1); render(); });
        const right = document.createElement('span');
        right.style.cssText = 'display:flex;gap:.8rem;align-items:center;flex-shrink:0';
        right.append(size, rm);
        li.append(name, right);
        list.appendChild(li);
      });
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      $('#e-files').textContent = files.length
        ? (totalBytes > MAX_TOTAL_BYTES
            ? `That's ${kb(totalBytes)} in total — please remove some so it's under 12 MB.`
            : '')
        : '';
      $('.dz-label', zone).textContent = files.length
        ? `${files.length} document${files.length === 1 ? '' : 's'} attached — tap to add more`
        : 'Tap to choose files, or drag them here';
    }

    function add(fileList) {
      const rejected = [];
      Array.from(fileList).forEach(f => {
        if (f.size > MAX_FILE_BYTES) { rejected.push(`${f.name} is ${kb(f.size)} — the limit is 4 MB per file`); return; }
        if (files.some(x => x.name === f.name && x.size === f.size)) return;  // already added
        files.push(f);
      });
      render();
      if (rejected.length) $('#e-files').textContent = rejected.join('. ');
    }

    input.addEventListener('change', () => { add(input.files); input.value = ''; });

    ['dragenter', 'dragover'].forEach(ev =>
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', e => { if (e.dataTransfer) add(e.dataTransfer.files); });
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({
        filename: file.name,
        type: file.type || 'application/octet-stream',
        content: String(r.result).split(',')[1] || ''
      });
      r.onerror = () => reject(new Error('Could not read ' + file.name));
      r.readAsDataURL(file);
    });
  }

  /* ══════════ Collect ══════════ */

  function collect(withSignature) {
    const d = {};
    $$('input, textarea, select', form).forEach(el => {
      if (!el.name) return;
      if (el.type === 'radio') { if (el.checked) d[el.name] = el.value; }
      else if (el.type === 'checkbox') { d[el.name] = el.checked; }
      else if (el.type === 'file') { /* handled separately */ }
      else if (el.hasAttribute('data-money')) { d[el.name] = num(el.value); }
      else { d[el.name] = el.value.trim(); }
    });

    d.totalMonthlyIncome   = num($('#f-netTakeHome').value) + num($('#f-otherIncome').value);
    d.totalMonthlyExpenses = $$('input[data-expense]').reduce((s, el) => s + num(el.value), 0);
    d.monthlySurplus       = d.totalMonthlyIncome - d.totalMonthlyExpenses;

    const id = parseSaId(d.idNumber);
    if (id.ok) { d.dateOfBirth = id.dob; d.age = id.age; }

    d.declarationsConfirmed = ['A','B','C','D','E','F','G','H'].filter(k => d['decl' + k]);
    // Rasterising the pad is not free, and the draft never keeps it anyway.
    d.signature = (withSignature && sig.drawn) ? sig.canvas.toDataURL('image/png') : '';
    d.page = location.href;
    d.source = document.referrer || 'direct';
    d.submittedAt = new Date().toISOString();
    return d;
  }

  /* ══════════ Validation ══════════ */

  const RULES = {
    1: () => {
      if ($('#f-vehicle').value.trim().length < 2) return err('vehicle', 'Please tell us which vehicle you have in mind.');
    },
    2: () => {
      const v = $('#f-idNumber').value.trim();
      const citizen = form.querySelector('input[name="citizenship"]:checked');
      if (citizen && citizen.value === 'Other') {
        // A non-citizen may be applying on a passport, so don't force a 13-digit SA ID.
        if (!v && !$('#f-passportNumber').value.trim())
          return err('idNumber', 'Please give us an ID or passport number.');
        return;
      }
      if (!v) return err('idNumber', 'Your ID number is required.');
      const r = parseSaId(v);
      if (!r.ok) return err('idNumber', r.reason);
      if (r.age < 18) return err('idNumber', 'Applicants must be 18 or older to apply for credit.');
    },
    3: () => {
      if ($('#f-surname').value.trim().length < 2)   return err('surname', 'Please enter your surname.');
      if ($('#f-fullNames').value.trim().length < 2) return err('fullNames', 'Please enter your full names.');
      if ($('#f-cell').value.replace(/\D/g, '').length < 9) return err('cell', 'Please enter a valid cell number.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($('#f-email').value.trim()))
        return err('email', 'Please enter a valid email address.');
      if ($('#f-homeAddress').value.trim().length < 5) return err('homeAddress', 'Please enter your home address.');
      const sp = $('#f-spouseId');
      if (!$('#rv-married').hidden && sp.value.trim() && !parseSaId(sp.value).ok)
        return err('spouseId', "That spouse ID number doesn't check out.");
    },
    4: () => {
      if ($('#f-companyName').value.trim().length < 2) return err('companyName', "Please enter your employer's name.");
      if ($('#f-occupation').value.trim().length < 2)  return err('occupation', 'Please enter your occupation.');
      if (!form.querySelector('input[name="retrenchmentNotice"]:checked'))
        return err('retrenchmentNotice', 'Please answer the retrenchment question.');
    },
    5: () => {
      if (num($('#f-grossRemuneration').value) <= 0) return err('grossRemuneration', 'Please enter your gross monthly income.');
      if (num($('#f-netTakeHome').value) <= 0)       return err('netTakeHome', 'Please enter your net take-home pay.');
      if (num($('#f-netTakeHome').value) > num($('#f-grossRemuneration').value))
        return err('netTakeHome', 'Net pay cannot be more than gross — please check both figures.');
    },
    6: () => {},
    7: () => {
      if ($('#f-accountHolder').value.trim().length < 2) return err('accountHolder', "Please enter the account holder's name.");
      if ($('#f-bankName').value.trim().length < 2)      return err('bankName', 'Please enter your bank.');
      if ($('#f-accountNo').value.replace(/\D/g, '').length < 6) return err('accountNo', 'Please enter your account number.');
      if (!$('#f-idxConsent').checked) return err('idxConsent', 'We need this consent to request your statements.');
    },
    8: () => {
      if ($('#f-relSurname').value.trim().length < 2)   return err('relSurname', "Please enter the relative's surname.");
      if ($('#f-relFullNames').value.trim().length < 2) return err('relFullNames', "Please enter the relative's full names.");
      if ($('#f-relCell').value.replace(/\D/g, '').length < 9) return err('relCell', 'Please enter a valid cell number.');
    },
    9: () => {
      const decls = $$('#declarations input[type="checkbox"]');
      const anyUnticked = decls.some(c => !c.checked);
      if (anyUnticked && $('#f-declarationExceptions').value.trim().length < 4)
        return err('declarationExceptions', 'Please tell us briefly about the ones you left unticked.');

      const required = ['serviceFeeAck', 'creditBureauConsent', 'nlrConsent', 'truthDeclaration', 'popiaConsent'];
      if (required.some(n => !form.querySelector(`input[name="${n}"]`).checked)) {
        $('#e-consents').textContent = 'Please tick all five confirmations above — the banks require each one.';
        return 'consents';
      }
      if (!sig.drawn) return err('signature', 'Please sign in the box above.');
      const bytes = files.reduce((s, f) => s + f.size, 0);
      if (bytes > MAX_TOTAL_BYTES) return err('files', 'Please remove some documents — the total must be under 12 MB.');
    }
  };

  function err(field, msg) { setError(field, msg); return field; }

  function validateStep(i) {
    const stepNo = i + 1;
    clearErrors(steps[i]);
    $('#e-consents').textContent = '';
    const bad = RULES[stepNo] ? RULES[stepNo]() : null;
    if (bad) {
      const el = $('#f-' + bad) || $('#e-' + bad);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (el.focus) setTimeout(() => el.focus({ preventScroll: true }), 200);
      }
      statusEl.className = 'form-status error';
      statusEl.textContent = 'Just one thing to fix above.';
      return false;
    }
    statusEl.textContent = '';
    return true;
  }

  /* ══════════ Step navigation ══════════ */

  function show(i, skipValidation) {
    if (i > current && !skipValidation && !validateStep(current)) return;

    current = Math.max(0, Math.min(total - 1, i));
    steps.forEach((s, n) => s.classList.toggle('active', n === current));

    const pct = Math.round(((current) / (total - 1)) * 100);
    $('#progress-fill').style.width = pct + '%';
    $('#progress-label').textContent = `Step ${current + 1} of ${total} · ${steps[current].dataset.title}`;
    $('#progress-pct').textContent = pct + '%';

    $('#back-btn').style.visibility = current === 0 ? 'hidden' : 'visible';
    const last = current === total - 1;
    $('#next-btn').hidden = last;
    $('#submit-btn').hidden = !last;

    if (last) sig.resize();

    window.scrollTo({ top: 0, behavior: 'smooth' });
    saveDraft();
  }

  /* ══════════ Draft ══════════ */

  let saveTimer = null;

  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const d = collect(false);
        SENSITIVE.forEach(k => delete d[k]);
        delete d.signature;
        delete d.company_website;
        d.__step = current;
        localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
        const note = $('#save-note');
        note.textContent = 'Saved';
        note.classList.add('flash');
        setTimeout(() => { note.textContent = 'Saved on this device'; note.classList.remove('flash'); }, 1200);
      } catch (e) { /* private browsing — not worth interrupting anyone for */ }
    }, 500);
  }

  function loadDraft() {
    let d;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { return null; }
    if (!d) return null;

    $$('input, textarea, select', form).forEach(el => {
      if (!el.name || el.type === 'file' || !(el.name in d)) return;
      if (el.type === 'radio')         { el.checked = (d[el.name] === el.value); }
      else if (el.type === 'checkbox') { el.checked = !!d[el.name]; }
      else if (el.hasAttribute('data-money')) { el.value = d[el.name] ? groupDigits(String(d[el.name])) : ''; }
      else { el.value = d[el.name] == null ? '' : d[el.name]; }
    });
    return d;
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  /* ══════════ Contact links ══════════ */

  function wireContact() {
    const wa = 'https://wa.me/' + CONFIG.whatsapp.replace(/\D/g, '') +
               '?text=' + encodeURIComponent(CONFIG.waGreeting);
    $$('.js-whatsapp').forEach(a => { a.href = wa; });
    $$('.js-tel').forEach(a => { a.href = 'tel:' + CONFIG.phone.replace(/[^\d+]/g, ''); });
  }

  /* ══════════ Submit ══════════ */

  async function submit() {
    if (!validateStep(current)) return;

    const btn = $('#submit-btn');
    btn.disabled = true;
    btn.classList.add('loading');
    statusEl.className = 'form-status info';
    statusEl.textContent = files.length
      ? 'Sending your application and documents…'
      : 'Sending your application…';

    const data = collect(true);

    // Silent bot rejection — a real applicant never sees this field.
    if (data.company_website) { finishSuccess(null); return; }
    delete data.company_website;

    try {
      data.attachments = await Promise.all(files.map(readAsBase64));
    } catch (e) {
      data.attachments = [];
      statusEl.textContent = 'One of your documents could not be read — sending the rest.';
    }

    let ok = false, body = null;
    try {
      const ctrl = new AbortController();
      // Uploads over a slow mobile connection need room to breathe.
      const timer = setTimeout(() => ctrl.abort(), files.length ? 90000 : 25000);
      const res = await fetch(CONFIG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      ok = res.ok;
      try { body = await res.json(); } catch (e) {}
    } catch (e) {
      ok = false;
    }

    btn.disabled = false;
    btn.classList.remove('loading');

    if (ok) finishSuccess(body);
    else finishFailure(body);
  }

  function finishSuccess(body) {
    clearDraft();
    form.hidden = true;
    progress.hidden = true;
    $('#failure').hidden = true;
    $('#success').hidden = false;

    const first = ($('#f-fullNames').value || '').trim().split(/\s+/)[0];
    if (first) $('#success-title').textContent = `Thank you, ${first} — we have your application.`;
    if (body && body.id) $('#success-ref').textContent = 'Reference: ' + body.id;

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function finishFailure(body) {
    form.hidden = true;
    progress.hidden = true;
    $('#failure').hidden = false;
    if (body && body.error) {
      $('#failure p').textContent =
        body.error + ' Your answers are still saved on this device, so nothing is lost.';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ══════════ Boot ══════════ */

  function init() {
    wireContact();
    wireIdNumber();
    wireMoney();
    wireFiles();
    initSignature();

    $('#f-signedAt').value = new Date().toISOString().slice(0, 10);

    // Restore before wiring the conditionals: each of those runs its sync once
    // on setup, so it lands on whatever the draft put in the fields.
    const draft = loadDraft();
    if (draft) {
      $('#resume-note').hidden = false;
      $('#start-btn').textContent = 'Carry on where I left off';
    }

    wireConditionals();
    recalc();

    $('#start-btn').addEventListener('click', () => {
      intro.hidden = true;
      form.hidden = false;
      progress.hidden = false;
      show(draft && typeof draft.__step === 'number' ? draft.__step : 0, true);
    });

    $('#clear-draft').addEventListener('click', () => {
      clearDraft();
      location.reload();
    });

    $('#next-btn').addEventListener('click', () => show(current + 1));
    $('#back-btn').addEventListener('click', () => show(current - 1, true));
    $('#retry-btn').addEventListener('click', () => {
      $('#failure').hidden = true;
      form.hidden = false;
      progress.hidden = false;
      show(total - 1, true);
    });

    form.addEventListener('submit', e => { e.preventDefault(); submit(); });
    form.addEventListener('input', saveDraft);
    form.addEventListener('change', saveDraft);

    // Enter should advance rather than submit half a form.
    form.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && current < total - 1) {
        e.preventDefault();
        show(current + 1);
      }
    });

    // Clear a field's error the moment it's being fixed.
    form.addEventListener('input', e => {
      if (e.target.classList && e.target.classList.contains('invalid')) {
        e.target.classList.remove('invalid');
        const id = (e.target.id || '').replace(/^f-/, '');
        setError(id, '');
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
