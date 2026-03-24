import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

type TravelContext = {
  userId: string;
  city?: string;
  company?: string;
  role?: string;
};

function buildPrompt(ctx: TravelContext) {
  return `
You are Plumtrips AI Travel Copilot.

You help with:
- Holiday strip planning
- Business travel planning

STRICT RULES:
- Draft itineraries only
- No pricing, booking, or guarantees
- Always guide user to Plumtrips Relationship Manager
- Tone: premium, calm, professional

Context:
City: ${ctx.city || "Unknown"}
Company: ${ctx.company || "Plumtrips Client"}
Role: ${ctx.role || "Employee"}
`;
}

function addRMCTA(text: string) {
  return `${text}

✨ This is a draft itinerary prepared by Plumtrips AI Copilot.
For a fully curated, visa-checked and cost-optimized itinerary,
please connect with your Plumtrips Relationship Manager.`;
}

export async function runTravelCopilot(
  message: string,
  ctx: TravelContext
) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: buildPrompt(ctx) },
      { role: "user", content: message }
    ]
  });

  return {
    reply: addRMCTA(completion.choices[0].message.content || ""),
    copilot: "travel",
    createdAt: new Date().toISOString()
  };
}
