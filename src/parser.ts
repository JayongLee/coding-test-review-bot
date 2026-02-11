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

function extractFields(body: string, label: string): string[] {
  const re = new RegExp(`^\\s*-?\\s*${label}\\s*:\\s*(.+)$`, "gim");
  const matches = body.matchAll(re);
  return [...matches].map((match) => match[1]?.trim()).filter((v): v is string => Boolean(v));
}

function selectProblemUrl(urlCandidates: string[], site?: SupportedSite): string | undefined {
  if (urlCandidates.length === 0) return undefined;

  const validUrl = (raw: string): string | undefined => {
    try {
      const url = new URL(raw);
      return url.toString();
    } catch {
      return undefined;
    }
  };

  const normalized = urlCandidates.map(validUrl).filter((v): v is string => Boolean(v));
  if (normalized.length === 0) return undefined;

  if (site === "BOJ") {
    return (
      normalized.find((url) => /(^|\.)acmicpc\.net$/i.test(new URL(url).hostname) && /\/problem\/\d+/.test(new URL(url).pathname)) ??
      normalized[0]
    );
  }

  if (site === "PROGRAMMERS") {
    return (
      normalized.find(
        (url) => /(^|\.)programmers\.co\.kr$/i.test(new URL(url).hostname) && /\/lessons\/\d+/.test(new URL(url).pathname)
      ) ?? normalized[0]
    );
  }

  return normalized[0];
}

export function parsePrBody(body?: string | null): PrProblemMetadata {
  if (!body) return {};
  const siteRaw = extractField(body, "Site");
  const site = siteRaw ? parseSite(siteRaw) : undefined;
  const problemNumber = extractField(body, "Problem Number");
  const problemUrl = selectProblemUrl(
    [...extractFields(body, "URL"), ...extractFields(body, "Problem URL"), ...extractFields(body, "URL \\(PROGRAMMERS\\)")],
    site
  );
  const ask = extractField(body, "피드백 요청할 부분") ?? extractField(body, "ASK");
  const language = extractField(body, "Language");
  const runtime = extractField(body, "Runtime");
  const memory = extractField(body, "Memory");
  const submittedAt = extractField(body, "Submitted At");

  return {
    site,
    problemNumber,
    problemUrl,
    language,
    ask,
    runtime,
    memory,
    submittedAt
  };
}

export function hasRequiredTemplateFields(metadata: PrProblemMetadata): boolean {
  return Boolean(metadata.site && metadata.problemNumber && metadata.language);
}
