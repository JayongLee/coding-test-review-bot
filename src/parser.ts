import type { PrProblemMetadata, SupportedSite } from "./types.js";

function parseSite(raw: string): SupportedSite | undefined {
  const trimmed = raw.trim();
  if (trimmed === "프로그래머스") return "PROGRAMMERS";

  const value = trimmed.toUpperCase();
  if (value === "BOJ" || value === "BAEKJOON") return "BOJ";
  if (value === "PROGRAMMERS" || value === "PGM" || value === "PROG") return "PROGRAMMERS";
  return undefined;
}

function extractField(body: string, label: string): string | undefined {
  const re = new RegExp(`^\\s*-?\\s*${label}\\s*:\\s*(.+)$`, "im");
  const match = body.match(re);
  return match?.[1]?.trim();
}

export function parsePrBody(body?: string | null): PrProblemMetadata {
  if (!body) return {};
  const siteRaw = extractField(body, "Site");
  const problemNumber = extractField(body, "Problem Number");
  const language = extractField(body, "Language");
  const runtime = extractField(body, "Runtime");
  const memory = extractField(body, "Memory");
  const submittedAt = extractField(body, "Submitted At");

  return {
    site: siteRaw ? parseSite(siteRaw) : undefined,
    problemNumber,
    language,
    runtime,
    memory,
    submittedAt
  };
}

export function hasRequiredTemplateFields(metadata: PrProblemMetadata): boolean {
  return Boolean(metadata.site && metadata.problemNumber && metadata.language);
}
