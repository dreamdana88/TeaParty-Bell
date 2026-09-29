import { transcriptOptedOutAt, transcriptSeatAt } from "./sessionRules.js";

const SHANGHAI = "Asia/Shanghai";
const USER_MESSAGE = 0;
const REPLY_MESSAGE = 19;
const INCLUDED_TYPES = new Set([USER_MESSAGE, REPLY_MESSAGE]);

export const TRANSCRIPT_FAILED_NOTICE = "本局团录没有发出。";
export const TRANSCRIPT_HISTORY_LIMIT = 2000;

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

export function transcriptFileName(title) {
  const cleaned = String(title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return `${cleaned || "本局"}团录.md`;
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
    if (!message || message.bot) continue;
    if (!message.id || seen.has(message.id)) continue;
    if (botUserId && message.authorId === botUserId) continue;
    if (message.type != null && !INCLUDED_TYPES.has(message.type)) continue;
    const time = formatTranscriptClock(message.createdTimestamp);
    if (!time) continue;
    const speaker = speakerFor(session, message.authorId, message.createdTimestamp);
    if (!speaker) continue;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content) continue;
    seen.add(message.id);
    entries.push({
      id: message.id,
      speaker,
      content,
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
    lines.push("（频道里更早的消息超过本次整理上限，没有写入这份团录。）", "");
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

export function buildTranscriptFile(session, messages, { botUserId = null, truncated = false } = {}) {
  const entries = selectTranscriptMessages(session, messages, botUserId);
  return {
    name: transcriptFileName(session.title),
    markdown: renderTranscriptMarkdown(session.title, entries, { truncated }),
  };
}
