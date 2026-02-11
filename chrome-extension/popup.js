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

      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            message: "지원 대상 페이지(BOJ status / Programmers lesson)가 아닙니다."
          });
          return;
        }

        resolve(response || { ok: false, message: "응답이 없습니다." });
      });
    });
  });
}

async function onClick() {
  setStatus("전송 중...");
  const result = await sendToActiveTab({ type: TRIGGER_MESSAGE });

  if (result.ok) {
    const url = result.pullRequestUrl ? `\n${result.pullRequestUrl}` : "";
    const skipped = result.skipped ? "(이미 처리됨) " : "";
    setStatus(`완료 ${skipped}${url}`);
    return;
  }

  setStatus(`실패: ${result.message || "알 수 없는 오류"}`);
}

document.getElementById("triggerButton")?.addEventListener("click", () => {
  void onClick();
});
