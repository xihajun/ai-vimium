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

function requestSnapshot() {
  UIComponentMessenger.postMessage({ name: "requestSnapshot" });
}

function closeFrame() {
  UIComponentMessenger.postMessage({ name: "requestHide" });
}

function handleMessage({ data }) {
  const handlers = {
    llmSnapshot: ({ snapshot }) => renderSnapshot(snapshot),
    llmSetStatus: ({ status }) => renderSnapshot({ status }),
  };
  const handler = handlers[data.name];
  if (handler) {
    handler(data);
  }
}

function initDom() {
  document.getElementById("llm-refresh")?.addEventListener("click", requestSnapshot);
  document.getElementById("llm-close")?.addEventListener("click", closeFrame);
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
