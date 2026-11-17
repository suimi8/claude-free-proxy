# Claude Desktop (free) → OpenAI 兼容反代

> **基于 Claude 官方桌面端（Claude Desktop）本地会话解密与逆向反代**，将桌面端免费会话转化为标准 OpenAI 格式 API，支持多账号池轮询、并发限流、429 智能故障转移与开箱即用的 WebUI 控制台。

[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-blue.svg)](https://platform.openai.com/docs/api-reference)
[![Shop](https://img.shields.io/badge/%F0%9F%9B%92%20%E6%88%90%E5%93%81%E8%B4%A6%E5%8F%B7%E8%B4%AD%E4%B9%B0-%E7%A2%8E%E7%B1%B3%E7%9A%84%E5%B0%8F%E5%BA%97-orange.svg)](https://wzyp.cn/shop/8WRBPFIB)

> 🛒 **成品账号购买**：如果你需要现成、稳定、开箱即用的 Claude 官方账号或独享账号，欢迎前往小店选购：
> 👉 **[碎米的小店的小店 - 链动小铺](https://wzyp.cn/shop/8WRBPFIB)**（购买后获取 sessionKey 支持一键批量导入反代池，免去繁琐注册）

---

## 💡 为什么是 Claude Desktop（桌面端）逆向？

如果你尝试过官方 API 路线，就会发现免费账号是无法直接获取商业 API 权限的：

| 探索路径 | 实际结果 |
|---|---|
| 官方商业 API (`api.anthropic.com/v1/messages`) | `403 oauth_not_allowed_for_organization`（仅限付费套餐） |
| `claude auth login`（Claude Code 授权） | 提示「连接 Claude Code 需要 Max、Ultra 或 Pro 套餐」 |
| **Claude Desktop（桌面端）本地解密** | **✅ 成功获取完整合法会话与 Cookie** |

### 桌面端逆向与解密链

Claude 官方桌面端（Windows）基于 Electron 架构，用户的登录凭据被高强度加密保存在本地数据目录：`%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc`。

本项目内置了自动化解密工具（[tools/desktop_session.py](tools/desktop_session.py)），解密链如下：
```text
Local State (os_crypt.encrypted_key) 
    └──> Windows DPAPI (CryptUnprotectData) 
          └──> AES-256-GCM Key 
                └──> 解密 Cookies.sqlite (encrypted_value) 
                      └──> 提取 sessionKey、cf_clearance 与配套 Electron UA
```
**桌面客户端在后台正是使用这套凭证与上游保持长连接并调用 completion 接口进行对话。本代理通过自动化提取 Claude 桌面端凭据，彻底打通免费会话向通用 OpenAI 接口的转换！**

---

## 🌟 核心特性

- **Claude Desktop 原生会话复用**：自动化解密本地已安装的 Claude 桌面端凭据，免复制 Cookie、免抓包、开箱即用。
- **OpenAI 协议全兼容**：无缝对接 Cherry Studio、NextChat、Cursor、Chatbox、沉浸式翻译等第三方客户端及各类 LangChain/LlamaIndex 应用。
- **多账号智能调度池**：
  - 支持 **轮询 (`round-robin`)** 与 **最闲优先 (`least-loaded`)** 调度。
  - 每账号独立并发控制，超额自动排队。
  - **精细区分两类 429**：区分「额度耗尽（等待窗口刷新）」与「瞬时并发满（1.5s 极速自愈）」。
  - **自动 Failover 与熔断自愈**：单一账号异常秒级无感切换，额度耗尽自动冷却并在窗口刷新时重新入池。
  - **低额度避让**：5h/7d 窗口剩余额度 `< 20%` 时自动切走，保障主力请求稳定。
- **现代化 WebUI 控制台**：
  - 反代进程内置托管，访问 `http://127.0.0.1:8787` 即可实时查看账号状态、TPS 速度、用量日志与系统配置。
  - **🔗 自动化链接登录**：一键调起隔离浏览器完成 Claude 登录，CDP 自动捕获 Cookie/UA/组织信息入池。
- **深度工程优化**：
  - **多模态图文对齐**：支持历史多轮对话中的图片准确关联与有序传递。
  - **真实 TPS 测速纠偏**：精准识别上游 Keep-Alive 挂起与正文输出，还原真实吐字速度。
  - **上下文裁剪（Prune Context）**：智能裁剪历史冗余工具调用，避免长对话 Token 暴涨。

---

## 📂 项目结构

本项目经过清晰的分层规划，核心服务、前端管理界面、实用工具、测试套件与配置模版各司其职：

```text
claude-free-proxy/
├── src/                          # 核心代理服务源码
│   ├── openai-proxy.mjs          # 主服务入口（OpenAI 兼容路由、WebUI 托管、调度总控）
│   ├── accounts.mjs              # 账号池管理器（负载调度、冷却阶梯、配额监控）
│   ├── config.mjs                # 配置中心与多 API Key 权限鉴权管理
│   ├── kyc.mjs                   # 账号 KYC 与风控封禁状态嗅探
│   ├── login-link.mjs            # 自动化浏览器登录托管模块
│   ├── quota-probe.mjs           # 官方上游配额主动嗅探
│   └── usage-log.mjs             # 请求流水与 Token 统计日志
│
├── web/                          # 前端单页面应用
│   └── webui.html                # 现代化 Web 控制台（响应式、无外置构建依赖）
│
├── tools/                        # 实用工具与辅助脚本
│   ├── accounts.ps1              # PowerShell 命令行账号快捷管理工具
│   ├── desktop_session.py        # Claude Desktop 本地会话解密与提取工具 (DPAPI+AES)
│   ├── probe_upstream_timing.mjs # 上游连接与网络延迟分析工具
│   └── record_har.mjs            # 浏览器网络交互录制抓包工具
│
├── tests/                        # 单元测试与端到端测试套件
│   ├── mock_claude.mjs           # Claude 官方交互仿真 Mock 服务
│   ├── mock_upstream.mjs         # 上游反代模拟器
│   ├── smoke.mjs                 # 快速冒烟测试
│   ├── test_accounts.mjs         # 账号池冷却与轮询调度测试 (24/24 passed)
│   ├── test_e2e.mjs              # 端到端请求链路测试
│   ├── test_image_collect.mjs    # 多图混排与上下文对齐测试
│   ├── test_multi.mjs            # 多账号并发与故障转移集成测试 (29/29 passed)
│   ├── test_pool_429.mjs         # 429 自动冷却熔断与恢复测试
│   ├── test_responses.mjs        # 协议流式输出与格式测试
│   ├── test_tps_record.mjs       # 出字速度 (TPS) 统计精准度验证
│   └── test_tps_tail.mjs         # 长连接挂起对 TPS 影响优化验证
│
├── config/                       # 配置文件模版（安全脱敏）
│   ├── accounts.example.json     # 账号池数据模版
│   ├── config.example.json       # 主系统配置模版
│   └── upstream.example.json     # 单上游配置模版
│
├── package.json                  # Node.js 项目清单
├── start.cmd                     # Windows 一键无痛启动入口脚本 (双击运行)
├── start.mjs                     # 跨平台启动协调器与端口占用检测
├── LICENSE                       # MIT 开源许可证
└── README.md                     # 本文档
```

---

## 🚀 快速上手

### 环境需求
- **Node.js**: `v22.0.0` 或更高版本（原生支持 fetch、WebSocket 与 ESM，**全项目零第三方 npm 依赖**）
- **Python 3**: Windows 环境运行 `tools/desktop_session.py` 解密桌面端时需要（使用内置 ctypes / sqlite3 模块，零 pip 依赖）

### 1. 启动服务

```bash
git clone https://github.com/suimi8/claude-free-proxy.git
cd claude-free-proxy
```

#### Windows 用户：
直接双击根目录下的 **`start.cmd`** 即可启动。如果需要局域网共享模式或打包：
```cmd
start.cmd          # 默认本机模式 (127.0.0.1:8787)
start.cmd lan      # 局域网模式（允许局域网设备接入）
start.cmd pack     # 快速打包项目（自动排除所有敏感配置与日志）
```

#### Linux / macOS 用户：
```bash
node start.mjs
# 或局域网模式
node start.mjs lan
```

首次运行程序会在根目录下自动创建 `config.json`，并自动生成默认的 API Key 打印在控制台中。

---

### 2. 账号接入模式

服务启动后，打开浏览器访问管理控制台：
👉 **http://127.0.0.1:8787**

#### 模式一：直接提取本机 Claude Desktop（推荐）
如果你本机已经安装并登录了 Claude 官方桌面端，运行：
```powershell
python tools/desktop_session.py
```
脚本会自动解密当前桌面端的登录凭据并生成 `upstream.json`，代理启动时会自动加载作为基础账号。

#### 模式二：WebUI 自动化链接登录（扩充多账号池 ⭐）
1. 在 WebUI 页面点击 **「🔗 链接登录」**。
2. 系统会自动启动一个独立的 Chrome/Edge 浏览器并进入 Claude 登录页面。
3. 在弹出的窗口中正常登录你的 Claude 账号。
4. 登录完成后，后台自动捕获 `sessionKey`、`cf_clearance` 与配套 UA 并加入账号池。

#### 模式三：批量导入 sessionKey 与购买成品账号
- **批量导入**：在控制台点击 **「📥 批量导入」**，支持多种纯 sessionKey 凭据格式自动解析与批量导入：
  - 📝 **每行一个 sessionKey**（纯文本 TXT）
  - 📦 **JSON 格式中自动获取 sessionKey**（支持单个 JSON 对象，如 `{"sessionKey": "sk-ant-..."}`）
  - 📑 **JSON 数组中批量获取 sessionKey**（支持 JSON 数组，如 `[{"sessionKey": "..."}, ...]` 或 `["sk-ant-...", ...]`）
  - 📄 **JSONL 格式中获取 sessionKey**（每行一个独立 JSON 对象）
  - 🍪 **Cookie 串自动提取**（直接粘贴包含 `sessionKey=...` 的整段 Cookie）
  > 💡 **特别说明**：**仅需提供 sessionKey 即可，绝不提供、也不需要任何邮箱和密码！** 后台将自动并发验证有效性、自动发现组织 Org 与备注入池。
- **购买成品账号**：如果你没有现成的 Claude 账号或不想花费时间自建注册，可直接前往小店购买高质量稳定成品账号：
  👉 **[碎米的小店的小店 - 链动小铺](https://wzyp.cn/shop/8WRBPFIB)**（购买后获取 sessionKey 直接批量粘贴导入，秒级开启并发服务）

#### 模式四：手动单账号添加
在控制台的账号管理中，点击「✎ 手动输入」，直接填入账号备注与 `sessionKey=sk-ant-sid02-...`。

---

### 3. 在客户端中配置并使用

在任意兼容 OpenAI API 的客户端（如 NextChat、Cherry Studio、Chatbox、Cursor、沉浸式翻译等）中配置：

| 配置项 | 填写内容 |
| :--- | :--- |
| **API 端点 (Base URL)** | `http://127.0.0.1:8787/v1` |
| **API Key** | 填写控制台展示的 API Key（在 `config.json` 或 WebUI 中管理） |
| **支持模型 (Models)** | `claude-3-7-sonnet` / `claude-3-5-sonnet` / `claude-3-5-haiku` |

#### cURL 调用示例

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -d '{
    "model": "claude-3-7-sonnet",
    "messages": [{"role": "user", "content": "你好，请用一句话介绍你自己"}],
    "stream": false
  }'
```

---

## ⚙️ 核心架构与调度机制

### 账号池调度与容灾矩阵

| 机制 | 工作细节 |
| :--- | :--- |
| **多策略调度** | 支持 `round-robin`（严格轮询）与 `least-loaded`（基于 5 小时窗口占用率的动态权重分配）。 |
| **智能并发控制** | 每账号支持独立设置并发槽位（默认 `3`），防止单个账号因高并发直接触发官方风控。 |
| **两级 429 区分** | <ul><li>**并发型 429**（`representativeClaim: concurrents`）：立即进入 1.5 秒短暂冷却后迅速重试，不污染主错误计数器。</li><li>**配额型 429**（`rate_limit_error`）：自动计算上游 `resets_at` 到期时刻并暂时移出活动池，等待到期自愈。</li></ul> |
| **客户端中断感知** | 当客户端提前取消或断连时，立即中止上游 Fetch 请求并释放连接池，避免无效占用后续请求的配额。 |
| **配置热重载** | `config.json` 与 `accounts.json` 的修改会被实时监听，无需重启服务即可即时生效。 |

---

## 🧪 运行测试套件

项目内置了详尽的单元测试与端到端测试，确保每一次调度与接口协议的可靠性：

```bash
# 运行账号池调度单测
node tests/test_accounts.mjs

# 运行多账号高并发与 Failover 测试
node tests/test_multi.mjs

# 运行 429 熔断与自动恢复测试
node tests/test_pool_429.mjs

# 运行 TPS 吐字测速精准性验证
node tests/test_tps_record.mjs
```

---

## 🔒 隐私与安全性规范

本项目严格遵守安全设计原则：
1. **数据本地化**：所有账号 Cookie、密钥、请求日志仅保存在用户本地，绝不向任何第三方服务回传。
2. **严防凭证泄露**：`.gitignore` 默认强力屏蔽所有 `.env`、`accounts.json`、`config.json`、`upstream.json`、`*.log` 以及抓包文件，提交代码时绝不会夹带个人隐私。
3. **隔离配置文件**：代码中仅提供脱敏的示例模版（`config/*.example.json`），生产配置由本地初始化自动生成。

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 分发与开源。仅供技术学习与交流使用，请合理合规使用相关服务。
