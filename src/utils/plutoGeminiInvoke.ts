// apps/backend/src/utils/plutoGeminiInvoke.ts
import { GoogleGenerativeAI } from "@google/generative-ai";

// Set up Gemini with your key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export async function invokePlutoGemini(prompt: string) {
  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // We try to clean the text in case Gemini adds ```json markdown tags
    const cleanJson = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error("Gemini invocation failed:", error);
    throw new Error("Both AI engines are currently unavailable.");
  }
}