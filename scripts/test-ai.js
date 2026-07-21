/**
 * DeepSeek API 真实环境 Smoke Test（Phase 4）。
 *
 * 使用 .env 中的真实 DEEPSEEK_API_KEY 验证 DeepSeek Provider
 * 基本连接和文本生成能力。
 *
 * 不依赖 Discord，不发送消息，不进入感谢业务流程。
 * 必须复用正式 src/ai/deepseek.js Provider，不得重复实现 API Client。
 *
 * 运行：node scripts/test-ai.js
 *  或：npm run test:ai
 */

import { loadConfig } from "../src/config/index.js";
import { createAiProvider } from "../src/ai/index.js";

const config = loadConfig();

// 检查 API Key
if (!config.deepseekApiKey) {
  console.error("❌ DEEPSEEK_API_KEY 未配置。请在 .env 中设置后重试。");
  process.exit(1);
}

const ai = createAiProvider(config);

console.log(`Base URL: ${config.deepseekBaseUrl}`);
console.log(`Timeout: ${config.deepseekTimeoutMs}ms`);
console.log("Sending test request...\n");

try {
  const result = await ai.generateText(
    [
      {
        role: "user",
        content: "请只回复：TeaParty-Bell AI connected",
      },
    ],
    {
      maxTokens: 50,
      thinking: { type: "disabled" },
    }
  );

  console.log("✅ DeepSeek API 连接成功！");
  console.log(`📝 返回内容：${result}`);
} catch (err) {
  console.error(`❌ DeepSeek API 测试失败`);
  console.error(`   错误码：${err.code ?? "N/A"}`);
  console.error(`   消息：${err.message}`);
  if (err.httpStatus) {
    console.error(`   HTTP Status：${err.httpStatus}`);
  }
  process.exit(1);
}
