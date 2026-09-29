import { controlPanel, transcriptPrivacyPrompt } from "./panel.js";
import {
  buildTranscriptFile,
  formatTranscriptClock,
  selectTranscriptMessages,
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
  assertEqual(transcriptPrivacyPrompt(false, "s1").components[0].toJSON().components[0].label, "不记录我的消息", "未退出时可以选择退出");
  assertEqual(transcriptPrivacyPrompt(true, "s1").components[0].toJSON().components[0].label, "恢复记录我的消息", "已退出时可以恢复");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
