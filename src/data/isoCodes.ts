// apps/backend/src/data/isoCodes.ts
//
// ISO 4217 currencies in circulation and ISO 3166-1 alpha-2 countries: the
// closed lists the Travel Policy module accepts (decision 3, 2026-11-25).
// Fund, metal and test codes (XAU, XDR, XXX …) are left out on purpose:
// nobody sets a travel limit in them.
//
// utils/countryCodes.ts is NOT this list: it carries only the countries the
// Visa module serves. Names come from Intl, so they cannot drift from the codes.

const CURRENCY_CODES =
  "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK " +
  "DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF " +
  "KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK " +
  "PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX " +
  "USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG";

const COUNTRY_CODES_ISO2 =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM " +
  "CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF " +
  "MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE " +
  "RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ " +
  "VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

const names = (type: "currency" | "region") => {
  try {
    const d = new Intl.DisplayNames(["en"], { type });
    return (code: string) => d.of(code) || code;
  } catch {
    return (code: string) => code;
  }
};

const currencyName = names("currency");
const regionName = names("region");

export interface IsoCode {
  code: string;
  name: string;
}

export const ISO_CURRENCIES: readonly IsoCode[] = CURRENCY_CODES.split(" ").map((code) => ({ code, name: currencyName(code) }));
export const ISO_COUNTRIES: readonly IsoCode[] = COUNTRY_CODES_ISO2.split(" ")
  .map((code) => ({ code, name: regionName(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const CURRENCY_SET = new Set(ISO_CURRENCIES.map((c) => c.code));
const COUNTRY_MAP = new Map(ISO_COUNTRIES.map((c) => [c.code, c.name]));

export const isIsoCurrency = (code: unknown): boolean => CURRENCY_SET.has(String(code ?? ""));
export const isIsoCountry = (code: unknown): boolean => COUNTRY_MAP.has(String(code ?? ""));
export const countryName = (code: unknown): string => COUNTRY_MAP.get(String(code ?? "")) ?? String(code ?? "");
