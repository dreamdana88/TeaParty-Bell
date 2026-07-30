/**
 * ai/ 模块统一入口（Phase 4）。
 *
 * 为业务模块提供稳定的通用 AI 文本生成接口。
 * 业务代码不应直接依赖具体 Provider 实现。
 */

import { createOpenAICompatibleProvider } from "./openaiCompatible.js";

/**
 * 创建 AI Provider。
 *
 * @param {object} config - 完整配置对象（来自 loadConfig()）
 * @returns {{ generateText: Function }}
 */
export function createAiProvider(config) {
  const provider = createOpenAICompatibleProvider(config);

  /**
   * 生成文本。
   *
   * @param {Array<{ role: string, content: string }>} messages
   * @param {object} [options]
   * @param {number} [options.maxTokens]
   * @returns {Promise<string>} 标准化最终文本
   * @throws {Error} 调用失败时抛出错误，错误含 code 属性标识类型
   */
  async function generateText(messages, options) {
    return provider.chat(messages, options);
  }

  return { generateText };
}
