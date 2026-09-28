# TeaParty-Bell CoC Phase 0 审计报告

> 只读审计。没有改业务代码。  
> 审计日期：2026-09-27  
> Phase 0.5 补丁：2026-09-27  
> 依据：`BOT_CONSTRUCTION_PLAN3.md`、当前 `main` 工作区源码、`TL COC CARD.xlsx`  
> Excel 的公式与 A/B/C 分类见 `docs/tl-coc-card-xlsx-audit.md`，本补丁不改那份事实审计。

Phase 0 结论是 **PASS with amendments**。下面第 4 节之后若与文首旧句冲突，以本文件 Phase 0.5 段落为准。Phase 0.5 文档补丁确认前，不开始 CoC 业务施工。

---

## 1. 这次审计定下来的决定

```text
SQLite 文件放在 data/runtime/coc/coc.sqlite
备份放在 data/runtime/coc/backups/
驱动用 better-sqlite3
Web 与 Bot 同一进程，启动失败只关掉 CoC，不让整个 Bot 退出
车卡页先用 Node 自带 http，不引入 Express、React、Redis
Guild 命令继续一次 PUT 全量注册，CoC 命令加进同一份清单
CoC 使用自己的 InteractionCreate 监听，不进 manualMessage
Message Content 默认关闭
活动时间只看消息作者，不看正文
角色卡 Schema 按拆解报告里的字段，不按单元格坐标
```

本地 Node 是 v22.20.0。`node:sqlite` 能加载，但运行时明确打印 ExperimentalWarning。角色卡不能放在仍标记为实验的 API 上。`better-sqlite3` 是同步 SQLite，一个进程里一个写入者，和现在的单实例锁匹配。代价是 VPS 上要能编译原生模块，Phase 1 部署时单独验证。

`data/runtime/` 已被 `.gitignore` 忽略。放在这里不会把角色库提交进 Git。计划里曾考虑的 `data/coc/` 不采用。

---

## 2. 仓库架构地图

入口是 `src/index.js`，只调用 `src/core/bot.js` 的 `start()`。依赖只有 `discord.js` 和 `dotenv`。没有 HTTP 服务，没有数据库，没有 ORM。测试是 `node scripts/run-tests.mjs`，递归运行 `src/` 和 `scripts/` 下的 `*.test.js`。每个文件自己打印 `PASS:` / `FAIL:`。没有 Jest。

`start()` 的顺序：

```text
loadConfig
→ 单实例锁 data/runtime/teaparty-bell.instance.lock
→ Alert Outbox data/runtime/alerts
→ BoostThanks JSON data/runtime/boost-thanks-state.json
→ Discord 登录
→ Startup Preflight
→ manualMessage 路由
→ forumBump 定时器与 /顶帖 路由
→ operational
```

配置失败、Outbox 失败、Boost 状态损坏、Preflight 失败、Forum 状态损坏，都会让进程以 78 或 1 退出。systemd 对 78 不重启。CoC 不能接进这些失败路径。

现有 Feature：

```text
src/features/boostThanks/     自动感谢
src/features/forumBump/       论坛顶帖、定时器、JSON 状态
src/features/forumPoc/        顶帖机制实验，不在 bot.js 启动链上
src/features/manualMessage/   管理员套皮回复和发言
src/features/adminCommands.js 把上述管理员命令合成一份清单
```

公共层：`config`、`discord/client.js`、`storage/boostThanksStore.js`、`alerts`、`core` 的健康检查和 Preflight、`utils/logger.js`。

### 2.1 Intents

`createClient()` 只开：

```text
Guilds
GuildMessages
```

文件注释写明当前没有 Privileged Intent。没有 `MessageContent`，没有 `GuildMembers`，没有 Partials。

没有 Message Content 时，普通成员消息的正文为空。消息对象仍有作者、频道和时间。Bot 自己发出的消息可以读到正文。所以：

```text
KP/KL 是否说过话     现在就能判断
团录里的玩家正文     必须等 Intent 审核通过
```

改昵称和加减身份组是 `PATCH /guilds/{id}/members/{id}` 与角色路由，权限是 `MANAGE_NICKNAMES`、`MANAGE_ROLES`。按单个用户改，不需要把 Guild Members Intent 打开。实现时再对照当时的 Discord 文档确认 `members.fetch(userId)` 不会去拉全员列表。

### 2.2 命令怎么注册

`scripts/register-admin-commands.js` 调用 `registerAdminCommands()`。它对

```text
PUT /applications/{application.id}/guilds/{guild.id}/commands
```

提交**整份**命令数组。Discord 的 PUT 会替换该服务器上这个应用的全部命令。

当前清单：

```text
小G宝回复     Message Context Menu，Administrator
小g宝发言     Slash，Administrator
顶帖          Slash，子命令「面板」，Administrator
```

CoC 若另写一次 PUT，会把这三条删掉。正确做法是扩展 `allAdminCommandDefinitions` 所在的那一次注册，让 Body 里同时有管理员命令和 `/coc`。CoC 命令的 `default_member_permissions` 不能是 Administrator。运行时再检查目标 Guild。

现在没有启动时自动注册。改命令后要跑 `npm run commands:register`。Phase 5 保持这个习惯。

### 2.3 Interaction 路由

没有一个总路由器。两套监听各自挂 `InteractionCreate`，先判断是不是自己的命令或 `customId`，不是就返回：

```text
manualMessage/interactionRouter.js
forumBump/admin/adminRouter.js
```

CoC 按同样方式加第三个监听。不把玩家命令写进管理员路由。首版也不把三个监听合并成一个，那是无关重构。

### 2.4 配置

`src/config/index.js` 的必填项是 Token、Application ID、Guild ID、感谢频道。Forum Bump 由 `forumBumpConfig.js` 分段加载，`disabled` 时不要求论坛频道。`TEST_MODE=true` 且论坛模式为 `execute` 时，配置阶段就失败。

CoC 照这个形状加一段：缺 `COC_CATEGORY_ID` 时模块关闭并告警，不让 `loadConfig()` 抛 78。否则正式环境一旦漏配跑团分类，感谢和顶帖都起不来。

### 2.5 定时器与状态

论坛顶帖的可借鉴部分：

```text
时钟和 setTimeout 可以注入
状态原子写：临时文件再 rename
损坏则 fail closed，不静默当空文件
重启后从状态算下一次醒来
写失败要看返回值
```

不可借鉴的部分：论坛状态损坏会让整个 Bot 退出。CoC 的 SQLite 打不开时，只停 CoC，并走现有 Alert Outbox。

JSON 存储继续留给感谢、告警、论坛。CoC 不用另一份 JSON 存角色卡。

### 2.6 测试与部署

新测试必须是独立 `node` 脚本，打印 `PASS:` / `FAIL:`，用临时目录。禁止碰 `data/runtime/` 里的正式文件。

部署是 systemd user service：`WorkingDirectory` 加 `node src/index.js`，`NODE_ENV=production`，`Restart=on-failure`，`RestartPreventExitStatus=78`。仓库里没有反向代理配置。Web 的 HTTPS 要看 VPS 上现有的代理，Phase 2 之前到机器上确认，不在代码里发明域名。

Preflight 现在检查：Guild、系统频道的查看和读历史、感谢频道的查看、发送、读历史、Reaction、表情资源、生产环境 `TEST_MODE=false`。这些检查保持原样。CoC 频道分类不进「失败就退出」的那一组。

---

## 3. 可以复用、不能复用、需要新增

可以复用：

```text
logger
loadConfig 的分段方式和 ConfigError
Alert Outbox 与社区静默
单实例锁
Guild 白名单：命令和 Web 都只认 DISCORD_GUILD_ID
原子写盘的纪律
论坛调度器的「可注入时钟」
命令注册的 REST PUT 函数，扩展它的命令清单
*.test.js 运行器
```

不能复用：

```text
manualMessage 的管理员权限判断，当作普通玩家的门
forumBump 的「失败就 exit 78」
boostThanks 的 JSON 状态文件
DeepSeek / AI Provider。车卡、检定、团录都不调用它
Excel 文件本身
```

需要新增：

```text
src/features/coc/
better-sqlite3
data/runtime/coc/
CoC 自己的 Interaction 监听
同一份 Guild 命令清单里的玩家命令
可关闭的 Web 监听
```

目录仍按计划里的 `dice / characters / sessions / transcript / webAuth / storage / discord`。Phase 1 只建 storage 和迁移，不预建空目录。

---

## 4. Character Schema 草案

细节和公式在 Excel 拆解报告。这里只定存什么。

```text
schemaVersion  1
ruleset        coc7
identity       name, playerName, age, sex, era, residence, birthplace
characteristics
               str con siz dex app int pow edu luck
occupation
               id, name, pointFormula, creditMin, creditMax,
               occupationalSkills[]
skills[]
               key, name, specialty, base, growth,
               occupationPoints, interestPoints
weapons[]      name, type, skillKey, count
armor          name, applyMovPenalty
background     appearance, beliefs, significantPeople,
               meaningfulLocations, treasuredPossessions,
               traits, scars, phobiasManias
possessions    cash, items[]
spells[]       name
```

派生值不入库当权威。读取时用纯函数重算：

```text
hp, majorWound, mp, sanCap, mov, damageBonus, build
skillTotal, hard, extreme
occupationPointsTotal, interestPointsTotal
```

职业点只有拆解报告列出的那 13 类。实现为枚举，例如 `EDU_X4`、`EDU_X2_PLUS_APP_X2`、`CUSTOM`，由 `calculateOccupationPoints(type, characteristics)` 显式计算。未知类型 fail closed。禁止解析 `"EDU*2+MAX(STR*2,DEX*2)"` 这种字符串，禁止 `eval`，禁止通用 Excel 公式器。拆解报告里「写一个小解释器」那句是当时的实现建议，不是公式事实；公式清单仍然以那份报告为准，算法以枚举函数为准。兴趣点是 `INT×2`。

年龄对力量、体质、敏捷、外貌、教育、幸运的修正，表里是缩写，不是公式。Phase 3 把缩写展开成明确规则并经确认后，再自动改属性。在那之前，页面提示年龄段，不暗中改数。移动力里的年龄减值已经有明确公式，可以算。

长期角色卡不存：死亡、退役、模组经历、本局当前 HP / SAN / MP / Luck、本局伤势、本局疯狂、Excel 坐标、骰娘导出文本。这些里需要在对局中变化的，进 `session_character_state`，本局结束即清理。

---

## 5. SQLite Schema 草案

```text
schema_migrations
  version

characters
  id
  guild_id
  owner_user_id
  ruleset              固定 coc7
  schema_version
  name
  character_data       JSON，即上一节
  created_at
  updated_at

sessions
  id
  guild_id
  channel_id
  title
  status               active / ending / ended / expired
  kp_user_id
  created_at
  last_activity_at
  expires_at
  delete_at
  control_message_id
  transcript_start_message_id

session_members
  session_id
  user_id
  role                 KP / KL / OB
  character_id         可空；KL 选定后才有
  joined_at

session_role_events
  session_id
  user_id
  role
  character_id
  changed_at

session_character_state
  session_id
  user_id
  character_id
  character_name          绑定时快照
  hp_current
  hp_max                  绑定时快照
  san_current
  san_start               绑定时快照
  san_cap                 绑定时快照
  mp_current
  mp_max                  绑定时快照
  luck_current
  luck_start              绑定时快照
  major_wound
  temporary_insanity
  indefinite_insanity
  state_json              仅放上述列装不下、且已确认的本局标记
  created_at
  updated_at

coc_display_state
  guild_id
  user_id
  original_nickname       可为 NULL，表示她原本没有服务器昵称
  applied_nickname
  nickname_changed_by_coc
  display_role            KP / KL / OB / 空
  display_session_id
  updated_at

web_sessions
  session_hash
  guild_id
  user_id
  created_at
  expires_at              约 90 天，常量可配
  last_seen_at
  last_entitlement_check_at
  revoked_at

oauth_states
  state_hash
  expires_at              分钟级
  used_at

coc_bot_messages
  message_id
  channel_id
  session_id
  kind                    dice / panel / notice
  created_at

coc_recovery_jobs
  id
  kind                    recompute_display / delete_channel
  payload
  not_before
  attempts
```

不建 `web_login_tokens`。那是「每次点击一张一次性车卡网址」的表。固定网站加 Discord OAuth 之后它没有用途。`oauth_states` 只防 OAuth 回调被伪造，几分钟就过期，不是车卡链接。

`original_nickname` 只在小G宝第一次接管这个用户的昵称时写入。第二桌不得覆盖。NULL 是合法值：恢复时清除服务器昵称，让 Discord 显示账号名，不要把账号用户名写进昵称。

消息正文没有表。团录文件写在系统临时目录，发出后删除。`coc_bot_messages` 只存消息 ID 和种类，不存正文。

WAL 模式，迁移用 `schema_migrations.version`。角色卡上的 `schema_version` 只描述 JSON，不拿它当数据库版本。

### 5.1 长期卡和本局状态

```text
长期角色卡：奈洛莉 HP 11 / SAN 50 / MP 10 / Luck 60
↓ KL 确认加入本局
写入 session_character_state，当前值等于当时的满值
↓ 对局中只有 KP 改本局状态
HP 7 / SAN 43 / MP 8 / Luck 55
↓ 本局结束
删掉这行本局状态，不写回角色卡
↓ 下一团再选奈洛莉
按当时的长期卡重新建一行
```

角色卡可以随时在网页上改。已经绑定的本局不跟着变。绑定时冻结的字段是：

```text
character_id
character_name
hp_max
san_start
san_cap
mp_max
luck_start
```

中途把 CON 从 60 改成 80，这一局的 HP 上限仍是 11。下一局才用新卡重算。

技能数值要不要同样冻结，Phase 1 不猜测。`cc 心理学` 读快照还是读长期卡，留到 Phase 4 的 Character Skill Resolver 之前由人确认。Phase 1 的表先放下表这些快照列；不要为了「可能要快照技能」加一套未定义的技能副本。

### 5.2 本局状态谁能看、谁能改

KP 管理本局 HP、SAN、MP、Luck 和伤势、疯狂标记。入口是控制面板上的 `[调查员状态]`，不新增 `/hp`、`/san` 这类命令。

```text
KP：下拉选择本团 KL，可看可改
KL：只能看自己的只读面板
OB：没有这个面板，也看不到别人的数值
```

修改用 Modal，接受 `+3`、`-4` 或一个目标整数。校验失败就拒绝这次写入，不把半截数字存进去。HP 不得高于本局 `hp_max`，也不得低于 0。SAN、MP、Luck 同样夹在 0 和各自上限之间。上限用本局快照，不用网页上刚改过的长期卡。

### 5.3 备份与损坏

角色卡是长期资产。Phase 1 用 `better-sqlite3` 的在线 `backup()` API，每天一份，放进 `data/runtime/coc/backups/`，保留最近 14 份。禁止在库还开着的时候用文件复制当作备份。

启动时跑 `PRAGMA integrity_check`。结果不是 `ok`：CoC fail closed，走 Alert Outbox，不新建一个空库把角色假装成「还没有」。感谢、顶帖、套皮发言继续跑。

---

## 6. Web 身份

固定入口，所有人同一个地址：

```text
https://固定域名/coc
```

Discord 上的「打开角色卡」「新建角色卡」「编辑角色卡」都打开这个地址。用户也可以自己收藏。没有每人一个网址，没有每次点击换一个网址，URL 里没有 Discord User ID。

```text
打开固定页面
↓
未登录则走 Discord OAuth
↓
只取真实 User ID（scope: identify）
↓
小G宝用 Bot 身份核对：
   属于 DISCORD_GUILD_ID
   拥有 COC_ACCESS_ROLE_ID（茶会贵宾）
↓
写入 web_sessions，浏览器只拿到随机 Session ID
↓
角色卡中心
```

禁止把用户自己填写的 Discord ID 或用户名当作登录。知道 `character_id` 也不能改别人的卡。每次写操作再查：当前 Session 的 `user_id` 等于 `characters.owner_user_id`。

Cookie：`HttpOnly`、`Secure`、`SameSite=Lax`。库存 Session ID 的哈希。篡改 Cookie 等于没有登录。

```text
Web Session 约 90 天
贵宾资格静默复查约 30 天
```

两个数字是命名常量，不散落在处理函数里。复查仍通过则无感继续。不在服务器里，或没有贵宾身份，则作废 Session。

OAuth 能证明「浏览器前是哪个 Discord 账号」。贵宾门禁用的是 Bot 已有的成员查询，不是再向用户要一次密码。Phase 2 开工前对照当时的 Discord 文档核对：按已知 User ID 取单个 Guild Member 是否被要求打开 Guild Members Intent。Phase 0 看到的资料是：整表成员列表才需要这个 Privileged Intent，单个成员 REST 不需要。若复核结果相反，改为在 OAuth 上增加用户侧的成员读取范围，仍然不打开 Gateway 的 Guild Members Intent。

Web 进程绑不上端口：记日志，告警，车卡站标记不可用。Bot 继续感谢、顶帖和套皮发言。

Phase 2 页面可以丑。Phase 3 再按手机优先做分步车卡。不把 Excel 的格子搬上网页。

Phase 2 验收：

```text
未登录进不了角色中心
其他服务器的用户拒绝
茶话会成员但没有贵宾身份拒绝
贵宾可以进入并改自己的测试字段
用户 A 读不到、改不了用户 B 的卡
篡改 Cookie 无效
关掉页面再打开，Session 仍在
资格复查到期后会再查一次 Role
Discord 侧能查到刚写下的同一条数据
```

---

## 7. Session 生命周期

开团在配置的分类下建文字频道。身份以 `session_members` 为准。频道权限覆盖只是表现。全服只有三个事先建好的颜色组：`CoC · KP`、`CoC · KL`、`CoC · OB`。不按桌创建 Role。跑团期间，茶话会其他频道也会看到角色昵称和这个颜色。Role 只负责颜色和气氛，不是权限真相。

```text
寿命 15 天，KP 可续 15 天
KP 与 KL 的消息刷新 last_activity_at
OB 的消息不刷新
连续 7 天没有 KP/KL 消息，或租期到了：进入结束流程
正常结束要二次确认
团录没交到人手里，不删频道
删除、改权限、私信都先有 fake
```

没有 Message Content 时，「有效发言」就是 KP 或 KL 发出的消息事件。不根据正文猜测这句话算不算跑团。

KL 确认角色卡时，先写 `session_character_state`，再改展示。改名失败不取消选卡，也不取消本局状态。

### 7.1 昵称和颜色一律重算

任何一张桌结束时，禁止直接「恢复原昵称并卸掉全部 CoC Role」。她可能还在另一桌。

唯一入口是 `recomputeCocDisplayState(userId)`。下面这些事情做完都要调用：

```text
加入、退出、选定角色、切换角色、身份变化
Session 结束、超时、删除
Bot 重启恢复
```

```text
查出她全部 active Session
↓ 还有
按主活动团决定展示；分不出主活动团时用 KP > KL > OB
主活动团 = 她最近一次 CoC 交互所在的、仍在进行的 Session
昵称用该展示所对应的本局 character_name 快照
颜色只挂一个 CoC Role，另外两个卸掉
↓ 一个 active Session 都没有
仅当当前昵称仍等于 applied_nickname 时，恢复 original_nickname
original_nickname 为 NULL 时，清除服务器昵称
当前昵称已经被人改过，则不动
三个 CoC Role 全部卸掉
```

### 7.2 重启后补活动时间

Gateway 离线时收不到 `messageCreate`。恢复每个 active Session 时，读该频道最近若干条历史，只看 `author_id`、`created_at`、`message_id`。若其中最新的 KP 或 KL 消息晚于库里的 `last_activity_at`，就改成那个时间。不读正文，所以不依赖 Message Content。然后再算 7 天和 15 天。避免 Bot 掉线期间还在说话的团被当成弃团。

---

## 8. Message Content Feature Gate

```text
COC_TRANSCRIPT_ENABLED=false
```

关闭时仍然可以：角色卡、Web、Slash 骰子、开团、身份、寿命、正常结束、重算昵称和颜色。

正式服务器上，关闭时不自动删除频道。结束流程要明白告诉 KP：现在做不出聊天团录，频道会留下来。禁止「结束 → 48 小时 → 删掉唯一一份聊天」。Dev Guild 仍可模拟自动删除，用来验收计时器。要不要再加一颗「确认无团录删除频道」，留到 Phase 6 定界面，默认行为是不删。

打开之前必须同时满足：Developer Portal 里 Intent 已获准，`createClient()` 加了 `MessageContent`，配置为 true。只改配置、不加 Intent，历史正文是空的。

普通文本骰子同样依赖这段 Intent。没打开时，玩家用 `/roll` 和 `/coc 检定`。打开之后，活跃跑团频道里整句匹配的文本成为正式入口，Slash 仍留着。

团录里的 Bot 消息只认 `coc_bot_messages.kind = dice`。发送检定结果时写入这个登记，并在消息上放稳定标记 `coc:transcript:dice`。控制面板、续期、倒计时和报错登记成 `panel` 或 `notice`，不进团录。禁止靠「这句话看起来像骰子」来猜。

Intent 未通过不阻止 Phase 1 到 Phase 6。它阻止的是正式服的文本骰子、真实团录，以及正式服的自动删频道。

---

## 9. 骰子输入协议

Dice Engine 独立。Discord 路由只负责把已经解析的请求交进去。

整句匹配，前后空白可以去掉。句子中间夹着别的字就不掷，所以「今天运气大概 1d100 吧」不会触发。只监听 active Session 的文字频道，不全服务器听。

```text
1d100
1d6
2d6
2d6+3

cc 70
cc 心理学

cc1 70
cc1 心理学
cc2 70

ccn1 70
ccn1 心理学
ccn2 心理学
```

`cc` 是目标值或技能名的普通检定。`cc1` / `cc2` 是 1 个或 2 个奖励骰。`ccn1` / `ccn2` 是惩罚骰。一条指令里不同时带奖励和惩罚。技能名是指令其余部分，用来在本局角色上找技能。KL 还没绑定角色卡时，`cc 心理学` 拒绝并说明原因，不猜一个目标值。

展示例：

```text
🎲 奈洛莉进行「心理学」检定

心理学：70
1D100 → 24

困难成功
```

没有角色名时，`cc 70` 只显示目标值和结果。

解析上限，集中成常量：

```text
骰子个数 ≤ 100
骰面 ≤ 1000
整句长度 ≤ 80
加减项只允许一个
结果必须落在安全整数范围
```

超出的输入拒绝，不掷。奖励骰、惩罚骰、大成功、大失败的具体对照表在 Phase 4 写成测试向量之后才能编码。本补丁只定语法。

适配顺序：Dice Engine，CoC 结果判定，文本解析，角色技能查找，Discord 文本回复，Slash 备用。Message Content 没下来时，文本适配器不注册，引擎和 Slash 照样做。

---

## 10. 分阶段施工建议

```text
Phase 1  本文件第 5 节的表、迁移、backup()、integrity_check、
         fail closed。不调用 exitFn。
Phase 2  固定 /coc、Discord OAuth、贵宾 Role、90 天 Session。
         验收见第 6 节。开工前复核单个成员查询要不要 Intent。
Phase 3  派生值和 13 个枚举职业点函数。
         年龄属性修正先提示。JSON 导入导出。
         不做公式解释器、骰娘简化卡、经历包。
Phase 4  独立骰子和三层适配。文本监听等 Intent。
         奖惩骰先有测试向量。
Phase 5  /coc 加入同一次命令 PUT。第三个 Interaction 监听。
         选卡时写本局状态。recomputeCocDisplayState。
         KP 状态面板，KL 只读自己的。15 天、7 天、可注入时钟。
         重启时用历史消息的作者和时间修正 last_activity_at。
Phase 6  二次确认。结束时重算展示并清本局状态。
         团录关闭的正式服不自动删频道。
         Dev Guild 仍可演练 48 小时删除。
         私信失败则把已有团录留在频道。
Phase 7  Intent 可用之后再读玩家正文。
         骰子行只收 kind=dice 的登记。
Phase 8  只在 Dev Guild。同时看感谢、顶帖、套皮是否没变。
```

---

## 11. 风险

```text
PUT 命令清单一旦漏掉旧命令，管理员发言和顶帖会从服务器消失
CoC 启动失败若走了论坛那条 exit 78，感谢也会停
better-sqlite3 在 VPS 上编译失败会挡住 Phase 1 部署
node:sqlite 在当前 Node 上仍是实验特性
年龄缩写被误写成自动改属性
简化卡的 #REF! 被当成导入格式
Excel 技能说明和规则书不一致，长文被抄进页面
示例卡的缓存数字被当成默认角色
Message Content 未开时用空正文生成空白团录并删频道
某一桌结束时把另一桌的昵称和颜色清掉
第二桌把角色名写成 original_nickname
把 NULL 原昵称恢复成账号用户名
三个颜色组排到管理组上面，管理员名字会变成跑团色
网页改 CON 后，本局 HP 上限跟着跳
职业点用字符串求值
备份用文件复制，WAL 下抄到半份库
损坏后自动建空库
```

迁移影响：Phase 1 不改现有 JSON。新依赖只加 `better-sqlite3`。新环境变量缺了就关闭对应的 CoC 能力，不关闭整个 Bot。

Excel 仍是规则参考。公开流传、授权链不完整这件事不挡 Phase 1 和 Phase 3。README 以后加一句来源声明即可，不做授权系统。

---

## 12. 不应修改的现有模块

```text
src/features/boostThanks/
src/features/forumBump/          不把跑团定时器写进去
src/features/forumPoc/
src/features/manualMessage/      不承接 /coc
src/storage/boostThanksStore.js
src/core/gatewayHealthMonitor.js
src/core/startupPreflight.js     不把 CoC 缺配置变成致命项
感谢频道、系统频道、TEST_MODE 的现有语义
```

`src/config/index.js`、`src/features/adminCommands.js`、`src/core/bot.js` 会在后续 Phase 被碰到。碰它们只为了：多加载一段可选配置、多注册几条命令、在 operational 之后尝试启动 CoC。失败分支必须是返回，不是 `exitFn`。

---

## 13. 还没确认的事

不挡 Phase 1 建表：

```text
VPS 能否编译 better-sqlite3
固定域名和反向代理路径
COC_CATEGORY_ID、三个颜色组的 ID 和最终色值
COC_ACCESS_ROLE_ID 的具体雪花 ID
OAuth 的 client secret 与回调地址
Message Content 审核提交了没有
年龄缩写按哪一版规则书展开
cc 技能读本局快照还是长期卡
奖励骰与惩罚骰的测试向量
Phase 6 是否增加「确认无团录删除频道」按钮
单个成员查询在复核时是否仍不需要 Guild Members Intent
```

Phase 1 可以做迁移、Store、备份和完整性检查。Phase 2 要等域名、OAuth 应用和那次 API 复核。Phase 4 的技能检定要等快照策略和奖惩骰向量。Phase 5 的正式服建频道要等分类频道和颜色组 ID。
