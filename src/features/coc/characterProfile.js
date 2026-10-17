/** KP 查看本局调查员档案：纯展示模块，只读 session 里保存的 characterSheet。 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { buildCustomId } from "./panel.js";
import { snapshotSkillValue } from "./textDice.js";

export const PROFILE_LIMITS = Object.freeze({ embedTotal: 6000, description: 4096, fieldValue: 1024, content: 2000 });
export const PAGE_CHARS = 3500; // description 预算，留出标题、页脚余量
const LIST_PAGE_SIZE = 25;
export const NO_SHEET_MESSAGE = "当前没有保存完整档案。";
export const NO_PL_MESSAGE = "本局目前没有调查员。";
export const TRUNCATED_NOTE = "⚠️ 档案过长，部分内容未保存。";
const PROFILE_COLOR = 0x78383f;

export const PROFILE_SECTIONS = Object.freeze([
  ["ov", "概览"], ["at", "属性"], ["sk", "技能"], ["bg", "背景"], ["eq", "装备"],
]);
const SECTION_LABEL = new Map(PROFILE_SECTIONS);

const BACKGROUND_LABELS = [
  ["appearance", "外貌描述"], ["beliefs", "思想与信念"], ["significantPeople", "重要之人"],
  ["meaningfulLocations", "意义非凡之地"], ["treasuredPossessions", "宝贵之物"], ["traits", "特质"],
  ["scars", "伤口伤疤"], ["phobias", "恐惧症/狂躁症"], ["personalHistory", "成长经历"],
  ["assets", "个人资产"], ["mythos", "神话"], ["companions", "调查员伙伴"],
];
const CHARACTERISTICS = [
  ["str", "力量 STR"], ["con", "体质 CON"], ["siz", "体型 SIZ"], ["dex", "敏捷 DEX"], ["app", "外貌 APP"],
  ["int", "智力 INT"], ["pow", "意志 POW"], ["edu", "教育 EDU"], ["luck", "幸运 Luck"],
];
const DERIVED_LABELS = new Map([
  ["hp", "生命值 HP"], ["mp", "魔法值 MP"], ["san", "理智 SAN"], ["mov", "移动力 MOV"], ["build", "体格"],
  ["damageBonus", "伤害加值 DB"], ["db", "伤害加值 DB"], ["dodge", "闪避"],
  ["majorWound", "重伤阈值"], ["sanMaximum", "理智上限"], ["movAdjust", "移动力调整"],
]);
const ITEM_LABELS = new Map([
  ["type", "类型"], ["skill", "技能"], ["damage", "伤害"], ["range", "射程"], ["impale", "贯穿"], ["rate", "次数"],
  ["ammo", "装弹"], ["malfunction", "故障"], ["era", "时代"], ["price", "价格"], ["invented", "年代"], ["note", "备注"],
  ["quantity", "数量"], ["movPenalty", "移动惩罚"], ["cost", "消耗"], ["castingTime", "施法时间"], ["description", "说明"],
]);

/**
 * 转义 Markdown（线性时间；discord.js escapeMarkdown 对超长单行是平方级），
 * 并在 @ 后插零宽字符，避免 @everyone/@here/<@id> 渲染成提及。
 */
export function safeText(value) {
  return String(value ?? "")
    .replace(/[\\*_~`|[\]]/g, "\\$&")
    .replace(/^(\s*)([>#-])/gm, "$1\\$2")
    .replace(/@/g, "@\u200b");
}
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const present = (value) => value !== undefined && value !== null && String(value).trim() !== "";

function itemLine(item) {
  if (!isPlainObject(item)) return present(item) && typeof item !== "object" ? `• ${safeText(item)}` : null;
  const name = present(item.name) ? `**${safeText(item.name)}**` : "**（未命名）**";
  const details = Object.entries(item)
    .filter(([key, value]) => key !== "name" && (typeof value === "string" || typeof value === "number") && present(value))
    .map(([key, value]) => `${ITEM_LABELS.get(key) ?? safeText(key)}：${safeText(value)}`);
  return `• ${name}${details.length ? ` — ${details.join("；")}` : ""}`;
}

/** 生成某区块的文本块（每块是一个逻辑段落，可能很长，之后再切页）。 */
function sectionBlocks(sheet, section) {
  const character = isPlainObject(sheet?.character) ? sheet.character : {};
  const identity = isPlainObject(character.identity) ? character.identity : {};
  const derived = isPlainObject(sheet?.derived) ? sheet.derived : {};
  if (section === "ov") {
    const occupation = isPlainObject(character.occupation) ? character.occupation.name : character.occupation;
    return [[
      ["姓名", identity.name], ["年龄", identity.age], ["性别", identity.sex], ["时代", identity.era],
      ["职业", occupation], ["住地", identity.residence], ["故乡", identity.birthplace],
    ].map(([label, value]) => `**${label}**：${present(value) ? safeText(value) : "—"}`).join("\n")];
  }
  if (section === "at") {
    const stats = isPlainObject(character.characteristics) ? character.characteristics : {};
    const lines = CHARACTERISTICS.map(([key, label]) => `**${label}**：${present(stats[key]) ? safeText(stats[key]) : "—"}`);
    // 初始 SAN 只取档案馆保存的 character.initialSan，不自行推导；缺失或非数字显示「—」。
    const initialSan = character.initialSan;
    lines.push(`**初始理智 SAN**：${typeof initialSan === "number" && Number.isFinite(initialSan) ? safeText(initialSan) : "—"}`);
    const derivedLines = Object.entries(derived)
      .filter(([, value]) => (typeof value === "number" || typeof value === "string") && present(value))
      .map(([key, value]) => `**${DERIVED_LABELS.get(key) ?? safeText(key)}**：${safeText(value)}`);
    return derivedLines.length ? [lines.join("\n"), `__衍生数值__\n${derivedLines.join("\n")}`] : [lines.join("\n")];
  }
  if (section === "sk") {
    const skills = Array.isArray(character.skills) ? character.skills : [];
    if (!skills.length) return ["（无技能记录）"];
    return skills.map((skill) => {
      const name = skill?.specialty ? `${skill.name}：${skill.specialty}` : skill?.name;
      const value = snapshotSkillValue(skill);
      return `${safeText(name ?? "（未命名）")}　**${value === null ? "数据异常" : value}**`;
    });
  }
  if (section === "bg") {
    const background = isPlainObject(character.background) ? character.background : {};
    const blocks = BACKGROUND_LABELS.filter(([key]) => typeof background[key] === "string" && background[key].trim())
      .map(([key, label]) => `__${label}__\n${safeText(background[key].trim())}`);
    return blocks.length ? blocks : ["（背景未填写）"];
  }
  if (section === "eq") {
    const blocks = [];
    const list = (title, items) => {
      const lines = (items ?? []).map(itemLine).filter(Boolean);
      if (lines.length) blocks.push(`__${title}__`, ...lines);
    };
    list("武器", Array.isArray(character.weapons) ? character.weapons : []);
    if (character.armor) list("护甲", Array.isArray(character.armor) ? character.armor : [character.armor]);
    const possessions = character.possessions;
    list("物品", Array.isArray(possessions) ? possessions : (isPlainObject(possessions) && Array.isArray(possessions.items) ? possessions.items : []));
    list("法术", Array.isArray(character.spells) ? character.spells : []);
    return blocks.length ? blocks : ["（没有记录装备）"];
  }
  return [];
}

/**
 * 在不超过 max 的前提下找安全切点：不切断 surrogate pair，不切断「\\ + 下一字符」转义序列。
 * 返回切点下标（从 start 起算的绝对下标），保证至少前进 1 个码元（极端情况下最多 2）。
 */
export function safeCutIndex(text, start, max) {
  const limit = Math.min(start + max, text.length);
  if (limit <= start) return Math.min(start + 1, text.length);
  let end = limit;
  // 高位代理落在末尾、低位代理在下一页开头 → 把高位代理留给下一页
  if (end > start && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  }
  // 奇数个连续尾部反斜杠意味着最后一个 \\ 还在等待被转义的字符 → 回退
  if (end > start && end < text.length) {
    let i = end - 1;
    while (i >= start && text[i] === "\\") i -= 1;
    if ((end - 1 - i) % 2 === 1) end -= 1;
  }
  // 回退后若什么都没切到，至少带走一个完整转义或一个代理对
  if (end <= start) {
    end = start + 1;
    if (end < text.length && text[start] === "\\") end = start + 2;
    else if (end < text.length) {
      const code = text.charCodeAt(start);
      if (code >= 0xD800 && code <= 0xDBFF) end = start + 2;
    }
  }
  return Math.min(end, text.length);
}

/** 把一段文本切成每页不超过 max 的页；优先在换行处切，单行超长时用 safeCutIndex。 */
export function splitTextPages(text, max = PAGE_CHARS) {
  if (!text) return ["—"];
  const pages = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.length - cursor <= max) {
      pages.push(text.slice(cursor));
      break;
    }
    const window = text.slice(cursor, cursor + max);
    const newline = window.lastIndexOf("\n");
    let end;
    if (newline > 0) {
      end = cursor + newline; // 换行本身留到下一页开头去掉，本页不含尾部 \n
    } else {
      end = safeCutIndex(text, cursor, max);
    }
    pages.push(text.slice(cursor, end));
    cursor = end;
    if (text[cursor] === "\n") cursor += 1; // 吃掉用作分隔的换行，避免下页以空行起头叠出来
  }
  return pages.length ? pages : ["—"];
}

/** 把块拼成文本后分页；超长不丢内容，切点不破坏转义与代理对。 */
function paginate(blocks) {
  return splitTextPages(blocks.join("\n"), PAGE_CHARS);
}

export function profilePages(sheet, section) {
  return paginate(sectionBlocks(sheet, section));
}

function button(customId, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

/** KP 选择要查看的 PL；超过 25 人时分页。 */
export function profileMemberPicker(session, page = 0) {
  const members = Array.isArray(session?.pl) ? session.pl : [];
  if (!members.length) return { content: NO_PL_MESSAGE, embeds: [], components: [], allowedMentions: { parse: [] } };
  const last = Math.max(0, Math.ceil(members.length / LIST_PAGE_SIZE) - 1);
  const current = Math.min(last, Math.max(0, Number.isInteger(page) ? page : 0));
  const options = members.slice(current * LIST_PAGE_SIZE, (current + 1) * LIST_PAGE_SIZE).map((member) => ({
    label: `${member.characterName || "未命名调查员"} · ${member.occupation || "职业未填写"}`.slice(0, 100),
    value: member.userId,
  }));
  const components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(buildCustomId("pf-pick", session.sessionId))
    .setPlaceholder("选择要查看的调查员").setMinValues(1).setMaxValues(1).addOptions(options))];
  if (last > 0) components.push(new ActionRowBuilder().addComponents(
    button(buildCustomId(`pf-list-${current - 1}`, session.sessionId), "上一页").setDisabled(current === 0),
    button(buildCustomId(`pf-list-${current + 1}`, session.sessionId), "下一页").setDisabled(current === last),
  ));
  return {
    content: `📁 选择要查看档案的调查员（第 ${current + 1}/${last + 1} 页，共 ${members.length} 人）。`,
    embeds: [], components, allowedMentions: { parse: [] },
  };
}

/** 某 PL 某区块某页的档案视图。 */
export function profileView(session, member, section = "ov", page = 0) {
  const sheet = member?.characterSheet;
  const back = new ActionRowBuilder().addComponents(button(buildCustomId("pf-list-0", session.sessionId), "返回调查员列表"));
  if (!isPlainObject(sheet) || !isPlainObject(sheet.character)) {
    return { content: NO_SHEET_MESSAGE, embeds: [], components: [back], allowedMentions: { parse: [] } };
  }
  const sec = SECTION_LABEL.has(section) ? section : "ov";
  const pages = profilePages(sheet, sec);
  const current = Math.min(pages.length - 1, Math.max(0, Number.isInteger(page) ? page : 0));
  const name = safeText(member.characterName || sheet.character?.identity?.name || "调查员").slice(0, 150);
  const footer = [`${SECTION_LABEL.get(sec)} 第 ${current + 1}/${pages.length} 页`, "仅 KP 可见 · 选卡时保存的快照"];
  const description = sheet.truncated ? `${TRUNCATED_NOTE}\n\n${pages[current]}` : pages[current];
  const embed = {
    color: PROFILE_COLOR,
    title: `📁 ${name} · ${SECTION_LABEL.get(sec)}`,
    description,
    footer: { text: footer.join(" · ") },
  };
  const sectionRow = new ActionRowBuilder().addComponents(PROFILE_SECTIONS.map(([key, label]) => (
    button(buildCustomId(`pf-${key}-0`, session.sessionId, member.userId), label, key === sec ? ButtonStyle.Primary : ButtonStyle.Secondary)
  )));
  const navRow = new ActionRowBuilder().addComponents(
    button(buildCustomId(`pf-${sec}-${current - 1}`, session.sessionId, member.userId), "上一页").setDisabled(current === 0),
    button(buildCustomId(`pf-${sec}-${current + 1}`, session.sessionId, member.userId), "下一页").setDisabled(current >= pages.length - 1),
    button(buildCustomId("pf-list-0", session.sessionId), "返回调查员列表"),
  );
  return { content: "", embeds: [embed], components: [sectionRow, navRow], allowedMentions: { parse: [] } };
}

/** 解析 pf-<区块>-<页码> / pf-list-<页码>。 */
export function parseProfileAction(action) {
  const match = /^pf-(ov|at|sk|bg|eq|list)-(-?\d{1,4})$/.exec(String(action ?? ""));
  if (!match) return null;
  return { section: match[1], page: Math.max(0, Number(match[2])) };
}
