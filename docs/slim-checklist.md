# 瘦身验收清单（手动走查）

用途：每一步瘦身合并前后，在本地 **Dev Bot + Dev Guild** 上逐项走查，确认对外行为没有变化。
基线 tag：`pre-slim-baseline`。发现差异时先对照该 tag 的行为。

> 命令名、按钮文字、配置项均取自代码（`src/features/**/commands.js`、`panelView.js`、`coc/panel.js`、`.env.example`）。
> 如代码改名，请同步更新本清单。

## 0. 准备

- [ ] `.env` 从 `.env.example` 复制，填 Dev Bot 的 `DISCORD_BOT_TOKEN` / `DISCORD_APPLICATION_ID` / `DISCORD_GUILD_ID` / `DISCORD_THANKS_CHANNEL_ID`。
- [ ] `NODE_ENV=development`，`TEST_MODE=true`（第一轮）。
- [ ] `npm test` 全绿（基线 71 文件；用例数见 PR 记录）。
- [ ] 注册命令：`npm run commands:register -- --confirm-guild <Dev Guild ID>`，Dev Guild 中能看到
  `/顶帖 面板`、`/小g宝发言`、消息右键菜单「小G宝回复」、`/coc 开团|面板|建卡`、`/r dice:`。
- [ ] 注意 `TEST_MODE=true` 的边界（代码行为，不是 bug）：
  - Boost 感谢只记录日志预览，**不真实发送、不加 Reaction**（`handler.js` → `test_skipped`）。
  - CoC **整体不启用**，启动日志会提示「TEST_MODE=true，CoC 不执行真实 Discord 操作…」（`coc/runtime.js`）。
  - 不申请 Message Content Intent。
  - 因此 CoC 和真实发送类项目需要第二轮：Dev Bot + Dev Guild + `TEST_MODE=false`（仍是 `NODE_ENV=development`）。

## 1. 启动自检（Startup Preflight）

- [ ] `npm start`，日志出现各项自检结果：Guild、SystemChannelFlags（`SuppressPremiumSubscriptions` 未开）、系统频道、感谢频道、Application Emojis、运行模式，以及每个 `forum_bump:<forumId>`（顶帖开启时）。
- [ ] 日志出现「⚡ 测试模式已启用 — 不会发送真实消息」。
- [ ] 负向：把 `DISCORD_THANKS_CHANNEL_ID` 改成不存在的 ID → 启动失败，退出码 78（永久故障）。还原。
- [ ] 负向：`NODE_ENV=production` + `TEST_MODE=true` → 自检 FATAL、退出码 78。还原。
- [ ] 负向（单实例锁）：同一目录再开一个 `npm start` → 第二个进程立即退出码 78（`INSTANCE_LOCK_BUSY`），第一个不受影响。
- [ ] 单实例锁过期接管：`kill -9` 第一个进程后再 `npm start` → 自动接管 `data/runtime/teaparty-bell.instance.lock` 正常启动。macOS / Windows 无 `/proc`，只检查 pid 存活；若 pid 被复用导致误判占用，手动删除该锁文件。
- [ ] 启动失败时 `data/runtime/alerts/` 下生成 `startup_preflight_failed` 告警文件。

## 2. Boost 感谢

- [ ] 在 Dev Guild 用测试账号 Boost（或使用已有的系统 Boost 消息复现方式），日志出现 `[BoostThanks]` 处理链：识别 → 聚合（窗口 `BOOST_AGGREGATION_WINDOW_MS`，默认 15000ms）→ 生成文案。
- [ ] `TEST_MODE=true`：日志「TEST_MODE：跳过真实发送」并带预览，频道里无消息。
- [ ] 15 秒内连续两次 Boost → 只生成一条聚合感谢。
- [ ] `TEST_MODE=false` 第二轮：感谢频道真实出现消息，并在 Boost 系统消息上加约 `REACTION_COUNT`（默认 10）个表情。
- [ ] AI：主 API（`AI_*`）正常时用主 API；把 `AI_BASE_URL` 写错且配置了 `FALLBACK_API_*` → 走备用一次；两路都失败 → 不发送，留待人工补。
- [ ] 重启后不重复感谢（`boostThanksStore` 去重）；发送中途杀进程，重启日志出现「发现 sending 状态残留，已标记为 uncertain」。

## 3. 论坛顶帖：扫描与顶帖

- [ ] 离线扫描（只读，要求 development + TEST_MODE=true）：
  `npm run forum:scan -- --forum <论坛频道ID> --silence-days 30 --confirm-guild <Dev Guild ID>`，输出候选帖列表；`--confirm-guild` 与 `.env` 不一致时报 `GUILD_CONFIRMATION_MISMATCH`。
- [ ] 状态文件：`npm run forum:state -- inspect`（默认 `FORUM_BUMP_STATE_PATH=data/runtime/forum-bump/state.json`）；首次需 `npm run forum:state -- init --confirm-guild <Dev Guild ID>`。
- [ ] 运行时：`FORUM_BUMP_MODE=dry_run` + `FORUM_BUMP_FORUM_CHANNEL_IDS=<ID>` → 日志有扫描/决策，不发消息；`execute` → 活跃窗口（`FORUM_BUMP_ACTIVE_START`–`FORUM_BUMP_ACTIVE_END`，`FORUM_BUMP_TIMEZONE`）内按间隔顶帖。
- [ ] 规则：置顶帖跳过（`FORUM_BUMP_SKIP_PINNED=true`）、`FORUM_BUMP_EXCLUDED_TAG_IDS` 中的标签跳过、未达 `FORUM_BUMP_SILENCE_DAYS` 的帖子不顶。
- [ ] 每日额度 `FORUM_BUMP_DAILY_LIMIT` 用完后当天不再顶；成功间隔 = 活跃窗时长 ÷ dailyLimit（最短 30 分钟）。
- [ ] `FORUM_BUMP_MODE=disabled`：不扫描、不顶帖；未知值 → 配置失败无法启动。

## 4. 管理面板按钮与动态配置

- [ ] 管理员执行 `/顶帖 面板` → 出现状态面板；非管理员看不到该命令。
- [ ] 「暂停顶帖」→ 面板变为「恢复顶帖」，调度停止；「恢复顶帖」→ 恢复。
- [ ] 「编辑配置」→ 弹出 Modal，四项：每日额度、活跃开始时间（HH:mm，UTC+8）、活跃结束时间、无回复天数（1–3650）。
- [ ] 「保存配置」后写入 `FORUM_BUMP_DYNAMIC_CONFIG_PATH`（默认 `data/runtime/forum-bump/config.json`），无需重启即生效；「取消」不写入。
- [ ] 非法值（如额度 0 / 31、时间格式错误、天数 0）→ 拒绝保存并提示。
- [ ] 删除动态配置文件后重启 → 回落到 `.env` 基线。

## 5. 管理员套皮发言

- [ ] `/小g宝发言` → 弹出输入框，提交后小G宝在当前频道发言。
- [ ] 消息右键 → 应用 →「小G宝回复」→ 小G宝以回复形式发言。
- [ ] 非管理员不可见/不可用；内容策略拒绝的内容（如批量 @everyone 等，见 `contentPolicy.js` / `manualMentionPolicy.js`）被拦截并提示。
- [ ] 审计日志有记录（`audit.js`）。

## 6. /coc 开团 → 掷骰 → 结束（需 TEST_MODE=false 的 Dev 环境）

前置：`COC_ENABLED=true`，`COC_CATEGORY_ID`、`COC_KP_ROLE_ID`、`COC_PL_ROLE_ID`、`COC_OB_ROLE_ID` 填 Dev Guild 的值；档案馆相关 `COC_CHARACTER_API_URL` / `INTERNAL_API_SECRET` / `COC_ARCHIVE_URL` 可选。

- [ ] 缺任一 ID → 只关闭跑团，感谢/顶帖/套皮仍正常。
- [ ] `/coc 建卡` → 仅本人可见的图文面板（图片默认 `src/resources/coc/archive-banner.png` 或 `COC_ARCHIVE_PANEL_IMAGE`）+ 档案馆链接。
- [ ] `/coc 开团` → 招募面板：「🎭 报名 PL」「👁 报名 OB」「↩ 取消报名」「🎲 正式开始」「✖ 取消开团」。
- [ ] 报名 PL 时可选档案馆角色卡（有卡）或看到无卡提示；取消报名生效；「✖ 取消开团」关闭招募。
- [ ] 「🎲 正式开始」→ 在分类下创建私密房间，KP / PL / OB 身份组与临时角色名（昵称）生效。
- [ ] 房间内 `/coc 面板` 重发控制面板：「👥 成员管理」（➕ 添加 PL / 👁 添加 OB / 🔄 转换身份 / ➖ 移出本局，含确认/返回）、「🛑 结束本局」。
- [ ] `/r dice:1d100`、`/r dice:2d6+3` 正确掷骰；非跑团房间使用被拒绝；非法表达式提示错误。
- [ ] 文字骰（如有开启）与 `MESSAGE_CONTENT_ENABLED=true` 时的「团录与隐私」按钮（还需 `COC_TRANSCRIPT_ENABLED=true`）：「不记录我之后的消息」/「恢复记录我之后的消息」。
- [ ] 「🛑 结束本局」→ 确认后结束，昵称/身份恢复，频道在 48 小时后删除（状态见 `COC_MVP_STATE_PATH`，默认 `data/runtime/coc-mvp-sessions.json`）；重启后会话状态保留。

## 7. 顶帖恢复手册（`forum_bump_scheduler_halted` / `manual_review_required` 之后）

适用场景：收到 `forum_bump_scheduler_halted`、`forum_bump_cleanup_required` 或 `forum_bump_reconciliation_required` 告警，或者启动日志里的恢复分类为 `manual_review_required`、`cleanup_required`、`reconciliation_required`。这时 bot 已经自动暂停，不会自动顶帖；状态里有 inFlight 时，管理面板的「恢复顶帖」会被拒绝，返回 `STATE_RECOVERY_REQUIRED`。

以下命令都已在临时状态目录上实际运行验证过。下文 `<state>` 指状态文件路径，默认是 `data/runtime/forum-bump/state.json`；如果 `.env` 里设置了 `FORUM_BUMP_STATE_PATH`，以它为准。

### 7.1 查看状态

```bash
npm run forum:state -- inspect                       # 读取 .env 里配置的路径
npm run forum:state -- inspect --state-path <state>  # 指定路径
npm run forum:state -- --help                        # 只有 init / inspect 两个子命令
```

- 只读，不登录 Discord，不改状态文件。退出码 0 表示读取成功；1 表示文件不存在、JSON 损坏或 schema 非法（会打印 `状态校验失败：STATE_INVALID` 等错误码）。
- 重点看 `paused`、`pauseReason`、`inFlightPhase` 和 `hasSentMessageId`：

| `inFlightPhase` | 启动时的恢复分类 | `pauseReason` | 含义 |
|---|---|---|---|
| `before_send` | `manual_review_required` | `INFLIGHT_BEFORE_SEND` | 可能没发出，也可能发出后已经删除（例如 send 之后状态写失败），需要人工确认 |
| `after_send` | `cleanup_required` | `INFLIGHT_MESSAGE_MAY_EXIST` | 消息已发出，可能还没删除 |
| `after_delete` | `reconciliation_required` | `INFLIGHT_SUCCESS_RECONCILIATION_REQUIRED` | 已发出并删除，只是没记入当日额度 |

- `inspect` 不输出帖子 ID 和消息 ID。要查看完整的 inFlight（threadId、sentMessageId、startedAt），直接读文件：

```bash
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(s.inFlight,null,2))' <state>
```

### 7.2 去 Discord 检查残留的顶帖消息

1. 打开帖子：`https://discord.com/channels/<inFlight.guildId>/<inFlight.threadId>`。
2. 如果有 `sentMessageId`（`after_send` / `after_delete`），直接打开 `https://discord.com/channels/<guildId>/<threadId>/<sentMessageId>`。消息还在就删除（Discord 客户端 → 消息菜单 → 删除消息，需要「管理消息」权限）；显示找不到消息，说明已经删掉了。
3. 如果是 `before_send`（没有 `sentMessageId`）：在帖子里找 bot 在 `inFlight.startedAt` 之后（UTC 时间，北京时间 +8 小时）发的顶帖消息。有残留就手动删除；没有，就是"没发出"或"已发已删"，两种情况都不用再处理。
4. 仓库里没有删除消息的命令，删除只能在 Discord 客户端里操作。

### 7.3 清除 inFlight

`forum:state` 工具**不能**清除 inFlight（只有 `init` 和 `inspect`），只能手动编辑状态文件：

```bash
cp <state> <state>.bak.$(date +%Y%m%d%H%M%S)          # 先备份
```

方式 A：bot 不停机，之后在面板里点恢复（把暂停原因改成 `ADMIN_PAUSED`，这是面板允许恢复的唯一原因）：

```bash
node -e 'const fs=require("fs");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));s.inFlight=null;s.paused=true;s.pauseReason="ADMIN_PAUSED";s.revision+=1;fs.writeFileSync(p+".tmp",JSON.stringify(s,null,2)+"\n");fs.renameSync(p+".tmp",p)' <state>
```

方式 B：先停 bot，之后重启恢复（直接取消暂停）：

```bash
node -e 'const fs=require("fs");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));s.inFlight=null;s.paused=false;s.pauseReason=null;s.revision+=1;fs.writeFileSync(p+".tmp",JSON.stringify(s,null,2)+"\n");fs.renameSync(p+".tmp",p)' <state>
```

- `after_delete`（这次顶帖实际已完成）：如果状态里的 `localDate` 就是今天，建议在上面的脚本里 `s.inFlight=null` 之前补记一次成功：`s.successCount+=1;s.lastSuccessAt=s.inFlight.updatedAt;`。不补的话，当天最多会多顶一次。
- 编辑完一定要再跑一次 `npm run forum:state -- inspect --state-path <state>`，确认退出码是 0、`inFlightPhase` 为 `null`。schema 不合法时 bot 会拒绝启动或停止调度（fail closed），这时用备份文件恢复。
- `revision` 必须是非负整数。脚本里 +1 是为了让正在运行的 bot 按旧 revision 发起的写入一律因 `STATE_REVISION_CONFLICT` 失败，不会覆盖手工修改。

### 7.4 恢复顶帖

- 方式 A：在 Discord 里执行 `/顶帖 面板` → 点「恢复顶帖」。恢复时会先从磁盘重新读取状态，所以不用重启。
- 方式 B：`npm start`（或按现有部署方式重启进程）。启动时恢复分类应为 `clean`。

恢复后检查：

- [ ] `npm run forum:state -- inspect`：`paused: false`、`pauseReason: null`、`inFlightPhase: null`。
- [ ] 面板显示运行中，下一次运行时间在营业时段内，`今日额度 x / dailyLimit` 符合预期。
- [ ] 没有新的 `forum_bump_*` 告警；先前打开的告警之后会生成 `_recovery` 文件。
- [ ] 下一次顶帖后，帖子里没有残留消息，`successCount` 加 1。

## 8. 告警（含 Telegram）

本仓库只负责**生成告警文件**（Alert Outbox，`data/runtime/alerts/`）；Telegram 推送由仓库外的投递方读取 outbox 完成（仓库内无 Telegram 代码）。

- [ ] 制造故障：启动自检失败 → `startup_preflight_failed`；断网使 Gateway 长时间异常 → `gateway_disconnected`，达到阈值进程 exit 1 由 systemd 拉起。
- [ ] 顶帖故障类告警 key：`forum_bump_state_unavailable`、`forum_bump_cleanup_required`、`forum_bump_reconciliation_required`、`forum_bump_scheduler_halted`、`forum_bump_scheduler_unexpected_failed`（例如把状态文件改成非法 JSON）。
- [ ] 同一故障重复发生只有一份 open 告警（dedupe）；恢复后生成 `<alertId>_recovery` 文件且幂等。
- [ ] 告警文件字段含 `deliveryStatus`（pending → delivered/delivery_failed）与 `incidentStatus`（open/resolved）。
- [ ] Telegram 端：确认外部投递方收到并推送，之后文件 `deliveryStatus` 变为 `delivered`。Gateway 恢复按设计**不发** Telegram recovery。
- [ ] `data/runtime/alerts/` 不可写 → 启动拒绝（Outbox 初始化失败）。

## 9. 模拟测试：自动化覆盖 vs 必须真机

### 已由 `npm test`（mock / 临时目录 / 子进程）覆盖

- 配置解析与校验：`config/*.test.js`（AI_* 与 DEEPSEEK_* 互斥、FORUM_BUMP_*、COC_*）。
- 启动自检分类（PASS/FATAL/RECOVERABLE、退出码 78/1）：`startupPreflight.test.js`，用 mock 的 Guild/Channel 对象。
- 单实例锁：`instanceLock.test.js`，含真实子进程并发互斥。
- Gateway 健康监控与生命周期日志：mock client + 假时钟。
- Boost：识别、聚合、Emoji 选择、文案生成（mock AI，含备用 API 回退）、发送状态机与去重存储。
- 顶帖：候选规则、扫描器、调度决策/间隔、业务时间与活跃窗口、状态文件 schema/迁移/恢复、bump 服务、动态配置存储、管理面板路由（mock interaction）、运行时告警映射、CLI 安全门。
- 套皮发言：命令定义、Modal 上下文、内容/提及策略、审计、交互路由（mock interaction）。
- CoC：会话规则、会话服务、交互路由、成员查询、选卡、骰子解析/奖惩骰、文字骰、团录。
- 告警：Outbox 文件读写、dedupe、recovery 幂等、fail-closed。
- 脚本：`scripts/*.test.js`（命令注册、forum-scan / forum-bump-state CLI、emoji 导出等的参数与安全门）。

### 只能靠真实 Discord Dev Bot 验证

- 真实 Gateway 登录、Intent（尤其 Message Content）与断线重连。
- Discord 端权限与 API 错误码的真实表现（Missing Access/Permissions、SystemChannelFlags）。
- Boost 系统消息的真实到达形态与 Reaction 实际添加（含速率限制）。
- 斜杠命令/右键菜单的注册与可见性（管理员默认权限）、Modal 与按钮在客户端的真实渲染和 3 秒交互时限。
- 论坛帖子的真实读取（归档帖、置顶、标签）与顶帖消息真实发送/删除。
- CoC 私密频道创建、权限覆盖、身份组授予/撤销、昵称修改、48 小时后删频道。
- 档案馆 HTTP（`COC_CHARACTER_API_URL`）与 `/coc 建卡` 图片附件上传。
- Telegram 推送链路（仓库外投递方）与 systemd 重启行为。
