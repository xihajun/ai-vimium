class LLMMode extends Mode {
  constructor(options = {}) {
    super();
    this.controller = options.controller;
    super.init({
      name: "llm-mode",
      exitOnEscape: true,
    });
  }

  exit(event) {
    super.exit(event);
    this.controller?.setStatus("idle");
    this.controller?.hide();
  }
}

globalThis.LLMMode = LLMMode;
