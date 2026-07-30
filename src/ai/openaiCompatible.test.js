import { AiProviderError } from "./aiProviderError.js";
import { createOpenAICompatibleProvider } from "./openaiCompatible.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function equal(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), label);
}
async function rejects(action, code, label) {
  try { await action(); assert(false, label); }
  catch (error) {
    assert(error instanceof AiProviderError, `${label} - AiProviderError`);
    assert(error.code === code, `${label} - ${code}`);
    return error;
  }
}

const baseConfig = {
  aiChatCompletionsUrl: "https://example.test/v1/chat/completions",
  aiApiKey: "secret-test-key",
  aiModel: "test-model",
  aiTimeoutMs: 20,
  aiAuthHeader: "Authorization",
  aiAuthScheme: "Bearer",
  aiBackendLabel: "Test Backend",
  aiExtraHeaders: {},
  aiExtraBody: {},
};
const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
const standard = (content) => ({ choices: [{ message: { content } }] });

{
  let captured;
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async (url, init) => { captured = { url, init }; return ok(standard("  hello  ")); },
  });
  const result = await provider.chat([{ role: "user", content: "hi" }]);
  assert(result === "hello", "标准字符串响应");
  assert(captured.url === baseConfig.aiChatCompletionsUrl, "使用完整 endpoint");
  const body = JSON.parse(captured.init.body);
  equal(body, { model: "test-model", messages: [{ role: "user", content: "hi" }], max_tokens: 128, temperature: 1, stream: false }, "默认请求体仅含通用字段");
  assert(captured.init.headers.Authorization === "Bearer secret-test-key", "默认鉴权");
  assert(!("thinking" in body) && !("reasoning" in body) && !("provider" in body), "默认请求无供应商专属字段");
}

{
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () => ok(standard([{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }])),
  });
  assert(await provider.chat([]) === "第一段第二段", "文本内容数组响应");
}

{
  const provider = createOpenAICompatibleProvider({ ...baseConfig, aiApiKey: "" }, {
    fetchImpl: async (_url, init) => { assert(!("Authorization" in init.headers), "无 Key 时不发送鉴权"); return ok(standard("ok")); },
  });
  await provider.chat([]);
}

{
  let captured;
  const provider = createOpenAICompatibleProvider({
    ...baseConfig,
    aiAuthHeader: "X-API-Key",
    aiAuthScheme: "Token",
    aiExtraHeaders: { "X-Client": "TeaParty-Bell" },
    aiExtraBody: { top_p: 0.5 },
  }, { fetchImpl: async (_url, init) => { captured = init; return ok(standard("ok")); } });
  await provider.chat([], { maxTokens: 64 });
  assert(captured.headers["X-API-Key"] === "Token secret-test-key", "自定义鉴权 Header / Scheme");
  assert(captured.headers["X-Client"] === "TeaParty-Bell", "Extra Headers 注入");
  const body = JSON.parse(captured.body);
  assert(body.top_p === 0.5 && body.max_tokens === 64, "Extra Body 注入");
}

{
  const provider = createOpenAICompatibleProvider(baseConfig, { fetchImpl: async () => new Response("error", { status: 502 }) });
  const error = await rejects(() => provider.chat([]), "server_error", "HTTP 错误");
  assert(error.httpStatus === 502, "HTTP 状态码安全保留");
}

{
  const provider = createOpenAICompatibleProvider(baseConfig, { fetchImpl: async () => { throw new Error("Authorization: Bearer secret-test-key"); } });
  const error = await rejects(() => provider.chat([]), "network_error", "网络错误");
  assert(!error.message.includes("secret-test-key") && !error.message.includes("Bearer"), "网络错误不泄露 Key");
}

{
  const provider = createOpenAICompatibleProvider({ ...baseConfig, aiTimeoutMs: 1 }, {
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  });
  await rejects(() => provider.chat([]), "timeout", "超时");
}

function makeControlledTimeout() {
  let timerCallback;
  let clearCount = 0;
  return {
    setTimeoutImpl(callback) {
      timerCallback = callback;
      return { timer: "fake" };
    },
    clearTimeoutImpl() {
      clearCount++;
    },
    get clearCount() {
      return clearCount;
    },
    fire() {
      timerCallback();
    },
  };
}

// fetch 阶段未返回时，AbortController 必须结束完整请求并清理计时器。
{
  const timer = makeControlledTimeout();
  const provider = createOpenAICompatibleProvider({ ...baseConfig, aiTimeoutMs: 1 }, {
    ...timer,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      queueMicrotask(() => timer.fire());
    }),
  });
  const error = await rejects(() => provider.chat([]), "timeout", "fetch 一直不返回时超时");
  assert(!error.message.includes("secret-test-key") && !error.message.includes("Bearer"), "timeout 错误不泄露 Key");
  assert(timer.clearCount === 1, "fetch 超时后清理 timer");
}

// 已收到响应头但正文未完成时，timer 仍必须生效。
{
  const timer = makeControlledTimeout();
  const provider = createOpenAICompatibleProvider({ ...baseConfig, aiTimeoutMs: 1 }, {
    ...timer,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        queueMicrotask(() => timer.fire());
      }),
    }),
  });
  await rejects(() => provider.chat([]), "timeout", "正文解析未完成时超时");
  assert(timer.clearCount === 1, "正文超时后清理 timer");
}

// 正文及时完成应正常返回，并且成功路径同样清理 timer。
{
  let clearCount = 0;
  const provider = createOpenAICompatibleProvider(baseConfig, {
    setTimeoutImpl: () => ({ timer: "success" }),
    clearTimeoutImpl: () => { clearCount++; },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => standard("body complete") }),
  });
  assert(await provider.chat([]) === "body complete", "正文在 timeout 前完成时正常返回");
  assert(clearCount === 1, "成功后清理 timer");
}

// 非 AbortError 的 JSON 解析失败保持 invalid_response，且没有悬挂 timer。
{
  let clearCount = 0;
  const provider = createOpenAICompatibleProvider(baseConfig, {
    setTimeoutImpl: () => ({ timer: "syntax-error" }),
    clearTimeoutImpl: () => { clearCount++; },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }),
  });
  await rejects(() => provider.chat([]), "invalid_response", "正文解析普通 SyntaxError");
  assert(clearCount === 1, "解析失败后清理 timer");
}

{
  const provider = createOpenAICompatibleProvider(baseConfig, { fetchImpl: async () => new Response("not json", { status: 200 }) });
  await rejects(() => provider.chat([]), "invalid_response", "非法 JSON");
}

{
  const provider = createOpenAICompatibleProvider(baseConfig, { fetchImpl: async () => ok({}) });
  await rejects(() => provider.chat([]), "invalid_response", "缺少 choices");
}

{
  const provider = createOpenAICompatibleProvider(baseConfig, { fetchImpl: async () => ok(standard("   ")) });
  await rejects(() => provider.chat([]), "empty_content", "空文本");
}

console.log(`\n[openaiCompatible.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
