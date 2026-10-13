"""ECO-FAST solve engine: turns website inputs into a model run and returns a JSON-ready answer.

All physics, costs and environmental factors come from model_core.py, which is generated from the
Pyomo/HiGHS notebook. This file only (1) maps website inputs onto the notebook's parameter container P,
(2) runs the requested objective, and (3) packages the result.
"""
import contextlib
import copy
import io
import threading
import time

import pyomo.environ as pyo
from pyomo.environ import Constraint, NonNegativeReals, Objective, Param, Var, minimize

with contextlib.redirect_stdout(io.StringIO()):      # silence the notebook prints at start-up
    import model_core as mc

_LOCK = threading.Lock()   # one solve at a time (HiGHS already uses the CPU cores)

OBJECTIVES = {
    "NAC": "Lowest cost (net annual cost)",
    "GHG": "Lowest greenhouse gas emissions",
    "EP": "Lowest marine eutrophication",
    "BALANCE": "Best balance of cost, GHG and EP",
}

# Website field -> notebook BASE_FEED key
FEED_FIELDS = {
    "moisture": "Moisture (%)",
    "carbohydrates": "Carbohydrate (%)",
    "proteins": "Protein (%)",
    "fats": "Lipid (%)",
    "ash": "Ash (%)",
    "fixed_carbon": "Fixed carbon (%)",
    "C": "C (%)", "H": "H (%)", "O": "O (%)", "N": "N (%)", "S": "S (%)",
    "hhv": "HHV (MJ/kg)",
}
ULTIMATE = ["C", "H", "O", "N", "S"]
TECH_NAMES = {"SHR": "Shredder", "MCR": "Macerator", "AER": "Aerobic pretreatment", "ENZ": "Enzymatic pretreatment",
              "HTL": "Hydrothermal liquefaction", "AND": "Anaerobic digestion", "SLF": "Sanitary landfill",
              "CMP": "Composting", "WWT": "Wastewater treatment", "INC": "Incineration", "CEN": "Centrifuge",
              "FLT": "Filtration", "ABS": "Water scrubbing (biogas upgrading)", "PSA": "Pressure swing adsorption",
              "STB": "Boiler + steam turbine", "BYP1": "Bypass 1", "BYP2": "Bypass 2", "BYP3": "Bypass 3"}
UNSOURCED_NOTE = ("FIXED_CHARGE and MIN_CAPACITY for stage II/III units are 0 (unsourced placeholders in the "
                  "notebook); results do not include a fixed charge or minimum plant size.")


class InputError(ValueError):
    """Bad user input. The message is shown to the user."""


# ---------------------------------------------------------------------------
# Defaults (what the website can show as 'typical values' / 'Reset to defaults')
# ---------------------------------------------------------------------------
def defaults():
    P = mc.P
    inv = {v: k for k, v in FEED_FIELDS.items()}
    f = P["feed"]
    feed = {inv[k]: v for k, v in f.items() if k in inv}
    feed["volatile_matter"] = f["Volatile matter (%)"]
    feed["other_organics"] = 100.0 - f["Carbohydrate (%)"] - f["Protein (%)"] - f["Lipid (%)"] - f["Ash (%)"]
    return {
        "feed_source": "Notebook base feed FW3 (FV50M50, phi = 0.5). Dry basis except moisture.",
        "feed": feed,
        "feed_rate_kg_h": P["Qf"],
        "operating_hours_h_yr": P["sc"]["Tann"],
        "scalars": {k: {"value": v, "description": P["desc"].get(k, "")} for k, v in P["sc"].items()},
        "reference_capital_cost_usd": P["C0"],
        "reference_capacity": P["Q0"],
        "specific_power": P["Wsp"],
        "labor_requirement": P["NLBR"],
        "product_prices": P["Price_prod"],
        "objectives": OBJECTIVES,
        "technologies": TECH_NAMES,
        "notes": [UNSOURCED_NOTE],
    }


# ---------------------------------------------------------------------------
# Input mapping
# ---------------------------------------------------------------------------
def _num(x, name):
    try:
        v = float(x)
    except (TypeError, ValueError):
        raise InputError(f"'{name}' must be a number.")
    if v != v or v in (float("inf"), float("-inf")):
        raise InputError(f"'{name}' must be a finite number.")
    return v


def build_parameters(req):
    """Copy of the notebook parameters with the user's inputs applied. Returns (P, defaults_used)."""
    P = copy.deepcopy(mc.P)
    used = []
    feed_in = {k: v for k, v in (req.get("feed") or {}).items() if v not in (None, "")}

    feed = dict(P["feed"])
    for web, key in FEED_FIELDS.items():
        if web in ULTIMATE:
            continue
        if web in feed_in:
            feed[key] = _num(feed_in[web], web)
        else:
            used.append(web)

    # Ultimate analysis: all five or none (they must close to 100%)
    given = [e for e in ULTIMATE if e in feed_in]
    if given and len(given) < 5:
        raise InputError("Give all of C, H, O, N, S (ash-free, summing to 100%) or leave all five empty.")
    if given:
        for e in ULTIMATE:
            feed[f"{e} (%)"] = _num(feed_in[e], e)
    else:
        used.append("C/H/O/N/S")

    # Volatile matter closes the dry proximate analysis
    feed["Volatile matter (%)"] = 100.0 - feed["Ash (%)"] - feed["Fixed carbon (%)"]

    if "other_organics" in feed_in:   # optional consistency check with the website's composition table
        oth = 100.0 - feed["Carbohydrate (%)"] - feed["Protein (%)"] - feed["Lipid (%)"] - feed["Ash (%)"]
        if abs(oth - _num(feed_in["other_organics"], "other_organics")) > 0.5:
            raise InputError(f"Dry composition must total 100%. With the values given, other organics should be {oth:.2f}%.")

    P["feed"] = feed

    rate = req.get("feed_rate")
    if rate not in (None, ""):
        rate = _num(rate, "feed_rate")
        unit = (req.get("feed_rate_unit") or "kg/hr").lower().replace(" ", "")
        if unit in ("kg/hr", "kg/h", "kghr"):
            P["Qf"] = rate
        elif unit in ("tonne/day", "t/day", "t/d", "tpd", "tday"):
            P["Qf"] = rate * 1000.0 / 24.0
        else:
            raise InputError("feed_rate_unit must be 'kg/hr' or 'tonne/day'.")
        if P["Qf"] <= 0:
            raise InputError("Feed rate must be positive.")
    else:
        used.append("feed_rate")

    hours = req.get("operating_hours")
    if hours not in (None, ""):
        hours = _num(hours, "operating_hours")
        if not 0 < hours <= 8760:
            raise InputError("Operating hours must be between 0 and 8760 h/yr.")
        P["sc"]["Tann"] = hours
    else:
        used.append("operating_hours")

    # Cost / environmental overrides, using the notebook's own parameter names
    ov = req.get("overrides") or {}
    for k, v in (ov.get("scalars") or {}).items():
        if k not in P["sc"]:
            raise InputError(f"Unknown parameter '{k}'.")
        P["sc"][k] = _num(v, k)
    for group in ("C0", "Q0", "Wsp", "NLBR", "Price_prod"):
        for k, v in (ov.get(group) or {}).items():
            if k not in P[group]:
                raise InputError(f"Unknown entry '{k}' in {group}.")
            P[group][k] = _num(v, f"{group}.{k}")

    try:
        mc.feed_data(P)        # same validity checks as the notebook
    except (ValueError, AssertionError) as e:
        raise InputError(f"Feed check failed: {e}")
    return P, used


# ---------------------------------------------------------------------------
# Objectives
# ---------------------------------------------------------------------------
_orig_set_objective = mc.set_objective


def _set_objective(mdl, which):
    if hasattr(mdl, "obj_BAL"):
        mdl.obj_BAL.deactivate()
    if which == "BAL":
        for name in ["obj_NAC", "obj_GHG", "obj_EP", "obj_AUG"]:
            if hasattr(mdl, name):
                getattr(mdl, name).deactivate()
        mdl.obj_BAL.activate()
    else:
        _orig_set_objective(mdl, which)


mc.set_objective = _set_objective   # solve_refined() looks this name up in model_core


def _lexicographic(mdl, first):
    """Same as one row of the notebook payoff table (CELL 49A): first objective, then the others."""
    names = mc.objective_names
    i = names.index(first)
    order = names[i:] + names[:i]
    mc.release_caps(mdl)
    best = None
    for stage, obj in enumerate(order):
        tc, r, _ = mc.solve_refined(mdl, obj)
        if tc != "optimal":
            if best is None:
                return tc, None
            break
        mdl.lex_cap[obj] = mc.lex_cap_value(mc.objective_value(r, obj))
        best = r
    mc.release_caps(mdl)
    return "optimal", best


def _balance(mdl):
    """Augmented Tchebycheff compromise (Steuer and Choo 1983) on the payoff-table ranges.
    Minimizes the largest normalized distance to the ideal point, plus a small sum term so the
    answer is Pareto-optimal. Equal weights for NAC, GHG and EP."""
    rows = {}
    for o in mc.objective_names:
        tc, r = _lexicographic(mdl, o)
        if tc != "optimal":
            return tc, None, None
        rows[o] = {"NAC": r["NAC_exact_cost"], "GHG": r["GHG"], "EP": r["EP"], "route": r["route"]}
    ideal = {k: min(rows[o][k] for o in rows) for k in ("NAC", "GHG", "EP")}
    nadir = {k: max(rows[o][k] for o in rows) for k in ("NAC", "GHG", "EP")}
    rng = {k: max(nadir[k] - ideal[k], 1e-9) for k in ideal}
    expr = {"NAC": mdl.NAC, "GHG": mdl.GHG_total_tpy, "EP": mdl.EP_marine_tpy}
    mdl.bal_t = Var(domain=NonNegativeReals)
    mdl.bal_c = Constraint(["NAC", "GHG", "EP"], rule=lambda b, k: (expr[k] - ideal[k]) / rng[k] <= mdl.bal_t)
    rho = 1e-3
    mdl.obj_BAL = Objective(expr=mdl.bal_t + rho * sum((expr[k] - ideal[k]) / rng[k] for k in expr), sense=minimize)
    mdl.obj_BAL.deactivate()
    tc, r, _ = mc.solve_refined(mdl, "BAL")
    payoff = [{"minimized": o, **{k: rows[o][k] for k in ("NAC", "GHG", "EP")}, "conversion_route": rows[o]["route"]} for o in rows]
    return tc, r, {"payoff_table": payoff, "ideal": ideal, "nadir": nadir}


# ---------------------------------------------------------------------------
# Result packaging
# ---------------------------------------------------------------------------
def _package(mdl, r):
    v = mc.pval
    byp = [b for b, var in [("BYP1", mdl.yBYP1), ("BYP2", mdl.yBYP2), ("BYP3", mdl.yBYP3)] if v(var) > 0.5]
    units = []
    for t, q in r["capacities"].items():
        units.append({"code": t, "name": TECH_NAMES[t], "capacity": q, "purchase_cost_usd": r["purchase_cost_exact"][t]})
    costs = {label: v(getattr(mdl, name)) for label, name in mc.cost_variables.items()} if hasattr(mc, "cost_variables") else {}
    return {
        "objectives": {"NAC_MUSD_per_yr": r["NAC_exact_cost"], "GHG_tCO2e_per_yr": r["GHG"], "EP_tN_eq_per_yr": r["EP"]},
        "pathway": {"mechanical": r["Mechanical"], "biological": r["Biological"], "conversion": r["Conversion"],
                    "htl_recovery": r["HTL_recovery"], "biogas_upgrading": r["Biogas_upgrading"]},
        "conversion_split": {k: x for k, x in r["fConv"].items() if x > 1e-4},
        "units": units,
        "bypasses": byp,
        "cost_breakdown_MUSD_per_yr": costs,
        **_impacts(mdl),
    }


def _impacts(mdl):
    """GHG contributions and saleable products of the solved design, read from the model variables."""
    v = mc.pval
    s = mdl.P["sc"]
    out = {}
    try:
        out["ghg_breakdown_t_per_yr"] = {
            "Energy_and_materials": v(mdl.GHG_ind_tpy),           # electricity, steam, natural gas, enzyme, water
            "Direct_emissions": v(mdl.GHG_dir_total),             # process CH4, N2O, fossil CO2
            "Residue_disposal": v(mdl.GHG_aq),                    # aqueous phase, char and ash disposal
            "Product_credits": -v(mdl.GHG_disp),                  # biomethane, biocrude, electricity, compost/biosolids N
            "Digestate_credit": -v(mdl.GHG_digestate),            # digestate used as fertilizer
        }
    except AttributeError:
        pass
    try:
        out["ep_breakdown_t_per_yr"] = _ep_breakdown(mdl)
    except (AttributeError, KeyError):
        pass
    prods = {}
    for kp in mdl.KP:
        q = sum(v(mdl.Mprod[t, kp]) for t in mdl.I)               # kg/h (electricity: kW)
        if abs(q) > 1e-9:
            price = mdl.P["Price_prod"][kp]
            prods[kp] = {"per_year": q * s["Tann"], "unit": "kWh" if kp == "ELECTRICITY" else "kg",
                         "revenue_MUSD_per_yr": s["Tann"] / 1e6 * price * q}
    out["products"] = prods
    return out


def _ep_breakdown(m):
    """Marine eutrophication split into the same terms as model_core cell_43_EP, t N-eq/yr."""
    v = mc.pval
    s, Fd = m.P["sc"], m.Fd
    Nf, TECH, ORG5 = Fd["N_frac"], mc.TECH, mc.ORG5
    N_landfill_in = Nf * sum(m.M["28", k] for k in ORG5)
    N_SHR_reject = Nf * sum(m.M["5", k] for k in ORG5)
    N_to_water = (m.N_HTL_discharge + m.N_eff_WWT + s["leach_frac_CMP"] * m.N_compost + s["leach_frac_AND"] * m.N_digestate
                  + s["leach_frac_SLF"] * (N_landfill_in + N_SHR_reject))
    direct = s["CF_N_water"] * N_to_water + s["CF_NOx_marine_EF"] * m.NOx_INC_kgph
    background = (s["EP_elec"] * sum(m.PW_op[t] for t in TECH) + s["EP_stm"] * sum(m.Mstm[t] for t in TECH)
                  + s["EP_NG_sup"] * (m.NG_aux_INC + m.M_NG_HTL) + s["EP_enz"] * m.M["15", "ENZYME"] + s["EP_water"] * m.process_water_added)
    disposal = s["EP_CHAR_disp"] * (m.HTL_solid_reject + m.m_ash_INC)
    product = s["EP_CH4_disp"] * m.M["56", "CH4"] + s["EP_BIOCRUDE_disp"] * m.M["47", "BIOCRUDE"] + s["EP_ELEC_disp"] * m.Mprod["STB", "ELECTRICITY"]
    fert = s["EP_Nfert"] * (s["MFE_CMP"] * m.N_compost + s["MFE_WWT"] * m.N_biosolids + s["MFE_AND"] * m.N_digestate)
    k = s["Tann"] / 1000.0
    return {"Nitrogen_to_water_and_air": k * v(direct), "Energy_and_materials": k * v(background), "Residue_disposal": k * v(disposal),
            "Product_credits": -k * v(product), "Fertilizer_credits": -k * v(fert)}


# cost_variables lives in the grid cell of the notebook, which is not part of model_core
mc.cost_variables = {"Annualized_capital": "CCAC", "Working_capital": "CCWC", "Insurance": "CCINS", "Utilities": "CCUC",
                     "Labour": "CCLB", "Overhead": "CCOC", "Materials_and_fuel": "CCRM", "Disposal": "CDISP",
                     "Fixed_charge": "CFIX", "Total_cost": "CCTC", "Total_revenue": "REV", "Tipping_revenue": "CTIP"}


def run(req):
    objective = (req.get("objective") or "NAC").upper()
    if objective not in OBJECTIVES:
        raise InputError(f"objective must be one of {list(OBJECTIVES)}.")
    P, used = build_parameters(req)
    disabled = [str(t).upper() for t in (req.get("disabled_technologies") or [])]
    bad = [t for t in disabled if t not in mc.TECH]
    if bad:
        raise InputError(f"Unknown technologies: {bad}.")
    allow_bypass = bool(req.get("allow_bypass", True))
    t0 = time.time()
    with _LOCK:
        mdl = mc.build_model(P)
        for t in disabled:                 # user switched the technology off on the Pathways step
            mdl.y[t].fix(0)
        if not allow_bypass:
            for b in (mdl.yBYP1, mdl.yBYP2, mdl.yBYP3):
                b.fix(0)
        extra = None
        if objective == "BALANCE":
            tc, r, extra = _balance(mdl)
        else:
            tc, r = _lexicographic(mdl, objective)
    if tc != "optimal" or r is None:
        return {"status": "no_solution", "message": f"No feasible design with these inputs and technology choices (solver status: {tc}).",
                "objective": objective, "defaults_used": used}
    out = {"status": "optimal", "objective": objective, "objective_label": OBJECTIVES[objective],
           "solver": f"HiGHS via Pyomo ({mc.SOLVER_NAME})", "solve_time_s": round(time.time() - t0, 2),
           "globally_certified": True, "inputs_used": {"feed": P["feed"], "feed_rate_kg_h": P["Qf"],
                                                       "operating_hours_h_yr": P["sc"]["Tann"]},
           "defaults_used": used, "disabled_technologies": disabled, "allow_bypass": allow_bypass,
           "notes": [UNSOURCED_NOTE], **_package(mdl, r)}
    if extra:
        out["balance"] = extra
    return out
