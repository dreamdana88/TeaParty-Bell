# B 线：CoC 角色卡中心

> 独立网站。用户用 Discord 登录，自己车卡，长期保存。  
> 建立日期：2026-09-28  
> 修订：2026-09-28。PL、OAuth 独立门禁、会话安全、长期卡与本局状态、Migration、配置化。  
> A 线跑团房间仍在 TeaParty-Bell，施工文件是 `docs/coc-mvp-0.1.md`。

把这句话交给负责 B 线的会话：

> 先做成一个能用 Discord 登录、独立车卡、长期保存角色卡的网站。等它自己稳定之后，再让 TeaParty-Bell 通过接口认识这些卡。

A 线搭桌子。B 线做人物档案馆。最后再让奈洛莉走进房间。

---

## 0. 两条线怎么分

B 线负责：

```text
Discord 登录
茶话会成员与茶会贵宾校验
CoC 7 角色卡数据
车卡网页
保存、编辑、复制、删除
SQLite
以后给小G宝调用的角色卡接口
```

A 线继续负责，B 线不要改这些：

```text
TeaParty-Bell 跑团 MVP
开团、PL / OB 报名
临时频道、身份组、临时昵称
房间寿命和结束
骰子
以后的团录
```

两条线现在互不阻塞。B 线不等 A 线做完，也不提前做 Bot 对接。

不要在 TeaParty-Bell 仓库里实现这套网站。Phase B0 新建独立项目，建议名：

```text
CoC-Character-Card
```

规则不要重做。字段和公式以这两份已确认的审计为准：

```text
TeaParty-Bell/docs/tl-coc-card-xlsx-audit.md
TeaParty-Bell/docs/coc-phase0-audit.md
```

工作簿在 `D:\git项目\TeaParty-Bell\TL COC CARD.xlsx`。它是参考，不是数据库。

`BOT_CONSTRUCTION_PLAN3.md` 里关于一次性车卡网址的旧方案已经作废。角色卡字段和公式仍以审计报告为准。登录、门禁和资格复查以本文件 Phase B3 为准，不再采用审计报告里「用 Bot 查成员、静默复查」的旧方案。

玩家身份沿用 A 线已经改完的说法：PL。B 线文档、接口、页面和测试从第一天起不使用 KL。

**B7 内部 API 是 B 线唯一正式集成边界。TeaParty-Bell 永远不直接打开 B 线 SQLite。**

---

## 1. 必须守住的产品决定

角色卡属于玩家的长期资产，所有权只认 Discord User ID。不用用户名、昵称、服务器显示名。

长期卡保存建卡结果。角色卡本身需要的基础值、初始值，或可由规则推导的字段，仍按 Character Schema 保存或计算。幸运是 CoC 7 的卡面字段，要留在人物卡上。理智上限、生命上限、魔法上限也一样，可以保存初始值，或由规则现算。

长期卡不写入跑团 Session 中产生的 HP / SAN / MP / Luck 消耗、伤势、疯狂、死亡等临时变化，也不记录死在哪个模组。禁止把「这一局花掉的幸运」扣回永久卡。

某一局的消耗由 A 线以后自己建本局状态。B 线只保存建卡结果。玩家中途改长期卡，不得让正在跑的那一局跟着跳。这个隔离到 Phase B8 再接，B 线先不要做本局状态。

职业点只有审计报告里那 13 类。写成枚举函数，例如 `EDU_X4`。未知类型直接失败。禁止解析 Excel 字符串，禁止 `eval`。兴趣点是智力的两倍。

年龄除了移动力以外，表里是缩写，不是公式。页面可以提示年龄段。在缩写被展开并确认之前，不要自动改力量、体质、敏捷、外貌、教育和幸运。

派生值用纯函数现算，不把 Excel 坐标存进库：

```text
HP、重伤、MP、SAN 上限
移动力、伤害加值、体格
技能普通值、困难值、极难值
职业点总额、兴趣点总额
```

闪避基础值是敏捷的一半，母语基础值是教育。克苏鲁神话不加职业点和兴趣点。

---

## 2. 阶段

### Phase B0：独立项目

新建仓库，最小结构：

```text
web/        页面
api/        HTTP
auth/       Discord OAuth 与会话
storage/    SQLite
rules/      CoC 7 纯计算
tests/
```

技术保持小。Node 即可。不用 Kubernetes、Redis、微服务、重型 ORM，也不为了好看先上大型前端框架。以后用到 SQLite 时，驱动用 `better-sqlite3`，不要用仍标记为实验特性的 `node:sqlite`。B0 先不安装这个驱动，也不建库。

B0 验收至少交付：

```text
package.json
Node 版本约束（写在 package.json 的 engines）
测试命令
.env.example
.gitignore
README
目录骨架
最小测试能够运行并 PASS
```

`.env.example` 只列名字，值为空。至少包括：

```text
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
OAUTH_CALLBACK_URL
DISCORD_GUILD_ID
COC_ACCESS_ROLE_ID
SESSION_SECRET
DATABASE_PATH
INTERNAL_API_SECRET
```

`.gitignore` 排除 `.env`。README 写明仓库如何引用现有的两份 Excel 审计，并写明上面这些值只来自环境变量。

然后停。不要趁 B0 写 OAuth、SQLite、Migration 或车卡页面。空目录可以在，里面不要有登录、数据库或页面实现。最小测试只证明测试命令能跑通。

### Phase B1：规则核心

内部格式是 `*.coc7.json`，`schemaVersion` 从 1 开始，`ruleset` 固定 `coc7`。

至少包括：

```text
姓名、玩家、年龄、性别、时代、住地、故乡
力量、体质、体型、敏捷、外貌、智力、意志、教育、幸运
职业：id、名称、点数公式种类、信用上下限、本职技能
技能：名称、专攻、基础值、成长、职业点、兴趣点
背景：形象、信念、重要之人、地点、宝贵之物、特质、疤痕、恐惧与躁狂
武器、护甲、物品、法术名
ownerDiscordUserId
```

规则模块只放纯函数。测试不连接 Discord，也不引用 TeaParty-Bell 的源码。

### Phase B2：角色库

网站独占一份 SQLite，只有 B 服务可以直接打开数据库。TeaParty-Bell 不打开这个文件。

SQLite migration 从 v1 就开始。哪怕首版只有 `001_init.sql`，也要有版本化 Migration。后面的 Schema 变更都走 Migration，禁止靠手改表结构。

支持创建、读取、编辑、删除、复制，以及按 Discord User ID 列出该用户的全部卡。复制产生新卡，所有者仍是当前用户。删除只删自己的卡。

启动执行 `integrity_check`。异常就 fail closed：拒绝服务并告警，不要新建一个空库假装角色还在。使用 SQLite 在线备份，每日一份，保留最近 14 份。禁止在库开着的时候用文件复制当备份。

数据库路径只读 `DATABASE_PATH`。驱动用 `better-sqlite3`。

### Phase B3：登录与门禁

固定地址，所有人同一个，例如 `https://域名/coc`。没有每人一个网址，URL 里没有 User ID。

开工前用 Discord 官方文档再核对一次 `identify` + `guilds.members.read`。2026-09-28 对照的官方说明是：

```text
identify
  允许 GET /users/@me，取得真实 User ID

guilds.members.read
  允许 GET /users/@me/guilds/{guild.id}/member
  用当前登录用户自己的 OAuth Access Token
  读取该用户在指定 Guild 的 Guild Member

Guild Member 对象的 roles
  是 role id 数组
```

文档：<https://docs.discord.com/developers/topics/oauth2>，<https://docs.discord.com/developers/resources/user#get-current-user-guild-member>，<https://docs.discord.com/developers/resources/guild#guild-member-object>。

优先由 B 线用这条用户 OAuth 路线独立完成 Guild 与贵宾身份校验。不共享 TeaParty-Bell 的 Bot Token，也不依赖 Guild Members Gateway Intent。这里说的是 OAuth scope，和小G宝的 Gateway Intent 不是一回事。不要为了这个功能打开那个 Intent，也不要把小G宝正式 Bot Token 放进 B 项目。

```text
identify
+
guilds.members.read
↓
取得 Discord User ID
↓
读取该用户在 DISCORD_GUILD_ID 的 Guild Member
↓
确认 Member 存在
↓
检查 roles 是否包含 COC_ACCESS_ROLE_ID（茶会贵宾）
↓
通过后写入服务端会话
```

读不到这个 Member，就视为不是该服务器成员。`DISCORD_GUILD_ID` 和 `COC_ACCESS_ROLE_ID` 只从环境变量读。文档可以备注当前生产茶话会的 Guild ID 是 `1447978053665030280`，这是正式社区，不是 A 线正在用的测试服。运行逻辑里不要写死这个数字，也不要写死贵宾身份组 ID。

下列也全部来自 `.env` 或密钥保管，不进仓库：

```text
Discord Client ID
Discord Client Secret
OAuth Callback URL
Session Secret
数据库路径
内部 API Secret
```

安全要求是封箱条件。只做到「能登录」不算 Phase B3 完成：

```text
OAuth Authorization Code Flow
必须校验 state
Session ID 随机不可猜
Cookie: HttpOnly + Secure + SameSite=Lax
Session 服务端保存
浏览器不保存 Discord access token
所有角色卡 API 从 Session 推导 ownerDiscordUserId
绝不接受前端自己传 ownerDiscordUserId 决定所有权
```

官方建议用 `state` 防止授权回调被伪造。`state` 只活在这一次授权里，不拿来当车卡链接。禁止 Implicit Grant。禁止用户手填 Discord ID 或用户名来登录。库存 Session 的哈希，不存裸 Session ID。

会话大约 90 天，资格大约 30 天。两个数字做成命名常量。

已选定：不长期保存 Discord access token，也不保存 refresh token。官方授权码换票响应里的 `expires_in` 示例是 604800 秒，access token 撑不到 30 天的静默复查。要静默复查就必须在服务端保存并刷新 OAuth 凭证。B 线只在进门时读一次成员和身份组，不需要在用户离开后继续代表用户调用 Discord。因此不做静默重检。

资格到期后，下一次访问必须重新走 Discord 授权。授权成功后用这一次的 access token 完成校验，然后丢掉 access token 和 refresh token，不写入数据库，不放进 Cookie。网站会话仍可维持到大约 90 天，但资格过期后不能进门，也不能写卡。

这一阶段的页面要证明：未登录进不去，外站用户进不去，茶话会成员但没有贵宾身份进不去，贵宾可以进来并看到自己的 Discord 用户 ID。篡改 Cookie 无效。关掉页面再打开，会话未过期时仍然是登录状态。上面的安全清单每条都有测试。

### Phase B4：最小车卡页

```text
我的调查员
新建
编辑
删除
复制
```

先做角色简介和八项属性。保存后刷新还在。两个登录用户互相看不到、改不到对方的卡。

界面先清楚能用。手机优先，电脑也能用。

### Phase B5：完整车卡

再加入职业、技能、背景、武器、物品、剩余职业点和兴趣点、派生值、表单校验、自定义技能、自定义职业。

视觉可以有神秘学气质，目标是接近以前用的 QQ 小程序那么好填，不照搬它的版面，也不把 Excel 格子搬上网。

### Phase B6：导入导出

先做自己的 `*.coc7.json` 导出和导入。导入后所有者是当前登录用户，不是文件里写的别人。

`TL COC CARD.xlsx` 的导入和 Excel 导出放到这之后。不承诺兼容任意 Excel。简化卡那张表有失效引用，不能当存档格式。

### Phase B7：给小G宝的内部接口

**B7 内部 API 是 B 线唯一正式集成边界。TeaParty-Bell 永远不直接打开 B 线 SQLite。**

网站稳定后再加，只给小G宝用：

```text
GET /internal/users/:discordUserId/characters
GET /internal/characters/:characterId
```

要能回答：这张卡是不是这个 Discord 用户的。

接口只监听本机，或者校验 `INTERNAL_API_SECRET`。不要暴露到公网。密钥不进仓库。

### Phase B8：和 A 线汇合

两边各自稳定后再做。第一批 Integration 只实现 PL 报名时选择自己的长期角色卡。TeaParty-Bell 通过 B7 Internal API 取得卡 ID、角色名和必要只读数据，本局建立独立 Session Snapshot。跑团产生的 HP / SAN / MP / Luck 等变化仅属于 A 线 Session，不回写长期角色卡。

```text
PL 报名选角
↓
通过 B7 拿到自己的卡
↓
选择本局角色
↓
A 线记下卡 ID、角色名，并建立本局快照
↓
小G宝把服务器昵称临时改成这个角色名
```

以后再接「cc 心理学」读取技能值，以及用角色卡生成这一局的 HP、SAN、MP 起点。那些本局数字仍留在 A 线。

汇合时由 TeaParty-Bell 调用 B7。不要让小G宝直接改角色库，也不要把 B 线的网页塞进现在的跑团路由。

---

## 3. 施工纪律

每个阶段：只做本阶段，带测试，通过后再进下一个。不要顺手做团录、奖励骰、AI KP、别的规则系统、经历包、疯狂症状抽取。

八荣八耻仍然有效：不猜 Discord 接口，不猜尚未写进审计报告的公式，不把昵称当身份，不在没有测试时改删除和授权。

失败只告诉当前用户。不要把数据库错误发进茶话会频道。

---

## 4. 当前下一步

阶段顺序保持 `B0 → B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8`。先做 Schema 和规则，再做数据库，然后才做 OAuth。角色卡核心不绑 Discord。

B 线从 Phase B0 开始：新建 `CoC-Character-Card` 仓库，交付上一节列出的验收文件，并让最小测试 PASS。不要改 TeaParty-Bell 的跑团代码。B0 完成后停，不进入 B1。
