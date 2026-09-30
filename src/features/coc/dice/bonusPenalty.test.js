import { d100FromDigits, parseBonusPenalty, rollBonusPenalty } from "./bonusPenalty.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  if (actual === expected) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function rollScript(expression, values) {
  let index = 0;
  return rollBonusPenalty(parseBonusPenalty(expression), () => values[index++]);
}

assert(parseBonusPenalty("1D100 奖励1").ok && parseBonusPenalty("1D100 奖励1").notation === "1D100 奖励1", "1D100 奖励1");
assert(parseBonusPenalty("  1d100 奖励2  ").notation === "1D100 奖励2", "1d100 奖励2");
assert(parseBonusPenalty("1D100 惩罚1").kind === "penalty" && parseBonusPenalty("1D100 惩罚1").extra === 1, "1D100 惩罚1");
assert(parseBonusPenalty("1d100 惩罚2").notation === "1D100 惩罚2", "1d100 惩罚2");
for (const bad of ["2D100 奖励1", "1D20 奖励1", "1D100 奖励3", "我投一个1D100 奖励1", "1D100奖励1", "1D100 惩罚0", "1d100"]) {
  assert(parseBonusPenalty(bad).ok === false, `拒绝 ${bad}`);
}

assertEqual(d100FromDigits(0, 0), 100, "00 加 0 是 100");
assertEqual(d100FromDigits(0, 5), 5, "十位 0 个位 5 是 5");
assertEqual(d100FromDigits(9, 0), 90, "十位 9 个位 0 是 90");

{
  const rolled = rollScript("1D100 奖励1", [7, 5, 2]);
  assertEqual(JSON.stringify(rolled.candidates), JSON.stringify([57, 27]), "奖励1 候选是完整 D100");
  assertEqual(rolled.total, 27, "奖励骰取最小值");
}
{
  const rolled = rollScript("1d100 奖励2", [4, 7, 3, 9]);
  assertEqual(JSON.stringify(rolled.candidates), JSON.stringify([74, 34, 94]), "奖励2 三个候选");
  assertEqual(rolled.total, 34, "奖励2 取最小值");
}
{
  const rolled = rollScript("1D100 惩罚1", [3, 4, 8]);
  assertEqual(JSON.stringify(rolled.candidates), JSON.stringify([43, 83]), "惩罚1 候选");
  assertEqual(rolled.total, 83, "惩罚骰取最大值");
}
{
  const rolled = rollScript("1d100 惩罚2", [4, 2, 6, 9]);
  assertEqual(JSON.stringify(rolled.candidates), JSON.stringify([24, 64, 94]), "惩罚2 三个候选");
  assertEqual(rolled.total, 94, "惩罚2 取最大值");
}
{
  const rolled = rollScript("1D100 奖励1", [0, 0, 5]);
  assertEqual(JSON.stringify(rolled.candidates), JSON.stringify([100, 50]), "奖励骰保留 100 边界");
  assertEqual(rolled.total, 50, "奖励骰在 100 和 50 中取 50");
}
{
  const rolled = rollScript("1D100 惩罚1", [0, 0, 5]);
  assertEqual(JSON.stringify(rolled.candidates), JSON.stringify([100, 50]), "惩罚骰保留 100 边界");
  assertEqual(rolled.total, 100, "惩罚骰在 100 和 50 中取 100");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
