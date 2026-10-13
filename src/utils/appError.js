/**
 * 统一的业务错误类型。
 *
 * code：机器可读错误码；safeMessage：可对外展示的安全文案；
 * cause：仅供内部诊断，不得直接写入对外回复或审计；context：可选的结构化上下文。
 */
export class AppError extends Error {
  /**
   * @param {string} code
   * @param {string} safeMessage
   * @param {unknown} [cause]
   * @param {object|null} [context]
   */
  constructor(code, safeMessage, cause, context = null) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "AppError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.cause = cause;
    this.context = context && typeof context === "object" ? { ...context } : null;
  }
}

/**
 * 定义一类「code → safeMessage 表」驱动的错误。
 * 返回的子类保留各自的 name，便于日志与 instanceof 区分。
 *
 * @param {string} name
 * @param {Readonly<Record<string, string>>} messages
 * @param {string} fallback 未知 code 时的文案
 */
export function defineAppError(name, messages, fallback) {
  const ErrorClass = {
    [name]: class extends AppError {
      constructor(code, safeMessage = messages[code] ?? fallback, cause, context = null) {
        super(code, safeMessage, cause, context);
        this.name = name;
      }
    },
  }[name];
  return {
    ErrorClass,
    create: (code, cause, context = null) => new ErrorClass(code, messages[code], cause, context),
    is: (error) => error instanceof ErrorClass,
    getSafeMessage: (code) => messages[code] ?? fallback,
  };
}
