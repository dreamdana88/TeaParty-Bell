import { createServer } from "node:http";
import { createCharacterClient } from "./characterClient.js";

let passed = 0; let failed = 0;
function check(ok, label) { if (ok) { passed++; console.log(`PASS: ${label}`); } else { failed++; console.error(`FAIL: ${label}`); } }

const nine = { str: 50, con: 60, siz: 55, dex: 70, app: 65, int: 75, pow: 70, edu: 80, luck: 60 };
const baseCard = () => ({
  schemaVersion: 1, ruleset: "coc7", id: "a", ownerDiscordUserId: "100",
  identity: { name: "奈洛莉" }, characteristics: { ...nine }, initialSan: 35,
  occupation: { name: "演员" }, skills: [{ name: "侦查", base: 25, growth: 0, occupationPoints: 20, interestPoints: 0 }],
});
let data = { ok: true, character: baseCard(), derived: { hp: 11, mp: 14 }, updatedAt: "2026-10-01T00:00:00Z" };
const http = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(data));
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
try {
  const client = createCharacterClient({ baseUrl: `http://127.0.0.1:${http.address().port}`, secret: "s" });
  const read = await client.read("a", "100");
  check(read.ok && JSON.stringify(read.snapshot.characteristics) === JSON.stringify(nine), "选卡后快照保存九项属性");
  const s = read.snapshot;
  check(s.characterId === "a" && s.ownerDiscordUserId === "100" && s.characterName === "奈洛莉" && s.occupation === "演员"
    && s.initialHp === 11 && s.initialSan === 35 && s.initialMp === 14 && s.initialLuck === 60
    && Array.isArray(s.skills) && s.skills.length === 1 && s.characterSheet && typeof s.characterSheet === "object", "原有快照字段全部保留");

  const extra = baseCard(); extra.characteristics.mystery = 5;
  data = { ...data, character: extra };
  const picked = await client.read("a", "100");
  check(picked.ok && !("mystery" in picked.snapshot.characteristics), "只保存九项属性，不夹带其它字段");

  const high = baseCard(); Object.assign(high.characteristics, { str: 95, dex: 120, edu: 99 });
  data = { ...data, character: high };
  const highRead = await client.read("a", "100");
  check(highRead.ok && highRead.snapshot.characteristics.dex === 120 && highRead.snapshot.characteristics.str === 95, "属性超过 90 的卡可以选卡");

  const luckHigh = baseCard(); luckHigh.characteristics.luck = 91;
  data = { ...data, character: luckHigh };
  check(!(await client.read("a", "100")).ok, "Luck 仍保留不超过 90 的检查");

  for (const key of Object.keys(nine)) {
    for (const bad of [-1, 1.5, "50", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      const card = baseCard();
      if (bad === undefined) delete card.characteristics[key]; else card.characteristics[key] = bad;
      data = { ...data, character: card };
      const result = await client.read("a", "100");
      check(!result.ok && !result.snapshot, `${key}=${String(bad)} 时整卡选卡失败`);
    }
  }
} finally {
  await new Promise((resolve) => http.close(resolve));
}
console.log(`${passed} passed / ${failed} failed`);
if (failed) process.exit(1);
