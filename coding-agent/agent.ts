// 入口文件：仅负责启动 CLI 主循环
import { runCli } from "./cli.ts";

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(
      `配置错误: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
