/**
 * 业务时区时间工具（纯函数，不依赖系统本地时区）。
 */

import { parseHhMm } from "./schedulerConfig.js";

/**
 * @param {number} nowMs
 * @param {string} timezone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function getLocalTimeParts(nowMs, timezone) {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs 必须为有限数字");
  }
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(nowMs));
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * @param {number} nowMs
 * @param {string} timezone
 * @returns {string} YYYY-MM-DD
 */
export function getLocalDate(nowMs, timezone) {
  const p = getLocalTimeParts(nowMs, timezone);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

/**
 * @param {number} nowMs
 * @param {string} timezone
 * @param {string} activeStart HH:mm
 * @param {string} activeEnd HH:mm
 */
export function isInsideActiveWindow(nowMs, timezone, activeStart, activeEnd) {
  const start = parseHhMm(activeStart);
  const end = parseHhMm(activeEnd);
  if (!start || !end) return false;
  const p = getLocalTimeParts(nowMs, timezone);
  const nowMin = p.hour * 60 + p.minute;
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  return nowMin >= startMin && nowMin < endMin;
}

/**
 * 将业务时区某天 HH:mm 转为 UTC 毫秒（二分搜索）。
 * @param {string} localDate YYYY-MM-DD
 * @param {string} hhmm
 * @param {string} timezone
 */
export function zonedLocalDateTimeToUtcMs(localDate, hhmm, timezone) {
  const [y, m, d] = localDate.split("-").map(Number);
  const tm = parseHhMm(hhmm);
  if (!tm) throw new TypeError("非法 HH:mm");

  // 近似：以 UTC 同日历日为中心搜索
  let lo = Date.UTC(y, m - 1, d - 1, 0, 0, 0) - 36 * 3600_000;
  let hi = Date.UTC(y, m - 1, d + 1, 0, 0, 0) + 36 * 3600_000;
  let found = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const p = getLocalTimeParts(mid, timezone);
    const cmpDate = p.year * 10_000 + p.month * 100 + p.day;
    const targetDate = y * 10_000 + m * 100 + d;
    const cmpMin = p.hour * 60 + p.minute;
    const targetMin = tm.hour * 60 + tm.minute;

    if (cmpDate < targetDate || (cmpDate === targetDate && cmpMin < targetMin)) {
      lo = mid + 1;
    } else if (cmpDate > targetDate || (cmpDate === targetDate && cmpMin > targetMin)) {
      hi = mid - 1;
    } else {
      // 同一分钟内找 second=0 的起点
      found = mid - p.second * 1000;
      break;
    }
  }

  if (found == null) {
    // 线性微调：从 lo 附近扫描一分钟
    for (let t = lo - 120_000; t <= lo + 120_000; t += 1000) {
      const p = getLocalTimeParts(t, timezone);
      if (
        p.year === y && p.month === m && p.day === d
        && p.hour === tm.hour && p.minute === tm.minute && p.second === 0
      ) {
        return t;
      }
    }
    throw new Error("无法解析业务时区时间");
  }

  // 对齐到该分钟 0 秒
  for (let t = found - 2000; t <= found + 2000; t += 1) {
    const p = getLocalTimeParts(t, timezone);
    if (
      p.year === y && p.month === m && p.day === d
      && p.hour === tm.hour && p.minute === tm.minute && p.second === 0
    ) {
      return t;
    }
  }
  return found;
}

/**
 * 下一次窗口起点（若已在窗口内则返回当前时间）。
 * @param {number} nowMs
 * @param {string} timezone
 * @param {string} activeStart
 * @param {string} activeEnd
 */
export function getNextWindowStart(nowMs, timezone, activeStart, activeEnd) {
  if (isInsideActiveWindow(nowMs, timezone, activeStart, activeEnd)) {
    return nowMs;
  }
  const p = getLocalTimeParts(nowMs, timezone);
  const start = parseHhMm(activeStart);
  const end = parseHhMm(activeEnd);
  const nowMin = p.hour * 60 + p.minute;
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  const today = `${p.year}-${mm}-${dd}`;

  if (nowMin < startMin) {
    return zonedLocalDateTimeToUtcMs(today, activeStart, timezone);
  }
  // 窗口已过：下一天
  const tomorrowUtcGuess = nowMs + 24 * 3600_000;
  const tp = getLocalTimeParts(tomorrowUtcGuess, timezone);
  // 更稳：从今天 12:00 起加一天
  const noon = zonedLocalDateTimeToUtcMs(today, "12:00", timezone);
  const nextDayParts = getLocalTimeParts(noon + 24 * 3600_000, timezone);
  const tmm = String(nextDayParts.month).padStart(2, "0");
  const tdd = String(nextDayParts.day).padStart(2, "0");
  const nextDate = `${nextDayParts.year}-${tmm}-${tdd}`;
  return zonedLocalDateTimeToUtcMs(nextDate, activeStart, timezone);
}

/**
 * 下一业务日 activeStart。
 */
export function getNextBusinessDayWindowStart(nowMs, timezone, activeStart) {
  const p = getLocalTimeParts(nowMs, timezone);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  const today = `${p.year}-${mm}-${dd}`;
  const noon = zonedLocalDateTimeToUtcMs(today, "12:00", timezone);
  const next = getLocalTimeParts(noon + 24 * 3600_000, timezone);
  const tmm = String(next.month).padStart(2, "0");
  const tdd = String(next.day).padStart(2, "0");
  return zonedLocalDateTimeToUtcMs(`${next.year}-${tmm}-${tdd}`, activeStart, timezone);
}

/**
 * 将候选时间钳到合法执行窗口起点（若在窗外）。
 */
export function clampToActiveWindow(targetMs, timezone, activeStart, activeEnd) {
  if (isInsideActiveWindow(targetMs, timezone, activeStart, activeEnd)) {
    return targetMs;
  }
  return getNextWindowStart(targetMs, timezone, activeStart, activeEnd);
}

/**
 * ISO UTC 毫秒 → 标准 UTC ISO 字符串。
 */
export function toUtcIso(ms) {
  return new Date(ms).toISOString();
}
