# 🚀 Claude Desktop (free) → OpenAI 兼容反代

<div align="center">

> **基于 Claude 官方桌面端（Claude Desktop）本地会话解密与逆向调度**  
> 将桌面端免费会话转化为标准 OpenAI 格式接口，支持多账号智能轮询、并发限流隔离、429 故障转移与开箱即用的现代化 WebUI 控制台。

[![Node.js](https://img.shields.io/badge/Node.js-22+-43853d.svg?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/Dependencies-Zero%20(0)-blue.svg?style=flat-square)](package.json)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-412991.svg?style=flat-square&logo=openai)](https://platform.openai.com/docs/api-reference)
[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-Community-2563eb.svg?style=flat-square)](https://linux.do/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[功能特性](#-核心特性) • [技术原理](#-为什么是桌面端解密逆向) • [快速上手](#-快速上手) • [Docker 部署](#-docker-部署) • [客户端接入](#-主流客户端接入) • [常见问题](#-常见问题--faq)

</div>

---

## 💡 为什么是桌面端解密逆向？

如果你尝试过官方商业 API 或 CLI 路线，就会发现免费个人账号是无法直接获取通用 API 权限的：

| 探索路径 | 官方响应 / 实际结果 | 适用场景 |
| :--- | :--- | :--- |
| **官方商业 API** (`api.anthropic.com/v1/messages`) | `403 oauth_not_allowed_for_organization` | 仅限绑卡付费组织 |
| **Claude Code CLI** (`claude auth login`) | 提示「连接 Claude Code 需要 Max、Ultra 或 Pro 套餐」 | 仅限付费订阅用户 |
| **网页端抓包 Cookie** | 频繁受制于 Cloudflare 动态人机验证与 Cookie 过期 | 容易频繁失效与掉线 |
| **Claude Desktop 本地凭据解密** | **✅ 成功获取完整合法长效会话、cf_clearance 与配套 UA** | **免费可用、协议完整、稳定长效** |

### 桌面端解密链 (Windows)

Claude 官方桌面端基于 Electron 架构，登录凭据使用 Windows 系统级安全服务加密保存在本地数据目录：`%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc`。

本项目内置全自动本地解密工具（[tools/desktop_session.py](tools/desktop_session.py)）：
```text
Local State (os_crypt.encrypted_key) 
    └──> Windows DPAPI (CryptUnprotectData) 
          └──> AES-256-GCM Master Key 
                └──> 解密 Cookies.sqlite (encrypted_value) 
                      └──> 提取 sessionKey、cf_clearance 与配套合法 Electron UA
```
提取完成后，反代服务利用合法桌面端环境向官方接口保持通信，完整模拟桌面端会话协议，平滑转换为通用标准的 OpenAI 格式。

---

## 🌟 核心特性

- **⚡ 零第三方 npm 依赖 (Zero Dependencies)**  
  全项目基于 Node.js 原生 ESM 模块体系开发，采用内置 `fetch`、`WebSocket` 与 `crypto`。无任何臃肿依赖包，轻量秒启，审计安全透明。
- **🔌 100% OpenAI 协议全兼容**  
  标准 `/v1/chat/completions` 与 `/v1/models`，支持流式输出 (`stream: true`)、非流式输出、工具调用 (`tools`) 与多轮上下文。无缝接入各类生态客户端与应用。
- **🎯 工业级多账号智能调度池**：
  - **多策略调度**：支持 `least-loaded`（基于 5 小时窗口负载动态权重最优调度）与 `round-robin`（严格轮询）。
  - **两级 429 智能区分**：
    - **瞬时并发 429**：毫秒级退避并自动换号重试，绝不误杀账号。
    - **配额耗尽 429**：自动解析上游 `resets_at` 到期时间，自动冷却移出活动池，到期自动回池复活。
  - **动态容错与 Failover**：单一账号遇阻（如速率限制、异常中断）自动秒级换号接力，保障调用方 0 感知。
  - **低额度避让**：5h/7d 配额剩余低于阈值（如 20%）时自动切至备用账号，保护主力调用。
  - **客户端断连立即中止**：调用方主动中断时，代理立即发送 `AbortSignal` 终止上游请求，绝不白白消耗账号 Token 额度。
- **🖥️ 现代化开箱即用 WebUI 控制台**：
  - 反代内置 Web 服务（访问 `http://127.0.0.1:8787`），无需额外部署任何前端服务。
  - 实时可视化查看账号健康状态、配额占用、TPS 速度、请求历史流式日志。
  - **🔗 自动化链接登录**：一键拉起独立隔离浏览器登录 Claude，后台自动捕获 `sessionKey` 并入池。
- **📥 纯 sessionKey 多格式免密导入**：
  - 仅需提供 `sessionKey`，**绝不索取、不需要任何邮箱或密码**。
  - 自动兼容纯文本每行一个、JSON 对象、JSON 数组、JSONL 以及整段 Cookie，自动验活并分配组织 Org。
- **🖼️ 多模态图文对齐**：
  - 支持多轮历史对话中的多张图片智能提取、排重与时间序列对齐。
- **📊 真实 TPS 纠偏统计**：
  - 精准过滤上游长连接握手与 Keep-Alive 挂起延迟，准确计算实际吐字速率。

---

## 📂 项目结构

```text
claude-free-proxy/
├── src/                          # 核心代理服务源码
│   ├── openai-proxy.mjs          # 主服务入口（OpenAI 兼容路由、WebUI 托管、调度总控）
│   ├── accounts.mjs              # 账号池管理器（负载调度、冷却阶梯、配额监控）
│   ├── config.mjs                # 配置中心与多 API Key 权限鉴权管理
│   ├── kyc.mjs                   # 账号 KYC 与风控封禁状态嗅探
│   ├── login-link.mjs            # 自动化浏览器登录托管与输入调度模块
│   ├── quota-probe.mjs           # 官方上游配额主动嗅探
│   └── usage-log.mjs             # 请求流水与 Token 统计日志
│
├── web/                          # 前端单页面应用
│   └── webui.html                # 现代化 Web 管理控制台
│
├── tools/                        # 实用工具与辅助脚本
│   ├── desktop_session.py        # Claude Desktop 本地会话解密提取工具 (DPAPI+AES)
│   ├── accounts.ps1              # 命令行账号池快捷维护脚本
│   └── probe_upstream_timing.mjs # 上游连接与网络延迟分析工具
│
├── tests/                        # 单元测试与端到端回归测试套件
│   ├── test_accounts.mjs         # 账号池冷却与轮询调度测试
│   ├── test_multi.mjs            # 多账号高并发与 Failover 测试
│   └── test_pool_429.mjs         # 429 自动冷却熔断与恢复测试
│
├── config/                       # 安全脱敏配置模版
│   ├── accounts.example.json     # 账号池模版
│   └── config.example.json       # 系统配置模版
│
├── start.cmd                     # Windows 双击无痛启动脚本
├── start.mjs                     # 跨平台启动协调器与端口检测
├── Dockerfile                    # Docker 容器镜像构建文件
├── docker-compose.yml            # Docker-Compose 一键编排配置
└── README.md                     # 本说明文档
```

---

## 🚀 快速上手

### 环境需求
- **Node.js**: `v22.0.0` 或更高版本（全项目零第三方 npm 依赖，开箱即用）。
- **Python 3** *(可选)*: 仅在 Windows 下运行本地 Claude 桌面端自动解密脚本时需要（使用原生内置模块）。

### 1. 克隆并启动

```bash
git clone https://github.com/suimi8/claude-free-proxy.git
cd claude-free-proxy
```

#### Windows 用户：
直接双击根目录下的 **`start.cmd`** 即可。也可以使用命令行参数：
```cmd
start.cmd          # 默认本机模式 (监听 127.0.0.1:8787)
start.cmd lan      # 局域网接入模式 (监听 0.0.0.0:8787)
start.cmd pack     # 自动打包归档（安全排除本地隐私配置与日志）
```

#### Linux / macOS 用户：
```bash
node start.mjs
# 或允许局域网其他设备访问
node start.mjs lan
```

首次启动服务会自动在根目录生成 `config.json`，并自动生成默认的鉴权 API Key 并打印在终端控制台中。

---

### 2. 账号录入与获取方式

服务启动后，在浏览器中打开内置控制台：
👉 **http://127.0.0.1:8787**

> 💡 **账号来源与快速获取**：
> - **优先自建**：推荐优先使用您自己的日常个人账号（完全免费，通过下方方式 A 或方式 B 录入）。
> - **应急测试/补给渠道**：如果您缺少多账号环境或仅用于临时开发测试，可参考作者提供的应急测试凭据通道（Base64 编码）：
>   ```text
>   aHR0cHM6Ly93enlwLmNuL3Nob3AvOFdSQlBGSUI=
>   ```
>   *(获取后直接通过下方方式 C「批量导入」一键粘贴 sessionKey 即可秒速入池)*

你可以通过以下四种方式中的任意一种添加账号：

#### 方式 A：一键解密本机 Claude 桌面端（最推荐）
如果本机已安装并登录过官方 Claude 桌面端，在命令行中执行：
```powershell
python tools/desktop_session.py
```
脚本会自动解密当前桌面端会话并生成 `upstream.json`，反代启动时自动载入作为主力账号。

#### 方式 B：WebUI「🔗 链接登录」（自动化扩充池）
1. 在 WebUI 界面中点击 **「🔗 链接登录」**。
2. 系统自动唤起隔离浏览器并跳转官方登录页面。
3. 正常完成登录，后台自动捕获 `sessionKey`、Cookie 与配套 User-Agent 并自动入池。

#### 方式 C：批量导入 sessionKey（免密快速录入）
在控制台点击 **「📥 批量导入」**，直接粘贴 sessionKey 凭据，支持以下各种常见格式：
- 📝 **每行一个 sessionKey**（纯文本 TXT）
- 📦 **JSON 格式**（例如 `{"sessionKey": "sk-ant-sid02-..."}`）
- 📑 **JSON 数组**（例如 `[{"sessionKey": "..."}, ...]` 或 `["sk-ant-sid02-...", ...]`）
- 📄 **JSONL 格式**（每行一个独立 JSON 字符串）
- 🍪 **整段 Cookie 文本**（自动从中正则匹配提取 `sessionKey` 项）

> 🔒 **隐私提示**：本代理所有账号 Cookie、凭据、日志数据**完全存储在你的本地硬盘**，绝不进行任何形式的远程上报或云端同步。

#### 方式 D：手动单独录入
在 WebUI 页面点击「✎ 手动输入」，输入账号自定义备注与 `sessionKey` 即可。

---

## 🐳 Docker 部署

适合部署在 Linux VPS 或 NAS 环境中常驻运行：

### Docker Compose（推荐）

项目根目录已内置 `docker-compose.yml`，执行：

```bash
docker compose up -d
```

### Docker 运行命令

```bash
docker build -t claude-free-proxy .
docker run -d \
  --name claude-free-proxy \
  -p 8787:8787 \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/accounts.json:/app/accounts.json \
  --restart unless-stopped \
  claude-free-proxy
```

---

## 📱 主流客户端接入

在任意兼容 OpenAI API 的客户端或分发聚合系统（如 **NextChat / Cherry Studio / Cursor / Chatbox / 沉浸式翻译 / One-API / New-API**）中配置：

| 配置项 | 填写内容 |
| :--- | :--- |
| **接口地址 (Base URL)** | `http://127.0.0.1:8787/v1` （局域网/服务器请填真实 IP/域名） |
| **API Key** | 填写控制台展示的 API Key（在 WebUI 界面或 `config.json` 中配置） |
| **支持模型 (Models)** | `claude-3-7-sonnet` / `claude-3-5-sonnet` / `claude-3-5-haiku` |

### cURL 请求示例

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{
    "model": "claude-3-7-sonnet",
    "messages": [
      {"role": "user", "content": "你好，请用简短一句话介绍你自己"}
    ],
    "stream": true
  }'
```

### Python SDK 接入示例

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="sk-your-proxy-key"
)

response = client.chat.completions.create(
    model="claude-3-7-sonnet",
    messages=[{"role": "user", "content": "请写一段 Python 快速排序代码"}],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
```

---

## ⚙️ 账号池状态与健康调度

```text
               ┌───────────────────────────────┐
               │    客户端 OpenAI API 请求      │
               └──────────────┬────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │ 智能调度器 Picker  │
                    └─────────┬─────────┘
                              │
           ┌──────────────────┴──────────────────┐
           │                                     │
┌──────────▼──────────┐               ┌──────────▼──────────┐
│  least-loaded 最闲  │               │  round-robin 轮询   │
└──────────┬──────────┘               └──────────┬──────────┘
           │                                     │
           └──────────────────┬──────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  并发检查与配额校验 │
                    └─────────┬─────────┘
                              │
     ┌────────────────────────┼────────────────────────┐
     │ 触发瞬时并发限频        │ 5h 窗口配额耗尽         │ 成功响应
┌────▼────────────────┐ ┌─────▼────────────────┐ ┌─────▼────────────────┐
│ 1.5s 短暂退避        │ │ 计算 resets_at       │ │ 更新 Token 统计      │
│ 自动切换备选账号重试  │ │ 进入冷却池等待复活    │ │ 归还并发槽位         │
└─────────────────────┘ └──────────────────────┘ └──────────────────────┘
```

---

## ❓ 常见问题 / FAQ

<details>
<summary><b>Q: 提示「429 no eligible account available」怎么办？</b></summary>

出现该提示说明账号池中所有账号当前均处于冷却中或 5 小时额度窗口已耗尽。
- 代理会在响应中贴心标明最近一个账号的预计恢复时间。
- 建议通过 WebUI 批量导入多个 sessionKey，账号越多，池子的并发承载力和容灾抗压能力越高。
</details>

<details>
<summary><b>Q: 提示「403 oauth_not_allowed_for_organization」是什么原因？</b></summary>

这说明调用请求使用了官方商业 API 格式直接请求了 `api.anthropic.com`，而免费个人账号没有商业 API 权限。请务必将客户端 Base URL 指向本代理服务（`http://127.0.0.1:8787/v1`），由本代理转换为桌面端安全协议。
</details>

<details>
<summary><b>Q: 导入 sessionKey 安全吗？需要提供邮箱和密码吗？</b></summary>

**绝对不需要提供任何邮箱和密码！** 
- 仅需提供以 `sk-ant-sid02-` 开头的 `sessionKey`。
- 本项目开源透明，零外部第三方网络上报，全部数据加密持久化存储于你的本机。
</details>

<details>
<summary><b>Q: 如何获取更多账号凭据？</b></summary>

本项目推荐优先使用您自己的个人账号（通过桌面端一键解密或 WebUI 链接登录，完全免费）。  
如果您缺少多账号环境或仅用于临时开发测试，可参考作者提供的应急备用通道（Base64：`aHR0cHM6Ly93enlwLmNuL3Nob3AvOFdSQlBGSUI=`），获取后直接将 `sessionKey` 复制到控制台「批量导入」即可。
</details>

---

## 🔒 隐私与免责声明

1. **隐私安全**：本项目恪守本地化原则，`.gitignore` 默认强力屏蔽所有 `.env`、`accounts.json`、`config.json`、`upstream.json`、`*.log`，严防用户凭据外泄。
2. **开源免责**：本项目仅供计算机技术研究与学习交流使用。使用者应自行对使用行为负责，请在遵守当地法律法规及第三方平台服务条款的前提下合理使用。

---

## 💖 致谢 (Acknowledgements)

特别致谢 **[LINUX DO](https://linux.do/)** 社区以及各位热心佬友们在技术探索、逆向分析与高可用架构讨论中提供的宝贵经验、无私分享与灵感启发！

---

## 📄 开源许可证

本项目遵循 [MIT License](LICENSE) 许可证开放源代码。
欢迎提交 Issue 与 Pull Request 共同改进！
