/**
 * Startup Preflight（启动权限自检）。
 *
 * 检查 Guild / SystemChannelFlags / 系统频道 / 感谢频道 / Emoji / 运行模式。
 *
 * 永久故障（exit 78）：
 *   Missing Access, Unknown Guild/Channel, 权限缺失, SuppressPremiumSubscriptions,
 *   production+TEST_MODE=true
 *
 * 可恢复故障（exit 1）：
 *   网络错误, Discord API 暂时不可用, 超时
 *
 * Guild 只 fetch 一次，后续检查复用。
 */

import { ChannelType, GuildSystemChannelFlags } from "discord.js";

export const PreflightResult = {
  PASS: "pass",
  FATAL: "fatal",
  WARNING: "warning",
  RECOVERABLE: "recoverable",
};

/**
 * Discord API 错误码映射。
 * 来自 https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
 */
const DISCORD_ERROR_PERMANENT = new Map([
  [50001, "Missing Access"],
  [50013, "Missing Permissions"],
  [10004, "Unknown Guild"],
  [10003, "Unknown Channel"],
  [50035, "Invalid Form Body"],
]);

function _isPermanentDiscordError(err) {
  const code = err?.code;
  // DiscordAPIError 直接带 code 属性
  if (typeof code === "number" && DISCORD_ERROR_PERMANENT.has(code)) {
    return true;
  }
  // HTTP 错误码
  const httpStatus = err?.httpStatus ?? err?.status;
  if (httpStatus === 403 || httpStatus === 404) {
    return true;
  }
  return false;
}

function _isNetworkError(err) {
  // 网络超时、DNS 失败、连接拒绝等
  if (err?.code === "ECONNREFUSED" || err?.code === "ETIMEDOUT" ||
      err?.code === "ENOTFOUND" || err?.code === "ECONNRESET" ||
      err?.code === "AbortError") {
    return true;
  }
  return false;
}

export function createStartupPreflight(options) {
  const {
    client,
    config,
    logger,
    emojiProvider,
    notifyFailure,
    notifyWarning,
    exitFn = process.exit,
  } = options;

  const _results = [];
  /** @type {import("discord.js").Guild|null} 缓存，只 fetch 一次 */
  let _guild = null;

  function _addResult(check, result, message, details = {}) {
    _results.push({ check, result, message, details });
    return result;
  }

  // ========================
  // 错误分类工具
  // ========================

  function _classifyFetchError(err, context) {
    if (_isPermanentDiscordError(err)) {
      return { result: PreflightResult.FATAL, label: `${context}（永久错误: ${err.message}）` };
    }
    if (_isNetworkError(err)) {
      return { result: PreflightResult.RECOVERABLE, label: `${context}（网络错误: ${err.message}）` };
    }
    return { result: PreflightResult.RECOVERABLE, label: `${context}（无法确定: ${err.message}）` };
  }

  /**
   * 当 Guild 获取失败后，后续依赖 Guild 的检查不应重复添加 FATAL。
   * 改为 SKIP——根因已在 _fetchGuildOnce 中记录。
   */
  function _skipNoGuild(checkName) {
    _addResult(checkName, PreflightResult.WARNING,
      `跳过检查：Guild 不可用（根因见 guild 检查结果）`);
  }

  // ========================
  // 检查项
  // ========================

  /**
   * 获取 Guild（仅 fetch 一次，缓存结果）。
   * fatal/recoverable 都会记录结果，调用方无需重复 fetch。
   */
  async function _fetchGuildOnce() {
    if (_guild !== null) return _guild;

    const guildId = config.discordGuildId;
    if (!guildId) {
      _addResult("guild", PreflightResult.FATAL, "discordGuildId 未配置");
      return null;
    }

    try {
      const g = await client.guilds.fetch(guildId);
      if (g && g.id === guildId) {
        _guild = g;
        _addResult("guild", PreflightResult.PASS,
          `目标 Guild 可访问：${g.name}（${g.id}）`,
          { guildId: g.id, guildName: g.name });
        return _guild;
      }
      _addResult("guild", PreflightResult.FATAL,
        `目标 Guild（${guildId}）不存在或 ID 不匹配`);
      return null;
    } catch (err) {
      const classified = _classifyFetchError(err, `无法获取 Guild（${guildId}）`);
      _addResult("guild", classified.result, classified.label,
        { guildId, discordCode: err?.code, errorName: err?.name });
      return null;
    }
  }

  async function _checkSuppressPremiumSubscriptions() {
    const guild = await _fetchGuildOnce();
    if (!guild) {
      // Guild 获取失败——根因已在 _fetchGuildOnce 中记录（FATAL 或 RECOVERABLE）
      // 这里不重复添加 FATAL，以免覆盖网络错误的可恢复判定
      return _skipNoGuild("suppress_premium_subscriptions");
    }

    try {
      // 使用 discord.js 枚举而非独立魔法数字
      const flags = guild.systemChannelFlags;
      if (flags && flags.has(GuildSystemChannelFlags.SuppressPremiumSubscriptions)) {
        return _addResult(
          "suppress_premium_subscriptions",
          PreflightResult.FATAL,
          "服务器已关闭 Boost 系统消息通知（SuppressPremiumSubscriptions 已启用）。" +
            "自动感谢功能无法工作。请在服务器设置 → 概览中重新开启" +
            "「Send a message when someone Boosts this server」。",
          { guildId: guild.id }
        );
      }
      return _addResult(
        "suppress_premium_subscriptions",
        PreflightResult.PASS,
        "Boost 系统消息通知已开启",
        { guildId: guild.id }
      );
    } catch (err) {
      // 无法读取 systemChannelFlags → WARNING（非 PASS）
      if (logger) {
        logger.warn("[StartupPreflight] 无法读取 systemChannelFlags", {
          guildId: guild.id,
          error: err.message,
        });
      }
      return _addResult(
        "suppress_premium_subscriptions",
        PreflightResult.WARNING,
        `无法读取 systemChannelFlags：${err.message}。无法确认 Boost 通知是否开启。`,
        { guildId: guild.id }
      );
    }
  }

  async function _checkSystemChannel() {
    const guild = await _fetchGuildOnce();
    if (!guild) {
      return _skipNoGuild("system_channel");
    }

    const systemChannelId = guild.systemChannelId;
    if (!systemChannelId) {
      return _addResult("system_channel", PreflightResult.FATAL,
        "目标 Guild 未设置 System Messages Channel。请在服务器设置 → 概览中指定系统消息频道。",
        { guildId: guild.id });
    }

    let channel;
    try {
      channel = await client.channels.fetch(systemChannelId);
    } catch (err) {
      const classified = _classifyFetchError(err, `无法获取系统消息频道（${systemChannelId}）`);
      return _addResult("system_channel", classified.result, classified.label,
        { guildId: guild.id, systemChannelId, discordCode: err?.code });
    }

    if (!channel) {
      return _addResult("system_channel", PreflightResult.FATAL,
        `系统消息频道（${systemChannelId}）不存在`,
        { guildId: guild.id, systemChannelId });
    }

    if (channel.guildId !== guild.id && channel.guild?.id !== guild.id) {
      return _addResult("system_channel", PreflightResult.FATAL,
        `系统消息频道不属于目标 Guild`,
        { guildId: guild.id, systemChannelId,
          channelGuildId: channel.guildId ?? channel.guild?.id });
    }

    // 权限
    const permissions = channel.permissionsFor(client.user);
    if (!permissions) {
      return _addResult("system_channel", PreflightResult.FATAL,
        `无法获取系统消息频道权限信息`,
        { guildId: guild.id, systemChannelId });
    }

    const missing = [];
    if (!permissions.has("ViewChannel")) missing.push("ViewChannel");
    if (!permissions.has("ReadMessageHistory")) missing.push("ReadMessageHistory");
    if (missing.length > 0) {
      return _addResult("system_channel", PreflightResult.FATAL,
        `系统消息频道缺少权限：${missing.join("、")}`,
        { guildId: guild.id, systemChannelId, missing });
    }

    return _addResult("system_channel", PreflightResult.PASS,
      `系统消息频道可访问：${systemChannelId}`,
      { guildId: guild.id, systemChannelId });
  }

  async function _checkThanksChannel() {
    const guildId = config.discordGuildId;
    const channelId = config.discordThanksChannelId;

    if (!channelId) {
      return _addResult("thanks_channel", PreflightResult.FATAL,
        "discordThanksChannelId 未配置");
    }

    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      const classified = _classifyFetchError(err, `无法获取感谢频道（${channelId}）`);
      return _addResult("thanks_channel", classified.result, classified.label,
        { guildId, channelId, discordCode: err?.code });
    }

    if (!channel) {
      return _addResult("thanks_channel", PreflightResult.FATAL,
        `感谢频道（${channelId}）不存在`, { guildId, channelId });
    }

    const channelGuildId = channel.guildId ?? channel.guild?.id;
    if (channelGuildId !== guildId) {
      return _addResult("thanks_channel", PreflightResult.FATAL,
        `感谢频道不属于目标 Guild`, { guildId, channelId, channelGuildId });
    }

    if (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement) {
      return _addResult("thanks_channel", PreflightResult.FATAL,
        `感谢频道不是文本频道（type: ${channel.type}）`,
        { guildId, channelId, channelType: channel.type });
    }

    const permissions = channel.permissionsFor(client.user);
    if (!permissions) {
      return _addResult("thanks_channel", PreflightResult.FATAL,
        `无法获取感谢频道权限信息`, { guildId, channelId });
    }

    const missing = [];
    if (!permissions.has("ViewChannel")) missing.push("ViewChannel");
    if (!permissions.has("SendMessages")) missing.push("SendMessages");
    if (!permissions.has("ReadMessageHistory")) missing.push("ReadMessageHistory");
    const addReactionsMissing = !permissions.has("AddReactions");

    if (missing.length > 0) {
      return _addResult("thanks_channel", PreflightResult.FATAL,
        `感谢频道缺少权限：${missing.join("、")}`,
        { guildId, channelId, missing });
    }

    if (addReactionsMissing) {
      return _addResult("thanks_channel", PreflightResult.WARNING,
        `感谢频道缺少 AddReactions，Reaction 降级，主消息正常`,
        { guildId, channelId, missing: ["AddReactions"] });
    }

    return _addResult("thanks_channel", PreflightResult.PASS,
      `感谢频道可访问：${channelId}`,
      { guildId, channelId });
  }

  async function _checkApplicationEmojis() {
    if (!emojiProvider) {
      return _addResult("application_emojis", PreflightResult.WARNING,
        "Emoji Provider 未提供，Reaction 不可用");
    }
    try {
      const emojis = await emojiProvider.fetchEmojis();
      if (emojis === null || (Array.isArray(emojis) && emojis.length === 0)) {
        return _addResult("application_emojis", PreflightResult.WARNING,
          "Application Emoji 获取失败或为空，Reaction 降级，主消息不受影响",
          { emojiCount: emojis?.length ?? 0 });
      }
      return _addResult("application_emojis", PreflightResult.PASS,
        `Application Emoji 可用：${emojis.length} 个`,
        { emojiCount: emojis.length });
    } catch (err) {
      return _addResult("application_emojis", PreflightResult.WARNING,
        `Application Emoji 获取异常：${err.message}`);
    }
  }

  function _checkRuntimeMode() {
    if (config.isProduction && config.testMode) {
      return _addResult("runtime_mode", PreflightResult.FATAL,
        "生产环境中 TEST_MODE=true 属于致命配置错误。请设置 TEST_MODE=false。",
        { nodeEnv: config.nodeEnv, testMode: config.testMode });
    }
    return _addResult("runtime_mode", PreflightResult.PASS,
      `运行模式正常：NODE_ENV=${config.nodeEnv}，TEST_MODE=${config.testMode}`,
      { nodeEnv: config.nodeEnv, testMode: config.testMode });
  }

  // ========================
  // 汇总与决策
  // ========================

  async function run() {
    _results.length = 0;
    _guild = null;

    if (logger) {
      logger.info("[StartupPreflight] 开始启动权限自检...", {
        guildId: config.discordGuildId,
        thanksChannelId: config.discordThanksChannelId,
        nodeEnv: config.nodeEnv,
        isProduction: config.isProduction,
      });
    }

    await _checkGuildDirect(); // _fetchGuildOnce 内部会调用
    await _checkSuppressPremiumSubscriptions();
    await _checkSystemChannel();
    await _checkThanksChannel();
    if (emojiProvider) await _checkApplicationEmojis();
    _checkRuntimeMode();

    const fatal = _results.filter((r) => r.result === PreflightResult.FATAL);
    const recoverable = _results.filter((r) => r.result === PreflightResult.RECOVERABLE);
    const warnings = _results.filter((r) => r.result === PreflightResult.WARNING);

    if (logger) {
      if (fatal.length === 0 && recoverable.length === 0) {
        logger.info("[StartupPreflight] 自检通过", {
          checkCount: _results.length, warningCount: warnings.length,
        });
      } else {
        logger.error("[StartupPreflight] 自检发现问题", {
          fatalCount: fatal.length, recoverableCount: recoverable.length,
          warningCount: warnings.length,
          fatalItems: fatal.map((r) => ({ check: r.check, message: r.message })),
          recoverableItems: recoverable.map((r) => ({ check: r.check, message: r.message })),
        });
      }
    }

    // 决策：permanent fatal → exit 78, recoverable → exit 1
    if (fatal.length > 0) {
      if (notifyFailure) {
        try {
          await notifyFailure("startup_preflight_failed",
            `启动自检失败，${fatal.length} 项致命问题`,
            { guildId: config.discordGuildId, details: { fatalCount: fatal.length, fatalItems: fatal } });
        } catch (err) {
          if (logger) logger.error("[StartupPreflight] 无法写入 fatal 告警", { error: err.message });
        }
      }
      if (notifyWarning && warnings.length > 0) {
        for (const w of warnings) {
          try { await notifyWarning(w.check, w.message, { details: w.details }); } catch {}
        }
      }
      exitFn(78);
      return { passed: false, fatal, recoverable, warnings, all: _results };
    }

    if (recoverable.length > 0) {
      if (notifyFailure) {
        try {
          await notifyFailure("startup_preflight_recoverable",
            `启动自检遇到可恢复错误：${recoverable[0].message}`,
            { guildId: config.discordGuildId, details: { recoverable } });
        } catch (err) {
          if (logger) logger.error("[StartupPreflight] 无法写入 recoverable 告警，放弃重启循环", { error: err.message });
          exitFn(78);
          return { passed: false, fatal: [], recoverable, warnings, all: _results };
        }
      }
      exitFn(1);
      return { passed: false, fatal: [], recoverable, warnings, all: _results };
    }

    if (notifyWarning && warnings.length > 0) {
      for (const w of warnings) {
        try { await notifyWarning(w.check, w.message, { details: w.details }); } catch {}
      }
    }

    return { passed: true, fatal: [], recoverable: [], warnings, all: _results };
  }

  // 首次调用 fetchGuildOnce（由 run 内联）
  async function _checkGuildDirect() {
    await _fetchGuildOnce();
  }

  return { run };
}
