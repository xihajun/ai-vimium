import "../lib/utils.js";
import "../lib/dom_utils.js";
import * as UIComponentMessenger from "./ui_component_messenger.js";

const DEFAULT_SNAPSHOT = {
  status: "idle",
  thought: "",
  action: "",
  observation: "",
  nextAction: "",
  rawResponse: "",
  screenshot: "",
  chatMessages: [],
};

const state = {
  snapshot: { ...DEFAULT_SNAPSHOT },
};

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value ?? "";
  }
}

function updateStatusPill(status) {
  const element = document.getElementById("llm-status");
  if (!element) return;
  element.textContent = status;
  element.dataset.status = status;
}

function renderSnapshot(snapshot) {
  const normalized = { ...DEFAULT_SNAPSHOT, ...snapshot };
  state.snapshot = normalized;
  updateStatusPill(normalized.status);
  setText("llm-thought", normalized.thought);
  setText("llm-action", normalized.action);
  setText("llm-observation", normalized.observation);
  setText("llm-next-action", normalized.nextAction);
  setText("llm-capture-action", normalized.action || "-");
  setText("llm-capture-next", normalized.nextAction || "-");
  renderChatMessages(normalized.chatMessages);
  const screenshot = document.getElementById("llm-screenshot");
  if (screenshot) {
    if (normalized.screenshot) {
      screenshot.src = normalized.screenshot;
      screenshot.classList.add("has-image");
    } else {
      screenshot.removeAttribute("src");
      screenshot.classList.remove("has-image");
    }
  }
  const jsonSnapshot = {
    ...normalized,
    screenshot: normalized.screenshot ? "[screenshot data]" : "",
  };
  setText("llm-json", JSON.stringify(jsonSnapshot, null, 2));
}

function setCaptureMode(enabled) {
  document.body.classList.toggle("llm-capture-mode", Boolean(enabled));
}

function renderChatMessages(messages) {
  const container = document.getElementById("llm-chat-log");
  if (!container) return;
  container.innerHTML = "";
  (messages || []).forEach((message) => {
    const item = document.createElement("div");
    item.classList.add("llm-chat-message");
    item.classList.add(message.role || "assistant");
    item.textContent = message.content || "";
    container.appendChild(item);
  });
  container.scrollTop = container.scrollHeight;
}

function requestSnapshot() {
  UIComponentMessenger.postMessage({ name: "requestSnapshot" });
}

function closeFrame() {
  UIComponentMessenger.postMessage({ name: "requestHide" });
}

function sendChatMessage() {
  const textarea = document.getElementById("llm-chat-text");
  const message = textarea?.value.trim();
  if (!message) return;
  UIComponentMessenger.postMessage({ name: "llmChatSend", message });
  textarea.value = "";
}

function handleMessage({ data }) {
  const handlers = {
    llmSnapshot: ({ snapshot }) => renderSnapshot(snapshot),
    llmSetStatus: ({ status }) => renderSnapshot({ status }),
    llmCaptureMode: ({ enabled }) => setCaptureMode(enabled),
  };
  const handler = handlers[data.name];
  if (handler) {
    handler(data);
  }
}

function initDom() {
  document.getElementById("llm-refresh")?.addEventListener("click", requestSnapshot);
  document.getElementById("llm-close")?.addEventListener("click", closeFrame);
  document.getElementById("llm-chat-send")?.addEventListener("click", sendChatMessage);
  document.getElementById("llm-chat-text")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendChatMessage();
    }
  });
  globalThis.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFrame();
    }
  });
}

UIComponentMessenger.registerHandler(handleMessage);
UIComponentMessenger.init();
globalThis.addEventListener("DOMContentLoaded", () => {
  initDom();
  renderSnapshot(DEFAULT_SNAPSHOT);
  requestSnapshot();
});
