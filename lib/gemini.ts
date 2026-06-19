import { createGoogleGenerativeAI } from "@ai-sdk/google";

const apiKey = process.env.GEMINI_API_KEY;

export const geminiProvider = apiKey ? createGoogleGenerativeAI({ apiKey }) : null;
