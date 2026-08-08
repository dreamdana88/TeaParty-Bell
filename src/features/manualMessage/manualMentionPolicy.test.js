/** 管理员手动 Mention 策略离线测试。 */
import {
  buildManualAllowedMentions,
  extractRoleMentionIds,
  validateManualMentions,
} from "./manualMentionPolicy.js";

const GUILD_ID = "guild-1";
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), label);
}
async function expectCode(action, code, label) {
  try { await action(); assert(false, label); }
  catch (error) { assert(error.code === code, `${label} (${code})`); }
}
function makeGuild(rolesById) {
  return {
    id: GUILD_ID,
    roles: {
      fetch: async (id) => rolesById.get(id) ?? null,
    },
  };
}

assertEqual(extractRoleMentionIds("<@&1> <@&1> <@&2>"), ["1", "2"], "Role Mention 全部提取并去重");
assertEqual(buildManualAllowedMentions(), {
  parse: ["users", "roles", "everyone"], repliedUser: false,
}, "管理员 allowedMentions 允许所有正常 Mention");

{
  const result = await validateManualMentions("普通文本 @everyone @here <@123>", { guildId: GUILD_ID });
  assertEqual(result.roleMentionIds, [], "无 Role Mention 不要求 Guild");
}

{
  const roles = new Map([["111", { id: "111", guildId: GUILD_ID }]]);
  let fetchOptions;
  const guild = makeGuild(roles);
  const originalFetch = guild.roles.fetch;
  guild.roles.fetch = async (id, options) => { fetchOptions = options; return originalFetch(id); };
  const result = await validateManualMentions("<@&111>", { guild, guildId: GUILD_ID });
  assertEqual(result.roleMentionIds, ["111"], "存在的单个 Role 允许");
  assertEqual(fetchOptions, { force: true }, "Role 校验强制刷新当前 Guild 状态");
}

{
  const ids = Array.from({ length: 25 }, (_, index) => String(index + 1));
  const roles = new Map(ids.map((id) => [id, { id, guildId: GUILD_ID }]));
  const result = await validateManualMentions(ids.map((id) => `<@&${id}>`).join(" "), { guild: makeGuild(roles), guildId: GUILD_ID });
  assertEqual(result.roleMentionIds, ids, "多个有效 Role 不设数量上限");
}

await expectCode(
  () => validateManualMentions("<@&not-a-number>", { guildId: GUILD_ID }),
  "INVALID_ROLE_MENTION",
  "Role ID 格式错误拒绝",
);
await expectCode(
  () => validateManualMentions("<@&222>", { guild: makeGuild(new Map()), guildId: GUILD_ID }),
  "ROLE_NOT_FOUND",
  "不存在 Role 拒绝",
);
{
  const deletedGuild = {
    id: GUILD_ID,
    roles: { fetch: async () => { throw Object.assign(new Error("Unknown Role"), { code: 10011 }); } },
  };
  await expectCode(
    () => validateManualMentions("<@&223>", { guild: deletedGuild, guildId: GUILD_ID }),
    "ROLE_NOT_FOUND",
    "已删除 Role 拒绝",
  );
}
await expectCode(
  () => validateManualMentions("<@&333>", { guild: makeGuild(new Map([["333", { id: "333", guildId: "other-guild" }]])), guildId: GUILD_ID }),
  "ROLE_NOT_FOUND",
  "其他 Guild Role 拒绝",
);
await expectCode(
  () => validateManualMentions("<@&111> <@&999>", { guild: makeGuild(new Map([["111", { id: "111", guildId: GUILD_ID }]])), guildId: GUILD_ID }),
  "ROLE_NOT_FOUND",
  "多个 Role 任一无效时整条拒绝",
);

console.log(`\n[manualMentionPolicy.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
