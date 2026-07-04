(() => {
  "use strict";

  const CACHE_KEY_PREFIX = "vr:user:";
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const CACHE_SCHEMA_VERSION = 1;
  const CONCURRENCY = 3;
  const REQUEST_TIMEOUT_MS = 8000;
  const RETRY_DELAY_MS = 1000;

  const inFlight = new Map();
  const memCache = new Map();
  const queue = [];
  let active = 0;

  function getCsrf() {
    const html = document.documentElement;
    const fromDataset = html?.dataset?.csrf;
    if (fromDataset) return fromDataset;
    try {
      return window.XF?.config?.csrf || null;
    } catch {
      return null;
    }
  }

  function getPagePath() {
    return window.location.pathname + window.location.search;
  }

  function parseScore(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s || s === "-" || s === "−") return null;
    const cleaned = s.replace(/[^\d-]/g, "");
    if (!cleaned || cleaned === "-") return null;
    const n = parseInt(cleaned, 10);
    return Number.isFinite(n) ? n : null;
  }

  function parseTooltipHtml(htmlString) {
    if (!htmlString) return null;
    let doc;
    try {
      doc = new DOMParser().parseFromString(htmlString, "text/html");
    } catch {
      return null;
    }
    const stats = doc.querySelector(".memberTooltip-stats");
    if (!stats) return null;

    const result = {
      messages: null,
      reactionScore: null,
      points: null,
      ignoreUrl: null,
    };
    stats.querySelectorAll("dl.pairs").forEach((dl) => {
      const dt = dl.querySelector("dt");
      const dd = dl.querySelector("dd");
      if (!dt || !dd) return;
      const label = dt.textContent.trim().toLowerCase();
      if (label.includes("messages")) {
        result.messages = parseScore(dd.textContent);
      } else if (label.includes("reaction")) {
        result.reactionScore = parseScore(dd.textContent);
      } else if (label.includes("point")) {
        result.points = parseScore(dd.textContent);
      }
    });

    const ignoreAnchor = doc.querySelector('a[href$="/ignore"]');
    if (ignoreAnchor) {
      const href = ignoreAnchor.getAttribute("href");
      if (href) result.ignoreUrl = href;
    }

    if (
      result.reactionScore === null &&
      result.messages === null &&
      result.points === null &&
      !result.ignoreUrl
    ) {
      return null;
    }
    return result;
  }

  async function readSessionCache(userId) {
    try {
      if (!chrome?.storage?.session) return null;
      const key = `${CACHE_KEY_PREFIX}${userId}`;
      const got = await chrome.storage.session.get(key);
      const entry = got?.[key];
      if (!entry) return null;
      if (entry.v !== CACHE_SCHEMA_VERSION) return null;
      if (!entry.ts || Date.now() - entry.ts > CACHE_TTL_MS) return null;
      if (!entry.data) return null;
      return entry.data;
    } catch {
      return null;
    }
  }

  async function writeSessionCache(userId, data) {
    try {
      if (!chrome?.storage?.session) return;
      const key = `${CACHE_KEY_PREFIX}${userId}`;
      await chrome.storage.session.set({
        [key]: { v: CACHE_SCHEMA_VERSION, ts: Date.now(), data },
      });
    } catch {
      // ignore quota / unavailability
    }
  }

  async function clearSessionCache() {
    try {
      if (!chrome?.storage?.session) return;
      const all = await chrome.storage.session.get(null);
      const toRemove = Object.keys(all).filter((k) => k.startsWith(CACHE_KEY_PREFIX));
      if (toRemove.length) {
        await chrome.storage.session.remove(toRemove);
      }
    } catch {
      // ignore
    }
  }

  function buildTooltipUrl(href) {
    const base = `https://voz.vn${href}`;
    const url = new URL(base);
    url.searchParams.set("tooltip", "true");
    url.searchParams.set("_xfResponseType", "json");
    url.searchParams.set("_xfWithData", "1");
    url.searchParams.set("_xfRequestUri", getPagePath());
    const csrf = getCsrf();
    if (csrf) url.searchParams.set("_xfToken", csrf);
    return url.toString();
  }

  function fetchWithTimeout(url, opts = {}, timeout = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      fetch(url, { ...opts, signal: ctrl.signal, credentials: "include" })
        .then((r) => {
          clearTimeout(timer);
          resolve(r);
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  async function fetchTooltipOnce(userId, href) {
    const url = buildTooltipUrl(href);
    const resp = await fetchWithTimeout(url, {
      headers: {
        accept: "application/json",
        "x-requested-with": "XMLHttpRequest",
      },
    });
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    const json = await resp.json();
    if (json?.status !== "ok" || !json?.html?.content) {
      const err = new Error("API not ok");
      err.code = "bad_response";
      throw err;
    }
    const parsed = parseTooltipHtml(json.html.content);
    if (!parsed) {
      const err = new Error("Parse failed");
      err.code = "parse_failed";
      throw err;
    }
    return parsed;
  }

  async function fetchTooltipWithRetry(userId, href) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fetchTooltipOnce(userId, href);
      } catch (e) {
        attempt += 1;
        const retriable =
          e.name === "AbortError" ||
          e.status === 429 ||
          (e.status >= 500 && e.status < 600) ||
          e.code === "bad_response";
        if (!retriable || attempt > 1) throw e;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  function runOne(task) {
    return task()
      .catch(() => null)
      .finally(() => {
        active -= 1;
        pump();
      });
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const next = queue.shift();
      active += 1;
      runOne(next);
    }
  }

  function schedule(task) {
    queue.push(task);
    pump();
  }

  async function getUserStats(userId, href) {
    if (!userId || !href) return null;
    if (inFlight.has(userId)) return inFlight.get(userId);

    const mem = memCache.get(userId);
    if (mem && Date.now() - mem.ts < CACHE_TTL_MS) {
      return mem.data;
    }

    const sess = await readSessionCache(userId);
    if (sess) {
      memCache.set(userId, { ts: Date.now(), data: sess });
      return sess;
    }

    const promise = new Promise((resolve) => {
      schedule(async () => {
        try {
          const data = await fetchTooltipWithRetry(userId, href);
          memCache.set(userId, { ts: Date.now(), data });
          writeSessionCache(userId, data);
          resolve(data);
        } catch (e) {
          // cache negative for a short window to avoid hammering
          memCache.set(userId, { ts: Date.now(), data: null });
          resolve(null);
        } finally {
          inFlight.delete(userId);
        }
      });
    });

    inFlight.set(userId, promise);
    return promise;
  }

  async function ignoreUser(href) {
    if (!href) throw new Error("Missing ignore href");
    const url = new URL(href, window.location.origin);
    url.searchParams.set("_xfResponseType", "json");
    const csrf = getCsrf();
    if (csrf) url.searchParams.set("_xfToken", csrf);

    const resp = await fetchWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
      },
      REQUEST_TIMEOUT_MS
    );
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    let json = null;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }
    if (json && json.status && json.status !== "ok") {
      const err = new Error("API not ok");
      err.code = "bad_response";
      throw err;
    }
    return { ok: true, raw: json };
  }

  window.VozReactionAPI = {
    getUserStats,
    ignoreUser,
    getCsrf,
    clearSessionCache,
  };
})();
