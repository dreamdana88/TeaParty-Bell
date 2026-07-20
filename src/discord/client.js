import { Client, GatewayIntentBits, Events } from "discord.js";
import { logger } from "../utils/logger.js";

/**
 * 创建 Discord Client 实例。
 *
 * Phase 1–2 使用的 Gateway Intents：
 * - Guilds（非特权，无需 Developer Portal 额外开启）
 *   服务器基本信息。
 * - GuildMessages（非特权，无需 Developer Portal 额外开启）
 *   接收 MESSAGE_CREATE 事件。
 *   Phase 2 用于监听 GUILD_BOOST 系统消息（type 8/9/10/11）。
 *
 * 当前未使用任何 Privileged Intent。
 * Privileged Intent（需 Portal 开启 + 100 服务器以上需验证）：
 *   GuildMembers(2)、GuildPresences(256)、MessageContent(32768)
 *
 * 真实环境测试前置条件（Discord 服务器端）：
 * - 服务器设置 → 概览 → System Messages Channel 已设置
 * - 服务器设置 → 概览 → "Send a message when someone Boosts this server" 已开启
 * 未满足以上条件时 Boost 系统消息不会生成，BOT 将无事件可监听。
 *
 * @returns {{ client: Client, login: Function, destroy: Function }}
 */
export function createClient() {
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
    await client.destroy();
    logger.info("Discord 连接已关闭");
  }

  return { client, login, destroy };
}
