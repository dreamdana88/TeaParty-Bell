# TeaParty-Bell（小G宝）

外神们的茶话会用的 Discord Bot。

## 现在会做

- Boost 自动感谢
- 论坛顶帖
- 管理员套皮回复和直接发言
- CoC 最小开团：招募、私密房间、KP / PL / OB 颜色、临时角色名、`/r` 掷骰、结束并在 48 小时后删频道

角色卡网站不在这个仓库里，见 [docs/coc-b-line.md](docs/coc-b-line.md)。

## 常用命令

```bash
npm install
npm start                         # 启动
npm test                          # 全量测试
npm run commands:register -- --confirm-guild <服务器ID>
```

配置从 `.env.example` 复制成 `.env`。`TEST_MODE=true` 时不会真的开跑团房间或改昵称。CoC 还要填分类频道和三个身份组 ID，缺了只关闭跑团，不影响感谢、顶帖和套皮发言。

## 文档

B8 第一阶段已实现招募期间 PL 的档案馆选卡与本局快照，以及 `/coc 建卡` 链接入口。只通过本机 HTTP 读取长期卡，不读取档案馆 SQLite，不执行本局资源修改或技能自动检定。部署配置、命令同步和验收边界见 [B8 第一阶段交付](docs/coc-b8-phase1.md)。

- 跑团最小版：[docs/coc-mvp-0.1.md](docs/coc-mvp-0.1.md)
- 完整规划：[BOT_CONSTRUCTION_PLAN3.md](BOT_CONSTRUCTION_PLAN3.md)
- 角色卡 B 线：[docs/coc-b-line.md](docs/coc-b-line.md)

## License

UNLICENSED — 内部项目，未开放授权。
# 本地技能骰点

`/coc 建卡` 以仅本人可见的图文面板提供正式档案馆入口 `https://coc.dreamdana.baby`。
默认宣传图为 `src/resources/coc/archive-banner.png`；可替换此图片，或设置 `COC_ARCHIVE_PANEL_IMAGE` 指向另一张本地图片（相对项目根目录或绝对路径）。
修改配置后重启 Bot。图片以附件发送，不依赖外部图片托管。

进行中的跑团频道支持 `1d100 演技`，以及 `1d100 演技 奖励1` / `1d100 演技 惩罚2`。
读取本人已绑定角色的本局技能快照，显示技能值和骰点，仅标成功／失败：最终骰点不超过技能值为成功，否则失败。不细分大成功、大失败或其他成功等级。
骰点回复先提及玩家并祝福「祝骰运昌隆喵~！」，下一行显示骰点。团录包含本小G宝的骰点结果，沿用触发玩家的身份与记录隐私设置。
