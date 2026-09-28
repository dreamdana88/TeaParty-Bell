import { readFileSync } from "fs";
import { Events } from "discord.js";
import { createCocInteractionRouter } from "./interactionRouter.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const source = readFileSync(new URL("./interactionRouter.js", import.meta.url), "utf8");
assert(!source.includes("pick-add-pl") && !source.includes("pick-add-ob"), "没有旧的下拉选人入口");
assert(!source.includes("isUserSelectMenu"), "没有 User Select 分支");
assert(!source.includes("Server Members Intent"), "403 不再要求打开 Server Members Intent");
assert(source.includes("成员搜索被 Discord 拒绝了"), "403 使用中性提示");

{
  const updates = [];
  const calls = [];
  const client = {
    on(name, fn) { this.fn = fn; this.name = name; },
    off() {},
  };
  const session = { sessionId: "s1", pl: [{ userId: "pl", characterName: "奈洛莉" }], ob: [], kpUserId: "kp" };
  const router = createCocInteractionRouter({
    client,
    service: {
      availability: () => "ready",
      previewMembers: () => ({ ok: true, session }),
      convertPlToOb: () => { calls.push("convert"); },
      removeMember: () => { calls.push("remove"); },
    },
    discord: {},
    logger: { warn() {}, error() {} },
  });
  router.start();
  assert(client.name === Events.InteractionCreate, "监听交互");
  await client.fn({
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "coc:v1:back-go-ob:s1",
    user: { id: "kp" },
    async update(payload) { updates.push(payload); },
  });
  await client.fn({
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "coc:v1:back-go-kick:s1",
    user: { id: "kp" },
    async update(payload) { updates.push(payload); },
  });
  assert(updates.length === 2 && updates.every((item) => item.content.includes("本局成员管理")), "两个返回按钮回到成员管理");
  assert(calls.length === 0, "返回不修改成员");
  router.destroy();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
