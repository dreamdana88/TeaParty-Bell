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

{
  const replies = [];
  const client = { on(_name, fn) { this.fn = fn; }, off() {} };
  const router = createCocInteractionRouter({
    client,
    service: {
      availability: () => "ready",
      finish: async () => ({
        ok: true,
        session: { sessionId: "s1", title: "我来测试", runChannelId: "room", controlMessageId: "panel" },
      }),
    },
    discord: {
      async sendMessage() { return "notice"; },
      async editMessage() {},
    },
    logger: { warn() {}, error() {} },
  });
  router.start();
  await client.fn({
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "coc:v1:finish:s1",
    user: { id: "kp" },
    async deferUpdate() {},
    async editReply(payload) { replies.push(payload); },
  });
  const receipt = replies.at(-1);
  assert(receipt?.content === "本局已经结束。频道将在 48 小时后删除。", "结束回执说明频道会删除");
  assert(Array.isArray(receipt?.components) && receipt.components.length === 0, "结束后拿掉确认和继续按钮");
  router.destroy();
}

{
  const replies = [];
  const client = { on(_name, fn) { this.fn = fn; }, off() {} };
  const obId = "1404419757679050814";
  const missingId = "1362486959028572461";
  const router = createCocInteractionRouter({
    client,
    service: {
      availability: () => "ready",
      previewMembers: () => ({
        ok: true,
        session: {
          sessionId: "s1",
          guildId: "guild",
          pl: [{ userId: "pl", characterName: "ho2" }],
          ob: [{ userId: obId }, { userId: missingId }],
        },
      }),
    },
    discord: {
      async fetchGuildMember(_guildId, userId) {
        if (userId !== obId) throw new Error("missing");
        return { userId, nickname: "森之黑山羊", username: "blackgoat", globalName: "Goat" };
      },
    },
    logger: { warn() {}, error() {} },
  });
  router.start();
  await client.fn({
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "coc:v1:convert:s1",
    user: { id: "kp" },
    async deferReply() {},
    async editReply(payload) { replies.push(payload); },
  });
  const options = replies.at(-1).components[0].toJSON().components[0].options;
  assert(options[0].label === "PL ho2", "PL 仍用角色名");
  assert(options[1].label === "OB 森之黑山羊 (blackgoat)", "OB 用服务器昵称");
  assert(options[1].value === `ob:${obId}`, "OB 选项仍然指向原来的用户");
  assert(!options[1].label.includes(obId), "认得出的 OB 不显示整段用户 ID");
  assert(options[2].label === "OB 未能读取名字 ·2461", "离开服务器的 OB 不全文铺 ID");
  router.destroy();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
