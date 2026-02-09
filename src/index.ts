import { Probot } from "probot";
import { generateAiReview } from "./ai/index.js";
import { crawlProblem } from "./crawlers.js";
import {
  buildChangedCodePrompt,
  commitFilesToPrBranch,
  createInlineReview,
  loadChangedFilesForReview,
  loadPrimaryJavaCode,
  removeTemplateCheckComment,
  upsertAiReviewComment,
  upsertFileLevelReviewComment,
  upsertTemplateCheckComment,
  upsertTemplateCheckCommentForIssue
} from "./github.js";
import { buildProblemMarkdown, sanitizeProblemTitle } from "./markdown.js";
import { hasRequiredTemplateFields, parsePrBody } from "./parser.js";

const REQUIRED_TEMPLATE_GUIDE = `
PR 본문에 아래 필드를 채워주세요.

- Site: BOJ | PROGRAMMERS
- Problem Number: 예) 10546
- Language: Java
`;

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

export default (app: Probot): void => {
  app.on("push", async (context) => {
    if (context.payload.sender?.type === "Bot") return;
    if (!context.payload.ref.startsWith("refs/heads/")) return;

    const [owner, repo] = context.payload.repository.full_name.split("/");
    const branch = context.payload.ref.replace("refs/heads/", "");

    const openPulls = await context.octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${owner}:${branch}`,
      per_page: 20
    });

    for (const pull of openPulls.data) {
      const metadata = parsePrBody(pull.body);
      if (hasRequiredTemplateFields(metadata)) continue;

      await upsertTemplateCheckCommentForIssue(
        context.octokit,
        owner,
        repo,
        pull.number,
        REQUIRED_TEMPLATE_GUIDE
      );
    }
  });

  app.on(["pull_request.opened", "pull_request.edited", "pull_request.synchronize"], async (context) => {
    if (context.payload.sender?.type === "Bot") return;

    if (!context.payload.pull_request.head.repo || !context.payload.pull_request.base.repo) {
      await upsertAiReviewComment(context, "PR 저장소 정보를 확인할 수 없습니다.");
      return;
    }

    const isForkPr =
      context.payload.pull_request.head.repo.full_name !== context.payload.pull_request.base.repo.full_name;
    if (isForkPr) {
      await upsertAiReviewComment(context, "현재 앱은 fork PR을 지원하지 않습니다.");
      return;
    }

    const metadata = parsePrBody(context.payload.pull_request.body);
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
        prBody: context.payload.pull_request.body || "",
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
  });
};
