# SVS Viewer · 病理切片查看与分享平台

[English](#english) | [中文](#中文)

一个自托管的全切片病理图像（WSI）查看器：在内网以"项目"管理 SVS/TIFF 等切片，
框选固定物理尺寸（6×6mm / 6.5×6.5mm）的 ROI 并导出全分辨率截图，
还能生成**限时、只读**的 HTTPS 分享链接发给外部用户；外部用户署名标注 ROI，
标注实时回传内网供管理员查看。

A self-hosted whole-slide pathology image viewer with project-based slide management,
physical-size ROI selection (6mm / 6.5mm) and full-resolution export, plus time-limited,
view-only share links with named ROI annotations that flow back to admins.

![share page](docs/screenshot-share.jpg)

---

## 中文

### 功能

- **WSI 查看**：OpenSlide + OpenSeadragon Deep Zoom，支持 svs / tif / tiff / ndpi / mrxs / vms / vmu / scn / bif / svslide 等格式，滚轮缩放、拖拽平移、旋转、双击放大
- **OME-TIFF 支持**：OpenSlide 打不开的（OME-）TIFF 自动回退到内置 tifffile+zarr 阅读器（`slide_io.py`），识别 SubIFD 金字塔并解析 OME-XML 的 PhysicalSize（mpp）；MRXS 等多文件格式连同数据目录打包 zip 上传，服务端安全解压
- **管理员登录（可选）**：设置 `ADMIN_PASSWORD` 后管理端启用账号密码登录（session 7 天、IP 防爆破锁定）；与分享端同端口路径分流（`/s/...` 走分享页，其余走管理门户），外网一个 HTTPS 端口即同时提供分享与管理员入口
- **项目管理**：切片按项目分组（一个项目 = 一个用户/批次的一组切片），未归类切片单列
- **ROI 选区**：固定物理尺寸 6mm / 6.5mm 方框（边长像素 = mm × 1000 / mpp），随缩放锚定、可拖动；一键导出 level-0 全分辨率 PNG
- **mpp 真实坐标尺**：依次读取厂商元数据 → TIFF 分辨率标签 → 倍率估算 → 手动输入
- **限时分享**：管理员勾选多张切片或整个项目 → 选时效（6h/24h/3d/7d/自定义）→ 生成只读链接；外部用户**只能**看到被分享的切片集，无上传/删除
- **署名标注**：分享用户填标签后保存 ROI 位置（存服务端），管理员在内网按切片/项目查看"被谁标记了几处"，点击跳转定位、或一键叠加全部标注框（按署名人着色）
- **手机 UI**：分享页响应式 + 触屏捏合缩放
- **性能**：512px 渐进式 JPEG 瓦片、服务端 LRU 瓦片缓存、immutable 浏览器缓存、缩略图底图层（慢网不白屏）、macOS 风格管理界面

### 架构

```
┌────────────┐  内网   ┌─────────────────┐
│ 管理员浏览器 │ ──────→ │ app.py   (:8000) │  管理端：上传/项目/分享/标注
└────────────┘        └────────┬────────┘
                               │ 共享 uploads/ 与 share-data/(flock JSON)
┌────────────┐  公网   ┌────────┴────────┐
│ 分享用户浏览器│ ──────→ │share_server(:38000)│ 只读分享端（可开 TLS）
└────────────┘        └─────────────────┘
```

两个进程共享：切片目录 `uploads/`（分享端只读）、`share-data/shares.json`
（项目/分享/标注，fcntl.flock 互斥）。公网暴露可配合 frp/nginx/caddy 等任意反向代理。

### 快速开始

#### 方式一：pip + venv

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt   # openslide-bin 自带动态库，无需系统安装

mkdir -p uploads share-data
python app.py                     # 管理端 http://localhost:8000
python share_server.py            # 分享端 http://localhost:38000（另开终端）
```

#### 方式二：Podman / Docker（推荐，含开机自启示例）

```bash
podman build -t svs-viewer -f Containerfile .

# 管理端
podman run -d --name svs-viewer -p 8000:8000 \
  -v $PWD/uploads:/data/uploads:Z \
  -v $PWD/share-data:/data/share:Z \
  -e SHARE_BASE_URL=https://slides.example.com:18767 \
  svs-viewer

# 分享端（只读挂载切片；TLS 可选）
podman run -d --name svs-share -p 38000:38000 \
  -v $PWD/uploads:/data/uploads:ro,Z \
  -v $PWD/share-data:/data/share:Z \
  -v $PWD/certs:/data/certs:ro,Z \
  -e SHARE_TLS_CERT=/data/certs/fullchain.crt \
  -e SHARE_TLS_KEY=/data/certs/privkey.key \
  svs-viewer python share_server.py
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8000 | 管理端端口 |
| `SHARE_PORT` | 38000 | 分享端端口 |
| `UPLOAD_DIR` | `~/svs-viewer/uploads`（容器内 `/data/uploads`） | 切片目录 |
| `SHARE_DATA_DIR` | `~/svs-viewer/share-data`（容器内 `/data/share`） | 项目/分享/标注数据 |
| `SHARE_BASE_URL` | `http://localhost:38000` | 生成分享链接的外部访问前缀 |
| `SHARE_TLS_CERT` / `SHARE_TLS_KEY` | — | 提供后分享端直接以 HTTPS 运行 |
| `ADMIN_USERNAME` | `browser_admin` | 管理员登录用户名 |
| `ADMIN_PASSWORD` | — | 设置后管理端启用登录认证（内网同样需要） |
| `SECRET_KEY` | 自动生成并持久化到数据目录 | Flask session 密钥 |
| `JPEG_QUALITY` | 82 | 瓦片 JPEG 质量 |
| `TILE_CACHE_MAX` | 3000 | 服务端瓦片缓存片数 |
| `TILE_CACHE_TTL` | 3600 | 分享端瓦片缓存 TTL（秒） |

### 使用

1. **上传**：管理端左侧"上传切片"或拖拽文件到查看区；MRXS 等多文件格式请把 `.mrxs` 与同名数据目录打包成 zip 上传；也可直接拷入 `uploads/` 刷新即可
2. **建项目**："＋新建项目" → "＋切片"把切片归入项目
3. **分享**：项目行悬停点 ↗（或勾选切片分享）→ 选时效 → 复制链接发给用户
4. **标注回流**：用户打开链接 → 填"标记人/标签" → 框 ROI → 保存选区；管理员在切片行看到"标记 N·M 人"徽章，点"标记"面板跳转定位，或"显示全部标记"叠加全部框

### AI 读片助手（仅管理员）

工具栏的「✨ AI」按钮打开 AI 读片助手面板，让大模型通过 OpenAI 兼容的 function-calling 接口操控虚拟显微镜：自动从低倍概览扫描、抓取快照、落矩形标注并给出中文总结。

**配置**（首次使用）：
1. 在 AI 面板的「设置区」填写：
   - **Base URL**：OpenAI 兼容端点，如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1` 等（不含 `/chat/completions` 后缀，程序会自动拼接）
   - **API Key**：对应服务的密钥（如 `sk-...`）
   - **模型**：支持 vision + tool-calling 的模型，如 `gpt-4o`、`gpt-4o-mini` 等
2. 点「保存配置」。配置写入数据目录下的 `ai_config.json`（与 `flask_secret.key` 同目录，即 `SHARE_DATA_DIR` 或 `~/svs-viewer/share-data/`），文件权限 `0600`，**API Key 不入日志**。
3. GET `/api/ai/config` 回显时 API Key 脱敏为「前4 + \*\*\*\* + 后4」掩码（`api_key_set: true` + `api_key_mask`），不回显明文；PUT 时空串=清除、与掩码同值=不变。

**使用**：
- 打开任一切片后，在 AI 面板的任务框输入指令（如「扫一遍这张片，标出可疑区域并总结」），点「开始」。
- 「判读当前选区」快捷钮会把当前 ROI 框或选中标注的 level-0 坐标写进任务前缀，引导 AI 重点看该区域。
- 运行中以 SSE（`text/event-stream`）实时推送轨迹：`slide_opened` / `agent_thinking` / `text_delta` / `tool_started` / `snapshot_captured` / `observation` / `annotation_created` / `agent_finished` / `agent_error`。`snapshot_captured` 只推 bbox 与放大倍率（不推图像 base64，省带宽），点击该行可跳转到对应区域。
- AI 的每个视口在画布上以**青色虚线框**叠加（区别于人工标注的金色实线框）；AI 落的标注会写入标注库（label「AI 建议」），出现在现有标注层与「标记」面板，管理员可正常编辑/删除。
- 「开始」可切为「停止」中途中断（AbortController）；同时只允许一个 run。

**约束**：
- 所有 `/api/ai/*` 与 `/api/slide/<name>/region` 走现有 `_require_auth`，仅管理员可用。
- AI 调用 OpenAI 兼容端点的请求在服务端发出（`requests` 库），不暴露 Key 给前端。
- 图像预算：messages 中只保留最近 3 张快照的 image content，更早的降级为 `[image omitted]`，控制 token 消耗。

### 安全说明

- 分享端所有路由都校验 token（存在/未撤销/未过期）且切片属于该分享，否则一律 404
- 分享端只读：无上传、无删除、无切片列表之外的任何信息
- 分享链接建议经 HTTPS 暴露（`SHARE_TLS_*` 或前置反代），避免明文 token 被窃听
- 管理端暴露到公网时务必设置 `ADMIN_PASSWORD`（登录认证 + IP 连续失败锁定），并经由分享端 TLS 监听（同端口路径分流）以 HTTPS 提供

---

## English

### Features

- **WSI viewing**: OpenSlide + OpenSeadragon Deep Zoom (svs/tif/tiff/ndpi/mrxs/vms/vmu/scn/bif/svslide), wheel zoom, pan, rotate
- **OME-TIFF support**: (OME-)TIFF files OpenSlide cannot read fall back to a built-in tifffile+zarr reader (`slide_io.py`) with SubIFD pyramid and OME-XML PhysicalSize (mpp) parsing; multi-file formats like MRXS are uploaded as a zip and extracted safely server-side
- **Optional admin login**: set `ADMIN_PASSWORD` to gate the admin UI behind username/password (7-day session, per-IP lockout); the share server path-routes the same port (`/s/...` → share pages, everything else → admin portal), so one external HTTPS port serves both
- **Projects**: organize slides into projects (one project = one client's slide set)
- **Physical ROI**: fixed 6mm / 6.5mm squares anchored to image coordinates; export full-resolution PNG crops
- **Real scale (mpp)**: vendor metadata → TIFF resolution tags → objective-power estimate → manual input
- **Time-limited view-only shares**: share selected slides or a whole project; recipients see only the shared set
- **Named annotations**: recipients label and save ROI positions; admins see "marked N by M people" per slide, jump to each annotation, or overlay all boxes (colored by label)
- **Mobile UI**: responsive share page with pinch zoom
- **Performance**: 512px progressive-JPEG tiles, server-side LRU tile cache, immutable browser caching, thumbnail backdrop (no white flashes), macOS-style admin UI

### Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
mkdir -p uploads share-data
python app.py           # admin UI  → http://localhost:8000
python share_server.py  # share API → http://localhost:38000
```

Or with Podman/Docker — see the Chinese section above (commands are identical).

Expose the share server publicly behind any reverse proxy (frp/nginx/caddy) and set
`SHARE_BASE_URL` to the public URL so generated links point to it.

### Security

- Every share route validates the token (exists / not revoked / not expired) and slide
  membership; anything else returns 404
- The share server is strictly read-only
- Serve shares over HTTPS to protect tokens in transit
- When exposing the admin UI publicly, always set `ADMIN_PASSWORD` (login + per-IP
  lockout) and serve it via the share server's TLS listener (same port, path-routed)

## License

[MIT](LICENSE) © 2026 solarise94

## Acknowledgements

- [OpenSlide](https://openslide.org/) / [openslide-python](https://github.com/openslide/openslide-python)
- [OpenSeadragon](https://openseadragon.github.io/)
- Test slide: OpenSlide public test data (Aperio CMU-1)
