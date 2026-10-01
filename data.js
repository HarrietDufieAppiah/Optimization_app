/* Model data for the site. Values copied from the Streamlit app.py (which takes them from the notebook). */
window.ECOFAST_DATA = (function () {
  const CAT = { blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", yellow: "#eda100", magenta: "#e87ba4", green: "#008300" };
  const TECH_COLOR = { HTL: CAT.blue, AND: CAT.orange, SLF: CAT.aqua, CMP: CAT.yellow, WWT: CAT.magenta, INC: CAT.green };
  const TECH_NAMES = { HTL: "Hydrothermal liquefaction", AND: "Anaerobic digestion", SLF: "Landfill", CMP: "Composting", WWT: "Wastewater treatment", INC: "Incineration" };

  const FEED_COMPONENTS = [
    ["WATER", "Water", "#c9c3b4"], ["PRT", "Protein", CAT.blue], ["CBH", "Carbohydrates", CAT.orange],
    ["FAT", "Fat / Lipid", CAT.aqua], ["ASH", "Ash", CAT.yellow], ["OTH", "Other Organics", CAT.magenta], ["FC", "Fixed Carbon", CAT.green],
  ];

  const TECH_SUMMARIES = [
    ["HTL", "Heats wet waste under pressure without drying it, converting it into biocrude."],
    ["AND", "Microbes break waste down without oxygen in a sealed digester, producing biogas."],
    ["SLF", "Buries waste in an engineered landfill, where it decomposes and releases gas for capture."],
    ["CMP", "Breaks waste down aerobically over time, turning it into a stable soil product."],
    ["WWT", "Treats wet, dilute waste with activated sludge, converting organics into biosolids and treated effluent."],
    ["INC", "Combusts the waste at high temperature, recovering its energy as heat and power."],
  ];

  const TECH_DETAILS = {
    HTL: [["Reactor temperature", "340", "degC"], ["Residence time", "1.0", "h"], ["Dilution water ratio", "7.0", "kg water / kg dry solids"], ["Heat recovery efficiency", "70", "%"], ["HTL gas heating value", "4.2", "MJ/kg"]],
    AND: [["Residence time", "30", "days"], ["Temperature", "35 (mesophilic)", "degC"], ["Design solids content", "10", "% TS, wet"], ["VS destruction", "80", "%"], ["Biogas capture", "97", "%"]],
    SLF: [["Degradable organic carbon", "35.8", "% of waste"], ["Gas capture", "65", "%"], ["Landfill depth", "10", "m"]],
    CMP: [["Residence time", "5", "days"], ["VS degraded", "50", "%"], ["Excess air ratio", "2.5", "x stoichiometric"]],
    WWT: [["Solids retention time", "1.0", "days"], ["F/M loading", "4.0", "kg BOD / kg MLSS / day"], ["MLSS", "5.0", "g/L"]],
    INC: [["Excess air ratio", "1.2", "x stoichiometric"], ["Self-sustaining threshold", "3.5", "MJ/kg wet feed (LHV)"], ["Auxiliary fuel", "Natural gas", "48 MJ/kg, used below the threshold"]],
  };

  const TECH_COST_PARAMS = {
    SHR: { c0: 111000, q0: 10000, q0_unit: "kg/h throughput", wsp: 0.02, nlbr: 0.1, stage: "Mechanical pretreatment" },
    MCR: { c0: 111000, q0: 60000, q0_unit: "kg/h throughput", wsp: 0.10, nlbr: 0.1, stage: "Mechanical pretreatment" },
    AER: { c0: 882000, q0: 15000, q0_unit: "m3 vessel volume", wsp: 0.04, nlbr: 0.5, stage: "Biological pretreatment" },
    ENZ: { c0: 882000, q0: 15000, q0_unit: "m3 vessel volume", wsp: 0.04, nlbr: 0.5, stage: "Biological pretreatment" },
    HTL: { c0: 645000, q0: 40, q0_unit: "m3 reactor volume", wsp: 2.0, nlbr: 2.0, stage: "Conversion" },
    AND: { c0: 594000, q0: 1000, q0_unit: "m3 digester volume", wsp: 0.005, nlbr: 0.02, stage: "Conversion" },
    SLF: { c0: 450000, q0: 0.15, q0_unit: "acres of new land/yr", wsp: 0.5, nlbr: 1.0, stage: "Conversion" },
    CMP: { c0: 786000, q0: 350, q0_unit: "m3 vessel volume", wsp: 0.02, nlbr: 0.5, stage: "Conversion" },
    WWT: { c0: 8000000, q0: 15000, q0_unit: "m3 aeration tank volume", wsp: 0.04, nlbr: 0.5, stage: "Conversion" },
    INC: { c0: 4700000, q0: 8000, q0_unit: "kg/h throughput", wsp: 0.05, nlbr: 1.0, stage: "Conversion" },
    CEN: { c0: 66000, q0: 0.01, q0_unit: "m2, sigma factor", wsp: 0.1, nlbr: 1.0, stage: "Recovery & upgrading" },
    FLT: { c0: 39000, q0: 80, q0_unit: "m2 membrane area", wsp: 0.1, nlbr: 0.5, stage: "Recovery & upgrading" },
    ABS: { c0: 30000, q0: 32, q0_unit: "Nm3/h biogas", wsp: 0.1, nlbr: 0.01, stage: "Recovery & upgrading" },
    PSA: { c0: 80000, q0: 50, q0_unit: "Nm3/h biogas", wsp: 0.4, nlbr: 0.01, stage: "Recovery & upgrading" },
    STB: { c0: 45000, q0: 30000, q0_unit: "kW electric output", wsp: 0.02, nlbr: 0.05, stage: "Recovery & upgrading" },
  };

  const ALL_TECH_NAMES = Object.assign({ SHR: "Shredder", MCR: "Macerator", AER: "Aerobic digester", ENZ: "Enzymatic hydrolysis" }, TECH_NAMES,
    { CEN: "Centrifuge", FLT: "Membrane filtration", ABS: "Amine absorption", PSA: "Pressure swing adsorption", STB: "Steam turbine" });

  // [label, key, default, unit, note]
  const GLOBAL_COST_ASSUMPTIONS = [
    ["Six-tenths cost exponent", "nc", 0.67, "", "applied to capacity ratio, all technologies"],
    ["Bare-module cost multiplier", "bmc", 5.4, "x", "installed cost / purchase cost"],
    ["Capital recovery factor", "crf", 0.11, "/yr", "annualizes installed capital"],
    ["Working capital", "wc", 15.0, "% of FCI/yr", "annualized the same way as capital"],
    ["Insurance & property tax", "ins", 1.0, "% of FCI/yr", "FCI = fixed capital investment"],
    ["Facility overhead", "fac", 6.0, "% of FCI/yr", "maintenance, factory overhead, local taxes"],
    ["Operating hours", "tann", 7920.0, "h/yr", "= 330 days/yr, 24 h/day"],
    ["Labor rate", "clbr", 30.0, "$/h", "per operator"],
    ["Electricity", "celec", 0.10, "$/kWh", ""],
    ["Process steam", "cstm", 0.012, "$/kg", ""],
    ["Cooling water", "cpwt", 0.00005, "$/kg", ""],
    ["Process water", "cwater", 0.0053, "$/kg", "dilution water for MCR/HTL/AND/STB"],
    ["Natural gas", "cng", 0.25, "$/kg", "INC auxiliary firing, below the self-sustaining threshold"],
  ];
  const PRODUCT_PRICES = [
    ["Biomethane (CH4)", "ch4", 0.55, "$/kg", "AND biogas, upgraded"],
    ["Biocrude", "biocrude", 0.48, "$/kg", "HTL product"],
    ["Compost", "compost", 0.068, "$/kg", "CMP product"],
    ["Electricity", "elec_price", 0.10, "$/kWh", "from the INC waste-heat steam turbine"],
    ["Biosolids", "biosolids", 0.05, "$/kg", "WWT product"],
    ["Tipping fee received", "tip", 0.055, "$/kg feed", "revenue for accepting the waste at the gate"],
  ];
  const DISPOSAL_COSTS = [
    ["Shredder reject", "disp_reject", 0.055, "$/kg", ""],
    ["Aqueous phase (HTL/AND)", "disp_aq", 0.030, "$/kg", "high-strength organic wastewater, needs treatment"],
    ["Char / cake", "disp_char", 0.055, "$/kg", "HTL solids residue"],
    ["Landfill gate fee", "disp_land", 0.055, "$/kg", "charged on the feed entering SLF"],
    ["AD digestate", "disp_digestate", 0.005, "$/kg", "land-applied, not landfilled"],
  ];

  const RESULTS_SUBVIEWS = ["Lowest Cost Pathways", "Lowest Environmental Impact Pathways", "Best Cost & Environmental Impact Pathways"];

  return { CAT, TECH_COLOR, TECH_NAMES, FEED_COMPONENTS, TECH_SUMMARIES, TECH_DETAILS, TECH_COST_PARAMS, ALL_TECH_NAMES,
    GLOBAL_COST_ASSUMPTIONS, PRODUCT_PRICES, DISPOSAL_COSTS, RESULTS_SUBVIEWS,
    DEFAULT_FEED_RATE: 10000, DEFAULT_HOURS: 7920 };
})();