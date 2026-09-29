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

{
  const client = new EventEmitter();
  client.user = { id: "bot" };
  const runtime = createCocRuntime({
    client,
    config: {
      testMode: true,
      discordGuildId: "guild",
      coc: {
        enabled: true,
        messageContentEnabled: true,
        transcriptEnabled: true,
        statePath: "unused",
        categoryId: "1447978053665030280",
        kpRoleId: "1447978053665030281",
        plRoleId: "1447978053665030282",
        obRoleId: "1447978053665030283",
      },
    },
    logger: { warn() {}, error() {} },
    store: {
      async load() { throw new Error("测试模式不应读场次"); },
      snapshot() { return { version: 1, sessions: [] }; },
      async update() { throw new Error("测试模式不应写场次"); },
    },
    discord: {},
  });
  await runtime.start();
  assert(client.listenerCount("messageCreate") === 0, "TEST_MODE 不听自然消息");
  runtime.stop();
}

{
  const client = new EventEmitter();
  client.user = { id: "bot" };
  const store = {
    async load() { return { ok: true, state: { version: 1, sessions: [] } }; },
    snapshot() { return { version: 1, sessions: [] }; },
    async update(mutator) {
      const changed = mutator({ version: 1, sessions: [] });
      if (!changed || changed.errorCode) return { ok: false, message: changed?.message ?? "" };
      return { ok: true, state: changed.state, result: changed.result ?? null };
    },
  };
  const quiet = {
    testMode: false,
    discordGuildId: "guild",
    coc: {
      enabled: true,
      messageContentEnabled: false,
      transcriptEnabled: false,
      statePath: "unused",
      categoryId: "cat",
      kpRoleId: "kp",
      plRoleId: "pl",
      obRoleId: "ob",
    },
  };
  const closed = createCocRuntime({
    client,
    config: quiet,
    logger: { warn() {}, error() {} },
    store,
    discord: {},
  });
  await closed.start();
  assert(client.listenerCount("messageCreate") === 0, "开关关闭时不听自然消息");
  closed.stop();

  let reads = 0;
  const open = createCocRuntime({
    client,
    config: {
      ...quiet,
      coc: { ...quiet.coc, messageContentEnabled: true },
    },
    logger: { warn() {}, error() {} },
    store,
    discord: {},
  });
  const started = await open.start();
  assert(started.enabled === true, "只打开文字骰子时跑团仍启动");
  assert(client.listenerCount("messageCreate") === 1, "Message Content 打开时听自然消息");
  client.emit("messageCreate", {
    guildId: "guild",
    channelId: "lobby",
    author: { bot: false, id: "user" },
    get content() { reads += 1; return "1d100"; },
  });
  assert(reads === 0, "普通频道的自然消息不读正文");
  open.stop();
  assert(client.listenerCount("messageCreate") === 0, "停止后卸下文字骰子监听");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
