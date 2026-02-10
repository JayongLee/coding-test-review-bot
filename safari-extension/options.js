const STORAGE_CONFIG_KEY = "ct_auto_pr_config";

function getStorageArea() {
  return chrome.storage.sync || chrome.storage.local;
}

function loadConfig() {
  return new Promise((resolve) => {
    getStorageArea().get([STORAGE_CONFIG_KEY], (result) => resolve(result[STORAGE_CONFIG_KEY] || {}));
  });
}

function saveConfig(config) {
  return new Promise((resolve) => {
    getStorageArea().set({ [STORAGE_CONFIG_KEY]: config }, () => resolve());
  });
}

function valueOf(id) {
  return String(document.getElementById(id)?.value || "").trim();
}

function setValue(id, value) {
  const input = document.getElementById(id);
  if (input) input.value = value || "";
}

function setStatus(message) {
  const node = document.getElementById("status");
  if (!node) return;
  node.textContent = message;
}

async function hydrate() {
  const config = await loadConfig();
  setValue("apiEndpoint", config.apiEndpoint || "");
  setValue("apiToken", config.apiToken || "");
  setValue("repoOwner", config.repoOwner || "");
  setValue("repoName", config.repoName || "");
  setValue("baseBranch", config.baseBranch || "main");
  setValue("defaultLanguage", config.defaultLanguage || "Java");
}

async function onSave() {
  const config = {
    apiEndpoint: valueOf("apiEndpoint"),
    apiToken: valueOf("apiToken"),
    repoOwner: valueOf("repoOwner"),
    repoName: valueOf("repoName"),
    baseBranch: valueOf("baseBranch") || "main",
    defaultLanguage: valueOf("defaultLanguage") || "Java"
  };

  await saveConfig(config);
  setStatus("저장되었습니다.");
}

document.getElementById("saveButton")?.addEventListener("click", () => {
  void onSave();
});

void hydrate();
