# B8 第一阶段：档案馆选卡

2026-10-01。本阶段只修改 TeaParty-Bell，CoC-Character-Card 不变。

## 玩家流程

点击招募面板的「报名 PL」后建立轻量待选卡记录，再按交互用户的 Discord User ID 查询自己的卡；选卡成功后才正式加入 PL。没有卡时给出档案馆链接，建卡后重新点击报名 PL；一张卡自动选择，多张卡显示仅本人可见的选择菜单，每页最多 25 张，支持翻页。选卡读取单卡并再次校验 owner 和请求卡 ID。

原普通 PL 手填角色名弹窗及提交路径已删除，角色名来自档案馆。现有 A 线开团时改昵称、结束时有条件恢复的生命周期继续复用，招募期间不提前修改全服昵称。未选卡的 PL 不能开团；读取中退出或招募结束时不会绑定异步返回的卡。

`/coc 建卡` 回复仅本人可见的「打开档案馆 · 建卡」链接按钮。Discord 不允许 Slash 命令替用户直接打开网页，用户点击链接进入现有档案馆，未登录时由网站处理授权。本阶段不修改网站登录或新建页面。

B8 补丁已将 KP 新增 PL 与 OB → PL 接入本人选卡邀请。新增邀请发在原招募频道，OB 转换邀请发在跑团频道，不使用私信。目标本人选择成功后才执行现有 PL 权限、身份组与昵称事务；KP 不得代选。公开入口和私有选卡菜单都绑定随机邀请 ID，过期或取消的入口不能加入。目标或 KP 可取消邀请。无卡/API 错误/owner 错误清理邀请；结束团清理全部邀请，晚到选卡不能提交。旧角色名输入弹窗及手填建立 PL 的服务方法已删除。技能检定与开团后换卡仍不在范围内。

## 配置与命令同步

```dotenv
COC_CHARACTER_API_URL=http://127.0.0.1:8787
INTERNAL_API_SECRET=
COC_ARCHIVE_URL=
```

两个内部 GET 请求均带 Bearer 密钥，不使用 Cookie。内部 API 地址限制为本机 HTTP 根地址，禁止跳转，超时 5 秒；密钥与档案馆一致。`COC_ARCHIVE_URL` 是对玩家公开的完整网址，部署时填写；未配置时明确提示管理员，不编造地址。原 CoC 开关和 TEST_MODE 仍生效。

新子命令已加入现有命令注册定义，部署时沿用已有同步脚本：

```text
npm run commands:register -- --dry-run
npm run commands:register -- --confirm-guild <实际目标 Guild ID>
```

本批没有使用真实 Bot Token 同步 Discord 命令、启动 Bot、修改部署配置或访问 VPS。真实 Guild 同步属于部署验收。

## 本局保存

每个 PL 记录 `characterId`、`ownerDiscordUserId`、`characterName`、`occupation`、`initialHp`、`initialSan`、`initialMp`、`initialLuck`、`skills`。初始 HP/MP 使用 B7 derived；SAN 只取独立 initialSan，Luck 只取 characteristics.luck。缺失或非法初始数据拒绝选择，提示去档案馆补齐。技能数据作为独立快照保存，长期卡后来改变不影响已存快照；只有招募中再次明确选卡才更新快照。

不创建 currentHp/currentSan/currentMp/currentLuck，不记录伤势、疯狂、死亡，不回写角色库，不实现 `1d100 演技` 等自动技能检定。

## 验证

新增测试使用本机真实 HTTP 模拟 B7 服务、临时场次文件及模拟 Discord 交互，覆盖 owner 隔离、单卡 owner/ID、认证/服务错误、异常 JSON、缺失 SAN 不补 POW、单卡自动选、多卡分页、无卡入口、仅本人菜单、快照持久化、读取期间退出、错误不改快照、昵称设置及恢复。HTTP 请求只有 GET；测试不打开长期角色数据库。

`npm test`：71 个测试文件全部通过，3516 个用例通过、0 失败。其中新增选卡测试 42 项，昵称/开团测试新增 6 项，配置测试新增 2 项。`git diff --check` 通过。自动化测试不代替真实 VPS 两服务联调、Discord 命令同步/交互、网页授权、昵称权限和 OpenResty 公网隔离验收。

停止在 B8 第一阶段，不进入 B9、团后回写、完整同步或高级跑团功能。

## B8 邀请补丁验收

`npm test`：71 个文件、3552 个用例全部通过，0 失败；`git diff --check` 通过。本次新增 36 项断言，原成员管理测试改用档案馆测试数据和本人选卡流程，保留权限、昵称、回滚和团录断言。

覆盖：KP 新增邀请不提前建 PL、目标本人限定、owner 不符、无卡/API 失败清理 pending、本人/KP 取消、旧邀请失效、OB 本人转 PL、完整快照、昵称来自档案馆、频道公开邀请且只 @ 目标、发送失败清理、离开服务器、读卡期间取消/结束、权限操作期间结束并回滚。普通 PL 的 HTTP GET、Bearer、分页和快照回归仍通过。

只修改 TeaParty-Bell。没有访问档案馆 SQLite，没有修改长期卡，没有发送真实 Discord 消息或执行真实权限/昵称操作。真实部署及 Discord 冒烟仍待验收。
