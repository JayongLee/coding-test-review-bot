import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { generateAiReview } from "./ai/index.js";
import { crawlProblem } from "./crawlers.js";
import { ensurePrivateKeyLoaded, requireEnv } from "./env.js";
import {
  buildChangedCodePrompt,
  commitFilesToPrBranch,
  createInlineReview,
  loadChangedFilesForReview,
  loadPrimaryJavaCode,
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

const REQUIRED_TEMPLATE_GUIDE = `
PR 본문에 아래 필드를 채워주세요.

- Site: BOJ | PROGRAMMERS
- Problem Number: 예) 10546
- Language: Java
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

function defaultJavaSource(): string {
  return `public class Main {
    public static void main(String[] args) throws Exception {
        // TODO: solve
    }
}
`;
}

function formatAiSummary(summaryMarkdown: string, answerCode: string): string {
  return `${summaryMarkdown}

## 모범 답안 코드
\`\`\`java
${answerCode}
\`\`\`
`;
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

  const promise = (async () => {
    const auth = createAppAuth({
      appId,
      privateKey,
      installationId
    });
    const installationAuth = await auth({ type: "installation" });
    return new Octokit({ auth: installationAuth.token });
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
  if (job.senderType === "Bot") return;

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
    const sourceCode = (await loadPrimaryJavaCode(context)) || defaultJavaSource();

    await commitFilesToPrBranch(context, `docs: sync problem assets for ${folderName}`, [
      { path: `${folderName}/README.md`, content: problemMarkdown },
      { path: `${folderName}/문제.java`, content: sourceCode }
    ]);

    const changedFiles = await loadChangedFilesForReview(context);
    const aiReview = await generateAiReview({
      problemMarkdown,
      prBody: pull.body || "",
      language: metadata.language || "Java",
      changedCodePrompt: buildChangedCodePrompt(changedFiles),
      reviewTargets: changedFiles
    });

    if (!aiReview) {
      await upsertAiReviewComment(
        context,
        "AI 리뷰를 생성하지 못했습니다. `AI_PROVIDER`, `OPENAI_API_KEY` 설정을 확인해주세요."
      );
      return;
    }

    const summaryBody = formatAiSummary(aiReview.summaryMarkdown, aiReview.answerCode);
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
