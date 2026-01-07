const LLMMode = {
  llmUI: null,

  init() {
    if (!this.llmUI) {
      this.llmUI = new UIComponent();
      this.llmUI.load("pages/llm_frame.html", "vimium-llm-frame");
    }
  },

  async requestScreenshot() {
    this.init();
    const dataUrl = await chrome.runtime.sendMessage({ handler: "captureVisibleTab" });
    if (!dataUrl) return;
    this.llmUI.show({ name: "showScreenshot", dataUrl }, { focus: false });
  },
};

globalThis.LLMMode = LLMMode;
