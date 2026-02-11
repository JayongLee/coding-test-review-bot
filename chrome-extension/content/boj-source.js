const MESSAGE_SUBMISSION = "CT_SUBMISSION_ACCEPTED";
const TRIGGER_MESSAGE = "CT_TRIGGER_SUBMISSION";

let autoDone = false;
let retryCount = 0;
const MAX_RETRY = 8;
const RETRY_DELAY_MS = 1200;

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function parseSubmissionId() {
  const match = location.pathname.match(/\/source\/(\d+)/);
  return match ? match[1] : "";
}

function findTableValue(keywordList) {
  const rows = Array.from(document.querySelectorAll("table tr"));
  for (const row of rows) {
    const th = row.querySelector("th");
    const td = row.querySelector("td");
    if (!th || !td) continue;

    const key = normalizeText(th.textContent).toLowerCase().replace(/\s/g, "");
    if (keywordList.some((kw) => key.includes(kw))) {
      return normalizeText(td.textContent);
    }
  }
  return "";
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

  const status =
    findTableValue(["결과", "result"]) ||
    normalizeText(document.querySelector("td.result")?.textContent);

  return /맞았습니다|accepted/i.test(status);
}

async function fetchProblemTitle(problemNumber) {
  if (!problemNumber) return "";

  try {
    const response = await fetch(`/problem/${problemNumber}`, { credentials: "include" });
    if (!response.ok) return "";

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return normalizeText(doc.querySelector("#problem_title")?.textContent);
  } catch {
    return "";
  }
}

function parseLanguage() {
  const text = findTableValue(["언어", "language"]);
  if (!text) return "Java";
  if (/java/i.test(text)) return "Java";
  if (/kotlin/i.test(text)) return "Kotlin";
  if (/python/i.test(text)) return "Python";
  if (/javascript|node/i.test(text)) return "JavaScript";
  if (/c\+\+/i.test(text)) return "C++";
  return text;
}

async function fetchCodeFromDownload(submissionId) {
  if (!submissionId) return "";
  try {
    const response = await fetch(`/source/download/${submissionId}`, {
      credentials: "include"
    });
    if (!response.ok) return "";
    const text = await response.text();
    return text.replace(/\r/g, "").trim();
  } catch {
    return "";
  }
}

async function parseSourceCode() {
  const textarea = document.querySelector("textarea#source, textarea[name='source']");
  if (textarea && typeof textarea.value === "string") {
    const value = textarea.value.trim();
    if (value) return value;
  }

  const pre = document.querySelector("pre#source, #source pre");
  const preText = (pre?.textContent || "").replace(/\r/g, "").trim();
  if (preText) return preText;

  return fetchCodeFromDownload(parseSubmissionId());
}

async function collectSubmission(requireAccepted = true) {
  if (requireAccepted && !isAccepted()) return null;

  const problemNumber = parseProblemNumber();
  if (!problemNumber) return null;

  const sourceCode = await parseSourceCode();
  if (!sourceCode) return null;

  const problemTitle = (await fetchProblemTitle(problemNumber)) || `problem-${problemNumber}`;

  return {
    site: "BOJ",
    problemNumber,
    problemTitle,
    language: parseLanguage(),
    sourceCode,
    runtime: findTableValue(["시간", "runtime"]),
    memory: findTableValue(["메모리", "memory"]),
    submittedAt: findTableValue(["제출한시간", "제출시간", "submittedat"]),
    problemUrl: `https://www.acmicpc.net/problem/${problemNumber}`,
    submissionId: parseSubmissionId()
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
  const payload = await collectSubmission(source !== "boj-manual");
  if (!payload) {
    return {
      ok: false,
      message: "정답 제출 데이터가 없거나 아직 채점 완료 전입니다."
    };
  }

  return sendToBackground(payload, source);
}

async function autoSubmit() {
  if (autoDone) return;
  if (!isAccepted()) return;

  const result = await submitFromPage("boj-auto");
  if (result.ok) {
    autoDone = true;
    return;
  }

  retryCount += 1;
  if (retryCount <= MAX_RETRY) {
    setTimeout(() => {
      void autoSubmit();
    }, RETRY_DELAY_MS);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== TRIGGER_MESSAGE) return false;

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

void autoSubmit();
