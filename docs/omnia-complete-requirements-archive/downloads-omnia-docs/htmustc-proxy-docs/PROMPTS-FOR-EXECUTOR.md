# PROMPT BÀN GIAO — htmustc-proxy upgrade

> Dùng với Opus 4.8 (hoặc phiên Claude Code mới bất kỳ).
> **Cách dùng:** mở phiên mới tại thư mục repo → paste khối **BOOTSTRAP** một lần → sau đó paste từng khối **TASK** theo thứ tự.
> Prompt task cố ý ngắn: mọi chi tiết đã nằm trong `docs/PLAN-UPGRADE-2026-09.md` trong repo.

---

## 🔑 BOOTSTRAP — paste một lần ở đầu phiên

```
Bạn đang làm việc trên repo tại G:\AI\API Proxy AI — một AI API proxy/reseller platform
đang CHẠY PRODUCTION THẬT với user thật (VPS 160.30.20.49, 8 container Docker).

Service bạn sẽ sửa: services/htmustc-proxy (Go 1.26, Gin).

ĐỌC BẮT BUỘC TRƯỚC KHI LÀM BẤT CỨ VIỆC GÌ (đọc hết, đừng skim):
1. CLAUDE.md ở gốc repo — có 2 mục sống còn: Kiro account pool nằm TRONG htmustc-proxy,
   và cơ chế "Empty/malformed HTTP 200 → 429 fallback".
2. services/htmustc-proxy/docs/PLAN-UPGRADE-2026-09.md — kế hoạch 6 phase / 35 task.
   Đây là spec của bạn. Mục 0.4 GUARDRAIL là những thứ TUYỆT ĐỐI không được làm.

BỐI CẢNH KỸ THUẬT:
- htmustc-proxy đã require github.com/router-for-me/CLIProxyAPI/v7 v7.0.0 nhưng mới chỉ
  dùng sdk/translator. services/cliproxy trong repo là bản vendored để ĐỌC THAM CHIẾU,
  không có replace trỏ vào nó. Học pattern từ đó rồi viết code Go trong htmustc-proxy.
- Repo được index bởi GitNexus. Trước khi sửa BẤT KỲ symbol nào, chạy
  gitnexus_impact({target: "tênSymbol", direction: "upstream"}) và báo blast radius.
  Nếu HIGH/CRITICAL thì DỪNG và hỏi tôi trước.

QUY TẮC LÀM VIỆC:
- Mỗi task = 1 commit riêng, revert độc lập được. Không gộp task.
- KHÔNG refactor ngoài phạm vi task. Thấy chỗ khác đáng sửa thì ghi lại, đừng tự sửa.
- KHÔNG deploy production. Deploy là việc của tôi, làm riêng.
- KHÔNG sửa docker-compose.yml / .env.docker của production. Cần đổi thì đề xuất diff
  trong phần mô tả, tôi tự áp dụng.
- Viết test TRƯỚC hoặc CÙNG lúc với code, không để sau.

ĐỊNH NGHĨA XONG (mọi task đều phải đạt):
1. go build ./... xanh
2. go test -race ./internal/... xanh (áp dụng sau khi T0.2 xong)
3. Golden test của T0.3 không đổi kết quả, trừ khi task cố ý đổi hành vi (phải ghi rõ)
4. Đã chạy gitnexus_impact, blast radius nằm trong commit message
5. Đã chạy gitnexus_detect_changes() trước khi commit
6. Commit message dạng:
   <TaskID>: <mô tả ngắn>

   Blast radius: <tóm tắt từ gitnexus_impact>

   Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

Xác nhận bạn đã đọc xong 2 file trên và tóm tắt lại GUARDRAIL trong 1 đoạn ngắn,
rồi dừng chờ tôi giao task đầu tiên.
```

---

## PHASE 0 — bắt buộc làm trước

### T0.1 · Vá auth bypass (P0, làm ngay)

```
Thực hiện T0.1 trong docs/PLAN-UPGRADE-2026-09.md.

Bổ sung ngoài plan: lỗ này ĐÃ ĐƯỢC XÁC MINH TRÊN PRODUCTION ngày 2026-09-10 bằng probe
không phá hoại qua https://vip.htmustc.id.vn — hai route POST /codexweb/login/cookies và
/codexweb/login/save trả 400 từ thân handler thay vì 401 từ middleware, tức là đã chạy qua
auth. Route anh em POST /codexweb/login (không có dấu / cuối) vẫn trả 401 đúng.

Trước khi sửa, đọc cả internal/api/routes_mgmt.go để thấy 4 route GET đăng ký NGOÀI group
(dòng 9-12) và các route POST đăng ký TRONG group có ManagementAuth (dòng 159-161).

Sau khi sửa, chạy management_auth_test.go và cho tôi xem diff + kết quả test.
```

### T0.2 · Gỡ chặn `-race`

```
Thực hiện T0.2 trong docs/PLAN-UPGRADE-2026-09.md.

Đây là task CHẶN cả Phase 2, làm cẩn thận.

Trước khi sửa: chạy `grep -rn "ResetAccountManagerForTest" --include="*.go" internal` để
thấy hết 18 call site, và đọc internal/proxy/scheduler.go:198-231.

Yêu cầu thêm: sau khi xong, chạy `go test -race ./internal/... -count=3` và dán output.
Nếu còn flake, báo tôi trước khi commit — đừng che bằng cách skip test.
```

### T0.3 · Golden test đường request lõi

```
Thực hiện T0.3 trong docs/PLAN-UPGRADE-2026-09.md.

Đây là LƯỚI AN TOÀN cho toàn bộ Phase 2, nên chất lượng test quan trọng hơn tốc độ.

Yêu cầu: test phải PASS trên code hiện tại mà KHÔNG sửa một dòng production code nào.
Nếu phát hiện hành vi hiện tại có vẻ sai, ĐỪNG sửa — ghi vào comment của test là
"hành vi hiện tại, chưa khẳng định đúng" và báo tôi.

Golden data lưu dạng file testdata/*.json để diff dễ đọc khi Phase 2 làm vỡ.
```

---

## PHASE 1 — sửa lỗi đã xác minh

> T1.1 và T1.9 nên làm cùng nhau (dùng chung singleflight). T1.2/T1.3/T1.4 cùng vùng storage/registry.

### T1.1 + T1.9 · Chống đua refresh token

```
Thực hiện T1.1 và T1.9 trong docs/PLAN-UPGRADE-2026-09.md — làm chung một đợt vì cả hai
đều cần singleflight, nhưng vẫn tách thành 2 commit.

Đọc trước:
- internal/proxy/oauth.go (toàn bộ hàm RefreshOAuthToken)
- internal/grok2api/models.go quanh dòng 159
- Tham chiếu: services/cliproxy/sdk/cliproxy/auth/conductor_refresh.go, xem hàm
  markRefreshPending ở dòng 322 và cách nó dedup theo authID.

Test bắt buộc: 50 goroutine đồng thời trên cùng 1 account, dùng httptest đếm số lần POST
tới token endpoint. Phải đúng bằng 1. Chạy với -race.
```

### T1.2 + T1.3 + T1.4 · Storage atomic + version + registry snapshot

```
Thực hiện T1.2, T1.3, T1.4 trong docs/PLAN-UPGRADE-2026-09.md — 3 commit riêng, theo đúng
thứ tự đó (T1.3 dựa trên T1.2, T1.4 độc lập nhưng cùng vùng).

Đọc trước:
- internal/storage/file_storage.go — 7 chỗ os.WriteFile ở dòng 430, 471, 513, 602, 1078,
  1239, 1361
- Tham chiếu atomic write: services/cliproxy/internal/store/objectstore.go dòng 213-217,
  và services/cliproxy/internal/pluginstore/install.go dòng 519

Lưu ý T1.3: Version phải tương thích ngược — file account cũ không có trường này, đọc lên
là 0 và PHẢI được chấp nhận. Đừng làm hỏng account đang chạy production.
```

### T1.5 + T1.6 · Stream error handling

```
Thực hiện T1.5 và T1.6 trong docs/PLAN-UPGRADE-2026-09.md — 2 commit riêng.

Đây là 2 bug làm account HỎNG vẫn bị đánh dấu healthy, nên hậu quả là routing tiếp vào
upstream đã chết.

T1.5: internal/api/handler/v1_raw.go quanh dòng 972.
T1.6: internal/codexweb/forward.go quanh dòng 111.

Test bắt buộc cho T1.5: chạy 100 lần, phải phân loại là lỗi cả 100 lần (đây là bug đua,
chạy 1 lần không chứng minh được gì).

Đọc thêm mục "Empty/malformed HTTP 200 → 429 fallback" trong CLAUDE.md — cùng họ triệu chứng.
```

### T1.7 + T1.10 + T1.11 + T1.12 + T1.13 · Nhóm nhỏ còn lại

```
Thực hiện T1.7, T1.10, T1.11, T1.12, T1.13 trong docs/PLAN-UPGRADE-2026-09.md.
Mỗi task 1 commit. Đây là các fix nhỏ, độc lập nhau.

Lưu ý T1.7: KHÔNG tự sửa docker-compose.yml. Chỉ sửa code Go để đọc TRUST_PROXY, rồi đưa
tôi diff compose cần thiết trong phần mô tả.

Lưu ý T1.11: gộp helper loopback server này với T3.1 sau, nên viết sao cho tái dùng được —
đặt ở package chung, đừng nhét trong mgmt_oauth_loopback.go.
```

---

## PHASE 2 — kiến trúc lõi (chỉ bắt đầu khi T0.2 + T0.3 đã xong)

### T2.1 → T2.5 · Nền kiến trúc

```
Thực hiện T2.1 đến T2.5 trong docs/PLAN-UPGRADE-2026-09.md, theo đúng thứ tự, mỗi task 1 commit.

ĐIỀU KIỆN VÀO: xác nhận T0.2 (go test -race chạy sạch) và T0.3 (golden test) đã xong.
Nếu chưa, DỪNG và báo tôi.

Đọc tham chiếu cliproxy trước khi viết:
- T2.1: sdk/cliproxy/auth/conductor.go dòng 16 (interface ProviderExecutor)
- T2.2: sdk/cliproxy/auth/classification.go, error_events.go
- T2.3: sdk/cliproxy/auth/cooldown_state.go, cooldown_fingerprint.go, cooldown_backoff_test.go
- T2.4: sdk/cliproxy/auth/conductor_execution.go dòng 275 (executeMixedOnce)
- T2.5: sdk/cliproxy/auth/auto_refresh_loop.go

NGUYÊN TẮC SỐNG CÒN cho T2.1: adapter-first. Bọc đường xử lý HIỆN CÓ thành genericExecutor,
KHÔNG tách provider nào trong task này. Golden test T0.3 phải xanh y nguyên — nếu nó đổi
kết quả nghĩa là bạn đã đổi hành vi, phải dừng lại.

T2.3 và T2.5 dùng fake clock, cấm dùng time.Sleep trong test.
```

### T2.6 · Tách executor từng provider

```
Thực hiện T2.6 trong docs/PLAN-UPGRADE-2026-09.md.

Làm TỪNG PROVIDER MỘT, mỗi provider 1 commit, theo thứ tự trong plan:
openai-compat → claude → gemini → codex → antigravity → grok → genspark

Sau MỖI provider: chạy golden test T0.3 + go test -race, rồi DỪNG báo tôi kết quả trước
khi sang provider tiếp theo. Đừng làm liền 7 cái rồi mới báo.

Nếu một provider cần hơn 400 dòng adapter → DỪNG, báo tôi, đừng ép.
```

---

## PHASE 3 — OAuth hardening

```
Thực hiện T3.1, T3.2, T3.3 trong docs/PLAN-UPGRADE-2026-09.md. Mỗi task 1 commit.

ĐIỀU KIỆN VÀO: T1.1 đã xong (singleflight refresh).

CẢNH BÁO QUAN TRỌNG: htmustc-proxy làm OAuth theo kiểu DECLARATIVE trong
internal/providers/data/providers.json — 8 flow shape, xem internal/providers/types.go
dòng 459-508. Cách này TỔNG QUÁT HƠN cliproxy (vốn viết Go thủ công từng provider).
TUYỆT ĐỐI KHÔNG thay mô hình declarative bằng Go per-provider. Chỉ hardening.

T3.2: field mới phải thêm vào OAuthConfig trong JSON, không hard-code tên provider trong Go.

Đọc tham chiếu: services/cliproxy/internal/auth/codex/{pkce.go,oauth_server.go,jwt_parser.go}
và internal/auth/claude/{pkce.go,oauth_server.go}
```

---

## PHASE 4 — Catalogue updater

```
Thực hiện T4.1, T4.2, T4.3 trong docs/PLAN-UPGRADE-2026-09.md. Mỗi task 1 commit.

ĐỌC KỸ TRƯỚC: internal/api/handler/models_autofetch.go ĐÃ TỒN TẠI và đã làm auto-fetch
model theo account (opt-in/provider, ticker 3h, cap 25/pass). KHÔNG viết lại nó.
Phase này chỉ bổ sung mảnh còn thiếu: updater cho catalogue TĨNH data/providers.json.

Tham chiếu: services/cliproxy/internal/registry/model_updater.go — đọc cả file, đặc biệt
detectChangedProviders (dòng ~190) và cách nó GIỮ NGUYÊN dữ liệu cũ khi fetch lỗi.

RỦI RO CAO ở T4.1: validate lỏng là catalogue sai → chết routing production.
Viết validateProvidersCatalog() và test của nó TRƯỚC, code fetch sau.
Mặc định URL nguồn để RỖNG (tắt) — opt-in, không tự bật.
```

---

## PHASE 5 — UI (chạy song song được với Phase 2–4)

### T5.1 → T5.3 · Hạ tầng + tách CSS/i18n

```
Thực hiện T5.1, T5.2, T5.3 trong docs/PLAN-UPGRADE-2026-09.md. Mỗi task 1 commit.

RÀNG BUỘC CỨNG: KHÔNG bundler, KHÔNG Node trong image Go. Dùng ES modules gốc +
//go:embed thư mục. go build phải là bước build duy nhất. Nếu bạn thấy cần Vite/webpack
để làm được thì DỪNG và báo tôi — nghĩa là hướng đã sai.

File: internal/api/dashboard/static/management.html (10.422 dòng)
- CSS ở dòng 24-1374
- i18n inline trong JS khoảng dòng 1451-3400

T5.1 là commit HẠ TẦNG: chỉ đổi cách serve, CHƯA tách code. Trang phải tải y hệt.
T5.2: không đổi một selector CSS nào. Chụp màn hình trước/sau cả light + dark, đủ 15 trang.
T5.3: thêm script kiểm key parity vi/en, thiếu key phải làm CI đỏ.
```

### T5.4 + T5.5 · Tách module + diệt innerHTML

```
Thực hiện T5.4 và T5.5 trong docs/PLAN-UPGRADE-2026-09.md.

T5.4: MỘT TRANG MỘT COMMIT. Thứ tự: core/* trước → proxies, console (đơn giản nhất) →
... → accounts, providers (phức tạp nhất, làm cuối).
Sau mỗi trang, mở trang đó xác nhận chạy y hệt rồi mới sang trang kế.

T5.5: hiện có 122 chỗ gán innerHTML. Ưu tiên các chỗ render DỮ LIỆU TỪ UPSTREAM trước
(tên model, thông báo lỗi provider, tên account) — đó là bề mặt XSS thật.
Test nghiệm thu: tên model chứa <img src=x onerror=alert(1)> phải hiện nguyên văn.
```

### T5.6 + T5.7

```
Thực hiện T5.6 rồi T5.7 trong docs/PLAN-UPGRADE-2026-09.md.

T5.6: dùng node --test thuần cho logic thuần (format, i18n, state, dựng URL của api.js).
Không cần jsdom cho các phần này. CI phải chạy được không cần trình duyệt.

T5.7 chỉ làm SAU khi T5.4 xong. Trước khi code, liệt kê đề xuất UX cho tôi chốt.
```

---

## Mẫu prompt cho task lẻ bất kỳ

```
Thực hiện <TaskID> trong services/htmustc-proxy/docs/PLAN-UPGRADE-2026-09.md.

Trước khi sửa: chạy gitnexus_impact trên các symbol sẽ đụng và báo blast radius.
Sau khi xong: cho tôi diff + kết quả go build và go test -race.
Đừng commit cho tới khi tôi duyệt diff.
```
