/**
 * 真实发送链路测试（Phase 6–7）。
 *
 * 模拟一条聚合后的 BoostEvent，完整测试：
 * 真实 AI 生成 → 标题构造 → 消息拼装 → 发送到 DISCORD_THANKS_CHANNEL_ID
 * → Application Emoji 获取 → 随机选择 → 添加 Reaction。
 *
 * ⚠️ 安全机制：
 *   必须同时设置 ALLOW_TEST_SEND=true 和 SEND_TEST_USER_ID 才会执行真实发送。
 *   否则脚本立即退出。
 *
 * 运行：
 *   $env:SEND_TEST_USER_ID="你的Discord用户ID"
 *   $env:SEND_TEST_BOOST_COUNT="2"
 *   $env:ALLOW_TEST_SEND="true"
 *   npm run test:send
 */

import { Client, GatewayIntentBits } from "discord.js";
import { loadConfig } from "../src/config/index.js";
import { createBoostThanksHandler } from "../src/features/boostThanks/handler.js";
import { buildTitle } from "../src/features/boostThanks/messageBuilder.js";
import { createApplicationEmojiProvider } from "../src/resources/applicationEmojis.js";

// ---- 安全检查 ----
if (process.env.ALLOW_TEST_SEND !== "true") {
  console.log("⚠️  真实发送测试未启用。");
  console.log("   请设置 ALLOW_TEST_SEND=true 后重新运行。");
  process.exit(0);
}

const config = loadConfig();

if (!config.discordBotToken) {
  console.error("❌ DISCORD_BOT_TOKEN 未配置。");
  process.exit(1);
}

if (!process.env.SEND_TEST_USER_ID) {
  console.error("❌ SEND_TEST_USER_ID 未设置。请设置环境变量 SEND_TEST_USER_ID 后重试。");
  console.error("   示例：$env:SEND_TEST_USER_ID=\"你的Discord用户ID\"");
  process.exit(1);
}
const TEST_USER_ID = process.env.SEND_TEST_USER_ID;
const TEST_BOOST_COUNT = Math.max(1, parseInt(process.env.SEND_TEST_BOOST_COUNT, 10) || 2);

// ---- 创建临时 Client（仅本次测试）----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

try {
  // 登录
  console.log("正在连接 Discord...");
  await client.login(config.discordBotToken);
  console.log(`已登录：${client.user.tag}\n`);

  // 创建 Handler（含 emojiProvider，完整覆盖 Reaction 链路）
  const emojiProvider = createApplicationEmojiProvider(client);
  const handler = createBoostThanksHandler({
    config,
    client,
    logger: {
      info: (msg, data) => console.log(`[INFO] ${msg}`, data ?? ""),
      error: (msg, data) => console.error(`[ERROR] ${msg}`, data ?? ""),
      warn: (msg, data) => console.warn(`[WARN] ${msg}`, data ?? ""),
      debug: () => {},
    },
    emojiProvider,
  });

  // 模拟 BoostEvent
  const mockEvent = {
    eventType: "boost",
    eventId: "test-send-mock",
    userId: TEST_USER_ID,
    username: null,
    displayName: null,
    guildId: config.discordGuildId,
    sourceChannelId: null,
    timestamp: Date.now(),
    boostCount: TEST_BOOST_COUNT,
    eventIds: ["test-send-mock-event"],
  };

  console.log("测试事件：");
  console.log(`  userId:     ${mockEvent.userId}`);
  console.log(`  boostCount: ${mockEvent.boostCount}`);
  console.log(`  channelId:  ${config.discordThanksChannelId}`);
  console.log();

  // 构建预期标题（预览用）
  const previewTitle = buildTitle(mockEvent.userId, mockEvent.boostCount);
  console.log("预期标题：");
  console.log(`  ${previewTitle}`);
  console.log();

  // 执行发送
  console.log("正在生成 AI 正文并发送...\n");
  const success = await handler.handleBoostEvent(mockEvent);

  if (success) {
    console.log("\n✅ 真实发送测试完成！请到感谢频道确认消息内容。");
  } else {
    console.log("\n❌ 真实发送测试失败，请查看上方错误日志。");
  }
} catch (err) {
  console.error(`❌ 测试脚本异常：${err.message}`);
} finally {
  console.log("\n正在断开 Discord...");
  await client.destroy();
  console.log("已断开。");
}
