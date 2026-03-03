import type {
  AiProvider,
  AiReviewInput,
  AiReviewResult,
  InlineSuggestion,
  ReviewTarget
} from "../types.js";

interface GeminiResponseShape {
  summary_markdown: string;
  time_complexity: string;
  space_complexity: string;
  answer_code: string;
  inline_suggestions: Array<{
    path: string;
    line: number;
    body: string;
  }>;
}

interface GeminiApiResponse {
  candidates?: Array<{
    finishReason?: string;
    finishMessage?: string;
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

type GeminiRequestResult =
  | { kind: "ok"; raw: string }
  | { kind: "rate_limited" }
  | { kind: "failed" };

interface GeminiGenerationConfig {
  temperature: number;
  maxOutputTokens: number;
  responseMimeType: string;
  responseSchema: Record<string, unknown>;
}

interface GeminiStreamState {
  rawText: string;
  finishReason?: string;
  finishMessage?: string;
  usageMetadata?: GeminiApiResponse["usageMetadata"];
}

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

function decodeJsonStringLike(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`) as string;
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function extractJsonStringField(text: string, key: string): string | null {
  const keyRegex = new RegExp(`"${key}"\\s*:`, "m");
  const keyMatch = keyRegex.exec(text);
  if (!keyMatch) return null;

  let index = keyMatch.index + keyMatch[0].length;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (text[index] !== '"') return null;

  index += 1;
  let escaped = false;
  let raw = "";
  while (index < text.length) {
    const ch = text[index];
    if (escaped) {
      raw += ch;
      escaped = false;
      index += 1;
      continue;
    }
    if (ch === "\\") {
      raw += ch;
      escaped = true;
      index += 1;
      continue;
    }
    if (ch === '"') {
      return decodeJsonStringLike(raw);
    }
    raw += ch;
    index += 1;
  }

  // 문자열이 닫히지 않은 경우, 파싱 가능한 부분까지만 사용
  return raw.trim() ? decodeJsonStringLike(raw) : null;
}

function parseLooseInlineSuggestions(text: string): GeminiResponseShape["inline_suggestions"] {
  const markerRegex = /"inline_suggestions"\s*:/m;
  const marker = markerRegex.exec(text);
  if (!marker) return [];

  let index = marker.index + marker[0].length;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (text[index] !== "[") return [];

  const slice = text.slice(index);
  const results: GeminiResponseShape["inline_suggestions"] = [];
  const objectRegex =
    /{[\s\S]*?"path"\s*:\s*"([\s\S]*?)"[\s\S]*?"line"\s*:\s*(-?\d+)[\s\S]*?"body"\s*:\s*"([\s\S]*?)"[\s\S]*?}/g;

  for (const match of slice.matchAll(objectRegex)) {
    const path = decodeJsonStringLike(match[1] ?? "").trim();
    const line = Number(match[2]);
    const body = decodeJsonStringLike(match[3] ?? "").trim();
    if (!path || !body || !Number.isInteger(line) || line <= 0) continue;
    results.push({ path, line, body });
    if (results.length >= 8) break;
  }

  return results;
}

function parseLooseResponse(text: string): GeminiResponseShape | null {
  const stripped = stripCodeFence(text);
  const summary = extractJsonStringField(stripped, "summary_markdown");
  if (!summary) return null;

  const timeComplexity = extractJsonStringField(stripped, "time_complexity") || "O(unknown)";
  const spaceComplexity = extractJsonStringField(stripped, "space_complexity") || "O(unknown)";
  const answerCode = extractJsonStringField(stripped, "answer_code") || "/* answer_code unavailable */";
  const inlineSuggestions = parseLooseInlineSuggestions(stripped);

  return {
    summary_markdown: summary.trim(),
    time_complexity: timeComplexity.trim(),
    space_complexity: spaceComplexity.trim(),
    answer_code: answerCode.trim(),
    inline_suggestions: inlineSuggestions
  };
}

function parseResponse(text: string): GeminiResponseShape | null {
  const tryParse = (input: string): GeminiResponseShape | null => {
    try {
      const parsed = JSON.parse(input) as GeminiResponseShape;
      if (!parsed.summary_markdown || !parsed.answer_code || !Array.isArray(parsed.inline_suggestions)) {
        return null;
      }
      return {
        ...parsed,
        time_complexity: parsed.time_complexity?.trim() || "O(unknown)",
        space_complexity: parsed.space_complexity?.trim() || "O(unknown)"
      };
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
    const sliced = stripped.slice(firstBrace, lastBrace + 1);
    const slicedParsed = tryParse(sliced);
    if (slicedParsed) return slicedParsed;
  }

  return parseLooseResponse(stripped);
}

function parseAnswerCodeOnly(text: string): string | null {
  const tryParse = (input: string): string | null => {
    try {
      const parsed = JSON.parse(input) as { answer_code?: unknown };
      if (typeof parsed.answer_code !== "string") return null;
      const normalized = parsed.answer_code.trim();
      return normalized.length > 0 ? normalized : null;
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
  const text = candidate.content.parts.map((part) => part.text ?? "").join("");
  return text.length > 0 ? text : null;
}

function updateStreamStateFromChunk(state: GeminiStreamState, chunk: GeminiApiResponse): void {
  const text = extractTextFromGeminiResponse(chunk);
  if (text) {
    state.rawText += text;
  }

  const candidate = chunk.candidates?.[0];
  if (candidate?.finishReason) {
    state.finishReason = candidate.finishReason;
  }
  if (candidate?.finishMessage) {
    state.finishMessage = candidate.finishMessage;
  }
  if (chunk.usageMetadata) {
    state.usageMetadata = chunk.usageMetadata;
  }
}

function parseSseEventChunk(chunk: string): GeminiApiResponse[] {
  const normalized = chunk.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const events: GeminiApiResponse[] = [];
  const blocks = normalized.split("\n\n");
  for (const block of blocks) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;

    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") continue;

    try {
      events.push(JSON.parse(payload) as GeminiApiResponse);
    } catch {
      // ignore malformed partial event; next chunks may complete stream meaningfully
    }
  }

  return events;
}

function buildPrompt(input: AiReviewInput): string {
  return `
당신은 코딩 테스트 리뷰 어시스턴트다.
반드시 JSON 객체 하나만 출력한다. Markdown/설명문/코드펜스 금지.

필수 작업:
1) 제출 코드는 "정답(AC)"이라고 가정하고, 왜 정답인지 핵심 근거를 설명한다.
2) 시간/공간 복잡도를 평가하고, 병목 가능성을 짚는다.
3) 더 나은 접근(복잡도 개선 또는 구현 단순화)이 가능한지 검토한다.
4) 코드 품질(변수명, 변수 선언 위치/스코프, 중복 로직, 매직넘버)을 리뷰한다.
5) 모범 답안 코드를 ${input.language} 기준으로 작성한다.
6) 인라인 코멘트는 아래 "허용 라인"에 있는 라인 번호만 사용한다.
7) 사용자가 ASK 필드에 남긴 요청이 있으면 해당 요청을 우선 반영한다.

응답 JSON 스키마:
{
  "summary_markdown": "## 총평\\n...\\n## 더 좋은 접근 제안\\n...\\n## 코드 레벨 개선 포인트\\n...\\n## 놓치기 쉬운 테스트 케이스\\n...",
  "time_complexity": "O(...)",
  "space_complexity": "O(...)",
  "answer_code": "모범 답안 코드 문자열",
  "inline_suggestions": [
    {"path":"허용 라인에 있는 정확한 파일 경로","line":23,"body":"개선 코멘트"}
  ]
}

제약:
- JSON 외 텍스트 출력 금지
- inline_suggestions 최대 6개
- inline_suggestions.path는 허용 라인에 나온 파일 경로 중 하나와 정확히 일치
- summary_markdown에는 "왜 정답인지", "시간/공간 복잡도 평가", "코드 품질 개선 포인트", "대안 접근"을 반드시 포함
- time_complexity/space_complexity는 Big-O 표기 포함 (예: O(N log N), O(H*N*M))
- summary_markdown은 1200자 이내로 작성
- answer_code는 220줄 이내로 작성
- answer_code는 실제 줄바꿈을 사용한 여러 줄 코드로 작성 ("\\n" 문자열로 이스케이프하지 않음)
- inline_suggestions가 1개 이상이면 answer_code에는 그 개선사항이 반드시 반영되어야 함
- answer_code는 입력 코드와 완전히 동일한 코드를 그대로 복사하면 안 됨
- 현재 알고리즘이 이미 최적이면, 알고리즘은 유지하되 코드 품질 개선(명확한 변수명/최소 스코프/구조 정리)을 반영
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
  "time_complexity": "O(...)",
  "space_complexity": "O(...)",
  "answer_code": "코드 문자열",
  "inline_suggestions": [{"path":"파일경로","line":1,"body":"코멘트"}]
}

제약:
- inline_suggestions 최대 4개
- inline_suggestions.path는 허용 라인에 나온 파일 경로 중 하나와 정확히 일치
- summary_markdown은 4개 섹션만 간결히 작성 (900자 이내)
- summary_markdown은 "왜 정답인지/복잡도/코드 품질/대안 접근"을 각각 한 단락 이상 포함
- time_complexity/space_complexity는 Big-O 표기 포함
- answer_code는 실제 줄바꿈을 사용한 여러 줄 코드로 작성 ("\\n" 문자열 금지)
- inline_suggestions가 1개 이상이면 answer_code에는 그 개선사항이 반드시 반영되어야 함
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

function isUnavailableAnswerCode(answerCode: string): boolean {
  const normalized = answerCode.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.includes("answer_code unavailable") ||
    normalized === "n/a" ||
    normalized === "na" ||
    normalized === "none"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildResponseSchema() {
  return {
    type: "OBJECT",
    properties: {
      summary_markdown: { type: "STRING" },
      time_complexity: { type: "STRING" },
      space_complexity: { type: "STRING" },
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
    required: [
      "summary_markdown",
      "time_complexity",
      "space_complexity",
      "answer_code",
      "inline_suggestions"
    ]
  };
}

function buildAnswerCodeSchema() {
  return {
    type: "OBJECT",
    properties: {
      answer_code: { type: "STRING" }
    },
    required: ["answer_code"]
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
  private readonly jsonRepairTimeoutMs: number;
  private readonly answerCodeTimeoutMs: number;
  private readonly complexityTimeoutMs: number;
  private readonly useStreaming: boolean;

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
    this.jsonRepairTimeoutMs = toPositiveInt(process.env.GEMINI_JSON_REPAIR_TIMEOUT_MS, 12000);
    this.answerCodeTimeoutMs = toPositiveInt(process.env.GEMINI_ANSWER_CODE_TIMEOUT_MS, 15000);
    this.complexityTimeoutMs = toPositiveInt(process.env.GEMINI_COMPLEXITY_TIMEOUT_MS, 8000);
    this.useStreaming = (process.env.GEMINI_STREAMING ?? "1").trim() !== "0";
  }

  private async requestUnary(
    model: string,
    prompt: string,
    timeoutMs: number,
    generationConfig: GeminiGenerationConfig
  ): Promise<GeminiRequestResult> {
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
          generationConfig
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
        console.error("Gemini response was empty", {
          model,
          finishReason: json.candidates?.[0]?.finishReason,
          finishMessage: json.candidates?.[0]?.finishMessage,
          usageMetadata: json.usageMetadata
        });
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

  private async requestStream(
    model: string,
    prompt: string,
    timeoutMs: number,
    generationConfig: GeminiGenerationConfig
  ): Promise<GeminiRequestResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 30000);

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
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
          generationConfig
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 429) {
          console.error("Gemini stream request rate limited", {
            model,
            timeoutMs,
            status: response.status,
            body: body.slice(0, 500)
          });
          return { kind: "rate_limited" };
        }

        console.error("Gemini stream request failed", {
          model,
          timeoutMs,
          status: response.status,
          body: body.slice(0, 500)
        });
        return { kind: "failed" };
      }

      if (!response.body) {
        console.error("Gemini stream response body was empty", { model, timeoutMs });
        return { kind: "failed" };
      }

      const state: GeminiStreamState = { rawText: "" };
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        let boundaryIndex = sseBuffer.indexOf("\n\n");
        while (boundaryIndex >= 0) {
          const eventChunk = sseBuffer.slice(0, boundaryIndex);
          sseBuffer = sseBuffer.slice(boundaryIndex + 2);

          const events = parseSseEventChunk(eventChunk);
          for (const event of events) {
            updateStreamStateFromChunk(state, event);
          }

          boundaryIndex = sseBuffer.indexOf("\n\n");
        }
      }

      sseBuffer += decoder.decode();
      const tailEvents = parseSseEventChunk(sseBuffer);
      for (const event of tailEvents) {
        updateStreamStateFromChunk(state, event);
      }

      if (!state.rawText.trim()) {
        console.error("Gemini stream response was empty", {
          model,
          timeoutMs,
          finishReason: state.finishReason,
          finishMessage: state.finishMessage,
          usageMetadata: state.usageMetadata
        });
        return { kind: "failed" };
      }

      if (state.finishReason && state.finishReason !== "STOP") {
        console.warn("Gemini stream finished with non-STOP reason", {
          model,
          finishReason: state.finishReason,
          finishMessage: state.finishMessage,
          usageMetadata: state.usageMetadata
        });
      }

      return { kind: "ok", raw: state.rawText };
    } catch (error) {
      console.error("Gemini stream request failed", {
        model,
        timeoutMs,
        message: error instanceof Error ? error.message : String(error)
      });
      return { kind: "failed" };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(
    model: string,
    prompt: string,
    timeoutMs: number,
    generationConfig: GeminiGenerationConfig = this.buildGenerationConfig()
  ): Promise<GeminiRequestResult> {
    if (this.useStreaming) {
      const streamed = await this.requestStream(model, prompt, timeoutMs, generationConfig);
      if (streamed.kind !== "failed") return streamed;

      console.warn("Gemini stream request failed, falling back to unary request", {
        model
      });
    }

    return this.requestUnary(model, prompt, timeoutMs, generationConfig);
  }

  private buildJsonRepairPrompt(raw: string): string {
    const sample = raw.slice(0, 14000);
    return `
다음 텍스트를 **의미를 유지한 채** 유효한 JSON 객체 1개로 복구하라.
출력은 JSON만 허용하며 코드펜스/설명 금지.

필수 키:
- summary_markdown (string)
- time_complexity (string)
- space_complexity (string)
- answer_code (string)
- inline_suggestions (array of {path:string,line:number,body:string})

규칙:
- 누락된 값이 있으면 최소값으로 채운다.
  - summary_markdown: "리뷰 요약 생성 중 일부 정보가 손실되었습니다."
  - time_complexity: "O(unknown)"
  - space_complexity: "O(unknown)"
  - answer_code: "/* answer_code unavailable */"
  - inline_suggestions: []
- inline_suggestions.line은 정수만 허용
- 반드시 JSON 문법을 지켜라.

원문:
${sample}
`;
  }

  private async repairMalformedJson(model: string, raw: string): Promise<GeminiResponseShape | null> {
    const result = await this.requestWithRateLimitRetry(
      model,
      this.buildJsonRepairPrompt(raw),
      this.jsonRepairTimeoutMs
    );
    if (result.kind !== "ok") return null;
    return parseResponse(result.raw);
  }

  private buildAnswerCodeOnlyPrompt(input: AiReviewInput): string {
    return `
당신은 코딩 테스트 코드 생성 어시스턴트다.
반드시 JSON 객체 하나만 출력한다. 설명/코드펜스 금지.

응답 스키마:
{
  "answer_code": "실행 가능한 ${input.language} 코드"
}

규칙:
- answer_code에는 실제 줄바꿈을 사용한다. ("\\n" 문자열 금지)
- 문제를 해결하는 완전한 코드를 작성한다.
- 부가 설명은 금지한다.

문제 문서:
${input.problemMarkdown}

PR 본문:
${input.prBody}

ASK:
${input.askRequest?.trim() || "없음"}

변경 코드:
${input.changedCodePrompt}
`;
  }

  private buildAnswerCodeGenerationConfig(): GeminiGenerationConfig {
    return {
      temperature: 0.1,
      maxOutputTokens: Math.min(this.maxOutputTokens, 3072),
      responseMimeType: "application/json",
      responseSchema: buildAnswerCodeSchema()
    };
  }

  private buildComplexitySchema() {
    return {
      type: "OBJECT",
      properties: {
        time_complexity: { type: "STRING" },
        space_complexity: { type: "STRING" }
      },
      required: ["time_complexity", "space_complexity"]
    };
  }

  private buildComplexityPrompt(input: AiReviewInput): string {
    return `
코딩 테스트 풀이의 복잡도만 추정하라.
반드시 JSON 객체 하나만 출력한다. 설명/코드펜스 금지.

응답 스키마:
{
  "time_complexity": "O(...)",
  "space_complexity": "O(...)"
}

규칙:
- Big-O 표기 필수
- 보수적으로 추정

문제 문서:
${input.problemMarkdown}

변경 코드:
${input.changedCodePrompt}
`;
  }

  private async recoverComplexity(
    model: string,
    input: AiReviewInput
  ): Promise<{ time: string; space: string } | null> {
    const prompt = limitPrompt(this.buildComplexityPrompt(input), this.maxPromptChars);
    const result = await this.requestWithRateLimitRetry(model, prompt, this.complexityTimeoutMs, {
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: "application/json",
      responseSchema: this.buildComplexitySchema()
    });
    if (result.kind !== "ok") return null;

    const parsed = parseResponse(result.raw);
    if (!parsed) return null;
    return {
      time: parsed.time_complexity.trim() || "O(unknown)",
      space: parsed.space_complexity.trim() || "O(unknown)"
    };
  }

  private async recoverAnswerCode(model: string, input: AiReviewInput): Promise<string | null> {
    const prompt = limitPrompt(this.buildAnswerCodeOnlyPrompt(input), this.maxPromptChars);
    const result = await this.requestWithRateLimitRetry(
      model,
      prompt,
      this.answerCodeTimeoutMs,
      this.buildAnswerCodeGenerationConfig()
    );
    if (result.kind !== "ok") return null;
    return parseAnswerCodeOnly(result.raw);
  }

  private async finalizeResult(
    model: string,
    input: AiReviewInput,
    parsed: GeminiResponseShape
  ): Promise<AiReviewResult> {
    let answerCode = parsed.answer_code.trim();
    let timeComplexity = parsed.time_complexity.trim() || "O(unknown)";
    let spaceComplexity = parsed.space_complexity.trim() || "O(unknown)";

    if (timeComplexity === "O(unknown)" || spaceComplexity === "O(unknown)") {
      const recoveredComplexity = await this.recoverComplexity(model, input);
      if (recoveredComplexity) {
        timeComplexity = recoveredComplexity.time;
        spaceComplexity = recoveredComplexity.space;
      }
    }

    if (isUnavailableAnswerCode(answerCode)) {
      const recovered = await this.recoverAnswerCode(model, input);
      if (recovered) {
        answerCode = recovered.trim();
      }
    }

    return {
      summaryMarkdown: parsed.summary_markdown.trim(),
      timeComplexity,
      spaceComplexity,
      answerCode,
      inlineSuggestions: normalizeInline(parsed.inline_suggestions)
    };
  }

  private async requestWithRateLimitRetry(
    model: string,
    prompt: string,
    timeoutMs: number,
    generationConfig?: GeminiGenerationConfig
  ): Promise<GeminiRequestResult> {
    let attempt = 0;
    while (true) {
      const result = await this.request(model, prompt, timeoutMs, generationConfig);
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

    let primaryHadUnusableResponse = false;
    let primaryRateLimited = false;

    for (const prompt of prompts) {
      const result = await this.requestWithRateLimitRetry(primaryModel.name, prompt, primaryModel.timeoutMs);
      if (result.kind === "rate_limited") {
        primaryRateLimited = true;
        break;
      }

      if (result.kind === "failed") {
        primaryHadUnusableResponse = true;
        continue;
      }

      const parsed = parseResponse(result.raw);
      if (parsed) {
        return this.finalizeResult(primaryModel.name, input, parsed);
      }

      console.error("Gemini response JSON parse failed", {
        model: primaryModel.name,
        preview: previewText(result.raw)
      });

      const repaired = await this.repairMalformedJson(primaryModel.name, result.raw);
      if (repaired) {
        return this.finalizeResult(primaryModel.name, input, repaired);
      }
      primaryHadUnusableResponse = true;
    }

    if (primaryRateLimited) return null;
    if (!fallbackModel || !primaryHadUnusableResponse) return null;

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
        return this.finalizeResult(fallbackModel.name, input, parsed);
      }

      console.error("Gemini response JSON parse failed", {
        model: fallbackModel.name,
        preview: previewText(result.raw)
      });

      const repaired = await this.repairMalformedJson(fallbackModel.name, result.raw);
      if (repaired) {
        return this.finalizeResult(fallbackModel.name, input, repaired);
      }
    }

    if (fallbackRateLimited) return null;
    return null;
  }
}
