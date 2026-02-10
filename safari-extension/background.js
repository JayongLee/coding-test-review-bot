const STORAGE_CONFIG_KEY = "ct_auto_pr_config";
const STORAGE_PROCESSED_KEY = "ct_auto_pr_processed";
const MESSAGE_SUBMISSION = "CT_SUBMISSION_ACCEPTED";

console.log("[CT-EXT][background] loaded");

function getStorageArea() {
  return chrome.storage.sync || chrome.storage.local;
}

function storageGet(key) {
  return new Promise((resolve) => {
    getStorageArea().get([key], (result) => resolve(result[key]));
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    getStorageArea().set(value, () => resolve());
  });
}

function notify(title, message) {
  console.log(`[${title}] ${message}`);
  if (chrome.action) {
    chrome.action.setBadgeBackgroundColor({ color: "#0b8043" });
    chrome.action.setBadgeText({ text: "PR" });
    chrome.action.setTitle({ title: `${title}: ${message}` });
  }
}

function normalizeText(value, fallback = "") {
  if (!value) return fallback;
  return String(value).trim();
}

function normalizeSite(site) {
  const value = normalizeText(site).toUpperCase();
  if (value === "BOJ" || value === "BAEKJOON") return "BOJ";
  if (value === "PROGRAMMERS" || value === "PGM" || value === "PROG") return "PROGRAMMERS";
  return "";
}

function validateConfig(config) {
  if (!config) return "옵션을 먼저 저장해주세요.";
  if (!normalizeText(config.apiEndpoint)) return "API Endpoint가 비어 있습니다.";
  if (!normalizeText(config.apiToken)) return "API Token이 비어 있습니다.";
  if (!normalizeText(config.repoOwner)) return "Repo Owner가 비어 있습니다.";
  if (!normalizeText(config.repoName)) return "Repo Name이 비어 있습니다.";
  return "";
}

function makeSubmissionKey(payload) {
  const external = normalizeText(payload.externalSubmissionId);
  if (external) return `${payload.site}:${external}`;

  const compactTitle = normalizeText(payload.problemTitle).slice(0, 40);
  const codeLen = normalizeText(payload.sourceCode).length;
  return `${payload.site}:${payload.problemNumber}:${compactTitle}:${codeLen}`;
}

async function markProcessed(key, pullRequestUrl) {
  const processed = (await storageGet(STORAGE_PROCESSED_KEY)) || {};
  processed[key] = {
    createdAt: new Date().toISOString(),
    pullRequestUrl: pullRequestUrl || ""
  };

  const keys = Object.keys(processed);
  if (keys.length > 300) {
    keys
      .sort((a, b) => {
        const at = processed[a]?.createdAt || "";
        const bt = processed[b]?.createdAt || "";
        return at.localeCompare(bt);
      })
      .slice(0, keys.length - 250)
      .forEach((staleKey) => delete processed[staleKey]);
  }

  await storageSet({ [STORAGE_PROCESSED_KEY]: processed });
}

async function isProcessed(key) {
  const processed = (await storageGet(STORAGE_PROCESSED_KEY)) || {};
  return Boolean(processed[key]);
}

async function submitToBackend(rawPayload, source) {
  console.log("[CT-EXT][background] submitToBackend called", { source, site: rawPayload?.site });
  const config = (await storageGet(STORAGE_CONFIG_KEY)) || {};
  const configError = validateConfig(config);
  if (configError) {
    console.warn("[CT-EXT][background] invalid config", { configError });
    return { ok: false, message: configError };
  }

  const site = normalizeSite(rawPayload.site);
  const problemNumber = normalizeText(rawPayload.problemNumber);
  const problemTitle = normalizeText(rawPayload.problemTitle);
  const language = normalizeText(rawPayload.language, config.defaultLanguage || "Java");
  const sourceCode = normalizeText(rawPayload.sourceCode);

  if (!site) return { ok: false, message: "지원하지 않는 사이트입니다." };
  if (!problemNumber) return { ok: false, message: "문제 번호를 읽지 못했습니다." };
  if (!problemTitle) return { ok: false, message: "문제 제목을 읽지 못했습니다." };
  if (!sourceCode) return { ok: false, message: "코드를 읽지 못했습니다." };

  const payload = {
    site,
    problemNumber,
    problemTitle,
    language,
    sourceCode,
    runtime: normalizeText(rawPayload.runtime),
    memory: normalizeText(rawPayload.memory),
    submittedAt: normalizeText(rawPayload.submittedAt),
    problemUrl: normalizeText(rawPayload.problemUrl),
    externalSubmissionId: normalizeText(rawPayload.externalSubmissionId),
    repoOwner: normalizeText(config.repoOwner),
    repoName: normalizeText(config.repoName),
    baseBranch: normalizeText(config.baseBranch, "main")
  };

  const dedupeKey = makeSubmissionKey(payload);
  if (await isProcessed(dedupeKey)) {
    console.log("[CT-EXT][background] duplicate submission skipped", { dedupeKey });
    return { ok: true, skipped: true, message: "이미 처리한 제출입니다." };
  }

  let response;
  try {
    console.log("[CT-EXT][background] calling API", {
      endpoint: normalizeText(config.apiEndpoint),
      site: payload.site,
      problemNumber: payload.problemNumber
    });
    response = await fetch(normalizeText(config.apiEndpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${normalizeText(config.apiToken)}`
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return {
      ok: false,
      message: `API 호출 실패: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok || body.ok === false) {
    console.error("[CT-EXT][background] API error", {
      status: response.status,
      body
    });
    return {
      ok: false,
      message: body.message || `API 오류: HTTP ${response.status}`
    };
  }

  console.log("[CT-EXT][background] API success", {
    pullRequestUrl: body.pullRequestUrl,
    pullRequestNumber: body.pullRequestNumber
  });
  await markProcessed(dedupeKey, body.pullRequestUrl || "");
  return {
    ok: true,
    pullRequestUrl: body.pullRequestUrl,
    pullRequestNumber: body.pullRequestNumber,
    source
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_SUBMISSION) {
    return false;
  }

  console.log("[CT-EXT][background] message received", {
    type: message.type,
    source: message.source
  });

  submitToBackend(message.payload || {}, message.source || "unknown")
    .then((result) => {
      console.log("[CT-EXT][background] result", result);
      if (result.ok && !result.skipped) {
        notify("Coding Test Auto PR", `PR 생성 완료: ${result.pullRequestUrl || "링크 확인"}`);
      } else if (!result.ok) {
        notify("Coding Test Auto PR", `실패: ${result.message}`);
      }
      sendResponse(result);
    })
    .catch((error) => {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error("[CT-EXT][background] unhandled error", error);
      notify("Coding Test Auto PR", `실패: ${messageText}`);
      sendResponse({ ok: false, message: messageText });
    });

  return true;
});
