# Claude Desktop (free) → OpenAI 兼容反代（多账号 / 轮询 / 并发）

把本机 Claude Desktop 的上游服务反代成 OpenAI 协议，供 Cherry Studio / NextChat /
OpenAI SDK 等第三方客户端调用。**用的是 Claude Desktop 已登录的 free 账号**，
不需要 API key、不需要订阅。支持**多账号池**：轮询分发、每账号并发上限、
429/403/CF 自动冷却并 failover、**额度剩余 < 20% 自动切走该账号**。
自带 **WebUI 管理控制台**（反代进程直接托管，`http://127.0.0.1:8787/` 打开即用）。

## 为什么不是 `api.anthropic.com`

free 账号拿不到官方 API 权限，实测两条路都是死的：

| 路径 | 结果 |
|---|---|
| `claude auth login`（Claude Code） | 授权页直接显示「连接 Claude Code 需要 Max、Ultra 或 Pro 套餐」 |
| OAuth token → `api.anthropic.com/v1/messages` | `403 oauth_not_allowed_for_organization` |
| OAuth token → `a-api.anthropic.com` | `403 Forbidden`（边缘层拦截） |
| Desktop 自己的日志 | `Cannot get base query config: oauth failed` —— cowork/VM 那条路一直失败 |
| **claude.ai web completion + sessionKey** | **✅ 200，返回 `你好`** |

**Claude Desktop 聊天实际走的是 claude.ai web 的 completion 接口，用 sessionKey cookie 认证。**
这条 free 账号完全可用 —— 这就是本反代的上游。

## 上游协议（实测得出）

```
GET  https://claude.ai/api/organizations                              -> 组织列表（只要 sessionKey）

POST https://claude.ai/api/organizations/{org}/chat_conversations
     {"uuid": "...", "name": "...", "is_temporary": true}              -> 201

POST https://claude.ai/api/organizations/{org}/chat_conversations/{id}/completion
     {"prompt", "model", "parent_message_uuid", "timezone",
      "attachments", "files", "rendering_mode", "tools"}              -> 200 text/event-stream
```

硬约束：

- `system`、`max_tokens`、`temperature` 传了直接 `400 Extra inputs are not permitted`
  → `system` 拼进 `prompt`，`max_tokens` 丢弃
- **永远返回 SSE**，即使请求里不带 `stream`
- 响应**没有 `usage` 字段** → 本地按 字符数/4 估算
- 发起 `tool_use` 后上游**不发 `message_delta`/`message_stop`，只发 `ping`**
  （它在等客户端回传 `tool_result`）。反代是无状态的，所以必须在
  `tool_use` block 结束 + 收到 `ping` 时**主动收尾**，否则连接永远挂着
- 上游在 tool 场景可能回报 `end_turn` 而不是 `tool_use`
  → 只要拿到 `tool_calls`，`finish_reason` 就强制为 `tool_calls`
- 限流返回 `429 {"error":{"message":"Rate limited. Please try again later.","type":"rate_limit_error"}}`
- SSE 里带 `message_limit` 事件，含 `windows.5h.utilization`（0~1）与 `resets_at`
  → 实测 `{"status":"within_limit","resets_at":...,"utilization":0.13}`

## 多账号

### 账号池怎么工作

| 机制 | 行为 |
|---|---|
| **选择策略** | `round-robin`（默认，严格轮询）/ `least-loaded`（按 5h 窗口用量挑最闲的） |
| **并发上限** | 每账号独立信号量，默认 `perAccountConcurrency=3`，超出的请求排队等 |
| **失败冷却** | 429→1m/3m/10m/30m；401/403→5m/15m/30m；CF 挑战→5m/15m/30m；网络抖动/5xx→0s/2s/10s（快速重试、不拉黑账号）；其它→15s/1m/5m。**每类错误独立累计连续失败次数再选档**（`streaks`），concurrency/transient 的连续出现不会把 rate_limit 顶到 30m 档，反之亦然；成功一次全部清零 |
| **网络错误重试** | `fetch failed`/`ECONNRESET`/超时等无状态码错误归类为 `transient`，退避后重试同一账号（最多 `MAX_FAILOVER` 次），不会一击毙命；最终仍失败返回 `502` |
| **两种 429 分开处理** | 配额用尽（`rate_limit_error`）→ 长冷却 1m~30m；账号并发满（`representativeClaim: concurrents`）→ **固定 1.5s 冷却**（不随失败次数递增，并发槽是确定性释放）+ **排队等待**（不消耗 failover 配额，见下文），不拉黑账号 |
| **客户端断连中止** | 客户端打断（Codex steer/超时）→ `res close` 触发 AbortController，**立即中止上游 fetch 并归还并发额度**（实测 3~4ms），不记成功/失败、不进冷却。否则上游流会继续跑白占并发槽，下一句立刻撞 `concurrents` 429 |
| **failover** | 一个账号挂了自动换下一个，最多 `MAX_FAILOVER=3` 次；400 类错误不换（换也没用） |
| **排队** | 全部账号都在冷却/满载时不会立刻失败，等 `ACCOUNT_WAIT_TIMEOUT_MS`（默认 30s）让冷却中的账号恢复 |
| **配额感知** | 每次响应的 `message_limit` 记到账号上，`least-loaded` 据此避开快用完的账号 |
| **额度低自动切换** | 每次选账号时计算剩余比例（5h/7d 两个窗口取**更紧**的那个），剩余 `< minQuotaRemaining`（默认 **20%**，`POST /v1/pool` 或 UI 可调，0=关闭）的账号本轮不选。**全都低于阈值或只剩一个账号时降级照用**，避免整个池拒绝服务 |
| **热加载** | `accounts.json` 被手工编辑后 2s 内生效，不用重启；换了 `sessionKey` 会自动清掉旧冷却 |
| **凭据轮换** | 换 `sessionKey` 视为新账号，冷却/失败计数归零 |

### 账号从哪来

**⭐ 账号 B/C/...（链接登录，推荐）**：不用打开 DevTools，也不用复制任何 Cookie。

WebUI 点「🔗 链接登录（推荐）」→ 服务端启动一个独立 Chrome/Edge 窗口并打开
`https://claude.ai/login` → 在窗口里正常登录 → 反代通过 CDP 自动捕获
`sessionKey`、`cf_clearance`、其余 claude.ai cookie 与浏览器精确 UA，
调用 `/api/organizations` 校验并发现 org 后**自动写入账号池**（以 sessionKey 去重），
最后关闭浏览器、删除临时 profile。整个过程只需点一次按钮 + 正常登录。

- 登录窗口使用**独立 user-data-dir**，不干扰你日常浏览器的登录态
- 同时保存 cf_clearance + 配套 UA，比只填 sessionKey 更不容易触发 Cloudflare 挑战
- 登录链接形如 `http://127.0.0.1:8787/login/<id>`，可复制到任意浏览器查看实时进度、
  或在关掉窗口后点「重新打开登录窗口」
- 超时 5 分钟；重复发起会复用进行中的流程，不会开出多个窗口
- 需要本机有 Chrome 或 Edge（可用 `LOGIN_BROWSER` 指定 exe），Node 22+

REST 端点：

```
POST   /v1/login                  发起链接登录 -> {id, link, state, ...}
GET    /v1/login/{id}            查询进度（WebUI 轮询用）
POST   /v1/login/{id}/cancel     取消并关闭登录浏览器
GET    /login/{id}               登录状态页（免鉴权，仅本机回环）
GET    /login/{id}/state         状态 JSON
POST   /login/{id}/open          重新打开登录页
```

**链接登录（推荐）**：打开 WebUI 点「🔗 链接登录」，在弹出的独立浏览器窗口里登录
claude.ai，程序通过 CDP 自动抓取 `sessionKey` + `cf_clearance` + 精确 UA 写入
`accounts.json`。不需要碰 DevTools。

**Desktop 自动同步（仅当仍装有 Claude Desktop）**：手动运行 `python desktop_session.py`，
从 Desktop profile 解密 `sessionKey` 并 upsert。Desktop 卸载后这条路径不可用。

**手动添加（仅当链接登录不可用时）**：浏览器登录 claude.ai → DevTools → Application →
Cookies → `claude.ai` → 复制 `sessionKey`，然后：

```powershell
.\accounts.ps1 -Add -Label b2 -SessionKey sk-ant-sid02-xxxx
```

`org` 会**自动发现**（`GET /api/organizations` 只要 sessionKey 就返回 200），
不用手动填。实测**只给 sessionKey、不带 `cf_clearance` 也能跑通 completion**。

### 账号管理

```powershell
.\accounts.ps1 -List                          # 查看（sessionKey 打码，含 5h 配额）
.\accounts.ps1 -Add -Label b2 -SessionKey ...  # 添加
.\accounts.ps1 -Disable <id>                  # 停用
.\accounts.ps1 -Enable <id>                   # 启用
.\accounts.ps1 -Remove <id>                   # 删除
.\accounts.ps1 -Strategy least-loaded         # 切策略
.\accounts.ps1 -Refresh                       # 重新解密 Desktop 凭据
```

也可以直接改 `accounts.json`（2s 内热加载），或调 REST：

```
GET    /v1/accounts            账号列表（含 quota_remaining / low_quota 等 UI 字段）
POST   /v1/accounts            {label, sessionKey, org?, base?}
PATCH  /v1/accounts/{id}       {enabled?, label?, org?, sessionKey?, cooldownUntil?}
DELETE /v1/accounts/{id}
GET    /v1/accounts/{id}/test  连通性测试（打一次 GET /api/organizations 验登录态，不耗对话额度）
POST   /v1/accounts/refresh    重新从 Desktop 解密（桌面端占用 Cookies 库时返回 503，旧凭据继续可用）
POST   /v1/pool                {strategy?, perAccountConcurrency?(1..32), minQuotaRemaining?(0..0.99)}
```

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `CONFIG_FILE` | `config.json` | 配置文件路径（端口 / 监听地址 / 全部 API Key） |
| `LOCAL_API_KEY` | 空 | 可选，额外加一个不受限的等价 key（调试用） |
| `ACCOUNT_STRATEGY` | `round-robin` | 覆盖 `accounts.json` 里的策略 |
| `PER_ACCOUNT_CONCURRENCY` | 文件值，兜底 3 | 每账号并发上限 |
| `MIN_QUOTA_REMAINING` | `0.2` | 额度切换阈值（仅 `accounts.json` 缺 `minQuotaRemaining` 字段时生效，平时用 UI/`/v1/pool` 调） |
| `MAX_FAILOVER` | `3` | 单次请求最多换几个账号 |
| `ACCOUNT_WAIT_TIMEOUT_MS` | `30000` | 全忙时最长等待 |
| `ACCOUNTS_FILE` | `accounts.json` | 账号池文件 |
| `DESKTOP_SYNC` | 开 | 设为 `0` 关闭 Desktop 自动同步（纯手动账号时用） |
| `MODELS` | 见下 | 覆盖 `/v1/models` 返回的模型 id |
| `DEFAULT_EFFORT` | `max` | 客户端没指定思考档位时用哪档（`low/medium/high/xhigh/max`；上游只认 `effort`，思考越久 TPS 越难看，见下） |
| `SSE_END_ON_STOP` | `1` | 上游发了 `message_stop` 就立刻收尾（不傻等它关连接）。设 `0` 恢复旧行为 |

## 输出速度（TPS）：反代现在记录的是**真实速度**

以前这个数字是假的：分子按「字符 ÷ 4」估（中文被低估 3~4 倍），分母是「首字 → 响应结束」
（把上游吊连接的空转和模型思考期都算了进去）。于是 258 个 token / 134 秒 = **1.9 tok/s**，
而上游真实出字速度其实是 **60~70 tok/s**。

现在每条请求都记录一条**时间轴**，口径全部拆开（用量日志 + WebUI「请求日志」）：

| 字段 | 含义 |
|---|---|
| `text_tokens` | 可见正文 token（中文 1 字 1 token，其余 4 字符 1 token） |
| `think_tokens` | 思考摘要 token（上游只给截断版） |
| `ttfb_ms` | 首字延迟（上游预填充 + 排队） |
| `think_ms` | 思考期（首个增量 → 首个正文） |
| `write_ms` | **真正在写正文的那段时间**（首个正文 → 末个正文） |
| `gen_ms` | 整个吐字窗口（首个增量 → 末个增量） |
| `idle_ms` | 末个增量之后的空闲（上游把连接吊着的那段） |
| `tps` | **真实出字速度 = 正文 token ÷ 书写秒数**（不含思考期、不含空闲） |
| `tps_e2e` | 端到端吐字速度（含思考摘要） |
| `tps_legacy` | 老口径，留着对比用（同样一条请求能差 10 倍以上） |
| `effort` | 本轮实际用的思考档位 |

WebUI 的「速度」列现在显示 `tps`，悬停能看到完整时间轴拆分；顶部新增「真实出字速度」卡片
（加权均值 / 单请求均值 / 平均思考 / 平均空闲）。

为什么以前会假：

1. **上游把 SSE 连接吊着不关**（keep-alive），内容早发完了但连接不结束。
   反代原来一直读到 EOF 才收尾，这段**纯空闲**被算进分母。
   现在收到上游的 `message_stop` 就立刻收尾（`SSE_END_ON_STOP=1`）。
   A/B 实测（假上游吊 30 秒）：客户端等待 **30.0s → 0.0s**，`tps` **18.5 → 242**。
2. **中文按 4 字符/token 估** → 一段 200 字的中文回复只算成 50 token，慢 4 倍。
   现在中英文分开估（`countTokens`）。
3. **思考时间**：`effort` 档位越高，模型思考越久，思考期不产出可数 token。
   想要速度就把档位调低（harness 里改推理等级，或 `DEFAULT_EFFORT=low`）。

另外首字延迟（TTFB）随上下文涨：157k 上下文实测 TTFB ≈ 14s，这段**不计入 TPS 分母**，但体感上一样慢。

## 文件

| 文件 | 作用 |
|---|---|
| `openai-proxy.mjs` | 反代主体（零依赖，Node ≥22 用于链接登录），同时托管 WebUI |
| `webui.html` | WebUI 管理控制台（单文件，反代进程内托管，改完刷新即生效） |
| `login-link.mjs` | **链接登录**：CDP 控制 Chrome/Edge 自动捕获 sessionKey + cf_clearance + UA |
| `quota-probe.mjs` | **主动查额度**：取 message_limit 利用率 + /rate_limits 并发档位 |
| `config.mjs` | **配置与多 Key 中心**：读写 `config.json`、鉴权、额度/到期/限速/白名单判定、用量累计（1 秒 debounce 落盘） |
| `config.json` | **配置文件（含 API Key 明文，敏感）**：端口、监听地址、所有 Key 及其限制。首次启动自动生成 |
| `usage-log.mjs` | **用量日志**：分账号 / 按小时 / 缓存前缀链 / 请求明细（落盘 `usage/*.jsonl`） |
| `accounts.mjs` | 账号池：轮询 / 冷却 / 并发上限 / failover / 配额切换 |
| `accounts.json` | 账号池（**敏感，勿提交**） |
| `accounts.ps1` | 账号管理 CLI |
| `desktop_session.py` | 从 Desktop profile 解密 cookie → `upstream.json` + `accounts.json` |
| `start.cmd` | **唯一启动入口**：双击=本机模式；`start.cmd lan`=局域网；`start.cmd pack`=打包迁移。已在运行会问「重启 / 保持现状」 |
| `start.mjs` | 上面那个入口的实现（端口检测、找 PID、停旧进程、中文提示）；`.cmd` 只负责切 UTF-8 和查 Node |
| `smoke.mjs` | 冒烟测试（独立文件，避免 PS5.1 内嵌 `node -e` 挂死） |
| `test_e2e.mjs` | 7 项真实上游回归 |
| `test_responses.mjs` | 8 项 Responses API 回归（流式/非流式/tools/续聊/鉴权） |
| `test_multi.mjs` | 29 项多账号回归（对 mock，确定性；含断连中止 4 项、WebUI+额度切换 5 项） |
| `test_accounts.mjs` | 24 项冷却档位 + 额度切换单元测试（per-kind streak，不联网） |
| `mock_claude.mjs` | claude.ai 格式假上游，可注入 429/401/延迟/慢速流式/配额 |
| `upstream.json` | Desktop 凭据落盘（**敏感，勿提交**） |
| `decrypt_oauth_cache.py` | 解 `config.json` 的 `oauth:tokenCache`（诊断用，free 档不可用） |
| `probe*.py` | 协议摸索阶段的探测脚本（留档） |

## 配置文件与 API Key

所有可配置项都在项目根目录的 `config.json`，**代码里不内置任何端口或密钥**。
首次启动若文件不存在会自动生成，并随机创建一个 key 打印在控制台。

```json
{
  "version": 1,
  "server": { "port": 8787, "host": "127.0.0.1" },
  "settings": { "pricePerMillionTokens": 0 },
  "keys": [
    {
      "id": "k_example",
      "name": "默认 Key",
      "key": "sk-your-random-generated-key",
      "enabled": true,
      "createdAt": 1794626237201,
      "expiresAt": null,
      "models": [],
      "rpm": 0,
      "tpm": 0,
      "ipWhitelist": [],
      "quota": { "limitTokens": 0, "usedTokens": 0, "limitRequests": 0, "usedRequests": 0 }
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `server.port` / `server.host` | 监听端口与地址。`host` 改 `0.0.0.0` 才开放局域网；**改这两项需重启** |
| `keys[].key` | 该 Key 明文，客户端用 `Authorization: Bearer <key>` |
| `keys[].enabled` | `false` 立即停用 → 403 `api key disabled` |
| `keys[].expiresAt` | 毫秒时间戳，`null` = 永不过期；过期 → 403 `api key expired` |
| `keys[].models` | 模型白名单，空数组 = 全部；不匹配 → 403 |
| `keys[].rpm` / `tpm` | 每分钟请求数 / tokens 上限，0 = 不限；超限 → 429 |
| `keys[].ipWhitelist` | 允许的来源 IP，空数组 = 不限；不匹配 → 403 `ip not allowed` |
| `keys[].quota.limitTokens` | 额度上限（tokens），0 = 不限 |
| `keys[].quota.limitRequests` | 请求数上限，0 = 不限 |
| `keys[].quota.usedTokens` / `usedRequests` | 已用量，可手工清零 |

**热加载**：改 key / 额度 / 到期 / 限速 / 白名单 3 秒内生效；改 `port` / `host` 需重启。

### 额度口径

按 **tokens** 计，与账号用量同一口径：`输入（含缓存命中）+ 输出`。
缓存命中的部分同样占上游上下文，所以**计入额度，不做折扣**。

> 为什么不按 CNY：上游 claude.ai free 档不返回任何费用数据，没有可用的计费基准。
> 想展示金额时在 `settings.pricePerMillionTokens` 填单价（元/百万 tokens）。

### 多 Key 的管理

- **WebUI**：「🔑 API Keys」标签页（推荐）—— 新建 / 编辑 / 停用 / 清零 / 删除
- **HTTP API**（仅本机可调用）：
  ```
  GET    /v1/keys              列表（key 脱敏）
  POST   /v1/keys              新建，明文 secret 只在响应里返回一次
  PATCH  /v1/keys/{id}         改任意字段
  DELETE /v1/keys/{id}         删除
  POST   /v1/keys/{id}/reset   清零已用量
  ```
- **直接编辑** `config.json`，保存后 3 秒生效

管理接口只要求「本机访问 + 一个有效 key」，**不受该 key 的额度 / 到期限制** ——
否则额度用尽后就再也改不回来了。

### 实测的限制响应

| 场景 | 状态码 | 错误体 |
|---|---|---|
| 没带 key | 401 | `missing api key` |
| key 不存在 | 401 | `invalid api key` |
| key 被停用 | 403 | `api key disabled` |
| 已过到期时间 | 403 | `api key expired` |
| IP 不在白名单 | 403 | `ip not allowed` |
| 额度 / 请求数用尽 | 403 | `quota exceeded` |
| 超过 RPM | 429 | `rpm limit exceeded` |
| 超过 TPM | 429 | `tpm limit exceeded` |
| 模型不在范围 | 403 | `模型 xxx 不在该 Key 的允许范围内` |

## 用法

```powershell
cd <PROJECT_ROOT>

# 双击 start.cmd 即可，端口与 API Key 读 config.json
# 如果服务已经在跑，会先问你：
#     [1] 关闭旧服务，启动新服务
#     [2] 关闭本次运行（保持现在这个服务不动）

# 命令行也可以：
start.cmd            # 本机模式
start.cmd lan        # 局域网模式（其他设备可访问，带强 key）
start.cmd pack       # 打包迁移到另一台电脑（不含凭据）

# 加账号：打开 WebUI 点「🔗 链接登录」，无需手动命令

# 看池状态（CLI，备用）
.\accounts.ps1 -List
```

**WebUI 控制台**：浏览器直接打开 `http://127.0.0.1:8787/`（或 `/ui`）。
页面本身免鉴权（仅本机回环），数据接口仍要 `Bearer <config.json 里的 key>` —— 首次打开
弹 Key 输入框，存 localStorage 后 3s 自动轮询。支持：账号卡片（FREE 徽章、
当前会话/本周额度条、在途/冷却/连败/最近错误）、添加/导入 Desktop 登录态、
连通性测试、启停/清冷却/删除/全选批量删除、搜索备注、轮询策略/并发/额度阈值在线保存。

客户端配置：

- Base URL：`http://127.0.0.1:8787/v1`
- API Key：`config.json` 里 keys[].key（首次启动会打印在控制台）
- 模型：`claude-sonnet-4-5` / `claude-haiku-5-5`（已自动映射到 free 档可用的
  Sonnet 5.5 / Haiku 5.5；请求 Opus/Fable 会降级到 Sonnet）

支持端点：`GET /v1/models`、`POST /v1/chat/completions`（流式/非流式/tools）、
`POST /v1/responses`（OpenAI **Responses API**：`input`/`instructions`/`tools`/流式事件
`response.output_text.delta`、`function_call_arguments.delta`、`previous_response_id`
续聊、`GET /v1/responses/{id}`，内存保留最近 50 条）、
`POST /v1/messages`（Anthropic 格式透传）、`GET /healthz`（含池状态与 `min_quota_remaining`）、
`GET /`（WebUI 控制台）、以及上面的账号管理端点。

## 已验证

**多账号（对 mock 上游，29/29，确定性）**

```
PASS  反代启动 + 2 账号加载  | strategy=round-robin total=2 eligible=2
PASS  轮询分布（8 请求摊到 2 账号）  | dist={"A":4,"B":4}
PASS  并发进行（12 并发全成功 + 摊到 2 账号 + 上限生效）  | maxConcurrent=4 (cap=4)
PASS  GET /v1/accounts / PATCH disable / enable / POST+org 自动发现 / DELETE
PASS  accounts.json 热加载（改 label 无需重启）
PASS  failover：坏账号 429 时请求仍成功  | fail=0/4
PASS  坏账号进入冷却  | cooldown=180s streak=2
PASS  冷却期内不再打坏账号  | bad hits=0
PASS  全挂返回 429（不挂死）  | http=429 15.3s
PASS  恢复后重新可用
PASS  多账号下流式 tools  | finish=tool_calls args={"city": "广州"} DONE=true
PASS  [8a] 断连（上游未响应阶段）立即释放 inflight  | held=104ms release=3ms（自然完成需 ≥2000ms）
PASS  [8b] 断连（流式中途）立即释放 inflight  | held=103ms release=4ms（自然完成还有 ~1900ms）
PASS  [8c] 断连不记失败、不进冷却  | fail 3->3 cooling=-
PASS  [8d] 断连后账号立即可用  | http=200
PASS  [9a] WebUI 托管在反代进程（/ 与 /ui 都 200+HTML）
PASS  [9b] A 上报额度 95%（剩5%）  | remaining=0.05 low=true
PASS  [9c] A 被标记 low_quota（阈值 20%）
PASS  [9d] 剩5%的账号被切走（4 连发全到 B）  | A+0 B+4
PASS  [9e] 阈值 0 关闭切换后 A 恢复轮询
PASS  POST /v1/pool 切换策略 / least-loaded 可用
29/29 passed
```

**冷却档位 + 额度切换单元（不联网，24/24）**

```
PASS  concurrency 第1次 -> 3s / 第2次 -> 10s
PASS  transient 不受 concurrency 污染 -> 0ms
PASS  rate_limit 独立起算 -> 60s
PASS  成功后 streak 清零 -> concurrency 回到 3s
PASS  streaks 落盘持久化 / disable-enable 清零
PASS  剩5% -> 切走 / 剩25% >= 阈值不切 / 7d 剩10% 也切走
PASS  utilization=95 百分比写法兼容
PASS  全部低额度仍能选到账号（降级）/ 唯一账号低额度仍可用
PASS  阈值 0 关闭切换 / 越界 400 / 策略非法 400 / 池配置落盘
24/24 passed
```

**真实上游（单账号回归，7 项）**

```
[1] stream+tools    20.1s  finish=tool_calls  args={"city": "广州"}   DONE=true
[2] nonstream+tools        finish=tool_calls  calls=[...{"city": "成都"}]
[3] stream text      3.9s  "一、二、三。"                            DONE=true
[4] zh+system              "中文正常"
[5] multiturn              "小红"
[6] /v1/messages           [{"type":"text","text":"收到"}]
[7] no-auth                http=401 (期望 401)
total 47.5s
```

真实配额抓取：`quota_5h = {"status":"within_limit","utilization":0.13,"resets_at":...}`

## 认证凭据从哪来

Claude Desktop 的 profile 里：

```
Local State.os_crypt.encrypted_key  → base64("DPAPI" + DPAPI(AES-256 key))
Network/Cookies.encrypted_value     → "v10" + nonce(12) + AES-256-GCM(ct||tag)
                                       明文前 32 字节是固定前缀，真值 = plaintext[32:]
```

关键 cookie：`sessionKey`（登录态）、`cf_clearance`（Cloudflare 通行）。

⚠️ **`cf_clearance` 与 User-Agent 绑定**。UA 必须是 Electron 45.2.1 对应的
Chrome 140，用别的 UA（比如 `claude/5.1231.2`）会触发 `Just a moment...` 挑战页。
Desktop 账号带完整 cookie 串时优先用它；手动账号只给 `sessionKey` 也可用
（实测通过），但更容易撞 CF 挑战，届时给账号补 `ua`/`cookie` 即可。

## 额度与 token（2026-11-13 实测 free 档）

**结论：能拿到"用了百分之几 + 何时重置"，拿不到"还能用多少 token / 多少条消息"。**

上游实测（`default_claude_ai` 档）：

| 来源 | 返回 |
|---|---|
| SSE `message_limit` 事件 | `windows.5h.utilization`(0~1)、`windows.7d.utilization`、`resets_at`、`representativeClaim`、`resolved.limit.percent` |
| `GET /api/organizations/{org}/rate_limits` | `rate_limit_tier`、`tier_model_rate_limiters`（只有 `concurrents`：多数模型 3、haiku_4 为 6） |
| `GET /api/organizations/{org}/usage` | `five_hour`/`seven_day`/`spend`/`limits` **全是 null、`limits: []`** |
| `message_limit.remaining` / `perModelLimit` / `resolved.spend` | **全是 null** |

free 档**不是按 token 计费/限额**，而是按滚动 5 小时会话窗口 + 7 天周窗口的
「消息使用强度」动态计算（受消息长度、模型、附件、工具调用影响）。上游只给利用率
百分比，从不给绝对数额 —— 所以「还能用多少 token」这个问题在上游没有对应数值，
任何具体 token 数都是猜测，本项目不编造。

能做的量化：

- **剩余比例**：两窗口取更紧的一个，WebUI 显示「剩 N%」，`least-loaded` 策略据此挑选账号
- **重置时间**：5h / 7d 窗口各自的 `resets_at`，WebUI 显示重置时刻
- **已用 token 估算**：本地按字符数/4 累计输入+输出（`tokens_in_est` / `tokens_out_est`），
  卡片显示「已用 ≈ N tokens」，**明确标注是本地估算、不是配额**

### 主动查额度

额度数据只随 completion 响应的 SSE 回来，新账号没发过消息时会显示「未上报」。
点卡片「📊 查额度」或顶部「📊 刷新全部额度」即可主动取回：

```
POST /v1/accounts/{id}/quota
  -> { ok, quota: {5h, 7d, remaining, per_model_limit, spend, representative_claim, resolved_limit},
       rate_limits: {tier, concurrents, spend_threshold}, account, note }
```

实现见 `quota-probe.mjs`：查 `/rate_limits`（不消耗消息）+ 建临时会话发一条
`prompt: "hi"` 的最小 completion 取 `message_limit`（**每个账号消耗 1 条极小的消息**）。
探测结果会落盘，重启不丢（`updateQuota` 已修为持久化）。

## 工具映射（不同客户端的差异）

**历史问题**：`responsesToChat` 曾直接丢弃 `type=custom` / hosted 工具：

```js
.filter(t => t && (t.function || (t.type || 'function') === 'function'))
.filter(t => t.type !== 'custom');   // 旧代码：custom/hosted 全丢
```

结果是**同一个反代里，不同客户端表现完全不同**：

| 客户端 | 声明的工具形状 | 旧行为 | 结果 |
|---|---|---|---|
| DeepSeek Harness 类 | 37 个 `type:function`（`pwsh`/`read`/`write`/`subagent`…） | 放行 | ✅ 能读文件、能开子智能体 |
| Codex CLI | 5~6 个 `custom` / `local_shell`（含 `bash_tool`） | **全部丢弃** | ❌ `unsupported call: bash_tool` |

`proxy.err.log` 里 4 条「忽略 5/6 个上游不支持的工具」正好对应客户端底部的
「4 warnings」。模型在 `instructions` 里仍以为有工具，照常发出调用意图，
但 `tools` 数组到上游时已经空了 → 工具层拒绝。

**现在**：`normalizeTool()` 把任意形状统一映射成上游可接受的
`{name, description, input_schema}`：

- chat completions `{type:'function', function:{...}}`
- responses function `{type:'function', name, parameters}`
- responses custom `{type:'custom', name, ...}` ← Codex 的 `bash_tool`
- hosted `{type:'local_shell' | 'web_search' | ...}`（用 type 兜底当 name）
- anthropic `{name, input_schema}`

同时补齐 `custom_tool_call` / `local_shell_call` / `*_call_output` 的 input 回放
（客户端每轮重发历史，所以 tool_result 回传闭环本来就通）。
`TOOL_PASSTHROUGH=off` 可回退到「不透传工具」。
日志会打印 `[responses] tools: <原始type>:<映射后name>` 便于核对。

> 待验证：Codex 若声明 `custom` 工具，可能期望响应里的 `custom_tool_call` 项，
> 而反代目前统一输出 `function_call`。若实测仍报错，把新报错发来即可补
> 输出事件形状的按类型回映射。

## 429 频繁：是并发满，不是配额耗尽

`completion 429` 的完整错误里 `representativeClaim: concurrents`、`error_code: concurrent_limit_reached`
—— 上游并发槽按 **sessionKey / org 全局**计，`/rate_limits` 给的是 `concurrents: 3`（`claude_haiku_4` 为 6）。

**判定方法**：空闲时发一条最小请求，若 2 秒内 200 就说明账号和配额都正常，429 纯粹是并发冲突。

### 三个叠加原因（实测）

| 原因 | 数据 |
|---|---|
| 多子代理并行 | DeepSeek Harness 开 7 个子智能体 → 7 个请求同时到，而反代只有 2 个槽位（2 账号 × 并发 1） |
| 请求本身很慢 | agent 每轮带全量历史 + 几十个工具定义，输入 6.7K~11.5K tokens，单个 completion 要 10s+；7 × 10s ÷ 2 槽 ≈ **35s 排队** |
| 5h 窗口接近上限 | 实测 A 用到 **76%**、B 用到 **91%**（`status: approaching_limit`）。free 档越接近窗口上限，上游对并发的容忍度越低 |

### 为什么桌面端几乎不撞

| 维度 | Claude 桌面端 | 本反代 |
|---|---|---|
| 并行度 | 单会话串行，一次只有一个 completion；人打字天然有间隔 | 7 个子代理并行，瞬时 7 个请求 |
| 会话 | 复用同一个 conversation | **每个请求都 `POST /chat_conversations` 新建临时会话**（多一次上游往返） |
| 重试 | 失败就停，等用户点 | 反代 failover（最多 4 次）× 客户端退避重试（实测 5 次）= 失败一次放大成十几倍请求量 |
| 输入长度 | 常规对话几千 token | 6.7K~11.5K tokens/请求，占槽时间数倍 |
| 使用者 | 只有它自己 | 反代 + 桌面端可能共用同一 sessionKey，并发叠加 |

### 反代的排队机制（已实现）

之前 `maxFailover=3` + `1.5s×(n+1)` 退避，意味着一个请求最多等约 **9 秒**就放弃；而 7 子代理场景要排
**35 秒**。结果大量请求在「快轮到自己」时被丢弃，客户端退避 8 秒重试又插队，形成 429 死循环。

现在：

- `concurrency` 类失败**不消耗 failover 配额**，改为排队（退避 1.2s/2.4s/3.6s…上限 8s）
- 排队总预算由 `ACCOUNT_QUEUE_BUDGET_MS` 控制（默认 **30000**，设为 0 则恢复快速失败）
- `concurrency` 冷却固定 **1.5s**，不随 `failStreak` 递增——并发满只是排队，不是账号坏了
- 客户端断连会立即中止并归还槽位，不会白占

**实测**：空载单请求 2.18s 成功；5 个并发请求全部 200，耗时 1.96s/2.99s/3.42s/4.12s/4.94s（标准排队曲线），零 429。

### 规避手段（按有效性排序）

1. **加账号** —— 最有效。槽位从 2 提到 4，排队时间直接减半。WebUI 点「🔗 链接登录」即可，无需手抄 sessionKey
2. **降低子代理并行数** —— 7 → 3，排队从 35s 降到 15s，落在预算内
3. **等 5h 窗口重置** —— 利用率归零后上游明显宽松（`GET /v1/accounts` 的 `quota_5h.resets_at` 有具体时间）
4. **保持 `perAccountConcurrency=1`** —— 别为了吞吐往上调：窗口利用率已 76%/91% 时调高只会更快耗尽并撞 429
5. **减少每轮输入 token** —— 客户端别每次重发全量历史；`CACHE_MODE=reuse` 对纯多轮文本有效（工具流为正确性会跳过）
6. **客户端重试改指数退避** —— 固定 8s 太短，建议 10s→20s→40s

## 429 额度耗尽池 / 有效池（不再胡乱调用）

上游有两种 429，必须分开对待（`classify()` 靠 `resetsAt` 区分）：

| 上游响应 | 含义 | 处理 |
|---|---|---|
| `resetsAt: null` / `concurrent_limit_reached` | **并发槽满**（滚动窗口，实测 8~66s 自愈） | 只退避 1.5s，不换号、不拉黑、不消耗 failover 配额 |
| `exceeded_limit` + `resetsAt: <时间戳>` | **配额用尽**（5h / 7d 窗口） | 列入「429 耗尽池」，**精确按上游给的恢复时刻**收紧 |

以前配额用尽只按 1m/3m/10m/30m 的阶梯冷却，窗口还没恢复就把账号再拿出来撞 —— 白白消耗
failover 配额和时间。现在：

- **429 耗尽池**：命中 `exceeded_limit` 的账号立刻出池，`cooldownUntil = 上游 resetsAt`，
  池里选账号时直接跳过（`eligible()` 里 `!(exhaustedUntil > now)`）。
- **有效池**：其余账号正常参与调度。
- **自动回池**：定时器每 2 秒检查一次，`resetsAt` 到了就自动把账号放回有效池
  （日志：`[pool] xxx 配额窗口已恢复 -> 回到有效池，重新参与调度`）。
- **不再空等**：failover 循环现在区分「立刻能用」和「冷却很快结束、值得排队」，
  剩下的全是耗尽池账号时直接退出（不白等 30 秒）。
- **并发型 429 不进耗尽池**：没有精确 `resetsAt` 的普通 429 仍按阶梯短暂冷却。

WebUI「账号池」页新增 **429 额度耗尽池** 卡片：显示耗尽账号数与最早恢复时刻；
账号卡片上带 `🚫 429 耗尽 · N 分钟` 标记，悬停能看到恢复时刻与原因
（`five_hour` / `seven_day` / `per_model`）。`GET /v1/accounts` 也会返回
`exhausted` / `exhausted_until` / `exhausted_reason` / `pool`（`valid` | `exhausted` | `disabled`）。

实测（2026-11-16，20 个账号全部撞 5h 窗口）：一次请求就把 8 个耗尽账号收进池子，
恢复时刻精确等于上游 `resetsAt`（12:30），有效池剩 12 个。

## 用量统计与缓存命中率

### 每个账号分别记录已用 Tokens

每次请求结束都会写一条日志到 `usage/YYYY-MM-DD.jsonl`（追加写、按天分文件、重启不丢）：

```
ts / account_id / account_label / model / api / input_tokens / output_tokens
cached_tokens / new_input_tokens / cache_hit / prefix_hash / prefix_candidates
conv_id / parent_uuid / status / ok / latency_ms / ttfb_ms / error / estimated
```

`GET /v1/usage?range=today|yesterday|7d|all&accountId=&model=` 返回总请求数、
真实消耗 Tokens、新增输入、缓存命中率、按小时序列、**分账号明细**（账号池里所有账号都列，
包括没产生请求的）、分模型、最近 50 条日志。`GET /v1/usage/logs` 返回请求明细。
WebUI 第二个标签页「📊 用量统计 / Tokens」展示四个指标卡 + Tokens 按小时折线图 +
按账号已用表 + 请求日志（新增输入 / 输出 / 缓存命中 / 速度 / 首字 / 耗时）。

> 上游 claude.ai **不返回 usage 字段**，所有 token 数都是本地按字符数/4 估算，
> 日志里带 `estimated: true`。这是「已用量」，**不是配额**（配额见上一节）。

### 缓存命中率是怎么算的

```
cache_hit_rate = cached_tokens / input_tokens        （token 口径，看板主指标）
new_input      = input - cached                     （看板「新增输入」）
```

命中判定用**最长公共前缀链**：对 `system + tools + 历史消息的每一个前缀` 各算一个
hash，与同账号近 `CACHE_TTL_MS`（默认 5 分钟，对齐 Anthropic prompt cache TTL）内的
记录比对，取最长命中。这样多轮对话的命中率会随轮次上升，而不是每轮都 miss。

### 如何增加缓存命中率（按效果排序）

上游是 claude.ai 网页版 completion 接口，**没有官方 prompt caching、也不返回任何缓存指标**。
所以这里的命中率是「重复输入有多少可以被省掉」的本地度量，提高它的实际手段是：

1. **保持 system / tools 完全稳定** ⭐ 最关键。它们属于基线前缀；每次改一个字、
   加一个时间戳或随机 id，整条前缀链就断了，命中率直接归零。不要在 system 里塞动态内容。
2. **多轮对话传完整历史，不要只发最后一条**。前缀链靠历史消息逐轮变长，
   命中率与「新增输入占比」随轮次改善。只发最后一句 = 每轮都从基线开始，命中率低。
3. **同一会话尽量落在同一账号**。缓存按 `account_id` 隔离；`round-robin` 严格轮询会在
   账号间跳，另一个账号没有该会话的前缀记录就必然 miss。用 `ACCOUNT_STRATEGY=least-loaded`
   或单账号时命中率明显更高（也可以用 `POST /v1/pool` 切换）。
4. **5 分钟内连续请求**。超过 TTL 前缀索引失效，命中率自然回落。
5. **客户端发 `cache_control: ephemeral`**（Claude Code 会这么做）。本项目会把它算进
   tools/system 前缀，不需要额外配置。
6. **开启 `CACHE_MODE=reuse`**（真正省输入，默认关闭）：命中前缀时复用上游
   `chat_conversation` 和 `parent_message_uuid`，**只发本轮增量 prompt**，而不是每轮重发
   全量历史。开启后「新增输入」会真实下降。
   ```powershell
   # 临时开一次：在 start.cmd 里把 set CACHE_MODE=stats 改成 reuse
   # 或用环境变量覆盖后从命令行启动
   $env:CACHE_MODE = 'reuse'; node openai-proxy.mjs
   ```
   保护：只用于纯多轮文本对话；工具调用 / 工具结果 / 非 user 结尾的请求一律新建会话
   走全量 prompt（正确性优先）。并发写同一会话时请自行评估。

`CACHE_MODE` 三档：`off` 不统计；`stats`（默认）只统计、完全不改上游请求；
`reuse` 统计 + 真正复用上游会话。

## 迁移到另一台电脑 / 另一网络

零依赖（没有 `node_modules` / `package.json`），整个目录就是全部代码，约 470 KB。

### 打包

```
start.cmd pack
```

生成 `claude-free-proxy-move.tar.gz`，**自动排除** `accounts.json`（凭据）、`usage/`（请求日志）、`*.log`。
也可以手工拷目录，但务必先删掉这三样。

### 新机器步骤

1. 装 **Node.js 22 或更新** —— 链接登录用 Node 22 的全局 `WebSocket`，低于 22 会报「需要 Node.js 22+」
2. 解压：`tar -xzf claude-free-proxy-move.tar.gz -C <目标目录>`
3. 双击 `start.cmd`（只在本机用）或运行 `start.cmd lan`（局域网其他设备也要用）
4. 浏览器打开 `http://127.0.0.1:8787`，点「🔗 链接登录」重新添加账号

首次启动会自动创建空的 `accounts.json`。

### 为什么不能直接把 accounts.json 搬过去

里面的 `cf_clearance` 是 Cloudflare 凭证，**绑定当时的出口 IP 和浏览器 UA**。换到另一个网络后：

- `cf_clearance` 立刻失效 → 第一个请求就撞 Cloudflare 挑战（归为 `challenge`，冷却 5~30 分钟）
- `sessionKey` 通常仍有效，但异地登录可能触发风控

正确做法是**在新机器重新登录一次**：会拿到新的 `sessionKey` + 新的 `cf_clearance` + 精确 UA，三者配套。
用同一账号登录不会产生重复账号（按 sessionKey 去重，相同则 upsert 更新凭据）。

### 同一出口 IP 换机

如果新旧机器走同一个路由器 / 同一公司网络（出口 IP 相同），`cf_clearance` 大概率仍然有效，
可以连 `accounts.json` 一起拷过去省掉登录。但重登只要几十秒，建议还是重登更干净。

### 跨公网给别的设备用

不要直接把 8787 映射到公网：没有 TLS，API Key 明文传输，而且 `accounts.json` / `config.json` 里就是凭据。
用 Tailscale / Cloudflare Tunnel 这类加密隧道，或者干脆每台设备各自跑一份。

## 注意

1. **凭据即账号**：`accounts.json`、`upstream.json` 和 profile cookie 泄露 = 账号泄露，
   勿提交仓库/云盘。
2. **合规**：把 free 账号接第三方客户端通常触碰 Anthropic ToS。仅自用、仅本机。
3. 代理默认只监听 `127.0.0.1`；要局域网访问，把 `config.json` 的 `server.host` 改成 `0.0.0.0`，并确保 keys 里已经有 key。
4. Desktop 账号的 cookie 每 10 分钟自动重解密一次；**桌面端正在运行时 Cookies 库
   可能被独占**，刷新会重试几秒后放弃并保留旧凭据（异步进行，不卡请求），下个周期再试。
   手动账号不会自动刷新，失效后从浏览器重新复制 `sessionKey`，用 `PATCH /v1/accounts/{id}` 轮换
   （会自动清掉旧冷却）。
5. 每次请求新建一个 `is_temporary` 会话（服务端自动清理），历史渲染进 `prompt`，
   所以代理本身无状态 —— 这也意味着**轮询换账号不会丢上下文**。
6. free 档 5h 窗口用完会 429（长冷却）。加账号是扩容的正解；单账号撞限后会自动冷却，
   别的账号继续服务。**桌面端与反代共用同一 sessionKey**，两边同时跑会撞上游并发上限
   （`concurrents` 429 → 短冷却 3/10/30s 自动重试，不拉黑账号）；要减少碰撞可调小
   `PER_ACCOUNT_CONCURRENCY`（默认 3）。
