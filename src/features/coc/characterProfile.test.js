import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharacterClient } from "./characterClient.js";
import { createCocSessionService } from "./sessionService.js";
import { createCocSessionStore } from "./sessionStore.js";
import { createCocInteractionRouter } from "./interactionRouter.js";
import { controlPanel } from "./panel.js";
import { findSnapshotSkill } from "./textDice.js";
import {
  NO_PL_MESSAGE, NO_SHEET_MESSAGE, PAGE_CHARS, PROFILE_LIMITS, PROFILE_SECTIONS, TRUNCATED_NOTE,
  profileMemberPicker, profilePages, profileView, safeText, splitTextPages,
} from "./characterProfile.js";

let passed = 0; let failed = 0;
function check(ok, label) { if (ok) { passed++; console.log(`PASS: ${label}`); } else { failed++; console.error(`FAIL: ${label}`); } }

function makeCard(id, owner, overrides = {}) {
  return {
    schemaVersion: 1, ruleset: "coc7", id, ownerDiscordUserId: owner,
    identity: { name: `调查员${owner}`, age: 30, sex: "男", era: "1920s", residence: "阿卡姆", birthplace: "印斯茅斯" },
    characteristics: { str: 50, con: 60, siz: 55, dex: 70, app: 65, int: 75, pow: 70, edu: 80, luck: 60 },
    initialSan: 70, occupation: { name: "记者" },
    skills: [{ name: "侦查", base: 25, growth: 5, occupationPoints: 30, interestPoints: 0 }],
    background: { beliefs: `信念${owner}`, personalHistory: "原始经历" },
    weapons: [{ name: "小刀", damage: "1d4" }], armor: { name: "皮夹克", applyMovPenalty: false },
    possessions: { items: [{ name: "笔记本" }] }, spells: [],
    ...overrides,
  };
}

// 假档案馆：通过 fetchImpl 驱动真实 characterClient.read()。
const cards = new Map();
let archiveDown = false;
let fetchCount = 0;
const characters = createCharacterClient({ baseUrl: "http://127.0.0.1:8787", secret: "test-secret", fetchImpl: async (url) => {
  fetchCount++;
  if (archiveDown) throw new Error("ECONNREFUSED");
  const path = new URL(url).pathname;
  const userMatch = /^\/internal\/users\/(\d+)\/characters$/.exec(path);
  if (userMatch) {
    const list = [...cards.values()].filter((card) => card.ownerDiscordUserId === userMatch[1])
      .map((card) => ({ id: card.id, ownerDiscordUserId: card.ownerDiscordUserId, name: card.identity.name, occupation: card.occupation.name, era: "1920s" }));
    return { ok: true, status: 200, json: async () => ({ ok: true, characters: list }) };
  }
  const card = cards.get(decodeURIComponent(path.split("/").pop()));
  if (!card) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ ok: true, character: structuredClone(card), derived: { hp: 11, mp: 14, mov: 8, build: 0, damageBonus: "0" }, updatedAt: "2026-10-01T00:00:00Z" }) };
} });

const fakeDiscord = new Proxy({
  async listSiblingNames() { return []; },
  async createTextChannel() { return { id: "room-1" }; },
  async fetchNickname() { return null; },
  async fetchGuildMember(_g, userId) { return { userId, bot: false, nickname: null }; },
  async createPrivateThread() { return { id: "thread-1" }; },
  async sendMessage() { return "msg-1"; },
  async fetchChannelHistory() { return { messages: [], truncated: false }; },
}, { get(target, key) { return key in target ? target[key] : async () => undefined; } });

const dir = mkdtempSync(join(tmpdir(), "coc-profile-"));
let ids = 0;
try {
  const store = createCocSessionStore({ filePath: join(dir, "sessions.json") });
  await store.load();
  const service = createCocSessionService({ store, discord: fakeDiscord, characters, logger: { warn() {}, error() {} },
    createId: () => `s${++ids}`,
    config: { enabled: true, guildId: "guild", categoryId: "cat", kpRoleId: "rk", plRoleId: "rp", obRoleId: "ro", botUserId: "bot", messageContentEnabled: false, transcriptEnabled: false } });
  const setState = (sessionId, state) => store.update((current) => ({
    state: { ...current, sessions: current.sessions.map((s) => s.sessionId === sessionId ? { ...s, state } : s) }, result: null }));

  for (const [id, owner] of [["c1", "101"], ["c2", "102"], ["c3", "103"]]) cards.set(id, makeCard(id, owner));
  await service.openRecruit({ guildId: "guild", channelId: "recruit", kpUserId: "900", title: "档案测试" });
  const prep = await service.prepareCharacterSelection("s1", "101");
  const bound = await service.selectCharacter("s1", "101", "c1", prep.invitation?.id);
  check(bound.ok, "报名选卡成功");
  const recruited = service.find("s1").pl.find((m) => m.userId === "101");
  check(recruited.characterSheet?.character?.background?.beliefs === "信念101" && recruited.characterSheet.derived.mov === 8, "报名选卡后成员有完整 characterSheet 快照");
  check(recruited.characterId === "c1" && recruited.characterName === "调查员101" && recruited.occupation === "记者"
    && recruited.initialHp === 11 && recruited.initialSan === 70 && recruited.initialMp === 14 && recruited.initialLuck === 60
    && recruited.skills.length === 1, "旧快照字段仍在");
  check(findSnapshotSkill(recruited, "侦查").value === 60, "技能骰仍读 skills");

  // RECRUITING 状态三处都拒绝
  const gateRecruit = [service.previewCharacterProfile("s1", "900"), service.previewCharacterProfile("s1", "900", "101")];
  check(gateRecruit.every((g) => !g.ok), "RECRUITING 状态服务层拒绝打开列表和选人");

  const started = await service.confirmStart("s1", "900");
  check(started.ok && service.find("s1").state === "ACTIVE", "开团进入 ACTIVE");
  const invited = await service.inviteCharacter("s1", "900", "102", "add");
  await service.prepareCharacterSelection("s1", "102", invited.invitation.id);
  check((await service.selectCharacter("s1", "102", "c2", invited.invitation.id)).ok, "ACTIVE 后 KP 加 PL 选卡成功");
  check(service.find("s1").pl.find((m) => m.userId === "102")?.characterSheet?.character?.background?.beliefs === "信念102", "ACTIVE 后加入的 PL 有快照");
  await service.addOb("s1", "900", "103");
  const conv = await service.inviteCharacter("s1", "900", "103", "convert");
  await service.prepareCharacterSelection("s1", "103", conv.invitation.id);
  check((await service.selectCharacter("s1", "103", "c3", conv.invitation.id)).ok, "OB→PL 选卡成功");
  check(service.find("s1").pl.find((m) => m.userId === "103")?.characterSheet?.character?.identity?.name === "调查员103", "OB→PL 成员有快照");

  // 路由
  const client = { on(_e, fn) { this.fn = fn; }, off() {} };
  const router = createCocInteractionRouter({ client, service, discord: fakeDiscord, logger: { warn() {}, error() {} } });
  router.start();
  function fire({ user, customId, select, updateError }) {
    const out = { replies: [], updates: [] };
    const interaction = {
      user: { id: user }, customId, values: select ? [select] : undefined, deferred: false, replied: false,
      isChatInputCommand: () => false, isModalSubmit: () => false,
      isStringSelectMenu: () => Boolean(select), isButton: () => !select,
      async reply(p) { out.replies.push(p); this.replied = true; },
      async followUp(p) { out.replies.push(p); },
      async update(p) { if (updateError) throw updateError; out.updates.push(p); },
      async editReply(p) { out.updates.push(p); },
      async deferReply() { this.deferred = true; }, async deferUpdate() { this.deferred = true; },
    };
    return client.fn(interaction).then(() => out);
  }
  const textOf = (p) => JSON.stringify(p ?? {});

  const panelButtons = controlPanel(service.find("s1")).components.flatMap((row) => row.toJSON().components);
  check(panelButtons.some((b) => b.label === "📁 调查员档案" && b.custom_id === "coc:v1:profile:s1"), "ACTIVE 控制面板有「📁 调查员档案」按钮");

  let r = await fire({ user: "900", customId: "coc:v1:profile:s1" });
  const list = r.replies[0];
  const opts = list?.components?.[0]?.toJSON().components[0].options ?? [];
  check(list?.flags === 64 && opts.length === 3 && opts.some((o) => o.label === "调查员101 · 记者" && o.value === "101"), "KP 能打开 ephemeral 调查员列表，显示「姓名 · 职业」");
  r = await fire({ user: "101", customId: "coc:v1:profile:s1" });
  check(r.replies[0]?.flags === 64 && r.replies[0].content.includes("只有本局 KP") && !r.replies[0].embeds, "非 KP 打不开列表，提示为 ephemeral");

  fetchCount = 0;
  r = await fire({ user: "900", customId: "coc:v1:pf-pick:s1", select: "101" });
  const view = r.updates[0];
  check(view?.embeds?.[0]?.description.includes("调查员101") && view.embeds[0].description.includes("印斯茅斯"), "KP 选中后看到概览");
  check(fetchCount === 0, "查看档案不请求档案馆");
  r = await fire({ user: "101", customId: "coc:v1:pf-pick:s1", select: "102" });
  check(!r.updates[0]?.embeds?.length && r.updates[0]?.content.includes("只有本局 KP"), "伪造 pf-pick customId 的非 KP 读不到");
  r = await fire({ user: "102", customId: "coc:v1:pf-bg-0:s1:101" });
  check(!r.updates[0]?.embeds?.length && !textOf(r).includes("信念101"), "伪造翻页 customId 的非 KP 读不到");
  r = await fire({ user: "900", customId: "coc:v1:pf-pick:s1", select: "999" });
  check(r.updates[0]?.content.includes("不在本局 PL") && !r.updates[0].embeds?.length, "不能查看非本局用户");
  r = await fire({ user: "900", customId: "coc:v1:pf-ov-0:s1:900" });
  check(!r.updates[0]?.embeds?.length, "不能把 KP 自己/非 PL 当目标");
  r = await fire({ user: "900", customId: "coc:v1:pf-ov-0:s404:101" });
  check(r.updates[0]?.content.includes("已经不在") && !r.updates[0].embeds?.length, "不能指定别的/不存在的 session");

  // 长期卡后续修改、删除、档案馆不可用都不影响
  cards.get("c2").background.beliefs = "被改掉了"; cards.delete("c3"); archiveDown = true; fetchCount = 0;
  r = await fire({ user: "900", customId: "coc:v1:pf-bg-0:s1:102" });
  check(r.updates[0]?.embeds?.[0]?.description.includes("信念102") && !textOf(r).includes("被改掉了"), "长期卡后续修改不影响快照");
  r = await fire({ user: "900", customId: "coc:v1:pf-ov-0:s1:103" });
  check(r.updates[0]?.embeds?.[0]?.description.includes("调查员103"), "长期卡删除不影响快照");
  check(fetchCount === 0, "Internal API 不可用不影响查看");
  archiveDown = false;

  // 装备、属性、技能区块
  r = await fire({ user: "900", customId: "coc:v1:pf-eq-0:s1:101" });
  const eq = r.updates[0]?.embeds?.[0]?.description ?? "";
  check(eq.includes("小刀") && eq.includes("皮夹克") && eq.includes("笔记本"), "装备区展示武器/护甲/物品");
  r = await fire({ user: "900", customId: "coc:v1:pf-sk-0:s1:101" });
  check(/侦查.*60/.test(r.updates[0]?.embeds?.[0]?.description ?? ""), "技能区展示共用函数计算的最终值");
  r = await fire({ user: "900", customId: "coc:v1:pf-at-0:s1:101" });
  check((r.updates[0]?.embeds?.[0]?.description ?? "").includes("力量 STR") && r.updates[0].embeds[0].description.includes("移动力 MOV"), "属性区含属性与衍生数值");

  // 档案更新失败不做专门兜底：错误抛给路由已有的统一错误处理
  r = await fire({ user: "900", customId: "coc:v1:pf-ov-1:s1:101", updateError: Object.assign(new Error("Unknown Webhook"), { code: 10015 }) });
  check(r.updates.length === 0 && r.replies.length === 1 && r.replies[0].content === "这次操作没有完成，请稍后再试。", "档案更新失败直接抛错，由已有统一错误处理接住");

  // PL 移出后不能再看
  await setState("s1", "ACTIVE");
  await store.update((current) => ({ state: { ...current, sessions: current.sessions.map((s) => s.sessionId === "s1" ? { ...s, pl: s.pl.filter((m) => m.userId !== "103") } : s) }, result: null }));
  r = await fire({ user: "900", customId: "coc:v1:pf-ov-0:s1:103" });
  check(r.updates[0]?.content.includes("不在本局 PL"), "只能看本局当前 PL");

  // 非 ACTIVE 状态三处都拒绝
  for (const state of ["RECRUITING", "STARTING", "ENDING", "ENDED", "CANCELLED"]) {
    await setState("s1", state);
    const a = await fire({ user: "900", customId: "coc:v1:profile:s1" });
    const b = await fire({ user: "900", customId: "coc:v1:pf-pick:s1", select: "101" });
    const c = await fire({ user: "900", customId: "coc:v1:pf-bg-0:s1:101" });
    const d = await fire({ user: "900", customId: "coc:v1:pf-list-0:s1" });
    check(a.replies[0]?.flags === 64 && a.replies[0].content.includes("进行中")
      && b.updates[0]?.content.includes("进行中") && !b.updates[0].embeds?.length
      && c.updates[0]?.content.includes("进行中") && !c.updates[0].embeds?.length
      && d.updates[0]?.content.includes("进行中"), `${state} 状态打开列表/选人/翻页全部拒绝`);
  }
  await setState("s1", "ACTIVE");

  // 旧 session 无 characterSheet
  await store.update((current) => ({ state: { ...current, sessions: current.sessions.map((s) => s.sessionId === "s1" ? { ...s, pl: s.pl.map((m) => { const { characterSheet, ...rest } = m; return m.userId === "102" ? rest : m; }) } : s) }, result: null }));
  fetchCount = 0;
  r = await fire({ user: "900", customId: "coc:v1:pf-pick:s1", select: "102" });
  check(r.updates[0]?.content === NO_SHEET_MESSAGE && fetchCount === 0, "旧 session 无完整档案时安全提示且不补读长期卡");
  router.destroy();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 纯展示：Discord 限制、分页不丢内容、提及与 Markdown
{
  const longSkills = Array.from({ length: 400 }, (_, i) => ({ name: `超长技能名${"术".repeat(60)}${i}`, specialty: "专精", base: 1, growth: 2, occupationPoints: 3, interestPoints: 4 }));
  const history = `开头${"经历".repeat(20000)}结尾标记`;
  const member = { userId: "1", characterName: "@everyone **粗体** <@123>", characterSheet: {
    character: { identity: { name: "@here _斜体_" }, characteristics: {}, occupation: { name: "x" }, skills: longSkills,
      background: { personalHistory: history, beliefs: "@everyone <@&555> `code` ||spoiler||" },
      weapons: Array.from({ length: 300 }, (_, i) => ({ name: `武器${i}`, note: "备注".repeat(50) })) },
    derived: { hp: 10 }, updatedAt: null } };
  const session = { sessionId: "s1", pl: [member] };
  let allOk = true; let allText = "";
  for (const [section] of PROFILE_SECTIONS) {
    const pages = profilePages(member.characterSheet, section);
    for (let page = 0; page < pages.length; page++) {
      const view = profileView(session, member, section, page);
      const embed = view.embeds[0];
      const total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text?.length ?? 0)
        + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
      if (embed.description.length > PROFILE_LIMITS.description || total > PROFILE_LIMITS.embedTotal
        || (view.content ?? "").length > PROFILE_LIMITS.content || (embed.fields ?? []).some((f) => f.value.length > PROFILE_LIMITS.fieldValue)
        || embed.title.length > 256) allOk = false;
      if (view.allowedMentions?.parse?.length !== 0) allOk = false;
      allText += embed.description + embed.title;
    }
  }
  check(allOk, "长技能/长背景/长装备每页 description≤4096、embed≤6000、field≤1024、content≤2000 且 allowedMentions.parse=[]");
  check(profilePages(member.characterSheet, "sk").length > 1 && profilePages(member.characterSheet, "bg").length > 1, "长区块分页");
  check(allText.includes("超长技能名") && allText.includes(`${"术".repeat(60)}399`) && allText.includes("结尾标记") && allText.includes("武器299"), "分页不静默丢内容");
  check(!/@everyone|@here|<@123>|<@&555>/.test(allText), "@everyone/@here/用户/身份组提及被中和");
  check(!allText.includes("**粗体**") && allText.includes("\\*\\*粗体\\*\\*") && allText.includes("\\`code\\`") && allText.includes("\\|\\|spoiler\\|\\|"), "玩家文本 Markdown 被转义");

  const truncated = profileView(session, { ...member, characterSheet: { ...member.characterSheet, truncated: true } }, "ov", 0);
  check(truncated.embeds[0].description.startsWith(TRUNCATED_NOTE) && TRUNCATED_NOTE.includes("档案过长，部分内容未保存"), "截断档案展示时提示");
  check(profileMemberPicker({ sessionId: "s1", pl: [] }).content === NO_PL_MESSAGE, "没有 PL 显示「本局目前没有调查员。」");
  const many = { sessionId: "s1", pl: Array.from({ length: 30 }, (_, i) => ({ userId: `${1000 + i}`, characterName: `PL${i}`, occupation: "医生" })) };
  const first = profileMemberPicker(many, 0); const second = profileMemberPicker(many, 1);
  check(first.components[0].toJSON().components[0].options.length === 25 && second.components[0].toJSON().components[0].options.length === 5
    && second.components[0].toJSON().components[0].options[0].value === "1025", "PL 超过 25 人分页选择");
  check(first.components[1].toJSON().components[1].custom_id === "coc:v1:pf-list-1:s1", "列表翻页 customId 只含 sessionId 与页码");
  const navIds = profileView(session, member, "sk", 1).components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
  check(navIds.every((id) => id.length <= 100 && /^coc:v1:pf-(ov|at|sk|bg|eq|list)-\d+:s1(:1)?$/.test(id)), "翻页 customId 只含区块、页码、sessionId、目标 userId");
  check(profileView(session, { userId: "1", characterName: "旧" }, "ov", 0).content === NO_SHEET_MESSAGE, "无 characterSheet 不崩溃");
  {
    const stat = { ...member, characterId: "c", initialHp: 12, initialSan: 60, initialMp: 9 };
    const ov = (extra) => profileView(session, { ...stat, ...extra }, "ov", 0).embeds[0].description;
    check(ov({ current: { hp: 8, san: 55, mp: 3 } }).startsWith("**当前状态**：HP 8/12　SAN 55/99　MP 3/9\n"), "KP 概览首行显示当前 HP/SAN/MP");
    check(ov({}).startsWith("**当前状态**：HP 12/12　SAN 60/99　MP 9/9\n"), "老快照概览用初始值回填");
    check(!profileView(session, { ...stat, current: { hp: 8, san: 55, mp: 3 } }, "at", 0).embeds[0].description.includes("当前状态"), "其他区块不加当前状态");
  }
}

// 分页：优先换行；跨页边界的 \* 不被切断；不切断 surrogate pair；每页 ≤ PAGE_CHARS
{
  function escapesComplete(page) {
    for (let i = 0; i < page.length; i++) {
      if (page[i] === "\\") {
        if (i + 1 >= page.length) return false;
        i += 1;
      }
    }
    return true;
  }
  // 旧硬切会在 PAGE_CHARS 处把 \ 和 * 拆开
  const escapedStar = safeText("*");
  check(escapedStar === "\\*", "safeText(*) 生成 \\*");
  const across = "a".repeat(PAGE_CHARS - 1) + escapedStar + "b".repeat(80);
  const starPages = splitTextPages(across, PAGE_CHARS);
  check(starPages.length >= 2, "边界 \\* 场景会分页");
  check(starPages.every((page) => page.length <= PAGE_CHARS), "边界 \\* 每页不超过 PAGE_CHARS");
  check(starPages.every(escapesComplete), "每页转义序列完整（无页以悬挂 \\ 结尾）");
  check(starPages.some((page) => page.includes("\\*")), "完整 \\* 落在同一页");
  check(!starPages.some((page) => page.endsWith("\\") && !page.endsWith("\\\\")), "没有页以单个未配对 \\ 结尾");
  check(starPages.join("") === across, "无换行文本分页后拼接还原");

  // 多个转义贴在边界
  const multi = "x".repeat(PAGE_CHARS - 3) + safeText("*_~") + "z".repeat(20);
  const multiPages = splitTextPages(multi, PAGE_CHARS);
  check(multiPages.every((page) => page.length <= PAGE_CHARS) && multiPages.every(escapesComplete)
    && multiPages.join("") === multi, "连续转义贴边界时仍完整且不超长");

  // 优先在换行处切
  const line = "行内容".repeat(30);
  const lined = Array.from({ length: 40 }, () => line).join("\n");
  const linePages = splitTextPages(lined, PAGE_CHARS);
  check(linePages.length > 1 && linePages.every((page) => page.length <= PAGE_CHARS), "换行文本分页且每页不超长");
  check(linePages.every((page) => !page.endsWith("\n")), "换行切点不把分隔换行留在页尾");
  check(linePages.join("\n") === lined, "换行切页拼接还原");
  check(linePages.every((page) => !page.includes("\n") || page.split("\n").every((seg) => seg.length <= PAGE_CHARS)), "各行本身不超过上限");

  // surrogate pair：emoji 正好卡在旧硬切点
  const emoji = "😀";
  check(emoji.length === 2, "测试用 emoji 是 surrogate pair");
  const emojiText = "a".repeat(PAGE_CHARS - 1) + emoji + "尾";
  const emojiPages = splitTextPages(emojiText, PAGE_CHARS);
  check(emojiPages.every((page) => page.length <= PAGE_CHARS), "代理对场景每页不超长");
  check(emojiPages.some((page) => page.includes(emoji)), "emoji 完整在同一页");
  check(emojiPages.every((page) => {
    const last = page.charCodeAt(page.length - 1);
    const first = page.charCodeAt(0);
    return !(last >= 0xD800 && last <= 0xDBFF) && !(first >= 0xDC00 && first <= 0xDFFF);
  }), "不切断 surrogate pair");
  check(emojiPages.join("") === emojiText, "代理对文本拼接还原");

  // 真实档案路径：长背景含 * 与换行，经 profilePages 后每页转义完整
  const history = `${"前".repeat(100)}*星号*${"中".repeat(2000)}\n第二段*再星*${"后".repeat(2000)}`;
  const bgSheet = { character: { background: { personalHistory: history } }, derived: {} };
  const bgPages = profilePages(bgSheet, "bg");
  check(bgPages.every((page) => page.length <= PAGE_CHARS), "档案背景分页每页正文 ≤ PAGE_CHARS");
  check(bgPages.every(escapesComplete), "档案背景每页转义完整");
  check(bgPages.some((page) => page.includes("\\*")), "背景中的 \\* 完整出现");
}

// 属性页：初始 SAN 与派生字段中文标签
{
  const base = { identity: { name: "甲" }, characteristics: { str: 50, luck: 55 }, occupation: { name: "x" }, skills: [] };
  const derived = { hp: 11, majorWound: 6, mp: 14, sanMaximum: 99, mov: 8, build: 0, damageBonus: "0", movAdjust: 0 };
  const attrText = (character) => profilePages({ character, derived }, "at").join("\n");
  const withSan = attrText({ ...base, initialSan: 65 });
  check(withSan.includes("**初始理智 SAN**：65"), "属性页显示 character.initialSan");
  check(withSan.includes("**幸运 Luck**：55") && withSan.includes("**生命值 HP**：11") && withSan.includes("**魔法值 MP**：14"), "Luck 仍取 characteristics.luck，HP/MP 仍取 derived");
  check(withSan.includes("**重伤阈值**：6") && withSan.includes("**理智上限**：99") && withSan.includes("**移动力调整**：0"), "majorWound/sanMaximum/movAdjust 显示中文标签");
  check(!/majorWound|sanMaximum|movAdjust/.test(withSan), "属性页不出现 majorWound、sanMaximum、movAdjust 英文 key");
  for (const [label, value] of [["缺失", undefined], ["字符串", "65"], ["null", null], ["NaN", Number.NaN]]) {
    const character = { ...base }; if (value !== undefined) character.initialSan = value;
    let text = "";
    try { text = attrText(character); } catch { text = null; }
    check(text !== null && text.includes("**初始理智 SAN**：—"), `initialSan ${label}时显示「—」不报错`);
  }
}

console.log(`${passed} passed / ${failed} failed`);
if (failed) process.exit(1);
