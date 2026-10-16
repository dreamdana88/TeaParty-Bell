import assert from "node:assert/strict";
import { Client, EmbedBuilder, MessagePayload } from "discord.js";
import { recruitPanel, startedPanel, cancelledPanel } from "./panel.js";

const session = { sessionId: "recruit-test", title: "人生 remaster", kpUserId: "100", pl: [], ob: [], createdAt: 1792123200000 };
const client = new Client({ intents: [] });
let passed = 0;
function check(value, label) { assert.ok(value, label); passed++; console.log("  PASS: " + label); }
for (const build of [recruitPanel, startedPanel, cancelledPanel]) {
  const payload = build(session);
  new EmbedBuilder(payload.embeds[0]).toJSON();
  const encoded = MessagePayload.create({ client }, payload).resolveBody();
  await encoded.resolveFiles();
  check(encoded.files.length === 1 && encoded.files[0].data.length > 0, build.name + " includes the local banner");
  check(encoded.body.attachments.length === 1 && encoded.body.attachments[0].id === "0", build.name + " replaces attachments with exactly one image");
  check(payload.embeds[0].image.url === "attachment://" + payload.files[0].name, build.name + " image matches attachment name");
  check(payload.embeds[0].fields[0].value === "<@100>" && payload.allowedMentions.parse.length === 0, build.name + " displays KP without sending notifications");
  check(!JSON.stringify(payload.embeds).includes("<t:"), build.name + " does not display a timestamp");
}
const filled = recruitPanel({ ...session, pl: Array.from({ length: 40 }, (_, i) => ({ userId: String(1000 + i), characterName: "*".repeat(32) })), ob: [{userId:"200"}] });
check(filled.embeds[0].fields.every(field => field.value.length <= 1024), "long roster stays within Discord field limits");
check(filled.embeds[0].fields[2].value.includes("还有") && !filled.embeds[0].fields[2].value.includes("```"), "roster truncation keeps readable mentions rather than code blocks");
const active = startedPanel(session).components.flatMap(row => row.toJSON().components);
check(active.every(button => button.disabled), "started invitation disables all recruitment controls");
const recruit = recruitPanel(session).components.flatMap(row => row.toJSON().components);
check(recruit.map(button=>button.custom_id).join(",") === "coc:v1:kl:recruit-test,coc:v1:ob:recruit-test,coc:v1:leave:recruit-test,coc:v1:start:recruit-test,coc:v1:abort:recruit-test", "existing interaction IDs remain unchanged");
console.log("\n" + passed + " passed, 0 failed");
