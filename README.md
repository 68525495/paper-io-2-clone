# Paper.io 2 复刻

复刻 Paper.io 2

![Paper.io 2复刻 游戏画面](artifacts/image.png)


## 技术栈

| 层 | 技术 |
| --- | --- |
| 浏览器客户端 | TypeScript、Vite 6、Babylon.js 7、`@colyseus/sdk` 0.18 |
| 权威服务端 | TypeScript、Colyseus 0.18、`@colyseus/schema` 5、Express 4 |
| 测试 | Vitest |
| 包管理 | pnpm；客户端与 `server/` 使用独立的 manifest 和 lockfile |

## 快速开始

### 环境要求

- Node.js 22+
- pnpm 9+
- 支持 WebGL 的现代浏览器

### 安装依赖

```bash
git clone https://github.com/68525495/paper-io-3d.git
cd paper-io-3d

pnpm install
pnpm --dir server install
```

根目录和 `server/` 是两个独立的 Node.js package，不是 pnpm workspace，因此首次运行时需要分别安装依赖。

### 启动本地开发环境

先启动 Colyseus 服务端：

```bash
pnpm dev:server
```

再打开另一个终端启动 Vite 客户端：

```bash
pnpm dev
```

访问 <http://localhost:3000>。本地服务默认地址如下：

- Vite 客户端：`http://localhost:3000`
- Colyseus / Express：`http://localhost:2567`
- 健康检查：`http://localhost:2567/health`

Vite 会监听局域网地址，客户端默认连接到当前页面主机的 `2567` 端口，因此同一局域网内的手机也可以使用开发机 IP 访问。请确保防火墙允许 `3000` 和 `2567` 端口。

如需显式指定游戏服务地址，可在启动客户端时设置：

```bash
VITE_COLYSEUS_ENDPOINT=ws://localhost:2567 pnpm dev
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动 Vite 客户端开发服务器。 |
| `pnpm dev:server` | 以 watch 模式启动本地 Colyseus 服务端。 |
| `pnpm typecheck` | 检查客户端 TypeScript。 |
| `pnpm --dir server typecheck` | 检查服务端 TypeScript。 |
| `pnpm --dir server test` | 运行服务端及共享逻辑的 Vitest 回归测试。 |
| `pnpm build` | 安装并验证服务端依赖，运行测试和两端类型检查，再构建完整发布产物。 |
| `pnpm preview` | 预览已经构建的静态客户端；多人功能仍需要可连接的 Colyseus 服务端。 |

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `VITE_COLYSEUS_ENDPOINT` | 自动解析 | 显式指定浏览器连接的 Colyseus endpoint，例如 `ws://localhost:2567`。这是 Vite 客户端变量，会在构建时写入产物。 |
| `PORT` | `2567` | 本地 Colyseus / Express 服务监听端口。修改它时也应同步设置客户端 endpoint。 |
| `MAX_PLAYERS_PER_ROOM` | `8` | 每个房间最多允许的真人客户端数量，最小值为 1。 |
| `DEBUG_GAME_TICKS` | 未启用 | 设为 `1` 后输出低频服务端 Tick 诊断日志。 |

不要在任何 `VITE_*` 变量中放入密钥；这类变量会进入公开的浏览器包。

客户端按以下优先级解析多人服务地址：

1. `VITE_COLYSEUS_ENDPOINT`；
2. 部署后 `colyseus.json` 中由平台写入的无凭证 `endpoint`；
3. 当前页面主机的 `2567` 端口，作为本地开发回退。

## 项目结构

```text
.
├── index.html                 # 开始页、Canvas 与客户端入口
├── src/
│   ├── main.ts                # 客户端启动、房间连接和事件编排
│   ├── game/                  # Babylon.js 场景、渲染、输入与网络平滑
│   ├── ui/                    # HUD、小地图与样式
│   └── shared/                # 客户端 Schema、协议和共享游戏常量
├── server/
│   ├── src/index.ts           # 仅用于本地开发的 Colyseus 主机
│   ├── src/game.ts            # Runner 插件入口与房间注册
│   ├── src/PaperRoom.ts       # 房间生命周期和 30 Hz 权威模拟
│   ├── src/territory.ts       # 网格、围合与领地转移
│   ├── src/bot.ts             # Bot 决策逻辑
│   └── src/test/              # 回归测试
├── public/colyseus.json       # Loopit 动态 Runner 源标记
└── artifacts/                 # README 与开发过程使用的截图
```

`server/src/schema.ts`、`protocol.ts`、`constants.ts` 与 `src/shared/` 中对应文件共同构成客户端和服务端协议。修改字段、消息或影响预测的常量时，需要同步更新两端。

## 多人架构

```text
输入设备
   │
   ▼
GameClient ── input / clock_ping ──▶ PaperRoom（权威状态与 30 Hz 模拟）
   ▲                                      │
   │                                      ├── Colyseus Schema patches
   └── grid / trail / gameplay events ────┘
   │
   ▼
MovementSynchronizer → Babylon.js Renderers → HUD / MiniMap
```

客户端通过 `joinOrCreate("paper", { name })` 进入默认房间。服务端还注册了使用相同 Room 实现的 `practice` 房间，但默认客户端不会使用它。移动、碰撞、圈地、击杀、排行榜和胜负均由服务端判定；客户端预测与插值只负责画面平滑。

主要同步方式：

- Colyseus Schema 保存玩家、排行榜、服务端时间与比赛结果等持久状态。
- `full_grid_sync` 同步领地网格，按数据大小选择 raw 或 RLE。
- `trail_sync` 在轨迹开始时立即发送，之后约以 3 Hz 发送完整紧凑快照。
- `territory_captured`、`player_killed`、`game_over` 等消息承载瞬时事件。
- 客户端每 2 秒测量一次 RTT，并把平滑后的延迟交给 Runner 指标通道。

## 测试与构建

提交改动前建议至少运行：

```bash
pnpm typecheck
pnpm --dir server typecheck
pnpm --dir server test
```

涉及资源、模块边界、客户端与服务端集成或部署配置时，再运行完整构建：

```bash
pnpm build
```

`pnpm build` 会先执行测试与两端类型检查，然后依次生成浏览器包和服务端插件：

```text
dist/
├── index.html
├── assets/
├── colyseus.json
└── server/
    ├── game.js               # 导出 gamePlugin 的 Runner 入口
    └── ...                   # Room、Schema 与服务端运行模块
```

`dist/` 是生成目录，请勿直接编辑。`dist/server/` 是私有服务端产物，不应作为普通静态文件公开。