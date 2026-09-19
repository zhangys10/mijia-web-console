# 米家 Web 控制台

一个基于 Next.js、Vinext 和 Cloudflare Workers 的米家设备管理界面。它通过小米二维码登录同步家庭、房间和设备，并提供设备控制、能力发现、开关拓扑以及实际照明视图。

## 功能

- 小米二维码登录和区域选择
- 家庭、房间、物理设备及派生端点同步
- MIoT 规格发现、属性读写和动作调用
- 真实手动场景同步、执行、新建及安全编辑
- 真实自动化同步、IF/THEN 详情、定时创建及安全修改
- 实体开关、中控、智能灯具和普通回路的统一管理
- 按家庭隔离的开关/照明拓扑
- Siri 快捷指令驱动的“回家模式”AI 场景控制 PoC
- 桌面端和移动端响应式界面

## 自动化支持范围

自动化与手动场景共用米家 `AppSceneService`。控制台按家庭读取真实规则，并把时间、设备、位置、天气和厂商私有触发条件转换为不含账号凭据、真实位置或私有 payload 的展示模型。

自动化列表复用米家 `AppSceneService/GetSceneList`，请求时声明当前 App 协议版本（`app_version: 25, get_type: 2`），避免米家 App 中新建的规则被服务端按协议兼容性过滤掉。

- 已验证可写：指定时间与星期重复；标准 MIoT 可写属性动作。
- 安全只读：设备事件、位置、天气/日出日落以及必须由厂商原生插件配置的私有条件或动作。
- 修改未知规则时，服务端从米家云重新读取原始记录，仅替换明确编辑的字段，其他节点原样保留。
- 新建自动化默认停用；创建和修改只有在米家云回读到一致结果后才向界面报告成功。

设备条件与动作目录优先使用米家 App 同源的 `GetSceneTCAConfigV3`，按当前家庭真实 DID 和 `black_dids` 过滤；接口不可用时降级到小米官方型号目录，再降级到 MIoT Spec。目录响应只包含名称、类型和规格地址，不向客户端返回 TCA 原始节点或账号字段。

自动化 API 为 `GET/POST /api/xiaomi/automations`、`GET/PUT /api/xiaomi/automations/:automationId` 和只返回脱敏能力目录的 `GET /api/xiaomi/automations/catalog`。当前版本不提供删除操作。

设备建模与交互规则见 [设备管理设计](docs/device-management-design.md)。
AI 语音与 LLM 场景控制的范围、安全边界和验收标准见 [AI Home PoC 设计](docs/ai-home-poc-design.md)。

## 技术栈

- Node.js `>=22.13.0`
- Next.js 16 / React 19
- Vinext / Vite
- Cloudflare Workers
- TypeScript / ESLint

## 本地开发

安装锁定版本的依赖：

```bash
npm ci
```

为本地会话生成独立的随机加密密钥，并只注入当前终端：

```bash
export XIAOMI_SESSION_SECRET="$(openssl rand -base64 32)"
```

启动开发服务器：

```bash
npm run dev
```

默认情况下，Vite 会监听所有本地网络接口。浏览器中的米家二维码登录完成后，应用会把小米会话加密保存到 `HttpOnly` Cookie；服务端请求设备数据时才会解密使用。

## 配置

### `XIAOMI_SESSION_SECRET`

必填。该值用于通过 AES-GCM 加密二维码状态和小米会话 Cookie。

- 每个部署环境使用独立的高熵随机值。
- 不要复用小米密码、API 令牌或其他账号凭据。
- 不要把实际值写入源码、README、提交记录或日志。
- 轮换该值会使现有登录会话失效，用户需要重新扫码。

本地可以通过未跟踪的 `.env.local` 提供该变量；仓库的 `.gitignore` 会排除所有 `.env*` 文件。生产环境应使用部署平台的加密 Secret 配置。

### AI Home PoC

AI Home 正在从“用户自带模型 Key 的 Siri PoC”迁移到“EdgeOne Makers Agent + 项目级 AI Gateway + 用户配额”的 Web 助手。目标方案不要求用户输入或保存模型 Key，Gateway 凭据只通过服务端项目环境注入。

当前仓库仍保留旧 `/api/ai/command`、Automation Token 和 AI 设置页面作为待迁移兼容实现；它们不代表新架构 contract。新部署在迁移完成前应设置 `AI_COMMAND_ENABLED=false`，不要向用户开放旧模型 Key 流程。

Phase 0 已冻结 Web Chat、Agent 内部请求、错误码、Preview 策略和人工验证门禁。目标 EdgeOne 项目启用 Agents 且批准模型 ID 经人工验证后，才进入 Gateway Provider 实现。

### `AI_GATEWAY_API_KEY` / `AI_GATEWAY_BASE_URL` / `AI_GATEWAY_MODEL`

AI Gateway Provider 必需的三个服务端变量，由 EdgeOne 项目环境注入，客户端和请求体不提供任何 Gateway 凭据。

- `AI_GATEWAY_ALLOWED_MODELS`：逗号分隔的模型 allowlist，缺省只允许当前 `AI_GATEWAY_MODEL`。
- `AI_GATEWAY_TIMEOUT_MS`：上游调用超时，默认 `5000`，范围 `1–60000`。
- `AI_GATEWAY_MAX_OUTPUT_TOKENS`：单次最大输出 Token，默认 `256`，范围 `1–4096`。
- `AI_GATEWAY_API_KEY` 只进入上游 `Authorization: Bearer` 头；错误、日志和客户端响应不得包含该值。
- 模型固定使用非思考模式（`enable_thinking=false`），不设源码默认模型。

详细设计见 [AI Home PoC 设计](docs/ai-home-poc-design.md)，冻结接口见 [AI Home Phase 0 Contract](docs/ai-home-phase-0-contract.md)，实施顺序见 [AI Home 实现 TODO](docs/ai-home-implementation-todo.md)。

### Makers Agent

Phase 4 已实现 EdgeOne Makers Agent 入口、密封内部身份上下文、会话存储、幂等执行和 `list_scenes` / `activate_scene` 两个受控工具。Agent 请求不是公开 Web API；后续 Web Chat API 会先校验小米登录、家庭归属和用户配额，再携带内部鉴权调用 Agent。

- 模型只看到场景别名、名称和描述；Gateway Key、小米会话、真实场景 ID、DID 和原始用户 ID 不进入模型上下文。
- `AI_AGENT_INTERNAL_SECRET`：Web API 调用 Agent 的内部 Bearer Secret，每个部署环境独立，至少 32 个字符。
- `AI_AGENT_BASE_URL`：可选的远程 Makers Agent HTTPS origin。生产环境的 `mijia-agent` EdgeOne 部署地址为 `https://agent.fabloki.xyz`；设置后 Web Chat 和配额摘要路由到新 Agent 项目，未设置时保持同项目路由和本地配额模式。除 `localhost`、`127.0.0.1` 和 IPv6 loopback 的本地开发地址外，HTTP origin 会被拒绝。
- `AI_SCENE_APPROVED_IDS`：逗号分隔的低风险手动场景 ID 审核名单；默认为空，任何场景都不会被执行。
- 连续对话由 Makers Agent 的 `Makers-Conversation-Id` 和服务端 principal/home 派生的存储键隔离。
- 副作用必须携带 Idempotency-Key；相同请求只执行一次，不同请求复用同一 key 会返回冲突。
- stop 请求按官方 contract 携带 `Makers-Conversation-Id`，body 使用 `conversation_id`，并调用运行时 `abortActiveRun`。

### `AI_PRINCIPAL_SECRET`

必填于后续 AI Home 路径。服务端使用 HMAC-SHA256 从小米会话中的 `userId` 派生 `usr_` 前缀的 principalId。

登录后可在 `/ai/settings` 查看 principalId；`GET /api/ai/principal` 仅返回当前会话派生后的 ID。

- 每个环境使用独立的高熵 Secret，至少 32 个字符。
- 客户端请求体、Header 或查询参数不能覆盖 principal。
- Secret 轮换会改变同一用户派生出的 principalId，历史配额与会话需要迁移或重置。
- PoC 默认不轮换，如确需轮换请提前同步配额迁移方案。

### AI Quota

Phase 3 提供 `GET /api/ai/quota`（EdgeOne Edge Function），只返回当前 Cookie 会话对应 principal 的额度摘要。未设置 `AI_AGENT_BASE_URL` 时，控制台使用本地 EdgeOne KV 账本；设置后由远程 Agent adapter 负责 reserve/commit 和摘要，控制台只做身份鉴权与代理，不运行第二套账本。

- `AI_QUOTA_ENABLED`：默认 `true`。设为 `false` 时配额完全停用：本地模式不写 KV 账本；远程模式（`AI_AGENT_BASE_URL` 已设置）不要求 adapter 返回配额摘要，也不调用 `POST /api/internal/quota`，由控制台直接合成 principal 绑定的 `mode: "disabled"` 摘要。停用状态没有请求/Token 限额、没有 usage 记账、没有应用层 429，也没有模型费用保护，只适用于开发联调；生产迁移前必须按 M3 计划实现 adapter 配额后恢复 `true`。远程模式现在会校验该取值，非法值返回 500 `AI_QUOTA_CONFIG_INVALID`（此前远程模式会忽略全部配额配置）。
- `AI_QUOTA_DEFAULT_REQUESTS_PER_MINUTE` / `AI_QUOTA_DEFAULT_REQUESTS_PER_DAY` / `AI_QUOTA_DEFAULT_TOKENS_PER_MONTH`：默认 `10` / `50` / `100000`。
- `AI_QUOTA_UNLIMITED_IDS`：逗号分隔的服务端 principalId，优先级最高，仍记录 usage。
- `AI_QUOTA_OVERRIDES_JSON`：按 principalId 覆盖部分额度，未覆盖字段继承默认值。
- `AI_QUOTA_FAIL_MODE`：`closed`（默认）或 `open`；存储不可用时默认阻断请求。
- `AI_QUOTA_KV_BINDING`：EdgeOne KV 全局绑定名，默认 `ai_quota_kv`；Edge Function 只从 `globalThis` 读取该绑定。

EdgeOne KV 没有原子自增/CAS，且跨节点传播最长约 60 秒。日/月额度是软限额，并发或传播窗口内可能少量超额；不要将其作为精确硬限额或商业计费依据。

本地配额模式按实际结果结算：Agent 错误若附带已知模型 usage，则提交该 usage；Gateway 超时等结果未知的错误按请求预留估值保守结算；明确发生在模型调用前的配置或鉴权错误释放预留。底层网络请求在收到 Agent 响应前失败时仍释放预留，因为控制台没有可验证的远端 usage。设置 `AI_AGENT_BASE_URL` 后，这些 reserve/commit/release 操作由远程 adapter 负责（`AI_QUOTA_ENABLED=false` 时整体停用，见上文），控制台不会写本地账本。

### AI Web Chat API

Phase 5 提供 Cookie 鉴权的非流式 Web Chat API，浏览器不提交 principal、米家凭据、Gateway Key、Agent 内部 Secret 或原始 Makers conversation ID。

- `POST /api/ai/conversations`：body 为 `{ "homeId": "..." }`，签发绑定当前登录用户和家庭的不透明 `conversationId`。
- `POST /api/ai/chat`：body 为 `{ "conversationId"?, "homeId", "message", "idempotencyKey"? }`，统一执行 principal 派生、家庭校验、Agent 调用和配额结算；远程 Agent 模式由 Agent adapter 返回配额摘要，`AI_QUOTA_ENABLED=false` 时由控制台返回固定的停用摘要。
- `DELETE /api/ai/conversations/:conversationId`：只清除当前用户、当前家庭对应的 Agent 对话记忆，不修改米家设备、场景或配额账本。
- 未提供 `idempotencyKey` 时，请求只拥有 `ai:chat` scope，不能执行 `activate_scene`；需要设备副作用的请求必须提供 16–128 字符的幂等键。
- 所有响应均为 JSON 并设置 `Cache-Control: no-store`；首期不提供 SSE。

Web API 默认通过同项目 `/ai-home` 和 `/ai-home/delete` Agent 路由通信；设置 `AI_AGENT_BASE_URL` 时改用远程 Agent origin。内部请求使用 `Makers-Conversation-Id` 与 `Authorization: Bearer <AI_AGENT_INTERNAL_SECRET>`。客户端响应不会返回 Agent usage 明细、真实场景 ID、DID、原始 Xiaomi userId 或任何 Secret。

`AI_ENVIRONMENT=preview` 时，聊天在完成 Cookie 鉴权、家庭归属和会话句柄校验后直接返回固定 mock 文本 `预览模式：不会调用模型或控制真实设备。`，配额模式为 `disabled`。该路径不创建执行 scope、不调用 Makers Agent，也不预留或消耗配额；删除会话返回本地幂等成功。预览判定只读取 `AI_ENVIRONMENT`，不读取 `VERCEL_ENV` 等平台特定变量；各平台的预览部署需显式设置该变量。Preview 部署应保持 `AI_AGENT_BASE_URL` 未设置，避免在进入服务层 mock 之前因无效远程配置失败。

EdgeOne KV 审批完成前，本地自动化测试使用 `InMemoryQuotaStore`。如果只做本地 Agent/Web API 联调，可以在本地临时设置 `AI_QUOTA_FAIL_MODE=open`；生产环境仍应保持默认 `closed`，不得在 KV 未绑定时继续产生共享模型费用。

本地人工验证建议使用 `edgeone makers dev` 启动同项目 Edge Functions 与 Agent，并准备已登录浏览器中的 `xiaomi_session` Cookie。以下命令中的 Secret 和 Cookie 只应保存在当前终端，不要写入仓库或 shell history：

```bash
export BASE=http://localhost:8088
export COOKIE='xiaomi_session=<local-cookie>'

CONV="$(curl -fsS -X POST "$BASE/api/ai/conversations" \
  -H 'Content-Type: application/json' \
  -H "Cookie: $COOKIE" \
  --data '{"homeId":"<your-home-id>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).conversationId')"

curl -i -X POST "$BASE/api/ai/chat" \
  -H 'Content-Type: application/json' \
  -H "Cookie: $COOKIE" \
  --data "{\"conversationId\":\"$CONV\",\"homeId\":\"<your-home-id>\",\"message\":\"查看可用场景\"}"

curl -i -X POST "$BASE/api/ai/chat" \
  -H 'Content-Type: application/json' \
  -H "Cookie: $COOKIE" \
  --data "{\"conversationId\":\"$CONV\",\"homeId\":\"<your-home-id>\",\"message\":\"执行回家模式\",\"idempotencyKey\":\"manual-phase5-$(date +%s)\"}"

curl -i -X DELETE "$BASE/api/ai/conversations/$CONV" \
  -H "Cookie: $COOKIE"
```

预期结果：创建会话返回 201；聊天返回 200、相同 `conversationId` 和脱敏 quota；副作用请求只执行审核名单中的低风险场景；删除返回 200，随后使用同一句柄会建立空的 Agent 对话历史。KV 未绑定且 `AI_QUOTA_FAIL_MODE=closed` 时，聊天应返回 503 `AI_QUOTA_STORE_UNAVAILABLE`。

## 常用命令

```bash
npm run dev        # 启动 Vite/Vinext 开发服务器
npm run build      # 生成 Cloudflare Worker 构建产物
npm run build:edgeone # 生成 EdgeOne Makers 使用的 Next.js 构建产物
npm run build:vercel # 生成 Vercel 使用的 Next.js 构建产物
npm run start      # 启动已构建的 Vinext 应用
npm run typecheck  # 检查应用 TypeScript 类型
npm run lint       # 运行 ESLint
npm test           # 构建并运行全部 Node 测试
```

## 部署

构建产物是 Cloudflare Worker 应用，入口为 `worker/index.ts`：

```bash
npm ci
npm run build
```

部署前，在目标 Cloudflare 环境中安全设置 `XIAOMI_SESSION_SECRET`。不要在命令历史、远程 URL、公开构建日志或版本库文件中传递实际值。具体发布命令可以按使用的 Cloudflare Workers 项目或 CI 流程配置。

### EdgeOne Makers

仓库中的 `edgeone.json` 会让 EdgeOne Makers 执行原生 Next.js 构建并使用 `.next` 产物。不要把 EdgeOne 的构建命令改回 `npm run build`：该命令面向 Cloudflare Workers，生成的是 Vinext `dist`，不包含 EdgeOne 的 OpenNext 插件所需的 `.next/required-server-files.json`。

部署前，在 EdgeOne Makers 项目的 Environment Variables 中安全设置高熵的 `XIAOMI_SESSION_SECRET`。配置修改后重新部署。

### Vercel

仓库中的 `vercel.json` 会让 Vercel 使用原生 Next.js 构建，而不是面向 Cloudflare Workers 的 Vinext 构建。Vercel 项目的 Framework Preset 应为 Next.js，Output Directory 保持为空或默认值，不要设置为 `dist`。

部署前，在 Vercel 项目的 Environment Variables 中设置高熵的 `XIAOMI_SESSION_SECRET`，并为 Production、Preview 等需要登录能力的环境分别配置。配置后重新部署，使 Route Handlers 能够安全加密米家会话。

## 安全说明

- 本项目不需要或存储用户的小米账号密码；用户在小米提供的二维码页面完成认证。
- `serviceToken` 和 `ssecurity` 是小米协议的运行时会话字段。它们只应从小米登录响应取得，并在加密 Cookie 和服务端请求中使用。
- 状态接口只返回脱敏后的用户标识，不返回会话字段。
- 不应在客户端响应、应用日志、错误消息、示例配置或测试夹具中输出真实会话值。
- 如果怀疑部署密钥或小米会话泄露，请立即轮换部署密钥、清除站点 Cookie，并重新扫码登录。

## License

本仓库当前未声明开源许可证。未经版权所有者许可，不得假定具有复制、修改或再分发权限。
