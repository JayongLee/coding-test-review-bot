const MESSAGE_SUBMISSION = "CT_SUBMISSION_ACCEPTED";
const TRIGGER_MESSAGE = "CT_TRIGGER_SUBMISSION";

let autoTriggered = false;
let autoRetryCount = 0;
const AUTO_MAX_RETRY = 8;
const AUTO_RETRY_DELAY_MS = 1200;

console.log("[CT-EXT][BOJ] content loaded", { url: location.href });

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function findTableValue(keywordList) {
  const rows = Array.from(document.querySelectorAll("table tr"));
  for (const row of rows) {
    const th = row.querySelector("th");
    const td = row.querySelector("td");
    if (!th || !td) continue;

    const key = normalizeText(th.textContent).toLowerCase().replace(/\s/g, "");
    const isMatch = keywordList.some((keyword) => key.includes(keyword));
    if (isMatch) return normalizeText(td.textContent);
  }
  return "";
}

function parseSubmissionId() {
  const match = location.pathname.match(/\/source\/(\d+)/);
  return match ? match[1] : "";
}

function parseProblemNumber() {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") || "";
    const match = href.match(/\/problem\/(\d+)/);
    if (match) return match[1];
  }

  const html = document.documentElement?.innerHTML || "";
  const htmlMatch = html.match(/\/problem\/(\d+)/);
  return htmlMatch ? htmlMatch[1] : "";
}

function isAccepted() {
  if (document.querySelector(".result-ac")) return true;

  const statusText =
    findTableValue(["결과", "result"]) || normalizeText(document.querySelector("td.result")?.textContent);

  return /맞았습니다|accepted/i.test(statusText);
}

async function fetchProblemTitle(problemNumber) {
  if (!problemNumber) return "";

  try {
    const response = await fetch(`/problem/${problemNumber}`, {
      credentials: "include"
    });

    if (!response.ok) return "";
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return normalizeText(doc.querySelector("#problem_title")?.textContent);
  } catch {
    return "";
  }
}

function parseLanguage() {
  const fromTable = findTableValue(["언어", "language"]);
  if (!fromTable) return "Java";
  if (/java/i.test(fromTable)) return "Java";
  if (/kotlin/i.test(fromTable)) return "Kotlin";
  if (/python/i.test(fromTable)) return "Python";
  if (/c\+\+/i.test(fromTable)) return "C++";
  if (/javascript|node/i.test(fromTable)) return "JavaScript";
  return fromTable;
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

async function parseSourceCode() {
  const sourceArea = document.querySelector("textarea#source, textarea[name='source']");
  if (sourceArea && typeof sourceArea.value === "string") {
    const value = sourceArea.value.trim();
    if (value) return value;
  }

  const sourcePre = document.querySelector("pre#source, #source pre, .CodeMirror-code");
  const preText = (sourcePre?.textContent || "").replace(/\r/g, "").trim();
  if (preText) return preText;

  const submissionId = parseSubmissionId();
  const downloaded = await fetchCodeFromDownload(submissionId);
  if (downloaded) return downloaded;

  return "";
}

async function collectSubmission(options = {}) {
  const requireAccepted = options.requireAccepted !== false;
  if (requireAccepted && !isAccepted()) {
    console.log("[CT-EXT][BOJ] collectSubmission skipped: not accepted yet");
    return null;
  }

  const problemNumber = parseProblemNumber();
  if (!problemNumber) {
    console.warn("[CT-EXT][BOJ] collectSubmission failed: problem number not found");
    return null;
  }

  const problemTitle = (await fetchProblemTitle(problemNumber)) || `problem-${problemNumber}`;
  const sourceCode = await parseSourceCode();
  if (!sourceCode) {
    console.warn("[CT-EXT][BOJ] collectSubmission failed: source code not found");
    return null;
  }

  return {
    site: "BOJ",
    problemNumber,
    problemTitle,
    language: parseLanguage(),
    sourceCode,
    runtime: findTableValue(["시간", "runtime"]),
    memory: findTableValue(["메모리", "memory"]),
    submittedAt: findTableValue(["제출한시간", "submittedat", "제출시간"]),
    problemUrl: `https://www.acmicpc.net/problem/${problemNumber}`,
    externalSubmissionId: parseSubmissionId()
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
        resolve(response || { ok: false, message: "background 응답 없음" });
      }
    );
  });
}

async function submitFromPage(source) {
  console.log("[CT-EXT][BOJ] submitFromPage", { source });
  const payload = await collectSubmission({
    requireAccepted: source !== "boj-manual"
  });
  if (!payload) {
    console.warn("[CT-EXT][BOJ] payload missing");
    return { ok: false, message: "정답 제출 데이터가 없거나 아직 채점 완료 전입니다." };
  }

  console.log("[CT-EXT][BOJ] payload prepared", {
    problemNumber: payload.problemNumber,
    language: payload.language
  });
  return sendToBackground(payload, source);
}

async function autoSubmitIfPossible() {
  if (autoTriggered) return;
  if (!isAccepted()) return;

  console.log("[CT-EXT][BOJ] accepted detected, auto submit");
  const result = await submitFromPage("boj-auto");

  if (result?.ok) {
    autoTriggered = true;
    return;
  }

  autoRetryCount += 1;
  if (autoRetryCount <= AUTO_MAX_RETRY) {
    console.warn("[CT-EXT][BOJ] auto submit failed, retry scheduled", {
      attempt: autoRetryCount,
      message: result?.message
    });
    setTimeout(() => {
      void autoSubmitIfPossible();
    }, AUTO_RETRY_DELAY_MS);
    return;
  }

  console.warn("[CT-EXT][BOJ] auto submit stopped after max retries", {
    message: result?.message
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== TRIGGER_MESSAGE) return false;
  console.log("[CT-EXT][BOJ] manual trigger received");

  submitFromPage("boj-manual")
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    );

  return true;
});

autoSubmitIfPossible();
