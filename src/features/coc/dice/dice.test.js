import { parseDiceExpression, INVALID_DICE_MESSAGE } from "./parser.js";
import { formatRoll, rollDice } from "./roller.js";

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

{
  const parsed = parseDiceExpression("1d100");
  assert(parsed.ok && parsed.count === 1 && parsed.sides === 100 && parsed.modifier === 0, "1d100");
}
{
  const parsed = parseDiceExpression("  2d6+3 ");
  assert(parsed.ok && parsed.notation === "2d6+3" && parsed.modifier === 3, "2d6+3");
}
{
  const parsed = parseDiceExpression("3d10-2");
  assert(parsed.ok && parsed.modifier === -2, "3d10-2");
}
for (const bad of ["今天运气大概1d100吧", "cc 70", "0d6", "21d6", "1d1", "1d100001", "2d6+100001", "(1d6)", ""]) {
  assert(parseDiceExpression(bad).ok === false, `拒绝 ${bad || "空"}`);
}

{
  let n = 0;
  const values = [4, 6];
  const rolled = rollDice("2d6+3", () => values[n++]);
  assertEqual(rolled.total, 13, "2d6+3 合计 13");
  assertEqual(formatRoll("奈洛莉", rolled), "🎲 奈洛莉掷骰\n\n2d6+3\n[4, 6] + 3 = 13", "带修正文案");
}
{
  const rolled = rollDice("1d100", () => 66);
  assertEqual(formatRoll("奈洛莉", rolled), "🎲 奈洛莉掷骰\n\n1d100 → 66", "单骰文案");
}
assert(INVALID_DICE_MESSAGE.includes("1d100"), "非法提示含示例");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
