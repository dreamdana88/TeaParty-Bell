# Forum Bump Dev 手动冒烟指南（Stage D-5）

施工自动化**不会**连接真实 Discord、不会读取 Token、不会创建你的 Dev state。  
以下步骤由你在 GitHub diff 审核通过后本地执行。

## 已知 Dev 环境（勿写入生产代码）

- Dev Guild ID：`1047080654573158420`
- Forum Channel ID：`1420375965963653180`
- 测试 Thread ID：`1423941620847480982`

## 1. 初始化独立 Dev 状态

```powershell
npm run forum:state -- init `
  --confirm-guild 1047080654573158420 `
  --state-path data/runtime/forum-bump/dev-state.json

npm run forum:state -- inspect `
  --state-path data/runtime/forum-bump/dev-state.json
```

预期：`successCount=0`，`inFlight=null`，`paused=false`。

## 2. Dry Run 建议配置（写入本地 `.env`，勿提交）

```env
TEST_MODE=true
FORUM_BUMP_MODE=dry_run
FORUM_BUMP_FORUM_CHANNEL_IDS=1420375965963653180
FORUM_BUMP_SILENCE_DAYS=30
FORUM_BUMP_DAILY_LIMIT=1
FORUM_BUMP_COOLDOWN_MINUTES=3
FORUM_BUMP_COOLDOWN_JITTER_MINUTES=0
FORUM_BUMP_IDLE_POLL_MINUTES=3
FORUM_BUMP_FAILURE_BACKOFF_MINUTES=1
FORUM_BUMP_TIMEZONE=Asia/Shanghai
FORUM_BUMP_STATE_PATH=data/runtime/forum-bump/dev-state.json
```

> `TEST_MODE=true` + `dry_run` 允许：不会真实 send/delete。

启动 Bot（你的常规方式，例如 `npm start`），至少观察两轮：

- Discord ready + Preflight 通过
- Runtime 启动（mode=dry_run）
- Scanner 每轮重新扫描
- 日志/状态为 `dry_run_candidate` 或 `no_candidate`
- **未**发送/删除消息
- `successCount` / `lastSuccessAt` / `inFlight` 不变
- 仅 `nextEligibleAt` 可能向后变化
- 正常关闭后无残留 timer

## 3. Execute 单次冒烟

**必须显式确认（配置层强制）**：

```env
TEST_MODE=false
FORUM_BUMP_MODE=execute
```

`TEST_MODE=true` + `execute` 会在加载配置时 **ConfigError / exit 78**，不会静默降级为 dry_run。

启动前请再次核对：

- Dev Bot Token（不是 Production）
- Dev Guild
- 测试 Forum
- 独立 Dev state 路径
- 没有第二实例（实例锁 exit 78）

inspect 后确认 `nextEligibleAt` 已到期或改用新 state 文件：

```env
TEST_MODE=false
FORUM_BUMP_MODE=execute
FORUM_BUMP_DAILY_LIMIT=1
FORUM_BUMP_COOLDOWN_MINUTES=3
FORUM_BUMP_COOLDOWN_JITTER_MINUTES=0
FORUM_BUMP_STATE_PATH=data/runtime/forum-bump/execute-dev-state.json
```

```powershell
npm run forum:state -- init `
  --confirm-guild 1047080654573158420 `
  --state-path data/runtime/forum-bump/execute-dev-state.json
```

验收：

- 只选一个候选；固定临时消息发一次、约 1 秒后删一次
- Thread 上浮；`successCount` 0→1；`lastSuccessAt` / `nextEligibleAt` 写入；`inFlight` 清空
- 达 dailyLimit 后不再顶帖
- 重启后额度保留且不再顶帖；无 startup recovery 告警

## 4. 正常关闭

`SIGINT` / `SIGTERM`：先停 Forum Runtime，再 destroy Discord Client。
