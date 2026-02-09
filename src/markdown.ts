import type { CrawledProblem, PrProblemMetadata } from "./types.js";

function toParagraphOrFallback(html: string, fallback: string): string {
  const cleaned = html
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

export function buildProblemMarkdown(metadata: PrProblemMetadata, problem: CrawledProblem): string {
  const sitePrefix =
    metadata.site === "BOJ" ? "백준" : metadata.site === "PROGRAMMERS" ? "프로그래머스" : metadata.site ?? "Unknown";
  const number = metadata.problemNumber ?? "N/A";
  const submittedAt = metadata.submittedAt ?? "N/A";
  const runtime = metadata.runtime ?? "N/A";
  const memory = metadata.memory ?? "N/A";

  const classification = problem.classification.length > 0 ? problem.classification.join(", ") : "N/A";

  return `# [${sitePrefix}] ${problem.title} - ${number}

[문제 링크](${problem.problemUrl})

### 성능 요약

메모리: ${memory}, 시간: ${runtime}

### 분류

${classification}

### 제출 일자

${submittedAt}

### 문제 설명

${toParagraphOrFallback(problem.descriptionHtml, "문제 설명을 불러오지 못했습니다.")}

### 입력

${toParagraphOrFallback(problem.inputHtml, "입력 설명을 불러오지 못했습니다.")}

### 출력

${toParagraphOrFallback(problem.outputHtml, "출력 설명을 불러오지 못했습니다.")}
`;
}

export function sanitizeProblemTitle(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
