# Lấy cookie CapCut chuẩn để add account

Provider `capcut` xác thực bằng **cookie đăng nhập capcut.com Pro** (không phải API key).
Mọi request (TTS/sign, quota) và worker (image/video) đều dùng chuỗi cookie này.

## 1. Cookie cần những gì
Toàn bộ header `Cookie` gửi tới `capcut.com`, quan trọng nhất (nhiều cái **httpOnly**):

| Cookie | httpOnly | Vai trò |
|---|---|---|
| `sessionid`, `sessionid_ss` | ✅ | phiên đăng nhập chính |
| `sid_tt`, `uid_tt` | ✅ | id phiên/user |
| `sid_guard` | ✅ | giữ đăng nhập dài hạn (nhiều tuần) |
| `msToken` | ❌ | token chống bot (xoay thường xuyên) |
| `ttwid`, `odin_tt` | một phần | fingerprint thiết bị |
| `passport_csrf_token`, `s_v_web_id` | ❌ | csrf / web id |

Định dạng cuối cùng = 1 dòng: `sessionid=...; sid_tt=...; msToken=...; ttwid=...; ...`

## 2. Vì sao KHÔNG lấy tự động từ ổ đĩa
- Chrome ≥127 mã hoá cookie **v20 app-bound** (`app_bound_encrypted_key: APPB`) — chỉ giải mã được
  **bên trong tiến trình Chrome**; process khác (kể cả chạy dưới user bạn) không giải mã được.
- File `…/User Data/<Profile>/Network/Cookies` bị Chrome **khoá độc quyền** (copy = sharing violation),
  cần **admin** để đọc qua Volume Shadow Copy.
- `document.cookie` (JS trang) **không thấy** cookie httpOnly (`sessionid`, `sid_guard`).

→ Phải lấy **qua chính Chrome**. 3 cách dưới, chọn theo nhu cầu.

## 3. Cách 0 — TOOL 1-CLICK macOS (khuyên dùng trên Mac) ⭐
```bash
cd capcut-worker
chmod +x get-cookie-mac.command     # 1 lần
./get-cookie-mac.command            # hoặc double-click trong Finder
```
Tool sẽ: mở Chrome → bạn **đăng nhập capcut.com** → bấm Enter → nó tự lấy **toàn bộ cookie (gồm
httpOnly)** qua CDP, **COPY vào clipboard** + lưu `full_cookie.txt`, và in sẵn lệnh add account.
Lần sau chạy lại KHÔNG cần login (profile riêng giữ phiên). Chỉ việc paste sang proxy.

## 3. Cách A — Extension (khuyên dùng, bấm 1 nút)
`chrome.cookies.getAll` chạy trong Chrome nên đọc được httpOnly + giải mã v20.

1. `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn `capcut-worker/cookie-extractor`.
2. Đăng nhập **capcut.com** (Pro, còn credit).
3. Bấm icon extension → **Lấy cookie capcut.com** (hiện checklist đủ/thiếu cookie) → **Copy**,
   hoặc điền Proxy URL + Admin key rồi **Add account vào proxy** (POST thẳng `/api/management/accounts`).

Tự viết tối giản:
```js
// manifest v3: "permissions":["cookies"], "host_permissions":["https://*.capcut.com/"]
const urls = ["https://www.capcut.com/","https://edit-api-sg.capcut.com/","https://commerce-api-sg.capcut.com/"];
const m = new Map();
for (const url of urls) for (const c of await chrome.cookies.getAll({url}))
  if (!m.has(c.name) || c.value.length > m.get(c.name).length) m.set(c.name, c.value);
const cookie = [...m].map(([k,v]) => `${k}=${v}`).join("; ");
```

## 4. Cách B — CDP tự động (headless, refresh định kỳ)
Dùng cho tool chạy nền. File: `capcut-worker/get_cookie_cdp.py`.
```bash
# Linux — mở Chrome debug + profile riêng (đăng nhập 1 lần, sid_guard giữ lâu)
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/capcut-cdp
# rồi:
python capcut-worker/get_cookie_cdp.py     # -> in cookie + ghi full_cookie.txt
```
Dùng CDP `Storage.getCookies` (đọc httpOnly, giải mã v20, không cần admin).

## 5. Cách C — thủ công 1 lần (DevTools)
capcut.com → F12 → **Network** → click 1 request tới `edit-api-sg.capcut.com` → chuột phải →
**Copy → Copy as cURL** → lấy phần sau `-H 'cookie: …'`.

## 6. Add vào proxy
```bash
curl -XPOST http://127.0.0.1:18080/api/management/accounts -H 'content-type: application/json' \
 -d '{"provider":"capcut","type":"cookie","credentials":{"cookie":"<COOKIE>"},"status":"healthy","weight":1}'
```
Hoặc UI `/management → Providers → CapCut → Add Account`. Thêm nhiều acc → pool tự xoay vòng/failover.

## 7. Kiểm tra cookie còn sống
- Nhanh nhất: gọi TTS (miễn phí) — ra MP3 là OK:
  ```bash
  curl -XPOST http://127.0.0.1:18080/v1/audio/speech \
    -d '{"model":"capcut-tts","input":"test","voice":"alloy"}' -o test.mp3
  ```
- Hoặc mục **Quota** trong proxy hiển thị số dư credit.

## 8. Vòng đời & làm mới
- `sid_guard` giữ đăng nhập nhiều tuần; `msToken` xoay liên tục (Chrome tự cập nhật khi bạn còn mở tab).
- Gen/TTS bắt đầu lỗi `401`/`ret=-1`/`not login` → cookie hết hạn → lấy lại (Cách B tự động hoá tốt nhất,
  có thể cron mỗi vài ngày và PUT cập nhật credential).
