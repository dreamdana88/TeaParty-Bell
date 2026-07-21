# TeaParty-Bell（茶会钟声 / 小G宝）

Discord 社区 BOT，为茶话会社区提供 Boost 助力自动感谢等服务。

## 功能（规划中）

- Boost 助力自动感谢（第一版核心功能，Phase 2 进行中）
- 社区事件播报（规划中）
- 频道内容总结（规划中）
- AI 聊天交互（规划中）

## 技术栈

- Node.js ≥ 18
- discord.js v14
- DeepSeek API（AI 文案生成）

## 快速开始

### 1. 克隆项目

```bash
git clone <repo-url>
cd TeaParty-Bell
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 填入真实的 Discord Bot Token、Application ID、服务器 ID 等配置。

### 4. 启动

```bash
npm start        # 生产启动
npm run dev      # 开发模式（文件变更自动重启）
```

## 项目结构

```text
src/
├── core/          # BOT 启动、生命周期、事件调度
├── discord/       # Discord 连接、事件监听、消息发送
├── ai/            # DeepSeek 等 AI 能力（后续 Phase）
├── features/      # 具体业务功能（后续 Phase）
├── storage/       # 本地持久化（后续 Phase）
├── resources/     # 表情、Reaction 等资源管理（后续 Phase）
├── config/        # 配置管理
└── utils/         # 通用工具

data/
├── history/       # 处理记录存储
├── prompts/       # AI Prompt 模板
└── emojis/        # 表情资源配置
```

## 施工状态

当前处于 **Phase 2：Boost 事件验证**（自动测试完成，等待真实 Discord Boost 环境验证）。

详细施工规划见 [BOT_CONSTRUCTION_PLAN.md](./BOT_CONSTRUCTION_PLAN.md)。

### 真实环境测试前置条件

在真实 Discord 环境中验证 Boost 检测前，请确保：

**Discord Developer Portal（BOT 端）：**

- BOT 已创建并获取 Token
- 不需要启用任何 Privileged Gateway Intent（当前仅使用非特权的 `Guilds` + `GuildMessages`）

**Discord 服务器端：**

- 服务器设置 → 概览 → **System Messages Channel**：已指定一个频道
- 服务器设置 → 概览 → **"Send a message when someone Boosts this server"**：已开启
- 未满足以上两项时，Discord 不会为 Boost 事件生成系统消息，BOT 将无事件可监听

**BOT 频道权限：**

- BOT 必须能够**查看**（`View Channel` / `Read Messages`）服务器的 System Messages Channel
- 即使 Gateway Intent 配置正确，若频道权限阻止 BOT 读取该频道，仍无法收到 Boost 系统消息
- System Messages Channel 与 `.env` 中的 `DISCORD_THANKS_CHANNEL_ID`（后续感谢发送目标）职责独立，两者可以是同一频道也可以是不同频道

**`.env` 配置：**

- `DISCORD_BOT_TOKEN`、`DISCORD_APPLICATION_ID`、`DISCORD_GUILD_ID`、`DISCORD_THANKS_CHANNEL_ID` 已正确填写

**验证步骤：**

1. 启动 BOT：`npm start`
2. 确认日志中看到 `Discord BOT 已就绪`
3. 请一位成员对服务器进行 Nitro Boost 助力
4. 观察 BOT 日志中是否出现 `[BoostObserver] 检测到疑似 Boost 事件`
5. 将包含完整 `[BoostObserver]` 日志的内容提供给开发者继续分析

## License

UNLICENSED — 内部项目，未开放授权。
