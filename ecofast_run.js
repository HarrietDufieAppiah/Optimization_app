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
    ".rr-save{display:inline-flex;align-items:center;gap:8px;height:50px;padding:0 18px;border:1.5px solid #0E4A42;border-radius:8px;background:#fff;color:#0E4A42;font:inherit;font-size:15px;font-weight:600;cursor:pointer;flex:none}",
    ".rr-save:hover{background:#F2F7F5}.rr-save svg{width:19px;height:19px}",
    ".rr-cancel{height:40px;padding:0 18px;border:1.5px solid #C9D3D0;border-radius:8px;background:#fff;color:#33413D;font:inherit;font-size:14px;font-weight:600;cursor:pointer;flex:none}",
    ".rr-cancel:hover{border-color:#B42318;color:#B42318}",
    ".rr-err{margin-top:12px;padding:10px 12px;border-radius:8px;background:#FEECEB;color:#B42318;font-size:13px;line-height:1.45}",
    ".rr-warn{margin-top:10px;padding:8px 10px;border-radius:8px;background:#FFF4DC;color:#8A5A00;font-size:12px;line-height:1.45}",
    "@media (max-width:1100px){.rr-checks{grid-template-columns:repeat(2,minmax(0,1fr))}.rr-prog{grid-template-columns:repeat(2,minmax(0,1fr))}}",
    "@media (max-width:760px){.rr-goals,.rr-checks,.rr-prog{grid-template-columns:1fr}.rr-go,.rr-pt{flex-direction:column;align-items:stretch}.rr-go .btn-run{width:100%}.rr-save{justify-content:center}.rr-go .rr-note,.rr-pt .rr-note{text-align:center;max-width:none}.rr-pt .rr-time{text-align:center}}",
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
    ".er-empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:48px 20px;border:2px dashed #CFDCD8;border-radius:14px;background:#FAFCFB;max-width:1100px}",
    ".er-eico{display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:#E3F1EC;color:#0E4A42}.er-eico svg{width:32px;height:32px}",
    ".er-et{margin-top:14px;font-size:20px;font-weight:800;color:#0B2E2D}.er-ed{margin:4px 0 18px;font-size:15px;color:#4A6460;max-width:380px}",
    ".er-go{display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 18px;border-radius:8px;background:#0E4A42;color:#fff;font-size:15px;font-weight:700;text-decoration:none}.er-go:hover{background:#0B3B35}",
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
  var ICO_SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h11l3.5 3.5v13.5H5z"/><path d="M8 3.5v5h7v-5M8 20.5v-6h8v6"/></g></svg>';
  var savedMsg = "", savedTimer = null;
  function saveProject() {                                                 // My Projects (index.html) listens and saves
    var d = { ok: false }; window.dispatchEvent(new CustomEvent("ecofast:save", { detail: d }));
    savedMsg = d.ok ? "Saved to My Projects." : "Could not save in this browser.";
    var n = el("rr-note"); if (n) n.textContent = savedMsg;
    clearTimeout(savedTimer); savedTimer = setTimeout(function () { savedMsg = ""; renderSide(); }, 2500);
  }
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
    h += '<div class="rr-go"><button type="button" class="btn-run" id="rr-run"' + (ok ? "" : " disabled") + ">" + ICO_PLAY + "Run Optimization</button>" +
      '<button type="button" class="rr-save" id="rr-save">' + ICO_SAVE + "Save project</button>";
    h += '<div class="rr-note" id="rr-note">' + (savedMsg || (ok ? "Results open on the Results page." : "Complete the items above to run.")) + "</div>" +
      (modelReady ? '<span class="rr-chip ok"><i></i>Model ready</span>' : '<span class="rr-chip wait"><i></i>Loading model...</span>') + "</div>";
    return h;
  }

  var sideLoaded = null;
  function renderSide() { var s = el("rr-side"); if (!s) return; sideLoaded = modelReady; var r = buildRequest(objectiveNow()); s.innerHTML = sideHtml(r.req, r); bindSide(); }
  function bindSide() {
    var rb = el("rr-run"); if (rb) rb.addEventListener("click", run);
    var sb = el("rr-save"); if (sb) sb.addEventListener("click", saveProject);
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
        window.dispatchEvent(new CustomEvent("ecofast:result", { detail: saved }));   // My Projects saves it
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
  var TECH_NAME = { SHR: "Shredder", MCR: "Macerator", AER: "Aerobic pretreatment", ENZ: "Enzymatic pretreatment", HTL: "Hydrothermal liquefaction",
    AND: "Anaerobic digestion", SLF: "Sanitary landfill", CMP: "Composting", WWT: "Wastewater treatment", INC: "Incineration",
    CEN: "Centrifuge", FLT: "Filtration", ABS: "Water scrubbing", PSA: "Pressure swing adsorption", STB: "Boiler + steam turbine" };
  var PROD = { CH4: ["Biomethane", "#eb6834"], BIOCRUDE: ["Biocrude", "#1baf7a"], COMPOST: ["Compost", "#eda100"], ELECTRICITY: ["Electricity", "#e87ba4"], BIOSOLIDS: ["Biosolids", "#008300"] };
  var BRANCH_PROD = { AND: "CH4", HTL: "BIOCRUDE", CMP: "COMPOST", INC: "ELECTRICITY", WWT: "BIOSOLIDS" };
  var GHG_LABEL = { Energy_and_materials: "Energy and materials", Direct_emissions: "Direct process emissions", Residue_disposal: "Residue disposal",
    Product_credits: "Credit for products", Digestate_credit: "Credit for digestate fertilizer" };
  var EP_LABEL = { Nitrogen_to_water_and_air: "Nitrogen to water and air", Energy_and_materials: "Energy and materials", Residue_disposal: "Residue disposal",
    Product_credits: "Credit for products", Fertilizer_credits: "Credit for fertilizer" };
  var FEED_PARTS = [["Carbohydrate (%)", "Carbohydrates"], ["Protein (%)", "Proteins"], ["Lipid (%)", "Lipids"], ["Ash (%)", "Ash"], ["Fixed carbon (%)", "Fixed carbon"]];
  var CAT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];

  css.textContent += [
    ".rs{font-family:inherit;color:#0B2E2D;max-width:1180px}",
    ".rs-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin:-8px 0 16px}",
    ".rs-name{font-size:20px;font-weight:800}",
    ".rs-pill{padding:3px 10px;border-radius:99px;font-size:12.5px;font-weight:700;background:var(--gt);color:var(--gc)}",
    ".rs-when{font-size:13px;color:#5A6B70}",
    ".rs-top .er-btn2{margin-left:auto;height:36px;font-size:14px}",
    ".rs-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:16px}",
    ".rs-tiles.one{grid-template-columns:minmax(0,380px)}",
    ".tm{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}",
    ".tm h4{margin:0 0 8px;font-size:13.5px;font-weight:700;color:#0B2E2D}",
    ".tm .hb{grid-template-columns:minmax(84px,max-content) 1fr}",
    ".rs-tile{position:relative;padding:16px 18px 14px;border:1px solid #DDE5E2;border-radius:12px;background:#fff;overflow:hidden}",
    ".rs-tile::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--c)}",
    ".rs-tile .k{font-size:13px;font-weight:600;color:#4A6460}",
    ".rs-tile .v{margin-top:4px;font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}",
    ".rs-tile .u{margin-top:2px;font-size:12.5px;color:#5A6B70}",
    ".rs-tile .tag{display:inline-block;margin-top:8px;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:700;background:#E3F4EA;color:#17693F}",
    ".rs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}",
    ".rs-card{border:1px solid #DDE5E2;border-radius:12px;background:#fff;padding:16px 18px 14px;min-width:0}",
    ".rs-card.wide{grid-column:1/-1}",
    ".rs-card h3{margin:0;font-size:16px;font-weight:800;color:#0B2E2D}",
    ".rs-card .sub{margin:2px 0 12px;font-size:12.5px;color:#5A6B70}",
    ".rs-flow{overflow-x:auto}.rs-flow svg{display:block;min-width:720px;width:100%;height:auto}",
    ".rs-flow text{font-family:inherit}",
    ".hb{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:6px 12px;align-items:center}",
    ".hb .l{font-size:13px;color:#33413D;text-align:right;white-space:nowrap}",
    ".hb .t{position:relative;height:22px}",
    ".hb .b{position:absolute;top:3px;height:16px;border-radius:0 4px 4px 0;background:var(--c);min-width:2px}",
    ".hb .b.neg{border-radius:4px 0 0 4px}",
    ".hb .val{position:absolute;top:2px;font-size:12px;font-weight:600;color:#33413D;white-space:nowrap;font-variant-numeric:tabular-nums}",
    ".hb .z{position:absolute;top:-3px;bottom:-3px;width:1px;background:#8FA19C}",
    ".hb .row-net .l{font-weight:800;color:#0B2E2D}",
    ".hb .sep{grid-column:1/-1;height:1px;background:#E6ECEA;margin:2px 0}",
    ".hb .hit{cursor:default}.hb .hit:hover .b{filter:brightness(.92)}",
    ".ax{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:0 12px;margin-top:4px}",
    ".ax .tk{position:relative;height:16px;border-top:1px solid #E6ECEA}",
    ".ax .tk span{position:absolute;top:2px;transform:translateX(-50%);font-size:11px;color:#6B7F7A;white-space:nowrap}",
    ".rs-sum{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:12px;padding-top:10px;border-top:1px solid #EEF2F0;font-size:13px;color:#4A6460}",
    ".rs-sum b{color:#0B2E2D;font-variant-numeric:tabular-nums}",
    ".dn{display:flex;align-items:center;gap:18px;flex-wrap:wrap}",
    ".dn svg{flex:none;width:150px;height:150px}",
    ".dn path{cursor:default;stroke:#fff;stroke-width:2}.dn path:hover{opacity:.85}",
    ".lg{flex:1;min-width:180px;display:grid;gap:6px}",
    ".lg div{display:grid;grid-template-columns:12px 1fr auto;gap:8px;align-items:center;font-size:13px;color:#33413D}",
    ".lg i{width:12px;height:12px;border-radius:3px;background:var(--c)}",
    ".lg b{font-variant-numeric:tabular-nums;color:#0B2E2D}",
    ".lg small{grid-column:2/-1;margin-top:-4px;font-size:11.5px;color:#6B7F7A}",
    ".sb{display:flex;gap:2px;height:34px;border-radius:6px;overflow:hidden}",
    ".sb div{background:var(--c);min-width:3px;display:flex;align-items:center;justify-content:center;font-size:12.5px;font-weight:700;color:#fff;text-shadow:0 0 3px rgba(0,0,0,.35);cursor:default}",
    ".sb div:hover{filter:brightness(.92)}",
    ".sbl{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;font-size:13px;color:#33413D}",
    ".sbl span{display:inline-flex;align-items:center;gap:7px}.sbl i{width:12px;height:12px;border-radius:3px;background:var(--c)}.sbl b{color:#0B2E2D}",
    ".rs-note{font-size:12px;color:#5A6B70;margin-top:8px}",
    ".rs-tip{position:fixed;z-index:50;pointer-events:none;padding:7px 10px;border-radius:7px;background:#0B2E2D;color:#fff;font-size:12.5px;line-height:1.4;box-shadow:0 6px 18px rgba(0,0,0,.18);display:none;max-width:260px}",
    ".rs-tip b{font-variant-numeric:tabular-nums}",
    ".rs-det{margin-top:16px;border:1px solid #DDE5E2;border-radius:12px;background:#fff;padding:4px 18px}",
    ".rs-det summary{cursor:pointer;padding:10px 0;font-size:15px;font-weight:700;color:#0E4A42}",
    "@media (max-width:900px){.rs-grid,.tm{grid-template-columns:1fr}}",
    "@media (max-width:640px){.rs-tiles{grid-template-columns:1fr}.rs-tile .v{font-size:26px}.rs-top .er-btn2{margin-left:0}}"
  ].join("");

  var tip = document.createElement("div"); tip.className = "rs-tip"; document.body.appendChild(tip);
  function bindTips(root) {
    root.querySelectorAll("[data-tip]").forEach(function (n) {
      n.addEventListener("mousemove", function (e) {
        tip.innerHTML = n.getAttribute("data-tip"); tip.style.display = "block";
        var x = e.clientX + 14, y = e.clientY + 14, w = tip.offsetWidth, h = tip.offsetHeight;
        if (x + w > innerWidth - 8) x = e.clientX - w - 14; if (y + h > innerHeight - 8) y = e.clientY - h - 14;
        tip.style.left = x + "px"; tip.style.top = y + "px";
      });
      n.addEventListener("mouseleave", function () { tip.style.display = "none"; });
    });
  }

  function niceStep(span, n) { var raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
  function scaleOf(min, max, n) {                                                       // clean axis from min..max, always containing 0
    min = Math.min(0, min); max = Math.max(0, max); if (max - min < 1e-12) max = min + 1;
    var st = niceStep(max - min, n || 4), lo = Math.floor(min / st) * st, hi = Math.ceil(max / st) * st, ticks = [];
    for (var v = lo; v <= hi + st / 2; v += st) ticks.push(Math.abs(v) < st / 1e6 ? 0 : v);
    var padL = lo < 0 ? 15 : 0, padR = 17;                                            // room for value labels
    return { lo: lo, hi: hi, ticks: ticks, pos: function (v) { return padL + (v - lo) / (hi - lo) * (100 - padL - padR); } };
  }
  function short(v) { var a = Math.abs(v); return a >= 1e6 ? fmt(v / 1e6, a >= 1e7 ? 0 : 1) + "M" : a >= 1e3 ? fmt(v / 1e3, a >= 1e4 ? 0 : 1) + "k" : fmt(v, a >= 10 || a === 0 ? 0 : a >= 1 ? 1 : 2); }

  // rows: [label, value, color, tipHtml, extraClass]
  function hbars(rows, sc, valFmt) {
    var h = '<div class="hb">';
    rows.forEach(function (r) {
      if (r === "sep") { h += '<div class="sep"></div>'; return; }
      var z = sc.pos(0), p = sc.pos(r[1]), neg = r[1] < 0, left = Math.min(z, p), w = Math.abs(p - z);
      var vt = valFmt(r[1]), vstyle = neg ? "right:" + (100 - left + 1) + "%" : "left:calc(" + (left + w) + "% + 6px)";
      h += '<div class="l ' + (r[4] || "") + '">' + r[0] + '</div><div class="t hit ' + (r[4] || "") + '" data-tip="' + esc(r[3] || "") + '">' +
        '<div class="z" style="left:' + z + '%"></div><div class="b' + (neg ? " neg" : "") + '" style="--c:' + r[2] + ";left:" + left + "%;width:" + w + '%"></div>' +
        '<span class="val" style="' + vstyle + '">' + vt + "</span></div>";
    });
    return h + "</div>";
  }
  function axis(sc, f) {
    return '<div class="ax"><div></div><div class="tk">' + sc.ticks.map(function (t) { return '<span style="left:' + sc.pos(t) + '%">' + f(t) + "</span>"; }).join("") + "</div></div>";
  }
  function donut(parts) {                                                             // parts: [label, value, color, tip]
    var tot = parts.reduce(function (s, p) { return s + p[1]; }, 0), a0 = -Math.PI / 2, R = 70, r = 44, cx = 75, cy = 75, h = '<svg viewBox="0 0 150 150" aria-hidden="true">';
    if (parts.length === 1) return h + '<circle cx="75" cy="75" r="57" fill="none" stroke="' + parts[0][2] + '" stroke-width="26"/></svg>';
    parts.forEach(function (p) {
      var a1 = a0 + p[1] / tot * 2 * Math.PI, lg = a1 - a0 > Math.PI ? 1 : 0;
      var P = function (rad, a) { return (cx + rad * Math.cos(a)).toFixed(2) + " " + (cy + rad * Math.sin(a)).toFixed(2); };
      h += '<path data-tip="' + esc(p[3]) + '" fill="' + p[2] + '" d="M' + P(R, a0) + " A" + R + " " + R + " 0 " + lg + " 1 " + P(R, a1) + " L" + P(r, a1) + " A" + r + " " + r + " 0 " + lg + " 0 " + P(r, a0) + 'Z"/>';
      a0 = a1;
    });
    return h + "</svg>";
  }
  function parts(s) {                                                                 // "HTL 6.61% / AND 93.39%" -> [["HTL",6.61],["AND",93.39]]
    if (!s || s === "Inactive" || s === "Bypass" || s === "-") return [];
    return String(s).split("/").map(function (x) { var m = x.trim().match(/^(\w+)\s*([\d.]+)?%?$/); return m ? [m[1], m[2] ? Number(m[2]) : 100] : null; })
      .filter(function (x) { return x && x[1] > 0.005; });
  }

  function flowSvg(r) {
    var p = r.pathway || {}, split = r.conversion_split || {}, have = {}; (r.units || []).forEach(function (u) { have[u.code] = true; });
    var conv = Object.keys(split).map(function (k) { return [k, split[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    if (!conv.length) conv = parts(p.conversion).map(function (x) { return [x[0], x[1] / 100]; });
    var pre = parts(p.mechanical).map(function (x) { return x[0]; }), bio = parts(p.biological).map(function (x) { return x[0]; });
    var rec = { AND: parts(p.biogas_upgrading).map(function (x) { return x[0]; }), HTL: parts(p.htl_recovery).map(function (x) { return x[0]; }), INC: have.STB ? ["STB"] : [] };
    var W = 1000, colX = [10, 185, 360, 535, 710, 870], nodeW = 120, H0 = 64, gap = 18;
    var branches = conv.map(function (c) { var code = c[0], pr = BRANCH_PROD[code]; return { code: code, f: c[1], rec: rec[code] || [], prod: pr && r.products && r.products[pr] ? pr : null }; });
    var H = Math.max(170, branches.length * (H0 + gap) + 40), mid = H / 2;
    var STAGE = { pre: "#1F8A5B", conv: "#6A3D9A", rec: "#C0561B" };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Treatment pathway">';
    function node(x, y, h, col, code, sub, tipH, dashed) {
      return '<g data-tip="' + esc(tipH || "") + '"><rect x="' + x + '" y="' + (y - h / 2) + '" width="' + nodeW + '" height="' + h + '" rx="9" fill="' + (dashed ? "#fff" : col) + '" stroke="' + col + '" stroke-width="1.5"' + (dashed ? ' stroke-dasharray="4 3"' : "") + "/>" +
        '<text x="' + (x + nodeW / 2) + '" y="' + (y - (sub ? 3 : -5)) + '" text-anchor="middle" font-size="15" font-weight="800" fill="' + (dashed ? col : "#fff") + '">' + esc(code) + "</text>" +
        (sub ? '<text x="' + (x + nodeW / 2) + '" y="' + (y + 14) + '" text-anchor="middle" font-size="11" fill="' + (dashed ? "#5A6B70" : "rgba(255,255,255,.9)") + '">' + esc(sub) + "</text>" : "") + "</g>";
    }
    function ribbon(x1, y1, x2, y2, w, col) {
      var m = (x1 + x2) / 2;
      return '<path d="M' + x1 + " " + (y1 - w / 2) + " C" + m + " " + (y1 - w / 2) + " " + m + " " + (y2 - w / 2) + " " + x2 + " " + (y2 - w / 2) + " L" + x2 + " " + (y2 + w / 2) + " C" + m + " " + (y2 + w / 2) + " " + m + " " + (y1 + w / 2) + " " + x1 + " " + (y1 + w / 2) + 'Z" fill="' + col + '" opacity=".22"/>';
    }
    var maxW = 40, by = branches.map(function (b, i) { return 20 + (H0 + gap) * i + H0 / 2 + (H - 40 - branches.length * (H0 + gap) + gap) / 2; });
    // shared trunk
    s += ribbon(colX[0] + nodeW, mid, colX[1], mid, maxW, STAGE.pre) + ribbon(colX[1] + nodeW, mid, colX[2], mid, maxW, STAGE.pre);
    branches.forEach(function (b, i) {
      var w = Math.max(3, maxW * b.f);
      s += ribbon(colX[2] + nodeW, mid, colX[3], by[i], w, STAGE.conv);
      if (b.rec.length) s += ribbon(colX[3] + nodeW, by[i], colX[4], by[i], w, STAGE.rec);
      if (b.prod) s += ribbon((b.rec.length ? colX[4] : colX[3]) + nodeW, by[i], colX[5], by[i], w, PROD[b.prod][1]);
    });
    var fr = r.inputs_used && r.inputs_used.feed_rate_kg_h;
    s += node(colX[0], mid, 72, "#0B2E2D", "Food waste", fr ? fmt(fr * 24 / 1000, 0) + " t/day" : "", "Food waste feed" + (fr ? "<br><b>" + fmt(fr, 0) + " kg/hr</b>" : ""));
    s += pre.length ? node(colX[1], mid, H0, STAGE.pre, pre.join(" + "), "Pretreatment", pre.map(function (c) { return TECH_NAME[c] || c; }).join(", ")) : node(colX[1], mid, H0, STAGE.pre, "None", "Pretreatment", "No pretreatment", true);
    s += bio.length ? node(colX[2], mid, H0, STAGE.pre, bio.join(" + "), "Biological", bio.map(function (c) { return TECH_NAME[c] || c; }).join(", ")) : node(colX[2], mid, H0, STAGE.pre, "Bypass", "Biological", "Biological pretreatment skipped", true);
    branches.forEach(function (b, i) {
      var pct = b.f * 100, ps = pct >= 99.995 ? "100%" : fmt(pct, pct < 1 ? 2 : 1) + "%";
      s += node(colX[3], by[i], H0, STAGE.conv, b.code, ps + " of flow", (TECH_NAME[b.code] || b.code) + "<br><b>" + ps + "</b> of the stream");
      if (b.rec.length) s += node(colX[4], by[i], H0, STAGE.rec, b.rec.join(" + "), "Recovery", b.rec.map(function (c) { return TECH_NAME[c] || c; }).join(", "));
      if (b.prod) {
        var pd = r.products[b.prod], amt = pd.unit === "kWh" ? fmt(pd.per_year / 1000, 0) + " MWh/yr" : fmt(pd.per_year / 1000, 0) + " t/yr";
        s += '<g data-tip="' + esc(PROD[b.prod][0] + "<br><b>" + amt + "</b><br>$" + fmt(pd.revenue_MUSD_per_yr, 2) + "M per year") + '"><rect x="' + colX[5] + '" y="' + (by[i] - H0 / 2) + '" width="' + nodeW + '" height="' + H0 + '" rx="9" fill="#fff" stroke="' + PROD[b.prod][1] + '" stroke-width="2"/>' +
          '<text x="' + (colX[5] + nodeW / 2) + '" y="' + (by[i] - 3) + '" text-anchor="middle" font-size="14" font-weight="800" fill="#0B2E2D">' + PROD[b.prod][0] + "</text>" +
          '<text x="' + (colX[5] + nodeW / 2) + '" y="' + (by[i] + 14) + '" text-anchor="middle" font-size="11" fill="#5A6B70">' + amt + "</text></g>";
      }
    });
    return s + "</svg>";
  }

  function renderResults(saved) {
    if (!resSlot) return;
    var r = saved.result, o = r.objectives || {}, c = r.cost_breakdown_MUSD_per_yr || {};
    var goalCol = { NAC: ["#9A5B13", "#FBF1E4"], GHG: ["#1F8A5B", "#E9F6EF"], EP: ["#1F8A5B", "#E9F6EF"], BALANCE: ["#6A3D9A", "#F2ECF9"] }[r.objective] || ["#0E4A42", "#E3F1EC"];
    var h = '<div class="rs"><div class="rs-top"><span class="rs-name">' + esc(saved.name) + '</span><span class="rs-pill" style="--gc:' + goalCol[0] + ";--gt:" + goalCol[1] + '">' + esc(OBJ_NAME[r.objective] || r.objective) + "</span>" +
      '<span class="rs-when">' + new Date(saved.when).toLocaleString() + (r.solve_time_s != null ? " &middot; solved in " + fmt(r.solve_time_s, 1) + " s" : "") + "</span>" +
      '<button type="button" class="er-btn2" id="er-dl">Download results (JSON)</button></div>';

    // Show only what belongs to the goal the user ran
    var show = { cost: r.objective === "NAC", ghg: r.objective === "GHG", ep: r.objective === "EP", bal: r.objective === "BALANCE" };
    var tCost = '<div class="rs-tile" style="--c:#9A5B13"><div class="k">Net annual cost</div><div class="v">' + (o.NAC_MUSD_per_yr < 0 ? "-$" : "$") + fmt(Math.abs(o.NAC_MUSD_per_yr), 2) + 'M</div><div class="u">per year</div>' + (o.NAC_MUSD_per_yr < 0 ? '<span class="tag">Net profit</span>' : "") + "</div>";
    var tGhg = '<div class="rs-tile" style="--c:#1F8A5B"><div class="k">Greenhouse gas</div><div class="v">' + fmt(o.GHG_tCO2e_per_yr, 0) + '</div><div class="u">t CO2-eq per year</div>' + (o.GHG_tCO2e_per_yr < 0 ? '<span class="tag">Net reduction</span>' : "") + "</div>";
    var tEp = '<div class="rs-tile" style="--c:#1D6FB8"><div class="k">Marine eutrophication</div><div class="v">' + fmt(o.EP_tN_eq_per_yr, 2) + '</div><div class="u">t N-eq per year</div></div>';
    if (show.bal) h += '<div class="rs-tiles">' + tCost + tGhg + tEp + "</div>";
    var halves = 0;

    h += '<div class="rs-grid">';
    // Pathway flow
    h += '<section class="rs-card wide"><h3>Recommended treatment pathway</h3><div class="sub">Band width shows the share of the food waste stream. Hover a box for details.</div><div class="rs-flow">' + flowSvg(r) + "</div></section>";

    // Annual costs
    var costKeys = ["Annualized_capital", "Labour", "Overhead", "Working_capital", "Insurance", "Utilities", "Disposal", "Materials_and_fuel", "Fixed_charge"]
      .filter(function (k) { return c[k] != null && Math.abs(c[k]) > 1e-6; }).sort(function (a, b) { return c[b] - c[a]; });
    if (show.cost && costKeys.length) { halves++;
      var csc = scaleOf(0, Math.max.apply(null, costKeys.map(function (k) { return c[k]; })));
      h += '<section class="rs-card"><h3>Annual costs</h3><div class="sub">Million $ per year</div>' +
        hbars(costKeys.map(function (k) { return [COST_LABEL[k], c[k], "#9A5B13", COST_LABEL[k] + "<br><b>$" + fmt(c[k], 3) + "M</b> per year<br>" + fmt(c[k] / c.Total_cost * 100, 1) + "% of total cost"]; }), csc, function (v) { return "$" + fmt(v, 2) + "M"; }) +
        axis(csc, function (t) { return "$" + short(t) + "M"; }) +
        '<div class="rs-sum"><span>Total cost <b>$' + fmt(c.Total_cost, 2) + 'M</b></span><span>Revenue <b>$' + fmt(c.Total_revenue, 2) + 'M</b></span><span>Net <b>' + (o.NAC_MUSD_per_yr < 0 ? "-$" : "$") + fmt(Math.abs(o.NAC_MUSD_per_yr), 2) + "M</b></span></div></section>";
    }

    // Revenue sources (donut)
    var rev = [];
    if (c.Tipping_revenue > 1e-6) rev.push(["Tipping fees", c.Tipping_revenue, CAT[0], null]);
    Object.keys(PROD).forEach(function (k) { var pd = r.products && r.products[k]; if (pd && pd.revenue_MUSD_per_yr > 1e-6) rev.push([PROD[k][0] + " sales", pd.revenue_MUSD_per_yr, PROD[k][1], pd]); });
    if (show.cost && rev.length) { halves++;
      var rt = rev.reduce(function (s, x) { return s + x[1]; }, 0);
      h += '<section class="rs-card"><h3>Revenue sources</h3><div class="sub">Million $ per year</div><div class="dn">' +
        donut(rev.map(function (x) { return [x[0], x[1], x[2], x[0] + "<br><b>$" + fmt(x[1], 2) + "M</b> per year<br>" + fmt(x[1] / rt * 100, 1) + "%"]; })) +
        '<div class="lg">' + rev.map(function (x) {
          var amt = x[3] ? (x[3].unit === "kWh" ? fmt(x[3].per_year / 1000, 0) + " MWh" : fmt(x[3].per_year / 1000, 0) + " t") + " per year" : "";
          return '<div style="--c:' + x[2] + '"><i></i><span>' + x[0] + "</span><b>$" + fmt(x[1], 2) + "M</b>" + (amt ? "<small>" + amt + "</small>" : "") + "</div>";
        }).join("") + "</div></div>";
      var negP = Object.keys(r.products || {}).filter(function (k) { return r.products[k].revenue_MUSD_per_yr < -1e-6; });
      if (negP.length) h += '<div class="rs-note">' + negP.map(function (k) { return PROD[k][0] + " cost $" + fmt(-r.products[k].revenue_MUSD_per_yr, 2) + "M per year to dispose"; }).join(". ") + ".</div>";
      h += "</section>";
    }

    // GHG by source (diverging)
    var g = r.ghg_breakdown_t_per_yr;
    if (show.ghg && g) { halves++;
      var gk = Object.keys(GHG_LABEL).filter(function (k) { return g[k] != null && Math.abs(g[k]) > 0.5; });
      var gv = gk.map(function (k) { return g[k]; }).concat([o.GHG_tCO2e_per_yr]);
      var gsc = scaleOf(Math.min.apply(null, gv), Math.max.apply(null, gv));
      h += '<section class="rs-card"><h3>Greenhouse gas by source</h3><div class="sub">t CO2-eq per year. Credits are emissions avoided by the products.</div>' +
        hbars(gk.map(function (k) { var v = g[k]; return [GHG_LABEL[k], v, v < 0 ? "#2a78d6" : "#eb6834", GHG_LABEL[k] + "<br><b>" + fmt(v, 0) + "</b> t CO2-eq/yr"]; })
          .concat(["sep", ["Net", o.GHG_tCO2e_per_yr, "#0B2E2D", "Net greenhouse gas<br><b>" + fmt(o.GHG_tCO2e_per_yr, 0) + "</b> t CO2-eq/yr", "row-net"]]), gsc, function (v) { return short(v); }) +
        axis(gsc, short) + "</section>";
    }

    // Equipment purchase cost
    var units = (r.units || []).filter(function (u) { return u.purchase_cost_usd > 0.5; }).sort(function (a, b) { return b.purchase_cost_usd - a.purchase_cost_usd; });
    if (show.cost && units.length) { halves++;
      var usc = scaleOf(0, units[0].purchase_cost_usd);
      h += '<section class="rs-card"><h3>Equipment purchase cost</h3><div class="sub">$ per unit, before installation</div>' +
        hbars(units.map(function (u) { return [esc(u.code) + " &middot; " + esc(TECH_NAME[u.code] || u.name), u.purchase_cost_usd, "#6A3D9A", esc(u.name) + "<br><b>$" + fmt(u.purchase_cost_usd, 0) + "</b><br>Capacity " + fmt(u.capacity, 2)]; }), usc, function (v) { return "$" + short(v); }) +
        axis(usc, function (t) { return "$" + short(t); }) + "</section>";
    }

    // Trade-off (Best balance)
    if (show.bal && r.balance && r.balance.payoff_table) {
      var rows = r.balance.payoff_table.map(function (row) { return [{ NAC: "Lowest cost", GHG: "Lowest GHG", EP: "Lowest EP" }[row.minimized] || row.minimized, row, "#B5C3BF"]; })
        .concat([["Best balance", { NAC: o.NAC_MUSD_per_yr, GHG: o.GHG_tCO2e_per_yr, EP: o.EP_tN_eq_per_yr }, "#6A3D9A"]]);
      var M = [["NAC", "Net annual cost", "M$/yr", function (v) { return (v < 0 ? "-$" : "$") + fmt(Math.abs(v), 2) + "M"; }], ["GHG", "Greenhouse gas", "t CO2-eq/yr", function (v) { return short(v); }], ["EP", "Eutrophication", "t N-eq/yr", function (v) { return fmt(v, v >= 100 ? 0 : 1); }]];
      h += '<section class="rs-card wide"><h3>Trade-off between the three goals</h3><div class="sub">Each grey bar is the design that is best for one goal. Best balance is the design closest to the best of all three.</div><div class="tm">' +
        M.map(function (m) {
          var vals = rows.map(function (x) { return x[1][m[0]]; }), sc = scaleOf(Math.min.apply(null, vals), Math.max.apply(null, vals), 2);
          return "<div><h4>" + m[1] + ' <span style="font-weight:500;color:#5A6B70">(' + m[2] + ")</span></h4>" +
            hbars(rows.map(function (x) { return [x[0], x[1][m[0]], x[2], x[0] + " design<br><b>" + m[3](x[1][m[0]]) + "</b> " + m[2] + (x[1].conversion_route ? "<br>Conversion: " + x[1].conversion_route : ""), x[0] === "Best balance" ? "row-net" : ""]; }), sc, m[3]) +
            axis(sc, m[0] === "NAC" ? function (t) { return (t < 0 ? "-$" : "$") + short(Math.abs(t)) + "M"; } : short) + "</div>";
        }).join("") + "</div></section>";
    }
    // Marine eutrophication by source
    var ep = r.ep_breakdown_t_per_yr;
    if (show.ep && ep) { halves++;
      var ek = Object.keys(EP_LABEL).filter(function (k) { return ep[k] != null && Math.abs(ep[k]) > 0.0005; });
      var ev = ek.map(function (k) { return ep[k]; }).concat([o.EP_tN_eq_per_yr]);
      var esc2 = scaleOf(Math.min.apply(null, ev), Math.max.apply(null, ev));
      var ef = function (v) { var a = Math.abs(v); return fmt(v, a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3); };
      h += '<section class="rs-card"><h3>Marine eutrophication by source</h3><div class="sub">t N-eq per year. Credits are impacts avoided by the products.</div>' +
        hbars(ek.map(function (k) { var v = ep[k]; return [EP_LABEL[k], v, v < 0 ? "#2a78d6" : "#eb6834", EP_LABEL[k] + "<br><b>" + ef(v) + "</b> t N-eq/yr"]; })
          .concat(["sep", ["Net", o.EP_tN_eq_per_yr, "#0B2E2D", "Net marine eutrophication<br><b>" + ef(o.EP_tN_eq_per_yr) + "</b> t N-eq/yr", "row-net"]]), esc2, ef) +
        axis(esc2, ef) + "</section>";
    }

    // Feedstock composition
    var fd = r.inputs_used && r.inputs_used.feed;
    if (fd) {
      var fp = FEED_PARTS.filter(function (x) { return fd[x[0]] > 0; }).map(function (x, i) { return [x[1], fd[x[0]], CAT[i]]; });
      var oth = 100 - fp.reduce(function (s, x) { return s + x[1]; }, 0); if (oth > 0.05) fp.push(["Other organics", oth, CAT[5]]);
      h += '<section class="rs-card' + (halves % 2 ? "" : " wide") + '"><h3>Feedstock composition</h3><div class="sub">Dry basis, %. Moisture is ' + fmt(fd["Moisture (%)"], 1) + "% of the wet feed.</div>" +
        '<div class="sb">' + fp.map(function (x) { return '<div data-tip="' + esc(x[0] + "<br><b>" + fmt(x[1], 2) + "%</b> dry basis") + '" style="--c:' + x[2] + ";flex:" + x[1] + ' 1 0">' + (x[1] >= 8 ? fmt(x[1], 1) + "%" : "") + "</div>"; }).join("") + "</div>" +
        '<div class="sbl">' + fp.map(function (x) { return '<span style="--c:' + x[2] + '"><i></i>' + x[0] + " <b>" + fmt(x[1], 1) + "%</b></span>"; }).join("") + "</div></section>";
    }

    h += "</div>";

    // Data tables (same numbers as the figures)
    h += '<details class="rs-det"><summary>Data tables and notes</summary>';
    if (show.cost && r.units && r.units.length) {
      h += '<div class="er-h">Equipment</div><table class="er-tbl"><thead><tr><th>Unit</th><th class="r">Capacity</th><th class="r">Purchase cost ($)</th></tr></thead><tbody>' +
        r.units.map(function (u) { return "<tr><td>" + esc(u.name) + " (" + esc(u.code) + ')</td><td class="r">' + fmt(u.capacity, 2) + '</td><td class="r">' + fmt(u.purchase_cost_usd, 0) + "</td></tr>"; }).join("") +
        '</tbody></table><div class="er-note">Capacity units are the reference-capacity units listed on the Cost Assumptions step.</div>';
    }
    if ((show.cost || show.bal) && Object.keys(c).length) {
      h += '<div class="er-h">Annual cost breakdown</div><table class="er-tbl"><thead><tr><th>Item</th><th class="r">Million $ per year</th></tr></thead><tbody>' +
        Object.keys(COST_LABEL).filter(function (k) { return k in c; }).map(function (k) { return "<tr><td>" + COST_LABEL[k] + '</td><td class="r">' + fmt(c[k], 4) + "</td></tr>"; }).join("") + "</tbody></table>";
    }
    if (show.ghg && g) {
      h += '<div class="er-h">Greenhouse gas by source</div><table class="er-tbl"><thead><tr><th>Source</th><th class="r">t CO2-eq per year</th></tr></thead><tbody>' +
        Object.keys(GHG_LABEL).filter(function (k) { return k in g; }).map(function (k) { return "<tr><td>" + GHG_LABEL[k] + '</td><td class="r">' + fmt(g[k], 1) + "</td></tr>"; }).join("") +
        '<tr><td><b>Net</b></td><td class="r"><b>' + fmt(o.GHG_tCO2e_per_yr, 1) + "</b></td></tr></tbody></table>";
    }
    if (show.ep && ep) {
      h += '<div class="er-h">Marine eutrophication by source</div><table class="er-tbl"><thead><tr><th>Source</th><th class="r">t N-eq per year</th></tr></thead><tbody>' +
        Object.keys(EP_LABEL).filter(function (k) { return k in ep; }).map(function (k) { return "<tr><td>" + EP_LABEL[k] + '</td><td class="r">' + fmt(ep[k], 4) + "</td></tr>"; }).join("") +
        '<tr><td><b>Net</b></td><td class="r"><b>' + fmt(o.EP_tN_eq_per_yr, 4) + "</b></td></tr></tbody></table>";
    }
    if (r.balance && show.bal) {
      h += '<div class="er-h">Trade-off extremes</div><table class="er-tbl"><thead><tr><th>Design that minimizes</th><th class="r">Cost (M$/yr)</th><th class="r">GHG (t CO2-eq/yr)</th><th class="r">EP (t N-eq/yr)</th></tr></thead><tbody>' +
        r.balance.payoff_table.map(function (row) {
          return "<tr><td>" + esc(OBJ_NAME[row.minimized] || row.minimized) + '</td><td class="r">' + fmt(row.NAC, 3) + '</td><td class="r">' + fmt(row.GHG, 0) + '</td><td class="r">' + fmt(row.EP, 3) + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
    if ((show.cost || show.ghg) && r.products && Object.keys(r.products).length) {
      h += '<div class="er-h">Products</div><table class="er-tbl"><thead><tr><th>Product</th><th class="r">Amount per year</th><th class="r">Revenue (M$/yr)</th></tr></thead><tbody>' +
        Object.keys(r.products).map(function (k) { var pd = r.products[k]; return "<tr><td>" + (PROD[k] ? PROD[k][0] : k) + '</td><td class="r">' + fmt(pd.per_year, 0) + " " + pd.unit + '</td><td class="r">' + fmt(pd.revenue_MUSD_per_yr, 4) + "</td></tr>"; }).join("") + "</tbody></table>";
    }
    var notes = (r.notes || []).slice();
    if (r.defaults_used && r.defaults_used.length) notes.unshift("Model default values were used for: " + r.defaults_used.join(", ") + ".");
    notes.push("Solved with " + r.solver + (r.solve_time_s != null ? " in " + r.solve_time_s + " s" : "") + ". The result is the proven global optimum of the model.");
    h += '<div class="er-h">Notes</div>' + notes.map(function (n) { return '<div class="er-note">' + esc(n) + "</div>"; }).join("") + '<div style="height:10px"></div></details></div>';

    resSlot.className = ""; resSlot.innerHTML = h;
    bindTips(resSlot);
    el("er-dl").addEventListener("click", function () {
      var b = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "ecofast_result.json"; a.click();
    });
  }

  function renderNoResults() {
    if (!resSlot) return;
    resSlot.className = "";
    resSlot.innerHTML = '<div class="er-empty"><span class="er-eico"><svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4.5 20h15"/><path d="M7 19v-5M11 19V9M15 19v-7M19 19V5"/></g></svg></span>' +
      '<div class="er-et">No results yet</div><div class="er-ed">Run an optimization on the Review &amp; Run step and the results will show here.</div>' +
      '<a class="er-go" href="#new">Go to New Analysis</a></div>';
  }

  // ---------- Start ----------
  window.addEventListener("ecofast:show-result", function (e) {           // opened from My Projects
    try { sessionStorage.setItem("ecofast_last_result", JSON.stringify(e.detail)); } catch (x) {}
    renderResults(e.detail);
  });
  try { var last = JSON.parse(sessionStorage.getItem("ecofast_last_result") || "null"); if (last) renderResults(last); else renderNoResults(); } catch (e) { renderNoResults(); }
  document.querySelectorAll('#page-new .step[data-step="4"], #page-new [data-go="4"]').forEach(function (b) {
    b.addEventListener("click", function () { renderRun(); });
  });
  renderRun();
  // Start loading the model in the background as soon as the user opens New Analysis
  function maybeStart() { if (location.hash === "#new") startModel(); }
  window.addEventListener("hashchange", maybeStart); maybeStart();
})();
