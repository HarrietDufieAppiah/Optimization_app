/*
  ECO-FAST: Review & Run + Results.
  Runs the ECO-FAST model (Pyomo + HiGHS) in the user's browser through ecofast_worker.js and shows the answer.
  No server is needed. index.html needs the one "window.ECOFAST = {...}" line and
  <script src="ecofast_run.js"></script> just before </body>.
*/
(function () {
  // ---------- Model worker (runs in the background) ----------
  var worker = null, calls = {}, nextId = 1, loadText = "", modelReady = false;
  function startModel() {
    if (worker) return;
    worker = new Worker("ecofast_worker.js");
    worker.onmessage = function (e) {
      var d = e.data;
      if (d.type === "status") { loadText = d.text; if (!d.text) modelReady = true; if (running) tickSide(); else renderSide(); return; }
      var c = calls[d.id]; if (!c) return; delete calls[d.id];
      if (d.ok) c.resolve(d.result); else c.reject(new Error(d.error));
    };
    worker.onerror = function (e) { Object.keys(calls).forEach(function (k) { calls[k].reject(new Error(e.message || "worker error")); delete calls[k]; }); };
    callModel("defaults").then(function (D) { syncDefaults(D); if (!running) renderRun(); }).catch(function () {});
  }
  function stopModel() {                                                   // used by Cancel: stop the solve and reload the model
    if (worker) worker.terminate();
    worker = null; modelReady = false; loadText = "";
    Object.keys(calls).forEach(function (k) { calls[k].reject(new Error("cancelled")); delete calls[k]; });
    startModel();
  }
  function callModel(type, req) {
    startModel();
    return new Promise(function (resolve, reject) { var id = nextId++; calls[id] = { resolve: resolve, reject: reject }; worker.postMessage({ id: id, type: type, req: req }); });
  }

  var E = window.ECOFAST;
  if (!E) { console.error("ecofast_run.js: window.ECOFAST is missing. Add the expose line to index.html."); return; }

  function el(id) { return document.getElementById(id); }
  function num(id) { var x = el(id); if (!x || x.value === "") return null; var v = Number(x.value); return isFinite(v) ? v : null; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(v, d) { return v == null || !isFinite(v) ? "-" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }

  // ---------- Website key -> model parameter ----------
  var SCALAR = { nc: "nc", bmc: "BMC_mult", crf: "CRF", clbr: "C_lbr", celec: "C_elec", cstm: "C_stm", cpwt: "C_pwt",
    cwater: "C_water", cng: "C_NG", tip: "C_tip", disp_reject: "C_disp_reject", disp_aq: "C_disp_aq",
    disp_char: "C_disp_char", disp_land: "C_disp_land" };
  var PERCENT = { wc: "r_wc", ins: "r_ins", fac: "r_fac" };              // site shows %, model uses a fraction
  var PRICE = { ch4: "CH4", biocrude: "BIOCRUDE", compost: "COMPOST", elec_price: "ELECTRICITY", biosolids: "BIOSOLIDS" };
  var TECHP = { c0_: "C0", wsp_: "Wsp", nlbr_: "NLBR" };
  var NOT_IN_MODEL = { disp_digestate: true };                          // shown on the site, not a model parameter

  function modelDefault(D, k) {
    if (SCALAR[k]) return D.scalars[SCALAR[k]] && D.scalars[SCALAR[k]].value;
    if (PERCENT[k]) return D.scalars[PERCENT[k]] && 100 * D.scalars[PERCENT[k]].value;
    if (PRICE[k]) return D.product_prices[PRICE[k]];
    for (var p in TECHP) if (k.indexOf(p) === 0) {
      var g = { C0: "reference_capital_cost_usd", Wsp: "specific_power", NLBR: "labor_requirement" }[TECHP[p]];
      return D[g][k.slice(p.length)];
    }
    return undefined;
  }

  // ---------- Make the site defaults equal to the model defaults ----------
  var syncNote = "";
  function syncDefaults(D) {
    var changed = [];
    Object.keys(E.CA_DEF).forEach(function (k) {
      var mv = modelDefault(D, k);
      if (mv == null || Math.abs(mv - E.CA_DEF[k]) <= 1e-12 * Math.max(1, Math.abs(mv))) return;
      changed.push(k);
      if (E.CA_VAL[k] === E.CA_DEF[k]) E.CA_VAL[k] = mv;               // user had not edited it
      E.CA_DEF[k] = mv;
    });
    E.CA_TECH.forEach(function (t) { var q = D.reference_capacity[t[0]]; if (q != null) t[2] = q; });
    Object.keys(E.EA_DEF).forEach(function (k) {
      var s = D.scalars[k]; if (!s) return;
      if (Math.abs(s.value - E.EA_DEF[k]) > 1e-15) { changed.push(k); if (E.EA_VAL[k] === E.EA_DEF[k]) E.EA_VAL[k] = s.value; E.EA_DEF[k] = s.value; }
    });
    E.caRender(); E.eaRender();
    syncNote = changed.length ? changed.length + " default values were updated to match the model." : "";
  }

  // ---------- Collect the request ----------
  var GOAL_TO_OBJ = { cost: "NAC", env: "GHG", balance: "BALANCE" };
  function changedOverrides() {
    var o = { scalars: {}, C0: {}, Wsp: {}, NLBR: {}, Price_prod: {} }, skipped = [];
    Object.keys(E.CA_DEF).forEach(function (k) {
      var v = E.CA_VAL[k]; if (!isFinite(v) || Math.abs(v - E.CA_DEF[k]) <= 1e-12) return;
      if (NOT_IN_MODEL[k]) { skipped.push(k); return; }
      if (SCALAR[k]) o.scalars[SCALAR[k]] = v;
      else if (PERCENT[k]) o.scalars[PERCENT[k]] = v / 100;
      else if (PRICE[k]) o.Price_prod[PRICE[k]] = v;
      else for (var p in TECHP) if (k.indexOf(p) === 0) o[TECHP[p]][k.slice(p.length)] = v;
    });
    Object.keys(E.EA_DEF).forEach(function (k) {
      var v = E.EA_VAL[k]; if (isFinite(v) && Math.abs(v - E.EA_DEF[k]) > 1e-15) o.scalars[k] = v;
    });
    return { overrides: o, skipped: skipped };
  }
  function buildRequest(objective) {
    var feed = { moisture: num("fs-moist"), carbohydrates: num("d-CBH"), proteins: num("d-PRT"), fats: num("d-FAT"),
      ash: num("d-ASH"), fixed_carbon: num("d-FC"), C: num("x-C"), H: num("x-H"), O: num("x-O"), N: num("x-N"),
      S: num("x-S"), hhv: num("x-HHV") };
    Object.keys(feed).forEach(function (k) { if (feed[k] == null) delete feed[k]; });
    var ch = changedOverrides();
    var off = E.CA_TECH.map(function (t) { return t[0]; }).filter(function (c) { return !E.isOn(c); });
    return { req: { objective: objective, feed: feed, feed_rate: num("fs-rate"), feed_rate_unit: el("fs-rateu").value,
      operating_hours: num("fs-hours"), overrides: ch.overrides, disabled_technologies: off, allow_bypass: E.getBypass() },
      skipped: ch.skipped, off: off };
  }

  // ---------- Styles ----------
  var css = document.createElement("style");
  css.textContent = [
    /* Review & Run */
    "#page-new [data-body='4'] .p-sub{display:none}",
    ".rr-grid{display:grid;grid-template-columns:1fr;gap:18px;margin-top:6px}",
    ".rr-checks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px 18px}",
    ".rr-go{display:flex;align-items:center;gap:16px;margin-top:12px;padding-top:14px;border-top:1px solid #EEF2F0}",
    ".rr-go .btn-run{width:280px;margin:0;flex:none}.rr-go .rr-note{margin:0;text-align:left}",
    ".rr-prog{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 14px;align-items:center}",
    ".rr-prog .rr-ph{padding:4px 0}",
    ".rr-pt{display:flex;align-items:center;gap:16px;margin-top:12px;padding-top:12px;border-top:1px solid #EEF2F0}",
    ".rr-pt .rr-time{margin:0;font-size:26px;flex:none}.rr-pt .rr-bar{flex:1;margin:0}.rr-pt .rr-note{margin:0;text-align:left;max-width:300px}",
    ".rr-card{border:1px solid #DDE5E2;border-radius:10px;background:#fff;overflow:hidden}",
    ".rr-card>.h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;background:#F6F9F8;border-bottom:1px solid #E6ECEA}",
    ".rr-card>.h h3{margin:0;font-size:15px;font-weight:700;color:#1B2A27}",
    ".rr-card>.h small{display:block;font-size:12px;color:#5B6660;font-weight:400;margin-top:1px}",
    ".rr-card>.b{padding:14px 16px}",
    ".rr-goals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}",
    ".rr-goal{position:relative;display:flex;gap:12px;align-items:flex-start;padding:14px;border:1.5px solid #CFDCD8;border-radius:8px;background:#fff;text-align:left;cursor:pointer;font:inherit;color:inherit}",
    ".rr-goal:hover{border-color:#8FB3A8}",
    ".rr-goal .gi{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--gt);color:var(--gc)}",
    ".rr-goal .gi svg{width:24px;height:24px}",
    ".rr-goal b{display:block;font-size:14px;color:#1B2A27}",
    ".rr-goal .gd{display:block;margin-top:2px;font-size:12px;line-height:1.4;color:#5B6660}",
    ".rr-goal.on{border-color:var(--gc);background:var(--gt);box-shadow:0 0 0 3px rgba(14,74,66,.08)}",
    ".rr-goal.on .gi{background:var(--gc);color:#fff}",
    ".rr-goal.on::after{content:'';position:absolute;top:10px;right:10px;width:18px;height:18px;border-radius:50%;background:var(--gc) url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6 12.5l4 4L18 8' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\") center/12px no-repeat}",
    ".rr-metric{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#1B2A27;flex-wrap:wrap}",
    ".rr-seg{display:inline-flex;border:1.5px solid #CFDCD8;border-radius:8px;overflow:hidden}",
    ".rr-seg button{border:none;background:#fff;padding:7px 12px;font:inherit;font-size:13px;color:#33413D;cursor:pointer}",
    ".rr-seg button+button{border-left:1.5px solid #CFDCD8}",
    ".rr-seg button.on{background:#1F8A5B;color:#fff;font-weight:600}",
    ".rr-run{border-top:3px solid #0E4A42}",
    ".rr-check{display:flex;align-items:flex-start;gap:10px;padding:7px 0;font-size:13px;color:#1B2A27}",
    ".rr-check svg{width:18px;height:18px;flex:none;margin-top:1px}",
    ".rr-check small{display:block;color:#5B6660;font-size:11.5px}.rr-check small.bad{color:#8A5A00}",
    ".btn-run{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:50px;margin-top:14px;border:none;border-radius:8px;background:#0E4A42;color:#fff;font:inherit;font-size:15.5px;font-weight:600;cursor:pointer}",
    ".btn-run:hover{background:#0C3D38}.btn-run:disabled{background:#9DB4AD;cursor:not-allowed}",
    ".btn-run svg{width:20px;height:20px}",
    ".rr-note{margin-top:10px;font-size:12px;line-height:1.45;color:#5B6660;text-align:center}",
    ".rr-ph{display:flex;align-items:center;gap:12px;padding:9px 0;font-size:13.5px;color:#9AA6A1}",
    ".rr-ph .dot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;flex:none;border:2px solid #DDE5E2;background:#fff}",
    ".rr-ph .dot svg{width:14px;height:14px}",
    ".rr-ph.done{color:#1B2A27}.rr-ph.done .dot{background:#1F8A5B;border-color:#1F8A5B;color:#fff}",
    ".rr-ph.now{color:#1B2A27;font-weight:600}.rr-ph.now .dot{border-color:#0E4A42;border-right-color:transparent;animation:er-s .9s linear infinite}",
    ".rr-time{margin:10px 0 4px;text-align:center;font-size:30px;font-weight:700;color:#0E4A42;font-variant-numeric:tabular-nums}",
    ".rr-bar{height:6px;border-radius:3px;background:#E6ECEA;overflow:hidden;margin:6px 0 2px}",
    ".rr-bar i{display:block;height:100%;width:35%;border-radius:3px;background:linear-gradient(90deg,#1F8A5B,#6A3D9A,#C0561B);animation:rr-slide 1.6s ease-in-out infinite}",
    "@keyframes rr-slide{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}",
    ".rr-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;font-size:12.5px;font-weight:600;white-space:nowrap}",
    ".rr-chip i{width:8px;height:8px;border-radius:50%;background:currentColor}",
    ".rr-chip.ok{background:#E9F6EF;color:#1F7A4A}.rr-chip.wait{background:#FFF4DC;color:#8A5A00}.rr-chip.wait i{animation:rr-pulse 1s ease-in-out infinite}",
    "@keyframes rr-pulse{50%{opacity:.25}}",
    ".rr-go .rr-chip{margin-left:auto}",
    ".rr-cancel{height:40px;padding:0 18px;border:1.5px solid #C9D3D0;border-radius:8px;background:#fff;color:#33413D;font:inherit;font-size:14px;font-weight:600;cursor:pointer;flex:none}",
    ".rr-cancel:hover{border-color:#B42318;color:#B42318}",
    ".rr-err{margin-top:12px;padding:10px 12px;border-radius:8px;background:#FEECEB;color:#B42318;font-size:13px;line-height:1.45}",
    ".rr-warn{margin-top:10px;padding:8px 10px;border-radius:8px;background:#FFF4DC;color:#8A5A00;font-size:12px;line-height:1.45}",
    "@media (max-width:1100px){.rr-checks{grid-template-columns:repeat(2,minmax(0,1fr))}.rr-prog{grid-template-columns:repeat(2,minmax(0,1fr))}}",
    "@media (max-width:760px){.rr-goals,.rr-checks,.rr-prog{grid-template-columns:1fr}.rr-go,.rr-pt{flex-direction:column;align-items:stretch}.rr-go .btn-run{width:100%}.rr-go .rr-note,.rr-pt .rr-note{text-align:center;max-width:none}.rr-pt .rr-time{text-align:center}}",
    /* Results */
    ".er-msg{margin:10px 0;padding:10px 12px;border-radius:8px;font-size:14px}",
    ".er-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:14px 0}",
    ".er-tile{border:1px solid var(--line,#E3E7E4);border-radius:10px;padding:14px 16px;background:#fff}",
    ".er-tile .n{font-size:24px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}",
    ".er-k{color:var(--muted,#5B6660);font-size:13px}",
    ".er-chain{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 4px}",
    ".er-chip{padding:6px 10px;border-radius:999px;background:var(--brand-soft,#E8F1EC);color:var(--brand,#114D47);font-weight:600;font-size:13.5px}",
    ".er-arrow{color:var(--muted,#5B6660)}",
    ".er-tbl{width:100%;border-collapse:collapse;font-size:14px;margin:6px 0 16px}",
    ".er-tbl th,.er-tbl td{padding:7px 10px;border-bottom:1px solid var(--line,#E3E7E4);text-align:left}",
    ".er-tbl td.r,.er-tbl th.r{text-align:right;font-variant-numeric:tabular-nums}",
    ".er-h{font-size:16px;font-weight:700;margin:20px 0 6px}",
    ".er-note{color:var(--muted,#5B6660);font-size:13px;margin:4px 0}",
    ".er-btn2{height:40px;padding:0 16px;border:1.5px solid #114D47;border-radius:6px;background:#fff;color:#114D47;font:inherit;font-weight:600;cursor:pointer}",
    ".er-btn2:hover{background:#F2F6F5}",
    "@keyframes er-s{to{transform:rotate(360deg)}}",
    "@media (max-width:600px){.er-tbl{font-size:13px}.er-tbl th,.er-tbl td{padding:6px}}"
  ].join("");
  document.head.appendChild(css);

  // ---------- Review & Run panel ----------
  var GOAL_UI = [
    ["cost", "Lowest Cost", "Lowest net annual cost", "#9A5B13", "#FBF1E4",
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><ellipse cx="12" cy="6.5" rx="6.5" ry="2.6"/><path d="M5.5 6.5v4c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6v-4"/><path d="M5.5 10.5v4c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6v-4"/><path d="M5.5 14.5v3c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6v-3"/></g>'],
    ["env", "Lowest Environmental Impact", "Lowest greenhouse gas or eutrophication", "#1F8A5B", "#E9F6EF",
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 4.5C10 4.5 5 9 5 15.5c0 1.4.3 2.6.8 3.6 1 .3 2 .4 3 .4 6.5 0 10.7-5 10.7-15z"/><path d="M5.6 19.4 14 11"/></g>'],
    ["balance", "Best Balance", "Closest to the best cost, GHG and EP together", "#6A3D9A", "#F2ECF9",
      '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v16M7.5 20.5h9M4.5 7h15"/><path d="M6.5 7 3.5 13.5h6z"/><path d="M17.5 7l-3 6.5h6z"/><path d="M3.5 13.5a3 2 0 0 0 6 0M14.5 13.5a3 2 0 0 0 6 0"/></g>']
  ];
  var OBJ_NAME = { NAC: "Lowest cost", GHG: "Lowest greenhouse gas", EP: "Lowest eutrophication", BALANCE: "Best balance" };
  var uiGoal = E.getGoal() || "cost", envMetric = "GHG";
  function objectiveNow() { return uiGoal === "env" ? envMetric : uiGoal === "balance" ? "BALANCE" : "NAC"; }
  document.querySelectorAll("#page-home .goal").forEach(function (a) {   // goal picked on the home page
    a.addEventListener("click", function () { var g = a.getAttribute("data-goal"); if (GOAL_TO_OBJ[g]) { uiGoal = g; renderRun(); } });
  });
  var runSlot = document.querySelector('#page-new [data-body="4"] .step-empty');
  var running = false, runStart = 0, runErr = "", tick = null;

  var CA_NAME = { nc: "Cost exponent", bmc: "Bare-module multiplier", crf: "Capital recovery factor", clbr: "Labor cost",
    celec: "Electricity cost", cstm: "Steam cost", cpwt: "Cooling water cost", cwater: "Process water cost", cng: "Natural gas cost",
    tip: "Tipping fee", disp_reject: "Reject disposal", disp_aq: "Aqueous disposal", disp_char: "Char disposal",
    disp_land: "Landfill disposal", disp_digestate: "Digestate disposal", wc: "Working capital", ins: "Insurance",
    fac: "Facility factor", ch4: "Biomethane price", biocrude: "Biocrude price", compost: "Compost price",
    elec_price: "Electricity price", biosolids: "Biosolids price" };
  function caName(k) {
    if (CA_NAME[k]) return CA_NAME[k];
    if (k.indexOf("c0_") === 0) return k.slice(3) + " purchase cost";
    if (k.indexOf("wsp_") === 0) return k.slice(4) + " specific power";
    if (k.indexOf("nlbr_") === 0) return k.slice(5) + " labor";
    return k;
  }
  var ICO_OK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1F8A5B"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICO_WARN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#E8B62C"/><path d="M12 7v6.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17" r="1.4" fill="#fff"/></svg>';
  var ICO_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor"/></svg>';
  var ICO_TICK = '<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4L18 8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function checks(q) {
    var name = ((el("fs-name") || {}).value || "").trim(), type = (el("fs-type") || {}).value;
    var dsum = 0, have = false;
    ["CBH", "PRT", "FAT", "ASH", "FC", "OTH"].forEach(function (k) { var v = num("d-" + k); if (v != null) { dsum += v; have = true; } });
    var bad = Object.keys(E.CA_VAL).concat(Object.keys(E.EA_VAL)).some(function (k) {
      var v = k in E.CA_VAL ? E.CA_VAL[k] : E.EA_VAL[k]; return !isFinite(v); });
    var rateOk = q.feed_rate != null && q.feed_rate > 0, hrsOk = q.operating_hours != null && q.operating_hours > 0;
    var unit = q.feed_rate_unit === "tday" ? " tonne/day" : " kg/hr";
    return [
      [true, "Goal", OBJ_NAME[objectiveNow()]],
      [!!name, "Analysis name", name || "Add a name on the Feedstock step"],
      [!!type, "Feedstock type", type || "Select a type on the Feedstock step"],
      [rateOk && hrsOk, "Feed rate and hours", rateOk && hrsOk ? fmt(q.feed_rate, 0) + unit + ", " + fmt(q.operating_hours, 0) + " hr/yr" : "Enter both on the Feedstock step"],
      [have && Math.abs(dsum - 100) <= 0.5, "Composition adds to 100%", have ? "Dry basis total " + dsum.toFixed(2) + "%" : "Fill in the composition"],
      [!bad, "Assumption values valid", bad ? "Fix the values marked in red" : "All values are filled in"]
    ];
  }

  function renderRun() {
    if (!runSlot) return;
    var r = buildRequest(objectiveNow()), q = r.req;
    var h = '<div class="rr-grid"><div>';
    h += '<section class="rr-card"><div class="h"><div><h3>Optimization Goal</h3><small>What should ECO-FAST optimize for?</small></div></div><div class="b"><div class="rr-goals">' +
      GOAL_UI.map(function (g) {
        return '<button type="button" class="rr-goal' + (g[0] === uiGoal ? " on" : "") + '" data-g="' + g[0] + '" style="--gc:' + g[3] + ";--gt:" + g[4] + '"' + (running ? " disabled" : "") +
          '><span class="gi"><svg viewBox="0 0 24 24" aria-hidden="true">' + g[5] + '</svg></span><span><b>' + g[1] + '</b><span class="gd">' + g[2] + "</span></span></button>";
      }).join("") + "</div>";
    if (uiGoal === "env") h += '<div class="rr-metric">Impact to minimize <span class="rr-seg">' +
      '<button type="button" data-m="GHG" class="' + (envMetric === "GHG" ? "on" : "") + '">Greenhouse gas (t CO2-eq/yr)</button>' +
      '<button type="button" data-m="EP" class="' + (envMetric === "EP" ? "on" : "") + '">Eutrophication (t N-eq/yr)</button></span></div>';
    h += "</div></section>";

    h += "</div>";
    h += '<aside class="rr-card rr-run"><div class="h"><h3>' + (running ? "Running" : "Ready to Run") + '</h3></div><div class="b" id="rr-side">' + sideHtml(q, r) + "</div></aside></div>";
    runSlot.className = ""; runSlot.innerHTML = h;
    runSlot.querySelectorAll(".rr-goal").forEach(function (b) { b.addEventListener("click", function () { if (running) return; uiGoal = b.dataset.g; runErr = ""; renderRun(); }); });
    runSlot.querySelectorAll(".rr-seg button").forEach(function (b) { b.addEventListener("click", function () { envMetric = b.dataset.m; renderRun(); }); });
    bindSide();
  }

  function sideHtml(q, r) {
    if (running) {
      var loaded = modelReady, sec = Math.floor((Date.now() - runStart) / 1000);
      var est = objectiveNow() === "BALANCE" ? "Best balance runs several optimizations and can take a few minutes." : "This usually takes under a minute.";
      return '<div class="rr-prog">' +
        '<div class="rr-ph done"><span class="dot">' + ICO_TICK + "</span>Inputs collected</div>" +
        '<div class="rr-ph ' + (loaded ? "done" : "now") + '"><span class="dot">' + (loaded ? ICO_TICK : "") + "</span>Loading the model</div>" +
        '<div class="rr-ph ' + (loaded ? "now" : "") + '"><span class="dot"></span>Solving: ' + esc(OBJ_NAME[objectiveNow()]) + "</div>" +
        '<div class="rr-ph"><span class="dot"></span>Opening results</div>' +
        '</div><div class="rr-pt"><div class="rr-time" id="rr-time">' + Math.floor(sec / 60) + ":" + ("0" + sec % 60).slice(-2) + "</div>" +
        '<div class="rr-bar"><i></i></div><div class="rr-note">' + est + " Keep this tab open.</div>" + '<button type="button" class="rr-cancel" id="rr-cancel">Cancel</button></div>';
    }
    var st = checks(q), ok = st.every(function (s) { return s[0]; });
    var h = '<div class="rr-checks">' + st.map(function (s) { return '<div class="rr-check">' + (s[0] ? ICO_OK : ICO_WARN) + "<span>" + s[1] + '<small class="' + (s[0] ? "" : "bad") + '">' + esc(s[2]) + "</small></span></div>"; }).join("") + "</div>";
    if (r.skipped.length) h += '<div class="rr-warn">Not used by the model, so ignored: ' + esc(r.skipped.map(caName).join(", ")) + "</div>";
    if (runErr) h += '<div class="rr-err">' + esc(runErr) + "</div>";
    h += '<div class="rr-go"><button type="button" class="btn-run" id="rr-run"' + (ok ? "" : " disabled") + ">" + ICO_PLAY + "Run Optimization</button>";
    h += '<div class="rr-note">' + (ok ? "Results open on the Results page." : "Complete the items above to run.") + "</div>" +
      (modelReady ? '<span class="rr-chip ok"><i></i>Model ready</span>' : '<span class="rr-chip wait"><i></i>Loading model...</span>') + "</div>";
    return h;
  }

  var sideLoaded = null;
  function renderSide() { var s = el("rr-side"); if (!s) return; sideLoaded = modelReady; var r = buildRequest(objectiveNow()); s.innerHTML = sideHtml(r.req, r); bindSide(); }
  function bindSide() {
    var rb = el("rr-run"); if (rb) rb.addEventListener("click", run);
    var cb = el("rr-cancel"); if (cb) cb.addEventListener("click", cancelRun);
  }
  function tickSide() {
    var t = el("rr-time");
    if (!t || sideLoaded !== modelReady) { renderSide(); return; }
    var sec = Math.floor((Date.now() - runStart) / 1000), mm = Math.floor(sec / 60) + ":" + ("0" + sec % 60).slice(-2);
    t.textContent = mm; document.title = "(" + mm + ") Running... " + baseTitle;
  }

  // ---------- Tab title and leave warning ----------
  var baseTitle = document.title, titleTimer = null;
  function setTitle(t) { clearTimeout(titleTimer); document.title = t ? t + " " + baseTitle : baseTitle; }
  function doneTitle(t) {
    setTitle(t);
    var back = function () { titleTimer = setTimeout(function () { setTitle(""); }, 4000); document.removeEventListener("visibilitychange", back); };
    if (document.hidden) document.addEventListener("visibilitychange", back); else back();
  }
  window.addEventListener("beforeunload", function (e) { if (running) { e.preventDefault(); e.returnValue = ""; return ""; } });

  var runToken = 0;
  function run() {
    if (running) return;
    var q = buildRequest(objectiveNow()).req, my = ++runToken;
    running = true; runErr = ""; runStart = Date.now();
    setTitle("(0:00) Running...");
    renderRun();
    sideLoaded = modelReady; tick = setInterval(tickSide, 1000);
    callModel("run", q).then(function (res) {
      if (my !== runToken) return;
      clearInterval(tick); running = false;
      if (res && res.status === "optimal") {
        var saved = { request: q, result: res, name: (el("fs-name") || {}).value || "Untitled", when: new Date().toISOString() };
        try { sessionStorage.setItem("ecofast_last_result", JSON.stringify(saved)); } catch (e) {}
        renderResults(saved);
        renderRun();
        doneTitle("Done.");
        location.hash = "#results";
      } else {
        runErr = (res && res.message) || "The run failed."; doneTitle("Failed."); renderRun();
      }
    }).catch(function (e) {
      if (my !== runToken) return;
      clearInterval(tick); running = false;
      runErr = "The model could not run in this browser (" + e.message + "). Try a current Chrome, Edge, Firefox or Safari."; doneTitle("Failed."); renderRun();
    });
  }
  function cancelRun() {
    if (!running) return;
    runToken++; clearInterval(tick); running = false; setTitle("");
    stopModel();
    renderRun();
  }

  // ---------- Results page ----------
  var resSlot = document.querySelector("#page-results .soon");
  var COST_LABEL = { Annualized_capital: "Annualized capital", Working_capital: "Working capital", Insurance: "Insurance",
    Utilities: "Utilities", Labour: "Labor", Overhead: "Overhead", Materials_and_fuel: "Materials and fuel",
    Disposal: "Disposal", Fixed_charge: "Fixed charge", Total_cost: "Total cost", Total_revenue: "Total revenue",
    Tipping_revenue: "Tipping revenue (part of revenue)" };

  function renderResults(saved) {
    if (!resSlot) return;
    var r = saved.result, o = r.objectives, p = r.pathway;
    var h = '<div class="er-k">' + esc(saved.name) + " &middot; " + esc(OBJ_NAME[r.objective] || r.objective) + " &middot; " + new Date(saved.when).toLocaleString() + "</div>";
    h += '<div class="er-tiles">' +
      '<div class="er-tile"><div class="er-k">Net annual cost</div><div class="n">' + fmt(o.NAC_MUSD_per_yr, 3) + '</div><div class="er-k">million $ per year' + (o.NAC_MUSD_per_yr < 0 ? " (negative = net profit)" : "") + '</div></div>' +
      '<div class="er-tile"><div class="er-k">Greenhouse gas</div><div class="n">' + fmt(o.GHG_tCO2e_per_yr, 0) + '</div><div class="er-k">t CO2-eq per year</div></div>' +
      '<div class="er-tile"><div class="er-k">Marine eutrophication</div><div class="n">' + fmt(o.EP_tN_eq_per_yr, 3) + '</div><div class="er-k">t N-eq per year</div></div></div>';
    var chain = ["Food waste", p.mechanical, p.biological, p.conversion, p.htl_recovery !== "Inactive" ? p.htl_recovery : null,
      p.biogas_upgrading !== "Inactive" ? p.biogas_upgrading : null].filter(function (x) { return x && x !== "-" && x !== ""; });
    h += '<div class="er-h">Recommended pathway</div><div class="er-chain">' + chain.map(function (c, i) {
      return (i ? '<span class="er-arrow">&rarr;</span>' : "") + '<span class="er-chip">' + esc(c) + "</span>";
    }).join("") + "</div>";
    if (r.units && r.units.length) {
      h += '<div class="er-h">Equipment</div><table class="er-tbl"><thead><tr><th>Unit</th><th class="r">Capacity</th><th class="r">Purchase cost ($)</th></tr></thead><tbody>' +
        r.units.map(function (u) { return "<tr><td>" + esc(u.name) + " (" + esc(u.code) + ')</td><td class="r">' + fmt(u.capacity, 2) + '</td><td class="r">' + fmt(u.purchase_cost_usd, 0) + "</td></tr>"; }).join("") +
        '</tbody></table><div class="er-note">Capacity units are the reference-capacity units listed on the Cost Assumptions step.</div>';
    }
    var c = r.cost_breakdown_MUSD_per_yr || {};
    if (Object.keys(c).length) {
      h += '<div class="er-h">Annual cost breakdown</div><table class="er-tbl"><thead><tr><th>Item</th><th class="r">Million $ per year</th></tr></thead><tbody>' +
        Object.keys(COST_LABEL).filter(function (k) { return k in c; }).map(function (k) {
          return "<tr><td>" + COST_LABEL[k] + '</td><td class="r">' + fmt(c[k], 4) + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
    if (r.balance) {
      h += '<div class="er-h">Trade-off extremes</div><table class="er-tbl"><thead><tr><th>Design that minimizes</th><th class="r">Cost (M$/yr)</th><th class="r">GHG (t CO2-eq/yr)</th><th class="r">EP (t N-eq/yr)</th></tr></thead><tbody>' +
        r.balance.payoff_table.map(function (row) {
          return "<tr><td>" + esc(OBJ_NAME[row.minimized] || row.minimized) + '</td><td class="r">' + fmt(row.NAC, 3) + '</td><td class="r">' + fmt(row.GHG, 0) + '</td><td class="r">' + fmt(row.EP, 3) + "</td></tr>";
        }).join("") + '</tbody></table><div class="er-note">Best balance picks the design closest to the best value of all three at once, each scaled by its range above.</div>';
    }
    var notes = (r.notes || []).slice();
    if (r.defaults_used && r.defaults_used.length) notes.unshift("Model default values were used for: " + r.defaults_used.join(", ") + ".");
    notes.push("Solved with " + r.solver + " in " + r.solve_time_s + " s in your browser. The result is the proven global optimum of the model.");
    h += '<div class="er-h">Notes</div>' + notes.map(function (n) { return '<div class="er-note">' + esc(n) + "</div>"; }).join("");
    h += '<div style="margin-top:14px"><button type="button" class="er-btn2" id="er-dl">Download results (JSON)</button></div>';
    resSlot.className = ""; resSlot.innerHTML = h;
    el("er-dl").addEventListener("click", function () {
      var b = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "ecofast_result.json"; a.click();
    });
  }

  // ---------- Start ----------
  try { var last = JSON.parse(sessionStorage.getItem("ecofast_last_result") || "null"); if (last) renderResults(last); } catch (e) {}
  document.querySelectorAll('#page-new .step[data-step="4"], #page-new [data-go="4"]').forEach(function (b) {
    b.addEventListener("click", function () { renderRun(); });
  });
  renderRun();
  // Start loading the model in the background as soon as the user opens New Analysis
  function maybeStart() { if (location.hash === "#new") startModel(); }
  window.addEventListener("hashchange", maybeStart); maybeStart();
})();