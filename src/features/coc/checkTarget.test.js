import { findCharacteristic, resolveCheckTarget, findSnapshotSkill } from "./textDice.js";

let passed = 0; let failed = 0;
function check(ok, label) { if (ok) { passed++; console.log(`PASS: ${label}`); } else { failed++; console.error(`FAIL: ${label}`); } }

const nine = { str: 50, con: 60, siz: 55, dex: 43, app: 65, int: 75, pow: 70, edu: 80, luck: 33 };
const member = { characterId: "c", initialLuck: 99, characteristics: { ...nine }, characterSheet: { character: { characteristics: { dex: 1 } } },
  skills: [{ name: "侦查", base: 25, growth: 0, occupationPoints: 20, interestPoints: 0 }, { name: "敏捷", base: 1, growth: 0, occupationPoints: 0, interestPoints: 0 }] };

const pairs = [["力量", "STR", "str"], ["体质", "CON", "con"], ["体型", "SIZ", "siz"], ["敏捷", "DEX", "dex"], ["外貌", "APP", "app"],
  ["智力", "INT", "int"], ["意志", "POW", "pow"], ["教育", "EDU", "edu"], ["幸运", "LUCK", "luck"]];
for (const [zh, en, key] of pairs) {
  for (const name of [zh, en, en.toLowerCase(), en[0] + en.slice(1).toLowerCase()]) {
    const r = resolveCheckTarget(member, name);
    check(r.ok && r.value === nine[key] && r.name === `${zh} ${en}`, `${name} 读到 ${key}`);
  }
}
check(findCharacteristic("侦查") === null && findCharacteristic("敏 捷") === null, "非属性名不识别为属性");
const spot = resolveCheckTarget(member, "侦查");
check(JSON.stringify(spot) === JSON.stringify(findSnapshotSkill(member, "侦查")) && spot.value === 45, "技能名仍走原技能逻辑");
check(resolveCheckTarget(member, "敏捷").value === 43, "属性名优先于同名自定义技能");
check(resolveCheckTarget({ ...member, characteristics: { ...nine, dex: undefined } }, "DEX").message === "本局角色属性数据异常，请联系 KP。", "不读 characterSheet 补值");
check(resolveCheckTarget(undefined, "敏捷").message === "请先绑定本局调查员角色卡。", "没卡时提示绑定");
check(resolveCheckTarget({ userId: "kp" }, "侦查").message === "请先绑定本局调查员角色卡。", "没卡时技能提示不变");
const legacy = { characterId: "c", initialLuck: 55, skills: [] };
check(resolveCheckTarget(legacy, "幸运").ok && resolveCheckTarget(legacy, "luck").value === 55, "老 Session 幸运回退 initialLuck");
check(resolveCheckTarget(legacy, "敏捷").message === "本局角色属性数据异常，请联系 KP。", "老 Session 其它属性报数据异常");
check(!resolveCheckTarget({ ...legacy, initialLuck: "55" }, "幸运").ok, "initialLuck 非法不回退");
for (const bad of [-1, 2.5, "40", null, Number.MAX_SAFE_INTEGER + 1]) {
  check(resolveCheckTarget({ ...member, characteristics: { ...nine, pow: bad } }, "意志").message === "本局角色属性数据异常，请联系 KP。", `属性值 ${String(bad)} 报数据异常`);
}
check(!resolveCheckTarget({ ...member, characteristics: [] }, "幸运").ok, "characteristics 结构非法时幸运也不回退");
console.log(`${passed} passed / ${failed} failed`);
if (failed) process.exit(1);
