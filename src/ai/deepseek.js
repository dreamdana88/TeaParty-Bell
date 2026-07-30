/**
 * @deprecated 仅保留给旧的直接导入路径。
 * 生产入口请使用 src/ai/index.js 的 createAiProvider。
 */
import { AiProviderError } from "./aiProviderError.js";
import { createOpenAICompatibleProvider } from "./openaiCompatible.js";

/** @deprecated 请改用 AiProviderError。 */
export { AiProviderError as DeepSeekError };

/**
 * @deprecated 请改用 createAiProvider(config)。
 * 将旧配置形状映射为通用 OpenAI-compatible Provider。
 */
export function createDeepSeekProvider(config, dependencies) {
  return createOpenAICompatibleProvider({
    aiChatCompletionsUrl: `${(config.deepseekBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "")}/chat/completions`,
    aiApiKey: config.deepseekApiKey,
    aiRequireApiKey: true,
    aiModel: config.deepseekModel || "deepseek-v4-flash",
    aiTimeoutMs: config.deepseekTimeoutMs ?? 30000,
    aiAuthHeader: "Authorization",
    aiAuthScheme: "Bearer",
    aiBackendLabel: "DeepSeek (legacy direct import)",
    aiExtraHeaders: {},
    aiExtraBody: {},
  }, dependencies);
}
