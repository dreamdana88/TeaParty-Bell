import { Client, GatewayIntentBits, Events } from "discord.js";
import { logger } from "../utils/logger.js";

/**
 * 创建 Discord Client 实例。
 *
 * Phase 1 只使用最小必要 Intents：
 * - Guilds：服务器基本信息
 * - GuildMessages：消息发送
 *
 * 后续 Phase 需要监听 Boost 事件时会在此处补充。
 *
 * @param {object} config - 完整配置对象（来自 config 模块）
 * @returns {Client}
 */
export function createClient(config) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

  // ---- 就绪事件 ----
  client.once(Events.ClientReady, (readyClient) => {
    logger.info("Discord BOT 已就绪", {
      tag: readyClient.user.tag,
      id: readyClient.user.id,
    });
  });

  // ---- 全局异常事件 ----
  client.on(Events.Error, (error) => {
    logger.error("Discord Client 发生错误", {
      message: error.message,
      name: error.name,
    });
  });

  // ---- 调试：捕获未归类 warning ----
  client.on(Events.Warn, (warning) => {
    logger.warn("Discord Client 警告", { warning });
  });

  /**
   * 登录 Discord 并返回 Client。
   * Token 由调用方提供，不在此处读取配置。
   */
  async function login(token) {
    logger.info("正在登录 Discord...");
    await client.login(token);
    return client;
  }

  /**
   * 安全退出。
   */
  async function destroy() {
    logger.info("正在断开 Discord 连接...");
    client.destroy();
    logger.info("Discord 连接已关闭");
  }

  return { client, login, destroy };
}
