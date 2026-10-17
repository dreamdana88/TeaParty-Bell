import { createCharacterClient } from "./characterClient.js";
import { buildCharacterSheet, CHARACTER_SHEET_MAX_BYTES } from "./characterSheet.js";
import { findSnapshotSkill } from "./textDice.js";

let passed = 0; let failed = 0;
function check(ok, label) { if (ok) { passed++; console.log(`PASS: ${label}`); } else { failed++; console.error(`FAIL: ${label}`); } }

function fullCard(overrides = {}) {
  return {
    schemaVersion: 1, ruleset: "coc7", id: "card-a", ownerDiscordUserId: "100",
    identity: { name: "奈洛莉", age: 27, sex: "女", era: "1920s", residence: "阿卡姆", birthplace: "波士顿" },
    characteristics: { str: 50, con: 60, siz: 55, dex: 70, app: 65, int: 75, pow: 70, edu: 80, luck: 60 },
    initialSan: 70, occupation: { name: "演员" },
    skills: [{ name: "艺术", specialty: "演技", base: 5, growth: 0, occupationPoints: 45, interestPoints: 10 }],
    background: { appearance: "银发", beliefs: "相信命运", personalHistory: "在剧团长大" },
    weapons: [{ name: "左轮", damage: "1d10" }], armor: null,
    possessions: { items: [{ name: "怀表" }] }, spells: [{ name: "联络诺登斯" }],
    ...overrides,
  };
}
function clientFor(card, extra = {}) {
  return createCharacterClient({ baseUrl: "http://127.0.0.1:8787", secret: "s", fetchImpl: async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, character: structuredClone(card), derived: { hp: 11, mp: 14, mov: 8, build: 0, damageBonus: "0" }, updatedAt: "2026-10-01T00:00:00Z", ...extra }),
  }) });
}

{
  const card = fullCard();
  const read = await clientFor(card).read("card-a", "100");
  const snap = read.snapshot;
  check(read.ok && snap.characterSheet?.character?.background?.beliefs === "相信命运"
    && snap.characterSheet.derived.mov === 8 && snap.characterSheet.updatedAt === "2026-10-01T00:00:00Z", "选卡快照含完整 characterSheet");
  check(!snap.characterSheet.truncated, "正常卡不标记截断");
  check(snap.characterId === "card-a" && snap.ownerDiscordUserId === "100" && snap.characterName === "奈洛莉" && snap.occupation === "演员"
    && snap.initialHp === 11 && snap.initialSan === 70 && snap.initialMp === 14 && snap.initialLuck === 60
    && JSON.stringify(snap.skills) === JSON.stringify(card.skills), "旧快照字段全部保留且值不变");
  const dice = findSnapshotSkill(snap, "演技");
  check(dice.ok && dice.value === 60, "技能骰仍从 snapshot.skills 读取");
  snap.characterSheet.character.skills[0].base = 99;
  check(findSnapshotSkill(snap, "演技").value === 60, "技能骰不读 characterSheet");
}
{
  const bad = fullCard({ background: { appearance: 123, beliefs: "ok", scars: { x: 1 } }, weapons: "刀", spells: { a: 1 }, armor: 5, possessions: "一堆" });
  const read = await clientFor(bad).read("card-a", "100");
  const c = read.snapshot?.characterSheet?.character;
  check(read.ok, "类型错误的自由文本不导致选卡失败");
  check(c.background.beliefs === "ok" && !("appearance" in c.background) && !("scars" in c.background), "background 非字符串字段被丢弃");
  check(!("weapons" in c) && !("spells" in c) && !("armor" in c) && !("possessions" in c), "weapons/spells/armor/possessions 类型错误被丢弃");
  const notObject = await clientFor(fullCard({ background: ["x"] })).read("card-a", "100");
  check(notObject.ok && !("background" in notObject.snapshot.characterSheet.character), "background 非对象被丢弃");
}
{
  const huge = fullCard({ background: { personalHistory: "长".repeat(200_000), beliefs: "<@&1> @everyone" },
    weapons: Array.from({ length: 2000 }, (_, i) => ({ name: `武器${i}`, note: "注".repeat(100) })) });
  const read = await clientFor(huge).read("card-a", "100");
  const sheet = read.snapshot?.characterSheet;
  check(read.ok, "超大卡选卡仍然成功");
  check(sheet.truncated === true, "超大卡标记 truncated");
  check(Buffer.byteLength(JSON.stringify(sheet), "utf8") <= CHARACTER_SHEET_MAX_BYTES, "超大卡快照序列化不超过 64KB");
  check(sheet.character.identity.name === "奈洛莉" && sheet.character.background.personalHistory.startsWith("长"), "截断保留开头内容");
  check(JSON.stringify(read.snapshot.skills) === JSON.stringify(huge.skills), "截断不影响技能快照");
  const extreme = buildCharacterSheet(fullCard({ skills: Array.from({ length: 5000 }, (_, i) => ({ name: `技能${"名".repeat(200)}${i}`, base: 1, growth: 0, occupationPoints: 0, interestPoints: 0 })) }), {}, null);
  check(extreme.truncated === true && Buffer.byteLength(JSON.stringify(extreme), "utf8") <= CHARACTER_SHEET_MAX_BYTES, "极端卡也不超过上限");
}
{
  const card = fullCard();
  const sheet = buildCharacterSheet(card, { hp: 1 }, "t");
  card.background.beliefs = "已修改"; card.weapons.length = 0;
  check(sheet.character.background.beliefs === "相信命运" && sheet.character.weapons.length === 1, "快照是深拷贝，长期卡修改不影响");
}
console.log(`${passed} passed / ${failed} failed`);
if (failed) process.exit(1);
