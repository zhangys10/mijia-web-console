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
- 桌面端和移动端响应式界面

## 自动化支持范围

自动化与手动场景共用米家 `AppSceneService`。控制台按家庭读取真实规则，并把时间、设备、位置、天气和厂商私有触发条件转换为不含账号凭据、真实位置或私有 payload 的展示模型。

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
