import { load } from "cheerio";
import type { CrawledProblem, PrProblemMetadata } from "./types.js";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

class ForbiddenFetchError extends Error {
  constructor(public readonly url: string) {
    super(`Failed to fetch problem page: 403 (${url})`);
    this.name = "ForbiddenFetchError";
  }
}

function getCandidateHeaders(url: string): HeadersInit[] {
  const origin = new URL(url).origin;
  const base = {
    "user-agent": BROWSER_USER_AGENT,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache"
  };

  return [base, { ...base, referer: origin }, { ...base, referer: `${origin}/` }];
}

async function fetchHtml(url: string): Promise<string> {
  for (const headers of getCandidateHeaders(url)) {
    const response = await fetch(url, {
      headers,
      redirect: "follow"
    });

    if (response.ok) {
      return response.text();
    }

    if (response.status === 403) {
      continue;
    }

    throw new Error(`Failed to fetch problem page: ${response.status}`);
  }

  throw new ForbiddenFetchError(url);
}

function defaultProblemUrl(site: PrProblemMetadata["site"], problemNumber: string): string {
  return site === "PROGRAMMERS"
    ? `https://school.programmers.co.kr/learn/courses/30/lessons/${problemNumber}`
    : `https://www.acmicpc.net/problem/${problemNumber}`;
}

function pickProblemUrl(site: PrProblemMetadata["site"], problemNumber: string, rawUrl?: string): string {
  if (!rawUrl) return defaultProblemUrl(site, problemNumber);

  const trimmed = rawUrl.trim();
  if (!trimmed) return defaultProblemUrl(site, problemNumber);

  try {
    const url = new URL(trimmed);
    if (site === "PROGRAMMERS") {
      const validHost = /(^|\.)programmers\.co\.kr$/i.test(url.hostname);
      const validPath = /\/lessons\/\d+/.test(url.pathname);
      if (validHost && validPath) return trimmed;
      return defaultProblemUrl(site, problemNumber);
    }

    const validHost = /(^|\.)acmicpc\.net$/i.test(url.hostname);
    const validPath = /\/problem\/\d+/.test(url.pathname);
    if (validHost && validPath) return trimmed;
    return defaultProblemUrl(site, problemNumber);
  } catch {
    return defaultProblemUrl(site, problemNumber);
  }
}

async function crawlBoj(problemNumber: string, problemUrl?: string): Promise<CrawledProblem> {
  const targetUrl = pickProblemUrl("BOJ", problemNumber, problemUrl);
  const html = await fetchHtml(targetUrl);
  const $ = load(html);

  const title = $("#problem_title").text().trim() || `[Unknown] ${problemNumber}`;
  const classification = $("#problem_tags a").map((_, el) => $(el).text().trim()).get();
  const descriptionHtml = $("#problem_description").html()?.trim() ?? "";
  const inputHtml = $("#problem_input").html()?.trim() ?? "";
  const outputHtml = $("#problem_output").html()?.trim() ?? "";

  return {
    title,
    problemUrl: targetUrl,
    classification,
    descriptionHtml,
    inputHtml,
    outputHtml
  };
}

function firstNonEmpty(values: Array<string | undefined | null>): string {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? "";
}

async function crawlProgrammers(problemNumber: string, problemUrl?: string): Promise<CrawledProblem> {
  const targetUrl = pickProblemUrl("PROGRAMMERS", problemNumber, problemUrl);
  const html = await fetchHtml(targetUrl);
  const $ = load(html);

  const title = firstNonEmpty([
    $("h4.challenge-title").first().text(),
    $(".challenge-main-title").first().text(),
    $('meta[property="og:title"]').attr("content")?.replace(/^코딩테스트 연습\s*-\s*/i, ""),
    `[Unknown] ${problemNumber}`
  ]);

  const classification = $(".breadcrumb a")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  const descriptionHtml = firstNonEmpty([
    $(".challenge-content .guide-section .markdown").first().html(),
    $(".challenge-content .markdown").first().html(),
    $(".challenge-content").first().html()
  ]);

  const sectionHeaders = $(".guide-section h6, .guide-section h5, .guide-section h4")
    .map((_, el) => $(el).text().trim())
    .get();

  const inputHtml = sectionHeaders.length > 0 ? `입출력/제약 섹션: ${sectionHeaders.join(", ")}` : "";
  const outputHtml = "";

  return {
    title,
    problemUrl: targetUrl,
    classification,
    descriptionHtml,
    inputHtml,
    outputHtml
  };
}

function buildFallbackProblem(metadata: PrProblemMetadata): CrawledProblem {
  const siteName = metadata.site === "PROGRAMMERS" ? "프로그래머스" : "백준";
  const problemNumber = metadata.problemNumber ?? "unknown";
  const problemUrl = pickProblemUrl(metadata.site, problemNumber, metadata.problemUrl);

  return {
    title: `${siteName} 문제 ${problemNumber}`,
    problemUrl,
    classification: [],
    descriptionHtml:
      "문제 사이트가 크롤링 요청을 차단했습니다(HTTP 403). 문제 링크를 통해 직접 확인한 뒤, PR 본문의 Solution Summary를 자세히 작성해주세요.",
    inputHtml: "입력 설명을 자동 수집하지 못했습니다.",
    outputHtml: "출력 설명을 자동 수집하지 못했습니다."
  };
}

export async function crawlProblem(metadata: PrProblemMetadata): Promise<CrawledProblem> {
  if (!metadata.site || !metadata.problemNumber) {
    throw new Error("Missing required metadata");
  }

  try {
    switch (metadata.site) {
      case "BOJ":
        return crawlBoj(metadata.problemNumber, metadata.problemUrl);
      case "PROGRAMMERS":
        return crawlProgrammers(metadata.problemNumber, metadata.problemUrl);
      default:
        throw new Error(`Unsupported site: ${String(metadata.site)}`);
    }
  } catch (error) {
    if (error instanceof ForbiddenFetchError) {
      return buildFallbackProblem(metadata);
    }
    throw error;
  }
}
