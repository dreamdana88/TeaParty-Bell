/**
 * 感谢文案 OpenAI-compatible AI 测试。
 *
 * 使用 .env 中的 AI_*（或兼容的 DEEPSEEK_*）配置生成 Boost 感谢文案。
 * 不依赖 Discord，不发送消息。
 *
 * 运行：
 *   npm run test:copy                              # 默认 1 轮，随机风格
 *   COPY_TEST_MODELS="模型A,模型B" COPY_TEST_ROUNDS=10 npm run test:copy
 *   COPY_TEST_STYLE=fairyTale npm run test:copy      # 固定一种风格
 *   COPY_TEST_INTEREST=星露谷 npm run test:copy      # 指定兴趣
 */

import { loadConfig } from "../src/config/index.js";
import { createCopyGenerator } from "../src/features/boostThanks/copyGenerator.js";
import { buildTitle, assembleMessage } from "../src/features/boostThanks/messageBuilder.js";
import { parseCopyTestModels, runCopyTest } from "./copyTestRunner.js";

const config = loadConfig();

const TEST_USER_ID = process.env.COPY_TEST_USER_ID || "1426581758194876577";
const TEST_INTEREST = process.env.COPY_TEST_INTEREST || "";
const ROUNDS = Math.max(1, parseInt(process.env.COPY_TEST_ROUNDS, 10) || 1);
const FIXED_STYLE = process.env.COPY_TEST_STYLE || "";

const MODELS = parseCopyTestModels(process.env.COPY_TEST_MODELS, config.aiModel);

console.log("========================================");
console.log("  茶话会 Boost 感谢文案测试（Phase 5）");
console.log("========================================");
console.log(`  Backend: ${config.aiBackendLabel}`);
console.log(`  Endpoint: ${config.aiChatCompletionsUrl}`);
console.log(`  Model: ${MODELS.join(", ")}`);
console.log(`  User ID: ${TEST_USER_ID}`);
if (TEST_INTEREST) console.log(`  Interest: ${TEST_INTEREST}`);
else console.log("  Interest: (无)");
if (FIXED_STYLE) console.log(`  Style: ${FIXED_STYLE}（固定）`);
else console.log("  Style: 随机抽签");
console.log(`  Rounds: ${ROUNDS}`);
console.log("========================================\n");

await runCopyTest({
  config,
  models: MODELS,
  rounds: ROUNDS,
  userId: TEST_USER_ID,
  interest: TEST_INTEREST,
  fixedStyle: FIXED_STYLE,
  createCopyGeneratorFn: createCopyGenerator,
  buildTitleFn: buildTitle,
  assembleMessageFn: assembleMessage,
});
