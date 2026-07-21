/**
 * Boost 感谢文案生成器（Phase 5）。
 *
 * 职责：
 * - 读取外置 Prompt 文件
 * - 将业务上下文传给统一 AI 入口
 * - 校验 AI 输出（禁止 Discord 特殊格式）
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

// ---- 正文限制 ----
const MAX_UNICODE_CHARS = 100;

// ---- 禁用格式正则 ----
// Discord 特殊格式：Mention / Emoji / Channel / Role / 群体 @ / Markdown 标题
const RE_USER_MENTION   = /<@!?\d+>/;       // <@123>  <@!123>
const RE_ROLE_MENTION   = /<@&\d+>/;         // <@&123>
const RE_CHANNEL_MENTION = /<#\d+>/;          // <#123>
const RE_EVERYONE_HERE  = /@(everyone|here)\b/i;
const RE_CUSTOM_EMOJI   = /<a?:\w+:\d+>/;    // <:name:id>  <a:name:id>
const RE_MD_HEADING     = /^\s*#{1,6}\s/m;    // #  到 ######

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
   * @param {string|null} context.displayName - 服务器显示名
   * @param {number} context.boostCount       - 聚合后助力次数（≥1）
   * @param {string} [context.interest]       - 可选的兴趣标签（用于定制梗）
   * @returns {Promise<string>} 校验后的感谢正文
   * @throws {Error} AI 调用失败或输出不合规时抛出
   */
  async function generateCopy(context) {
    // ---- 1. 参数校验 ----
    if (!context) {
      throw new Error("generateCopy: context 不能为空");
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

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
    const options = {
      thinking: { type: "disabled" },
      maxTokens: 128,
    };

    // ---- 3. 调用 AI ----
    const rawText = await ai.generateText(messages, options);

    // ---- 4. 校验输出 ----
    const trimmed = rawText.trim();
    _validateCopy(trimmed, messages, options);

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
 * @param {Array} [_msgs] - AI 请求 messages（仅供错误日志，不在此校验）
 * @param {object} [_opts] - AI 请求 options（仅供错误日志，不在此校验）
 * @throws {Error} 校验失败
 */
function _validateCopy(text, _msgs, _opts) {
  // 非空
  if (!text || text === "") {
    throw new Error("AI 生成的正文为空");
  }

  // Unicode 字符长度上限（正确处理 Emoji 等多字节字符）
  const charCount = Array.from(text).length;
  if (charCount > MAX_UNICODE_CHARS) {
    throw new Error(
      `AI 生成的正文过长（${charCount} 个 Unicode 字符，上限 ${MAX_UNICODE_CHARS}），疑似失控`
    );
  }

  // 禁止 Discord 用户 Mention
  if (RE_USER_MENTION.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 用户 Mention 格式，已拒绝");
  }

  // 禁止 Discord Role Mention
  if (RE_ROLE_MENTION.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 身份组 Mention 格式，已拒绝");
  }

  // 禁止 Discord Channel Mention
  if (RE_CHANNEL_MENTION.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 频道 Mention 格式，已拒绝");
  }

  // 禁止 @everyone / @here
  if (RE_EVERYONE_HERE.test(text)) {
    throw new Error("AI 生成的正文包含 @everyone / @here，已拒绝");
  }

  // 禁止自定义 Emoji（含静态和动画）
  if (RE_CUSTOM_EMOJI.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 自定义 Emoji 格式，已拒绝");
  }

  // 禁止 Markdown 标题（#  等）
  if (RE_MD_HEADING.test(text)) {
    throw new Error("AI 生成的正文包含 Markdown 标题格式，已拒绝");
  }
}

/**
 * 获取 Prompt 文件路径（供测试用）。
 * @returns {string}
 */
export function getPromptPath() {
  return PROMPT_PATH;
}
