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
    COC_KL_ROLE_ID: "1447978053665030282",
    COC_OB_ROLE_ID: "1447978053665030283",
  }, { projectRoot: root });
  assert(config.enabled === true, "四个雪花都在时开启");
}
{
  const config = loadCocConfig({ COC_ENABLED: "maybe" }, { projectRoot: root });
  assert(config.enabled === false, "非法开关只关闭 CoC");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
