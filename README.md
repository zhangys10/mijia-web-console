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

### AI Home

AI Web 助手的 Agent 运行时已迁移到独立的 `mijia-agent` 仓库（EdgeOne Makers Agent + Python agent，独立部署，生产地址 `https://agent.fabloki.xyz`）。本仓库只保留 Cookie 鉴权的 Web Chat / 会话 / 配额 API、principal 派生、短期 Automation Token 和 `/api/ai/tools` 只读工具 facade；模型调用、场景执行和配额记账全部由远程 Agent 完成。

旧嵌入式 `/api/ai/command` 编排已下线：该路由现在返回 `410 AI_COMMAND_RETIRED`，命令流量由 mijia-agent 的 `POST /ai/command`（automation token 直连入口）承接。本仓库保留 AI 设置页的 Automation Token 签发（不含 BYOK 模型字段，令牌只封装米家会话与可选绑定家庭）；模型访问统一由 Agent 侧的 Makers Gateway 提供。

Phase 2 的家庭读取通过 `/api/internal/assistant/v1/capabilities` 与
`/api/internal/assistant/v1/tools:invoke` 提供。在「设置 → AI 助手访问权限」中，家庭成员
逐房间开放环境指标、逐设备开放只读状态；初始状态全部关闭。生产授权配置保存在
EdgeOne Makers Blob 的 `mijia-ai-assistant-exposure-v1` 命名空间，并使用强一致读取。该授权配置按哈希化的 `homeId` 保存，不绑定某个米家 `userId`；每次读取前仍会校验当前登录会话是否属于该家庭。因此同一家庭的授权对有权访问该家庭的成员共享，不会改变米家账号本身的权限。
EdgeOne Pages 运行时，Blob SDK 使用平台提供的部署凭据。Node/Next 本地开发在
`AI_ENVIRONMENT=development` 时将配置读写到 `AI_ASSISTANT_EXPOSURE_DIR` 指定的本地文件目录；
其他环境不会使用此开发存储，Blob 不可用时返回 `503 AI_EXPOSURE_STORE_UNAVAILABLE`，不会回退到内存或 KV。
可运行 `scripts/local-integration.py start` 自动生成本地 `.env.local` 并启动端到端联调，
无需 Pages Blob 凭据。生产 Next Route Handler 使用 Blob namespace 和强一致读取；EdgeOne 部署切换后需在 staging 单独验证现有 namespace 的读取与写入。
敏感设备类别不会列为可开放项，读取过滤只会减少已授权数据。

### 远程 Makers Agent

Agent 运行时位于独立的 `mijia-agent` 仓库。本仓库的 Web Chat API 在完成小米登录、家庭归属和会话校验后，签发短期 Automation Token 并携带内部鉴权调用远程 Agent；Agent 端点不是公开 Web API。Makers adapter 会先通过 `/api/ai/tools` 重新解析 token 并比对 principal/home，再读取对话或调用 Python；Python 仅在模型选择家居能力时原样转发 token。

- `AI_AGENT_BASE_URL`：远程 Makers Agent origin，非预览聊天与会话删除的必填配置。生产环境的 `mijia-agent` EdgeOne 部署地址为 `https://agent.fabloki.xyz`；未设置时非预览请求返回 502 `AI_AGENT_UNAVAILABLE` 配置错误。除 `localhost`、`127.0.0.1` 和 IPv6 loopback 的本地开发地址外，HTTP origin 会被拒绝。
- `AI_AGENT_INTERNAL_SECRET`：Web API 调用 Agent 的内部 Bearer Secret，每个部署环境独立，至少 32 个字符。
- `AI_AUTOMATION_TOKEN_SECRET`：签发和验证短期 Automation Token 的独立高熵密钥；Web Chat、Siri 和本地生产验证使用同一 token 工具信封。缺失时非预览聊天会安全失败，不会回退到 session binding。
- `APP_ENV`：Automation Token 的 AES-GCM AAD 环境边界。生产环境必须显式设为 `production`；签发 token 的 `/api/ai/chat`、验证 token 的 `/api/ai/tools` 和离线 token 生成器必须使用相同值。
- `AI_AUTOMATION_TOKEN_KEY_ID`：可选的 token 密钥版本标签；未设置时使用内置默认值。开始密钥轮换后，所有签发方和验证方必须同时配置相同标签。
- 场景目录不做预置审核名单：`/api/ai/tools` 的 `list_scenes` 返回该家庭下所有已启用的手动场景；模型只看到场景别名、名称和描述；小米会话、真实场景 ID、DID 和原始用户 ID 不进入模型上下文。
- 连续对话由 Makers Agent 的 `Makers-Conversation-Id` 和服务端 principal/home 派生的存储键隔离。
- `idempotencyKey` 是请求/回执标识，不是授权；Phase 1 的 Web Chat 固定为 `ai:chat`，不会因为客户端提供 key 而获得 `scene:activate`。未来物理动作必须同时满足服务器签发的 action scope、暴露/修订校验、durable action ledger 和幂等 claim。

### `AI_PRINCIPAL_SECRET`

必填于后续 AI Home 路径。服务端使用 HMAC-SHA256 从小米会话中的 `userId` 派生 `usr_` 前缀的 principalId。

登录后可在 `/ai/settings` 查看 principalId；`GET /api/ai/principal` 仅返回当前会话派生后的 ID。

- 每个环境使用独立的高熵 Secret，至少 32 个字符。
- 客户端请求体、Header 或查询参数不能覆盖 principal。
- Secret 轮换会改变同一用户派生出的 principalId，历史配额与会话需要迁移或重置。
- PoC 默认不轮换，如确需轮换请提前同步配额迁移方案。

### AI Quota

Phase 3 提供 `GET /api/ai/quota`（Next Route Handler），只返回当前 Cookie 会话对应 principal 的额度摘要。摘要由远程 Agent adapter 负责 reserve/commit 和返回，控制台只做身份鉴权与代理，不运行第二套账本。

- `AI_QUOTA_ENABLED`：默认 `true`。设为 `false` 时配额完全停用：不要求 adapter 返回配额摘要，也不调用 `POST /api/internal/quota`，由控制台直接合成 principal 绑定的 `mode: "disabled"` 摘要。停用状态没有请求/Token 限额、没有 usage 记账、没有应用层 429，也没有模型费用保护，只适用于开发联调。该取值会被校验，非法值返回 500 `AI_QUOTA_CONFIG_INVALID`。
- `AI_QUOTA_DEFAULT_REQUESTS_PER_MINUTE` / `AI_QUOTA_DEFAULT_REQUESTS_PER_DAY` / `AI_QUOTA_DEFAULT_TOKENS_PER_MONTH`：默认 `10` / `50` / `100000`。
- `AI_QUOTA_UNLIMITED_IDS`：逗号分隔的服务端 principalId，优先级最高，仍记录 usage。
- `AI_QUOTA_OVERRIDES_JSON`：按 principalId 覆盖部分额度，未覆盖字段继承默认值。
- Console 不配置配额存储；`AI_QUOTA_ENABLED` 仅控制是否由 Console 返回本地 `mode: "disabled"` 摘要，启用时由远程 Agent 提供摘要。

配额 reserve/commit/release 与错误结算由远程 Agent adapter 负责（`AI_QUOTA_ENABLED=false` 时整体停用，见上文）；控制台在聊天路径不读写任何本地账本。

### AI Web Chat API

Phase 5 提供 Cookie 鉴权的非流式 Web Chat API，浏览器不提交 principal、米家凭据、Gateway Key、Agent 内部 Secret 或原始 Makers conversation ID。

- `POST /api/ai/conversations`：body 为 `{ "homeId": "..." }`，签发绑定当前登录用户和家庭的不透明 `conversationId`。
- `POST /api/ai/chat`：body 为 `{ "conversationId"?, "homeId", "message", "idempotencyKey"? }`，统一执行 principal 派生、家庭校验和远程 Agent 调用；配额摘要由 Agent adapter 返回，`AI_QUOTA_ENABLED=false` 时由控制台返回固定的停用摘要。
- `DELETE /api/ai/conversations/:conversationId`：只清除当前用户、当前家庭对应的 Agent 对话记忆，不修改米家设备、场景或配额账本。
- Phase 1 请求固定只拥有 `ai:chat` scope；`idempotencyKey` 仍会传给 Agent 用于回执和重复请求检测，但不能授予 `activate_scene`。未来设备副作用除 16–128 字符的幂等键外，还必须有服务端签发的 action scope、暴露/修订校验和 durable action ledger claim。
- 所有响应均为 JSON 并设置 `Cache-Control: no-store`；首期不提供 SSE。

Web API 通过 `AI_AGENT_BASE_URL` 指定的远程 Agent origin 的 `/ai-home` 与 `/ai-home/delete` 路由通信；未设置该变量时，非预览聊天与删除返回 502 `AI_AGENT_UNAVAILABLE`。内部请求使用 `Makers-Conversation-Id` 与 `Authorization: Bearer <AI_AGENT_INTERNAL_SECRET>`。客户端响应不会返回 Agent usage 明细、真实场景 ID、DID、原始 Xiaomi userId 或任何 Secret。

`AI_ENVIRONMENT=preview` 时，聊天在完成 Cookie 鉴权、家庭归属和会话句柄校验后直接返回固定 mock 文本 `预览模式：不会调用模型或控制真实设备。`，配额模式为 `disabled`。该路径不创建执行 scope、不调用 Makers Agent，也不预留或消耗配额；删除会话返回本地幂等成功。预览判定只读取 `AI_ENVIRONMENT`，不读取 `VERCEL_ENV` 等平台特定变量；各平台的预览部署需显式设置该变量。Preview 部署应保持 `AI_AGENT_BASE_URL` 未设置，避免在进入服务层 mock 之前因无效远程配置失败。

配额数据由远程 Agent 持有；Console 在 Agent 缺失或请求失败时 fail closed，不维护 KV 或内存配额账本。

### AI 助手面板

Phase 6 在主要页面挂载右下角的 AI 助手按钮，打开对话面板调用上述 Web Chat API。Console API 统一由 `app/api/**/route.ts` 提供 Next Route Handlers，并调用 `lib/ai/api` 中的共享 handler；EdgeOne、Vercel 与本地 Next 运行时使用相同 URL 和鉴权、家庭校验、配额及预览逻辑。

- 未登录时点击按钮会引导现有的小米扫码登录；演示家庭（demo）不打开面板。
- 桌面端为右侧面板，移动端（≤760px）为全屏抽屉；发送中可点"停止"中断本地请求——服务端可能仍在处理该轮对话。
- "清除会话"只清除 Agent 对话记忆，不影响设备、场景或配额账本。
- 配额 `mode: "disabled"` 时面板显示"配额已停用/不可用"，不会显示为零剩余；429 时显示恢复时间并禁用重试，绝不自动重试。
- 本地联调注意：Agent 运行时已迁出本仓库，非预览聊天必须设置 `AI_AGENT_BASE_URL`（否则 502 `AI_AGENT_UNAVAILABLE`）。本地开发请使用 `AI_ENVIRONMENT=preview`（固定 mock）或指向本地/远程 Agent。

本地人工验证通过 Next 路由运行 Console，并连接 `mijia-agent` 仓库的本地 Agent：运行 `npm run dev`（或本地集成脚本）启动控制台后，将 `AI_AGENT_BASE_URL` 指向本地 Agent origin（或直接使用 `https://agent.fabloki.xyz`），并准备已登录浏览器中的 `xiaomi_session` Cookie。以下命令中的 Secret 和 Cookie 只应保存在当前终端，不要写入仓库或 shell history：

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

预期结果：创建会话返回 201；聊天返回 200、相同 `conversationId` 和脱敏 quota；场景列表返回该家庭下所有已启用的手动场景；删除返回 200，随后使用同一句柄会建立空的 Agent 对话历史。

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

部署前，在 EdgeOne Makers 项目的 Production Environment Variables 中配置以下变量；Secret 只保存在平台的加密配置中：

| 变量 | 要求 | 用途 |
| --- | --- | --- |
| `APP_ENV` | 必填，固定为 `production` | 绑定 Automation Token 的加密环境，签发与验证必须一致 |
| `XIAOMI_SESSION_SECRET` | 必填，独立高熵 Secret | 加密登录会话 Cookie |
| `AI_PRINCIPAL_SECRET` | 必填，至少 32 字符 | 从服务端会话派生稳定 principalId |
| `AI_AUTOMATION_TOKEN_SECRET` | 必填，独立高熵 Secret | 加密 Web Chat 与工具调用间的短期 token |
| `AI_AGENT_BASE_URL` | 必填，HTTPS origin | 远程 `mijia-agent` 地址，不包含路径 |
| `AI_AGENT_INTERNAL_SECRET` | 必填，至少 32 字符 | Web Console 调用 Agent 的内部 Bearer 鉴权 |
| `AI_TOOLS_INTERNAL_SECRET` | 必填，至少 32 字符 | Agent 回调 `/api/ai/tools` 的内部 Bearer 鉴权 |
| `AI_AUTOMATION_TOKEN_KEY_ID` | 可选 | token 密钥版本；设置后签发方和验证方必须一致 |
| `AI_QUOTA_ENABLED` | 建议显式设置 | `false` 完全停用配额；其他合法配置见 AI Quota 一节 |

Production 不得设置 `AI_ENVIRONMENT=preview`。环境变量新增或修改后必须重新部署；仅保存变量但继续运行旧部署，可能仍使用旧的绑定快照。部署后先验证 Web Chat 能签发 token，再确认 Agent 可通过 `/api/ai/tools` 打开同一 token。

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
