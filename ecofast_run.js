/*
  ECO-FAST: Review & Run + Results.
  Runs the ECO-FAST model (Pyomo + HiGHS) in the user's browser through ecofast_worker.js and shows the answer.
  No server is needed. index.html needs the one "window.ECOFAST = {...}" line (see SETUP.md) and
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
      if (d.type === "status") { loadText = d.text; if (!d.text) modelReady = true; if (running) renderRun(msg("info", d.text || "Solving...", true)); return; }
      var c = calls[d.id]; if (!c) return; delete calls[d.id];
      if (d.ok) c.resolve(d.result); else c.reject(new Error(d.error));
    };
    worker.onerror = function (e) { Object.keys(calls).forEach(function (k) { calls[k].reject(new Error(e.message || "worker error")); delete calls[k]; }); };
    callModel("defaults").then(function (D) { syncDefaults(D); if (!running) renderRun(); }).catch(function () {});
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
    ".er-box{border:1px solid var(--line,#E3E7E4);border-radius:10px;padding:18px 20px;background:var(--bg-soft,#F7F9F8);margin:6px 0 14px}",
    ".er-row{display:flex;flex-wrap:wrap;gap:10px 28px;margin:4px 0}",
    ".er-row div{min-width:150px}.er-k{color:var(--muted,#5B6660);font-size:13px}.er-v{font-weight:600}",
    ".er-obj{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:12px 0}",
    ".er-obj label{display:flex;gap:10px;align-items:flex-start;border:1.5px solid var(--line,#E3E7E4);border-radius:8px;padding:10px 12px;cursor:pointer;background:#fff}",
    ".er-obj label.on{border-color:var(--brand,#114D47);background:var(--brand-soft,#E8F1EC)}",
    ".er-obj small{display:block;color:var(--muted,#5B6660);font-size:12.5px;margin-top:2px}",
    ".er-msg{margin:10px 0;padding:10px 12px;border-radius:8px;font-size:14px}",
    ".er-msg.info{background:var(--info-soft,#E7EFFA);color:var(--info,#1D4F91)}.er-msg.warn{background:var(--warn-soft,#FFF4DC);color:var(--warn,#8A5A00)}",
    ".er-msg.err{background:var(--danger-soft,#FEECEB);color:var(--danger,#B42318)}.er-msg.ok{background:var(--ok-soft,#E8F1EC);color:var(--brand,#114D47)}",
    ".er-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:14px 0}",
    ".er-tile{border:1px solid var(--line,#E3E7E4);border-radius:10px;padding:14px 16px;background:#fff}",
    ".er-tile .n{font-size:24px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}",
    ".er-chain{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:10px 0 4px}",
    ".er-chip{padding:6px 10px;border-radius:999px;background:var(--brand-soft,#E8F1EC);color:var(--brand,#114D47);font-weight:600;font-size:13.5px}",
    ".er-arrow{color:var(--muted,#5B6660)}",
    ".er-tbl{width:100%;border-collapse:collapse;font-size:14px;margin:6px 0 16px}",
    ".er-tbl th,.er-tbl td{padding:7px 10px;border-bottom:1px solid var(--line,#E3E7E4);text-align:left}",
    ".er-tbl td.r,.er-tbl th.r{text-align:right;font-variant-numeric:tabular-nums}",
    ".er-h{font-size:16px;font-weight:700;margin:20px 0 6px}",
    ".er-note{color:var(--muted,#5B6660);font-size:13px;margin:4px 0}",
    ".er-spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:er-s .8s linear infinite;vertical-align:-2px;margin-right:8px}",
    ".er-btn2{height:40px;padding:0 16px;border:1.5px solid #114D47;border-radius:6px;background:#fff;color:#114D47;font:inherit;font-weight:600;cursor:pointer}",
    ".er-btn2:hover{background:#F2F6F5}",
    "@keyframes er-s{to{transform:rotate(360deg)}}",
    "@media (max-width:600px){.er-tbl{font-size:13px}.er-tbl th,.er-tbl td{padding:6px}}"
  ].join("");
  document.head.appendChild(css);

  // ---------- Review & Run panel ----------
  var OBJ = [
    ["NAC", "Lowest cost", "Lowest net annual cost"],
    ["GHG", "Lowest greenhouse gas", "Lowest t CO2-eq per year"],
    ["EP", "Lowest eutrophication", "Lowest marine eutrophication, t N-eq per year"],
    ["BALANCE", "Best balance", "Closest to the best cost, GHG and EP together"]
  ];
  var objective = GOAL_TO_OBJ[E.getGoal()] || "NAC";
  document.querySelectorAll("#page-home .goal").forEach(function (a) {   // goal picked on the home page
    a.addEventListener("click", function () { objective = GOAL_TO_OBJ[a.getAttribute("data-goal")] || objective; renderRun(); });
  });
  var runSlot = document.querySelector('#page-new [data-body="4"] .step-empty');
  var running = false;

  function renderRun(state) {
    if (!runSlot) return;
    var r = buildRequest(objective), q = r.req;
    var rate = q.feed_rate == null ? "Not set" : fmt(q.feed_rate, 0) + (q.feed_rate_unit === "tday" ? " tonne/day" : " kg/hr");
    var type = el("fs-type") && el("fs-type").value;
    var nChanged = Object.keys(q.overrides).reduce(function (n, g) { return n + Object.keys(q.overrides[g]).length; }, 0);
    var h = '<div class="er-box"><div class="er-row">' +
      '<div><div class="er-k">Analysis</div><div class="er-v">' + esc((el("fs-name") || {}).value || "Untitled") + "</div></div>" +
      '<div><div class="er-k">Feedstock</div><div class="er-v">' + esc(type || "Custom") + "</div></div>" +
      '<div><div class="er-k">Feed rate</div><div class="er-v">' + rate + "</div></div>" +
      '<div><div class="er-k">Operating hours</div><div class="er-v">' + (q.operating_hours == null ? "Not set" : fmt(q.operating_hours, 0) + " h/yr") + "</div></div>" +
      '<div><div class="er-k">Changed assumptions</div><div class="er-v">' + (nChanged ? nChanged : "None (model defaults)") + "</div></div>" +
      '<div><div class="er-k">Technologies switched off</div><div class="er-v">' + (r.off.length ? esc(r.off.join(", ")) : "None") + "</div></div>" +
      "</div></div>";
    h += '<div class="er-k" style="margin-top:6px">Objective</div><div class="er-obj">' + OBJ.map(function (o) {
      return '<label class="' + (o[0] === objective ? "on" : "") + '"><input type="radio" name="er-obj" value="' + o[0] + '"' + (o[0] === objective ? " checked" : "") + "><span><b>" + o[1] + "</b><small>" + o[2] + "</small></span></label>";
    }).join("") + "</div>";
    if (syncNote) h += '<div class="er-msg info">' + esc(syncNote) + "</div>";
    if (r.skipped.length) h += '<div class="er-msg warn">Not used by the model, so ignored: ' + esc(r.skipped.join(", ")) + "</div>";
    if (state) h += state;
    h += '<button type="button" class="btn-next" id="er-run"' + (running ? " disabled" : "") + ">" + (running ? "Running..." : "Run optimization") + "</button>";
    runSlot.className = ""; runSlot.innerHTML = h;
    runSlot.querySelectorAll('input[name="er-obj"]').forEach(function (i) {
      i.addEventListener("change", function () { objective = i.value; renderRun(); });
    });
    el("er-run").addEventListener("click", run);
  }

  function msg(kind, text, spin) { return '<div class="er-msg ' + kind + '">' + (spin ? '<span class="er-spin"></span>' : "") + esc(text) + "</div>"; }

  function run() {
    if (running) return;
    var q = buildRequest(objective).req;
    if (q.feed_rate == null || q.feed_rate <= 0) { renderRun(msg("err", "Enter a feed rate on step 1.")); return; }
    if (q.operating_hours == null) { renderRun(msg("err", "Enter operating hours on step 1.")); return; }
    running = true;
    var waitText = objective === "BALANCE" ? "Solving. Best balance runs several optimizations, about 2 minutes." :
      objective === "GHG" ? "Solving, about 10 to 20 seconds." : "Solving, up to about a minute.";
    renderRun(msg("info", modelReady ? waitText : (loadText || "Loading the model in your browser..."), true));
    var t = setInterval(function () { if (modelReady && running) { clearInterval(t); renderRun(msg("info", waitText, true)); } }, 500);
    callModel("run", q).then(function (res) {
      clearInterval(t); running = false;
      if (res && res.status === "optimal") {
        var saved = { request: q, result: res, name: (el("fs-name") || {}).value || "Untitled", when: new Date().toISOString() };
        try { sessionStorage.setItem("ecofast_last_result", JSON.stringify(saved)); } catch (e) {}
        renderResults(saved);
        renderRun(msg("ok", "Done. Opening the results."));
        location.hash = "#results";
      } else {
        renderRun(msg("err", (res && res.message) || "The run failed."));
      }
    }).catch(function (e) {
      clearInterval(t); running = false;
      renderRun(msg("err", "The model could not run in this browser (" + e.message + "). Try a current Chrome, Edge, Firefox or Safari."));
    });
  }

  // ---------- Results page ----------
  var resSlot = document.querySelector("#page-results .soon");
  var COST_LABEL = { Annualized_capital: "Annualized capital", Working_capital: "Working capital", Insurance: "Insurance",
    Utilities: "Utilities", Labour: "Labor", Overhead: "Overhead", Materials_and_fuel: "Materials and fuel",
    Disposal: "Disposal", Fixed_charge: "Fixed charge", Total_cost: "Total cost", Total_revenue: "Total revenue",
    Tipping_revenue: "Tipping revenue (part of revenue)" };
  var OBJ_NAME = { NAC: "Lowest cost", GHG: "Lowest greenhouse gas", EP: "Lowest eutrophication", BALANCE: "Best balance" };

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
