# CapCut provider (native)

Provider `capcut` gọi model CapCut (Dreamina / Seedream / Seedance / Sora / Veo + TTS) bằng
**cookie đăng nhập Pro**. TTS + credit/quota chạy thuần headless (sign đã dịch ngược). Image/Video
chạy qua **worker headless Chromium** (bắt buộc — xem "Vì sao cần worker"). Callable như mọi
provider (OpenAI-compatible).

## File
- `internal/providers/builtin_capcut.go` — định nghĩa provider + full model catalog + cookie auth.
- `internal/proxy/capcut_call.go` — sign, TTS (pure-HTTP), credit/quota, `callCapCutMedia` (image/video → worker).
- `internal/proxy/capcut_worker.go` — HTTP client gọi worker (`CAPCUT_WORKER_URL`), map size→480p/720p/1080p/2K/4K.
- `internal/capcutworker/capcutworker.go` — spawn + giám sát worker khi `capcut.auto_start: true`.
- `internal/config/config.go` — `CapCutConfig` (`capcut:` trong config.yaml).
- `internal/app/run.go` — set `CAPCUT_WORKER_URL` từ config + khởi động worker (nếu auto_start).
- `capcut-worker/capcut_worker.py` — worker Playwright (service HTTP `/generate`, `/health`) — đã bundle.
- `capcut-worker/cookie-extractor/`, `capcut-worker/get_cookie_cdp.py` — công cụ lấy cookie.
- Wiring: `registry.go` (Register), `audio.go` (`case "capcut-tts"`), `image.go`/`video.go` (`case "capcut"`),
  `quota.go` (`fetchCapCutQuota`).

## Thêm account (cookie)
UI `/management → Providers → CapCut → Add Account`, hoặc API:
```bash
curl -XPOST http://127.0.0.1:18080/api/management/accounts -H 'content-type: application/json' \
 -d '{"provider":"capcut","type":"cookie","credentials":{"cookie":"<COOKIE>"},"status":"healthy","weight":1}'
```
`<COOKIE>` = header Cookie sau khi đăng nhập capcut.com Pro (sessionid, sid_tt, msToken, ttwid…).
Thêm nhiều account để pool tự xoay vòng / cooldown / failover. **Chỉ cần credential `cookie`** —
image/video KHÔNG còn cần `frontier_access_key`/`frontier_device_id` (worker tự chạy SDK).

**Lấy cookie chuẩn (gồm httpOnly):** xem hướng dẫn đầy đủ **[docs/CAPCUT_GET_COOKIE.md](CAPCUT_GET_COOKIE.md)**.
Tóm tắt: KHÔNG đọc được từ ổ đĩa (Chrome v20 app-bound + file khoá + cần admin). Dùng 1 trong:
(A) extension `capcut-worker/cookie-extractor` (bấm 1 nút, `chrome.cookies` đọc cả httpOnly, có nút Add vào proxy),
(B) CDP tự động `capcut-worker/get_cookie_cdp.py` (`Storage.getCookies`), (C) DevTools → Copy as cURL.

## Gọi (OpenAI-compatible)
```bash
# TTS (headless, trả MP3)
curl -XPOST .../v1/audio/speech -d '{"model":"capcut-tts","input":"xin chào","voice":"alloy"}' -o out.mp3
# Ảnh (qua worker) — size → tỉ lệ + độ phân giải (1K/2K/4K)
curl -XPOST .../v1/images/generations -d '{"model":"seedream5pro","prompt":"a red apple on a plate","size":"1024x1024"}'
# Video (qua worker) — resolution 480p/720p/1080p, aspect_ratio 16:9/9:16
curl -XPOST .../v1/videos/generations -d '{"model":"seedance_2pt0_fast","prompt":"a dog running","resolution":"720p","aspect_ratio":"16:9"}'
```
Voice: alloy/echo/fable/nova/shimmer → giọng CapCut; hoặc `"voice":"capcut:<speaker_id>"`.
`resolution`/`aspect_ratio` (video) và `size` (ảnh) được nhúng vào prompt để agent CapCut chọn.

> Cơ chế worker tối ưu tài nguyên + đa account (warm pool, auto-login theo cookie, remote browser):
> xem **[docs/CAPCUT_WORKER_DESIGN.md](CAPCUT_WORKER_DESIGN.md)**.

## Worker headless (image/video) — Linux

### Vì sao cần worker
Kết quả image/video đẩy về qua **Frontier WebSocket** (`wss://frontier-sg.capcut.com/ws/v2`), mà
`access_key` của WS do **webmssdk** (device-attestation obfuscate của ByteDance) sinh CLIENT-SIDE và
**bind vào đúng connection SDK tạo ra** — không có HTTP endpoint, không tái tạo/tái dùng được thuần
Go/headless (đã RE & kiểm chứng: bogus key → WS 400; reuse key tươi của app → 0 event). Cách DUY NHẤT
qua attestation là chạy CHÍNH SDK trong một trình duyệt thật. Worker = Playwright + Chromium headless,
mở `capcut.com/ai-creator` bằng cookie Pro, để trang tự chạy webmssdk + frontier SDK, rồi lái UI.

### Luồng worker (đã xác minh chạy)
1. nạp cookie → mở `/ai-creator` (redirect `/ai-creator/start`, "Video Studio").
2. gõ prompt vào ô ProseMirror (contenteditable) → Enter (`send_msg`).
3. agent trả lời + hiện **thẻ gate**; worker tự bấm (KHÔNG bao giờ bấm *Upgrade*/*Buy credits*):
   - **Consume credits? → Confirm** (đủ credit): thẻ hiện luôn số credit sẽ trừ, vd `+78`.
   - **You're using Ultra features → Continue** (prompt chạm 1080p+/model Ultra → hạ về tuỳ chọn Pro).
   - **Not enough credits left → Continue with a lighter version** (thiếu credit → model rẻ hơn).
4. sinh xong → media đã ký render trong trang → worker thu URL (`x-expires`+`x-signature`), loại rác
   (bee marketing / showroom / template thumbnail).

### Chạy worker (đã bundle sẵn trong repo: `capcut-worker/`)
```bash
cd capcut-worker
python -m venv venv && . venv/bin/activate
pip install -r requirements.txt
python -m playwright install --with-deps chromium   # lần đầu
python capcut_worker.py --host 127.0.0.1 --port 8790
# hoặc systemd: capcut-worker/capcut-worker.service
# test 1 phát: python capcut_worker.py --once image "a red apple on a white plate"
```

### Cấu hình trong proxy (`config.yaml`)
```yaml
capcut:
  enabled: true
  worker_url: "http://127.0.0.1:8790"   # nơi proxy gọi worker (mặc định)
  auto_start: false                     # true = proxy tự spawn worker (cần python+playwright trên host)
  # khi auto_start: true
  python: "python"
  worker_script: "capcut-worker/capcut_worker.py"
  port: 8790
  headless: true
```
- `auto_start: false` (khuyến nghị production): chạy worker riêng (systemd/docker), proxy chỉ gọi HTTP.
- `auto_start: true`: proxy tự khởi động + giám sát worker (log + restart backoff), tắt cùng proxy.
- Proxy đọc địa chỉ worker qua env **`CAPCUT_WORKER_URL`** (config tự set; có thể override bằng env).

Worker giữ 1 browser sống, Playwright chạy trong **thread riêng** (job queue) để tránh lỗi greenlet;
mỗi request 1 context (cách ly cookie theo account), gen serialize. Cần song song thật → nhiều
instance khác port + nhiều `worker_url` (hoặc 1 LB phía trước).

## Model
TTS: `capcut-tts`. Ảnh: `seedream5pro`, `ai_model_seedream_4_5/4_0s`, `ai_model_nano_pro/nano`.
Video: `seedance_2.5`, `seedance2_mini`, `seedance_2pt0(_fast)`, `ai_model_seedance_1_5_pro`,
`ai_model_sora_2`, `ai_model_veo_3_fast`.

## Credit / Quota — BẢNG GIÁ
> Bảng giá chi tiết (theo model × độ phân giải × thời lượng, nguồn đo): **[CAPCUT_PRICING.md](CAPCUT_PRICING.md)**.
- Xem số dư: mục **Quota** (proxy) → `fetchCapCutQuota` (POST `commerce/v1/benefits/user_credit`).
- **Chi phí LUÔN hiện trên thẻ gate trước khi trừ**, và worker **scrape số này trả về `cost`** trong
  response `/generate` + log `credit_cost` mỗi lần → luôn biết giá thực từng request (bảng dưới là tham chiếu).
- Bảng giá (đo trực tiếp trên thẻ "Dùng điểm tín dụng?"; ✅ = đã đo, ~ = ước lượng nội suy):

| Loại | Model / Chất lượng | Thời lượng | Credit |
|---|---|---|---|
| **TTS** | mọi giọng (endpoint audition) | — | **0** (miễn phí – preview) ✅ |
| **Ảnh** | model thường (Nano / Seedream 4.0s), 1K | 1 ảnh | **≈1–4** ✅ (gen được với acc còn 4cr) |
| **Ảnh** | high-fidelity (Seedream 5 Pro / Nano Pro), **2K** | 1 ảnh | **65** ✅ |
| **Ảnh** | high-fidelity, 4K | 1 ảnh | ~90–130 ~ (cần Ultra) |
| **Video** | Seedance 2.0 Fast/Mini, 720p | 5s | ~65 ~ |
| **Video** | Seedance 2.0 Fast, 720p | **6s** | **78** ✅ |
| **Video** | Seedance 2.0 Fast, 720p | **8s** | **104** ✅ |
| **Video** | Seedance 2.0 Fast, 720p | 10s | ~130 ~ |
| **Video** | Seedance 2.0 Fast, 720p | 12s | ~156 ~ |
| **Video** | 1080p / 2K / 4K, hoặc Sora 2 / Veo 3 / Seedance 2.5 Pro | mọi | **Ultra** (Pro không có) |

- Quy luật video (720p Seedance Fast): xấp xỉ **~13 credit/giây** (78/6s, 104/8s).
- **1080p / 2K / 4K + Sora 2 / Veo 3 / Seedream Pro = tính năng Ultra**, KHÔNG có trong Pro. Với acc Pro,
  agent chặn ("Bạn đang dùng tính năng Ultra") → worker tự bấm **Tiếp tục/Continue** hạ về tuỳ chọn Pro
  (thường 720p). Muốn 2K/4K/1080p thật → account phải nâng **Ultra**.
- Thiếu credit → agent hiện "Not enough credits" + "Continue with a lighter version" → worker tự chọn
  bản nhẹ hơn (rẻ hơn) để vẫn ra kết quả.

## Trạng thái
| | |
|---|---|
| TTS | ✅ đầy đủ headless (đã test qua proxy: `/v1/audio/speech` → audio/mpeg) |
| Ảnh | ✅ qua worker (đã test: prompt → URL ảnh đã ký; ảnh khớp prompt) |
| Video | ✅ qua worker (mechanism xác nhận: Confirm → gen → trừ 78 credit; URL kết quả `.mp4` đã ký) |
| Credit/Quota | ✅ số dư + chi phí/gen |

## Ghi chú ranh giới (RE)
- Direct `common_task/new` → **shark block** (MetaSec X-Argus). Đường agent thì shark-free nhưng kết
  quả qua frontier WS attestation → phải dùng worker.
- `sign = md5("9e2c|" + path[-7:] + "|7|8.4.0|" + device_time + "|" + tdid + "|11ac")` (khớp 219/219).
- Đã RE thử client Frontier WS thuần Go (protobuf) nhưng bỏ: access_key bind connection SDK →
  không tái dùng được. Đường chính hiện tại là worker headless.
