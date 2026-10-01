import { transcriptOptedOutAt, transcriptSeatAt } from "./sessionRules.js";

const SHANGHAI = "Asia/Shanghai";
const USER_MESSAGE = 0;
const REPLY_MESSAGE = 19;
const INCLUDED_TYPES = new Set([USER_MESSAGE, REPLY_MESSAGE]);

export const TRANSCRIPT_FAILED_NOTICE = "本局团录没有发出。";
export const TRANSCRIPT_INCOMPLETE_NOTICE = "本局团录没有完整发出。";
export const TRANSCRIPT_TRUNCATED_NOTICE = "⚠️ 本局消息量超过团录安全上限，本次团录只包含最近 20000 条频道消息。";
export const TRANSCRIPT_HISTORY_PAGE_SIZE = 100;
export const TRANSCRIPT_HISTORY_HARD_LIMIT = 20000;
export const TRANSCRIPT_PART_MESSAGE_LIMIT = 2000;

/**
 * @param {number} timestamp
 * @returns {string|null}
 */
export function formatTranscriptClock(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SHANGHAI,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (!hour || !minute) return null;
  return `${hour}:${minute}`;
}

export function transcriptFileName(title, { part = null, parts = 1 } = {}) {
  const cleaned = String(title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  const base = `${cleaned || "本局"}团录`;
  if (parts > 1 && part != null) return `${base}-${String(part).padStart(2, "0")}.md`;
  return `${base}.md`;
}

function slimHistoryMessage(message) {
  return {
    id: message.id,
    authorId: message.authorId ?? message.author?.id ?? "",
    bot: message.bot === true || Boolean(message.author?.bot) || message.system === true,
    content: typeof message.content === "string" ? message.content : "",
    createdTimestamp: message.createdTimestamp,
    type: message.type,
  };
}

/**
 * 从新到旧翻页。正常停在 startedAt；20000 只挡住翻页停不下来。
 * @param {(query: { limit: number, before?: string }) => Promise<object[]>} fetchPage
 */
export async function collectTranscriptHistory(fetchPage, {
  startedAt = null,
  hardLimit = TRANSCRIPT_HISTORY_HARD_LIMIT,
  pageSize = TRANSCRIPT_HISTORY_PAGE_SIZE,
} = {}) {
  const messages = [];
  let before;
  let truncated = false;
  let scanned = 0;
  while (scanned < hardLimit) {
    const limit = Math.min(pageSize, hardLimit - scanned);
    const batch = await fetchPage({ limit, before });
    const rows = [...(batch ?? [])].filter((message) => message?.id);
    rows.sort((left, right) => (
      left.createdTimestamp - right.createdTimestamp || String(left.id).localeCompare(String(right.id))
    ));
    if (!rows.length) break;
    let reachedStart = false;
    for (const message of [...rows].reverse()) {
      if (scanned >= hardLimit) break;
      scanned += 1;
      if (startedAt != null && message.createdTimestamp < startedAt) {
        reachedStart = true;
        break;
      }
      messages.push(slimHistoryMessage(message));
    }
    const oldest = rows[0]?.id;
    if (!oldest || oldest === before) break;
    before = oldest;
    if (reachedStart) break;
    if (rows.length < limit) break;
    if (scanned >= hardLimit) {
      truncated = true;
      break;
    }
  }
  messages.sort((left, right) => (
    left.createdTimestamp - right.createdTimestamp || String(left.id).localeCompare(String(right.id))
  ));
  return { messages, truncated };
}

function speakerFor(session, authorId, timestamp) {
  if (transcriptOptedOutAt(session, authorId, timestamp)) return null;
  const seat = transcriptSeatAt(session, authorId, timestamp);
  if (!seat) return null;
  if (seat.role === "kp") return "KP";
  return seat.name || "PL";
}

/**
 * 按消息发送时的 KP / PL 身份和时间段过滤。不改消息原文，也不保存原文。
 * @param {object} session
 * @param {object[]} messages
 * @param {string|null} botUserId
 */
export function selectTranscriptMessages(session, messages, botUserId) {
  const seen = new Set();
  const entries = [];
  for (const message of messages ?? []) {
    if (!message) continue;
    if (!message.id || seen.has(message.id)) continue;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    const ownDice = botUserId && message.authorId === botUserId
      ? /^\*\*<@(\d+)> 祝骰运昌隆喵~！\*\*\n🎲 \d+d\d+(?:[+-]\d+)?(?: (?:奖励|惩罚)[12])? (?:=|→) [^\n]+/i.exec(content) : null;
    if ((message.bot || message.authorId === botUserId) && !ownDice) continue;
    if (message.type != null && !INCLUDED_TYPES.has(message.type) && !(ownDice && message.type === 20)) continue;
    if (session?.startedAt != null && message.createdTimestamp < session.startedAt) continue;
    const time = formatTranscriptClock(message.createdTimestamp);
    if (!time) continue;
    const speaker = speakerFor(session, ownDice ? ownDice[1] : message.authorId, message.createdTimestamp);
    if (!speaker) continue;
    if (!content) continue;
    seen.add(message.id);
    entries.push({
      id: message.id,
      speaker: ownDice ? "小G宝" : speaker,
      content: content.replace(/<@!?(\d+)>/g, (mention, userId) => {
        const seat = transcriptSeatAt(session, userId, message.createdTimestamp);
        return seat ? (seat.role === "kp" ? "KP" : seat.name || "PL") : mention;
      }),
      time,
      createdTimestamp: message.createdTimestamp,
    });
  }
  entries.sort((left, right) => (
    left.createdTimestamp - right.createdTimestamp || String(left.id).localeCompare(String(right.id))
  ));
  return entries;
}

export function renderTranscriptMarkdown(title, entries, { truncated = false } = {}) {
  const lines = [`# 《${title}》团录`, ""];
  if (truncated) {
    lines.push(TRANSCRIPT_TRUNCATED_NOTICE, "");
  }
  if (!entries.length) {
    lines.push("（本局没有记入团录的发言。）");
    return `${lines.join("\n")}\n`;
  }
  for (const entry of entries) {
    lines.push(`[${entry.time}] ${entry.speaker}：`, entry.content, "");
  }
  return `${lines.join("\n").replace(/\n$/, "")}\n`;
}

function chunkEntries(entries, partLimit) {
  if (!entries.length) return [[]];
  const chunks = [];
  for (let index = 0; index < entries.length; index += partLimit) {
    chunks.push(entries.slice(index, index + partLimit));
  }
  return chunks;
}

export function buildTranscriptFiles(session, messages, {
  botUserId = null,
  truncated = false,
  partLimit = TRANSCRIPT_PART_MESSAGE_LIMIT,
} = {}) {
  const entries = selectTranscriptMessages(session, messages, botUserId);
  const chunks = chunkEntries(entries, partLimit);
  const files = chunks.map((chunk, index) => ({
    name: transcriptFileName(session.title, { part: index + 1, parts: chunks.length }),
    markdown: renderTranscriptMarkdown(session.title, chunk, { truncated: truncated && index === 0 }),
  }));
  return { files, truncated };
}

export function buildTranscriptFile(session, messages, options = {}) {
  return buildTranscriptFiles(session, messages, options).files[0];
}
