import { Buffer } from "node:buffer";
import type { Context } from "probot";

const TEMPLATE_COMMENT_MARKER = "<!-- ct-assistant:template-check -->";
const REVIEW_COMMENT_MARKER = "<!-- ct-assistant:ai-review -->";
const LINE_REVIEW_MARKER = "<!-- ct-assistant:inline-review -->";
const FILE_REVIEW_MARKER = "<!-- ct-assistant:file-review -->";

export type PullRequestContext = Context<
  "pull_request.opened" | "pull_request.edited" | "pull_request.synchronize"
>;

type OctokitClient = PullRequestContext["octokit"];

export interface ChangedFileForReview {
  path: string;
  patch: string;
  addedLines: number[];
  content: string;
}

export interface InlineReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface InlineReviewResult {
  posted: boolean;
  reason: "posted" | "no_valid_comments" | "already_posted";
  validComments: InlineReviewComment[];
}

interface FileLineIndex {
  path: string;
  normalizedPath: string;
  basename: string;
  rightLines: number[];
}

function isGeneratedProblemJavaFile(path: string): boolean {
  return /^(백준|프로그래머스)\/[^/]+\/[^/]+\.java$/.test(path);
}
async function upsertIssueComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  bodyWithoutMarker: string
): Promise<void> {
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100
  });

  const existing = comments.data.find(
    (comment) => comment.body?.includes(marker) && comment.user?.type === "Bot"
  );

  const finalBody = `${marker}\n${bodyWithoutMarker}`;
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: finalBody
    });
    return;
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: finalBody
  });
}

function parseAddedLinesFromPatch(patch: string): number[] {
  const lines = patch.split("\n");
  const added: number[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      if (!match) {
        inHunk = false;
        continue;
      }
      newLine = Number(match[1]) - 1;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLine += 1;
      added.push(newLine);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    newLine += 1;
  }

  return added;
}

function parseRightSideLinesFromPatch(patch: string): number[] {
  const lines = patch.split("\n");
  const right = new Set<number>();
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      if (!match) {
        inHunk = false;
        continue;
      }
      newLine = Number(match[1]) - 1;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLine += 1;
      right.add(newLine);
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    if (line.startsWith(" ")) {
      newLine += 1;
      right.add(newLine);
    }
  }

  return [...right].sort((a, b) => a - b);
}

function normalizePathForMatch(path: string): string {
  let normalized = path.trim().replace(/\\/g, "/");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^\/+/, "");
  return normalized;
}

function buildFileLineIndexes(changedFiles: ChangedFileForReview[]): FileLineIndex[] {
  return changedFiles.map((file) => {
    const normalizedPath = normalizePathForMatch(file.path);
    const basename = normalizedPath.split("/").pop() || normalizedPath;
    const rightLines = parseRightSideLinesFromPatch(file.patch);
    return {
      path: file.path,
      normalizedPath,
      basename,
      rightLines
    };
  });
}

function resolvePathForInlineComment(requestedPath: string, indexes: FileLineIndex[]): string | null {
  const requested = normalizePathForMatch(requestedPath);
  if (!requested) return null;

  const exact = indexes.find((item) => item.normalizedPath === requested);
  if (exact) return exact.path;

  const suffixMatched = indexes.filter(
    (item) =>
      item.normalizedPath.endsWith(`/${requested}`) || requested.endsWith(`/${item.normalizedPath}`)
  );
  if (suffixMatched.length === 1) return suffixMatched[0].path;

  const basename = requested.split("/").pop() || requested;
  const basenameMatched = indexes.filter((item) => item.basename === basename);
  if (basenameMatched.length === 1) return basenameMatched[0].path;

  if (indexes.length === 1) return indexes[0].path;
  return null;
}

function findClosestReviewLine(targetLine: number, rightLines: number[]): number | null {
  if (!Number.isInteger(targetLine) || targetLine <= 0) return null;
  if (rightLines.length === 0) return null;
  if (rightLines.includes(targetLine)) return targetLine;

  let bestLine = rightLines[0];
  let bestDistance = Math.abs(bestLine - targetLine);
  for (const line of rightLines) {
    const distance = Math.abs(line - targetLine);
    if (distance < bestDistance) {
      bestLine = line;
      bestDistance = distance;
    }
  }

  // 과도한 점프를 막기 위해 너무 먼 라인은 버린다.
  if (bestDistance > 20) return null;
  return bestLine;
}

async function getTextFileContent(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  ref: string,
  path: string
): Promise<string | null> {
  try {
    const content = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref
    });

    if (Array.isArray(content.data) || content.data.type !== "file" || !content.data.content) {
      return null;
    }

    return Buffer.from(content.data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function listPullFiles(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number
) {
  const files: Awaited<ReturnType<OctokitClient["rest"]["pulls"]["listFiles"]>>["data"] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page
    });
    files.push(...response.data);
    if (response.data.length < 100) break;
    page += 1;
  }

  return files;
}

async function listPullReviews(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  pullNumber: number
) {
  const reviews: Awaited<ReturnType<OctokitClient["rest"]["pulls"]["listReviews"]>>["data"] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page
    });
    reviews.push(...response.data);
    if (response.data.length < 100) break;
    page += 1;
  }

  return reviews;
}

export async function upsertTemplateCheckComment(context: PullRequestContext, body: string): Promise<void> {
  await upsertIssueComment(
    context.octokit,
    context.payload.repository.owner.login,
    context.payload.repository.name,
    context.payload.pull_request.number,
    TEMPLATE_COMMENT_MARKER,
    body
  );
}

export async function upsertTemplateCheckCommentForIssue(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  await upsertIssueComment(octokit, owner, repo, issueNumber, TEMPLATE_COMMENT_MARKER, body);
}

export async function upsertAiReviewComment(context: PullRequestContext, body: string): Promise<void> {
  await upsertIssueComment(
    context.octokit,
    context.payload.repository.owner.login,
    context.payload.repository.name,
    context.payload.pull_request.number,
    REVIEW_COMMENT_MARKER,
    body
  );
}

export async function upsertFileLevelReviewComment(
  context: PullRequestContext,
  comments: InlineReviewComment[]
): Promise<void> {
  const grouped = new Map<string, InlineReviewComment[]>();
  for (const item of comments) {
    const list = grouped.get(item.path) ?? [];
    list.push(item);
    grouped.set(item.path, list);
  }

  const bodyLines: string[] = [];
  bodyLines.push("인라인 라인 매칭이 어려워 파일 단위 코멘트로 남깁니다.");
  for (const [path, list] of grouped) {
    bodyLines.push(`\n### ${path}`);
    for (const item of list.slice(0, 5)) {
      bodyLines.push(`- (제안 라인 ${item.line}) ${item.body}`);
    }
  }

  await upsertIssueComment(
    context.octokit,
    context.payload.repository.owner.login,
    context.payload.repository.name,
    context.payload.pull_request.number,
    FILE_REVIEW_MARKER,
    bodyLines.join("\n")
  );
}

export async function removeTemplateCheckComment(context: PullRequestContext): Promise<void> {
  const issueNumber = context.payload.pull_request.number;
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;

  const comments = await context.octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100
  });

  const matched = comments.data.find(
    (comment) => comment.body?.includes(TEMPLATE_COMMENT_MARKER) && comment.user?.type === "Bot"
  );
  if (!matched) return;

  await context.octokit.rest.issues.deleteComment({
    owner,
    repo,
    comment_id: matched.id
  });
}

export async function loadChangedFilesForReview(
  context: PullRequestContext,
  maxFiles = 8,
  maxCharsPerFile = 3500
): Promise<ChangedFileForReview[]> {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const pullNumber = context.payload.pull_request.number;
  const ref = context.payload.pull_request.head.ref;

  const files = await listPullFiles(context.octokit, owner, repo, pullNumber);

  const nonGeneratedCodeFiles = files
    .filter((file) => file.status !== "removed")
    .filter((file) => !isGeneratedProblemJavaFile(file.filename))
    .filter((file) => /\.(java|kt|py|cpp|c|js|ts|go|rs)$/.test(file.filename))
    .slice(0, maxFiles);

  const codeFiles =
    nonGeneratedCodeFiles.length > 0
      ? nonGeneratedCodeFiles
      : files
          .filter((file) => file.status !== "removed")
          .filter((file) => /\.(java|kt|py|cpp|c|js|ts|go|rs)$/.test(file.filename))
          .slice(0, maxFiles);

  const results: ChangedFileForReview[] = [];
  for (const file of codeFiles) {
    const raw = await getTextFileContent(context.octokit, owner, repo, ref, file.filename);
    if (!raw) continue;

    results.push({
      path: file.filename,
      patch: file.patch ?? "",
      addedLines: file.patch ? parseAddedLinesFromPatch(file.patch) : [],
      content: raw.slice(0, maxCharsPerFile)
    });
  }

  return results;
}

export function buildChangedCodePrompt(files: ChangedFileForReview[]): string {
  if (files.length === 0) return "코드 정보를 불러오지 못했습니다.";

  return files
    .map(
      (file) =>
        `FILE: ${file.path}\nADDED_LINES: ${file.addedLines.join(",") || "none"}\nPATCH:\n${file.patch}\n\nCODE:\n${file.content}`
    )
    .join("\n\n---\n\n");
}

export async function loadPrimaryJavaCode(context: PullRequestContext): Promise<string | null> {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const pullNumber = context.payload.pull_request.number;
  const ref = context.payload.pull_request.head.ref;

  const files = await listPullFiles(context.octokit, owner, repo, pullNumber);

  const preferredJavaFile = files.find(
    (file) => file.status !== "removed" && file.filename.endsWith(".java") && !isGeneratedProblemJavaFile(file.filename)
  );
  const fallbackJavaFile = files.find((file) => file.status !== "removed" && file.filename.endsWith(".java"));
  const javaFile = preferredJavaFile ?? fallbackJavaFile;
  if (!javaFile) return null;

  return getTextFileContent(context.octokit, owner, repo, ref, javaFile.filename);
}

export async function commitFilesToPrBranch(
  context: PullRequestContext,
  message: string,
  files: Array<{ path: string; content: string }>
): Promise<boolean> {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const branch = context.payload.pull_request.head.ref;

  const unchangedResults = await Promise.all(
    files.map(async (file) => {
      const existing = await getTextFileContent(context.octokit, owner, repo, branch, file.path);
      return existing === file.content;
    })
  );
  if (unchangedResults.every(Boolean)) return false;

  const ref = await context.octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`
  });

  const baseCommitSha = ref.data.object.sha;
  const baseCommit = await context.octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseCommitSha
  });

  const tree = await context.octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.data.tree.sha,
    tree: files.map((file) => ({
      path: file.path,
      mode: "100644",
      type: "blob",
      content: file.content
    }))
  });

  const commit = await context.octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.data.sha,
    parents: [baseCommitSha]
  });

  await context.octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: false
  });

  return true;
}

export async function createInlineReview(
  context: PullRequestContext,
  summaryBody: string,
  comments: InlineReviewComment[],
  changedFiles: ChangedFileForReview[]
): Promise<InlineReviewResult> {
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const pullNumber = context.payload.pull_request.number;
  const latestPull = await context.octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  });
  const headSha = latestPull.data.head.sha;

  const indexes = buildFileLineIndexes(changedFiles);
  const rightLinesByPath = new Map(indexes.map((item) => [item.path, item.rightLines]));

  const resolved = new Map<string, InlineReviewComment>();
  for (const item of comments) {
    const body = item.body.trim();
    if (!body) continue;

    const resolvedPath = resolvePathForInlineComment(item.path, indexes);
    if (!resolvedPath) continue;

    const rightLines = rightLinesByPath.get(resolvedPath) || [];
    const resolvedLine = findClosestReviewLine(item.line, rightLines);
    if (!resolvedLine) continue;

    const key = `${resolvedPath}:${resolvedLine}`;
    resolved.set(key, {
      path: resolvedPath,
      line: resolvedLine,
      body
    });
  }

  const validComments = [...resolved.values()].slice(0, 8);

  if (validComments.length === 0) {
    return {
      posted: false,
      reason: "no_valid_comments",
      validComments: []
    };
  }

  const reviews = await listPullReviews(context.octokit, owner, repo, pullNumber);

  const alreadyPosted = reviews.some(
    (review) =>
      review.user?.type === "Bot" &&
      review.commit_id === headSha &&
      (review.body ?? "").includes(LINE_REVIEW_MARKER)
  );
  if (alreadyPosted) {
    return {
      posted: false,
      reason: "already_posted",
      validComments
    };
  }

  await context.octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: headSha,
    event: "COMMENT",
    body: `${LINE_REVIEW_MARKER}\n${summaryBody}`,
    comments: validComments.map((item) => ({
      path: item.path,
      line: item.line,
      side: "RIGHT",
      body: item.body
    }))
  });

  return {
    posted: true,
    reason: "posted",
    validComments
  };
}
