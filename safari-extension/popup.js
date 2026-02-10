const TRIGGER_MESSAGE = "CT_TRIGGER_SUBMISSION";

function setStatus(message) {
  const node = document.getElementById("status");
  if (!node) return;
  node.textContent = message;
}

function sendToActiveTab(message) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || typeof tab.id !== "number") {
        resolve({ ok: false, message: "활성 탭을 찾을 수 없습니다." });
        return;
      }

      console.log("[CT-EXT][popup] send message", { tabId: tab.id, url: tab.url });
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[CT-EXT][popup] sendMessage failed", {
            error: chrome.runtime.lastError.message,
            url: tab.url
          });
          resolve({
            ok: false,
            message:
              "현재 페이지에 확장 스크립트가 없습니다. BOJ source/Programmers lesson 페이지인지 확인 후 새로고침하고 다시 시도하세요."
          });
          return;
        }

        if (!response) {
          console.warn("[CT-EXT][popup] empty response", { url: tab.url });
        }
        resolve(response || { ok: false, message: "콘텐츠 스크립트 응답이 없습니다. 페이지 새로고침 후 재시도하세요." });
      });
    });
  });
}

async function onTrigger() {
  console.log("[CT-EXT][popup] manual trigger clicked");
  setStatus("전송 중...");
  const result = await sendToActiveTab({ type: TRIGGER_MESSAGE });

  if (result.ok) {
    const link = result.pullRequestUrl ? `\n${result.pullRequestUrl}` : "";
    setStatus(`완료: ${result.message || "PR 생성 요청 성공"}${link}`);
    return;
  }

  setStatus(`실패: ${result.message || "알 수 없는 오류"}`);
}

document.getElementById("triggerButton")?.addEventListener("click", () => {
  void onTrigger();
});
