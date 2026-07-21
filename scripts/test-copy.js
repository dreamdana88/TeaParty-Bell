/**
 * 感谢文案真实 AI 测试（Phase 5）。
 *
 * 使用 .env 中的真实 DEEPSEEK_API_KEY 生成 Boost 感谢文案。
 * 不依赖 Discord，不发送消息。
 *
 * 必须复用正式 src/features/boostThanks/ 业务模块，
 * 不得重复实现 Prompt 或 AI Client。
 *
 * 运行：node scripts/test-copy.js
 *  或：npm run test:copy
 */

import { loadConfig } from "../src/config/index.js";
import { createCopyGenerator } from "../src/features/boostThanks/copyGenerator.js";
import { buildTitle, assembleMessage } from "../src/features/boostThanks/messageBuilder.js";

const config = loadConfig();

if (!config.deepseekApiKey) {
  console.error("❌ DEEPSEEK_API_KEY 未配置。请在 .env 中设置后重试。");
  process.exit(1);
}

// 测试参数（可修改）
const TEST_USER_ID = process.env.COPY_TEST_USER_ID || "1426581758194876577";
const TEST_DISPLAY_NAME = process.env.COPY_TEST_DISPLAY_NAME || "Dreamdana";
const TEST_INTEREST = process.env.COPY_TEST_INTEREST || "星露谷、SillyTavern、AI 工具";

const copyGenerator = createCopyGenerator(config);

console.log("========================================");
console.log("  茶话会 Boost 感谢文案测试（Phase 5）");
console.log("========================================");
console.log(`  User ID: ${TEST_USER_ID}`);
console.log(`  Display Name: ${TEST_DISPLAY_NAME}`);
console.log(`  Interest: ${TEST_INTEREST}`);
console.log("========================================\n");

for (const boostCount of [1, 2, 3]) {
  console.log(`── boostCount = ${boostCount} ──\n`);

  try {
    const title = buildTitle(TEST_USER_ID, boostCount);
    const body = await copyGenerator.generateCopy({
      userId: TEST_USER_ID,
      displayName: TEST_DISPLAY_NAME,
      boostCount,
      interest: TEST_INTEREST,
    });
    const message = assembleMessage(title, body);
    console.log(message);
  } catch (err) {
    console.error(`❌ 生成失败：${err.message}`);
    if (err.code) {
      console.error(`   错误码：${err.code}`);
    }
  }

  console.log("\n");
}
