# CapCut provider — Hướng dẫn setup chi tiết (htmustc-proxy)

Hướng dẫn từ 0 → gọi được image/video/TTS của CapCut qua API proxy, add account bằng cookie.
Trọng tâm: **lấy đúng URL của "browser điều khiển" và cắm vào proxy**.

- Tài liệu liên quan: [CAPCUT_PROVIDER.md](CAPCUT_PROVIDER.md) (tổng quan), [CAPCUT_GET_COOKIE.md](CAPCUT_GET_COOKIE.md)
  (lấy cookie), [CAPCUT_WORKER_DESIGN.md](CAPCUT_WORKER_DESIGN.md) (kiến trúc/tài nguyên).

---

## 0. Hiểu 2 loại URL (RẤT QUAN TRỌNG)

Có **2 "link"** khác nhau, đừng nhầm:

```
   ┌─ htmustc-proxy (Go) ─┐        ┌─ capcut-worker (Python) ─┐        ┌─ Browser (Chromium) ─┐
   │  gọi image/video ───────►  worker_url  ────► điều khiển ──►  cdp_url (nếu remote)  ──►  Chrome │
   └──────────────────────┘   (link 1)                        (link 2, TUỲ CHỌN)              └──────┘
```

| Link | Là gì | Ai gọi ai | Bắt buộc? | Config |
|---|---|---|---|---|
| **`worker_url`** | Địa chỉ HTTP của **worker** (service Python) | proxy → worker | ✅ luôn cần | `capcut.worker_url` |
| **`cdp_url`** | Địa chỉ **browser điều khiển** (Chrome debug / browserless) | worker → browser | ⚙️ chỉ khi dùng remote browser | `capcut.cdp_url` |

- **Mặc định (đơn giản nhất):** worker tự mở Chromium ngay trong nó → **KHÔNG cần `cdp_url`**. Chỉ cần `worker_url`.
- **Remote browser:** worker KHÔNG tự mở Chrome, mà nối tới 1 Chrome/browserless chạy sẵn qua `cdp_url`.
  Dùng khi muốn tách RAM browser sang máy khác / scale / chạy browser trên máy Mac riêng.

---

## 1. Yêu cầu
- **Proxy**: binary htmustc-proxy (Go) — đã có.
- **Worker**: Python ≥ 3.11 + Playwright + chromium. (Chỉ cần cho image/video; TTS/quota không cần.)
- 1 **cookie** đăng nhập CapCut Pro còn credit (xem mục 4).

---

## 2. Cài worker

### 2a. macOS — TOOL 1-CLICK (khuyên dùng) ⭐
Chỉ cần chạy 1 lần, nó tự cài + in URL để paste:
```bash
cd capcut-worker
chmod +x start-mac.command      # 1 lần
./start-mac.command             # hoặc double-click trong Finder
```
Tool sẽ: tự tạo venv + cài Playwright/Chromium (lần đầu) → chạy worker (bind LAN, `caffeinate`
chống ngủ) → **in ra URL + đoạn config để copy-paste sang `htmustc-proxy/config.yaml`**. Giữ cửa
sổ mở để worker chạy; Ctrl+C để dừng. Không cần nhập cookie ở Mac — cookie đi kèm mỗi request từ proxy.

### 2b. Linux / macOS (thủ công)
```bash
cd capcut-worker
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python -m playwright install --with-deps chromium   # Linux
# macOS: bỏ --with-deps: python -m playwright install chromium
```

### 2c. Docker (tuỳ chọn)
```dockerfile
FROM mcr.microsoft.com/playwright/python:v1.48.0-jammy
WORKDIR /app
COPY capcut-worker/ /app/
RUN pip install -r requirements.txt && python -m playwright install chromium
EXPOSE 8790
CMD ["python","capcut_worker.py","--host","0.0.0.0","--port","8790"]
```

### 2d. Chạy thử worker (độc lập)
```bash
python capcut_worker.py --host 127.0.0.1 --port 8790
# kiểm tra:
curl http://127.0.0.1:8790/health      # {"ok":true,"browser":true,...}
```

---

## 3. LẤY URL & CẮM VÀO PROXY (phần chính)

### 3.1 `worker_url` — link tới worker (luôn cần)
- Đây chỉ là **địa chỉ HTTP nơi worker lắng nghe** (`--host`/`--port`).
- Cùng máy với proxy → `http://127.0.0.1:8790`.
- Worker ở máy khác (vd Mac) → `http://<IP-máy-worker>:8790` (mở port trong LAN, **đừng phơi internet**).
- Kiểm tra link đúng: `curl <worker_url>/health` trả `{"ok":true}`.

Cắm vào `config.yaml`:
```yaml
capcut:
  enabled: true
  worker_url: "http://127.0.0.1:8790"   # hoặc http://192.168.1.50:8790 nếu worker ở máy khác
  auto_start: true                      # true = proxy tự chạy worker (worker cùng máy)
  python: "python3"                     # macOS/Linux; hoặc full path venv
  worker_script: "capcut-worker/capcut_worker.py"
```
> Nếu worker ở **máy khác** thì để `auto_start: false` (proxy không spawn), tự chạy worker ở máy đó.

### 3.2 `cdp_url` — link "browser điều khiển" (chỉ khi remote browser)
Bỏ qua mục này nếu dùng mặc định (worker tự mở Chromium). Dùng khi muốn browser chạy tách ra.

#### Cách A — browserless (Docker) ⭐ khuyên dùng cho remote tự chủ
```bash
docker run -d --name browserless -p 3000:3000 \
  -e "TOKEN=capcut-secret" -e "CONCURRENT=3" \
  ghcr.io/browserless/chromium
```
- **URL cần lấy** = endpoint WebSocket CDP của browserless:
  ```
  ws://<IP-máy-browserless>:3000?token=capcut-secret
  ```
- Cắm vào proxy:
  ```yaml
  capcut:
    enabled: true
    worker_url: "http://127.0.0.1:8790"
    auto_start: true
    cdp_url: "ws://127.0.0.1:3000?token=<CAPCUT_TOKEN_REDACTED>"   # worker sẽ NỐI tới đây thay vì tự mở Chrome
  ```
- Kiểm tra browserless sống: `curl http://127.0.0.1:3000/`  (hoặc mở trong trình duyệt).

#### Cách B — Chrome/Chromium tự bật cổng debug (đơn giản, 1 máy)
```bash
# Linux/macOS — mở Chrome với cổng debug + profile riêng
google-chrome --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/capcut-cdp
# macOS: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/capcut-cdp
```
- **URL cần lấy** = `webSocketDebuggerUrl` — đọc từ:
  ```bash
  curl http://127.0.0.1:9222/json/version
  # -> {"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/XXXXXXXX", ...}
  ```
- Lấy đúng chuỗi `ws://127.0.0.1:9222/devtools/browser/....` đó cắm vào:
  ```yaml
  capcut:
    cdp_url: "ws://127.0.0.1:9222/devtools/browser/XXXXXXXX"
  ```
  > Lưu ý: chuỗi này **đổi mỗi lần Chrome khởi động lại**. Nên với Chrome-debug thủ công, mỗi lần restart phải lấy lại URL. Muốn ổn định → dùng **browserless** (URL cố định) ở Cách A.

#### Cách C — Managed (Browserbase / Steel / browserless cloud)
- Lấy **Connect URL** từ dashboard dịch vụ (dạng `wss://connect.browserbase.com?apiKey=...` hoặc tương tự).
- Cắm vào `cdp_url`.
- ⚠️ **Bảo mật**: cookie phiên CapCut Pro sẽ rời hạ tầng của bạn → chỉ dùng nếu chấp nhận rủi ro.

#### Test URL trước khi cắm
```bash
# browserless / chrome-debug:
curl http://<host>:<port>/json/version      # có webSocketDebuggerUrl = OK
```
Sau khi set `cdp_url` và chạy worker, log worker in `cdp=yes`; `/health` phải `{"ok":true}`.

---

## 4. Lấy cookie & add account
Chi tiết: [CAPCUT_GET_COOKIE.md](CAPCUT_GET_COOKIE.md). Nhanh:
```bash
# add account bằng cookie (chỉ cần credential "cookie")
curl -XPOST http://127.0.0.1:18080/api/management/accounts -H 'content-type: application/json' \
 -d '{"provider":"capcut","type":"cookie","credentials":{"cookie":"<COOKIE ĐẦY ĐỦ>"},"status":"healthy","weight":1}'
```
Hoặc UI `/management → Providers → CapCut → Add Account`, hoặc extension `capcut-worker/cookie-extractor`
(có nút "Add account vào proxy").

---

## 5. Gọi thử (OpenAI-compatible)
```bash
# TTS (pure-HTTP, free, không cần worker)
curl -XPOST http://127.0.0.1:18080/v1/audio/speech \
 -d '{"model":"capcut-tts","input":"xin chào","voice":"alloy"}' -o out.mp3

# Ảnh (qua worker)
curl -XPOST http://127.0.0.1:18080/v1/images/generations \
 -d '{"model":"seedream5pro","prompt":"a red apple on a plate","size":"1024x1024"}'

# Video (qua worker) — resolution 720p (Pro), aspect 16:9
curl -XPOST http://127.0.0.1:18080/v1/videos/generations \
 -d '{"model":"seedance_2pt0_fast","prompt":"a dog running","resolution":"720p","aspect_ratio":"16:9"}'
```

---

## 6. Kiểm tra & giám sát
```bash
curl <worker_url>/health     # {"ok":true,"browser":true,"contexts":N,"inflight":M}
curl <worker_url>/metrics    # gens_total/gens_ok/auth_fail/evictions + danh sách context theo account
```
- Số dư credit: mục **Quota** trong proxy (tự query `user_credit`).
- Log worker: stdout (hoặc file trong systemd/launchd/docker).

---

## 7. Các chế độ triển khai (chọn 1)

| Chế độ | worker_url | auto_start | cdp_url | Khi nào |
|---|---|---|---|---|
| **Cùng máy, worker tự mở Chrome** ⭐ | `http://127.0.0.1:8790` | `true` | trống | Đơn giản nhất, 1 server |
| **Worker máy riêng (vd Mac)** | `http://<IP-Mac>:8790` | `false` | trống | Tách RAM browser sang Mac; chạy worker bằng launchd |
| **Remote browser (browserless)** | `http://127.0.0.1:8790` | `true` | `ws://<host>:3000?token=...` | Scale browser độc lập, giữ hạ tầng riêng |
| **Managed browser** | `http://127.0.0.1:8790` | `true` | `wss://...` (dịch vụ) | Auto-scale, ⚠️ cookie rời hạ tầng |

---

## 8. Tối ưu tài nguyên (xem CAPCUT_WORKER_DESIGN.md §4)
```yaml
capcut:
  max_contexts: 3          # ít account nóng → ít RAM
  idle_ttl_sec: 600        # đóng context rảnh sớm
  concurrency: 1           # 1 gen/lúc = tiết kiệm nhất
  block_junk: true         # cắt showroom/analytics/font
  recycle_every_gens: 200
```
Ngân sách: ~0.6–0.9 GB/1 context nóng; ~1–1.5 GB cho 3 context + 1 gen. TTS/quota ~0.

---

## 9. Troubleshooting
| Triệu chứng | Nguyên nhân | Xử lý |
|---|---|---|
| `/health` không phản hồi | worker chưa chạy / sai worker_url | chạy worker; kiểm `curl worker_url/health` |
| worker log `cdp=no` mà bạn muốn remote | chưa set `cdp_url` | set `capcut.cdp_url` + restart |
| `connect_over_cdp` lỗi | URL sai / browser debug tắt / token sai | `curl host:port/json/version`; lấy lại `webSocketDebuggerUrl`; kiểm token browserless |
| gọi image/video trả `unauthorized` | cookie hết hạn | lấy cookie mới (CAPCUT_GET_COOKIE.md), PUT cập nhật account |
| `no_credit` | account hết credit | nạp credit / đổi account |
| video `submitted_no_result` | render lâu > timeout | tăng timeout / thử lại; 720p nhanh hơn |
| RAM cao | nhiều context nóng | giảm `max_contexts`, `idle_ttl_sec` |
| macOS worker chết khi rảnh | máy ngủ | `caffeinate -dimsu ...` + tắt sleep (xem plist) |

---

## 10. Bảng giá credit
Chi tiết đầy đủ: **[CAPCUT_PRICING.md](CAPCUT_PRICING.md)**. Tóm: TTS=0; ảnh 1K ~1–4, ảnh 2K=65;
video 720p 6s=78, 8s=104 (~13cr/s); 1080p/2K/4K + Sora/Veo/Seedream Pro = cần Ultra. Chi phí thật
hiện trên thẻ mỗi lần + worker trả `cost` mỗi request.
