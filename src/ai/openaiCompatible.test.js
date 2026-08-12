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

// ---------------------------------------------------------------------------
// 默认请求体：reasoning_effort=high，无 max_tokens / temperature
// ---------------------------------------------------------------------------
{
  let captured;
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async (url, init) => { captured = { url, init }; return ok(standard("  hello  ")); },
  });
  const result = await provider.chat([{ role: "user", content: "hi" }]);
  assert(result === "hello", "标准字符串响应");
  assert(captured.url === baseConfig.aiChatCompletionsUrl, "使用完整 endpoint");
  const body = JSON.parse(captured.init.body);
  equal(
    body,
    {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      stream: false,
    },
    "默认请求体含 reasoning_effort=high，无 max_tokens / temperature",
  );
  assert(!("max_tokens" in body), "未传 maxTokens 时不存在 max_tokens");
  assert(!("temperature" in body), "未传 temperature 时不存在 temperature");
  assert(captured.init.headers.Authorization === "Bearer secret-test-key", "默认鉴权");
  assert(!("thinking" in body) && !("reasoning" in body) && !("provider" in body), "默认请求无供应商专属字段");
}

// ---------------------------------------------------------------------------
// options.reasoningEffort 可覆盖默认值
// ---------------------------------------------------------------------------
{
  let body;
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return ok(standard("ok"));
    },
  });
  await provider.chat([], { reasoningEffort: "medium" });
  assert(body.reasoning_effort === "medium", "options.reasoningEffort 覆盖默认 high");
}

// ---------------------------------------------------------------------------
// AI_EXTRA_BODY_JSON 可补充 / 覆盖供应商特殊参数
// ---------------------------------------------------------------------------
{
  let captured;
  const provider = createOpenAICompatibleProvider({
    ...baseConfig,
    aiAuthHeader: "X-API-Key",
    aiAuthScheme: "Token",
    aiExtraHeaders: { "X-Client": "TeaParty-Bell" },
    aiExtraBody: { top_p: 0.5, thinking: { type: "enabled" }, reasoning_effort: "low" },
  }, { fetchImpl: async (_url, init) => { captured = init; return ok(standard("ok")); } });
  await provider.chat([], { maxTokens: 64 });
  assert(captured.headers["X-API-Key"] === "Token secret-test-key", "自定义鉴权 Header / Scheme");
  assert(captured.headers["X-Client"] === "TeaParty-Bell", "Extra Headers 注入");
  const body = JSON.parse(captured.body);
  assert(body.top_p === 0.5, "Extra Body 补充 top_p");
  equal(body.thinking, { type: "enabled" }, "Extra Body 可注入供应商 thinking 参数");
  assert(body.reasoning_effort === "low", "Extra Body 可覆盖 reasoning_effort");
  assert(body.max_tokens === 64, "显式 maxTokens 发送 max_tokens");
}

// ---------------------------------------------------------------------------
// 显式 temperature
// ---------------------------------------------------------------------------
{
  let body;
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return ok(standard("ok"));
    },
  });
  await provider.chat([], { temperature: 0.7 });
  assert(body.temperature === 0.7, "显式 temperature 正常发送");
  assert(!("max_tokens" in body), "仅传 temperature 时仍不发送 max_tokens");
}

// ---------------------------------------------------------------------------
// 文本内容数组响应
// ---------------------------------------------------------------------------
{
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () => ok(standard([{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }])),
  });
  assert(await provider.chat([]) === "第一段第二段", "文本内容数组响应");
}

// ---------------------------------------------------------------------------
// 无 Key 时不发送鉴权
// ---------------------------------------------------------------------------
{
  const provider = createOpenAICompatibleProvider({ ...baseConfig, aiApiKey: "" }, {
    fetchImpl: async (_url, init) => { assert(!("Authorization" in init.headers), "无 Key 时不发送鉴权"); return ok(standard("ok")); },
  });
  await provider.chat([]);
}

// ---------------------------------------------------------------------------
// reasoning_content + 正常 content → 只返回 content
// ---------------------------------------------------------------------------
{
  const secretReasoning = "SECRET_REASONING_TRACE_DO_NOT_LEAK";
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () =>
      ok({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "  final answer  ",
              reasoning_content: secretReasoning,
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
  });
  const text = await provider.chat([]);
  assert(text === "final answer", "reasoning_content + content 时只返回 content");
  assert(!text.includes(secretReasoning), "返回值不含 reasoning 原文");
}

// ---------------------------------------------------------------------------
// reasoning_content + 空 content + finish_reason=length → reasoning_budget_exhausted
// ---------------------------------------------------------------------------
{
  const secretReasoning = "INTERNAL_CHAIN_OF_THOUGHT_NEVER_LOG";
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () =>
      ok({
        choices: [
          {
            finish_reason: "length",
            message: {
              content: "",
              reasoning_content: secretReasoning,
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 128,
          total_tokens: 228,
          completion_tokens_details: { reasoning_tokens: 128 },
        },
      }),
  });
  const error = await rejects(
    () => provider.chat([]),
    "reasoning_budget_exhausted",
    "推理预算耗尽",
  );
  assert(
    error.message.includes("推理阶段耗尽输出预算"),
    "错误消息说明推理预算耗尽",
  );
  assert(error.finishReason === "length", "诊断保留 finish_reason");
  assert(error.hasReasoningContent === true, "诊断标记 reasoning_content 存在");
  assert(error.reasoningContentLength === secretReasoning.length, "诊断保留 reasoning 字符数");
  assert(error.usage?.completion_tokens === 128, "诊断保留 usage.completion_tokens");
  assert(error.usage?.reasoning_tokens === 128, "诊断保留 usage.reasoning_tokens");
  assert(
    !error.message.includes(secretReasoning),
    "错误消息不泄露 reasoning_content 原文",
  );
  assert(
    !JSON.stringify(error).includes(secretReasoning),
    "错误对象序列化不泄露 reasoning 原文",
  );
}

// ---------------------------------------------------------------------------
// 有 reasoning 但 finish_reason 非 length 的空 content → empty_content
// ---------------------------------------------------------------------------
{
  const secretReasoning = "ANOTHER_SECRET_REASONING";
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () =>
      ok({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "   ", reasoning_content: secretReasoning },
          },
        ],
      }),
  });
  const error = await rejects(() => provider.chat([]), "empty_content", "空 content 且非 length 仍 empty_content");
  assert(!error.message.includes(secretReasoning), "empty_content 不泄露 reasoning 原文");
}

// ---------------------------------------------------------------------------
// 普通空 content 仍 empty_content
// ---------------------------------------------------------------------------
{
  const provider = createOpenAICompatibleProvider(baseConfig, { fetchImpl: async () => ok(standard("   ")) });
  await rejects(() => provider.chat([]), "empty_content", "普通空文本");
}

// ---------------------------------------------------------------------------
// 非 2xx：安全提取上游错误字段
// ---------------------------------------------------------------------------
{
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            param: "messages",
            message: "This model's maximum context length was exceeded",
          },
        }),
        { status: 422 },
      ),
  });
  const error = await rejects(() => provider.chat([]), "http_error", "HTTP 422 带上游错误体");
  assert(error.httpStatus === 422, "HTTP 状态码安全保留");
  assert(error.message.includes("HTTP 422"), "消息含 HTTP 状态");
  assert(error.message.includes("invalid_request_error"), "消息含 error.type");
  assert(error.message.includes("context_length_exceeded"), "消息含 error.code");
  assert(error.message.includes("messages"), "消息含 error.param");
  assert(error.message.includes("maximum context length"), "消息含 error.message");
  assert(error.upstreamError?.type === "invalid_request_error", "upstreamError.type");
  assert(error.upstreamError?.code === "context_length_exceeded", "upstreamError.code");
  assert(!error.message.includes("secret-test-key"), "HTTP 错误不泄露 API Key");
  assert(!error.message.includes("Authorization"), "HTTP 错误不泄露 Authorization");
}

// ---------------------------------------------------------------------------
// 非 2xx：无 JSON 错误体时保持基础消息
// ---------------------------------------------------------------------------
{
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () => new Response("error", { status: 502 }),
  });
  const error = await rejects(() => provider.chat([]), "server_error", "HTTP 502 无 JSON 体");
  assert(error.httpStatus === 502, "HTTP 状态码安全保留");
  assert(error.message === "AI Provider 请求失败（HTTP 502）", "无错误体时消息简洁");
}

// ---------------------------------------------------------------------------
// 上游错误 message 截断到 500 字符
// ---------------------------------------------------------------------------
{
  const longMsg = "X".repeat(800);
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: longMsg } }), { status: 400 }),
  });
  const error = await rejects(() => provider.chat([]), "http_error", "HTTP 400 长错误消息");
  assert(error.upstreamError?.message?.length === 500, "upstream message 截断到 500");
  assert(!error.message.includes("X".repeat(600)), "错误消息不含超长原文");
}

// ---------------------------------------------------------------------------
// 网络错误不泄露 Key
// ---------------------------------------------------------------------------
{
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () => { throw new Error("Authorization: Bearer secret-test-key"); },
  });
  const error = await rejects(() => provider.chat([]), "network_error", "网络错误");
  assert(!error.message.includes("secret-test-key") && !error.message.includes("Bearer"), "网络错误不泄露 Key");
}

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// content 为 null 且无 reasoning → empty_content
// ---------------------------------------------------------------------------
{
  const provider = createOpenAICompatibleProvider(baseConfig, {
    fetchImpl: async () =>
      ok({ choices: [{ finish_reason: "stop", message: { content: null } }] }),
  });
  await rejects(() => provider.chat([]), "empty_content", "content=null 仍 empty_content");
}

console.log(`\n[openaiCompatible.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
