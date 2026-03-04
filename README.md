# GMX Mail Reader

Web đọc mail GMX qua IMAP — **pass không bao giờ lộ ra client**.

## Cấu trúc thư mục
```
.
├── server.js          # Backend Express + IMAP
├── package.json
├── accounts.txt       # Danh sách tài khoản (bảo vệ file này!)
└── public/
    └── index.html     # Frontend tự động serve
```

## Cài đặt & chạy

```bash
npm install
node server.js
```

Server chạy tại `http://localhost:3000`

## Thêm tài khoản

Mở file `accounts.txt`, thêm dòng theo cú pháp:
```
maillam|mailchinh|passmailchinh
```

Ví dụ:
```
froschth@gmx.de|elli_hofmann6rsk@gmx.de|MyPassword123
```

## Truy cập

```
http://domain/froschth@gmx.de/elli_hofmann6rsk@gmx.de
```

Frontend sẽ:
1. Gọi `/api/read?from=...&to=...`
2. Backend tra pass từ `accounts.txt` (client **không bao giờ nhìn thấy pass**)
3. Kết nối IMAP GMX với `mailchinh + pass`
4. Stream mail về qua Server-Sent Events (SSE) theo thời gian thực
5. Hiển thị log kết nối + danh sách mail

## Bảo mật

- ✅ Pass chỉ lưu trên server trong `accounts.txt`
- ✅ Client chỉ gửi `from` và `to`, không bao giờ gửi pass
- ✅ Kết nối IMAP dùng TLS (port 993)
- ⚠️ Thêm authentication (API key / session) nếu deploy public
- ⚠️ Phân quyền `accounts.txt` (chmod 600)

## Deploy production

Thêm reverse proxy (nginx) và HTTPS. Ví dụ với PM2:
```bash
npm install -g pm2
pm2 start server.js --name mail-reader
```
