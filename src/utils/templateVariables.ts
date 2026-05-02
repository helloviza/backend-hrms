export interface TemplateContext {
  customerName?: string;
  customerEmail?: string;
  ticketRef?: string;
  agentName?: string;
  agentEmail?: string;
  companyName?: string;
  currentDate?: string;
}

const VARIABLE_MAP: Record<string, keyof TemplateContext> = {
  customerName: "customerName",
  customerEmail: "customerEmail",
  ticketRef: "ticketRef",
  agentName: "agentName",
  agentEmail: "agentEmail",
  companyName: "companyName",
  currentDate: "currentDate",
};

export function renderTemplate(bodyHtml: string, context: TemplateContext): string {
  let rendered = bodyHtml;
  for (const [varName, contextKey] of Object.entries(VARIABLE_MAP)) {
    const value = context[contextKey] ?? "";
    rendered = rendered.replace(new RegExp(`\\{\\{${varName}\\}\\}`, "g"), value);
  }
  return rendered;
}
