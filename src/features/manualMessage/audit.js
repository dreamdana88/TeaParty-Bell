/**
 * Manual Message 结构化审计。
 *
 * 只记录允许的元数据，不记录正文、allowedMentions、Token 或完整错误对象。
 * logger 失败不会向上抛出，避免把“消息已发送”伪装成“发送失败”。
 */

import { logger as defaultLogger } from "../../utils/logger.js";

export const MANUAL_MESSAGE_AUDIT_EVENT = "[ManualMessageAudit]";

function actorField(actor, field) {
  return actor && typeof actor[field] === "string" ? actor[field] : null;
}

export function buildManualMessageAuditRecord(entry = {}, now = new Date()) {
  return {
    timestamp: now.toISOString(),
    action: entry.action ?? null,
    source: entry.source ?? null,
    actorId: actorField(entry.actor, "id") ?? entry.actorId ?? null,
    actorUsername: actorField(entry.actor, "username") ?? entry.actorUsername ?? null,
    actorDisplayName: actorField(entry.actor, "displayName") ?? entry.actorDisplayName ?? null,
    guildId: entry.guildId ?? null,
    channelId: entry.channelId ?? null,
    targetMessageId: entry.targetMessageId ?? null,
    sentMessageId: entry.sentMessageId ?? null,
    contentLength: Number.isInteger(entry.contentLength) ? entry.contentLength : null,
    success: entry.success === true,
    errorCode: entry.errorCode ?? null,
  };
}

export function createManualMessageAudit({ logger = defaultLogger } = {}) {
  function record(entry = {}) {
    const auditRecord = buildManualMessageAuditRecord(entry);
    try {
      logger?.info?.(MANUAL_MESSAGE_AUDIT_EVENT, auditRecord);
      return { written: true, record: auditRecord };
    } catch (error) {
      // 审计写入失败必须可观察，但不能改变业务发送结果。
      try {
        logger?.error?.("[ManualMessageAudit] 审计写入失败", {
          message: error?.message ?? String(error),
        });
      } catch {
        // logger 本身不可用时，保持原业务结果；不得再次抛出。
      }
      return { written: false, record: auditRecord, error };
    }
  }

  return { record };
}
