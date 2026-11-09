// apps/backend/src/utils/plutoNonAirports.ts
//
// Codes in data/airports.json that are NOT airports. The catalog has no type
// field, so this list is the only thing that tells a bus station from a runway.
// It matters because the catalog files these codes under real cities' city
// codes: XNB "Dubai Bus Station" shares cityCode DXB with Dubai's airports, so a
// BLR → AUH flight + Etihad coach to XNB passed as a "Dubai" arrival and won
// "Best" on prod (2026-11-10, Pluto Hotfix A follow-up).
//
// Built by scanning all 4,919 catalog records (2026-11-10):
//   - names with surface-transport words (bus, coach, rail, station, Hbf,
//     gare, ferry, heliport, …): 106 hits, 76 of them non-airports below;
//     the other 30 are real airports whose names merely contain the word
//     (PHX "Sky Harbor Int'l", PBI "Palm Beach Intl", seaplane harbours…) and
//     are listed in KNOWN_AIRPORTS_WITH_SURFACE_WORDS so the guard test passes.
//   - records with NO name: 61 — 34 rail stations and 8 unverified codes below; the other 19 are real airports (LHW, SAG, UKB, …).
//     A nameless code in a city whose airport has a different, known code
//     (FIR in Florence = FLR, LJR in Ljubljana = LJU, …) is treated as
//     non-airport ("other"): wrongly excluding one only moves a row to the
//     "Other nearby airports" group with a label; wrongly including a station
//     puts a coach ride in "Best".
// plutoNonAirports.test.ts re-scans the catalog so a newly added
// bus/rail/ferry code can't slip in unclassified.

export type NonAirportKind = "coach" | "train" | "ferry" | "helicopter" | "ground transfer";

export const NON_AIRPORTS: Record<string, NonAirportKind> = {
  // ── bus / coach stations (13) ──
  XNB: "coach", // Dubai Bus Station [DXB]
  ZVJ: "coach", // Abu Dhabi Bus Station [AUH]
  ZVH: "coach", // Al Ain Bus Station
  DMS: "coach", // Dammam Sabto bus station [DMM]
  GBX: "coach", // Granada Bus Station
  NGY: "coach", // Nagoya Bus Station [NGO]
  ZGB: "coach", // Nottingham Bus Station [NQT]
  VTI: "coach", // Vitoria Bus Station
  XER: "coach", // Strasbourg Bus Station
  XJN: "coach", // Valladolid Bus Station
  ZBC: "coach", // Birmingham Colmore Row Bus Stn
  ZGC: "coach", // Zagreb Bus Station
  ZLZ: "coach", // Leeds Bus Station

  // ── rail stations, named in the catalog (56) ──
  QPP: "train", DHC: "train", ZYR: "train", CFW: "train", EXS: "train",
  ZRB: "train", GEP: "train", GPP: "train", GGZ: "train", IMR: "train",
  INP: "train", IOB: "train", IRR: "train", KJR: "train", KLT: "train",
  KGV: "train", LZS: "train", QQK: "train", QDL: "train", LXC: "train",
  XTI: "train", XIK: "train", XUT: "train", QJZ: "train", XJV: "train",
  OVI: "train", OXQ: "train", XPG: "train", QRH: "train", QYG: "train",
  XRJ: "train", LTZ: "train", YJV: "train", XIT: "train", XIX: "train",
  XOC: "train", XPJ: "train", XQA: "train", YJW: "train", XVQ: "train",
  XVY: "train", XWG: "train", XZN: "train", XZV: "train", XEG: "train",
  YJB: "train", XLJ: "train", XEC: "train", YBZ: "train", ZAQ: "train",
  ZGG: "train", ZMS: "train", ZVR: "train", ZXE: "train", ZYA: "train",
  ZYN: "train",

  // ── ferry terminals (5) ──
  PFT: "ferry", // Pazhou Ferry Terminal [CAN]
  YFT: "ferry", // Taipa Ferry Terminal [MFM]
  NSZ: "ferry", // Nansha Ferry Port
  FYG: "ferry", // Fuyong Ferry Port [SZX]
  ZGN: "ferry", // Zhongshan Ferry Port

  // ── heliport (1) ──
  BHC: "helicopter", // Bhurban Heliport

  // ── other off-airport points (1) ──
  ZXZ: "ground transfer", // Jumeirah Beach [DXB]

  // ── nameless rail codes (34): city rail stations with no catalog name ──
  DTZ: "train", IBT: "train", QDU: "train", QEW: "train", QFB: "train",
  QKL: "train", QLJ: "train", QPA: "train", QQM: "train", QQU: "train",
  QQX: "train", QQY: "train", QUL: "train", QYX: "train", XDB: "train",
  XDS: "train", XHK: "train", XRF: "train", XWC: "train", XYD: "train",
  XYG: "train", YMY: "train", ZDH: "train", ZDJ: "train", ZFJ: "train",
  ZFQ: "train", ZFV: "train", ZHT: "train", ZMB: "train", ZSB: "train",
  ZWE: "train", ZWS: "train", ZYT: "train", YJE: "train",

  // ── nameless, unverified, in a city whose airport is a different code (8) ──
  XHB: "ground transfer", // Dubai (airports DXB/DWC)
  XXQ: "ground transfer", // Budapest (BUD)
  ZDN: "ground transfer", // Brno (BRQ)
  FIR: "ground transfer", // Florence (FLR)
  LJR: "ground transfer", // Ljubljana (LJU)
  HZD: "ground transfer", // Hangzhou (HGH)
  TXB: "ground transfer", // Trieste (TRS)
  BQC: "ground transfer", // Quebec (YQB)
};

/**
 * Catalog records whose NAME contains a surface-transport word but which ARE
 * airports (or seaplane bases with scheduled air service). Exists only so the
 * guard test can tell "reviewed, it's an airport" from "never looked at".
 */
export const KNOWN_AIRPORTS_WITH_SURFACE_WORDS: string[] = [
  "BEK", "BHB", "CFS", "DAB", "EBA", "FRD", "GHB", "GHC", "LGB", "MHH",
  "NOB", "ODW", "PBI", "PHR", "PHX", "PIZ", "PPM", "RCE", "CEF", "VPS",
  "VRB", "WRW", "YFX", "YLC", "YMH", "YSY", "YUX", "CXH", "YWH", "YZS",
];

export function nonAirportKind(code: string): NonAirportKind | null {
  return NON_AIRPORTS[String(code || "").trim().toUpperCase()] ?? null;
}

export function isAirportCode(code: string): boolean {
  return nonAirportKind(code) === null;
}
