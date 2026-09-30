import { secureRandomInt } from "./roller.js";

const BONUS_PENALTY = /^1d100\s+(奖励|惩罚)([12])$/i;

/**
 * 整句 1D100 奖励/惩罚。认不出就当普通聊天。
 * @param {unknown} input
 */
export function parseBonusPenalty(input) {
  if (typeof input !== "string") return { ok: false };
  const match = BONUS_PENALTY.exec(input.trim());
  if (!match) return { ok: false };
  const kind = match[1] === "奖励" ? "bonus" : "penalty";
  const extra = Number(match[2]);
  const word = kind === "bonus" ? "奖励" : "惩罚";
  return {
    ok: true,
    kind,
    extra,
    notation: `1D100 ${word}${extra}`,
  };
}

/** CoC 百分骰：十位 0 且个位 0 记为 100。 */
export function d100FromDigits(tens, units) {
  if (tens === 0 && units === 0) return 100;
  return tens * 10 + units;
}

/**
 * 先掷一次个位，再掷 1+extra 次十位。奖励取最小，惩罚取最大。
 * 候选值按掷出顺序保留，供展示直接使用。
 * @param {{ ok?: boolean, kind?: string, extra?: number, notation?: string }} parsed
 * @param {(min: number, max: number) => number} [randomIntFn]
 */
export function rollBonusPenalty(parsed, randomIntFn = secureRandomInt) {
  if (!parsed?.ok) return { ok: false };
  if (parsed.kind !== "bonus" && parsed.kind !== "penalty") return { ok: false };
  if (parsed.extra !== 1 && parsed.extra !== 2) return { ok: false };
  const units = randomIntFn(0, 9);
  const tens = [];
  for (let index = 0; index < 1 + parsed.extra; index += 1) {
    tens.push(randomIntFn(0, 9));
  }
  const candidates = tens.map((digit) => d100FromDigits(digit, units));
  const total = parsed.kind === "bonus" ? Math.min(...candidates) : Math.max(...candidates);
  return {
    ok: true,
    kind: parsed.kind,
    extra: parsed.extra,
    notation: parsed.notation,
    units,
    tens,
    candidates,
    total,
  };
}
