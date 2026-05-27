const DEFAULT_SETTINGS = {
  endpoint: "http://localhost:11434",
  model: "qwen3.5:27b",
  maxChars: 2000
};

const form = document.getElementById("settingsForm");
const endpoint = document.getElementById("endpoint");
const model = document.getElementById("model");
const maxChars = document.getElementById("maxChars");
const status = document.getElementById("status");
const testConnection = document.getElementById("testConnection");

document.addEventListener("DOMContentLoaded", loadSettings);
form.addEventListener("submit", saveSettings);
testConnection.addEventListener("click", testOllama);

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  endpoint.value = settings.endpoint;
  model.value = settings.model;
  maxChars.value = settings.maxChars;
}

async function saveSettings(event) {
  event.preventDefault();
  const settings = readSettings();
  await chrome.storage.sync.set(settings);
  setStatus("设置已保存。");
}

async function testOllama() {
  const settings = readSettings();
  setStatus("正在测试 Ollama 连接...");
  try {
    const response = await fetch(`${normalizeEndpoint(settings.endpoint)}/api/tags`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const models = (data.models || []).map((item) => item.name);
    const found = models.includes(settings.model);
    setStatus(found ? "连接正常，已找到当前模型。" : "连接正常，但没有在本地模型列表中找到当前模型。");
  } catch (error) {
    setStatus(`连接失败：${error.message || error}`);
  }
}

function readSettings() {
  return {
    endpoint: normalizeEndpoint(endpoint.value.trim() || DEFAULT_SETTINGS.endpoint),
    model: model.value.trim() || DEFAULT_SETTINGS.model,
    maxChars: Math.min(3000, Math.max(300, Number(maxChars.value || DEFAULT_SETTINGS.maxChars)))
  };
}

function normalizeEndpoint(value) {
  return value.replace(/\/+$/, "");
}

function setStatus(message) {
  status.textContent = message;
}
