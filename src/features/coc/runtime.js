import { createCocDiscordGateway } from "./discordGateway.js";
import { createCocInteractionRouter } from "./interactionRouter.js";
import { createCocSessionService } from "./sessionService.js";
import { createCocSessionStore } from "./sessionStore.js";
import { attachTextDiceListener } from "./textDice.js";
import { createCharacterClient } from "./characterClient.js";

const RETRY_MS = 60 * 1000;

/**
 * CoC MVP 运行时。启动失败只关掉自己，不退出进程。
 */
export function createCocRuntime({
  client,
  config,
  logger = console,
  alertNotifier = null,
  projectRoot,
  store = null,
  discord = null,
  clock = { now: () => Date.now() },
  timers = { setTimeout, clearTimeout },
} = {}) {
  const coc = config?.coc;
  const testMode = config?.testMode === true;
  const configured = coc?.enabled === true;
  const enabled = configured && !testMode;
  const disabledReason = configured && testMode
    ? "测试模式不会创建跑团频道、修改昵称或删除频道。"
    : "CoC 跑团暂时没有开启。";
  const resolvedStore = store ?? (enabled
    ? createCocSessionStore({ filePath: coc.statePath })
    : null);
  const resolvedDiscord = discord ?? (client ? createCocDiscordGateway(client) : null);
  const service = createCocSessionService({
    store: resolvedStore ?? createMemoryStore(),
    discord: resolvedDiscord ?? {},
    config: enabled ? {
      enabled: true,
      guildId: config.discordGuildId,
      categoryId: coc.categoryId,
      kpRoleId: coc.kpRoleId,
      plRoleId: coc.plRoleId,
      obRoleId: coc.obRoleId,
      botUserId: null,
      messageContentEnabled: coc.messageContentEnabled === true,
      transcriptEnabled: coc.transcriptEnabled === true,
    } : { enabled: false, disabledReason },
    clock,
    logger,
    characters: createCharacterClient({ baseUrl: coc?.characterApiUrl, secret: coc?.internalApiSecret }),
  });
  const handles = new Map();
  let router = null;
  let detachTextDice = null;

  function arm(session) {
    if (!session || session.state !== "ENDED" || session.channelDeleted || session.deleteAt == null) return;
    const previous = handles.get(session.sessionId);
    if (previous) timers.clearTimeout(previous);
    const delay = Math.max(0, session.deleteAt - clock.now());
    const handle = timers.setTimeout(() => {
      handles.delete(session.sessionId);
      service.deleteIfDue(session.sessionId).then((result) => {
        if (!result?.ok) {
          const retry = timers.setTimeout(() => arm(service.find(session.sessionId)), RETRY_MS);
          handles.set(session.sessionId, retry);
        }
      }).catch((error) => {
        logger.warn?.("CoC 删除频道任务失败", { message: error?.message });
      });
    }, delay);
    handles.set(session.sessionId, handle);
  }

  router = createCocInteractionRouter({
    client,
    service,
    discord: resolvedDiscord,
    onSessionEnded: arm,
    logger,
    archiveUrl: coc?.archiveUrl,
  });

  async function warn(message) {
    logger.warn?.(message);
    try {
      await alertNotifier?.notifyWarning?.("coc_mvp_unavailable", message, {});
    } catch {
      // 告警失败不改变 CoC 降级结果。
    }
  }

  async function start() {
    router?.start();
    if (!enabled) {
      if (configured && testMode) {
        await warn("TEST_MODE=true，CoC 不执行真实 Discord 操作。真实冒烟请使用 Dev Bot、Dev Guild，并把 TEST_MODE 设为 false。");
      }
      return { enabled: false, blockedByTestMode: configured && testMode };
    }
    serviceConfigBot();
    const loaded = await resolvedStore.load();
    if (!loaded.ok) {
      service.markBroken();
      await warn("CoC 场次记录无法读取，跑团模块已关闭。");
      return { enabled: false, broken: true };
    }
    service.markReady();
    const recovered = await service.recoverInterrupted();
    for (const session of recovered.ended) arm(session);
    for (const session of service.dueSessions()) arm(session);
    if (coc.messageContentEnabled === true) {
      detachTextDice = attachTextDiceListener({ client, service, logger });
    }
    return { enabled: true };
  }

  function serviceConfigBot() {
    const botUserId = client?.user?.id ?? null;
    if (botUserId && service) {
      // confirmStart 读取的是构造时的 config。这里补上登录后的 bot id。
      service.setBotUserId?.(botUserId);
    }
  }

  function stop() {
    for (const handle of handles.values()) timers.clearTimeout(handle);
    handles.clear();
    detachTextDice?.();
    detachTextDice = null;
    router?.destroy();
  }

  return { start, stop, service, arm };
}

function createMemoryStore() {
  let memory = { version: 1, sessions: [] };
  return {
    async load() {
      return { ok: true, state: memory };
    },
    snapshot() {
      return structuredClone(memory);
    },
    async update(mutator) {
      const changed = mutator(structuredClone(memory));
      if (!changed || changed.errorCode) {
        return { ok: false, errorCode: changed?.errorCode ?? "REJECTED", message: changed?.message ?? "" };
      }
      memory = changed.state;
      return { ok: true, state: memory, result: changed.result ?? null };
    },
  };
}
