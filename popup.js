const DEFAULT_SETTINGS = {
  endpoint: "http://localhost:11434",
  model: "qwen3.5:27b"
};

document.addEventListener("DOMContentLoaded", async () => {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  document.getElementById("model").textContent = settings.model;
  document.getElementById("endpoint").textContent = settings.endpoint;
  document.getElementById("openOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
