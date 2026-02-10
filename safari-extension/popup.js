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
            message: "현재 페이지는 지원 대상(BOJ source/Programmers lesson)이 아닙니다."
          });
          return;
        }

        resolve(response || { ok: false, message: "응답이 없습니다." });
      });
    });
  });
}

async function onTrigger() {
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
