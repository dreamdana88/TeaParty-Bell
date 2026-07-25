import { loadConfig } from "../config/index.js";
import { setLogLevel, logger } from "../utils/logger.js";
import { createClient } from "../discord/client.js";
import { setupBoostObserver } from "../features/boostThanks/observer.js";
import { createBoostThanksHandler } from "../features/boostThanks/handler.js";
import { createApplicationEmojiProvider } from "../resources/applicationEmojis.js";
import { createBoostThanksStore } from "../storage/boostThanksStore.js";
import { createAlertOutbox } from "../alerts/alertOutbox.js";
import { createProductionAlertNotifier } from "../alerts/productionAlertNotifier.js";
import { setupGatewayLifecycleLogger } from "./gatewayLifecycleLogger.js";
import { createGatewayHealthMonitor } from "./gatewayHealthMonitor.js";
import { createStartupPreflight } from "./startupPreflight.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");

/**
 * TeaParty-Bell 主生命周期管理。
 *
 * 职责：
 * - 加载配置
 * - 初始化日志
 * - 创建 Alert Outbox + Notifier（告警基础设施）
 * - 创建 BoostThanks 持久化 Store（Phase 8）
 * - 启动时恢复扫描（Phase 8）
 * - 创建 Discord Client
 * - 注册 Gateway Lifecycle Logger
 * - 创建并启动 Gateway Health Monitor
 * - 创建 Emoji Provider / Handler / Observer
 * - 登录
 * - 等待首次 ClientReady
 * - 执行 Startup Preflight
 * - 处理进程退出信号
 */
export async function start() {
  // ---- 1. 加载配置 ----
  logger.info("正在加载配置...");
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`配置加载失败：${err.message}`);
    process.exit(1);
  }

  // ---- 2. 设置日志等级 ----
  setLogLevel(config.logLevel);
  logger.info("配置加载成功", {
    testMode: config.testMode,
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
    isProduction: config.isProduction,
  });

  if (config.testMode) {
    logger.info("⚡ 测试模式已启用 — 不会发送真实消息");
  }

  // ---- 2.5 告警基础设施（在 BoostThanksStore 之前，以便 outbox 故障能被记录） ----
  const alertsDir = resolve(projectRoot, "data", "runtime", "alerts");
  let outbox;
  try {
    outbox = createAlertOutbox({ alertsDir, logger });
  } catch (err) {
    console.error(`Alert Outbox 初始化失败：${err.message}`);
    process.exit(1);
  }

  const notifier = createProductionAlertNotifier({ outbox, logger });

  // 从 outbox 加载已有告警，重建 incident 状态（跨重启防重复）
  try {
    await notifier.initialize();
  } catch (err) {
    console.error(`Alert Outbox 加载失败，拒绝启动（fail closed）：${err.message}`);
    process.exit(1);
  }

  // ---- 3. 初始化持久化 Store 并执行启动恢复扫描（Phase 8）----
  const store = createBoostThanksStore({
    filePath: resolve(projectRoot, "data", "runtime", "boost-thanks-state.json"),
    logger,
  });

  try {
    await store.load();
  } catch (err) {
    logger.error("BoostThanks 状态文件加载失败，Bot 拒绝启动（fail closed）", {
      error: err.message,
    });
    process.exit(1);
  }

  // 恢复扫描：sending → uncertain，记录可恢复候选
  const allRecords = store.getAllRecords();
  let sendingCount = 0;
  for (const [key, record] of allRecords) {
    if (record.status === "sending") {
      await store.markUncertain(key, "bot_restart_after_sending");
      sendingCount++;
      logger.error("[BoostThanks] 发现 sending 状态残留（可能已发送），已标记为 uncertain", {
        aggregateKey: key,
        eventIds: record.eventIds,
        guildId: record.guildId,
        userId: record.userId,
      });
    }
  }
  if (sendingCount > 0) {
    logger.warn("[BoostThanks] 共转换 sending → uncertain", { count: sendingCount });
  }

  const recoverable = store.listRecoverable();
  if (recoverable.length > 0) {
    logger.warn("[BoostThanks] 发现可恢复的未完成事件（Phase 8 不自动重试）", {
      count: recoverable.length,
      statuses: [...new Set(recoverable.map((r) => r.status))],
    });
  }

  // ---- 4. 创建 Discord Client ----
  const { client, login, destroy, waitUntilReady } = createClient();

  // ---- 5. 注册 Gateway Lifecycle Logger ----
  const lifecycleLoggerCleanup = setupGatewayLifecycleLogger({ client, logger });

  // ---- 6. 创建并启动 Gateway Health Monitor ----
  const healthMonitor = createGatewayHealthMonitor({
    client,
    notifyFailure: (type, msg, details) => notifier.notifyFailure(type, msg, details),
    notifyRecovery: (type, msg) => notifier.notifyRecovery(type, msg),
    exitFn: (code) => process.exit(code),
    logger,
  });
  healthMonitor.start();

  // ---- 7. 创建 Feature 组件（须在登录前注册监听器）----
  const emojiProvider = createApplicationEmojiProvider(client, logger);
  const thanksHandler = createBoostThanksHandler({
    config,
    client,
    logger,
    emojiProvider,
    store,
  });
  const observerCleanup = setupBoostObserver(
    client,
    logger,
    config,
    (event) => thanksHandler.handleBoostEvent(event),
    config.discordGuildId
  );

  // ---- 8. 登录 ----
  try {
    await login(config.discordBotToken);
  } catch (err) {
    logger.error("Discord 登录失败", {
      message: err.message,
      code: err.code,
    });
    process.exit(1);
  }

  // ---- 9. 等待首次 ClientReady ----
  try {
    await waitUntilReady();
    logger.info("ClientReady 已确认");
  } catch (err) {
    logger.error("等待 ClientReady 时发生异常", { message: err.message });
    process.exit(1);
  }

  // ---- 10. 通知 Health Monitor 进入稳定监控状态 ----
  healthMonitor.onReady();

  // ---- 11. 执行 Startup Preflight ----
  const preflight = createStartupPreflight({
    client,
    config,
    logger,
    emojiProvider,
    notifyFailure: (type, msg, details) => notifier.notifyFailure(type, msg, details),
    notifyWarning: (type, msg, details) => notifier.notifyWarning(type, msg, details),
    exitFn: (code) => process.exit(code),
  });
  await preflight.run();

  // ---- 12. Preflight 通过，发送就绪通知 ----
  await notifier.notifyReadyAfterRestart();

  // ---- 13. 进程退出处理 ----
  async function shutdown(signal) {
    logger.info(`收到 ${signal} 信号，正在关闭...`);

    // 停止 Health Monitor（优先，防止退出过程中触发二次 exit）
    try {
      healthMonitor.stop();
    } catch (err) {
      logger.error("Health Monitor 停止时发生异常", { message: err.message });
    }

    // 移除生命周期监听器
    try {
      if (lifecycleLoggerCleanup) lifecycleLoggerCleanup.destroy();
    } catch (err) {
      logger.error("Lifecycle Logger 清理时发生异常", { message: err.message });
    }

    // 清理 Observer
    try {
      if (observerCleanup) observerCleanup.destroy();
    } catch (err) {
      logger.error("Observer 清理时发生异常", { message: err.message });
    }

    // 关闭 Store
    try {
      await store.close();
    } catch (err) {
      logger.error("Store 关闭时发生异常", { message: err.message });
    }

    // 关闭 Outbox
    try {
      await outbox.close();
    } catch (err) {
      logger.error("Outbox 关闭时发生异常", { message: err.message });
    }

    // 销毁 Discord Client
    try {
      await destroy();
    } catch (err) {
      logger.error("Discord 断开时发生异常", { message: err.message });
    }

    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 未捕获异常：记录后退出，不掩盖错误
  process.on("uncaughtException", (err) => {
    logger.error("未捕获的异常", { message: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("未处理的 Promise 拒绝", {
      message: reason?.message ?? String(reason),
    });
  });

  logger.info("TeaParty-Bell 启动完成 / operational");
  return { client, destroy, healthMonitor };
}
