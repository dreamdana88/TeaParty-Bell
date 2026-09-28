/**
 * 只有当前昵称仍是小G宝改成功的角色名时才恢复。
 * original 为 null 表示她当时没有服务器昵称，恢复时清除。
 *
 * @param {{ originalNickname: string|null, appliedNickname: string|null, currentNickname: string|null }} input
 * @returns {{ action: "skip" }|{ action: "clear" }|{ action: "set", nickname: string }}
 */
export function planNicknameRestore(input) {
  const applied = input.appliedNickname ?? null;
  if (!applied) return { action: "skip" };
  if ((input.currentNickname ?? null) !== applied) return { action: "skip" };
  if (input.originalNickname == null || input.originalNickname === "") {
    return { action: "clear" };
  }
  return { action: "set", nickname: input.originalNickname };
}
