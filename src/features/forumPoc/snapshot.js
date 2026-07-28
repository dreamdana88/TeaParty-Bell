/**
 * Forum Thread 安全快照与空白客户端观察字段。
 *
 * 只序列化白名单字段，不输出完整 Channel / Message 对象。
 */

/**
 * 用户手工记录的客户端观察提示（程序不填充真实 UI 排序结论）。
 * @returns {object}
 */
export function blankClientObservations() {
  return {
    observedSortPositionBefore: null,
    observedSortPositionAfter: null,
    unreadObserved: null,
    notificationObserved: null,
    visibleArtifactObserved: null,
  };
}

/**
 * @param {object|null|undefined} thread
 * @param {object|null|undefined} parentForum
 * @param {{ now: () => number }} clock
 * @returns {object}
 */
export function captureThreadSnapshot(thread, parentForum, clock) {
  const now = typeof clock?.now === "function" ? clock.now() : Date.now();
  return {
    timestamp: new Date(now).toISOString(),
    guildId: thread?.guildId ?? thread?.guild?.id ?? null,
    forumChannelId: parentForum?.id ?? thread?.parentId ?? null,
    threadId: thread?.id ?? null,
    threadType: thread?.type ?? null,
    threadName: typeof thread?.name === "string" ? thread.name : null,
    archived: thread?.archived ?? null,
    locked: thread?.locked ?? null,
    autoArchiveDuration: thread?.autoArchiveDuration ?? null,
    archiveTimestamp: thread?.archiveTimestamp ?? null,
    lastMessageId: thread?.lastMessageId ?? null,
    messageCount: thread?.messageCount ?? null,
    totalMessageSent: thread?.totalMessageSent ?? null,
    appliedTagIds: Array.isArray(thread?.appliedTags) ? [...thread.appliedTags] : [],
    defaultSortOrder: parentForum?.defaultSortOrder ?? null,
  };
}
