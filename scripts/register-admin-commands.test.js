import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import {
  parseRegisterCommandArgs,
  runRegisterCommands,
} from "./register-admin-commands.js";
import { AdminCommandRegistrationError } from "../src/features/manualMessage/registerCommands.js";

const CONFIG = {
  discordBotToken: "BOT_TOKEN_SHOULD_NOT_PRINT",
  discordApplicationId: "123456789012345678",
  discordGuildId: "987654321098765432",
};

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}
function outputBuffer() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

console.log("\n=== Register Admin Commands CLI ===\n");

assertEqual(JSON.stringify(parseRegisterCommandArgs(["--dry-run"])), JSON.stringify({ dryRun: true }), "解析 --dry-run");
assertEqual(parseRegisterCommandArgs(["--confirm-guild", CONFIG.discordGuildId]).confirmGuild, CONFIG.discordGuildId, "解析 --confirm-guild");

{
  let restCreated = false;
  let registerCalled = false;
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const result = await runRegisterCommands({
    argv: ["--dry-run"],
    loadConfigFn: () => CONFIG,
    restFactory: () => { restCreated = true; throw new Error("must not create REST"); },
    registerFn: async () => { registerCalled = true; },
    stdout,
    stderr,
  });
  const serialized = JSON.stringify(stdout.lines);
  assertEqual(result.exitCode, 0, "dry-run 退出码 0");
  assertEqual(restCreated, false, "dry-run 不创建 REST Client");
  assertEqual(registerCalled, false, "dry-run 不调用注册模块");
  assert(serialized.includes("小G宝回复") && serialized.includes("小g宝发言"), "dry-run 输出两个命令摘要");
  assert(serialized.includes(CONFIG.discordApplicationId) && serialized.includes(CONFIG.discordGuildId), "dry-run 输出安全 ID 摘要");
  assert(!serialized.includes(CONFIG.discordBotToken), "dry-run 不输出 Token");
  assertEqual(stderr.lines.length, 0, "dry-run 无错误输出");
}

for (const argv of [[], ["--confirm-guild", "wrong-guild"]]) {
  let restCreated = false;
  const stderr = outputBuffer();
  const result = await runRegisterCommands({
    argv,
    loadConfigFn: () => CONFIG,
    restFactory: () => { restCreated = true; },
    stderr,
  });
  assert(result.exitCode !== 0, "缺失或不匹配 confirm-guild 拒绝");
  assertEqual(restCreated, false, "拒绝注册时不创建 REST Client");
  assert(!JSON.stringify(stderr.lines).includes(CONFIG.discordBotToken), "确认失败不输出 Token");
}

{
  let restToken;
  let registrationOptions;
  const stdout = outputBuffer();
  const result = await runRegisterCommands({
    argv: ["--confirm-guild", CONFIG.discordGuildId],
    loadConfigFn: () => CONFIG,
    restFactory: (options) => { restToken = options.token; return { put: async () => {} }; },
    registerFn: async (options) => {
      registrationOptions = options;
      return { count: 2, names: ["小G宝回复", "小g宝发言"] };
    },
    stdout,
  });
  assertEqual(result.exitCode, 0, "匹配 confirm-guild 成功退出 0");
  assertEqual(restToken, CONFIG.discordBotToken, "真实模式使用配置 Bot Token 创建 REST");
  assertEqual(registrationOptions.applicationId, CONFIG.discordApplicationId, "注册使用配置 Application ID");
  assertEqual(registrationOptions.guildId, CONFIG.discordGuildId, "注册使用配置 Guild ID");
  assertEqual(registrationOptions.commandDefinitions.length, 2, "注册使用统一两个命令");
  assert(!JSON.stringify(stdout.lines).includes(CONFIG.discordBotToken), "成功输出不包含 Token");
}

{
  let restCreated = false;
  const stderr = outputBuffer();
  const result = await runRegisterCommands({
    argv: ["--confirm-guild", CONFIG.discordGuildId],
    loadConfigFn: () => { throw new Error("config token secret"); },
    restFactory: () => { restCreated = true; },
    stderr,
  });
  assertEqual(result.exitCode, 1, "配置缺失退出非 0");
  assertEqual(restCreated, false, "配置缺失不创建 REST Client");
  assert(!JSON.stringify(stderr.lines).includes("config token secret"), "配置错误不输出原始信息");
}

{
  const stderr = outputBuffer();
  const result = await runRegisterCommands({
    argv: ["--confirm-guild", CONFIG.discordGuildId],
    loadConfigFn: () => CONFIG,
    restFactory: () => ({ put: async () => {} }),
    registerFn: async () => {
      throw new AdminCommandRegistrationError("COMMAND_REGISTRATION_FAILED", undefined, new Error("response token secret"));
    },
    stderr,
  });
  assertEqual(result.exitCode, 1, "REST 失败退出非 0");
  assert(!JSON.stringify(stderr.lines).includes("response token secret"), "REST 失败输出安全摘要");
  assert(!JSON.stringify(stderr.lines).includes(CONFIG.discordBotToken), "REST 失败不输出 Token");
}

{
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assertEqual(packageJson.scripts["commands:register"], "node scripts/register-admin-commands.js", "package.json 注册入口");
}

console.log(`\n[register-admin-commands.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
