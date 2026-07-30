/**
 * 旧直接导入路径的兼容测试。
 */
import { createDeepSeekProvider, DeepSeekError } from "./deepseek.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

let captured;
const provider = createDeepSeekProvider({
  deepseekApiKey: "legacy-key",
  deepseekBaseUrl: "https://legacy.example/",
  deepseekModel: "legacy-model",
  deepseekTimeoutMs: 100,
}, {
  fetchImpl: async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: " legacy ok " } }] }), { status: 200 });
  },
});

assert(await provider.chat([]) === "legacy ok", "旧模块转发到通用 Provider");
assert(captured.url === "https://legacy.example/chat/completions", "旧 Base URL 正确拼接");
assert(JSON.parse(captured.init.body).thinking === undefined, "旧兼容路径不发送供应商专属字段");
assert(typeof DeepSeekError === "function", "旧错误类型导出仍可解析");

const withoutLegacyKey = createDeepSeekProvider({ deepseekBaseUrl: "https://legacy.example" }, {
  fetchImpl: async () => { throw new Error("不应发出网络请求"); },
});
try {
  await withoutLegacyKey.chat([]);
  assert(false, "旧配置无 Key 应拒绝请求");
} catch (error) {
  assert(error.code === "missing_api_key", "旧配置无 Key 保持兼容失败方式");
}

console.log(`\n[deepseek.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
