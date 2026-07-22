import { loadConfig } from "../config/index.js";
import { setLogLevel, logger } from "../utils/logger.js";
import { createClient } from "../discord/client.js";
import { setupBoostObserver } from "../features/boostThanks/observer.js";
import { createBoostThanksHandler } from "../features/boostThanks/handler.js";
import { createApplicationEmojiProvider } from "../resources/applicationEmojis.js";

/**
 * TeaParty-Bell 主生命周期管理。
 *
 * 职责：
 * - 加载配置
 * - 初始化日志
 * - 创建 Discord Client
 * - 登录
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
  logger.info("配置加载成功", { testMode: config.testMode, logLevel: config.logLevel });

  if (config.testMode) {
    logger.info("⚡ 测试模式已启用 — 不会发送真实消息");
  }

  // ---- 3. 创建 Discord Client ----
  const { client, login, destroy } = createClient();

  // ---- 3.5 注册 Feature 监听器 + 感谢发送链路（须在登录前完成）----
  const emojiProvider = createApplicationEmojiProvider(client, logger);
  const thanksHandler = createBoostThanksHandler({ config, client, logger, emojiProvider });
  const observerCleanup = setupBoostObserver(
    client,
    logger,
    config,
    (event) => thanksHandler.handleBoostEvent(event)
  );

  // ---- 4. 登录 ----
  try {
    await login(config.discordBotToken);
  } catch (err) {
    logger.error("Discord 登录失败", {
      message: err.message,
      code: err.code,
    });
    process.exit(1);
  }

  // ---- 5. 进程退出处理 ----
  async function shutdown(signal) {
    logger.info(`收到 ${signal} 信号，正在关闭...`);
    try {
      if (observerCleanup) observerCleanup.destroy();
    } catch (err) {
      logger.error("Observer 清理时发生异常", { message: err.message });
    }
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

  logger.info("TeaParty-Bell 启动完成");
  return { client, destroy };
}
