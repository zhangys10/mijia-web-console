# 本地端到端联调（不调用真实模型，也不依赖 EdgeOne Blob）

本流程在本机串起 **Console → Makers Agent adapter → Python Assistant → Console 家庭工具 API**。Makers adapter 用仓库内的 loopback shim 和内存状态模拟；Gateway 用本地固定响应的 fake server，不会访问任何模型供应商；家庭助手授权配置存放在 Console 本地文件目录，不访问 EdgeOne Blob。

```text
浏览器 → 本地 Console :3000
              ↓ /ai-home
本地 Agent shim :8789 → Python :8000/internal/v1/assistant
                              ├→ fake Gateway :9901/v1/chat/completions
                              └→ 本地 Console :3000/api/internal/assistant/v1/*
```

## 联调边界

- Python 和 Console 间使用真实 HTTP、真实路由和当前鉴权；Makers adapter 使用真实 `ai-home` handler。
- 模型请求由本地 fixture 固定生成一次家庭只读 tool call 和一次最终答复；Fake Gateway 不记录请求正文。
- Agent adapter 的 `context.store` 使用本地进程内存，不验证 Makers 跨实例状态持久化。
- Console 仍需有效的本地登录会话和米家家庭读取权限。家庭查询会访问登录账号的米家云只读 API；Phase 2 没有设备写入工具。
- 本地授权文件位于 Console 的 `.local/assistant-exposure/`，不与生产 Blob 配置共享。所有本地服务只监听 loopback。

## 一键启动

在 `mijia-web-console` 根目录运行：

```sh
python3 scripts/local-integration.py start
```

`start` 会自动创建/更新 Console 根目录的 `.local-integration.env`、`.env.local`，启动 fake Gateway、Python、Makers shim 与 Next/Vinext Console，并在 Ctrl-C 时一起关闭。密钥为本机生成的随机开发值，文件权限为仅当前用户可读写；已生成的本地密钥会在重复运行时复用。也可以运行 `python3 scripts/local-integration.py setup` 只生成配置，或运行 `python3 scripts/local-integration.py setup --reset` 轮换本地密钥。

Console 原有 `.env.local` 中其他未托管的配置行会保留；脚本管理的 AI 本地联调变量会更新为 loopback 地址和随机本地密钥。不会配置 `PAGES_PROJECT_ID` 或 `PAGES_BLOB_API_TOKEN`，也不会读取或覆盖 `adapters/edgeone/.env`。

本地 `/api/ai/exposure` 和 assistant v1 API 在 `AI_ENVIRONMENT=development` 时使用开发存储：Cloudflare Vite Worker 开发运行时使用进程内存（重启后清空），Node 运行时使用 `AI_ASSISTANT_EXPOSURE_DIR` 指定的文件存储（未指定时为 `.local/assistant-exposure/`）。直接运行 Node 开发服务器且未设置 `AI_ENVIRONMENT` 时也会自动选用该本地存储；显式设置为 `preview` 或 `production` 时仍走 Blob 路径，不可用则失败关闭。默认拒绝和曝光过滤逻辑与 Blob 实现相同。本地与 EdgeOne 部署均由 Next Route Handler 处理；生产路径继续使用现有 Pages Blob namespace。部署迁移后需在 staging 验证 SSR 运行时能够读取/写入该 namespace。

打开 `http://127.0.0.1:3000`，登录米家账号，选择用于测试的家庭，再到「设置 → AI 助手访问权限」开放所需的只读指标/设备。

## 从 Console 发起联调

打开本地 Console 的 AI 助手，提问：

```text
客厅温度是多少？
```

预期路径是：

1. Console 创建聊天 turn 并调用 `http://127.0.0.1:8789/ai-home`。
2. Agent adapter 向本地 Console `/api/ai/tools` 验证短期 automation token，再转发到 Python `/internal/v1/assistant`。
3. Python 调用本地 `http://127.0.0.1:9901/v1/chat/completions`；fake Gateway 返回 `get_home_environment` tool call。
4. Python 用同一个 opaque token 回调 Console `/api/internal/assistant/v1/capabilities` 与 `/tools:invoke`。
5. Fake Gateway 收到 tool result 后返回固定答复，Console 展示回答和结构化环境数据。

Fake Gateway 终端只应显示 `scripted tool call` 与 `scripted final answer`。检查 Agent、Python、Console 各自终端确认请求经过本地端口；不得把 Authorization header、cookie 或 Token 打印出来。

若没有在 Console 中授权 `客厅.temperature`，预期读取失败或能力不可用；这可以验证默认拒绝和曝光过滤。不要用一个隐藏的假后端让权限检查“通过”。

## 故障排查

- **`Service URL must use HTTPS`**：本脚本用 Uvicorn 启动 Python，并注入 `AI_ENVIRONMENT=development`。如果改用 PythonFunctionBuilder，必须在该构建器实际读取的本地环境中设置此值；不要放宽生产 URL 校验。
- **Console 曝光 API 返回 `AI_EXPOSURE_STORE_UNAVAILABLE`**：检查 Console 是否运行在本地 Node 开发模式，或显式设置 `AI_ENVIRONMENT=development`；如设置了 `AI_ASSISTANT_EXPOSURE_DIR`，确认该目录可写。显式 `preview`/`production` 环境需要可用的 Pages Blob 配置。
- **Agent shim 返回 `AI_UNAUTHENTICATED`**：检查 Console 与 adapter 的 `AI_AGENT_INTERNAL_SECRET`，以及 adapter/Python/Console 共同使用的 `AI_TOOLS_INTERNAL_SECRET`。
- **Python 返回 `AI_UNAUTHENTICATED`**：检查 adapter 与 Python 的 `AI_PYTHON_INTERNAL_SECRET` 是否一致。
- **Fake Gateway 返回 `AI_GATEWAY_UNAVAILABLE`**：确认 `AI_GATEWAY_BASE_URL` 是 `http://127.0.0.1:9901/v1`，并且 fake server 正在运行。
- **家庭读取不可用**：确认本地 Console 已登录、使用同一个家庭，且在该本地 Console 设置中为房间开放了对应指标。

## 本流程没有验证的内容

它不调用真实模型，也不验证 EdgeOne Functions 的真实部署环境、Makers 持久化、Blob 跨 worker 一致性、配额或物理设备执行。要验证这些生产特性，仍需单独部署测试环境并使用对应 runbook。
