# TeaParty-Bell（茶会钟声 / 小G宝）

Discord 社区 BOT，为茶话会社区提供 Boost 助力自动感谢等服务。

## 功能（规划中）

- Boost 助力自动感谢（第一版核心功能）
- 社区事件播报
- 频道内容总结
- AI 聊天交互

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

当前处于 **Phase 1：基础骨架**。

详细施工规划见 [BOT_CONSTRUCTION_PLAN.md](./BOT_CONSTRUCTION_PLAN.md)。

## License

UNLICENSED — 内部项目，未开放授权。
