import OpenAI from "openai";
import type {
  AiProvider,
  AiReviewInput,
  AiReviewResult,
  InlineSuggestion,
  ReviewTarget
} from "../types.js";

interface OpenAiResponseShape {
  summary_markdown: string;
  answer_code: string;
  inline_suggestions: Array<{
    path: string;
    line: number;
    body: string;
  }>;
}

function buildTargetGuide(targets: ReviewTarget[]): string {
  if (targets.length === 0) return "라인 코멘트 대상 파일이 없습니다.";
  return targets
    .map((target) => `${target.path} -> [${target.addedLines.join(",") || "none"}]`)
    .join("\n");
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseResponse(text: string): OpenAiResponseShape | null {
  try {
    const parsed = JSON.parse(stripCodeFence(text)) as OpenAiResponseShape;
    if (!parsed.summary_markdown || !parsed.answer_code || !Array.isArray(parsed.inline_suggestions)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeInline(items: OpenAiResponseShape["inline_suggestions"]): InlineSuggestion[] {
  const results: InlineSuggestion[] = [];
  for (const item of items) {
    const path = item.path?.trim();
    const line = Number(item.line);
    const body = item.body?.trim();
    if (!path || !body || !Number.isInteger(line) || line <= 0) continue;
    results.push({ path, line, body });
  }
  return results;
}

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? "5000");
  }

  async generateReview(input: AiReviewInput): Promise<AiReviewResult | null> {
    const prompt = `
당신은 코딩 테스트 리뷰 어시스턴트다.
반드시 JSON 객체 하나만 출력한다. Markdown/설명문/코드펜스 금지.

필수 작업:
1) 현재 풀이를 분석하고 더 좋은 접근을 제안한다.
2) 모범 답안 코드를 ${input.language} 기준으로 작성한다.
3) 인라인 코멘트는 아래 "허용 라인"에 있는 라인 번호만 사용한다.

응답 JSON 스키마:
{
  "summary_markdown": "## 총평\\n...\\n## 더 좋은 접근 제안\\n...\\n## 코드 레벨 개선 포인트\\n...\\n## 놓치기 쉬운 테스트 케이스\\n...",
  "answer_code": "모범 답안 코드 문자열",
  "inline_suggestions": [
    {"path":"src/Main.java","line":23,"body":"개선 코멘트"}
  ]
}

제약:
- inline_suggestions 최대 6개
- summary_markdown에는 "현재 접근 복잡도", "대안 접근", "왜 더 좋은지"를 반드시 포함
- answer_code는 실행 가능한 형태로 작성

허용 라인:
${buildTargetGuide(input.reviewTargets)}

문제 문서:
${input.problemMarkdown}

PR 본문:
${input.prBody}

변경 코드:
${input.changedCodePrompt}
`;

    let response;
    try {
      response = await this.client.responses.create(
        {
          model: this.model,
          input: prompt
        },
        {
          timeout: Number.isFinite(this.timeoutMs) ? this.timeoutMs : 5000
        }
      );
    } catch {
      return null;
    }

    const raw = response.output_text?.trim();
    if (!raw) return null;

    const parsed = parseResponse(raw);
    if (!parsed) return null;

    return {
      summaryMarkdown: parsed.summary_markdown.trim(),
      answerCode: parsed.answer_code.trim(),
      inlineSuggestions: normalizeInline(parsed.inline_suggestions)
    };
  }
}
