import { GatewayIntentBits } from "discord.js";
import { createClient } from "./client.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

{
  const off = createClient();
  assert(off.client.options.intents.has(GatewayIntentBits.Guilds), "保留 Guilds");
  assert(off.client.options.intents.has(GatewayIntentBits.GuildMessages), "保留 GuildMessages");
  assert(!off.client.options.intents.has(GatewayIntentBits.MessageContent), "默认不注册 Message Content");
  await off.destroy();
}
{
  const on = createClient({ messageContent: true });
  assert(on.client.options.intents.has(GatewayIntentBits.MessageContent), "打开时才注册 Message Content");
  await on.destroy();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
