//
// This content script must be run prior to domReady so that we perform some operations very early.
//

let isEnabledForUrl = true;
let normalMode = null;

// This is set by initializeFrame. We can only get this frame's ID from the background page.
globalThis.frameId = null;

// We track whther the current window has the focus or not.
let windowHasFocus = null;
function windowIsFocused() {
  return windowHasFocus;
}

function initWindowIsFocused() {
  DomUtils.documentReady().then(() => windowHasFocus = document.hasFocus());
  globalThis.addEventListener(
    "focus",
    forTrusted(function (event) {
      if (event.target === window) {
        windowHasFocus = true;
      }
      return true;
    }),
    true,
  );
  globalThis.addEventListener(
    "blur",
    forTrusted(function (event) {
      if (event.target === window) {
        windowHasFocus = false;
      }
      return true;
    }),
    true,
  );
}

// True if this window should be focusable by various Vim commands (e.g. "nextFrame").
function isWindowFocusable() {
  // Avoid focusing tiny frames. See #1317.
  return !DomUtils.windowIsTooSmall() && (document.body?.tagName.toLowerCase() != "frameset");
}

// If an input grabs the focus before the user has interacted with the page, then grab it back (if
// the grabBackFocus option is set).
class GrabBackFocus extends Mode {
  constructor() {
    super();
    let listener;
    const exitEventHandler = () => {
      return this.alwaysContinueBubbling(() => {
        this.exit();
        chrome.runtime.sendMessage({
          handler: "sendMessageToFrames",
          message: { handler: "userIsInteractingWithThePage" },
        });
      });
    };

    super.init({
      name: "grab-back-focus",
      keydown: exitEventHandler,
    });

    // True after we've grabbed back focus to the page and logged it via console.log , so web devs
    // using Vimium don't get confused.
    this.logged = false;

    this.push({
      _name: "grab-back-focus-mousedown",
      mousedown: exitEventHandler,
    });

    if (this.modeIsActive) {
      if (Settings.get("grabBackFocus")) {
        this.push({
          _name: "grab-back-focus-focus",
          focus: (event) => this.grabBackFocus(event.target),
        });
        // An input may already be focused. If so, grab back the focus.
        if (document.activeElement) {
          this.grabBackFocus(document.activeElement);
        }
      } else {
        this.exit();
      }
    }

    // This mode is active in all frames. A user might have begun interacting with one frame without
    // other frames detecting this. When one GrabBackFocus mode exits, we broadcast a message to
    // inform all GrabBackFocus modes that they should exit; see #2296.
    chrome.runtime.onMessage.addListener(
      listener = ({ name }) => {
        if (name === "userIsInteractingWithThePage") {
          chrome.runtime.onMessage.removeListener(listener);
          if (this.modeIsActive) {
            this.exit();
          }
        }
        // We will not be calling sendResponse.
        return false;
      },
    );
  }

  grabBackFocus(element) {
    if (!DomUtils.isFocusable(element)) {
      return this.continueBubbling;
    }

    if (!this.logged && (element !== document.body)) {
      this.logged = true;
      if (!globalThis.vimiumDomTestsAreRunning) {
        console.log("An auto-focusing action on this page was blocked by Vimium.");
      }
    }
    element.blur();
    return this.suppressEvent;
  }
}

// Pages can load new content dynamically and change the displayed URL using history.pushState.
// Since this can often be indistinguishable from an actual new page load for the user, we should
// also re-start GrabBackFocus for these as well. This fixes issue #1622.
handlerStack.push({
  _name: "GrabBackFocus-pushState-monitor",
  click(event) {
    // If a focusable element is focused, the user must have clicked on it. Retain focus and bail.
    if (DomUtils.isFocusable(document.activeElement)) {
      return true;
    }

    let target = event.target;

    while (target) {
      // Often, a link which triggers a content load and url change with javascript will also have
      // the new url as it's href attribute.
      if (
        (target.tagName === "A") &&
        (target.origin === document.location.origin) &&
        // Clicking the link will change the url of this frame.
        ((target.pathName !== document.location.pathName) ||
          (target.search !== document.location.search)) &&
        (["", "_self"].includes(target.target) ||
          ((target.target === "_parent") && (globalThis.parent === window)) ||
          ((target.target === "_top") && (globalThis.top === window)))
      ) {
        return new GrabBackFocus();
      } else {
        target = target.parentElement;
      }
    }
    return true;
  },
});

function installModes() {
  // Install the permanent modes. The permanently-installed insert mode tracks focus/blur events,
  // and activates/deactivates itself accordingly.
  normalMode = new NormalMode();
  normalMode.init();
  // Initialize components upon which normal mode depends.
  Scroller.init();
  FindModeHistory.init();
  new InsertMode({ permanent: true });
  if (isEnabledForUrl) {
    new GrabBackFocus();
  }
  // Return the normalMode object (for the tests).
  return normalMode;
}

// document is null in our tests.
let previousUrl = globalThis.document?.location.href;

// When we're informed by the background page that a URL in this tab has changed, we check if we
// have the correct enabled state (but only if this frame has the focus).
const checkEnabledAfterURLChange = forTrusted(function (_request) {
  // The background page can't tell if the URL has actually changed after a client-side
  // history.pushState call. To limit log spam, ignore spurious URL change events where the URL
  // didn't actually change.
  if (previousUrl == document.location.href) {
    return;
  } else {
    previousUrl = document.location.href;
  }
  // The URL changing feels like navigation to the user, so reset the scroller (see #3119).
  Scroller.reset();
  if (windowIsFocused()) {
    checkIfEnabledForUrl();
  }
});

// If our extension gets uninstalled, reloaded, or updated, the content scripts for the old version
// become orphaned: they remain running but cannot communicate with the background page or invoke
// most extension APIs. There is no Chrome API to be notified of this event, so we test for it every
// time a keystroke is pressed before we act on that keystroke. https://stackoverflow.com/a/64407849
const extensionHasBeenUnloaded = () => chrome.runtime?.id == null;

// Wrapper to install event listeners.  Syntactic sugar.
function installListener(element, event, callback) {
  element.addEventListener(
    event,
    forTrusted(function () {
      if (extensionHasBeenUnloaded()) {
        console.log("Vimium extension has been unloaded. Unloading content script.");
        onUnload();
        return;
      }
      if (isEnabledForUrl) {
        return callback.apply(this, arguments);
      } else {
        return true;
      }
    }),
    true,
  );
}

// Installing or uninstalling listeners is error prone. Instead we elect to check isEnabledForUrl
// each time so we know whether the listener should run or not.
// Note: We install the listeners even if Vimium is disabled. See comment in commit
// 6446cf04c7b44c3d419dc450a73b60bcaf5cdf02.
const installListeners = Utils.makeIdempotent(function () {
  // Key event handlers fire on window before they do on document. Prefer window for key events so
  // the page can't set handlers to grab the keys before us.
  const events = ["keydown", "keypress", "keyup", "click", "focus", "blur", "mousedown", "scroll"];
  for (const type of events) {
    installListener(globalThis, type, (event) => handlerStack.bubbleEvent(type, event));
  }
  installListener(
    document,
    "DOMActivate",
    (event) => handlerStack.bubbleEvent("DOMActivate", event),
  );
});

// Whenever we get the focus, check if we should be enabled.
const onFocus = forTrusted(function (event) {
  if (event.target === window) {
    checkIfEnabledForUrl();
  }
});

// We install these listeners directly (that is, we don't use installListener) because we still need
// to receive events when Vimium is not enabled.
globalThis.addEventListener("focus", onFocus, true);
globalThis.addEventListener("hashchange", checkEnabledAfterURLChange, true);

async function initializeOnDomReady() {
  // Tell the background page we're in the domReady state.
  await chrome.runtime.sendMessage({ handler: "domReady" });

  const isVimiumNewTabPage = document.location.href == Settings.vimiumNewTabPageUrl;
  if (!isVimiumNewTabPage) return;

  // Show the Vomnibar.
  await Settings.onLoaded();
  if (Settings.get("openVomnibarOnNewTabPage")) {
    await Utils.populateBrowserInfo();
    DomUtils.injectUserCss();
    Vomnibar.activate(0, {});
  }
}

const onUnload = Utils.makeIdempotent(() => {
  HintCoordinator.exit({ isSuccess: false });
  handlerStack.reset();
  isEnabledForUrl = false;
  globalThis.removeEventListener("focus", onFocus, true);
  globalThis.removeEventListener("hashchange", checkEnabledAfterURLChange, true);
});

function setScrollPosition({ scrollX, scrollY }) {
  DomUtils.documentReady().then(() => {
    if (!DomUtils.isTopFrame()) return;
    Utils.nextTick(function () {
      globalThis.focus();
      document.body.focus();
      if ((scrollX > 0) || (scrollY > 0)) {
        Marks.setPreviousPosition();
        globalThis.scrollTo(scrollX, scrollY);
      }
    });
  });
}

const flashFrame = (() => {
  let highlightedFrameElement = null;
  return () => {
    if (highlightedFrameElement == null) {
      highlightedFrameElement = DomUtils.createElement("div");

      // Create a shadow DOM wrapping the frame so the page's styles don't interfere with ours.
      const shadowDOM = highlightedFrameElement.attachShadow({ mode: "open" });

      // Inject stylesheet.
      const styleEl = DomUtils.createElement("style");
      const vimiumCssUrl = chrome.runtime.getURL("content_scripts/vimium.css");
      styleEl.textContent = `@import url("${vimiumCssUrl}");`;
      shadowDOM.appendChild(styleEl);

      const frameEl = DomUtils.createElement("div");
      frameEl.className = "vimium-reset vimium-highlighted-frame";
      shadowDOM.appendChild(frameEl);
    }

    document.documentElement.appendChild(highlightedFrameElement);
    Utils.setTimeout(200, () => highlightedFrameElement.remove());
  };
})();

//
// Called from the backend in order to change frame focus.
//
function focusThisFrame(request) {
  // It should never be the case that we get a forceFocusThisFrame request on a window that isn't
  // focusable, because the background script checks that the window is focusable before sending the
  // focusFrame message.
  if (!request.forceFocusThisFrame && !isWindowFocusable()) return;

  Utils.nextTick(function () {
    globalThis.focus();
    // On Firefox, window.focus doesn't always draw focus back from a child frame (bug 554039). We
    // blur the active element if it is an iframe, which gives the window back focus as intended.
    if (document.activeElement.tagName.toLowerCase() === "iframe") {
      document.activeElement.blur();
    }
    if (request.highlight) {
      flashFrame();
    }
  });
}

// Used by the focusInput command.
globalThis.lastFocusedInput = (function () {
  // Track the most recently focused input element.
  let recentlyFocusedElement = null;
  globalThis.addEventListener(
    "focus",
    forTrusted(function (event) {
      if (DomUtils.isEditable(event.target)) {
        recentlyFocusedElement = event.target;
      }
    }),
    true,
  );
  return () => recentlyFocusedElement;
})();

const messageHandlers = {
  getFocusStatus(_request, _sender) {
    return {
      focused: windowIsFocused(),
      focusable: isWindowFocusable(),
    };
  },
  focusFrame(request) {
    focusThisFrame(request);
  },
  getScrollPosition(_ignoredA, _ignoredB) {
    if (DomUtils.isTopFrame()) {
      return { scrollX: globalThis.scrollX, scrollY: globalThis.scrollY };
    }
  },
  setScrollPosition,
  checkEnabledAfterURLChange,
  runInTopFrame({ sourceFrameId, registryEntry }) {
    // TODO(philc): it seems to me that we should be able to get rid of this runInTopFrame
    // command, and instead use chrome.tabs.sendMessage with a frameId 0 from the background page.
    if (DomUtils.isTopFrame()) {
      return NormalModeCommands[registryEntry.command](sourceFrameId, registryEntry);
    }
  },
  linkHintsMessage(request, sender) {
    if (HintCoordinator.willHandleMessage(request.messageType)) {
      return HintCoordinator[request.messageType](request, sender);
    }
  },
  showMessage(request) {
    HUD.show(request.message, 2000);
  },
  showLLMOverlay({ sourceFrameId }) {
    LLMFrame.show({ sourceFrameId });
  },
};

async function handleMessage(request, sender) {
  // Some requests are so frequent and noisy (like checkEnabledAfterURLChange on
  // docs.google.com) that we silence debug logging for just those requests so the rest remain
  // useful.
  if (!request.silenceLogging) {
    Utils.debugLog(
      "frontend.js: onMessage:%otype:%o",
      request.handler,
      request.messageType,
      // request // Often useful for debugging.
    );
  }
  request.isTrusted = true;
  // Some request are handled elsewhere in the code base; ignore them here.
  const shouldHandleMessage = request.handler !== "userIsInteractingWithThePage" &&
    (isEnabledForUrl ||
      ["checkEnabledAfterURLChange", "runInTopFrame"].includes(request.handler));
  if (shouldHandleMessage) {
    const result = await messageHandlers[request.handler](request, sender);
    return result;
  }
}

//
// Complete initialization work that should be done prior to DOMReady.
//
async function initializePreDomReady() {
  // Run this as early as possible, so the page can't register any event handlers before us.
  installListeners();
  // NOTE(philc): I'm blocking further Vimium initialization on this, for simplicity. If necessary
  // we could allow other tasks to run concurrently.
  await checkIfEnabledForUrl();

  Utils.addChromeRuntimeOnMessageListener(
    Object.keys(messageHandlers),
    handleMessage,
  );
}

// Check if Vimium should be enabled or not based on the top frame's URL.
async function checkIfEnabledForUrl() {
  if (extensionHasBeenUnloaded()) {
    return;
  }
  const promises = [];
  promises.push(chrome.runtime.sendMessage({ handler: "initializeFrame" }));
  if (!Settings.isLoaded()) {
    promises.push(Settings.onLoaded());
  }
  let response;
  try {
    [response] = await Promise.all(promises);
  } catch {
    return;
  }
  if (!response) return;

  isEnabledForUrl = response.isEnabledForUrl;

  // This browser info is used by other content scripts, but can only be determinted by the
  // background page.
  Utils._isFirefox = response.isFirefox;
  Utils._firefoxVersion = response.firefoxVersion;
  Utils._browserInfoLoaded = true;
  // This is the first time we learn what this frame's ID is.
  globalThis.frameId = response.frameId;

  if (normalMode == null) installModes();
  normalMode.setPassKeys(response.passKeys);
  // Hide the HUD if we're not enabled.
  if (!isEnabledForUrl) HUD.hide(true, false);
}

// If this content script is running in the help dialog's iframe, then use the HelpDialogPage's
// methods to control the dialog. Otherwise, load the help dialog in a UIComponent iframe.
const HelpDialog = {
  helpUI: null,

  isShowing() {
    if (globalThis.isVimiumHelpDialogPage) return true;
    return this.helpUI && this.helpUI.showing;
  },

  abort() {
    if (globalThis.isVimiumHelpDialogPage) throw new Error("This should be impossible.");
    if (this.isShowing()) {
      return this.helpUI.hide(false);
    }
  },

  async toggle(request) {
    // If we're in the help dialog page already and the user has typed a key to show the help
    // dialog, then we should hide it.
    if (globalThis.isVimiumHelpDialogPage) return HelpDialogPage.hide();

    if (this.helpUI == null) {
      await DomUtils.documentComplete();
      this.helpUI = new UIComponent();
      this.helpUI.load("pages/help_dialog_page.html", "vimium-help-dialog-frame");
    }
    if (this.isShowing()) {
      this.helpUI.hide();
    } else {
      return this.helpUI.show(
        { name: "show" },
        { focus: true, sourceFrameId: request.sourceFrameId },
      );
    }
  },
};

const LLMFrame = {
  llmUI: null,
  mode: null,
  snapshot: {
    status: "idle",
    thought: "",
    action: "",
    observation: "",
    nextAction: "",
    rawResponse: "",
    screenshot: "",
    chatMessages: [],
  },
  isCapturingScreenshot: false,

  isShowing() {
    return this.llmUI && this.llmUI.showing;
  },

  handleUIComponentMessage({ data }) {
    const handlers = {
      requestSnapshot: this.sendSnapshot,
      requestHide: this.hide,
      llmChatSend: this.runChat,
    };
    const handler = handlers[data.name];
    if (handler) {
      return handler.bind(this)(data);
    }
  },

  init() {
    if (!this.llmUI) {
      this.llmUI = new UIComponent();
      this.llmUI.load(
        "pages/llm_frame.html",
        "vimium-llm-frame",
        this.handleUIComponentMessage.bind(this),
      );
    }
  },

  sendSnapshot() {
    if (!this.llmUI) return;
    this.llmUI.postMessage({ name: "llmSnapshot", snapshot: this.snapshot });
  },

  setSnapshot(snapshot) {
    this.snapshot = Object.assign({}, this.snapshot, snapshot);
    if (this.isShowing()) {
      this.sendSnapshot();
    }
  },

  setStatus(status) {
    this.setSnapshot({ status });
  },

  setOverlayHiddenForScreenshot(hidden) {
    if (!this.llmUI?.iframeElement) return;
    this.llmUI.iframeElement.classList.toggle("vimium-llm-frame--hidden-for-capture", hidden);
    this.llmUI.postMessage({ name: "llmCaptureMode", enabled: hidden });
  },

  async withScreenshotHidden(task) {
    if (!this.llmUI?.iframeElement || this.isCapturingScreenshot) {
      return task();
    }
    this.isCapturingScreenshot = true;
    this.setOverlayHiddenForScreenshot(true);
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    try {
      return await task();
    } finally {
      this.setOverlayHiddenForScreenshot(false);
      this.isCapturingScreenshot = false;
    }
  },

  buildKeyEvent(key, modifiers = {}) {
    const keyCodeMap = {
      Escape: 27,
      Enter: 13,
      Tab: 9,
      Backspace: 8,
      Delete: 46,
      " ": 32,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      PageUp: 33,
      PageDown: 34,
      Home: 36,
      End: 35,
    };
    const keyCode = keyCodeMap[key] ??
      (key && key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    return {
      key,
      code: modifiers.code || "",
      keyCode,
      which: keyCode,
      altKey: Boolean(modifiers.altKey),
      ctrlKey: Boolean(modifiers.ctrlKey),
      metaKey: Boolean(modifiers.metaKey),
      shiftKey: Boolean(modifiers.shiftKey),
      isTrusted: true,
      preventDefault() {},
      stopImmediatePropagation() {},
    };
  },

  parseVimiumKeySequence(sequence) {
    if (!sequence || typeof sequence !== "string") return null;
    const trimmed = sequence.replace(/\s+/g, "");
    if (!trimmed) return null;
    const keyAliases = {
      esc: "Escape",
      escape: "Escape",
      enter: "Enter",
      return: "Enter",
      tab: "Tab",
      space: " ",
      backspace: "Backspace",
      delete: "Delete",
      del: "Delete",
      up: "ArrowUp",
      down: "ArrowDown",
      left: "ArrowLeft",
      right: "ArrowRight",
      pageup: "PageUp",
      pagedown: "PageDown",
      pgup: "PageUp",
      pgdn: "PageDown",
      home: "Home",
      end: "End",
    };
    const tokens = [];
    for (let i = 0; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "<") {
        const closeIndex = trimmed.indexOf(">", i + 1);
        if (closeIndex === -1) return null;
        const token = trimmed.slice(i + 1, closeIndex);
        tokens.push({ type: "special", value: token });
        i = closeIndex;
      } else {
        tokens.push({ type: "char", value: char });
      }
    }

    return tokens.map((token) => {
      if (token.type === "char") {
        const key = token.value;
        const isUpper = key.length === 1 && key.toUpperCase() === key && key.toLowerCase() !== key;
        return this.buildKeyEvent(key, { shiftKey: isUpper });
      }

      const normalized = token.value.toLowerCase();
      const parts = normalized.split("-");
      const keyName = parts.pop();
      const modifiers = {
        altKey: parts.includes("a"),
        ctrlKey: parts.includes("c"),
        metaKey: parts.includes("m"),
        shiftKey: parts.includes("s"),
      };
      const key = keyAliases[keyName] || keyName;
      return this.buildKeyEvent(key, modifiers);
    });
  },

  dispatchVimiumKeySequence(sequence) {
    const events = this.parseVimiumKeySequence(sequence);
    if (!events) return null;
    events.forEach((event) => {
      handlerStack.bubbleEvent("keydown", event);
      handlerStack.bubbleEvent("keyup", event);
    });
    return sequence.replace(/\s+/g, "");
  },

  normalizeSpecialKey(key) {
    if (!key || typeof key !== "string") return null;
    const trimmed = key.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
    const normalized = trimmed.toLowerCase();
    const specialKeys = new Set([
      "escape",
      "esc",
      "enter",
      "return",
      "tab",
      "space",
      "backspace",
      "delete",
      "del",
      "up",
      "down",
      "left",
      "right",
      "pageup",
      "pagedown",
      "pgup",
      "pgdn",
      "home",
      "end",
    ]);
    if (specialKeys.has(normalized)) {
      return `<${normalized}>`;
    }
    return trimmed;
  },

  applyTextAction(action) {
    if (!action || typeof action !== "object") return null;
    const text = action.text ?? action.value;
    if (typeof text !== "string" || !text.trim()) return null;
    let target = null;
    if (typeof action.selector === "string") {
      target = document.querySelector(action.selector);
    }
    if (!target || !DomUtils.isEditable(target)) {
      target = document.activeElement;
    }
    if (!target || !DomUtils.isEditable(target)) return null;
    target.focus();
    if (target.isContentEditable) {
      target.textContent = text;
    } else {
      target.value = text;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return "Auto-typed text into the active input.";
  },

  applyAutoAction(action) {
    if (!action) return null;
    if (typeof action === "string") {
      const appliedSequence = this.dispatchVimiumKeySequence(action);
      return appliedSequence ? `Auto-executed Vimium keys: ${appliedSequence}` : null;
    }
    if (typeof action !== "object") return null;
    const actionType = (action.type || "").toString().toLowerCase();
    if (actionType === "type") {
      return this.applyTextAction(action);
    }
    if (["vim_key", "key", "keypress"].includes(actionType)) {
      const keySequence = this.normalizeSpecialKey(action.key || action.keys || action.sequence);
      if (!keySequence) return null;
      const appliedSequence = this.dispatchVimiumKeySequence(keySequence);
      return appliedSequence ? `Auto-executed Vimium keys: ${appliedSequence}` : null;
    }
    const rawKey = this.normalizeSpecialKey(action.key || action.keys || action.sequence);
    if (rawKey) {
      const appliedSequence = this.dispatchVimiumKeySequence(rawKey);
      return appliedSequence ? `Auto-executed Vimium keys: ${appliedSequence}` : null;
    }
    return null;
  },

  maybeAutoExecuteAction(result) {
    const notes = [];
    const actionNote = this.applyAutoAction(result?.action);
    if (actionNote) notes.push(actionNote);
    const nextActionNote = this.applyAutoAction(result?.nextAction);
    if (nextActionNote) notes.push(nextActionNote);
    if (notes.length === 0) return false;
    const previousObservation = this.snapshot?.observation || result?.observation || "";
    const note = notes.join("\n");
    this.setSnapshot({
      observation: previousObservation ? `${previousObservation}\n${note}` : note,
    });
    return true;
  },

  async runChat({ message, sourceFrameId } = {}) {
    const trimmedMessage = message?.trim();
    if (!trimmedMessage) return;
    await Settings.onLoaded();
    if (!Settings.get("llmEnabled")) {
      this.init();
      this.show({ sourceFrameId });
      this.setSnapshot({
        status: "error",
        observation: "LLM is disabled. Enable it in Vimium options to continue.",
      });
      return;
    }

    const includeScreenshot = Settings.get("llmIncludeScreenshot");
    const existingMessages = this.snapshot.chatMessages || [];
    const apiKey = Settings.get("llmApiKey");
    if (!apiKey) {
      this.init();
      this.show({ sourceFrameId });
      if (/\s/.test(trimmedMessage)) {
        this.setSnapshot({
          status: "error",
          observation: "LLM API key is missing. Paste your API key (no spaces) into the chat box.",
        });
        return;
      }
      await Settings.set("llmApiKey", trimmedMessage);
      this.setSnapshot({
        status: "idle",
        observation: "API key saved. Send your task again to continue.",
        chatMessages: [
          ...existingMessages,
          { role: "assistant", content: "✅ API key saved. Send your task again to continue." },
        ],
      });
      return;
    }
    this.init();
    this.show({ sourceFrameId });
    const updatedMessages = [...existingMessages, { role: "user", content: trimmedMessage }];
    this.setSnapshot({
      status: "busy",
      chatMessages: updatedMessages,
    });

    try {
      const request = () =>
        chrome.runtime.sendMessage({
          handler: "runLLMRequest",
          prompt: trimmedMessage,
          includeScreenshot,
          pageContext: {
            url: globalThis.location.href,
            title: globalThis.document?.title || "",
          },
        });
      const response = includeScreenshot
        ? await this.withScreenshotHidden(request)
        : await request();
      if (!response || response.error) {
        this.setSnapshot({
          status: "error",
          observation: response?.error || "LLM request failed.",
          rawResponse: response?.rawResponse || "",
          screenshot: response?.screenshot || "",
          chatMessages: [
            ...updatedMessages,
            { role: "assistant", content: response?.error || "LLM request failed." },
          ],
        });
        return;
      }
      const assistantMessage = response.rawResponse ||
        JSON.stringify(response.result || {}, null, 2);
      this.setSnapshot({
        status: "idle",
        thought: response.result?.thought || "",
        action: response.result?.action || "",
        observation: response.result?.observation || "",
        nextAction: response.result?.nextAction || "",
        rawResponse: response.rawResponse || "",
        screenshot: response.screenshot || "",
        chatMessages: [...updatedMessages, { role: "assistant", content: assistantMessage }],
      });
      this.maybeAutoExecuteAction(response.result);
    } catch (error) {
      this.setSnapshot({
        status: "error",
        observation: `LLM request failed: ${error?.message || error}`,
        chatMessages: [
          ...updatedMessages,
          { role: "assistant", content: `LLM request failed: ${error?.message || error}` },
        ],
      });
    }
  },

  async runAnalysis({ sourceFrameId } = {}) {
    await Settings.onLoaded();
    if (!Settings.get("llmEnabled")) {
      this.init();
      this.show({ sourceFrameId });
      this.setSnapshot({
        status: "error",
        observation: "LLM is disabled. Enable it in Vimium options to continue.",
      });
      return;
    }

    const apiKey = Settings.get("llmApiKey");
    if (!apiKey) {
      this.init();
      this.show({ sourceFrameId });
      this.setSnapshot({
        status: "error",
        observation: "LLM API key is missing. Paste your API key in the chat box to continue.",
      });
      return;
    }

    const prompt = Settings.get("llmUserPrompt");
    const includeScreenshot = Settings.get("llmIncludeScreenshot");
    this.init();
    this.show({ sourceFrameId });
    this.setSnapshot({
      status: "busy",
      thought: "",
      action: "",
      observation: "",
      nextAction: "",
      rawResponse: "",
      screenshot: "",
    });

    try {
      const request = () =>
        chrome.runtime.sendMessage({
          handler: "runLLMRequest",
          prompt,
          includeScreenshot,
          pageContext: {
            url: globalThis.location.href,
            title: globalThis.document?.title || "",
          },
        });
      const response = includeScreenshot
        ? await this.withScreenshotHidden(request)
        : await request();
      if (!response || response.error) {
        this.setSnapshot({
          status: "error",
          observation: response?.error || "LLM request failed.",
          rawResponse: response?.rawResponse || "",
          screenshot: response?.screenshot || "",
        });
        return;
      }
      this.setSnapshot({
        status: "idle",
        thought: response.result?.thought || "",
        action: response.result?.action || "",
        observation: response.result?.observation || "",
        nextAction: response.result?.nextAction || "",
        rawResponse: response.rawResponse || "",
        screenshot: response.screenshot || "",
      });
      this.maybeAutoExecuteAction(response.result);
    } catch (error) {
      this.setSnapshot({
        status: "error",
        observation: `LLM request failed: ${error?.message || error}`,
      });
    }
  },

  show(options = {}) {
    this.init();
    if (!this.mode || !this.mode.modeIsActive) {
      this.mode = new LLMMode({ controller: this });
    }
    const focusOptions = {
      focus: false,
      sourceFrameId: options.sourceFrameId ?? globalThis.frameId,
    };
    return this.llmUI.show({ name: "llmSnapshot", snapshot: this.snapshot }, focusOptions);
  },

  hide({ fromMode } = {}) {
    if (!fromMode) {
      this.setStatus("idle");
    }
    if (this.llmUI) {
      this.llmUI.hide();
    }
    if (this.mode) {
      const mode = this.mode;
      this.mode = null;
      if (!fromMode && mode.modeIsActive) {
        mode.exit();
      }
    }
  },
};

const testEnv = globalThis.window == null;
if (!testEnv) {
  initWindowIsFocused();
  initializePreDomReady();
  DomUtils.documentReady().then(initializeOnDomReady);
}

Object.assign(globalThis, {
  HelpDialog,
  LLMFrame,
  handlerStack,
  windowIsFocused,
  // These are exported for normal mode and link-hints mode.
  focusThisFrame,
  // Exported only for tests.
  installModes,
});
