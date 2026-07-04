const DEFAULT_STATE = {
  enabled: true,
  reactions: {},
};

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const current = await chrome.storage.sync.get("vr_enabled");
  if (current.vr_enabled === undefined) {
    await chrome.storage.sync.set({ vr_enabled: DEFAULT_STATE.enabled });
  }
  if (reason === "install") {
    console.log("[Voz Reaction] Installed.");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "vr.ping") {
    sendResponse({ ok: true, ts: Date.now() });
  }
  return true;
});
