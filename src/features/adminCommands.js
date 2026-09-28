/**
 * 全部管理员 Guild 命令统一注册表。
 */

import { adminCommandDefinitions as manualAdminCommands } from "./manualMessage/commands.js";
import { forumBumpAdminCommandDefinitions } from "./forumBump/admin/commands.js";
import { cocCommandDefinitions } from "./coc/commands.js";

/** 当前全部 Guild 命令。一次 PUT 必须带上管理员命令和 CoC 命令。 */
export const allAdminCommandDefinitions = Object.freeze([
  ...manualAdminCommands,
  ...forumBumpAdminCommandDefinitions,
  ...cocCommandDefinitions,
]);

export function getAllAdminCommandDefinitions() {
  return allAdminCommandDefinitions.map((d) => ({ ...d }));
}
