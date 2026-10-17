/** 本局 PL 当前 HP/SAN/MP：只读写 Session 快照，不回写档案馆。 */
import { parseDiceExpression } from "./dice/parser.js";

export const STAT_LABELS = Object.freeze({ hp: "HP", san: "SAN", mp: "MP" });
const SAN_MAX = 99;
const FIXED_MAX = 999;

/** 加减值：固定非负整数（≤999）或 /r 同款骰子表达式；其余返回 null。 */
function parseAmount(text) {
  if (/^\d{1,3}$/.test(text)) return { fixed: Number(text) };
  const dice = parseDiceExpression(text);
  return dice.ok ? { dice } : null;
}

/** 整句必须完全匹配 sc / hp|san|mp / st；认不出返回 { ok: false }。 */
export function parseStatCommand(content) {
  if (typeof content !== "string" || content.length > 100) return { ok: false };
  const text = content.trim();
  if (/^st$/i.test(text)) return { ok: true, kind: "st" };
  const sc = /^sc\s+([^\s/]+)\/([^\s/]+)$/i.exec(text);
  if (sc) {
    const success = parseAmount(sc[1]);
    const failure = parseAmount(sc[2]);
    return success && failure ? { ok: true, kind: "sc", success, failure } : { ok: false };
  }
  const adjust = /^(hp|san|mp)\s+<@!?(\d{1,25})>\s+([+-])(\S+)$/i.exec(text);
  if (!adjust) return { ok: false };
  const amount = parseAmount(adjust[4]);
  if (!amount) return { ok: false };
  return { ok: true, kind: "adjust", stat: adjust[1].toLowerCase(), targetUserId: adjust[2], sign: adjust[3] === "+" ? 1 : -1, amount };
}

/** 当前值与上限；老快照缺 current 时用 initial 补。初始值异常返回 null。 */
export function currentStats(member) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  if (!member?.characterId || !valid(member.initialHp) || !valid(member.initialSan) || !valid(member.initialMp)) return null;
  const max = { hp: member.initialHp, san: SAN_MAX, mp: member.initialMp };
  const pick = (key, initial) => {
    const value = member.current?.[key];
    return valid(value) ? Math.min(value, max[key]) : Math.min(initial, max[key]);
  };
  return {
    current: { hp: pick("hp", member.initialHp), san: pick("san", member.initialSan), mp: pick("mp", member.initialMp) },
    max,
  };
}

/** 掷加减值，返回 { value, label }；label 用于「（骰式=结果）」。maxOut 时骰子直接取最大值。 */
export function rollAmount(amount, randomInt, maxOut = false) {
  if (amount.fixed !== undefined) return { value: amount.fixed, label: String(amount.fixed) };
  const { count, sides, modifier, notation } = amount.dice;
  let total = modifier;
  for (let index = 0; index < count; index += 1) total += maxOut ? sides : randomInt(1, sides);
  const value = Math.max(0, total);
  return { value, label: `${notation}${maxOut ? " 取最大" : ""}=${value}` };
}

/** 在上下限内应用变化；返回新值与截断提示。 */
export function applyDelta(stats, stat, delta) {
  const before = stats.current[stat];
  const raw = before + delta;
  const after = Math.min(stats.max[stat], Math.max(0, raw));
  const note = raw > after ? `，已截断到上限 ${stats.max[stat]}` : raw < after ? "，已截断到下限 0" : "";
  return { before, after, note };
}

export function formatStatLine(stats) {
  return ["hp", "san", "mp"].map(key => `${STAT_LABELS[key]} ${stats.current[key]}/${stats.max[key]}`).join("　");
}
