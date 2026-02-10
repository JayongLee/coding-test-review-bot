import { Buffer } from "node:buffer";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { ensurePrivateKeyLoaded, optionalEnv, requireEnv, resolveGithubApiBaseUrl } from "./env.js";
import { sanitizeProblemTitle } from "./markdown.js";
import type { SupportedSite } from "./types.js";

interface HttpEventLike {
  requestContext?: {
    http?: {
      method?: string;
    };
  };
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface HttpResponseLike {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface SubmissionRequest {
  site: string;
  problemNumber: string;
  problemTitle: string;
  language: string;
  sourceCode: string;
  repoOwner: string;
  repoName: string;
  baseBranch?: string;
  runtime?: string;
  memory?: string;
  submittedAt?: string;
  problemUrl?: string;
  solutionSummary?: string;
  notes?: string;
  externalSubmissionId?: string;
  extensionApiToken?: string;
}

interface SubmissionInput {
  site: SupportedSite;
  problemNumber: string;
  problemTitle: string;
  language: string;
  sourceCode: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  runtime?: string;
  memory?: string;
  submittedAt?: string;
  problemUrl: string;
  solutionSummary?: string;
  notes?: string;
  externalSubmissionId?: string;
}

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
};

function jsonResponse(statusCode: number, payload: unknown): HttpResponseLike {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload)
  };
}

function getHeader(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function normalizeSite(raw: string): SupportedSite | null {
  const value = raw.trim().toUpperCase();
  if (value === "BOJ" || value === "BAEKJOON") return "BOJ";
  if (value === "PROGRAMMERS" || value === "PGM" || value === "PROG" || raw.trim() === "프로그래머스") {
    return "PROGRAMMERS";
  }
  return null;
}

function sanitizeBranchPart(value: string, fallback: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || fallback;
}

function parseBody(event: HttpEventLike): SubmissionRequest {
  const rawBody = event.body ?? "";
  const decodedBody = event.isBase64Encoded ? Buffer.from(rawBody, "base64").toString("utf-8") : rawBody;
  if (!decodedBody) {
    throw new Error("Request body is empty");
  }
  return JSON.parse(decodedBody) as SubmissionRequest;
}

function normalizeOptional(value?: string, maxLength = 500): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function defaultProblemUrl(site: SupportedSite, problemNumber: string): string {
  return site === "PROGRAMMERS"
    ? `https://school.programmers.co.kr/learn/courses/30/lessons/${problemNumber}`
    : `https://www.acmicpc.net/problem/${problemNumber}`;
}

function validateSubmission(request: SubmissionRequest): SubmissionInput {
  const site = normalizeSite(String(request.site || ""));
  if (!site) {
    throw new Error("site must be BOJ or PROGRAMMERS");
  }

  const problemNumber = String(request.problemNumber || "").trim();
  if (!/^\d+$/.test(problemNumber)) {
    throw new Error("problemNumber must be numeric");
  }

  const problemTitle = String(request.problemTitle || "").trim();
  if (!problemTitle) {
    throw new Error("problemTitle is required");
  }

  const language = String(request.language || "").trim() || "Java";
  const sourceCode = String(request.sourceCode || "");
  if (!sourceCode.trim()) {
    throw new Error("sourceCode is required");
  }

  const repoOwner = String(request.repoOwner || "").trim();
  const repoName = String(request.repoName || "").trim();
  if (!repoOwner || !repoName) {
    throw new Error("repoOwner and repoName are required");
  }

  const baseBranchRaw = String(request.baseBranch || "main").trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(baseBranchRaw)) {
    throw new Error("baseBranch format is invalid");
  }
  const baseBranch = baseBranchRaw || "main";
  const runtime = normalizeOptional(request.runtime, 120);
  const memory = normalizeOptional(request.memory, 120);
  const submittedAt = normalizeOptional(request.submittedAt, 120);
  const solutionSummary = normalizeOptional(request.solutionSummary, 3000);
  const notes = normalizeOptional(request.notes, 3000);
  const externalSubmissionId = normalizeOptional(request.externalSubmissionId, 120);
  const problemUrl = normalizeOptional(request.problemUrl, 500) || defaultProblemUrl(site, problemNumber);

  return {
    site,
    problemNumber,
    problemTitle,
    language,
    sourceCode,
    repoOwner,
    repoName,
    baseBranch,
    runtime,
    memory,
    submittedAt,
    problemUrl,
    solutionSummary,
    notes,
    externalSubmissionId
  };
}

function buildPrBody(input: SubmissionInput): string {
  const lines: string[] = [];
  lines.push("## Coding Test Metadata");
  lines.push(`- Site: ${input.site}`);
  lines.push(`- Problem Number: ${input.problemNumber}`);
  lines.push(`- Language: ${input.language}`);

  if (input.runtime) lines.push(`- Runtime: ${input.runtime}`);
  if (input.memory) lines.push(`- Memory: ${input.memory}`);
  if (input.submittedAt) lines.push(`- Submitted At: ${input.submittedAt}`);

  lines.push("");
  lines.push(input.problemUrl);
  lines.push("");

  lines.push("## Solution Summary");
  lines.push(`- 핵심 아이디어: ${input.solutionSummary ?? ""}`);
  lines.push("- 시간 복잡도:");
  lines.push("- 공간 복잡도:");
  lines.push("");

  lines.push("## Notes");
  lines.push(`- 구현 시 고민한 점: ${input.notes ?? ""}`);

  return lines.join("\n");
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

async function buildAppOctokit(): Promise<Octokit> {
  const appId = requireEnv("APP_ID");
  const privateKey = ensurePrivateKeyLoaded();
  const baseUrl = resolveGithubApiBaseUrl();

  const appAuth = createAppAuth({
    appId,
    privateKey
  });

  const authResult = await appAuth({ type: "app" });

  return new Octokit({
    auth: authResult.token,
    ...(baseUrl ? { baseUrl } : {})
  });
}

async function buildInstallationOctokit(owner: string, repo: string): Promise<Octokit> {
  const appId = requireEnv("APP_ID");
  const privateKey = ensurePrivateKeyLoaded();
  const baseUrl = resolveGithubApiBaseUrl();

  const appOctokit = await buildAppOctokit();
  const installation = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
  const installationId = installation.data.id;

  const installationAuth = createAppAuth({
    appId,
    privateKey,
    installationId
  });

  const authResult = await installationAuth({ type: "installation" });

  return new Octokit({
    auth: authResult.token,
    ...(baseUrl ? { baseUrl } : {})
  });
}

async function ensureBranchExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseBranch: string,
  newBranch: string
): Promise<void> {
  const base = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch: baseBranch
  });

  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${newBranch}`,
      sha: base.data.commit.sha
    });
  } catch (error) {
    if (getErrorStatus(error) === 422) return;
    throw error;
  }
}

async function createOrUpdateSourceFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  commitMessage: string
): Promise<void> {
  let existingSha: string | undefined;

  try {
    const existing = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: branch
    });

    if (!Array.isArray(existing.data) && existing.data.type === "file") {
      existingSha = existing.data.sha;
    }
  } catch (error) {
    if (getErrorStatus(error) !== 404) {
      throw error;
    }
  }

  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message: commitMessage,
    content: Buffer.from(content.endsWith("\n") ? content : `${content}\n`, "utf-8").toString("base64"),
    ...(existingSha ? { sha: existingSha } : {})
  });
}

async function findOpenAutoPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  site: SupportedSite,
  problemNumber: string
): Promise<{ htmlUrl: string; number: number } | null> {
  const pulls = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100
  });

  const prefix = `auto/${site.toLowerCase()}/${problemNumber}-`;
  const existing = pulls.find((pull) => {
    const body = pull.body ?? "";
    return (
      pull.head.ref.startsWith(prefix) &&
      body.includes(`- Site: ${site}`) &&
      body.includes(`- Problem Number: ${problemNumber}`)
    );
  });

  if (!existing) return null;
  return {
    htmlUrl: existing.html_url,
    number: existing.number
  };
}

function buildBranchName(input: SubmissionInput): string {
  const site = sanitizeBranchPart(input.site, "site");
  const number = sanitizeBranchPart(input.problemNumber, "problem");
  const suffixSource = input.externalSubmissionId || `${Date.now()}`;
  const suffix = sanitizeBranchPart(suffixSource, "submission");
  return `auto/${site}/${number}-${suffix}`;
}

function buildPrTitle(input: SubmissionInput): string {
  const siteLabel = input.site === "BOJ" ? "백준" : "프로그래머스";
  return `${siteLabel}/${input.problemTitle}/${input.problemNumber}`;
}

async function createSubmissionPullRequest(input: SubmissionInput): Promise<{ url: string; number: number; branch: string }> {
  const octokit = await buildInstallationOctokit(input.repoOwner, input.repoName);

  const existing = await findOpenAutoPullRequest(
    octokit,
    input.repoOwner,
    input.repoName,
    input.site,
    input.problemNumber
  );
  if (existing) {
    return {
      url: existing.htmlUrl,
      number: existing.number,
      branch: "(existing)"
    };
  }

  const branch = buildBranchName(input);
  await ensureBranchExists(octokit, input.repoOwner, input.repoName, input.baseBranch, branch);

  const folderName = `${input.problemNumber}.${sanitizeProblemTitle(input.problemTitle) || "문제"}`;
  const sourcePath = `${folderName}/문제.java`;

  await createOrUpdateSourceFile(
    octokit,
    input.repoOwner,
    input.repoName,
    branch,
    sourcePath,
    input.sourceCode,
    `feat: add ${input.site} ${input.problemNumber} solution`
  );

  const body = buildPrBody(input);

  try {
    const created = await octokit.rest.pulls.create({
      owner: input.repoOwner,
      repo: input.repoName,
      title: buildPrTitle(input),
      head: branch,
      base: input.baseBranch,
      body
    });

    return {
      url: created.data.html_url,
      number: created.data.number,
      branch
    };
  } catch (error) {
    if (getErrorStatus(error) !== 422) throw error;

    const pulls = await octokit.rest.pulls.list({
      owner: input.repoOwner,
      repo: input.repoName,
      head: `${input.repoOwner}:${branch}`,
      state: "open",
      per_page: 1
    });

    const existingPr = pulls.data[0];
    if (!existingPr) throw error;

    return {
      url: existingPr.html_url,
      number: existingPr.number,
      branch
    };
  }
}

function isAuthorized(event: HttpEventLike, requestBody?: SubmissionRequest): boolean {
  const expected = optionalEnv("EXTENSION_API_TOKEN");
  if (!expected) {
    throw new Error("EXTENSION_API_TOKEN is required");
  }

  const header = getHeader(event.headers, "authorization");
  if (!header) return false;

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match && match[1] === expected) return true;

  const tokenFromBody = requestBody?.extensionApiToken?.trim();
  return Boolean(tokenFromBody && tokenFromBody === expected);
}

export async function handler(event: HttpEventLike): Promise<HttpResponseLike> {
  const method = event.requestContext?.http?.method?.toUpperCase();
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: ""
    };
  }

  if (method !== "POST") {
    return jsonResponse(405, { message: "Method Not Allowed" });
  }

  try {
    const request = parseBody(event);
    if (!isAuthorized(event, request)) {
      return jsonResponse(401, { message: "Unauthorized" });
    }

    const input = validateSubmission(request);
    const result = await createSubmissionPullRequest(input);

    return jsonResponse(200, {
      ok: true,
      pullRequestUrl: result.url,
      pullRequestNumber: result.number,
      branch: result.branch
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Extension submission failed", { message, error });
    return jsonResponse(400, {
      ok: false,
      message
    });
  }
}
