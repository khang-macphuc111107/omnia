# CapCut media worker — phương án headless browser tối ưu tài nguyên + đa account

Mục tiêu: image/video CapCut gọi hoàn toàn qua API proxy, **tối ưu RAM/CPU nhất có thể**, và
**mỗi request dùng account nào thì browser tự "đăng nhập" đúng account đó** (qua cookie), không thao
tác tay. Tài liệu này là bản thiết kế đầy đủ + lộ trình triển khai.

> Ràng buộc nền: kết quả image/video đến qua Frontier WS có attestation `webmssdk` (ByteDance),
> KHÔNG tái tạo được pure-HTTP → bắt buộc chạy SDK trong 1 browser engine. "Đăng nhập" = **nạp cookie
> phiên** (không password) → tức là nạp cookie vào 1 `BrowserContext` là xong (không cần gõ mật khẩu).

---

## 1. Nguyên tắc thiết kế
1. **1 browser process, N `BrowserContext`** — mỗi account 1 context (cookie riêng, cách ly hoàn toàn).
   Context nhẹ hơn browser ~5–8× → đây là đòn bẩy tài nguyên lớn nhất.
2. **Warm context pool** — giữ context "nóng" (đã mở `ai-creator`, đã login) và **tái dùng** giữa các
   request cùng account → bỏ ~10–15s load trang + login mỗi lần, giảm CPU đột biến.
3. **LRU + cap** — giới hạn số context nóng (mặc định 6), evict cái idle lâu nhất để chặn RAM phình.
4. **Request interception** — chặn tải byte của thứ vô dụng (showroom/bee/analytics/font) nhưng **vẫn
   ghi URL** kết quả từ sự kiện request → tiết kiệm băng thông + CPU render mà không mất khả năng bắt URL.
5. **Serialize theo tài nguyên** — mặc định 1 gen/lúc (RAM/CPU bounded = "tối ưu tài nguyên nhất").
   Có công tắc tăng song song khi cần throughput.
6. **Recycle** — khởi động lại browser sau N gen / T giờ để chống memory leak của Chromium.
7. **Auto-login theo account** — key = `account_id` (hoặc `sha256(cookie)`). Cookie đổi → rebuild context.

---

## 2. Kiến trúc

```
                         ┌───────────────────────── htmustc-proxy (Go) ─────────────────────────┐
  client ──/v1/images────►  pool chọn account (cookie)  ──►  callCapCutMedia  ──HTTP POST /generate│
        ──/v1/videos───►     (TTS/quota: pure-HTTP, không qua đây)            {cookie, account_id,  │
                         └───────────────────────────────────────────────────  prompt, kind, ...} ─┘
                                                                                     │ HTTP
                                                                                     ▼
             ┌──────────────────────── capcut-worker (Python, headless) ────────────────────────┐
             │  HTTP API  /generate  /health  /metrics                                            │
             │      │                                                                             │
             │      ▼   SessionManager (async event loop, 1 process)                              │
             │  ┌──────────────────────────────────────────────────────────────────────────┐    │
             │  │  ContextPool (LRU, cap=N)   key = account_id                                │    │
             │  │   acc A → BrowserContext(cookie A) + Page@ai-creator (WARM, logged-in)      │    │
             │  │   acc B → BrowserContext(cookie B) + Page@ai-creator (WARM)                 │    │
             │  │   acc C → (idle > TTL) → evicted                                            │    │
             │  └───────────────────────────────┬──────────────────────────────────────────┘    │
             │        1 Chromium process ────────┘   (--headless-shell, flags tiết kiệm)          │
             │  Route filter: abort showroom/bee/analytics/font (ghi URL kết quả từ request event)│
             └──────────────────────────────────────────────────────────────────────────────────┘
```

Thành phần:
- **SessionManager**: điều phối; giữ 1 browser; sở hữu ContextPool; áp semaphore song song; recycle.
- **ContextPool**: `dict[account_key] → AccountSession`. LRU evict theo `last_used`. Cap = `max_contexts`.
- **AccountSession**: `{context, page, cookie_hash, last_used, lock}` — 1 lock/account (1 gen/account/lúc).
- **GenExecutor**: luồng gõ prompt → gate → chờ kết quả → (video) bấm tải → thu URL. Dùng lại từ bản hiện tại.
- **RouteFilter**: chặn byte rác, ghi URL kết quả.

---

## 3. Vòng đời 1 request `/generate` (siêu chi tiết)

```
1. HTTP /generate {cookie, account_id, prompt, kind, aspect, resolution, timeout}
2. key = account_id or sha256(cookie)[:16]
3. await global_semaphore (giới hạn N gen đồng thời; mặc định 1)
4. sess = pool.get(key)
   4a. MISS → tạo BrowserContext (UA, viewport, accept_downloads, route filter),
       context.add_cookies(parse(cookie)); page = context.new_page();
       page.goto(ai-creator); VERIFY login (prompt box .ProseMirror hiện + widget credit).
         - không login được (redirect login / body có "log in") → trả {status:"auth_required"} (401-ish)
       pool.put(key, sess); nếu pool > cap → evict LRU idle (đóng context, giải phóng RAM)
   4b. HIT nhưng cookie_hash khác (cookie đã refresh) → đóng context cũ, tạo lại như 4a.
   4c. HIT & warm → tái dùng (đã ở ai-creator, đã login).
5. await sess.lock   (1 gen/account/lúc; account khác chạy song song nếu bật)
6. GenExecutor.run(sess.page, prompt, kind, ...):
     - nếu page không còn ở start/studio sạch → điều hướng "New project" hoặc reload nhẹ
     - gõ prompt (ProseMirror) → Enter
     - vòng lặp: bấm gate (Confirm/Continue/lighter — không Upgrade); scrape cost; dò kết quả
     - kind=video: khi "ready" → trigger Tải xuống → bắt URL mp4 (tiktokcdn ?mime_type=video_mp4)
     - kind=image: bắt URL faceuimg-sign đã ký; dedup rendition
7. sess.last_used = now; release lock; release semaphore
8. trả {status, cost, urls[], kind}
9. (nền) recycle: nếu gen_count % recycle_every==0 hoặc uptime>recycle_hours → đóng+mở lại browser
```

**Tái dùng page an toàn**: sau mỗi gen, page ở trạng thái studio của gen đó. Trước gen mới của cùng
account: bấm **"Dự án mới"/New project** (hoặc `goto(ai-creator)`) để về khung sạch → tránh nối nhầm
hội thoại. Đây là bước reset rẻ (không đóng context → giữ login).

---

## 4. Tối ưu tài nguyên — chi tiết

### 4.1 Cờ khởi động Chromium (headless-shell)
```
--headless=new (dùng chromium)   # nhẹ hơn full chrome
--no-sandbox                                     # container/root (cân nhắc bảo mật; hoặc user riêng)
--disable-dev-shm-usage                          # tránh /dev/shm nhỏ trong docker
--disable-gpu --disable-software-rasterizer
--disable-extensions --disable-default-apps --mute-audio
--disable-background-networking --disable-sync --no-first-run --no-default-browser-check
--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints
--js-flags=--max-old-space-size=512              # trần heap V8/tab
```

### 4.2 Request interception (đòn tiết kiệm lớn)
- `context.route("**/*", handler)`.
- **Ghi URL trước, chặn byte sau**: handler đọc `route.request.url` (đủ để bắt kết quả) rồi:
  - `abort()` với host rác: `vimo-sg`, `beecdn|bee_prod|ies-fe-bee` (showroom/marketing), `mcs-normal|mon-sg|monitor|snssdk|analytics|gtm|google-analytics|doubleclick`, font (`.woff2?`), ảnh showroom `tplv-*-resize:*`.
  - `continue_()` cho: `capcut.com` app JS/CSS + API (`edit-api-sg`, `commerce-api-sg`, `storyboard`), và **request kết quả** (faceuimg-sign, tiktokcdn video) — với kết quả, ta chỉ cần URL nên có thể `abort()` sau khi ghi (tiết kiệm tải), NHƯNG video cần trang xử lý → để an toàn: cho phép nhưng đó là số ít.
- Lợi ích: bỏ tải hàng chục video showroom + analytics mỗi lần load → giảm mạnh CPU/băng thông.

### 4.3 Warm pool + LRU
- `max_contexts` (mặc định 6): trần số account nóng đồng thời trong RAM.
- Evict: khi vượt cap, đóng context `last_used` cũ nhất **đang không giữ lock**.
- `idle_ttl` (mặc định 20 phút): context idle quá lâu → đóng chủ động (giải phóng RAM cả khi chưa vượt cap).

### 4.4 Recycle chống leak
- `recycle_every_gens` (mặc định 200) hoặc `recycle_after_hours` (mặc định 6): đóng toàn bộ context +
  browser, mở lại; pool rỗng, tái tạo lazy. Chạy khi không có gen đang chạy (chờ semaphore rảnh).

### 4.5 Ngân sách tài nguyên (ước lượng, headless-shell trên Linux x64)
| Cấu hình | RAM | Ghi chú |
|---|---|---|
| Browser baseline | ~120–180 MB | 1 process |
| Mỗi warm context + page | ~40–90 MB | tuỳ trang |
| 1 gen đang chạy | +100–250 MB tạm | render + xử lý |
| Pool 6 context, concurrency 1 | ~0.5–0.8 GB | cấu hình "tiết kiệm" khuyến nghị |
| Pool 10, concurrency 3 | ~1.5–2.5 GB | cấu hình throughput |
- CPU: đột biến lúc load/gen; idle gần 0. Interception cắt ~40–60% CPU lúc load.
- Khuyến nghị host tối thiểu: **1 vCPU / 1.5 GB RAM** cho cấu hình tiết kiệm; **2 vCPU / 4 GB** cho throughput.

---

## 5. Đa account + auto-login (giải quyết yêu cầu cốt lõi)
- **Login = nạp cookie phiên** (`sessionid/sid_guard/...`) vào `BrowserContext` — KHÔNG password
  (đúng ràng buộc an toàn). Verify bằng trạng thái trang, không bằng đăng nhập.
- Proxy gửi kèm `account_id` (đã có) → worker key hoá pool theo account → **request của acc nào chạy
  đúng context đã login acc đó**.
- **Verify login** sau khi mở ai-creator: có `.ProseMirror` + đọc được widget credit (số `✦`), URL không
  phải trang login. Fail → `auth_required` → proxy bench account (nhắc refresh cookie).
- **Cookie refresh**: `msToken` xoay; nếu chỉ msToken đổi thì context cũ vẫn chạy (cookie trong context
  không tự cập nhật, nhưng phiên sống nhờ sid_guard). Khi proxy cập nhật cookie account (PUT), worker
  thấy `cookie_hash` đổi → rebuild context (nạp cookie mới).
- **Cách ly**: mỗi context có cookie/storage riêng → không rò rỉ giữa account. Không dùng chung page.

---

## 6. Mô hình song song
| Chế độ | Cơ chế | Ưu | Nhược |
|---|---|---|---|
| **Serialize (mặc định)** | `global_semaphore=1`, async 1 event loop | RAM/CPU thấp nhất, đơn giản | 1 gen/lúc toàn hệ |
| **Song song theo account** | `global_semaphore=K`, lock/account | nhiều account gen cùng lúc | RAM×K |
| **Đa instance** | nhiều worker khác port, proxy shard theo account (consistent hash) | scale ngang, context affinity | cần LB/định tuyến |

> Async Playwright (`playwright.async_api`) là bắt buộc cho song song thật trong 1 process (sync API kẹt
> greenlet theo thread). Bản serialize cũng nên dùng async để đồng nhất + sẵn sàng bật K>1.

---

## 7. Phương án Remote Browser (so sánh)
| Phương án | Cookie ở đâu | Scale | Chi phí | Khi nào dùng |
|---|---|---|---|---|
| **A. Worker tự host (browser cùng host)** ⭐ | Hạ tầng của bạn | vừa | thấp | Mặc định — riêng tư, độ trễ thấp |
| **B. Browserless self-host (Docker) qua CDP** | Hạ tầng của bạn | tốt (tách browser khỏi logic) | thấp–vừa | Cần scale browser độc lập; nhiều instance |
| **C. Managed (Browserbase/Steel/browserless cloud)** | **RỜI hạ tầng bạn** ⚠️ | rất tốt (auto) | theo giờ browser | Chỉ khi chấp nhận rủi ro gửi cookie phiên CapCut ra ngoài |

- Mã nguồn **không đổi nhiều**: `chromium.launch()` (A) ↔ `chromium.connect_over_cdp(WS)` (B/C).
- B/C hỗ trợ "context" + inject cookie như nhau → auto-login theo account vẫn nguyên cơ chế.
- **Khuyến nghị**: A cho production riêng tư; B khi cần scale (tự chủ); C chỉ khi bảo mật cho phép
  (session CapCut Pro là nhạy cảm — rời hạ tầng = rủi ro chiếm phiên).

---

## 8. Ma trận lỗi & xử lý
| Tình huống | Phát hiện | Xử lý |
|---|---|---|
| Cookie hết hạn | verify login fail / redirect login | `auth_required` → proxy bench account (IsAuthFailure) |
| Thiếu credit | gate "Not enough" | worker bấm "lighter version"; nếu vẫn thiếu → `no_credit` → cooldown |
| Tính năng Ultra | gate "Ultra features" | bấm **Continue** hạ về Pro (720p); log rõ |
| Gen quá lâu | vượt `timeout` | trả `submitted_no_result`; giữ context ấm; proxy cooldown ngắn |
| Chromium crash | `browser.is_connected()` false | relaunch browser + rebuild context lazy |
| Rò rỉ RAM | gen_count/uptime | recycle định kỳ |
| Page kẹt | reset "New project" thất bại | đóng context account đó, tạo lại |

---

## 9. Cấu hình (đề xuất — mở rộng `capcut:` trong config.yaml)
```yaml
capcut:
  enabled: true
  worker_url: "http://127.0.0.1:8790"
  auto_start: true
  headless: true
  # ---- tài nguyên (mới) ----
  max_contexts: 6          # số account nóng tối đa trong RAM (LRU)
  concurrency: 1           # số gen đồng thời (1 = tiết kiệm nhất)
  idle_ttl_sec: 1200       # đóng context idle sau 20'
  recycle_every_gens: 200  # recycle browser sau N gen
  recycle_after_hours: 6
  block_junk: true         # bật request interception
  # ---- remote (tuỳ chọn) ----
  cdp_url: ""              # nếu set -> connect_over_cdp thay vì launch (browserless/managed)
```
Worker nhận các tham số này qua CLI/env; Go truyền xuống hoặc worker tự đọc env `CAPCUT_WORKER_*`.

## 10. HTTP API worker (mở rộng)
- `POST /generate` `{cookie, account_id?, prompt, kind, aspect?, resolution?, timeout?}` → `{status, cost, urls[], kind, account_key}`
- `GET /health` → `{ok, browser, contexts, inflight}`
- `GET /metrics` → `{gens_total, gens_ok, auth_fail, evictions, rss_mb, contexts:[{key,last_used,busy}]}`
- `POST /evict` `{account_id}` → đóng context 1 account (khi cookie đổi/logout) — tuỳ chọn.

## 11. Lộ trình triển khai
- **P1 (tối ưu tài nguyên, giữ sync)** ✅ đang có nền: 1 browser, context/req, interception, recycle.
- **P2 (warm pool + async)**: chuyển `playwright.async_api`, ContextPool LRU theo account, semaphore,
  verify-login, /metrics. ← trọng tâm bản này.
- **P3 (scale)**: cdp_url (browserless), đa instance + shard account ở proxy, /metrics cho autoscale.

## 12. Đối chiếu yêu cầu
- ✅ "tối ưu tài nguyên nhất": 1 browser + context nhẹ + interception + serialize + recycle + LRU cap.
- ✅ "call bằng acc nào chạy browser tự động login acc đó": pool key theo account + inject cookie +
  verify — request acc X luôn chạy context đã login acc X, cookie đổi thì rebuild.
- ✅ "remote browser khả thi": `cdp_url` (browserless self-host = riêng tư; managed = tiện nhưng cân nhắc bảo mật).
- ✅ Luồng image/video: mục 3 + GenExecutor (gate/handle/thu URL, video có bước tải).
