/**
 * Boost 感谢文案生成器（Phase 5）。
 *
 * 职责：
 * - 读取外置 Prompt 文件
 * - 将业务上下文传给统一 AI 入口
 * - 校验 AI 输出（禁止 Discord Mention / 自定义 Emoji）
 *
 * 不负责：
 * - 标题生成（见 messageBuilder.js）
 * - 消息发送
 * - Discord API 调用
 *
 * 不直接依赖 deepseek.js，必须通过 src/ai/index.js 调用 AI。
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { createAiProvider } from "../../ai/index.js";

// ---- 路径 ----
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, "..", "..", "..", "data", "prompts", "boost-thanks.md");

// ---- 禁用格式正则 ----
const RE_MENTION = /<@!?\d+>/;
const RE_CUSTOM_EMOJI = /<a?:\w+:\d+>/;

// ---- 工厂 ----

/**
 * 创建文案生成器。
 *
 * @param {object} config - 完整配置对象（来自 loadConfig()）
 * @param {{ generateText: Function }} [aiOverride] - 测试用 AI 替代实现
 * @returns {{ generateCopy: Function }}
 */
export function createCopyGenerator(config, aiOverride) {
  const ai = aiOverride ?? createAiProvider(config);

  // 读取外置 Prompt（同步读取，仅在创建时执行一次）
  const systemPrompt = _loadPrompt();

  /**
   * 为 Boost 事件生成感谢正文。
   *
   * @param {object} context
   * @param {string} context.userId       - 助力成员 Discord 用户 ID
   * @param {string|null} context.displayName - 服务器显示名
   * @param {number} context.boostCount   - 聚合后助力次数（≥1）
   * @param {string} [context.interest]   - 可选的兴趣标签（用于定制梗）
   * @returns {Promise<string>} 校验后的感谢正文
   * @throws {Error} AI 调用失败或输出不合规时抛出
   */
  async function generateCopy(context) {
    // ---- 1. 参数校验 ----
    if (!context || !context.userId || typeof context.userId !== "string") {
      throw new Error("generateCopy: userId 必须为非空字符串");
    }
    if (!Number.isInteger(context.boostCount) || context.boostCount < 1) {
      throw new Error(
        `generateCopy: boostCount 必须为正整数，收到：${context.boostCount}`
      );
    }

    // ---- 2. 构造用户消息 ----
    const userName = context.displayName || "新朋友";
    const boostLabel = context.boostCount === 1
      ? "1个助力"
      : `${context.boostCount}个助力`;

    let userMessage = `请为 "${userName}" 生成 Boost 感谢正文。`;
    userMessage += `\n助力数量：${boostLabel}`;

    if (context.interest && typeof context.interest === "string" && context.interest.trim()) {
      userMessage += `\n兴趣：${context.interest.trim()}`;
    }

    // ---- 3. 调用 AI ----
    const rawText = await ai.generateText(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        thinking: { type: "disabled" },
        maxTokens: 512,
      }
    );

    // ---- 4. 校验输出 ----
    const trimmed = rawText.trim();
    _validateCopy(trimmed);

    return trimmed;
  }

  return { generateCopy };
}

// ---- 内部工具 ----

/**
 * 读取外置 Prompt 文件。
 * @returns {string}
 */
function _loadPrompt() {
  try {
    return readFileSync(PROMPT_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `无法读取感谢文案 Prompt 文件：${PROMPT_PATH}（${err.message}）`
    );
  }
}

/**
 * 校验 AI 生成的正文。
 * 不合规时直接抛出，不使用固定兜底文案。
 *
 * @param {string} text - trim 后的正文
 * @throws {Error} 校验失败
 */
function _validateCopy(text) {
  // 非空
  if (!text || text === "") {
    throw new Error("AI 生成的正文为空");
  }

  // 长度上限（防止 AI 暴走）
  if (text.length > 600) {
    throw new Error(
      `AI 生成的正文过长（${text.length} 字符），疑似失控`
    );
  }

  // 禁止 Discord Mention
  if (RE_MENTION.test(text)) {
    throw new Error("AI 生成的正文包含 Discord Mention 格式，已拒绝");
  }

  // 禁止自定义 Emoji（含静态和动画）
  if (RE_CUSTOM_EMOJI.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 自定义 Emoji 格式，已拒绝");
  }
}

/**
 * 获取 Prompt 文件路径（供测试用）。
 * @returns {string}
 */
export function getPromptPath() {
  return PROMPT_PATH;
}
