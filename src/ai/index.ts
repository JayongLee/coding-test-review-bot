import { GeminiProvider } from "./providers/gemini-provider.js";
import { OpenAiProvider } from "./providers/openai-provider.js";
import type { AiProvider, AiReviewInput, AiReviewResult } from "./types.js";

function buildProvider(): AiProvider | null {
  const providerName = (process.env.AI_PROVIDER || "gemini").toLowerCase();

  if (providerName === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    return new OpenAiProvider(apiKey, model);
  }

  if (providerName === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    return new GeminiProvider(apiKey, model);
  }

  return null;
}

export async function generateAiReview(input: AiReviewInput): Promise<AiReviewResult | null> {
  const provider = buildProvider();
  if (!provider) return null;
  return provider.generateReview(input);
}
