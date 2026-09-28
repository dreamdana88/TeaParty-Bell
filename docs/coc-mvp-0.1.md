# CoC MVP 0.1 施工文档

> 明天能开一桌的最小跑团环境  
> 建立日期：2026-09-27  
> 长期规划仍是 `BOT_CONSTRUCTION_PLAN3.md`  
> 本文件只管辖这一版临时施工

小G宝负责招募、建房、身份颜色、角色昵称、掷骰和散场。角色卡、HP、SAN、技能和规则判定由 KP 与玩家自己管。

本文件确认后才写代码。不提前做本文件没有列出的功能。

---

## 1. 完成标准

KP 在公共频道执行 `/coc 开团` 并填写模组名。其他人在招募面板报名。KP 点正式开始后，只有报名的人能看见新房间，KL 的服务器昵称变成角色名，三种身份有不同颜色。房间里可以用 `/r 1d100`。结束后恢复昵称、卸下颜色、锁住发言，并写明 48 小时后删频道。

同时，自动感谢、论坛顶帖、管理员发言的行为不变。

---

## 2. 做与不做

做：

```text
/coc 开团
公共频道招募面板
KL / OB 报名，KL 填写本局角色名
KP 正式开始
私密跑团频道
三个预先建好的颜色身份组
KL 临时昵称
/r
KP 结束本局
48 小时后删频道
重启后认领未完成的团
```

不做：

```text
角色卡数据库、Web 车卡、Discord OAuth
职业、技能、cc、奖励骰、惩罚骰
HP / SAN 面板
Excel / JSON 导入导出
团录
Message Content，以及普通消息里直接打 1d100
7 天无活动回收、15 天租期、续期
一人同时参加多桌
战斗、成长、疯狂表
SQLite
```

---

## 3. 一人一桌

同一 Discord 用户同一时间只能处在一场 `RECRUITING` 或 `ACTIVE` 的团里，KP、KL、OB 都算。

已经在一场里时，报名或再开团只回复他本人：

```text
你当前已经参加了一场 CoC 跑团，请先结束或退出上一场。
```

因此结束时可以直接恢复这一桌的昵称和颜色，不用做多桌重算。`ENDED` 和 `CANCELLED` 不再占名额。

KP 不能再报名成这场的 KL 或 OB。

---

## 4. 配置与故障隔离

```text
COC_ENABLED=true
COC_CATEGORY_ID=
COC_KP_ROLE_ID=
COC_KL_ROLE_ID=
COC_OB_ROLE_ID=
```

`COC_ENABLED` 不是 true，或上面任一 ID 缺失：关掉 CoC，记 warning，可走现有 Alert Outbox。感谢、顶帖、套皮发言照常启动。

下面这些失败也不许让进程退出：

```text
建频道、改昵称、发身份组、收身份组
恢复昵称、删频道
MVP 状态损坏或写盘失败
```

状态文件损坏时 fail closed：停用 CoC，保留原文件，不当成空名单，也不使用论坛顶帖那种 `exit 78`。

---

## 5. 命令与路由

新增目录 `src/features/coc/`，自己监听 `InteractionCreate`。不把命令放进 `manualMessage`。

```text
/coc    子命令「开团」
/r      选项名 dice，字符串
```

这两条加进现有那一次 Guild 命令 PUT。禁止再发一次独立 PUT。现有「小G宝回复」「小g宝发言」「顶帖」必须仍在同一份清单里。

`/coc` 和 `/r` 的默认权限不是 Administrator。只在 `DISCORD_GUILD_ID` 里有效。错误只回复操作者，不写进公共频道。

建议文件：

```text
src/features/coc/
├── commands.js
├── interactionRouter.js
├── sessionService.js
├── sessionStore.js
├── channelAccess.js
├── displayRoles.js
├── nickname.js
└── dice/
    ├── parser.js
    ├── roller.js
    └── parser.test.js
```

可按现有 Feature 的写法微调，不另起一套框架。

---

## 6. 招募

`/coc 开团` 的人就是 KP，不用再报名。Modal 只收模组名称。提交后在**当前频道**发招募面板，先不建房。

```text
🎲 CoC 跑团招募

模组：常暗之厢
KP：@Dream

🎭 KL 调查员：0人
👁 OB 旁观者：0人

等待报名中……

[🎭 报名 KL]  [👁 报名 OB]  [↩ 取消报名]
[🎲 正式开始]  [✖ 取消开团]
```

正式开始和取消开团只有 KP 能按。别人按了，只对他本人提示。

KL 报名弹出 Modal，填写本局角色名。记下 `user_id`、`role=KL`、`character_name`。招募阶段不改昵称，不发身份组。

OB 报名不填名字。同一人再点另一种身份，就从原来的身份换过去。KL 换成 OB 时清掉角色名。取消报名删掉自己的记录。

面板随报名更新。名单过长时只保留人数和前面若干人，避免 Discord 消息超限。

KP 在开始前取消：二次确认后状态变为 `CANCELLED`，按钮停用，面板写成「《常暗之厢》招募已取消。」不建频道，不发身份组，不改昵称。

---

## 7. 正式开始

至少 1 名 KL。没有就只提示 KP：「至少需要一名调查员才能开团。」

二次确认展示 KL 与 OB 人数。确认后状态从 `RECRUITING` 进入 `STARTING`。`STARTING` 或 `ACTIVE` 时再次点击，直接告诉他已经在处理，不得再建一个频道。

顺序：

```text
1. 再次核对仍是 RECRUITING、KP 本人、至少一名 KL
2. 创建频道
3. 把频道 ID 写入状态
4. 写入权限覆盖
5. 发放三个身份组
6. 修改 KL 昵称
7. 状态改为 ACTIVE
8. 在跑团频道发送控制面板
9. 把公共频道招募面板改成「已经开团」，按钮全部停用
```

补偿：

```text
建频道失败
→ 回到 RECRUITING，告诉 KP，不动昵称和身份组

权限没写完
→ 删掉刚建的频道，回到 RECRUITING

身份组没发完
→ 卸掉这场已经发出的 CoC 身份组，删频道，回到 RECRUITING

昵称没改成
→ 记下 warning，开团继续
→ 只有 Discord 确实改成功的人，才记下 applied_nickname

第 8 或第 9 步失败
→ Session 已经 ACTIVE 时不回滚房间
→ 告警，并允许 KP 稍后在跑团频道看到补发的控制面板
```

招募面板不贴私密频道链接。

---

## 8. 频道

建在 `COC_CATEGORY_ID` 下面。优先名称是 `🎲・模组名`。Discord 拒绝这个名字时，改用 `coc-` 加安全化后的模组名再试一次。同分类重名则加 `-2`、`-3`。长度遵守 Discord 上限。

`@everyone` 的 `ViewChannel` 设为拒绝。再按人允许：

```text
KP、KL、OB、小G宝本人
ViewChannel
SendMessages
ReadMessageHistory
```

没报名的人看不到频道。OB 在这一版可以发言。

---

## 9. 颜色与昵称

三个身份组事先存在，ID 来自配置。开团时发放，结束时收回。不按桌新建身份组。它们只表示颜色，不作为权限依据。权限以频道覆盖和这份报名记录为准。

正式开始时，对每个 KL：若改名成功，保存改名前的服务器昵称，允许是 NULL，并记下 `applied_nickname` 为角色名。KP 和 OB 不改名。

结束时，只有当前昵称仍等于 `applied_nickname` 才动。等于时：原昵称是 NULL 就清除服务器昵称，否则改回原昵称。本人中途改成别的名字，就留着。

---

## 10. 跑团面板与结束

房间里只放一张控制消息：

```text
🎲 《常暗之厢》

KP：@Dream
KL：2人
OB：5人

跑团已开始。

[🛑 结束本局]
```

只有 KP 能结束。二次确认写明会恢复 KL 昵称、卸下三种颜色、锁住发言，并在 48 小时后删除频道。

确认后：

```text
1. 状态改为 ENDED，报名和再次开始都拒绝
2. 按第 9 节恢复昵称
3. 卸下这场所有人的三种 CoC 身份组
4. 保留查看和读历史，关掉 KP / KL / OB 的发言权限
5. 发送「本局已经结束。本频道将在 48 小时后自动删除。请在此之前保存需要保留的内容。」
6. delete_at = now + 48 小时
7. 到点删除频道
```

这一版没有团录，所以第 5 步的提醒必须发出。频道已经被管理员删掉时，视为删除完成。

---

## 11. 骰子

`/r` 只在本场 `ACTIVE` 跑团频道可用。别处调用时告诉对方：这个骰子目前只在小G宝创建的 CoC 房间里使用。

语法只有整句：

```text
NdM
NdM+K
NdM-K
```

例如 `1d100`、`2d6+3`、`3d10-2`。不做 `cc`、奖励骰、惩罚骰、括号和多段表达式。不用 `eval`。

```text
骰子个数 1～20
骰面 2～100000
表达式长度 ≤ 32
修正值绝对值 ≤ 100000
```

非法时回复：`骰子表达式无效，请使用例如 1d100、2d6+3。`

随机数用加密安全的整数随机，范围含两端。逻辑放在 `dice/`，`/r` 只做适配。以后若开放普通消息 `1d100`，仍调用这一套。

KL 且这场有角色名时，标题用角色名。否则用 Discord 当前显示名。

```text
🎲 奈洛莉掷骰

2d6+3
[4, 6] + 3 = 13
```

单骰写 `1d100 → 66`。不增加 Message Content Intent。

---

## 12. 临时存储与重启

文件：

```text
data/runtime/coc-mvp-sessions.json
```

`data/runtime/` 已被 Git 忽略。写入使用临时文件再 rename，并串行化。这是临时 Store，完整版改 SQLite 时迁走或删除。

只存：

```text
session_id
state                 RECRUITING / STARTING / ACTIVE / ENDED / CANCELLED
guild_id
recruit_channel_id
recruit_message_id
run_channel_id
kp_user_id
kl[]                  user_id, character_name, original_nickname, applied_nickname
ob[]                  user_id
created_at
started_at
ended_at
delete_at
```

不存聊天正文、角色卡、HP、SAN、团录。

启动时：

```text
RECRUITING    继续认领原面板上的按钮
ACTIVE        认领结束按钮；不重复改昵称、不重复发身份组
ENDED         delete_at 已到则删频道，未到则按剩余时间再排一次
CANCELLED     不再接受按钮
```

删除计时来自 `delete_at`，不靠一个只活在内存里的 48 小时定时器。测试注入时钟，不真的等 48 小时。

---

## 13. 测试与冒烟

自动测试沿用现有 `*.test.js`，打印 `PASS:` / `FAIL:`，使用假的 Discord 和临时目录。

必须覆盖：开团、KL 填名、OB、KL 与 OB 互换、取消报名、KP 不能报名、别人不能开始、没有 KL 不能开始、重复开始不会建两个频道。未报名者看不到频道，KP、KL、OB 看得到。三种身份组在结束时卸下。昵称覆盖原来有昵称、原来没有、中途被本人改掉、改名失败仍能开团。骰子覆盖合法式、非法式、超限、非跑团频道拒绝。非 KP 不能结束。重启后三种未完成状态都还在。

自动测试通过后，只在 Dev Guild 走一遍：开团、两人 KL、一人 OB、确认外人看不到、看颜色和昵称、`/r 1d100`、`/r 2d6+3`、结束、昵称与身份组恢复、把 `delete_at` 调到过去以确认删频道。再看一眼感谢、顶帖和套皮发言。

正式茶话会只在这条冒烟通过后使用。
