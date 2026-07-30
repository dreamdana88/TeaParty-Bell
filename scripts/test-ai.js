/**
 * OpenAI-compatible API 真实环境 Smoke Test。
 *
 * 使用 .env 中配置的通用 AI Provider
 * 基本连接和文本生成能力。
 *
 * 不依赖 Discord，不发送消息，不进入感谢业务流程。
 * 必须复用 src/ai/index.js 统一 AI 入口，不得重复实现 API Client。
 *
 * 运行：node scripts/test-ai.js
 *  或：npm run test:ai
 */

import { loadConfig } from "../src/config/index.js";
import { createAiProvider } from "../src/ai/index.js";

const config = loadConfig();

const ai = createAiProvider(config);

console.log(`Backend: ${config.aiBackendLabel}`);
console.log(`Endpoint: ${config.aiChatCompletionsUrl}`);
console.log(`Model: ${config.aiModel}`);
console.log(`Timeout: ${config.aiTimeoutMs}ms`);
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
    }
  );

  console.log("✅ AI Provider 连接成功！");
  console.log(`📝 返回内容：${result}`);
} catch (err) {
  console.error(`❌ AI Provider 测试失败`);
  console.error(`   错误码：${err.code ?? "N/A"}`);
  console.error(`   消息：${err.message}`);
  if (err.httpStatus) {
    console.error(`   HTTP Status：${err.httpStatus}`);
  }
  process.exit(1);
}
