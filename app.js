/* ECO-FAST web app: sign in, explore the model, submit jobs, view results. */
(function () {
  "use strict";
  const CFG = window.ECOFAST_CONFIG || {};
  const D = window.ECOFAST_DATA;
  const DEMO = !CFG.SUPABASE_URL || CFG.SUPABASE_URL === "DEMO";
  const SITE_URL = location.origin + location.pathname;
  const FEED_CSV = "data/feedstock_composition.csv";
  const $ = (id) => document.getElementById(id);

  let sb = null;
  let recovering = false;
  let jobsTimer = null;

  // ---------- state ----------
  const S = {
    page: "instructions",
    feedRows: null, feedError: null,      // { scenario: row }
    scenario: null,
    feedRate: String(D.DEFAULT_FEED_RATE.toFixed(2)),
    hours: String(D.DEFAULT_HOURS.toFixed(2)),
    zip: "",
    comp: {},                              // scenario -> { code: string }
    techSel: "HTL",
    costTab: "tech",
    costTech: "SHR",
    techCost: {},                          // code -> { c0, wsp, nlbr } strings
    cost: {},                              // key -> string
    jobNotes: "", jobsFilter: null,
  };

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const show = (el, on) => el.classList.toggle("hidden", !on);
  function msg(el, kind, text) { el.className = "msg " + kind; el.textContent = text; show(el, !!text); }
  function friendly(err) {
    const m = ((err && err.message) || String(err || "")).toLowerCase();
    if (m.includes("invalid login credentials")) return "Incorrect email or password.";
    if (m.includes("email not confirmed")) return "Please confirm your email first. Check your inbox for the link.";
    if (m.includes("already registered") || m.includes("already exists")) return "An account with this email already exists. Please log in.";
    if (m.includes("password should be") || m.includes("weak password")) return err.message;
    if (m.includes("rate limit")) return "Too many attempts. Please wait a few minutes and try again.";
    if (m.includes("demo mode")) return err.message;
    return "We could not complete your request. Please try again in a moment.";
  }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "Please wait..."; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  const decimalsFor = (v) => (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 2 : 5);
  const num = (s) => (s === "" || s == null ? NaN : Number(s));
  const same = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
  const info = (text) => `<div class="st-info">${esc(text)}</div>`;

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); if (row.some((x) => x !== "")) rows.push(row); row = []; cur = ""; }
      else cur += c;
    }
    row.push(cur); if (row.some((x) => x !== "")) rows.push(row);
    const head = rows.shift().map((h) => h.trim().replace(/^\uFEFF/, ""));
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? "" : r[i].trim()])));
  }
  async function loadFeed() {
    try {
      const res = await fetch(FEED_CSV, { cache: "no-store" });
      if (!res.ok) throw new Error("missing");
      const rows = parseCSV(await res.text());
      S.feedRows = {};
      rows.forEach((r) => {
        const o = { Scenario: r.Scenario };
        Object.keys(r).forEach((k) => { if (k !== "Scenario") o[k] = Number(r[k]); });
        S.feedRows[r.Scenario] = o;
      });
    } catch (e) { S.feedError = true; S.feedRows = {}; }
  }
  const scenarios = () => Object.keys(S.feedRows || {}).sort();

  // ---------- feed math (same as populate_feed() in the notebook / app.py) ----------
  function wetBasis(f) {
    const dry = { CBH: f["Carbohydrate (%)"], PRT: f["Protein (%)"], FAT: f["Lipid (%)"], ASH: f["Ash (%)"], FC: f["Fixed carbon (%)"] };
    dry.OTH = f["Volatile matter (%)"] - dry.CBH - dry.PRT - dry.FAT;
    const xmc = f["Moisture (%)"] / 100;
    const sol = {}; Object.keys(dry).forEach((c) => { sol[c] = dry[c] / 100 * (1 - xmc); });
    const total = Object.values(sol).reduce((a, b) => a + b, 0);
    const scale = (1 - xmc) / total;
    Object.keys(sol).forEach((c) => { sol[c] *= scale; });
    sol.WATER = xmc;
    return sol;
  }
  function feedStats(f) {
    return { hhv: f["HHV (MJ/kg)"], moisture: f["Moisture (%)"], vm: f["Volatile matter (%)"], cn: (f["C (%)"] / 12.011) / (f["N (%)"] / 14.01) };
  }
  function compDefaults(sc) {
    const w = wetBasis(S.feedRows[sc]); const out = {};
    D.FEED_COMPONENTS.forEach(([c]) => { out[c] = Number(w[c].toFixed(4)); });
    return out;
  }
  function compState(sc) {
    if (!S.comp[sc]) { const d = compDefaults(sc); S.comp[sc] = {}; Object.keys(d).forEach((c) => { S.comp[sc][c] = d[c].toFixed(4); }); }
    return S.comp[sc];
  }

  // ---------- cost state ----------
  const costRows = () => D.GLOBAL_COST_ASSUMPTIONS.concat(D.PRODUCT_PRICES, D.DISPOSAL_COSTS);
  function costVal(key, def) { if (!(key in S.cost)) S.cost[key] = Number(def).toFixed(decimalsFor(def)); return S.cost[key]; }
  function techCostVal(code) {
    const p = D.TECH_COST_PARAMS[code];
    if (!S.techCost[code]) S.techCost[code] = { c0: p.c0.toFixed(0), wsp: p.wsp.toFixed(3), nlbr: p.nlbr.toFixed(3) };
    return S.techCost[code];
  }

  // Everything the user changed from the model defaults, for the job and for display
  function collectChanges() {
    const changes = [], costOverrides = {}, techOverrides = {}, compChanged = [];
    if (S.scenario) {
      const d = compDefaults(S.scenario), c = compState(S.scenario);
      D.FEED_COMPONENTS.forEach(([code, label]) => {
        if (!same(num(c[code]), d[code])) { compChanged.push(code); changes.push({ label: "Composition: " + label, value: c[code], default: d[code].toFixed(4) }); }
      });
    }
    costRows().forEach(([label, key, def, unit]) => {
      if (key in S.cost && !same(num(S.cost[key]), def)) { costOverrides[key] = num(S.cost[key]); changes.push({ label: label + (unit ? " (" + unit + ")" : ""), value: S.cost[key], default: String(def) }); }
    });
    Object.keys(S.techCost).forEach((code) => {
      const p = D.TECH_COST_PARAMS[code], t = S.techCost[code], o = {};
      [["c0", "reference purchase cost ($)"], ["wsp", "specific power"], ["nlbr", "labor requirement"]].forEach(([k, lab]) => {
        if (!same(num(t[k]), p[k])) { o[k] = num(t[k]); changes.push({ label: code + " " + lab, value: t[k], default: String(p[k]) }); }
      });
      if (Object.keys(o).length) techOverrides[code] = o;
    });
    return { changes, costOverrides, techOverrides, compChanged };
  }

  // ---------- auth screens ----------
  function setAuthView(view) {
    ["login", "signup", "forgot", "newpw"].forEach((v) => show($("form-" + v), v === view));
    $("auth-h").textContent = { login: "Welcome Back", signup: "Create an account", forgot: "Reset your password", newpw: "Set a new password" }[view];
    $("auth-sub").textContent = { login: "Sign in to access ECO-FAST.", signup: "It takes a minute. We will email you a link to confirm.", forgot: "Enter your email and we will send you a link to set a new password.", newpw: "Choose a new password for your account." }[view];
    msg($("auth-msg"), "", "");
  }
  function showAuth(view) { show($("app"), false); show($("auth"), true); setAuthView(view || "login"); stopJobsTimer(); }
  function showApp(session) {
    show($("auth"), false); show($("app"), true);
    const meta = session.user.user_metadata || {};
    $("user-name").textContent = meta.full_name || session.user.email;
    goPage("instructions");
  }
  let shownUser = null;
  function render(session) {
    if (recovering) return showAuth("newpw");
    if (session) {
      if (shownUser === session.user.id && !$("app").classList.contains("hidden")) return;
      shownUser = session.user.id; showApp(session);
    } else { shownUser = null; showAuth("login"); }
  }

  function wireAuth() {
    document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => setAuthView(b.dataset.goto)));

    $("form-login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("li-email").value.trim(), pw = $("li-pw").value, btn = e.target.querySelector("button[type=submit]");
      if (!email || !pw) return msg($("auth-msg"), "error", "Please enter your email and password.");
      busy(btn, true, "Signing in...");
      const { error } = await sb.auth.signInWithPassword({ email, password: pw });
      busy(btn, false);
      if (error) msg($("auth-msg"), "error", friendly(error));
    });

    $("form-signup").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("su-name").value.trim(), org = $("su-org").value.trim(), email = $("su-email").value.trim();
      const pw = $("su-pw").value, pw2 = $("su-pw2").value, btn = e.target.querySelector("button[type=submit]");
      if (!name || !email || !pw) return msg($("auth-msg"), "error", "Name, email and password are required.");
      if (pw.length < 8) return msg($("auth-msg"), "error", "Password must be at least 8 characters.");
      if (pw !== pw2) return msg($("auth-msg"), "error", "Passwords do not match.");
      busy(btn, true, "Creating account...");
      const { data, error } = await sb.auth.signUp({ email, password: pw,
        options: { data: { full_name: name, organization: org }, emailRedirectTo: SITE_URL } });
      busy(btn, false);
      if (error) return msg($("auth-msg"), "error", friendly(error));
      if (!data || !data.session) msg($("auth-msg"), "success", "Account created. Check your email for a confirmation link, then log in.");
    });

    $("form-forgot").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("fp-email").value.trim(), btn = e.target.querySelector("button[type=submit]");
      if (!email) return msg($("auth-msg"), "error", "Please enter your email.");
      busy(btn, true, "Sending...");
      await sb.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL });
      busy(btn, false);
      msg($("auth-msg"), "info", "If that email has an account, a reset link is on its way.");
    });

    $("form-newpw").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pw = $("np-pw").value, pw2 = $("np-pw2").value, btn = e.target.querySelector("button[type=submit]");
      if (pw.length < 8) return msg($("auth-msg"), "error", "Password must be at least 8 characters.");
      if (pw !== pw2) return msg($("auth-msg"), "error", "Passwords do not match.");
      busy(btn, true, "Saving...");
      const { error } = await sb.auth.updateUser({ password: pw });
      busy(btn, false);
      if (error) return msg($("auth-msg"), "error", friendly(error));
      recovering = false;
      const { data } = await sb.auth.getSession();
      render(data.session);
    });

    $("btn-signout").addEventListener("click", async () => { await sb.auth.signOut(); });
  }

  // ---------- navigation ----------
  const PAGES = [["instructions", "Instructions"], ["feed", "Feed Inputs"], ["tech", "Technology Specifications"], ["cost", "Cost Specifications"], ["results", "Results"], ["ej", "Environmental Justice"]];
  function renderNav() {
    const resultsActive = S.page === "results" || S.page.startsWith("sub:");
    let html = "";
    PAGES.forEach(([id, label]) => {
      html += `<button type="button" data-page="${id}" class="${S.page === id ? "active" : ""}"><span class="radio"></span>${esc(label)}</button>`;
      if (id === "results" && resultsActive) {
        D.RESULTS_SUBVIEWS.forEach((sv) => {
          const pid = "sub:" + sv;
          html += `<button type="button" data-page="${esc(pid)}" class="sub ${S.page === pid ? "active" : ""}"><span class="radio"></span>${esc(sv)}</button>`;
        });
      }
    });
    $("sidenav").innerHTML = html;
    $("sidenav").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => goPage(b.dataset.page)));
  }
  function goPage(page) {
    S.page = page;
    renderNav();
    const box = page.startsWith("sub:") ? "sub" : page;
    ["instructions", "feed", "tech", "cost", "results", "sub", "ej"].forEach((p) => show($("page-" + p), p === box));
    stopJobsTimer();
    if (page === "feed") renderFeed();
    else if (page === "tech") renderTech();
    else if (page === "cost") renderCost();
    else if (page === "results") { renderResults(); jobsTimer = setInterval(loadJobs, 60000); }
    else if (page.startsWith("sub:")) { renderRun(page.slice(4)); jobsTimer = setInterval(loadJobs, 60000); }
    else if (page === "ej") renderPlaceholder($("page-ej"), "Environmental Justice");
    window.scrollTo(0, 0);
  }
  function stopJobsTimer() { if (jobsTimer) clearInterval(jobsTimer); jobsTimer = null; }
  function renderPlaceholder(el, name) {
    el.innerHTML = `<div class="page-head"><h2>${esc(name)}</h2></div>${info(name + ": coming soon.")}`;
  }

  // ---------- Feed Inputs ----------
  function renderFeed() {
    const el = $("page-feed");
    let html = `<div class="page-head"><h2>Feed Inputs</h2></div>
      <p class="lead">Select the food waste type you are working with, then review the stream details below. Everything here is propagated through the model and carries through to the Results.</p>
      <h3 class="sub-title">Food Waste Type</h3>`;
    if (S.feedError) {
      el.innerHTML = html + info("The feedstock data file could not be loaded. Please contact the site team.");
      return;
    }
    html += `<select id="f-scenario" class="input select"><option value="">Select a food waste type...</option>${scenarios().map((s) => `<option ${s === S.scenario ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
    if (!S.scenario) {
      el.innerHTML = html + info("Please select a food waste type to continue.");
      $("f-scenario").addEventListener("change", (e) => { S.scenario = e.target.value || null; renderFeed(); });
      return;
    }
    const comp = compState(S.scenario), st = feedStats(S.feedRows[S.scenario]);
    html += `<div class="st-card">
      <div class="two-col">
        <div>
          <h3 class="sub-title">Feed Stream Conditions</h3>
          <div class="pair">
            <div class="field"><label for="f-rate">Feed rate (kg/hr)</label><input id="f-rate" class="input" type="number" min="0" step="100" value="${esc(S.feedRate)}"></div>
            <div class="field"><label for="f-hours">Operating hours (hr/yr)</label><input id="f-hours" class="input" type="number" min="0" max="8760" step="10" value="${esc(S.hours)}"></div>
          </div>
          <h3 class="sub-title">Facility Location</h3>
          <input id="f-zip" class="input" inputmode="numeric" maxlength="5" placeholder="e.g. 08028" value="${esc(S.zip)}">
          <p class="caption">Enter a zip code to enable the Environmental Justice assessment.</p>
          <h3 class="sub-title">Composition (wet basis)</h3>
          <button type="button" class="btn" id="f-reset">&#8634; Reset to this feedstock's typical composition</button>
          <div class="pair comp">${D.FEED_COMPONENTS.map(([code, label]) => `
            <div class="field"><label for="c-${code}">${esc(label)}</label><input id="c-${code}" data-code="${code}" class="input comp-in" type="number" min="0" max="1" step="0.001" value="${esc(comp[code])}"></div>`).join("")}
          </div>
          <div id="f-total"></div>
        </div>
        <div>
          <h3 class="sub-title">Energy &amp; Organic Content</h3>
          <div class="metrics">
            <div class="metric"><div class="m-label">HHV, dry (MJ/kg)</div><div class="m-val">${st.hhv.toFixed(2)}</div></div>
            <div class="metric"><div class="m-label">Moisture (%)</div><div class="m-val">${st.moisture.toFixed(2)}</div></div>
            <div class="metric"><div class="m-label">VM, dry (%)</div><div class="m-val">${st.vm.toFixed(2)}</div></div>
            <div class="metric"><div class="m-label">C:N ratio (molar)</div><div class="m-val">${st.cn.toFixed(1)}</div></div>
          </div>
          <h3 class="sub-title">Composition Breakdown</h3>
          <div id="f-donut" class="donut-wrap"></div>
        </div>
      </div>
      <p class="caption">Feed rate and operating hours scale the cost and emissions totals; composition drives the mass balance through each technology.</p>
    </div>`;
    el.innerHTML = html;

    $("f-scenario").addEventListener("change", (e) => { S.scenario = e.target.value || null; renderFeed(); });
    $("f-rate").addEventListener("input", (e) => { S.feedRate = e.target.value; updateSummary(); });
    $("f-hours").addEventListener("input", (e) => { S.hours = e.target.value; });
    $("f-zip").addEventListener("input", (e) => { S.zip = e.target.value.trim(); });
    $("f-reset").addEventListener("click", () => { delete S.comp[S.scenario]; renderFeed(); });
    el.querySelectorAll(".comp-in").forEach((inp) => inp.addEventListener("input", () => { comp[inp.dataset.code] = inp.value; updateFeedDerived(); }));
    updateFeedDerived();
  }

  function updateFeedDerived() {
    const comp = compState(S.scenario);
    const vals = D.FEED_COMPONENTS.map(([code]) => Math.max(0, num(comp[code]) || 0));
    const total = vals.reduce((a, b) => a + b, 0);
    $("f-total").innerHTML = Math.abs(total - 1) < 0.005
      ? `<p class="caption">Total mass fraction: <b>${total.toFixed(4)}</b> (closes to 1.0)</p>`
      : `<div class="st-warn">Total mass fraction: <b>${total.toFixed(4)}</b>. It should sum to 1.0; adjust the values above.</div>`;
    $("f-donut").innerHTML = donut(D.FEED_COMPONENTS.map(([, label, color], i) => ({ label, color, value: vals[i] * 100 })), S.scenario);
    updateSummary();
  }

  function donut(items, center) {
    const total = items.reduce((a, b) => a + b.value, 0) || 1;
    const R = 70, C = 2 * Math.PI * R; let off = 0;
    const arcs = items.map((it) => {
      const len = it.value / total * C;
      const a = `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${it.color}" stroke-width="34" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"><title>${esc(it.label)}: ${it.value.toFixed(2)}%</title></circle>`;
      off += len; return a;
    }).join("");
    return `<svg viewBox="0 0 200 200" class="donut" role="img" aria-label="Composition breakdown">${arcs}
      <text x="100" y="104" text-anchor="middle" class="donut-center">${esc(center)}</text></svg>
      <ul class="legend">${items.map((it) => `<li><span class="sw" style="background:${it.color}"></span>${esc(it.label)}: ${it.value.toFixed(2)}%</li>`).join("")}</ul>`;
  }

  function updateSummary() {
    const el = $("j-summary"); if (!el) return;
    const { changes } = collectChanges();
    el.textContent = changes.length ? changes.length + (changes.length === 1 ? " value changed" : " values changed") + " from the model defaults." : "Using the model defaults for this food waste type.";
  }

  async function submitJob(objective) {
    const out = $("j-msg"), btn = $("j-submit");
    const title = S.scenario + ", " + objective;
    const fr = num(S.feedRate), hr = num(S.hours);
    const comp = compState(S.scenario);
    const vals = {}; let total = 0, badComp = false;
    D.FEED_COMPONENTS.forEach(([code]) => { const v = num(comp[code]); if (!isFinite(v) || v < 0 || v > 1) badComp = true; vals[code] = v; total += v || 0; });
    let err = "";
    if (!S.scenario) err = "Select a food waste type in Feed Inputs first.";
    else if (!isFinite(fr) || fr <= 0) err = "Feed rate must be a positive number.";
    else if (!isFinite(hr) || hr < 0 || hr > 8760) err = "Operating hours must be between 0 and 8760.";
    else if (S.zip && !/^\d{5}$/.test(S.zip)) err = "Facility zip code must be 5 digits.";
    else if (badComp) err = "Each composition value must be between 0 and 1.";
    else if (Math.abs(total - 1) >= 0.005) err = "The composition must sum to 1.0 before you can submit.";
    const { changes, costOverrides, techOverrides, compChanged } = collectChanges();
    if (!err && costRows().some(([, key]) => key in S.cost && !isFinite(num(S.cost[key])))) err = "A value in Cost Specifications is not a number.";
    if (err) { msg(out, "error", err); return; }

    const { data: s } = await sb.auth.getSession();
    busy(btn, true, "Submitting...");
    const { error } = await sb.from("jobs").insert({
      title, scenario: S.scenario, notes: S.jobNotes.trim() || null,
      user_email: s.session.user.email,
      user_name: (s.session.user.user_metadata || {}).full_name || null,
      inputs: {
        objective, scenario: S.scenario, feed_rate_kgph: fr, operating_hours: hr, facility_zip: S.zip || null,
        composition_wet: vals, composition_default: compDefaults(S.scenario), composition_changed: compChanged,
        cost_overrides: costOverrides, tech_cost_overrides: techOverrides, changes,
      },
    }).select().single();
    busy(btn, false);
    if (error) return msg(out, "error", friendly(error));
    S.jobNotes = "";
    renderRun(objective, true);
  }

  // ---------- Technology Specifications ----------
  function renderTech() {
    const el = $("page-tech");
    const cards = D.TECH_SUMMARIES.map(([code, desc]) => `
      <div class="tcard" style="border-left-color:${D.TECH_COLOR[code]}"><div class="tc-name">${esc(D.TECH_NAMES[code])}</div><div class="tc-desc">${esc(desc)}</div></div>`).join("");
    el.innerHTML = `<div class="page-head"><h2>Technology Specifications</h2></div>
      <p class="lead">These are the treatment technologies the model is allowed to choose from. Each one can take a fractional share of the waste stream.</p>
      <div class="tgrid">${cards}</div>
      <h3 class="sub-title big">Process Parameters</h3>
      <label class="field-l" for="t-sel">Choose a technology</label>
      <select id="t-sel" class="input select">${Object.keys(D.TECH_DETAILS).map((c) => `<option value="${c}" ${c === S.techSel ? "selected" : ""}>${esc(D.TECH_NAMES[c])}</option>`).join("")}</select>
      <div class="st-card" id="t-detail"></div>
      <p class="caption">Pretreatment (shredding, maceration, aerobic, enzymatic) and Recovery &amp; Upgrading (centrifuge, filter, amine scrubbing, PSA, steam turbine) technologies aren't broken out here yet.</p>`;
    const draw = () => {
      const c = S.techSel;
      $("t-detail").innerHTML = `<div class="t-head" style="border-left-color:${D.TECH_COLOR[c]}">${esc(D.TECH_NAMES[c])} (${c})</div>
        <table class="st-table"><thead><tr><th>Parameter</th><th>Value</th><th>Unit / note</th></tr></thead><tbody>
        ${D.TECH_DETAILS[c].map(([p, v, u]) => `<tr><th>${esc(p)}</th><td>${esc(v)}</td><td>${esc(u)}</td></tr>`).join("")}</tbody></table>`;
    };
    $("t-sel").addEventListener("change", (e) => { S.techSel = e.target.value; draw(); });
    draw();
  }

  // ---------- Cost Specifications ----------
  function renderCost() {
    const el = $("page-cost");
    const tabs = [["tech", "Technology capital & labor"], ["global", "Global assumptions"], ["prices", "Product prices & fees"], ["disposal", "Disposal costs"]];
    el.innerHTML = `<div class="page-head"><h2>Cost Specifications</h2></div>
      <p class="lead">These are the cost, revenue, and disposal assumptions driving the model: equipment costs, labor rates, utility prices, product revenue, and disposal fees. Adjust any of them below to test your own assumptions. Your changes are included when you run an optimization from Results.</p>
      <div class="st-tabs">${tabs.map(([id, l]) => `<button type="button" data-tab="${id}" class="${S.costTab === id ? "active" : ""}">${esc(l)}</button>`).join("")}</div>
      <div id="cost-body"></div>`;
    el.querySelectorAll(".st-tabs button").forEach((b) => b.addEventListener("click", () => { S.costTab = b.dataset.tab; renderCost(); }));
    const body = $("cost-body");
    if (S.costTab === "tech") {
      const code = S.costTech, p = D.TECH_COST_PARAMS[code], t = techCostVal(code);
      const color = D.TECH_COLOR[code] || "#898781";
      body.innerHTML = `<label class="field-l" for="ct-sel">Technology</label>
        <select id="ct-sel" class="input select">${Object.keys(D.TECH_COST_PARAMS).map((c) => `<option value="${c}" ${c === code ? "selected" : ""}>${esc(D.ALL_TECH_NAMES[c])} (${esc(D.TECH_COST_PARAMS[c].stage)})</option>`).join("")}</select>
        <div class="tcard wide" style="border-left-color:${color}"><div class="tc-name">${esc(D.ALL_TECH_NAMES[code])} (${code})</div><div class="tc-desc">${esc(p.stage)}</div></div>
        <div class="pair">
          <div class="field"><label for="ct-c0">Reference purchase cost ($)</label><input id="ct-c0" data-k="c0" class="input tc-in" type="number" step="1000" value="${esc(t.c0)}"></div>
          <div class="field"><label>Reference capacity</label><input class="input" disabled value="${esc(String(p.q0) + " " + p.q0_unit)}"></div>
          <div class="field"><label for="ct-wsp">Specific power (kW per unit capacity)</label><input id="ct-wsp" data-k="wsp" class="input tc-in" type="number" step="0.01" value="${esc(t.wsp)}"></div>
          <div class="field"><label for="ct-nlbr">Labor requirement (operators per unit capacity)</label><input id="ct-nlbr" data-k="nlbr" class="input tc-in" type="number" step="0.01" value="${esc(t.nlbr)}"></div>
        </div>
        <p class="caption">Purchase cost scales from the reference point by the six-tenths rule: cost = C0 &times; (capacity / reference capacity) ^ 0.67.</p>`;
      $("ct-sel").addEventListener("change", (e) => { S.costTech = e.target.value; renderCost(); });
      body.querySelectorAll(".tc-in").forEach((inp) => inp.addEventListener("input", () => { t[inp.dataset.k] = inp.value; }));
    } else {
      const rows = S.costTab === "global" ? D.GLOBAL_COST_ASSUMPTIONS : S.costTab === "prices" ? D.PRODUCT_PRICES : D.DISPOSAL_COSTS;
      body.innerHTML = `<div class="pair">${rows.map(([label, key, def, unit, note]) => `
        <div class="field"><label for="cp-${key}">${esc(unit ? label + " (" + unit + ")" : label)}${note ? ` <span class="help" title="${esc(note)}">?</span>` : ""}</label>
        <input id="cp-${key}" data-k="${key}" class="input cp-in" type="number" step="any" value="${esc(costVal(key, def))}"></div>`).join("")}</div>`;
      body.querySelectorAll(".cp-in").forEach((inp) => inp.addEventListener("input", () => { S.cost[inp.dataset.k] = inp.value; }));
    }
  }

  // ---------- Results ----------
  function renderResults() {
    const el = $("page-results");
    el.innerHTML = `<div class="page-head"><h2>Results</h2></div>
      <p class="lead">Choose a pathway to view its results.</p>
      <div class="sub-btns">${D.RESULTS_SUBVIEWS.map((sv) => `<button type="button" class="btn st-btn" data-sub="${esc(sv)}">${esc(sv)}</button>`).join("")}</div>
      <div class="jobs-head"><h3 class="sub-title big">All your runs</h3><button class="btn" type="button" id="btn-refresh">Refresh</button></div>
      <p class="caption" style="margin-top:0">Each run is solved by our team. Result files appear here when they are ready.</p>
      <div class="card"><div class="table-wrap" id="jobs-table"></div></div>`;
    el.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", () => goPage("sub:" + b.dataset.sub)));
    $("btn-refresh").addEventListener("click", loadJobs);
    S.jobsFilter = null;
    loadJobs();
  }

  function renderRun(objective, justSubmitted) {
    const el = $("page-sub");
    let html = `<div class="page-head"><h2>${esc(objective)}</h2></div>`;
    if (justSubmitted) html += `<div class="st-success">Your optimization run was submitted. Our team will run it and the result files will appear below when they are ready.</div>`;
    if (!S.scenario) {
      html += info("Select a food waste type in Feed Inputs to run the optimization.");
    } else {
      const { changes } = collectChanges();
      html += `<div class="st-card">
        <h3 class="sub-title" style="margin-top:0">Run the optimization</h3>
        <p class="caption" style="margin-top:0">The model will find the ${esc(objective.toLowerCase())} for your inputs. Review them, then click Run optimization.</p>
        <table class="st-table summary"><tbody>
          <tr><th>Food waste type</th><td>${esc(S.scenario)}</td></tr>
          <tr><th>Feed rate</th><td>${esc(S.feedRate)} kg/hr</td></tr>
          <tr><th>Operating hours</th><td>${esc(S.hours)} hr/yr</td></tr>
          <tr><th>Facility zip code</th><td>${esc(S.zip || "not given")}</td></tr>
          <tr><th>Changes from model defaults</th><td>${changes.length ? `<ul class="chg">${changes.map((c) => `<li>${esc(c.label)}: ${esc(c.value)} (default ${esc(c.default)})</li>`).join("")}</ul>` : "None"}</td></tr>
        </tbody></table>
        <p class="caption">To change these, go back to Feed Inputs or Cost Specifications.</p>
        <div class="field"><label for="j-notes">Notes for our team (optional)</label><textarea id="j-notes" class="input" maxlength="2000">${esc(S.jobNotes)}</textarea></div>
        <button class="btn btn-blue" type="button" id="j-submit">Run optimization</button>
        <div id="j-msg" class="msg hidden" role="alert"></div>
      </div>`;
    }
    html += `<div class="jobs-head"><h3 class="sub-title big">Your runs</h3><button class="btn" type="button" id="btn-refresh">Refresh</button></div>
      <div class="card"><div class="table-wrap" id="jobs-table"></div></div>`;
    el.innerHTML = html;
    if ($("j-submit")) {
      $("j-notes").addEventListener("input", (e) => { S.jobNotes = e.target.value; });
      $("j-submit").addEventListener("click", () => submitJob(objective));
    }
    $("btn-refresh").addEventListener("click", loadJobs);
    S.jobsFilter = objective;
    loadJobs();
    window.scrollTo(0, 0);
  }

  const STATUS = { submitted: "Submitted", running: "In progress", done: "Results ready", failed: "Could not complete" };
  async function loadJobs() {
    const box = $("jobs-table"); if (!box) return;
    if (!box.innerHTML) box.innerHTML = '<div class="empty">Loading your jobs...</div>';
    let { data, error } = await sb.from("jobs").select("*").order("created_at", { ascending: false });
    if (error) { box.innerHTML = '<div class="empty">' + esc(friendly(error)) + "</div>"; return; }
    if (S.jobsFilter) data = data.filter((j) => (j.inputs || {}).objective === S.jobsFilter);
    if (!data.length) { box.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
    box.innerHTML = `<table><thead><tr><th>Run</th><th>Food waste type</th><th>Submitted</th><th>Status</th><th>Result files</th></tr></thead><tbody>
      ${data.map((j) => {
        const changes = (j.inputs || {}).changes || [];
        const files = (j.result_files || []).map((f) => `<a href="#" data-path="${esc(f.path)}">${esc(f.name)}</a>`).join("");
        return `<tr>
          <td><div>${esc(j.title)}</div><div class="jobid">${esc(String(j.id).slice(0, 8))}</div>
            ${changes.length ? `<details class="inputs"><summary>${changes.length} edited value${changes.length > 1 ? "s" : ""}</summary><ul>${changes.map((c) => `<li>${esc(c.label)}: ${esc(c.value)} (default ${esc(c.default)})</li>`).join("")}</ul></details>` : ""}</td>
          <td data-label="Food waste type">${esc(j.scenario || "")}</td>
          <td data-label="Submitted">${esc(new Date(j.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))}</td>
          <td data-label="Status"><span class="badge ${esc(j.status)}">${esc(STATUS[j.status] || j.status)}</span>${j.admin_message ? `<div class="admin-msg">${esc(j.admin_message)}</div>` : ""}</td>
          <td class="files" data-label="Result files">${files || '<span class="muted">Not yet</span>'}</td></tr>`;
      }).join("")}</tbody></table>`;
    box.querySelectorAll("a[data-path]").forEach((a) => a.addEventListener("click", async (e) => {
      e.preventDefault();
      const { data: d, error: err } = await sb.storage.from("results").createSignedUrl(a.dataset.path, 3600);
      if (err) { alert(friendly(err)); return; }
      window.open(d.signedUrl, "_blank", "noopener");
    }));
  }

  // ---------- start ----------
  async function init() {
    if (DEMO) { sb = window.makeDemoClient(); show($("demo-banner"), true); }
    else {
      await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
    }
    wireAuth();
    await loadFeed();
    sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") { recovering = true; showAuth("newpw"); return; }
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") render(session);
    });
    const { data } = await sb.auth.getSession();
    render(data.session);
  }
  init();
})();