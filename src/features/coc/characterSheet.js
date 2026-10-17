/** 选卡时保存到 session 的完整档案快照：类型清洗 + 大小上限。纯函数，不读写任何外部资源。 */
export const CHARACTER_SHEET_MAX_BYTES = 64 * 1024;

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const byteSize = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function cleanCharacter(character) {
  const out = structuredClone(character);
  if (Object.hasOwn(out, "background")) {
    if (!isPlainObject(out.background)) delete out.background;
    else for (const [key, value] of Object.entries(out.background)) {
      if (typeof value !== "string") delete out.background[key];
    }
  }
  for (const key of ["weapons", "spells"]) {
    if (Object.hasOwn(out, key) && !Array.isArray(out[key])) delete out[key];
  }
  // 档案馆实际结构：armor 为对象或 null，possessions 为 { items: [] }；同时接受数组，其余类型丢弃。
  if (Object.hasOwn(out, "armor") && out.armor !== null && !isPlainObject(out.armor) && !Array.isArray(out.armor)) delete out.armor;
  if (Object.hasOwn(out, "possessions") && !isPlainObject(out.possessions) && !Array.isArray(out.possessions)) delete out.possessions;
  if (isPlainObject(out.possessions) && Object.hasOwn(out.possessions, "items") && !Array.isArray(out.possessions.items)) delete out.possessions.items;
  return out;
}

function capStrings(value, maxChars, maxItems) {
  if (typeof value === "string") return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => capStrings(item, maxChars, maxItems));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capStrings(v, maxChars, maxItems)]));
  return value;
}

const FREE_TEXT_KEYS = ["background", "weapons", "armor", "possessions", "spells"];

/**
 * @returns {{ character: object, derived: object, updatedAt: string|null, truncated?: true }}
 */
export function buildCharacterSheet(character, derived, updatedAt, maxBytes = CHARACTER_SHEET_MAX_BYTES) {
  const sheet = {
    character: cleanCharacter(character),
    derived: isPlainObject(derived) ? structuredClone(derived) : {},
    updatedAt: typeof updatedAt === "string" ? updatedAt.slice(0, 64) : null,
  };
  if (byteSize(sheet) <= maxBytes) return sheet;
  const free = (char) => Object.fromEntries(FREE_TEXT_KEYS.filter((k) => Object.hasOwn(char, k)).map((k) => [k, char[k]]));
  for (const [maxChars, maxItems] of [[4000, 100], [2000, 60], [1000, 40], [500, 25], [200, 15], [80, 10]]) {
    const next = { ...sheet, character: { ...sheet.character, ...capStrings(free(sheet.character), maxChars, maxItems) }, truncated: true };
    if (byteSize(next) <= maxBytes) return next;
  }
  // 自由文本全部截断后仍超限：只保留展示必需的结构字段，并把所有字符串压到 40 字。
  const { identity, characteristics, occupation, skills } = sheet.character;
  const minimal = capStrings({ identity, characteristics, occupation, skills: (skills ?? []).slice(0, 200) }, 40, 200);
  const fallback = { character: minimal, derived: capStrings(sheet.derived, 40, 20), updatedAt: sheet.updatedAt, truncated: true };
  if (byteSize(fallback) <= maxBytes) return fallback;
  return { character: { identity: capStrings(identity ?? {}, 40, 10) }, derived: {}, updatedAt: sheet.updatedAt, truncated: true };
}
