/**
 * 全部管理员 Guild 命令统一注册表。
 */

import { adminCommandDefinitions as manualAdminCommands } from "./manualMessage/commands.js";
import { forumBumpAdminCommandDefinitions } from "./forumBump/admin/commands.js";

/** 当前全部管理员命令（顺序：人工消息 → Forum 顶帖） */
export const allAdminCommandDefinitions = Object.freeze([
  ...manualAdminCommands,
  ...forumBumpAdminCommandDefinitions,
]);

export function getAllAdminCommandDefinitions() {
  return allAdminCommandDefinitions.map((d) => ({ ...d }));
}
