import * as UIComponentMessenger from "./ui_component_messenger.js";

const screenshotEl = document.querySelector(".llm-screenshot");
const observationEl = document.querySelector(".llm-observation");

function updateScreenshot(dataUrl) {
  if (!dataUrl) return;
  screenshotEl.src = dataUrl;
  observationEl.textContent = `observation: ${dataUrl}`;
}

async function onMessage(event) {
  const name = event.data?.name;
  if (name === "showScreenshot") {
    updateScreenshot(event.data.dataUrl);
  } else if (name === "hidden") {
    observationEl.textContent = "";
    screenshotEl.removeAttribute("src");
  }
}

UIComponentMessenger.init();
UIComponentMessenger.registerHandler(onMessage);
