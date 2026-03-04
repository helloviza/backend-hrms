// Add 'export' to the type definition
export type PlutoIntent = "DISCOVERY" | "PLANNING" | "REFINEMENT" | "PIVOT";

export function classifyPlutoIntent(prompt: string): PlutoIntent {
  const text = prompt.toLowerCase();
  
  const pivotKeywords = ["instead", "actually", "change to", "forget", "nevermind"];
  if (pivotKeywords.some(k => text.includes(k))) return "PIVOT";

  if (text.includes("itinerary") || text.includes("plan")) return "PLANNING";
  if (text.includes("add") || text.includes("update")) return "REFINEMENT";
  
  return "DISCOVERY";
}