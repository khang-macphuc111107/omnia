# KẾ HOẠCH NÂNG CẤP htmustc-proxy — Lõi + OAuth + Auto-fetch Model + UI

> **Người thực thi:** Opus 4.8 · **Người duyệt:** operator
> **Ngày lập:** 2026-09-10 · **Base commit:** `93a72449`
> **Tham chiếu học tập:** `services/cliproxy` (module `github.com/router-for-me/CLIProxyAPI/v7`)
> **Nguyên tắc:** làm **tuần tự theo Phase**. Không nhảy phase. Mỗi task là một commit riêng, có test, revert độc lập được.

---

## 0. BỐI CẢNH ĐÃ KHẢO SÁT (đọc trước khi làm)

### 0.1 Quan hệ hai codebase

htmustc-proxy **đã** phụ thuộc cliproxy, nhưng chỉ dùng đúng một tầng:

```
go.mod: github.com/router-for-me/CLIProxyAPI/v7 v7.0.0
Đang import:  sdk/translator           (13 chỗ)
              sdk/translator/builtin    (2 chỗ)
KHÔNG dùng:   sdk/cliproxy/auth         (conductor: selection/cooldown/retry/refresh)
              sdk/cliproxy/executor     (lifecycle, websocket)
              internal/registry         (model catalogue updater)
```

`services/cliproxy` trong repo là **bản vendored để đọc tham chiếu**, KHÔNG có `replace` trỏ vào nó. Mọi task dưới đây **đọc** cliproxy để học pattern, rồi **viết code Go trong htmustc-proxy**. Chỉ nâng version module khi task nói rõ.

### 0.2 Bảng so sánh kiến trúc (số liệu đo thực tế)

| Hạng mục | cliproxy | htmustc-proxy | Kết luận |
|---|---|---|---|
| Điều phối request | `sdk/cliproxy/auth/Manager` + `ProviderExecutor` interface | `internal/proxy` 23.460 dòng / 59 file, switch-chain theo provider | **Thiếu abstraction** |
| Chọn account | `Selector` interface + `scheduler.go` + `weight.go` | `AccountManager.SelectAccountForModel` (1.143 dòng) | htmustc có sticky/round-robin/in-flight — **tốt, giữ lại** |
| Cooldown/backoff | `cooldown_state.go` + fingerprint + backoff test | rải rác trong `account_health.go`, `combo_health.go` | **Thiếu state machine tập trung** |
| Phân loại lỗi | `classification.go`, `error_events.go` | `upstream_error.go` (375 dòng) | Cần chuẩn hoá |
| Refresh token | min-heap loop + `markRefreshPending` dedup | `RefreshOAuthToken` gọi inline, **không dedup** | **Lỗi race thật** |
| OAuth per provider | Go thủ công / provider (`internal/auth/{claude,codex,antigravity,kimi,xai,vertex}`) | **Declarative** trong `providers.json` (8 flow shapes) | htmustc **tổng quát hơn** — giữ, chỉ vá phần cứng |
| Catalogue model tĩnh | `//go:embed models.json` + updater nền 3h + validate + change-callback | `//go:embed data/providers.json` (8.941 dòng), **không có updater** | **Thiếu** |
| Auto-fetch model theo account | không có | **đã có** `models_autofetch.go` (opt-in/provider, 3h, cap 25) | **Đã làm rồi — KHÔNG viết lại** |
| Ghi file | `tmp + os.Rename` (3 store + 3 helper `atomicWriteFile`) | `os.WriteFile` trực tiếp **7 chỗ** | **Không atomic** |
| Test | 3.994 func / 465 file | 954 func / 168 file | Mật độ ~1/4 |
| UI | — | 1 file `management.html` **510 KB / 10.422 dòng** | **Điểm đau chính** |

### 0.3 Cấu trúc `management.html` (đo thực tế)

```
dòng    24 – 1374   <style>    1.350 dòng CSS
dòng  1376 – 1434   <body>        58 dòng markup (chỉ là shell: sidebar + topbar + #content)
dòng  1434 – 10420  <script>   8.986 dòng JS inline, 523 hàm, TẤT CẢ ở global scope
  ├─ ~1451–3400   từ điển i18n vi + en nhúng thẳng trong JS (~1.900 dòng)
  ├─ 3529         async function api()   ← wrapper HTTP duy nhất
  ├─ 3648         const PAGES = [...]    ← 15 trang
  └─ phần còn lại: render từng trang bằng chuỗi template
122 chỗ gán innerHTML · 0 build tooling · phục vụ bằng //go:embed static/management.html
```

### 0.4 GUARDRAIL — tuyệt đối không làm

1. **KHÔNG** viết lại `internal/kiropool` hay `third_party/kiro-pool` — đó **là** account pool (xem `CLAUDE.md`).
2. **KHÔNG** viết lại `models_autofetch.go` — đã tồn tại và đã đúng ý tưởng cliproxy.
3. **KHÔNG** thay OAuth declarative bằng Go thủ công từng provider. htmustc tổng quát hơn cliproxy ở điểm này; chỉ vá phần thiếu.
4. **KHÔNG** đưa Node/Vite/bundler vào image Go. UI phải giữ `go build` là bước build duy nhất.
5. **KHÔNG** refactor `internal/proxy` hàng loạt trong một commit. Đây là service production đang chạy user thật.
6. **BẮT BUỘC** chạy `gitnexus_impact({target, direction:"upstream"})` trước khi sửa bất kỳ symbol nào, và báo blast radius. Dừng lại hỏi nếu HIGH/CRITICAL.

---

## PHASE 0 — CHẶN MÁU + LƯỚI AN TOÀN

> Production đang chạy user thật. Phase này **phải xong trước** mọi refactor.

### T0.1 · Vá lỗ auth bypass đang mở trên Internet — P0

- **File:** `internal/api/middleware/management_auth.go:31`
- **Bằng chứng (đã probe production `https://vip.htmustc.id.vn`, 2026-09-10):**
  ```
  POST /api/management/codexweb/login          → 401 management_key_required   (đúng)
  POST /api/management/codexweb/login/cookies  → 400 "invalid json"            ← LỌT AUTH
  POST /api/management/codexweb/login/save     → 400 "Open Chrome to sign in"  ← LỌT AUTH
  ```
- **Nguyên nhân:** `strings.Contains(path, "/codexweb/login/")` khớp cả 2 route POST ghi credential nằm trong group đã gắn `ManagementAuth` (`routes_mgmt.go:160-161`). Ý định ban đầu chỉ miễn 2 route **GET** ở `routes_mgmt.go:11-12`. Bằng chứng là tai nạn: `POST /codexweb/login` (không có dấu `/` cuối) vẫn được bảo vệ đúng.
- **Việc:** đổi sang khớp **chính xác** đúng 2 path GET được phép:
  ```go
  if c.Request.Method == http.MethodGet &&
     (path == "/api/management/codexweb/login/open" ||
      path == "/api/management/codexweb/login/status") {
      c.Next()
      return
  }
  ```
  Giữ nguyên 2 nhánh `HasSuffix("/oauth/callback")` và `HasSuffix("/codexweb/callback")`.
- **Test:** mở rộng `management_auth_test.go` — POST `/codexweb/login/cookies` và `/codexweb/login/save` **phải** 401; 2 GET vẫn 200.
- **Nghiệm thu:** cả 4 path suspect trả 401 khi không có key; dashboard đăng nhập bình thường.
- **Rủi ro:** thấp. **Rollback:** revert 1 commit.

### T0.2 · Gỡ chặn `go test -race` — P0

- **File:** `internal/proxy/scheduler.go:198-231`
- **Bằng chứng:** `defaultManager` là biến package-level global; `ResetAccountManagerForTest()` (dùng ở **18** chỗ) tự ghi *"Not safe for concurrent use"*. Không test nào dám `t.Parallel()`, và `-race` không chạy sạch.
- **Việc:**
  1. Thêm constructor thuần `NewAccountManagerFor(store, policy) *AccountManager` (không đụng singleton).
  2. Chuyển dần test sang constructor thuần; giữ singleton cho production path.
  3. Bọc `defaultManager` bằng `atomic.Pointer[AccountManager]` (hoặc `sync.RWMutex`).
- **Nghiệm thu:** `go test -race ./internal/...` xanh, lặp 3 lần không flake.
- **Ghi chú:** **điều kiện tiên quyết của Phase 2**. Không có `-race`, mọi fix race bên dưới không chứng minh được.

### T0.3 · Test đặc tả (characterization) cho đường request lõi

- **Việc:** trước khi refactor, chốt hành vi hiện tại bằng golden test cho chuỗi
  `InspectRequest` → `DetermineProvider` → `resolveTransport` → `buildEndpoint` → `buildHeaders`,
  với ≥8 provider đại diện: `openai-compat`, `claude`, `gemini`, `codex`, `antigravity`, `grok`, `kiro`, `genspark`.
- **Nghiệm thu:** test pass trên code hiện tại **không sửa gì**. Đây là lưới an toàn cho Phase 2 — mọi refactor sau phải giữ nguyên golden này.

---

## PHASE 1 — LÕI: SỬA LỖI ĐÃ XÁC MINH

> Các task độc lập nhau, làm song song được, nhưng **commit riêng từng cái**.

### T1.1 · Chống đua khi refresh OAuth token — P0

- **File:** `internal/proxy/oauth.go:24` `RefreshOAuthToken`
- **Bằng chứng:** không có lock/singleflight/dedup nào. Hai request đồng thời trên cùng account đều qua `tokenNeedsRefresh` (dòng 47) rồi cùng POST `refresh_token` grant với **cùng một token**. Provider có xoay refresh_token (Google, OpenAI/codex) sẽ vô hiệu grant thứ hai → account chết. Ghi account sau đó là last-writer-wins.
- **Tham chiếu cliproxy:** `sdk/cliproxy/auth/conductor_refresh.go:322` `markRefreshPending(id, now) bool`; `auto_refresh_loop.go` (min-heap + concurrency bound).
- **Việc:**
  1. Thêm `singleflight.Group` (hoặc `map[string]chan struct{}` + mutex) khoá theo `account.ID` trong `Router`.
  2. Mọi caller đi qua cùng một entry point — hiện có: `models_fetch.go:73`, `quota*.go`, `core.go`, retry path.
  3. Người thắng thực hiện refresh; người thua **chờ rồi đọc lại** account đã cập nhật, **không** tự POST.
- **Test:** `-race`, 50 goroutine gọi đồng thời trên 1 account → đúng **1** HTTP POST tới token endpoint (đếm bằng `httptest`).
- **Nghiệm thu:** test trên xanh; log không còn 2 dòng refresh liền nhau cùng accountID.

### T1.2 · Ghi file atomic — P1

- **File:** `internal/storage/file_storage.go` — 7 chỗ `os.WriteFile` (dòng 430, 471, 513, 602, 1078, 1239, 1361)
- **Bằng chứng:** crash/OOM giữa lúc ghi để lại file account cụt → account rơi khỏi routing, không có cảnh báo.
- **Tham chiếu cliproxy:** `internal/store/objectstore.go:213-217` (`tmp := path + ".tmp"` → `os.Rename`); helper `internal/pluginstore/install.go:519` `writeFileAtomic`.
- **Việc:** thêm `internal/storage/atomicwrite.go`:
  ```go
  func writeFileAtomic(path string, data []byte, mode os.FileMode) error
  // CreateTemp cùng thư mục → Write → Sync → Close → Chmod → Rename
  ```
  Thay cả 7 chỗ, giữ nguyên mode (0600 cho account, 0644 cho phần còn lại).
- **Test:** inject lỗi ở bước Write → file cũ còn nguyên vẹn, không có file cụt, không có `.tmp` sót.

### T1.3 · Ghi account có kiểm tra phiên bản (optimistic concurrency) — P1

- **File:** `internal/proxy/scheduler.go` vùng persist account (~dòng 335)
- **Bằng chứng:** ghi cả bản ghi sau một network call → đè mất model-lock, quota stamp, token usage mà goroutine khác vừa ghi.
- **Tham chiếu cliproxy:** `sdk/cliproxy/auth/persist_policy.go`, `store.go`.
- **Việc:** thêm `Version int64` vào `storage.Account`; `Save` chỉ ghi khi version khớp, lệch thì reload + merge theo field. Migration: `Version == 0` được chấp nhận (tương thích ngược với file cũ).
- **Test:** 2 goroutine sửa 2 field khác nhau đồng thời → cả 2 field đều còn sau khi ghi.

### T1.4 · `Registry.Get` trả snapshot bất biến — P1

- **File:** `internal/providers/registry.go` (~dòng 749)
- **Bằng chứng:** trả `*Provider` sống trong khi background sync ghi lại slice `Models` → data race trên hot path mỗi request.
- **Việc:** ưu tiên `atomic.Pointer[Provider]` + **thay nguyên con trỏ** khi sync (copy-on-write, không sửa tại chỗ). Phương án thay thế: trả bản copy nông + copy slice `Models` (tốn allocation mỗi request).
- **Test:** `-race`, 1 goroutine `Get` liên tục + 1 goroutine sync catalogue → sạch.

### T1.5 · `pumpRawSSE`: đua giữa lỗi buffered và kênh data đã đóng — P1

- **File:** `internal/api/handler/v1_raw.go:972`
- **Bằng chứng:** stream lỗi bị log thành 200 và account bị đánh dấu **healthy** khoảng 50% số lần → account hỏng vẫn được routing tiếp.
- **Việc:** ưu tiên đọc kênh lỗi trước khi kết luận thành công; chỉ mark healthy khi stream kết thúc sạch.
- **Test:** `httptest` phát lỗi giữa stream, chạy 100 lần → 100 lần đều phân loại là lỗi (không flake).
- **Liên quan:** cùng họ triệu chứng với mục *"Empty/malformed HTTP 200 → 429"* trong `CLAUDE.md`.

### T1.6 · `codexweb`: bỏ qua `scanner.Err()` và luôn nối `data: [DONE]` — P1

- **File:** `internal/codexweb/forward.go:111`
- **Bằng chứng:** stream ChatGPT-Web bị cắt ngang vẫn được giao cho client như một câu trả lời hoàn chỉnh.
- **Việc:** kiểm `scanner.Err()`; khác nil thì phát khung lỗi SSE thay vì `[DONE]`, và **không** mark account healthy.

### T1.7 · Lockout đăng nhập dashboard khoá nhầm IP proxy — P1

- **File:** `internal/api/session/limiter.go:96`
- **Bằng chứng:** sau Caddy, mọi request mang IP container Caddy → một kẻ ẩn danh khoá được **toàn bộ** operator khỏi `/management`. `docker-compose.yml:367` **không** set `TRUST_PROXY` cho service này.
- **Việc:** đọc client IP thật qua `X-Forwarded-For` **chỉ khi** `TRUST_PROXY` bật. Đề xuất diff `docker-compose.yml` trong PR nhưng **operator tự áp dụng** (không tự sửa file compose production).

### T1.8 · `grok2api` cắt cụt body > 1 MiB — P1

- **File:** `internal/grok2api/rotate.go:238`
- **Việc:** peek không được vứt phần dư — dùng `io.MultiReader` nối lại phần đã đọc trước khi forward, hoặc buffer đủ.
- **Test:** forward body 2 MiB → upstream nhận đủ 2 MiB.

### T1.9 · `grok2api` giữ `ensureMu` xuyên qua ~6 network round-trip — P1

- **File:** `internal/grok2api/models.go:159`
- **Bằng chứng:** ôm mutex qua cả bcrypt admin login, trong khi **mọi** chat request cần đúng mutex đó → nghẽn toàn proxy.
- **Việc:** tách "quyết định có refresh" (trong lock) khỏi "thực hiện refresh" (ngoài lock); dùng lại singleflight của T1.1.

### T1.10 · Logger ghi nguyên query string — P2

- **File:** `internal/api/middleware/logger.go:36`
- **Bằng chứng:** API key proxy, management secret, chữ ký media 30 ngày rơi vào stdout + ring buffer.
- **Việc:** redact theo whitelist — log path + tên tham số, giá trị thay bằng `***`.

### T1.11 · OAuth loopback bind `0.0.0.0` — P2

- **File:** `internal/api/handler/mgmt_oauth_loopback.go:105`
- **Bằng chứng:** endpoint đổi token hở ra mạng LAN trong 5 phút.
- **Việc:** bind `127.0.0.1`. Tham chiếu `internal/auth/codex/oauth_server.go` của cliproxy. **Gộp với T3.1.**

### T1.12 · Xoá API key cuối cùng ⇒ `/v1` mở toang, không cảnh báo — P2

- **File:** `internal/api/handler/mgmt_apikeys.go:149`
- **Việc:** chặn xoá key cuối, hoặc bắt xác nhận rõ ràng + log WARN mỗi lần boot khi danh sách rỗng.

### T1.13 · `Access-Control-Max-Age` sai kiểu — P3

- **File:** `internal/api/middleware/cors.go:58` — đang phát code point UTF-8 thay vì số thập phân → preflight không bao giờ được cache. Sửa bằng `strconv.Itoa`.

---

## PHASE 2 — LÕI: KIẾN TRÚC THEO cliproxy

> **Điều kiện vào:** T0.2 và T0.3 đã xong. Không có `-race` + golden test thì **không** bắt đầu.

### T2.1 · Định nghĩa `ProviderExecutor` interface

- **Tham chiếu:** `sdk/cliproxy/auth/conductor.go:16`
  ```go
  type ProviderExecutor interface {
      Identifier() string
      Execute(ctx, auth, req, opts) (Response, error)
      ExecuteStream(ctx, auth, req, opts) (*StreamResult, error)
      Refresh(ctx, auth) (*Auth, error)
  }
  ```
- **Việc trong htmustc:** tạo `internal/proxy/executor.go` với interface tương đương, **adapter-first**: bọc đường xử lý hiện có thành `genericExecutor` (dùng `Router.buildEndpoint/buildHeaders`). **Chưa tách provider nào.**
- **Nghiệm thu:** toàn bộ golden test T0.3 vẫn xanh; hành vi runtime không đổi một byte.
- **Vì sao adapter trước:** cho phép các task sau tách từng provider tăng dần, mỗi lần một commit revert được.

### T2.2 · Tầng phân loại lỗi upstream

- **Tham chiếu:** `sdk/cliproxy/auth/classification.go`, `error_events.go`
- **Việc:** chuẩn hoá `internal/proxy/upstream_error.go` thành enum rõ ràng:
  `Unauthorized · RateLimited · Overloaded · QuotaExhausted · ModelUnsupported · Transient · Fatal`
  Mỗi loại kèm quyết định: có retry account khác không / có cooldown không / cooldown bao lâu / có refresh token không.
- **Nghiệm thu:** bảng test ánh xạ `(status, body-pattern, provider) → classification`, ≥40 case lấy từ log thật.

### T2.3 · Máy trạng thái cooldown + backoff

- **Tham chiếu:** `sdk/cliproxy/auth/cooldown_state.go`, `cooldown_backoff_test.go`, `cooldown_fingerprint.go`
- **Việc:** gom logic đang rải ở `account_health.go` + `combo_health.go` vào một state machine: exponential backoff có jitter, cooldown theo **fingerprint** `(account, model, loại lỗi)` chứ không chỉ theo account.
- **Lý do fingerprint:** một model bị từ chối không nên đánh sập cả account cho những model khác.
- **Nghiệm thu:** test dùng **fake clock**, không `time.Sleep`.

### T2.4 · Vòng retry/failover thống nhất

- **Tham chiếu:** `sdk/cliproxy/auth/conductor_execution.go:275` `executeMixedOnce`
- **Việc:** một vòng duy nhất: chọn account → prepare (refresh nếu cần) → execute → classify → (cooldown + chọn account kế) hoặc trả về. Có `maxRetryCredentials` và **ngân sách thời gian tổng**.
- **Chú ý:** `AccountManager` đã có `FailoverBudget()` (`scheduler.go:403`). Giữ nguyên, đừng thay.
- **Nghiệm thu:** test *"3 account, 2 cái trả 429, 1 cái OK → đúng 3 lần thử, account tốt được chọn, 2 account kia vào cooldown"*.

### T2.5 · Vòng auto-refresh token nền

- **Tham chiếu:** `sdk/cliproxy/auth/auto_refresh_loop.go` (min-heap theo thời điểm hết hạn, concurrency bound)
- **Việc:** thay refresh "lười" (chỉ khi có request chạm vào) bằng loop nền refresh **trước** khi hết hạn. Dùng lại singleflight T1.1.
- **Lợi ích:** loại hẳn latency spike của request xui gặp đúng lúc token hết hạn.
- **Nghiệm thu:** fake clock, 100 account hạn lệch nhau → mỗi account refresh đúng 1 lần, đúng thời điểm, không quá N đồng thời.

### T2.6 · Tách executor theo provider (tăng dần)

- **Thứ tự đề xuất** (dễ → khó, theo mức lệch so với generic):
  `openai-compat` → `claude` → `gemini` → `codex` → `antigravity` → `grok` → `genspark`
- **Quy tắc:** **một provider một commit**. Sau mỗi commit: golden test T0.3 + `-race` + smoke thật trên dev instance (`:18099`).
- **Dừng lại nếu:** một provider cần >400 dòng adapter — báo lại, đừng ép.

---

## PHASE 3 — OAuth TỪNG PROVIDER

> htmustc đang **declarative** (`providers.json` → `OAuthConfig`, 8 flow shapes: Device / State / ChallengePoll / InitiatePoll / BrowserPoll / BrowserToken / PathBrowser / KeyExchange — xem `internal/providers/types.go:459-508`). Đây là **ưu thế** so với cliproxy. Phase này **hardening**, không thay mô hình.

### T3.1 · Chuẩn hoá PKCE + local callback server

- **Tham chiếu:** `internal/auth/codex/pkce.go`, `oauth_server.go`; `internal/auth/claude/pkce.go`, `oauth_server.go`
- **Việc:** một helper PKCE dùng chung (`S256`, verifier 43–128 ký tự, `crypto/rand`), một loopback server dùng chung: bind `127.0.0.1:0`, có timeout, `state` dùng một lần, tự tắt sau callback. Thay các bản cục bộ trong `mgmt_oauth_*.go`.
- **Gộp với T1.11.**

### T3.2 · Ngữ nghĩa token theo provider

- **Tham chiếu:** `internal/auth/codex/jwt_parser.go`, `token.go`; `internal/auth/kimi/token.go`; `internal/auth/xai/token.go`
- **Việc:** bổ sung vào `OAuthConfig` (**declarative**, KHÔNG hard-code Go từng provider):
  - `refresh_token_rotates: bool` — provider có xoay refresh_token không (quyết định logic ghi lại + cảnh báo khi grant cũ bị vô hiệu).
  - `expiry_skew_seconds: int` — refresh sớm bao lâu (mặc định 300).
  - `expiry_from_jwt: bool` — lấy hạn từ claim `exp` của access token thay vì `expires_in`.
- **Nghiệm thu:** mở rộng `internal/providers/oauth_flows_test.go` — mỗi flow shape có ≥1 test round-trip bằng `httptest`.

### T3.3 · Ma trận conformance OAuth

- **Việc:** bảng test cho **mọi** provider trong `providers.json` có khối `oauth`: khẳng định flow shape được phân loại đúng, URL sinh đúng, tham số bắt buộc đầy đủ. Provider thiếu field → test đỏ kèm thông báo rõ tên provider + field thiếu.
- **Nghiệm thu:** thêm provider mới vào JSON mà thiếu field ⇒ CI đỏ ngay, không phải chờ lỗi runtime.

---

## PHASE 4 — AUTO-FETCH MODEL

> **Nhắc lại:** `internal/api/handler/models_autofetch.go` **đã có** (fetch theo account, opt-in/provider, 3h, cap 25/pass). Phase này bổ sung **mảnh còn thiếu**: catalogue tĩnh tự cập nhật.

### T4.1 · Updater catalogue tĩnh

- **Tham chiếu:** `internal/registry/model_updater.go` (cliproxy) — đọc kỹ pattern:
  1. `//go:embed` làm fallback lúc `init()`
  2. goroutine nền, `sync.Once` chặn double-start
  3. fetch **nhiều URL** lần lượt, timeout 30s, giới hạn kích thước
  4. parse → **validate** → chỉ khi hợp lệ mới swap vào store
  5. fetch lỗi ⇒ **giữ nguyên dữ liệu cũ** (không bao giờ xoá trắng)
- **Việc trong htmustc:** `internal/providers/catalogue_updater.go` cho `data/providers.json`:
  - URL nguồn cấu hình qua `config.yaml`, **mặc định rỗng = tắt** (opt-in).
  - `validateProvidersCatalog()` — từ chối payload làm **giảm** số provider quá 20%, hoặc thiếu bất kỳ provider nào đang có account (chống nguồn hỏng làm mất routing).
- **Nghiệm thu:** test nguồn 404 / JSON sai / catalogue teo → catalogue cũ nguyên vẹn, có log WARN.
- **Rủi ro:** **cao** nếu validate lỏng — catalogue sai làm chết routing. Validate là phần quan trọng nhất của task này, viết test trước.

### T4.2 · Phát hiện thay đổi + callback

- **Tham chiếu:** `model_updater.go:190` `detectChangedProviders` + `SetModelRefreshCallback`
- **Việc:** so sánh theo provider, phát callback kèm danh sách provider đổi. Consumer: làm mới cache registry (nối với T1.4), ghi audit log, hiện badge "có model mới" trên UI (nối với T5.7).

### T4.3 · Công cụ sinh catalogue offline

- **Tham chiếu:** `cmd/fetch_codex_models`, `cmd/fetch_antigravity_models`, `cmd/validate_codex_models`
- **Việc:**
  - `cmd/fetch_provider_models/` — chạy tay, dùng credential thật, sinh/cập nhật `data/providers.json`, in diff trước khi ghi.
  - `cmd/validate_catalogue/` — chạy trong CI.
- **Nghiệm thu:** CI đỏ nếu `providers.json` không hợp lệ.

---

## PHASE 5 — UI DASHBOARD

> **Ràng buộc cứng:** không bundler, không Node trong image. Dùng **ES modules gốc** + `//go:embed` cả thư mục. `go build` vẫn là bước build duy nhất.

### T5.1 · Chuyển sang embed thư mục + ES modules

- **File:** `internal/api/dashboard/dashboard.go`
- **Việc:**
  ```go
  //go:embed static
  var staticFS embed.FS
  ```
  Phục vụ `/management/assets/*` từ FS này với `Content-Type` + `Cache-Control` đúng. `management.html` giữ nguyên URL cũ.
- **Nghiệm thu:** trang tải y hệt, không đổi hành vi. Đây là commit **hạ tầng**, chưa tách code.

### T5.2 · Tách CSS

- **Việc:** 1.350 dòng `<style>` → `static/assets/app.css`. Không đổi một selector nào.
- **Nghiệm thu:** so sánh ảnh chụp trước/sau ở cả light + dark, đủ 15 trang.

### T5.3 · Tách i18n ra JSON

- **Việc:** ~1.900 dòng từ điển inline → `static/assets/i18n/vi.json` + `en.json`, nạp động khi đổi ngôn ngữ.
- **Lợi ích phụ:** thêm ngôn ngữ không cần đụng JS; giảm ~19% kích thước file chính.
- **Nghiệm thu:** script kiểm **key parity** giữa vi/en — thiếu key ⇒ CI đỏ.

### T5.4 · Tách JS thành module

- **Cấu trúc đích:**
  ```
  static/assets/
    core/    api.js  i18n.js  dom.js  toast.js  modal.js  format.js  state.js
    pages/   dashboard.js accounts.js usage.js quota.js providers.js nodes.js
             combos.js grok2api.js kiropool.js chatgptweb.js proxies.js
             logs.js console.js plugins.js settings.js
    app.js   (router + đăng ký PAGES)
  ```
- **Quy tắc:** **một trang một commit**. Sau mỗi commit: mở trang đó, xác nhận hoạt động y hệt.
- **Thứ tự:** `core/*` trước → rồi trang đơn giản nhất (`proxies`, `console`) → phức tạp nhất cuối (`accounts`, `providers`).

### T5.5 · Diệt `innerHTML`

- **Bằng chứng:** 122 chỗ gán `innerHTML`. Dữ liệu provider/account/model đi thẳng vào chuỗi HTML.
- **Việc:** helper `el(tag, props, ...children)` trả `HTMLElement`, dùng `textContent` cho mọi giá trị động. Chỉ giữ `innerHTML` cho hằng số tĩnh do dev viết.
- **Ưu tiên:** chỗ render **dữ liệu từ upstream** (tên model, thông báo lỗi provider, tên account) làm trước — đó là bề mặt XSS thật.
- **Nghiệm thu:** test với tên model chứa `<img src=x onerror=alert(1)>` → hiển thị nguyên văn, không thực thi.

### T5.6 · Bộ test cho UI

- **Bối cảnh:** hiện **không có** harness nào.
- **Việc:** sau khi tách module, mỗi module là ES module import được → test bằng `node --test` thuần cho phần logic thuần (format, i18n, state, dựng URL của api.js). Không cần jsdom cho các phần này.
- **Nghiệm thu:** ≥1 test cho mỗi module `core/`; CI chạy được không cần trình duyệt.

### T5.7 · Tinh chỉnh UX (chỉ sau khi cấu trúc xong)

Chỉ làm **sau** T5.4. Đề xuất, operator chốt:
- Bảng account: virtualize khi >200 dòng (hiện render hết).
- Trạng thái loading/error nhất quán (hiện mỗi trang một kiểu).
- `console` + `logs`: cắt buffer — hiện giữ toàn bộ trong DOM.
- Badge "model mới" nối vào callback T4.2.

---

## THỨ TỰ THỰC THI + ƯỚC LƯỢNG

| Thứ tự | Phase | Task | Chặn bởi | Ước lượng |
|---|---|---|---|---|
| 1 | 0 | T0.1 | — | 1h |
| 2 | 0 | T0.2 | — | 4h |
| 3 | 0 | T0.3 | T0.2 | 6h |
| 4 | 1 | T1.1, T1.9 | T0.2 | 6h |
| 5 | 1 | T1.2, T1.3, T1.4 | T0.2 | 8h |
| 6 | 1 | T1.5, T1.6 | T0.3 | 5h |
| 7 | 1 | T1.7, T1.10–T1.13 | — | 4h |
| 8 | 2 | T2.1 → T2.5 | T0.2 + T0.3 | 20h |
| 9 | 2 | T2.6 (7 provider) | T2.1–T2.4 | 24h |
| 10 | 3 | T3.1 → T3.3 | T1.1 | 12h |
| 11 | 4 | T4.1 → T4.3 | T1.4 | 10h |
| 12 | 5 | T5.1 → T5.6 | — (song song được) | 28h |
| 13 | 5 | T5.7 | T5.4 | mở |

**Phase 5 chạy song song được với Phase 2–4** (khác hẳn vùng file). Nếu có 2 phiên: một làm lõi (0→1→2→3→4), một làm UI (5).

---

## ĐỊNH NGHĨA "XONG" CHO MỌI TASK

1. `go build ./...` xanh.
2. `go test -race ./internal/...` xanh (sau T0.2).
3. Golden test T0.3 không đổi kết quả — trừ khi task **cố ý** đổi hành vi, phải ghi rõ trong commit message.
4. Đã chạy `gitnexus_impact` trên mọi symbol bị sửa; blast radius có trong commit message.
5. `gitnexus_detect_changes()` trước khi commit.
6. Smoke thật trên dev instance `:18099` cho mọi task chạm đường request.
7. Commit message: `<TaskID>: <mô tả>` + dòng blast radius + `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
8. **Không** deploy production trong cùng commit. Deploy là bước riêng của operator.
