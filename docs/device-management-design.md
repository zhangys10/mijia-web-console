# 米家设备管理与照明控制拓扑设计规范

- 文档状态：第一版实现规范
- 更新日期：2026-08-26
- 适用范围：家庭、房间、设备、开关派生端点、照明目标、智能灯组、设备状态与按键配置
- 核心原则：家庭隔离、型号优先、真实属性优先、推断关系显式标记、未知信息不使用默认值补全

## 1. 核心实体

| 实体 | 定义 | 标识 |
| --- | --- | --- |
| 家庭 | 米家账号下独立的设备作用域 | `homeId` |
| 物理设备 | 真实存在的开关、中控屏、智能灯、网关或其他硬件 | `homeId + did` |
| 派生端点 | 物理开关某个 `switch` 服务生成的逻辑设备 | `physicalDid.sN` |
| 照明目标 | UI 中聚合展示的一盏灯、一个普通灯回路或一个灯组 | `homeId + targetRoom + normalizedName` |
| 控制边 | 某个物理控制器的具体服务对照明目标的控制关系 | `sourceDid + siid + targetKey` |
| 智能灯组 | 米家云中的组合照明设备 | 完整 `group.*` DID |
| 事件按键 | 只有事件能力、没有独立 `switch` 服务的按键 | 事件服务与参数 |

所有索引、匹配和去重均以 `homeId` 为第一层作用域。不同家庭之间禁止建立拓扑关系。

## 2. 数据来源与证据等级

### 2.1 数据来源

| 来源 | 使用字段 |
| --- | --- |
| 设备列表 | DID、名称、型号、URN、家庭、房间、在线状态、灯组关系 |
| MIoT 型号规格 | 设备类别、服务、`siid`、属性、`piid`、枚举、读写能力、事件与动作 |
| MIoT 属性读取 | 指定真实 DID 的 `on`、`mode` 及其他可读属性 |
| 明确绑定返回 | 来源 DID、来源服务、目标 DID、目标服务 |
| 用户确认规则 | “副控”表示无线副控角色；不单独证明目标 DID |

### 2.2 证据等级

```ts
type Evidence = "confirmed" | "inferred" | "unknown";
```

| 等级 | 使用条件 | UI 表达 |
| --- | --- | --- |
| `confirmed` | 真实 DID、型号规格、实时属性或明确目标 DID 直接证明 | 正常显示关系 |
| `inferred` | 同家庭内依据名称与房间规则得到唯一候选 | 显示“名称推断” |
| `unknown` | 属性读取失败、候选冲突或接口未公开 | 显示“待确认” |

`inferred` 不得显示为米家云已经确认的绑定。

## 3. DID 与物理设备归类

### 3.1 派生 DID

派生 DID 仅使用以下格式：

```text
^(?<physicalDid>.+)\.s(?<siid>\d+)$
```

示例：

```text
1206737667.s2  -> physicalDid=1206737667, siid=2
720449456.s15  -> physicalDid=720449456,  siid=15
```

归类规则：

1. `group.*` 始终保留完整 DID。
2. `blt.*`、`lumi.*` 及其他协议型 DID 不按最后一个点号截断。
3. `.sN` 的根 DID 必须存在于同一家庭。
4. 型号规格包含对应 `siid` 的 `switch` 服务时，派生关系为 `confirmed`。
5. 规格不可用时保留端点并标记为 `unknown`，不得默认成有线端点。
6. 硬件视图按完整物理 DID 去重；派生端点不生成独立硬件卡片。

### 3.2 型号优先分类

分类优先级：

```text
完整 DID 规则
  > 型号与型号规格
  > URN 设备类别
  > 设备名称
  > 云端逻辑类型
```

| 型号 | 物理类别 | 照明服务 |
| --- | --- | --- |
| `xiaomi.controller.oh4w` | 智能中控屏 | `switch` 服务 `14`、`15`、`16` |
| `linp.switch.qh2db4` | 四键墙壁开关 | `switch` 服务 `2`、`3`、`4` |
| `linp.switch.t2dbw3` | 三键墙壁开关 | `switch` 服务 `2`、`3`、`4` |
| `linp.switch.t2dbw2` | 双键墙壁开关 | `switch` 服务 `2`、`3` |
| `linp.switch.t2dbw1` | 单键墙壁开关 | `switch` 服务 `2` |
| `mijia.light.group3` | 智能灯组 | 灯光服务 `2` |
| `*.light.*`、`*.lamp.*` | 独立智能灯具 | 型号规格中的灯光服务 |
| `*.gateway.*`、`*.hub.*` | 网关 | 不作为中控屏或墙壁开关 |

中控屏派生端点的名称可以是“中间筒灯”，但物理设备类别仍是中控屏。云端逻辑类型不得覆盖型号确定的物理类别。

### 3.3 事件按键

没有独立 `switch` 服务的按键不进入照明拓扑。

`linp.switch.qh2db4` 的第四按键只作为事件能力保留，不创建 `.sN` 控制端点、照明目标或控制边。

## 4. 开关服务与实时模式

### 4.1 属性读取

对每个物理开关或中控屏：

1. 读取型号规格中全部真实 `switch` 服务。
2. 每个服务只读取可读的精确 `on` 属性和精确 `mode` 属性。
3. 属性请求使用物理 DID，不使用派生 DID。
4. 单次属性请求最多包含 40 个 `siid.piid`。
5. 单个型号规格或属性批次失败不阻断设备列表同步。

以下字段和动作不参与拓扑：

```text
local-control
local-control-num
get-control-num
get-local-ctrl
key-relay-set
key-param
厂商私有整数参数
```

### 4.2 模式映射

```ts
type Connection = "wired" | "wireless" | "unknown";
```

对于已验证型号：

| `mode` | 连接类型 | 含义 |
| --- | --- | --- |
| `0` | `wired` | 继电器直接控制负载电源 |
| `1` | `wireless` | 按键作为无线副控，不直接切换本地继电器 |
| 缺失或无法识别 | `unknown` | 模式待确认 |

若型号规格提供明确的枚举标签，优先依据枚举中的“有线/主控”或“无线/副控”语义解析。未知值不得归为 `wired`。

### 4.3 按键状态

- `wired` 端点的 `on` 可以作为普通灯回路状态。
- `wireless` 端点的 `on` 只表示按键服务状态，不作为目标灯状态。
- `unknown` 端点的 `on` 不用于确定照明目标状态。
- 物理设备离线时保留拓扑，状态显示为离线或未知。

## 5. 照明目标与控制关系

### 5.1 目标类别

```ts
type LightingTargetKind =
  | "ordinary-load"
  | "smart-light"
  | "smart-light-group"
  | "unknown";
```

| 类别 | 锚点 | 配置入口 | 状态来源 |
| --- | --- | --- | --- |
| 普通灯回路 | `wired` 派生端点 | 物理开关及具体服务 | 有线端点 `on` |
| 独立智能灯 | 智能灯自身 DID | 智能灯自身 DID | 智能灯自身状态 |
| 智能灯组 | 完整 `group.*` DID | 灯组自身 DID | 灯组自身状态 |
| 未确认目标 | 无唯一锚点的派生端点 | 来源物理设备 | 未知 |

### 5.2 控制关系

```ts
type ControlRelation =
  | "relay-load"
  | "wireless-secondary"
  | "smart-device-power"
  | "group-control"
  | "unknown";
```

| 关系 | 来源 | 目标 |
| --- | --- | --- |
| `relay-load` | 有线 `switch` 服务 | 普通灯回路 |
| `wireless-secondary` | 无线 `switch` 服务 | 已匹配照明目标 |
| `smart-device-power` | 派生电源端点 | 独立智能灯 |
| `group-control` | 明确目标 DID 的控制端点 | 智能灯组 |
| `unknown` | 模式或目标无法确认的端点 | 待确认目标 |

一个来源服务可以连接多个目标，一个目标也可以包含多个有线或无线来源。数据模型使用多对多控制边，不把关系限制为一对一。

### 5.3 名称匹配

名称匹配只在同一家庭内执行，并扫描该家庭全部房间。

标准化规则：

1. 去除空格、全角空格、连接符和常用分隔符。
2. 转换为统一大小写。
3. 名称以灯具主体开头时，去除“副控”及其后的控制位置说明。
4. 名称以位置开头时，只移除中间的“副控”，保留其后的灯具主体。
5. 去除末尾“电源”。
6. 保留灯具主体名称。

示例：

```text
中间筒灯副控次卧床头 -> 中间筒灯
客厅射灯副控         -> 客厅射灯
客厅副控灯带         -> 客厅灯带
餐厅射灯电源         -> 餐厅射灯
```

目标匹配顺序：

1. 明确绑定返回中的目标 DID 与服务。
2. 同家庭、标准化名称相同的智能灯或灯组。
3. 同家庭、标准化名称相同且房间一致的有线目标。
4. 多候选时优先派生端点房间。
5. 仍有多候选时优先来源物理设备房间。
6. 仍无法唯一确定时生成 `unknown` 目标，不自动选取。

名称得到的目标关系统一标记为 `inferred`。

同名普通灯先分别按有线派生端点房间建立目标锚点，再关联无线副控。不得因为全家庭内暂时只有一个同名普通灯候选，就把其他房间后续出现的有线端点合并到该候选。

### 5.4 “勿关”房间

“勿关”是米家记录的房间位置，不是设备类别。

位于“勿关”的派生端点按以下规则处理：

1. 存在同名有线目标时，作为该目标的无线副控候选。
2. 存在同名独立智能灯或灯组时，作为智能设备的电源控制或无线控制候选。
3. 没有唯一目标时保留为待确认端点。
4. 不在硬件视图中生成独立卡片。

## 6. 房间与状态规则

### 6.1 目标房间

| 目标类别 | `targetRoom` |
| --- | --- |
| 普通灯回路 | 有线派生端点所属房间 |
| 独立智能灯 | 智能灯自身所属房间 |
| 智能灯组 | 灯组自身所属房间 |
| 未确认目标 | 非隐藏派生房间；否则来源硬件房间 |

物理开关可以位于客厅，而其有线端点归属玄关或餐厅；照明目标按端点位置展示，控制来源仍显示物理开关的实际位置。

### 6.2 状态优先级

```text
普通灯：有线派生端点状态
智能灯：智能灯自身 DID 状态
智能灯组：灯组自身 DID 状态
无线副控：不提供目标状态
模式未知：状态未知
```

智能灯或灯组离线时只显示离线，不使用供电继电器状态替代。

## 7. 拓扑数据模型

```ts
type ControlEndpoint = {
  key: string;
  homeId: string;
  did: string;
  physicalDid: string;
  siid: number;
  buttonIndex: number | null;
  name: string;
  endpointRoom: string;
  sourceName: string;
  sourceRoom: string;
  connection: "wired" | "wireless" | "unknown";
  reportedOn: boolean | null;
  modeValue: boolean | number | string | null;
  evidence: "confirmed" | "inferred" | "unknown";
};

type LightingTarget = {
  key: string;
  homeId: string;
  name: string;
  targetRoom: string;
  kind: "ordinary-load" | "smart-light" | "smart-light-group" | "unknown";
  deviceDids: string[];
  online: boolean | null;
  on: boolean | null;
  stateSource: "wired-endpoint" | "smart-device" | "unknown";
  unresolved: boolean;
};

type ControlEdge = {
  key: string;
  homeId: string;
  sourceDid: string;
  sourceSiid: number;
  endpointDid: string;
  targetKey: string;
  relation:
    | "relay-load"
    | "wireless-secondary"
    | "smart-device-power"
    | "group-control"
    | "unknown";
  evidence: "confirmed" | "inferred" | "unknown";
};

type HomeTopology = {
  homeId: string;
  physicalDevices: PhysicalDevice[];
  endpoints: ControlEndpoint[];
  targets: LightingTarget[];
  edges: ControlEdge[];
  unresolved: TopologyIssue[];
  capturedAt: string;
};
```

`deviceDids` 用于保留同一显示目标关联的所有真实设备 ID。目标卡片只显示一次，每个关联 DID 均保留独立配置入口。

## 8. 拓扑构建算法

1. 按 `homeId + did` 建立家庭级设备索引。
2. 根据 DID 规则识别 `group.*`、物理设备和 `.sN` 派生端点。
3. 按型号获取并缓存 MIoT 规格。
4. 仅枚举真实 `switch` 服务，忽略事件型按键。
5. 批量读取各服务的 `on` 与 `mode`。
6. 为每个 `.sN` 端点关联同家庭物理根 DID 与服务 `siid`。
7. 先建立独立智能灯和智能灯组目标。
8. 使用 `wired` 端点建立普通灯目标或智能设备供电关系。
9. 使用明确绑定或全家庭名称匹配关联 `wireless` 端点。
10. 按目标类别计算 `targetRoom`、状态与配置入口。
11. 合并同目标控制边，保留所有来源设备、服务和证据等级。
12. 将模式缺失、父设备缺失、名称歧义和成员未知记录到 `unresolved`。

构建顺序固定为“设备与规格 → 实时模式 → 目标锚点 → 无线关系 → 状态”，不得在读取真实 `mode` 前默认控制角色。

## 9. API 契约

### 9.1 设备同步

```http
GET /api/xiaomi/devices
```

```ts
type DeviceSyncResponse = {
  homes: Array<{ id: string; name: string }>;
  devices: Array<{
    did: string;
    name: string;
    model: string;
    online: boolean;
    on: boolean | null;
    room: string;
    homeId: string;
    home: string;
    roomId: string;
    icon: unknown | null;
    parentId: string | null;
    logicalType: string;
    urn: string | null;
    groupMemberIds: string[];
    groupIds: string[];
    topology: DeviceTopology | null;
  }>;
  stateCapturedAt: string;
};
```

响应规则：

- 同步同时读取设备列表、必要型号规格和实时状态。
- 状态读取失败时仍返回设备，相关连接类型和状态设为 `unknown`。
- `parentId` 只关联同家庭物理根 DID。
- 派生端点的 `on` 取对应物理设备服务状态。
- 智能灯和灯组的 `on` 取自身 DID 状态。

### 9.2 型号能力

```http
GET /api/xiaomi/spec?model=...&urn=...
```

返回服务、属性、动作、事件、枚举、范围、读写能力及安全绑定能力分析。型号能力只表示可用接口，不表示某台设备已经配置对应关系。

### 9.3 属性读取

```http
GET /api/xiaomi/control?did=...&properties=2.1,2.2,3.1,3.2
```

```json
{
  "ok": true,
  "did": "1206737667",
  "values": {
    "2.1": true,
    "2.2": 1
  },
  "errors": {},
  "capturedAt": "2026-08-26T00:00:00.000Z"
}
```

单属性读取、属性写入和动作执行均回显目标 DID。写入与动作必须由用户明确触发。

## 10. 设备管理界面

### 10.1 筛选层级

筛选顺序固定为：

```text
家庭
  → 房间
    → 视图切换
```

- 切换视图不重置家庭和房间。
- 切换家庭时房间重置为“全屋”。
- 房间列表同时包含硬件房间和照明目标房间。
- 拓扑匹配始终扫描当前家庭全部房间，房间筛选只影响展示结果。

### 10.2 “开关与硬件”视图

本视图只显示：

- 物理墙壁开关
- 中控屏
- 独立智能灯具
- 智能灯组
- 网关及其他实际智能设备

展示规则：

1. 每个物理 DID 只显示一张卡片。
2. `.sN` 派生端点不单独显示。
3. 开关和中控卡片直接列出真实 `switch` 服务、目标名称、模式与 `sN`。
4. 点击硬件卡片打开物理设备配置。
5. 点击卡片中的具体服务打开物理设备配置并聚焦该派生端点。
6. 不显示“虚拟开关”标识。
7. 不要求二次展开才能看到按键与目标。

### 10.3 “实际照明”视图

1. 同一照明目标只显示一张目标卡片。
2. 卡片按 `targetRoom + targetName` 归类。
3. 卡片显示普通灯、智能灯、智能灯组或待确认目标。
4. 卡片显示有线、无线和待确认控制来源数量。
5. 拓扑图以目标为中心，分别绘制有线实线、无线虚线和未知关系。
6. 点击控制来源打开对应物理设备及具体端点。
7. 点击智能灯或灯组本体打开其独立配置。
8. 普通灯不生成不存在的灯具配置入口，只打开其有线开关服务。
9. 同一目标关联多个 DID 时，逐项显示并允许进入对应配置页面。

### 10.4 灯组

- `group.*` 显示为单独灯组卡片。
- 已返回成员 DID 时，成员嵌套在灯组卡片内。
- 点击灯组卡片编辑灯组；点击成员编辑单个设备。
- 未返回成员 DID 时显示“成员关系暂未公开”。
- 不依据名称推测灯组成员。

### 10.5 状态与响应式布局

- 离线硬件和智能灯显示离线样式。
- `unknown` 模式显示“模式待确认”。
- `inferred` 关系显示“名称推断”。
- 桌面端使用目标列表、拓扑图和控制详情并列布局。
- 移动端改为单列，保持全部配置入口和点击区域。
- 字体与触控区域适配 PC、平板和手机。

## 11. 按键绑定规则

### 11.1 能力判定

```ts
type BindingMode =
  | "target-action"
  | "target-property"
  | "readonly"
  | "unsupported";
```

只有满足以下条件之一时显示可写绑定界面：

1. 型号公开安全动作，并明确公开来源按键、目标 DID 和目标服务参数。
2. 型号公开可写目标 DID 属性，且目标类型符合属性能力。

以下能力不得作为云端灯具绑定入口：

```text
local-control
get-control-num
get-local-ctrl
enter-study
clear-wireless
厂商私有 payload
含义未知的整数参数
```

### 11.2 UI 行为

| 能力 | UI |
| --- | --- |
| `target-action` | 选择来源按键、目标灯具与目标服务后保存 |
| `target-property` | 选择具有独立 DID 的兼容智能灯后保存 |
| `readonly` | 只展示云端公开的绑定状态 |
| `unsupported` | 显示“型号未开放绑定接口”，不提供保存按钮 |

普通灯目标提交物理开关 DID 与实际回路；智能灯目标提交智能灯自身 DID。任何含义未知的参数都会阻止绑定提交。

## 12. 主卧拓扑基准

### 12.1 物理控制器

| DID | 设备 | 房间 |
| --- | --- | --- |
| `720449456` | 主卧智能中控屏 | 主卧 |
| `1206737667` | 主卧床头开关-左 | 主卧 |
| `1206848237` | 主卧床头开关-右 | 主卧 |

### 12.2 服务模式

| 物理 DID | 服务 | 派生目标 | `mode` | 角色 |
| --- | --- | --- | --- | --- |
| `720449456` | `14` | 床头筒灯 | `0` | 有线主控 |
| `720449456` | `15` | 中间筒灯 | `0` | 有线主控 |
| `720449456` | `16` | 床尾筒灯 | `0` | 有线主控 |
| `1206737667` | `2` | 灯带 | `1` | 无线副控 |
| `1206737667` | `3` | 床头筒灯 | `1` | 无线副控 |
| `1206737667` | `4` | 中间筒灯 | `1` | 无线副控 |
| `1206848237` | `2` | 灯带 | `0` | 有线主控 |
| `1206848237` | `3` | 床头筒灯 | `1` | 无线副控 |
| `1206848237` | `4` | 中间筒灯 | `1` | 无线副控 |

### 12.3 聚合结果

| 照明目标 | 有线来源 | 无线来源 | 总控制来源 |
| --- | --- | --- | --- |
| 主卧灯带 | 右床头开关 `1206848237.s2` | 左床头开关 `1206737667.s2` | 2 |
| 主卧床头筒灯 | 中控屏 `720449456.s14` | 左 `1206737667.s3`、右 `1206848237.s3` | 3 |
| 主卧中间筒灯 | 中控屏 `720449456.s15` | 左 `1206737667.s4`、右 `1206848237.s4` | 3 |
| 主卧床尾筒灯 | 中控屏 `720449456.s16` | 无 | 1 |

主卧“实际照明”视图必须聚合为以上 4 个目标；“开关与硬件”视图必须显示以上 3 个物理控制器，不显示 9 个派生端点卡片。

## 13. 验收标准

### 13.1 解析与分类

1. `1206737667.s2` 解析为根 DID `1206737667` 与 `siid=2`。
2. `720449456.s15` 解析为根 DID `720449456` 与 `siid=15`。
3. `group.*`、`blt.*` 和 `lumi.*` 保持完整 DID。
4. `xiaomi.controller.oh4w` 始终归类为中控屏。
5. 网关不归类为中控屏或墙壁开关。
6. 没有真实 `switch` 服务的事件按键不进入照明拓扑。

### 13.2 模式与状态

1. `mode=0` 显示“有线主控”。
2. `mode=1` 显示“无线副控”。
3. 缺少或无法识别的 `mode` 显示“模式待确认”。
4. 无线端点的 `on` 不覆盖目标状态。
5. 普通灯状态取有线端点。
6. 智能灯和灯组状态取自身 DID。
7. 离线智能灯不借用继电器状态。

### 13.3 关联与房间

1. 关联仅在同一家庭内建立。
2. 名称关联扫描当前家庭全部房间。
3. 普通灯按有线派生端点房间归类。
4. 智能灯和灯组按自身房间归类。
5. 名称歧义不自动选择目标。
6. “副控”确认无线角色，但名称目标标记为 `inferred`。
7. 灯组成员只使用真实返回 DID。

### 13.4 界面

1. 房间选择位于视图切换上方。
2. 切换视图保留房间选择。
3. 硬件视图每个物理 DID 只有一张卡片。
4. 派生端点只出现在物理卡片的服务列表或照明拓扑中。
5. 实际照明视图每个目标只有一张卡片。
6. 点击控制来源进入物理设备并聚焦具体服务。
7. 普通灯不显示虚构的智能灯配置入口。
8. 智能灯和灯组保留自身配置入口。
9. 桌面端和移动端均保留全部筛选与配置能力。

## 14. 代码与规格参考

核心实现文件：

```text
app/api/xiaomi/devices/route.ts
app/api/xiaomi/spec/route.ts
app/api/xiaomi/control/route.ts
app/device-management.tsx
app/page.tsx
lib/xiaomi-cloud.ts
lib/miot-spec.ts
lib/device-topology.ts
lib/device-management.ts
lib/device-groups.ts
lib/switch-channel-mode.ts
lib/switch-bindings.ts
```

型号规格：

- [领普四键墙壁开关 `linp.switch.qh2db4`](https://home.miot-spec.com/spec/linp.switch.qh2db4)
- [领普三键墙壁开关 `linp.switch.t2dbw3`](https://home.miot-spec.com/spec/linp.switch.t2dbw3)
- [领普双键墙壁开关 `linp.switch.t2dbw2`](https://home.miot-spec.com/spec/linp.switch.t2dbw2)
- [领普单键墙壁开关 `linp.switch.t2dbw1`](https://home.miot-spec.com/spec/linp.switch.t2dbw1)
- [小米智能中控屏 `xiaomi.controller.oh4w`](https://home.miot-spec.com/spec/xiaomi.controller.oh4w)
- [智能灯组 `mijia.light.group3`](https://home.miot-spec.com/spec/mijia.light.group3)
