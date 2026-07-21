/**
 * deepseek.js 自动测试（Phase 4）。
 *
 * 所有测试使用 Mock fetch，不消耗真实 API 额度。
 * globalThis.fetch 在每个测试用例中替换，测试后恢复。
 *
 * 运行：node src/ai/deepseek.test.js
 */

import { createDeepSeekProvider, DeepSeekError } from "./deepseek.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${label} (${JSON.stringify(expected)})`);
  } else {
    failed++;
    console.error(
      `  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertInstanceOf(value, cls, label) {
  if (value instanceof cls) {
    passed++;
    console.log(`  PASS: ${label} — instanceof ${cls.name}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label} — not instanceof ${cls.name}`);
  }
}

function assertIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label} — "${haystack}" does not include "${needle}"`);
  }
}

// ============================================================
// Mock fetch 工具
// ============================================================

const originalFetch = globalThis.fetch;

/**
 * 安装 mock fetch。
 * @param {(url: string, init: RequestInit) => Response|Promise<Response>} fn
 */
function mockFetch(fn) {
  globalThis.fetch = fn;
}

/** 恢复原生 fetch */
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

/** 每个测试后自动清理 */
function afterEach() {
  restoreFetch();
}

/**
 * 构造标准 Mock 200 响应。
 */
function makeOkResponse(content = "Hello from DeepSeek", overrides = {}) {
  return new Response(
    JSON.stringify({
      id: "resp_001",
      object: "chat.completion",
      created: 1700000000,
      model: overrides.model ?? "deepseek-v4-flash",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: overrides.content ?? content,
          },
          finish_reason: overrides.finish_reason ?? "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { status: overrides.status ?? 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * 构造标准 Mock 错误响应。
 */
function makeErrorResponse(status, errorMessage = "error") {
  return new Response(
    JSON.stringify({ error: { message: errorMessage, type: "api_error" } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/** 简单 Mock 配置 */
const TEST_CONFIG = {
  deepseekApiKey: "sk-test-mock-key-12345",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekModel: "deepseek-v4-flash",
  deepseekTimeoutMs: 5000,
};

// ============================================================
// Test Suite
// ============================================================

console.log("\n=== 测试 1：正常请求成功 → 返回 content ===\n");

{
  let capturedUrl, capturedHeaders, capturedBody;
  mockFetch(async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return makeOkResponse("TeaParty-Bell AI connected");
  });

  const provider = createDeepSeekProvider(TEST_CONFIG);
  const result = await provider.chat([
    { role: "user", content: "请只回复：TeaParty-Bell AI connected" },
  ]);

  assertEqual(result, "TeaParty-Bell AI connected", "返回正确 content");
  assertEqual(capturedUrl, "https://api.deepseek.com/chat/completions", "URL 正确");
  afterEach();
}

console.log("\n=== 测试 2：content 前后空白正确 trim ===\n");

{
  mockFetch(() => makeOkResponse("  \n  trimmed text  \n  "));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  const result = await provider.chat([{ role: "user", content: "hi" }]);
  assertEqual(result, "trimmed text", "正确 trim 空白");
  afterEach();
}

console.log("\n=== 测试 3：自定义模型正确进入请求 ===\n");

{
  let capturedBody;
  mockFetch(async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeOkResponse("ok", { model: "deepseek-v4-pro" });
  });

  const config = { ...TEST_CONFIG, deepseekModel: "deepseek-v4-pro" };
  const provider = createDeepSeekProvider(config);
  await provider.chat([{ role: "user", content: "hi" }]);
  assertEqual(capturedBody.model, "deepseek-v4-pro", "请求中 model = deepseek-v4-pro");
  afterEach();
}

console.log("\n=== 测试 4：thinking disabled 正确进入请求 ===\n");

{
  let capturedBody;
  mockFetch(async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeOkResponse("ok");
  });

  const provider = createDeepSeekProvider(TEST_CONFIG);
  await provider.chat([{ role: "user", content: "hi" }], {
    thinking: { type: "disabled" },
  });
  assertEqual(
    JSON.stringify(capturedBody.thinking),
    JSON.stringify({ type: "disabled" }),
    "thinking = { type: disabled }"
  );
  afterEach();
}

console.log("\n=== 测试 5：thinking enabled 正确进入请求 ===\n");

{
  let capturedBody;
  mockFetch(async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeOkResponse("thoughtful response");
  });

  const provider = createDeepSeekProvider(TEST_CONFIG);
  await provider.chat([{ role: "user", content: "hi" }], {
    thinking: { type: "enabled" },
  });
  assertEqual(
    JSON.stringify(capturedBody.thinking),
    JSON.stringify({ type: "enabled" }),
    "thinking = { type: enabled }"
  );
  afterEach();
}

console.log("\n=== 测试 6：未指定 thinking 时默认传 disabled（不依赖 DeepSeek 默认值）===\n");

{
  let capturedBody;
  mockFetch(async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeOkResponse("ok");
  });

  const provider = createDeepSeekProvider(TEST_CONFIG);
  await provider.chat([{ role: "user", content: "hi" }]);
  assertEqual(
    JSON.stringify(capturedBody.thinking),
    JSON.stringify({ type: "disabled" }),
    "未传 thinking → 默认 { type: disabled }"
  );
  afterEach();
}

console.log("\n=== 测试 7：maxTokens 正确传入 ===\n");

{
  let capturedBody;
  mockFetch(async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeOkResponse("ok");
  });

  const provider = createDeepSeekProvider(TEST_CONFIG);
  await provider.chat([{ role: "user", content: "hi" }], { maxTokens: 512 });
  assertEqual(capturedBody.max_tokens, 512, "max_tokens = 512");
  afterEach();
}

{
  // maxTokens 未传时不出现 max_tokens 字段
  let capturedBody;
  mockFetch(async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return makeOkResponse("ok");
  });

  const provider = createDeepSeekProvider(TEST_CONFIG);
  await provider.chat([{ role: "user", content: "hi" }]);
  assert(
    capturedBody.max_tokens === undefined,
    "未传 maxTokens 时请求体不含 max_tokens"
  );
  afterEach();
}

console.log("\n=== 测试 8：API Key 正确进入 Authorization Header ===\n");

{
  let capturedAuth;
  mockFetch(async (url, init) => {
    capturedAuth = init.headers.Authorization;
    return makeOkResponse("ok");
  });

  const provider = createDeepSeekProvider(TEST_CONFIG);
  await provider.chat([{ role: "user", content: "hi" }]);
  assertEqual(capturedAuth, "Bearer sk-test-mock-key-12345", "Authorization header 正确");
  // 验证测试中不输出真实 Key
  assert(
    !capturedAuth.includes("real"),
    "Mock 测试不含真实 Key"
  );
  afterEach();
}

console.log("\n=== 测试 9：Base URL 正确拼接（去除末尾斜杠）===\n");

{
  let capturedUrl;
  mockFetch(async (url) => {
    capturedUrl = url;
    return makeOkResponse("ok");
  });

  const config = { ...TEST_CONFIG, deepseekBaseUrl: "https://api.deepseek.com/" };
  const provider = createDeepSeekProvider(config);
  await provider.chat([{ role: "user", content: "hi" }]);
  assertEqual(
    capturedUrl,
    "https://api.deepseek.com/chat/completions",
    "末尾斜杠被去除，URL 正确"
  );
  afterEach();
}

console.log("\n=== 测试 10：请求超时 → Abort → 抛出超时错误 ===\n");

{
  mockFetch((url, init) => {
    // 模拟永不响应：返回一个永不 resolve 的 Promise
    // fetch 本身会因 AbortController 而抛出 AbortError
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new DOMException("The operation was aborted.", "AbortError");
        reject(err);
      });
      // 不 resolve —— 让 abort 触发
    });
  });

  const config = { ...TEST_CONFIG, deepseekTimeoutMs: 50 };
  const provider = createDeepSeekProvider(config);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "timeout", "错误码 = timeout");
    assertIncludes(err.message, "超时", "错误信息包含超时");
  }
  afterEach();
}

console.log("\n=== 测试 11：网络错误 → 明确失败 ===\n");

{
  mockFetch(() => {
    throw new Error("connect ECONNREFUSED");
  });

  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "network_error", "错误码 = network_error");
    assertIncludes(err.message, "网络请求失败", "错误信息包含网络请求失败");
  }
  afterEach();
}

console.log("\n=== 测试 12：401 / 认证错误 ===\n");

{
  mockFetch(() => makeErrorResponse(401, "Invalid API key"));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "auth_error", "错误码 = auth_error");
    assertEqual(err.httpStatus, 401, "httpStatus = 401");
    assertIncludes(err.message, "401", "错误信息包含状态码");
  }
  afterEach();
}

console.log("\n=== 测试 13：402 / 余额不足 ===\n");

{
  mockFetch(() => makeErrorResponse(402, "Insufficient balance"));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "insufficient_balance", "错误码 = insufficient_balance");
    assertEqual(err.httpStatus, 402, "httpStatus = 402");
  }
  afterEach();
}

console.log("\n=== 测试 14：422 / 参数错误 ===\n");

{
  mockFetch(() => makeErrorResponse(422, "Invalid model"));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "invalid_params", "错误码 = invalid_params");
    assertEqual(err.httpStatus, 422, "httpStatus = 422");
  }
  afterEach();
}

console.log("\n=== 测试 15：429 / Rate Limit ===\n");

{
  mockFetch(() => makeErrorResponse(429, "Too many requests"));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "rate_limit", "错误码 = rate_limit");
  }
  afterEach();
}

console.log("\n=== 测试 16：500 / 服务端错误 ===\n");

{
  mockFetch(() => makeErrorResponse(500, "Server error"));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "server_error", "错误码 = server_error");
  }
  afterEach();
}

console.log("\n=== 测试 17：503 / 服务过载 ===\n");

{
  mockFetch(() => makeErrorResponse(503, "Server overloaded"));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "server_overloaded", "错误码 = server_overloaded");
  }
  afterEach();
}

console.log("\n=== 测试 18：400 / 请求格式错误 ===\n");

{
  mockFetch(() => makeErrorResponse(400, "Invalid format"));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "invalid_format", "错误码 = invalid_format");
    assertEqual(err.httpStatus, 400, "httpStatus = 400");
  }
  afterEach();
}

console.log("\n=== 测试 19：非 JSON 或异常响应 ===\n");

{
  mockFetch(() => new Response("plain text, not json", { status: 200 }));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "invalid_response", "错误码 = invalid_response");
  }
  afterEach();
}

console.log("\n=== 测试 20：choices 缺失 ===\n");

{
  mockFetch(() =>
    new Response(
      JSON.stringify({ id: "x", object: "chat.completion", choices: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "invalid_response", "错误码 = invalid_response");
    assertIncludes(err.message, "choices", "错误信息提到 choices");
  }
  afterEach();
}

console.log("\n=== 测试 21：content 为空 → empty_content ===\n");

{
  mockFetch(() =>
    new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "empty_content", "错误码 = empty_content");
    assertIncludes(err.message, "content_filter", "错误信息包含 finish_reason");
  }
  afterEach();
}

console.log("\n=== 测试 22：content 为 null → empty_content ===\n");

{
  mockFetch(() =>
    new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "empty_content", "错误码 = empty_content");
  }
  afterEach();
}

console.log("\n=== 测试 23：content 仅含空白字符 → empty_content ===\n");

{
  // whitespace-only content must be rejected
  mockFetch(() =>
    new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "   \n \t  " }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "empty_content", "错误码 = empty_content");
    assertIncludes(err.message, "空白字符", "错误信息提示空白字符");
  }
  afterEach();
}

console.log("\n=== 测试 24：API Key 缺失时 chat() 抛出明确错误 ===\n");

{
  const config = { ...TEST_CONFIG, deepseekApiKey: undefined };
  const provider = createDeepSeekProvider(config);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
    assert(false, "应抛出异常");
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assertEqual(err.code, "missing_api_key", "错误码 = missing_api_key");
    assertIncludes(err.message, "DEEPSEEK_API_KEY", "错误信息提到 DEEPSEEK_API_KEY");
  }
}

console.log("\n=== 测试 25：API Key 缺失时 provider 仍可创建（不抛异常）===\n");

{
  const config = { ...TEST_CONFIG, deepseekApiKey: undefined };
  let provider;
  try {
    provider = createDeepSeekProvider(config);
    assert(true, "创建 provider 不抛异常");
  } catch {
    assert(false, "创建 provider 不应抛异常");
  }
  assert(provider !== undefined, "provider 被创建");
  assertEqual(typeof provider.chat, "function", "provider.chat 是函数");
}

console.log("\n=== 测试 26：日志和错误不得泄露 API Key ===\n");

{
  mockFetch(() => makeErrorResponse(401, "Invalid API key"));
  const provider = createDeepSeekProvider(TEST_CONFIG);
  try {
    await provider.chat([{ role: "user", content: "hi" }]);
  } catch (err) {
    assertInstanceOf(err, DeepSeekError, "抛出 DeepSeekError");
    assert(!err.message.includes("sk-test-mock-key-12345"), "错误消息不含 API Key");
    assert(!err.message.includes("Bearer"), "错误消息不含 Bearer");
    if (err.cause) {
      // cause 对象也不应含 Key
      const causeStr = JSON.stringify(err.cause);
      assert(!causeStr.includes("sk-test"), "cause 不含 API Key");
    }
  }
  afterEach();
}

console.log("\n=== 测试 27：provider.model 返回当前模型名 ===\n");

{
  const provider = createDeepSeekProvider(TEST_CONFIG);
  assertEqual(provider.model, "deepseek-v4-flash", "model getter 返回正确模型名");
}

console.log("\n=== 测试 28：reasoning_content 不被当作最终 content 返回 ===\n");

{
  // 模拟 thinking enabled 的响应：content 和 reasoning_content 同时存在
  mockFetch(() =>
    new Response(
      JSON.stringify({
        id: "resp_reasoning",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "最终答案",
              reasoning_content: "这是思考过程...很长的思考...",
            },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
  const provider = createDeepSeekProvider(TEST_CONFIG);
  const result = await provider.chat([{ role: "user", content: "复杂问题" }], {
    thinking: { type: "enabled" },
  });
  assertEqual(result, "最终答案", "只返回 content，不返回 reasoning_content");
  assert(!result.includes("思考过程"), "结果不含 reasoning 内容");
  afterEach();
}

// ============================================================
// Summary
// ============================================================

console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}
