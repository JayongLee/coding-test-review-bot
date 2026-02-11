const MESSAGE_SUBMISSION = "CT_SUBMISSION_ACCEPTED";
const TRIGGER_MESSAGE = "CT_TRIGGER_SUBMISSION";
const UI_STYLE_ID = "ct-pr-helper-style";
const TOAST_CONTAINER_ID = "ct-pr-toast-container";

let lastAutoKey = "";

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
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

function parseProblemLevel() {
  const levelSelectors = [
    '[class*="level"]',
    '[class*="difficulty"]',
    '[data-testid*="level"]',
    '.challenge-info'
  ];

  for (const selector of levelSelectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const text = normalizeText(node.textContent);
      if (/lv\.?\s*\d+|level|난이도|브론즈|실버|골드|플래티넘|다이아/i.test(text)) {
        return text.replace(/\s+/g, " ");
      }
    }
  }

  const bodyText = normalizeText(document.body.textContent);
  const match = bodyText.match(/(Lv\.?\s*\d+)/i);
  return match ? normalizeText(match[1]) : "";
}

function parseProblemDescription() {
  const candidates = [
    "#tab-description",
    ".challenge-content",
    ".guide-section",
    ".markdown",
    ".problem-guide"
  ];

  for (const selector of candidates) {
    const node = document.querySelector(selector);
    const text = normalizeText(node?.textContent);
    if (text && text.length > 30) {
      return text.slice(0, 6000);
    }
  }

  const metaDescription = normalizeText(document.querySelector('meta[name="description"]')?.getAttribute("content"));
  return metaDescription.slice(0, 6000);
}

function parsePerformance() {
  const text = normalizeText(document.body.textContent);
  const runtimeMatch = text.match(/(\d+(?:\.\d+)?)\s*ms/i);
  const memoryMatch = text.match(/(\d+(?:\.\d+)?)\s*MB/i);

  return {
    runtime: runtimeMatch ? `${runtimeMatch[1]} ms` : "",
    memory: memoryMatch ? `${memoryMatch[1]} MB` : ""
  };
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
  const level = parseProblemLevel();
  const problemDescription = parseProblemDescription();
  const performance = parsePerformance();

  return {
    site: "PROGRAMMERS",
    problemNumber,
    problemTitle,
    level,
    problemDescription,
    language: parseLanguage(),
    sourceCode,
    runtime: performance.runtime,
    memory: performance.memory,
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
  const payload = await collectSubmission(source !== "programmers-manual");
  if (!payload) {
    const result = { ok: false, message: "정답 판정을 감지하지 못했습니다." };
    if (notify) showToast(result.message, "warning");
    return result;
  }

  if (payload.missingCode) {
    const result = { ok: false, message: payload.message };
    if (notify) showToast(result.message, "warning");
    return result;
  }

  const result = await sendToBackground(payload, source);

  if (result.ok) {
    if (notify || source === "programmers-auto") {
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

async function tryAutoSubmit() {
  const payload = await collectSubmission(true);
  if (!payload || payload.missingCode) return;

  const key = normalizeText(payload.submissionId);
  if (!key || key === lastAutoKey) return;

  lastAutoKey = key;
  const result = await sendToBackground(payload, "programmers-auto");
  if (result.ok) {
    showToast(
      result.skipped ? "이미 생성한 PR입니다." : "PR을 생성했습니다.",
      "success",
      result.pullRequestUrl || ""
    );
    return;
  }

  showToast(`자동 제출 실패: ${result.message || "알 수 없는 오류"}`, "error");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== TRIGGER_MESSAGE) return false;

  submitFromPage("programmers-manual", { notify: true })
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
