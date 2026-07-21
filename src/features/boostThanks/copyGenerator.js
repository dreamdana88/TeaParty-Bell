/**
 * Boost 感谢文案生成器（Phase 5）。
 *
 * 职责：
 * - 读取外置 Prompt 文件
 * - 轻量随机风格抽签（降低 AI 腔和模板化）
 * - 将业务上下文 + 风格指令传给统一 AI 入口
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
const RE_USER_MENTION    = /<@!?\d+>/;
const RE_ROLE_MENTION    = /<@&\d+>/;
const RE_CHANNEL_MENTION = /<#\d+>/;
const RE_EVERYONE_HERE   = /@(everyone|here)\b/i;
const RE_CUSTOM_EMOJI    = /<a?:\w+:\d+>/;
const RE_MD_HEADING      = /^\s*#{1,6}\s/m;

// =========================================================================
// 风格抽签系统
// =========================================================================

/**
 * 加权风格池。
 * 权重设计目标：SillyTavern / AI 相关风格总体占比控制在约 15%。
 *
 * ┌─────────────────────┬────────┬─────────┐
 * │ 风格                │ 权重   │ 约占比   │
 * ├─────────────────────┼────────┼─────────┤
 * │ 生活怪祝福          │ 20     │ 20%     │
 * │ 童话胡说八道        │ 15     │ 15%     │
 * │ 互联网抽象怪话      │ 15     │ 15%     │
 * │ 一句话突然梗        │ 15     │ 15%     │
 * │ 温柔祝福            │ 10     │ 10%     │
 * │ 反套路戏精          │ 10     │ 10%     │
 * │ 轻度酒馆梗 ★        │ 10     │ 10%     │
 * │ AI 玩家怪梗 ★       │  5     │  5%     │
 * └─────────────────────┴────────┴─────────┘
 * ★ = SillyTavern/AI 相关，合计约 15%
 */
const STYLE_POOL = [
  { key: "lifeBlessing",   weight: 20 },
  { key: "fairyTale",      weight: 15 },
  { key: "abstractChaos",  weight: 15 },
  { key: "oneLiner",       weight: 15 },
  { key: "gentleBlessing", weight: 10 },
  { key: "antiRoutine",    weight: 10 },
  { key: "lightTavern",    weight: 10 },
  { key: "aiGamer",        weight:  5 },
];

/** 风格定义：简短方向描述，传给 AI 的 user message */
const STYLE_HINTS = {
  lifeBlessing:
    "本次风格方向：生活怪祝福。围绕吃饭、睡觉、天气、快递、钱、工作、游戏和日常小事进行具体又突然的祝福。" +
    "允许一本正经地胡说八道。不要使用酒馆、角色卡、世界书、模型、上下文、截断、预设等社区术语。",

  fairyTale:
    "本次风格方向：童话胡说八道。创造不存在的食物、天气、动物、植物或奇怪好运。" +
    "可以天马行空，不要解释世界观。不要使用酒馆、角色卡、世界书、模型、上下文、截断、预设等社区术语。",

  abstractChaos:
    "本次风格方向：互联网抽象怪话。像群友突然冒出来的一句话。允许跳跃、荒诞、没头没尾，但要自然。" +
    "不要使用酒馆、角色卡、世界书、模型、上下文、截断、预设等社区术语。",

  oneLiner:
    "本次风格方向：一句话突然梗。保持简短。可以前半句正常，后半句突然拐弯。" +
    "不要使用酒馆、角色卡、世界书、模型、上下文、截断、预设等社区术语。",

  gentleBlessing:
    "本次风格方向：温柔祝福。真诚、自然、有生命力。避免鸡汤、宏大叙事和万能成功学。" +
    "不使用酒馆、角色卡、世界书、模型、上下文、截断、预设等社区术语。",

  antiRoutine:
    "本次风格方向：反套路戏精。可以模仿霸总、广告、天气预报、新闻播报、系统通知等语气，" +
    "然后突然转成祝福。不要使用酒馆、角色卡、世界书、模型等非必要社区术语。",

  lightTavern:
    "本次风格方向：轻度酒馆梗。允许使用 1 到 2 个 SillyTavern 玩家熟悉的梗（如酒馆、角色卡、模型、上下文等），" +
    "但禁止术语堆砌。可以融入自然口语。",

  aiGamer:
    "本次风格方向：AI 玩家怪梗。可以玩模型、厂商、截断、复读等社区梗。" +
    "优先创造新表达，避免机械重复已有固定梗（如'模型不炸显存''上下文永远塞得下'等）。" +
    "可以自然使用少量技术术语。",
};

/** SillyTavern/AI 相关风格 key 集合 */
const TECH_STYLE_KEYS = new Set(["lightTavern", "aiGamer"]);

// ---- 导出（供测试） ----

/**
 * 加权随机抽选风格。
 * @returns {{ key: string, hint: string }}
 */
export function pickStyle() {
  const totalWeight = STYLE_POOL.reduce((sum, s) => sum + s.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const entry of STYLE_POOL) {
    rand -= entry.weight;
    if (rand <= 0) {
      return { key: entry.key, hint: STYLE_HINTS[entry.key] };
    }
  }
  // fallback（浮点精度兜底）
  const last = STYLE_POOL[STYLE_POOL.length - 1];
  return { key: last.key, hint: STYLE_HINTS[last.key] };
}

/**
 * 判断风格 key 是否为 SillyTavern/AI 相关风格。
 * @param {string} key
 * @returns {boolean}
 */
export function isTechStyle(key) {
  return TECH_STYLE_KEYS.has(key);
}

/**
 * 获取风格池的完整 key 列表（供测试验证）。
 * @returns {string[]}
 */
export function getStyleKeys() {
  return STYLE_POOL.map((s) => s.key);
}

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
   * @param {string} [context.styleHint]      - 测试用：强制指定风格 key
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

    // ---- 2. 风格抽签 ----
    const style = context.styleHint
      ? { key: context.styleHint, hint: STYLE_HINTS[context.styleHint] }
      : pickStyle();
    if (!style.hint) {
      throw new Error(`generateCopy: 未知的 styleHint：${context.styleHint}`);
    }

    // ---- 3. 构造用户消息 ----
    const userName = context.displayName || "新朋友";
    const boostLabel = context.boostCount === 1
      ? "1个助力"
      : `${context.boostCount}个助力`;

    let userMessage = `请为 "${userName}" 生成 Boost 感谢正文。`;
    userMessage += `\n助力数量：${boostLabel}`;
    userMessage += `\n\n${style.hint}`;

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

    // ---- 4. 调用 AI ----
    const rawText = await ai.generateText(messages, options);

    // ---- 5. 校验输出 ----
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
      `无法读取感谢文案 Prompt 文件：${PROMPT_PATH}（${err.message}）`
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
      `AI 生成的正文过长（${charCount} 个 Unicode 字符，上限 ${MAX_UNICODE_CHARS}），疑似失控`
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
