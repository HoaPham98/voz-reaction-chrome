const STORAGE_KEYS = {
  enabled: "vr_enabled",
};

const enabledToggle = document.getElementById("enabled-toggle");
const statusEl = document.getElementById("status");

function setStatus(text, duration = 1500) {
  statusEl.textContent = text;
  if (duration > 0) {
    setTimeout(() => {
      statusEl.textContent = "Sẵn sàng";
    }, duration);
  }
}

async function loadState() {
  const { [STORAGE_KEYS.enabled]: enabled = true } =
    await chrome.storage.sync.get(STORAGE_KEYS.enabled);
  enabledToggle.checked = Boolean(enabled);
}

async function persistEnabled(value) {
  await chrome.storage.sync.set({ [STORAGE_KEYS.enabled]: value });
  setStatus(value ? "Đã bật" : "Đã tắt");
}

enabledToggle.addEventListener("change", (e) => {
  persistEnabled(e.target.checked);
});

document.addEventListener("DOMContentLoaded", loadState);
