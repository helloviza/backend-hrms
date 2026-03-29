/**
 * Payroll statutory calculation engine — FY 2025-26
 * All rates provided by spec. Do NOT modify rates without regulatory guidance.
 */

/* ───────────────────────── CONSTANTS ───────────────────────── */

export const STATUTORY = {
  PF: {
    EMPLOYEE_RATE: 0.12,
    EMPLOYER_RATE: 0.12,
    EPS_RATE: 0.0833,
    EPF_EMPLOYER_RATE: 0.0367,
    EPS_WAGE_CAP: 15000,
    DEFAULT_CAP: 15000,
  },

  ESI: {
    EMPLOYEE_RATE: 0.0075,
    EMPLOYER_RATE: 0.0325,
    GROSS_LIMIT: 21000,
  },

  PROFESSIONAL_TAX: {
    Karnataka: [
      { upTo: 14999, tax: 0 },
      { upTo: 29999, tax: 200 },
      { upTo: Infinity, tax: 200 },
    ],
    Maharashtra: [
      { upTo: 7500, tax: 0 },
      { upTo: 10000, tax: 175 },
      { upTo: Infinity, tax: 200 },
    ],
    "West Bengal": [
      { upTo: 8500, tax: 0 },
      { upTo: 10000, tax: 90 },
      { upTo: 15000, tax: 110 },
      { upTo: 25000, tax: 130 },
      { upTo: 40000, tax: 150 },
      { upTo: Infinity, tax: 200 },
    ],
    "Andhra Pradesh": [
      { upTo: 15000, tax: 0 },
      { upTo: 20000, tax: 150 },
      { upTo: Infinity, tax: 200 },
    ],
    Telangana: [
      { upTo: 15000, tax: 0 },
      { upTo: 20000, tax: 150 },
      { upTo: Infinity, tax: 200 },
    ],
    Gujarat: [
      { upTo: 5999, tax: 0 },
      { upTo: 8999, tax: 80 },
      { upTo: 11999, tax: 150 },
      { upTo: Infinity, tax: 200 },
    ],
    "Tamil Nadu": [{ upTo: Infinity, tax: 0 }],
    Kerala: [
      { upTo: 11999, tax: 0 },
      { upTo: 17999, tax: 120 },
      { upTo: 29999, tax: 180 },
      { upTo: Infinity, tax: 208 },
    ],
    Delhi: [{ upTo: Infinity, tax: 0 }],
    DEFAULT: [
      { upTo: 14999, tax: 0 },
      { upTo: Infinity, tax: 200 },
    ],
  } as Record<string, Array<{ upTo: number; tax: number }>>,

  NEW_REGIME: {
    STANDARD_DEDUCTION: 75000,
    REBATE_87A_LIMIT: 700000,
    REBATE_87A_AMOUNT: 25000,
    SLABS: [
      { upTo: 300000, rate: 0 },
      { upTo: 700000, rate: 0.05 },
      { upTo: 1000000, rate: 0.10 },
      { upTo: 1200000, rate: 0.15 },
      { upTo: 1500000, rate: 0.20 },
      { upTo: Infinity, rate: 0.30 },
    ],
    SURCHARGE: [
      { upTo: 5000000, rate: 0 },
      { upTo: 10000000, rate: 0.10 },
      { upTo: 20000000, rate: 0.15 },
      { upTo: Infinity, rate: 0.25 },
    ],
    CESS_RATE: 0.04,
  },

  OLD_REGIME: {
    STANDARD_DEDUCTION: 50000,
    REBATE_87A_LIMIT: 500000,
    REBATE_87A_AMOUNT: 12500,
    SECTION_80C_LIMIT: 150000,
    SECTION_80D_LIMIT: 25000,
    SECTION_80CCD1B_LIMIT: 50000,
    HRA_EXEMPTION: true,
    SLABS: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.20 },
      { upTo: Infinity, rate: 0.30 },
    ],
    SURCHARGE: [
      { upTo: 5000000, rate: 0 },
      { upTo: 10000000, rate: 0.10 },
      { upTo: 20000000, rate: 0.15 },
      { upTo: 50000000, rate: 0.25 },
      { upTo: Infinity, rate: 0.37 },
    ],
    CESS_RATE: 0.04,
  },
} as const;

/* ───────────────────────── REIMBURSEMENT HEADS ───────────────────────── */

export const REIMBURSEMENT_HEADS = {

  // ─── SECTION 10(14)(ii) — Prescribed personal expense allowances ───
  // Fixed statutory caps. Tax-free in old regime, fully taxable in new regime.

  CONVEYANCE: {
    key: "conveyance",
    label: "Conveyance Allowance",
    section: "10(14)(ii)" as string,
    annualLimit: 19200 as number | null,
    taxFreeLimit: 19200 as number | null,
    newRegimeTaxFree: false,
    requiresBills: false,
    cappedByStatute: true,
    description: "Transport between home and office. Statutory cap \u20B91,600/month.",
  },

  CHILDREN_EDUCATION: {
    key: "childrenEducation",
    label: "Children Education Allowance",
    section: "10(14)(ii)" as string,
    annualLimit: 2400 as number | null,
    taxFreeLimit: 2400 as number | null,
    newRegimeTaxFree: false,
    requiresBills: false,
    cappedByStatute: true,
    description: "Education allowance for up to 2 children. \u20B9100/child/month.",
  },

  CHILDREN_HOSTEL: {
    key: "childrenHostel",
    label: "Children Hostel Allowance",
    section: "10(14)(ii)" as string,
    annualLimit: 3600 as number | null,
    taxFreeLimit: 3600 as number | null,
    newRegimeTaxFree: false,
    requiresBills: false,
    cappedByStatute: true,
    description: "Hostel allowance for up to 2 children. \u20B9300/child/month.",
  },

  // ─── SECTION 10(14)(i) — Performance of duty allowances ───
  // NO statutory cap — employer sets limit, employee submits bills.
  // Tax-free to the extent of bills submitted and approved.

  BOOKS_PERIODICALS: {
    key: "booksAndPeriodicals",
    label: "Books & Periodicals",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Books, journals, magazines for professional development. No statutory cap \u2014 bill-based.",
  },

  TELEPHONE: {
    key: "telephone",
    label: "Telephone & Internet",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Mobile and internet bills for official use. No statutory cap \u2014 bill-based.",
  },

  PROFESSIONAL_DEVELOPMENT: {
    key: "professionalDevelopment",
    label: "Professional Development",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Training, courses, conferences for professional growth. No statutory cap \u2014 bill-based.",
  },

  CAR_FUEL: {
    key: "carFuel",
    label: "Car Fuel & Maintenance",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Fuel and maintenance for car used for official duties. No statutory cap \u2014 bill-based.",
  },

  CAR_REPAIR: {
    key: "carRepair",
    label: "Car Repair & Insurance",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Car repair and insurance for vehicle used for official duties. No statutory cap.",
  },

  DRIVER_SALARY: {
    key: "driverSalary",
    label: "Driver Salary",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Salary paid to driver of employee-owned or company-provided vehicle used for official duties.",
  },

  MOBILE_HANDSET: {
    key: "mobileHandset",
    label: "Mobile Handset Reimbursement",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Purchase of mobile phone for official use. No statutory cap \u2014 bill-based. One-time or periodic.",
  },

  HEALTH_CLUB: {
    key: "healthClub",
    label: "Health Club & Gym",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Gym or health club membership for employee wellness. No statutory cap \u2014 bill-based.",
  },

  ENTERTAINMENT: {
    key: "entertainment",
    label: "Entertainment Reimbursement",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Client entertainment, business meals. No statutory cap \u2014 bill-based.",
  },

  // ─── OTHER SECTION 10 EXEMPTIONS ───

  LTA: {
    key: "lta",
    label: "Leave Travel Allowance",
    section: "10(5)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Domestic travel for employee and family. Tax-free for 2 journeys in 4-year block (current: 2022-2025). Economy class, shortest route.",
  },

  MEDICAL: {
    key: "medical",
    label: "Medical Reimbursement",
    section: "10(14)(i)" as string,
    annualLimit: 15000 as number | null,
    taxFreeLimit: 15000 as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: true,
    description: "Medical expenses for employee and family. Tax-free up to \u20B915,000/year (old regime).",
  },

  DRIVER_STATUTORY: {
    key: "driver",
    label: "Driver Allowance (statutory)",
    section: "10(14)(ii)" as string,
    annualLimit: 9600 as number | null,
    taxFreeLimit: 9600 as number | null,
    newRegimeTaxFree: false,
    requiresBills: false,
    cappedByStatute: true,
    description: "Statutory driver allowance \u20B9800/month. For company car with driver.",
  },

  UNIFORM: {
    key: "uniform",
    label: "Uniform Allowance",
    section: "10(14)(i)" as string,
    annualLimit: null as number | null,
    taxFreeLimit: null as number | null,
    newRegimeTaxFree: false,
    requiresBills: true,
    cappedByStatute: false,
    description: "Work uniform purchase and dry cleaning. Bill-based, no statutory cap.",
  },

  GIFT_VOUCHER: {
    key: "giftVoucher",
    label: "Gift / Voucher",
    section: "17(2)(viii)" as string,
    annualLimit: 5000 as number | null,
    taxFreeLimit: 5000 as number | null,
    newRegimeTaxFree: false,
    requiresBills: false,
    cappedByStatute: true,
    description: "Gift cards or vouchers. Tax-free up to \u20B95,000/year. Excess is a perquisite.",
  },
};

export const getSectionLabel = (section: string): string => {
  const labels: Record<string, string> = {
    "10(14)(i)": "Performance of duty \u2014 no statutory cap, bill-based",
    "10(14)(ii)": "Personal expense \u2014 statutory cap applies",
    "10(5)": "Leave Travel Allowance",
    "10(13A)": "House Rent Allowance",
    "17(2)(viii)": "Perquisite \u2014 capped at \u20B95,000/year",
  };
  return labels[section] || section;
};

export const isStatutoryCapped = (key: string): boolean => {
  const head = Object.values(REIMBURSEMENT_HEADS).find(h => h.key === key);
  return head?.cappedByStatute ?? false;
};

/* ───────────────────────── HELPERS ───────────────────────── */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ───────────────────────── TYPES ───────────────────────── */

export interface Section10Exemptions {
  hra: number;
  lta: number;
  section10_14i: number;
  section10_14ii: number;
  other: number;
}

export interface TDSResult {
  regime: "OLD" | "NEW";
  annualizedGross: number;
  section10Total: number;
  totalDeductionsAllowed: number;
  taxableIncome: number;
  taxBeforeRebate: number;
  rebate87A: number;
  surcharge: number;
  cess: number;
  annualTax: number;
  monthlyTds: number;
}

/* ───────────────────────── 1. PF ───────────────────────── */

/**
 * Compute PF deductions for a given monthly basic.
 * @example computePF(25000, 'CAPPED', 15000)
 *   => pfBasisAmount: 15000, pfEmployee: 1800, pfEmployer: 1800, eps: 1249.50, epfEmployer: 550.50
 */
export function computePF(
  basicMonthly: number,
  pfBasis: "CAPPED" | "ACTUAL",
  pfCap: number
): {
  pfBasisAmount: number;
  pfEmployee: number;
  pfEmployer: number;
  eps: number;
  epfEmployer: number;
} {
  const pfBasisAmount = pfBasis === "CAPPED" ? Math.min(basicMonthly, pfCap) : basicMonthly;
  const pfEmployee = round2(pfBasisAmount * STATUTORY.PF.EMPLOYEE_RATE);
  const pfEmployer = round2(pfBasisAmount * STATUTORY.PF.EMPLOYER_RATE);
  const epsBasis = Math.min(pfBasisAmount, STATUTORY.PF.EPS_WAGE_CAP);
  const eps = round2(epsBasis * STATUTORY.PF.EPS_RATE);
  const epfEmployer = round2(pfEmployer - eps);

  return { pfBasisAmount, pfEmployee, pfEmployer, eps, epfEmployer };
}

/* ───────────────────────── 2. ESI ───────────────────────── */

/**
 * Compute ESI deductions.
 * @example computeESI(18000, 21000)
 *   => applicable: true, esiEmployee: 135, esiEmployer: 585
 */
export function computeESI(
  grossMonthly: number,
  esiGrossLimit: number
): {
  applicable: boolean;
  esiEmployee: number;
  esiEmployer: number;
} {
  const applicable = grossMonthly <= esiGrossLimit;
  if (!applicable) return { applicable, esiEmployee: 0, esiEmployer: 0 };

  return {
    applicable,
    esiEmployee: round2(grossMonthly * STATUTORY.ESI.EMPLOYEE_RATE),
    esiEmployer: round2(grossMonthly * STATUTORY.ESI.EMPLOYER_RATE),
  };
}

/* ───────────────────────── 3. PT ───────────────────────── */

/**
 * Compute Professional Tax based on state slab.
 * @example computePT(50000, 'Karnataka') => { pt: 200 }
 */
export function computePT(
  grossMonthly: number,
  state: string
): { pt: number } {
  const slabs =
    STATUTORY.PROFESSIONAL_TAX[state] || STATUTORY.PROFESSIONAL_TAX.DEFAULT;
  for (const slab of slabs) {
    if (grossMonthly <= slab.upTo) return { pt: slab.tax };
  }
  return { pt: 0 };
}

/* ───────────────────────── 4. LOP ───────────────────────── */

/**
 * Compute LOP (Loss of Pay) deduction.
 * @example computeLOP(50000, 22, 2) => { lopDeduction: 4545.45, effectiveGross: 45454.55 }
 */
export function computeLOP(
  grossMonthly: number,
  workingDays: number,
  lopDays: number
): { lopDeduction: number; effectiveGross: number } {
  if (workingDays <= 0 || lopDays <= 0) return { lopDeduction: 0, effectiveGross: grossMonthly };
  const lopDeduction = round2((grossMonthly / workingDays) * lopDays);
  const effectiveGross = round2(grossMonthly - lopDeduction);
  return { lopDeduction, effectiveGross };
}

/* ───────────────────────── 8. SLAB TAX ───────────────────────── */

/**
 * Apply progressive slab tax.
 * @example applySlabTax(1200000, STATUTORY.NEW_REGIME.SLABS)
 */
export function applySlabTax(
  income: number,
  slabs: ReadonlyArray<{ upTo: number; rate: number }>
): number {
  let tax = 0;
  let prev = 0;
  for (const slab of slabs) {
    if (income <= prev) break;
    const taxable = Math.min(income, slab.upTo) - prev;
    tax += taxable * slab.rate;
    prev = slab.upTo;
  }
  return round2(tax);
}

/* ───────────────────────── 9. SURCHARGE ───────────────────────── */

/**
 * Apply surcharge based on income slab.
 */
export function applySurcharge(
  tax: number,
  income: number,
  surchargeSlabs: ReadonlyArray<{ upTo: number; rate: number }>
): number {
  for (const slab of surchargeSlabs) {
    if (income <= slab.upTo) return round2(tax * slab.rate);
  }
  return 0;
}

/* ───────────────────────── 7. HRA EXEMPTION ───────────────────────── */

/**
 * Compute HRA exemption under old regime.
 * Exemption = min(actual HRA received, rent paid - 10% basic, 50%/40% of basic)
 */
export function computeHRAExemption(params: {
  basicMonthly: number;
  hraReceived: number;
  hraActualPaid: number;
  isMetro: boolean;
}): number {
  const { basicMonthly, hraReceived, hraActualPaid, isMetro } = params;
  if (hraActualPaid <= 0 || hraReceived <= 0) return 0;

  const annualBasic = basicMonthly * 12;
  const annualHraReceived = hraReceived * 12;
  const annualRentPaid = hraActualPaid * 12;

  const a = annualHraReceived;
  const b = annualRentPaid - 0.1 * annualBasic;
  const c = (isMetro ? 0.5 : 0.4) * annualBasic;

  return round2(Math.max(0, Math.min(a, b, c)));
}

/* ───────────────────────── 5. TDS NEW REGIME ───────────────────────── */

/**
 * Compute TDS under the new tax regime (FY 2025-26).
 * @example computeTDSNewRegime({ annualGross: 1200000, standardDeduction: 75000, monthNumber: 1, tdsPaidSoFar: 0 })
 */
export function computeTDSNewRegime(params: {
  annualGross: number;
  standardDeduction?: number;
  section10Exemptions?: Section10Exemptions;
  monthNumber: number;
  tdsPaidSoFar: number;
}): TDSResult {
  const { annualGross, monthNumber, tdsPaidSoFar } = params;
  const standardDeduction = params.standardDeduction ?? STATUTORY.NEW_REGIME.STANDARD_DEDUCTION;

  // New regime: Section 10 salary exemptions are NOT available (post-Budget 2023)
  const section10Total = 0;

  const taxableIncome = Math.max(0, annualGross - section10Total - standardDeduction);
  const taxBeforeRebate = applySlabTax(taxableIncome, STATUTORY.NEW_REGIME.SLABS);

  let rebate87A = 0;
  if (taxableIncome <= STATUTORY.NEW_REGIME.REBATE_87A_LIMIT) {
    rebate87A = Math.min(taxBeforeRebate, STATUTORY.NEW_REGIME.REBATE_87A_AMOUNT);
  }

  const taxAfterRebate = Math.max(0, taxBeforeRebate - rebate87A);
  const surcharge = applySurcharge(taxAfterRebate, taxableIncome, STATUTORY.NEW_REGIME.SURCHARGE);
  const cess = round2((taxAfterRebate + surcharge) * STATUTORY.NEW_REGIME.CESS_RATE);
  const annualTax = round2(taxAfterRebate + surcharge + cess);

  // Compute monthly TDS: distribute remaining tax over remaining months
  const remainingMonths = Math.max(1, 12 - monthNumber + 1);
  const tdsBalance = Math.max(0, annualTax - tdsPaidSoFar);
  const monthlyTds = round2(tdsBalance / remainingMonths);

  return {
    regime: "NEW",
    annualizedGross: annualGross,
    section10Total,
    totalDeductionsAllowed: standardDeduction,
    taxableIncome,
    taxBeforeRebate,
    rebate87A,
    surcharge,
    cess,
    annualTax,
    monthlyTds,
  };
}

/* ───────────────────────── 6. TDS OLD REGIME ───────────────────────── */

/**
 * Compute TDS under the old tax regime (FY 2025-26).
 */
export function computeTDSOldRegime(params: {
  annualGross: number;
  standardDeduction?: number;
  hraExemption: number;
  section10Exemptions?: Section10Exemptions;
  section80C: number;
  section80D: number;
  section80CCD1B: number;
  homeLoanInterest: number;
  otherDeductions: number;
  parentsHealthInsurance?: number;
  parentsAreSenior?: boolean;
  educationLoanInterest?: number;
  savingsInterest?: number;
  donations?: Array<{ amount: number; deductionPercent: number }>;
  monthNumber: number;
  tdsPaidSoFar: number;
}): TDSResult {
  const {
    annualGross,
    hraExemption,
    monthNumber,
    tdsPaidSoFar,
  } = params;
  const standardDeduction = params.standardDeduction ?? STATUTORY.OLD_REGIME.STANDARD_DEDUCTION;

  // Section 10 exemptions — subtracted from gross BEFORE Chapter VI-A deductions
  const s10 = params.section10Exemptions || { hra: 0, lta: 0, section10_14i: 0, section10_14ii: 0, other: 0 };
  const section10Total = round2(
    s10.hra + s10.lta + s10.section10_14i + s10.section10_14ii + s10.other
  );

  // Gross after Section 10 exemptions
  const grossAfterSection10 = Math.max(0, annualGross - section10Total);

  const s80C = Math.min(params.section80C, STATUTORY.OLD_REGIME.SECTION_80C_LIMIT);
  const s80D = Math.min(params.section80D, STATUTORY.OLD_REGIME.SECTION_80D_LIMIT);
  const s80CCD1B = Math.min(params.section80CCD1B, STATUTORY.OLD_REGIME.SECTION_80CCD1B_LIMIT);
  const homeLoan = Math.min(params.homeLoanInterest, 200000);
  const other = params.otherDeductions;

  // 80D parents — cap depends on senior citizen status
  const parents80D = Math.min(
    params.parentsHealthInsurance || 0,
    params.parentsAreSenior ? 50000 : 25000
  );

  // 80E — education loan interest, no upper limit
  const deduction80E = params.educationLoanInterest || 0;

  // 80G — donations
  const deduction80G = (params.donations || []).reduce((sum, d) => {
    return sum + (d.amount * (d.deductionPercent / 100));
  }, 0);

  // 80TTA — savings interest, max ₹10,000
  const deduction80TTA = Math.min(params.savingsInterest || 0, 10000);

  // Chapter VI-A deductions (applied after Section 10 and standard deduction)
  const totalChapterVIA = round2(
    s80C + s80D + parents80D + s80CCD1B + homeLoan +
    deduction80E + deduction80G + deduction80TTA + other
  );

  // HRA is now part of section10Exemptions, but keep backward compatibility:
  // If section10Exemptions.hra is provided, use it (already subtracted above).
  // If not, fall back to the old hraExemption param for backward compatibility.
  const legacyHra = s10.hra > 0 ? 0 : hraExemption;

  const totalDeductionsAllowed = round2(
    standardDeduction + legacyHra + totalChapterVIA
  );

  const taxableIncome = Math.max(0, grossAfterSection10 - totalDeductionsAllowed);
  const taxBeforeRebate = applySlabTax(taxableIncome, STATUTORY.OLD_REGIME.SLABS);

  let rebate87A = 0;
  if (taxableIncome <= STATUTORY.OLD_REGIME.REBATE_87A_LIMIT) {
    rebate87A = Math.min(taxBeforeRebate, STATUTORY.OLD_REGIME.REBATE_87A_AMOUNT);
  }

  const taxAfterRebate = Math.max(0, taxBeforeRebate - rebate87A);
  const surcharge = applySurcharge(taxAfterRebate, taxableIncome, STATUTORY.OLD_REGIME.SURCHARGE);
  const cess = round2((taxAfterRebate + surcharge) * STATUTORY.OLD_REGIME.CESS_RATE);
  const annualTax = round2(taxAfterRebate + surcharge + cess);

  const remainingMonths = Math.max(1, 12 - monthNumber + 1);
  const tdsBalance = Math.max(0, annualTax - tdsPaidSoFar);
  const monthlyTds = round2(tdsBalance / remainingMonths);

  return {
    regime: "OLD",
    annualizedGross: annualGross,
    section10Total,
    totalDeductionsAllowed,
    taxableIncome,
    taxBeforeRebate,
    rebate87A,
    surcharge,
    cess,
    annualTax,
    monthlyTds,
  };
}
