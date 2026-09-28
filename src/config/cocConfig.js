import { resolve } from "path";
import { isDiscordSnowflake } from "../features/forumBump/activityTime.js";

export const COC_MVP_STATE_PATH = "data/runtime/coc-mvp-sessions.json";

function enabledFlag(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { enabled: false, reason: "COC_ENABLED 未打开" };
  }
  const value = String(raw).trim().toLowerCase();
  if (value === "true" || value === "1") return { enabled: true, reason: null };
  if (value === "false" || value === "0") return { enabled: false, reason: "COC_ENABLED 未打开" };
  return { enabled: false, reason: "COC_ENABLED 不是 true/false" };
}

/**
 * 缺 ID 时关闭模块，不让整个 Bot 起不来。
 * 显式写成非法布尔或非法雪花，仍视为配置错误。
 */
export function loadCocConfig(env, { projectRoot }) {
  const flag = enabledFlag(env.COC_ENABLED);
  const statePath = resolve(projectRoot, env.COC_MVP_STATE_PATH?.trim() || COC_MVP_STATE_PATH);
  const ids = {
    categoryId: env.COC_CATEGORY_ID?.trim() ?? "",
    kpRoleId: env.COC_KP_ROLE_ID?.trim() ?? "",
    plRoleId: env.COC_PL_ROLE_ID?.trim() || env.COC_KL_ROLE_ID?.trim() || "",
    obRoleId: env.COC_OB_ROLE_ID?.trim() ?? "",
  };
  if (!flag.enabled) {
    return { enabled: false, statePath, ...ids, disabledReason: flag.reason };
  }
  for (const [field, value] of Object.entries(ids)) {
    if (!value || !isDiscordSnowflake(value)) {
      return {
        enabled: false,
        statePath,
        ...ids,
        disabledReason: value ? `${field} 不是合法的 Discord ID` : `${field} 未配置`,
      };
    }
  }
  return { enabled: true, statePath, ...ids, disabledReason: null };
}
