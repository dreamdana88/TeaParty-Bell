/**
 * 配置错误类型，携带建议退出码。
 */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} [exitCode=1]
   */
  constructor(message, code, exitCode = 1) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
