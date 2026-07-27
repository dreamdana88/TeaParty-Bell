import {
  AdminCommandRegistrationError,
  registerAdminCommands,
} from "./registerCommands.js";
import { adminCommandDefinitions } from "./commands.js";

const APPLICATION_ID = "123456789012345678";
const GUILD_ID = "987654321098765432";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}
function makeLogger() {
  const calls = [];
  return {
    calls,
    error: (message, data) => calls.push({ message, data }),
  };
}

console.log("\n=== Manual Guild Command Registration ===\n");

{
  const calls = [];
  const rest = {
    put: async (route, options) => {
      calls.push({ route, options });
      return options.body;
    },
  };
  const result = await registerAdminCommands({
    rest,
    applicationId: APPLICATION_ID,
    guildId: GUILD_ID,
    commandDefinitions: adminCommandDefinitions,
  });
  assertEqual(calls.length, 1, "REST.put 只调用一次");
  assert(calls[0].route.includes(`/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`), "使用 Guild Commands 路由");
  assert(!calls[0].route.includes(`/applications/${APPLICATION_ID}/commands`), "不使用全局命令路由");
  assertEqual(calls[0].options.body.length, 2, "注册 body 恰好两个命令");
  assertEqual(JSON.stringify(calls[0].options.body), JSON.stringify(adminCommandDefinitions), "body 来源为统一 commandDefinitions");
  assertEqual(result.count, 2, "返回注册数量");
  assertEqual(JSON.stringify(result.names), JSON.stringify(["小G宝回复", "小g宝发言"]), "返回命令名称摘要");
}

{
  const logger = makeLogger();
  let putCount = 0;
  try {
    await registerAdminCommands({
      rest: { put: async () => { putCount++; throw Object.assign(new Error("token secret response"), { code: 50013 }); } },
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      logger,
    });
    assert(false, "REST 失败应抛出安全错误");
  } catch (error) {
    assert(error instanceof AdminCommandRegistrationError, "REST 失败使用安全错误类型");
    assertEqual(error.safeMessage, "Guild 命令注册失败。", "REST 失败 safeMessage");
    assertEqual(putCount, 1, "REST 失败只请求一次");
    const serialized = JSON.stringify(logger.calls);
    assert(!serialized.includes("token secret response"), "注册日志不包含 Token 或原始响应");
    assert(!serialized.includes("stack"), "注册日志不包含 stack");
  }
}

{
  let putCount = 0;
  try {
    await registerAdminCommands({
      rest: { put: async () => { putCount++; } },
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      commandDefinitions: [adminCommandDefinitions[0]],
    });
    assert(false, "命令数量错误应拒绝");
  } catch (error) {
    assert(error instanceof AdminCommandRegistrationError, "命令数量错误使用安全错误");
    assertEqual(putCount, 0, "命令数量错误不发 REST 请求");
  }
}

console.log(`\n[registerCommands.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
