/*
  ECO-FAST job form settings.

  The default VALUES are not typed here. They are read from scenario_defaults.json,
  which you export straight from the notebook (see lab/export_defaults_cell.py).
  Every key in that file becomes a field on the form, so the form always matches the model.

  This file only controls how fields look and whether users may change them.
  Keys must match the notebook dict keys. Nested dicts are flattened with a dot,
  e.g. {"CHNOS": {"C": ...}} becomes "CHNOS.C".
*/
window.ECOFAST_FORM = {
  // Order of the scenario buttons (must match the top-level keys in scenario_defaults.json)
  scenarios: ["Household", "Restaurant", "Institutional", "Retail", "Market"],

  // Groups shown on the form. Any key not listed here goes into "Other parameters".
  groups: [
    { title: "Proximate analysis", keys: ["Moisture", "VM", "Ash", "FC"] },
    { title: "Biochemical composition", keys: ["CBH", "PRT", "Lipid"] },
    { title: "Elemental composition", keys: ["CHNOS.C", "CHNOS.H", "CHNOS.N", "CHNOS.O", "CHNOS.S", "C", "H", "N", "O", "S"] },
    { title: "Energy content", keys: ["HHV"] },
  ],

  // Labels and units. Units are left blank on purpose: fill them in to match the notebook.
  // Optional per key: min, max (validation), editable: false (shown but locked).
  fields: {
    "Moisture": { label: "Moisture", unit: "" },
    "VM":       { label: "Volatile matter", unit: "" },
    "Ash":      { label: "Ash", unit: "" },
    "FC":       { label: "Fixed carbon", unit: "" },
    "CBH":      { label: "Carbohydrates", unit: "" },
    "PRT":      { label: "Protein", unit: "" },
    "Lipid":    { label: "Lipids", unit: "" },
    "CHNOS.C":  { label: "Carbon (C)", unit: "" },
    "CHNOS.H":  { label: "Hydrogen (H)", unit: "" },
    "CHNOS.N":  { label: "Nitrogen (N)", unit: "" },
    "CHNOS.O":  { label: "Oxygen (O)", unit: "" },
    "CHNOS.S":  { label: "Sulfur (S)", unit: "" },
    "HHV":      { label: "Higher heating value", unit: "" },
  },

  // Extra inputs that are NOT in the scenario dicts (e.g. how much waste the user has).
  // Each needs a default you choose; leave default as null to make the user type it.
  // Example (uncomment and edit):
  // extra: [ { key: "feed_rate", label: "Food waste quantity", unit: "t/day", default: null, min: 0 } ],
  extra: [],
};
