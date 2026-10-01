import { loadCocConfig } from "./cocConfig.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const root = "D:/tmp/teaparty";
{
  const config = loadCocConfig({}, { projectRoot: root });
  assert(config.enabled === false, "缺省关闭");
}
{
  const config = loadCocConfig({ COC_ENABLED: "true" }, { projectRoot: root });
  assert(config.enabled === false && config.disabledReason.includes("未配置"), "缺 ID 时关闭而不是抛错");
}
{
  const config = loadCocConfig({
    COC_ENABLED: "true",
    COC_CATEGORY_ID: "1447978053665030280",
    COC_KP_ROLE_ID: "1447978053665030281",
    COC_PL_ROLE_ID: "1447978053665030282",
    COC_OB_ROLE_ID: "1447978053665030283",
  }, { projectRoot: root });
  assert(config.enabled === true, "四个雪花都在时开启");
}
{
  const config = loadCocConfig({ COC_ENABLED: "maybe" }, { projectRoot: root });
  assert(config.enabled === false, "非法开关只关闭 CoC");
}
{
  const config = loadCocConfig({}, { projectRoot: root });
  assert(config.messageContentEnabled === false && config.transcriptEnabled === false, "团录和文字骰子默认关闭");
}
{
  const config = loadCocConfig({
    COC_ENABLED: "true",
    COC_CATEGORY_ID: "1447978053665030280",
    COC_KP_ROLE_ID: "1447978053665030281",
    COC_PL_ROLE_ID: "1447978053665030282",
    COC_OB_ROLE_ID: "1447978053665030283",
    MESSAGE_CONTENT_ENABLED: "true",
    COC_TRANSCRIPT_ENABLED: "maybe",
  }, { projectRoot: root });
  assert(config.enabled === true && config.messageContentEnabled === true, "Message Content 可以单独打开");
  assert(config.transcriptEnabled === false, "非法团录开关只当关闭，不拖垮跑团");
}

{
  const config = loadCocConfig({ COC_ARCHIVE_URL: "https://archive.example/investigators",
    COC_CHARACTER_API_URL: "http://127.0.0.1:8787", INTERNAL_API_SECRET: "test-secret" }, { projectRoot: root });
  assert(config.archiveUrl === "https://archive.example/investigators", "建卡入口使用配置网址");
  assert(config.characterApiUrl === "http://127.0.0.1:8787" && config.internalApiSecret === "test-secret", "内部 API 地址和密钥读取统一配置");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
