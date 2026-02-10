const MESSAGE_SUBMISSION = "CT_SUBMISSION_ACCEPTED";
const TRIGGER_MESSAGE = "CT_TRIGGER_SUBMISSION";

let lastAutoKey = "";

console.log("[CT-EXT][PGM] content loaded", { url: location.href });

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

function simpleHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function extractCodeFromMonaco() {
  const candidates = Array.from(document.querySelectorAll(".monaco-editor textarea, textarea.inputarea"));
  for (const element of candidates) {
    const value = element && typeof element.value === "string" ? element.value.trim() : "";
    if (value) return value;
  }

  const fallback = normalizeText(document.querySelector("textarea")?.value);
  return fallback;
}

function hasAcceptedSignal() {
  const text = normalizeText(document.body.textContent);
  return /정답입니다|모든\s*테스트\s*통과|정확성\s*테스트\s*통과|효율성\s*테스트\s*통과/i.test(text);
}

async function collectSubmission() {
  if (!hasAcceptedSignal()) return null;

  const problemNumber = parseProblemNumber();
  if (!problemNumber) return null;

  const sourceCode = extractCodeFromMonaco();
  if (!sourceCode) {
    return {
      missingCode: true,
      message: "코드 추출에 실패했습니다. 에디터가 보이는 상태에서 다시 시도해주세요."
    };
  }

  const problemTitle = parseProblemTitle(problemNumber);
  const language = parseLanguage();
  const externalSubmissionId = `pgm-${problemNumber}-${simpleHash(sourceCode)}`;

  return {
    site: "PROGRAMMERS",
    problemNumber,
    problemTitle,
    language,
    sourceCode,
    problemUrl: `https://school.programmers.co.kr/learn/courses/30/lessons/${problemNumber}`,
    externalSubmissionId
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
  console.log("[CT-EXT][PGM] submitFromPage", { source });
  const payload = await collectSubmission();
  if (!payload) {
    console.warn("[CT-EXT][PGM] accepted signal not found");
    return { ok: false, message: "정답 판정을 감지하지 못했습니다." };
  }

  if (payload.missingCode) {
    console.warn("[CT-EXT][PGM] missing code in editor");
    return { ok: false, message: payload.message };
  }

  console.log("[CT-EXT][PGM] payload prepared", {
    problemNumber: payload.problemNumber,
    language: payload.language
  });
  return sendToBackground(payload, source);
}

async function tryAutoSubmit() {
  const payload = await collectSubmission();
  if (!payload || payload.missingCode) return;

  const key = `${payload.externalSubmissionId}`;
  if (!key || key === lastAutoKey) return;

  console.log("[CT-EXT][PGM] accepted detected, auto submit", { key });
  lastAutoKey = key;
  await sendToBackground(payload, "programmers-auto");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== TRIGGER_MESSAGE) return false;
  console.log("[CT-EXT][PGM] manual trigger received");

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
