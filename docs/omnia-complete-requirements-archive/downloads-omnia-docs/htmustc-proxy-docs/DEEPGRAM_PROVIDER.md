# Deepgram provider (STT + TTS Aura + quota credit)

Provider `deepgram` (alias `dg`) gọi toàn bộ model của Deepgram qua API tương thích OpenAI:

- **STT**: `/v1/audio/transcriptions` → Deepgram `/v1/listen` (Nova 3/2/1, Enhanced, Base, Whisper).
- **TTS**: `/v1/audio/speech` → Deepgram `/v1/speak` (102 giọng Aura 2 / Aura 1, 7 ngôn ngữ).
- **Quota**: trang Quota hiện **số dư credit (USD)** của từng tài khoản.
- **Thêm tài khoản bằng API key** trên dashboard (Deepgram trước đây bị ẩn khỏi trang Providers).

Tài liệu gồm hai phần: **A. Cách hoạt động** (dùng/vận hành), **B. Hướng dẫn chuyển sang dự án chính**
(`G:\AI\API Proxy AI\services\htmustc-proxy`). Bản tham chiếu đã chạy và test xong nằm ở `G:\AI\htmustc-proxy`.

---

## A. Cách hoạt động

### Xác thực
Header `Authorization: Token <API_KEY>`. Deepgram **không** nhận API key dưới `Bearer` (Bearer chỉ dành cho JWT
tạm của `/v1/auth/grant`) → trả 401. Proxy thêm scheme auth mới `token` cho việc này.

Quyền của key theo role (tạo tại console.deepgram.com → API Keys):

| Việc | Member | Admin / Owner |
|---|---|---|
| Gọi STT / TTS, liệt kê `/v1/models` | ✅ | ✅ |
| Đọc số dư credit (`billing:read`) | ❌ (403) | ✅ |

Key role thấp vẫn chạy STT/TTS bình thường; card Quota chỉ hiện lời giải thích thay vì số dư.

### Model
152 model trong catalogue, ID gọi thẳng không cần `"provider"`:

| Nhóm | Ví dụ ID | Ghi chú |
|---|---|---|
| STT tên ngắn (6) | `nova-3`, `nova-2`, `nova`, `enhanced`, `base`, `whisper` | Deepgram tự chọn bản `-general` |
| STT đầy đủ (42) | `nova-3-medical`, `nova-2-phonecall`, `enhanced-meeting`, `whisper-large` | chỉ bản batch |
| TTS họ (2) | `aura-2`, `aura` | giọng lấy từ trường `voice` |
| TTS giọng (102) | `aura-2-thalia-en`, `aura-2-agathe-fr`, `aura-2-ama-ja`, `aura-asteria-en` | **ID model = giọng** |

Danh sách sinh tự động từ `GET /v1/models` bằng `scripts/gen_deepgram_models.py` → `builtin_deepgram_models.go`.
Deepgram ra giọng mới thì chạy lại:
```bash
DEEPGRAM_API_KEY=... python scripts/gen_deepgram_models.py
gofmt -w internal/providers/builtin_deepgram_models.go
```
Nút "Fetch models" trên dashboard cũng đọc được `/v1/models` (fetcher type `deepgram`).

### Biến thể STT — trường `variant` (một model cho mỗi họ)
Deepgram công bố mỗi bản theo lĩnh vực/kích cỡ thành một tên model riêng (`nova-2-phonecall`, `enhanced-meeting`,
`whisper-large`) nhưng **tính giá theo họ**. Vì vậy gọi bằng **tên họ** + trường form `variant`, y như TTS chọn giọng
bằng `voice`:

| Họ (`model`) | `variant` hợp lệ (để trống = general) |
|---|---|
| `nova-3` | general, medical, pharma |
| `nova-2` | atc, automotive, conversationalai, drivethru, ea, finance, general, medical, meeting, phonecall, video, voicemail |
| `nova` (hoặc `nova-1`) | drivethru, general, medical, phonecall, voicemail |
| `enhanced` | automotive, drivethru, finance, general, meeting, phonecall |
| `base` | conversationalai, finance, general, meeting, phonecall, phoneme, video, voicemail |
| `whisper` | tiny, base, small, medium, large |

- Cách viết được chuẩn hoá: `Phone Call`, `phone-call`, `phone_call` → `phonecall`. Tên đầy đủ trong `model`
  (`nova-2-phonecall`) vẫn chạy.
- Biến thể **không có trong họ** → **400** kèm danh sách biến thể đúng, trả **trước khi gửi audio** (không tính tiền,
  không đổi account, không phạt credential). Không bao giờ âm thầm rơi về model general.
- `model` đã là tên đầy đủ mà `variant` lại chỉ biến thể khác → 400 (mâu thuẫn, không đoán).
- Bảng họ/biến thể **dựng từ danh sách sinh tự động** (`providers/deepgram_stt_variants.go`), nên chạy lại
  `gen_deepgram_models.py` là biến thể mới tự có. Loại trừ fixture test của Deepgram (`*-dQw4w9WgXcQ`) và
  `general-polaris` (tên khác của enhanced-general).
- Gateway chép mọi field của form xuống upstream (trừ `model`), nên `variant` đi xuyên qua web mà không cần sửa gateway.

```bash
curl -XPOST .../v1/audio/transcriptions -F model=nova-2 -F variant=phonecall -F file=@call.mp3
# SDK OpenAI (Python): client.audio.transcriptions.create(model="nova-2", file=f, extra_body={"variant": "medical"})
```

### Gọi (OpenAI-compatible)
```bash
# TTS — kiểu OpenAI: họ + voice (voice OpenAI được map sang Aura)
curl -XPOST .../v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"aura-2","voice":"alloy","input":"Xin chào"}' -o out.mp3
# TTS — chỉ định thẳng giọng, wav, nhanh hơn
curl -XPOST .../v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"aura-2-helena-en","input":"Hello","response_format":"wav","speed":1.2}' -o out.wav
# STT
curl -XPOST .../v1/audio/transcriptions -F model=nova-3 -F language=en -F file=@clip.mp3
curl -XPOST .../v1/audio/transcriptions -F model=nova-3 -F response_format=srt -F file=@clip.mp3
```

Quy tắc chọn model TTS (`deepgramTTSModel`):
1. `model` hoặc `voice` là ID đủ (`aura-2-xxx-en`, `aura-xxx-en`) → dùng nguyên.
2. `model` là `aura-2`, rỗng, hoặc tên OpenAI (`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`) → họ Aura 2; `aura`/`aura-1` → Aura 1.
3. `voice` là tên OpenAI → map sang giọng cùng giới tính (bảng dưới); tên trần như `thalia` → thêm `-en`;
   `celeste-es` giữ nguyên. Không có voice → `thalia` (Aura 2) / `asteria` (Aura 1).
4. Model lạ khác → chuyển nguyên cho Deepgram tự xét.

| OpenAI | alloy | ash | ballad | coral | echo | fable | nova | onyx | sage | shimmer | verse |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Aura 2 | thalia | arcas | orpheus | cora | apollo | draco | luna | zeus | athena | aurora | orion |
| Aura 1 | asteria | arcas | orpheus | hera | orion | helios | luna | zeus | athena | stella | perseus |

Định dạng (`response_format` → query của Deepgram):

| response_format | Deepgram | Ghi chú |
|---|---|---|
| `mp3` (mặc định) | `encoding=mp3` | |
| `wav` | `linear16`, `container=none`, 24 kHz | proxy tự gắn header RIFF |
| `pcm` | `linear16`, `container=none`, 24 kHz | đúng chuẩn pcm của OpenAI |
| `aac` | `encoding=aac` | |
| `mulaw` / `ulaw` | `mulaw`, `container=none`, 8 kHz | |
| `opus` / `ogg`, `flac` | `encoding=opus` / `flac` | **không ghép được**, xem dưới |

- **speed**: chỉ Aura 2, kẹp trong 0.7–1.5. Aura 1 báo lỗi 400 nếu nhận `speed` nên proxy bỏ đi; `speed: 1` cũng không gửi.
- **Input dài**: Deepgram nhận tối đa **2000 ký tự** mỗi request (đếm theo ký tự, không phải byte). Proxy cắt theo câu
  (không cắt `3.14`; nhận dấu câu CJK), gọi **song song tối đa 4 đoạn**, ghép audio theo đúng thứ tự.
  4800 ký tự: 106 s (tuần tự) → 74 s (song song). Riêng opus/flac chỉ có một header cho cả file nên input dài
  bị từ chối ngay (400) trước khi tốn tiền.

### Xử lý lỗi (quan trọng cho pool account)
- **Model/giọng sai**: Deepgram trả `403 INSUFFICIENT_PERMISSIONS "Project does not have access to the requested model"`.
  Mặc định proxy coi 403 là key hỏng và **khoá cả account đến khi reset tay**. `deepgramError` đổi thành 404, nên
  scheduler chỉ khoá đúng model đó; client nhận 404. Các 403 khác (thiếu scope) vẫn là lỗi xác thực.
- **Transcript rỗng** (audio im lặng hoặc container không giải mã được): lỗi `ErrEmptyTranscript` (bọc
  `ErrInvalidMediaRequest`) → client nhận 400 kèm lời giải thích, **account không bị cooldown**. Nút "Test model" STT
  gửi 0.25 s im lặng, nên trường hợp này được tính là pass.
- **Override `base_url` trên account** (EU: `https://api.eu.deepgram.com`, self-host): `deepgramRoute` coi host hoặc
  `/v1` là gốc rồi nối `/v1/listen`, `/v1/speak`, `/v1/projects`; URL có `/listen`|`/speak`|`/read` thì đổi đoạn cuối.
  Một override dùng chung cho STT, TTS và quota.

### Quota (số dư credit)
`GET /v1/projects` → `GET /v1/projects/{id}/balances` → `{"balances":[{"balance_id","amount","units","purchase_order_id"}]}`.
- Cộng các balance cùng đơn vị thành **một dòng** `balance` với `unit: "USD"`; dashboard hiện "Credit còn lại **187,42 US$**".
- Không có balance nào → hiện $0 (thanh đỏ).
- Key thiếu quyền `billing:read`/`project:read` (403) → snapshot kèm message hướng dẫn tạo key Admin/Owner. **Không trả lỗi**,
  để card không hiện "đăng nhập lại" và account không bị ghi lỗi 403.
- 401 (key sai) → lỗi xác thực bình thường (card "cần đăng nhập lại").
- Deepgram không công bố số credit ban đầu, nên `total = remaining` khi còn tiền. Số dư dương xoá dấu "hết quota" cũ;
  số dư $0 **không** tự khoá account (có thể còn thẻ thanh toán sau).

### Thêm tài khoản
Dashboard → **Providers** → section **"Provider giọng nói & media (TTS/STT/ảnh/video)"** → Deepgram → **Thêm API key**.
Form có ô **API key** riêng ở đầu; ô ID có thể để trống. Hoặc qua API:
```bash
curl -XPOST .../api/management/accounts -H 'content-type: application/json' \
  -d '{"provider":"deepgram","type":"api","credentials":{"api_key":"<KEY>"},"weight":1}'
```
Server từ chối (400) tài khoản mới **không có credential nào**, trừ provider `no_auth` như Ollama. Trước đây dán key
nhầm vào ô ID sẽ tạo ra một account tên là chính key và không có credential.

---

## B. Chuyển sang dự án chính

Đích: `G:\AI\API Proxy AI\services\htmustc-proxy`. Đã đối chiếu ngày 2026-09-24: mọi hàm và điểm neo bên dưới đều có
bên đó và đang ở trạng thái gốc (chưa có phần Deepgram). **Nhưng nhiều file đã lệch với bản tham chiếu**
(`upstream_error.go` khác 737 dòng, `page-providers.js` khác 343 dòng…), vì vậy:

- **File mới → copy nguyên** (tự đứng được, chỉ dùng hàm đã có sẵn).
- **File sửa → sửa theo từng điểm dưới đây, KHÔNG copy đè** (sẽ mất code riêng của dự án chính,
  vd. `idTranhVaChamProvider` trong `CreateAccount`).

**Đã kiểm chứng (2026-09-24)**: làm đúng B1–B13 trên một bản sao của service chính thì `go vet ./...`,
`go test ./...` (26 test Deepgram) và `node scripts/check-dashboard.mjs` đều pass. Chạy thử script bên dưới trên
dự án chính thật (chỉ đọc) cho kết quả: 9 file mới, 17 file sửa, không điểm neo nào lệch.

**Cách nhanh (tuỳ chọn)**: `scripts/port_deepgram.py` (chạy từ repo tham chiếu này) làm đúng B1–B13. Mặc định chỉ
chạy thử. Script chỉ ghi khi **mọi** điểm neo đều khớp, nếu có một điểm không khớp thì dừng và không sửa gì.
Chạy lại lần hai cũng an toàn (điểm nào đã áp dụng thì bỏ qua).
```bash
cd /g/AI/htmustc-proxy
python scripts/port_deepgram.py            # chạy thử trên dự án chính (chỉ đọc)
python scripts/port_deepgram.py --apply    # ghi thật — chạy gitnexus_impact trước
```
Nếu chạy thử báo lỗi ở điểm nào (do dự án chính đã đổi), làm tay điểm đó theo mục tương ứng bên dưới.

> Dự án chính dùng GitNexus (`CLAUDE.md`): chạy `gitnexus_impact` trước khi sửa mỗi symbol và
> `gitnexus_detect_changes()` trước khi commit. Các symbol bị sửa: `registerAllProviders`, `applyAuthScheme`,
> `knownAuthSchemes`, `normalizeAuthCredentials`, `TextToSpeech`, `callDeepgramSTT`, `modelUnavailableKeywords`,
> `modelEntitlementKeywords`, `parseModelList`, `QuotaWindow`, `QuotaSupported`, `FetchAccountQuota`,
> `probeModelOnce`, `CreateAccount`. Rủi ro thấp: toàn bộ là nhánh mới cho `deepgram`, trừ 3 thay đổi chung:
> scheme `token`, keyword 403-model và chặn account không credential.

Số dòng ghi bên dưới là vị trí **trong dự án chính** lúc đối chiếu (chỉ để tham khảo, hãy tìm theo nội dung).

### B1. Copy file mới
```bash
SRC=/g/AI/htmustc-proxy
DST="/g/AI/API Proxy AI/services/htmustc-proxy"
for f in \
  internal/providers/builtin_deepgram.go \
  internal/providers/builtin_deepgram_models.go \
  internal/providers/builtin_deepgram_test.go \
  internal/proxy/audio_tts_deepgram.go \
  internal/proxy/audio_tts_deepgram_test.go \
  internal/proxy/deepgram_quota.go \
  internal/proxy/deepgram_quota_test.go \
  scripts/gen_deepgram_models.py \
  docs/DEEPGRAM_PROVIDER.md
do cp "$SRC/$f" "$DST/$f"; done
```

| File | Nội dung |
|---|---|
| `providers/builtin_deepgram.go` | `DeepgramProvider()`: transport auth `token`, `STTConfig`/`TTSConfig` format `deepgram`, `ModelsFetcher` type `deepgram`, 6 tên STT ngắn + 2 họ Aura |
| `providers/builtin_deepgram_models.go` | **sinh tự động**: `deepgramSTTModels` (42), `deepgramTTSModels` (102) |
| `proxy/audio_tts_deepgram.go` | `callDeepgramTTS`, `deepgramTTSModel`, bảng voice, `splitTTSText`/`ttsSeam`, `deepgramSpeakPieces` (song song), `deepgramRoute`, `deepgramError` |
| `proxy/deepgram_quota.go` | `fetchDeepgramQuota`, `deepgramGetJSON`, `deepgramScopeMessage` |
| `scripts/gen_deepgram_models.py` | generator danh sách model |

### B2. `internal/providers/registry.go` (~dòng 493)
Trong `registerAllProviders`, ngay sau `r.Register(HuggingFaceProvider())`:
```go
	r.Register(DeepgramProvider())
```

### B3. `internal/proxy/router.go` — `applyAuthScheme` (~dòng 597)
Thêm case trước `case "raw", "":`
```go
	case "token":
		// Deepgram: an API key rides "Token", and the same key under Bearer is
		// a 401 — Bearer is reserved for the JWTs its /v1/auth/grant issues.
		return "Token " + value
```

### B4. `internal/proxy/account_validate.go`
- `knownAuthSchemes` (~dòng 60): `"bearer": {}, "key": {}, "token": {}, "raw": {}, "": {},`
- Thông báo lỗi (~dòng 306): `(want bearer, key or raw)` → `(want bearer, key, token or raw)`

### B5. `internal/proxy/audio.go`
Sau `var ErrUnsupportedFormat = ...`:
```go
// ErrEmptyTranscript is a transcription that came back 200 with no text. The
// upstream took the key and read the audio, so it is the request's problem —
// silence, or a container the provider could not decode — and wraps
// ErrInvalidMediaRequest: the caller gets a 400 saying so, and the account is
// not benched for it. The dashboard's probe sends silence on purpose and counts
// this as the pass it is.
var ErrEmptyTranscript = fmt.Errorf("%w: empty transcript", ErrInvalidMediaRequest)
```
Trong `TextToSpeech`, sau nhánh `case "elevenlabs":` (~dòng 118):
```go
	case "deepgram":
		return r.callDeepgramTTS(ctx, account, provider, raw, request)
```

### B6. `internal/proxy/audio_stt_providers.go` — `callDeepgramSTT` (~dòng 35)
```go
	// cũ
	endpoint := httpEndpoint(raw, "https://api.deepgram.com/v1/listen")
	// mới
	endpoint := deepgramRoute(raw, "listen")
```
```go
	// Khối r.postMedia(ctx, account, "deepgram", ...) có header "Authorization": "Token " + key
	// (~dòng 66–72). Chú ý: đoạn `}, upload.audio) / if err != nil { return nil, err }` xuất hiện
	// 2 lần trong file, chỉ sửa khối của Deepgram. Cũ `return nil, err` → mới:
	if err != nil {
		return nil, deepgramError(err)
	}
```
```go
	// ~dòng 114: cũ
	return nil, fmt.Errorf("deepgram returned an empty transcript — the audio may be silent or in a container it could not decode (%s)", upload.mimeType())
	// mới
	return nil, fmt.Errorf("%w — deepgram heard no speech; the audio may be silent or in a container it could not decode (%s)", ErrEmptyTranscript, upload.mimeType())
```

### B7. `internal/proxy/upstream_error.go` (~dòng 252 và 287)
Trong **cả hai** danh sách `modelUnavailableKeywords` và `modelEntitlementKeywords`, ngay sau dòng
`"model does not exist", "does not have access to model",` thêm:
```go
	"does not have access to the requested model",
```

### B8. `internal/proxy/models_fetch.go` — `parseModelList` (~dòng 207)
Sau khối `if fetcherType == "mimo-free" || looksLikeModelsDev(root) {...}`:
```go
	if fetcherType == "deepgram" {
		return parseDeepgramModels(root)
	}
```
Thêm hàm (đặt ngay sau `parseModelList`):
```go
// parseDeepgramModels reads Deepgram's /v1/models, which files models by
// direction — {"stt":[…],"tts":[…]} — with one entry per version and language,
// so the same canonical name recurs. The canonical name is what /v1/listen and
// /v1/speak take as the model. An STT entry marked batch:false is the streaming
// build of a model, reachable only over the websocket this proxy does not speak;
// its batch twin is listed separately and is the one kept.
func parseDeepgramModels(root gjson.Result) []FetchedModel {
	seen := make(map[string]bool)
	out := make([]FetchedModel, 0, 160)
	add := func(id, name, kind string) {
		id = strings.TrimSpace(id)
		if id == "" || seen[strings.ToLower(id)] {
			return
		}
		seen[strings.ToLower(id)] = true
		out = append(out, FetchedModel{ID: id, Name: name, Kind: kind})
	}
	root.Get("stt").ForEach(func(_, item gjson.Result) bool {
		if batch := item.Get("batch"); batch.Exists() && !batch.Bool() {
			return true
		}
		add(item.Get("canonical_name").String(), "", "stt")
		return true
	})
	root.Get("tts").ForEach(func(_, item gjson.Result) bool {
		// "Aura 2 · Thalia (en)": the family, the voice as Deepgram names it, and
		// the language, which is the one thing the ID's suffix hides from a
		// reader who does not know "nl" is Dutch.
		name := item.Get("metadata.display_name").String()
		if family := strings.ReplaceAll(item.Get("architecture").String(), "-", " "); family != "" && name != "" {
			name = strings.ToUpper(family[:1]) + family[1:] + " · " + name
		}
		if lang := item.Get("languages.0").String(); lang != "" && name != "" {
			name += " (" + lang + ")"
		}
		add(item.Get("canonical_name").String(), name, "tts")
		return true
	})
	return out
}
```

### B9. `internal/proxy/quota.go`
1. `QuotaWindow` (~dòng 22) — thêm trường cuối:
```go
	// Unit names the currency a money balance is in ("USD"), so the dashboard
	// renders "$187.42" rather than a bare 187.42 that reads like a request
	// count. Empty for every counter-shaped row.
	Unit string `json:"unit,omitempty"`
```
2. `QuotaSupported` (~dòng 73) — sau khối `if provider.ID == "flow" { return true }`:
```go
	// Deepgram publishes a money balance per project, two hops away from the key
	// (see deepgram_quota.go) — nothing the single usage URL below can describe.
	if provider.ID == "deepgram" {
		return true
	}
```
3. `FetchAccountQuota` — sau khối `if account.Provider == "flow" { return r.fetchFlowQuota(ctx, account) }`:
```go
	if account.Provider == "deepgram" {
		snap, err := r.fetchDeepgramQuota(ctx, account)
		if err == nil {
			applyQuotaExhaustion(account, snap, time.Now())
		}
		return snap, err
	}
```
Chạy `gofmt -w internal/proxy/quota.go` sau khi sửa.

### B10. `internal/api/handler/mgmt_models.go` — `probeModelOnce`, nhánh `case "stt":` (~dòng 411)
Sau khối `testErr = h.callWithTokenRetry(... h.router.SpeechToText ...)`:
```go
		// A provider that reports silence as "no speech" instead of "" (Deepgram)
		// has answered the probe exactly as it should.
		if errors.Is(testErr, proxy.ErrEmptyTranscript) {
			testErr = nil
		}
```

### B11. `internal/api/handler/mgmt_accounts.go` — `CreateAccount` (~dòng 190)
Thêm import `"github.com/htmustc/proxy/internal/providers"`. Ngay **sau** khối `if err := proxy.NormalizeAccountCredentials(&account); err != nil {...}`
(trước `account.CreatedAt = time.Now()` và `idTranhVaChamProvider`):
```go
	// Normalization drops empty values, so a form sent with its api_key row left
	// blank arrives here with no credentials at all. Saved, that is an account
	// that fails every request with "no api_key credential" — and the usual cause
	// is the key pasted into the ID field instead, which then shows the secret as
	// the account's name on every page.
	if len(account.Credentials) == 0 {
		if p, err := providers.DefaultRegistry().Get(account.Provider); err == nil && !p.NoAuth {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "invalid account",
				"message": "tài khoản chưa có credential nào — dán API key vào ô API key (credential api_key), không phải ô ID",
			})
			return
		}
	}
```
Sửa comment phía trên `dropMaskedCredentials`: "…so they are dropped and the empty-credentials check below rejects the
account rather than saving a credential that cannot authenticate."

### B12. Dashboard — `internal/api/dashboard/static/assets/`

**`page-providers.js`**
- `SECTIONS` (~dòng 73), sau dòng `key: "apikey"`:
```js
    // Speech and media providers have no llm kind, so the two sections above — chat
    // providers only — never listed them: a TTS/STT provider such as Deepgram had no
    // card to open and so no way to add a key from this page.
    { key: "media",     title: t("prov.secMedia"),     cats: ["apikey", "freeTier"], mediaOnly: true },
```
- `inSection` (~dòng 85): sau `const isLlm = ...` thêm hai hằng, và dòng đầu tiên sau kiểm tra `cats`:
```js
  const MEDIA_KINDS = ["tts", "stt", "image", "video"];
  const isMedia = p => kinds(p).some(k => MEDIA_KINDS.includes(k));
  // … trong inSection, sau `if (!sec.cats.includes(p.category)) return false;`
    if (sec.mediaOnly) return !isLlm(p) && isMedia(p);
```
- `sorters` (~dòng 97): `media: (a, b) => (hasAcc(b) - hasAcc(a)) || byName(a, b),`
- Nút `#cta-apikey` (~dòng 1066): `{ tab: "form", provider: id }` → `{ tab: "form", provider: id, apiKey: true }`

> Lưu ý: section này cũng làm hiện ra các provider TTS/STT/ảnh/video khác trước đây bị ẩn
> (ElevenLabs, AssemblyAI, Cartesia, Play.ht, fal.ai, Stability, Edge TTS…). Provider web-search/embedding vẫn ẩn.

**`page-accounts.js`** — `openAccountModal`
- Sau `const apiKeyBulk = ...` (~dòng 917):
```js
  // "Add API key" from a provider page: the key gets a field of its own at the top
  // of the form. In the generic key/value editor it sat below the ID field, and a
  // key pasted into the ID box saved an account named after the secret, with no
  // credential at all.
  const apiKeyMode = isNew && opts.apiKey === true;
```
- `creds`/`credRows` (~dòng 930):
```js
  const creds = Object.entries(a.credentials || {}).filter(([k]) => !(apiKeyMode && k === "api_key"));
  const credRows = (creds.length ? creds : (apiKeyMode ? [] : [["api_key", ""]])).map(([k, v]) => `
```
- Đầu `formHTML`, trước `<div class="field-row">` chứa ô ID:
```js
    ${apiKeyMode ? `<div class="field"><label>${t("acc.apiKeyLabel")}</label>
      <input id="m-apikey" class="mono" autocomplete="off" spellcheck="false" placeholder="${esc(t("acc.apiKeyPh"))}">
      <p class="hint">${t("acc.apiKeyHint")}</p>
    </div>` : ""}
```
- Nhãn khối credentials (~dòng 964): `<label>Credentials</label>` → `<label>${apiKeyMode ? t("acc.moreCreds") : "Credentials"}</label>`
- Thay dòng `if (!Object.keys(credentials).length) { toast(t("acc.needCred"), "error"); return false; }` (~dòng 1064):
```js
    if (apiKeyMode) {
      const key = ($("#m-apikey")?.value || "").trim();
      if (!key) { toast(t("acc.needApiKey"), "error"); $("#m-apikey")?.focus(); return false; }
      credentials.api_key = key;
    }
    // A row with a key and no value is not a credential: the server drops empty
    // values, so counting rows let a blank api_key through as an account with none.
    const prov = (state.providers || []).find(p => p.id === provider);
    const filled = Object.values(credentials).some(v => String(v).trim());
    if (!filled && !(prov && prov.no_auth)) { toast(t("acc.needCred"), "error"); return false; }
```

**`page-usage.js`**
- Ngay trước `function quotaValueLabel` (~dòng 69):
```js
// quotaMoney renders a balance row in its currency: "$187.42", or "187,42 US$"
// in Vietnamese. A unit that is not an ISO currency code is written after the
// number rather than dropped, since the unit is the whole point of the row.
function quotaMoney(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const code = String(unit || "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return n.toLocaleString(currentLang() === "vi" ? "vi-VN" : "en-US", { style: "currency", currency: code, maximumFractionDigits: 2 });
    } catch (_) { /* unknown currency code — fall through to the plain form */ }
  }
  return quotaNumber(n) + " " + unit;
}
```
- Dòng đầu trong `quotaValueLabel`: `if (q.unit) return quotaMoney(q.remaining, q.unit);`
- Dòng đầu trong `quotaValueTitle`: ``if (q.unit) return `${quotaLabel(q.name)}: ${quotaMoney(q.remaining, q.unit)}`;``
- `quotaCardState` (~dòng 167):
```js
  // A money balance counts even at zero: $0 left is an answer, not a blank.
  const known = rows.filter(q => q?.unit || Number(q?.total) > 0 || Number(q?.remaining) > 0 || Number(q?.used) > 0);
```

**`i18n.js`** — thêm vào **cả hai** khối `vi` và `en`:

| Key (đặt cạnh) | vi | en |
|---|---|---|
| `quota.label.balance` (sau `quota.label.review_weekly`) | Credit còn lại | Credit balance |
| `prov.secMedia` (sau `prov.secNode`) | Provider giọng nói & media (TTS/STT/ảnh/video) | Voice & media providers (TTS/STT/image/video) |
| `acc.apiKeyLabel` (sau `acc.needCred`) | API key | API key |
| `acc.apiKeyPh` | Dán API key vào đây | Paste the API key here |
| `acc.apiKeyHint` | Ô ID tài khoản ở dưới có thể để trống — hệ thống tự đặt tên. Đừng dán key vào ô ID. | The account ID below can stay empty — one is generated. Do not paste the key into the ID field. |
| `acc.needApiKey` | Chưa nhập API key | Enter the API key |
| `acc.moreCreds` | Credential khác (tuỳ chọn) | Other credentials (optional) |

### B13. Sửa test sẵn có
- `internal/proxy/audio_stt_test.go`, `TestDeepgramSTTSendsAudioAsBodyAndRendersSubRip` (~dòng 200): đường dẫn mong đợi
  `"/?detect_language=..."` → `"/v1/listen?detect_language=true&keyterm=htmustc&model=nova-3&smart_format=true&utterances=true"`
  (host trần giờ được nối `/v1/listen`).
- Cùng file, `TestDeepgramSTTExplainsAnEmptyTranscript`: thêm import `"errors"` và cuối test:
```go
	// The key worked and the upstream answered: silence must not bench the account.
	if !errors.Is(err, ErrEmptyTranscript) || ShouldPunishAccount(err) {
		t.Errorf("error = %v, want a request-scoped ErrEmptyTranscript", err)
	}
```
- `internal/proxy/models_fetch_test.go`, `TestParseModelListShapes`: thêm case `"deepgram stt/tts split"`
  (copy từ bản tham chiếu).
- `internal/api/handler/mgmt_accounts_test.go`: thêm `TestCreateAccountRejectsAnAccountWithNoCredentials`
  (copy từ bản tham chiếu).

### B14. Kiểm tra
```bash
cd "/g/AI/API Proxy AI/services/htmustc-proxy"
# Chỉ kiểm tra các file đã đụng tới. Dự án chính vốn có sẵn vài file chưa gofmt (empty_sse.go, scheduler.go…)
gofmt -l internal/providers/builtin_deepgram*.go internal/proxy/audio_tts_deepgram*.go internal/proxy/deepgram_quota*.go \
  internal/proxy/quota.go internal/proxy/models_fetch.go internal/proxy/router.go internal/proxy/audio.go \
  internal/api/handler/mgmt_accounts.go internal/api/handler/mgmt_models.go
go vet ./... && go test ./...
node scripts/check-dashboard.mjs
```
Test riêng phần Deepgram:
```bash
go test ./internal/proxy/ ./internal/providers/ ./internal/api/handler/ -run 'Deepgram|SplitTTS|ParseModelList|CreateAccount' -v
```
Deploy (compose ở gốc dự án chính, service bind `127.0.0.1:20131`):
```bash
docker compose build htmustc-proxy
docker compose up -d htmustc-proxy
```
Thử nhanh sau deploy:
```bash
curl -XPOST http://127.0.0.1:20131/v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"aura-2","voice":"alloy","input":"Xin chào"}' -o out.mp3
curl -XPOST http://127.0.0.1:20131/v1/audio/transcriptions -F model=nova-3 -F file=@out.mp3
```
Dashboard: Providers → section media có Deepgram, 152 model; "Thêm API key" có ô API key; nút Test ở `aura-2` và
`nova-3` đều xanh; Quota hiện số dư (key Admin/Owner) hoặc lời nhắn thiếu quyền (key Member).

### B15. Ngoài phạm vi service này
- **Gateway chính** (`apps/gateway`) đã có route `/v1/audio/speech` và `/v1/audio/transcriptions`. Để bán model
  Deepgram cho khách, cần kiểm tra gateway route các model ID này tới router htmustc-proxy (cấu hình runtime DB) —
  **chưa kiểm tra**.
- Hai việc nên làm tiếp (không bắt buộc cho Deepgram):
  1. AssemblyAI / Gemini / HuggingFace STT vẫn trả lỗi thường khi transcript rỗng → audio im lặng làm account bị
     cooldown và nút Test luôn đỏ. Chuyển sang `ErrEmptyTranscript` giống Deepgram.
  2. `classifyFailureScope` xét `IsAuthFailure` trước `IsModelUnavailable`, nên với mọi provider, một 403 kiểu
     "model không được bật" đều khoá cả account. Deepgram đang né bằng `deepgramError`; nên sửa gốc cho tất cả.

### Tham khảo
- Roles & scopes: https://developers.deepgram.com/guides/deep-dives/working-with-roles
- Get Project Balances: https://developers.deepgram.com/reference/manage/billing/list
- Deepgram CLI: https://developers.deepgram.com/developer-tools/agentic-tools#deepgram-cli
