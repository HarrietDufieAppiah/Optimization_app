/*
  ECO-FAST model worker. Runs the Pyomo + HiGHS model inside the user's browser (Pyodide, WebAssembly),
  in the background so the page stays responsive. No server needed.

  Files it loads from this site: py/model_core.py, py/engine.py, py/pyomo-6.10.1-py3-none-any.whl
  Files it loads from the Pyodide CDN: Python itself, numpy, pandas, highspy (cached by the browser after the first visit).
*/
var PYODIDE_VERSION = "0.29.3";
importScripts("https://cdn.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/pyodide.js");

var BASE = self.location.href.replace(/[^\/]*$/, "");   // folder that holds this file
function status(text) { self.postMessage({ type: "status", text: text }); }

var ready = (async function () {
  status("Starting Python in your browser...");
  var py = await loadPyodide();
  status("Loading the solver (first visit only takes longer)...");
  await py.loadPackage(["numpy", "pandas", "highspy", "micropip", "ply"]);
  await py.runPythonAsync('import micropip\nawait micropip.install("' + BASE + 'py/pyomo-6.10.1-py3-none-any.whl", deps=False)');
  status("Loading the ECO-FAST model...");
  py.FS.mkdirTree("/app");
  for (var f of ["model_core.py", "engine.py"]) {
    var r = await fetch(BASE + "py/" + f, { cache: "no-cache" });
    if (!r.ok) throw new Error("Could not load py/" + f + " (" + r.status + ")");
    py.FS.writeFile("/app/" + f, await r.text());
  }
  await py.runPythonAsync([
    "import sys, json, contextlib",
    "sys.path.insert(0, '/app')",
    "# Browsers cannot start threads; Pyomo only uses one here to copy solver output, so turn that off.",
    "import pyomo.contrib.solver.solvers.highs as _h",
    "class _NoTee:",
    "    def __init__(self, *a, **k): pass",
    "_h.capture_output = lambda *a, **k: contextlib.nullcontext()",
    "_h.TeeStream = _NoTee",
    "import engine",
    "def _num(o):",
    "    try:",
    "        return float(o)",
    "    except Exception:",
    "        return str(o)",
    "def ecofast_call(kind, req_json):",
    "    try:",
    "        if kind == 'defaults':",
    "            out = engine.defaults()",
    "        else:",
    "            out = engine.run(json.loads(req_json))",
    "    except engine.InputError as e:",
    "        out = {'status': 'input_error', 'message': str(e)}",
    "    return json.dumps(out, default=_num)"
  ].join("\n"));
  status("");
  return py;
})();

self.onmessage = async function (e) {
  var d = e.data || {};
  try {
    var py = await ready;
    if (d.type === "warmup") { self.postMessage({ id: d.id, ok: true, result: null }); return; }
    var call = py.globals.get("ecofast_call");
    var out = call(d.type === "defaults" ? "defaults" : "run", JSON.stringify(d.req || {}));
    call.destroy();
    self.postMessage({ id: d.id, ok: true, result: JSON.parse(out) });
  } catch (err) {
    self.postMessage({ id: d.id, ok: false, error: String((err && err.message) || err).slice(-1500) });
  }
};
