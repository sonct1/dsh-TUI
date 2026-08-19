# Auto-continue

[Chỉ mục tài liệu](README.md) · [Cấu hình](configuration.md)

`autoContinue` là cơ chế tự gửi một user message tiếp tục khi một turn kết thúc vì lỗi có thể retry hoặc vì model chạm giới hạn token. Tính năng này mặc định tắt và hiện được implement trực tiếp trong `dsh-tui`, không phải plugin độc lập.

## Bật nhanh

Thêm override cho service `dsh-tui` trong profile patch:

```text
$DSH_HOME/profiles/dsh-tui/cordis.patch.yml
```

Ví dụ tối thiểu:

```yaml
- id: dsh-tui
  config:
    autoContinue: true
```

Ví dụ đầy đủ:

```yaml
- id: dsh-tui
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
    effort: max
    activity: true
    contextBar: true
    fullscreen: false

    autoContinue: true
    autoContinueText: >-
      Tiếp tục một cách thận trọng. Chỉ tiếp tục phần việc đang làm dở đã được phê duyệt hoặc đã yêu cầu. Nếu tin nhắn trước đó của assistant là kế hoạch, đề xuất, câu hỏi, hoặc đang chờ người dùng phê duyệt, không triển khai; hãy nói rằng bạn đang chờ quyết định của người dùng.
    autoContinueGraceMs: 3000
    autoContinueCooldownMs: 20000
    autoContinueMaxConsecutive: 3
    autoContinueOnMaxTokens: true
```

Lưu ý: `config` của một row là thay thế toàn bộ, không deep-merge. Nếu override `id: dsh-tui`, hãy giữ lại các field đang cần dùng như `provider`, `model`, `effort`, `activity`, `contextBar`, `fullscreen`, `preset`, `workspace`, `sessionId`.

## Các trường cấu hình

| Field | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `autoContinue` | `false` | Bật/tắt auto-continue. |
| `autoContinueText` | prompt guard tiếng Việt | Nội dung message tự gửi. Mặc định yêu cầu chỉ tiếp tục phần đang làm dở đã được phê duyệt/yêu cầu và không triển khai nếu assistant trước đó đang chờ quyết định của user. |
| `autoContinueGraceMs` | `3000` | Thời gian chờ trước khi gửi message, tính bằng mili giây. |
| `autoContinueCooldownMs` | `20000` | Khoảng cách tối thiểu giữa hai lần auto-continue liên tiếp. |
| `autoContinueMaxConsecutive` | `3` | Số lần auto-continue liên tiếp tối đa trước khi có một turn hoàn tất thành công. |
| `autoContinueOnMaxTokens` | `true` | Có tự tiếp tục khi turn kết thúc vì `max-tokens` hay không. |

## Luồng hoạt động

`dsh-tui` lắng nghe live event `turn/end` của session hiện tại. Nó không quét lại lịch sử session và không gửi tiếp từ event replay.

Khi nhận `turn/end`, logic xử lý như sau:

```text
turn/end
  ├─ completed       → reset bộ đếm
  ├─ aborted         → bỏ qua
  ├─ interrupted     → bỏ qua
  ├─ blocked         → bỏ qua
  ├─ max-tokens      → chờ grace → gửi autoContinueText
  └─ error
       ├─ transient  → chờ grace → gửi autoContinueText
       └─ permanent  → bỏ qua
```

Trước khi gửi, scheduler kiểm tra lại các guard:

- agent vẫn là agent đã tạo lịch gửi;
- session vẫn là session đã tạo lịch gửi;
- TUI không còn ở trạng thái `working`;
- không có message khác đang pending;
- chưa vượt cooldown;
- chưa vượt `autoContinueMaxConsecutive`.

Nếu một guard không còn đúng, auto-continue sẽ bị bỏ qua thay vì gửi nhầm vào session hoặc turn khác.

## Lỗi nào được xem là transient

Auto-continue chỉ chạy với lỗi có khả năng retry. Ví dụ:

- timeout hoặc network error;
- connection reset/refused;
- rate limit hoặc too many requests;
- HTTP `408`, `409`, `425`, `429`;
- HTTP `5xx`;
- code như `ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`, `RATE_LIMIT`, `TIMEOUT`, `SERVER`, `TRANSPORT`, `OVERLOADED`, `SERVICE_UNAVAILABLE`.

## Lỗi nào bị xem là permanent

Các lỗi permanent không được auto-continue để tránh loop vô ích:

- sai hoặc thiếu API key;
- unauthorized/forbidden;
- quota, balance, billing, insufficient credit;
- model không tồn tại;
- context length exceeded hoặc too many tokens;
- HTTP `4xx` không thuộc nhóm retryable ở trên.

Khi gặp lỗi permanent, UI hiện notice kiểu:

```text
Auto-continue skipped: permanent error
```

## Notification trong UI

Khi bật, UI có thể hiện các notice sau:

| Notice | Khi nào xuất hiện |
| --- | --- |
| `Auto-continue scheduled in Ns (...)` | Đã phát hiện lỗi retryable hoặc `max-tokens`, đang chờ grace. |
| `Auto-continue sent (n/max)` | Đã gửi message tự động. |
| `Auto-continue failed · ...` | Gọi `agent.followup` thất bại. |
| `Auto-continue reached the max consecutive limit (...)` | Đã vượt giới hạn liên tiếp. |
| `Auto-continue cooldown active (...)` | Gặp lỗi tiếp theo quá gần lần tự gửi trước. |
| `Auto-continue skipped: permanent error` | Lỗi được phân loại là permanent. |

## Giới hạn hiện tại

- Không có slash command riêng để bật/tắt runtime; chỉnh qua `cordis.patch.yml` rồi khởi động lại profile.
- Không phải plugin độc lập. Module policy nằm ở `src/dsh-adapter/autoContinue.ts`, nhưng vẫn cần hook mỏng trong `src/dsh-adapter/channel.ts` để nghe live event và gọi `agent.followup`.
- Không retry turn bị user abort/interrupted/blocked.
- Không gửi nếu TUI đang working hoặc còn pending message khác, để giảm rủi ro chen ngang thao tác của user.
- Không đảm bảo mọi tool call trước đó là idempotent. Mặc định `autoContinueText` đã là prompt guard:

```yaml
autoContinueText: >-
  Tiếp tục một cách thận trọng. Chỉ tiếp tục phần việc đang làm dở đã được phê duyệt hoặc đã yêu cầu. Nếu tin nhắn trước đó của assistant là kế hoạch, đề xuất, câu hỏi, hoặc đang chờ người dùng phê duyệt, không triển khai; hãy nói rằng bạn đang chờ quyết định của người dùng.
```

## Gợi ý cấu hình an toàn

Cấu hình cân bằng cho sử dụng hằng ngày:

```yaml
autoContinue: true
autoContinueText: >-
  Tiếp tục một cách thận trọng. Chỉ tiếp tục phần việc đang làm dở đã được phê duyệt hoặc đã yêu cầu. Nếu tin nhắn trước đó của assistant là kế hoạch, đề xuất, câu hỏi, hoặc đang chờ người dùng phê duyệt, không triển khai; hãy nói rằng bạn đang chờ quyết định của người dùng.
autoContinueGraceMs: 3000
autoContinueCooldownMs: 20000
autoContinueMaxConsecutive: 3
autoContinueOnMaxTokens: true
```

Nếu chỉ muốn tiếp tục khi model chạm giới hạn token, không muốn retry lỗi provider:

```yaml
autoContinue: true
autoContinueOnMaxTokens: true
autoContinueMaxConsecutive: 1
```

Hiện chưa có mode tách riêng “max-tokens only”; nếu cần chính xác tuyệt đối, cần bổ sung thêm field cấu hình mới ở source.
