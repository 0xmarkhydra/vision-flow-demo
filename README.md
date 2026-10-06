# BIDDI AI Showcase

Demo local để so sánh **logic cũ** và **Phase 1** trên cùng một ảnh bằng OpenAI API thật và public storage của BIDDI.

## Luồng benchmark

```text
Chọn ảnh
  -> upload 1 lần lên BIDDI public storage
  -> lấy public image URL
  -> chạy song song trên cùng URL:
       Logic cũ: AI basic/category -> schema -> AI attributes -> validate -> usable
       Phase 1:  AI basic -> dữ liệu cơ bản sẵn sàng -> schema -> AI enrichment -> validate
```

Mốc quyết định chính là **Logic cũ usable vs Phase 1 usable**. Phase 1 full chỉ dùng để xem enrichment hoàn tất khi nào.

## Đổi model Phase 1

Model logic cũ lấy từ:

```text
OLD_MODEL=gpt-4o
```

và được giữ cố định làm baseline.

Giao diện luôn chọn **GPT-4o** khi mở trang để so sánh hai cách với cùng AI. Model dự phòng phía server cho request không truyền model lấy từ:

```text
NEW_MODEL=gpt-4o
```

Giao diện có danh sách **Phase 1 · Cách mới**: GPT-4o, GPT-4o mini, GPT-4.1, GPT-4.1 mini và model đang cấu hình. Chọn **Model khác…** để nhập ID tùy chỉnh. Khả dụng phụ thuộc tài khoản API; lựa chọn không đảm bảo model đã được cấp quyền. Giá trị UI override `NEW_MODEL` cho cả hai request Phase 1 trong lần thử, mặc định là `gpt-4o` dù `.env` cấu hình model khác. Không cần sửa `.env` hay restart chỉ để đổi model.

Server chỉ cho override model ở `flow=phase1`; logic cũ luôn dùng `OLD_MODEL`.

## Chạy

Yêu cầu Node.js 22 trở lên. Không cần cài dependency.

```bash
git clone https://github.com/0xmarkhydra/vision-flow-demo.git
cd vision-flow-demo
cp .env.example .env
```

Điền OpenAI API key và thông tin storage riêng vào `.env`; không commit file này.

```bash
npm run check
npm test
npm start
```

Mở:

```text
http://127.0.0.1:8765
```

Nếu server đang chạy từ trước khi sửa code, dừng bằng `Ctrl+C` rồi chạy `npm start` lại.

## UI

1. Chọn ảnh sản phẩm.
2. Nhập/chọn model ID cho Phase 1.
3. Bấm **Bắt đầu so sánh**.
4. Xem thời gian gửi ảnh, thời gian bắt đầu của hai cách và thời gian tiết kiệm.
5. Xem tên sản phẩm, danh mục, kiểm duyệt và chi tiết nhận diện ở hai cột.
6. Mở **Dành cho đội kỹ thuật** khi cần timing từng stage hoặc JSON. **Đọc kết quả này như thế nào?** giải thích giới hạn phép thử.

Kết quả giữ tên ảnh và model của lần chạy, không đổi nhãn khi chọn model cho lần kế tiếp. Điều khiển bị khóa trong lúc chạy. Lỗi từng luồng và lỗi bổ sung chi tiết hiển thị riêng.

`npm test` dùng Node stdlib, dữ liệu giả, không gọi OpenAI hoặc upload ảnh. Browser QA cũng phải mock API nếu chưa được duyệt dùng dịch vụ thật.

Chọn file **không tự gọi AI**; chỉ khi bấm nút chạy mới phát sinh model calls.

## API local

- `GET /api/config`: trạng thái key/storage và model mặc định; không trả secret.
- `POST /api/upload`: nhận raw image bytes, upload vào bucket `biddi-public`, trả public URL.
- `POST /api/analyze`: nhận `flow`, `stage`, `imageUrl`, `category`; với `flow=phase1` có thể gửi thêm `model` để override candidate model.

Ảnh chỉ upload một lần. Old/Phase 1 dùng chung public URL; không chuyển ảnh sang base64/data URL.

## Bảo mật

OpenAI key và storage credentials chỉ tồn tại ở Node server `.env`; browser không nhận hoặc render secret. `.env` bị ignore khỏi Git.

Static server chỉ cho phép `index.html`, `app.js`, `styles.css`; không phục vụ `.env` hay source server. Chỉ dùng ảnh không nhạy cảm vì ảnh được upload công khai. Local mặc định chỉ nghe localhost. Bản Railway mở công khai không cần đăng nhập theo yêu cầu user ngày 2026-10-06 để demo ngắn hạn; ai có link đều có thể chạy và phát sinh phí. Giữ quota ở mục Railway, xóa/dừng dịch vụ khi demo xong.

## Railway

Deploy bằng Dockerfile; chỉ copy năm file chạy app, không copy `.env` hoặc evidence. Railway cấp `PORT`; production nghe `0.0.0.0`. Health check công khai tại `/health` chỉ trả trạng thái.

- `NODE_ENV=production`, `OLD_MODEL=gpt-4o`, `NEW_MODEL=gpt-4o`.
- URL: https://biddi.up.railway.app — không có tên người dùng, mật khẩu hoặc mã demo.
- OpenAI/storage credentials đặt trong Railway Variables, không ghi vào source hoặc build image.
- Production chỉ cho bốn model trong dropdown; model tùy chỉnh vẫn dùng được ở local.
- Giới hạn dùng chung: 20 yêu cầu upload và 80 yêu cầu phân tích mỗi cửa sổ một giờ (tối đa 20 phép so sánh đầy đủ), tối đa 4 request dịch vụ đồng thời. Lượt lỗi cũng tính vào quota. Timeout dịch vụ 120 giây.
- Quota nằm trong RAM, reset khi restart/redeploy; giữ một replica. Đây không phải trần tiền USD. Cần quota lưu bền/chung và kiểm soát ngân sách provider trước khi mở rộng.
- `.railway-access.json` local chỉ lưu project/service/deployment ID và URL, không còn mật khẩu; bị loại khỏi Git, Railway upload và Docker build.

## Chi phí demo

Một lần bấm **Chạy so sánh** có thể tạo tối đa 4 model calls:

- Logic cũ: basic + attributes.
- Phase 1: basic + attributes.

Đây là benchmark/demo, không phải cấu hình rollout production.

Schema/validation là độ trễ mô phỏng 35 ms/10 ms, không gọi backend sản phẩm. Mốc “bắt đầu” đo dữ liệu sẵn sàng, không mở form đăng bán thật. Tỷ lệ tin cậy là AI tự báo cáo, không phải số liệu accuracy đã kiểm chứng.
