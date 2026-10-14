# HomeMediaPlayer（HMP）

跑在 NAS 上的家庭娱乐中心：一个 Node.js 服务端 + 网页界面，局域网内任何设备打开浏览器就能用——影视、音乐、电子书、照片、网盘、AI 功能一锅端。

**全部功能免费**：无授权码、无功能限制、无试用期。

## 功能一览

- **影视库**：TMDB 自动刮削（海报 / 剧情 / 演员）、海报墙、剧集追更进度、多版本管理
- **音乐 / 电子书 / 照片**：分类浏览、封面、阅读器
- **网盘挂载**：基于 OpenList，支持阿里云盘等 9 家，挂载后当本地库一样刷
- **实时字幕**：FunASR 双引擎，支持多语种
- **人脸识别**：照片按人脸自动聚类
- **照片智能分类**：CLIP 模型，自然语言搜图
- **AI 助理**：自然语言搜片、查库、操作播放器
- **其他**：IP 访问白名单、qBittorrent 下载、WebDAV、远程访问、OTA 在线升级

## 快速开始

要求 **Node.js ≥ 22.5**（用了内置 `node:sqlite`，无需额外安装数据库）。

```bash
node server.js
```

浏览器打开 `http://<机器IP>:8080`，按引导页创建管理密码即可使用。

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HMP_PORT` | `8080` | 服务端口 |
| `HMP_DATA_DIR` | `./data` | 数据目录（数据库 / 设置 / 缓存） |
| `HMP_SS_DEVID` / `HMP_SS_DEVPASSWORD` | 内置默认 | ScreenScraper API 凭据（可选） |

## 目录结构

```
server.js          服务端入口
lib/               功能模块（tmdb 刮削 / asr 字幕 / faces 人脸 / openlist 网盘 / ota 升级…）
public/            前端（app.js / index.html / style.css / 播放器组件）
tools/             运维小工具（如重置管理密码）
vendor/ai/         AI 运行时依赖（onnxruntime-web WASM 版 + CLIP 分词器，已内置，请勿删除）
vendor/ai/models/  ONNX 模型存放位置（不随仓库分发，见下）
```

## AI 模型说明

人脸识别和 CLIP 搜图需要 ONNX 模型（共约 190MB）。仓库不含模型文件，首次使用对应功能时会**自动从 hf-mirror 下载**；也可以手动把 `face_det_10g.onnx`、`face_w600k_r50.onnx` 放进 `vendor/ai/models/` 或数据目录的 `ai/` 下。模型未就位时其他功能不受影响。

## NAS 部署

完整部署包（含 Node 运行时、安装向导、一键脚本）走既有发布渠道分发；已装机用户通过内置 OTA 升级，更新源地址 `https://hmp.tsetch.com/ota/manifest.json` 长期不变。

## 许可证

[GPL-3.0](LICENSE)
