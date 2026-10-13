"""ECO-FAST model core. AUTO-GENERATED from the Pyomo/HiGHS notebook (foodwaste_pyomo_milp.ipynb).
Do not edit by hand: change the notebook source and regenerate. Code is identical to the notebook cells
(CELL 2 to CELL 45, plus the solve helpers of CELL 46, apply_overrides, and the CELL 49A/50A model steps)."""

def display(*args, **kwargs):   # notebook display() is not needed on the server
    pass


# ----------------------------------------------------------------------

import pyomo
import highspy
import pyomo.environ as pyo

print("Pyomo version:", pyomo.__version__)
print("HiGHS installed:", pyo.SolverFactory("highs").available())



import copy
import time

import numpy as np
import pandas as pd

import pyomo.environ as pyo
from pyomo.environ import (Binary, ConcreteModel, Constraint, Expression, NonNegativeReals,
                           Objective, Param, Piecewise, Reals, Set, Var, minimize, value)

# =====================================================
# SOLVER SETTINGS
# =====================================================
SOLVER_NAME = "highs"
MIP_REL_GAP = 1e-6       # HiGHS relative MIP gap
TIME_LIMIT = 600         # seconds per solve, same limit as the original Pareto grid
PWL_REL_TOL = 0.01       # starting max chord error of the capital-cost PWL (L6); refined to exact

# =====================================================
# MODEL SETTINGS (Q1 to Q5)
#   NOTEBOOK_MODE = True  -> exact replica of the original notebook
#   NOTEBOOK_MODE = False -> literature-based corrections (default)
# =====================================================
NOTEBOOK_MODE = False

def settings():
    if NOTEBOOK_MODE:
        return {"cap_smooth": None, "stage23_binaries": False, "oth_from_scenario_feed": False, "lex_tolerance": 0.01}
    return {"cap_smooth": 0.0, "stage23_binaries": True, "oth_from_scenario_feed": True, "lex_tolerance": 1e-4}

# Parameter container: plays the role of the GAMSPy Container m for all data
P = {}

print("Solver:", SOLVER_NAME)
print("NOTEBOOK_MODE:", NOTEBOOK_MODE)
print("Active settings:", settings())
print("Parameter container created successfully.")



# Technologies
TECH = ["SHR", "MCR",
        "AER", "ENZ",
        "HTL", "AND", "SLF", "CMP", "WWT", "INC",
        "CEN", "FLT", "ABS", "PSA", "STB"]
# Streams
STREAMS = [str(x) for x in range(1, 62)]
# All stream components
COMP = ["CBH", "PRT", "FAT", "OTH",
        "WATER", "FC", "ASH",
        "BIOCRUDE", "CHAR", "AQ", "GAS",
        "COMPOST", "BIOSOLIDS", "ELECTRICITY",
        "CO2", "CH4", "N2O", "SO2",
        "N2", "O2", "NH3", "H2S",
        "ENZYME"]
# Components present in the food waste feed
K_FEED = ["WATER", "CBH", "PRT", "FAT", "OTH", "ASH"]
I_MECH = ["SHR", "MCR"]                                  # Mechanical pretreatment
I_BIO = ["AER", "ENZ"]                                   # Biological pretreatment
I_CONV = ["HTL", "AND", "SLF", "CMP", "WWT", "INC"]      # Conversion
I_REC = ["CEN", "FLT"]                                   # HTL product recovery
I_UPG = ["ABS", "PSA"]                                   # Biogas upgrading
KP = ["CH4", "BIOCRUDE", "COMPOST", "ELECTRICITY", "BIOSOLIDS"]   # Saleable products
STAGE23 = ["HTL", "AND", "SLF", "CMP", "WWT", "INC", "CEN", "FLT", "ABS", "PSA", "STB"]
ORG5 = ["CBH", "PRT", "FAT", "OTH", "FC"]                # dry ash-free organics (HTL, N accounting)

# Pretreatment pathways used by the exact Splitter-3 reformulation (L1):
# one mechanical choice x one biological choice, plus the full bypass BYP2
PATHWAYS = [(mech, bio) for mech in ["SHR", "MCR", "BYP1"] for bio in ["AER", "ENZ", "BYP3"]] + [("BYP2", "none")]
PATH_ID = {p: f"{p[0]}-{p[1]}" if p[1] != "none" else "BYP2" for p in PATHWAYS}
# Conversion branches; HTL is split into the share sent to CEN and the share sent to FLT (L2)
BRANCH = ["HTL_CEN", "HTL_FLT", "AND", "SLF", "CMP", "WWT", "INC"]
BRANCH_TECH = {"HTL_CEN": "HTL", "HTL_FLT": "HTL", "AND": "AND", "SLF": "SLF", "CMP": "CMP", "WWT": "WWT", "INC": "INC"}
BRANCH_STREAM = {"AND": "23", "SLF": "28", "CMP": "31", "WWT": "35", "INC": "38"}

print(f"Technologies: {len(TECH)}")
print(f"Streams: {len(STREAMS)}")
print(f"Components: {len(COMP)}")
print(f"Feed components: {len(K_FEED)}")
print(f"Pretreatment pathways: {len(PATHWAYS)}")



# CELL 3 — BASE FEED CHARACTERIZATION

# Base feed = FV50M50 (phi = 0.5) = FW3
# Moisture           = % wet basis
# VM / Ash / FC      = % dry basis
# CBH / PRT / Lipid  = % dry basis
# C / H / N / O / S  = % ash-free basis
# HHV                = MJ/kg dry basis

BASE_FEED = {
    "Moisture (%)": 75.95,
    "Volatile matter (%)": 80.23,
    "Ash (%)": 5.17,
    "Fixed carbon (%)": 14.60,
    "Carbohydrate (%)": 6.95,
    "Protein (%)": 44.82,
    "Lipid (%)": 19.28,
    "C (%)": 43.27,
    "H (%)": 6.05,
    "N (%)": 7.17,
    "O (%)": 42.89,
    "S (%)": 0.62,
    "HHV (MJ/kg)": 15.67
}

# Base plant feed rate (kg wet food waste/h)
BASE_QF = 1000.0

print("Base feed characterization created successfully.")
print("Base feed rate:", BASE_QF, "kg/h")
print(BASE_FEED)



P["Qf"] = BASE_QF               # Wet food waste feed rate (kg/h)
P["feed"] = dict(BASE_FEED)     # Feed characterization used by populate_feed()

print(f"Base feed rate: {P['Qf']:.2f} kg/h")
print("Feed parameters declared successfully.")



P["sc"] = {}
P["desc"] = {}

def sc(name, val, desc=""):
    """Scalar parameter, same call signature as the original notebook."""
    P["sc"][name] = val
    if desc:
        P["desc"][name] = desc
    return val

# Economic parameters
sc("T_amb", 25.0, "Ambient temperature (degC)")
sc("CAP_SMOOTH", 0.01, "Dimensionless smoothing parameter for equipment cost scaling")
sc("C_NG", 0.25, "Natural gas cost ($/kg)")
sc("r_fac", 0.06, "Facility-dependent annual cost factor")

sc("nc", 0.67, "Cost scaling exponent")
sc("BMC_mult", 5.4, "Bare-module cost multiplier")
sc("CRF", 0.11, "Capital recovery factor (1/yr)")
sc("Tann", 7920.0, "Annual operating hours (h/yr)")
sc("C_elec", 0.10, "Electricity cost ($/kWh)")
sc("C_stm", 0.012, "Steam cost ($/kg)")
sc("C_pwt", 0.00005, "Cooling water cost ($/kg)")
sc("C_water", 0.0053, "Process water cost ($/kg)")
sc("C_lbr", 30.0, "Labor cost ($/h)")
sc("C_tip", 0.055, "Tipping fee received ($/kg feed)")
sc("r_wc", 0.15, "Working capital fraction of FCI")
sc("r_ins", 0.01, "Insurance fraction of FCI per year")

# Physical constants
sc("rho_s", 1290.0, "Food-waste solids density (kg/m3)")
sc("rho_w", 1000.0, "Water density (kg/m3)")
sc("Cp_water", 4.2, "Water heat capacity (kJ/kg/K)")
sc("Cp_eff", 4.2, "Slurry heat capacity (kJ/kg/K)")
sc("dh_steam", 2046.5, "Steam latent heat (kJ/kg)")
sc("Vm_STP", 22.414, "Molar volume at STP (m3/kmol)")
sc("MW_CH4", 16.04, "Methane molecular weight (kg/kmol)")
sc("MW_CO2_AND", 44.01, "CO2 molecular weight (kg/kmol)")
sc("yO2_air", 0.232, "O2 mass fraction of air")
sc("yN2_air", 0.768, "N2 mass fraction of air")
sc("Tcw_in", 20.0, "Cooling water inlet temperature (degC)")
sc("Tcw_out", 40.0, "Cooling water outlet temperature (degC)")

print("Global economic and physical parameters created successfully.")
print(f"Scalars defined so far: {len(P['sc'])}")



# CELL 6 — BASE INDEXED DATA

BASE_C0 = {"SHR": 111000, "MCR": 111000, "AER": 103000, "ENZ": 399000, "WWT": 618000,
           "INC": 4700000, "HTL": 7853000, "CMP": 786000, "AND": 594000, "SLF": 450000,
           "CEN": 651000, "FLT": 651000, "ABS": 30000, "PSA": 80000, "STB": 443000}

BASE_Q0 = {"SHR": 10000, "MCR": 60000, "AER": 70, "ENZ": 10, "WWT": 210, "INC": 8000,
           "HTL": 5.32, "CMP": 350, "AND": 1000, "SLF": 0.15, "CEN": 18.79, "FLT": 18.79,
           "PSA": 50, "ABS": 32, "STB": 400}

BASE_WSP = {"SHR": 0.01, "MCR": 0.0123, "AER": 0.04, "ENZ": 0.04, "WWT": 0.04, "INC": 0.062,
            "HTL": 44.7, "CMP": 0.02, "AND": 0.0052, "SLF": 0.5, "CEN": 4.0, "FLT": 0.1,
            "ABS": 0.1, "PSA": 0.4, "STB": 0.02}

BASE_NLBR = {"SHR": 0.1, "MCR": 0.1, "AER": 0.5, "ENZ": 0.5, "WWT": 0.5, "INC": 1.0,
             "HTL": 2.0, "CMP": 0.5, "AND": 0.02, "SLF": 1.0, "CEN": 1.0, "FLT": 0.5,
             "ABS": 0.01, "PSA": 0.01, "STB": 0.05}

BASE_RFLT = {"BIOCRUDE": 0.04, "CHAR": 0.98, "AQ": 1.00}

BASE_RWW = {"CBH": 0.55, "PRT": 0.55, "FAT": 0.55, "OTH": 0.55, "WATER": 0.02, "ASH": 1.00, "FC": 1.00}

BASE_DEN = {"BIOCRUDE": 1200, "CHAR": 1500, "AQ": 1000}

BASE_PRICE_PROD = {
    "CH4": 0.55,
    "BIOCRUDE": 0.48,
    "COMPOST": 0.068,
    "ELECTRICITY": 0.10,
    "BIOSOLIDS": -0.127   # Class B land-application cost, $127/dry ton (Pima County AZ, 2017-2019), NACWA 2020 Cost Analysis of PFAS on Biosolids, Table 3-2
}

print("Base indexed data created successfully.")



# =====================================================
# MOLECULAR WEIGHTS
# =====================================================

MW_C = 12.011
MW_H = 1.008
MW_O = 16.00
MW_N = 14.01
MW_S = 32.06

_M_CH4 = MW_C + 4 * MW_H
_M_CO2 = MW_C + 2 * MW_O
_M_NH3 = MW_N + 3 * MW_H
_M_H2S = MW_S + 2 * MW_H
_M_H2O = 2 * MW_H + MW_O

# =====================================================
# BUSWELL YIELDS
# =====================================================

def buswell_yields(C_f, H_f, O_f, N_f, S_f):
    """Yields in kg per kg VS destroyed. H2O is consumed."""
    nC = C_f / MW_C
    h = (H_f / MW_H) / nC
    o = (O_f / MW_O) / nC
    n = (N_f / MW_N) / nC
    ss = (S_f / MW_S) / nC
    U = MW_C + MW_H * h + MW_O * o + MW_N * n + MW_S * ss
    return {"CH4": max(0.5 + h / 8 - o / 4 - 3 * n / 8 - ss / 4, 0.0) * _M_CH4 / U,
            "CO2": max(0.5 - h / 8 + o / 4 + 3 * n / 8 + ss / 4, 0.0) * _M_CO2 / U,
            "NH3": n * _M_NH3 / U,
            "H2S": ss * _M_H2S / U,
            "H2O_consumed": max(1 - h / 4 - o / 2 + 3 * n / 4 + ss / 2, 0.0) * _M_H2O / U}

# =====================================================
# AEROBIC YIELDS
# =====================================================

def aerobic_yields(C_f, H_f, O_f, N_f, S_f):
    """Aerobic oxidation yields in kg/kg VS degraded."""
    nC = C_f / MW_C
    nH = H_f / MW_H
    nO = O_f / MW_O
    nN = N_f / MW_N
    U = C_f + H_f + O_f + N_f + S_f
    _M_O2 = 2 * MW_O
    return {"O2": (nC + nH / 4 - nO / 2 - 3 * nN / 4) * _M_O2 / U,
            "CO2": nC * _M_CO2 / U,
            "H2O": (nH - 3 * nN) / 2 * _M_H2O / U,
            "NH3": nN * _M_NH3 / U}

# =====================================================
# HTL YIELDS
# =====================================================

def htl_yields(fat_dry, prt_dry):
    """HTL product yields, kg/kg dry ash-free organics."""
    y_bio = 0.395
    y_char = 0.045
    y_gas = 0.165
    y_aq = 1.0 - y_bio - y_char - y_gas
    return y_bio, y_char, y_aq, y_gas

# =====================================================
# HHV SANITY-CHECK CORRELATION
# =====================================================

def channiwala_parikh(C_, H_, S_, O_, N_, Ash_):
    """HHV from ultimate analysis, MJ/kg dry basis."""
    return 0.3491 * C_ + 1.1783 * H_ + 0.1005 * S_ - 0.1034 * O_ - 0.0151 * N_ - 0.0211 * Ash_

# =====================================================
# FEED UPDATE FUNCTION (same checks and formulas as populate_feed)
# =====================================================

def feed_data(P, label=None):
    f = P["feed"]
    required = list(BASE_FEED)
    if any(name not in f for name in required):
        raise ValueError("Feed dictionary is missing required measured properties.")
    if not all(np.isfinite(float(f[name])) for name in required):
        raise ValueError("Feed properties must be finite.")
    if not 0 <= f["Moisture (%)"] < 100:
        raise ValueError("Moisture must be in [0,100).")
    if min(f[name] for name in required) < 0:
        raise ValueError("Negative feed properties are invalid.")
    if f["C (%)"] <= 0:
        raise ValueError("Carbon fraction must be positive.")
    proximate_total = f["Volatile matter (%)"] + f["Fixed carbon (%)"] + f["Ash (%)"]
    if abs(proximate_total - 100) > 0.05:
        raise ValueError("Dry proximate composition must sum to 100%.")
    ultimate_total = sum(f[name] for name in ["C (%)", "H (%)", "O (%)", "N (%)", "S (%)"])
    if abs(ultimate_total - 100) > 0.05:
        raise ValueError("Ash-free ultimate composition must sum to 100%.")

    dry = {"CBH": f["Carbohydrate (%)"], "PRT": f["Protein (%)"], "FAT": f["Lipid (%)"], "ASH": f["Ash (%)"]}
    dry["OTH"] = 100.0 - dry["CBH"] - dry["PRT"] - dry["FAT"] - dry["ASH"]
    if dry["OTH"] < 0:
        raise ValueError("OTH cannot be negative.")
    dry_total = sum(dry.values())
    x_MC_val = f["Moisture (%)"] / 100.0
    ts_feed_val = 1.0 - x_MC_val
    X = {component: percent / 100.0 * ts_feed_val for component, percent in dry.items()}
    X["WATER"] = x_MC_val
    _frac_total = sum(X.values())
    if not np.isclose(_frac_total, 1.0):
        raise ValueError(f"Wet feed fractions do not sum to 1. Got {_frac_total:.8f}.")

    _buswell = buswell_yields(f["C (%)"], f["H (%)"], f["O (%)"], f["N (%)"], f["S (%)"])
    _aer = aerobic_yields(f["C (%)"], f["H (%)"], f["O (%)"], f["N (%)"], f["S (%)"])
    y_bio, y_char, y_aq, y_gas = htl_yields(f["Lipid (%)"] / 100.0, f["Protein (%)"] / 100.0)

    # OTH volatile share (CELL 23). The original computes it from BASE_FEED for every feed;
    # the corrected model (Q3) uses the feed actually being run.
    bf = f if settings()["oth_from_scenario_feed"] else BASE_FEED
    oth_dry = 100.0 - bf["Carbohydrate (%)"] - bf["Protein (%)"] - bf["Lipid (%)"] - bf["Ash (%)"]
    oth_vol = bf["Volatile matter (%)"] - bf["Carbohydrate (%)"] - bf["Protein (%)"] - bf["Lipid (%)"]
    assert 0.0 <= oth_vol <= oth_dry
    aer_oth = oth_vol / oth_dry if oth_dry > 0.0 else 0.0

    if label:
        print(f"[{label}] Moisture={100 * x_MC_val:.2f}% | total solids={100 * ts_feed_val:.2f}%")
        print(f"[{label}] Proximate total = {proximate_total:.2f}%")
        print(f"[{label}] Ultimate total = {ultimate_total:.2f}%")
        print(f"[{label}] Model dry components = {dry_total:.2f}%")
        print(f"[{label}] OTH = {dry['OTH']:.2f}% dry basis")
        print(f"[{label}] X closes to {_frac_total:.6f}")
        print(f"[{label}] Buswell AD yields:", {key: round(v, 4) for key, v in _buswell.items()})
        print(f"[{label}] HTL yields: bio={y_bio:.4f}, char={y_char:.4f}, aq={y_aq:.4f}, gas={y_gas:.4f}")
        print(f"[{label}] OTH volatile share = {aer_oth:.6f}")

    return {"X": X, "x_MC": x_MC_val, "TS_feed": ts_feed_val, "HHV_feed": f["HHV (MJ/kg)"],
            "C_frac": f["C (%)"] / 100.0, "H_frac": f["H (%)"] / 100.0, "O_frac": f["O (%)"] / 100.0,
            "N_frac": f["N (%)"] / 100.0, "S_frac": f["S (%)"] / 100.0,
            "CH4_yield_AND": _buswell["CH4"], "CO2_yield_AND": _buswell["CO2"], "NH3_yield_AND": _buswell["NH3"],
            "H2S_yield_AND": _buswell["H2S"], "H2O_yield_AND": _buswell["H2O_consumed"],
            "Y_O2_AER": _aer["O2"], "Y_CO2_AER": _aer["CO2"], "Y_H2O_AER": _aer["H2O"], "Y_NH3_AER": _aer["NH3"],
            "yHTL": {"BIOCRUDE": y_bio, "CHAR": y_char, "AQ": y_aq, "GAS": y_gas},
            "AER_OTH_VS_fraction": aer_oth}

# =====================================================
# POPULATE BASE CASE
# =====================================================

Fd = feed_data(P, label="BASE")
print("Feed characterization complete.")



# CELL 8 — FEED COMPONENT MASS FLOWS

F_feed_k = {k: P["Qf"] * Fd["X"][k] for k in K_FEED}

print("Feed component mass flows (kg/h):")
display(pd.DataFrame({"k_feed": list(F_feed_k), "value": list(F_feed_k.values())}))
print("Total feed component flow:", sum(F_feed_k.values()), "kg/h")


# CELL 9 — STAGE I: PRETREATMENT TECHNOLOGY PARAMETERS

# SHR — SHREDDING
sc("eta_SHR", 0.98, "Shredder mass recovery fraction")

# MCR — MECHANICAL PRETREATMENT
sc("TS_MCR", 0.20, "Target total solids after MCR")

# AER — AEROBIC PRETREATMENT
sc("theta_AER", 48.0, "AER residence time (h)")
sc("f_deg_AER", 0.026, "Fraction of VS degraded in AER")
sc("eps_AER", 0.80, "AER working-volume fraction")
sc("EAR_AER", 2.0, "AER excess-air ratio")

# ENZ — ENZYMATIC PRETREATMENT
sc("r_enz", 0.02, "Enzyme dosage")
sc("HRT_ENZ", 6.0, "ENZ hydraulic residence time (h)")
sc("C_enzyme", 2.00, "Enzyme cost ($/kg)")
sc("delta_ENZ", 0.25, "Increase in downstream degradability from ENZ; best case, maximum the eta_AND cap allows")
sc("delta_AER", 0.0, "Increase in AND VS destruction from AER; 0 base (CH4 potential unchanged, Wu et al. 2018; Fisgativa et al. 2018), 0.15 sensitivity")
sc("eps_ENZ", 0.80, "ENZ working-volume fraction")
sc("T_ENZ", 55.0, "ENZ operating temperature (degC)")

print("Stage I pretreatment parameters created successfully.")



# CELL 10 — STAGE II: CONVERSION TECHNOLOGY PARAMETERS

# HTL — HYDROTHERMAL LIQUEFACTION
sc("TS_HTL", 0.20, "HTL feed total-solids fraction")
sc("rho_HTL", 1006.0, "HTL feed density at 25 degC and 20.5 MPa (kg/m3), IAPWS-IF97")
sc("T_HTL", 340.0, "HTL operating temperature (degC)")
sc("etaHX_HTL", 0.77, "HTL heat-recovery efficiency")
sc("theta_HTL", 0.2833, "HTL residence time, PNNL-32731 LHSV 3.6/h (h)")
sc("eps_HTL", 1.0, "HTL working-volume fraction")
sc("dh_w_HTL", 1446.0, "HTL water heating enthalpy (kJ/kg)")
sc("LHV_NG", 50.0, "Natural gas lower heating value (MJ/kg)")
sc("eta_fh", 0.825, "Fired-heater efficiency")
sc("HHV_HTLgas", 4.2, "HTL gas heating value (MJ/kg)")

# AND — ANAEROBIC DIGESTION
sc("theta_AND", 720.0, "AND residence time (h)")
sc("r_rate_AER", 0.22, "AD daily CH4 production rate gain from aerobic pretreatment (+22% at 5 d; CH4 potential unchanged), Wu et al. 2018 Bioresour Technol 261:279")
sc("r_rate_ENZ", 0.82, "AD rate gain from enzymatic pretreatment; 0 base, sensitivity 0-2.5 (3.5x rate in lab batch, Kiran et al. 2015)")
sc("epsilon_AND", 0.85, "AND working-volume fraction")
sc("TS_AND", 0.10, "AND feed total-solids fraction")
sc("eta_AND", 0.80, "AND volatile-solids destruction fraction")
sc("eta_OTH_AND", 0.30, "AND OTH degradability")
sc("eta_cap_AND", 0.954, "AND biogas capture efficiency")
sc("T_AND", 35.0, "AND operating temperature (degC)")

# SLF — SANITARY LANDFILL
sc("DOC_value", 0.38, "Degradable organic carbon fraction")
sc("DOC_f_value", 0.70, "Fraction of DOC that decomposes")
sc("MCF_value", 1.0, "Methane correction factor")
sc("F_value", 0.50, "Methane fraction in landfill gas")
sc("ratio_CH4_to_C", 1.3333, "CH4-to-carbon mass ratio")
sc("density_CH4", 0.717, "Methane density (kg/m3)")
sc("Depth_SLF", 10.0, "Landfill depth (m)")
sc("ACRE", 4046.86, "Area conversion factor (m2/acre)")
sc("OX", 0.10, "Landfill methane oxidation factor")
sc("CAP_SLF", 0.75, "Landfill methane capture efficiency")
sc("rho_SLF", 1302.0, "Landfilled waste density (kg/m3)")
sc("C_disp_land", 0.05, "Landfill disposal cost ($/kg)")

# CMP — COMPOSTING
sc("fdeg_CMP", 0.50, "Fraction degraded in composting")
sc("EF_CH4_CMP_wet", 0.004, "Composting CH4 emission factor")
sc("EF_N2O_CMP_wet", 0.00024, "Composting N2O emission factor")
sc("theta_CMP", 252.0, "Composting residence time (h)")
sc("epsilon_CMP", 0.70, "Composting working-volume fraction")
sc("eta_OTH_CMP", 0.60, "OTH degradability in composting")
sc("EAR_CMP", 2.5, "Composting excess-air ratio")

# WWT — WASTEWATER TREATMENT
sc("rho_ww", 1000.0, "Wastewater density (kg/m3)")
sc("f_ox_WWT", 0.069, "WWT oxidation fraction")
sc("f_dig_WWT", 0.44, "VS destroyed in aerobic sludge digester (38-50%), Moore 2021 WEF/ORNL training #10")
sc("e_COD_WWT", 1.9, "Whole-plant electricity (kWh/kg COD removed), Water Pract. Technol. 16(3):851, 2021")
sc("FM_day", 4.0, "WWT food-to-microorganism ratio basis")
sc("X_MLSS", 5.0, "Mixed liquor suspended solids concentration")

# INC — INCINERATION
sc("lambda_inc", 1.9, "Incinerator excess-air ratio")
sc("EF_CH4_INC_wet", 2e-7, "Incineration CH4 emission factor")
sc("EF_N2O_INC_wet", 5e-5, "Incineration N2O emission factor")
sc("LHV_selfsust", 6.0, "Minimum LHV for self-sustaining combustion (MJ/kg)")
sc("hfg_water", 2.44, "Water vaporization energy (MJ/kg)")
sc("MW_NG", 16.043, "Natural gas molecular weight (kg/kmol)")
sc("EF_NG_fossil", 2.743, "Fossil natural gas CO2 emission factor")

print("Stage II conversion parameters created successfully.")



# CELL 11 — STAGE III: RECOVERY & UPGRADING TECHNOLOGY PARAMETERS

# CEN / FLT — HTL PRODUCT RECOVERY
sc("Eff_CNT", 1.0, "HTL product recovery efficiency")

# ABS — BIOGAS ABSORPTION
sc("Pur_CH4", 0.96, "Target biomethane CH4 purity")
sc("slipCH4_ABS", 0.015, "CH4 slip fraction in ABS")
sc("etaCO2_ABS", 0.985, "CO2 removal efficiency in ABS")
sc("e_el_ABS", 0.25, "ABS electricity demand")
sc("w_ABS", 0.05, "ABS water demand")

# PSA — PRESSURE SWING ADSORPTION
sc("slipCH4_PSA", 0.018, "CH4 slip fraction in PSA")
sc("etaCO2_PSA", 0.985, "CO2 removal efficiency in PSA")
sc("e_el_PSA", 0.25, "PSA electricity demand")

# STB — STEAM TURBINE / BOILER
sc("T_g_in", 850.0, "Flue-gas inlet temperature (degC)")
sc("T_g_out", 200.0, "Flue-gas outlet temperature (degC)")
sc("CP_g", 1.15, "Flue-gas heat capacity (kJ/kg/K)")
sc("h_stm_STB", 3214.4, "Steam enthalpy (kJ/kg)")
sc("h_fw_STB", 191.8, "Feedwater enthalpy (kJ/kg)")
sc("h_2s_STB", 2144.5, "Isentropic turbine outlet enthalpy (kJ/kg)")
sc("eta_turbine", 0.85, "Steam turbine efficiency")
sc("eta_generator", 0.95, "Generator efficiency")

print("Stage III recovery and upgrading parameters created successfully.")



# CELL 12 — INDEXED TECHNOLOGY PARAMETERS

P["C0"] = dict(BASE_C0)                 # Reference equipment capital cost ($)
P["Q0"] = dict(BASE_Q0)                 # Reference equipment capacity
P["Wsp"] = dict(BASE_WSP)               # Specific electricity requirement
P["NLBR"] = dict(BASE_NLBR)             # Technology labor requirement
P["rFLT"] = dict(BASE_RFLT)             # HTL filtration product recovery fraction (to reject)
P["rWW"] = dict(BASE_RWW)               # Fraction of component reporting to WWT waste sludge
P["DEN"] = dict(BASE_DEN)               # Product density (kg/m3)
P["Price_prod"] = dict(BASE_PRICE_PROD) # Product price ($/kg; electricity $/kWh)

print("Indexed technology parameters created successfully.")
print("C0 technologies:", len(P["C0"]))
print("Q0 technologies:", len(P["Q0"]))
print("Wsp technologies:", len(P["Wsp"]))
print("NLBR technologies:", len(P["NLBR"]))



# CELL 13 — DISPOSAL COSTS & ENVIRONMENTAL PARAMETERS

# DISPOSAL COSTS
sc("C_disp_reject", 0.05, "Reject disposal cost ($/kg)")
sc("C_disp_aq", 0.030, "Aqueous-phase disposal cost ($/kg)")
sc("C_sewer_flow", 0.000696, "Sewer flow charge ($/kg effluent water), EBMUD $1.97/Ccf, rates eff. 1 Jul 2026")
sc("C_sewer_COD", 0.463, "Sewer COD charge ($/kg COD), EBMUD $0.21/lb, rates eff. 1 Jul 2026")
sc("C_disp_char", 0.05, "Char disposal cost ($/kg)")

# GLOBAL WARMING POTENTIAL
sc("GWP_CH4", 34.0, "CH4 global warming potential (kg CO2-eq/kg CH4)")
sc("GWP_N2O", 298.0, "N2O global warming potential (kg CO2-eq/kg N2O)")

# ELECTRICITY
sc("EF_elec", 0.676, "Electricity GHG emission factor")
sc("EP_elec", 4.69e-5, "Electricity eutrophication factor")

# STEAM
sc("EF_stm", 0.2103, "Steam GHG emission factor")
sc("EP_stm", 1.478e-6, "Steam eutrophication factor")

# NATURAL GAS SUPPLY
sc("EF_NG_sup", 0.7225, "Natural gas supply GHG emission factor")
sc("EP_NG_sup", 1.202e-5, "Natural gas supply eutrophication factor")

# ENZYME
sc("EF_enz", 7.18, "Enzyme GHG emission factor")
sc("EP_enz", 8.06e-3, "Enzyme eutrophication factor")

# PROCESS WATER
sc("EF_water", 5.63e-4, "Process water GHG emission factor")
sc("EP_water", 2.27e-8, "Process water eutrophication factor")

# WWT EMISSIONS
sc("B0_WWT", 0.25, "WWT maximum methane-producing capacity")
sc("MCF_WWT", 0.034, "WWT methane correction factor")
sc("EF_N2O_WWT", 0.016, "WWT N2O emission factor")

# HTL GAS
sc("EF_HTLgas", 0.0, "HTL gas direct emission factor")

# NUTRIENT / LEACHING PARAMETERS
sc("leach_frac_AND", 0.194, "Nitrogen leaching fraction for AND")
sc("leach_frac_CMP", 0.0065, "Nitrogen leaching fraction for CMP")
sc("leach_frac_SLF", 0.01, "Nitrogen leaching fraction for SLF")

# INCINERATION NOx
sc("EF_NOx_INC_wet", 0.00183, "Incineration NOx emission factor")
sc("CF_NOx_marine_EF", 0.0902, "Marine eutrophication characterization factor for NOx")
sc("CF_N_water", 0.297, "Waterborne nitrogen characterization factor")

# HTL GAS VENTING
sc("HTL_gas_vent_frac", 0.10, "Fraction of HTL gas vented")
sc("HTL_gas_CH4_frac", 0.08, "CH4 fraction of HTL gas")

print("Disposal and environmental parameters created successfully.")



# CELL 14 — DISPLACEMENT CREDITS AND REMAINING ENVIRONMENTAL PARAMETERS

# Biomethane replaces pipeline natural gas
sc("EF_CH4_disp", 3.466)
sc("EP_CH4_disp", 1.202e-5)

# Raw biocrude replaces heavy fuel oil
sc("f_HV_bio", 0.885)
sc("EF_BIOCRUDE_disp", 3.203)
sc("EP_BIOCRUDE_disp", 5.76e-5)

# Electricity displacement
sc("EF_ELEC_disp", 0.676)
sc("EP_ELEC_disp", 4.69e-5)

# FERTILISER CREDITS
sc("EF_Nfert", 10.6)
sc("EP_Nfert", 1.59e-4)
sc("MFE_CMP", 0.20)
sc("MFE_AND", 0.50)
sc("MFE_WWT", 0.40)

# DISPOSAL BURDENS
sc("EF_AQ_disp", 5.78e-4)
sc("EF_CHAR_disp", 5.34e-3)
sc("EP_CHAR_disp", 4.52e-8)

# AQUATIC NITROGEN
# Assumption: 65% of incoming HTL nitrogen enters the aqueous phase.
sc("HTL_N_to_AQ", 0.65)

# Incineration energy-balance assumptions
sc("MAX_NG_PER_WET_FEED", 1.0)
sc("ETA_BOILER_INC", 0.825)

# HTL aqueous-phase treatment assumptions
sc("HTL_AQ_N_removal", 0.0)
sc("HTL_AQ_N2O_N_frac", 0.0)

# Biocrude nitrogen proxy
sc("HTL_bio_N_fraction", 0.04)

# Aeration assumption
sc("AE_O2", 1.2)

# HTL solids heat capacity
sc("Cp_solids_HTL", 1.5)

print("Environmental credits and remaining assumptions created successfully.")
print(f"Total scalar parameters: {len(P['sc'])}")



# Q2 inputs: UNSOURCED PLACEHOLDERS (0). Fill from literature before using results.
FIXED_CHARGE = {t: 0.0 for t in STAGE23}    # $/yr charged when the unit exists (y = 1)
MIN_CAPACITY = {t: 0.0 for t in STAGE23}    # minimum installed capacity when it exists (Qc units)

# Q1: capital-cost smoothing
if settings()["cap_smooth"] is not None:
    P["sc"]["CAP_SMOOTH"] = settings()["cap_smooth"]

# Q3: refresh feed-derived data with the active setting
Fd = feed_data(P)

print("NOTEBOOK_MODE:", NOTEBOOK_MODE)
print(f"Q1 CAP_SMOOTH used in the capital cost: {P['sc']['CAP_SMOOTH']}")
print(f"Q2 stage II/III existence binaries: {settings()['stage23_binaries']}"
      + ("  (FIXED_CHARGE and MIN_CAPACITY are unsourced placeholders = 0)" if settings()["stage23_binaries"] else ""))
print(f"Q3 OTH volatile share from the scenario feed: {settings()['oth_from_scenario_feed']}  -> {Fd['AER_OTH_VS_fraction']:.6f}")
print(f"Q4 lexicographic tolerance: {settings()['lex_tolerance']}")
print("Q5 objectives: NAC, GHG, marine EP")



M_BIG_BOUND = 100000.0   # notebook M_big, kept only as the generic stream upper bound

def capital_curve(x, s, n):
    """Notebook Capital_eq: PurchaseCost / C0 as a function of x = Qc/Q0."""
    return ((x + s) ** n - s ** n) / ((1.0 + s) ** n - s ** n)

def derive_bounds(P, F):
    """All variable bounds of CELL 44, same formulas."""
    s = P["sc"]
    feed_max = P["Qf"]
    dry_feed_max = feed_max * F["TS_feed"]
    raw_water_max = feed_max * F["x_MC"]
    enzyme_max = s["r_enz"] * dry_feed_max
    dry_max = dry_feed_max + enzyme_max
    mcr_water_max = dry_feed_max * (1.0 / s["TS_MCR"] - 1.0)
    inlet_water_max = max(raw_water_max, mcr_water_max)
    wet_inlet_max = dry_max + inlet_water_max
    htl_water_max = max(inlet_water_max, dry_max * (1.0 / s["TS_HTL"] - 1.0))
    and_water_max = max(inlet_water_max, dry_max * (1.0 / s["TS_AND"] - 1.0))
    and_eta_max = s["eta_AND"] * (1.0 + s["delta_ENZ"] + s["delta_AER"])
    assert 0.0 <= s["eta_AND"] <= and_eta_max <= 1.0, "AND conversion bounds must be between 0 and 1."
    B = dict(feed_max=feed_max, dry_feed_max=dry_feed_max, raw_water_max=raw_water_max, enzyme_max=enzyme_max,
             dry_max=dry_max, mcr_water_max=mcr_water_max, inlet_water_max=inlet_water_max,
             wet_inlet_max=wet_inlet_max, htl_water_max=htl_water_max, and_water_max=and_water_max,
             and_eta_max=and_eta_max)
    B["aer_work_max"] = s["theta_AER"] * (dry_feed_max / s["rho_s"] + inlet_water_max / s["rho_w"])
    B["aer_capacity_max"] = B["aer_work_max"] / s["eps_AER"]
    B["aer_degraded_max"] = s["f_deg_AER"] * dry_feed_max
    B["aer_oxygen_max"] = F["Y_O2_AER"] * B["aer_degraded_max"]
    B["enz_work_max"] = s["HRT_ENZ"] * (dry_max / s["rho_s"] + inlet_water_max / s["rho_w"])
    B["enz_capacity_max"] = B["enz_work_max"] / s["eps_ENZ"]
    B["htl_work_max"] = s["theta_HTL"] * (dry_max / s["rho_s"] + htl_water_max / s["rho_HTL"])
    B["htl_capacity_max"] = B["htl_work_max"] / s["eps_HTL"]
    B["htl_heat_max"] = (1.0 - s["etaHX_HTL"]) * (htl_water_max * s["dh_w_HTL"] + dry_max * s["Cp_solids_HTL"] * (s["T_HTL"] - s["T_amb"]))
    B["htl_gas_max"] = F["yHTL"]["GAS"] * dry_max
    B["H_gas_HTL_up"] = 1000.0 * s["HHV_HTLgas"] * (1.0 - s["HTL_gas_vent_frac"]) * s["eta_fh"] * B["htl_gas_max"]
    B["M_NG_HTL_up"] = B["htl_heat_max"] / (1000.0 * s["LHV_NG"] * s["eta_fh"])
    B["and_work_max"] = s["theta_AND"] * (dry_max / s["rho_s"] + and_water_max / s["rho_w"])
    B["and_capacity_max"] = B["and_work_max"] / s["epsilon_AND"]
    B["slf_ch4_max"] = dry_max * s["DOC_value"] * s["DOC_f_value"] * s["MCF_value"] * s["F_value"] * s["ratio_CH4_to_C"]
    B["slf_co2_max"] = B["slf_ch4_max"] * (1.0 - s["F_value"]) / s["F_value"] * s["MW_CO2_AND"] / s["MW_CH4"]
    B["slf_volume_max"] = wet_inlet_max * s["Tann"] / s["rho_SLF"]
    B["slf_capacity_max"] = B["slf_volume_max"] / (s["Depth_SLF"] * s["ACRE"])
    B["cmp_work_max"] = s["theta_CMP"] * (dry_max / s["rho_s"] + inlet_water_max / s["rho_w"])
    B["cmp_capacity_max"] = B["cmp_work_max"] / s["epsilon_CMP"]
    B["cmp_degraded_max"] = s["fdeg_CMP"] * dry_max
    B["cmp_oxygen_max"] = F["Y_O2_AER"] * B["cmp_degraded_max"]
    B["wwt_degraded_max"] = s["f_ox_WWT"] * dry_max
    B["wwt_capacity_max"] = F["Y_O2_AER"] * dry_max
    INC_MW_O2, INC_MW_N2 = 2.0 * MW_O, 2.0 * MW_N
    INC_MW_N2O, INC_MW_NO2 = 2.0 * MW_N + MW_O, MW_N + 2.0 * MW_O
    B["inc_ng_max"] = s["MAX_NG_PER_WET_FEED"] * wet_inlet_max
    B["inc_nC_max"] = dry_max * F["C_frac"] / MW_C
    B["inc_nH_max"] = dry_max * F["H_frac"] / MW_H
    B["inc_nO_max"] = dry_max * F["O_frac"] / MW_O
    B["inc_nN_max"] = dry_max * F["N_frac"] / MW_N
    B["inc_nS_max"] = dry_max * F["S_frac"] / MW_S
    B["inc_nNG_max"] = B["inc_ng_max"] / _M_CH4
    inc_n2o_max = s["EF_N2O_INC_wet"] * wet_inlet_max / INC_MW_N2O
    inc_no2_max = s["EF_NOx_INC_wet"] * wet_inlet_max / INC_MW_NO2
    B["inc_o2_sto_max"] = B["inc_nC_max"] + 0.25 * B["inc_nH_max"] + B["inc_nS_max"] + 2.0 * B["inc_nNG_max"] + 0.5 * inc_n2o_max + inc_no2_max
    B["inc_o2_in_max"] = s["lambda_inc"] * B["inc_o2_sto_max"]
    B["inc_n2_air_max"] = (0.79 / 0.21) * B["inc_o2_in_max"]
    inc_air_max = INC_MW_O2 * B["inc_o2_in_max"] + INC_MW_N2 * B["inc_n2_air_max"]
    B["inc_flue_max"] = wet_inlet_max + B["inc_ng_max"] + inc_air_max
    B["INC_net_heat_lo"] = -s["hfg_water"] * (inlet_water_max + _M_H2O * 0.5 * B["inc_nH_max"])
    B["INC_net_heat_up"] = F["HHV_feed"] * dry_max
    B["recovery_capacity_max"] = (dry_max + htl_water_max) / min(P["DEN"][c] for c in ["BIOCRUDE", "CHAR", "AQ"])
    B["and_gas_max"] = (F["CH4_yield_AND"] + F["CO2_yield_AND"]) * dry_max
    B["combined_gas_max"] = B["and_gas_max"] + B["slf_ch4_max"] + B["slf_co2_max"]
    B["upgrading_capacity_max"] = B["combined_gas_max"] * s["Vm_STP"] / min(s["MW_CH4"], s["MW_CO2_AND"])
    B["stb_heat_max"] = B["inc_flue_max"] * s["CP_g"] * (s["T_g_in"] - s["T_g_out"])
    B["stb_steam_max"] = B["stb_heat_max"] / (s["h_stm_STB"] - s["h_fw_STB"])
    B["stb_turbine_max"] = B["stb_steam_max"] * (s["h_stm_STB"] - s["h_2s_STB"])
    B["stb_capacity_max"] = s["eta_turbine"] * s["eta_generator"] * B["stb_turbine_max"] / 3600.0
    B["stb_cooling_max"] = B["stb_steam_max"] * (s["h_stm_STB"] - s["eta_turbine"] * (s["h_stm_STB"] - s["h_2s_STB"]) - s["h_fw_STB"]) / (s["Cp_water"] * (s["Tcw_out"] - s["Tcw_in"]))
    B["capacity_limits"] = {"SHR": feed_max, "MCR": feed_max, "AER": B["aer_capacity_max"], "ENZ": B["enz_capacity_max"],
                            "HTL": B["htl_capacity_max"], "AND": B["and_capacity_max"], "SLF": B["slf_capacity_max"],
                            "CMP": B["cmp_capacity_max"], "WWT": B["wwt_capacity_max"], "INC": wet_inlet_max,
                            "CEN": B["recovery_capacity_max"], "FLT": B["recovery_capacity_max"],
                            "ABS": B["upgrading_capacity_max"], "PSA": B["upgrading_capacity_max"], "STB": B["stb_capacity_max"]}
    B["PurchaseCost_up"] = {t: P["C0"][t] * capital_curve(c / P["Q0"][t], s["CAP_SMOOTH"], s["nc"]) for t, c in B["capacity_limits"].items()}
    B["Nlabr_up"] = {t: P["NLBR"][t] * c / P["Q0"][t] for t, c in B["capacity_limits"].items()}
    return B

def _dry(m, j):
    return sum(m.M[j, k] for k in COMP if k != "WATER")

def _wet(m, j):
    return sum(m.M[j, k] for k in COMP)

def _dry_of(vec):
    return sum(vec[k] for k in COMP if k != "WATER")

def _fix_zero(m, j, keep):
    """Notebook '..._zero' equations M[j,k] == 0 are imposed by fixing those variables to 0."""
    for k in COMP:
        if k not in keep:
            m.M[j, k].fix(0.0)

def _no_utility_no_product(m, t, steam=True, cw=True, prod_keep=()):
    """Notebook Mstm_*_zero, Mcw_*_zero and Mprod_*_zero equations."""
    if steam:
        m.Mstm[t].fix(0.0)
    if cw:
        m.Mcw[t].fix(0.0)
    for kp in KP:
        if kp not in prod_keep:
            m.Mprod[t, kp].fix(0.0)

def pwl_breakpoints(cap_max, Q0, s_cap, n_cap, rel_tol, extra=()):
    """Breakpoints (Qc units) for the capital-cost PWL on [0, cap_max] (L6).
    Each segment is as long as possible while the chord stays within rel_tol of the true curve."""
    X = cap_max / Q0
    g = lambda x: capital_curve(x, s_cap, n_cap)

    def seg_err(a, b):
        xs = np.linspace(a, b, 60)[1:-1]
        if len(xs) == 0 or b <= a:
            return 0.0
        chord = g(a) + (g(b) - g(a)) * (xs - a) / (b - a)
        return float(np.max((g(xs) - chord) / np.maximum(g(xs), 1e-300)))

    pts, a = [0.0], 0.0
    if s_cap == 0.0:
        # Plain power law: infinite slope at 0, so keep the first segment tiny (1e-4 of the range)
        a = 1e-4 * X
        pts.append(a)
    while a < X * (1 - 1e-12):
        if seg_err(a, X) <= rel_tol:
            b = X
        else:
            lo, hi = a, X
            for _ in range(60):
                mid = 0.5 * (lo + hi)
                if seg_err(a, mid) <= rel_tol:
                    lo = mid
                else:
                    hi = mid
            b = lo if lo > a else hi
        pts.append(b)
        a = b
    qs = sorted(set([p * Q0 for p in pts] + [float(e) for e in extra if 0.0 < e < cap_max]))
    qs[-1] = cap_max
    out = [qs[0]]
    for q in qs[1:]:
        if q - out[-1] > 1e-9 * max(1.0, cap_max):
            out.append(q)
    out[-1] = cap_max
    return out

def glover(m, name, ybin, x, U):
    """EXACT linearization of u = y * x with y binary and 0 <= x <= U (Glover 1975):
    u <= U*y ; u <= x ; u >= x - U*(1 - y)."""
    u = Var(domain=NonNegativeReals, bounds=(0.0, U))
    setattr(m, f"u_{name}", u)
    setattr(m, f"L3_{name}_1", Constraint(expr=u <= U * ybin))
    setattr(m, f"L3_{name}_2", Constraint(expr=u <= x))
    setattr(m, f"L3_{name}_3", Constraint(expr=u >= x - U * (1 - ybin)))
    return u

# ---------------- build-step registry ----------------
BUILD_STEPS = []

def new_model(P, extra_bp=None):
    """Empty model carrying the data every step needs."""
    mdl = ConcreteModel(name="FoodWaste_MILP")
    mdl.P = P
    mdl.Fd = feed_data(P)
    mdl.B = derive_bounds(P, mdl.Fd)
    mdl.X = {k: mdl.Fd["X"].get(k, 0.0) for k in COMP}
    mdl.extra_bp = dict(extra_bp or {})
    return mdl

def model_step(fn):
    """Register a build step and run it on the notebook model m."""
    BUILD_STEPS[:] = [f for f in BUILD_STEPS if f.__name__ != fn.__name__] + [fn]
    fn(globals()["m"])
    return fn

def build_model(P_new, extra_bp=None, upto=None):
    """Rebuild the whole model (all registered steps) for a new parameter set."""
    mdl = new_model(P_new, extra_bp)
    for fn in BUILD_STEPS[:upto]:
        fn(mdl)
    return mdl

print("Model builder ready.")


# CELL 15 — MODEL VARIABLES

m = new_model(P)
BUILD_STEPS = []     # rerunning from this cell rebuilds the model from scratch

@model_step
def cell_15_model_variables(m):
    # SETS
    m.I = Set(initialize=TECH, ordered=True)
    m.J = Set(initialize=STREAMS, ordered=True)
    m.K = Set(initialize=COMP, ordered=True)
    m.KP = Set(initialize=KP, ordered=True)
    m.ICONV = Set(initialize=I_CONV, ordered=True)
    m.IUPG = Set(initialize=I_UPG, ordered=True)

    # TECHNOLOGY SELECTION AND SPLIT VARIABLES
    m.y = Var(m.I, domain=Binary)
    m.yBYP1 = Var(domain=Binary)
    m.yBYP2 = Var(domain=Binary)
    m.yBYP3 = Var(domain=Binary)

    # ROUTING FRACTIONS (upper bound 1 as in the notebook)
    m.fConv = Var(m.ICONV, domain=NonNegativeReals, bounds=(0.0, 1.0))
    m.fUpg = Var(m.IUPG, domain=NonNegativeReals, bounds=(0.0, 1.0))
    m.fSTB = Var(domain=NonNegativeReals, bounds=(0.0, 1.0))
    # fRec is not a separate variable: the CEN share is a Splitter-3 branch (L2, CELL 32)

    # STAGE II/III BINARIES: fixed to 0 in the notebook; free when Q2 is active
    if not settings()["stage23_binaries"]:
        for tech in STAGE23:
            m.y[tech].fix(0)

    # MASS FLOWS
    m.M = Var(m.J, m.K, domain=NonNegativeReals)

    # EQUIPMENT SIZING
    m.Qc = Var(m.I, domain=NonNegativeReals)
    m.PurchaseCost = Var(m.I, domain=NonNegativeReals)
    m.Nlabr_new = Var(m.I, domain=NonNegativeReals)

    # OPERATING STATE
    m.Qc_s = Var(m.I, domain=NonNegativeReals)
    m.PW_op = Var(m.I, domain=NonNegativeReals)
    m.Mstm = Var(m.I, domain=NonNegativeReals)
    m.Mcw = Var(m.I, domain=NonNegativeReals)
    m.Mprod = Var(m.I, m.KP, domain=NonNegativeReals)
    m.eta_AND_eff = Var(domain=NonNegativeReals)

print("Selection, flow, sizing and operating variables declared.")
print("Free stage II/III binaries:", [t for t in STAGE23 if not m.y[t].fixed] or "none (fixed to 0, as in the notebook)")



# CELL 16 — UNIT-MODEL VARIABLES

@model_step
def cell_16_unit_variables(m):
    names = [
        # AER
        "VS_AER_deg", "V_w_AER", "V_vessel_AER", "O2_AER",
        # ENZ
        "V_ENZ", "V_w_ENZ", "ENZ_DS_in",
        # HTL
        "M_daf_HTL", "Mslurry22", "m_HTL", "V_w_HTL", "V_HTL", "H_net_HTL", "H_gas_HTL", "M_NG_HTL", "N_aq_HTL",
        # AND
        "VSANDin", "VSdestroyed", "CH4gen", "CO2gen", "NH3gen", "H2Sgen", "H2Oconsumed", "V_w_AND", "V_vessel_AND",
        # SLF
        "CH4_mass_SLF", "CO2_mass_SLF", "CH4_volume_SLF", "CH4_ox_SLF", "m_wasteleft_SLF", "vol_FW_SLF",
        # CMP
        "VSCMP_in", "VSCMP_deg", "O2req_CMP", "AirCMP", "V_work_CMP", "V_vessel_CMP",
        # WWT
        "Qww_m3ph", "mVS_in", "mVS_deg_WWT", "Px", "m_wasteleft_WWT", "N_eff_WWT",
        # INC
        "mdry_inc", "mdaf_inc", "nC_inc", "nH_inc", "nO_inc", "nN_inc", "nS_inc", "nO2_sto", "nO2_in", "nN2_air",
        "nCO2_inc", "nH2O_inc", "nSO2_inc", "nO2_out", "nN2_out", "mflue_inc", "m_ash_INC", "NG_aux_INC",
        "nNG_inc", "CO2_fossil_INC", "NOx_INC_kgph",
        # STB
        "P_turbine",
    ]
    for name in names:
        setattr(m, name, Var(domain=NonNegativeReals))

print("Unit-model variables declared.")



# CELL 17 — COST, ENVIRONMENTAL AND OBJECTIVE VARIABLES

@model_step
def cell_17_cost_env_variables(m):
    # ANNUAL COSTS AND REVENUES — M$/yr
    for name in ["CCAC", "CCLB", "CCUC", "CCOC", "CCRM", "CDISP", "CTIP", "CCWC", "CCINS", "CCTC", "REV"]:
        setattr(m, name, Var(domain=NonNegativeReals))
    # INDIRECT GREENHOUSE GAS EMISSIONS
    for name in ["GHG_ind_kgph", "GHG_ind_kgyr", "GHG_ind_tpy", "GHG_dir_total"]:
        setattr(m, name, Var(domain=NonNegativeReals))
    # OTHER GREENHOUSE GAS ACCOUNTING (free)
    for name in ["GHG_disp", "GHG_aq", "GHG_digestate"]:
        setattr(m, name, Var(domain=Reals))
    # OBJECTIVES
    m.NAC = Var(domain=Reals)              # Net annual cost, M$/yr
    m.GHG_total_tpy = Var(domain=Reals)    # Net GHG, t CO2-eq/yr
    m.EP_marine_tpy = Var(domain=Reals)    # Marine eutrophication, t N-eq/yr

print("Cost, environmental and objective variables declared.")



# BIG-M CONSTANT

@model_step
def cell_18_big_m(m):
    s, Fd, B, Qf = m.P["sc"], m.Fd, m.B, m.P["Qf"]
    # MCR water switch: stream 6 is either zero or the full raw feed, so the deficit is 0 or d_full
    d_full = (1.0 / s["TS_MCR"] - 1.0) * Qf * Fd["TS_feed"] - Qf * m.X["WATER"]
    m.M_MCR_upper = max(0.0, -d_full)          # notebook: Qf*X[WATER]
    m.M_MCR_switch = max(0.0, d_full)          # notebook: Qf*TS_feed*(1/TS_MCR - 1)
    # Splitter-2 caps: largest flow of k that can reach Splitter 2
    m.U_spl2 = {k: Qf * m.X[k] + (m.M_MCR_switch if k == "WATER" else 0.0) for k in COMP}   # notebook: M_big
    # Fuel switches: tight M from the notebook's own variable bounds
    m.M_HTL_fuel_upper = B["H_gas_HTL_up"]           # notebook: 1000*HHV_HTLgas*eta_fh*M_big
    m.M_HTL_fuel_switch = B["M_NG_HTL_up"]           # notebook: M_big
    m.M_INC_fuel_upper = max(0.0, B["INC_net_heat_up"])   # notebook: HHV_feed*M_big
    m.M_INC_fuel_switch = B["inc_ng_max"]            # notebook: M_big

_s = P["sc"]
big_m_table = pd.DataFrame([
    ("MCR water, upper", P["Qf"] * Fd["X"]["WATER"], m.M_MCR_upper),
    ("MCR water, switch", P["Qf"] * Fd["TS_feed"] * (1 / _s["TS_MCR"] - 1), m.M_MCR_switch),
    ("Splitter 2 caps (water)", M_BIG_BOUND, m.U_spl2["WATER"]),
    ("HTL fuel, upper (kJ/h)", 1000 * _s["HHV_HTLgas"] * _s["eta_fh"] * M_BIG_BOUND, m.M_HTL_fuel_upper),
    ("HTL fuel, switch (kg/h)", M_BIG_BOUND, m.M_HTL_fuel_switch),
    ("INC fuel, upper (MJ/h)", Fd["HHV_feed"] * M_BIG_BOUND, m.M_INC_fuel_upper),
    ("INC fuel, switch (kg/h)", M_BIG_BOUND, m.M_INC_fuel_switch),
], columns=["Switch", "Notebook M", "Tight M used"])
display(big_m_table)
print(f"Generic stream upper bound kept from the notebook: M_big = {M_BIG_BOUND:,.0f} kg/h")



# CELL 19 — FEED AND SPLITTER 1 EQUATIONS

@model_step
def cell_19_feed_splitter1(m):
    X, Qf = m.X, m.P["Qf"]
    # Stream 1: raw food waste feed
    m.eq_feed = Constraint(m.K, rule=lambda m, k: m.M["1", k] == Qf * X[k])
    # Splitter 1: feed goes to BYP1, SHR, MCR or BYP2
    m.Spl1_bal = Constraint(m.K, rule=lambda m, k: m.M["1", k] == m.M["2", k] + m.M["3", k] + m.M["6", k] + m.M["58", k])
    # Activate only the selected path
    m.Spl1_byp1_cap = Constraint(m.K, rule=lambda m, k: m.M["2", k] <= Qf * X[k] * m.yBYP1)
    m.Spl1_SHR_cap = Constraint(m.K, rule=lambda m, k: m.M["3", k] <= Qf * X[k] * m.y["SHR"])
    m.Spl1_MCR_cap = Constraint(m.K, rule=lambda m, k: m.M["6", k] <= Qf * X[k] * m.y["MCR"])
    m.Spl1_byp2_cap = Constraint(m.K, rule=lambda m, k: m.M["58", k] <= Qf * X[k] * m.yBYP2)
    # Exactly one mechanical-stage path
    m.Mech_choose = Constraint(expr=m.y["SHR"] + m.y["MCR"] + m.yBYP1 + m.yBYP2 == 1)

print("Feed and Splitter 1 equations created.")



# CELL 20 — SHR: SHREDDER EQUATIONS

@model_step
def cell_20_SHR(m):
    s, Wsp = m.P["sc"], m.P["Wsp"]
    # Stream 3: inlet; stream 4: product; stream 5: reject
    m.eq_SHR_out = Constraint(m.K, rule=lambda m, k: m.M["4", k] == s["eta_SHR"] * m.M["3", k])
    m.eq_SHR_rej = Constraint(m.K, rule=lambda m, k: m.M["5", k] == (1.0 - s["eta_SHR"]) * m.M["3", k])
    # Required and installed throughput, kg/h
    m.eq_SHR_Qc = Constraint(expr=m.Qc_s["SHR"] == _wet(m, "3"))
    m.SHR_installed_capacity = Constraint(expr=m.Qc["SHR"] == m.Qc_s["SHR"])
    # Power demand, kW
    m.eq_SHR_PW = Constraint(expr=m.PW_op["SHR"] == Wsp["SHR"] * m.Qc_s["SHR"])
    # No steam, cooling water or saleable product
    _no_utility_no_product(m, "SHR")

print("SHR equations created.")



# CELL 21 — MCR: MACERATOR AND DILUTION EQUATIONS

@model_step
def cell_21_MCR(m):
    s, Wsp = m.P["sc"], m.P["Wsp"]
    # Stream 6: inlet; stream 7: added water; stream 8: slurry
    MCR_dry_in = _dry(m, "6")
    MCR_water_deficit = (1.0 / s["TS_MCR"] - 1.0) * MCR_dry_in - m.M["6", "WATER"]
    # Added-water stream contains water only
    _fix_zero(m, "7", ["WATER"])
    # L5: add exactly the water needed to reach the target solids fraction (tight M from the BIG-M cell)
    m.MCR_water_needed = Var(domain=Binary)
    m.MCR_water_lower = Constraint(expr=m.M["7", "WATER"] >= MCR_water_deficit)
    m.MCR_water_upper = Constraint(expr=m.M["7", "WATER"] <= MCR_water_deficit + m.M_MCR_upper * (1.0 - m.MCR_water_needed))
    m.MCR_water_switch = Constraint(expr=m.M["7", "WATER"] <= m.M_MCR_switch * m.MCR_water_needed)
    m.MCR_water_selection = Constraint(expr=m.MCR_water_needed <= m.y["MCR"])
    # Component mass balance
    m.MCR_out = Constraint(m.K, rule=lambda m, k: m.M["8", k] == m.M["6", k] + m.M["7", k])
    # Grinder capacity: wet inlet before dilution, kg/h
    m.eq_MCR_Qc = Constraint(expr=m.Qc_s["MCR"] == _wet(m, "6"))
    m.MCR_installed_capacity = Constraint(expr=m.Qc["MCR"] == m.Qc_s["MCR"])
    # Power demand, kW
    m.eq_MCR_PW = Constraint(expr=m.PW_op["MCR"] == Wsp["MCR"] * m.Qc_s["MCR"])
    # No steam, cooling water or saleable product
    _no_utility_no_product(m, "MCR")

print("MCR equations created.")
print(f"L5: MCR water switch uses M = {m.M_MCR_upper:.2f} (upper) and {m.M_MCR_switch:.2f} (switch).")



# CELL 22 — MIXER 1 AND BIOLOGICAL ROUTING

@model_step
def cell_22_mixer1_biorouting(m):
    # Mixer 1: SHR product (4) + MCR slurry (8) -> stream 9
    m.Mxr1_bal = Constraint(m.K, rule=lambda m, k: m.M["9", k] == m.M["4", k] + m.M["8", k])
    # Splitter 2: stream 9 + mechanical bypass (2). Outlets: AER (10), ENZ (14), biological bypass (61)
    m.Spl2_bal = Constraint(m.K, rule=lambda m, k: m.M["9", k] + m.M["2", k] == m.M["10", k] + m.M["14", k] + m.M["61", k])
    # L5: activate only the selected biological path (tight M = largest flow of k reaching Splitter 2)
    m.Spl2_AER_cap = Constraint(m.K, rule=lambda m, k: m.M["10", k] <= m.U_spl2[k] * m.y["AER"])
    m.Spl2_ENZ_cap = Constraint(m.K, rule=lambda m, k: m.M["14", k] <= m.U_spl2[k] * m.y["ENZ"])
    m.Spl2_BYP3_cap = Constraint(m.K, rule=lambda m, k: m.M["61", k] <= m.U_spl2[k] * m.yBYP3)
    # Select one biological path unless BYP2 skips both stages
    m.Bio_choose = Constraint(expr=m.y["AER"] + m.y["ENZ"] + m.yBYP3 == 1.0 - m.yBYP2)

print("Mixer 1 and biological routing equations created.")



# CELL 23 — AER: AEROBIC PRETREATMENT EQUATIONS

@model_step
def cell_23_AER(m):
    s, Fd, Wsp = m.P["sc"], m.Fd, m.P["Wsp"]
    # Stream 10: feed; stream 13: air; stream 11: offgas; stream 12: product
    # Model assumption: degradation applies only to the volatile share of OTH
    aer_oth = Fd["AER_OTH_VS_fraction"]
    fz = s["f_deg_AER"]
    # OTH volatile share downstream of an optional AER (used by AND, CMP and WWT): share = a0 + db*y_AER
    after = aer_oth * (1.0 - fz) / (1.0 - fz * aer_oth)
    m.share_a0, m.share_db = aer_oth, after - aer_oth
    # Volatile solids degraded, kg/h
    m.eq_AER_VSdeg = Constraint(expr=m.VS_AER_deg == fz * (m.M["10", "CBH"] + m.M["10", "PRT"] + m.M["10", "FAT"] + aer_oth * m.M["10", "OTH"]))
    # Oxygen demand, kg/h
    m.eq_AER_O2 = Constraint(expr=m.O2_AER == Fd["Y_O2_AER"] * m.VS_AER_deg)
    # Air supply
    m.eq_AER_air_O2 = Constraint(expr=m.M["13", "O2"] == s["EAR_AER"] * m.O2_AER)
    m.eq_AER_air_N2 = Constraint(expr=m.M["13", "N2"] == (s["yN2_air"] / s["yO2_air"]) * m.M["13", "O2"])
    _fix_zero(m, "13", ["O2", "N2"])
    # Undegraded carbohydrate, protein and fat
    m.eq_AER_out = Constraint(["CBH", "PRT", "FAT"], rule=lambda m, k: m.M["12", k] == (1.0 - fz) * m.M["10", k])
    # OTH retains its nonvolatile share
    m.eq_AER_out_OTH = Constraint(expr=m.M["12", "OTH"] == (1.0 - fz * aer_oth) * m.M["10", "OTH"])
    # Ash, separately tracked FC and inlet water pass through
    m.eq_AER_pass = Constraint(["ASH", "FC", "WATER"], rule=lambda m, k: m.M["12", k] == m.M["10", k])
    _fix_zero(m, "12", ["CBH", "PRT", "FAT", "OTH", "ASH", "FC", "WATER"])
    # Offgas components
    m.eq_AER_offgas_CO2 = Constraint(expr=m.M["11", "CO2"] == Fd["Y_CO2_AER"] * m.VS_AER_deg)
    m.eq_AER_offgas_NH3 = Constraint(expr=m.M["11", "NH3"] == Fd["Y_NH3_AER"] * m.VS_AER_deg)
    m.eq_AER_offgas_O2 = Constraint(expr=m.M["11", "O2"] == m.M["13", "O2"] - m.O2_AER)
    m.eq_AER_offgas_N2 = Constraint(expr=m.M["11", "N2"] == m.M["13", "N2"])
    # Lumped reaction-water balance closes total mass
    m.eq_AER_offgas_H2O = Constraint(expr=m.M["11", "WATER"] == m.VS_AER_deg + m.O2_AER - m.M["11", "CO2"] - m.M["11", "NH3"])
    _fix_zero(m, "11", ["CO2", "NH3", "O2", "N2", "WATER"])
    # Working and total vessel volumes, m3
    m.eq_AER_working_vol = Constraint(expr=m.V_w_AER == s["theta_AER"] * ((_wet(m, "10") - m.M["10", "WATER"]) / s["rho_s"] + m.M["10", "WATER"] / s["rho_w"]))
    m.eq_AER_vessel_vol = Constraint(expr=s["eps_AER"] * m.V_vessel_AER == m.V_w_AER)
    m.eq_AER_Qc = Constraint(expr=m.Qc_s["AER"] == m.V_vessel_AER)
    m.AER_installed_capacity = Constraint(expr=m.Qc["AER"] == m.Qc_s["AER"])
    # Power demand, kW
    m.eq_AER_PW = Constraint(expr=m.PW_op["AER"] == Wsp["AER"] * m.Qc_s["AER"] + m.O2_AER / s["AE_O2"])
    # No steam, cooling water or saleable product
    _no_utility_no_product(m, "AER")

print("AER equations created.")
print(f"OTH volatile share: {m.share_a0:.6f} (raw), {m.share_a0 + m.share_db:.6f} (after AER)")



# CELL 24 — ENZ: ENZYMATIC PRETREATMENT EQUATIONS

@model_step
def cell_24_ENZ(m):
    s, Wsp = m.P["sc"], m.P["Wsp"]
    # Stream 14: feed; stream 15: enzyme; stream 16: offgas; stream 17: product
    # Inlet dry solids, kg/h
    m.ENZ_DSin_eq = Constraint(expr=m.ENZ_DS_in == _dry(m, "14"))
    # Enzyme dose based on actual inlet dry solids
    m.ENZ_Ez = Constraint(expr=m.M["15", "ENZYME"] == s["r_enz"] * m.ENZ_DS_in)
    _fix_zero(m, "15", ["ENZYME"])
    # No offgas in this lumped hydrolysis model
    _fix_zero(m, "16", [])
    # Feed components pass through except protein and enzyme
    m.ENZ_out = Constraint([k for k in COMP if k not in ("PRT", "ENZYME")], rule=lambda m, k: m.M["17", k] == m.M["14", k])
    # Model assumption: added enzyme is represented as protein downstream
    m.ENZ_out_prt = Constraint(expr=m.M["17", "PRT"] == m.M["14", "PRT"] + m.M["14", "ENZYME"] + m.M["15", "ENZYME"])
    m.M["17", "ENZYME"].fix(0.0)
    # Working volume includes inlet solids, enzyme and upstream water, m3
    m.ENZ_working_vol = Constraint(expr=m.V_w_ENZ == s["HRT_ENZ"] * ((m.ENZ_DS_in + m.M["15", "ENZYME"]) / s["rho_s"] + m.M["14", "WATER"] / s["rho_w"]))
    m.ENZ_vessel_vol = Constraint(expr=s["eps_ENZ"] * m.V_ENZ == m.V_w_ENZ)
    m.ENZ_capacity = Constraint(expr=m.Qc_s["ENZ"] == m.V_ENZ)
    m.ENZ_installed_capacity = Constraint(expr=m.Qc["ENZ"] == m.Qc_s["ENZ"])
    # Mixing power, kW
    m.ENZ_power = Constraint(expr=m.PW_op["ENZ"] == Wsp["ENZ"] * m.Qc_s["ENZ"])
    # Steam for heating inlet feed and enzyme, kg/h
    m.Mstm_ENZ_heat = Constraint(expr=m.Mstm["ENZ"] * s["dh_steam"] == s["Cp_eff"] * (s["T_ENZ"] - s["T_amb"]) * (_wet(m, "14") + m.M["15", "ENZYME"]))
    # No cooling water or saleable product
    _no_utility_no_product(m, "ENZ", steam=False)

print("ENZ equations created.")



# CELL 25 — MIXER 2 AND CONVERSION ROUTING

@model_step
def cell_25a_mixer2(m):
    # Mixer 2: AER product (12) + ENZ product (17) + biological bypass (61)
    m.Mxr2_bal = Constraint(m.K, rule=lambda m, k: m.M["18", k] == m.M["12", k] + m.M["17", k] + m.M["61", k])

def pathway_profiles(P_, upto_step):
    """S_p[k] = M18 + M58 for each pretreatment pathway, from the model's own equations (steps before upto_step)."""
    upto = [f.__name__ for f in BUILD_STEPS].index(upto_step)
    profiles = {}
    for mech, bio in PATHWAYS:
        mu = build_model(P_, upto=upto)
        on = {"SHR": 0, "MCR": 0, "BYP1": 0, "BYP2": 0, "AER": 0, "ENZ": 0, "BYP3": 0}
        on[mech] = 1
        if bio != "none":
            on[bio] = 1
        for t in ["SHR", "MCR", "AER", "ENZ"]:
            mu.y[t].fix(on[t])
        mu.yBYP1.fix(on["BYP1"]); mu.yBYP2.fix(on["BYP2"]); mu.yBYP3.fix(on["BYP3"])
        mu.obj = Objective(expr=0.0)
        res = pyo.SolverFactory(SOLVER_NAME).solve(mu, load_solutions=False)
        if str(res.solver.termination_condition) != "optimal":
            raise RuntimeError(f"Pathway {PATH_ID[(mech, bio)]}: upstream solve failed")
        mu.solutions.load_from(res)
        profiles[PATH_ID[(mech, bio)]] = {k: pyo.value(mu.M["18", k]) + pyo.value(mu.M["58", k]) for k in COMP}
    return profiles

@model_step
def cell_25b_splitter3_L1(m):
    s = m.P["sc"]
    # Pathway profiles S_p
    m.S = pathway_profiles(m.P, "cell_25b_splitter3_L1")
    m.PATH = Set(initialize=list(m.S), ordered=True)
    m.path_of = {PATH_ID[p]: p for p in PATHWAYS}
    m.BR = Set(initialize=BRANCH, ordered=True)
    m.Smax = {k: max(m.S[q][k] for q in m.PATH) for k in COMP}

    # L1 auxiliary variables: z_p = pathway indicator, w[c,p] = fConv[c] * z_p
    m.z = Var(m.PATH, domain=NonNegativeReals, bounds=(0.0, 1.0))
    m.w = Var(m.BR, m.PATH, domain=NonNegativeReals, bounds=(0.0, 1.0))
    mech_bin = {"SHR": m.y["SHR"], "MCR": m.y["MCR"], "BYP1": m.yBYP1}
    bio_bin = {"AER": m.y["AER"], "ENZ": m.y["ENZ"], "BYP3": m.yBYP3}

    def z_rule(m, q, r):
        mech, bio = m.path_of[q]
        if mech == "BYP2":
            rows = [m.z[q] == m.yBYP2]
        else:   # z = (mechanical binary) AND (biological binary), exact for binaries
            rows = [m.z[q] <= mech_bin[mech], m.z[q] <= bio_bin[bio], m.z[q] >= mech_bin[mech] + bio_bin[bio] - 1]
        return rows[r] if r < len(rows) else Constraint.Skip
    m.L1_z = Constraint(m.PATH, range(3), rule=z_rule)
    # w[c,p] = fConv[c]*z_p, exact: w <= z_p and sum_c w[c,p] = z_p
    m.L1_w_le_z = Constraint(m.BR, m.PATH, rule=lambda m, c, q: m.w[c, q] <= m.z[q])
    m.L1_w_sum = Constraint(m.PATH, rule=lambda m, q: sum(m.w[c, q] for c in BRANCH) == m.z[q])
    m.L1_fConv = Constraint(m.ICONV, rule=lambda m, t: m.fConv[t] == sum(m.w[c, q] for c in BRANCH if BRANCH_TECH[c] == t for q in m.PATH))

    def branch_flow(c, k):
        return sum(m.w[c, q] * m.S[q][k] for q in m.PATH)
    m.branch_flow = branch_flow

    # Splitter 3: mixed stream (18) + full pretreatment bypass (58)
    m.Spl3_bal = Constraint(m.K, rule=lambda m, k: m.M["18", k] + m.M["58", k] == m.M["19", k] + m.M["23", k] + m.M["28", k] + m.M["31", k] + m.M["35", k] + m.M["38", k])
    # Proportional routing (L1, linear): every branch keeps the composition of its pathway
    m.Spl3_HTL_split = Constraint(m.K, rule=lambda m, k: m.M["19", k] == branch_flow("HTL_CEN", k) + branch_flow("HTL_FLT", k))
    for c, j in BRANCH_STREAM.items():
        setattr(m, f"Spl3_{c}_split", Constraint(m.K, rule=lambda m, k, c=c, j=j: m.M[j, k] == branch_flow(c, k)))
    # All conversion fractions sum to one
    m.Conv_choose = Constraint(expr=sum(m.fConv[t] for t in I_CONV) == 1.0)

    # L5: tight M for the HTL and AND water switches (one pathway active, fConv <= 1)
    d_htl = [(1.0 / s["TS_HTL"] - 1.0) * _dry_of(m.S[q]) - m.S[q]["WATER"] for q in m.PATH]
    d_and = [(1.0 / s["TS_AND"] - 1.0) * _dry_of(m.S[q]) - m.S[q]["WATER"] for q in m.PATH]
    m.M_HTL_water_upper = max(0.0, max(-d for d in d_htl))   # notebook: M_big
    m.M_HTL_water_switch = max(0.0, max(d_htl))              # notebook: M_big
    m.M_AND_water_upper = max(0.0, max(-d for d in d_and))   # notebook: M_big
    m.M_AND_water_switch = max(0.0, max(d_and))              # notebook: M_big

print("Pretreatment pathway profiles S_p = M18 + M58 (kg/h), from the notebook's own pretreatment equations:")
display(pd.DataFrame(m.S).T[[k for k in COMP if any(abs(m.S[q][k]) > 1e-12 for q in m.S)]].round(4))
print("Mixer 2 and conversion routing equations created.")
print("L1: Splitter 3 reformulated exactly over", len(m.PATH), "pretreatment pathways.")
print(f"L5: HTL water M = {m.M_HTL_water_upper:.2f} / {m.M_HTL_water_switch:.2f}; AND water M = {m.M_AND_water_upper:.2f} / {m.M_AND_water_switch:.2f}")



# CELL 26 — HTL: HYDROTHERMAL LIQUEFACTION EQUATIONS

@model_step
def cell_26_HTL(m):
    s, Fd, Wsp = m.P["sc"], m.Fd, m.P["Wsp"]
    yHTL = Fd["yHTL"]
    # Stream 19: feed; stream 21: added water; stream 20: gas; stream 22: products
    HTL_dry_in = _dry(m, "19")
    m.HTL_org_def = Constraint(expr=m.M_daf_HTL == sum(m.M["19", k] for k in ORG5))
    # L5: add only the water missing from the actual HTL inlet (tight M from CELL 25)
    HTL_water_deficit = (1.0 / s["TS_HTL"] - 1.0) * HTL_dry_in - m.M["19", "WATER"]
    m.HTL_water_needed = Var(domain=Binary)
    m.HTL_water_lower = Constraint(expr=m.M["21", "WATER"] >= HTL_water_deficit)
    m.HTL_water_upper = Constraint(expr=m.M["21", "WATER"] <= HTL_water_deficit + m.M_HTL_water_upper * (1.0 - m.HTL_water_needed))
    m.HTL_water_switch = Constraint(expr=m.M["21", "WATER"] <= m.M_HTL_water_switch * m.HTL_water_needed)
    _fix_zero(m, "21", ["WATER"])
    # Gas production
    m.HTL_gas = Constraint(expr=m.M["20", "GAS"] == yHTL["GAS"] * m.M_daf_HTL)
    _fix_zero(m, "20", ["GAS"])
    # Biocrude, char and aqueous products
    m.HTL_biocrude = Constraint(expr=m.M["22", "BIOCRUDE"] == yHTL["BIOCRUDE"] * m.M_daf_HTL)
    m.HTL_char = Constraint(expr=m.M["22", "CHAR"] == yHTL["CHAR"] * m.M_daf_HTL + m.M["19", "ASH"])
    m.HTL_aq = Constraint(expr=m.M["22", "AQ"] == yHTL["AQ"] * m.M_daf_HTL + m.M["19", "WATER"] + m.M["21", "WATER"])
    _fix_zero(m, "22", ["BIOCRUDE", "CHAR", "AQ"])
    # Total products sent to recovery, kg/h
    m.Slurry22_def = Constraint(expr=m.Mslurry22 == _wet(m, "22"))
    # Heated slurry mass, kg/h
    m.HTL_mheated_def = Constraint(expr=m.m_HTL == _wet(m, "19") + m.M["21", "WATER"])
    # Reactor volume, m3
    m.HTL_working_vol = Constraint(expr=m.V_w_HTL == s["theta_HTL"] * (HTL_dry_in / s["rho_s"] + (m.M["19", "WATER"] + m.M["21", "WATER"]) / s["rho_HTL"]))
    m.HTL_vessel_vol = Constraint(expr=s["eps_HTL"] * m.V_HTL == m.V_w_HTL)
    m.HTL_capacity = Constraint(expr=m.Qc_s["HTL"] == m.V_HTL)
    m.HTL_installed_capacity = Constraint(expr=m.Qc["HTL"] == m.Qc_s["HTL"])
    # Heat demand after heat recovery, kJ/h
    m.HTL_heat_net = Constraint(expr=m.H_net_HTL == (1.0 - s["etaHX_HTL"]) * ((m.M["19", "WATER"] + m.M["21", "WATER"]) * s["dh_w_HTL"] + HTL_dry_in * s["Cp_solids_HTL"] * (s["T_HTL"] - s["T_amb"])))
    # Useful heat from nonvented HTL gas, kJ/h
    m.HTL_gas_heat = Constraint(expr=m.H_gas_HTL == 1000.0 * s["HHV_HTLgas"] * (1.0 - s["HTL_gas_vent_frac"]) * s["eta_fh"] * m.M["20", "GAS"])
    # L5: exact auxiliary natural-gas demand, max(0, heat deficit), tight M
    m.HTL_fuel_needed = Var(domain=Binary)
    HTL_fuel_heat = 1000.0 * s["LHV_NG"] * s["eta_fh"] * m.M_NG_HTL
    HTL_heat_deficit = m.H_net_HTL - m.H_gas_HTL
    m.HTL_fuel_lower = Constraint(expr=HTL_fuel_heat >= HTL_heat_deficit)
    m.HTL_fuel_upper = Constraint(expr=HTL_fuel_heat <= HTL_heat_deficit + m.M_HTL_fuel_upper * (1.0 - m.HTL_fuel_needed))
    m.HTL_fuel_switch = Constraint(expr=m.M_NG_HTL <= m.M_HTL_fuel_switch * m.HTL_fuel_needed)
    # Pump power follows cold inlet flow
    m.HTL_power = Constraint(expr=m.PW_op["HTL"] == Wsp["HTL"] * (17.0 / 60.0) * (1006.0 / s["rho_w"]) * (HTL_dry_in / s["rho_s"] + (m.M["19", "WATER"] + m.M["21", "WATER"]) / s["rho_w"]))
    # No process steam or cooling water; saleable biocrude is assigned after CEN/FLT recovery
    _no_utility_no_product(m, "HTL", prod_keep=("BIOCRUDE",))
    # Nitrogen accounting, kg N/h
    for name in ["N_HTL_bio", "N_HTL_char", "N_HTL_removed", "N_HTL_discharge", "N_HTL_N2O"]:
        setattr(m, name, Var(domain=NonNegativeReals))
    Nf = Fd["N_frac"]
    m.HTL_N_aq_eq = Constraint(expr=m.N_aq_HTL == s["HTL_N_to_AQ"] * Nf * m.M_daf_HTL)
    m.HTL_N_bio_eq = Constraint(expr=m.N_HTL_bio == (1.0 - s["HTL_N_to_AQ"]) * Nf * m.M_daf_HTL)
    # Assumption: negligible nitrogen in HTL gas
    m.HTL_N_phase_balance = Constraint(expr=Nf * m.M_daf_HTL == m.N_aq_HTL + m.N_HTL_bio + m.N_HTL_char)
    m.HTL_N_char_limit = Constraint(expr=m.N_HTL_char <= m.M["22", "CHAR"])
    m.HTL_N_aq_limit = Constraint(expr=m.N_aq_HTL <= m.M["22", "AQ"])
    m.HTL_N_discharge_eq = Constraint(expr=m.N_HTL_discharge == (1.0 - s["HTL_AQ_N_removal"]) * m.N_aq_HTL)
    m.HTL_N_removed_eq = Constraint(expr=m.N_HTL_removed == s["HTL_AQ_N_removal"] * m.N_aq_HTL)
    m.HTL_N2O_eq = Constraint(expr=m.N_HTL_N2O == s["HTL_AQ_N2O_N_frac"] * m.N_HTL_removed)

print("HTL equations created.")



# CELL 27 — AND: ANAEROBIC DIGESTION EQUATIONS

@model_step
def cell_27_AND(m):
    s, Fd, B, Wsp = m.P["sc"], m.Fd, m.B, m.P["Wsp"]
    eta0, dE, dA = s["eta_AND"], s["delta_ENZ"], s["delta_AER"]
    a0, db = m.share_a0, m.share_db
    yA, yE = m.y["AER"], m.y["ENZ"]
    # Stream 23: feed; stream 24: added water; 25: uncaptured gas; 26: digestate; 27: captured biogas

    # Effective destruction efficiency
    m.eta_AND_eff_link = Constraint(expr=m.eta_AND_eff == eta0 * (1.0 + dE * yE + dA * yA))

    # L3: Glover variables u = y * x (U = bound of x)
    u = {}
    u["A_OTH"] = glover(m, "yAER_M23_OTH", yA, m.M["23", "OTH"], m.Smax["OTH"])
    u["E_OTH"] = glover(m, "yENZ_M23_OTH", yE, m.M["23", "OTH"], m.Smax["OTH"])
    u["A_VS"] = glover(m, "yAER_VSANDin", yA, m.VSANDin, B["dry_max"])
    u["E_VS"] = glover(m, "yENZ_VSANDin", yE, m.VSANDin, B["dry_max"])
    u["A_Vw"] = glover(m, "yAER_V_w_AND", yA, m.V_w_AND, B["and_work_max"])
    u["E_Vw"] = glover(m, "yENZ_V_w_AND", yE, m.V_w_AND, B["and_work_max"])
    for k in ["CBH", "PRT", "FAT"]:
        u[f"A_{k}"] = glover(m, f"yAER_M23_{k}", yA, m.M["23", k], m.Smax[k])
        u[f"E_{k}"] = glover(m, f"yENZ_M23_{k}", yE, m.M["23", k], m.Smax[k])

    # L5: water addition uses actual inlet solids and water (tight M from CELL 25)
    AND_dry_in = _dry(m, "23")
    AND_water_deficit = (1.0 / s["TS_AND"] - 1.0) * AND_dry_in - m.M["23", "WATER"]
    m.AND_water_needed = Var(domain=Binary)
    m.AND_water_lower = Constraint(expr=m.M["24", "WATER"] >= AND_water_deficit)
    m.AND_water_upper = Constraint(expr=m.M["24", "WATER"] <= AND_water_deficit + m.M_AND_water_upper * (1.0 - m.AND_water_needed))
    m.AND_water_switch = Constraint(expr=m.M["24", "WATER"] <= m.M_AND_water_switch * m.AND_water_needed)
    _fix_zero(m, "24", ["WATER"])

    # Eligible volatile solids: share*M23[OTH] = a0*M23[OTH] + db*(y_AER*M23[OTH])
    m.AND_VS = Constraint(expr=m.VSANDin == m.M["23", "CBH"] + m.M["23", "PRT"] + m.M["23", "FAT"]
                          + s["eta_OTH_AND"] * (a0 * m.M["23", "OTH"] + db * u["A_OTH"]))
    # eta_AND_eff*VSANDin = eta0*(VSANDin + dE*y_ENZ*VSANDin + dA*y_AER*VSANDin)
    m.AND_VSdeg = Constraint(expr=m.VSdestroyed == eta0 * (m.VSANDin + dE * u["E_VS"] + dA * u["A_VS"]))
    # Buswell reaction products, kg/h
    m.AND_CH4gen = Constraint(expr=m.CH4gen == Fd["CH4_yield_AND"] * m.VSdestroyed)
    m.AND_CO2gen = Constraint(expr=m.CO2gen == Fd["CO2_yield_AND"] * m.VSdestroyed)
    m.AND_NH3gen = Constraint(expr=m.NH3gen == Fd["NH3_yield_AND"] * m.VSdestroyed)
    m.AND_H2Sgen = Constraint(expr=m.H2Sgen == Fd["H2S_yield_AND"] * m.VSdestroyed)
    m.AND_H2Ocons = Constraint(expr=m.H2Oconsumed == Fd["H2O_yield_AND"] * m.VSdestroyed)
    # Captured biogas
    m.AND_biogasCH4 = Constraint(expr=m.M["27", "CH4"] == s["eta_cap_AND"] * m.CH4gen)
    m.AND_biogasCO2 = Constraint(expr=m.M["27", "CO2"] == s["eta_cap_AND"] * m.CO2gen)
    _fix_zero(m, "27", ["CH4", "CO2"])
    # Uncaptured gas; H2S is assigned here as a model assumption
    m.AND_offgasCH4 = Constraint(expr=m.M["25", "CH4"] == (1.0 - s["eta_cap_AND"]) * m.CH4gen)
    m.AND_offgasCO2 = Constraint(expr=m.M["25", "CO2"] == (1.0 - s["eta_cap_AND"]) * m.CO2gen)
    m.AND_offgasH2S = Constraint(expr=m.M["25", "H2S"] == m.H2Sgen)
    _fix_zero(m, "25", ["CH4", "CO2", "H2S"])
    # Undegraded digestate components: (1 - eta_eff)*M23[k]
    m.AND_dig_organics = Constraint(["CBH", "PRT", "FAT"], rule=lambda m, k: m.M["26", k] == m.M["23", k] - eta0 * (m.M["23", k] + dE * u[f"E_{k}"] + dA * u[f"A_{k}"]))
    # (1 - eta_eff*eta_OTH*share)*M23[OTH]; the y_ENZ*y_AER term is zero (at most one of them)
    m.AND_dig_OTH = Constraint(expr=m.M["26", "OTH"] == m.M["23", "OTH"] - eta0 * s["eta_OTH_AND"] * (
        a0 * m.M["23", "OTH"] + db * u["A_OTH"] + a0 * dE * u["E_OTH"] + a0 * dA * u["A_OTH"] + db * dA * u["A_OTH"]))
    m.AND_dig_inert = Constraint(["ASH", "FC"], rule=lambda m, k: m.M["26", k] == m.M["23", k])
    m.AND_dig_WAT = Constraint(expr=m.M["26", "WATER"] == m.M["23", "WATER"] + m.M["24", "WATER"] - m.H2Oconsumed)
    # NH3 is a lumped label for ammonia retained in digestate
    m.AND_dig_NH3 = Constraint(expr=m.M["26", "NH3"] == m.NH3gen)
    _fix_zero(m, "26", ["CBH", "PRT", "FAT", "OTH", "ASH", "FC", "WATER", "NH3"])
    # Working and total digester volumes, m3: V_w_AND*(1 + r_AER*y_AER + r_ENZ*y_ENZ) = theta*(...)
    m.AND_working_vol = Constraint(expr=m.V_w_AND + s["r_rate_AER"] * u["A_Vw"] + s["r_rate_ENZ"] * u["E_Vw"]
                                   == s["theta_AND"] * (AND_dry_in / s["rho_s"] + (m.M["23", "WATER"] + m.M["24", "WATER"]) / s["rho_w"]))
    m.AND_vessel_vol = Constraint(expr=s["epsilon_AND"] * m.V_vessel_AND == m.V_w_AND)
    m.AND_capacity = Constraint(expr=m.Qc_s["AND"] == m.V_vessel_AND)
    m.AND_installed_capacity = Constraint(expr=m.Qc["AND"] == m.Qc_s["AND"])
    # Mixing power, kW
    m.AND_power = Constraint(expr=m.PW_op["AND"] == Wsp["AND"] * m.Qc_s["AND"])
    # Heating assumes all incoming material starts at ambient temperature
    m.Mstm_AND_heat = Constraint(expr=m.Mstm["AND"] * s["dh_steam"] == (_wet(m, "23") + m.M["24", "WATER"]) * s["Cp_eff"] * (s["T_AND"] - s["T_amb"]))
    # Biogas revenue is counted only after upgrading
    _no_utility_no_product(m, "AND", steam=False)

print("AND equations created.")
print("L3: 12 binary x continuous products replaced by exact Glover variables.")



# CELL 28 — SLF: SANITARY LANDFILL EQUATIONS

@model_step
def cell_28_SLF(m):
    s, Wsp = m.P["sc"], m.P["Wsp"]
    # Stream 28: waste inlet; stream 29: uncaptured emissions; stream 30: captured gas
    # DOC_value is treated here as kg degradable organic carbon/kg dry waste.
    slf_gas = s["DOC_value"] * s["DOC_f_value"] * s["MCF_value"] * s["F_value"] * s["ratio_CH4_to_C"]
    m.SLF_CH4gen = Constraint(expr=m.CH4_mass_SLF == _dry(m, "28") * slf_gas)
    # Carbon dioxide generation from the assumed landfill-gas composition
    m.SLF_CO2gen = Constraint(expr=m.CO2_mass_SLF == m.CH4_mass_SLF * ((1.0 - s["F_value"]) / s["F_value"]) * (s["MW_CO2_AND"] / s["MW_CH4"]))
    # Oxidation applies only to uncaptured methane
    m.SLF_oxidation = Constraint(expr=m.CH4_ox_SLF == (1.0 - s["CAP_SLF"]) * s["OX"] * m.CH4_mass_SLF)
    # Methane volume for reporting, m3/h
    m.SLF_CH4_vol = Constraint(expr=m.CH4_volume_SLF == m.CH4_mass_SLF / s["density_CH4"])
    # Captured landfill gas
    m.SLF_cap_CH4 = Constraint(expr=m.M["30", "CH4"] == s["CAP_SLF"] * m.CH4_mass_SLF)
    m.SLF_cap_CO2 = Constraint(expr=m.M["30", "CO2"] == s["CAP_SLF"] * m.CO2_mass_SLF)
    _fix_zero(m, "30", ["CH4", "CO2"])
    # Uncaptured methane after cover oxidation
    m.SLF_off_CH4 = Constraint(expr=m.M["29", "CH4"] == (1.0 - s["CAP_SLF"]) * (1.0 - s["OX"]) * m.CH4_mass_SLF)
    # Uncaptured carbon dioxide plus carbon dioxide from methane oxidation
    m.SLF_off_CO2 = Constraint(expr=m.M["29", "CO2"] == (1.0 - s["CAP_SLF"]) * m.CO2_mass_SLF + (s["MW_CO2_AND"] / s["MW_CH4"]) * m.CH4_ox_SLF)
    # Oxidation water; coefficient closes mass using the retained molecular weights
    m.SLF_off_water = Constraint(expr=m.M["29", "WATER"] == (1.0 + 64.0 / s["MW_CH4"] - s["MW_CO2_AND"] / s["MW_CH4"]) * m.CH4_ox_SLF)
    _fix_zero(m, "29", ["CH4", "CO2", "WATER"])
    # Remaining landfilled mass, including atmospheric oxygen input
    m.SLF_wasteleft = Constraint(expr=m.m_wasteleft_SLF == _wet(m, "28") + (64.0 / s["MW_CH4"]) * m.CH4_ox_SLF - _wet(m, "29") - _wet(m, "30"))
    # Annual compacted waste volume, m3/yr
    m.SLF_vol = Constraint(expr=m.vol_FW_SLF == _wet(m, "28") * s["Tann"] / s["rho_SLF"])
    # Capacity basis: acres of new landfill area per year
    m.SLF_capacity = Constraint(expr=m.Qc_s["SLF"] * s["Depth_SLF"] * s["ACRE"] == m.vol_FW_SLF)
    m.SLF_installed_capacity = Constraint(expr=m.Qc["SLF"] == m.Qc_s["SLF"])
    # Retained power correlation, kW
    m.SLF_power = Constraint(expr=m.PW_op["SLF"] == Wsp["SLF"] * m.Qc_s["SLF"])
    # Gas revenue is counted after upgrading
    _no_utility_no_product(m, "SLF")

print("SLF equations created.")



# CELL 29 — CMP: COMPOSTING EQUATIONS

@model_step
def cell_29_CMP(m):
    s, Fd, Wsp = m.P["sc"], m.Fd, m.P["Wsp"]
    # Stream 31: feed; stream 33: air; stream 32: offgas; stream 34: compost
    # L3: volatile share of OTH after optional AER; share*M31[OTH] = a0*M + db*(y_AER*M), exact
    u_oth = glover(m, "yAER_M31_OTH", m.y["AER"], m.M["31", "OTH"], m.Smax["OTH"])
    cmp_share_x = m.share_a0 * m.M["31", "OTH"] + m.share_db * u_oth
    # Eligible volatile solids and degradation, kg/h
    m.CMP_VS_in = Constraint(expr=m.VSCMP_in == m.M["31", "CBH"] + m.M["31", "PRT"] + m.M["31", "FAT"] + s["eta_OTH_CMP"] * cmp_share_x)
    m.CMP_VS_deg = Constraint(expr=m.VSCMP_deg == s["fdeg_CMP"] * m.VSCMP_in)
    # Oxygen demand and specified excess-air supply
    m.CMP_O2_demand = Constraint(expr=m.O2req_CMP == Fd["Y_O2_AER"] * m.VSCMP_deg)
    m.CMP_air_req = Constraint(expr=m.AirCMP == s["EAR_CMP"] * m.O2req_CMP / s["yO2_air"])
    m.CMP_air_O2 = Constraint(expr=m.M["33", "O2"] == s["yO2_air"] * m.AirCMP)
    m.CMP_air_N2 = Constraint(expr=m.M["33", "N2"] == s["yN2_air"] * m.AirCMP)
    _fix_zero(m, "33", ["O2", "N2"])
    # Retained emission-factor basis: actual wet composting inlet, kg/h
    m.CMP_gas_CH4 = Constraint(expr=m.M["32", "CH4"] == s["EF_CH4_CMP_wet"] * _wet(m, "31"))
    m.CMP_gas_N2O = Constraint(expr=m.M["32", "N2O"] == s["EF_N2O_CMP_wet"] * _wet(m, "31"))
    # Subtract methane carbon from the carbon dioxide allocation
    m.CMP_gas_CO2 = Constraint(expr=m.M["32", "CO2"] == Fd["Y_CO2_AER"] * m.VSCMP_deg - (_M_CO2 / _M_CH4) * m.M["32", "CH4"])
    # Subtract N2O nitrogen from the ammonia allocation
    m.CMP_gas_NH3 = Constraint(expr=m.M["32", "NH3"] == Fd["Y_NH3_AER"] * m.VSCMP_deg - (_M_NH3 / MW_N) * (28.013 / 44.013) * m.M["32", "N2O"])
    m.CMP_gas_O2 = Constraint(expr=m.M["32", "O2"] == m.M["33", "O2"] - m.O2req_CMP)
    m.CMP_gas_N2 = Constraint(expr=m.M["32", "N2"] == m.M["33", "N2"])
    # Lumped reaction-water balance closes total mass
    m.CMP_gas_H2O = Constraint(expr=m.M["32", "WATER"] == m.VSCMP_deg + m.O2req_CMP - m.M["32", "CO2"] - m.M["32", "NH3"] - m.M["32", "CH4"] - m.M["32", "N2O"])
    _fix_zero(m, "32", ["CO2", "WATER", "NH3", "CH4", "N2O", "O2", "N2"])
    # Undegraded compost components
    m.CMP_comp_organics = Constraint(["CBH", "PRT", "FAT"], rule=lambda m, k: m.M["34", k] == (1.0 - s["fdeg_CMP"]) * m.M["31", k])
    m.CMP_comp_OTH = Constraint(expr=m.M["34", "OTH"] == m.M["31", "OTH"] - s["fdeg_CMP"] * s["eta_OTH_CMP"] * cmp_share_x)
    # Inlet water and inert components remain in the compost
    m.CMP_comp_pass = Constraint(["WATER", "ASH", "FC"], rule=lambda m, k: m.M["34", k] == m.M["31", k])
    _fix_zero(m, "34", ["CBH", "PRT", "FAT", "OTH", "WATER", "ASH", "FC"])
    # Working and total vessel volumes, m3
    m.CMP_wvol = Constraint(expr=m.V_work_CMP == s["theta_CMP"] * ((_wet(m, "31") - m.M["31", "WATER"]) / s["rho_s"] + m.M["31", "WATER"] / s["rho_w"]))
    m.CMP_vvol = Constraint(expr=s["epsilon_CMP"] * m.V_vessel_CMP == m.V_work_CMP)
    m.CMP_capacity = Constraint(expr=m.Qc_s["CMP"] == m.V_vessel_CMP)
    m.CMP_installed_capacity = Constraint(expr=m.Qc["CMP"] == m.Qc_s["CMP"])
    # Power demand, kW
    m.CMP_power = Constraint(expr=m.PW_op["CMP"] == Wsp["CMP"] * m.Qc_s["CMP"])
    # No steam or cooling water; saleable compost is counted on a dry-mass basis
    _no_utility_no_product(m, "CMP", prod_keep=("COMPOST",))
    m.CMP_prod_compost = Constraint(expr=m.Mprod["CMP", "COMPOST"] == _dry(m, "34"))

print("CMP equations created.")



# CELL 30 — WWT: WASTEWATER TREATMENT EQUATIONS (lumped on-site plant)

@model_step
def cell_30_WWT(m):
    s, Fd, rWW = m.P["sc"], m.Fd, m.P["rWW"]
    Nf = Fd["N_frac"]
    # Activated sludge + clarifier + aerobic sludge digester (40 CFR 503 Class B) + dewatering
    # Stream 35: inlet; 36: offgas; 37: digested, dewatered biosolids to farmland
    # L3: volatile share of OTH after optional AER; share*M35[OTH] = a0*M + db*(y_AER*M), exact
    u_oth = glover(m, "yAER_M35_OTH", m.y["AER"], m.M["35", "OTH"], m.Smax["OTH"])
    wwt_share_x = m.share_a0 * m.M["35", "OTH"] + m.share_db * u_oth
    # Inlet flow, m3/h
    m.WWT_Q_def = Constraint(expr=m.Qww_m3ph == _wet(m, "35") / s["rho_ww"])
    # Volatile solids entering and oxidised in the aeration basin, kg/h
    m.WWT_mVS_def = Constraint(expr=m.mVS_in == m.M["35", "CBH"] + m.M["35", "PRT"] + m.M["35", "FAT"] + wwt_share_x)
    m.WWT_VSdeg = Constraint(expr=m.mVS_deg_WWT == s["f_ox_WWT"] * m.mVS_in)
    # VS captured in sludge before digestion, and VS destroyed in the digester, kg/h
    vs_sludge_pre = rWW["CBH"] * m.M["35", "CBH"] + rWW["PRT"] * m.M["35", "PRT"] + rWW["FAT"] * m.M["35", "FAT"] + rWW["OTH"] * wwt_share_x
    vs_dig = s["f_dig_WWT"] * vs_sludge_pre
    # Biosolids after digestion
    m.WWT_split_bio = Constraint([k for k in COMP if k not in ("OTH", "CBH", "PRT", "FAT")], rule=lambda m, k: m.M["37", k] == rWW.get(k, 0.0) * m.M["35", k])
    m.WWT_split_VS = Constraint(["CBH", "PRT", "FAT"], rule=lambda m, k: m.M["37", k] == (1.0 - s["f_dig_WWT"]) * rWW[k] * m.M["35", k])
    # Nonvolatile OTH fully captured; volatile OTH captured then partly digested
    m.WWT_split_OTH = Constraint(expr=m.M["37", "OTH"] == m.M["35", "OTH"] - wwt_share_x + (1.0 - s["f_dig_WWT"]) * rWW["OTH"] * wwt_share_x)
    # Dry biosolids to farmland, kg/h
    m.WWT_biosolids_prod = Constraint(expr=m.Px == _dry(m, "37"))
    # Nitrogen: N released in digestion returns to the plant and leaves in effluent
    WWT_N_in = Nf * sum(m.M["35", k] for k in ORG5)
    WWT_N_sludge = Nf * sum(m.M["37", k] for k in ORG5)
    # Offgas, kg/h: CO2 from basin oxidation and digester VS destruction
    m.WWT_off_CO2 = Constraint(expr=m.M["36", "CO2"] == Fd["Y_CO2_AER"] * (m.mVS_deg_WWT + vs_dig))
    # Methane factor applied to the uncaptured COD load
    WWT_uncaptured_VS = (1.0 - rWW["CBH"]) * m.M["35", "CBH"] + (1.0 - rWW["PRT"]) * m.M["35", "PRT"] + (1.0 - rWW["FAT"]) * m.M["35", "FAT"] + (1.0 - rWW["OTH"]) * wwt_share_x
    m.WWT_off_CH4 = Constraint(expr=m.M["36", "CH4"] == s["B0_WWT"] * s["MCF_WWT"] * Fd["Y_O2_AER"] * WWT_uncaptured_VS)
    m.WWT_off_N2O = Constraint(expr=m.M["36", "N2O"] == s["EF_N2O_WWT"] * (44.013 / 28.013) * WWT_N_in)
    _fix_zero(m, "36", ["CO2", "CH4", "N2O"])
    # Nitrogen discharged in effluent, kg N/h
    m.WWT_N_eff_eq = Constraint(expr=m.N_eff_WWT == WWT_N_in - WWT_N_sludge - (28.013 / 44.013) * m.M["36", "N2O"])
    # Effluent mass balance, including O2 consumed in basin and digester
    m.WWT_wasteleft = Constraint(expr=m.m_wasteleft_WWT == _wet(m, "35") + Fd["Y_O2_AER"] * (m.mVS_deg_WWT + vs_dig) - _wet(m, "37") - _wet(m, "36"))
    # Effluent load for sewer charges
    m.WWT_eff_COD = Expression(expr=Fd["Y_O2_AER"] * (WWT_uncaptured_VS - m.mVS_deg_WWT))
    m.WWT_eff_water = Expression(expr=(1.0 - rWW["WATER"]) * m.M["35", "WATER"])
    # Capacity = COD load, kg COD/h
    m.WWT_capacity = Constraint(expr=m.Qc_s["WWT"] == Fd["Y_O2_AER"] * m.mVS_in)
    m.WWT_installed_capacity = Constraint(expr=m.Qc["WWT"] == m.Qc_s["WWT"])
    # Whole-plant electricity, kW
    m.WWT_power = Constraint(expr=m.PW_op["WWT"] == s["e_COD_WWT"] * (Fd["Y_O2_AER"] * m.mVS_in - m.WWT_eff_COD))
    # Biosolids to farmland (land-application cost via negative price)
    _no_utility_no_product(m, "WWT", prod_keep=("BIOSOLIDS",))
    m.WWT_biosolids_sale = Constraint(expr=m.Mprod["WWT", "BIOSOLIDS"] == m.Px)

print("WWT equations created.")



# CELL 31 — INC: INCINERATION EQUATIONS

@model_step
def cell_31_INC(m):
    s, Fd, Wsp = m.P["sc"], m.Fd, m.P["Wsp"]
    # Stream 38: waste inlet; stream 39: trace emissions; stream 40: main flue gas
    INC_MW_O2 = 2.0 * MW_O
    INC_MW_N2 = 2.0 * MW_N
    INC_MW_SO2 = MW_S + 2.0 * MW_O
    INC_MW_N2O = 2.0 * MW_N + MW_O
    INC_MW_NO2 = MW_N + 2.0 * MW_O
    # Dry mass, ash and dry ash-free organics, kg/h
    m.INC_dryfeed = Constraint(expr=m.mdry_inc == _wet(m, "38") - m.M["38", "WATER"])
    m.INC_ash = Constraint(expr=m.m_ash_INC == m.M["38", "ASH"])
    m.INC_daf = Constraint(expr=m.mdaf_inc == m.mdry_inc - m.m_ash_INC)
    # Elemental feed flows, kmol atoms/h
    m.INC_elem_C = Constraint(expr=m.nC_inc == m.mdaf_inc * Fd["C_frac"] / MW_C)
    m.INC_elem_H = Constraint(expr=m.nH_inc == m.mdaf_inc * Fd["H_frac"] / MW_H)
    m.INC_elem_O = Constraint(expr=m.nO_inc == m.mdaf_inc * Fd["O_frac"] / MW_O)
    m.INC_elem_N = Constraint(expr=m.nN_inc == m.mdaf_inc * Fd["N_frac"] / MW_N)
    m.INC_elem_S = Constraint(expr=m.nS_inc == m.mdaf_inc * Fd["S_frac"] / MW_S)
    # Signed net waste heat, MJ/h
    m.INC_net_heat = Var(domain=Reals)
    m.INC_LHV = Constraint(expr=m.INC_net_heat == Fd["HHV_feed"] * m.mdry_inc - s["hfg_water"] * (m.M["38", "WATER"] + _M_H2O * 0.5 * m.nH_inc))
    # L5: exact auxiliary fuel required to meet the retained combustion threshold (tight M)
    m.INC_fuel_needed = Var(domain=Binary)
    INC_heat_deficit = s["LHV_selfsust"] * _wet(m, "38") - m.INC_net_heat
    m.INC_aux_NG_lower = Constraint(expr=m.NG_aux_INC * s["LHV_NG"] >= INC_heat_deficit)
    m.INC_aux_NG_upper = Constraint(expr=m.NG_aux_INC * s["LHV_NG"] <= INC_heat_deficit + m.M_INC_fuel_upper * (1.0 - m.INC_fuel_needed))
    m.INC_aux_NG_switch = Constraint(expr=m.NG_aux_INC <= m.M_INC_fuel_switch * m.INC_fuel_needed)
    # Engineering fuel limit ties auxiliary gas to actual waste feed
    m.INC_aux_activation = Constraint(expr=m.NG_aux_INC <= s["MAX_NG_PER_WET_FEED"] * _wet(m, "38"))
    m.INC_NG_mol = Constraint(expr=m.nNG_inc == m.NG_aux_INC / _M_CH4)
    m.INC_fossil_CO2 = Constraint(expr=m.CO2_fossil_INC == s["EF_NG_fossil"] * m.NG_aux_INC)
    # Trace emissions, kg/h
    m.INC_fug_CH4 = Constraint(expr=m.M["39", "CH4"] == s["EF_CH4_INC_wet"] * _wet(m, "38"))
    m.INC_fug_N2O = Constraint(expr=m.M["39", "N2O"] == s["EF_N2O_INC_wet"] * _wet(m, "38"))
    # NOx is represented as NO2-equivalent mass outside the component set
    m.INC_fug_NOx = Constraint(expr=m.NOx_INC_kgph == s["EF_NOx_INC_wet"] * _wet(m, "38"))
    _fix_zero(m, "39", ["CH4", "N2O"])
    INC_trace_CH4_mol = m.M["39", "CH4"] / _M_CH4
    INC_trace_N2O_mol = m.M["39", "N2O"] / INC_MW_N2O
    INC_trace_NO2_mol = m.NOx_INC_kgph / INC_MW_NO2
    # Oxygen demand accounts for trace products rather than counting their atoms twice
    m.INC_stoO2 = Constraint(expr=m.nO2_sto == m.nC_inc + 0.25 * m.nH_inc + m.nS_inc - 0.5 * m.nO_inc + 2.0 * m.nNG_inc - 2.0 * INC_trace_CH4_mol + 0.5 * INC_trace_N2O_mol + INC_trace_NO2_mol)
    # Air supply, kmol/h
    m.INC_airO2 = Constraint(expr=m.nO2_in == s["lambda_inc"] * m.nO2_sto)
    m.INC_airN2 = Constraint(expr=m.nN2_air == (0.79 / 0.21) * m.nO2_in)
    # Main combustion products, kmol/h
    m.INC_prod_CO2 = Constraint(expr=m.nCO2_inc == m.nC_inc + m.nNG_inc - INC_trace_CH4_mol)
    m.INC_prod_H2O = Constraint(expr=m.nH2O_inc == 0.5 * m.nH_inc + 2.0 * m.nNG_inc - 2.0 * INC_trace_CH4_mol)
    m.INC_prod_SO2 = Constraint(expr=m.nSO2_inc == m.nS_inc)
    m.INC_prod_O2 = Constraint(expr=m.nO2_out == m.nO2_in - m.nO2_sto)
    m.INC_prod_N2 = Constraint(expr=m.nN2_out == m.nN2_air + 0.5 * m.nN_inc - INC_trace_N2O_mol - 0.5 * INC_trace_NO2_mol)
    # Main flue-gas component flows, kg/h
    m.INC_flue_CO2 = Constraint(expr=m.M["40", "CO2"] == _M_CO2 * m.nCO2_inc)
    m.INC_flue_H2O = Constraint(expr=m.M["40", "WATER"] == m.M["38", "WATER"] + _M_H2O * m.nH2O_inc)
    m.INC_flue_SO2 = Constraint(expr=m.M["40", "SO2"] == INC_MW_SO2 * m.nSO2_inc)
    m.INC_flue_O2 = Constraint(expr=m.M["40", "O2"] == INC_MW_O2 * m.nO2_out)
    m.INC_flue_N2 = Constraint(expr=m.M["40", "N2"] == INC_MW_N2 * m.nN2_out)
    _fix_zero(m, "40", ["CO2", "WATER", "SO2", "O2", "N2"])
    # Total main flue gas, including separately tracked NOx
    m.INC_mflue = Constraint(expr=m.mflue_inc == _wet(m, "40") + m.NOx_INC_kgph)
    # Wet-feed throughput capacity, kg/h
    m.INC_capacity = Constraint(expr=m.Qc_s["INC"] == _wet(m, "38"))
    m.INC_installed_capacity = Constraint(expr=m.Qc["INC"] == m.Qc_s["INC"])
    # Auxiliary electrical demand, kW
    m.INC_power = Constraint(expr=m.PW_op["INC"] == Wsp["INC"] * m.Qc_s["INC"])
    # Electricity production is assigned to the steam turbine
    _no_utility_no_product(m, "INC")

print("INC equations created.")


# CELL 32 — MIXER 3 AND HTL RECOVERY ROUTING

@model_step
def cell_32_mixer3_splitter4_L2(m):
    s, Fd, B = m.P["sc"], m.Fd, m.B
    yHTL = Fd["yHTL"]
    # Mixer 3: AND biogas (27) + captured landfill gas (30) -> stream 48
    m.Mxr3_bal = Constraint(m.K, rule=lambda m, k: m.M["48", k] == m.M["27", k] + m.M["30", k])
    # Splitter 4: HTL products (22) -> CEN (41) + FLT (44)
    m.Spl4_bal = Constraint(m.K, rule=lambda m, k: m.M["22", k] == m.M["41", k] + m.M["44", k])
    # L2: CEN inlet = HTL products of the CEN share of stream 19 (same yields, water rule and binary)
    M19c = {k: m.branch_flow("HTL_CEN", k) for k in COMP}
    daf_c = sum(M19c[k] for k in ORG5)
    deficit_c = (1.0 / s["TS_HTL"] - 1.0) * _dry_of(M19c) - M19c["WATER"]
    m.M21c = Var(domain=NonNegativeReals, bounds=(0.0, B["htl_water_max"]))   # water added to the CEN share
    m.L2_water_lower = Constraint(expr=m.M21c >= deficit_c)
    m.L2_water_upper = Constraint(expr=m.M21c <= deficit_c + m.M_HTL_water_upper * (1.0 - m.HTL_water_needed))
    m.L2_water_switch = Constraint(expr=m.M21c <= m.M_HTL_water_switch * m.HTL_water_needed)
    m.Spl4_CEN_BIOCRUDE = Constraint(expr=m.M["41", "BIOCRUDE"] == yHTL["BIOCRUDE"] * daf_c)
    m.Spl4_CEN_CHAR = Constraint(expr=m.M["41", "CHAR"] == yHTL["CHAR"] * daf_c + M19c["ASH"])
    m.Spl4_CEN_AQ = Constraint(expr=m.M["41", "AQ"] == yHTL["AQ"] * daf_c + M19c["WATER"] + m.M21c)

print("Mixer 3 and HTL recovery routing equations created.")
print("L2: Splitter 4 reformulated exactly (CEN share routed as its own Splitter-3 branch).")



# CELL 33 — CEN: CENTRIFUGE EQUATIONS

@model_step
def cell_33_CEN(m):
    s, Wsp, DEN = m.P["sc"], m.P["Wsp"], m.P["DEN"]
    # Stream 41: inlet; stream 42: aqueous/solid reject; stream 43: biocrude product
    m.CEN_bal = Constraint(m.K, rule=lambda m, k: m.M["41", k] == m.M["42", k] + m.M["43", k])
    # Biocrude recovery
    m.CEN_liq_BIOCRUDE = Constraint(expr=m.M["43", "BIOCRUDE"] == s["Eff_CNT"] * m.M["41", "BIOCRUDE"])
    # Aqueous phase and char go to reject
    m.CEN_reject_AQ = Constraint(expr=m.M["42", "AQ"] == m.M["41", "AQ"])
    m.CEN_reject_CHAR = Constraint(expr=m.M["42", "CHAR"] == m.M["41", "CHAR"])
    # Product contains biocrude only; no other components in inlet and reject
    _fix_zero(m, "43", ["BIOCRUDE"])
    _fix_zero(m, "41", ["BIOCRUDE", "CHAR", "AQ"])
    _fix_zero(m, "42", ["BIOCRUDE", "CHAR", "AQ"])
    # Volumetric throughput capacity, m3/h
    m.CEN_capacity = Constraint(expr=m.Qc_s["CEN"] == m.M["41", "BIOCRUDE"] / DEN["BIOCRUDE"] + m.M["41", "CHAR"] / DEN["CHAR"] + m.M["41", "AQ"] / DEN["AQ"])
    m.CEN_installed_capacity = Constraint(expr=m.Qc["CEN"] == m.Qc_s["CEN"])
    # Power demand, kW
    m.CEN_power = Constraint(expr=m.PW_op["CEN"] == Wsp["CEN"] * m.Qc_s["CEN"])
    # No steam, cooling water or separate product revenue
    _no_utility_no_product(m, "CEN")

print("CEN equations created.")



# CELL 34 — FLT: FILTRATION EQUATIONS

@model_step
def cell_34_FLT(m):
    Wsp, DEN, rFLT = m.P["Wsp"], m.P["DEN"], m.P["rFLT"]
    # Stream 44: inlet; stream 45: reject; stream 46: product
    m.FLT_bal = Constraint(m.K, rule=lambda m, k: m.M["44", k] == m.M["45", k] + m.M["46", k])
    # rFLT specifies the fraction sent to reject
    m.FLT_reject = Constraint(["BIOCRUDE", "CHAR", "AQ"], rule=lambda m, k: m.M["45", k] == rFLT[k] * m.M["44", k])
    # Remaining fraction goes to product
    m.FLT_product = Constraint(["BIOCRUDE", "CHAR", "AQ"], rule=lambda m, k: m.M["46", k] == (1.0 - rFLT[k]) * m.M["44", k])
    # Prevent other components in inlet, reject and product
    for j in ["44", "45", "46"]:
        _fix_zero(m, j, ["BIOCRUDE", "CHAR", "AQ"])
    # Volumetric throughput capacity, m3/h
    m.FLT_capacity = Constraint(expr=m.Qc_s["FLT"] == m.M["44", "BIOCRUDE"] / DEN["BIOCRUDE"] + m.M["44", "CHAR"] / DEN["CHAR"] + m.M["44", "AQ"] / DEN["AQ"])
    m.FLT_installed_capacity = Constraint(expr=m.Qc["FLT"] == m.Qc_s["FLT"])
    # Power demand, kW
    m.FLT_power = Constraint(expr=m.PW_op["FLT"] == Wsp["FLT"] * m.Qc_s["FLT"])
    # No steam, cooling water or separate product revenue
    _no_utility_no_product(m, "FLT")

print("FLT equations created.")



# CELL 35 — MIXER 4 AND FINAL BIOCRUDE PRODUCT

@model_step
def cell_35_mixer4(m):
    # Mixer 4: CEN product (43) + FLT product (46) -> stream 47
    m.Mxr4_bal = Constraint(m.K, rule=lambda m, k: m.M["47", k] == m.M["43", k] + m.M["46", k])
    # Count recovered biocrude once as the HTL saleable product
    m.HTL_biocrude_prod = Constraint(expr=m.Mprod["HTL", "BIOCRUDE"] == m.M["47", "BIOCRUDE"])

print("Mixer 4 and final biocrude product equations created.")



# CELL 36 — SPLITTER 5: BIOGAS UPGRADING ROUTING

@model_step
def cell_36_splitter5_L4(m):
    s, Fd, B = m.P["sc"], m.Fd, m.B
    # Stream 48: combined biogas; stream 49: ABS inlet; stream 53: PSA inlet
    m.Spl5_bal = Constraint(m.K, rule=lambda m, k: m.M["48", k] == m.M["49", k] + m.M["53", k])
    # Fixed CO2/CH4 mass ratios of the two biogas sources
    m.rho_A = Fd["CO2_yield_AND"] / Fd["CH4_yield_AND"]
    m.rho_S = ((1.0 - s["F_value"]) / s["F_value"]) * (s["MW_CO2_AND"] / s["MW_CH4"])
    m.GA = s["eta_cap_AND"] * Fd["CH4_yield_AND"] * B["dry_max"]   # bound of M[27,CH4]
    m.GS = s["CAP_SLF"] * B["slf_ch4_max"]                         # bound of M[30,CH4]
    # L4: aABS = fUpg[ABS]*M27[CH4], bABS = fUpg[ABS]*M30[CH4] (McCormick envelopes)
    m.aABS = Var(domain=NonNegativeReals, bounds=(0.0, m.GA))
    m.bABS = Var(domain=NonNegativeReals, bounds=(0.0, m.GS))
    f = m.fUpg["ABS"]
    m.L4_mc_a1 = Constraint(expr=m.aABS >= m.M["27", "CH4"] - m.GA * (1.0 - f))
    m.L4_mc_a2 = Constraint(expr=m.aABS <= m.M["27", "CH4"])
    m.L4_mc_a3 = Constraint(expr=m.aABS <= m.GA * f)
    m.L4_mc_b1 = Constraint(expr=m.bABS >= m.M["30", "CH4"] - m.GS * (1.0 - f))
    m.L4_mc_b2 = Constraint(expr=m.bABS <= m.M["30", "CH4"])
    m.L4_mc_b3 = Constraint(expr=m.bABS <= m.GS * f)
    # Proportional split of the CH4/CO2 stream (linear in aABS, bABS)
    m.Spl5_ABS_CH4 = Constraint(expr=m.M["49", "CH4"] == m.aABS + m.bABS)
    m.Spl5_ABS_CO2 = Constraint(expr=m.M["49", "CO2"] == m.rho_A * m.aABS + m.rho_S * m.bABS)
    # Upgrading fractions refer to the combined biogas stream
    m.Upg_choose = Constraint(expr=m.fUpg["ABS"] + m.fUpg["PSA"] == 1.0)

print("Biogas upgrading routing equations created.")
print(f"L4: CO2/CH4 ratio, AND biogas = {m.rho_A:.6f}; landfill gas = {m.rho_S:.6f}")



# CELL 37 — ABS: BIOGAS WATER-SCRUBBING EQUATIONS

@model_step
def cell_37_ABS(m):
    s = m.P["sc"]
    # Stream 49: biogas inlet; stream 50: water bleed; stream 51: offgas; stream 52: upgraded gas
    _fix_zero(m, "49", ["CH4", "CO2"])
    # Methane recovery and remaining carbon dioxide
    m.ABS_CH4_prod = Constraint(expr=m.M["52", "CH4"] == (1.0 - s["slipCH4_ABS"]) * m.M["49", "CH4"])
    m.ABS_CO2_prod = Constraint(expr=m.M["52", "CO2"] == (1.0 - s["etaCO2_ABS"]) * m.M["49", "CO2"])
    _fix_zero(m, "52", ["CH4", "CO2"])
    # Methane slip and removed carbon dioxide
    m.ABS_CH4_off = Constraint(expr=m.M["51", "CH4"] == s["slipCH4_ABS"] * m.M["49", "CH4"])
    m.ABS_CO2_off = Constraint(expr=m.M["51", "CO2"] == s["etaCO2_ABS"] * m.M["49", "CO2"])
    _fix_zero(m, "51", ["CH4", "CO2"])
    # Inlet gas flow at STP, Nm3/h
    ABS_gas_flow = s["Vm_STP"] * (m.M["49", "CH4"] / s["MW_CH4"] + m.M["49", "CO2"] / s["MW_CO2_AND"])
    # Make-up water equals bleed, kg/h
    m.ABS_water_50 = Constraint(expr=m.M["50", "WATER"] == s["w_ABS"] * ABS_gas_flow)
    _fix_zero(m, "50", ["WATER"])
    # Installed gas-throughput capacity, Nm3/h
    m.ABS_cap = Constraint(expr=m.Qc_s["ABS"] == ABS_gas_flow)
    m.ABS_installed_capacity = Constraint(expr=m.Qc["ABS"] == m.Qc_s["ABS"])
    # Power demand, kW
    m.ABS_power = Constraint(expr=m.PW_op["ABS"] == s["e_el_ABS"] * ABS_gas_flow)
    # Methane purity on a molar basis
    m.ABS_purity = Constraint(expr=m.M["52", "CH4"] / s["MW_CH4"] >= s["Pur_CH4"] * (m.M["52", "CH4"] / s["MW_CH4"] + m.M["52", "CO2"] / s["MW_CO2_AND"]))
    # No steam or cooling water; saleable methane after upgrading, kg/h
    _no_utility_no_product(m, "ABS", prod_keep=("CH4",))
    m.ABS_CH4_mprod = Constraint(expr=m.Mprod["ABS", "CH4"] == m.M["52", "CH4"])

print("ABS equations created.")



# CELL 38 — PSA: PRESSURE SWING ADSORPTION EQUATIONS

@model_step
def cell_38_PSA(m):
    s = m.P["sc"]
    # Stream 53: biogas inlet; stream 54: offgas; stream 55: upgraded gas
    _fix_zero(m, "53", ["CH4", "CO2"])
    # Methane recovery and remaining carbon dioxide
    m.PSA_CH4_prod = Constraint(expr=m.M["55", "CH4"] == (1.0 - s["slipCH4_PSA"]) * m.M["53", "CH4"])
    m.PSA_CO2_prod = Constraint(expr=m.M["55", "CO2"] == (1.0 - s["etaCO2_PSA"]) * m.M["53", "CO2"])
    _fix_zero(m, "55", ["CH4", "CO2"])
    # Methane slip and removed carbon dioxide
    m.PSA_CH4_off = Constraint(expr=m.M["54", "CH4"] == s["slipCH4_PSA"] * m.M["53", "CH4"])
    m.PSA_CO2_off = Constraint(expr=m.M["54", "CO2"] == s["etaCO2_PSA"] * m.M["53", "CO2"])
    _fix_zero(m, "54", ["CH4", "CO2"])
    # Inlet gas flow at STP, Nm3/h
    PSA_gas_flow = s["Vm_STP"] * (m.M["53", "CH4"] / s["MW_CH4"] + m.M["53", "CO2"] / s["MW_CO2_AND"])
    # Installed gas-throughput capacity, Nm3/h
    m.PSA_cap = Constraint(expr=m.Qc_s["PSA"] == PSA_gas_flow)
    m.PSA_installed_capacity = Constraint(expr=m.Qc["PSA"] == m.Qc_s["PSA"])
    # Power demand, kW
    m.PSA_power = Constraint(expr=m.PW_op["PSA"] == s["e_el_PSA"] * PSA_gas_flow)
    # Methane purity on a molar basis
    m.PSA_purity = Constraint(expr=m.M["55", "CH4"] / s["MW_CH4"] >= s["Pur_CH4"] * (m.M["55", "CH4"] / s["MW_CH4"] + m.M["55", "CO2"] / s["MW_CO2_AND"]))
    # No steam or cooling water; saleable methane after upgrading, kg/h
    _no_utility_no_product(m, "PSA", prod_keep=("CH4",))
    m.PSA_CH4_mprod = Constraint(expr=m.Mprod["PSA", "CH4"] == m.M["55", "CH4"])

print("PSA equations created.")



# CELL 39 — MIXER 5: FINAL BIOMETHANE STREAM

@model_step
def cell_39_mixer5(m):
    # ABS product (52) + PSA product (55) -> final gas product (56)
    m.Mxr5_bal = Constraint(m.K, rule=lambda m, k: m.M["56", k] == m.M["52", k] + m.M["55", k])

print("Mixer 5 equations created.")



# CELL 40 — STB: BOILER AND STEAM TURBINE EQUATIONS

@model_step
def cell_40_STB(m):
    s, Wsp = m.P["sc"], m.P["Wsp"]
    # Stream 59: boiler feedwater; stream 60: steam; stream 57: electricity (kW)
    # Turbine operation is linked to the incineration route
    m.STB_link = Constraint(expr=m.fSTB == m.fConv["INC"])
    # Heat recovered from actual incinerator flue gas, kJ/h
    m.STB_HE_balance = Constraint(expr=m.mflue_inc * s["CP_g"] * (s["T_g_in"] - s["T_g_out"]) == m.M["59", "WATER"] * (s["h_stm_STB"] - s["h_fw_STB"]))
    # Boiler feedwater contains water only
    _fix_zero(m, "59", ["WATER"])
    # Steam mass equals feedwater mass, kg/h
    m.STB_steam_bal = Constraint(expr=m.M["60", "WATER"] == m.M["59", "WATER"])
    _fix_zero(m, "60", ["WATER"])
    # Ideal turbine power before efficiencies, kJ/h
    m.STB_turb_power = Constraint(expr=m.P_turbine == m.M["60", "WATER"] * (s["h_stm_STB"] - s["h_2s_STB"]))
    # Gross electrical output, kW
    m.STB_elec_cap = Constraint(expr=m.Qc_s["STB"] == s["eta_turbine"] * s["eta_generator"] * m.P_turbine / 3600.0)
    m.STB_installed_capacity = Constraint(expr=m.Qc["STB"] == m.Qc_s["STB"])
    # Turbine-system auxiliary power demand, kW
    m.STB_power = Constraint(expr=m.PW_op["STB"] == Wsp["STB"] * m.Qc_s["STB"])
    # Electricity reporting stream
    m.STB_elec_stream = Constraint(expr=m.M["57", "ELECTRICITY"] == m.Qc_s["STB"])
    _fix_zero(m, "57", ["ELECTRICITY"])
    # Steam is generated internally, not purchased
    m.Mstm["STB"].fix(0.0)
    # Condenser cooling-water circulation, kg/h
    m.STB_cw = Constraint(expr=m.Mcw["STB"] * s["Cp_water"] * (s["Tcw_out"] - s["Tcw_in"]) == m.M["60", "WATER"] * (s["h_stm_STB"] - s["eta_turbine"] * (s["h_stm_STB"] - s["h_2s_STB"]) - s["h_fw_STB"]))
    # Gross electricity product; auxiliary demand is charged separately
    m.STB_prod_elec = Constraint(expr=m.Mprod["STB", "ELECTRICITY"] == m.Qc_s["STB"])
    for kp in KP:
        if kp != "ELECTRICITY":
            m.Mprod["STB", kp].fix(0.0)
    # Boiler recovery cannot exceed available combustion energy
    m.STB_energy_available = Constraint(expr=m.M["59", "WATER"] * (s["h_stm_STB"] - s["h_fw_STB"]) <= 1000.0 * s["ETA_BOILER_INC"] * (m.INC_net_heat + m.NG_aux_INC * s["LHV_NG"]))

print("Boiler and steam turbine equations created.")



# CELL 41 — ECONOMIC ACCOUNTING

def set_capital_pwl(m, extra_bp=None):
    """(Re)build the capital-cost PWL (L6), with extra breakpoints at given capacities."""
    s, B = m.P["sc"], m.B
    if extra_bp is not None:
        m.extra_bp = dict(extra_bp)
    if hasattr(m, "Capital_pwl"):
        m.del_component(m.Capital_pwl)
    s_cap, n_cap = s["CAP_SMOOTH"], s["nc"]
    m.pw_points = {t: pwl_breakpoints(B["capacity_limits"][t], m.P["Q0"][t], s_cap, n_cap, PWL_REL_TOL, m.extra_bp.get(t, []))
                   for t in TECH}
    m.Capital_pwl = Piecewise(m.I, m.PurchaseCost, m.Qc, pw_pts=m.pw_points, pw_constr_type="EQ", pw_repn="INC",
                              unbounded_domain_var=True, warn_domain_coverage=False,   # INC form keeps Qc inside [0, Qmax]
                              f_rule=lambda m_, t, q: m.P["C0"][t] * capital_curve(q / m.P["Q0"][t], s_cap, n_cap))

@model_step
def cell_41_economics(m):
    s, P_ = m.P["sc"], m.P
    # Equipment purchase cost, dollars (L6: piecewise linear)
    set_capital_pwl(m)
    sumPC = sum(m.PurchaseCost[t] for t in TECH)
    # Annualized installed capital, M$/yr
    m.ACC_eq = Constraint(expr=m.CCAC == s["CRF"] * s["BMC_mult"] * sumPC / 1e6)
    # Annualized working-capital charge
    m.WC_eq = Constraint(expr=m.CCWC == s["r_wc"] * s["CRF"] * s["BMC_mult"] * sumPC / 1e6)
    # Annual insurance cost
    m.INS_eq = Constraint(expr=m.CCINS == s["r_ins"] * s["BMC_mult"] * sumPC / 1e6)
    # Labour requirement scaled by installed capacity
    m.Labor_units_eq = Constraint(m.I, rule=lambda m, t: m.Nlabr_new[t] * P_["Q0"][t] == P_["NLBR"][t] * m.Qc[t])
    m.Labor_eq = Constraint(expr=m.CCLB == sum(m.Nlabr_new[t] for t in TECH) * s["C_lbr"] * s["Tann"] / 1e6)
    # Purchased electricity, steam and cooling water
    m.Utility_eq = Constraint(expr=m.CCUC == (s["Tann"] / 1e6) * (s["C_elec"] * sum(m.PW_op[t] for t in TECH) + s["C_stm"] * sum(m.Mstm[t] for t in TECH) + s["C_pwt"] * sum(m.Mcw[t] for t in TECH)))
    # Maintenance, overhead and local taxes
    m.Overhead_eq = Constraint(expr=m.CCOC == s["r_fac"] * s["BMC_mult"] * sumPC / 1e6)
    # Purchased process water: count each addition once
    m.process_water_added = Expression(expr=m.M["7", "WATER"] + m.M["21", "WATER"] + m.M["24", "WATER"] + m.M["50", "WATER"])
    # Enzyme and auxiliary natural gas
    m.CCRM_eq = Constraint(expr=m.CCRM == (s["Tann"] / 1e6) * (s["C_water"] * m.process_water_added + s["C_enzyme"] * m.M["15", "ENZYME"] + s["C_NG"] * (m.NG_aux_INC + m.M_NG_HTL)))
    # Disposal costs
    m.HTL_solid_reject = Expression(expr=m.M["42", "CHAR"] + m.M["45", "CHAR"] + m.M["42", "BIOCRUDE"] + m.M["45", "BIOCRUDE"])
    m.HTL_aqueous_reject = Expression(expr=m.M["42", "AQ"] + m.M["45", "AQ"])
    m.Disposal_eq = Constraint(expr=m.CDISP == (s["Tann"] / 1e6) * (s["C_disp_reject"] * _wet(m, "5") + s["C_disp_char"] * m.HTL_solid_reject + s["C_disp_aq"] * m.HTL_aqueous_reject + s["C_disp_aq"] * m.M["50", "WATER"] + s["C_disp_land"] * _wet(m, "28") + s["C_sewer_flow"] * m.WWT_eff_water + s["C_sewer_COD"] * m.WWT_eff_COD + s["C_disp_land"] * m.m_ash_INC))
    # Tipping fee received on raw food waste only
    m.Tipping_eq = Constraint(expr=m.CTIP == s["C_tip"] * P_["Qf"] * s["Tann"] / 1e6)
    # Product revenue: use Mprod once
    m.Revenue_eq = Constraint(expr=m.REV == (s["Tann"] / 1e6) * sum(P_["Price_prod"][kp] * m.Mprod[t, kp] for t in TECH for kp in KP) + m.CTIP)
    # Q2: fixed annual charge of selected stage II/III units (0 until FIXED_CHARGE is filled)
    m.CFIX = Expression(expr=(sum(FIXED_CHARGE[t] * m.y[t] for t in STAGE23) / 1e6) if settings()["stage23_binaries"] else 0.0)
    # Total annual cost
    m.Total_eq = Constraint(expr=m.CCTC == m.CCAC + m.CCWC + m.CCINS + m.CCUC + m.CCLB + m.CCOC + m.CCRM + m.CDISP + m.CFIX)
    # Net annual cost, M$/yr
    m.NetCost_eq = Constraint(expr=m.NAC == m.CCTC - m.REV)
    # Capital-cost factor (M$/yr per $ of purchase cost), used to re-price the PWL exactly
    m.capital_factor = (s["CRF"] * s["BMC_mult"] + s["r_wc"] * s["CRF"] * s["BMC_mult"] + s["r_ins"] * s["BMC_mult"] + s["r_fac"] * s["BMC_mult"]) / 1e6

print("Economic accounting equations created.")
print(f"L6: capital-cost PWL with {sum(len(p) - 1 for p in m.pw_points.values())} segments in total "
      f"(max chord error {100 * PWL_REL_TOL:.0f}%, CAP_SMOOTH = {P['sc']['CAP_SMOOTH']}):")
print({t: len(p) - 1 for t, p in m.pw_points.items()})



# CELL 42 — GREENHOUSE GAS ACCOUNTING

@model_step
def cell_42_GHG(m):
    s, Fd = m.P["sc"], m.Fd
    Nf = Fd["N_frac"]
    # Nitrogen bookkeeping for land-applied products, kg N/h
    m.N_compost = Expression(expr=Nf * sum(m.M["34", k] for k in ORG5))
    m.N_biosolids = Expression(expr=Nf * sum(m.M["37", k] for k in ORG5))
    m.N_digestate = Expression(expr=Nf * sum(m.M["26", k] for k in ORG5) + (MW_N / _M_NH3) * m.M["26", "NH3"])
    # Purchased utility and material burdens, kg CO2-eq/h
    m.GHG_ind_ph_eq = Constraint(expr=m.GHG_ind_kgph == s["EF_elec"] * sum(m.PW_op[t] for t in TECH) + s["EF_stm"] * sum(m.Mstm[t] for t in TECH) + s["EF_NG_sup"] * (m.NG_aux_INC + m.M_NG_HTL) + s["EF_enz"] * m.M["15", "ENZYME"] + s["EF_water"] * m.process_water_added)
    m.GHG_ind_yr_eq = Constraint(expr=m.GHG_ind_kgyr == s["Tann"] * m.GHG_ind_kgph)
    m.GHG_ind_tpy_eq = Constraint(expr=m.GHG_ind_tpy == m.GHG_ind_kgyr / 1000.0)
    # Methane escaping from process streams, kg/h
    process_CH4_emitted = sum(m.M[j, "CH4"] for j in ["25", "29", "32", "36", "39", "51", "54"])
    # Assumption: SHR rejects are landfilled using the same gas-potential model
    SHR_reject_dry = _wet(m, "5") - m.M["5", "WATER"]
    SHR_reject_CH4 = (1.0 - s["CAP_SLF"]) * (1.0 - s["OX"]) * s["DOC_value"] * s["DOC_f_value"] * s["MCF_value"] * s["F_value"] * s["ratio_CH4_to_C"] * SHR_reject_dry
    # Vented methane from HTL gas
    HTL_vented_CH4 = s["HTL_gas_vent_frac"] * s["HTL_gas_CH4_frac"] * m.M["20", "GAS"]
    # Nitrous oxide emissions, kg N2O/h
    process_N2O_emitted = m.M["32", "N2O"] + m.M["36", "N2O"] + m.M["39", "N2O"] + (44.013 / 28.013) * m.N_HTL_N2O
    # Fossil CO2 from auxiliary fuel combustion
    auxiliary_fossil_CO2 = m.CO2_fossil_INC + s["EF_NG_fossil"] * m.M_NG_HTL
    # Direct emissions, t CO2-eq/yr (biogenic CO2 has zero characterization)
    m.GHG_dir_total_eq = Constraint(expr=m.GHG_dir_total == (s["Tann"] / 1000.0) * (s["GWP_CH4"] * (process_CH4_emitted + SHR_reject_CH4 + HTL_vented_CH4) + s["GWP_N2O"] * process_N2O_emitted + auxiliary_fossil_CO2 + s["EF_HTLgas"] * m.M["20", "GAS"]))
    # Product and fertilizer displacement credits, t CO2-eq/yr
    m.GHG_disp_eq = Constraint(expr=m.GHG_disp == (s["Tann"] / 1000.0) * (s["EF_CH4_disp"] * m.M["56", "CH4"] + s["EF_BIOCRUDE_disp"] * m.M["47", "BIOCRUDE"] + s["EF_ELEC_disp"] * m.Mprod["STB", "ELECTRICITY"] + s["EF_Nfert"] * (s["MFE_CMP"] * m.N_compost + s["MFE_WWT"] * m.N_biosolids)))
    # Disposal burdens, t CO2-eq/yr
    m.GHG_aq_eq = Constraint(expr=m.GHG_aq == (s["Tann"] / 1000.0) * (s["EF_AQ_disp"] * (m.HTL_aqueous_reject + m.M["50", "WATER"]) + s["EF_CHAR_disp"] * (m.HTL_solid_reject + m.m_ash_INC)))
    # Digestate fertilizer displacement credit
    m.GHG_digestate_eq = Constraint(expr=m.GHG_digestate == (s["Tann"] / 1000.0) * s["EF_Nfert"] * s["MFE_AND"] * m.N_digestate)
    # Net greenhouse gas objective
    m.GHG_total_tpy_eq = Constraint(expr=m.GHG_total_tpy == m.GHG_ind_tpy + m.GHG_dir_total + m.GHG_aq - m.GHG_disp - m.GHG_digestate)

print("Greenhouse gas accounting equations created.")



# CELL 43 — MARINE EUTROPHICATION ACCOUNTING

@model_step
def cell_43_EP(m):
    s, Fd = m.P["sc"], m.Fd
    Nf = Fd["N_frac"]
    # Nitrogen in landfill feed and SHR rejects, kg N/h
    N_landfill_in = Nf * sum(m.M["28", k] for k in ORG5)
    N_SHR_reject = Nf * sum(m.M["5", k] for k in ORG5)
    # Direct nitrogen discharge and leaching, kg N/h
    N_to_water = m.N_HTL_discharge + m.N_eff_WWT + s["leach_frac_CMP"] * m.N_compost + s["leach_frac_AND"] * m.N_digestate + s["leach_frac_SLF"] * (N_landfill_in + N_SHR_reject)
    # Direct impacts, kg N-eq/h
    EP_direct = s["CF_N_water"] * N_to_water + s["CF_NOx_marine_EF"] * m.NOx_INC_kgph
    # Purchased utilities and materials, kg N-eq/h
    EP_background = s["EP_elec"] * sum(m.PW_op[t] for t in TECH) + s["EP_stm"] * sum(m.Mstm[t] for t in TECH) + s["EP_NG_sup"] * (m.NG_aux_INC + m.M_NG_HTL) + s["EP_enz"] * m.M["15", "ENZYME"] + s["EP_water"] * m.process_water_added
    # Solid-reject and ash disposal impacts, kg N-eq/h
    EP_disposal = s["EP_CHAR_disp"] * (m.HTL_solid_reject + m.m_ash_INC)
    # Product displacement credits, kg N-eq/h
    EP_product_credits = s["EP_CH4_disp"] * m.M["56", "CH4"] + s["EP_BIOCRUDE_disp"] * m.M["47", "BIOCRUDE"] + s["EP_ELEC_disp"] * m.Mprod["STB", "ELECTRICITY"]
    # Fertilizer displacement credits, kg N-eq/h
    EP_fertilizer_credits = s["EP_Nfert"] * (s["MFE_CMP"] * m.N_compost + s["MFE_WWT"] * m.N_biosolids + s["MFE_AND"] * m.N_digestate)
    # Net marine eutrophication, t N-eq/yr
    m.EP_marine_tpy_eq = Constraint(expr=m.EP_marine_tpy == (s["Tann"] / 1000.0) * (EP_direct + EP_background + EP_disposal - EP_product_credits - EP_fertilizer_credits))

print("Marine eutrophication accounting equation created.")



# ROUTING COMPATIBILITY CONSTRAINTS

@model_step
def cell_43b_routing(m):
    # ALL CONVERSIONS EXCEPT SLF AND INC REQUIRE SHR OR MCR
    m.eq_HTL_requires_mechanical = Constraint(expr=m.fConv["HTL"] <= m.y["SHR"] + m.y["MCR"])
    m.eq_AND_requires_mechanical = Constraint(expr=m.fConv["AND"] <= m.y["SHR"] + m.y["MCR"])
    m.eq_CMP_requires_mechanical = Constraint(expr=m.fConv["CMP"] <= m.y["SHR"] + m.y["MCR"])
    m.eq_WWT_requires_mechanical = Constraint(expr=m.fConv["WWT"] <= m.y["MCR"])
    # CMP — RETAIN THE AGREED RESTRICTIONS
    m.eq_CMP_no_MCR = Constraint(expr=m.fConv["CMP"] <= 1.0 - m.y["MCR"])
    m.eq_CMP_no_AER = Constraint(expr=m.fConv["CMP"] <= 1.0 - m.y["AER"])
    # SLF AND INC — DIRECT RAW-FEED BYPASS
    m.eq_SLF_raw_feed = Constraint(expr=m.fConv["SLF"] <= m.yBYP2)
    m.eq_INC_raw_feed = Constraint(expr=m.fConv["INC"] <= m.yBYP2)
    # Q2: existence binaries for stage II/III technologies
    if settings()["stage23_binaries"]:
        B = m.B
        m.Q2_route = Constraint(I_CONV, rule=lambda m, t: m.fConv[t] <= m.y[t])
        m.Q2_cap_max = Constraint(STAGE23, rule=lambda m, t: m.Qc[t] <= B["capacity_limits"][t] * m.y[t])
        m.Q2_cap_min = Constraint(STAGE23, rule=lambda m, t: m.Qc[t] >= MIN_CAPACITY[t] * m.y[t])

print("HTL, AND, CMP and WWT require SHR or MCR.")
print("CMP excludes MCR and AER, so its mechanical option is SHR.")
print("SLF and INC require direct raw-feed bypass.")
if settings()["stage23_binaries"]:
    print("Q2: stage II/III existence binaries linked to routing and capacity.")



# CELL 44 — ALL VARIABLE BOUNDS AND STARTING GUESSES

@model_step
def cell_44_bounds(m):
    s, Fd, B, Wsp = m.P["sc"], m.Fd, m.B, m.P["Wsp"]
    # STREAM FLOWS
    for j in STREAMS:
        for k in COMP:
            if not m.M[j, k].fixed:
                m.M[j, k].setub(M_BIG_BOUND)
    m.eta_AND_eff.setlb(s["eta_AND"])
    m.eta_AND_eff.setub(B["and_eta_max"])
    cap = B["capacity_limits"]
    for t in TECH:
        m.Qc_s[t].setub(cap[t])
        m.Qc[t].setub(cap[t])
        m.PurchaseCost[t].setub(B["PurchaseCost_up"][t])
        m.Nlabr_new[t].setub(B["Nlabr_up"][t])
    # Power bounds
    pw = {"SHR": Wsp["SHR"] * B["feed_max"], "MCR": Wsp["MCR"] * B["feed_max"],
          "AER": Wsp["AER"] * B["aer_capacity_max"] + B["aer_oxygen_max"] / s["AE_O2"],
          "ENZ": Wsp["ENZ"] * B["enz_capacity_max"],
          "HTL": Wsp["HTL"] * (17.0 / 60.0) * (1006.0 / s["rho_w"]) * (B["dry_max"] / s["rho_s"] + B["htl_water_max"] / s["rho_w"]),
          "AND": Wsp["AND"] * B["and_capacity_max"], "SLF": Wsp["SLF"] * B["slf_capacity_max"],
          "CMP": Wsp["CMP"] * B["cmp_capacity_max"], "WWT": s["e_COD_WWT"] * Fd["Y_O2_AER"] * B["dry_max"],
          "INC": Wsp["INC"] * B["wet_inlet_max"], "CEN": Wsp["CEN"] * B["recovery_capacity_max"],
          "FLT": Wsp["FLT"] * B["recovery_capacity_max"], "ABS": s["e_el_ABS"] * B["upgrading_capacity_max"],
          "PSA": s["e_el_PSA"] * B["upgrading_capacity_max"], "STB": Wsp["STB"] * B["stb_capacity_max"]}
    for t, ub in pw.items():
        m.PW_op[t].setub(ub)
    # Specific stream bounds
    m.M["7", "WATER"].setub(B["mcr_water_max"])
    m.M["15", "ENZYME"].setub(B["enzyme_max"])
    m.M["21", "WATER"].setub(B["htl_water_max"])
    m.M["24", "WATER"].setub(B["and_water_max"])
    m.M["50", "WATER"].setub(s["w_ABS"] * B["upgrading_capacity_max"])
    m.M["59", "WATER"].setub(min(M_BIG_BOUND, B["stb_steam_max"]))
    m.M["60", "WATER"].setub(min(M_BIG_BOUND, B["stb_steam_max"]))
    m.M["57", "ELECTRICITY"].setub(B["stb_capacity_max"])
    # Utilities
    m.Mstm["ENZ"].setub(s["Cp_eff"] * max(s["T_ENZ"] - s["T_amb"], 0.0) * B["wet_inlet_max"] / s["dh_steam"])
    m.Mstm["AND"].setub(s["Cp_eff"] * max(s["T_AND"] - s["T_amb"], 0.0) * (B["dry_max"] + B["and_water_max"]) / s["dh_steam"])
    m.Mcw["STB"].setub(B["stb_cooling_max"])
    for t in TECH:
        for kp in KP:
            if not m.Mprod[t, kp].fixed:
                m.Mprod[t, kp].setub(B["stb_capacity_max"] if kp == "ELECTRICITY" else B["dry_max"] + B["combined_gas_max"])
    # Unit-model variables
    ub = {"VS_AER_deg": B["aer_degraded_max"], "O2_AER": B["aer_oxygen_max"], "V_w_AER": B["aer_work_max"],
          "V_vessel_AER": B["aer_capacity_max"], "ENZ_DS_in": B["dry_feed_max"], "V_w_ENZ": B["enz_work_max"],
          "V_ENZ": B["enz_capacity_max"], "M_daf_HTL": B["dry_max"], "Mslurry22": B["dry_max"] + B["htl_water_max"],
          "m_HTL": B["dry_max"] + B["htl_water_max"], "V_w_HTL": B["htl_work_max"], "V_HTL": B["htl_capacity_max"],
          "H_net_HTL": B["htl_heat_max"], "H_gas_HTL": B["H_gas_HTL_up"], "M_NG_HTL": B["M_NG_HTL_up"],
          "N_aq_HTL": B["dry_max"], "N_HTL_bio": B["dry_max"], "N_HTL_char": B["dry_max"], "N_HTL_removed": B["dry_max"],
          "N_HTL_discharge": B["dry_max"], "N_HTL_N2O": B["dry_max"],
          "VSANDin": B["dry_max"], "VSdestroyed": B["dry_max"], "CH4gen": Fd["CH4_yield_AND"] * B["dry_max"],
          "CO2gen": Fd["CO2_yield_AND"] * B["dry_max"], "NH3gen": Fd["NH3_yield_AND"] * B["dry_max"],
          "H2Sgen": Fd["H2S_yield_AND"] * B["dry_max"], "H2Oconsumed": Fd["H2O_yield_AND"] * B["dry_max"],
          "V_w_AND": B["and_work_max"], "V_vessel_AND": B["and_capacity_max"],
          "CH4_mass_SLF": B["slf_ch4_max"], "CO2_mass_SLF": B["slf_co2_max"], "CH4_volume_SLF": B["slf_ch4_max"] / s["density_CH4"],
          "CH4_ox_SLF": B["slf_ch4_max"], "m_wasteleft_SLF": B["wet_inlet_max"] + 64.0 * B["slf_ch4_max"] / s["MW_CH4"],
          "vol_FW_SLF": B["slf_volume_max"],
          "VSCMP_in": B["dry_max"], "VSCMP_deg": B["cmp_degraded_max"], "O2req_CMP": B["cmp_oxygen_max"],
          "AirCMP": s["EAR_CMP"] * B["cmp_oxygen_max"] / s["yO2_air"], "V_work_CMP": B["cmp_work_max"], "V_vessel_CMP": B["cmp_capacity_max"],
          "Qww_m3ph": B["wet_inlet_max"] / s["rho_ww"], "mVS_in": B["dry_max"], "mVS_deg_WWT": B["wwt_degraded_max"],
          "Px": B["dry_max"], "N_eff_WWT": B["dry_max"], "m_wasteleft_WWT": B["wet_inlet_max"] + Fd["Y_O2_AER"] * B["dry_max"],
          "mdry_inc": B["dry_max"], "mdaf_inc": B["dry_max"], "m_ash_INC": B["dry_max"], "NG_aux_INC": B["inc_ng_max"],
          "nC_inc": B["inc_nC_max"], "nH_inc": B["inc_nH_max"], "nO_inc": B["inc_nO_max"], "nN_inc": B["inc_nN_max"],
          "nS_inc": B["inc_nS_max"], "nNG_inc": B["inc_nNG_max"], "nO2_sto": B["inc_o2_sto_max"], "nO2_in": B["inc_o2_in_max"],
          "nN2_air": B["inc_n2_air_max"], "nCO2_inc": B["inc_nC_max"] + B["inc_nNG_max"],
          "nH2O_inc": 0.5 * B["inc_nH_max"] + 2.0 * B["inc_nNG_max"], "nSO2_inc": B["inc_nS_max"],
          "nO2_out": B["inc_o2_in_max"], "nN2_out": B["inc_n2_air_max"] + 0.5 * B["inc_nN_max"],
          "mflue_inc": B["inc_flue_max"], "CO2_fossil_INC": s["EF_NG_fossil"] * B["inc_ng_max"],
          "NOx_INC_kgph": s["EF_NOx_INC_wet"] * B["wet_inlet_max"], "P_turbine": B["stb_turbine_max"]}
    for name, val in ub.items():
        getattr(m, name).setub(val)
    m.INC_net_heat.setlb(B["INC_net_heat_lo"])
    m.INC_net_heat.setub(B["INC_net_heat_up"])
    # STB CAN OPERATE ONLY WHEN INC RECEIVES FEED
    m.eq_STB_requires_INC = Constraint(expr=m.Qc_s["STB"] <= B["stb_capacity_max"] * m.fConv["INC"])

print(f"Actual wet feed rate: {m.B['feed_max']:,.2f} kg/h")
print(f"Raw-feed dry solids: {m.B['dry_feed_max']:,.2f} kg/h")
print(f"Shared component-flow upper bound: {M_BIG_BOUND:,.0f} kg/h")
print("Technology bounds and starting guesses applied.")



# CELL 45 — MODEL DEFINITION

@model_step
def cell_45_model_definition(m):
    m.obj_NAC = Objective(expr=m.NAC, sense=minimize)
    m.obj_GHG = Objective(expr=m.GHG_total_tpy, sense=minimize)
    m.obj_EP = Objective(expr=m.EP_marine_tpy, sense=minimize)
    m.obj_GHG.deactivate()
    m.obj_EP.deactivate()

def model_size(mdl):
    vars_ = [v for v in mdl.component_data_objects(Var) if not v.fixed]
    cons = list(mdl.component_data_objects(Constraint, active=True))
    return {"Constraints": len(cons), "Variables": len(vars_),
            "Binary variables": sum(1 for v in vars_ if v.is_binary()),
            "Continuous variables": sum(1 for v in vars_ if not v.is_binary())}

print(f"Number of build steps: {len(BUILD_STEPS)}")
for k_, v_ in model_size(m).items():
    print(f"{k_}: {v_}")
print("Model created successfully (MILP).")
print("Objective: minimize net annual cost, M$/yr.")


# CELL 46 — SOLVE THE COST-MINIMIZATION MODEL

LAST_SOLVE = {}

def pval(x):
    v = pyo.value(x, exception=False)
    return 0.0 if v is None or abs(v) < 1e-12 else float(v)   # clears solver round-off such as -1e-14

def set_objective(mdl, which):
    for name in ["obj_NAC", "obj_GHG", "obj_EP", "obj_AUG"]:
        if hasattr(mdl, name):
            getattr(mdl, name).deactivate()
    getattr(mdl, {"NAC": "obj_NAC", "GHG": "obj_GHG", "EP": "obj_EP", "AUG": "obj_AUG"}[which]).activate()

def solve(mdl, tee=False):
    """Solve with HiGHS. Returns 'optimal', 'infeasible', or another termination string."""
    opt = pyo.SolverFactory(SOLVER_NAME)
    opt.options["mip_rel_gap"] = MIP_REL_GAP
    opt.options["time_limit"] = TIME_LIMIT
    t0 = time.time()
    res = opt.solve(mdl, tee=tee, load_solutions=False)
    tc = str(res.solver.termination_condition)
    LAST_SOLVE.update({"termination": tc, "wall_time_s": time.time() - t0,
                       "lower_bound": getattr(res.problem, "lower_bound", None),
                       "upper_bound": getattr(res.problem, "upper_bound", None)})
    if tc == "optimal":
        mdl.solutions.load_from(res)
    return tc

def exact_capital(mdl):
    """Exact (notebook) purchase cost at the MILP capacities."""
    s = mdl.P["sc"]
    return {t: mdl.P["C0"][t] * capital_curve(max(pval(mdl.Qc[t]), 0.0) / mdl.P["Q0"][t], s["CAP_SMOOTH"], s["nc"]) for t in TECH}

def recovery_split(mdl):
    M22 = sum(pval(mdl.M["22", k]) for k in COMP)
    f = min(1.0, max(0.0, sum(pval(mdl.M["41", k]) for k in COMP) / M22)) if M22 > 1e-9 else 0.0
    return {"CEN": f, "FLT": 1.0 - f if M22 > 1e-9 else 0.0}

def upgrading_split(mdl):
    M48 = pval(mdl.M["48", "CH4"])
    f = min(1.0, max(0.0, pval(mdl.M["49", "CH4"]) / M48)) if M48 > 1e-9 else 0.0
    return {"ABS": f, "PSA": 1.0 - f if M48 > 1e-9 else 0.0}

def report(mdl):
    sel = [t for t in ["SHR", "MCR", "AER", "ENZ"] if pval(mdl.y[t]) > 0.5]
    byp = [b for b, var in [("BYP1", mdl.yBYP1), ("BYP2", mdl.yBYP2), ("BYP3", mdl.yBYP3)] if pval(var) > 0.5]
    mech = next((t for t in ["SHR", "MCR"] if t in sel), "BYP1" if "BYP1" in byp else ("BYP2" if "BYP2" in byp else ""))
    bio = next((t for t in ["AER", "ENZ"] if t in sel), "Bypass" if "BYP3" in byp else ("-" if "BYP2" in byp else ""))
    fconv = {t: pval(mdl.fConv[t]) for t in I_CONV}
    pc_pwl = {t: pval(mdl.PurchaseCost[t]) for t in TECH}
    pc_ex = exact_capital(mdl)
    nac = pval(mdl.NAC)
    rec, upg = recovery_split(mdl), upgrading_split(mdl)
    active = [t for t in TECH if pval(mdl.Qc[t]) > 1e-6]
    return {"NAC_MILP": nac, "NAC_exact_cost": nac + mdl.capital_factor * sum(pc_ex[t] - pc_pwl[t] for t in TECH),
            "GHG": pval(mdl.GHG_total_tpy), "EP": pval(mdl.EP_marine_tpy), "Mechanical": mech, "Biological": bio,
            "Conversion": " / ".join(f"{t} {100 * min(1.0, f):.2f}%" for t, f in fconv.items() if f > 1e-4),
            "HTL_recovery": " / ".join(f"{t} {100 * f:.2f}%" for t, f in rec.items()) if sum(rec.values()) > 0 else "Inactive",
            "Biogas_upgrading": " / ".join(f"{t} {100 * f:.2f}%" for t, f in upg.items()) if sum(upg.values()) > 0 else "Inactive",
            "fConv": fconv, "route": max(fconv, key=fconv.get),
            "config": "+".join(sorted(active + byp)),
            "capacities": {t: pval(mdl.Qc[t]) for t in active},
            "purchase_cost_exact": {t: pc_ex[t] for t in active}}

def solve_refined(mdl, objective="NAC", tol=1e-7, max_iter=25):
    """Solve, then add PWL breakpoints at the chosen capacities until the PWL is exact there (L6).
    The first MILP optimum is a lower bound on the MINLP optimum; re-pricing its design with the exact
    curve gives an upper bound. When they agree (gap <= tol, M$/yr) the MINLP optimum is certified."""
    set_capital_pwl(mdl, {})
    history = []
    for it in range(1, max_iter + 1):
        set_objective(mdl, objective)
        tc = solve(mdl)
        if tc != "optimal":
            return tc, None, history
        r = report(mdl)
        gap = r["NAC_exact_cost"] - r["NAC_MILP"]
        history.append({"Iteration": it, "MILP_NAC_lower_bound": r["NAC_MILP"], "Exact_NAC_of_design": r["NAC_exact_cost"], "Gap": gap})
        if gap <= tol:
            return tc, r, history
        extra = {t: list(mdl.extra_bp.get(t, [])) for t in TECH}
        for t, q in r["capacities"].items():
            extra[t].append(q)
        set_capital_pwl(mdl, extra)
    return "refinement_not_converged", r, history



# BREAKEVEN: r_rate_ENZ AND r_rate_AER (same bisection as the original)

def apply_overrides(P_, overrides):
    """Copy of P with scalar or 'Price_prod:<product>' overrides; 'A+B' changes both."""
    Q = copy.deepcopy(P_)
    for key, v in overrides.items():
        for k in key.split("+"):
            if k.startswith("Price_prod:"):
                Q["Price_prod"][k.split(":")[1]] = v
            else:
                Q["sc"][k] = v
    return Q



# CELL 49A: LEXICOGRAPHIC PAYOFF TABLE (AUGMECON, Mavrotas 2009)

objective_names = ["NAC", "GHG", "EP"]
lex_tolerance = settings()["lex_tolerance"]   # Q4 (original notebook: 0.01)

# CAP PARAMETERS AND CAP EQUATIONS (one per objective)
@model_step
def cell_49A_lex_caps(m):
    m.lex_cap = Param(["NAC", "GHG", "EP"], initialize=1e12, mutable=True)
    m.eq_lex_cap_NAC = Constraint(expr=m.NAC <= m.lex_cap["NAC"])
    m.eq_lex_cap_GHG = Constraint(expr=m.GHG_total_tpy <= m.lex_cap["GHG"])
    m.eq_lex_cap_EP = Constraint(expr=m.EP_marine_tpy <= m.lex_cap["EP"])

def lex_cap_value(v):
    return v + lex_tolerance * max(1e-3, abs(v))

def release_caps(mdl):
    for name in objective_names:
        mdl.lex_cap[name] = 1e12

def objective_value(r, name):
    return {"NAC": r["NAC_exact_cost"], "GHG": r["GHG"], "EP": r["EP"]}[name]

def save_solution(mdl):
    return {"Streams": pd.DataFrame([(j, k, pval(mdl.M[j, k])) for j in STREAMS for k in COMP], columns=["j", "k", "level"]),
            "Selections": pd.DataFrame([(t, pval(mdl.y[t])) for t in TECH], columns=["i", "level"]),
            "Conversion": pd.DataFrame([(t, pval(mdl.fConv[t])) for t in I_CONV], columns=["iConv", "level"]),
            "Recovery": pd.DataFrame(list(recovery_split(mdl).items()), columns=["iRec", "level"]),
            "Upgrading": pd.DataFrame(list(upgrading_split(mdl).items()), columns=["iUpg", "level"]),
            "BYP1": pval(mdl.yBYP1), "BYP2": pval(mdl.yBYP2), "BYP3": pval(mdl.yBYP3)}



# CELL 50A: AUGMENTED EPSILON-CONSTRAINT MODEL (AUGMECON)

@model_step
def cell_50A_augmecon(m):
    # LIMITS, RANGES AND AUGMENTATION WEIGHT
    m.epsilon_GHG = Param(initialize=0.0, mutable=True)
    m.epsilon_EP = Param(initialize=0.0, mutable=True)
    m.range_GHG = Param(initialize=1.0, mutable=True)
    m.range_EP = Param(initialize=1.0, mutable=True)
    # Mavrotas (2009) uses a small weight between 1e-3 and 1e-6
    m.aug_delta = Param(initialize=1e-3, mutable=True)
    # SLACK VARIABLES AND AUGMENTED OBJECTIVE
    m.s_GHG = Var(domain=NonNegativeReals)
    m.s_EP = Var(domain=NonNegativeReals)
    m.eq_aug_GHG = Constraint(expr=m.GHG_total_tpy + m.s_GHG == m.epsilon_GHG)
    m.eq_aug_EP = Constraint(expr=m.EP_marine_tpy + m.s_EP == m.epsilon_EP)
    m.eq_aug_GHG.deactivate()
    m.eq_aug_EP.deactivate()
    m.obj_AUG = Objective(expr=m.NAC - m.aug_delta * (m.s_GHG / m.range_GHG + m.s_EP / m.range_EP), sense=minimize)
    m.obj_AUG.deactivate()

