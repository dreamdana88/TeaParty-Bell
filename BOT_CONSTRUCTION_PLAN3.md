# BOT_CONSTRUCTION_PLAN3.md

> TeaParty-Bell「小G宝」CoC 7e 跑团模块施工总计划  
> 适用范围：在现有 Discord Bot 上新增社区自用的 Call of Cthulhu 7 版跑团模块  
> 建立日期：2026-09-27  
> 文档版本：v0.1

---

## 0. 文档地位

本文件是 CoC 7e 跑团模块的产品范围、阶段顺序和施工边界。

并行存在的计划：

```text
BOT_CONSTRUCTION_PLAN.md
历史记录。TeaParty-Bell 从 Phase 1 到自动感谢主线完成。

BOT_CONSTRUCTION_PLAN2.md
继续管辖已上线能力：
自动感谢、Gateway 健康监控、启动权限自检、
Hermes / Telegram 私下告警、管理员套皮发言、论坛顶帖。

BOT_CONSTRUCTION_PLAN3.md
本文件。只管辖 CoC 7e 跑团模块。
```

执行任何 CoC 阶段前，必须同时阅读：

```text
AGENTS.md
CLAUDE.md
BOT_CONSTRUCTION_PLAN2.md
BOT_CONSTRUCTION_PLAN3.md
```

若发生冲突：

```text
用户当前明确指令
→ AGENTS.md / CLAUDE.md
→ 本文件中的 CoC 范围
→ BOT_CONSTRUCTION_PLAN2.md 中的已上线功能边界
```

`AGENTS.md` 当前指向 `CLAUDE.md`。阅读时以 `CLAUDE.md` 正文为准。

本文件建立之日起，CoC 模块的功能范围与阶段顺序以本文件为准。已上线功能的行为以 `BOT_CONSTRUCTION_PLAN2.md` 和现有代码为准。

Phase 0 审计报告确认前，禁止按本文件大规模修改仓库。

## 官方文档与规则来源

涉及 Discord 接口时，优先查询官方文档和现有项目实现：

- Discord Gateway / Intents  
  <https://docs.discord.com/developers/events/gateway>

- Discord Message Resource  
  <https://docs.discord.com/developers/resources/message>

- Discord Interactions  
  <https://docs.discord.com/developers/interactions/overview>

- Discord Permissions  
  <https://docs.discord.com/developers/topics/permissions>

- discord.js 官方文档  
  <https://discord.js.org/docs>

CoC 7 车卡规则与数据模型，首版以只读审计这份工作簿为准：

```text
TL COC CARD.xlsx
```

该文件位于工作区根目录 `d:\git项目\TeaParty-Bell\TL COC CARD.xlsx`，不在 Bot 源码目录内。

禁止优先使用博客、Stack Overflow、过时教程或未经验证的第三方示例替代官方文档。

禁止把网上骰娘命令表、HKTRPG 文档或未审计的规则摘要当成小G宝的实现规格。Excel 审计完成前，角色卡字段与公式都还是待确认事项。

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

社区规模已经超过 1 万人。因此 Message Content 属于需要 Discord 审核的 Privileged Intent。这一点决定团录功能必须单独做 Feature Gate，不能卡住整个 CoC 模块。

项目已经完成并仍在生产运行的业务线：

```text
Discord Boost 自动感谢
管理员套皮发言 / 直接发言
论坛顶帖
Gateway 健康监控、启动权限自检、私下告警
```

本文件要新增的是第四条业务线：

```text
面向茶话会社区自用的 CoC 7 版跑团模块
```

目标不是复制 HKTRPG 这种大而全的多规则骰娘。针对社区实际使用方式，做一套：

```text
易上手
界面友好
CoC 7 专用
临时房间自动管理
角色卡长期保存
团录自动导出
不永久保存聊天正文
```

的轻量跑团系统。

现有 Boost 感谢、论坛顶帖、人工发言必须保持完全独立。CoC 模块上线后，这些功能的行为不得变化，也不得出现回归。

后续使用者应感到：

```text
跑团是主角
小G宝只负责安静地把繁琐东西收拾干净
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

这条与 `CLAUDE.md` 的核心铁律相同。CoC 施工期间继续有效。

具体落到本模块：

```text
Discord 字段、权限、Intent、频道 API
→ 查官方文档和现有代码

角色卡公式、职业技能点、奖励骰
→ 以 Excel 只读审计和用户确认为准

不确定的产品行为
→ 写进审计报告，停下来问

已有 Logger、配置、告警、原子写盘、权限判断
→ 先搜索再决定是否复用

删除频道、发私信、改权限
→ 先有 dry-run / fake / mock 测试，再碰 Dev Guild
```

## 2.2 强制开发节奏

每个独立 Phase 必须遵循：

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

Phase 0 只有只读审查和审计报告，没有实现。

禁止：

```text
一次性实现多个大 Phase
跳过只读审查
只看完成报告、不看真实代码
让 VPS 成为常规开发环境
未测试即直接部署生产
在正式服务器上试错删频道
Phase 0 报告确认前开始大规模改仓库
上一 Phase 未封箱就进入下一 Phase
```

Phase 2 的身份链路验收通过前，不开始完整车卡 UI。

Phase 5 先不依赖 Message Content。

Phase 8 全部通过前，不进入正式服务器。

## 2.3 架构边界

总体依赖方向保持：

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

CoC 是新的 Feature，不是现有模块的补丁。

```text
src/features/coc/
```

禁止把 CoC 逻辑塞进：

```text
src/features/boostThanks/
src/features/forumBump/
src/features/forumPoc/
src/features/manualMessage/
```

现有 `manualMessage` 路由承载的是管理员权限模型。禁止复用它来承载普通玩家的 CoC 指令。

CoC 必须拥有自己的 Interaction Router 和权限判断。

骰子核心必须独立成模块。禁止把骰子判定散落在 Discord Router 里。

公共模块可以继续提供这些已有能力，但不得为了 CoC 去反向引用 CoC 内部类型：

```text
Logger
配置读取
告警 Outbox
原子写盘与 fail closed
Guild 白名单
Gateway 健康与启动自检
```

是否复用某一段现有存储或命令注册代码，由 Phase 0 对照真实实现决定。禁止为了“看起来像复用”把管理员发言服务改成跑团服务。

## 2.4 社区静默原则

运行维护故障不得公开发送到社区频道。

禁止在以下位置发布系统错误：

```text
感谢频道
普通聊天频道
系统消息频道
Forum 帖子
公告频道
跑团临时频道里的堆栈、配置错误、数据库错误
```

面向玩家的失败，只向操作者返回 ephemeral 说明，或写在该次交互的私有响应里。

运行维护信息只允许进入：

```text
VPS journal
本地持久化告警 outbox
Hermes
Telegram 私聊通知
```

团录本身是玩家要的产物，可以发在当次跑团频道或 KP 私聊。发送失败、权限缺失、数据库损坏不属于团录正文，不得当成普通聊天发出去。

## 2.5 最小设计

首版优先简单、可靠、可维护。

首版不引入：

```text
Kubernetes
Redis
微服务
重型 ORM
大型前端框架
PostgreSQL
MySQL
多服务器 SaaS
大型 Web 管理后台
```

如果简单 HTML / CSS / JS 或轻量前端已经满足车卡体验，就保持这个选择。

Web 前端与 Discord Bot 可以同一 Node 项目运行，也可以拆成独立进程。这个决定留到 Phase 0，不在本文件里提前定死。

允许为已知扩展方向保留字段，例如 `ruleset = coc7`、`schema_version`。禁止因为“以后可能支持 D&D”提前做插件化规则引擎。

---

# 3. 当前生产基线

## 3.1 已完成主线

`BOT_CONSTRUCTION_PLAN2.md` 记录的完成状态：

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

其后又落地了管理员发言、论坛顶帖、Gateway 健康监控和启动自检。后续仍以 GitHub 最新提交和最新全量测试报告为准。

当前源码中的独立 Feature 至少包括：

```text
src/features/boostThanks/
src/features/forumBump/
src/features/forumPoc/
src/features/manualMessage/
```

CoC 新增目录不得替换这些目录。

## 3.2 必须保持独立的现有功能

以下行为在整个 CoC 施工期间视为冻结基线：

```text
Boost 感谢的识别、聚合、生成、发送、Reaction、防重复
论坛顶帖的配置、调度、状态文件和失败告警
管理员套皮回复与直接发言的权限、审计和发送
Gateway 健康退出与 Startup Preflight
Guild 白名单
TEST_MODE 的生产语义
告警 Outbox 与社区静默
```

CoC 的配置项、定时器、数据库和命令注册必须与上述状态文件分开。

禁止 CoC 启动失败时拖垮感谢、顶帖或套皮发言。若两者必须共享进程，CoC 初始化失败应降级为该模块不可用，并走现有私下告警。具体降级点由 Phase 0 对照 `src/core/bot.js` 的真实启动顺序写出。

## 3.3 关键生产配置

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

不得把任何 Token、API Key、Web Session Secret 或完整 `.env` 写入本文件、审计报告、日志、Issue 或聊天记录。

CoC 将来需要的新配置，例如跑团分类频道、Web 基址、团录开关，必须进入统一配置模块。禁止在业务代码里散落 Guild ID、Channel ID 和密钥。

## 3.4 已确认的部署教训

以下内容继续有效，CoC 部署检查表在此基础上追加：

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

正式服务器只接受已经在 Dev Guild 冒烟通过的版本。

禁止在正式服务器上试验：

```text
创建临时频道
删除频道
修改频道权限
发送团录
角色卡数据库迁移
```

## 4.2 Dev Bot

沿用 `BOT_CONSTRUCTION_PLAN2.md` 的隔离要求。

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
跑团分类频道
Web 回调或本地 Web 地址
SQLite 文件
运行状态文件
```

禁止：

```text
Dev Bot 加入茶话会
本地使用正式 Bot Token 启动完整 Bot
生产与开发共用 CoC SQLite
生产与开发共用 Phase 8 或论坛顶帖状态文件
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
反向代理与 HTTPS
权限与目录修复
部署检查
SQLite 备份目录的权限
```

若 VPS 临时产生代码 commit，必须通过 patch 或其他可审计方式同步回 GitHub。

---

# 5. 首版产品边界

## 5.1 规则范围

首版只支持：

```text
Call of Cthulhu 7th Edition
CoC 7 版
ruleset = coc7
```

首版不做：

```text
CoC 6 版
D&D
Pathfinder
其他 TRPG 系统
HKTRPG 全部命令兼容
多服务器 SaaS 化
大型 Web 管理后台
AI 自动 KP
AI 剧情生成
```

DeepSeek 不参与车卡、检定、团录和房间管理。

## 5.2 五块核心功能

```text
1. CoC 7 角色卡
2. 骰子与 CoC 7 检定
3. 临时跑团房间
4. KP / PL / OB 会话身份
5. 团录导出与自动清理
```

## 5.3 玩家需要记住的入口

玩家最终只需要知道：

```text
/coc 开团
/coc 角色卡
/r 1d100
```

以及控制面板上的几个按钮。

备用命令保留：

```text
/coc 结束
/coc 检定
```

新人不需要知道：

```text
ccb
ccn2
复杂骰娘指令
数据库
Discord Role
Excel 公式
```

命令的最终注册名、是否用中文子命令、`/r` 与 `/coc` 的拆分方式，Phase 0 对照现有 Guild Command 注册代码后再定。本文件里的写法是产品入口，不是已经审核过的 API 名称。

---

# 6. 角色卡

## 6.1 角色卡属于玩家长期资产

角色卡不记录：

```text
死亡
生还
退役
曾在哪个模组死亡
```

某张角色卡这一局死亡，不影响下一个模组继续使用。

每次新团开始时，每名 PL 从自己的角色库里重新指定：

```text
本局使用哪张角色卡
```

角色卡和某一个 Session 没有永久绑定。Session 只保存“这一局里选了哪张卡”的引用。

## 6.2 所有权

角色卡所有权只绑定：

```text
Discord User ID
```

同时记录 `guild_id`，因为首版只服务茶话会这一台社区，数据仍要能按服务器分开。

禁止用以下可变信息判断归属：

```text
昵称
服务器显示名
用户名
全局显示名
```

用户不能在网页里手填 Discord ID。

禁止使用可篡改的 URL 参数充当身份，例如：

```text
?userId=123456789
```

## 6.3 角色卡能力

必须支持：

```text
新建
查看
编辑
复制
删除
导入
导出
```

复制产生一张新卡，所有者仍是当前 Discord 用户。复制不继承任何 Session 引用。

删除一张仍被进行中 Session 引用的卡时如何表现，Phase 0 写出方案，Phase 8 必须实测。禁止静默把正在跑的团上的角色名改丢。

## 6.4 Web 车卡

Discord 内不承担复杂车卡交互。

Discord 只提供入口：

```text
/coc 角色卡
```

或按钮：

```text
[新建角色卡]
[我的角色卡]
```

点击后打开独立 Web 车卡页面。

目标体验参考用户当前使用的 QQ 小程序，信息分区为：

```text
角色简介
基础属性
职业 & 技能
背景故事
武器 & 物品
```

移动端优先，PC 同时可正常使用。

页面应具备：

```text
分步骤车卡
上一步 / 下一步
实时显示剩余职业技能点
实时显示剩余兴趣技能点
属性自动计算
职业技能自动加载
技能基础值自动加载
HP / SAN / MP / MOV / DB / Build 等派生值实时计算
表单校验
编辑已有角色卡
保存后立即进入小G宝数据库
```

首版不要求完全复刻 QQ 小程序视觉。最终易用程度应接近该小程序。

前端风格可以独立设计，优先：

```text
手机端
清晰
简洁
有 CoC / 神秘学气质
```

禁止把 Excel UI 原样搬到网页。

Phase 2 只做能证明链路的最小页面。完整视觉从 Phase 3 开始。

## 6.5 Discord 与 Web 的身份绑定

Phase 0.5 替换了一次性车卡网址。所有人打开同一个固定站点：

```text
https://固定域名/coc
```

Discord 按钮和收藏夹都进这里。URL 里没有 User ID，也没有每次更换的 token。

```text
固定页面
↓
Discord OAuth（identify）
↓
真实 User ID
↓
Bot 核对茶话会成员，以及 COC_ACCESS_ROLE_ID 茶会贵宾
↓
web_sessions
↓
HttpOnly + Secure + SameSite=Lax 的随机 Cookie
```

Session 约 90 天。贵宾资格约 30 天复查一次，仍符合就无感继续。写角色卡时再核对 Session 用户就是 `owner_user_id`。

禁止用户手填 Discord ID 或用户名来登录。禁止把 Bot Token 放进 URL。OAuth 的 `state` 只活几分钟，用来防止回调伪造，不拿来当车卡链接。

Phase 2 开工前复核：按已知 User ID 取单个成员是否需要 Guild Members Intent。若不需要，就不要开。若需要，改用用户侧的成员读取范围，仍然不开这个 Gateway Intent。

细节以 `docs/coc-phase0-audit.md` 第 6 节为准。

## 6.6 导入与导出

小G宝内部必须拥有自己的标准格式。

首选完整、无损、可重新导入的文件：

```text
*.coc7.json
```

形状示例：

```json
{
  "schemaVersion": 1,
  "ruleset": "coc7",
  "name": "奈洛莉",
  "characteristics": {},
  "skills": {},
  "background": {},
  "weapons": [],
  "items": []
}
```

这是方向，不是已经冻结的 Schema。字段以 Phase 0 的 Character Schema 草案为准，Phase 3 实现时如果审计修订了字段，升高 `schemaVersion`。

后续支持的顺序：

```text
JSON 导入
JSON 导出
Excel 导入
Excel 导出
```

JSON 属于 Phase 3。Excel 导入导出在 JSON 可用之后再评估。

Excel 导入首先针对 `TL COC CARD.xlsx` 这一种模板研究兼容性。首版不承诺兼容任意来源的 Excel。

内部角色格式由小G宝自己定义。禁止把 Excel 文件本身当数据库。

---

# 7. 数据存储

## 7.1 引擎与位置

使用现有 VPS。

首版数据库：

```text
SQLite
```

首版不使用 PostgreSQL 或 MySQL。

推荐存放：

```text
data/
└── coc/
    ├── coc.sqlite
    └── backups/
```

现有运行时数据已经使用 `data/runtime/`，例如告警和论坛顶帖状态。Phase 0 必须对照真实数据目录规范，决定 CoC 是放在 `data/coc/` 还是 `data/runtime/coc/`。决定之前，业务代码不得各自写死一条路径。

要求继承项目已有存储纪律：

```text
atomic write
串行写入
schema 校验
损坏时 fail closed
不得静默清空
Bot 重启后数据仍在
```

SQLite 文件、备份和迁移版本必须能在重启后恢复：

```text
角色卡不丢
正在运行的团不丢
频道到期状态不丢
```

## 7.2 长期保存什么

数据库只长期保存：

```text
角色卡
跑团 Session 元数据
成员与身份变更记录
```

禁止长期保存完整跑团聊天正文。

运行期间，Discord 频道本身就是唯一聊天原始数据源。结束时再读取历史消息，生成团录文件，发出后删除 VPS 上的临时文件。

数据库不得保留完整消息正文。

## 7.3 建议数据模型

最终 Schema 必须在 Excel 审计后确定。以下只是方向。

### Character

```text
id
guild_id
owner_user_id
ruleset
schema_version
name
character_data
created_at
updated_at
```

其中：

```text
ruleset = coc7
```

`character_data` 可以采用结构化 JSON。JSON 形状由小G宝的 `*.coc7.json` 定义，不照搬 Excel 单元格坐标。

### Session

```text
id
guild_id
channel_id
title
status
kp_user_id

created_at
last_activity_at
expires_at
delete_at

control_message_id
transcript_start_message_id
```

状态例如：

```text
active
ending
ended
expired
```

### SessionMember

至少包含：

```text
session_id
user_id
role
character_id
joined_at
```

role：

```text
KP
PL
OB
```

PL 的 `character_id` 指向本局选用的角色卡。下一局重新选择，不回写角色卡本体。

### CocDisplayState

昵称和颜色是整个服务器共用的一份显示，不按每一桌各存一份“原昵称”。

同一个人同时参加多桌时，若把 `original_nickname` 写在每一条 SessionMember 上，第二桌会把第一桌已经改成的角色名当成原昵称，结束时就会恢复错。

因此原昵称单独记在用户级显示状态上。每个 `guild_id + user_id` 最多一行：

```text
guild_id
user_id
original_nickname
applied_nickname
nickname_changed_by_coc
display_role
display_session_id
updated_at
```

`original_nickname` 只在 `nickname_changed_by_coc` 从 false 变成 true 时写入，内容是改名之前的服务器昵称，包括“本来没有昵称”。已经由小G宝改过名时，后一桌不得覆盖这份原值。

`applied_nickname` 是小G宝最近一次成功写到 Discord 上的角色名。

SessionMember 继续只记录这一桌的真实身份和角色卡。显示状态不是身份来源。

### SessionRoleEvent

如果允许中途身份切换，需要身份变更记录，用于判断：

```text
某人作为 OB 时的发言不进入团录
后来变成 PL 之后的发言才开始计入
```

Phase 0 必须明确首版是否允许中途切换。若允许，Schema 里就包含 `SessionRoleEvent`。若首版不允许切换、只允许离团后重新加入，也要在报告里写明，并保证团录过滤仍有时间依据。

禁止只在 Discord 权限覆盖上查当前身份，然后用“现在的身份”去过滤“当时的发言”。

## 7.4 迁移

Phase 1 必须带 migration / version 管理。

禁止靠“删库重建”升级已有角色卡。

`schema_version` 记在角色卡上，数据库 schema 版本另外管理。两者不是同一个数字。

---

# 8. Excel 只读审计

施工前对 `TL COC CARD.xlsx` 做只读审计。

目前已知含多个工作表，例如：

```text
人物卡
简化卡 骰娘导入
职业列表
成长表（测试）
本职技能
附表
技能注释
属性注释
资产及物价参考
武器列表 战斗
防具表 载具表
疯狂表
更新说明
```

工作表名单以打开文件后的真实结果为准。上面这份是任务书中的已知线索，审计时允许增补或更名。

重点分析：

```text
基础属性
派生属性公式
年龄修正
职业
职业技能点计算
兴趣技能点
技能基础值
信用评级
自定义职业
自定义技能
武器
防具
资产
疯狂表
数据验证
下拉列表
隐藏数据区
「简化卡 骰娘导入」的用途
各 Sheet 之间公式依赖
```

每一条结论必须区分：

```text
A. CoC 7 规则本身
B. Excel 作者提供的便利功能
C. 仅为 Excel 展示存在的公式 / UI
```

只有 A，以及确实有价值并经用户确认的 B，才进入小G宝。

禁止机械照搬整个 Excel。

审计是只读的。禁止为了看公式去修改这本工作簿。

---

# 9. 骰子与 CoC 7 检定

骰子核心独立成模块，位于 CoC Feature 内部，供检定和普通掷骰调用。

首版支持通用骰：

```text
1d100
1d6
2d6
2d6+3
```

以及 CoC 7 检定。产品入口例如：

```text
/coc 检定
```

选择：

```text
技能
目标值
普通 / 奖励骰 / 惩罚骰
```

必须正确判定：

```text
普通成功
困难成功
极难成功
失败
大成功
大失败
```

奖励骰 / 惩罚骰按照 CoC 7 规则实现。

首版至少支持：

```text
奖励1
奖励2
惩罚1
惩罚2
```

奖励与惩罚同时出现时的规则、大成功与大失败的阈值、技能值与奖励骰的组合方式，全部以 Phase 0 对照 CoC 7 与 Excel 审计后的书面规则为准。禁止凭骰娘习惯猜测。

随机机制使用适合骰子的可靠随机实现。Phase 4 的测试必须能注入随机源，保证判定分支可重复。

这一模块必须有充分单元测试。禁止只在 Discord 里手掷几下就算完成。

正式输入是活跃跑团频道里的整句文本：`1d100`、`2d6+3`、`cc 70`、`cc 心理学`、`cc1`、`ccn1`。不全服务器监听。Message Content 未开放时，这些文本不注册，改走 `/roll` 和 `/coc 检定`。奖励骰和惩罚骰的算法先写成测试向量再编码。骰子个数、骰面和句子长度有上限。协议全文在审计报告第 9 节。

检定结果发送时登记为 `coc:transcript:dice`。控制面板和系统提示另类登记，不进团录。禁止靠文案猜哪条是骰子。

---

# 10. 跑团房间

## 10.1 开团

入口例如：

```text
/coc 开团
```

输入：

```text
模组名称
```

小G宝创建专属临时文字频道。

推荐创建在配置好的分类下：

```text
COC_CATEGORY_ID
```

创建后生成控制面板。例如：

```text
🎲 常暗之厢

KP：xxx
PL：2
OB：7

[加入 PL]
[加入 OB]
[选择角色]
[管理本局]
```

KP 默认由开团者担任，或由管理员明确指定。

禁止用户自由抢 KP。

Phase 5 实现本段时，先不读取普通消息正文，因此不依赖 Message Content Intent。

## 10.2 KP / PL / OB

首版不为每一桌创建服务器永久 Role。

优先采用：

```text
Session 内部身份
+
Discord Channel Permission Overwrite
```

数据库才是真实身份来源。Discord 权限只是表现层。

避免产生并长期残留：

```text
常暗之厢-KP
常暗之厢-PL
常暗之厢-OB
第二团-KP
第二团-PL
```

这类会把服务器 Role 列表塞爆的永久身份组。

PL 加入后选择本局角色卡。例如：

```text
梦宝
身份：PL
角色：奈洛莉
```

下一局重新选择。

OB 可以旁听。OB 的发言不进入团录，也不刷新房间活动时间。

身份的权限覆盖至少要保证：KP 能管理本局面板，普通成员不能执行结束、续期和踢人。细项在 Phase 0 列出，Phase 5 用 Dev Guild 验证。

## 10.2.1 临时角色名与身份组颜色

这是显示层增强。昵称和颜色让桌上更好认人，不得成为 Session 权限或角色卡绑定的数据来源。

改名失败、颜色被更高身份组盖住、配置关闭，报名、选卡、检定和团录仍照常进行。

用户已确认：跑团期间，茶话会的其他频道里同时看到角色名和身份颜色，是想要的效果。

Discord 的范围仍然是：

```text
可以改：这个服务器里的昵称
不可以改：Discord 全局用户名
名字和颜色都会出现在茶话会的其他频道
```

依据是 Modify Guild Member：`nick` 属于 Guild Member，权限是 `MANAGE_NICKNAMES`。加减身份组的权限是 `MANAGE_ROLES`。聊天里的名字颜色来自该成员层级最高、且设置了颜色的那个 Role。

用户已说明小G宝目前的身份组权限很高。层级仍可能改不了服务器群主，以及最高身份组高于或等于小G宝的成员。这种失败只降级显示，不中断跑团。

### 角色名

开关：

```text
COC_SESSION_NICKNAME=true
```

茶话会的预期默认值是打开。关闭时不改任何昵称，颜色身份组仍可发放。配置名最终以 Phase 0 对照现有配置模块为准，语义保持为“可单独关闭临时角色名”。

只在 PL 确认本局角色卡之后改名。KP、OB 不因报名而改名。

确认时先提示，再写入：

```text
本局期间，你的服务器昵称将临时变更为「奈洛莉」，结束后自动恢复。
```

她确认后：

```text
PL 选卡完成
↓
若还没有由小G宝接管昵称，记下当前服务器昵称
↓
尝试改成角色卡名
↓
授予本局对应的展示身份组
↓
跑团
↓
结束 / 退出 / 超时 / 身份变化 / Bot 重启
↓
recomputeCocDisplayState(userId)
↓
还有别的活跃团：改成那个团该显示的昵称和唯一颜色
一个活跃团都没有：仅当当前昵称仍是小G宝设置的角色名时恢复
original_nickname 为 NULL 时清除昵称，不把账号名写成新昵称
```

禁止某一桌结束时直接恢复原昵称并卸掉全部 CoC Role。

KP 报名成功时授予 `CoC · KP`。OB 报名成功时授予 `CoC · OB`。PL 报名成功时先授予 `CoC · PL`，选卡完成后再改昵称。

改名失败时，选卡结果仍然有效。只向她本人返回：

```text
无法修改你的服务器昵称，将继续使用当前昵称；本局角色仍绑定为「奈洛莉」。
```

常见原因：

```text
机器人身份组层级不够高
对方是服务器群主
角色名超过 Discord 昵称长度上限
缺少 MANAGE_NICKNAMES
COC_SESSION_NICKNAME 关闭
```

长度上限以 Phase 0 对照当时的官方文档为准。超长时不截断、不改名，提示她缩短角色卡名。

恢复保护：

```text
当前服务器昵称 == applied_nickname
→ 恢复 original_nickname

当前服务器昵称已经不是小G宝设置的角色名
→ 视为她中途自己改过
→ 不覆盖她的新昵称
→ 清除 nickname_changed_by_coc
```

中途不反复把昵称抢回来。她再次明确确认一张角色卡时，重新提示并重新设置。

同一个人同时是多桌 PL 时，服务器里仍然只有一个昵称。显示她的主活动团里那张 PL 角色卡；主活动团里她不是 PL 时，显示她最近一次确认、且该团仍在进行的 PL 角色卡。全部这类 PL 身份都结束后，才按上面的保护规则恢复原昵称。

### 颜色

全服永久预建三个共用身份组，不按桌新建：

```text
🔮 CoC · KP    建议色：紫金
🎲 CoC · PL    建议色：蓝 / 青
👁 CoC · OB    建议色：灰紫
```

色值施工前可以改。这三个名字用于和社区原有身份组区分。

它们平时可以没人持有。开团报名时临时发放，结束、退出、废弃和重启恢复时收回。

这三个组：

```text
不带任何服务器权限
不可被 @
不在成员列表里单独分组
频道里谁能看见、谁能说话，仍由 Session 数据 + Channel Permission Overwrite 决定
```

摆放位置：

```text
普通成员的彩色身份组
↓
CoC · OB / CoC · PL / CoC · KP
↓
真正的管理身份组
↓
小G宝自己的最高身份组
```

这样大多数玩家看得到跑团颜色，管理员保留原来的管理色。禁止为了让管理层也变成跑团色，去抬高这三个组、改动服务器权限秩序。

同一用户同时只能拥有一个 CoC 展示身份色。各团里的 KP / PL / OB 仍分别记在 SessionMember。

展示色的选择顺序：

```text
1. 她当前的主活动团
2. 没有可判定的主活动团时，按 KP > PL > OB
```

主活动团指：她最近一次做出 CoC 交互的、仍在进行的 Session。交互包括加入、选卡、换身份、骰子和面板按钮。Bot 不知道她此刻眼睛看着哪个频道，不用“当前打开的频道”猜测主活动团。

三个展示组同一时间只挂其中一个。换团、换身份后重算，并卸掉另外两个。没有任何进行中的团时，三个都卸掉。

身份组由管理员事先建好，ID 进入配置。Bot 只负责加减成员。禁止 Bot 在正式服务器运行时临时创建或删除这些组。

每桌仍禁止再创建 `常暗之厢-KP` 这类组。

## 10.3 频道生命周期

临时频道不能永久存在。

创建后的最大自然寿命：

```text
15 天
```

长团允许 KP 点击：

```text
[续期15天]
```

再次延长。续期次数首版不设上限，除非 Phase 0 提出并得到确认的保护上限。每次续期写审计日志。

无活动回收：

```text
KP + PL
连续 7 天没有有效发言
→ 判定该团废弃
```

OB 发言不刷新 `last_activity_at`。

避免 OB 靠聊天把废弃团频道永久续命。

“有效发言”的定义在 Message Content 未开通前可能无法从正文判断。Phase 5 先用 KP / PL 的消息事件或交互事件维持活动时间，并在审计报告里写明：Feature Gate 关闭时，活动判定看得到哪些事件、看不到哪些事件。禁止在 Intent 未开通时假装已经能区分闲聊和有效发言。

## 10.4 正常结束

推荐通过控制面板：

```text
[结束本局]
```

并保留备用命令：

```text
/coc 结束
```

点击结束后必须二次确认。例如：

```text
确定结束《常暗之厢》？

[确认结束]
[取消]
```

确认后的顺序：

```text
1. Session 进入结束状态
2. 禁止继续改变本局成员和角色
3. 清理本局状态，不写回长期角色卡
4. 对每个成员调用 recomputeCocDisplayState
5. 读取频道历史消息
6. 生成团录
7. 团录作为 Discord 附件发在当前频道
8. 所有人可自行下载
9. 团录已经交付时，频道进入 48 小时删除倒计时
10. 48 小时后自动删除频道
```

展示重算失败时写入待恢复队列，私下告警，Bot 重启后继续试。她中途自己改过的昵称留着。重算失败不阻挡后面的团录步骤。团录没交付，就不进入第 9 步。

Message Content 尚未开通时，第 5 到第 7 步改为明确告知「当前不能生成聊天团录」。昵称和身份组改为调用 `recomputeCocDisplayState`。正式服务器在团录关闭时不进入 48 小时删除。Dev Guild 仍可演练删除。禁止因为团录不可用就拒绝结束本局。是否另加「确认无团录删除频道」，Phase 6 再定界面。

## 10.5 异常结束与超时

触发条件：

```text
KP + PL 连续 7 天没有有效发言
```

或：

```text
频道租期耗尽
```

处理顺序：

```text
1. 清理本局状态，并对成员调用 recomputeCocDisplayState
2. 生成当前已有团录
3. 优先私聊发送给 KP
4. 成功交付后删除房间
```

第 1 步失败时同样进入待恢复队列，不因此跳过团录交付，也不因此提前删频道。

如果 KP 禁止私信或 DM 失败：

```text
将团录发送到原频道
↓
@KP
↓
额外保留一段安全时间
↓
再删除频道
```

禁止出现：

```text
团录发送失败
并且
频道已经删除
```

这种不可恢复情况。

团录功能关闭时，异常结束仍要在频道留下可见说明，并重算昵称和颜色。正式服务器不因为租期或弃团就删掉这个频道。Dev Guild 可以演练删除。禁止在没有团录、也没有明确说明的情况下删掉唯一聊天记录。

安全时间的具体长度 Phase 0 提议、用户确认后写入实现。本文件先固定原则：交付失败就延迟删除。

删除频道、分配权限、发送 DM、生成附件都属于高副作用操作。测试路径必须是：

```text
dry-run / fake / mock
```

定时删除在没有这些测试前禁止上线。

## 10.6 团录内容

小G宝不长期保存跑团正文。

导出包含：

```text
KP 发言
PL 发言
小G宝产生的 CoC 骰子结果
```

过滤：

```text
OB 发言
无关 Bot 消息
频道系统噪声
```

身份中途变化时，按 `SessionRoleEvent` 的时间判断该条消息当时算不算 KP / PL。

格式优先 Markdown。

文件名例如：

```text
常暗之厢_2026-09-26.md
```

内容形状例如：

```text
# 常暗之厢

KP：xxx
PL：梦宝 / 奈洛莉
开始时间：
结束时间：

---

[20:31] KP
你们推开了那扇门……

[20:32] 奈洛莉
“这里的气息让我很不舒服。”

🎲 心理学 70
1D100 → 24
困难成功
```

导出完成后删除 VPS 上临时生成的团录文件。

Phase 7 必须覆盖：

```text
大量消息
身份中途变化
Bot 重启
消息删除
消息编辑
附件
Emoji
Reply
长文本
中文
Markdown 特殊字符
```

历史消息要分页读取。禁止假设一个频道的全部消息能一次取回。

## 10.7 Message Content Feature Gate

团录需要读取普通玩家消息正文。

小G宝所在社区规模已经超过 1 万人，Message Content 需要 Discord 审核。

开发必须采用 Feature Gate，例如：

```text
COC_TRANSCRIPT_ENABLED=false
```

审核通过前，以下功能保持可用：

```text
角色卡
Web 车卡
骰子
开团
Session
KP / PL / OB
频道生命周期
```

团录功能明确显示：

```text
等待 Discord 权限
```

审核通过后再打开：

```text
COC_TRANSCRIPT_ENABLED=true
```

禁止因为 Message Content 尚未通过而阻塞全部 CoC 模块上线。

配置名是否最终叫 `COC_TRANSCRIPT_ENABLED`，Phase 0 对照现有配置模块决定。语义必须保持：团录开关默认关闭。关闭时角色卡、开团、Slash 骰子和结束仍工作。正式服不自动删频道。文本骰子等开关打开后再听。

---

# 11. Web 服务架构

优先与 TeaParty-Bell 部署在同一 VPS。

逻辑上：

```text
TeaParty-Bell
│
├── Discord Bot
├── CoC Web
├── CoC API
├── SQLite
└── Temporary Exporter
```

可通过现有反向代理提供 HTTPS。例如未来：

```text
https://xxx.example.com/coc/
```

真实域名、路径和证书沿用 VPS 上已经在用的反向代理。禁止在计划或代码里发明一套新的公网入口而不先看现有部署。

Phase 0 决定：

```text
Web 与 Bot 同一进程
或
Web 独立进程
```

决策标准只有：

```text
首版简单
故障隔离是否必要
现有 systemd 与反向代理能否少改
重启 Bot 时车卡页面是否可以短暂不可用
```

无论是否同进程，CoC Web 都不得Listening在未经验证的公网明文 HTTP 上交付授权 token。

---

# 12. 代码接入约束

建议内部结构，实际目录由 Phase 0 对照现有 Feature 写法确定：

```text
src/features/coc/
├── dice/
├── characters/
├── sessions/
├── transcript/
├── webAuth/
├── storage/
├── discord/
└── index.js
```

不要求一次性建出全部空目录。做到哪个 Phase，再落哪个目录。

接入时必须单独查清并写进审计报告：

```text
Discord Client intents 现在开了哪些
Interaction 现在在哪里注册
Guild Command 现在如何注册
配置系统如何增加一个开关
Feature 如何在 bot.js 里启动和停止
论坛顶帖的定时器与状态保存可以借鉴什么
现有测试如何挂进全量测试
VPS 的 systemd 与反向代理现在怎么部署
```

可复用的结论、不能复用的结论，都要写成清单。禁止审计报告只写“建议重构 router”。

CoC 定时器负责：

```text
15 天寿命
7 天无活动
48 小时删除倒计时
续期
```

它必须在 Bot 重启后从 SQLite 恢复，而不是只活在内存里。

借鉴论坛顶帖的地方限于：定时器如何被启动、状态如何原子保存、失败如何私下告警。禁止把跑团频道调度写进 `forumBump`。

---

# 13. 施工阶段

总顺序：

```text
Phase 0  只读审计
Phase 1  数据模型与 SQLite
Phase 2  最小 Web 身份链路
Phase 3  完整角色卡
Phase 4  骰子与 CoC 7 检定
Phase 5  开团与临时频道
Phase 6  结束流程
Phase 7  团录导出
Phase 8  Dev Guild 完整冒烟
```

角色卡、车卡网站、Discord OAuth 和角色库已经拆到 B 线，施工文件是 `docs/coc-b-line.md`。本文件第 2、3 阶段不再在 TeaParty-Bell 里做。A 线继续负责开团、房间、身份、昵称、骰子和团录。两条线互不阻塞，整合放到 B 线的 Phase B8。

## Phase 0：只读审计

这一阶段禁止施工。

审计对象：

```text
1. 当前 TeaParty-Bell main
2. Discord Client intents
3. Interaction Router
4. Guild Command 注册方式
5. 配置系统
6. Feature 生命周期
7. Forum Bump 定时器与状态保存方式
8. 当前测试体系
9. VPS 部署方式
10. TL COC CARD.xlsx
```

输出：

```text
《TeaParty-Bell CoC Phase 0 审计报告》
```

报告必须明确：

```text
1. 当前仓库架构地图
2. Excel 数据结构与公式地图
3. Character Schema 草案
4. SQLite Schema 草案
5. Web 身份认证方案
6. Discord Session 生命周期方案
7. Message Content Feature Gate 方案
8. 分阶段施工建议
9. 风险点
10. 不应修改的现有模块
```

以及这些判断：

```text
可以复用什么
需要新增什么
哪些不能复用
SQLite 选型与文件位置
Web Server 同进程还是独立进程
Excel 规则映射里哪些是 A / B / C
Message Content 的接入点
风险与迁移影响
```

Phase 0 与 Phase 0.5 的文档确认前，禁止大规模修改仓库。

## Phase 1：数据模型与 SQLite

完成：

```text
SQLite 基础设施
migration / version 管理
Character 表
Session 表
Session Member
Session Role Event
session_character_state
coc_display_state，original_nickname 允许 NULL
web_sessions
oauth_states
coc_bot_messages
不建 web_login_tokens
Repository / Store 层
每天 backup()，保留 14 份
启动 integrity_check
自动测试
启动恢复机制
```

目标：

```text
Bot 重启后
角色卡不丢
正在运行的团不丢
本局状态不写回角色卡
频道到期状态不丢
库损坏时只关闭 CoC
```

封箱前测试至少覆盖：空库启动、迁移、损坏文件 fail closed、不自动建空库冒充、在线备份、重启恢复、角色卡不写死亡和本局 HP。

## Phase 2：固定网站与 Discord OAuth

只做最小闭环：

```text
打开固定 /coc
↓
Discord OAuth
↓
核对茶话会成员和茶会贵宾 Role
↓
建立 Web Session
↓
修改一个测试角色字段
↓
保存 SQLite
↓
再次打开仍保持登录
↓
Discord 查询同一条数据
```

这一阶段不做完整车卡 UI。开工前复核单个成员查询要不要 Guild Members Intent。

验收：

```text
未登录拒绝
外服务器拒绝
无贵宾 Role 拒绝
贵宾可写自己的测试字段
用户 A 不能读改用户 B
篡改 Cookie 无效
长期 Session 可恢复
资格复查到期后会再查 Role
```

验收通过后再进入 Phase 3。

## Phase 3：完整角色卡系统

根据 Excel 审计结果实现：

```text
CoC 7 Character Schema
新建
编辑
删除
复制
查看
职业
技能
属性
派生值
背景
武器
物品
自定义技能
JSON 导入
JSON 导出
```

随后再评估：

```text
Excel 导入
Excel 导出
```

Web 前端此阶段开始按第 6.4 节美化。移动端优先，PC 可用。

派生值、职业技能点、兴趣技能点必须有纯函数测试。职业点是 13 个枚举函数，未知类型 fail closed。禁止字符串公式解释器和 `eval`。年龄缩写未展开前只提示，不改属性。

## Phase 4：骰子与 CoC 7 检定

先做独立 Dice Engine，再接：

```text
Text Adapter
Slash Adapter
Character Skill Adapter
```

实现：

```text
1d100、2d6+3，整句匹配，只在 active 跑团频道
cc 70、cc 技能名
cc1 / cc2 奖励骰
ccn1 / ccn2 惩罚骰
普通 / 困难 / 极难
大成功 / 大失败
个数、面数、长度上限
/roll 与 /coc 检定 作为 Message Content 关闭时的入口
```

奖惩骰算法先有测试向量。技能检定读快照还是长期卡，编码前确认，不在适配器里临时选。随机源可注入。禁止把判定写进消息路由。

## Phase 5：开团与临时频道

实现：

```text
/coc 开团
临时频道
控制面板
KP
PL
OB
PL 角色选择
选卡时建立 session_character_state 快照
KP 的调查员状态面板，可改 HP / SAN / MP / Luck
PL 只能看自己的只读面板
OB 没有这个面板
COC_SESSION_NICKNAME
选卡前的昵称变更提示
recomputeCocDisplayState
original_nickname 可为 NULL
多桌结束不会清掉另一桌的昵称和颜色
三个共用颜色身份组
主活动团优先，否则 KP > PL > OB
Session 状态
Channel Permission Overwrite
15 天寿命
7 天无活动回收
续期
Bot 重启后按消息作者和时间修正 last_activity_at
```

这一阶段的开团、身份和 Slash 不依赖 Message Content。文本骰子不在这一阶段开启。

禁止为每一桌创建 KP / PL / OB Role。允许使用的只有第 10.2.1 节那三个全服共用、无权限的颜色身份组。

封箱前用 fake Discord client 覆盖权限、重启恢复和“OB 不刷新活动时间”。真实建频道只在 Dev Guild 做。

## Phase 6：结束流程

实现：

```text
[结束本局]
二次确认
结束状态锁
recomputeCocDisplayState
清理本局状态，不写回角色卡
恢复失败进入待恢复队列
团录可用时：48 小时删除倒计时
团录关闭且是正式服：不自动删频道，并说明原因
Dev Guild：可演练自动删除
超时 / 废弃结束
KP DM 交付机制
DM 失败 fallback
```

这一阶段团录可以暂时使用测试数据验证流程。

必须证明：团录或测试附件没有成功交付时，频道不会被删。正式服在 `COC_TRANSCRIPT_ENABLED=false` 时，即使结束成功也不自动删。

## Phase 7：团录导出

等待或并行申请 Discord Message Content。

审核通过后实现真实频道历史读取。

完成：

```text
分页读取 Discord 历史
KP / PL 筛选
OB 过滤
身份变更时间判断
CoC 骰子结果只认 coc_bot_messages 里 kind=dice 的登记
不把控制面板和系统提示收进团录
Markdown 输出
Discord Attachment
临时文件清理
```

Feature Gate 仍保持可关闭。关闭时不读玩家正文，正式服不自动删频道。

重点测试见第 10.6 节。

## Phase 8：完整实机冒烟

在 Dev Guild 做完整模拟：

```text
创建团
↓
PL / OB 加入
↓
选择角色
↓
发言
↓
骰子
↓
角色编辑
↓
长时间 Session 状态
↓
结束
↓
生成团录
↓
48 小时删除
```

再测试：

```text
7 天无活动模拟
15 天到期模拟
DM 失败
Bot 重启
SQLite 恢复
权限缺失
频道已被管理员人工删除
角色卡被删除但 Session 正在引用
PL 昵称改成角色名后，在其他频道也同样显示
结束、崩溃、重启后，仅在昵称仍是角色名时恢复
她中途自己改过昵称时，结束不会覆盖新昵称
第二桌不会把第一桌的角色名记成原昵称
COC_SESSION_NICKNAME 关闭时不改名，选卡和颜色仍可用
三个颜色身份组挂上和卸下
同时两桌时只保留一个展示色，各团身份仍在数据库里
身份组比成员低时，选卡仍成功，只提示改名失败
Message Content 关闭
现有感谢 / 顶帖 / 套皮发言未被 CoC 改变
```

全部通过后再进入正式服务器。

长时间条件用可控时钟或注入的 `now`，禁止为了验收真的把 Dev Bot 晾 7 天或 15 天。生产启用前，仍要在 Dev Guild 看到一次真实的短时加速演练记录。

---

# 14. 必须避免的坑

施工过程中不得：

```text
1. 为角色卡保存死亡状态
2. 把角色卡和某个 Session 永久绑定
3. 把 Discord 昵称当用户身份。临时角色名只是显示层
4. 永久保存团录正文
5. 为每一桌创建永久 KP / PL / OB Role。全服共用的三个无权限颜色组除外
6. 让 OB 发言刷新频道生命周期
7. 依赖 Message Content 才能启动整个 CoC 模块
8. 团录发送失败时直接删除频道
9. 把 Excel 当数据库
10. 在 Discord 里实现完整复杂车卡表单
11. 把 CoC 加进现有管理员 Router
12. 破坏 Boost Thanks / Forum Bump / Manual Message
13. 一次性大重构 TeaParty-Bell
14. 为了首版引入不必要的重型基础设施
15. 在没有测试的情况下上线定时删除频道逻辑
```

另外不得：

```text
把 Bot Token 放进 Web URL
用可篡改的 userId 查询参数代替授权 token
在正式茶话会里试删频道
让 CoC 初始化失败拖垮已上线功能
把 CoC SQLite 与论坛顶帖、感谢状态混在同一个 JSON 文件里
```

---

# 15. 测试策略

每个 Phase 都必须新增对应测试。

重点测试层：

```text
纯函数
↓
Store / SQLite
↓
Service
↓
Interaction Router
↓
Discord mock
↓
Dev Guild 实机冒烟
```

沿用现有自动测试纪律：

```text
fake client
fake interaction
fake timer
fake notifier
可控时钟
临时目录
可控权限对象
```

禁止自动测试：

```text
真实 process.exit
真实 Discord 发送
真实删除频道
真实 Telegram
真实 Hermes
正式 data/runtime
正式或开发共用的 coc.sqlite
```

删除频道、分配权限、发送 DM、生成附件必须有 dry-run / fake / mock。

无法只靠模拟最终确认的事项，完成后标记为：

```text
待真实环境验证
```

至少包括：

```text
Dev Guild 里真实建频道与权限覆盖
真实按钮打开 Web 并写回角色卡
Message Content 开通后的真实历史读取
DM 失败时的真实频道 fallback
VPS 重启后的 Session 恢复
```

不得在未经真实测试时宣称 Phase 8 完全验收通过。

禁止直接在正式服务器试错。

全量测试失败时，先分析原因。禁止删除测试、放宽断言或跳过检查来制造通过。

---

# 16. 部署检查表

每次正式部署，先完成 `BOT_CONSTRUCTION_PLAN2.md` 的既有检查，再追加 CoC 相关项。

既有项仍然包括：

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
```

CoC 进入生产后追加：

```text
COC 数据库路径在持久盘上，不在会随重启消失的临时目录
备份目录可写
Web 只通过现有 HTTPS 反向代理暴露
授权 token 不出现在公网日志
COC_TRANSCRIPT_ENABLED 与 Discord Intent 实际状态一致
跑团分类频道属于正式 Guild
Bot 能在该分类下创建和删除文字频道
Bot 能管理该频道的 Permission Overwrite
Bot 拥有 MANAGE_NICKNAMES 与 MANAGE_ROLES
三个颜色身份组已存在、无权限、不可提及、不单独分组
三个颜色身份组高于普通成员色，低于管理组和低于小G宝
COC_SESSION_NICKNAME 的生产值明确
感谢、顶帖、套皮发言的冒烟仍然正常
CoC 配置缺失时，其余功能仍能启动
```

正式服务查看命令保持不变：

```bash
journalctl --user -u teaparty-bell -n 200 --no-pager
journalctl --user -u teaparty-bell -f
```

在对应 Phase 尚未封箱前，检查表里属于该 Phase 的项标成“未上线”，不得假装已经生效。

---

# 17. 非目标范围

当前规划不包含：

```text
CoC 6 版
D&D、Pathfinder 及其他 TRPG
HKTRPG 命令兼容
多服务器 SaaS
大型 Web 管理后台
AI 自动 KP
AI 剧情生成
PostgreSQL / MySQL
Redis
Kubernetes
微服务
重型 ORM
为每一桌永久 Role
角色卡死亡 / 退役档案
长期保存聊天正文
一次性车卡网址
通用 Excel 公式解释器
全服务器骰子监听
普通成员 AI 聊天
开放式 ChatGPT 问答
```

这些如果将来要做，另立计划。禁止借 CoC 首版把它们一起带进来。

---

# 18. 目标体验

一个典型流程：

```text
KP：
/coc 开团 常暗之厢

↓

小G宝创建临时频道

↓

玩家点击：
[加入PL]
[加入OB]

↓

PL：
[选择角色]
→ 奈洛莉

↓

小G宝先提示：本局昵称将临时变成「奈洛莉」
确认后改名，并挂上 CoC · PL 的颜色
KP 是紫金色，OB 是灰紫色

↓

开始跑团

↓

需要判定：
/coc 检定 心理学 70

↓

自然结束：
[结束本局]
→ 二次确认

↓

小G宝：
生成《常暗之厢.md》
发送到频道

↓

48 小时后：
自动删除临时频道
```

角色卡走另一条安静的支线：

```text
/coc 角色卡
→ 打开 Web
→ 分步填写
→ 保存
→ 下次开团时再选这张卡
```

这张卡在某一局里死亡，下一局里仍然可以被选中。

---

# 19. 当前下一步

现在不施工完整功能。

Phase 0 与 Phase 0.5 的设计已经写入：

```text
docs/coc-phase0-audit.md
docs/tl-coc-card-xlsx-audit.md
```

Excel 拆解报告保持事实审计，不因 Phase 0.5 改公式和 A/B/C。完整版产品语义以审计报告 Phase 0.5 段落和本文件为准。

A 线眼下的施工边界是 `docs/coc-mvp-0.1.md`。角色卡网站交给另一个会话，边界是 `docs/coc-b-line.md`。A 线不要做 SQLite 角色库、车卡页面和 OAuth。B 线不要改跑团 MVP。

审计完成后提交第 13 节列出的报告，至少包含：

```text
1. 当前仓库架构地图
2. Excel 数据结构与公式地图
3. Character Schema 草案
4. SQLite Schema 草案
5. Web 身份认证方案
6. Discord Session 生命周期方案
7. Message Content Feature Gate 方案
8. 分阶段施工建议
9. 风险点
10. 不应修改的现有模块
```

报告确认后，才进入 Phase 1。

---

# 20. 给开发 Agent 的固定开场

```text
继续开发 TeaParty-Bell 的 CoC 7e 跑团模块。

请先阅读并严格遵守：

AGENTS.md
CLAUDE.md
BOT_CONSTRUCTION_PLAN2.md
BOT_CONSTRUCTION_PLAN3.md

BOT_CONSTRUCTION_PLAN.md 只作为历史参考。
已上线的自动感谢、生产加固、管理员发言、论坛顶帖以 BOT_CONSTRUCTION_PLAN2.md 为准。
CoC 完整版的功能范围、阶段顺序和架构边界以 BOT_CONSTRUCTION_PLAN3.md 为准。
当前要施工的最小开团版本以 docs/coc-mvp-0.1.md 为准。完整版 Phase 1 先不要做。

执行当前 Phase 前：

1. 先做只读审查。
2. 区分已确认事实、未知信息和待用户确认事项。
3. 不猜测 Discord 接口，不猜测 CoC 公式。
4. 不创建未经确认的新配置体系。
5. 不进入后续 Phase。
6. 不修改 boostThanks、forumBump、manualMessage 的行为。
7. 完成后 Push GitHub，等待真实代码审阅。

当前先按 docs/coc-mvp-0.1.md 施工。不要提前做 SQLite、角色卡、Web 或团录。
```

---

# 21. 最终原则

CoC 模块应始终围绕：

```text
跑团是主角
角色卡是玩家的长期资产
房间是临时的
身份以数据库为准
正文不落库
失败先交付、后删除
已上线功能不被牵连
先审计，再一个 Phase 一个 Phase 地封箱
```

小G宝在这套流程里负责：

```text
打开车卡页
记住这张卡属于谁
开一间会自己到期的房间
把检定算对
结束时把该留下的发言交出去
然后把房间收拾掉
```

她不负责替角色记住死亡，不负责替服务器堆积 Role，也不负责把茶话会的闲聊存进数据库。
