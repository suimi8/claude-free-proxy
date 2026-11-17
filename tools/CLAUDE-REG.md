# Claude 账号「纯协议」注册工具

基于 `claude-reg.har` 抓包逆向出的 claude.ai 网页端注册协议链，**不依赖浏览器自动化**完成注册，
直接用 HTTP 请求 + 打码平台拿到可用的 `sessionKey`，最后写进反代账号池。

---

## 1. 协议链路（与 HAR 逐条对应）

| # | 请求 | 说明 |
|---|------|------|
| 1 | `GET https://claude.ai/login` | 建立会话 Cookie（`_fbp` / `anthropic-device-id` / `activitySessionId` / `ion-vk` / `__cf_bm` / `_cfuvid`），并从 HTML 里解析客户端指纹 |
| 2 | `GET /api/auth/login_methods?email=…&source=claude-ai` | 查询该邮箱支持的登录方式（`magic_link` / `google`） |
| 3 | 打码 sitekey `f1b21a9c-9100-4022-a928-8d5c29de2e6a` | **send** 通道的 hCaptcha（invisible） |
| 4 | `POST /api/auth/send_magic_link` | 请求魔法链接邮件，body 携带 `client_attestation.hcaptcha_token` |
| 5 | 轮询邮箱 → 解析 Magic Link | 链接格式 `https://claude.ai/magic-link#<nonce>:<base64(email)>` |
| 6 | 打码 sitekey `a8086506-2036-46f4-ae50-00d8be805efa` | **login** 通道的 hCaptcha（invisible） |
| 7 | `POST /api/auth/verify_magic_link` | 兑换 `sessionKey`（Set-Cookie） |
| 8 | onboarding 补齐 | `accept_legal_docs` / `age_is_verified` / `display_name` / `has_finished_claudeai_onboarding` |
| 9 | `GET /api/organizations` + `POST /v1/accounts` | 校验组织并写入反代账号池 |

### 关键指纹头

```
anthropic-client-build:   1794807535                      ← 注意：是 data-build-timestamp，不是 build-id
anthropic-client-sha:     c1052f6878c8bdf320783f727e4afbaf891341b3
anthropic-client-version: 1.0.0
anthropic-client-platform: web_claude_ai
anthropic-anonymous-id:   claudeai.v1.<uuid>
anthropic-device-id:      <取自 Cookie>
x-activity-session-id:    <取自 Cookie>
```

---

## 2. 两种打码引擎

| 引擎 | 参数 | 说明 |
|------|------|------|
| `yescaptcha` | `--captcha yescaptcha`（默认） | 第三方打码平台，30 点/次。**只能过 `send_magic_link`** |
| `local` | `--captcha local` | 本机 Chrome/Chromium + CDP 完成验证码，**签发 IP 与指纹和后续请求完全一致** |

`local` 引擎的实现细节：

1. **有头浏览器优先**：Linux 上没有 `$DISPLAY` 时自动拉起 `Xvfb` 虚拟屏（`1440x900x24`），
   用真实的有头 Chrome，而不是 `--headless`——无头浏览器会被 hCaptcha 直接判定为机器人，
   把 invisible 验证升级成 3×3 图形题。
2. **抹掉自动化特征**：`--disable-blink-features=AutomationControlled`、`navigator.webdriver → undefined`，
   并在注入组件前模拟鼠标轨迹 / 滚轮。
3. **图形题回退**：如果仍然出图形题，题目图片交给 YesCaptcha 的
   `HCaptchaClassification`（8 点/次，只返回「哪几张是目标」），
   点击动作在**本机浏览器**里用真实鼠标事件完成 →
   token 依然由本机 IP 签发。

### 第三方打码能不能过最后一步？（结论已更新）

**能。** 之前「YesCaptcha 一定被拒」的结论是错的，实测（2026-11-16）：

```
YesCaptcha HCaptchaTaskProxyless → token "P1_…"（约 2900 字符）
POST /api/auth/verify_magic_link
{ credentials: { method: "nonce", nonce, encoded_email_address },
  locale, client_attestation: { hcaptcha_token: "P1_…" }, source: "claude" }
→ 不再报 missing_client_attestation，而是 login_link_expired（nonce 过期）
```

错误码从「缺 attestation」变成「链接过期」——**send 通道的 token 确认被接受**。
但 **verify 通道后来被证伪**（2026-11-17）：

> ⚠️ **YesCaptcha 代解的 verify token 一律被拒**：换 2 个不同账号（均曾在池中成功登录）
> 重复 4 次，`verify_magic_link` 全部返回 403 `sign_in_not_permitted`，
> 且 nonce 被消费（后续兑换报 `login_link_already_used`）。
> 而**同一批账号用浏览器原生 attestation 一直是成功的**（池中 33 个账号均为浏览器流程产出），
> 且账号本身未死（sessionKey 调 `/api/organizations` 仍 200）。
>
> 结论：`send_magic_link` 接受代解 token，`verify_magic_link` 对 attestation 有更严校验
> （代解 token 过不了）。**verify 一步不要用打码积分**，用 `--link` 模式让浏览器自己完成。

两个 sitekey 分工不同，别用错：

| 用途 | sitekey |
|------|---------|
| `send_magic_link`（发信） | `f1b21a9c-9100-4022-a928-8d5c29de2e6a` |
| `verify_magic_link`（登录） | `a8086506-2036-46f4-ae50-00d8be805efa` |

> 错误码语义（2026-11-17 修正）：`missing_client_attestation` / `browser_not_verified`
> = token 本身没通过；`login_link_expired` = nonce 过期；`login_link_already_used` = 已用；
> **`sign_in_not_permitted` = verify 侧拒绝本次登录**（实测与「邮箱/账号被拉黑」无关——
> 被拒账号的旧 sessionKey 依然有效；更可能是 attestation 校验不过的统一话术）。
> 遇到它**立即放弃本次尝试，不要重试**（重试只会重复扣积分）。

---

## 3. 用法

### 本机直接跑

```bash
# 环境变量
export YESCAPTCHA_CLIENT_KEY=xxx
export MAOMAIL_TOKEN='Bearer xxx'          # 临时邮箱平台 Token（默认也读 config.json settings.maomailToken）

# 注册一个账号（默认第三方打码）
node tools/claude-reg-protocol.mjs --email user@example.com

# 用本机浏览器打码（推荐，能真正建号成功）
node tools/claude-reg-protocol.mjs --email user@example.com --captcha local

# 手动提供魔法链接（跳过发信与收信）
node tools/claude-reg-protocol.mjs --email user@example.com \
  --magic-link 'https://claude.ai/magic-link#<nonce>:<base64>'

# 浏览器辅助登录（最稳：页面自己出 attestation，脚本只负责填邮箱 / 取回退验证码 / 捕获 sessionKey）
node tools/claude-reg-browser.mjs --email user@example.com

# 【最终方案 · 推荐】协议发信（30 点）+ 浏览器点链接 verify（0 点）
node tools/claude-code-login.mjs --email user@example.com --proto --link   # 输出结果
node tools/claude-code-login.mjs --email user@example.com --proto --link --pool  # 成功后入池
node tools/claude-code-login.mjs --email user@example.com --attach-port 44701 --new-tab --send  # 复用已过 CF 的浏览器
node tools/claude-code-login.mjs --email user@example.com --code 377315  # 已知 6 位码时走页面兜底
```

积分账目（YesCaptcha 失败任务不扣点，成功 token 每个 30 点）：

| 模式 | 消耗 | 说明 |
|------|------|------|
| `--proto --link`（推荐） | **30 点** | 仅 send token；verify 由浏览器打开魔法链接自铸 attestation |
| `--proto`（verify 也走协议） | 60 点起 | verify token 大概率被 `sign_in_not_permitted` 拒掉（白花） |
| 工具内置硬上限 | ≤120 点 | send×1 + verify×1 + 失效重发×1；`sign_in_not_permitted` 立即放弃 |

每次运行自动写日志到 `logs/claude-login-<时间戳>-<邮箱前缀>.log`（VM 上是 `~/claude-reg/logs/`）：
毫秒级时间戳 + argv + 每一步的请求/响应/异常/退出码，`sessionKey` 与 cookie 只记脱敏前缀和数量，
方便直接回查卡点：`tail -f ~/claude-reg/logs/claude-login-*.log`。

### 在 Cage 虚拟机里跑（推荐，出口 IP 与验证码一致）

```bash
scp tools/yescaptcha.mjs tools/hcaptcha-local.mjs tools/claude-reg-protocol.mjs cagevm:~/claude-reg/tools/
scp plugins/maomail-auto-login/maomail.mjs cagevm:~/claude-reg/plugins/maomail-auto-login/

ssh cagevm "cd ~/claude-reg && set -a && . ./.env && set +a && \
  node tools/claude-reg-protocol.mjs --email xxx@yyy --captcha local --skip-pool"
```

虚拟机侧依赖：Node.js 22+、Google Chrome/Chromium、Xvfb（`apt install xvfb`，已预装）。
脚本会自己拉起 `Xvfb` 并用有头 Chrome 打码，无需 `$DISPLAY`。

### 主要参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--email` | — | 注册邮箱 |
| `--auto` | 关 | 从临时邮箱平台自动挑一个邮箱 |
| `--captcha` | `yescaptcha` | `yescaptcha` 或 `local` |
| `--magic-link` | — | 直接给定魔法链接；填 `-` 表示从 stdin 读一行 |
| `--proxy-base` | `http://127.0.0.1:8787` | 反代地址，用于自动入池 |
| `--skip-pool` | 关 | 只打印结果不入池 |
| `--dry-run` | 关 | 只跑到「发送魔法链接」 |
| `--timeout` | 120000 | 打码 / 等邮件超时（毫秒） |
| `--locale` / `--lang` | `ja-JP` | 语言 |
| `--utc-offset` | `-540` | 时区偏移（分钟） |

---

## 4. 踩坑记录

1. **`anthropic-client-build` 用错** → 用 `data-build-timestamp`（`1794807535`），
   不是 `data-build-id`（`c1052f6878`）。
2. **Magic Link 的 nonce 与会话绑定** → `send_magic_link` 与 `verify_magic_link`
   必须在同一个进程/同一套 Cookie 内完成，否则 403。
3. **`login_methods` 只返回 `google`** → 该邮箱已被绑定 Google 账号，换邮箱。
4. **临时邮箱域名不可投递** → Anthropic 不会发信（例如 `zjkdongao.cn` 就收不到），
   脚本表现为「等待验证邮件超时」。换可投递域名即可。
5. **跨境链路首个请求很慢** → 临时邮箱 API 的超时已放宽到 60s（`MaoMailClient.timeoutMs`）。
6. **`i18n` 文案 key 是哈希的** → 想看 Anthropic 的错误文案含义，得从
   `assets-proxy.anthropic.com` 的 JS bundle 里反查 `errorCode → 文案 key` 的映射。
7. **魔法链接页会卡在「読み込み中…」** → 它其实在等 hCaptcha（`image_label_area_select`）。
   同一链接被复用/重载（nonce 已消费）后，页面会回退成
   「認証コードを使用して続行」+ **6 位验证码**，并提示
   「最初にサインインを試みた場所で、この認証コードを入力してください」。
8. **邮件里没有验证码** → 模板里只有 `000000`（占位）和 `141413`（配色），
   真正的 6 位码只在魔法链接页的回退界面出现。
9. **验证码回退登录（推荐路径）** → 发信后登录页会出现 `#code` 输入框；
    nonce 换码（见第 10 条）后直接在这个框里提交即可。全程不需要解魔法链接页的 hCaptcha。
10. **真正的「nonce → 6 位码」接口（关键）** → 魔法链接页的 bundle 里写着：
    ```js
    POST /api/auth/exchange_nonce_for_code
    { nonce, encoded_email_address, source: "claude" }   // 不需要 client_attestation
    → { code: "105067" }
    ```
    所以魔法链接页的 hCaptcha **可以完全绕开**：拿 nonce 换码，再把码交给
    `/login` 的 `#code` 输入框。验证码登录的请求体是：
    ```js
    POST /api/auth/verify_magic_link
    { credentials: { method: "code", email_address, code }, locale, client_attestation, source }
    ```
    （`method: "nonce"` 才是 `{ nonce, encoded_email_address }` 那一支。）
11. **换码接口会占用 nonce 吗** → 不会影响 `#code` 提交；但同一个 nonce 只能用一次，
    重复换码/重复提交会返回 `login_link_already_used`。
12. **验证码页有多个 `data-testid="continue"`** → 邮箱步与验证码步的提交按钮同名，
    其中一个是隐藏的（`offsetWidth === 0`）。用 `querySelector` 会拿到隐藏那个，
    判定「按钮就绪」永远失败、点击也会误触「SSO で続ける」把页面打回邮箱页。
    必须 `[...querySelectorAll('button[data-testid="continue"]')]
    .find(b => b.offsetWidth && b.offsetHeight && !b.disabled)`。
13. **登录限流是按邮箱计的** → 同一地址短时间内反复发信，页面会显示
    「ログイン試行回数が多すぎます。しばらくしてから再度お試しください。」
    （`too_many_attempts`）。此时**换一个邮箱立刻就能继续**，说明出口 IP 没有整体封禁。
    已把该文案加入早退检测，不会再空等。
14. **已发出的链接不要浪费** → `--attach-port <调试端口>` 可以附加到正在运行的
    Chrome、跳过发信，直接从邮箱取 nonce 换码继续；配合 `--since <分钟>`
    回溯邮件时间（附加模式默认 20 分钟）。
15. **新账号需要 onboarding 才有 org** → 首次登录后 `/api/organizations` 可能是空数组，
    此时按顺序补：
    ```js
    PUT  /api/account/accept_legal_docs
    PUT  /api/account_profile        { full_name, locale }
    POST /api/accounts/me/organizations/get_or_create_chat_organization
    ```
    之后再读 `/api/organizations` 就能拿到 `uuid` / `rate_limit_tier`。
16. **onboarding 可能重新签发 cookie** → 入池前要重新 `Network.getAllCookies`
    再取一次 `sessionKey`，否则可能拿到过期值。
17. **纯协议登录（历史方案，verify 侧已被证伪）** → 发信后只取 nonce，用 YesCaptcha token 兑现：
    实测 `send_magic_link` 收代解 token，但 **`verify_magic_link` 对同一 token 返回
    403 `sign_in_not_permitted` 且消费掉 nonce**（2 个账号 × 多次复现）。
    此路径 verify 一步不要再用打码积分，改用第 20 条 `--link` 模式。
18. **`login_link_expired` 要重新发信，不要反复重试旧 nonce** →
    该错误表示「nonce 过期」，旧 nonce 已经没救了。
    协议重发一封新邮件，用新的 nonce/enc 再来一次；
    `waitForVerification` 的 `sinceTimestamp` 要改到「刚刚」。
19. **验证码页的 hCaptcha 是拖拽题且会自崩** → 实测题型为
    「アイコンをぴったり合う場所にドラッグしてください」，
    同时页面提示「もう一度やり直してください」，提交时 body 里是
    `client_attestation: { hcaptcha_mint_error: "challenge_closed" }`，
    必然换回 `missing_client_attestation`。
    现有图形题求解器只支持 3×3 九宫格，**不要把它当兜底**；优先走第 20 条。
20. **CF 前门 + verify 的最终解法（2026-11-17）**：
    - VM 直连 curl/Node 对 claude.ai 一律 403（`cf-mitigated: challenge`），
      但**全新 profile 的真实 Chrome（Xvfb 有头）5 秒内自动通过挑战**拿到
      `cf_clearance`，无需任何打码积分（诊断脚本 `probe-cfpass.mjs`）；
    - verify 用 `--link`：浏览器直接 `Page.navigate` 到邮件里的魔法链接，
      页面自己 mint attestation 并提交（等价于人点邮件链接），0 积分，
      sessionKey 直接出现在 cookie 里；
21. **CF clearance 会被集体作废（2026-11-17 实测）** → 池里 22 个账号全带
    `cf_clearance`+UA 却集体 `cloudflare_challenge`：不是缺失，是 CF 风控升级后
    批量作废旧 token。解法已内置反代（**不打码、0 积分**）：
    - 控制台每账号卡片新增「🛡 过CF」按钮 → `POST /v1/accounts/{id}/cfverify`
      （仅本机回环可调）→ `createCfVerifyManager`（`src/login-link.mjs`）弹一个
      有头 Chrome（临时 profile，**只种 sessionKey**，旧 clearance 不种避免污染）；
    - 用户手动过挑战后，轮询到新 `cf_clearance` → `validateLogin` 校验 →
      新 cookie 全串 + 浏览器真实 UA 一并 `POOL.set` 回池并清冷却/连败
      （手动停用的账号保持停用）；5 分钟超时，同一时间只允许一个流程；
    - `sec-ch-ua` 头已改为从账号 UA 的 Chrome 大版本派生（硬编码 140 与
      Chrome/156 这类 UA 不配套本身就是风控信号）；
    - 流程状态：`GET /v1/cfverify/{fid}/state`；UI 2s 轮询，终态自动刷新列表。
22. **挑战轮盘与求解器现状（2026-11-17）** → hCaptcha canvas 题三种形态：
    ①数数题（4×4 / 3×4 / 3×3 网格 + 侧栏「Nx」胶囊）：`solveIcons` v4 ——
    动态网格检测（亮度对比度积分峰，任意 WxH 自适配）+ 双极坐标描述子
    （亮度/饱和度各一套取 max，背景无关）+ 中部带列跨度 OCR 计数
    （1x=细杆 7px / 2x=宽腰 14px，**"3x" 会被误读成 2x**，靠免费换题兜底）。
    范例定位从「饱和带」改成「与侧栏底色（逐通道中位色）的色差带」——
    白羊毛/蓝灰鸽这类低饱和贴纸在米色栏上饱和带检测不到；
    ②拖拽题：`solveDrag`（徽章锚定 + 连通域 + chamfer DT），约 70% 命中；
    ③DOM 九宫格语义题 / 无 canvas：直接 スキップ 换题（免费）。
    新出现的「无可见磨砂字块」拖拽变体会报「未定位磨砂字块」→ スキップ。
    8 轮免费刷新，总成功率 >95%。probe 脚本：VM `~/claude-reg/probe-drag.mjs`。
23. **过CF 指纹独立 + 一键批量（2026-11-17）**：
    - **findBrowser 无条件 Chrome 优先**：原来会跟随系统默认浏览器——用户默认是
      Edge 时弹出 Edge（UA 带 `Edg/156`，与新 clearance 配套保存后上游头全错）。
      已删注册表跟随逻辑；`LOGIN_BROWSER` 环境变量仍可覆盖；
    - **每次过CF随机指纹 + 无痕**（用户点名要求）：`--incognito`（cookie/
      sessionKey 只进内存 jar 不落盘；临时 profile 仅用于保证独立 Chrome 进程 +
      CDP 端口生效，用完照删）；窗口尺寸 8 组池 + ±12px 抖动、Accept-Language
      4 组 ja 系变体，每次 Math.random 现场抽签（确定性派生会撞车：4×3 组合
      对 32 账号必有两账号共享指纹）。时区固定 Asia/Tokyo、UA 真实版本——
      与账号注册 locale / 真机 TLS 绑定，不能随机；canvas/WebGL/TLS 层不注噪；
    - **无痕 jar 关键坑**：无痕窗口用独立内存 cookie jar，浏览器级
      `Storage.setCookies/getCookies` 读写的是默认 jar（无痕页看不见）——
      种登录态和收 clearance 必须走**页面级** `Network.setCookie` /
      `Network.getCookies`（readCookies 已改为页面级优先），种完 `Page.reload`；
    - **一键批量**：工具栏「🛡 批量过CF」→ `POST /v1/cfverify/batch {ids}` →
      顺序弹窗（一次一个），实测 32/32 全成、约 28s/个、挑战基本自动过；
      `POST /v1/cfverify/{fid}/cancel` 主动停止；**关掉弹出的 Chrome 窗口 =
      停止批量**（防止关一个弹一个）；批量/flow 驻留代理内存，**跑完前别重启代理**；
    - `stateOf` 暴露 `fingerprint` 字段便于核对派生结果；
    - **profile 清理三保险（2026-11-17 补）**：① 单次流程所有终态（done/error/
      closed/timeout/异常）都走 `finally → cleanup`，800ms 延迟 `rmSync`（等
      taskkill 释放句柄）；② 管理器创建（代理启动）时 `sweepStaleProfiles()`
      收历史尸体——崩溃/强杀留下的 `claude-cf-verify-*` / `claude-free-login-*` /
      `claude-free-har-*` / `cfv-manual-test`（非无痕时期 profile 落盘过
      sessionKey，属凭据残留必须删；实测 3 个遗留 + 1 个构造目录启动即清）；
      ③ `PROFILES_IN_USE` Set 登记在跑流程的 profile，清扫时跳过防误删；
    - **健康账号不显示「🛡 过CF」**：卡片按钮条件渲染
      `${/cloudflare|challenge/i.test(a.last_error || "") ? 按钮 : ""}`——
      与「批量过CF」工具栏的筛选正则完全一致；webui.local.html（实际 serve）
      和 webui.html（镜像）两份同步改；
    - **「过了CF错误条还挂着」破案（2026-11-17 补）**：根因是 lastError 只在
      sessionKey 变化时清零（accounts.mjs `set()` L549 分支），而过CF恰好
      保留 sessionKey 只换 clearance → 全部账号挂着陈年 cloudflare_challenge。
      修了两处：① cfverify onCapture 传 `clearError: true`（POOL.set 新增
      该 patch 字段）；② `release(ok=true)` 成功即清 lastError（自愈）。
      **踩坑：GET /api/organizations 不在 CF 挑战规则内**——裸 sessionKey
      （完全无 clearance）都返回 200，拿它当健康检查全是假阳性（真门禁在
      POST completion 上，免费离线测不到，只能 /quota 发最小消息测真路径，
      每号耗 1 条消息）。据此删了 wash-cf-errors.mjs（其「健康→清标记」
      会把真被拦的账号也洗白，反而误导）；被拦账号的标记由 fail() 实时写、
      成功即清，池子状态自然保持真实，无需离线清洗；
    - **CF 风暴检测（2026-11-17 补）**：clearance 会被 CF 整批作废（撑过一夜
      全灭，疑似到期或出口 IP 变化——clearance 是 IP+UA 绑定的），死亡后每
      个 completion 都 502 + 冷却递增，用户侧表现为「频繁 502」。已加检测：
      openai-proxy.mjs 5 分钟滚动窗口数 challenge 失败（主完成流 catch 处
      `noteChallenge()`），`/v1/accounts` 返回 `cf_storm` 字段，WebUI 顶部
      红色横幅提醒点批量过CF；阈值 `CF_STORM_MIN`（默认 10 次/5min）；
    - **批量过CF后要复查漏网**：批量只自动筛「当前挂着 challenge 标记」的
      账号——若标记被误清过（如假阳性健康检查），死 clearance 账号会漏网，
      要等真实流量把它们重新打上标记后再补一轮批量（09:42 实测：23 个清零
      后重启，流量 10 分钟内又暴露 8 个漏网，补跑一轮全清）。
24. **求解器已合入主工具（2026-11-17）** → `tools/hcaptcha-canvas-solvers.mjs`
    （由 `tools/make-canvas-solvers.mjs` 从 probe-drag.mjs 拼接生成，勿手改——
    改算法先改 probe 再重新拼接保持两侧一致）：
    - `claude-code-login.mjs` 的 `solveIfVisible()` 策略改为：
      canvas 数数题/拖拽题**本地 0 积分优先** → 失败免费 スキップ 换题 →
      DOM 语义题才 YesCaptcha 兜底（无 key 也照跑，只是语义题跳过）；
    - 数数题「计划与上轮相同」= 挑战没刷新，自动 スキップ 防死循环；
    - OOPIF 基建：浏览器级 `Target.attachToTarget(flatten)` 拿 sessionId →
      frame 内 eval 抓 canvas → 浏览器级 Input 派发点击/拖拽（页面坐标 =
      iframe 原点 + 位图坐标 ÷ dpr）。
25. **`waitVerify(waves, sec)` 单位 bug 探针假死（2026-11-17）** → 定义是
    `await sleep(sec * 1000)`，调用却传毫秒 `waitVerify(5, 2000)`——每波睡
    2000 秒，表现为「提交答案后探针无声卡死、timeout 先杀进程、日志戛然而止」。
    曾被误判成 ssh 断管。定位手法：加 15s 心跳（`setInterval(...).unref()`）+
    每轮时间戳——心跳照跳、事件循环健在、`events` 冻结 ⇒ 异步链挂在某个
    超长 sleep 上，而非崩溃/断连。修复：参数改名 `intervalMs` 直用毫秒。
    教训：**「继续跑但永远不返回」先查 sleep 单位**；探针务必带时间戳。
26. **TLS 指纹伪装根治 CF 概率性 challenge（2026-11-17）**：node fetch(undici)
    的 JA3/H2 指纹是知名机器人特征，CF 对 completion 端点逐请求打分——
    **clearance 有效也照样概率性下发 challenge**（实测：两轮批量 31 个新
    clearance 几分钟内 20+ 账号又被打标；同一账号 9:33 probe 过、9:43 被
    拦）。解法：`tools/curl-impersonate/`（lexiforest fork v2.3.2 Windows
    构建，已 gitignore）——openai-proxy.mjs 的 `upstreamFetch`（唯一传输
    入口）在二进制存在时走 `curlFetch`（spawn curl-impersonate.exe
    `--impersonate chrome<N>`，`-i` 流式解析状态行+响应头，body 走
    `Readable.toWeb(PassThrough)` 同时支持 `getReader()`/`for await`，
    backpressure 经 drain/resume 传导，abort 杀进程，伪装层失败自动回退
    undici）；档位按账号 UA 的 Chrome 大版本选「不超过的最近档」
    （`curlProfileFor`）——**档位版本 vs UA 版本错位会被 CF 拦**
    （实测 chrome142 档 + Chrome/157 UA → 403；chrome152 档 → 200）。
    显式 `-H` 覆盖 UA/cookie 保持与 clearance 绑定一致。上线后 0 challenge。
    `UPSTREAM_IMPERSONATE=0` 可关。

---

## 5. 相关文件

| 文件 | 作用 |
|------|------|
| `tools/claude-code-login.mjs` | **当前主工具**：发信 → 取 nonce → YesCaptcha token → 协议登录 → onboarding → 入池；验证码页仅作兜底 |
| `tools/claude-reg-protocol.mjs` | 注册主流程（纯协议） |
| `tools/claude-reg-browser.mjs` | 浏览器辅助登录（真实页面出 attestation → 捕获 sessionKey → 入池），含「回退验证码」路径 |
| `tools/yescaptcha.mjs` | YesCaptcha 客户端（createTask / getTaskResult / HCaptchaClassification / /useragent） |
| `tools/hcaptcha-local.mjs` | 本机浏览器 hCaptcha 打码器（Chrome + CDP + Xvfb） |
| `tools/hcaptcha-challenge.mjs` | hCaptcha 图形题求解（读题 / 读图 / 真实鼠标点击，支持 OOPIF） |
| `tools/hcaptcha-canvas-solvers.mjs` | canvas 数数题 v4 + 拖拽题本地求解器（纯函数；由 make-canvas-solvers.mjs 生成） |
| `tools/make-canvas-solvers.mjs` | 从 probe-drag.mjs 拼接生成 hcaptcha-canvas-solvers.mjs（保持两侧算法一致） |
| `plugins/maomail-auto-login/maomail.mjs` | 临时邮箱平台客户端（收信、提取 Magic Link） |
