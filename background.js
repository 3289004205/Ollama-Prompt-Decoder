const DEFAULT_SETTINGS = {
  endpoint: "http://localhost:11434",
  model: "qwen3.5:27b",
  maxChars: 2000,
  requestTimeoutMs: 180000,
  imageMaxSide: 1024,
  imageQuality: 0.85
};

const QUICK_PROMPT_EXTENSION_ID = "hnjamiaoicaepbkhdoknhhcedjdocpkd";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...existing });
  await installCorsBypassRules();
});

chrome.runtime.onStartup.addListener(() => {
  installCorsBypassRules().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SAVE_TO_QUICK_PROMPT") {
    saveToQuickPrompt(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type !== "EXTRACT_IMAGE_PROMPTS") {
    return false;
  }

  extractPrompts(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function saveToQuickPrompt(payload) {
  const content = String(payload?.content || "").trim();
  if (!content) {
    throw new Error("没有可保存的提示词内容。");
  }

  const quickPromptUrl = `chrome-extension://${QUICK_PROMPT_EXTENSION_ID}/options.html?action=new&content=${encodeURIComponent(content)}`;
  try {
    await chrome.tabs.create({ url: quickPromptUrl, active: true });
    return { opened: true };
  } catch {
    throw new Error("无法打开 Quick Prompt。请确认已安装并启用 quick-prompt 插件。");
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "OLLAMA_PROMPT_EXTRACTION") {
    return;
  }

  let abortController = null;
  port.onMessage.addListener((message) => {
    if (message?.type !== "START_EXTRACTION") {
      return;
    }

    abortController = new AbortController();
    extractPromptsWithProgress(message.payload, (progress) => {
      safePost(port, { type: "PROGRESS", progress });
    }, abortController.signal)
      .then((result) => safePost(port, { type: "DONE", result }))
      .catch((error) => {
        safePost(port, { type: "ERROR", error: error.message || String(error) });
      });
  });

  port.onDisconnect.addListener(() => {
    if (abortController) {
      abortController.abort();
    }
  });
});

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The panel may have closed before the async task completed.
  }
}

async function installCorsBypassRules() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    return;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1001, 1002],
    addRules: [
      {
        id: 1001,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Origin",
              operation: "remove"
            }
          ]
        },
        condition: {
          urlFilter: "|http://localhost:11434/",
          resourceTypes: ["xmlhttprequest", "other"]
        }
      },
      {
        id: 1002,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "Origin",
              operation: "remove"
            }
          ]
        },
        condition: {
          urlFilter: "|http://127.0.0.1:11434/",
          resourceTypes: ["xmlhttprequest", "other"]
        }
      }
    ]
  });
}

async function getSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    endpoint: normalizeEndpoint(settings.endpoint || DEFAULT_SETTINGS.endpoint),
    model: settings.model || DEFAULT_SETTINGS.model,
    maxChars: Number(settings.maxChars || DEFAULT_SETTINGS.maxChars),
    requestTimeoutMs: Number(settings.requestTimeoutMs || DEFAULT_SETTINGS.requestTimeoutMs),
    imageMaxSide: Number(settings.imageMaxSide || DEFAULT_SETTINGS.imageMaxSide),
    imageQuality: Number(settings.imageQuality || DEFAULT_SETTINGS.imageQuality)
  };
}

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, "");
}

async function extractPrompts(payload) {
  const settings = await getSettings();
  const imageBase64 = await imageUrlToBase64(payload.imageUrl);
  const response = await fetch(`${settings.endpoint}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      format: "json",
      options: {
        temperature: 0.2,
        num_predict: 600
      },
      messages: [
        {
          role: "system",
          content: [
            "你是专业的图片提示词反推助手。",
            "只输出 JSON，不要 Markdown，不要解释。",
            "必须返回三个字段：jsonPrompt、zhPrompt、enPrompt。",
            "zhPrompt 和 enPrompt 各输出约 300 字。",
            "提示词要描述主体、场景、构图、风格、光线、色彩和质量关键词。",
            "如果图片无法读取，基于可用的图片 URL、alt、title 和页面上下文生成保守提示词。"
          ].join("")
        },
        {
          role: "user",
          content: buildUserPrompt(payload, settings.maxChars),
          images: [imageBase64]
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throwOllamaHttpError(response.status, text);
  }

  const data = await response.json();
  const content = data?.message?.content;
  if (!content) {
    throw new Error("Ollama 没有返回可用内容。");
  }

  return normalizeModelResult(content, settings.maxChars, payload);
}

async function extractPromptsWithProgress(payload, onProgress, signal) {
  const settings = await getSettings();
  onProgress({ percent: 8, stage: "读取设置", detail: `模型：${settings.model}` });

  onProgress({ percent: 18, stage: "读取图片", detail: "正在获取网页图片数据" });
  const imageBase64 = await imageUrlToBase64(payload.imageUrl, signal, {
    maxSide: settings.imageMaxSide,
    quality: settings.imageQuality,
    onProgress: (detail) => {
    onProgress({ percent: 30, stage: "图片转码", detail });
    }
  });

  onProgress({ percent: 38, stage: "生成 JSON", detail: "正在生成结构化 JSON 提示词" });
  const jsonContent = await requestSinglePrompt(settings, buildJsonTask(payload), imageBase64, onProgress, signal);

  onProgress({ percent: 58, stage: "生成中文", detail: "正在生成中文自然语言提示词" });
  const zhContent = await requestSinglePrompt(settings, buildZhTask(payload), imageBase64, onProgress, signal);

  onProgress({ percent: 78, stage: "生成英文", detail: "正在生成英文自然语言提示词" });
  const enContent = await requestSinglePrompt(settings, buildEnTask(payload), imageBase64, onProgress, signal);

  onProgress({ percent: 96, stage: "整理结果", detail: "正在分别整理 JSON、中文和英文结果" });
  const result = normalizeSeparateResults({ jsonContent, zhContent, enContent }, settings.maxChars, payload);
  result.meta = {
    rawLength: jsonContent.length + zhContent.length + enContent.length
  };
  onProgress({ percent: 100, stage: "完成", detail: "提示词反推完成" });
  return result;
}

async function requestSinglePrompt(settings, task, imageBase64, onProgress, signal) {
  let content = await callOllamaStream(settings, task, imageBase64, onProgress, signal);
  content = stripPromptOutput(content).trim();
  if (content) {
    return content;
  }

  onProgress({
    percent: Math.min(94, task.percent + 8),
    stage: `${task.label}重试`,
    detail: "上一次为空，正在用更短要求重试"
  });
  const retryTask = {
    ...task,
    percent: Math.min(90, task.percent + 8),
    prompt: task.retryPrompt || task.prompt
  };
  return stripPromptOutput(await callOllamaStream(settings, retryTask, imageBase64, onProgress, signal)).trim();
}

async function requestPromptWithRetries(settings, payload, imageBase64, onProgress, signal) {
  const attempts = [
    {
      label: "视觉分析",
      percent: 42,
      prompt: buildVisionPrompt(payload, settings.maxChars),
      system: buildVisionSystemPrompt()
    },
    {
      label: "简化重试",
      percent: 62,
      prompt: buildCompactVisionPrompt(payload, settings.maxChars),
      system: "你是图片提示词反推助手。直接输出三段内容：JSON、中文提示词、English prompt。不要输出思考过程。"
    },
    {
      label: "最小重试",
      percent: 78,
      prompt: "请描述这张图片，适合作为文生图提示词。中文约300字，英文约500字。不要留空，不要输出思考过程。",
      system: "你必须基于图片输出可见提示词内容。不要解释，不要输出思考过程，不要输出分析过程。"
    }
  ];

  let lastContent = "";
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    onProgress({
      percent: attempt.percent,
      stage: attempt.label,
      detail: index === 0 ? "正在等待模型响应" : "上一次输出为空，正在自动重试"
    });

    const content = await callOllamaStream(settings, attempt, imageBase64, onProgress, signal);
    lastContent = content;
    if (content.trim()) {
      return content;
    }
  }

  return lastContent;
}

async function callOllamaStream(settings, attempt, imageBase64, onProgress, signal) {
  const requestController = new AbortController();
  const timeoutId = setTimeout(() => {
    requestController.abort(new Error("等待 Ollama 响应超时。"));
  }, settings.requestTimeoutMs);
  const heartbeatId = startRequestHeartbeat(onProgress, signal, requestController.signal, attempt.percent);
  signal?.addEventListener("abort", () => requestController.abort(), { once: true });

  let response;
  try {
    response = await fetch(`${settings.endpoint}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: requestController.signal,
      body: JSON.stringify({
        model: settings.model,
        stream: true,
        think: false,
        options: {
          temperature: 0.15,
          num_predict: 1600
        },
        messages: [
          {
            role: "system",
            content: attempt.system
          },
          {
            role: "user",
            content: attempt.prompt,
            images: [imageBase64]
          }
        ]
      })
    });
  } catch (error) {
    if (requestController.signal.aborted && !signal?.aborted) {
      throw new Error("等待 Ollama 响应超过 180 秒。请确认 Ollama 已启动、插件已重新加载，并用 ollama ps 检查模型是否开始运行。");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    clearInterval(heartbeatId);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throwOllamaHttpError(response.status, text);
  }

  onProgress({ percent: Math.min(90, attempt.percent + 8), stage: "模型推理", detail: "正在接收模型输出" });
  const content = await readOllamaStream(response, (tokenCount) => {
    const percent = Math.min(94, attempt.percent + 8 + Math.floor(tokenCount / 8));
    onProgress({ percent, stage: "模型推理", detail: `已接收 ${tokenCount} 段输出` });
  }, signal);
  return stripThinking(content).trim();
}

function startRequestHeartbeat(onProgress, parentSignal, requestSignal, basePercent = 42) {
  const startedAt = Date.now();
  return setInterval(() => {
    if (parentSignal?.aborted || requestSignal?.aborted) {
      return;
    }
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    onProgress({
      percent: Math.min(basePercent + 12, basePercent + Math.floor(elapsedSeconds / 15)),
      stage: "等待 Ollama 响应",
      detail: `已等待 ${elapsedSeconds} 秒。如果 ollama ps 为空，说明模型还没有进入推理。`
    });
  }, 3000);
}

async function readOllamaStream(response, onToken, signal) {
  if (!response.body) {
    const data = await response.json();
    return data?.message?.content || "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let tokenCount = 0;

  while (true) {
    if (signal?.aborted) {
      throw new Error("任务已取消。");
    }

    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (item?.error) {
        throw new Error(item.error);
      }
      const chunk = item?.message?.content || "";
      if (chunk) {
        content += chunk;
        tokenCount += 1;
        onToken(tokenCount);
      }
      if (item?.done) {
        return content;
      }
    }
  }

  if (buffer.trim()) {
    try {
      const item = JSON.parse(buffer);
      if (item?.error) {
        throw new Error(item.error);
      }
      content += item?.message?.content || "";
    } catch {
      content += "";
    }
  }

  return content;
}

function buildUserPrompt(payload, maxChars) {
  return buildVisionPrompt(payload, maxChars);
}

function buildImageMeta(payload) {
  return {
    imageUrl: payload.imageUrl,
    alt: payload.alt || "",
    title: payload.title || "",
    width: payload.width || "",
    height: payload.height || "",
    pageTitle: payload.pageTitle || "",
    surroundingText: payload.surroundingText || ""
  };
}

function buildJsonTask(payload) {
  return {
    label: "JSON",
    percent: 38,
    system: [
      "你是图片提示词结构化分析器。",
      "严禁输出思考过程、分析过程、解释、Markdown。",
      "只输出一个合法 JSON 对象，不能包含 JSON 以外的任何文字。",
      "JSON 必须根据图片真实内容填写，不要编造不存在的物体。"
    ].join(""),
    prompt: [
      "请分析图片，只输出一个分层 JSON 对象。",
      "必须包含这些顶层字段：image_overview、framing_elements、scene_details、background_details、photographic_and_aesthetic_attributes。",
      "可根据图片真实内容增加或重命名细节字段，例如人物、产品、建筑、自然景观、室内空间、食物等。",
      "字段内容要像摄影/文生图提示词反推一样详细，描述构图、主体、场景、光线、色彩、材质、背景、摄影属性和审美主题。",
      "不要输出中文提示词，不要输出英文提示词，不要输出思考过程。",
      `图片与页面信息：${JSON.stringify(buildImageMeta(payload))}`
    ].join("\n"),
    retryPrompt: [
      "只输出合法 JSON 对象。",
      "顶层字段：image_overview、framing_elements、scene_details、background_details、photographic_and_aesthetic_attributes。",
      "不要解释，不要 Markdown，不要思考过程。"
    ].join("\n")
  };
}

function buildZhTask(payload) {
  return {
    label: "中文",
    percent: 58,
    system: [
      "你是中文文生图提示词写作助手。",
      "严禁输出 JSON、Markdown、列表、标题、思考过程、分析过程或解释。",
      "只输出一段中文自然语言提示词。"
    ].join(""),
    prompt: [
      "请根据图片输出一段约300字的中文文生图提示词。",
      "必须是普通文本句子格式，不要 JSON，不要键值对，不要项目符号，不要标题。",
      "内容包含主体、环境、构图、光线、色彩、材质、风格、镜头、景深、细节和质量关键词。",
      "只输出中文提示词正文。",
      `图片与页面信息：${JSON.stringify(buildImageMeta(payload))}`
    ].join("\n"),
    retryPrompt: "只输出一段约300字中文自然语言文生图提示词。不要 JSON，不要标题，不要解释，不要思考过程。"
  };
}

function buildEnTask(payload) {
  return {
    label: "English",
    percent: 78,
    system: [
      "You are an English text-to-image prompt writer.",
      "Never output JSON, Markdown, lists, headings, reasoning, analysis, or explanations.",
      "Output only one plain English paragraph."
    ].join(""),
    prompt: [
      "Based on the image, write one English text-to-image prompt of about 500 characters.",
      "It must be plain sentence text, not JSON, not key-value pairs, not bullet points, not a title.",
      "Cover the subject, environment, composition, lighting, colors, materials, style, camera angle, depth of field, details, and quality keywords.",
      "Output only the English prompt paragraph.",
      `Image and page metadata: ${JSON.stringify(buildImageMeta(payload))}`
    ].join("\n"),
    retryPrompt: "Output only one plain English text-to-image prompt paragraph, about 500 characters. No JSON, no heading, no explanation, no reasoning."
  };
}

function buildVisionSystemPrompt() {
  return [
    "你是专业的图片提示词反推助手。",
    "严禁输出思考过程、分析过程、推理过程、解释性寒暄或 Markdown。",
    "只输出最终结果内容。",
    "优先根据图片本身生成内容。",
    "输出必须包含 JSON、中文提示词、English prompt 三部分，并分别使用 JSON:、中文:、English: 标签。",
    "JSON 必须是分层对象，中文提示词约300字，English prompt 约500字。",
    "描述主体、场景、构图、风格、光线、色彩、材质、摄影属性和质量关键词。"
  ].join("");
}

function buildVisionPrompt(payload, maxChars) {
  const meta = {
    imageUrl: payload.imageUrl,
    alt: payload.alt || "",
    title: payload.title || "",
    width: payload.width || "",
    height: payload.height || "",
    pageTitle: payload.pageTitle || "",
    surroundingText: payload.surroundingText || ""
  };

  return [
    "请分析这张图片并反推提示词。",
    "不要输出思考过程、分析过程、推理过程或解释，只输出以下三个结果区块：",
    "JSON: 输出一个分层 JSON 对象。必须包含 image_overview、framing_elements、scene_details、background_details、photographic_and_aesthetic_attributes。每个字段根据图片真实内容填写；如果某类元素不存在，用与图片匹配的字段名替代，不要编造不存在的物体。",
    "中文: 输出约300字的中文文生图提示词，包含主体、环境、构图、光线、色彩、材质、风格、镜头和质量词。",
    "English: Output an English text-to-image prompt around 500 characters, covering subject, environment, composition, lighting, colors, materials, style, camera, and quality keywords.",
    `图片与页面信息：${JSON.stringify(meta)}`
  ].join("\n");
}

function buildCompactVisionPrompt(payload, maxChars) {
  const meta = [payload.alt, payload.title, payload.pageTitle, payload.surroundingText]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 500);
  return [
    "请看图生成提示词，必须有内容，不要留空。",
    "1. JSON:",
    "2. 中文: 约300字",
    "3. English: around 500 characters",
    `参考文本：${meta || "无"}`
  ].join("\n");
}

async function imageUrlToBase64(imageUrl, signal, options = {}) {
  if (!imageUrl) {
    throw new Error("没有找到图片地址。");
  }

  const onProgress = options.onProgress;
  if (imageUrl.startsWith("data:image/")) {
    onProgress?.("图片已是 base64 数据，正在尝试压缩");
    const blob = await dataUrlToBlob(imageUrl);
    return await blobToOptimizedBase64(blob, options);
  }

  const response = await fetch(imageUrl, {
    credentials: "include",
    cache: "force-cache",
    signal
  });

  if (!response.ok) {
    throw new Error(`图片读取失败：${response.status}`);
  }

  const blob = await response.blob();
  onProgress?.(`原图大小：${formatBytes(blob.size)}，正在压缩`);
  return await blobToOptimizedBase64(blob, options);
}

async function blobToOptimizedBase64(blob, options = {}) {
  try {
    const bitmap = await createImageBitmap(blob);
    const maxSide = options.maxSide || DEFAULT_SETTINGS.imageMaxSide;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const optimizedBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: options.quality || DEFAULT_SETTINGS.imageQuality
    });
    options.onProgress?.(`已压缩到 ${width}x${height}，${formatBytes(optimizedBlob.size)}`);
    return await blobToBase64(optimizedBlob);
  } catch {
    options.onProgress?.(`图片压缩失败，使用原始数据 ${formatBytes(blob.size)}`);
    return await blobToBase64(blob);
  }
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return await response.blob();
}

function normalizeModelResult(content, maxChars, payload = {}) {
  const cleaned = stripPromptOutput(content || "");
  if (!cleaned.trim()) {
    return buildFallbackResult(payload, maxChars, "模型返回了空内容");
  }

  let parsed;
  try {
    parsed = JSON.parse(extractJsonObject(cleaned));
  } catch {
    parsed = parseLabeledPrompt(cleaned);
  }

  const fallback = buildFallbackResult(payload, maxChars, "模型没有返回该字段");
  return {
    jsonPrompt: formatJsonPrompt(firstNonEmpty(parsed.jsonPrompt, fallback.jsonPrompt), payload),
    zhPrompt: clampText(firstNonEmpty(parsed.zhPrompt, fallback.zhPrompt), maxChars),
    enPrompt: clampText(firstNonEmpty(parsed.enPrompt, fallback.enPrompt), maxChars)
  };
}

function normalizeSeparateResults(parts, maxChars, payload = {}) {
  const fallback = buildFallbackResult(payload, maxChars, "模型返回为空或格式不正确");
  return {
    jsonPrompt: formatJsonPrompt(firstNonEmpty(parts.jsonContent, fallback.jsonPrompt), payload),
    zhPrompt: clampText(cleanTextPrompt(firstNonEmpty(parts.zhContent, fallback.zhPrompt), "zh", fallback.zhPrompt), maxChars),
    enPrompt: clampText(cleanTextPrompt(firstNonEmpty(parts.enContent, fallback.enPrompt), "en", fallback.enPrompt), maxChars)
  };
}

function cleanTextPrompt(value, language, fallback) {
  let text = stripPromptOutput(String(value || ""));
  text = text
    .replace(/^(?:中文提示词|中文|Chinese|English prompt|English|英文提示词|英文)\s*[:：]\s*/i, "")
    .trim();

  if (looksLikeJson(text)) {
    text = extractTextFromJsonLike(text, language);
  }

  text = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  if (!text || looksLikeJson(text)) {
    return fallback;
  }

  return text;
}

function looksLikeJson(text) {
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || /"image_overview"\s*:/.test(trimmed);
}

function extractTextFromJsonLike(text, language) {
  try {
    const parsed = JSON.parse(extractJsonObject(text));
    const preferredKeys = language === "zh"
      ? ["zhPrompt", "chinese_prompt", "中文提示词", "中文", "prompt"]
      : ["enPrompt", "english_prompt", "English prompt", "英文提示词", "英文", "prompt"];
    const found = findStringByKeys(parsed, preferredKeys);
    if (found) {
      return found;
    }
    return collectJsonStrings(parsed).join(language === "zh" ? "，" : ", ");
  } catch {
    return "";
  }
}

function findStringByKeys(value, keys) {
  if (!value || typeof value !== "object") {
    return "";
  }
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  for (const child of Object.values(value)) {
    const found = findStringByKeys(child, keys);
    if (found) {
      return found;
    }
  }
  return "";
}

function collectJsonStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonStrings(item, output);
    }
    return output;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      collectJsonStrings(child, output);
    }
  }
  return output.slice(0, 20);
}

function formatJsonPrompt(value, payload) {
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(extractJsonObject(stripPromptOutput(value))) : value;
  } catch {
    parsed = buildStructuredJsonFromText(stripPromptOutput(String(value || "")), payload);
  }
  return JSON.stringify(parsed, null, 2);
}

function buildStructuredJsonFromText(text, payload = {}) {
  const subject = payload.alt || payload.title || "Image subject";
  const context = payload.surroundingText || payload.pageTitle || text || "No extra page context";
  return {
    image_overview: {
      composition_type: "Auto-inferred composition",
      primary_scene: subject,
      dominant_mood: "Inferred from visible image content",
      overall_color_palette: "Inferred from image colors",
      lighting_style: "Inferred natural or artificial lighting"
    },
    main_subject_details: {
      subject,
      visual_description: text || "Model output was not valid JSON; this structured fallback was generated from available image/page context.",
      placement: "Inferred from image framing",
      texture_and_materials: "Inferred from visible details"
    },
    scene_details: {
      environment: context,
      objects_and_props: "Describe visible supporting objects and spatial relationships",
      composition_notes: "Balanced text-to-image prompt structure based on available context"
    },
    background_details: {
      background_scene: "Inferred background and depth cues",
      atmosphere: "Inferred mood and environmental quality"
    },
    photographic_and_aesthetic_attributes: {
      style: "Photorealistic / image-matched style",
      camera_angle: "Inferred camera angle",
      depth_of_field: "Inferred focus depth",
      texture_details: "Preserve visible textures and material detail",
      composition_rules: "Use image-matched framing, perspective, and visual hierarchy",
      quality_keywords: "high detail, coherent composition, natural lighting"
    }
  };
}

function parseLabeledPrompt(text) {
  const cleanText = stripPromptOutput(text);
  const sections = {
    jsonPrompt: "",
    zhPrompt: "",
    enPrompt: ""
  };
  const patterns = [
    ["jsonPrompt", /(?:^|\n)\s*(?:JSON|jsonPrompt|1[.、]\s*JSON)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:中文|Chinese|zhPrompt|2[.、]\s*中文|English|英文|enPrompt|3[.、]\s*English)\s*[:：]|$)/i],
    ["zhPrompt", /(?:^|\n)\s*(?:中文|Chinese|zhPrompt|2[.、]\s*中文)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:English|英文|enPrompt|3[.、]\s*English)\s*[:：]|$)/i],
    ["enPrompt", /(?:^|\n)\s*(?:English|英文|enPrompt|3[.、]\s*English)\s*[:：]\s*([\s\S]*?)$/i]
  ];

  for (const [key, pattern] of patterns) {
    const match = cleanText.match(pattern);
    sections[key] = stripPromptOutput(match?.[1] || "");
  }

  if (!sections.zhPrompt && /[\u4e00-\u9fff]/.test(cleanText)) {
    sections.zhPrompt = stripPromptOutput(cleanText);
  }
  if (!sections.enPrompt && /[a-z]{4,}/i.test(cleanText)) {
    sections.enPrompt = stripPromptOutput(cleanText);
  }
  if (!sections.jsonPrompt) {
    const jsonLike = extractJsonObject(cleanText);
    sections.jsonPrompt = jsonLike !== cleanText ? jsonLike : JSON.stringify({
      description: cleanText.slice(0, 500)
    });
  }

  return sections;
}

function stripCodeFence(text) {
  return String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function stripThinking(text) {
  return stripPromptOutput(text);
}

function stripPromptOutput(text) {
  let output = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/^\s*(?:思考过程|思考|分析过程|分析|Reasoning|Thinking)\s*[:：][\s\S]*?(?=\n\s*(?:JSON|jsonPrompt|中文|Chinese|zhPrompt|English|英文|enPrompt|1[.、]|2[.、]|3[.、])\s*[:：])/i, "")
    .replace(/^\s*(?:好的|我来分析|下面是|以下是)[\s\S]*?(?=\n\s*(?:JSON|jsonPrompt|中文|Chinese|zhPrompt|English|英文|enPrompt)\s*[:：])/i, "")
    .trim();

  const labelIndex = findFirstPromptLabelIndex(output);
  if (labelIndex > 0) {
    output = output.slice(labelIndex).trim();
  }

  return stripCodeFence(output);
}

function findFirstPromptLabelIndex(text) {
  const indexes = [
    text.search(/(?:^|\n)\s*(?:JSON|jsonPrompt|1[.、]\s*JSON)\s*[:：]/i),
    text.search(/(?:^|\n)\s*(?:中文|Chinese|zhPrompt|2[.、]\s*中文)\s*[:：]/i),
    text.search(/(?:^|\n)\s*(?:English|英文|enPrompt|3[.、]\s*English)\s*[:：]/i),
    text.search(/\{\s*"image_overview"\s*:/i)
  ].filter((index) => index >= 0);

  return indexes.length ? Math.min(...indexes) : -1;
}

function extractJsonObject(text) {
  const trimmed = String(text).trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function firstNonEmpty(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.trim() ? text : fallback;
}

function clampText(value, maxChars) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function buildFallbackResult(payload, maxChars, reason) {
  const subject = payload.alt || payload.title || "网页图片";
  const size = payload.width && payload.height ? `${payload.width}x${payload.height}` : "未知尺寸";
  const context = payload.surroundingText || payload.pageTitle || "无页面上下文";
  const jsonPrompt = buildStructuredJsonFromText(reason, payload);
  jsonPrompt.image_overview.composition_type = size;
  return {
    jsonPrompt: JSON.stringify(jsonPrompt, null, 2),
    zhPrompt: clampText(`${subject}，网页图片，结合页面上下文：${context}，保守反推提示词，清晰构图，自然光线，细节丰富。${reason}。`, maxChars),
    enPrompt: clampText(`${subject}, web image, conservative reverse prompt based on page context: ${context}, clear composition, natural lighting, detailed visual style. ${reason}.`, maxChars)
  };
}

function throwOllamaHttpError(status, text) {
  if (status === 403) {
    throw new Error([
      "Ollama 请求失败：403。",
      "通常是 Ollama 未允许 Chrome 扩展来源访问。",
      "插件已尝试移除 Origin 请求头，请在 chrome://extensions/ 重新加载插件后再试。"
    ].join(""));
  }
  throw new Error(`Ollama 请求失败：${status} ${text}`.trim());
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "图片读取完成";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
