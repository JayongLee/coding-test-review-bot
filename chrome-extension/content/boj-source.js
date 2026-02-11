const MESSAGE_SUBMISSION = "CT_SUBMISSION_ACCEPTED";
const TRIGGER_MESSAGE = "CT_TRIGGER_SUBMISSION";
const UI_STYLE_ID = "ct-pr-helper-style";
const TOAST_CONTAINER_ID = "ct-pr-toast-container";

let autoDone = false;
let retryCount = 0;
const MAX_RETRY = 12;
const RETRY_DELAY_MS = 1500;

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function parseFirstNumber(value) {
  const match = normalizeText(value).match(/[\d,]+(?:\.\d+)?/);
  return match ? Number(String(match[0]).replace(/,/g, "")) : NaN;
}

function ensureUiStyle() {
  if (document.getElementById(UI_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = UI_STYLE_ID;
  style.textContent = `
    #${TOAST_CONTAINER_ID} {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .ct-pr-toast {
      min-width: 240px;
      max-width: 360px;
      padding: 10px 12px;
      border-radius: 10px;
      color: #ffffff;
      font-size: 12px;
      line-height: 1.4;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      pointer-events: auto;
      word-break: break-word;
    }
    .ct-pr-toast.info { background: #1f2937; }
    .ct-pr-toast.success { background: #065f46; }
    .ct-pr-toast.warning { background: #92400e; }
    .ct-pr-toast.error { background: #991b1b; }
    .ct-pr-toast a {
      color: #fef08a;
      text-decoration: underline;
      margin-left: 6px;
    }
    .ct-pr-row-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 8px;
      font-size: 11px;
      font-weight: 700;
      color: #047857;
    }
    .ct-pr-row-indicator a {
      color: #0369a1;
      text-decoration: underline;
      font-weight: 600;
    }
  `;

  (document.head || document.documentElement).appendChild(style);
}

function getToastContainer() {
  ensureUiStyle();
  let container = document.getElementById(TOAST_CONTAINER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = TOAST_CONTAINER_ID;
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message, type = "info", actionUrl = "") {
  const container = getToastContainer();
  const toast = document.createElement("div");
  toast.className = `ct-pr-toast ${type}`;
  toast.textContent = message;

  if (actionUrl) {
    const link = document.createElement("a");
    link.href = actionUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "PR 열기";
    toast.appendChild(link);
  }

  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
    if (!container.childElementCount) container.remove();
  }, 6000);
}

function markRowAsPrCreated(row, result) {
  if (!row) return;

  const targetCell =
    row.querySelector("td.result") ||
    row.querySelector(".result") ||
    row.querySelectorAll("td")[3] ||
    row.lastElementChild;
  if (!targetCell) return;

  ensureUiStyle();

  let indicator = row.querySelector(".ct-pr-row-indicator");
  if (!indicator) {
    indicator = document.createElement("span");
    indicator.className = "ct-pr-row-indicator";
    targetCell.appendChild(indicator);
  }

  indicator.textContent = result.skipped ? "✅ PR 이미 생성됨" : "✅ PR 생성됨";

  if (result.pullRequestUrl) {
    const link = document.createElement("a");
    link.href = result.pullRequestUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "열기";
    indicator.appendChild(link);
  }
}

function isRetryableFailure(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return true;
  return /정답 제출 데이터를 찾지 못했습니다|채점|아직/i.test(text);
}

function getStatusRows() {
  const tableRows = Array.from(document.querySelectorAll("#status-table tbody tr"));
  if (tableRows.length > 0) return tableRows;
  return Array.from(document.querySelectorAll("table tbody tr"));
}

function parseSubmissionIdFromRow(row) {
  const sourceLink = row.querySelector('a[href^="/source/"]');
  const href = sourceLink?.getAttribute("href") || "";
  const match = href.match(/\/source\/(\d+)/);
  return match ? match[1] : "";
}

function parseProblemNumberFromRow(row) {
  const problemLink = row.querySelector('a[href^="/problem/"]');
  const href = problemLink?.getAttribute("href") || "";
  const match = href.match(/\/problem\/(\d+)/);
  return match ? match[1] : "";
}

function parseLanguageFromRow(row) {
  const byClass = normalizeText(row.querySelector("td.language")?.textContent);
  if (byClass) return byClass;

  const cells = row.querySelectorAll("td");
  if (cells.length >= 7) {
    const fallback = normalizeText(cells[6]?.textContent);
    if (fallback) return fallback;
  }

  return "Java";
}

function parseResultTextFromRow(row) {
  return normalizeText(row.querySelector("td.result")?.textContent) || normalizeText(row.querySelector(".result")?.textContent);
}

function parseRuntimeFromRow(row) {
  return normalizeText(row.querySelector("td.time")?.textContent);
}

function parseMemoryFromRow(row) {
  return normalizeText(row.querySelector("td.memory")?.textContent);
}

function parseCodeLengthFromRow(row) {
  const byClass = normalizeText(row.querySelector("td.length")?.textContent);
  if (byClass) return byClass;

  const cells = row.querySelectorAll("td");
  if (cells.length >= 8) return normalizeText(cells[7]?.textContent);
  return "";
}

function parseSubmittedAtFromRow(row) {
  const byClass = normalizeText(row.querySelector("td.submit-time")?.textContent);
  if (byClass) return byClass;

  const cells = row.querySelectorAll("td");
  if (cells.length >= 10) return normalizeText(cells[8]?.textContent);
  return "";
}

function isAcceptedRow(row) {
  if (row.querySelector(".result-ac")) return true;

  const resultText = parseResultTextFromRow(row);

  return /맞았습니다|accepted/i.test(resultText);
}

function parseQueryParam(name) {
  return new URLSearchParams(location.search).get(name) || "";
}

function compareAcceptedRowData(a, b) {
  const aHasScore = Number.isFinite(a.score);
  const bHasScore = Number.isFinite(b.score);

  if (aHasScore && bHasScore && a.score !== b.score) {
    return b.score - a.score;
  }

  if (a.runtime !== b.runtime) return a.runtime - b.runtime;
  if (a.memory !== b.memory) return a.memory - b.memory;
  if (a.codeLength !== b.codeLength) return a.codeLength - b.codeLength;
  return b.submissionIdNumber - a.submissionIdNumber;
}

function parseAcceptedRowData(row) {
  const submissionId = parseSubmissionIdFromRow(row);
  const problemNumber = parseProblemNumberFromRow(row);
  const languageRaw = parseLanguageFromRow(row);
  const resultText = parseResultTextFromRow(row);
  const score = parseFirstNumber(resultText);

  return {
    row,
    submissionId,
    submissionIdNumber: parseFirstNumber(submissionId) || 0,
    problemNumber,
    languageRaw,
    resultText,
    score,
    runtimeText: parseRuntimeFromRow(row),
    memoryText: parseMemoryFromRow(row),
    codeLengthText: parseCodeLengthFromRow(row),
    runtime: parseFirstNumber(parseRuntimeFromRow(row)) || Number.MAX_SAFE_INTEGER,
    memory: parseFirstNumber(parseMemoryFromRow(row)) || Number.MAX_SAFE_INTEGER,
    codeLength: parseFirstNumber(parseCodeLengthFromRow(row)) || Number.MAX_SAFE_INTEGER
  };
}

function pickBestAcceptedRow() {
  const rows = getStatusRows();
  const problemNumberFromQuery = parseQueryParam("problem_id");

  let accepted = rows
    .filter((row) => isAcceptedRow(row))
    .map((row) => parseAcceptedRowData(row))
    .filter((data) => data.submissionId && data.problemNumber);

  if (problemNumberFromQuery) {
    accepted = accepted.filter((data) => data.problemNumber === problemNumberFromQuery);
  }

  if (!accepted.length) return null;

  const latestLanguage = normalizeText(accepted[0]?.languageRaw);
  if (latestLanguage) {
    const sameLanguage = accepted.filter((data) => normalizeText(data.languageRaw) === latestLanguage);
    if (sameLanguage.length) accepted = sameLanguage;
  }

  accepted.sort(compareAcceptedRowData);
  return accepted[0] || null;
}

function parseLevelFromProblemPage(doc) {
  const levelSelectors = [
    "#problem-info img[alt]",
    "#problem_level img[alt]",
    'img[src*="solved.ac"]',
    "#problem-info a[href*='solved.ac']"
  ];

  for (const selector of levelSelectors) {
    const node = doc.querySelector(selector);
    const alt = normalizeText(node?.getAttribute?.("alt"));
    if (alt) return alt;
    const text = normalizeText(node?.textContent);
    if (text) return text;
  }

  return "";
}

function parseTagsFromProblemPage(doc) {
  const tags = Array.from(doc.querySelectorAll("#problem_tags a, #problem-tag a"))
    .map((node) => normalizeText(node.textContent))
    .filter(Boolean);
  return [...new Set(tags)];
}

async function fetchProblemMetadata(problemNumber) {
  if (!problemNumber) return {};

  try {
    const response = await fetch(`/problem/${problemNumber}`, { credentials: "include" });
    if (!response.ok) return {};

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return {
      title: normalizeText(doc.querySelector("#problem_title")?.textContent),
      level: parseLevelFromProblemPage(doc),
      problemTags: parseTagsFromProblemPage(doc)
    };
  } catch {
    return {};
  }
}

async function fetchCodeFromDownload(submissionId) {
  if (!submissionId) return "";

  try {
    const response = await fetch(`/source/download/${submissionId}`, { credentials: "include" });
    if (!response.ok) return "";
    const text = await response.text();
    return text.replace(/\r/g, "").trim();
  } catch {
    return "";
  }
}

function normalizeLanguage(raw) {
  const text = normalizeText(raw) || "Java";
  if (/java/i.test(text)) return "Java";
  if (/kotlin/i.test(text)) return "Kotlin";
  if (/python/i.test(text)) return "Python";
  if (/javascript|node/i.test(text)) return "JavaScript";
  if (/c\+\+/i.test(text)) return "C++";
  return text;
}

async function collectSubmission(requireAccepted = true) {
  const best = pickBestAcceptedRow();
  if (!best) {
    return null;
  }

  if (requireAccepted && !isAcceptedRow(best.row)) {
    return null;
  }

  const submissionId = best.submissionId;
  const problemNumber = best.problemNumber;
  if (!submissionId || !problemNumber) return null;

  const sourceCode = await fetchCodeFromDownload(submissionId);
  if (!sourceCode) return null;

  const metadata = await fetchProblemMetadata(problemNumber);
  const problemTitle = normalizeText(metadata.title) || `problem-${problemNumber}`;

  return {
    row: best.row,
    payload: {
      site: "BOJ",
      problemNumber,
      problemTitle,
      level: normalizeText(metadata.level),
      problemTags: Array.isArray(metadata.problemTags) ? metadata.problemTags : [],
      language: normalizeLanguage(best.languageRaw),
      sourceCode,
      runtime: best.runtimeText,
      memory: best.memoryText,
      codeLength: best.codeLengthText,
      score: Number.isFinite(best.score) ? String(best.score) : "",
      submittedAt: parseSubmittedAtFromRow(best.row),
      problemUrl: `https://www.acmicpc.net/problem/${problemNumber}`,
      submissionId
    }
  };
}

function sendToBackground(payload, source) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: MESSAGE_SUBMISSION,
        payload,
        source
      },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            message: chrome.runtime.lastError.message || "background 통신 실패"
          });
          return;
        }
        resolve(response || { ok: false, message: "background 응답 없음" });
      }
    );
  });
}

async function submitFromPage(source, options = {}) {
  const notify = Boolean(options.notify);
  const collected = await collectSubmission(source !== "boj-manual");
  if (!collected) {
    const result = {
      ok: false,
      message: "status 페이지에서 정답 제출 데이터를 찾지 못했습니다."
    };
    if (notify) showToast(result.message, "warning");
    return result;
  }

  const result = await sendToBackground(collected.payload, source);

  if (result.ok) {
    markRowAsPrCreated(collected.row, result);
    if (notify || source === "boj-auto") {
      showToast(
        result.skipped ? "이미 생성한 PR입니다." : "PR을 생성했습니다.",
        "success",
        result.pullRequestUrl || ""
      );
    }
    return result;
  }

  if (notify) {
    showToast(`PR 생성 실패: ${result.message || "알 수 없는 오류"}`, "error");
  }

  return result;
}

async function autoSubmit() {
  if (autoDone) return;

  const result = await submitFromPage("boj-auto", { notify: false });
  if (result.ok) {
    autoDone = true;
    return;
  }

  if (!isRetryableFailure(result.message)) {
    autoDone = true;
    showToast(`자동 제출 실패: ${result.message || "알 수 없는 오류"}`, "error");
    return;
  }

  retryCount += 1;
  if (retryCount <= MAX_RETRY) {
    setTimeout(() => {
      void autoSubmit();
    }, RETRY_DELAY_MS);
    return;
  }

  autoDone = true;
  showToast("자동 제출을 여러 번 시도했지만 실패했습니다. 팝업에서 수동 실행을 눌러주세요.", "warning");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== TRIGGER_MESSAGE) return false;

  submitFromPage("boj-manual", { notify: true })
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

void autoSubmit();
