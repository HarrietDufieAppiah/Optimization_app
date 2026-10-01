/* ECO-FAST web app: sign in, submit jobs, view results. */
(function () {
  "use strict";
  const CFG = window.ECOFAST_CONFIG || {};
  const FORM = window.ECOFAST_FORM || { scenarios: [], groups: [], fields: {}, extra: [] };
  const DEMO = !CFG.SUPABASE_URL || CFG.SUPABASE_URL === "DEMO";
  const SITE_URL = location.origin + location.pathname;
  const $ = (id) => document.getElementById(id);

  let sb = null;
  let recovering = false;
  let defaults = {};      // { scenario: { flatKey: number } }
  let keys = [];          // ordered flat keys
  let scenario = null;
  let values = {};        // flatKey -> string as typed
  let jobsTimer = null;

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
  function flatten(obj, prefix, out) {
    out = out || {};
    Object.keys(obj || {}).forEach((k) => {
      const v = obj[k], key = prefix ? prefix + "." + k : k;
      if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
      else out[key] = v;
    });
    return out;
  }
  function unflatten(flat) {
    const out = {};
    Object.keys(flat).forEach((k) => {
      const parts = k.split("."); let o = out;
      parts.slice(0, -1).forEach((p) => { o[p] = o[p] || {}; o = o[p]; });
      o[parts[parts.length - 1]] = flat[k];
    });
    return out;
  }
  const fieldInfo = (k) => (FORM.fields || {})[k] || {};
  const fmt = (v) => (v === null || v === undefined || v === "" ? "none" : String(v));

  // ---------- auth screens ----------
  function setAuthView(view) {
    ["login", "signup", "forgot", "newpw"].forEach((v) => show($("form-" + v), v === view));
    show($("auth-tabs"), view === "login" || view === "signup");
    document.querySelectorAll("#auth-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    msg($("auth-msg"), "", "");
  }
  function showAuth(view) { show($("app"), false); show($("auth"), true); setAuthView(view || "login"); stopJobsTimer(); }
  function showApp(session) {
    show($("auth"), false); show($("app"), true);
    const meta = session.user.user_metadata || {};
    $("user-name").textContent = meta.full_name || session.user.email;
    goPage("new");
  }
  let shownUser = null;
  function render(session) {
    if (recovering) return showAuth("newpw");
    if (session) {
      // supabase-js re-sends SIGNED_IN when the tab regains focus; don't reset the page for that
      if (shownUser === session.user.id && !$("app").classList.contains("hidden")) return;
      shownUser = session.user.id; showApp(session);
    } else { shownUser = null; showAuth("login"); }
  }

  function wireAuth() {
    document.querySelectorAll("#auth-tabs .tab").forEach((t) => t.addEventListener("click", () => setAuthView(t.dataset.view)));
    document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => setAuthView(b.dataset.goto)));

    $("form-login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("li-email").value.trim(), pw = $("li-pw").value, btn = e.submitter || e.target.querySelector("button[type=submit]");
      if (!email || !pw) return msg($("auth-msg"), "error", "Please enter your email and password.");
      busy(btn, true, "Logging in...");
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

  // ---------- pages ----------
  function goPage(page) {
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
    show($("page-new"), page === "new"); show($("page-jobs"), page === "jobs");
    stopJobsTimer();
    if (page === "jobs") { loadJobs(); jobsTimer = setInterval(loadJobs, 60000); }
    window.scrollTo(0, 0);
  }
  function stopJobsTimer() { if (jobsTimer) clearInterval(jobsTimer); jobsTimer = null; }

  // ---------- job form ----------
  async function loadDefaults() {
    const file = DEMO ? "demo_defaults.json" : "scenario_defaults.json";
    const res = await fetch(file, { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load " + file);
    const raw = await res.json();
    defaults = {};
    Object.keys(raw).filter((s) => !s.startsWith("_")).forEach((s) => { defaults[s] = flatten(raw[s]); });
    (FORM.extra || []).forEach((x) => Object.keys(defaults).forEach((s) => { defaults[s][x.key] = x.default; }));
    const seen = new Set();
    Object.values(defaults).forEach((d) => Object.keys(d).forEach((k) => seen.add(k)));
    keys = Array.from(seen);
  }

  function scenarioList() {
    const listed = (FORM.scenarios || []).filter((s) => defaults[s]);
    return listed.concat(Object.keys(defaults).filter((s) => !listed.includes(s)));
  }

  function buildForm() {
    const presets = $("presets");
    presets.innerHTML = scenarioList().map((s) => `<button type="button" class="preset" data-s="${esc(s)}">${esc(s)}</button>`).join("");
    presets.querySelectorAll(".preset").forEach((b) => b.addEventListener("click", () => pickScenario(b.dataset.s)));

    const extraKeys = (FORM.extra || []).map((x) => x.key);
    const used = new Set();
    const sections = [];
    if (extraKeys.length) { sections.push({ title: "Your waste stream", keys: extraKeys }); extraKeys.forEach((k) => used.add(k)); }
    (FORM.groups || []).forEach((g) => {
      const ks = g.keys.filter((k) => keys.includes(k) && !used.has(k));
      ks.forEach((k) => used.add(k));
      if (ks.length) sections.push({ title: g.title, keys: ks });
    });
    const rest = keys.filter((k) => !used.has(k));
    if (rest.length) sections.push({ title: "Other parameters", keys: rest });

    $("param-sections").innerHTML = sections.map((sec) => `
      <div class="card section"><h3>${esc(sec.title)}</h3><p class="hint">&nbsp;</p><div class="grid">
      ${sec.keys.map((k) => {
        const f = fieldInfo(k) || {}, x = (FORM.extra || []).find((e) => e.key === k) || {};
        const label = f.label || x.label || k, unit = f.unit || x.unit || "", locked = f.editable === false;
        return `<div class="pfield" data-k="${esc(k)}">
          <label for="p-${esc(k)}"><span>${esc(label)}</span>${locked ? '<span class="lock">Locked</span>' : ""}</label>
          <div class="unit-wrap"><input id="p-${esc(k)}" class="input" type="number" step="any" inputmode="decimal" ${locked ? "disabled" : ""}>
          ${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div>
          <div class="meta"></div></div>`;
      }).join("")}</div></div>`).join("");
    document.querySelectorAll("#param-sections .hint").forEach((h) => h.remove());

    document.querySelectorAll(".pfield input").forEach((inp) => {
      const el = inp.closest(".pfield");
      inp.addEventListener("input", () => { values[el.dataset.k] = inp.value; refreshField(el); updateCount(); });
      inp.addEventListener("blur", () => { el.dataset.touched = "1"; refreshField(el); });
    });
  }

  function isChanged(k) {
    const d = defaults[scenario] ? defaults[scenario][k] : undefined;
    const v = values[k];
    if (d === null || d === undefined) return false;
    return v === "" || Number(v) !== Number(d);
  }
  function validate(k) {
    const v = values[k], f = Object.assign({}, (FORM.extra || []).find((e) => e.key === k), fieldInfo(k));
    if (v === "" || v === undefined || v === null) return "Required";
    const n = Number(v);
    if (!isFinite(n)) return "Enter a number";
    if (f.min !== undefined && n < f.min) return "Must be at least " + f.min;
    if (f.max !== undefined && n > f.max) return "Must be at most " + f.max;
    return "";
  }
  function refreshField(el) {
    const k = el.dataset.k, d = defaults[scenario] ? defaults[scenario][k] : undefined;
    const err = validate(k), changed = isChanged(k);
    el.classList.toggle("changed", changed && !err);
    el.classList.toggle("invalid", !!err && el.dataset.touched === "1");
    const meta = el.querySelector(".meta");
    if (err && el.dataset.touched === "1") meta.textContent = err;
    else if (d === null || d === undefined) meta.textContent = "No default, please enter a value";
    else meta.textContent = (changed ? "Edited. Default: " : "Default: ") + fmt(d);
  }
  function updateCount() {
    const n = keys.filter(isChanged).length;
    $("changed-count").textContent = scenario ? (n ? n + (n === 1 ? " value changed from defaults" : " values changed from defaults") : "Using default values") : "";
  }
  function pickScenario(s, force) {
    if (!force && scenario && scenario !== s && keys.some(isChanged) &&
        !confirm("Switch to " + s + "? Your edited values will be replaced with the " + s + " defaults.")) return;
    scenario = s;
    document.querySelectorAll(".preset").forEach((b) => b.classList.toggle("active", b.dataset.s === s));
    keys.forEach((k) => {
      const d = defaults[s][k]; values[k] = d === null || d === undefined ? "" : String(d);
      const el = document.querySelector(`.pfield[data-k="${CSS.escape(k)}"]`);
      if (el) { el.querySelector("input").value = values[k]; delete el.dataset.touched; refreshField(el); }
    });
    updateCount();
  }

  function wireJobForm() {
    $("btn-reset").addEventListener("click", () => { if (scenario) pickScenario(scenario, true); });
    $("form-job").addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = $("job-msg"), btn = $("btn-submit"), title = $("job-title").value.trim();
      if (!title) { msg(out, "error", "Please give the job a name."); $("job-title").focus(); return; }
      if (!scenario) { msg(out, "error", "Please choose a waste source."); return; }
      document.querySelectorAll(".pfield").forEach((el) => { el.dataset.touched = "1"; refreshField(el); });
      const bad = keys.filter((k) => validate(k));
      if (bad.length) { msg(out, "error", "Please fix the highlighted values (" + bad.length + ")."); document.querySelector(".pfield.invalid input")?.focus(); return; }

      const flat = {}; keys.forEach((k) => { flat[k] = Number(values[k]); });
      const { data: s } = await sb.auth.getSession();
      busy(btn, true, "Submitting...");
      const { error } = await sb.from("jobs").insert({
        title, scenario, notes: $("job-notes").value.trim() || null,
        user_email: s.session.user.email,
        user_name: (s.session.user.user_metadata || {}).full_name || null,
        inputs: { scenario, values: unflatten(flat), values_flat: flat, changed_keys: keys.filter(isChanged),
                  defaults_used: defaults[scenario] },
      }).select().single();
      busy(btn, false);
      if (error) return msg(out, "error", friendly(error));
      msg(out, "", "");
      $("job-title").value = ""; $("job-notes").value = ""; pickScenario(scenario, true);
      goPage("jobs");
    });
  }

  // ---------- jobs list ----------
  const STATUS = { submitted: "Submitted", running: "In progress", done: "Results ready", failed: "Could not complete" };
  async function loadJobs() {
    const box = $("jobs-table");
    if (!box.innerHTML) box.innerHTML = '<div class="empty">Loading your jobs...</div>';
    const { data, error } = await sb.from("jobs").select("*").order("created_at", { ascending: false });
    if (error) { box.innerHTML = '<div class="empty">' + esc(friendly(error)) + "</div>"; return; }
    if (!data.length) { box.innerHTML = '<div class="empty">You have not submitted any jobs yet.</div>'; return; }
    box.innerHTML = `<table><thead><tr><th>Job</th><th>Waste source</th><th>Submitted</th><th>Status</th><th>Results</th></tr></thead><tbody>
      ${data.map((j) => {
        const changed = ((j.inputs || {}).changed_keys || []), flat = (j.inputs || {}).values_flat || {};
        const files = (j.result_files || []).map((f) => `<a href="#" data-path="${esc(f.path)}">${esc(f.name)}</a>`).join("");
        return `<tr>
          <td><div>${esc(j.title)}</div><div class="jobid">${esc(String(j.id).slice(0, 8))}</div>
            ${changed.length ? `<details class="inputs"><summary>${changed.length} edited value${changed.length > 1 ? "s" : ""}</summary><ul>${changed.map((k) => `<li>${esc((fieldInfo(k).label) || k)}: ${esc(fmt(flat[k]))}</li>`).join("")}</ul></details>` : ""}</td>
          <td data-label="Waste source">${esc(j.scenario || "")}</td>
          <td data-label="Submitted">${esc(new Date(j.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))}</td>
          <td data-label="Status"><span class="badge ${esc(j.status)}">${esc(STATUS[j.status] || j.status)}</span>${j.admin_message ? `<div style="font-size:.82rem;color:var(--muted);margin-top:6px;max-width:260px">${esc(j.admin_message)}</div>` : ""}</td>
          <td class="files" data-label="Results">${files || '<span style="color:var(--muted)">Not yet</span>'}</td></tr>`;
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
    wireAuth(); wireJobForm();
    document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => goPage(b.dataset.page)));
    $("btn-refresh").addEventListener("click", loadJobs);

    try { await loadDefaults(); buildForm(); const first = scenarioList()[0]; if (first) pickScenario(first, true); }
    catch (err) { $("param-sections").innerHTML = `<div class="card section"><div class="msg error">The default values file could not be loaded. Please contact the site team.</div></div>`; console.error(err); }

    sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") { recovering = true; showAuth("newpw"); return; }
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") render(session);
    });
    const { data } = await sb.auth.getSession();
    render(data.session);
  }
  init();
})();
