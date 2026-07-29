/**
 * TeaParty-Bell 主生命周期管理。
 *
 * 支持依赖注入以进行自动测试。
 * 生产默认值使用现有真实模块。
 */

import { loadConfig, ConfigError } from "../config/index.js";
import { setLogLevel, logger as defaultLogger } from "../utils/logger.js";
import { createClient } from "../discord/client.js";
import { setupBoostObserver } from "../features/boostThanks/observer.js";
import { createBoostThanksHandler } from "../features/boostThanks/handler.js";
import { createApplicationEmojiProvider } from "../resources/applicationEmojis.js";
import { createBoostThanksStore } from "../storage/boostThanksStore.js";
import { createAlertOutbox, OutboxError } from "../alerts/alertOutbox.js";
import { createProductionAlertNotifier } from "../alerts/productionAlertNotifier.js";
import { setupGatewayLifecycleLogger } from "./gatewayLifecycleLogger.js";
import { createGatewayHealthMonitor } from "./gatewayHealthMonitor.js";
import { createStartupPreflight } from "./startupPreflight.js";
import { createManualMessageService } from "../features/manualMessage/service.js";
import { createManualInteractionRouter } from "../features/manualMessage/interactionRouter.js";
import { createForumBumpRuntime } from "../features/forumBump/runtime.js";
import {
  createInstanceLock,
  InstanceLockError,
  INSTANCE_LOCK_BUSY_EXIT_CODE,
} from "./instanceLock.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _defaultProjectRoot = resolve(__dirname, "..", "..");

export const EXIT_OK = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_PERMANENT = 78;

function safeStartupErrorFields(error) {
  return {
    errorName: typeof error?.name === "string" ? error.name : "Error",
    errorCode: error?.code ?? null,
  };
}

function safeStartupLog(logger, message, error) {
  try {
    logger.error(message, safeStartupErrorFields(error));
  } catch {
    // 启动错误日志自身失败不能改变既定退出路径。
  }
}

async function safelyDestroyManualRouter(router, logger, message) {
  if (!router || typeof router.destroy !== "function") return;
  try {
    await router.destroy();
  } catch (error) {
    safeStartupLog(logger, message, error);
  }
}

/**
 * 启动 TeaParty-Bell。
 *
 * 支持注入以下依赖（测试用）：
 *   loadConfigFn, createClientFn, createAlertOutboxFn, createNotifierFn,
 *   createStoreFn, createHealthMonitorFn, createPreflightFn,
 *   setupLifecycleLoggerFn, setupObserverFn, createHandlerFn, createEmojiProviderFn,
 *   createManualMessageServiceFn, createManualInteractionRouterFn,
 *   logger, exitFn, processLike, projectRoot
 *
 * @returns {Promise<{client: object, destroy: Function, healthMonitor: object}|undefined>}
 */
export async function start(options = {}) {
  const {
    loadConfigFn = loadConfig,
    createClientFn = createClient,
    createAlertOutboxFn = createAlertOutbox,
    createNotifierFn = createProductionAlertNotifier,
    createStoreFn = createBoostThanksStore,
    createHealthMonitorFn = createGatewayHealthMonitor,
    createPreflightFn = createStartupPreflight,
    setupLifecycleLoggerFn = setupGatewayLifecycleLogger,
    setupObserverFn = setupBoostObserver,
    createHandlerFn = createBoostThanksHandler,
    createEmojiProviderFn = createApplicationEmojiProvider,
    createManualMessageServiceFn = createManualMessageService,
    createManualInteractionRouterFn = createManualInteractionRouter,
    createForumBumpRuntimeFn = createForumBumpRuntime,
    createInstanceLockFn = createInstanceLock,
    logger = defaultLogger,
    exitFn = (code) => process.exit(code),
    processLike = process,
    projectRoot = _defaultProjectRoot,
    /** 测试可跳过单实例锁 */
    skipInstanceLock = false,
  } = options;

  // ---- 1. 加载配置 ----
  logger.info("正在加载配置...");
  let config;
  try {
    config = loadConfigFn();
  } catch (err) {
    const exitCode = err instanceof ConfigError ? err.exitCode : EXIT_RUNTIME;
    logger.error ? logger.error("配置加载失败", { message: err.message, exitCode })
      : console.error(`配置加载失败（exit ${exitCode}）：${err.message}`);
    exitFn(exitCode);
    return;
  }

  // ---- 2. 设置日志等级 ----
  setLogLevel(config.logLevel);
  logger.info("配置加载成功", {
    testMode: config.testMode,
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
    isProduction: config.isProduction,
    forumBumpMode: config.forumBump?.mode ?? "disabled",
  });
  if (config.testMode) logger.info("⚡ 测试模式已启用 — 不会发送真实消息");

  // ---- 2b. 跨进程单实例锁（Discord 登录前）----
  let instanceLock = null;
  if (!skipInstanceLock) {
    try {
      instanceLock = createInstanceLockFn({
        lockPath: resolve(projectRoot, "data", "runtime", "teaparty-bell.instance.lock"),
      });
      instanceLock.acquire();
      logger.info("实例锁已获取", { lockPath: instanceLock.lockPath });
    } catch (err) {
      const exitCode = err instanceof InstanceLockError
        ? err.exitCode
        : INSTANCE_LOCK_BUSY_EXIT_CODE;
      logger.error
        ? logger.error("实例锁获取失败，拒绝启动（避免多进程竞争状态/告警）", {
          message: err.message,
          code: err.code ?? null,
          exitCode,
        })
        : console.error(`实例锁失败（exit ${exitCode}）：${err.message}`);
      exitFn(exitCode);
      return;
    }
  }

  // ---- 3. 告警基础设施 ----
  const alertsDir = resolve(projectRoot, "data", "runtime", "alerts");
  let outbox;
  try {
    outbox = createAlertOutboxFn({ alertsDir, logger });
    outbox.verifyWritable();
  } catch (err) {
    try { instanceLock?.release(); } catch { /* ignore */ }
    const exitCode = err instanceof OutboxError ? EXIT_PERMANENT : EXIT_RUNTIME;
    logger.error ? logger.error("Alert Outbox 初始化失败", { message: err.message, exitCode })
      : console.error(`Alert Outbox 初始化失败（exit ${exitCode}）：${err.message}`);
    exitFn(exitCode);
    return;
  }

  const notifier = createNotifierFn({ outbox, logger });
  try { await notifier.initialize(); }
  catch (err) {
    try { instanceLock?.release(); } catch { /* ignore */ }
    logger.error ? logger.error("Alert Outbox 加载失败，拒绝启动", { message: err.message })
      : console.error(`Alert Outbox 加载失败，拒绝启动（exit ${EXIT_PERMANENT}）：${err.message}`);
    exitFn(EXIT_PERMANENT);
    return;
  }

  // ---- 4. BoostThanks Store（Phase 8）----
  const store = createStoreFn({
    filePath: resolve(projectRoot, "data", "runtime", "boost-thanks-state.json"),
    logger,
  });
  try { await store.load(); }
  catch (err) {
    try { instanceLock?.release(); } catch { /* ignore */ }
    logger.error("BoostThanks 状态文件加载失败，Bot 拒绝启动（fail closed）", { error: err.message });
    exitFn(EXIT_PERMANENT);
    return;
  }

  // 恢复扫描
  const allRecords = store.getAllRecords();
  let sendingCount = 0;
  for (const [key, record] of allRecords) {
    if (record.status === "sending") {
      await store.markUncertain(key, "bot_restart_after_sending");
      sendingCount++;
      logger.error("[BoostThanks] 发现 sending 状态残留，已标记为 uncertain", { aggregateKey: key });
    }
  }
  if (sendingCount > 0) logger.warn("[BoostThanks] 共转换 sending → uncertain", { count: sendingCount });

  // ---- 5. 创建 Discord Client ----
  const { client, login, destroy, waitUntilReady } = createClientFn();

  // ---- 6. 注册 Gateway Lifecycle Logger ----
  const lifecycleLoggerCleanup = setupLifecycleLoggerFn({ client, logger });

  // ---- 7. 创建并启动 Gateway Health Monitor ----
  const healthMonitor = createHealthMonitorFn({
    client,
    notifyFailure: (type, msg, details) => notifier.notifyFailure(type, msg, details),
    notifyRecovery: (type, msg) => notifier.notifyRecovery(type, msg),
    exitFn,
    logger,
    alertPersistenceFailureExitCode: EXIT_PERMANENT,
  });
  healthMonitor.start();

  // ---- 8. 创建 Feature 组件 ----
  const emojiProvider = createEmojiProviderFn(client, logger);
  const thanksHandler = createHandlerFn({ config, client, logger, emojiProvider, store });
  const observerCleanup = setupObserverFn(
    client, logger, config,
    (event) => thanksHandler.handleBoostEvent(event),
    config.discordGuildId
  );

  // ---- 9. 登录 ----
  try { await login(config.discordBotToken); }
  catch (err) {
    try { instanceLock?.release(); } catch { /* ignore */ }
    logger.error("Discord 登录失败", { message: err.message, code: err.code });
    exitFn(EXIT_RUNTIME);
    return;
  }

  // ---- 10. 等待首次 ClientReady ----
  try { await waitUntilReady(); logger.info("ClientReady 已确认"); }
  catch (err) {
    try { instanceLock?.release(); } catch { /* ignore */ }
    logger.error("等待 ClientReady 时发生异常", { message: err.message });
    exitFn(EXIT_RUNTIME);
    return;
  }

  // ---- 11. 通知 Health Monitor 进入稳定监控 ----
  healthMonitor.onReady();

  // ---- 12. 执行 Startup Preflight ----
  const preflight = createPreflightFn({
    client, config, logger, emojiProvider,
    notifyFailure: (type, msg, details) => notifier.notifyFailure(type, msg, details),
    notifyWarning: (type, msg, details) => notifier.notifyWarning(type, msg, details),
    exitFn,
  });

  const preflightResult = await preflight.run();

  // Preflight 失败 → 不继续（preflight 内部已调用 exitFn）
  if (!preflightResult.passed) {
    return;
  }

  // ---- 13. Preflight 通过 → 创建并启动人工回复链路 ----
  let manualMessageService;
  let manualInteractionRouter;
  try {
    manualMessageService = createManualMessageServiceFn({ client, config, logger });
    manualInteractionRouter = createManualInteractionRouterFn({
      client,
      manualMessageService,
      guildId: config.discordGuildId,
      logger,
    });
    await manualInteractionRouter.start();
  } catch (error) {
    await safelyDestroyManualRouter(manualInteractionRouter, logger, "Manual Interaction Router 清理异常");
    try { instanceLock?.release(); } catch { /* ignore */ }
    safeStartupLog(logger, "Manual Message Service / Interaction Router 初始化失败，拒绝继续运行", error);
    exitFn(EXIT_RUNTIME);
    return;
  }

  // ---- 13b. Forum Bump Runtime（Preflight 成功后）----
  let forumBumpRuntime = null;
  try {
    forumBumpRuntime = createForumBumpRuntimeFn({
      client,
      config,
      logger,
      alertNotifier: notifier,
      statePath: config.forumBump?.statePath,
    });
    const fbStart = await forumBumpRuntime.start();
    // 关键失败：状态损坏且无法启动、告警持久化失败等
    if (fbStart && fbStart.success === false) {
      const code = fbStart.errorCode ?? "FORUM_BUMP_START_FAILED";
      // 状态/告警类 fail closed；recovery 待处理则允许其他功能继续
      if (
        code === "ALERT_PERSISTENCE_FAILED"
        || code === "STATE_NOT_FOUND"
        || code === "STATE_READ_FAILED"
        || code === "STATE_INVALID"
        || code === "STATE_RECOVERY_FAILED"
        || code === "STATE_WRITE_FAILED"
      ) {
        try {
          await forumBumpRuntime.stop();
        } catch { /* ignore */ }
        await safelyDestroyManualRouter(manualInteractionRouter, logger, "Forum Bump 启动失败后清理 Router");
        try { instanceLock?.release(); } catch { /* ignore */ }
        safeStartupLog(logger, "Forum Bump Runtime 启动失败，拒绝继续运行", { code });
        exitFn(EXIT_PERMANENT);
        return;
      }
      // 其他 start 失败：仍允许 Bot 其他功能（无 Forum timer）
      logger.warn?.("[Bot] Forum Bump Runtime 未完全启动，其他功能继续", {
        errorCode: code,
        recoveryStatus: fbStart.recoveryStatus ?? null,
      });
    }
  } catch (error) {
    try {
      if (forumBumpRuntime) await forumBumpRuntime.stop();
    } catch { /* ignore */ }
    await safelyDestroyManualRouter(manualInteractionRouter, logger, "Forum Bump 异常后清理 Router");
    try { instanceLock?.release(); } catch { /* ignore */ }
    safeStartupLog(logger, "Forum Bump Runtime 初始化异常，拒绝继续运行", error);
    exitFn(EXIT_PERMANENT);
    return;
  }

  // ---- 14. Router + Forum Bump 后 → 发送就绪通知 ----
  let readyResult;
  try {
    readyResult = await notifier.notifyReadyAfterRestart();
  } catch (err) {
    try { if (forumBumpRuntime) await forumBumpRuntime.stop(); } catch { /* ignore */ }
    await safelyDestroyManualRouter(manualInteractionRouter, logger, "Router 启动后清理失败");
    try { instanceLock?.release(); } catch { /* ignore */ }
    safeStartupLog(logger, "[Bot] notifyReadyAfterRestart 持久化失败，拒绝继续运行", err);
    exitFn(EXIT_PERMANENT);
    return;
  }

  // 检查 recovery 是否有失败
  if (readyResult && readyResult.failedRecoveries && readyResult.failedRecoveries.length > 0) {
    try { if (forumBumpRuntime) await forumBumpRuntime.stop(); } catch { /* ignore */ }
    await safelyDestroyManualRouter(manualInteractionRouter, logger, "Router 启动后清理失败");
    try { instanceLock?.release(); } catch { /* ignore */ }
    try {
      logger.error("[Bot] 部分 Recovery 持久化失败", { count: readyResult.failedRecoveries.length });
    } catch {
      // 日志设施失败不能掩盖 EXIT_PERMANENT 路径。
    }
    exitFn(EXIT_PERMANENT);
    return;
  }

  // ---- 15. 进程退出处理 ----
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal} 信号，正在关闭...`);
    // 先停 Forum Bump（等待 send/delete/complete 收尾），再 destroy Discord
    try {
      if (forumBumpRuntime) await forumBumpRuntime.stop();
    } catch (err) {
      logger.error("Forum Bump Runtime 停止异常", { message: err.message });
    }
    try { healthMonitor.stop(); } catch (err) { logger.error("Health Monitor 停止异常", { message: err.message }); }
    try { if (lifecycleLoggerCleanup) lifecycleLoggerCleanup.destroy(); } catch (err) { logger.error("Lifecycle Logger 清理异常", { message: err.message }); }
    try { if (observerCleanup) observerCleanup.destroy(); } catch (err) { logger.error("Observer 清理异常", { message: err.message }); }
    try { if (manualInteractionRouter) manualInteractionRouter.destroy(); } catch (err) { logger.error("Manual Interaction Router 清理异常", { message: err.message }); }
    try { await store.close(); } catch (err) { logger.error("Store 关闭异常", { message: err.message }); }
    try { await outbox.close(); } catch (err) { logger.error("Outbox 关闭异常", { message: err.message }); }
    try { await destroy(); } catch (err) { logger.error("Discord 断开异常", { message: err.message }); }
    try { instanceLock?.release(); } catch (err) { logger.error("实例锁释放异常", { message: err.message }); }
    exitFn(EXIT_OK);
  }

  // 信号处理仅在 operational 后注册（避免在 preflight 阶段被信号中断）
  if (processLike.on) {
    processLike.on("SIGINT", () => { void shutdown("SIGINT"); });
    processLike.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  }
  processLike.on?.("uncaughtException", (err) => {
    logger.error("未捕获的异常", { message: err.message, stack: err.stack });
    exitFn(EXIT_RUNTIME);
  });
  processLike.on?.("unhandledRejection", (reason) => {
    logger.error("未处理的 Promise 拒绝", { message: reason?.message ?? String(reason) });
  });

  logger.info("TeaParty-Bell 启动完成 / operational");
  return {
    client,
    destroy,
    healthMonitor,
    forumBumpRuntime,
    shutdown,
  };
}
