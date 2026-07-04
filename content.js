(() => {
  "use strict";

  const SYNC = {
    enabled: "vr_enabled",
  };

  const POST_SEL = ".block-body.js-replyNewMessageContainer > article.js-post";
  const OBSERVED_ATTR = "data-vr-observed";
  const DONE_ATTR = "data-vr-done";
  const LOW_THRESHOLD_DEFAULT = 0;
  const fmt = new Intl.NumberFormat("en-US");
  const IO_ROOT_MARGIN = "240px";

  let enabled = true;
  let api = null;
  let domObserver = null;
  let postObserver = null;
  let lastPath = window.location.pathname + window.location.search;

  function getApi() {
    if (api) return api;
    api = window.VozReactionAPI || null;
    return api;
  }

  async function loadEnabled() {
    try {
      const got = await chrome.storage.sync.get(SYNC.enabled);
      enabled = got[SYNC.enabled] !== false;
    } catch {
      enabled = true;
    }
  }

  function extractAuthor(post) {
    const userLink = post.querySelector(".message-userDetails a.username");
    if (!userLink) return null;
    const userId = userLink.getAttribute("data-user-id");
    const href = userLink.getAttribute("href");
    if (!userId || !href) return null;
    const userCell = post.querySelector(".message-cell--user");
    if (!userCell) return null;
    return {
      userId,
      href,
      userCell,
    };
  }

  function buildStatsEl(score) {
    const el = document.createElement("div");
    el.className = "vr-stats";
    el.setAttribute("data-vr-score", String(score));
    const value = document.createElement("span");
    value.className = "vr-stats__value";
    value.textContent = fmt.format(score);
    const label = document.createElement("span");
    label.className = "vr-stats__label";
    label.textContent = "Reaction";
    el.appendChild(value);
    el.appendChild(label);
    return el;
  }

  function buildLoadingEl() {
    const el = document.createElement("div");
    el.className = "vr-loading";
    el.textContent = "…";
    return el;
  }

  function buildErrorEl() {
    const el = document.createElement("div");
    el.className = "vr-error";
    el.textContent = "—";
    el.title = "Không lấy được reaction score";
    return el;
  }

  function buildBadgeEl(score) {
    const el = document.createElement("div");
    el.className = "vr-badge--low";
    el.textContent = `⚠ Reaction thấp (${fmt.format(score)})`;
    return el;
  }

  function buildIgnoreBtn(ignoreUrl) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vr-ignore-btn";
    btn.textContent = "Ignore";
    btn.title = "Bỏ qua user này";
    btn.dataset.ignoreUrl = ignoreUrl;
    btn.addEventListener("click", onIgnoreClick);
    return btn;
  }

  async function onIgnoreClick(e) {
    const btn = e.currentTarget;
    if (btn.dataset.busy === "1" || btn.dataset.done === "1") return;
    const ignoreUrl = btn.dataset.ignoreUrl;
    if (!ignoreUrl) return;
    const a = getApi();
    if (!a) return;
    btn.dataset.busy = "1";
    const original = btn.textContent;
    btn.textContent = "Đang xử lý…";
    btn.disabled = true;
    try {
      await a.ignoreUser(ignoreUrl);
      btn.textContent = "Đã ignore";
      btn.dataset.done = "1";
      btn.classList.add("vr-ignore-btn--done");
    } catch (err) {
      btn.textContent = "Lỗi — thử lại";
      btn.disabled = false;
    } finally {
      btn.dataset.busy = "0";
      if (btn.dataset.done !== "1") {
        setTimeout(() => {
          if (btn.dataset.done !== "1") {
            btn.textContent = original;
            btn.disabled = false;
          }
        }, 1500);
      }
    }
  }

  function ensureStatsSlot(userCell) {
    let slot = userCell.querySelector(":scope > .vr-slot");
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "vr-slot";
      userCell.appendChild(slot);
    }
    return slot;
  }

  function applyStats(userCell, score, ignoreUrl) {
    const slot = ensureStatsSlot(userCell);

    slot
      .querySelectorAll(".vr-loading, .vr-error, .vr-stats, .vr-ignore-btn")
      .forEach((el) => el.remove());

    const stats = buildStatsEl(score);
    slot.appendChild(stats);

    const isLow = score < LOW_THRESHOLD_DEFAULT;

    if (isLow && ignoreUrl) {
      const ignoreBtn = buildIgnoreBtn(ignoreUrl);
      slot.appendChild(ignoreBtn);
    }

    const post = userCell.closest("article.js-post");
    if (post) {
      post.classList.toggle("vr-post--low", isLow);
    }
    userCell.classList.toggle("vr-user--low", isLow);

    let badge = userCell.querySelector(":scope > .vr-badge--low");
    if (isLow && !badge) {
      badge = buildBadgeEl(score);
      userCell.insertBefore(badge, userCell.firstChild);
    } else if (isLow && badge) {
      badge.textContent = `⚠ Reaction thấp (${fmt.format(score)})`;
    } else if (!isLow && badge) {
      badge.remove();
    }
  }

  function applyLoading(userCell) {
    const slot = ensureStatsSlot(userCell);
    if (slot.querySelector(".vr-stats, .vr-loading, .vr-error")) return;
    slot.appendChild(buildLoadingEl());
  }

  function applyError(userCell) {
    const slot = ensureStatsSlot(userCell);
    slot
      .querySelectorAll(".vr-loading, .vr-error, .vr-stats")
      .forEach((el) => el.remove());
    slot.appendChild(buildErrorEl());
  }

  function clearEnhancement() {
    document
      .querySelectorAll(".vr-stats, .vr-badge--low, .vr-slot")
      .forEach((el) => el.remove());
    document
      .querySelectorAll(".vr-user--low, .vr-post--low")
      .forEach((el) => el.classList.remove("vr-user--low", "vr-post--low"));
    document
      .querySelectorAll(`article.js-post[${OBSERVED_ATTR}]`)
      .forEach((el) => el.removeAttribute(OBSERVED_ATTR));
    document
      .querySelectorAll(`article.js-post[${DONE_ATTR}]`)
      .forEach((el) => el.removeAttribute(DONE_ATTR));
  }

  async function processPost(post) {
    if (post.hasAttribute(DONE_ATTR)) return;
    const author = extractAuthor(post);
    if (!author) {
      post.setAttribute(DONE_ATTR, "1");
      return;
    }
    post.setAttribute(DONE_ATTR, "1");
    const a = getApi();
    if (!a) return;
    applyLoading(author.userCell);
    let stats = null;
    try {
      stats = await a.getUserStats(author.userId, author.href);
    } catch (e) {
      // ignore
    }
    if (stats && typeof stats.reactionScore === "number") {
      applyStats(author.userCell, stats.reactionScore, stats.ignoreUrl);
    } else {
      applyError(author.userCell);
    }
  }

  function ensurePostObserver() {
    if (postObserver) return postObserver;
    postObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const post = entry.target;
          postObserver.unobserve(post);
          if (enabled) processPost(post);
        }
      },
      { rootMargin: IO_ROOT_MARGIN }
    );
    return postObserver;
  }

  function scanPosts() {
    if (!enabled) return;
    const io = ensurePostObserver();
    document.querySelectorAll(POST_SEL).forEach((post) => {
      if (post.hasAttribute(OBSERVED_ATTR)) return;
      post.setAttribute(OBSERVED_ATTR, "1");
      io.observe(post);
    });
  }

  function isThreadPage() {
    return /^\/t\/[^/]+\.\d+(\/|\/page-\d+)?(\?|$)/.test(window.location.pathname);
  }

  function setupDomObserver() {
    if (domObserver) domObserver.disconnect();
    domObserver = new MutationObserver(() => {
      if (!enabled) return;
      if (!isThreadPage()) return;
      scanPosts();
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  function setupUrlWatcher() {
    const check = () => {
      const cur = window.location.pathname + window.location.search;
      if (cur !== lastPath) {
        lastPath = cur;
        clearEnhancement();
        if (isThreadPage() && enabled) {
          setTimeout(scanPosts, 50);
        }
      }
    };
    window.addEventListener("popstate", check);
    const titleObs = new MutationObserver(check);
    const titleEl = document.querySelector("title");
    if (titleEl) titleObs.observe(titleEl, { childList: true, characterData: true });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[SYNC.enabled]) {
      enabled = changes[SYNC.enabled].newValue !== false;
      if (enabled) {
        clearEnhancement();
        if (isThreadPage()) scanPosts();
      } else {
        clearEnhancement();
        if (postObserver) {
          postObserver.disconnect();
          postObserver = null;
        }
      }
    }
  });

  function init() {
    loadEnabled().then(() => {
      if (isThreadPage() && enabled) {
        scanPosts();
      }
      setupDomObserver();
      setupUrlWatcher();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();