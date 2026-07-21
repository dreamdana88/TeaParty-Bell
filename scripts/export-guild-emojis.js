/**
 * Guild Emoji 批量导出工具（Phase 4.5）。
 *
 * 读取 .env → 连接 Discord → 获取指定 Guild 的自定义 Emoji →
 * 下载到本地 → 生成 manifest.json → 输出统计。
 *
 * 运行：npm run export:emojis
 *
 * 基于 Discord 官方文档：
 * - GET  /guilds/{guild.id}/emojis
 * - CDN: https://cdn.discordapp.com/emojis/{id}.webp
 *         https://cdn.discordapp.com/emojis/{id}.webp?animated=true
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { rename, unlink } from "fs/promises";
import { pipeline } from "stream/promises";
import { Client, GatewayIntentBits } from "discord.js";

import { loadConfig } from "../src/config/index.js";
import { logger as log } from "../src/utils/logger.js";

// ---- 路径 ----
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const OUTPUT_DIR = resolve(PROJECT_ROOT, "data", "exported-emojis");
const EMOJIS_DIR = resolve(OUTPUT_DIR, "emojis");

const CDN_BASE = "https://cdn.discordapp.com";

// =========================================================================
// 纯逻辑函数（导出供测试）
// =========================================================================

/**
 * 构造 Emoji CDN 下载 URL（WebP 格式）。
 *
 * @param {string} id - Emoji snowflake ID
 * @param {boolean} animated - 是否动画
 * @returns {string} CDN URL
 */
export function buildCdnUrl(id, animated) {
  if (animated) {
    return `${CDN_BASE}/emojis/${id}.webp?animated=true`;
  }
  return `${CDN_BASE}/emojis/${id}.webp`;
}

/**
 * 安全处理 Emoji 名称用于文件名。
 *
 * - 替换 Windows 非法字符为 _
 * - 防止路径穿越
 * - 空或异常时使用 emoji_{id}
 *
 * @param {string|null|undefined} name - 原始 Emoji 名称
 * @param {string} id - Emoji ID（fallback 用）
 * @returns {string} 安全的文件名片段（不含扩展名）
 */
export function sanitizeFileName(name, id) {
  if (!name || typeof name !== "string" || name.trim() === "") {
    return `emoji_${id}`;
  }

  // Windows 非法字符：\ / : * ? " < > |
  // 同时移除路径分隔符变体和控制字符
  let safe = name.replace(/[\\/:*?"<>|]/g, "_");

  // 移除控制字符
  safe = safe.replace(/[\x00-\x1f\x7f]/g, "");

  // 去除首尾空白和点（Windows 不允许以点结尾的文件名）
  safe = safe.trim().replace(/\.+$/, "");

  // 如果清理后为空，fallback
  if (safe === "") {
    return `emoji_${id}`;
  }

  // 防止路径穿越：移除 ../ 和 ..\
  safe = safe.replace(/\.\./g, "_");

  return safe;
}

/**
 * 构造 Emoji 保存文件名。
 *
 * 格式：{safeName}__{id}.webp
 *
 * @param {{ id: string, name: string|null }} emoji
 * @returns {string} 文件名
 */
export function buildEmojiFileName(emoji) {
  const safeName = sanitizeFileName(emoji.name, emoji.id);
  return `${safeName}__${emoji.id}.webp`;
}

/**
 * 从 discord.js GuildEmoji 提取标准化记录。
 *
 * @param {import("discord.js").GuildEmoji} emoji
 * @returns {object}
 */
function extractEmojiRecord(emoji) {
  const roles = emoji.roles?.cache
    ? [...emoji.roles.cache.keys()]
    : [];

  return {
    id: emoji.id,
    name: emoji.name ?? null,
    animated: emoji.animated ?? false,
    available: emoji.available ?? true,
    managed: emoji.managed ?? false,
    roles,
  };
}

/**
 * 构建 manifest 对象。
 *
 * @param {string} guildId
 * @param {Array<object>} records - extractEmojiRecord 的输出 + download 结果
 * @returns {object} manifest
 */
export function buildManifest(guildId, records) {
  const successCount = records.filter((r) => r.downloaded).length;
  const failedCount = records.filter((r) => !r.downloaded).length;

  return {
    exportedAt: new Date().toISOString(),
    guildId,
    total: records.length,
    successCount,
    failedCount,
    emojis: records.map((r) => ({
      id: r.id,
      name: r.name,
      animated: r.animated,
      available: r.available,
      managed: r.managed,
      roles: r.roles,
      filename: r.filename,
      downloaded: r.downloaded,
      error: r.error ?? null,
    })),
  };
}

// =========================================================================
// 文件 / 网络操作
// =========================================================================

/**
 * 确保目录存在。
 */
function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 下载单个 Emoji 到指定路径（原子写入）。
 *
 * 先写入 .part 临时文件，下载完整成功后 rename 为正式文件。
 * 失败时清理 .part，不留下不完整的正式文件。
 *
 * @param {string} url - CDN URL
 * @param {string} filePath - 本地保存路径（最终 .webp 文件）
 * @returns {Promise<void>}
 */
async function downloadFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CDN HTTP ${response.status}`);
  }

  const partPath = `${filePath}.part`;
  const fileStream = createWriteStream(partPath);

  try {
    const { Readable } = await import("stream");
    await pipeline(Readable.fromWeb(response.body), fileStream);
    // 下载完整成功：原子 rename
    await rename(partPath, filePath);
  } catch (err) {
    // 下载或写入失败：尝试清理 .part 临时文件，不留下损坏文件
    try {
      await unlink(partPath);
    } catch {
      // 清理失败不影响主逻辑（可能文件未创建或已删除）
    }
    throw err;
  }
}

/**
 * 安全错误摘要：仅保留 message，不泄露 URL 中的 token 等。
 *
 * @param {Error} err
 * @returns {string}
 */
function safeErrorSummary(err) {
  const msg = err?.message ?? String(err);
  // 过滤可能含 token 的 URL
  return msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
}

// =========================================================================
// 主流程
// =========================================================================

/**
 * 执行 Guild Emoji 导出。
 *
 * @param {object} config - loadConfig() 的输出
 * @returns {Promise<{success: boolean, code?: number}>}
 */
export async function exportGuildEmojis(config) {
  // ---- 1. 校验配置 ----
  if (!config.discordBotToken) {
    console.error("❌ DISCORD_BOT_TOKEN 未配置。请在 .env 中设置后重试。");
    return { success: false, code: 1 };
  }

  if (!config.discordGuildId) {
    console.error("❌ DISCORD_GUILD_ID 未配置。请在 .env 中设置后重试。");
    return { success: false, code: 1 };
  }

  // ---- 2. 创建 Discord Client（仅 Guilds intent）----
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  /** @type {import("discord.js").Guild} */
  let guild;

  try {
    // ---- 3. 登录 ----
    console.log("正在连接 Discord...");
    await client.login(config.discordBotToken);
    console.log(`已登录：${client.user.tag}`);

    // ---- 4. 获取目标 Guild ----
    guild = client.guilds.cache.get(config.discordGuildId);
    if (!guild) {
      // 尝试 fetch（可能尚未缓存）
      try {
        guild = await client.guilds.fetch(config.discordGuildId);
      } catch {
        console.error(`❌ 找不到目标服务器（Guild ID: ${config.discordGuildId}）`);
        console.error("   请确认 BOT 已加入该服务器，且 Guild ID 正确。");
        await client.destroy();
        return { success: false, code: 1 };
      }
    }

    console.log(`目标服务器：${guild.name}（${guild.id}）`);

    // ---- 5. 获取 Emoji 列表 ----
    console.log("正在获取 Emoji 列表...");
    let emojis;
    try {
      emojis = await guild.emojis.fetch();
    } catch (err) {
      console.error(`❌ 获取 Emoji 列表失败：${safeErrorSummary(err)}`);
      await client.destroy();
      return { success: false, code: 1 };
    }

    const total = emojis.size;
    console.log(`发现 ${total} 个自定义 Emoji\n`);

    if (total === 0) {
      console.log("服务器无自定义 Emoji，无需导出。");
      // 仍生成空 manifest
      const manifest = buildManifest(guild.id, []);
      ensureDir(OUTPUT_DIR);
      const { writeFileSync } = await import("fs");
      writeFileSync(resolve(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
      await client.destroy();
      return { success: true, code: 0 };
    }

    // ---- 6. 准备输出目录 ----
    ensureDir(EMOJIS_DIR);

    // ---- 7. 逐个下载 ----
    const records = [];
    let completed = 0;

    for (const [, emoji] of emojis) {
      completed++;
      const record = extractEmojiRecord(emoji);
      const filename = buildEmojiFileName(emoji);
      const url = buildCdnUrl(emoji.id, emoji.animated);
      const filePath = resolve(EMOJIS_DIR, filename);

      try {
        await downloadFile(url, filePath);
        record.filename = filename;
        record.downloaded = true;
        record.error = null;
        console.log(`  [${completed}/${total}] ✅ ${emoji.name ?? "(unnamed)"}`);
      } catch (err) {
        record.filename = filename;
        record.downloaded = false;
        record.error = safeErrorSummary(err);
        console.error(`  [${completed}/${total}] ❌ ${emoji.name ?? "(unnamed)"} — ${record.error}`);
      }

      records.push(record);
    }

    // ---- 8. 生成 manifest ----
    const manifest = buildManifest(guild.id, records);
    const { writeFileSync } = await import("fs");
    writeFileSync(resolve(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

    // ---- 9. 输出统计 ----
    console.log("\n导出完成");
    console.log(`  成功：${manifest.successCount}`);
    console.log(`  失败：${manifest.failedCount}`);
    console.log(`  目录：${OUTPUT_DIR}`);

    await client.destroy();
    return { success: manifest.failedCount === 0, code: 0 };
  } catch (err) {
    console.error(`❌ 导出过程发生未预期错误：${safeErrorSummary(err)}`);
    try {
      await client.destroy();
    } catch {
      // 忽略关闭时的错误
    }
    return { success: false, code: 1 };
  }
}

// =========================================================================
// CLI 入口
// =========================================================================

// 仅当直接运行本脚本时执行主流程（import 时跳过）
const runningDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (runningDirectly) {
  const config = loadConfig();
  const result = await exportGuildEmojis(config);
  process.exit(result.code ?? 0);
}
