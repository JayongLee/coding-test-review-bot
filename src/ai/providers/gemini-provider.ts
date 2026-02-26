import type {
  AiProvider,
  AiReviewInput,
  AiReviewResult,
  InlineSuggestion,
  ReviewTarget
} from "../types.js";

interface GeminiResponseShape {
  summary_markdown: string;
  answer_code: string;
  inline_suggestions: Array<{
    path: string;
    line: number;
    body: string;
  }>;
}

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

type GeminiRequestResult =
  | { kind: "ok"; raw: string }
  | { kind: "rate_limited" }
  | { kind: "failed" };

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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

function parseResponse(text: string): GeminiResponseShape | null {
  const tryParse = (input: string): GeminiResponseShape | null => {
    try {
      const parsed = JSON.parse(input) as GeminiResponseShape;
      if (!parsed.summary_markdown || !parsed.answer_code || !Array.isArray(parsed.inline_suggestions)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const stripped = stripCodeFence(text);
  const direct = tryParse(stripped);
  if (direct) return direct;

  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParse(stripped.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function normalizeInline(items: GeminiResponseShape["inline_suggestions"]): InlineSuggestion[] {
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

function extractTextFromGeminiResponse(response: GeminiApiResponse): string | null {
  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts?.length) return null;
  const text = candidate.content.parts.map((part) => part.text ?? "").join("").trim();
  return text || null;
}

function buildPrompt(input: AiReviewInput): string {
  return `
당신은 코딩 테스트 리뷰 어시스턴트다.
반드시 JSON 객체 하나만 출력한다. Markdown/설명문/코드펜스 금지.

필수 작업:
1) 현재 풀이를 분석하고 더 좋은 접근을 제안한다.
2) 모범 답안 코드를 ${input.language} 기준으로 작성한다.
3) 인라인 코멘트는 아래 "허용 라인"에 있는 라인 번호만 사용한다.
4) 사용자가 ASK 필드에 남긴 요청이 있으면 해당 요청을 우선 반영한다.

응답 JSON 스키마:
{
  "summary_markdown": "## 총평\\n...\\n## 더 좋은 접근 제안\\n...\\n## 코드 레벨 개선 포인트\\n...\\n## 놓치기 쉬운 테스트 케이스\\n...",
  "answer_code": "모범 답안 코드 문자열",
  "inline_suggestions": [
    {"path":"허용 라인에 있는 정확한 파일 경로","line":23,"body":"개선 코멘트"}
  ]
}

제약:
- JSON 외 텍스트 출력 금지
- inline_suggestions 최대 6개
- inline_suggestions.path는 허용 라인에 나온 파일 경로 중 하나와 정확히 일치
- summary_markdown에는 "현재 접근 복잡도", "대안 접근", "왜 더 좋은지"를 반드시 포함
- summary_markdown은 1200자 이내로 작성
- answer_code는 220줄 이내로 작성
- answer_code는 실제 줄바꿈을 사용한 여러 줄 코드로 작성 ("\\n" 문자열로 이스케이프하지 않음)
- answer_code는 실행 가능한 형태로 작성

허용 라인:
${buildTargetGuide(input.reviewTargets)}

문제 문서:
${input.problemMarkdown}

PR 본문:
${input.prBody}

ASK (피드백 요청할 부분):
${input.askRequest?.trim() || "없음"}

변경 코드:
${input.changedCodePrompt}
`;
}

function buildCompactPrompt(input: AiReviewInput): string {
  const compactProblem = input.problemMarkdown.slice(0, 6000);
  const compactPrBody = input.prBody.slice(0, 2000);
  const compactChanged = input.changedCodePrompt.slice(0, 7000);
  return `
당신은 코딩 테스트 리뷰 어시스턴트다.
반드시 "유효한 JSON 객체 1개"만 출력한다.
절대 코드펜스(\`\`\`)를 사용하지 마라.

응답 스키마:
{
  "summary_markdown": "마크다운 문자열",
  "answer_code": "코드 문자열",
  "inline_suggestions": [{"path":"파일경로","line":1,"body":"코멘트"}]
}

제약:
- inline_suggestions 최대 4개
- inline_suggestions.path는 허용 라인에 나온 파일 경로 중 하나와 정확히 일치
- summary_markdown은 4개 섹션만 간결히 작성 (900자 이내)
- answer_code는 실제 줄바꿈을 사용한 여러 줄 코드로 작성 ("\\n" 문자열 금지)
- answer_code는 실행 가능 코드

허용 라인:
${buildTargetGuide(input.reviewTargets)}

문제 문서(요약):
${compactProblem}

PR 본문(요약):
${compactPrBody}

ASK:
${input.askRequest?.trim() || "없음"}

변경 코드(요약):
${compactChanged}
`;
}

function limitPrompt(prompt: string, maxPromptChars: number): string {
  return prompt.length > maxPromptChars
    ? `${prompt.slice(0, maxPromptChars)}\n\n[truncated: prompt too long]`
    : prompt;
}

function previewText(text: string, length = 300): string {
  return text.slice(0, length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildResponseSchema() {
  return {
    type: "OBJECT",
    properties: {
      summary_markdown: { type: "STRING" },
      answer_code: { type: "STRING" },
      inline_suggestions: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            path: { type: "STRING" },
            line: { type: "INTEGER" },
            body: { type: "STRING" }
          },
          required: ["path", "line", "body"]
        }
      }
    },
    required: ["summary_markdown", "answer_code", "inline_suggestions"]
  };
}

export class GeminiProvider implements AiProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fallbackModel: string;
  private readonly fallbackTimeoutMs: number;
  private readonly maxPromptChars: number;
  private readonly maxOutputTokens: number;
  private readonly maxRetries: number;
  private readonly rateLimitRetries: number;
  private readonly rateLimitBackoffMs: number;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = toPositiveInt(process.env.GEMINI_TIMEOUT_MS, 60000);
    this.fallbackModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash";
    this.fallbackTimeoutMs = toPositiveInt(process.env.GEMINI_FALLBACK_TIMEOUT_MS, 30000);
    this.maxPromptChars = toPositiveInt(process.env.GEMINI_MAX_PROMPT_CHARS, 20000);
    this.maxOutputTokens = toPositiveInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 4096);
    this.maxRetries = toPositiveInt(process.env.GEMINI_MAX_RETRIES, 2);
    this.rateLimitRetries = toPositiveInt(process.env.GEMINI_RATE_LIMIT_RETRIES, 1);
    this.rateLimitBackoffMs = toPositiveInt(process.env.GEMINI_RATE_LIMIT_BACKOFF_MS, 1200);
  }

  private async request(model: string, prompt: string, timeoutMs: number): Promise<GeminiRequestResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 30000);

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: this.buildGenerationConfig()
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 429) {
          console.error("Gemini request rate limited", {
            model,
            timeoutMs,
            status: response.status,
            body: body.slice(0, 500)
          });
          return { kind: "rate_limited" };
        }

        console.error("Gemini request failed", {
          model,
          timeoutMs,
          status: response.status,
          body: body.slice(0, 500)
        });
        return { kind: "failed" };
      }

      const json = (await response.json()) as GeminiApiResponse;
      const raw = extractTextFromGeminiResponse(json);
      if (!raw) {
        console.error("Gemini response was empty", { model });
        return { kind: "failed" };
      }
      return { kind: "ok", raw };
    } catch (error) {
      console.error("Gemini request failed", {
        model,
        timeoutMs,
        message: error instanceof Error ? error.message : String(error)
      });
      return { kind: "failed" };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestWithRateLimitRetry(
    model: string,
    prompt: string,
    timeoutMs: number
  ): Promise<GeminiRequestResult> {
    let attempt = 0;
    while (true) {
      const result = await this.request(model, prompt, timeoutMs);
      if (result.kind !== "rate_limited") return result;

      if (attempt >= this.rateLimitRetries) {
        return result;
      }

      const backoff = this.rateLimitBackoffMs * Math.max(1, attempt + 1);
      await sleep(backoff);
      attempt += 1;
    }
  }

  private buildGenerationConfig() {
    return {
      temperature: 0.2,
      maxOutputTokens: this.maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: buildResponseSchema()
    };
  }

  async generateReview(input: AiReviewInput): Promise<AiReviewResult | null> {
    const prompts = [limitPrompt(buildPrompt(input), this.maxPromptChars)];
    const compactPrompt = limitPrompt(buildCompactPrompt(input), this.maxPromptChars);
    if (compactPrompt !== prompts[0]) {
      prompts.push(compactPrompt);
    }

    const primaryModel = { name: this.model, timeoutMs: this.timeoutMs };
    const fallbackModel =
      this.fallbackModel && this.fallbackModel !== this.model
        ? { name: this.fallbackModel, timeoutMs: this.fallbackTimeoutMs }
        : null;

    let primaryHadTransportFailure = false;
    let primaryRateLimited = false;

    for (const prompt of prompts) {
      const result = await this.requestWithRateLimitRetry(primaryModel.name, prompt, primaryModel.timeoutMs);
      if (result.kind === "rate_limited") {
        primaryRateLimited = true;
        break;
      }

      if (result.kind === "failed") {
        primaryHadTransportFailure = true;
        continue;
      }

      const parsed = parseResponse(result.raw);
      if (parsed) {
        return {
          summaryMarkdown: parsed.summary_markdown.trim(),
          answerCode: parsed.answer_code.trim(),
          inlineSuggestions: normalizeInline(parsed.inline_suggestions)
        };
      }

      console.error("Gemini response JSON parse failed", {
        model: primaryModel.name,
        preview: previewText(result.raw)
      });
    }

    if (primaryRateLimited) return null;
    if (!fallbackModel || !primaryHadTransportFailure) return null;

    let fallbackRateLimited = false;
    let fallbackAttempts = 0;

    for (const prompt of prompts) {
      if (fallbackAttempts >= this.maxRetries) break;
      fallbackAttempts += 1;

      const result = await this.requestWithRateLimitRetry(fallbackModel.name, prompt, fallbackModel.timeoutMs);
      if (result.kind === "rate_limited") {
        fallbackRateLimited = true;
        break;
      }

      if (result.kind === "failed") {
        continue;
      }

      const parsed = parseResponse(result.raw);
      if (parsed) {
        return {
          summaryMarkdown: parsed.summary_markdown.trim(),
          answerCode: parsed.answer_code.trim(),
          inlineSuggestions: normalizeInline(parsed.inline_suggestions)
        };
      }

      console.error("Gemini response JSON parse failed", {
        model: fallbackModel.name,
        preview: previewText(result.raw)
      });
    }

    if (fallbackRateLimited) return null;
    return null;
  }
}
