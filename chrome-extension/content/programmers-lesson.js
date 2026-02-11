const MESSAGE_SUBMISSION = "CT_SUBMISSION_ACCEPTED";
const TRIGGER_MESSAGE = "CT_TRIGGER_SUBMISSION";

let lastAutoKey = "";

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function parseProblemNumber() {
  const match = location.pathname.match(/\/lessons\/(\d+)/);
  return match ? match[1] : "";
}

function parseProblemTitle(problemNumber) {
  const fromHeader = normalizeText(document.querySelector("h4.challenge-title")?.textContent);
  if (fromHeader) return fromHeader;

  const ogTitle = normalizeText(document.querySelector('meta[property="og:title"]')?.getAttribute("content"));
  if (ogTitle) {
    return ogTitle.replace(/^코딩테스트\s*연습\s*-\s*/i, "").trim();
  }

  return `lesson-${problemNumber}`;
}

function parseLanguage() {
  const candidate = normalizeText(
    document.querySelector(".language-select, .select-language, .css-1fif4ot")?.textContent
  );
  if (!candidate) return "Java";
  if (/java/i.test(candidate)) return "Java";
  if (/kotlin/i.test(candidate)) return "Kotlin";
  if (/python/i.test(candidate)) return "Python";
  if (/javascript|node/i.test(candidate)) return "JavaScript";
  return candidate;
}

function hasAcceptedSignal() {
  const text = normalizeText(document.body.textContent);
  return /정답입니다|모든\s*테스트\s*통과|정확성\s*테스트\s*통과|효율성\s*테스트\s*통과/i.test(text);
}

function extractCodeFromEditor() {
  const candidates = Array.from(document.querySelectorAll(".monaco-editor textarea, textarea.inputarea"));
  for (const node of candidates) {
    const value = node && typeof node.value === "string" ? node.value.trim() : "";
    if (value) return value;
  }

  const fallback = document.querySelector("textarea");
  if (fallback && typeof fallback.value === "string" && fallback.value.trim()) {
    return fallback.value.trim();
  }

  return "";
}

function simpleHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

async function collectSubmission(requireAccepted = true) {
  if (requireAccepted && !hasAcceptedSignal()) {
    return null;
  }

  const problemNumber = parseProblemNumber();
  if (!problemNumber) return null;

  const sourceCode = extractCodeFromEditor();
  if (!sourceCode) {
    return {
      missingCode: true,
      message: "코드 추출에 실패했습니다. 에디터가 보이는 상태에서 다시 시도해주세요."
    };
  }

  const problemTitle = parseProblemTitle(problemNumber);

  return {
    site: "PROGRAMMERS",
    problemNumber,
    problemTitle,
    language: parseLanguage(),
    sourceCode,
    problemUrl: `https://school.programmers.co.kr/learn/courses/30/lessons/${problemNumber}`,
    submissionId: `pgm-${problemNumber}-${simpleHash(sourceCode)}`
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
  const payload = await collectSubmission(source !== "programmers-manual");
  if (!payload) {
    return { ok: false, message: "정답 판정을 감지하지 못했습니다." };
  }

  if (payload.missingCode) {
    return { ok: false, message: payload.message };
  }

  return sendToBackground(payload, source);
}

async function tryAutoSubmit() {
  const payload = await collectSubmission(true);
  if (!payload || payload.missingCode) return;

  const key = normalizeText(payload.submissionId);
  if (!key || key === lastAutoKey) return;

  lastAutoKey = key;
  await sendToBackground(payload, "programmers-auto");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== TRIGGER_MESSAGE) return false;

  submitFromPage("programmers-manual")
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    );

  return true;
});

const observer = new MutationObserver(() => {
  void tryAutoSubmit();
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true
});

void tryAutoSubmit();
