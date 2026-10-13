import { ApplicationCommandType, PermissionFlagsBits } from "discord.js";
import {
  buildManualReplyCommand,
  buildSlashSendCommand,
  adminCommandDefinitions,
  MANUAL_REPLY_COMMAND_NAME,
  SLASH_SEND_COMMAND_NAME,
} from "./commands.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}

console.log("\n=== Manual Message Commands ===\n");

const command = buildManualReplyCommand().toJSON();
assertEqual(command.name, MANUAL_REPLY_COMMAND_NAME, "命令名称");
assertEqual(command.type, ApplicationCommandType.Message, "命令类型为 Message Context Menu");
assertEqual(command.default_member_permissions, String(PermissionFlagsBits.Administrator), "默认权限为 Administrator");
assert(!("description" in command), "不生成 Slash Command description");

const slash = buildSlashSendCommand().toJSON();
assertEqual(slash.name, SLASH_SEND_COMMAND_NAME, "Slash 命令名称");
assertEqual(slash.description, "让小G宝在当前频道发言", "Slash 命令描述");
assertEqual(slash.type, ApplicationCommandType.ChatInput, "命令类型为 Chat Input");
assertEqual(slash.default_member_permissions, String(PermissionFlagsBits.Administrator), "Slash 默认权限为 Administrator");
assertEqual(slash.options.length, 0, "Slash 命令没有参数");

const definitions = adminCommandDefinitions;
assertEqual(JSON.stringify(definitions.map((item) => item.name)), JSON.stringify([MANUAL_REPLY_COMMAND_NAME, SLASH_SEND_COMMAND_NAME]), "统一命令名称");

console.log(`\n[commands.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
