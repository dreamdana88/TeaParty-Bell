/**
 * Boost 感谢文案生成器（Phase 5）。
 *
 * 职责：
 * - 读取外置 Prompt 文件
 * - 轻量随机风格抽签（降低 AI 腔和模板化）
 * - 将风格指令传给统一 AI 入口
 * - 校验 AI 输出（禁止 Discord 特殊格式）
 *
 * AI 只知道风格方向和可选的兴趣信息。
 * 用户身份（userId / displayName）和 Boost 数量由 messageBuilder 负责。
 *
 * 不负责：
 * - 标题生成（见 messageBuilder.js）
 * - 消息发送
 * - Discord API 调用
 *
 * 不直接依赖 deepseek.js，必须通过 src/ai/index.js 调用 AI。
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { createAiProvider } from "../../ai/index.js";

// ---- 路径 ----
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "prompts",
  "boost-thanks.md",
);

// ---- 正文限制 ----
const MAX_UNICODE_CHARS = 100;

// ---- 禁用格式正则 ----
const RE_USER_MENTION = /<@!?\d+>/;
const RE_ROLE_MENTION = /<@&\d+>/;
const RE_CHANNEL_MENTION = /<#\d+>/;
const RE_EVERYONE_HERE = /@(everyone|here)\b/i;
const RE_CUSTOM_EMOJI = /<a?:\w+:\d+>/;
const RE_MD_HEADING = /^\s*#{1,6}\s/m;

// =========================================================================
// 风格抽签系统
// =========================================================================

const STYLE_POOL = [
  { key: "lifeBlessing", weight: 20 },
  { key: "fairyTale", weight: 15 },
  { key: "abstractChaos", weight: 15 },
  { key: "oneLiner", weight: 15 },
  { key: "gentleBlessing", weight: 10 },
  { key: "antiRoutine", weight: 10 },
  { key: "lightTavern", weight: 10 },
  { key: "aiGamer", weight: 5 },
];

const STYLE_HINTS = {
  lifeBlessing:
    "本次风格方向：可爱的生活祝福。围绕吃饭、睡觉、天气、钱、工作和日常小事进行具体又惊喜的温暖祝福。" +
    "允许一本正经地胡说八道。",

  fairyTale:
    "本次风格方向：童话梦幻风。创造奇幻的法术、神奇的魔法生物、独特的食物、天气、动物、植物或奇怪好运。" +
    "可以天马行空，不要解释世界观。",

  abstractChaos:
    "本次风格方向：互联网抽象玩梗。像群友突然冒出来的一句话。允许跳跃、荒诞、没头没尾，但要自然、轻盈、不冒犯女性。" +
    "不要玩冒犯女性的恶俗烂梗！",
  oneLiner:
    "本次风格方向：一句话突然搞笑。保持简短。可以前半句正常，后半句突然拐弯，措手不及。",

  gentleBlessing:
    "本次风格方向：温柔祝福。真诚、自然、有生命力。避免鸡汤、宏大叙事和万能成功学。",

  antiRoutine:
    "本次风格方向：反套路戏精。可以模仿霸总、广告、天气预报、新闻播报、系统通知等语气，" +
    "然后突然转成温暖真诚的祝福。",

  lightTavern:
    "本次风格方向：轻度酒馆梗。允许使用 1 到 2 个 SillyTavern 玩家熟悉的梗进行对用户RP人生的美好祝福，" +
    "但禁止术语堆砌。融入自然口语。",

  aiGamer:
    "本次风格方向：AI 玩家怪梗。可以玩模型、厂商、截断、复读等社区梗。" +
    "优先创造新表达，避免机械重复已有固定梗（如'模型不炸显存''截断'等）。" +
    "可以自然使用少量技术术语。",
};

const TECH_STYLE_KEYS = new Set(["lightTavern", "aiGamer"]);

const NON_TECH_RESTRICTION =
  "本次创作请完全围绕指定风格展开，并时刻注意反男凝、男本位、厌女辱女恶俗烂梗。女性始终为社区第一性，尊重女性为第一位。";

// ---- 导出（供测试） ----

export function pickStyle() {
  const totalWeight = STYLE_POOL.reduce((sum, s) => sum + s.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const entry of STYLE_POOL) {
    rand -= entry.weight;
    if (rand <= 0) return { key: entry.key, hint: STYLE_HINTS[entry.key] };
  }
  const last = STYLE_POOL[STYLE_POOL.length - 1];
  return { key: last.key, hint: STYLE_HINTS[last.key] };
}

export function isTechStyle(key) {
  return TECH_STYLE_KEYS.has(key);
}

export function getStyleKeys() {
  return STYLE_POOL.map((s) => s.key);
}

// ---- 工厂 ----

export function createCopyGenerator(config, aiOverride) {
  const ai = aiOverride ?? createAiProvider(config);
  const systemPrompt = _loadPrompt();

  /**
   * 生成 Boost 感谢正文。
   *
   * AI 不知道用户是谁、助力多少次。
   * 仅根据风格方向和可选的兴趣信息生成一条自然的感谢或祝福正文。
   *
   * @param {object} [context]
   * @param {string} [context.interest]   - 可选的兴趣标签
   * @param {string} [context.styleHint]  - 测试用：强制指定风格 key
   * @returns {Promise<string>}
   */
  async function generateCopy(context = {}) {
    // ---- 1. 风格抽签 ----
    const style = context.styleHint
      ? { key: context.styleHint, hint: STYLE_HINTS[context.styleHint] }
      : pickStyle();
    if (!style.hint) {
      throw new Error(`generateCopy: 未知的 styleHint：${context.styleHint}`);
    }

    // ---- 2. 构造用户消息 ----
    let userMessage = "请生成一条 Boost 感谢正文。\n\n";
    userMessage += style.hint;

    if (!isTechStyle(style.key)) {
      userMessage += `\n\n${NON_TECH_RESTRICTION}`;
    }

    if (
      context.interest &&
      typeof context.interest === "string" &&
      context.interest.trim()
    ) {
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
    _validateCopy(trimmed);

    return trimmed;
  }

  return { generateCopy };
}

// ---- 内部工具 ----

function _loadPrompt() {
  try {
    return readFileSync(PROMPT_PATH, "utf-8");
  } catch (err) {
    throw new Error(
      `无法读取感谢文案 Prompt 文件：${PROMPT_PATH}（${err.message}）`,
    );
  }
}

function _validateCopy(text) {
  if (!text || text === "") {
    throw new Error("AI 生成的正文为空");
  }

  const charCount = Array.from(text).length;
  if (charCount > MAX_UNICODE_CHARS) {
    throw new Error(
      `AI 生成的正文过长（${charCount} 个 Unicode 字符，上限 ${MAX_UNICODE_CHARS}），疑似失控`,
    );
  }

  if (RE_USER_MENTION.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 用户 Mention 格式，已拒绝");
  }
  if (RE_ROLE_MENTION.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 身份组 Mention 格式，已拒绝");
  }
  if (RE_CHANNEL_MENTION.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 频道 Mention 格式，已拒绝");
  }
  if (RE_EVERYONE_HERE.test(text)) {
    throw new Error("AI 生成的正文包含 @everyone / @here，已拒绝");
  }
  if (RE_CUSTOM_EMOJI.test(text)) {
    throw new Error("AI 生成的正文包含 Discord 自定义 Emoji 格式，已拒绝");
  }
  if (RE_MD_HEADING.test(text)) {
    throw new Error("AI 生成的正文包含 Markdown 标题格式，已拒绝");
  }
}

export function getPromptPath() {
  return PROMPT_PATH;
}
