import { OpenAiProvider } from "./providers/openai-provider.js";
import type { AiProvider, AiReviewInput, AiReviewResult } from "./types.js";

function buildProvider(): AiProvider | null {
  const providerName = (process.env.AI_PROVIDER || "openai").toLowerCase();
  if (providerName !== "openai") {
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  return new OpenAiProvider(apiKey, model);
}

export async function generateAiReview(input: AiReviewInput): Promise<AiReviewResult | null> {
  const provider = buildProvider();
  if (!provider) return null;
  return provider.generateReview(input);
}
