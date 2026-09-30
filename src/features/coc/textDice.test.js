import { attachTextDiceListener, formatBonusPenalty, formatTextDice, isWholeMessageDice, messageNeedsTextDice } from "./textDice.js";

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

assertEqual(formatTextDice("user", {
  notation: "1d100", count: 1, rolls: [79], modifier: 0, total: 79,
}), "<@user> 🎲 1d100 = 79", "单骰 1d100");
assertEqual(formatTextDice("user", {
  notation: "1d4", count: 1, rolls: [3], modifier: 0, total: 3,
}), "<@user> 🎲 1d4 = 3", "单骰 1d4");
assertEqual(formatTextDice("user", {
  notation: "2d6", count: 2, rolls: [1, 5], modifier: 0, total: 6,
}), "<@user> 🎲 2d6 → [1, 5] = 6", "多骰列出每一颗");
assertEqual(formatTextDice("user", {
  notation: "2d6+3", count: 2, rolls: [1, 5], modifier: 3, total: 9,
}), "<@user> 🎲 2d6+3 → [1, 5] + 3 = 9", "多骰加修正");
assertEqual(formatTextDice("user", {
  notation: "3d8-2", count: 3, rolls: [4, 7, 2], modifier: -2, total: 11,
}), "<@user> 🎲 3d8-2 → [4, 7, 2] - 2 = 11", "多骰减修正");
assertEqual(formatTextDice("user", {
  notation: "2d6+3", count: 2, rolls: [1, 5], modifier: 3, total: 9,
}).includes("[1, 5]"), true, "展示用传入的骰面，不另掷");
assertEqual(formatBonusPenalty("user", {
  notation: "1D100 奖励1", candidates: [57, 27], total: 27,
}), "<@user> 🎲 1D100 奖励1 → [57, 27] = 27", "奖励1 展示候选");
assertEqual(formatBonusPenalty("user", {
  notation: "1D100 奖励2", candidates: [74, 34, 94], total: 34,
}), "<@user> 🎲 1D100 奖励2 → [74, 34, 94] = 34", "奖励2 展示候选");
assertEqual(formatBonusPenalty("user", {
  notation: "1D100 惩罚1", candidates: [43, 83], total: 83,
}), "<@user> 🎲 1D100 惩罚1 → [43, 83] = 83", "惩罚1 展示候选");
assertEqual(formatBonusPenalty("user", {
  notation: "1D100 惩罚2", candidates: [24, 64, 94], total: 94,
}), "<@user> 🎲 1D100 惩罚2 → [24, 64, 94] = 94", "惩罚2 展示候选");

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
  let bonusReads = 0;
  const lobbyBonus = {
    guildId: "g",
    author: { bot: false },
    get content() { bonusReads += 1; return "1D100 奖励1"; },
  };
  assert(messageNeedsTextDice(lobbyBonus, false) === false, "普通频道不读奖励骰正文");
  assertEqual(bonusReads, 0, "普通频道没有碰到奖励骰正文");
  for (const bad of ["2D100 奖励1", "1D20 奖励1", "1D100 奖励3", "我投一个1D100 奖励1"]) {
    assert(messageNeedsTextDice({ guildId: "g", author: { bot: false }, content: bad }, true) === false, `不触发 ${bad}`);
  }
  assert(messageNeedsTextDice({ guildId: "g", author: { bot: true }, content: "1D100 惩罚1" }, true) === false, "Bot 的惩罚骰不掷");
  assert(messageNeedsTextDice({ guildId: "g", author: { bot: false }, content: "  1d100 奖励2  " }, true) === true, "整句奖励骰才读");
  assert(messageNeedsTextDice({ guildId: "g", author: { bot: false }, content: "1D100 惩罚2" }, true) === true, "整句惩罚骰才读");
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
        return { ok: true, text: "<@pl> 🎲 2d6+3 → [3, 4] + 3 = 10" };
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
  assert(replies.length === 1 && replies[0].content.startsWith("<@pl> 🎲"), "合法整句回复里 @ 触发者");
  assertEqual(replies[0].allowedMentions?.users?.[0], "pl", "只允许 @ 触发骰子的用户");
  assert(replies[0].allowedMentions?.parse?.length === 0, "不解析消息里的其他提及");
  assert(replies[0].allowedMentions?.repliedUser === false, "回复引用不再额外 @ 一次");
  assert(!replies.some((payload) => String(payload.content).includes("无效")), "非法或失败都不回复报错");
  await handler({ ...base, content: "1D100 奖励3" });
  await handler({ ...base, content: "1D100 奖励1" });
  const bonusReply = replies.at(-1);
  assert(calls.at(-1) === "1D100 奖励1", "奖励骰整句会交给掷骰");
  assert(!calls.includes("1D100 奖励3"), "非法奖励骰不交给掷骰");
  assertEqual(bonusReply.allowedMentions?.users?.[0], "pl", "奖励骰也只 @ 触发者");
  assert(bonusReply.allowedMentions?.parse?.length === 0 && bonusReply.allowedMentions?.repliedUser === false, "奖励骰不解析其他提及");
  detach();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
