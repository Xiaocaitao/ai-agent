import { fileURLToPath } from "node:url";

// 入口文件：仅负责启动 CLI 主循环
import { runCli } from "./cli.ts";

const isMainModule = import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli().catch((error) => {
    console.error(
      `配置错误: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
