# BOT_CONSTRUCTION_PLAN2.md

> TeaParty-Bell 后续建设总计划  
> 适用范围：自动感谢主线完成后的生产加固与社区管理功能扩展  
> 建立日期：2026-07-24

---

## 0. 文档地位

本文件是 `BOT_CONSTRUCTION_PLAN.md` 的后续版本。

旧文件继续保留，作为 TeaParty-Bell 从 Phase 1 到自动感谢主线完成期间的历史设计记录；从本文件建立之日起，以下内容以本文件为准：

- 已上线自动感谢系统的生产维护
- Gateway 健康监控
- 启动权限自检
- Hermes / Telegram 私下告警
- 管理员套皮回复与直接发言
- 自动顶帖机制验证
- 自动顶帖管理员配置面板
- 本地 Dev Bot 与生产 Bot 的隔离开发流程

执行任何新阶段前，必须同时阅读：

```text
AGENTS.md
BOT_CONSTRUCTION_PLAN2.md
```

若两者发生冲突：

```text
AGENTS.md 优先
```

旧 `BOT_CONSTRUCTION_PLAN.md` 不再作为未来功能范围与阶段顺序的唯一依据。

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

禁止优先使用博客、Stack Overflow、过时教程或未经验证的第三方示例替代官方文档
---

# 1. 项目定位

项目名称：

```text
TeaParty-Bell
```

Discord Bot：

```text
小G宝
```

主要服务社区：

```text
外神们的茶话会
```

社区性质：

```text
女性用户为主体的 SillyTavern 玩家社区
```

项目目前已完成第一条核心业务线：

```text
Discord Boost
→ 识别真实 Boost 系统消息
→ 连续助力聚合
→ AI 生成感谢正文
→ 代码生成固定标题
→ 发送至感谢频道
→ 添加随机 Application Emoji Reaction
→ 持久化处理状态
→ 防止同一事件重复发送
```

后续目标是将小G宝从“自动感谢 Bot”扩展为：

```text
稳定运行的社区辅助 Bot
+
管理员可控的社区发言工具
+
论坛维护工具
```

---

# 2. 核心开发原则

## 2.1 八荣八耻

所有开发 Agent 必须遵守：

```text
以瞎猜接口为耻，以认真查询为荣。
以模糊执行为耻，以寻求确认为荣。
以臆想业务为耻，以人类确认为荣。
以创造接口为耻，以复用现有为荣。
以跳过验证为耻，以主动测试为荣。
以破坏架构为耻，以遵循规范为荣。
以假装理解为耻，以诚实无知为荣。
以盲目修改为耻，以谨慎重构为荣。
```

## 2.2 强制开发节奏

每个独立阶段必须遵循：

```text
只读审查
→ 提交设计摘要
→ 用户确认
→ 实现
→ 自动测试
→ Push GitHub
→ 审阅 GitHub 实际代码与 diff
→ Review Fix
→ 再次测试
→ VPS 拉取部署
→ 生产验收
→ 封箱
```

禁止：

```text
一次性实现多个大功能
跳过只读审查
只看完成报告、不看真实代码
让 VPS 成为常规开发环境
未测试即直接部署生产
```

## 2.3 架构边界

总体依赖方向：

```text
Feature
  ↓
Shared Discord / Commands / Storage / Alerts / AI / Resources
```

禁止反向依赖：

```text
公共模块
  ↓
具体 Feature
```

例如：

```text
messageSender
不能依赖 boostThanks

productionAlertNotifier
不能依赖 threadRevival

adminAuthorization
不能依赖某个具体命令
```

## 2.4 社区静默原则

运行维护故障不得公开发送到社区频道。

禁止在以下位置发布系统错误：

```text
感谢频道
普通聊天频道
系统消息频道
Forum 帖子
公告频道
```

运行维护信息只允许进入：

```text
VPS journal
本地持久化告警 outbox
Hermes
Telegram 私聊通知
```

---

# 3. 当前生产基线

## 3.1 已完成主线

当前完成状态：

```text
Phase 1   项目基础架构                         ✅
Phase 2   Discord Boost 真实事件检测           ✅
Phase 3   BoostEvent 与连续助力聚合            ✅
Phase 4   厂商无关 AI Provider                 ✅
Phase 4.5 Guild Emoji 批量备份工具             ✅
Phase 5   感谢文案生成                         ✅
Phase 6   Discord 正式发送                     ✅
Phase 7   Application Emoji Reaction           ✅
Phase 8   防重复、持久化与安全失败状态机        ✅
Hotfix    Guild 白名单隔离                     ✅
VPS       systemd user service 常驻部署         ✅
```

Guild Isolation 修复后曾达到：

```text
794 passed
0 failed
```

后续以 GitHub 最新提交和最新全量测试报告为准。

## 3.2 自动感谢主线

正式链路：

```text
Discord MessageCreate
→ Guild 白名单过滤
→ BoostObserver
→ BoostNormalizer
→ BoostAggregator
→ BoostThanks Handler
→ BoostThanks Store
→ Copy Generator
→ Message Builder
→ Message Sender
→ markSent
→ Application Emoji Reaction
```

## 3.3 当前关键生产配置

正式 Guild：

```text
1447978053665030280
```

正式感谢频道：

```text
1457244225916637348
```

正式系统消息频道：

```text
1448005989214322809
```

生产环境要求：

```text
TEST_MODE=false
```

不得把任何 Token、API Key 或完整 `.env` 写入本文件、日志、Issue 或聊天记录。

## 3.4 已验证权限

系统消息频道必须具备：

```text
ViewChannel
ReadMessageHistory
```

感谢频道必须具备：

```text
ViewChannel
SendMessages
ReadMessageHistory
AddReactions
```

Application Emoji 获取失败：

```text
Reaction 降级
主消息仍可工作
```

## 3.5 已确认的部署教训

以下内容必须写入未来部署检查表：

```text
DISCORD_GUILD_ID 必须指向正式 Guild
Observer 必须按 Guild 白名单过滤
Bot 必须能查看 System Messages Channel
Bot 必须能读取系统消息历史
Bot 必须能在感谢频道发送消息
Bot 必须能在感谢频道添加 Reaction
TEST_MODE 在生产环境必须为 false
正式 Bot 不得同时在本地和 VPS 运行完整监听进程
```

---

# 4. 开发环境隔离

## 4.1 正式 Bot

```text
名称：小G宝
运行位置：VPS
目标：外神们的茶话会
用途：生产服务
```

## 4.2 Dev Bot

应新建独立 Discord Application：

```text
名称建议：小G宝 Dev / 小G宝 2号
运行位置：本地 Windows
目标：私人测试服务器
用途：新功能开发与真实 Discord 测试
```

必须使用独立：

```text
Bot Token
Application ID
Guild ID
测试频道
Application Emoji
运行状态文件
```

禁止：

```text
Dev Bot 加入茶话会
本地使用正式 Bot Token 启动完整 Bot
生产与开发共用 Phase 8 状态文件
```

## 4.3 标准交付链

```text
本地开发
→ Dev Bot 实测
→ 全量测试
→ Git commit
→ Push GitHub
→ 代码审阅
→ Hermes 在 VPS git pull
→ VPS 再跑全量测试
→ 重启 systemd service
→ 查看启动日志
→ 生产观察
```

常规开发不应直接在 VPS 修改代码。

VPS 只适合：

```text
紧急生产止血
.env 调整
systemd 配置
权限与目录修复
部署检查
```

若 VPS 临时产生代码 commit，必须通过 patch 或其他可审计方式同步回 GitHub。

---

# 5. 后续总体路线

开发顺序固定为：

```text
Stage 0  小G宝 Dev 环境
    ↓
Stage A  Gateway Health + Startup Preflight + Hermes Alert
    ↓
Stage B  Admin Voice 管理员套皮发言
    ↓
Stage C  Thread Revival Mechanism POC
    ↓
Stage D  Thread Revival Scheduler + Admin Config Panel
```

不得在 Stage A 未完成前进入自动顶帖正式实现。

不得在顶帖机制未实测前开发完整定时调度器。

---

# 6. Stage A：生产健康监控

模块名称建议：

```text
Production Hardening
Gateway Health Monitor
Startup Preflight
Production Alert
```

这是当前第一优先级。

## 6.1 目标

```text
观察 Discord Gateway 生命周期
判断连接是否长期不健康
长期异常时安全退出
由 systemd 自动重启
启动时检查关键 Guild / 频道 / 权限
社区内保持静默
将故障交给 Hermes
由 Hermes 在 Telegram 通知项目作者
恢复后只通知一次
```

## 6.2 Gateway 原则

discord.js 继续负责：

```text
heartbeat
heartbeat ACK
reconnect
resume
session management
```

TeaParty-Bell 不自行实现 Gateway 心跳协议。

禁止：

```text
自行发送 heartbeat opcode
每小时向 Discord 频道发送“我还活着”
仅凭没有业务日志判断 Gateway 死亡
仅凭 ping 较高重启 Bot
```

## 6.3 生命周期日志

集中监听：

```text
shardReady
shardDisconnect
shardReconnecting
shardResume
shardError
invalidated
```

安全日志字段可包括：

```text
shardId
closeCode
closeReason
replayedEvents
errorName
errorMessage
wsStatus
ping
timestamp
```

禁止记录：

```text
Token
API Key
完整环境变量
完整请求头
完整 Prompt
未经清洗的 Error 对象
```

## 6.4 健康检查

建议默认值：

```text
检查间隔：60 秒
启动宽限期：5 分钟
连续异常阈值：5 分钟
正常摘要：每小时最多一次
```

主要健康依据：

```text
client.isReady() === true
client.ws.status === Ready
```

`client.ws.ping`：

```text
仅用于诊断
不能单独触发退出
```

行为：

```text
单次不健康
→ warning
→ 不退出

阈值内恢复
→ 清零异常计时
→ 记录恢复

持续超过阈值
→ 创建一次故障告警
→ exit(1)
→ systemd 自动重启
```

## 6.5 Startup Preflight

首次 Ready 后检查：

### Guild

```text
目标 Guild 存在
Guild ID 与配置一致
```

### 系统消息频道

```text
systemChannelId 存在
频道属于目标 Guild
ViewChannel
ReadMessageHistory
```

### 感谢频道

```text
频道存在
频道属于目标 Guild
频道类型可发送文字消息
ViewChannel
SendMessages
ReadMessageHistory
AddReactions
```

### Application Emoji

```text
Provider 可访问
失败仅降级 Reaction
不阻塞主消息
```

### 运行模式

```text
明确 production 时：
TEST_MODE 必须为 false

development / test：
允许 TEST_MODE=true
```

必须先复用项目已有环境判定方式。

不得未经审查随意增加重复环境变量体系。

## 6.6 故障分类

### 可重启恢复的运行期故障

例如：

```text
Gateway 长期不健康
Gateway 启动超时
```

处理：

```text
写日志
创建告警
exit(1)
systemd Restart=on-failure
```

### 永久性配置或权限故障

例如：

```text
Guild 配错
系统消息频道不存在
系统频道无 ViewChannel
感谢频道无 SendMessages
production 下 TEST_MODE=true
```

处理：

```text
社区静默
写日志
创建告警
exit(78)
```

systemd：

```ini
Restart=on-failure
RestartSec=10s
RestartPreventExitStatus=78
```

避免每 10 秒反复撞墙。

### 非致命降级

例如：

```text
Application Emoji 获取失败
AddReactions 不可用
```

处理：

```text
主消息继续运行
Reaction 降级
warning
非致命告警
不退出
```

## 6.7 Alert Notifier 与 Outbox

TeaParty-Bell 不直接绑定 Hermes 内部实现。

建议抽象：

```text
notifyFailure(alert)
notifyRecovery(alert)
notifyWarning(alert)
```

若没有可验证的 Hermes API：

```text
先写本地 alert outbox
再由 VPS 上的 Hermes 读取并转发 Telegram
```

建议路径：

```text
data/runtime/alerts/
```

要求：

```text
atomic write
串行写入
损坏时 fail closed
非法 JSON 不得当成空 outbox
Hermes 暂时不可用时告警不丢失
```

状态建议：

```text
pending
delivered
resolved
delivery_failed
```

不得假装 Telegram 已经通知成功。

## 6.8 告警防刷屏

同一轮故障：

```text
一次 failure
一次 recovery
```

持续异常期间：

```text
不每分钟重复告警
不每次重启重复 Telegram 轰炸
```

新的独立故障才允许新建告警。

## 6.9 Hermes / Telegram 目标链路

最终目标：

```text
TeaParty-Bell
→ 产生结构化告警
→ Alert Outbox / Notifier
→ Hermes
→ Telegram 私聊梦宝
```

社区中：

```text
完全静默
```

Stage A 完工报告必须明确：

```text
已真实接通 Hermes Telegram
```

或：

```text
TeaParty-Bell outbox 已完成
Hermes 转发仍需部署接入
```

禁止模糊表述。

## 6.10 Stage A 验收

必须覆盖：

```text
Ready 不退出
启动宽限期
短暂断线
断线恢复
长期异常 exit(1)
永久配置错误 exit(78)
正常摘要限频
生命周期日志
Preflight 权限检查
社区不发故障消息
告警防重复
Outbox 持久化与损坏处理
资源清理
```

Stage A 完成前，不开发管理员套皮和自动顶帖。

---

# 7. Stage B：Admin Voice 管理员套皮发言

模块名称建议：

```text
Admin Voice
Admin Puppet Reply
管理员套皮发言
```

该功能完全由管理员提供文字。

DeepSeek 不参与。

## 7.1 功能范围

必须同时支持：

```text
回复指定消息
直接发送新消息
Hermes 作者入口
```

## 7.2 回复指定消息

推荐使用 Discord Message Context Menu：

```text
管理员右键 / 长按某条消息
→ 应用
→ 小G宝回复
→ 弹出 Modal
→ 管理员填写正文
→ 小G宝回复目标消息
```

最终频道效果：

```text
小G宝
↳ 回复成员原消息

管理员填写的内容
```

交互确认仅管理员本人可见：

```text
小G宝已回复
```

## 7.3 直接发送消息

推荐 Slash Command：

```text
/小g宝发言
```

流程：

```text
选择目标频道
→ 弹出 Modal
→ 输入正文
→ 预览
→ 确认
→ 小G宝发送
```

初版可以只支持文字。

后续再考虑：

```text
附件
Embed
投票
定时发送
```

这些不属于首版。

## 7.4 权限模型

不维护管理员用户 ID 白名单。

授权依据：

```text
Discord Administrator 权限
```

双重校验：

```text
命令注册：
default_member_permissions = Administrator

运行时：
memberPermissions.has(Administrator)
```

还必须检查：

```text
只能在目标 Guild 使用
不能在私信使用
目标频道属于目标 Guild
Bot 在目标频道有发送权限
```

管理员流动时只需调整 Discord 管理权限，无需修改 `.env`。

## 7.5 安全规则

默认禁止：

```text
@everyone
@here
批量角色 Mention
跨 Guild 发送
向无权限频道发送
```

需要明确设置 Allowed Mentions。

内容长度必须遵守 Discord 限制。

失败时：

```text
只向操作者返回 ephemeral 错误
社区内不公开报错
```

## 7.6 审计

每次套皮操作必须记录：

```text
operatorId
operatorName
source
operationType
targetGuildId
targetChannelId
targetMessageId
sentMessageId
contentSummary
createdAt
```

来源：

```text
discord_admin
hermes
```

审计位置：

```text
VPS journal
+
仅管理可见审计频道或本地审计存储
```

正文是否保存全文，应在只读设计阶段确认隐私需求。

至少保存安全摘要与可追踪 ID。

## 7.7 Hermes 作者入口

Hermes 与 Discord 管理命令必须复用同一底层服务。

建议共享：

```text
manualMessageService.reply()
manualMessageService.send()
```

Hermes 流程：

```text
梦宝给出目标消息或频道
→ Hermes 获取必要 ID
→ 展示最终预览
→ 梦宝确认
→ 小G宝发送
→ 写审计记录
```

Hermes 不得绕过：

```text
Guild 校验
频道校验
Allowed Mentions
审计
```

人工补发旧 Boost：

```text
不伪造 BoostEvent
不修改 Phase 8 状态
不进入自动感谢 Handler
```

## 7.8 Stage B 验收

至少覆盖：

```text
Administrator 可使用
普通成员不可使用
目标 Guild 可用
其他 Guild 拒绝
消息右键回复
直接发送
Modal 内容校验
Allowed Mentions
目标消息不存在
目标频道不可发送
审计记录
Hermes 与 Discord 入口行为一致
社区错误静默
```

---

# 8. Stage C：Thread Revival Mechanism POC

模块名称建议：

```text
Thread Revival POC
自动顶帖机制实验
```

这一阶段只验证 Discord 实际机制。

禁止直接开发完整定时系统。

## 8.1 核心问题

需要验证：

```text
怎样让 Forum 旧帖重新出现在活跃位置
同时不留下机器人“顶帖”垃圾消息
```

当前任何“解除归档就一定会顶上去”的说法都只能视为假设。

必须在 Dev Bot 与测试服务器中实测。

## 8.2 实验顺序

优先测试：

```text
A. 仅 setArchived(false)
B. 线程状态变化是否影响排序
C. Discord 允许的其他无消息元数据变化
D. 发送临时消息后删除
```

方案 D 仅作为最后备选。

需要观察：

```text
Forum 排序是否变化
成员是否看到新活动
是否产生未读
是否留下审计痕迹
是否触发通知
是否重新归档
```

## 8.3 POC 结论要求

必须给出：

```text
哪种方法真实有效
是否无痕
是否有副作用
所需权限
是否适合茶话会
```

如果所有无痕方式都无效：

```text
停止
提交产品决策
等待用户决定是否接受有消息顶帖
```

不得未经确认自动采用“发消息后删除”。

---

# 9. Stage D：自动顶帖与管理员配置面板

只有 Stage C 验证出可接受机制后才可进入。

模块名称建议：

```text
Thread Revival Scheduler
Thread Revival Admin Panel
```

## 9.1 单一命令入口

只提供一个主要入口：

```text
/顶帖
```

执行后打开仅管理员可见的配置面板。

不建立命令森林。

## 9.2 配置面板

面板展示当前配置：

```text
自动顶帖：开启 / 关闭
目标频道：多选
沉默阈值：天数
每日上限：数量
执行时间
帖子冷却时间
排除标签
锁定帖策略
```

推荐组件：

```text
按钮
Channel Select
String Select
Modal
数字输入
确认 / 取消
```

管理员可一次进入面板完成多项修改。

## 9.3 首版配置

建议 schema：

```json
{
  "enabled": false,
  "channelIds": [],
  "inactiveDays": 30,
  "dailyLimit": 3,
  "runTime": "09:00",
  "timezone": "Asia/Shanghai",
  "threadCooldownDays": 30,
  "excludeLocked": true,
  "excludedTagIds": [],
  "updatedBy": "...",
  "updatedAt": 1700000000000
}
```

首版使用全局规则。

暂不支持每个频道单独配置不同阈值。

## 9.4 权限

仅允许：

```text
Discord Administrator
```

双重校验：

```text
命令默认权限
+
运行时权限
```

不使用个人管理员白名单。

## 9.5 候选选择

每日执行：

```text
读取启用的 Forum 频道
→ 获取帖子
→ 计算最后活动时间
→ 排除未达到 inactiveDays
→ 排除锁定帖
→ 排除指定标签
→ 排除仍在 threadCooldownDays 内的帖子
→ 按最久未活动优先排序
→ 取 dailyLimit
→ 执行已验证顶帖机制
→ 写入结果
```

## 9.6 持久化

必须记录：

```text
当前配置
每日已处理数量
每个帖子最近处理时间
成功 / 失败
失败原因
配置修改者
配置修改时间
```

建议路径：

```text
data/runtime/thread-revival/
```

要求：

```text
atomic write
串行写入
损坏时 fail closed
不得静默清空
```

## 9.7 安全规则

默认：

```text
不处理锁定帖
不自动解锁
不跨 Guild
不处理未配置频道
不超过每日上限
不连续处理同一帖子
不在管理员配置失败时公开报错
```

管理员配置操作必须审计。

## 9.8 Dry Run

正式自动执行前必须支持：

```text
Dry Run
```

只列出候选：

```text
将处理哪些帖子
为什么入选
最后活动时间
所在频道
```

不真正修改帖子。

管理员确认结果合理后才能开启生产执行。

## 9.9 Stage D 验收

至少覆盖：

```text
开关
多频道配置
沉默天数
每日上限
执行时间
冷却期
锁定帖排除
标签排除
Dry Run
持久化
重启恢复
管理员权限
审计
跨 Guild 拒绝
每日上限不会超出
同一帖子不会频繁重复处理
```

---

# 10. 建议目录演进

以下为目标结构参考，不要求一次性建立全部空目录：

```text
src/
├── core/
│   ├── bot.js
│   ├── gatewayHealthMonitor.js
│   ├── gatewayLifecycleLogger.js
│   └── startupPreflight.js
│
├── discord/
│   ├── client.js
│   ├── messageSender.js
│   ├── reactionSender.js
│   └── manualMessageService.js
│
├── alerts/
│   ├── productionAlertNotifier.js
│   └── alertOutbox.js
│
├── commands/
│   ├── registry.js
│   ├── interactionRouter.js
│   └── adminAuthorization.js
│
├── features/
│   ├── boostThanks/
│   ├── adminVoice/
│   └── threadRevival/
│
├── storage/
├── resources/
├── ai/
├── config/
└── utils/
```

边界：

```text
commands
→ 解析 Discord Interaction

features/adminVoice
→ 管理员发言业务编排

discord/manualMessageService
→ 真正发送 / 回复

features/threadRevival
→ 顶帖规则

storage
→ 状态与配置持久化

alerts
→ 生产告警
```

---

# 11. 共享模块规划

## 11.1 Admin Authorization

统一检查：

```text
目标 Guild
Administrator
Bot 权限
频道归属
```

供以下模块复用：

```text
管理员套皮
自动顶帖配置
未来管理命令
```

## 11.2 Audit Logger

统一记录：

```text
管理员操作
Hermes 操作
配置修改
自动顶帖执行
```

## 11.3 Interaction Router

集中路由：

```text
Slash Command
Message Context Menu
Button
Select Menu
Modal Submit
```

禁止每个 Feature 随意注册一套重复监听器。

## 11.4 Runtime JSON Store

若多个新模块使用 JSON 持久化，应复用：

```text
atomic write
串行写入
schema 校验
损坏 fail closed
```

不得复制多套略有不同的危险写盘代码。

是否提取公共 JSON Store，必须先审查 Phase 8 Store 与 Alert Outbox 的真实代码，不得盲目重构。

---

# 12. 测试策略

## 12.1 自动测试

每个模块必须使用：

```text
fake client
fake interaction
fake timer
fake notifier
fake exitFn
临时目录
可控权限对象
```

禁止自动测试：

```text
真实 process.exit
真实 Discord 发送
真实 Telegram
真实 Hermes
正式 data/runtime
```

## 12.2 Dev Bot 实测

适合验证：

```text
Gateway 断线 / 重连日志
管理员命令
Modal
Context Menu
频道权限
Forum 排序与顶帖机制
```

## 12.3 生产验证

生产中不得为了验证反复消耗真实 Boost。

优先使用：

```text
test:send
Dev Bot
历史消息只读检查
Dry Run
管理员人工发送
```

自然 Boost 到来时观察完整链路。

---

# 13. 部署检查表

每次正式部署后确认：

```text
Git HEAD 与 GitHub 一致
npm ci 状态
全量测试 0 failed
.env 未被覆盖
生产 TEST_MODE=false
正式 Guild ID 正确
感谢频道 ID 正确
System Messages Channel 可读
感谢频道可发送
Reaction 权限存在
Application Emoji 可访问
Gateway Ready
Startup Preflight 通过
systemd active/running
Restart=on-failure
RestartSec 合理
永久配置错误不会重启风暴
日志查看命令明确
```

正式服务查看：

```bash
journalctl --user -u teaparty-bell -n 200 --no-pager
journalctl --user -u teaparty-bell -f
```

---

# 14. 非目标范围

当前规划不包含：

```text
普通成员 AI 聊天
开放式 ChatGPT 问答
管理员白名单维护系统
复杂 Web 后台
Prometheus
Grafana
Redis
云数据库
复杂队列
自动修改 Discord 权限
自动解锁锁定帖子
未经确认的机器人顶帖消息
```

未来需要新增时，应另立计划。

---

# 15. 推荐版本节奏

```text
v1.0.x
生产健康监控与部署加固

v1.1
管理员套皮回复与直接发言

v1.2-alpha
自动顶帖机制实验

v1.2
自动顶帖调度与配置面板
```

版本号以项目当前实际版本规范为准，不得机械照搬。

---

# 16. 当前下一步

当前立即执行：

```text
1. 创建小G宝 Dev
2. 执行 Stage A 只读设计审查
3. 完成 Gateway Health Monitor
4. 完成 Startup Preflight
5. 完成 Alert Notifier / Outbox
6. 在 VPS 接入 Hermes Telegram 转发
7. 生产部署验收
```

Stage A 封箱后：

```text
开始 Stage B 管理员套皮发言
```

Stage B 封箱后：

```text
开始 Stage C 自动顶帖机制实验
```

不得跳过机制实验直接施工完整自动顶帖系统。

---

# 17. 给开发 Agent 的固定开场

```text
继续开发 TeaParty-Bell。

请先阅读并严格遵守：

AGENTS.md
BOT_CONSTRUCTION_PLAN2.md

旧 BOT_CONSTRUCTION_PLAN.md 只作为历史参考。
未来功能范围、阶段顺序和架构边界以 BOT_CONSTRUCTION_PLAN2.md 为准。

执行当前 Stage 前：

1. 先做只读审查。
2. 区分已确认事实、未知信息和待用户确认事项。
3. 不猜测接口。
4. 不创建未经确认的新配置体系。
5. 不进入后续 Stage。
6. 完成后 Push GitHub，等待真实代码审阅。
```

---

# 18. 最终原则

TeaParty-Bell 后续建设应始终围绕：

```text
生产稳定
社区静默
管理员可控
操作可审计
故障可追踪
配置可恢复
功能彼此隔离
先验证机制再扩大功能
```

小G宝可以偶尔因外部故障安静下来，但不得：

```text
跨服串台
重复感谢
公开播报机房错误
无审计地替管理员发言
未经验证到处顶帖
```

她的目标是：

```text
平时像社区里一只安静的小猫
需要时准确出声
出问题时私下敲管理员的门
```
