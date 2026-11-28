# CapCut — Bảng giá credit (chi tiết)

Chi phí mỗi lượt tạo TTS / ảnh / video theo chất lượng, tính bằng **credit** của tài khoản CapCut Pro.

> **Nguồn số liệu:** ✅ = đo trực tiếp trên thẻ "Dùng điểm tín dụng?" hoặc qua chênh lệch số dư
> (ngày 2026-09-12). `~` = ước lượng nội suy (nêu rõ cơ sở). **Giá thật LUÔN hiện trên thẻ trước khi
> trừ**, và worker trả `cost` mỗi request → con số dưới là *tham chiếu*, số thực đọc theo từng lần.

---

## 1. Credit CapCut là gì
- Số dư = `vip_credit` (bao gồm trong gói, làm mới định kỳ) + `gift_credit` (khuyến mãi) + `purchase_credit` (mua thêm).
- Gói **Pro** có hạn mức credit/tháng; hết thì phải chờ reset hoặc mua thêm.
- **Chỉ image/video tốn credit. TTS + xem số dư = miễn phí.**

## 2. Xem số dư
- Mục **Quota** trong proxy (tự query `commerce/v1/benefits/user_credit`).
- Hoặc UI CapCut hiển thị `✦ <số>` góc trên.

---

## 3. BẢNG GIÁ TỔNG HỢP (theo dịch vụ × chất lượng)

| Dịch vụ | Model / Chất lượng | Thông số | Credit | Nguồn |
|---|---|---|---:|:---:|
| **TTS** | mọi giọng (`mget_audition`) | mỗi đoạn text | **0** | ✅ |
| **Ảnh** | model thường (Nano / Seedream 4.0s) | **1K** | **~1–4** | ✅¹ |
| **Ảnh** | high-fidelity (Seedream 5 Pro / Nano Pro) | **2K** | **65** | ✅ |
| **Ảnh** | high-fidelity | **4K** | ~90–130 | ~ (Ultra) |
| **Video** | Seedance 2.0 Fast/Mini | **720p · 5s** | ~65 | ~ |
| **Video** | Seedance 2.0 Fast | **720p · 6s** | **78** | ✅ |
| **Video** | Seedance 2.0 Fast | **720p · 8s** | **104** | ✅ |
| **Video** | Seedance 2.0 Fast | **720p · 10s** | ~130 | ~ |
| **Video** | Seedance 2.0 Fast | **720p · 12s** | ~156 | ~ |
| **Video** | Seedance 2.0 Fast | **720p · 15s** | ~195 | ~ |
| **Video** | mọi model | **480p** | ~0.6× của 720p | ~ |
| **Video** | 1080p / 2K / 4K, hoặc Sora 2 / Veo 3 / Seedance 2.5 Pro | mọi | **cần Ultra** | — |

¹ Suy từ việc account còn **4 credit vẫn tạo được 1 ảnh** → ảnh thường ≤ 4 credit.

---

## 4. TTS — chi tiết
| Mục | Giá |
|---|---|
| Mọi giọng, mọi độ dài (endpoint `mget_audition`) | **0 credit** |

- ✅ **Đã kiểm chứng:** gọi TTS trên account **0 credit** vẫn trả về **MP3 166 KB** (`ret:0`) → không trừ credit.
- Không có thẻ "Consume credits" cho TTS → miễn phí (đường audition/preview).
- Schema: `{"speakers":[{"speaker","platform","text","lan"}]}`.

## 5. Ảnh — chi tiết
Chi phí phụ thuộc **model** + **độ phân giải**:

| Model | 1K | 2K | 4K |
|---|---:|---:|---:|
| Nano / Seedream 4.0s (thường) | ~1–4 ✅ | ~30–40 ~ | Ultra |
| Seedream 5 Pro / Nano Pro (high-fidelity) | ~20–30 ~ | **65** ✅ | ~90–130 ~ (Ultra) |

- ✅ Đo được: **high-fidelity 2K = 65 credit** (thẻ hiện "high-fidelity image model at 2K resolution … 65").
- Mỗi lần tạo ra ~2–3 rendition (crop 512, display q85, preview) nhưng **tính là 1 lượt**.
- Agent tự chọn model/độ phân giải theo prompt; nêu rõ "1K"/"2K" hoặc model để kiểm soát chi phí.

## 6. Video — chi tiết
**Công thức 720p (Seedance 2.0 Fast):** `credit ≈ 13 × số_giây` (nội suy từ 78/6s và 104/8s).

| Thời lượng | 480p (~) | 720p | 1080p+ |
|---|---:|---:|---|
| 5s | ~40 | ~65 ~ | Ultra |
| 6s | ~47 | **78** ✅ | Ultra |
| 8s | ~62 | **104** ✅ | Ultra |
| 10s | ~78 | ~130 ~ | Ultra |
| 12s | ~94 | ~156 ~ | Ultra |
| 15s | ~117 | ~195 ~ | Ultra |

- ⚠️ **Lưu ý khuyến mãi:** lúc đo có promo **"giảm 57% credit cho Seedance 2.0 Fast"** → 78/104 có thể là **giá đã giảm**. Model/giai đoạn khác sẽ cao hơn. Luôn xem thẻ để biết giá thực.
- Model đắt hơn (Seedance 2.5, Sora 2, Veo 3) = **Ultra**, Pro không dùng được.

## 7. Tier Ultra (Pro KHÔNG có)
Những thứ chạm tier Ultra → account Pro bị chặn ("You're using Ultra features"), worker tự bấm
**Continue** hạ về tuỳ chọn Pro (thường **720p, Seedance 2.0 Fast**):
- Độ phân giải **1080p / 2K / 4K** (video); **4K** (ảnh).
- Model cao cấp: **Sora 2**, **Veo 3**, **Seedance 2.5 Pro**, **Seedream 5 Pro** (ảnh 2K vẫn được trên Pro như đo ở trên, nhưng 4K/《advanced》cần Ultra).
→ Muốn 1080p/2K/4K/Sora/Veo thật: nâng gói **Ultra**.

## 8. Proxy báo cost mỗi request thế nào
- Worker **scrape số credit trên thẻ** và trả trong response `/generate`:
  ```json
  {"status":"done","cost":104,"urls":[...],"kind":"video"}
  ```
- Log proxy: `capcut media generated ... credit_cost=104 resolution=720p`.
- → Bạn luôn biết **chính xác** mỗi lượt tốn bao nhiêu (không phụ thuộc bảng ước lượng).

## 9. Cơ chế "thẻ" hiển thị giá (gate)
| Thẻ | Ý nghĩa | Nút |
|---|---|---|
| **Dùng điểm tín dụng? +N / Consume credits +N** | đủ credit, N = giá lượt này | **Xác nhận / Confirm** |
| **Bạn đang dùng tính năng Ultra / You're using Ultra features** | prompt chạm Ultra | **Tiếp tục / Continue** (hạ về Pro) / *Nâng cấp* |
| **Không đủ credit / Not enough credits** | thiếu credit | **Continue with a lighter version** (bản rẻ hơn) |

## 10. Tối ưu chi phí
1. **TTS miễn phí** — tận dụng.
2. Ảnh: dùng **model thường + 1K** (~1–4cr) thay vì high-fidelity 2K (65cr) nếu không cần siêu nét.
3. Video: **720p + thời lượng ngắn** (5–8s). 720p 6s = 78; mỗi giây thêm ~13cr.
4. Tránh 1080p/2K/4K + Sora/Veo (Ultra) trên Pro — bị hạ xuống hoặc chặn.
5. Theo dõi `credit_cost` trong log để biết lượt nào đắt.
6. Nạp nhiều account (pool) để phân tải credit + failover khi 1 account hết.

## 11. Nguồn & ngày đo
| Số liệu | Cách đo | Ngày |
|---|---|---|
| TTS = 0 | MP3 166KB trên acc 0 credit (`ret:0`) | 2026-09-12 |
| Ảnh high-fidelity 2K = 65 | đọc thẻ "…2K resolution … 65 Xác nhận" | 2026-09-12 |
| Ảnh thường ≤ 4 | tạo được ảnh khi acc còn 4 credit | 2026-09-12 |
| Video 720p 6s = 78 | thẻ "+78" + số dư 152→74 | 2026-09-12 |
| Video 720p 8s = 104 | thẻ "+104" + số dư 192→88 | 2026-09-12 |
| ~13 cr/s (720p) | nội suy 78/6 và 104/8 | — |

> Các ô `~` là ước lượng — hãy coi thẻ gate / trường `cost` là số thực. Giá CapCut có thể đổi theo
> khuyến mãi (vd promo Seedance 2.0 Fast −57% lúc đo).
