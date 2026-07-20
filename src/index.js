import { start } from "./core/bot.js";

// ============================================================
// TeaParty-Bell 入口文件
//
// 启动 BOT 并从 bot.js 导入完整生命周期管理。
// 此处只负责调用 start()，不做任何业务逻辑。
// ============================================================

try {
  await start();
} catch (err) {
  console.error("BOT 启动失败", err);
  process.exit(1);
}
