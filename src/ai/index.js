/**
 * ai/ 模块统一入口（Phase 4）。
 *
 * 为业务模块提供稳定的通用 AI 文本生成接口。
 * 业务代码不应直接依赖 deepseek.js 或 createDeepSeekProvider。
 *
 * 当前仅内部调用 DeepSeek Provider。
 * 不实现多 Provider 路由、fallback 或复杂工厂。
 */

import { createDeepSeekProvider } from "./deepseek.js";

/**
 * 创建 AI Provider。
 *
 * @param {object} config - 完整配置对象（来自 loadConfig()）
 * @returns {{ generateText: Function }}
 */
export function createAiProvider(config) {
  const provider = createDeepSeekProvider(config);

  /**
   * 生成文本。
   *
   * @param {Array<{ role: string, content: string }>} messages
   * @param {object} [options]
   * @param {number} [options.maxTokens]
   * @param {{ type: "enabled"|"disabled" }} [options.thinking]
   * @returns {Promise<string>} 标准化最终文本
   * @throws {DeepSeekError} 所有错误均以此类型（或其子类）抛出
   */
  async function generateText(messages, options) {
    return provider.chat(messages, options);
  }

  return { generateText };
}
