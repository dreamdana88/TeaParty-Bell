const DICE_PATTERN = /^(\d+)d(\d+)([+-]\d+)?$/i;

export const DICE_LIMITS = Object.freeze({
  maxLength: 32,
  minCount: 1,
  maxCount: 20,
  minSides: 2,
  maxSides: 100000,
  maxModifierAbs: 100000,
});

export const INVALID_DICE_MESSAGE = "骰子表达式无效，请使用例如 `1d100`、`2d6+3`。";

/**
 * @param {unknown} input
 * @returns {{ ok: true, count: number, sides: number, modifier: number, notation: string }|{ ok: false }}
 */
export function parseDiceExpression(input) {
  if (typeof input !== "string") return { ok: false };
  const raw = input.trim();
  if (raw.length === 0 || raw.length > DICE_LIMITS.maxLength) return { ok: false };
  const match = DICE_PATTERN.exec(raw);
  if (!match) return { ok: false };
  const count = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(sides) || !Number.isSafeInteger(modifier)) {
    return { ok: false };
  }
  if (count < DICE_LIMITS.minCount || count > DICE_LIMITS.maxCount) return { ok: false };
  if (sides < DICE_LIMITS.minSides || sides > DICE_LIMITS.maxSides) return { ok: false };
  if (Math.abs(modifier) > DICE_LIMITS.maxModifierAbs) return { ok: false };
  const sign = modifier === 0 ? "" : modifier > 0 ? `+${modifier}` : String(modifier);
  return {
    ok: true,
    count,
    sides,
    modifier,
    notation: `${count}d${sides}${sign}`,
  };
}
