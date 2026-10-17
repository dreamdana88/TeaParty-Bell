import { applyDelta, currentStats, parseStatCommand, rollAmount } from "./currentStats.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const sc = parseStatCommand("sc 1d3/1d20");
assert(sc.ok && sc.kind === "sc" && sc.success.dice.notation === "1d3" && sc.failure.dice.notation === "1d20", "sc 1d3/1d20");
assert(parseStatCommand("SC 0/1d6").failure.dice.sides === 6 && parseStatCommand("sc 0/1d6").success.fixed === 0, "sc 0/1d6，大小写不敏感");
assert(parseStatCommand("  sc 1/1d10  ").ok, "两端空白与其他文字骰一致忽略");
const hp = parseStatCommand("hp <@123> -5");
assert(hp.ok && hp.stat === "hp" && hp.targetUserId === "123" && hp.sign === -1 && hp.amount.fixed === 5, "hp <@123> -5");
const san = parseStatCommand("san <@!123> +1d3");
assert(san.ok && san.stat === "san" && san.sign === 1 && san.amount.dice.notation === "1d3", "san <@!123> +1d3");
assert(parseStatCommand("st").kind === "st" && parseStatCommand("ST").ok, "st");
for (const bad of [
  "st一下", "hp快没了", "sc是啥", "sc", "st 啊", "我 st", "sc 0/1d6 吧", "请 sc 0/1d6", "sc 0/", "sc /1d6", "sc 0 / 1d6", "sc0/1d6",
  "sc 0/1d6/2", "sc 0/21d6", "sc 0/1d1", "sc -1/1d6", "sc 1000/1", "hp <@123> 5", "hp <@123> -", "hp @某人 -5", "hp <@123>-5",
  "hp <@123> -5 点", "hp <@abc> -5", "hp <@&123> -5", "hp <@123> - 5", "hp <@123> -21d6", "luck <@123> -5", "hpp <@123> -5", "",
]) {
  assert(parseStatCommand(bad).ok === false, `不认 ${JSON.stringify(bad)}`);
}
assert(parseStatCommand(`sc 0/${"1".repeat(200)}`).ok === false && parseStatCommand(42).ok === false, "超长与非字符串不认");

const member = { characterId: "c", initialHp: 12, initialSan: 60, initialMp: 9 };
assert(JSON.stringify(currentStats(member)) === JSON.stringify({ current: { hp: 12, san: 60, mp: 9 }, max: { hp: 12, san: 99, mp: 9 } }), "缺 current 用初始值补");
assert(currentStats({ ...member, current: { hp: 3, san: 0, mp: 9 } }).current.san === 0, "current 0 有效");
assert(currentStats({ ...member, current: { hp: 30 } }).current.hp === 12, "超上限的 current 截到上限");
assert(currentStats({ ...member, initialHp: "12" }) === null && currentStats({ ...member, characterId: undefined }) === null, "初始值异常或未绑卡返回 null");
const stats = currentStats(member);
assert(JSON.stringify(applyDelta(stats, "hp", 5)) === JSON.stringify({ before: 12, after: 12, note: "，已截断到上限 12" }), "加值溢出截断到上限");
assert(applyDelta(stats, "mp", -20).note === "，已截断到下限 0" && applyDelta(stats, "mp", -20).after === 0, "下限 0");
assert(applyDelta(stats, "san", 50).after === 99, "SAN 上限 99");
assert(applyDelta(stats, "hp", -2).note === "", "未越界不提示");
const faces = [4, 2];
assert(JSON.stringify(rollAmount(parseStatCommand("sc 0/2d6+1").failure, () => faces.shift())) === JSON.stringify({ value: 7, label: "2d6+1=7" }), "骰子加修正");
assert(rollAmount(parseStatCommand("sc 0/1d6").failure, () => { throw new Error("不该掷"); }, true).label === "1d6 取最大=6", "取最大值不掷骰");
assert(rollAmount(parseStatCommand("sc 0/1d3-5").failure, () => 1).value === 0, "骰子负结果按 0 计");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
