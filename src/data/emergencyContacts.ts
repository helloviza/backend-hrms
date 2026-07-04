// apps/backend/src/data/emergencyContacts.ts
//
// Phase 4 (Arrive) — STATIC emergency numbers for the arrival concierge. No
// network, no LLM: a hard-coded per-country map keyed by the destination IATA
// code (covering the concierge's IATA_MAP cities), with a generic 112 fallback
// for anything unmapped. Numbers are widely published national emergency lines.

// IATA airport code → ISO-3166 alpha-2 country, for the concierge's known cities.
export const IATA_TO_COUNTRY: Record<string, string> = {
  // India
  DEL: "IN", BOM: "IN", BLR: "IN", MAA: "IN", HYD: "IN", CCU: "IN", PNQ: "IN",
  AMD: "IN", GOI: "IN", COK: "IN", JAI: "IN", LKO: "IN", ATQ: "IN", VNS: "IN",
  SXR: "IN", IXC: "IN", IDR: "IN", BHO: "IN",
  // Japan
  NRT: "JP", KIX: "JP", NGO: "JP", CTS: "JP", FUK: "JP", OKA: "JP", HIJ: "JP",
  // SE / South Asia
  SIN: "SG", BKK: "TH", HKT: "TH", DPS: "ID", CGK: "ID", KUL: "MY",
  SGN: "VN", HAN: "VN", MNL: "PH", CMB: "LK", KTM: "NP", DAC: "BD",
  // Middle East
  DXB: "AE", AUH: "AE", DOH: "QA", MCT: "OM", RUH: "SA", JED: "SA", KWI: "KW",
  // Europe
  LHR: "GB", CDG: "FR", AMS: "NL", FRA: "DE", FCO: "IT", MXP: "IT", MAD: "ES",
  BCN: "ES", ZRH: "CH", VIE: "AT", IST: "TR", ATH: "GR",
  // Americas / Oceania
  JFK: "US", LAX: "US", ORD: "US", YYZ: "CA", YVR: "CA", SYD: "AU", MEL: "AU", AKL: "NZ",
};

export interface EmergencyNumbers {
  country: string; // ISO-2
  police: string;
  ambulance: string;
}

// country ISO-2 → national police / ambulance numbers.
export const EMERGENCY_BY_COUNTRY: Record<string, EmergencyNumbers> = {
  IN: { country: "IN", police: "100", ambulance: "108" },
  JP: { country: "JP", police: "110", ambulance: "119" },
  SG: { country: "SG", police: "999", ambulance: "995" },
  TH: { country: "TH", police: "191", ambulance: "1669" },
  ID: { country: "ID", police: "110", ambulance: "118" },
  MY: { country: "MY", police: "999", ambulance: "999" },
  VN: { country: "VN", police: "113", ambulance: "115" },
  PH: { country: "PH", police: "911", ambulance: "911" },
  LK: { country: "LK", police: "119", ambulance: "1990" },
  NP: { country: "NP", police: "100", ambulance: "102" },
  BD: { country: "BD", police: "999", ambulance: "999" },
  AE: { country: "AE", police: "999", ambulance: "998" },
  QA: { country: "QA", police: "999", ambulance: "999" },
  OM: { country: "OM", police: "9999", ambulance: "9999" },
  SA: { country: "SA", police: "999", ambulance: "997" },
  KW: { country: "KW", police: "112", ambulance: "112" },
  GB: { country: "GB", police: "999", ambulance: "999" },
  FR: { country: "FR", police: "17", ambulance: "15" },
  NL: { country: "NL", police: "112", ambulance: "112" },
  DE: { country: "DE", police: "110", ambulance: "112" },
  IT: { country: "IT", police: "112", ambulance: "118" },
  ES: { country: "ES", police: "112", ambulance: "112" },
  CH: { country: "CH", police: "117", ambulance: "144" },
  AT: { country: "AT", police: "133", ambulance: "144" },
  TR: { country: "TR", police: "112", ambulance: "112" },
  GR: { country: "GR", police: "100", ambulance: "166" },
  US: { country: "US", police: "911", ambulance: "911" },
  CA: { country: "CA", police: "911", ambulance: "911" },
  AU: { country: "AU", police: "000", ambulance: "000" },
  NZ: { country: "NZ", police: "111", ambulance: "111" },
};

// Generic fallback: 112 reaches emergency services from any mobile in most of
// the world (and is recognised alongside local numbers).
export const GENERIC_EMERGENCY: EmergencyNumbers = { country: "", police: "112", ambulance: "112" };

/** Resolve emergency numbers for a destination IATA code, or the generic 112 fallback. */
export function getEmergencyNumbers(destinationIata: string | null | undefined): EmergencyNumbers {
  const iata = String(destinationIata || "").trim().toUpperCase();
  const country = IATA_TO_COUNTRY[iata];
  if (country && EMERGENCY_BY_COUNTRY[country]) return EMERGENCY_BY_COUNTRY[country];
  return GENERIC_EMERGENCY;
}
