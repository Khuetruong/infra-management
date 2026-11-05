# Nền tảng quản lý hạ tầng: control plane, agent và giao diện web

Bản mở rộng này biến app demo thành nền tảng **kết nối và quản trị server thật**, sau khi chủ server cấp quyền bằng cách cài agent. App mobile Expo cũ vẫn để nguyên trong thư mục gốc. Giao diện chính giờ là web.

```
┌──────────────┐  HTTPS (JWT)   ┌─────────────────────────────┐   HTTPS, agent tự gọi ra    ┌──────────────┐
│ Trình duyệt  │ ─────────────► │ Control plane (server/)      │ ◄─────────────────────────── │ Agent        │
│ (web UI)     │                │ API + web UI + SQLite        │   heartbeat 10s, nhận lệnh   │ (agent/)     │
└──────────────┘                │ RBAC · vault · audit · alert │   gửi kết quả                │ trên mỗi     │
                                └─────────────────────────────┘                               │ server Linux │
                                                                                               └──────────────┘
```

## Thành phần

| Thư mục | Nội dung |
|---|---|
| `server/` | Control plane viết bằng Node.js 22.5 trở lên, **không có dependency ngoài** (dùng `node:http`, `node:sqlite`, `node:crypto`). Phục vụ API, giao diện web (`server/web/`) và file cài agent. |
| `agent/` | Agent `infra_agent.py`, chỉ dùng thư viện chuẩn của Python 3.6 trở lên, cùng `install.sh` để cài thành dịch vụ systemd. |

## Chạy thử (5 phút)

```bash
cd server
npm start                       # http://localhost:8080
```

1. Mở `http://localhost:8080`. Lần đầu vào, trang sẽ yêu cầu tạo tài khoản **chủ sở hữu**.
2. Vào **Server**, bấm **+ Thêm server**, đặt tên server. Trang sẽ hiện một lệnh cài đặt dùng một lần, hết hạn sau 24 giờ.
3. Chạy lệnh đó bằng quyền root trên server Linux cần quản lý. Server sẽ xuất hiện trong danh sách với trạng thái *Online*.
4. Mở server đó và chọn thao tác, ví dụ *Kiểm tra bảo mật tổng quát*. Kết quả và điểm bảo mật hiện ngay trên giao diện.

> Khi chạy bằng HTTP, lệnh cài đặt sẽ có thêm `--insecure-http`. Cách này **chỉ dùng cho lab**. Agent mặc định từ chối kết nối không mã hoá.

## Triển khai thật

```bash
# Cách 1: TLS trực tiếp
PUBLIC_URL=https://infra.congty.vn TLS_CERT=/etc/ssl/infra.crt TLS_KEY=/etc/ssl/infra.key PORT=443 npm start

# Cách 2: đặt sau reverse proxy (nginx/Caddy) có TLS
PUBLIC_URL=https://infra.congty.vn TRUST_PROXY=1 HOST=127.0.0.1 PORT=8080 npm start

# Hoặc Docker
docker build -f server/Dockerfile -t infra-control .    # chạy từ thư mục gốc
docker run -d -p 8080:8080 -v infra-data:/data -e PUBLIC_URL=https://infra.congty.vn infra-control
```

### Chạy trên Vercel (serverless, truy cập từ Internet)

Nền tảng chạy được trên Vercel. Vì mỗi request serverless là một tiến trình riêng và `/tmp` không chia sẻ, ở chế độ này **bắt buộc dùng Postgres** và **bắt buộc đặt khoá qua biến môi trường** (không tự sinh file khoá như bản VPS).

1. Tạo project trên Vercel, **Root Directory = `server`** (hoặc dùng `vercel` CLI trong thư mục `server/`).
2. Tạo một database Postgres và lấy connection string. Tài khoản này đã cài sẵn **Neon** trên Vercel: vào tab **Storage → Create Database → Neon**, kết nối vào project. Vercel sẽ tự thêm biến `DATABASE_URL`. (Dùng Postgres nào cũng được, miễn đặt `DATABASE_URL`.)
3. Đặt các biến môi trường (Project → Settings → Environment Variables):

   | Biến | Giá trị |
   |---|---|
   | `DATABASE_URL` | Neon tự thêm, hoặc dán connection string Postgres |
   | `MASTER_KEY` | 64 ký tự hex: `openssl rand -hex 32` |
   | `JWT_SECRET` | 64 ký tự hex khác: `openssl rand -hex 32` |
   | `SETUP_TOKEN` | một chuỗi bí mật bạn tự đặt; cần nhập khi tạo tài khoản owner đầu tiên |
   | `PUBLIC_URL` | URL của app, ví dụ `https://infra-cua-ban.vercel.app` |

4. Deploy. Mở URL, nhập `SETUP_TOKEN` để tạo tài khoản owner, rồi dùng như bình thường.

> `SETUP_TOKEN` để tránh việc URL công khai bị người lạ vào chiếm quyền tạo owner. HTTPS do Vercel lo sẵn nên lệnh cài agent luôn là `https://`.
>
> **Lưu ý chi phí:** database Postgres (Neon) tính phí theo dung lượng và thời gian tính toán trên tài khoản của bạn.

File cấu hình đã có sẵn: `server/vercel.json` (định tuyến mọi request vào `api/index.js`, kèm `web/` và `agent/`) và `server/api/index.js` (điểm vào serverless). Agent được gom vào bundle qua bước build `server/scripts/prepare-bundle.js`.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `PUBLIC_URL` | lấy theo Host của request | URL công khai, dùng để tạo lệnh cài agent |
| `DATABASE_URL` | (trống → dùng SQLite) | Connection string Postgres. Đặt biến này để dùng Postgres thay cho SQLite; bắt buộc khi chạy trên Vercel |
| `DATA_DIR` | `server/data` | Nơi chứa DB SQLite và khoá (chỉ dùng khi không có `DATABASE_URL`) |
| `MASTER_KEY` | tự sinh ra `DATA_DIR/master.key` (bắt buộc đặt tay trên Vercel) | Khoá AES-256 của kho bí mật. **Phải backup riêng**, mất khoá này là mất toàn bộ bí mật |
| `JWT_SECRET` | tự sinh ra `DATA_DIR/jwt.key` (bắt buộc đặt tay trên Vercel) | Khoá ký phiên đăng nhập |
| `SETUP_TOKEN` | (trống) | Nếu đặt, phải nhập đúng mã này khi tạo tài khoản owner đầu tiên. Bắt buộc khi chạy trên Vercel |
| `TLS_CERT`, `TLS_KEY` | (trống) | Bật HTTPS trực tiếp |
| `TRUST_PROXY` | (trống) | Đặt `1` khi chạy sau reverse proxy, để ghi đúng IP vào audit |
| `PLAN` | `enterprise` | `basic` cho tối đa 10 server, `professional` cho 100 server, `enterprise`/`government` không giới hạn |
| `AGENT_OFFLINE_AFTER_SECONDS` | 90 | Quá thời gian này mà không nhận heartbeat thì server bị coi là mất kết nối và sinh cảnh báo |
| `CORS_ORIGIN` | (trống) | Chỉ cần đặt khi một client khác domain gọi API, ví dụ app mobile cũ |

Nếu quên mật khẩu owner, chạy `node --no-warnings src/cli.js create-admin <email> <mật-khẩu>` để tạo hoặc đặt lại.

## Mô hình bảo mật

- **Cấp quyền bằng cách cài agent.** Không lưu SSH key hay mật khẩu root của server. Token đăng ký chỉ dùng được một lần, hết hạn sau 24 giờ, và chỉ lưu dạng băm SHA-256. Mỗi agent nhận một token riêng (cũng chỉ lưu bản băm). Khi gỡ server trên giao diện, token đó bị thu hồi ngay.
- **Agent chỉ kết nối ra ngoài.** Server được quản lý không phải mở thêm cổng nào.
- **Danh sách thao tác cho phép có hai lớp kiểm tra.** Control plane chỉ gửi những thao tác có trong danh mục (`server/src/actions.js`). Agent giữ bản danh mục riêng và tự kiểm tra lại từng tham số bằng regex/khoảng giá trị. Lệnh được chạy dạng danh sách đối số, không qua shell, nên không chèn được lệnh kiểu `nginx; rm -rf /`.
- **Shell tự do (break-glass) mặc định bị tắt ở cả hai phía.** Muốn dùng phải (1) admin bật cho server trên web, **và** (2) người quản trị server đặt `"allow_shell": true` trong `/etc/infra-agent/config.json` trên chính máy đó. Vì vậy, kể cả khi control plane bị chiếm quyền, kẻ tấn công vẫn không chạy được lệnh tuỳ ý.
- **Phân quyền RBAC:**
  - `viewer`: chỉ xem.
  - `operator`: restart/start dịch vụ, xem log, kiểm tra bảo mật, backup DB.
  - `admin`: cập nhật OS, reboot, dừng dịch vụ, firewall, chặn IP, thêm/gỡ server, quản lý bí mật và người dùng.
  - `owner`: toàn quyền.
  - Không ai cấp được vai trò cao hơn vai trò của chính mình, và hệ thống luôn giữ ít nhất một owner.
- **Thao tác nguy hiểm** (reboot, cập nhật, dừng dịch vụ, firewall) bắt buộc `confirm: true`. Trên web, người dùng phải gõ đúng tên server mới chạy được.
- **Kho bí mật** (mật khẩu DB…) được mã hoá AES-256-GCM. API không bao giờ trả lại giá trị. Bí mật chỉ được giải mã lúc gửi lệnh cho agent, và mọi chỗ giá trị xuất hiện trong output đều bị thay bằng `***`. Trong DB, tham số lệnh chỉ lưu tham chiếu `{"$secret": "tên"}`.
- **Nhật ký audit** ghi lại mọi đăng nhập (kể cả đăng nhập sai), lệnh được tạo hoặc hoàn tất, thay đổi người dùng, bí mật và server, kèm IP.
- **Đăng nhập:** mật khẩu băm bằng scrypt. Sau 10 lần sai trong 15 phút, tài khoản bị khoá tạm theo IP và email. Đổi mật khẩu sẽ vô hiệu hoá các phiên cũ. Giao diện web dùng CSP chặt (`script-src 'self'`) và không dùng `innerHTML`.

## Thao tác hiện có

| Nhóm | Thao tác |
|---|---|
| Hệ thống | thông tin máy, dung lượng ổ đĩa, top tiến trình, tài khoản có shell, kiểm tra/cài cập nhật (apt/dnf/yum), reboot có hẹn giờ |
| Dịch vụ | liệt kê, xem trạng thái, start/restart/stop (systemd), xem log journald |
| Bảo mật | kiểm tra tổng quát có chấm điểm (cấu hình SSH, tài khoản UID 0, quyền `/etc/shadow`, firewall, DB mở ra Internet, bản vá chưa cài, fail2ban, unattended-upgrades), cổng đang mở, đăng nhập SSH thất bại kèm top IP, trạng thái/mở/đóng cổng firewall (ufw/firewalld), chặn IP |
| Database | PostgreSQL: trạng thái, danh sách DB, backup `pg_dump`. MySQL/MariaDB: trạng thái, backup `mysqldump` nén gzip (mật khẩu lấy từ kho bí mật). Liệt kê file backup |
| Break-glass | chạy lệnh shell (cần bật ở cả hai phía) |

Cảnh báo tự động: CPU/RAM vượt 90% hoặc 97%, ổ đĩa vượt 80% hoặc 92%, có bản vá bảo mật chưa cài, cần reboot, agent mất kết nối, kiểm tra bảo mật phát hiện lỗi mức cao. Cảnh báo tự đóng khi chỉ số trở lại bình thường.

Muốn thêm thao tác mới, cần khai báo ở cả `server/src/actions.js` (tham số, vai trò tối thiểu, mức nguy hiểm) và `agent/infra_agent.py` (`ACTIONS` và `HANDLERS`).

## Kiểm thử

```bash
cd server && npm test
```

Bài test end-to-end khởi động control plane, chạy agent Python thật để đăng ký và nhận lệnh, rồi kiểm tra các điểm sau:
- RBAC, chặn chèn lệnh, bắt buộc xác nhận thao tác nguy hiểm;
- agent tự từ chối shell khi cấu hình cục bộ tắt;
- bí mật bị che trong output;
- cảnh báo mất kết nối và audit log;
- gỡ server thì agent bị thu hồi quyền;
- chặn path traversal khi phục vụ file tĩnh.

## Giới hạn hiện tại và bước tiếp theo nên làm

- Agent chạy bằng root để làm được việc quản trị. Có thể tách thành user riêng kèm sudoers giới hạn.
- Chưa có 2FA (TOTP) và phê duyệt hai người cho thao tác nguy hiểm.
- Chưa có lệnh hàng loạt theo nhãn (ví dụ cập nhật tất cả server `prod`) và lịch backup định kỳ.
- Chưa có kết nối không cần agent (qua SSH) cho thiết bị mạng như router hay switch.
- Chưa gửi thông báo cảnh báo ra ngoài (email/Telegram/Slack).
- SQLite đủ cho vài trăm server. Quy mô lớn hơn nên chuyển sang PostgreSQL.
