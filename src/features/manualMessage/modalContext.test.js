import {
  buildReplyModal,
  buildSendModal,
  createSendModalCustomId,
  MAX_MODAL_CUSTOM_ID_LENGTH,
  parseManualModalContext,
  parseReplyModalCustomId,
  parseSendModalCustomId,
} from "./modalContext.js";

const CHANNEL_ID = "123456789012345678";
const MESSAGE_ID = "987654321098765432";
const VALID_ID = `manual:v1:reply:${CHANNEL_ID}:${MESSAGE_ID}`;
const VALID_SEND_ID = `manual:v1:send:${CHANNEL_ID}`;

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}

console.log("\n=== Manual Reply Modal Context ===\n");

assertEqual(JSON.stringify(parseReplyModalCustomId(VALID_ID)), JSON.stringify({
  channelId: CHANNEL_ID,
  targetMessageId: MESSAGE_ID,
}), "有效 customId 严格解析");
assertEqual(JSON.stringify(parseSendModalCustomId(VALID_SEND_ID)), JSON.stringify({ channelId: CHANNEL_ID }), "有效 send customId 严格解析");
assertEqual(JSON.stringify(parseManualModalContext(VALID_ID)), JSON.stringify({
  version: "v1", action: "reply", channelId: CHANNEL_ID, targetMessageId: MESSAGE_ID,
}), "reply context round-trip");
assertEqual(JSON.stringify(parseManualModalContext(VALID_SEND_ID)), JSON.stringify({
  version: "v1", action: "send", channelId: CHANNEL_ID,
}), "send context round-trip");
for (const [value, label] of [
  ["manual:v2:reply:" + CHANNEL_ID + ":" + MESSAGE_ID, "版本错误"],
  ["manual:v1:send:" + CHANNEL_ID + ":" + MESSAGE_ID, "动作错误"],
  ["manual:v1:reply:" + CHANNEL_ID, "字段缺失"],
  [VALID_ID + ":extra", "字段过多"],
  ["manual:v1:reply:channel-1:" + MESSAGE_ID, "频道 ID 非 Snowflake"],
  ["manual:v1:reply:" + CHANNEL_ID + ":message-1", "消息 ID 非 Snowflake"],
  ["manual:v1:reply:" + CHANNEL_ID + ":", "消息 ID 为空"],
  ["manual:v1:send:" + CHANNEL_ID + ":" + MESSAGE_ID, "send 多出 targetMessageId"],
  ["manual:v1:reply:" + CHANNEL_ID, "reply 缺少 targetMessageId"],
  ["manual:v1:send:", "send channelId 为空"],
  ["manual:v1:send:" + CHANNEL_ID + ":" + "x".repeat(MAX_MODAL_CUSTOM_ID_LENGTH), "超过 customId 长度限制"],
  [null, "customId 非字符串"],
]) {
  assertEqual(parseReplyModalCustomId(value), null, `${label} 拒绝`);
  assertEqual(parseManualModalContext(value), null, `${label} generic parser 拒绝`);
}

const modal = buildReplyModal({ channelId: CHANNEL_ID, targetMessageId: MESSAGE_ID }).toJSON();
assertEqual(modal.custom_id, VALID_ID, "Modal customId 不携带正文或操作者信息");
assertEqual(modal.title, "让小G宝回复", "Modal 标题");
const input = modal.components[0].components[0];
assertEqual(input.custom_id, "content", "正文输入 customId");
assertEqual(input.style, 2, "正文使用 Paragraph");
assertEqual(input.required, true, "正文必填");
assertEqual(input.min_length, 1, "正文最短长度");
assertEqual(input.max_length, 2000, "正文最大长度");
assertEqual(buildReplyModal({ channelId: "channel-1", targetMessageId: MESSAGE_ID }), null, "非法上下文不构造 Modal");

const sendModal = buildSendModal({ channelId: CHANNEL_ID }).toJSON();
assertEqual(sendModal.custom_id, VALID_SEND_ID, "Send Modal customId");
assertEqual(sendModal.title, "让小G宝发言", "Send Modal 标题");
assertEqual(sendModal.components[0].components[0].label, "发言内容", "Send Modal 正文 label");
assertEqual(createSendModalCustomId(CHANNEL_ID).length <= MAX_MODAL_CUSTOM_ID_LENGTH, true, "Send customId 不超过 Discord 长度限制");
assertEqual(buildSendModal({ channelId: "channel-1" }), null, "非法 send 上下文不构造 Modal");

console.log(`\n[modalContext.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
