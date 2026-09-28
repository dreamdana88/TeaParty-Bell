import { EventEmitter } from "events";
import { createCocRuntime } from "./runtime.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

{
  const client = new EventEmitter();
  client.user = { id: "bot" };
  let loaded = false;
  const runtime = createCocRuntime({
    client,
    config: {
      testMode: true,
      discordGuildId: "guild",
      coc: {
        enabled: true,
        statePath: "unused",
        categoryId: "1447978053665030280",
        kpRoleId: "1447978053665030281",
        plRoleId: "1447978053665030282",
        obRoleId: "1447978053665030283",
      },
    },
    logger: { warn() {}, error() {} },
    store: {
      async load() { loaded = true; return { ok: true, state: { version: 1, sessions: [] } }; },
      snapshot() { return { version: 1, sessions: [] }; },
      async update() { throw new Error("测试模式不应写场次"); },
    },
    discord: {
      async createTextChannel() { throw new Error("测试模式不应建频道"); },
    },
  });
  const started = await runtime.start();
  assert(started.enabled === false && started.blockedByTestMode === true, "TEST_MODE 禁止真实 CoC 副作用");
  assert(loaded === false, "TEST_MODE 不读取场次文件");
  const reply = runtime.service.statusMessage();
  assert(reply.includes("测试模式"), "命令会说明测试模式不会建房或改名");
  runtime.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
