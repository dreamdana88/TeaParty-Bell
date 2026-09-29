import { attachTextDiceListener, isWholeMessageDice, messageNeedsTextDice } from "./textDice.js";

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

for (const expression of ["1d4", "1d6", "1d20", "1d100", "2d6", "2d6+3", "2d6-1"]) {
  assert(isWholeMessageDice(expression), `整句 ${expression}`);
}
assert(isWholeMessageDice("  1D100  "), "忽略大小写和两端空白");
assert(isWholeMessageDice("2D6+3"), "修正值忽略大小写");
assert(!isWholeMessageDice("1d100 请"), "后面有字不算整句");
assert(!isWholeMessageDice("请 1d100"), "前面有字不算整句");
assert(!isWholeMessageDice("今天运气大概1d100吧"), "句子里夹着骰子不算整句");
assert(!isWholeMessageDice("请帮我掷 2d6+3"), "前面有字的骰子不算整句");
assert(!isWholeMessageDice("2d6 + 3"), "表达式中间的空格不算整句");
assert(!isWholeMessageDice("cc 70"), "技能检定不是这轮骰子");
assert(!isWholeMessageDice("0d6"), "非法个数不掷");
assert(!isWholeMessageDice("21d6"), "超过上限不掷");
assert(!isWholeMessageDice(""), "空消息不掷");

{
  let reads = 0;
  const lobby = {
    guildId: "g",
    author: { bot: false },
    get content() { reads += 1; return "2d6+3"; },
  };
  assert(messageNeedsTextDice(lobby, false) === false, "普通频道不读正文");
  assertEqual(reads, 0, "普通频道没有碰到消息正文");
  assert(messageNeedsTextDice({
    guildId: "g",
    author: { bot: false },
    content: "今天看看 1d100",
  }, true) === false, "进行中的频道里夹杂骰子的句子不掷");
  assert(messageNeedsTextDice({ guildId: "g", author: { bot: true }, content: "2d6+3" }, true) === false, "Bot 的骰子不掷");
  assert(messageNeedsTextDice({
    guildId: "g",
    system: true,
    author: { bot: false },
    content: "1d100",
  }, true) === false, "系统消息不掷");
  assert(messageNeedsTextDice({ guildId: "g", author: { bot: false }, content: "2d6-1" }, true) === true, "进行中的频道里整句骰子才读");
}

{
  const replies = [];
  const calls = [];
  let handler;
  const client = {
    on(_name, fn) { handler = fn; },
    off() {},
    removeListener() {},
  };
  const detach = attachTextDiceListener({
    client,
    service: {
      hasActiveRunChannel: (id) => id === "room",
      async rollTextDice(input) {
        calls.push(input.content);
        if (input.content === "1d6") return { ok: false, message: "骰子表达式无效" };
        return { ok: true, text: "🎲 奈洛莉掷骰\n\n2d6+3\n[3, 4] + 3 = 10" };
      },
    },
    logger: { warn() {} },
  });
  const base = {
    guildId: "g",
    channelId: "room",
    author: { bot: false, id: "pl", username: "dream" },
    async reply(payload) { replies.push(payload); },
  };
  await handler({ ...base, content: "今天运气大概1d100吧" });
  await handler({ ...base, author: { bot: true, id: "bot" }, content: "2d6+3" });
  await handler({ ...base, content: "1d6" });
  await handler({ ...base, content: "2d6+3", member: { displayName: "奈洛莉" } });
  assertEqual(calls.length, 2, "只有整句骰子才会交给掷骰");
  assert(replies.length === 1 && replies[0].content.includes("2d6+3"), "合法整句按 /r 文案回复");
  assert(replies[0].allowedMentions?.parse?.length === 0, "回复不解析提及");
  assert(!replies.some((payload) => String(payload.content).includes("无效")), "非法或失败都不回复报错");
  detach();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
