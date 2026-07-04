# Voz Reaction

Chrome extension (Manifest V3) — tự động lấy **reaction score** của tác giả mỗi post trong thread Voz và hiển thị trong pannel user; **đánh dấu đỏ** các user có reaction score âm (thường là clone/spam/low-quality).

## Tính năng chính

- Tự động phát hiện tác giả từng post trong `https://voz.vn/t/<slug>.<id>/...`
- Gọi member-tooltip API của Voz để lấy **Reaction score** (cùng API hover-tooltip gốc)
- Hiển thị score trong panel user, dưới `userTitle`
- Nếu score `< 0` → panel user có viền đỏ + badge `⚠ Reaction thấp`
- Cache 3 lớp: in-memory (page) → `chrome.storage.session` (cross-page trong cùng session) → không spam API
- Concurrent = 3, retry 1 lần, fail silent

## Cấu trúc

```
voz-reaction-chrome/
├── manifest.json        # Manifest V3
├── popup.html / .css / .js
├── api.js               # Fetch member-tooltip, parser, cache, semaphore
├── content.js           # Detect author, render stats, observer, popstate
├── content.css
├── background.js        # Service worker (default state)
└── icons/               # 16/32/48/128 PNG
```

## Cài đặt (dev)

1. Chrome → `chrome://extensions`
2. Bật **Developer mode**
3. **Load unpacked** → trỏ tới thư mục `voz-reaction-chrome/`
4. Mở 1 thread voz (`voz.vn/t/...`) và quan sát panel user

## Cấu hình

- `vr_enabled` (sync) — bật/tắt tiện ích (toggle trong popup)
- `chrome.storage.session` (auto) — cache user stats, TTL 10 phút, tự xoá khi đóng browser

## API sử dụng

```
GET https://voz.vn/u/{slug}.{id}/?tooltip=true&_xfResponseType=json&_xfWithData=1
    &_xfRequestUri={currentPath}&_xfToken={csrf}
```

Response JSON chứa HTML tooltip → parse `.memberTooltip-stats > dl.pairs` theo `<dt>` label.

CSRF lấy từ `<html data-csrf="...">` (fallback `window.XF.config.csrf`).

## Lệnh nhanh

- Reload extension: `chrome://extensions` → nút refresh
- Log content script: DevTools trên trang voz → Console
- Log service worker: `chrome://extensions` → **Service worker** link
- Clear session cache (debug): trong Console trang voz:
  ```js
  VozReactionAPI.clearSessionCache().then(() => location.reload());
  ```
