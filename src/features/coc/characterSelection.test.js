import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharacterClient } from "./characterClient.js";
import { createCocSessionService } from "./sessionService.js";
import { createCocSessionStore } from "./sessionStore.js";
import { createCocInteractionRouter } from "./interactionRouter.js";
import { archiveEntry, characterChoices } from "./characterPanel.js";
import { cocCommandDefinitions } from "./commands.js";

let passed = 0;
function check(value, label) { assert.ok(value, label); passed++; console.log(`PASS: ${label}`); }
const secret = "test-b8-secret";
const card = {
  schemaVersion: 1, ruleset: "coc7", id: "a", ownerDiscordUserId: "100",
  identity: { name: "奈洛莉" }, characteristics: { pow: 70, luck: 60 }, initialSan: 35,
  occupation: { name: "演员" }, skills: [{ name: "艺术", specialty: "演技", base: 5, growth: 0, occupationPoints: 45, interestPoints: 0 }],
};
let data = { ok: true, character: card, derived: { hp: 11, mp: 14 } };
let summary = [{ id: "a", ownerDiscordUserId: "100", name: "奈洛莉", occupation: "演员", era: "1920s" }];
let status = 200;
const requests = [];
const http = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url, auth: request.headers.authorization });
  response.setHeader("Content-Type", "application/json");
  response.statusCode = status;
  response.end(JSON.stringify(request.url.includes("/users/") ? { ok: true, characters: summary } : data));
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const dir = mkdtempSync(join(tmpdir(), "coc-b8-"));
try {
  const client = createCharacterClient({ baseUrl: `http://127.0.0.1:${http.address().port}`, secret });
  check((await client.list("100")).characters.length === 1, "用户 A 获取自己的列表");
  check(!(await client.list("200")).ok, "列表中其它 owner 不能展示给用户 B");
  check(!(await client.read("a", "200")).ok, "用户 B 不能选择用户 A 的卡");
  check((await client.read("a", "100")).snapshot.initialSan === 35, "初始理智来自独立字段而非 POW");
  const absent = structuredClone(card); delete absent.initialSan;
  data = { ...data, character: absent };
  check(!(await client.read("a", "100")).ok, "缺失 initialSan 明确拒绝，不从 POW 补值");
  data = { ok: true, character: card, derived: { hp: 11, mp: 14 } };
  for (const code of [401, 404, 500]) {
    status = code;
    const result = await client.read("a", "100");
    check(!result.ok && !result.message.includes(secret), `${code} 返回安全中文错误`);
  }
  status = 200;
  check(!(await createCharacterClient({ baseUrl: "http://example.com", secret }).list("100")).ok, "内部密钥不发送到公网地址");
  check(!(await createCharacterClient({ baseUrl: "http://127.0.0.1:1", secret }).list("100")).ok, "服务不可用返回可理解提示");
  check(!(await createCharacterClient({ baseUrl: "http://127.0.0.1:8787" }).list("100")).ok, "未配置密钥拒绝请求");
  check(!(await createCharacterClient({ baseUrl: "http://127.0.0.1:8787", secret,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error(secret); } }),
  }).list("100")).ok, "非法 JSON 不抛出敏感内容");
  summary = [];
  check((await client.list("100")).characters.length === 0, "无卡正常返回空列表");
  summary = [{ id: "a", ownerDiscordUserId: "100", name: "奈洛莉", occupation: "演员", era: "1920s" }];

  const store = createCocSessionStore({ filePath: join(dir, "sessions.json") });
  await store.load();
  const service = createCocSessionService({ store, discord: {}, characters: client,
    config: { enabled: true, guildId: "guild" }, createId: () => "s1" });
  await service.openRecruit({ guildId: "guild", channelId: "recruit", kpUserId: "kp", title: "测试" });
  check(!(await service.selectCharacter("s1", "100", "a")).ok, "未报名不能通过伪造选择绑定角色");
  check((await service.prepareCharacterSelection("s1", "100")).ok, "PL 报名后查询列表");
  check(!service.previewStart("s1", "kp").ok, "未选卡不能开团");
  check(!(await service.selectCharacter("s1", "100", "b")).ok, "响应角色 ID 不符不能绑定");
  await service.prepareCharacterSelection("s1", "100");
  const selected = await service.selectCharacter("s1", "100", "a");
  check(selected.ok, "选择自己的卡成功");
  const member = service.find("s1").pl[0];
  assert.deepEqual({ id: member.characterId, owner: member.ownerDiscordUserId, name: member.characterName,
    job: member.occupation, hp: member.initialHp, san: member.initialSan, mp: member.initialMp, luck: member.initialLuck,
    skills: member.skills }, { id: "a", owner: "100", name: "奈洛莉", job: "演员", hp: 11, san: 35, mp: 14, luck: 60, skills: card.skills });
  check(true, "Session 初始数值和技能快照保存完整");
  const reloaded = createCocSessionStore({ filePath: join(dir, "sessions.json") });
  await reloaded.load();
  check(reloaded.snapshot().sessions[0].pl[0].initialSan === 35, "重启读取后快照保留");
  card.initialSan = 20; card.skills[0].occupationPoints = 1;
  check(service.find("s1").pl[0].initialSan === 35 && service.find("s1").pl[0].skills[0].occupationPoints === 45, "长期卡变化不会修改已有本局快照");
  await service.prepareCharacterSelection("s1", "100");
  check(service.find("s1").pl[0].characterId === "a", "重复打开列表保留已选卡");
  status = 500;
  const beforeError = store.snapshot();
  check(!(await service.selectCharacter("s1", "100", "a")).ok, "读卡服务异常不绑定角色");
  assert.deepEqual(store.snapshot().sessions[0].pl, beforeError.sessions[0].pl);
  check(store.snapshot().sessions[0].characterInvitations.length === 0, "读卡失败清理选卡邀请");
  check(true, "失败的读卡不会改写已有快照");
  status = 200;
  await service.prepareCharacterSelection("s1", "100");
  let release;
  const racing = createCocSessionService({ store, discord: {}, config: { enabled: true }, characters: {
    read: async () => new Promise((resolve) => { release = resolve; }),
  } });
  const inFlight = racing.selectCharacter("s1", "100", "a");
  await service.leave("s1", "100");
  release({ ok: true, snapshot: { ...member, ownerDiscordUserId: "100" } });
  check(!(await inFlight).ok && service.find("s1").pl.length === 0, "读取期间取消报名不会被异步结果重新绑定");

  const interactionClient = { on(_event, fn) { this.fn = fn; }, off() {} };
  let listedCards = summary;
  let choices = 0;
  let selectedId;
  const router = createCocInteractionRouter({ client: interactionClient, archiveUrl: "https://archive.example/investigators",
    service: { availability: () => "ready",
      prepareCharacterSelection: async () => ({ ok: true, characters: listedCards, session: service.find("s1"), invitation: { id: "inv-100" } }),
      invitationFor: (_session, id) => id === "inv-100" ? { targetUserId: "100" } : { targetUserId: "200" },
      selectCharacter: async (_s, _u, id) => { choices++; selectedId = id; return { ok: true, session: { sessionId: "s1", pl: [{ userId: "100", characterName: "奈洛莉" }] } }; },
    }, discord: {}, logger: { error() {}, warn() {} } });
  router.start();
  const replies = [];
  const base = { user: { id: "100" }, async deferReply() {}, async deferUpdate() {},
    async editReply(payload) { replies.push(payload); }, async reply(payload) { replies.push(payload); } };
  await interactionClient.fn({ ...base, isButton: () => true, customId: "coc:v1:kl:s1" });
  check(choices === 1 && selectedId === "a", "一张卡自动选择");
  listedCards = [...summary, { ...summary[0], id: "b" }];
  await interactionClient.fn({ ...base, isButton: () => true, customId: "coc:v1:kl:s1" });
  check(choices === 1 && replies.at(-1).components[0].toJSON().components[0].options.length === 2, "多张卡显示本人选择菜单");
  await interactionClient.fn({ ...base, isStringSelectMenu: () => true, customId: "coc:v1:pick-invited-character:s1:inv-200", values: ["b"] });
  check(choices === 1 && replies.at(-1).content.includes("目标本人"), "伪造他人的菜单被拒绝");
  listedCards = [];
  await interactionClient.fn({ ...base, isButton: () => true, customId: "coc:v1:kl:s1" });
  check(replies.at(-1).components[0].toJSON().components[0].url === "https://archive.example/investigators", "无卡提示包含档案馆链接");
  await interactionClient.fn({ ...base, isChatInputCommand: () => true, commandName: "coc", options: { getSubcommand: () => "建卡" } });
  check(replies.at(-1).content.includes("Discord 授权"), "/coc 建卡提供仅本人入口和授权说明");
  router.destroy();
  const many = Array.from({ length: 26 }, (_, index) => ({ ...summary[0], id: `card-${index}` }));
  check(characterChoices("s1", "100", many, 0, "inv-100").components[0].toJSON().components[0].options.length === 25, "每页最多 25 张卡");
  check(characterChoices("s1", "100", many, 1, "inv-100").components[0].toJSON().components[0].options[0].value === "card-25", "第 26 张卡可以在下一页选择");
  check(archiveEntry("").components.length === 0, "入口未配置时不编造网址");
  check(cocCommandDefinitions.find((item) => item.name === "coc").options.some((item) => item.name === "建卡"), "正式命令定义包含建卡子命令");
  check(requests.every((request) => request.method === "GET" && request.auth === `Bearer ${secret}`), "所有档案馆请求仅 GET 且使用 Bearer 密钥");
  check(!readFileSync(join(dir, "sessions.json"), "utf8").includes(secret), "Session 不保存内部密钥");
  for (const key of ["currentHp", "currentSan", "currentMp", "currentLuck", "death", "madness"]) {
    check(!Object.hasOwn(member, key), `不创建 ${key}`);
  }
  console.log(`${passed} passed / 0 failed`);
} finally {
  await new Promise((resolve) => http.close(resolve));
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}
