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

{
  assert(!source.includes("modal-add-pl") && !source.includes("modal-ob-pl") && !source.includes("targetNameModal"), "彻底删除 KP 角色名弹窗路径");
  const client = { on(_name, fn) { this.fn = fn; }, off() {} };
  const sent = [];
  const cancelled = [];
  const replies = [];
  let failSend = false;
  let reads = 0;
  const router = createCocInteractionRouter({ client,
    service: {
      availability: () => "ready",
      async inviteCharacter(_session, actor, target, kind) {
        if (actor !== "kp") return { ok: false, message: "只有 KP 可以邀请。" };
        return { ok: true, session: { runChannelId: "room", recruitChannelId: "recruit" },
          invitation: { id: "invite-1", targetUserId: target, kind } };
      },
      async prepareCharacterSelection(_session, userId, invitationId) {
        reads++;
        return userId === "target" && invitationId === "invite-1"
          ? { ok: true, characters: [{ id: "a", name: "奈洛莉", occupation: "演员", era: "1920s" },
            { id: "b", name: "江某", occupation: "侦探", era: "1920s" }], invitation: { id: invitationId } }
          : { ok: false, message: "只有目标本人可以选卡。" };
      },
      invitationFor() { return { targetUserId: "target" }; },
      async cancelCharacterInvitation(_session, _actor, id) { cancelled.push(id); return { ok: true }; },
    },
    discord: { async sendMessage(channel, payload) {
      if (failSend) throw new Error("send failed");
      sent.push({ channel, payload });
    } }, logger: { warn() {}, error() {} },
  });
  router.start();
  const base = { user: { id: "kp" }, async deferUpdate() {}, async deferReply() {},
    async editReply(payload) { replies.push(payload); } };
  await client.fn({ ...base, isStringSelectMenu: () => true, customId: "coc:v1:pick-found-pl:s1", values: ["target"] });
  assert(sent[0]?.channel === "recruit", "KP 新增 PL 的邀请发在原招募频道");
  assert(sent[0]?.payload.allowedMentions.users[0] === "target" && sent[0].payload.content.includes("<@target>"), "邀请只 @ 目标用户");
  assert(sent[0]?.payload.components[0].toJSON().components[0].label === "选择调查员", "公开邀请提供选择调查员按钮");
  await client.fn({ ...base, isStringSelectMenu: () => true, customId: "coc:v1:pick-convert:s1", values: ["ob:target"] });
  assert(sent[1]?.channel === "room", "OB 转 PL 邀请使用已有权限的跑团频道");
  await client.fn({ ...base, isButton: () => true, customId: "coc:v1:invite-open:s1:invite-1" });
  assert(replies.at(-1)?.content.includes("目标本人"), "KP 点击目标邀请会被拒绝");
  await client.fn({ ...base, user: { id: "target" }, isButton: () => true, customId: "coc:v1:invite-open:s1:invite-1" });
  assert(reads === 2 && replies.at(-1)?.components[0].toJSON().components[0].options.length === 2, "目标本人可以打开自己的多卡选择菜单");
  await client.fn({ ...base, isStringSelectMenu: () => true, customId: "coc:v1:pick-invited-character:s1:invite-1", values: ["a"] });
  assert(replies.at(-1)?.content.includes("目标本人"), "KP 不能伪造目标菜单替人选择");
  failSend = true;
  await client.fn({ ...base, isStringSelectMenu: () => true, customId: "coc:v1:pick-found-pl:s1", values: ["target"] });
  assert(cancelled.includes("invite-1") && replies.at(-1)?.content.includes("已取消"), "邀请发送失败清理 pending");
  router.destroy();
}

{
  const replies = [];
  const client = { on(_name, fn) { this.fn = fn; }, off() {} };
  const session = {
    sessionId: "s1",
    kpUserId: "kp",
    pl: [{ userId: "pl", characterName: "奈洛莉" }],
    ob: [{ userId: "ob" }],
    secretThreads: [],
  };
  const router = createCocInteractionRouter({
    client,
    service: {
      availability: () => "ready",
      previewSecret: (id, actor) => actor === "kp"
        ? { ok: true, session }
        : { ok: false, message: "只有本局 KP 可以使用秘密交流。" },
    },
    discord: {},
    logger: { warn() {}, error() {} },
  });
  router.start();
  await client.fn({
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "coc:v1:secret:s1",
    user: { id: "pl" },
    async reply(payload) { replies.push(payload); },
  });
  assert(replies.at(-1)?.content?.includes("只有本局 KP"), "非 KP 不能打开秘密交流");
  await client.fn({
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "coc:v1:secret:s1",
    user: { id: "kp" },
    async reply(payload) { replies.push(payload); },
  });
  assert(replies.at(-1)?.content?.includes("尚无秘密子区"), "KP 看到仅自己可见的秘密交流面板");
  assert(replies.at(-1)?.flags, "秘密交流面板是 ephemeral");
  router.destroy();
}

{
  const updates = [];
  const client = { on(_name, fn) { this.fn = fn; }, off() {} };
  const session = {
    sessionId: "s1",
    kpUserId: "kp",
    pl: [{ userId: "pl", characterName: "奈洛莉" }, { userId: "pl2", characterName: "江某" }],
    ob: [{ userId: "ob" }],
    secretThreads: [{ threadId: "t1", name: "耳语", createdAt: 1, plUserIds: ["pl"] }],
  };
  const added = [];
  const router = createCocInteractionRouter({
    client,
    service: {
      availability: () => "ready",
      previewSecret: () => ({ ok: true, session }),
      async addSecretThreadPl(_session, _actor, threadId, ids) {
        added.push({ threadId, ids });
        return {
          ok: true,
          threadId,
          session: {
            ...session,
            secretThreads: [{ ...session.secretThreads[0], plUserIds: ["pl", "pl2"] }],
          },
        };
      },
    },
    discord: { async sendMessage() { throw new Error("不应刷主频道"); } },
    logger: { warn() {}, error() {} },
  });
  router.start();
  await client.fn({
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    customId: "coc:v1:s-apls:s1:t1",
    user: { id: "kp" },
    values: ["pl2"],
    async deferUpdate() {},
    async editReply(payload) { updates.push(payload); },
  });
  assertEqual(added[0]?.threadId, "t1", "增补打到选中的子区");
  assert(updates.at(-1)?.content.includes("江某"), "增补后更新管理面板");
  assert(!updates.at(-1)?.content.includes("主频道"), "不往主频道发通知");
  router.destroy();
}

{
  const updates = [];
  const client = { on(_name, fn) { this.fn = fn; }, off() {} };
  const session = {
    sessionId: "s1",
    kpUserId: "kp",
    pl: [{ userId: "pl", characterName: "奈洛莉" }],
    ob: [{ userId: "ob" }],
    secretThreads: [{ threadId: "t1", name: "耳语", createdAt: 1, plUserIds: [] }],
  };
  const router = createCocInteractionRouter({
    client,
    service: {
      availability: () => "ready",
      async createSecretThread() {
        return {
          ok: true,
          session,
          thread: session.secretThreads[0],
          warning: "部分 PL 没有加入该秘密子区，可在「管理参与者」中增补。",
        };
      },
    },
    discord: { async sendMessage() { throw new Error("不应刷主频道"); } },
    logger: { warn() {}, error() {} },
  });
  router.start();
  await client.fn({
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isButton: () => true,
    customId: "coc:v1:s-only:s1",
    user: { id: "kp" },
    async deferUpdate() {},
    async editReply(payload) { updates.push(payload); },
  });
  assert(updates.at(-1)?.content.includes("部分 PL 没有加入该秘密子区"), "部分加入失败时把警告显示在管理面板");
  router.destroy();
}

function assertEqual(actual, expected, label) {
  if (actual === expected) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

{
  const calls = [];
  const client = { on(_event, handler) { this.handler = handler; }, off() {} };
  const session = { sessionId: "banner", title: "招募", kpUserId: "kp", pl: [], ob: [{userId:"ob"}], createdAt: 1000 };
  const router = createCocInteractionRouter({ client, service: { availability: () => "ready", joinOb: async () => ({ok:true,session}) }, discord: {}, logger: {warn(){},error(){}} });
  router.start();
  await client.handler({ isChatInputCommand:()=>false,isModalSubmit:()=>false,isStringSelectMenu:()=>false,isButton:()=>true,customId:"coc:v1:ob:banner",user:{id:"ob"}, async deferUpdate(){calls.push("ack");this.deferred=true;},async editReply(payload){calls.push(payload.files?.length===1?"image-edit":"missing-image");} });
  assert(calls.join(",") === "ack,image-edit", "招募刷新先确认交互再上传横幅，不占用首个回复时限");
  router.destroy();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
