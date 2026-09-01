# 米家 Web 控制台架构

> 架构基线：`origin/main@a4dd9e9f001c59e45eb5a068118994672e16b1c6`（2026-08-31）
> 文档目标：描述当前实现，并识别可复用、可拆分和可扩展的组件。文中的“目标架构”是演进建议，不代表已经实现。

## 1. 系统全景

项目是一个运行在服务端边缘环境的米家 Web 控制台。浏览器只调用同源 Route Handler；小米会话、请求签名和真实云端数据均留在服务端。

```mermaid
flowchart TB
    User[用户浏览器]

    subgraph UI[表现层 · app]
        Page[page.tsx<br/>登录、同步、导航、设备控制]
        DeviceUI[device-management.tsx]
        SceneUI[scene-editor.tsx]
        AutomationUI[automation-center.tsx]
    end

    subgraph API[HTTP 边界 · app/api/xiaomi]
        AuthAPI[QR / Status]
        DeviceAPI[Devices / Spec / Control]
        SceneAPI[Scenes / Run / Action Catalog]
        AutomationAPI[Automations / Catalog]
    end

    subgraph Service[服务与应用编排 · 当前分布在 lib 和 Route Handler]
        Cloud[xiaomi-cloud<br/>会话、签名、云请求、设备发现]
        SceneService[xiaomi-scenes<br/>xiaomi-scene-editor<br/>xiaomi-scene-action-catalog]
        AutomationService[xiaomi-automations<br/>xiaomi-automation-editor<br/>xiaomi-automation-catalog]
        SpecService[miot-spec<br/>规格获取与缓存]
    end

    subgraph Domain[领域层 · lib 中的纯规则]
        Topology[device-topology<br/>xiaomi-control-objects]
        Management[device-management<br/>device-views / device-groups]
        Switch[device-capabilities<br/>switch-channel-mode / switch-bindings]
        SceneDomain[场景/自动化解析<br/>校验、保真写入、展示分组]
    end

    subgraph External[外部服务]
        Account[account.xiaomi.com]
        XiaomiCloud[region api.io.mi.com]
        MiotSpec[miot-spec.org<br/>spec.miot-spec.com]
        ModelCatalog[home.mi.com 型号场景目录]
    end

    User --> Page
    Page --> DeviceUI & SceneUI & AutomationUI
    Page --> AuthAPI & DeviceAPI & SceneAPI & AutomationAPI
    AuthAPI --> Cloud
    DeviceAPI --> Cloud & SpecService & Topology & Management & Switch
    SceneAPI --> SceneService --> SceneDomain
    AutomationAPI --> AutomationService --> SceneDomain
    Cloud --> Account & XiaomiCloud
    SpecService --> MiotSpec
    AutomationService --> XiaomiCloud & ModelCatalog
```

### 1.1 部署形态

```mermaid
flowchart LR
    Source[Next.js 16 + React 19 源码]

    Source -->|npm run build| Vinext[Vinext / Vite]
    Vinext --> Worker[Cloudflare Worker<br/>worker/index.ts]
    Worker --> Assets[ASSETS binding]
    Worker --> Images[Cloudflare Images binding]

    Source -->|npm run build:edgeone| NextEdge[Next.js webpack .next]
    NextEdge --> EdgeOne[EdgeOne Makers]

    Source -->|npm run build:vercel| NextVercel[Next.js webpack .next]
    NextVercel --> Vercel[Vercel]

    Secret[XIAOMI_SESSION_SECRET]
    Secret -.运行时注入.-> Worker
    Secret -.运行时注入.-> EdgeOne
    Secret -.运行时注入.-> Vercel
```

Cloudflare 构建由 `vite.config.ts` 和 `worker/index.ts` 负责；EdgeOne、Vercel 分别通过 `edgeone.json`、`vercel.json` 使用原生 Next.js 构建。三种目标共享相同的应用与领域代码。

## 2. 主要调用链

### 2.1 二维码登录

```mermaid
sequenceDiagram
    actor Browser as 浏览器
    participant Route as QR Route Handlers
    participant Session as xiaomi-cloud
    participant Account as account.xiaomi.com
    participant Redirect as 小米登录跳转链

    Browser->>Route: POST /api/xiaomi/qr/start {region}
    Route->>Session: startQrLogin(region)
    Session->>Account: GET /longPolling/loginUrl
    Account-->>Session: qr、lp、loginUrl、Cookie
    Session-->>Route: XiaomiQrState
    Route->>Route: AES-GCM 加密 xiaomi_qr Cookie
    Route-->>Browser: imageUrl、loginUrl、expiresIn

    Browser->>Route: GET /api/xiaomi/qr/image
    Route->>Route: 解密 XiaomiQrState
    Route->>Account: 获取动态二维码图片
    Account-->>Browser: image/png

    loop 最长 5 分钟
        Browser->>Route: GET /api/xiaomi/qr/poll
        Route->>Account: 请求动态 pollUrl
        alt 尚未完成扫码
            Account-->>Browser: pending=true
        else 登录完成
            Account-->>Session: ssecurity、userId、location
            Session->>Redirect: 最多 6 次手动重定向
            Redirect-->>Session: serviceToken Cookie
            Route->>Route: 加密 xiaomi_session，删除 xiaomi_qr
            Route-->>Browser: connected=true、脱敏用户信息
        end
    end
```

会话凭据不进入客户端响应。`ssecurity`、`serviceToken`、区域和用户标识被 AES-GCM 加密后保存到 HttpOnly Cookie，密钥由 `XIAOMI_SESSION_SECRET` 派生。

### 2.2 设备同步与运行状态增强

```mermaid
sequenceDiagram
    actor Browser as 浏览器
    participant API as GET /api/xiaomi/devices
    participant Cloud as xiaomi-cloud
    participant Xiaomi as api.io.mi.com
    participant Spec as miot-spec
    participant Domain as 拓扑与管理领域

    Browser->>API: homeId? + includeScenes?
    API->>API: 校验参数并解密会话
    API->>Cloud: listDevices(session)
    Cloud->>Xiaomi: gethome
    loop 每个家庭、按 max_did 分页
        Cloud->>Xiaomi: home_device_list
        Xiaomi-->>Cloud: 物理设备、派生端点、房间与嵌入控制对象
    end
    Cloud-->>API: 设备结果 + completeness + warnings

    par 按唯一 model/URN 加载规格
        API->>Spec: getMiotCapabilities(model, urn)
    and 最多 40 项一批读取属性
        API->>Xiaomi: miotspec/prop/get
    end

    Note over API,Spec: 运行状态增强总预算 12 秒
    alt 增强按时完成
        API->>Domain: 构建通道状态和设备电源状态
    else 超时或部分失败
        API->>API: 保留基础设备，增加 partial warning
    end

    API->>Domain: buildDeviceTopology
    Domain->>Domain: 解析控制对象、模式、组成员与证据等级
    Domain-->>API: 家庭隔离的设备与照明拓扑
    API-->>Browser: devices、homes、completeness、warnings
```

设备发现允许按家庭部分成功；规格或属性批次失败也不会丢弃已经取得的基础设备。当前实现使用 `withTimeoutFallback` 限制运行状态增强，优先保证同步接口可返回。

### 2.3 设备控制

```mermaid
sequenceDiagram
    actor Browser as 浏览器
    participant API as /api/xiaomi/control
    participant Cloud as xiaomi-cloud
    participant Xiaomi as api.io.mi.com

    Browser->>API: GET/POST + did、siid、piid/aiid
    API->>API: 校验会话、标识符、数值和批量上限
    alt 读取属性
        API->>Cloud: /app/miotspec/prop/get
    else 写入属性
        API->>Cloud: /app/miotspec/prop/set
    else 执行动作
        API->>Cloud: /app/miotspec/action
    end
    Cloud->>Cloud: 生成 nonce、签名并 RC4 加密
    Cloud->>Xiaomi: 区域化 HTTPS 请求
    Xiaomi-->>Cloud: 加密或 JSON 结果
    Cloud->>Cloud: 解密、检查 HTTP 与业务 code
    Cloud-->>API: 标准结果或 XiaomiCloudError
    API-->>Browser: 成功结果或稳定错误码
```

控制请求始终使用真实物理 DID 和明确的 MIoT 地址。UI 不会因为提交成功而伪造未知状态；错误仍会显式反馈。

### 2.4 场景与自动化安全写入

```mermaid
sequenceDiagram
    actor Browser as 浏览器
    participant API as Scene / Automation Route
    participant App as 编辑与校验服务
    participant Spec as MIoT Spec
    participant Xiaomi as AppSceneService

    Browser->>API: POST/PUT 编辑草稿
    API->>API: 校验会话、homeId 和资源 ID
    API->>Xiaomi: GetSceneList(home_id)
    Xiaomi-->>API: 最新原始规则
    API->>App: 计算 SHA-256 revision
    API->>API: 对比客户端 revision
    API->>Spec: 校验设备归属与可写属性能力
    App->>App: 深拷贝原始规则
    App->>App: 只替换明确编辑的字段
    Note over App: 未知触发器、动作和私有字段原样保留
    API->>Xiaomi: AppSceneService/Edit

    loop 有界回读
        API->>Xiaomi: GetSceneList(home_id)
        Xiaomi-->>API: 当前规则
        API->>App: 比对名称、状态、触发器和动作
    end

    alt 回读一致
        API-->>Browser: created/updated=true
    else 冲突、只读节点或写入不可见
        API-->>Browser: 409/502 + 稳定错误码
    end
```

这种“原始记录保真 + 能力校验 + 乐观并发控制 + 写后验证”的模式，是场景和自动化模块最重要的可复用设计。

### 2.5 场景动作目录

```mermaid
flowchart LR
    Browser[场景编辑器] --> Route[GET /api/xiaomi/scenes/action-catalog]
    Route -->|鉴权、homeId 校验| Catalog[xiaomi-scene-action-catalog]
    Catalog --> TCA[实例级 TCA]
    TCA -->|不可用| Model[官方型号目录]
    Model -->|不可用| Spec[MIoT Spec]
    TCA -->|成功但为空| Empty[权威空列表]
    Catalog --> Validate[按目标设备规格校验<br/>枚举、范围、空参数动作]
    Validate --> DTO[脱敏模板与 opaque key]
    DTO --> Browser
```

动作目录以设备实例为首选证据，严格应用 `black_dids`；实例目录成功但为空时不继续猜测。服务端保留真实目录动作 ID，客户端只接收 opaque key、官方原文和经过 MIoT 规格验证的参数约束。创建或更新场景时，服务端重新加载当前目录并校验模板，避免目录变化后写入失效或跨设备的数值。

## 3. 外部与内部 API

### 3.1 外部 API

| 主机/来源 | 路径 | 用途 | 主要保护或降级 |
| --- | --- | --- | --- |
| `account.xiaomi.com` | `/longPolling/loginUrl` | 创建二维码登录流程 | 区域白名单、12 秒超时 |
| 登录接口返回的动态 URL | QR image URL | 获取二维码图片 | 服务端代理，不暴露登录 Cookie |
| 登录接口返回的动态 URL | Poll URL / redirect chain | 轮询登录并取得服务令牌 | 5 分钟失效、最多 6 次跳转 |
| `{region.}api.io.mi.com` | `/app/v2/homeroom/gethome` | 家庭、房间、共享家庭和 owner UID | 所有后续数据按 `homeId` 隔离 |
| 同上 | `/app/v2/home/home_device_list` | 按家庭分页获取设备 | `max_did` 防重复游标；允许家庭级部分成功 |
| 同上 | `/app/home/device_list` | 无家庭结果时的兼容设备列表 | 仅遇到 HTTP 415 才尝试旧签名协议 |
| 同上 | `/app/miotspec/prop/get` | 批量读取属性 | 单批最多 40 项；批次失败局部降级 |
| 同上 | `/app/miotspec/prop/set` | 写入标准 MIoT 属性 | 服务端校验标识符和值类型 |
| 同上 | `/app/miotspec/action` | 执行标准 MIoT Action | 使用对象形 `params` envelope |
| 同上 | `AppSceneService/GetSceneList` | 读取场景和自动化 | 按用户触发器区分手动场景与自动化 |
| 同上 | `AppSceneService/NewRunScene` | 运行手动场景 | 先验证家庭归属、启用状态和场景 ID |
| 同上 | `AppSceneService/Edit` | 创建或修改场景/自动化 | revision、能力校验、原始节点保真、回读验证 |
| 同上 | `AppSceneService/GetSceneTCAConfigV3` | 获取实例级条件和动作目录 | 按真实 DID、型号、`black_dids` 过滤 |
| `miot-spec.org` / `spec.miot-spec.com` | `/miot-spec-v2/instances?status=all` | 型号解析为规格 URN | 双源顺序容错 |
| 同上 | `/miot-spec-v2/instance?type=...` | 获取服务、属性、动作和事件 | 30 分钟进程内缓存 |
| `home.mi.com` | `/cgi-op/api/v1/baike/v2/scene?model=...` | 自动化型号目录后备源 | 单型号失败不影响其他设备 |

小米云主机按区域生成：中国大陆为 `api.io.mi.com`，其他区域为 `{region}.api.io.mi.com`。支持区域为 `cn`、`sg`、`de`、`us`、`ru`、`i2`、`in`。

### 3.2 内部 Route Handler

| 路径 | 方法 | 职责 |
| --- | --- | --- |
| `/api/xiaomi/qr/start` | `POST` | 创建登录二维码状态 |
| `/api/xiaomi/qr/image` | `GET` | 代理二维码图片 |
| `/api/xiaomi/qr/poll` | `GET` | 轮询登录并建立加密会话 |
| `/api/xiaomi/status` | `GET`, `DELETE` | 返回脱敏连接状态或退出登录 |
| `/api/xiaomi/devices` | `GET` | 聚合家庭、设备、属性、拓扑及可选场景 |
| `/api/xiaomi/spec` | `GET` | 返回型号能力及公开绑定能力 |
| `/api/xiaomi/control` | `GET`, `POST` | 读取/写入属性或执行动作 |
| `/api/xiaomi/scenes` | `GET`, `POST` | 列出或创建手动场景 |
| `/api/xiaomi/scenes/:sceneId` | `GET`, `PUT` | 获取编辑草稿或安全更新场景 |
| `/api/xiaomi/scenes/action-catalog` | `GET` | 按家庭和设备实例返回脱敏、可重新验证的官方动作模板 |
| `/api/xiaomi/scenes/run` | `POST` | 执行手动场景 |
| `/api/xiaomi/automations` | `GET`, `POST` | 列出或创建自动化 |
| `/api/xiaomi/automations/:automationId` | `GET`, `PUT` | 获取草稿或安全更新自动化 |
| `/api/xiaomi/automations/catalog` | `GET` | 返回脱敏后的触发条件和动作目录 |

## 4. 当前分层与模块依赖

### 4.1 `lib` 主要依赖关系

```mermaid
flowchart LR
    Cloud[xiaomi-cloud]
    ControlObjects[xiaomi-control-objects]
    Miot[miot-spec]
    Capabilities[device-capabilities]
    Topology[device-topology]
    ChannelMode[switch-channel-mode]
    Bindings[switch-bindings]
    Views[device-views]
    Groups[device-groups]
    Management[device-management]
    Scenes[xiaomi-scenes]
    SceneEditor[xiaomi-scene-editor]
    SceneActionCatalog[xiaomi-scene-action-catalog]
    SceneProperties[xiaomi-scene-properties]
    SceneGroups[scene-action-groups]
    Automations[xiaomi-automations]
    AutomationEditor[xiaomi-automation-editor]
    AutomationCatalog[xiaomi-automation-catalog]

    Cloud --> ControlObjects
    Capabilities --> Miot
    Topology --> ChannelMode
    Bindings --> Miot & Topology
    Views --> Topology
    Management --> Topology
    Scenes --> Cloud
    SceneEditor --> Cloud & Miot & Topology & SceneProperties & Scenes
    SceneActionCatalog --> AutomationCatalog & Miot & Topology & SceneProperties & SceneEditor
    SceneGroups --> Management & SceneEditor & Scenes
    Automations --> Cloud & Topology & Scenes
    AutomationEditor --> SceneEditor & Scenes & Automations
    AutomationCatalog --> Cloud & Topology & Scenes

    Groups -.独立纯函数.-> Management
```

依赖方向整体以“上游适配器和场景服务依赖基础领域规则”为主，但尚未通过接口隔离基础设施。`xiaomi-scenes`、`xiaomi-automations` 等文件同时包含纯解析函数和网络访问函数。

### 4.2 Domain 层

| 领域 | 模块 | 核心职责 | 当前特征 |
| --- | --- | --- | --- |
| 设备身份与拓扑 | `device-topology`, `xiaomi-control-objects` | 识别物理设备、`.sN` 端点、控制通道、控制对象和证据 | 纯规则为主，家庭隔离明确 |
| 开关语义 | `switch-channel-mode`, `switch-bindings` | 解析有线/无线模式，识别可安全调用的绑定能力 | 未知值保持 `unknown` |
| 设备聚合 | `device-management`, `device-views`, `device-groups` | 生成硬件视图、受控设备视图、照明目标和活动设备 | 与 UI DTO 有一定耦合 |
| MIoT 能力 | `miot-spec`, `device-capabilities`, `xiaomi-scene-properties` | 规范化服务/属性/动作/事件，划分只读、读写、仅写和 Action，并限制场景可写能力 | 获取与解析仍在同一模块 |
| 场景 | `xiaomi-scenes`, `xiaomi-scene-editor`, `xiaomi-scene-action-catalog`, `scene-action-groups` | 解析、展示、草稿、实例动作目录、校验和保真写入 | 网络服务与领域逻辑混合 |
| 自动化 | `xiaomi-automations`, `xiaomi-automation-editor`, `xiaomi-automation-catalog` | 触发器分类、编辑、能力目录与安全投影 | 复用场景写入内核 |

#### 关键领域不变量

```mermaid
flowchart TD
    Input[设备、规格、实时属性、控制对象]
    Scope{homeId 是否一致}
    Reject[拒绝跨家庭匹配]
    Identity{身份和目标是否明确}
    Confirmed[confirmed<br/>真实 DID / 型号规格 / 属性 / 明确目标]
    Inferred[inferred<br/>同家庭唯一名称与房间候选]
    Unknown[unknown<br/>缺失、冲突、失败或私有语义]
    Model[领域拓扑]
    UI[UI 明确显示证据或待确认状态]

    Input --> Scope
    Scope -->|否| Reject
    Scope -->|是| Identity
    Identity -->|直接证明| Confirmed
    Identity -->|仅唯一弱匹配| Inferred
    Identity -->|无法证明| Unknown
    Confirmed & Inferred & Unknown --> Model --> UI
```

- 所有索引、匹配、去重和缓存首先按 `homeId` 分区。
- `group.*` 始终保留完整 DID；仅 `physicalDid.sN` 被视为派生端点。
- MIoT 请求使用物理 DID 和精确 `siid`/`piid`/`aiid`。
- 型号和规格优先于名称；名称推断不能伪装成云端确认关系。
- 属性失败、候选冲突和未公开协议均保留为 `unknown`。
- 普通回路状态只来自已证明的有线端点；无线按键状态不等价于目标灯状态。

### 4.3 Service 与 Application 层

当前没有独立的 `service/` 或 `application/` 目录，职责分布如下：

| 位置 | 实际职责 | 主要问题 |
| --- | --- | --- |
| `xiaomi-cloud.ts` | 登录、会话加密、RC4/HMAC 请求、错误分类、家庭与设备发现 | Gateway、认证和查询服务集中在一个文件 |
| `miot-spec.ts` | HTTP 获取、双源降级、缓存、规格规范化 | 基础设施与领域转换混合 |
| 场景/自动化模块 | 上游调用、原始记录解析、草稿与写入 payload | service 和 domain 边界不清晰 |
| Route Handlers | 鉴权、权限校验、编排、超时、写后回读、HTTP 映射 | 承担了主要 application use case |
| `app/page.tsx` | 客户端请求去重、缓存、冷却、同步和控制状态 | 页面组件承担客户端 application service |

## 5. 数据转换

```mermaid
flowchart LR
    RawHome[Xiaomi Home/Room Raw Record]
    RawDevice[Xiaomi Device Raw Record]
    RawSpec[MIoT Raw Specification]
    RawScene[AppScene Raw Record]

    CloudAdapter[xiaomi-cloud<br/>合并、分页、错误分类]
    SpecNormalizer[miot-spec<br/>能力规范化]
    SceneParser[scene / automation parser]

    Runtime[实时属性状态]
    Topology[DeviceTopology<br/>Channel / ControlObject / Evidence]
    Management[DeviceManagementModel<br/>LightingTopology]
    SceneModel[ManualScene / XiaomiAutomation]

    ApiDTO[脱敏 API DTO<br/>completeness + warnings]
    ViewModel[React View Model]

    RawHome & RawDevice --> CloudAdapter
    RawSpec --> SpecNormalizer
    RawScene --> SceneParser
    CloudAdapter & SpecNormalizer --> Runtime
    CloudAdapter & Runtime --> Topology --> Management
    SceneParser --> SceneModel
    Management & SceneModel --> ApiDTO --> ViewModel
```

上游数据大量使用 `Record<string, unknown>` 兼容小米不同版本的字段形状。优点是协议容错强，代价是边界内存在较多运行时字段探测；后续应在适配器出口尽早转换为强类型领域对象。

## 6. 可复用性与扩展评估

### 6.1 复用矩阵

| 组件 | 复用价值 | 当前耦合 | 拆分成本 | 推荐用途 |
| --- | :---: | :---: | :---: | --- |
| `device-topology` | 高 | 低 | 低 | 独立设备拓扑 SDK、多平台聚合 |
| `xiaomi-control-objects` | 高 | 低 | 低 | 控制关系解析和证据管理 |
| `switch-channel-mode` | 高 | 低 | 低 | 开关通道语义解析 |
| `device-management` | 高 | 中 | 中 | 照明与设备管理领域模型 |
| `device-groups` / `device-views` | 高 | 中 | 低 | 设备清单、分组和 UI 投影 |
| MIoT 规格规范化 | 高 | 中 | 中 | CLI、桥接服务、能力浏览器 |
| 场景/自动化 parser | 高 | 中 | 中 | 规则审计、迁移和多端展示 |
| 安全编辑与写后验证 | 高 | 中 | 中 | 通用规则编辑内核 |
| `xiaomiRequest` 协议实现 | 中 | 中 | 中 | Xiaomi Gateway 基础客户端 |
| Route Handlers | 低 | 高 | 高 | 仅适合当前 Next.js HTTP 边界 |
| 编辑器 UI | 中 | 中 | 中 | 其他 React 米家客户端 |
| `app/page.tsx` 编排 | 低 | 高 | 高 | 应先拆 hooks/store 再复用 |

### 6.2 主要扩展阻力

```mermaid
flowchart LR
    Page[page.tsx<br/>客户端状态与用例集中]
    Routes[Route Handlers<br/>服务端用例集中]
    Lib[lib<br/>Gateway + Service + Domain 混合]
    Raw[Record string unknown<br/>兼容但弱类型]
    Cache[进程内缓存<br/>Serverless 冷启动丢失]

    Page -->|难以复用 UI| SplitHooks[拆分认证、同步、控制 hooks/store]
    Routes -->|难以复用 HTTP 之外入口| UseCases[抽出 Application Services]
    Lib -->|依赖方向不稳定| Ports[引入 Gateway Ports]
    Raw -->|运行时探测分散| DTO[适配器边界统一 DTO]
    Cache -->|重复拉取规格| CachePort[可替换缓存接口]
```

## 7. 建议的目标架构

```mermaid
flowchart TB
    subgraph Delivery[Delivery Adapters]
        Next[Next.js Route Handlers]
        Worker[Cloudflare Worker]
        Future[CLI / Mobile BFF / Home Assistant]
    end

    subgraph Application[Application Services]
        AuthUC[AuthenticationService]
        SyncUC[DeviceSyncService]
        ControlUC[DeviceControlService]
        SceneUC[SceneService]
        AutomationUC[AutomationService]
        CatalogUC[CapabilityDiscoveryService]
    end

    subgraph Domain[Pure Domain]
        DeviceDomain[Device / Home / Room]
        TopologyDomain[Topology / Evidence / Control Edge]
        CapabilityDomain[MIoT Capability]
        RuleDomain[Scene / Automation / Safe Edit]
    end

    subgraph Ports[Infrastructure Ports]
        XiaomiPort[XiaomiCloudGateway]
        SpecPort[MiotSpecRepository]
        SessionPort[SessionStore]
        CachePort[CapabilityCache]
    end

    subgraph Adapters[Infrastructure Adapters]
        XiaomiAdapter[RC4/HMAC Xiaomi Adapter]
        HttpSpec[HTTP MIoT Spec Adapter]
        CookieSession[Encrypted Cookie Adapter]
        MemoryCache[In-memory Cache]
    end

    Next & Worker & Future --> Application
    Application --> Domain
    Application --> Ports
    XiaomiPort -.实现.-> XiaomiAdapter
    SpecPort -.实现.-> HttpSpec
    SessionPort -.实现.-> CookieSession
    CachePort -.实现.-> MemoryCache
```

建议接口边界：

```ts
interface XiaomiCloudGateway {
  listHomes(): Promise<Home[]>;
  listDevices(homeId?: string): Promise<DeviceDiscoveryResult>;
  getProperties(refs: PropertyRef[]): Promise<PropertyBatchResult>;
  setProperty(command: PropertyCommand): Promise<void>;
  runAction(command: ActionCommand): Promise<void>;
  listRules(homeId: string): Promise<RawRule[]>;
  editRule(payload: RawRule): Promise<RuleWriteResult>;
  runScene(homeId: string, sceneId: string): Promise<void>;
}
```

接口应返回领域可识别的“完整/部分/未知”结果，不把 HTTP、Cookie 或 Next.js 类型带入 Application 和 Domain 层。

### 7.1 推荐演进顺序

```mermaid
flowchart LR
    P1[1. 抽 XiaomiCloudGateway<br/>保持现有 HTTP 合约]
    P2[2. 抽 DeviceSyncService<br/>迁移 12 秒预算与 partial 语义]
    P3[3. 抽 Scene/AutomationService<br/>统一安全写入模板]
    P4[4. 拆 MIoT Repository 与 Normalizer]
    P5[5. 拆客户端 hooks/store 与可复用 UI]
    P6[6. 增加可替换缓存、持久化与实时推送]

    P1 --> P2 --> P3 --> P4 --> P5 --> P6
```

第一阶段只改变内部依赖，不改变现有 Route Handler 路径和响应结构。这样可以先让领域能力被 CLI、后台任务或其他前端复用，再逐步替换存储和交付适配器。

## 8. 测试与安全边界

现有测试集中覆盖以下架构约束：

- 家庭隔离、派生 DID、灯组和设备拓扑。
- 属性批次、设备分页、部分成功、错误分类和时间预算。
- 场景/自动化识别、草稿校验、未知节点保真和写后验证。
- TCA 目录分页、黑名单、脱敏投影、实例动作验证和逐型号降级。
- Route Handler 未登录保护、参数校验和稳定错误响应。
- Cloudflare、EdgeOne、Vercel 构建配置及响应式 UI。

后续抽层时应以这些测试作为兼容契约，尤其不得破坏：

1. 会话字段只存在于服务端边界。
2. 不记录真实 DID、Cookie、Token 或账号数据。
3. 不跨家庭合并、匹配或建立控制关系。
4. 单个规格、属性批次、家庭或型号目录失败不拖垮其他结果。
5. 未知和冲突数据保持 `unknown`，不使用默认值伪装为已确认。
6. 对未知规则只读或原样保留，不生成无法证明安全的写入 payload。
