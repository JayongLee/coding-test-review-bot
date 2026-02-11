const STORAGE_CONFIG_KEY = "ct_pr_config";

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

function byId(id) {
  return document.getElementById(id);
}

function valueOf(id) {
  return String(byId(id)?.value || "").trim();
}

function setValue(id, value) {
  const node = byId(id);
  if (node) node.value = value || "";
}

function setStatus(message) {
  const node = byId("status");
  if (!node) return;
  node.textContent = message;
}

async function hydrate() {
  const config = await loadConfig();
  setValue("githubToken", config.githubToken || "");
  setValue("repoOwner", config.repoOwner || "");
  setValue("repoName", config.repoName || "");
  setValue("baseBranch", config.baseBranch || "main");
  setValue("defaultLanguage", config.defaultLanguage || "Java");
  setValue("defaultAsk", config.defaultAsk || "");
}

async function onSave() {
  const config = {
    githubToken: valueOf("githubToken"),
    repoOwner: valueOf("repoOwner"),
    repoName: valueOf("repoName"),
    baseBranch: valueOf("baseBranch") || "main",
    defaultLanguage: valueOf("defaultLanguage") || "Java",
    defaultAsk: valueOf("defaultAsk")
  };

  await saveConfig(config);
  setStatus("저장되었습니다.");
}

byId("saveButton")?.addEventListener("click", () => {
  void onSave();
});

void hydrate();
