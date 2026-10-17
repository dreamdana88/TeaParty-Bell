import { findSnapshotSkill, snapshotSkillValue } from "./textDice.js";

let passed = 0; let failed = 0;
function check(ok, label) { if (ok) { passed++; console.log(`PASS: ${label}`); } else { failed++; console.error(`FAIL: ${label}`); } }

// 原 findSnapshotSkill 求和逻辑的逐字复刻，用作对照基准。
function legacy(skill) {
  const values = [skill.base, skill.growth, skill.occupationPoints, skill.interestPoints];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return { ok: false, message: "本局技能数据异常，请联系 KP。" };
  const value = values.reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(value)) return { ok: false, message: "本局技能数据异常，请联系 KP。" };
  return { ok: true, value };
}
const cases = [
  { base: 5, growth: 0, occupationPoints: 45, interestPoints: 0 },
  { base: 0, growth: 0, occupationPoints: 0, interestPoints: 0 },
  { base: 25, growth: 7, occupationPoints: 30, interestPoints: 20 },
  { base: 99, growth: 1, occupationPoints: 0, interestPoints: 0 },
  { base: -1, growth: 0, occupationPoints: 0, interestPoints: 0 },
  { base: 1.5, growth: 0, occupationPoints: 0, interestPoints: 0 },
  { base: "5", growth: 0, occupationPoints: 0, interestPoints: 0 },
  { base: 5, growth: null, occupationPoints: 0, interestPoints: 0 },
  { base: Number.MAX_SAFE_INTEGER, growth: 1, occupationPoints: 0, interestPoints: 0 },
];
cases.forEach((skill, index) => {
  const member = { characterId: "c", skills: [{ name: `技能${index}`, ...skill }] };
  const before = legacy(skill);
  const after = findSnapshotSkill(member, `技能${index}`);
  const shared = snapshotSkillValue(skill);
  check(JSON.stringify(before.ok ? { ok: true, name: `技能${index}`, value: before.value } : before) === JSON.stringify(after), `用例 ${index} 掷骰结果与原实现完全一致`);
  check(shared === (before.ok ? before.value : null), `用例 ${index} 共用函数与原求和一致`);
});
console.log(`${passed} passed / ${failed} failed`);
if (failed) process.exit(1);
