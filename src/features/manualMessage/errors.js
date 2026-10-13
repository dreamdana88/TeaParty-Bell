/**
 * Manual Message Service 的安全业务错误模型。
 *
 * safeMessage 只用于对外展示；cause 保留给内部诊断，不能直接写入审计。
 */
import { defineAppError } from "../../utils/appError.js";

export const MANUAL_MESSAGE_SOURCES = Object.freeze([
  "discord_slash",
  "discord_context_menu",
  "hermes",
]);

const SAFE_MESSAGES = Object.freeze({
  INVALID_SOURCE: "人工发言来源无效。",
  INVALID_ACTOR: "无法确认人工发言操作者身份。",
  WRONG_GUILD: "只能在目标服务器发言。",
  CHANNEL_NOT_FOUND: "目标频道不存在或无法访问。",
  CHANNEL_FETCH_FAILED: "获取目标频道失败。",
  WRONG_CHANNEL_TYPE: "目标频道不是可发送的文字频道。",
  TARGET_MESSAGE_NOT_FOUND: "目标消息不存在或无法访问。",
  TARGET_MESSAGE_FETCH_FAILED: "获取目标消息失败。",
  BOT_MISSING_PERMISSION: "小G宝缺少在目标频道发言所需的权限。",
  EMPTY_CONTENT: "发言内容不能为空。",
  CONTENT_TOO_LONG: "发言内容超过 2000 字符。",
  THREAD_LOCKED: "目标 Thread 已锁定，无法发言。",
  SEND_FAILED: "小G宝发送消息失败。",
  REPLY_FAILED: "小G宝回复消息失败。",
});

const kind = defineAppError("ManualMessageError", SAFE_MESSAGES, "人工发言失败。");

export const ManualMessageError = kind.ErrorClass;
export const isManualMessageError = kind.is;
export const createManualMessageError = kind.create;
export const getSafeMessage = kind.getSafeMessage;
