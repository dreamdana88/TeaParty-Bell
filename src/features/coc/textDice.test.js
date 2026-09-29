import { formatTextD100, isWholeMessageD100, messageNeedsTextDice } from "./textDice.js";

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

assert(isWholeMessageD100("1d100"), "整句 1d100");
assert(isWholeMessageD100("  1D100  "), "忽略大小写和两端空白");
assert(!isWholeMessageD100("1d100 请"), "后面有字不算整句");
assert(!isWholeMessageD100("请 1d100"), "前面有字不算整句");
assert(!isWholeMessageD100("1d100+1"), "不接受修正值");
assert(!isWholeMessageD100("2d6"), "不接受其他骰式");
assert(!isWholeMessageD100(""), "空消息不掷");
assertEqual(formatTextD100("奈洛莉", 63), "奈洛莉 🎲 1d100 = 63", "文字骰子回复格式");

{
  let reads = 0;
  const lobby = {
    guildId: "g",
    author: { bot: false },
    get content() { reads += 1; return "1d100"; },
  };
  assert(messageNeedsTextDice(lobby, false) === false, "普通频道不读正文");
  assertEqual(reads, 0, "普通频道没有碰到消息正文");
  assert(messageNeedsTextDice({
    guildId: "g",
    author: { bot: false },
    content: "你好",
  }, true) === false, "进行中的频道里普通句子不掷");
  assert(messageNeedsTextDice({ guildId: "g", author: { bot: true }, content: "1d100" }, true) === false, "Bot 的 1d100 不掷");
  assert(messageNeedsTextDice({ guildId: "g", author: { bot: false }, content: "1d100" }, true) === true, "进行中的频道里整句 1d100 才读");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
