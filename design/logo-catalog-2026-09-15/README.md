# Omnia logo + palette exploration

Ngày 15/09/2026 — catalog để chọn hướng trước khi thay logo thật trong app.

Logo hiện tại dùng aperture hình lục giác + lõi kim cương màu tím. Hướng catalog này cố ý bỏ cảm giác “AI tím mặc định”, ưu tiên hình học gọn, đọc tốt ở 16–32 px, quen thuộc với coder và hợp cả dark/light Windows desktop.

## Cách xem nhanh

1. Mở `index.html` để xem toàn bộ logo và palette trên cùng một trang.
2. Các file `logo-*.svg` là mark riêng, nền trong suốt, có thể dùng làm nguồn cho icon/app icon sau khi chốt.
3. Chọn một logo (L01–L12) và một palette (P01–P08). Có thể chọn “logo này + màu của palette khác”.

## Tiêu chí thiết kế

- Đọc rõ ở 16 px, 24 px, 32 px và app icon 1024 px.
- Hình học phẳng, ít chi tiết, không gradient “AI glow”, không ngôi sao/brain/neural cliché.
- Accent chỉ là tín hiệu thao tác; nền và chữ giữ trung tính để UI không bị nhuộm màu.
- Tương phản đủ cho dark mode, đồng thời có cặp màu light mode.
- Có thể vẽ lại bằng SVG/Windows icon pipeline, không phụ thuộc raster.

## Logo concepts

| ID | Tên | Ý tưởng | Cảm giác |
| --- | --- | --- | --- |
| L01 | Command ring | Vòng chữ O bị ngắt bởi caret `>` và điểm lệnh | Coder, rõ thương hiệu |
| L02 | Terminal aperture | Hai dấu prompt mở vào lõi vuông | Terminal-first, trực tiếp |
| L03 | Branch node | Ba node nối thành chữ O mở | Workflow, DAG, orchestration |
| L04 | Layered window | Bốn pane xếp thành khung cửa sổ | Desktop-native, thân thuộc |
| L05 | Hex core | Hex tối giản với lỗ trung tâm | Hạ tầng, bền, kỹ thuật |
| L06 | Stack cursor | Ba lớp dữ liệu + cursor dọc | Context, layers, code |
| L07 | Orbit grid | Quỹ đạo một node quanh lõi | Điều phối nhiều provider |
| L08 | Chevron loop | Hai chevron đan thành vòng liên tục | Automation, flow |
| L09 | Prompt diamond | Dấu `>` và gạch lệnh tạo hình diamond | CLI, compact, sắc |
| L10 | Compile spark | Ba thanh build + tia đánh dấu thành công | Build, ship, momentum |
| L11 | Nodal arc | Cung tròn + ba điểm neo | Network, connected workspace |
| L12 | Monogram O | Chữ O vuông bo với notch định hướng | Tối giản, dễ scale |

## Palette concepts

| ID | Tên | Dark accent | Light accent | Khi nên chọn |
| --- | --- | --- | --- |
| P01 | Signal Blue | `#4FA3D1` | `#2D6FA3` | Mặc định an toàn, giống công cụ dev chuyên nghiệp |
| P02 | Terminal Green | `#2FCB88` | `#178457` | Nhấn mạnh automation/terminal, thân thiện với coder |
| P03 | Build Amber | `#E7A23C` | `#A96709` | Năng lượng build, cảnh báo vừa phải, không neon |
| P04 | Focus Cyan | `#17B6C8` | `#087B89` | Sạch, hiện đại, khác biệt nhưng vẫn kỹ thuật |
| P05 | Ship Coral | `#F07462` | `#BC4B3C` | Ấm hơn, có cá tính cho sản phẩm công cụ |
| P06 | Steel Teal | `#3AB7A3` | `#14796C` | Cân bằng, ít chói, hợp UI dùng lâu |
| P07 | Paper Cobalt | `#5E9BE6` | `#2D6CDF` | Light-first, tài liệu/code workspace |
| P08 | Carbon Mint | `#72D4C3` | `#2A8B7D` | Tươi nhưng không “AI purple”, hợp logo hình học |

## Gợi ý shortlist

Nếu cần một hướng mặc định để bắt đầu, tôi đề xuất thử:

- **L04 + P01**: cửa sổ xếp lớp + xanh tín hiệu — dễ hiểu ngay là app desktop cho coder.
- **L03 + P02**: node workflow + xanh terminal — gắn với Goal → Task → DAG của Omnia.
- **L01 + P04**: command ring + cyan — mark nhỏ rất dễ nhận diện ở rail/title bar.
- **L12 + P07**: O bo notch + cobalt — tối giản nhất, phù hợp cả icon và wordmark.

Chưa thay logo trong app ở bước này; chờ chọn L/P để tránh khóa sai hướng thương hiệu.
