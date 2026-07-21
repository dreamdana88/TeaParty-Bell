# Discord 社区 BOT 施工规划

暂定名称：小G宝 / 茶会钟声

## 官方文档优先来源

涉及 Discord 和 DeepSeek 接口时，优先查询以下官方文档：

- Discord Gateway / Intents
  <https://docs.discord.com/developers/events/gateway>

- Discord Message Resource
  <https://docs.discord.com/developers/resources/message>

- discord.js 官方文档
  <https://discord.js.org/docs>

- DeepSeek API 官方文档
  <https://api-docs.deepseek.com/>

禁止优先使用博客、Stack Overflow、过时教程或未经验证的第三方示例替代官方文档。

## 一、项目定位

开发一个拥有固定名称、头像和 Discord Bot 身份的社区 BOT。

当前第一版核心功能：

Discord 服务器出现新的 Boost 助力
→ BOT 捕获助力事件
→ 获取助力成员信息
→ 调用 DeepSeek API
→ 按社区固定格式生成感谢文案
→ BOT 在指定频道发送感谢
→ 自动添加约 8～10 个 Reaction
→ 记录处理结果，防止重复发送

项目应保持清晰、模块化和可扩展性。

未来可能增加：

- 其他社区事件播报
- 指定频道内容总结
- AI 聊天交互
- 定时社区播报
- 管理员指令
- 其他 AI 功能

当前只开发已经确认的功能，不提前实现未确定业务。

# 二、铁律

- 以瞎猜接口为耻，以认真查询为荣。
- 以模糊执行为耻，以寻求确认为荣。
- 以臆想业务为耻，以人类确认为荣。
- 以创造接口为耻，以复用现有为荣。
- 以跳过验证为耻，以主动测试为荣。
- 以破坏架构为耻，以遵循规范为荣。
- 以假装理解为耻，以诚实无知为荣。
- 以盲目修改为耻，以谨慎重构为荣。

# 三、设计原则

1. Discord 接入、AI、业务功能、存储、消息发送相互解耦。

2. DeepSeek 必须通过统一 AI 接口调用，业务模块不得重复实现 API 请求。

3. Discord 原始事件先转换为内部统一事件，再进入业务逻辑。

4. 消息发送、Reaction、表情资源统一管理，不允许相关 ID 散落在业务代码中。

5. Token、API Key、服务器 ID、频道 ID 等通过环境变量或配置管理。

6. 第一版使用轻量本地持久化，不提前引入复杂数据库。

7. Discord 和第三方 API 的接口、权限、字段必须查询官方文档并通过真实测试确认。

8. 保留合理扩展能力，禁止为未知需求提前制造复杂架构。

# 四、建议项目结构

src/
├── core/               # BOT 启动、事件调度
├── discord/            # Discord 连接、事件监听、消息发送
├── ai/                 # DeepSeek 等 AI 能力
├── features/
│   └── boostThanks/    # 助力感谢功能
├── storage/            # 历史记录、防重复
├── resources/          # 表情、Reaction 等资源管理
├── config/             # 配置
└── utils/              # 通用工具

data/
├── history/
├── prompts/
└── emojis/

不得将整个 BOT 写成单文件大脚本。

# 五、第一版施工流程

## Phase 1：基础骨架

完成：

- Node.js 项目初始化
- Discord BOT 登录
- 环境变量配置
- 基础日志
- 基础异常处理
- 正常启动与退出

验收：

- BOT 能稳定连接 Discord
- 敏感信息不会进入 Git
- 配置缺失时给出明确错误

## Phase 2：Boost 事件验证

完成：

- 查询 Discord 当前官方文档
- 监听相关 Boost 事件
- 输出必要调试信息
- 确认真实助力者信息来源
- 确认事件 ID、事件类型等字段
- 验证一次 Boost 是否可能产生多个相关事件

此阶段允许先完成代码和模拟测试。

真实 Boost 行为必须经过实际 Discord 环境验证后才能最终验收。

不得通过文本猜测系统消息内容。

## Phase 3：统一事件层

将 Discord 原始事件转换为内部统一结构，例如：

- eventId
- eventType
- userId
- username
- displayName
- guildId
- channelId
- timestamp

后续业务逻辑只依赖统一事件结构。

## 连续助力聚合

需要支持同一成员短时间内连续投放多个助力时合并感谢。

要求：

- 以 guildId + userId 作为聚合键。
- 设置可配置的短时间聚合窗口，默认建议 15 秒。
- 同一聚合窗口内的多个真实 Boost 事件累计 boostCount。
- 每收到新的可计数 Boost 时重新计算等待窗口。
- 窗口结束后只触发一次后续感谢流程。
- 感谢上下文必须包含 boostCount。
- 单个助力与多个助力使用对应的标题表达。
- Tier 升级事件不得未经验证直接计入 boostCount。
- BOT 重启、并发事件、重复 Gateway 事件需要在后续防重复设计中考虑。

## Phase 4：DeepSeek 接入

建立统一 AI Provider。

完成：

- DeepSeek API 配置
- 统一文本生成接口
- 超时处理
- 明确错误处理
- 模型可配置
- Prompt 与 API 请求逻辑分离

业务模块不得自行重复调用 DeepSeek。

## Phase 5：感谢文案生成

感谢文案必须符合社区现有格式，例如：

感谢 @用户 阿咪给茶话会投喂的助力！

正文祝福内容……

要求：

- 正确 @ 助力成员
- 固定标题格式
- 正文由 AI 生成
- 支持社区文风规则
- 支持示例文案作为风格参考
- 可根据用户名适度玩梗
- 避免机械重复
- 禁止直接复制旧文案
- AI 只负责文案内容，不负责生成未经验证的 Discord 表情 ID

## Phase 6：消息发送

完整流程：

BoostEvent
→ 防重复检查
→ 构建 Prompt
→ DeepSeek 生成
→ 内容有效性检查
→ BOT 在指定频道发送
→ 添加 Reaction
→ 成功后记录事件

感谢频道必须通过配置指定。

## Phase 7：Reaction 表情系统

感谢消息发送成功后，BOT 自动添加约 8～10 个 Reaction。

要求：

- Reaction 数量可配置
- 表情资源统一管理
- 支持 Application Emoji
- 支持 Unicode Emoji
- 预留服务器自定义 Emoji 支持
- 支持固定核心 Reaction + 随机 Reaction 池
- 同一条消息不得重复选择相同表情
- 表情名称和 ID 通过统一资源模块管理
- 禁止在业务代码中散落硬编码表情 ID
- 单个 Reaction 添加失败时记录日志，并继续处理其他 Reaction
- Reaction 失败不得影响已经成功发送的感谢正文

推荐逻辑：

固定 2～3 个核心 Reaction
+
随机抽取其他 Reaction
=

最终约 8～10 个

## Phase 8：防重复与失败处理

要求：

- 同一 Boost 事件不得重复感谢
- AI 失败不得标记完成
- Discord 消息发送失败不得标记完成
- BOT 重启后仍能识别已处理事件
- 错误必须有明确日志
- 禁止层层兜底掩盖真实故障

感谢正文已经成功发送后，即视为核心业务成功。

Reaction 部分允许独立失败并记录日志，避免因单个表情失败导致重复发送整篇感谢。

## Phase 9：测试工具

提供管理员专用测试入口，例如：

/感谢测试 @用户

用于测试：

- DeepSeek 调用
- Prompt
- 固定感谢格式
- @用户
- 消息发送
- Reaction
- 表情资源

无需真实 Boost 即可测试完整感谢链路。

同时支持测试模式，避免开发期间误发正式消息。

# 六、基础配置

至少支持：

- Discord Bot Token
- Application ID
- 目标服务器 ID
- 感谢频道 ID
- DeepSeek API Key
- DeepSeek API 地址
- DeepSeek 模型
- 测试模式
- 日志等级
- Reaction 数量

敏感配置进入 .env。

仓库只提供 .env.example。

# 七、表情资源管理

小G宝使用的 Application Emoji 统一登记。

资源模块负责：

- 表情名称
- 表情 ID
- 表情类型
- 是否属于固定 Reaction
- 是否允许进入随机池

AI 不直接控制真实表情 ID。

以后新增或删除表情时，应尽量只修改资源配置，无需修改助力业务逻辑。

# 八、未来扩展预留

项目应允许未来新增独立 Feature，例如：

features/
├── boostThanks/
├── announcements/
├── channelSummary/
└── chat/

各 Feature 可以复用：

- Discord
- AI
- Storage
- Emoji Resources
- Logger

新增功能原则上不应要求重写已有助力感谢功能。

# 九、第一版明确不做

- Web 管理后台
- 复杂数据库
- 多服务器管理系统
- 多 AI Provider 管理界面
- 自动频道总结
- AI 聊天
- 大量 Slash Command
- 未确认的社区自动化功能

仅预留合理扩展空间，不提前实现。

# 十、最终验收标准

第一版必须达到：

- BOT 可以稳定上线
- 能正确识别 Boost
- 能正确获取助力成员
- DeepSeek 能生成符合格式的感谢文案
- 能正确 @ 助力成员
- 能发送到指定感谢频道
- 能自动添加约 8～10 个 Reaction
- Application Emoji 可以正常作为 Reaction 使用
- 同一事件不会重复发送
- BOT 重启后历史记录有效
- API 或 Discord 失败时有明确日志
- 可通过管理员测试命令测试完整流程
- 无明显重复接口
- 无无意义兜底
- 无敏感信息泄露
- 无大量硬编码
- 模块职责清晰
- 未来新增其他社区 Feature 无需推翻现有架构

# 十一、施工要求

按照 Phase 顺序推进。

不存在外部阻塞时可以连续完成多个 Phase，无需每阶段等待人工确认。

每个 Phase 必须：

1. 完成实现
2. 执行对应测试
3. 修复发现的问题
4. 记录测试结果

遇到以下情况必须暂停并说明：

- 需要真实 Discord 配置
- 需要真实 Boost 验证
- 第三方接口行为无法确认
- 业务规则存在歧义
- 需要用户决定产品行为

禁止未经确认擅自扩展需求。

完成第一版后进行一次整体代码审查，并输出：

- 已完成功能
- 项目结构
- 测试结果
- 未完成的真实环境验证
- 发现的问题
- 下一步需要人工完成的操作
