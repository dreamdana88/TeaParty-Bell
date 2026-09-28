import { randomInt } from "crypto";
import { parseDiceExpression } from "./parser.js";

/**
 * 含两端的整数随机。默认使用 crypto.randomInt。
 * @param {number} min
 * @param {number} max
 */
export function secureRandomInt(min, max) {
  return randomInt(min, max + 1);
}

/**
 * @param {string|{ ok: true, count: number, sides: number, modifier: number, notation: string }} input
 * @param {(min: number, max: number) => number} [randomIntFn]
 */
export function rollDice(input, randomIntFn = secureRandomInt) {
  const parsed = typeof input === "string" ? parseDiceExpression(input) : input;
  if (!parsed?.ok) return { ok: false };
  const rolls = [];
  for (let index = 0; index < parsed.count; index += 1) {
    rolls.push(randomIntFn(1, parsed.sides));
  }
  const subtotal = rolls.reduce((sum, value) => sum + value, 0);
  return {
    ok: true,
    notation: parsed.notation,
    count: parsed.count,
    sides: parsed.sides,
    modifier: parsed.modifier,
    rolls,
    total: subtotal + parsed.modifier,
  };
}

/**
 * @param {string} speaker
 * @param {{ notation: string, count: number, rolls: number[], modifier: number, total: number }} result
 */
export function formatRoll(speaker, result) {
  const name = speaker.trim() || "调查员";
  if (result.count === 1 && result.modifier === 0) {
    return `🎲 ${name}掷骰\n\n${result.notation} → ${result.total}`;
  }
  if (result.modifier === 0) {
    return `🎲 ${name}掷骰\n\n${result.notation} → [${result.rolls.join(", ")}] = ${result.total}`;
  }
  const sign = result.modifier > 0 ? "+" : "−";
  const abs = Math.abs(result.modifier);
  return `🎲 ${name}掷骰\n\n${result.notation}\n[${result.rolls.join(", ")}] ${sign} ${abs} = ${result.total}`;
}
