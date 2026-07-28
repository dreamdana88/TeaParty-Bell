OBS-TB-001：Boost Observer 没有完整移除监听器

Boost Observer.destroy() 当前只销毁聚合器，没有显式移除 MessageCreate listener。

当前服务每个进程只启动一次，正常退出后 Client 也会销毁，所以没有实际回归。未来若支持进程内热重载、重复 start 或模块重建，需要补齐 listener cleanup。

OBS-TB-002：人工发言审计依赖 journald 持久化

Stage B 的审计元数据写入 systemd journal，没有额外 JSONL 审计文件。

需要在 VPS 确认 journald 使用持久化存储，否则机器重启后旧审计可能无法查询。部署时让 Hermes 检查即可，不阻塞代码上线。

OBS-TB-003：2000 字符边界采用 Unicode code point 计数

内容策略使用 Array.from(content).length 计算长度。

中文、普通 Emoji 和大部分内容表现正常，但 Discord 对复杂组合 Emoji 的最终边界没有经过真实 2000 字符极限测试。日常人工发言几乎碰不到，不阻塞上线。

OBS-TB-004：Router 的 destroy 当前是同步契约

bot.js 调用 manualInteractionRouter.destroy() 时没有 await，当前 destroy() 本身是同步函数，顺序正确。

未来若 Router 增加异步资源清理，需要把 shutdown 调用同步改为 await 并补测试。

OBS-TB-005：命令注册 CLI 与完整 Bot 配置耦合

commands:register 复用了完整 loadConfig()，因此命令注册和 dry-run 也要求部分与注册无关的环境变量存在，例如感谢频道配置。

现有 Dev 和生产 .env 都完整，不影响使用。未来架构精简时可以拆出专用注册配置读取器。

OBS-TB-006：Router 最外层未知异常文案偏向“回复”

正常 Send 和 Reply 错误已经分别显示“人工发言失败”和“人工回复失败”。

最外层极端兜底路径仍可能使用偏向 Reply 的通用措辞。该路径只处理未被正常分支捕获的意外异常，不影响实际业务。

OBS-TB-007：Modal 中输入普通 @用户名 不会自动转换为 Mention

管理员直接键入：

@Dreamdana

只会成为普通文字。真正的用户 Mention 需要正文中包含：

<@用户ID>

当前安全策略能够正确允许真实用户 Mention，同时拒绝 @everyone、@here 和角色 Mention。

未来可以考虑 User Select，但这属于体验增强，MVP 不阻塞。

OBS-TB-008：本地 Interaction ACK 偶发 10062

Windows 本地实测曾高频出现 DiscordAPIError[10062]。

诊断确认：

Router 收到 Interaction
→ 0 至 1ms 内开始 ACK

代码没有在 ACK 前明显拖延。成功样本中的 Discord ACK 请求耗时约 460ms 至 1730ms，问题较大概率来自本机到 Discord REST 的网络、DNS、IPv4/IPv6 或线路抖动。

当前代码已经能够：

将其归类为 INTERACTION_EXPIRED
只记录一次 WARN
不二次响应
不调用人工发言 Service
不重复发送
不导致进程退出

正式 VPS 上需要做一次基础烟雾测试。VPS 稳定即可上线，本地偶发问题继续作为环境观察项保留。