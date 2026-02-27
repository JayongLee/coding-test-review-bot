import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { generateAiReview } from "./ai/index.js";
import { crawlProblem } from "./crawlers.js";
import { ensurePrivateKeyLoaded, requireEnv, resolveGithubApiBaseUrl } from "./env.js";
import {
  buildChangedCodePrompt,
  commitFilesToPrBranch,
  createInlineReview,
  loadChangedFilesForReview,
  loadPrimaryCode,
  removeTemplateCheckComment,
  type PullRequestContext,
  upsertAiReviewComment,
  upsertFileLevelReviewComment,
  upsertTemplateCheckComment,
  upsertTemplateCheckCommentForIssue
} from "./github.js";
import type { WorkerJob } from "./jobs.js";
import { buildProblemMarkdown, sanitizeProblemTitle } from "./markdown.js";
import { hasRequiredTemplateFields, parsePrBody } from "./parser.js";
import type { SupportedSite } from "./types.js";

const REQUIRED_TEMPLATE_GUIDE = `
PR 본문에 아래 필드를 채워주세요.

- Site: BOJ | PROGRAMMERS
- Problem Number: 예) 10546
- URL: BOJ는 https://www.acmicpc.net/problem/{문제번호}, PROGRAMMERS는 https://school.programmers.co.kr/learn/courses/30/lessons/{문제번호}
- Language: Java
- ASK > 피드백 요청할 부분: 예) 시간복잡도 개선 관점으로 집중 리뷰
`;

interface SqsRecordLike {
  messageId: string;
  body: string;
}

interface SqsEventLike {
  Records: SqsRecordLike[];
}

interface BatchResponseLike {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

const octokitCache = new Map<number, Promise<Octokit>>();

function buildFolderName(problemNumber: string, title: string): string {
  const sanitizedTitle = sanitizeProblemTitle(title) || "문제";
  return `${problemNumber}.${sanitizedTitle}`;
}

function buildSiteRootFolder(site: SupportedSite): string {
  return site === "PROGRAMMERS" ? "프로그래머스" : "백준";
}

type SupportedReviewLanguage = "Java" | "Python" | "C++";

interface LanguageProfile {
  name: SupportedReviewLanguage;
  codeFence: "java" | "python" | "cpp";
  extension: ".java" | ".py" | ".cpp";
  fallbackTemplate: string;
}

function resolveLanguageProfile(rawLanguage?: string): LanguageProfile {
  const raw = (rawLanguage || "").trim().toLowerCase();

  if (/python/.test(raw)) {
    return {
      name: "Python",
      codeFence: "python",
      extension: ".py",
      fallbackTemplate: `import sys

def solve() -> None:
    # TODO: solve
    pass

if __name__ == "__main__":
    solve()
`
    };
  }

  if (/c\+\+|cpp|g\+\+|clang\+\+/.test(raw)) {
    return {
      name: "C++",
      codeFence: "cpp",
      extension: ".cpp",
      fallbackTemplate: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // TODO: solve
    return 0;
}
`
    };
  }

  return {
    name: "Java",
    codeFence: "java",
    extension: ".java",
    fallbackTemplate: `class Main {
    public static void main(String[] args) throws Exception {
        // TODO: solve
    }
}
`
  };
}

function stripOuterCodeFence(code: string): string {
  const trimmed = code.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```[a-zA-Z0-9_+-]*\s*/i, "").replace(/\s*```$/, "").trim();
}

function decodeEscapedLayoutOutsideStrings(code: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const next = i + 1 < code.length ? code[i + 1] : "";

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      if (!inSingle && !inDouble) {
        if (next === "n") {
          out += "\n";
          i += 1;
          continue;
        }
        if (next === "r") {
          i += 1;
          continue;
        }
        if (next === "t") {
          out += "  ";
          i += 1;
          continue;
        }
      }
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }

    out += ch;
  }

  return out;
}

function formatMinifiedCStyleCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.includes("\n")) return trimmed;
  if (trimmed.length < 200) return trimmed;

  let raw = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let parenDepth = 0;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    if (escaped) {
      raw += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      raw += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      raw += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      raw += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === "(") {
        parenDepth += 1;
      } else if (ch === ")") {
        parenDepth = Math.max(parenDepth - 1, 0);
      }

      if (ch === "{") {
        raw += "{\n";
        continue;
      }
      if (ch === "}") {
        raw += "\n}\n";
        continue;
      }
      if (ch === ";" && parenDepth === 0) {
        raw += ";\n";
        continue;
      }
    }

    raw += ch;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const formatted: string[] = [];
  let indent = 0;
  for (const line of lines) {
    if (line.startsWith("}")) {
      indent = Math.max(indent - 1, 0);
    }

    formatted.push(`${"  ".repeat(indent)}${line}`);

    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;
    indent = Math.max(indent + opens - closes, 0);
  }

  return formatted.join("\n");
}

function normalizeAnswerCodeForDisplay(answerCode: string, codeFence: LanguageProfile["codeFence"]): string {
  let normalized = stripOuterCodeFence(answerCode);

  // Safety: occasionally the whole code is wrapped as a JSON string literal.
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    try {
      const decoded = JSON.parse(normalized);
      if (typeof decoded === "string" && decoded.trim().length > 0) {
        normalized = decoded;
      }
    } catch {
      // ignore and keep original
    }
  }

  normalized = decodeEscapedLayoutOutsideStrings(normalized);

  if ((codeFence === "java" || codeFence === "cpp") && !normalized.includes("\n")) {
    normalized = formatMinifiedCStyleCode(normalized);
  }

  return normalized.trim();
}

function normalizeComplexity(value: string | undefined): string {
  const normalized = (value || "").trim();
  if (!normalized) return "O(unknown)";
  return normalized;
}

function formatAiSummary(
  summaryMarkdown: string,
  timeComplexity: string,
  spaceComplexity: string,
  answerCode: string,
  codeFence: LanguageProfile["codeFence"]
): string {
  const normalizedAnswerCode = normalizeAnswerCodeForDisplay(answerCode, codeFence);
  return `${summaryMarkdown}

## 시간/공간 복잡도 평가
- 시간 복잡도: ${normalizeComplexity(timeComplexity)}
- 공간 복잡도: ${normalizeComplexity(spaceComplexity)}

## 모범 답안 코드
\`\`\`${codeFence}
${normalizedAnswerCode}
\`\`\`
`;
}

function normalizeForCodeComparison(code: string): string {
  return code.replace(/\s+/g, "");
}

function isAnswerCodeTooSimilar(answerCode: string, originalCode: string): boolean {
  if (!answerCode || !originalCode) return false;
  const normalizedAnswer = normalizeForCodeComparison(answerCode);
  const normalizedOriginal = normalizeForCodeComparison(originalCode);
  if (!normalizedAnswer || !normalizedOriginal) return false;
  return normalizedAnswer === normalizedOriginal;
}

function buildForcedRewriteAsk(userAsk?: string): string {
  const extra = [
    "모범답안(answer_code)은 원본 코드와 동일하면 안 됩니다.",
    "inline_suggestions에 제안한 개선점을 실제 코드에 반영해 주세요.",
    "성능/가독성/안정성 중 최소 1개 이상 개선이 드러나야 합니다."
  ].join(" ");
  return userAsk?.trim() ? `${userAsk.trim()}\n\n[추가 요구] ${extra}` : extra;
}

function buildPullRequestContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull: Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"]
): PullRequestContext {
  return {
    octokit,
    payload: {
      repository: {
        owner: { login: owner },
        name: repo
      },
      pull_request: {
        number: pull.number,
        body: pull.body ?? "",
        head: {
          ref: pull.head.ref,
          sha: pull.head.sha,
          repo: pull.head.repo
        },
        base: {
          repo: pull.base.repo
        }
      }
    }
  } as unknown as PullRequestContext;
}

function parseWorkerJob(body: string): WorkerJob {
  const parsed = JSON.parse(body) as WorkerJob;
  if (!parsed || parsed.v !== 1 || !parsed.type || !parsed.installationId || !parsed.owner || !parsed.repo) {
    throw new Error("Invalid worker job payload");
  }
  return parsed;
}

async function getOctokitForInstallation(installationId: number): Promise<Octokit> {
  const cached = octokitCache.get(installationId);
  if (cached) return cached;

  const appId = requireEnv("APP_ID");
  const privateKey = ensurePrivateKeyLoaded();

  const baseUrl = resolveGithubApiBaseUrl();
  const promise = (async () => {
    const auth = createAppAuth({
      appId,
      privateKey,
      installationId
    });
    const installationAuth = await auth({ type: "installation" });
    return new Octokit({
      auth: installationAuth.token,
      ...(baseUrl ? { baseUrl } : {})
    });
  })();

  octokitCache.set(installationId, promise);
  return promise;
}

async function handlePushJob(job: WorkerJob, octokit: Octokit): Promise<void> {
  if (job.type !== "push") return;
  if (!job.branch) return;

  const openPulls = await octokit.rest.pulls.list({
    owner: job.owner,
    repo: job.repo,
    state: "open",
    head: `${job.owner}:${job.branch}`,
    per_page: 20
  });

  for (const pull of openPulls.data) {
    const metadata = parsePrBody(pull.body);
    if (hasRequiredTemplateFields(metadata)) continue;

    await upsertTemplateCheckCommentForIssue(
      octokit as unknown as PullRequestContext["octokit"],
      job.owner,
      job.repo,
      pull.number,
      REQUIRED_TEMPLATE_GUIDE
    );
  }
}

async function handlePullRequestJob(job: WorkerJob, octokit: Octokit): Promise<void> {
  if (job.type !== "pull_request") return;
  if (job.senderType === "Bot" && job.action !== "opened") return;

  const pull = (
    await octokit.rest.pulls.get({
      owner: job.owner,
      repo: job.repo,
      pull_number: job.pullNumber
    })
  ).data;

  const context = buildPullRequestContext(octokit, job.owner, job.repo, pull);

  if (!pull.head.repo || !pull.base.repo) {
    await upsertAiReviewComment(context, "PR 저장소 정보를 확인할 수 없습니다.");
    return;
  }

  const isForkPr = pull.head.repo.full_name !== pull.base.repo.full_name;
  if (isForkPr) {
    await upsertAiReviewComment(context, "현재 앱은 fork PR을 지원하지 않습니다.");
    return;
  }

  const metadata = parsePrBody(pull.body);
  if (!hasRequiredTemplateFields(metadata)) {
    await upsertTemplateCheckComment(context, REQUIRED_TEMPLATE_GUIDE);
    return;
  }
  await removeTemplateCheckComment(context);

  try {
    const problem = await crawlProblem(metadata);
    const problemMarkdown = buildProblemMarkdown(metadata, problem);
    const folderName = buildFolderName(metadata.problemNumber!, problem.title);
    const siteRoot = buildSiteRootFolder(metadata.site!);
    const fileTitle = sanitizeProblemTitle(problem.title) || "문제";
    const folderPath = `${siteRoot}/${folderName}`;
    const languageProfile = resolveLanguageProfile(metadata.language);
    const sourceCode =
      (await loadPrimaryCode(context, [languageProfile.extension])) || languageProfile.fallbackTemplate;

    await commitFilesToPrBranch(context, `docs: sync problem assets for ${folderName}`, [
      { path: `${folderPath}/README.md`, content: problemMarkdown },
      { path: `${folderPath}/${fileTitle}${languageProfile.extension}`, content: sourceCode }
    ]);

    const changedFiles = await loadChangedFilesForReview(context);
    let aiReview = await generateAiReview({
      problemMarkdown,
      prBody: pull.body || "",
      language: languageProfile.name,
      askRequest: metadata.ask,
      changedCodePrompt: buildChangedCodePrompt(changedFiles),
      reviewTargets: changedFiles
    });

    if (!aiReview) {
      const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
      const model =
        provider === "gemini"
          ? process.env.GEMINI_MODEL || "gemini-2.0-flash"
          : process.env.OPENAI_MODEL || "gpt-4.1-mini";
      const timeout =
        provider === "gemini"
          ? process.env.GEMINI_TIMEOUT_MS || "15000"
          : process.env.OPENAI_TIMEOUT_MS || "15000";
      const hasKey =
        provider === "gemini"
          ? Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0)
          : Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);

      await upsertAiReviewComment(
        context,
        `AI 리뷰를 생성하지 못했습니다. (provider=${provider}, model=${model}, timeoutMs=${timeout}, apiKey=${hasKey ? "set" : "missing"})\nCloudWatch Worker 로그에서 provider 실패 메시지를 확인해주세요.`
      );
      return;
    }

    // If model returns code identical to the submitted code while giving improvements,
    // request one forced rewrite pass so answer_code reflects suggested changes.
    const shouldForceRewrite =
      aiReview.inlineSuggestions.length > 0 && isAnswerCodeTooSimilar(aiReview.answerCode, sourceCode);
    if (shouldForceRewrite) {
      const rewritten = await generateAiReview({
        problemMarkdown,
        prBody: pull.body || "",
        language: languageProfile.name,
        askRequest: buildForcedRewriteAsk(metadata.ask),
        changedCodePrompt: buildChangedCodePrompt(changedFiles),
        reviewTargets: changedFiles
      });

      if (rewritten && !isAnswerCodeTooSimilar(rewritten.answerCode, sourceCode)) {
        aiReview = rewritten;
      }
    }

    const summaryBody = formatAiSummary(
      aiReview.summaryMarkdown,
      aiReview.timeComplexity,
      aiReview.spaceComplexity,
      aiReview.answerCode,
      languageProfile.codeFence
    );
    await upsertAiReviewComment(context, summaryBody);

    const inlineResult = await createInlineReview(
      context,
      "인라인 코멘트를 추가했습니다. 전체 총평과 모범 답안은 AI 리뷰 코멘트를 확인해주세요.",
      aiReview.inlineSuggestions,
      changedFiles
    );

    if (inlineResult.reason === "no_valid_comments" && aiReview.inlineSuggestions.length > 0) {
      await upsertFileLevelReviewComment(context, aiReview.inlineSuggestions);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertAiReviewComment(context, `처리 중 오류가 발생했습니다: ${message}`);
  }
}

async function processJob(job: WorkerJob): Promise<void> {
  const octokit = await getOctokitForInstallation(job.installationId);
  switch (job.type) {
    case "push":
      await handlePushJob(job, octokit);
      return;
    case "pull_request":
      await handlePullRequestJob(job, octokit);
      return;
    default:
      throw new Error(`Unsupported worker job type: ${(job as { type?: string }).type}`);
  }
}

export const handler = async (event: SqsEventLike): Promise<BatchResponseLike> => {
  const failures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const job = parseWorkerJob(record.body);
      await processJob(job);
    } catch (error) {
      console.error("Worker job failed", { messageId: record.messageId, error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
