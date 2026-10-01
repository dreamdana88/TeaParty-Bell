function failure(message) { return { ok: false, message }; }

export function createCharacterClient({ baseUrl, secret, fetchImpl = globalThis.fetch } = {}) {
  async function get(path) {
    if (!secret || !baseUrl) return failure("档案馆内部接口尚未配置，请联系管理员。");
    let base;
    try {
      base = new URL(baseUrl);
      if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password
        || base.pathname !== "/" || base.search || base.hash) throw new Error();
    } catch { return failure("档案馆内部地址配置无效，请联系管理员。"); }
    try {
      const response = await fetchImpl(new URL(path, base), {
        method: "GET", headers: { Authorization: `Bearer ${secret}` },
        redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401) return failure("档案馆内部认证失败，请联系管理员检查配置。");
      if (response.status === 404) return failure("这张角色卡已不存在，请重新选择。");
      if (!response.ok) return failure("档案馆服务暂时不可用，请稍后重试。");
      const data = await response.json();
      if (data?.ok !== true) return failure("档案馆返回的数据异常，请联系管理员。");
      return data;
    } catch { return failure("档案馆服务暂时不可用或返回异常，请稍后重试。"); }
  }
  async function list(userId) {
    if (!/^\d+$/.test(userId)) return failure("Discord 用户身份无效。");
    const data = await get(`/internal/users/${encodeURIComponent(userId)}/characters`);
    if (!data.ok) return data;
    if (!Array.isArray(data.characters) || data.characters.some((card) => (
      !card || card.ownerDiscordUserId !== userId || typeof card.id !== "string" || !card.id || card.id.length > 100
      || typeof card.name !== "string" || typeof card.occupation !== "string" || typeof card.era !== "string"
    ))) return failure("档案馆角色列表异常，请联系管理员。");
    return data;
  }
  async function read(characterId, userId) {
    if (typeof characterId !== "string" || !characterId.trim()) return failure("角色卡 ID 无效。");
    const data = await get(`/internal/characters/${encodeURIComponent(characterId)}`);
    if (!data.ok) return data;
    const card = data.character;
    if (!card || card.id !== characterId || card.schemaVersion !== 1 || card.ruleset !== "coc7"
      || !card.identity || !card.characteristics || !card.occupation || !Array.isArray(card.skills)
      || !data.derived) return failure("档案馆角色数据异常，请联系管理员。");
    if (card.ownerDiscordUserId !== userId) return failure("只能选择属于你自己的角色卡。");
    if (card.skills.some((skill) => !skill || typeof skill.name !== "string"
      || ![skill.base, skill.growth, skill.occupationPoints, skill.interestPoints]
        .every((value) => Number.isInteger(value) && value >= 0))) {
      return failure("档案馆技能数据异常，请联系管理员。");
    }
    const initial = [data.derived.hp, card.initialSan, data.derived.mp, card.characteristics.luck];
    if (!initial.every((value) => Number.isInteger(value) && value >= 0)
      || card.initialSan > 99 || card.characteristics.luck > 90
      || typeof card.identity.name !== "string" || !card.identity.name.trim()
      || typeof card.occupation.name !== "string") {
      return failure("角色卡姓名或初始 HP、SAN、MP、Luck 不完整，请先到档案馆补齐；初始理智不会从意志补值。");
    }
    return { ok: true, snapshot: structuredClone({
      characterId: card.id, ownerDiscordUserId: card.ownerDiscordUserId,
      characterName: card.identity.name, occupation: card.occupation.name,
      initialHp: data.derived.hp, initialSan: card.initialSan,
      initialMp: data.derived.mp, initialLuck: card.characteristics.luck, skills: card.skills,
    }) };
  }
  return { list, read };
}
