const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Discord 的成员搜索是「用户名或服务器昵称的开头」，不是全文包含。
 * 一串用户 ID 则直接精确查找。
 * @param {unknown} raw
 */
export function classifyMemberQuery(raw) {
  const query = typeof raw === "string" ? raw.trim() : "";
  if (!query) {
    return { ok: false, message: "请输入名字的开头，或粘贴 Discord 用户 ID。" };
  }
  if (SNOWFLAKE.test(query)) return { ok: true, kind: "id", query };
  if (query.length > 32) return { ok: false, message: "搜索词不能超过 32 个字。" };
  return { ok: true, kind: "prefix", query };
}

export function memberOptionLabel(member) {
  const name = member.nickname || member.globalName || member.username || member.userId;
  const handle = member.username ? ` (${member.username})` : "";
  return `${name}${handle}`.slice(0, 100);
}
