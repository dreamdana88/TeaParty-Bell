/**
 * 管理员手动消息的 Mention 策略。
 *
 * 仅用于 /小g宝发言 与 /小G宝回复；AI 自动消息不使用本模块。
 */
import { ManualMessageError } from "./errors.js";

const ROLE_MENTION_PATTERN = /<@&([^>]+)>/g;
const ROLE_ID_PATTERN = /^\d+$/;
const UNKNOWN_ROLE_CODE = 10011;

export function extractRoleMentionIds(content) {
  const ids = [];
  const seen = new Set();
  const pattern = new RegExp(ROLE_MENTION_PATTERN.source, "g");
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function buildManualAllowedMentions() {
  return {
    parse: ["users", "roles", "everyone"],
    // 保持原有回复目标不因 Reply 本身被额外 ping；正文中的 <@用户ID> 仍正常解析。
    repliedUser: false,
  };
}

/**
 * 验证正文中的全部 Role Mention。任一项无效即拒绝，绝不部分发送。
 *
 * @param {string} content
 * @param {{ guild?: object|null, guildId: string }} context
 * @returns {Promise<{roleMentionIds: string[], allowedMentions: object}>}
 */
export async function validateManualMentions(content, { guild, guildId } = {}) {
  const roleMentionIds = extractRoleMentionIds(content);
  for (const roleId of roleMentionIds) {
    if (!ROLE_ID_PATTERN.test(roleId)) {
      throw new ManualMessageError(
        "INVALID_ROLE_MENTION",
        "发送失败：身份组 ID 格式错误。请检查身份组 ID 后重新发送。",
      );
    }
  }

  if (roleMentionIds.length > 0) {
    if (!guild || guild.id !== guildId || !guild.roles) {
      throw new ManualMessageError(
        "ROLE_VALIDATION_FAILED",
        "发送失败：无法验证身份组，请稍后重试。",
      );
    }
    for (const roleId of roleMentionIds) {
      const role = await fetchRole(guild.roles, roleId);
      if (!role || getRoleGuildId(role) !== guildId) {
        throw roleNotFoundError(roleId);
      }
    }
  }

  return { roleMentionIds, allowedMentions: buildManualAllowedMentions() };
}

async function fetchRole(roleManager, roleId) {
  try {
    if (typeof roleManager.fetch === "function") {
      // 强制绕过本地缓存，避免已删除角色因缓存残留而被错误放行。
      return await roleManager.fetch(roleId, { force: true });
    }
    return roleManager.cache?.get?.(roleId) ?? null;
  } catch (error) {
    if (error?.code === UNKNOWN_ROLE_CODE) return null;
    throw new ManualMessageError(
      "ROLE_VALIDATION_FAILED",
      "发送失败：无法验证身份组，请稍后重试。",
    );
  }
}

function getRoleGuildId(role) {
  return role?.guild?.id ?? role?.guildId ?? null;
}

function roleNotFoundError(roleId) {
  return new ManualMessageError(
    "ROLE_NOT_FOUND",
    `发送失败：身份组 ${roleId} 不存在于当前服务器。请检查身份组 ID 后重新发送。`,
  );
}
