const MAX_CHANNEL_NAME = 100;

function cleanTitle(title) {
  return String(title).replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
}

function uniqueName(base, existingNames) {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()));
  const clipped = base.slice(0, MAX_CHANNEL_NAME);
  if (!taken.has(clipped.toLowerCase())) return clipped;
  let index = 2;
  while (index < 1000) {
    const suffix = `-${index}`;
    const candidate = `${clipped.slice(0, MAX_CHANNEL_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
    index += 1;
  }
  return `${clipped.slice(0, 80)}-${Date.now().toString(36)}`.slice(0, MAX_CHANNEL_NAME);
}

/**
 * @param {string} title
 * @param {string[]} existingNames
 * @returns {string[]}
 */
export function planChannelNames(title, existingNames = []) {
  const cleaned = cleanTitle(title).slice(0, 80);
  const preferred = uniqueName(`🎲COC・${cleaned}`, existingNames);
  const slug = cleaned
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "session";
  const fallback = uniqueName(`coc-${slug}`, [...existingNames, preferred]);
  return preferred === fallback ? [preferred] : [preferred, fallback];
}
