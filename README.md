# Claude Desktop (free) → OpenAI 兼容反代

[![Node.js >=22.19.0](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-43853d?logo=node.js)](package.json) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

将你有权使用的 Claude Desktop 会话接入本地 HTTP 服务。网关提供 Chat Completions、Responses 和 Messages 接口，支持流式输出、工具调用和多轮对话。WebUI 与 API 共用一个端口，默认地址为 `http://127.0.0.1:8787`。

[快速上手](#快速上手) · [Docker 部署](#docker-部署) · [客户端接入](#客户端接入) · [版本与更新](#版本与更新) · [WebUI 请求日志](#webui-请求日志) · [故障排查](#故障排查) · [数据备份与升级](#数据备份与升级)

## 快速上手

本机部署需要 **Node.js 22.19.0 或更高版本**。在终端中克隆仓库并安装锁文件中的依赖。

```sh
git clone https://github.com/suimi8/claude-free-proxy.git
cd claude-free-proxy
npm ci
```

Windows 在 PowerShell 运行 `./start.cmd`，也可以双击 `start.cmd`。Linux 和 macOS 运行 `npm start`。保留启动窗口，在同一台机器的另一个终端运行就绪检查。

```sh
npm run doctor -- 8787
```

看到 `Gateway ready on 8787` 即可打开 `http://127.0.0.1:8787`。首次启动会在私有 `config.json` 的 `keys` 数组中生成两个 Key。用 `role: "admin"` 对应的 Key 登录 WebUI，在「账号池」中添加你有权使用的会话。给 DSH 等客户端填写 `role: "inference"` 对应的 Key。

| 检查 | 所需凭据 | 能确认什么 |
| --- | --- | --- |
| `GET /readyz` | 无 | 当前地址有网关响应。预期为 HTTP 200，并带有 `X-Gateway-Service: claude-desktop-proxy`。账号池为空时也可检查 |
| `GET /healthz` | 管理 Key，默认从回环地址访问 | 查看账号池、模型与调度状态。验证实际生成能力时，再从客户端发送一条短消息 |

需要供局域网客户端访问时，在受信网络中使用 `./start.cmd lan` 或 `npm run start:lan`，并将客户端地址改为网关所在机器的地址。

## Docker 部署

在仓库根目录运行以下命令。Compose 默认将端口发布到宿主机 `127.0.0.1:8787`，将数据保存在挂载到 `/app/data` 的命名卷中。

```sh
docker compose up -d --build
docker compose ps
docker compose exec claude-proxy node src/doctor.mjs
```

从宿主访问 `http://127.0.0.1:8787/readyz` 可验证端口映射。`PROXY_PORT` 可更改宿主端口。同一 Compose 网络中的其他容器通过 `http://claude-proxy:8787` 访问网关。

使用单容器部署时，可在 Bash 中运行以下等价命令。

```bash
docker build -t claude-free-proxy .
docker run -d --name claude-free-proxy --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v proxy-data:/app/data claude-free-proxy
```

管理接口按进程看到的来源地址判断是否来自回环。桥接网络可能把宿主请求显示为非回环来源。如果需要从宿主管理，请保持端口只发布到 `127.0.0.1`，确认容器网络受信后设置 `ALLOW_REMOTE_ADMIN=1`，再运行 `docker compose up -d` 重新创建容器。管理请求仍需提供管理 Key。

## 版本与更新

当前正式版为 **v0.5.3**。WebUI 顶栏显示当前版本和 GitHub 仓库入口。点击版本号可查看发布说明、作者主页和检查时间。网关在启动后检查正式 Release，此后每六小时检查一次。管理员可以手动检查或点击「立即更新」。

用 `npm start`、`start.cmd` 或 Compose 启动时可安装热更新。网关先核对发布附件的 SHA-256，再等待在途请求结束，随后短暂切换进程。新版通过就绪检查后才记为当前版本，启动失败会回到上一版。数据目录保存生效版本。运行依赖、启动器变化或本地代码与新版发生冲突时，界面会提示使用完整发布包。

管理员可设置 `GATEWAY_UPDATE_CHECK=0` 关闭后台检查，仍可在版本弹窗手动检查。

**发布后续版本。** 在公开源码工作区递增 `package.json` 和锁文件的版本，在本地完成回归验证，暂存要发布的文件，再运行 `npm run release:build -- <输出目录>`。源码和安装包均按公开文件清单发布。把生成的 `release-integrity.json` 一并提交，用对应的标签创建 GitHub 正式 Release，并上传生成的 `.tgz` 安装包和 `.update.json.gz` 热更新包。客户端通过标记为 Latest 的正式 Release 发现更新。

[GitHub Releases](https://github.com/suimi8/claude-free-proxy/releases) · [作者主页](https://github.com/suimi8)

## 客户端接入

下表按网关与客户端在同一台机器上填写。每种模式都使用调用 Key。

| 客户端或模式 | 客户端中填写的 Base URL | 网关实际收到的请求 |
| --- | --- | --- |
| OpenAI Chat 兼容客户端、DSH `openai-completions` | `http://127.0.0.1:8787/v1` | `POST /v1/chat/completions` |
| OpenAI Responses 兼容客户端 | `http://127.0.0.1:8787/v1` | `POST /v1/responses` |
| DSH `anthropic-messages` | `http://127.0.0.1:8787` | `POST /v1/messages`。DSH 会追加 `/v1/messages` |

**选择模型。** 将调用 Key 放入当前终端的 `PROXY_API_KEY` 环境变量。用下面的命令查询模型，从返回的 `data[].id` 中选取该 Key 获准使用的模型，并填入客户端。

```powershell
$root = 'http://127.0.0.1:8787'
$auth = @{ Authorization = "Bearer $env:PROXY_API_KEY" }
(Invoke-RestMethod "$root/v1/models" -Headers $auth).data | Select-Object -ExpandProperty id
```

**验证一次生成。** 在同一个 PowerShell 窗口运行下例，按提示粘贴选定的模型 ID。

```powershell
$model = Read-Host 'Model ID'
$body = @{ model = $model; messages = @(@{ role = 'user'; content = 'Reply OK' }) } | ConvertTo-Json -Depth 4
$reply = Invoke-RestMethod "$root/v1/chat/completions" -Method Post -Headers $auth -ContentType 'application/json' -Body $body
$reply.choices[0].message.content
```

<details>
<summary>使用 cURL 或 Python SDK 验证流式输出</summary>

在 Bash 中，将示例里的 `MODEL_ID` 替换为 `/v1/models` 返回的模型 ID。`curl -N` 会在收到 SSE 数据时显示它。

```bash
curl -sS -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

已安装 OpenAI Python SDK 的客户端也可以逐段读取正文。把选定的模型 ID 放入 `PROXY_MODEL` 环境变量。

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=os.environ["PROXY_API_KEY"])
response = client.chat.completions.create(
    model=os.environ["PROXY_MODEL"],
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in response:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
```

</details>

- **流式响应。** Chat 和 Responses 请求可传 `"stream": true`。Responses 客户端按顺序拼接 `response.output_text.delta` 事件的 `delta` 字段。遇到 `response.incomplete` 时，保留已有内容并检查 `incomplete_details.reason`。
- **Responses 续聊。** 用同一个调用 Key 提交 `previous_response_id`。设置 `store: false`、网关重启或旧记录被淘汰后，下一次请求需传回对话历史。
- **Token 预估。** `POST /v1/messages/count_tokens` 使用同一个调用 Key，返回 `input_tokens`。响应头 `X-Token-Count-Source: local-estimate` 表示计数在本地完成。Chat 流式请求可用 `"stream_options": {"include_usage": true}` 取得结束前的用量统计。
- **网页搜索。** `POST /v1/tools/search` 由网关向 DuckDuckGo 查询。用调用 Key 发送 JSON，例如 `{"query":"Node.js streams","count":3}`，读取响应中的 `results` 数组。客户端若要求填写完整搜索端点，同机默认是 `http://127.0.0.1:8787/v1/tools/search`。

## WebUI 请求日志

打开「用量统计 / Tokens」，选好时间范围和账号，向下找到「请求日志」，按时间和模型定位请求。窄屏可在表格内横向滚动。

| 想了解什么 | 在请求日志中怎么看 |
| --- | --- |
| 为什么等了很久才看到回复？ | 对照「首字」「思考」与「耗时」。首字记录到首个增量的等待时间，耗时覆盖整次请求 |
| 开始输出后到底有多快？ | 将指针停在「速度」上，可查看正文书写时间、收尾空闲和端到端速度。表格中的 tok/s 按可见正文计算 |
| 这一轮为什么失败？ | 将指针停在失败行的「状态」上查看完整错误，再和客户端同一时间的末尾事件对照 |

账号池支持 `least-loaded` 和 `round-robin` 调度。排查额度或并发问题时，在「账号池」查看对应账号的启用状态、配额和冷却时间。

## 故障排查

### `503 connect-refused` 或 `circuit open`

从 **DSH 所在的系统或容器** 访问网关的 `/readyz`。若连接被拒绝，检查启动窗口、监听地址和端口。容器中的 `127.0.0.1` 指向容器自己，同一 Compose 网络内使用服务名 `claude-proxy`。就绪检查通过后，等客户端提示的下一次探测，再用一条短消息验证。

### `pi-ai stream idle timeout` 或 `upstream stopped making progress`

- `重试延迟：500 毫秒` 表示客户端计划多久后再试。`pi-ai stream idle timeout after 300000ms` 表示客户端的五分钟空闲计时器已到期。记录报错时间，对照 WebUI 中该请求的耗时与状态。
- 遇到 `upstream stopped making progress` 时，检查错误中的 `phase` 和 `timeout_ms`。普通阶段默认允许 120 秒没有协议进展。收到思考块或思考摘要后，网关默认允许 360 秒，直到收到非空正文、工具调用或结束原因。心跳只表示连接活动。`last_byte_age_ms` 给出距最近收到上游数据的毫秒数。显式设置 `SSE_IDLE_TIMEOUT_MS` 会覆盖两种默认值，可用 `SSE_THINKING_IDLE_TIMEOUT_MS` 单独指定思考阶段的上限（毫秒）。

### `transport interrupted`、工具参数缺失或命令出现在正文

并发代理可以共享一个调用 Key。网关会把同一条上游消息重复发送的起始事件合并为一个。若两个起始事件的消息身份冲突，网关只在尚未交付输出时重新建立一次请求。已交付输出的请求会返回流错误，以免客户端重复执行工具。

默认 `CACHE_MODE=stats` 只统计前缀命中。启用 `CACHE_MODE=reuse` 时，纯文本续写需要显式会话标识和完整匹配的历史，每个父消息只供一个请求续写。并发分支及工具请求使用各自的上游会话。

`transport interrupted` 表示网关在收到完整的上游结束事件前丢失了数据流。流式请求可能已经返回 HTTP 200，仍需读取末尾的 Chat `error`、Responses `response.failed` 或 Messages `error` 事件。

遇到 `invalid tool delta` 或 `tool stop without a tool block` 时，检查客户端发送的工具名、参数声明和返回的错误。网关交付工具调用前会校验工具块、JSON 对象和声明的必填参数。正文里出现 `[TOOL_CALL …]` 或 `<function_calls>` 只说明收到了这些文字。涉及写文件、运行命令等操作时，先核对实际结果，再决定是否重试。

### `429 no eligible account available`

在「账号池」检查是否有已启用且当前可用的账号。若账号处于冷却期，按返回的恢复时间再试。若同一时段有多个请求，检查并发占用。

## 数据备份与升级

- **数据目录。** 设置 `DATA_DIR` 可集中存放 `config.json`、`accounts.json`、可选的 `upstream.json`、`usage/` 和 `logs/`。未设置时默认使用项目根目录，也兼容已有的 `config/*.json`。备份和迁移时使用服务实际读取的目录。
- **升级。** 先停掉原服务并备份数据。旧安装需要补管理 Key 时，在项目目录运行 `node src/init-admin.mjs`，沿用服务的 `DATA_DIR` 或 `CONFIG_FILE`。该命令保留现有调用 Key，已有管理员时可重复运行。
- **容器迁移。** 旧部署若使用单文件挂载，先备份，再把实际配置文件及需要的日志恢复到 `/app/data` 对应的命名卷或私有绑定目录，并确保容器内 `node` 用户可读写。保留原数据卷直至核对账号和日志完成。
- **程序打包。** `npm run pack:release` 按发布清单生成程序归档。迁移时另行备份私有数据，在新机器解包后运行 `npm ci`。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/openai-proxy.mjs` | HTTP 路由、协议转换与 WebUI 托管 |
| `src/accounts.mjs`、`src/config.mjs` | 账号池、服务配置及 Key 权限 |
| `web/webui.html` | 管理控制台 |
| `config/*.example.json` | 配置示例 |

提交 Issue 时请提供接口、错误类型和时间，并移除 Key、Cookie、账号标识及对话正文。请使用获准的会话，遵守上游服务条款。本项目采用 [MIT License](LICENSE)。
