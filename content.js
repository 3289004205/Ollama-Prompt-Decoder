const MIN_IMAGE_SIZE = 80;
const BADGE_OFFSET = 8;
let activePanel = null;
let activePanelImage = null;
let activePort = null;
let badgeUpdateQueued = false;
let hoverBadge = null;
let hoveredImage = null;
let hideBadgeTimer = null;
let lastPointer = { x: -1, y: -1 };

init();

function init() {
  const observer = new MutationObserver(() => {
    scheduleBadgeUpdate();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "class", "hidden"]
  });

  hoverBadge = createBadge();
  document.documentElement.appendChild(hoverBadge);
  document.addEventListener("mousemove", handlePointerMove, true);
  document.addEventListener("mouseover", handleImageMouseOver, true);
  document.addEventListener("mouseout", handleImageMouseOut, true);
  document.addEventListener("scroll", scheduleBadgeUpdate, { passive: true, capture: true });
  window.addEventListener("scroll", scheduleBadgeUpdate, { passive: true });
  window.addEventListener("resize", scheduleBadgeUpdate);
  setInterval(updateBadgePositions, 500);
}

function isCandidateImage(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  return width >= MIN_IMAGE_SIZE &&
    height >= MIN_IMAGE_SIZE &&
    Boolean(image.currentSrc || image.src) &&
    isElementRenderable(image);
}

function createBadge() {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "ollama-prompt-badge";
  badge.textContent = "提取提示词";
  badge.title = "使用本地 Ollama 反推图片提示词";
  badge.addEventListener("mouseover", () => {
    clearTimeout(hideBadgeTimer);
  });
  badge.addEventListener("mouseout", () => {
    hideBadgeSoon();
  });
  badge.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (hoveredImage && isCandidateImage(hoveredImage) && isImageVisible(hoveredImage)) {
      openPromptPanel(hoveredImage);
    }
  });
  return badge;
}

function updateBadgePositions() {
  if (activePanelImage && (!activePanelImage.isConnected || !isImageVisible(activePanelImage))) {
    closePromptPanel();
  }

  if (!hoverBadge || !hoveredImage || !hoveredImage.isConnected || !isCandidateImage(hoveredImage)) {
    hideBadge();
    return;
  }

  const rect = hoveredImage.getBoundingClientRect();
  if (!isImageVisible(hoveredImage, rect)) {
    hideBadge();
    return;
  }

  hoverBadge.style.display = "flex";
  hoverBadge.style.top = `${Math.max(8, rect.top + BADGE_OFFSET)}px`;
  hoverBadge.style.left = `${Math.min(window.innerWidth - hoverBadge.offsetWidth - 8, rect.right - hoverBadge.offsetWidth - BADGE_OFFSET)}px`;
}

function handleImageMouseOver(event) {
  const image = event.target?.closest?.("img");
  if (!image || !isCandidateImage(image) || !isImageVisible(image)) {
    return;
  }
  rememberPointer(event);
  clearTimeout(hideBadgeTimer);
  hoveredImage = image;
  updateBadgePositions();
}

function handleImageMouseOut(event) {
  rememberPointer(event);
  const image = event.target?.closest?.("img");
  if (!image || image !== hoveredImage) {
    return;
  }

  const related = event.relatedTarget;
  if (related === hoverBadge || hoverBadge?.contains(related)) {
    return;
  }

  hideBadgeSoon();
}

function handlePointerMove(event) {
  rememberPointer(event);
  const image = event.target?.closest?.("img");
  if (image && isCandidateImage(image) && isImageVisible(image)) {
    clearTimeout(hideBadgeTimer);
    if (hoveredImage !== image) {
      hoveredImage = image;
    }
    updateBadgePositions();
    return;
  }

  if (hoveredImage && isPointerOverImageOrBadge()) {
    clearTimeout(hideBadgeTimer);
    updateBadgePositions();
    return;
  }

  if (hoveredImage) {
    hideBadgeSoon();
  }
}

function rememberPointer(event) {
  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    lastPointer = { x: event.clientX, y: event.clientY };
  }
}

function hideBadgeSoon() {
  clearTimeout(hideBadgeTimer);
  hideBadgeTimer = setTimeout(() => {
    if (isPointerOverImageOrBadge()) {
      return;
    }
    hideBadge();
  }, 220);
}

function hideBadge() {
  hoveredImage = null;
  if (hoverBadge) {
    hoverBadge.style.display = "none";
  }
}

function isPointerOverImageOrBadge() {
  if (!hoveredImage || !hoveredImage.isConnected) {
    return false;
  }
  return isPointInsideElement(lastPointer.x, lastPointer.y, hoveredImage) ||
    isPointInsideElement(lastPointer.x, lastPointer.y, hoverBadge);
}

function isPointInsideElement(x, y, element) {
  if (!element || x < 0 || y < 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return x >= rect.left &&
    x <= rect.right &&
    y >= rect.top &&
    y <= rect.bottom;
}

function scheduleBadgeUpdate() {
  if (badgeUpdateQueued) {
    return;
  }
  badgeUpdateQueued = true;
  requestAnimationFrame(() => {
    badgeUpdateQueued = false;
    updateBadgePositions();
  });
}

function isElementRenderable(element) {
  if (element.hidden) {
    return false;
  }
  const style = getComputedStyle(element);
  return style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity || 1) > 0.01;
}

function isImageVisible(image, rect = image.getBoundingClientRect()) {
  if (!isElementRenderable(image)) {
    return false;
  }

  if (rect.width < MIN_IMAGE_SIZE || rect.height < MIN_IMAGE_SIZE) {
    return false;
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewportHeight &&
    rect.left < viewportWidth;
}

function openPromptPanel(image) {
  closePromptPanel();

  const rect = image.getBoundingClientRect();
  const panel = createPanel(image);
  document.documentElement.appendChild(panel.root);
  activePanel = panel.root;
  activePanelImage = image;
  positionPanel(panel.root, rect);

  const payload = getImagePayload(image);
  const port = chrome.runtime.connect({ name: "OLLAMA_PROMPT_EXTRACTION" });
  activePort = port;
  port.onMessage.addListener((message) => {
    if (!document.documentElement.contains(panel.root)) {
      port.disconnect();
      return;
    }
    if (message.type === "PROGRESS") {
      panel.setProgress(message.progress);
    }
    if (message.type === "ERROR") {
      panel.setError(message.error || "提取失败。");
      port.disconnect();
      if (activePort === port) {
        activePort = null;
      }
    }
    if (message.type === "DONE") {
      panel.setResult(message.result);
      port.disconnect();
      if (activePort === port) {
        activePort = null;
      }
    }
  });
  port.postMessage({ type: "START_EXTRACTION", payload });
}

function createPanel(targetImage) {
  const root = document.createElement("section");
  root.className = "ollama-prompt-panel";
  root.innerHTML = `
    <div class="ollama-prompt-panel__header">
      <div class="ollama-prompt-panel__title">图片提示词反推</div>
      <button class="ollama-prompt-panel__close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="ollama-prompt-panel__tabs" role="tablist">
      <button class="ollama-prompt-panel__tab" type="button" data-key="jsonPrompt" aria-selected="true">JSON</button>
      <button class="ollama-prompt-panel__tab" type="button" data-key="zhPrompt" aria-selected="false">中文</button>
      <button class="ollama-prompt-panel__tab" type="button" data-key="enPrompt" aria-selected="false">English</button>
    </div>
    <div class="ollama-prompt-panel__progress">
      <div class="ollama-prompt-panel__progress-head">
        <div class="ollama-prompt-panel__stage">准备任务</div>
        <div class="ollama-prompt-panel__percent">0%</div>
      </div>
      <div class="ollama-prompt-panel__track" aria-hidden="true">
        <div class="ollama-prompt-panel__bar"></div>
      </div>
      <div class="ollama-prompt-panel__detail">正在建立任务连接...</div>
    </div>
    <div class="ollama-prompt-panel__status" hidden></div>
    <div class="ollama-prompt-panel__body" hidden>
      <pre class="ollama-prompt-panel__output"></pre>
    </div>
    <div class="ollama-prompt-panel__footer">
      <button class="ollama-prompt-panel__save-library" type="button" disabled>保存到提示词库</button>
      <button class="ollama-prompt-panel__copy" type="button">复制当前提示词</button>
    </div>
  `;

  const tabs = [...root.querySelectorAll(".ollama-prompt-panel__tab")];
  const progress = root.querySelector(".ollama-prompt-panel__progress");
  const stage = root.querySelector(".ollama-prompt-panel__stage");
  const percent = root.querySelector(".ollama-prompt-panel__percent");
  const bar = root.querySelector(".ollama-prompt-panel__bar");
  const detail = root.querySelector(".ollama-prompt-panel__detail");
  const status = root.querySelector(".ollama-prompt-panel__status");
  const body = root.querySelector(".ollama-prompt-panel__body");
  const output = root.querySelector(".ollama-prompt-panel__output");
  const close = root.querySelector(".ollama-prompt-panel__close");
  const copy = root.querySelector(".ollama-prompt-panel__copy");
  const saveLibrary = root.querySelector(".ollama-prompt-panel__save-library");
  let result = null;
  let activeKey = "jsonPrompt";

  close.addEventListener("click", closePromptPanel);
  saveLibrary.addEventListener("click", async () => {
    const text = output.textContent || "";
    if (!text.trim()) {
      return;
    }
    saveLibrary.disabled = true;
    const previousText = saveLibrary.textContent;
    saveLibrary.textContent = "正在打开...";
    try {
      await saveCurrentPromptToQuickPrompt(text, activeKey, targetImage);
      saveLibrary.textContent = "已打开";
    } catch (error) {
      saveLibrary.textContent = "保存失败";
      status.hidden = false;
      status.textContent = `保存失败：${error.message || error}`;
    } finally {
      setTimeout(() => {
        saveLibrary.disabled = false;
        saveLibrary.textContent = previousText;
      }, 1400);
    }
  });
  copy.addEventListener("click", async () => {
    const text = output.textContent || "";
    if (!text) {
      return;
    }
    await copyText(text);
    copy.textContent = "已复制";
    setTimeout(() => {
      copy.textContent = "复制当前提示词";
    }, 1200);
  });

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      activeKey = tab.dataset.key;
      tabs.forEach((item) => {
        item.setAttribute("aria-selected", String(item === tab));
      });
      render();
    });
  }

  function render() {
    if (!result) {
      return;
    }
    output.textContent = result[activeKey] || "";
    if (!output.textContent.trim()) {
      output.textContent = "当前选项没有可显示内容。请切换其它选项，或换一张图片重试。";
    }
  }

  return {
    root,
    setResult(nextResult) {
      result = ensureVisibleResult(nextResult, targetImage);
      progress.hidden = true;
      status.hidden = true;
      body.hidden = false;
      saveLibrary.disabled = false;
      render();
    },
    setProgress(nextProgress) {
      const value = Math.max(0, Math.min(100, Number(nextProgress?.percent || 0)));
      progress.hidden = false;
      status.hidden = true;
      stage.textContent = nextProgress?.stage || "处理中";
      percent.textContent = `${value}%`;
      bar.style.width = `${value}%`;
      detail.textContent = nextProgress?.detail || "";
    },
    setError(message) {
      progress.hidden = true;
      status.hidden = false;
      body.hidden = true;
      saveLibrary.disabled = true;
      status.textContent = `提取失败：${message}`;
    }
  };
}

function ensureVisibleResult(nextResult, image) {
  const result = nextResult && typeof nextResult === "object" ? nextResult : {};
  const fallback = buildLocalFallbackResult(image);
  return {
    ...result,
    jsonPrompt: hasVisibleText(result.jsonPrompt) ? result.jsonPrompt : fallback.jsonPrompt,
    zhPrompt: hasVisibleText(result.zhPrompt) ? result.zhPrompt : fallback.zhPrompt,
    enPrompt: hasVisibleText(result.enPrompt) ? result.enPrompt : fallback.enPrompt
  };
}

function hasVisibleText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function buildLocalFallbackResult(image) {
  const subject = image.alt || image.title || "网页图片";
  const context = getSurroundingText(image) || document.title || "无页面上下文";
  const width = image.naturalWidth || image.width || "未知";
  const height = image.naturalHeight || image.height || "未知";
  return {
    jsonPrompt: JSON.stringify({
      image_overview: {
        composition_type: "Browser-side fallback",
        primary_scene: subject,
        dominant_mood: "Generated from image metadata because the model returned no visible text",
        overall_color_palette: "Unavailable from browser metadata",
        lighting_style: "Unavailable from browser metadata"
      },
      scene_details: {
        page_context: context,
        image_size: `${width}x${height}`
      },
      photographic_and_aesthetic_attributes: {
        style: "Use visible image content as reference",
        quality_keywords: "clear composition, detailed visual description, image-matched style"
      }
    }, null, 2),
    zhPrompt: `${subject}，根据网页图片和页面上下文生成的保守提示词。参考上下文：${context}。请保持与原图一致的主体、构图、光线、色彩、材质和整体风格，画面清晰，细节丰富，适合作为文生图反推提示词。`,
    enPrompt: `${subject}, conservative prompt generated from browser-side image metadata and page context: ${context}. Preserve the visible subject, composition, lighting, color palette, materials, mood, and overall style of the original image, with clear framing and rich visual detail.`
  };
}

function closePromptPanel() {
  if (activePort) {
    activePort.disconnect();
    activePort = null;
  }
  if (activePanel) {
    activePanel.remove();
    activePanel = null;
  }
  activePanelImage = null;
}

function positionPanel(panel, imageRect) {
  const width = Math.min(420, window.innerWidth - 24);
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, imageRect.right - width));
  const top = Math.min(window.innerHeight - 120, Math.max(12, imageRect.top + 42));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function getImagePayload(image) {
  return {
    imageUrl: image.currentSrc || image.src,
    alt: image.alt || "",
    title: image.title || "",
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    pageTitle: document.title || "",
    surroundingText: getSurroundingText(image)
  };
}

function getSurroundingText(image) {
  const container = image.closest("figure, article, section, div, a") || image.parentElement;
  const text = (container?.innerText || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 500);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.documentElement.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function saveCurrentPromptToQuickPrompt(text, activeKey, image) {
  const label = {
    jsonPrompt: "JSON",
    zhPrompt: "中文",
    enPrompt: "English"
  }[activeKey] || "提示词";
  const sourceUrl = image.currentSrc || image.src || location.href;
  const content = [
    `【图片提示词反推 - ${label}】`,
    text,
    "",
    `来源页面：${location.href}`,
    `图片地址：${sourceUrl}`
  ].join("\n");

  const response = await chrome.runtime.sendMessage({
    type: "SAVE_TO_QUICK_PROMPT",
    payload: { content }
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Quick Prompt 打开失败。");
  }
}
