import { load } from "cheerio";
import type { CrawledProblem, PrProblemMetadata } from "./types.js";

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "coding-test-review-bot/0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch problem page: ${response.status}`);
  }
  return response.text();
}

async function crawlBoj(problemNumber: string): Promise<CrawledProblem> {
  const problemUrl = `https://www.acmicpc.net/problem/${problemNumber}`;
  const html = await fetchHtml(problemUrl);
  const $ = load(html);

  const title = $("#problem_title").text().trim() || `[Unknown] ${problemNumber}`;
  const classification = $("#problem_tags a").map((_, el) => $(el).text().trim()).get();
  const descriptionHtml = $("#problem_description").html()?.trim() ?? "";
  const inputHtml = $("#problem_input").html()?.trim() ?? "";
  const outputHtml = $("#problem_output").html()?.trim() ?? "";

  return {
    title,
    problemUrl,
    classification,
    descriptionHtml,
    inputHtml,
    outputHtml
  };
}

function firstNonEmpty(values: Array<string | undefined | null>): string {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? "";
}

async function crawlProgrammers(problemNumber: string): Promise<CrawledProblem> {
  const problemUrl = `https://school.programmers.co.kr/learn/courses/30/lessons/${problemNumber}`;
  const html = await fetchHtml(problemUrl);
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
    problemUrl,
    classification,
    descriptionHtml,
    inputHtml,
    outputHtml
  };
}

export async function crawlProblem(metadata: PrProblemMetadata): Promise<CrawledProblem> {
  if (!metadata.site || !metadata.problemNumber) {
    throw new Error("Missing required metadata");
  }

  switch (metadata.site) {
    case "BOJ":
      return crawlBoj(metadata.problemNumber);
    case "PROGRAMMERS":
      return crawlProgrammers(metadata.problemNumber);
    default:
      throw new Error(`Unsupported site: ${String(metadata.site)}`);
  }
}
