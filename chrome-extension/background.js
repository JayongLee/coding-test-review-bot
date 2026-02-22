const MESSAGE_SUBMISSION = "CT_SUBMISSION_ACCEPTED";
const STORAGE_CONFIG_KEY = "ct_pr_config";
const STORAGE_PROCESSED_KEY = "ct_pr_processed";

const GITHUB_API_BASE = "https://api.github.com";
const inFlightSubmissionTasks = new Map();

function getStorageArea() {
  return chrome.storage.sync || chrome.storage.local;
}

function storageGet(key) {
  return new Promise((resolve) => {
    getStorageArea().get([key], (result) => resolve(result[key]));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    getStorageArea().set(values, () => resolve());
  });
}

function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function sanitizeTitleForPath(raw) {
  return normalizeText(raw)
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function sanitizeBranchPart(raw, fallback) {
  const sanitized = normalizeText(raw)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || fallback;
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function encodeGitHubPath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getSiteRoot(site) {
  return site === "PROGRAMMERS" ? "프로그래머스" : "백준";
}

function getProblemDefaultUrl(site, problemNumber) {
  if (site === "PROGRAMMERS") {
    return `https://school.programmers.co.kr/learn/courses/30/lessons/${problemNumber}`;
  }
  return `https://www.acmicpc.net/problem/${problemNumber}`;
}

function normalizeLanguage(language, fallback = "Java") {
  const value = normalizeText(language, fallback);
  if (/java/i.test(value)) return "Java";
  if (/kotlin/i.test(value)) return "Kotlin";
  if (/python/i.test(value)) return "Python";
  if (/javascript|node/i.test(value)) return "JavaScript";
  if (/c\+\+/i.test(value)) return "C++";
  if (/go/i.test(value)) return "Go";
  if (/rust/i.test(value)) return "Rust";
  return value;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean);
  }
  const text = normalizeText(value);
  if (!text) return [];
  return text
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function normalizeMultiline(value, maxLength = 6000) {
  const text = normalizeText(value).replace(/\r/g, "");
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function hashText(value) {
  const text = normalizeText(value);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function buildSubmissionKey(payload) {
  const submissionId = normalizeText(payload.submissionId);
  if (submissionId) return `${payload.site}:${submissionId}`;

  const hashInput = [
    payload.site,
    payload.problemNumber,
    payload.problemTitle,
    payload.language,
    normalizeText(payload.sourceCode).length
  ].join("|");

  let hash = 0;
  for (let i = 0; i < hashInput.length; i += 1) {
    hash = (hash * 31 + hashInput.charCodeAt(i)) >>> 0;
  }
  return `${payload.site}:${payload.problemNumber}:${hash.toString(16)}`;
}

async function getProcessedInfo(key) {
  const processed = (await storageGet(STORAGE_PROCESSED_KEY)) || {};
  return processed[key] || null;
}

async function markProcessed(key, prUrl) {
  const processed = (await storageGet(STORAGE_PROCESSED_KEY)) || {};
  processed[key] = {
    createdAt: new Date().toISOString(),
    prUrl: prUrl || ""
  };

  const keys = Object.keys(processed);
  if (keys.length > 200) {
    keys
      .sort((a, b) => (processed[a]?.createdAt || "").localeCompare(processed[b]?.createdAt || ""))
      .slice(0, keys.length - 150)
      .forEach((k) => delete processed[k]);
  }

  await storageSet({ [STORAGE_PROCESSED_KEY]: processed });
}

function validateConfig(config) {
  if (!normalizeText(config.githubToken)) return "GitHub Token이 비어 있습니다.";
  if (!normalizeText(config.repoOwner)) return "Repo Owner가 비어 있습니다.";
  if (!normalizeText(config.repoName)) return "Repo Name이 비어 있습니다.";
  if (!normalizeText(config.baseBranch, "main")) return "Base Branch가 비어 있습니다.";
  return "";
}

function validatePayload(payload) {
  if (!payload) return "제출 데이터가 없습니다.";
  if (!["BOJ", "PROGRAMMERS"].includes(payload.site)) return "지원하지 않는 사이트입니다.";
  if (!/^\d+$/.test(normalizeText(payload.problemNumber))) return "문제 번호를 읽지 못했습니다.";
  if (!normalizeText(payload.problemTitle)) return "문제 제목을 읽지 못했습니다.";
  if (!normalizeText(payload.sourceCode)) return "소스 코드를 읽지 못했습니다.";
  return "";
}

async function githubRequest(config, path, options = {}) {
  const token = normalizeText(config.githubToken);
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message = json?.message || text || `GitHub API Error (${response.status})`;
    throw new Error(message);
  }

  return json;
}

async function getBranchSha(config, owner, repo, branch) {
  const ref = await githubRequest(config, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  return ref.object.sha;
}

async function createBranch(config, owner, repo, baseBranch, newBranch) {
  const baseSha = await getBranchSha(config, owner, repo, baseBranch);

  await githubRequest(config, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ref: `refs/heads/${newBranch}`,
      sha: baseSha
    })
  });
}

function isBranchAlreadyExistsError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Reference already exists|already exists/i.test(message);
}

function isAlreadyHasPullRequestError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /A pull request already exists/i.test(message);
}

async function findOpenPullRequestByHead(config, owner, repo, headOwner, headBranch) {
  const pulls = await githubRequest(
    config,
    `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${headOwner}:${headBranch}`)}`
  );
  return Array.isArray(pulls) && pulls.length > 0 ? pulls[0] : null;
}

async function getContentShaIfExists(config, owner, repo, path, branch) {
  try {
    const data = await githubRequest(
      config,
      `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(branch)}`
    );
    return data?.sha;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Not Found/i.test(message)) return undefined;
    throw error;
  }
}

async function upsertFile(config, owner, repo, branch, path, content, message) {
  const sha = await getContentShaIfExists(config, owner, repo, path, branch);

  const body = {
    message,
    content: toBase64Utf8(content.endsWith("\n") ? content : `${content}\n`),
    branch,
    ...(sha ? { sha } : {})
  };

  await githubRequest(config, `/repos/${owner}/${repo}/contents/${encodeGitHubPath(path)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function createBlob(config, owner, repo, content) {
  const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;

  const blob = await githubRequest(config, `/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: normalizedContent,
      encoding: "utf-8"
    })
  });

  return blob.sha;
}

async function createSingleCommitForFiles(config, owner, repo, branch, files, message) {
  const headSha = await getBranchSha(config, owner, repo, branch);
  const headCommit = await githubRequest(config, `/repos/${owner}/${repo}/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;

  const treeItems = [];
  for (const file of files) {
    const blobSha = await createBlob(config, owner, repo, String(file.content || ""));
    treeItems.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blobSha
    });
  }

  const tree = await githubRequest(config, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems
    })
  });

  if (tree.sha === baseTreeSha) {
    return { created: false, sha: headSha };
  }

  const commit = await githubRequest(config, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [headSha]
    })
  });

  await githubRequest(config, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sha: commit.sha,
      force: false
    })
  });

  return { created: true, sha: commit.sha };
}

function buildReadme(problem) {
  const problemTags = (problem.problemTags || []).join(", ") || "N/A";
  const level = normalizeText(problem.level, "N/A");
  const description = normalizeMultiline(problem.problemDescription);
  const codeLength = normalizeText(problem.codeLength, "N/A");
  const score = normalizeText(problem.score, "N/A");

  return `# [${problem.siteLabel}] ${problem.problemTitle} - ${problem.problemNumber}

[문제 링크](${problem.problemUrl})

### 성능 요약

메모리: ${problem.memory || "N/A"}, 시간: ${problem.runtime || "N/A"}
코드 길이: ${codeLength}, 점수: ${score}

### 분류

${problemTags}

### 난이도

${level}

### 제출 일자

${problem.submittedAt || "N/A"}

### 문제 설명

${description || "자동 생성 PR입니다. 문제 설명은 링크에서 확인해주세요."}

### 입력

문제 링크 참고

### 출력

문제 링크 참고
`;
}

function buildPrBody(problem, config) {
  const defaultAsk = normalizeText(config.defaultAsk);
  const problemTags = (problem.problemTags || []).join(", ");
  const level = normalizeText(problem.level);

  return `## Problem Metadata 🔎
- 사이트 : ${problem.site}
- 문제 번호 : ${problem.problemNumber}
- URL: ${problem.problemUrl}
- URL: ${problem.site === "PROGRAMMERS" ? problem.problemUrl : "https://school.programmers.co.kr/learn/courses/30/lessons/{문제번호}"}
- Level: ${level}
- 카테고리 : ${problemTags}
- 언어 : ${problem.language}

## Solution Summary 📝
- 핵심 아이디어:
- 시간 복잡도:
- 공간 복잡도:

## Notes 💭
- 구현 시 고민한 점:

## ASK ❓
- 피드백 요청할 부분: ${defaultAsk}
`;
}

async function createPullRequest(config, payload) {
  const owner = normalizeText(config.repoOwner);
  const repo = normalizeText(config.repoName);
  const baseBranch = normalizeText(config.baseBranch, "main");

  const site = payload.site;
  const siteRoot = getSiteRoot(site);
  const problemNumber = normalizeText(payload.problemNumber);
  const problemTitle = sanitizeTitleForPath(payload.problemTitle) || `problem-${problemNumber}`;
  const language = normalizeLanguage(payload.language, normalizeText(config.defaultLanguage, "Java"));
  const sourceCode = String(payload.sourceCode || "");
  const runtime = normalizeText(payload.runtime);
  const memory = normalizeText(payload.memory);
  const codeLength = normalizeText(payload.codeLength);
  const score = normalizeText(payload.score);
  const submittedAt = normalizeText(payload.submittedAt);
  const problemUrl = normalizeText(payload.problemUrl, getProblemDefaultUrl(site, problemNumber));
  const level = normalizeText(payload.level);
  const problemTags = normalizeList(payload.problemTags);
  const problemDescription = normalizeMultiline(payload.problemDescription);

  const folderName = `${problemNumber}.${problemTitle}`;
  const folderPath = `${siteRoot}/${folderName}`;
  const codeFilePath = `${folderPath}/${problemTitle}.java`;
  const readmePath = `${folderPath}/README.md`;

  const submissionKey = buildSubmissionKey(payload);
  const branchSuffix = hashText(submissionKey).slice(0, 10);
  const branch = `auto/${sanitizeBranchPart(site, "site")}/${sanitizeBranchPart(problemNumber, "problem")}-${branchSuffix}`;

  try {
    await createBranch(config, owner, repo, baseBranch, branch);
  } catch (error) {
    if (!isBranchAlreadyExistsError(error)) {
      throw error;
    }
  }

  const readme = buildReadme({
    site,
    siteLabel: site === "PROGRAMMERS" ? "프로그래머스" : "백준",
    problemNumber,
    problemTitle,
    problemUrl,
    runtime,
    memory,
    codeLength,
    score,
    level,
    problemTags,
    problemDescription,
    submittedAt
  });

  const commitSite = site === "PROGRAMMERS" ? "programmers" : "boj";
  const commitMessage = `${commitSite}: add ${folderName} solution & metadata`;

  await createSingleCommitForFiles(
    config,
    owner,
    repo,
    branch,
    [
      { path: readmePath, content: readme },
      { path: codeFilePath, content: sourceCode }
    ],
    commitMessage
  );

  const existingOpenPr = await findOpenPullRequestByHead(config, owner, repo, owner, branch);
  if (existingOpenPr) {
    return {
      pullRequestUrl: existingOpenPr.html_url,
      pullRequestNumber: existingOpenPr.number,
      branch
    };
  }

  const title = `${site === "PROGRAMMERS" ? "프로그래머스" : "백준"}/${problemTitle}/${problemNumber}`;
  const prBody = buildPrBody(
    {
      site,
      problemNumber,
      problemUrl,
      level,
      problemTags,
      language,
      runtime,
      memory,
      submittedAt
    },
    config
  );

  let pr;
  try {
    pr = await githubRequest(config, `/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        head: branch,
        base: baseBranch,
        body: prBody
      })
    });
  } catch (error) {
    if (!isAlreadyHasPullRequestError(error)) {
      throw error;
    }

    const existingPr = await findOpenPullRequestByHead(config, owner, repo, owner, branch);
    if (!existingPr) {
      throw error;
    }
    pr = existingPr;
  }

  return {
    pullRequestUrl: pr.html_url,
    pullRequestNumber: pr.number,
    branch
  };
}

async function handleSubmission(rawPayload, source) {
  const config = (await storageGet(STORAGE_CONFIG_KEY)) || {};
  const configError = validateConfig(config);
  if (configError) return { ok: false, message: configError };

  const payload = {
    site: normalizeText(rawPayload?.site).toUpperCase(),
    problemNumber: normalizeText(rawPayload?.problemNumber),
    problemTitle: normalizeText(rawPayload?.problemTitle),
    language: normalizeLanguage(rawPayload?.language, normalizeText(config.defaultLanguage, "Java")),
    sourceCode: String(rawPayload?.sourceCode || ""),
    runtime: normalizeText(rawPayload?.runtime),
    memory: normalizeText(rawPayload?.memory),
    codeLength: normalizeText(rawPayload?.codeLength),
    score: normalizeText(rawPayload?.score),
    submittedAt: normalizeText(rawPayload?.submittedAt),
    problemUrl: normalizeText(rawPayload?.problemUrl),
    level: normalizeText(rawPayload?.level),
    problemTags: normalizeList(rawPayload?.problemTags),
    problemDescription: normalizeMultiline(rawPayload?.problemDescription),
    submissionId: normalizeText(rawPayload?.submissionId)
  };

  const payloadError = validatePayload(payload);
  if (payloadError) return { ok: false, message: payloadError };

  const key = buildSubmissionKey(payload);
  const inFlightTask = inFlightSubmissionTasks.get(key);
  if (inFlightTask) {
    return inFlightTask;
  }

  const task = (async () => {
    try {
      const processedInfo = await getProcessedInfo(key);
      if (processedInfo) {
        return {
          ok: true,
          skipped: true,
          message: "이미 처리한 제출입니다.",
          pullRequestUrl: normalizeText(processedInfo.prUrl)
        };
      }

      const result = await createPullRequest(config, payload);
      await markProcessed(key, result.pullRequestUrl);

      return {
        ok: true,
        source,
        ...result
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      inFlightSubmissionTasks.delete(key);
    }
  })();

  inFlightSubmissionTasks.set(key, task);
  return task;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_SUBMISSION) {
    return false;
  }

  handleSubmission(message.payload || {}, message.source || "unknown")
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    );

  return true;
});
