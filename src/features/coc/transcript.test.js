import { controlPanel, transcriptPrivacyPrompt } from "./panel.js";
import {
  buildTranscriptFile,
  buildTranscriptFiles,
  collectTranscriptHistory,
  formatTranscriptClock,
  selectTranscriptMessages,
  TRANSCRIPT_PART_MESSAGE_LIMIT,
  TRANSCRIPT_TRUNCATED_NOTICE,
  transcriptFileName,
} from "./transcript.js";

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

const session = {
  title: "常暗之厢",
  kpUserId: "kp",
  pl: [{ userId: "pl", characterName: "奈洛莉" }, { userId: "pl2", characterName: "江某" }],
  ob: [{ userId: "ob" }],
  transcriptOptOutUserIds: ["pl2"],
};

{
  const diceSession = { kpUserId: "1", pl: [{ userId: "2", characterName: "白夜行" }, { userId: "3", characterName: "隐私PL" }], transcriptOptOutUserIds: ["3"] };
  const msg = (id, authorId, userId) => ({ id, authorId, bot: true, type: 19, createdTimestamp: 2000,
    content: `**<@${userId}> 祝骰运昌隆喵~！**\n🎲 2d50 → [15, 7] = 22` });
  const selected = selectTranscriptMessages(diceSession, [msg("a", "bot", "2"), msg("b", "other", "2"),
    msg("c", "bot", "3"), msg("d", "bot", "outsider"),
    { ...msg("e", "bot", "2"), content: "开团管理通知" }], "bot");
  assertEqual(selected.length, 1, "只保留本Bot为允许记录的成员发出的骰点，忽略其他Bot和管理消息");
  assertEqual(selected[0].speaker, "小G宝", "团录注明骰点由小G宝发出");
  assert(selected[0].content.includes("白夜行") && selected[0].content.includes("[15, 7] = 22"), "团录提及转角色名且保留骰点");
  assertEqual(selectTranscriptMessages(diceSession, [{ ...msg("slash", "bot", "2"), type: 20 }], "bot").length, 1, "团录保留 /r 应用命令回复");
  const mention = selectTranscriptMessages(diceSession, [{ id: "mention", authorId: "1", content: "<@2> 请调查", type: 0, createdTimestamp: 2000 }], "bot");
  assertEqual(mention[0].content, "白夜行 请调查", "原文中的 Discord 提及转为发言时角色名，不依赖当前昵称");
}

{
  assertEqual(formatTranscriptClock(Date.parse("2026-09-28T12:15:00.000Z")), "20:15", "团录时间用上海时区");
  assertEqual(transcriptFileName("a/b:c"), "a b c团录.md", "文件名去掉路径字符");
  const entries = selectTranscriptMessages(session, [
    { id: "late", authorId: "pl", content: " 后一句 ", createdTimestamp: 2_000, type: 0 },
    { id: "ob", authorId: "ob", content: "旁观", createdTimestamp: 1_500, type: 0 },
    { id: "early", authorId: "kp", content: "先一句", createdTimestamp: 1_000, type: 19 },
    { id: "bot", authorId: "bot", bot: true, content: "机器人", createdTimestamp: 1_100, type: 0 },
    { id: "out", authorId: "pl2", content: "退出者", createdTimestamp: 1_200, type: 0 },
    { id: "pin", authorId: "kp", content: "置顶", createdTimestamp: 1_300, type: 6 },
    { id: "empty", authorId: "pl", content: "   ", createdTimestamp: 1_400, type: 0 },
  ], "bot");
  assertEqual(entries.map((entry) => entry.content).join("|"), "先一句|后一句", "只留下 KP 和未退出的 PL，并按时间排");
  const file = buildTranscriptFile(session, [
    { id: "a", authorId: "kp", content: "你们推开了地下室的门。", createdTimestamp: Date.parse("2026-09-28T12:15:00.000Z"), type: 0 },
  ]);
  assert(file.markdown.startsWith("# 《常暗之厢》团录\n\n[20:15] KP：\n你们推开了地下室的门。"), "团录标题和正文格式");
  assertEqual(file.name, "常暗之厢团录.md", "附件名带模组名");
}

{
  const shown = controlPanel(session, { transcript: true });
  const hidden = controlPanel(session);
  assertEqual(shown.components.length, 2, "团录开关打开时多一行隐私按钮");
  assertEqual(hidden.components.length, 1, "团录开关关闭时不出现隐私按钮");
  assertEqual(shown.components[1].toJSON().components[0].label, "团录与隐私", "按钮文字是团录与隐私");
  const recording = transcriptPrivacyPrompt(false, "s1");
  const paused = transcriptPrivacyPrompt(true, "s1");
  assertEqual(recording.components[0].toJSON().components[0].label, "不记录我之后的消息", "未退出时可以选择从现在起不记录");
  assertEqual(paused.components[0].toJSON().components[0].label, "恢复记录我之后的消息", "已退出时可以恢复之后的记录");
  assert(recording.content.includes("从现在起") && recording.content.includes("只跳过之后的新消息"), "未退出的说明是时间段，不是整局删除");
  assert(paused.content.includes("从现在起") && paused.content.includes("不会补上"), "已退出的说明是时间段，恢复不补旧消息");
}

{
  const timed = {
    title: "时间段",
    kpUserId: "kp",
    pl: [{ userId: "ob", characterName: "后来" }],
    ob: [{ userId: "pl" }],
    transcriptSeats: [
      { userId: "kp", role: "kp", name: "KP", from: 0, until: null },
      { userId: "pl", role: "pl", name: "奈洛莉", from: 1_000, until: 3_000 },
      { userId: "ob", role: "pl", name: "后来", from: 4_000, until: null },
    ],
    transcriptOptOutSpans: [
      { userId: "kp", from: 1_500, until: 2_500 },
    ],
  };
  const entries = selectTranscriptMessages(timed, [
    { id: "a", authorId: "pl", content: "入座", createdTimestamp: 1_000, type: 0 },
    { id: "b", authorId: "pl", content: "离座当刻", createdTimestamp: 3_000, type: 0 },
    { id: "c", authorId: "pl", content: "旁观", createdTimestamp: 3_500, type: 0 },
    { id: "d", authorId: "ob", content: "还在看", createdTimestamp: 2_000, type: 0 },
    { id: "e", authorId: "ob", content: "入座了", createdTimestamp: 4_000, type: 0 },
    { id: "f", authorId: "kp", content: "退出前", createdTimestamp: 1_200, type: 0 },
    { id: "g", authorId: "kp", content: "退出中", createdTimestamp: 1_500, type: 0 },
    { id: "h", authorId: "kp", content: "恢复后", createdTimestamp: 2_500, type: 0 },
  ], "bot");
  assertEqual(
    entries.map((entry) => `${entry.speaker}:${entry.content}`).join("|"),
    "奈洛莉:入座|KP:退出前|KP:恢复后|后来:入座了",
    "按发送当时的身份和退出时间段过滤",
  );
}

function kpLines(count, from = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `k${from + index}`,
    authorId: "kp",
    content: `句${from + index}`,
    createdTimestamp: from + index,
    type: 0,
  }));
}

function partSession(startedAt = null) {
  return {
    title: "常暗之厢",
    kpUserId: "kp",
    startedAt,
    pl: [],
    ob: [{ userId: "ob" }],
    transcriptSeats: [{ userId: "kp", role: "kp", name: "KP", from: 0, until: null }],
    transcriptOptOutSpans: [{ userId: "kp", from: 10, until: 20 }],
  };
}

function noise() {
  return [
    { id: "old", authorId: "kp", content: "开团前", createdTimestamp: 1, type: 0 },
    { id: "skip", authorId: "kp", content: "退出中", createdTimestamp: 15, type: 0 },
    { id: "ob", authorId: "ob", content: "旁观噪声", createdTimestamp: 80, type: 0 },
    { id: "bot", authorId: "bot", bot: true, content: "机器人噪声", createdTimestamp: 81, type: 0 },
  ];
}

{
  const host = partSession(50);
  const one = buildTranscriptFiles(host, [...kpLines(1999, 100), ...noise()]);
  assertEqual(one.files.length, 1, "不足 2000 条有效发言仍是单文件");
  assertEqual(one.files[0].name, "常暗之厢团录.md", "单文件不带分卷号");
  assert(!one.files[0].markdown.includes("开团前") && !one.files[0].markdown.includes("旁观噪声"), "开团前和旁观不进单文件");
  const exact = buildTranscriptFiles(host, [...kpLines(TRANSCRIPT_PART_MESSAGE_LIMIT, 100), ...noise()]);
  assertEqual(exact.files.length, 1, "正好 2000 条有效发言仍是单文件");
  const split = buildTranscriptFiles(host, [...kpLines(2001, 100), ...noise()]);
  assertEqual(split.files.map((file) => file.name).join("|"), "常暗之厢团录-01.md|常暗之厢团录-02.md", "2001 条有效发言分成两卷");
  assert(split.files[0].markdown.includes("句100") && split.files[0].markdown.includes("句2099"), "第一卷是前 2000 条有效发言");
  assert(!split.files[0].markdown.includes("句2100") && split.files[1].markdown.includes("句2100"), "第 2001 条进第二卷");
  assert(!split.files[1].markdown.includes("退出中") && !split.files[1].markdown.includes("机器人噪声"), "过滤掉的消息不占分卷名额");
  const long = buildTranscriptFiles(host, kpLines(5000, 100));
  assertEqual(long.files.length, 3, "5000 条有效发言分成三卷");
  assert(long.files[2].markdown.includes("句4100") && long.files[2].markdown.includes("句5099"), "第三卷接着第二卷");
  assert(!long.files[2].markdown.includes("句4099"), "第三卷不重复上一卷");
}

{
  const warned = buildTranscriptFiles(partSession(50), kpLines(3, 100), { truncated: true, partLimit: 2 });
  assert(warned.files[0].markdown.includes(TRANSCRIPT_TRUNCATED_NOTICE), "超过安全上限时第一卷写明截断");
  assert(!warned.files[1].markdown.includes(TRANSCRIPT_TRUNCATED_NOTICE), "截断说明只放在第一卷");
}

{
  const all = Array.from({ length: 250 }, (_, index) => ({
    id: String(index + 1).padStart(6, "0"),
    createdTimestamp: index + 1,
    authorId: "kp",
    content: `m${index + 1}`,
    type: 0,
  }));
  const calls = [];
  const fetchPage = async ({ limit, before }) => {
    calls.push({ limit, before: before ?? null });
    const pool = before ? all.filter((message) => message.id < before) : all;
    return pool.slice(-limit);
  };
  const full = await collectTranscriptHistory(fetchPage, { startedAt: 1, pageSize: 100 });
  assertEqual(calls.length, 3, "超过 100 条会继续向前翻页");
  assertEqual(calls[0].limit, 100, "每页最多 100 条");
  assertEqual(full.messages.length, 250, "翻完整个频道");
  assert(full.truncated === false, "翻到频道开头不算截断");
  calls.length = 0;
  const bounded = await collectTranscriptHistory(fetchPage, { startedAt: 80, pageSize: 100 });
  assertEqual(calls.length, 2, "读到开团时间后停止翻页");
  assertEqual(bounded.messages.length, 171, "开团时间之后的消息都留下");
  assert(!bounded.messages.some((message) => message.createdTimestamp < 80), "开团前的频道消息不进入结果");
  assert(bounded.truncated === false, "读到开团时间不算截断");
  calls.length = 0;
  const capped = await collectTranscriptHistory(fetchPage, { startedAt: 1, pageSize: 100, hardLimit: 150 });
  assertEqual(capped.messages.length, 150, "安全上限停在最近的 150 条");
  assert(capped.truncated === true, "还没读到开团时间就触顶时标记截断");
  assertEqual(capped.messages[0].createdTimestamp, 101, "触顶后保留的是较新的一段");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
