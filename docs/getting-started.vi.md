buil 

# Cài đặt, build và chạy local

Tài liệu này hướng dẫn cách **build bản release từ mã nguồn của repo này và dùng
nó**, kèm đường cài nhanh từ npm và cách chạy bản local khi phát triển. Nội dung
là bản dịch/hướng dẫn tiếng Việt của [安装与快速开始](getting-started.md).

## Yêu cầu tiền đề

| Thành phần | Yêu cầu                             | Ghi chú                                                                                                                                                                         |
| ------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js      | `^22.19 \|\| >=24`                    | CI sử dụng Node 24. Phiên bản thấp hơn 22.19 có thể install được (pnpm chỉ cảnh báo) nhưng không được hỗ trợ.                                               |
| pnpm         | **10 trở lên** (CI dùng 11)  | pnpm 9 làm profile không resolve được transitive dependency`dsh-working-activity`, dẫn đến TUI thoát ngay sau khi khởi động gần như không có lỗi (issue #60). |
| dsh CLI      | `@deepseek-ai/dsh`                  | CLI chính thức của DeepSeek Harness.                                                                                                                                          |
| Terminal     | TTY hỗ trợ nhập liệu tương tác | `dsh-tui` không chạy được khi stdout bị redirect ra file hoặc pipeline.                                                                                                 |
| API key      | `DEEPSEEK_API_KEY`                  | Bắt buộc để chạy model. Với endpoint tùy chỉnh có thể set thêm`DEEPSEEK_BASE_URL`.                                                                                  |

macOS/Linux:

```sh
export DEEPSEEK_API_KEY='your-key'
```

PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = 'your-key'
```

Không commit key thật vào repo. Profile bình thường đọc trực tiếp từ biến môi
trường khi khởi động.

## Build bản release từ source và dùng

Mục tiêu phần này: build chính repo này thành gói release rồi cài vào profile dsh
và dùng ngay. Tất cả chỉ 5 lệnh, chạy trong thư mục repo:

```sh
# 0. Nếu chưa clone (kéo luôn 2 submodule dsh-ecosystem-spec, vendor/dsh-std):
git clone --recurse-submodules https://github.com/ccch1mneyyy/dsh-TUI.git
cd dsh-TUI

pnpm install --frozen-lockfile   # 1. cài dependencies
pnpm build                       # 2. compile src -> lib/types + chạy verify gate
npm pack                         # 3. đóng gói thành deepseek-harness-tui-dsh-tui-0.8.1.tgz
dsh plugin --profile dsh-tui add ./deepseek-harness-tui-dsh-tui-0.8.1.tgz   # 4. cài vào profile
dsh --profile dsh-tui            # 5. chạy (cần DEEPSEEK_API_KEY trong shell)
```

Ghi chú:

- Bước 4 chuyển tiếp sang `pnpm add` nên chấp nhận đường dẫn tarball local. Sau
  bước 4, lệnh `dsh-tui` cũng chạy được — tương đương `dsh --profile dsh-tui`.
- Tên tarball sinh từ `package.json` version (hiện tại `0.8.1`); nếu version
  khác thì dùng đúng tên file `npm pack` in ra.
- Node cần `^22.19 || >=24` (CI dùng 24). Nếu build lỗi liên quan engine, nâng
  Node trước, ví dụ với asdf: `asdf install nodejs 24.10.0 && asdf local nodejs 24.10.0`.
- Clone xong mà `dsh-ecosystem-spec`/`vendor/dsh-std` trống:
  `git submodule update --init --recursive`.
- `pnpm build` = `compile` (build `vendor/dsh-std` → xóa `lib/` → `tsc -p tsconfig.json`)
  + `verify:build` (17 script verify: boundary, contract, manifest-deps,
    patch-surface, plugin-spec/grants/storage/messages/ledger/commands/negotiation/
    lifecycle, packaged-presets, minimal-preset-tools, liangshen-bootstrap,
    activity-i18n). `lib/types/` là thư mục generate bị ignore khỏi git.
- Muốn chạy smoke test sau build: `pnpm smoke`.

## Cài nhanh từ npm (không cần build)

Đường nhanh nhất — cài global CLI + plugin, plugin tự mang theo lệnh `dsh-tui`:

```sh
# CLI chính thức + plugin này
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# Nếu chưa có pnpm (lần chạy đầu tự khởi tạo profile cần pnpm):
npm install -g pnpm
# hoặc: corepack enable pnpm

# Khởi động: lần đầu tự chạy dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<phiên bản>
dsh-tui
```

Các bước thủ công tương đương:

```sh
npm install -g @deepseek-ai/dsh
npm install -g pnpm   # nếu chưa có
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui
dsh --profile dsh-tui   # hoặc dsh-tui
```

Từ bản checkout của repo cũng có thể chạy:

```sh
sh install.sh
```

`install.sh` chỉ bọc lệnh profile plugin và kiểm tra `dsh`, `pnpm` có sẵn hay
không; nó không copy mã nguồn và không cần build local.

### Lệnh install làm gì

Lần đầu chạy `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`,
CLI chính thức sẽ:

1. Khởi tạo profile tại `$DSH_HOME/profiles/dsh-tui/` (mặc định `~/.dsh` khi
   chưa set `DSH_HOME`).
2. Dùng `@deepseek-ai/dsh-base` làm bundle tầng đầu của profile.
3. Cài `@deepseek-harness-tui/dsh-tui` trong profile bằng pnpm.
4. Đọc metadata `dsh.bundle.patch` trong package và thêm `cordis.patch.yml`
   làm tầng ghép.

Thứ tự khởi động:

```text
dsh-base -> các bundle khác -> @deepseek-harness-tui/dsh-tui patch -> user profile patch
```

`dsh-working-activity` đã là dependency của package này và được patch của
dsh-tui tự động chèn vào. Đừng `add dsh-working-activity` riêng cho cùng một
profile, nếu không sẽ bị trùng dòng.

## Chạy bản local khi phát triển

Khi sửa code trong repo này, dùng các lệnh dev — chúng đi qua đúng đường profile
giống người dùng cài:

```sh
pnpm dev:copy-config   # lần đầu / sau khi đổi key hoặc config
pnpm dev               # build -> đóng gói -> cài profile isolated -> mở TUI
```

- `pnpm dev:copy-config` chỉ copy `~/.dsh/settings.yaml` và
  `~/.dsh/.credentials.yaml`. Unix set quyền `0600`; Windows dùng ACL do hệ
  thống quản lý.
- `pnpm dev` dùng `HOME`, `DSH_HOME` và thư mục session **riêng**, không đụng
  `~/.dsh/profiles/dsh-tui`, `~/.dsh-tui` hay session chính thức. Thư mục test
  mặc định: `$XDG_CACHE_HOME/dsh-tui-dev` (Unix, mặc định `~/.cache/dsh-tui-dev`),
  `%LOCALAPPDATA%\dsh-tui-dev` (Windows); có thể ghi đè bằng `DSH_TUI_DEV_ROOT`.
- Chỉ muốn verify build/đóng gói/install mà không mở TUI:
  ```sh
  pnpm dev:test
  ```
- CI còn chạy 3 regression render:
  ```sh
  node --import tsx/esm scripts/repro-askpanel.tsx
  node --import tsx/esm scripts/verify-askpanel-layout.tsx
  node --import tsx/esm scripts/repro-toolcards.tsx
  ```
- `pnpm tui` (gọi `scripts/run.ts`) ghép trực tiếp source patch của DeepSeek
  Harness và mặc định giả định package nằm trong layout `packages/*` của Harness
  monorepo; với standalone checkout cần set `DSH_TUI_DEV_WORKSPACE` trỏ tới
  root của Harness. Khi chỉ test mã nguồn repo này, ưu tiên `pnpm dev` ở trên.

## Cập nhật lên phiên bản mới nhất

Lệnh install tái sử dụng để update, chỉ định rõ `@latest`:

```sh
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@latest
```

- Không có `@latest`, pnpm resolve theo range version đã ghi trong
  `package.json` của profile (ví dụ `^0.1.4`) và có thể đứng yên trên nhánh cũ.
- Kiểm tra phiên bản hiệu lực: góc phải banner khởi động hiển thị
  `✦ dsh-TUI vX.Y.Z`.
- Tầng override `cordis.patch.yml` của user được giữ nguyên khi update.

## Cấu hình profile

File override của user:

```text
$DSH_HOME/profiles/dsh-tui/cordis.patch.yml
```

Khi cấu hình một node, block `config` là thay thế toàn bộ, không deep-merge
theo từng field — khi copy ví dụ cần giữ các field vẫn còn hiệu lực. Chi tiết
xem [配置参考](configuration.md).

`cordis.yml` ở root repo là ví dụ combo trần; với install npm/profile chính
thức thì dùng `cordis.patch.yml`, không cần copy config root vào profile.

## Khởi động

```sh
dsh --profile dsh-tui
```

Lệnh khởi động từ thư mục hiện tại nên workspace mặc định của Agent cũng là
thư mục đó. Vào thư mục project muốn làm việc rồi mới chạy.

Windows bản checkout còn có:

```bat
dsh-tui.cmd
dsh-tui.cmd --resume
```

`--resume` đọc `%USERPROFILE%\.dsh-tui\resume.txt` để khôi phục session gần
nhất; file này được ghi kép sang `%USERPROFILE%\.dsh-cc\resume.txt` cho launcher
cũ. Set `DSH_TUI_WORKSPACE` để ghi đè thư mục làm việc của batch launcher.

## Câu hỏi thường gặp

### `dsh-tui requires an interactive terminal`

stdout không phải TTY. Chạy trực tiếp trong terminal, đừng pipe output chính
ra file hoặc lệnh khác.

### Không tìm thấy `dsh` hoặc `pnpm`

Xác nhận thư mục global npm bin nằm trong `PATH` và mở lại terminal. `install.sh`
kiểm tra 2 lệnh này trước khi cài.

### Khởi động xong thoát ngay, gần như không có lỗi (pnpm 9)

Với pnpm 9, transitive dependency `dsh-working-activity` không được hoist tới
vị trí loader resolve được; module resolution fail khiến cả cây plugin bị thu
hồi, TUI in hint resume rồi thoát (issue #60). Nâng pnpm lên 10+ rồi cài lại:

```sh
npm install -g pnpm@latest
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@latest
```

### Model không khởi động hoặc báo thiếu credential

Xác nhận `DEEPSEEK_API_KEY` tồn tại trong cùng shell đã chạy `dsh`. Endpoint
tùy chỉnh kiểm tra thêm `DEEPSEEK_BASE_URL`.

### Trùng dòng trạng thái làm việc

Kiểm tra profile có từng add riêng `dsh-working-activity` hay không. Giữ dòng
`working-activity` do patch của package này tự chèn, bỏ config bundle trùng.

### TUI hiển thị lệch hoặc trạng thái bất thường sau khi thoát terminal

Chạy `/doctor`, ghi lại loại terminal và mode, rồi tham khảo
[交互文档](interaction.md) và [架构文档](architecture.md). Vấn đề render có thể
dùng `DSH_TUI_RENDER_LOG` để thu frame thô, nhưng log có thể chứa nội dung
session — cần xử lý cẩn thận.
