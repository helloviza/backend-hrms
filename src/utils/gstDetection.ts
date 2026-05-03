export const GST_STATE_CODES: Record<string, string> = {
  "Andhra Pradesh": "37",
  "Arunachal Pradesh": "12",
  "Assam": "18",
  "Bihar": "10",
  "Chhattisgarh": "22",
  "Goa": "30",
  "Gujarat": "24",
  "Haryana": "06",
  "Himachal Pradesh": "02",
  "Jharkhand": "20",
  "Karnataka": "29",
  "Kerala": "32",
  "Madhya Pradesh": "23",
  "Maharashtra": "27",
  "Manipur": "14",
  "Meghalaya": "17",
  "Mizoram": "15",
  "Nagaland": "13",
  "Odisha": "21",
  "Punjab": "03",
  "Rajasthan": "08",
  "Sikkim": "11",
  "Tamil Nadu": "33",
  "Telangana": "36",
  "Tripura": "16",
  "Uttar Pradesh": "09",
  "Uttarakhand": "05",
  "West Bengal": "19",
  "Andaman and Nicobar Islands": "35",
  "Chandigarh": "04",
  "Dadra and Nagar Haveli and Daman and Diu": "26",
  "Delhi": "07",
  "Jammu and Kashmir": "01",
  "Ladakh": "38",
  "Lakshadweep": "31",
  "Puducherry": "34",
};

export const UNION_TERRITORIES = new Set([
  "Andaman and Nicobar Islands",
  "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Jammu and Kashmir",
  "Ladakh",
  "Lakshadweep",
  "Puducherry",
]);

export const INDIA_STATES_AND_UTS = Object.keys(GST_STATE_CODES);

export type GSTType = "CGST_SGST" | "CGST_UTGST" | "IGST" | "EXPORT" | "NONE";

export interface GSTDetectionResult {
  gstType: GSTType;
  supplierState: string;
  customerState: string;
  supplierStateCode: string;
  customerStateCode: string;
  placeOfSupply: string;
  canCalculate: boolean;
  reason?: string;
}

export function detectGSTType(input: {
  supplierState: string;
  customerState?: string;
  customerCountry?: string;
}): GSTDetectionResult {
  const supplierState = input.supplierState || "Karnataka";
  const supplierStateCode = GST_STATE_CODES[supplierState] || "29";

  if (input.customerCountry && input.customerCountry.trim() !== "" && input.customerCountry.trim() !== "India") {
    return {
      gstType: "EXPORT",
      supplierState,
      customerState: input.customerCountry,
      supplierStateCode,
      customerStateCode: "00",
      placeOfSupply: input.customerCountry,
      canCalculate: true,
      reason: "International customer — zero-rated export",
    };
  }

  if (!input.customerState || !input.customerState.trim()) {
    return {
      gstType: "NONE",
      supplierState,
      customerState: "",
      supplierStateCode,
      customerStateCode: "",
      placeOfSupply: "",
      canCalculate: false,
      reason: "Customer state missing — update customer profile to generate invoice",
    };
  }

  const customerState = input.customerState.trim();
  const customerStateCode = GST_STATE_CODES[customerState] || "";

  if (!customerStateCode) {
    return {
      gstType: "NONE",
      supplierState,
      customerState,
      supplierStateCode,
      customerStateCode: "",
      placeOfSupply: customerState,
      canCalculate: false,
      reason: `Unknown state: "${customerState}" — must be a valid Indian state or UT`,
    };
  }

  if (customerState === supplierState) {
    const gstType: GSTType = UNION_TERRITORIES.has(customerState) ? "CGST_UTGST" : "CGST_SGST";
    return {
      gstType,
      supplierState,
      customerState,
      supplierStateCode,
      customerStateCode,
      placeOfSupply: customerState,
      canCalculate: true,
    };
  }

  return {
    gstType: "IGST",
    supplierState,
    customerState,
    supplierStateCode,
    customerStateCode,
    placeOfSupply: customerState,
    canCalculate: true,
  };
}

export function calculateGSTAmounts(
  totalGst: number,
  gstType: GSTType,
): { cgst: number; sgst: number; utgst: number; igst: number; total: number } {
  const half = parseFloat((totalGst / 2).toFixed(2));
  const otherHalf = parseFloat((totalGst - half).toFixed(2));
  switch (gstType) {
    case "CGST_SGST":
      return { cgst: half, sgst: otherHalf, utgst: 0, igst: 0, total: totalGst };
    case "CGST_UTGST":
      return { cgst: half, sgst: 0, utgst: otherHalf, igst: 0, total: totalGst };
    case "IGST":
      return { cgst: 0, sgst: 0, utgst: 0, igst: totalGst, total: totalGst };
    case "EXPORT":
    case "NONE":
      return { cgst: 0, sgst: 0, utgst: 0, igst: 0, total: 0 };
  }
}
