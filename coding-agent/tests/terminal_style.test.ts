import assert from "node:assert/strict";
import test from "node:test";

import * as terminalStyle from "../terminal_style.ts";
import {
  styleDiff,
  styleText,
  terminalColorsEnabled,
} from "../terminal_style.ts";

const ANSI_PATTERN = /\x1b\[[0-9;]+m/g;

test("styleText 使用不同的 RGB 表达不同语义", () => {
  const action = styleText("Action", "action", true);
  const error = styleText("Error", "error", true);

  assert.match(action, /\x1b\[38;2;\d+;\d+;\d+m/);
  assert.match(error, /\x1b\[38;2;\d+;\d+;\d+m/);
  assert.notEqual(action.match(ANSI_PATTERN)?.[0], error.match(ANSI_PATTERN)?.[0]);
  assert.equal(action.replaceAll(ANSI_PATTERN, ""), "Action");
  assert.equal(error.replaceAll(ANSI_PATTERN, ""), "Error");
});

test("styleText 关闭颜色时返回原始文本", () => {
  assert.equal(styleText("plain", "success", false), "plain");
});

test("styleDiff 分别着色删除、增加和定位行", () => {
  const styled = styleDiff(
    "@@ -1,1 +1,1 @@\n-old\n+new\n unchanged\n",
    true,
  );

  const [hunk, removed, added, unchanged] = styled.split("\n");
  assert.match(hunk, /\x1b\[38;2;/);
  assert.match(removed, /\x1b\[38;2;/);
  assert.match(added, /\x1b\[38;2;/);
  assert.notEqual(removed.match(ANSI_PATTERN)?.[0], added.match(ANSI_PATTERN)?.[0]);
  assert.equal(unchanged, " unchanged");
  assert.equal(styled.replaceAll(ANSI_PATTERN, ""), "@@ -1,1 +1,1 @@\n-old\n+new\n unchanged\n");
});

test("terminalColorsEnabled 只在 TTY 且未设置 NO_COLOR 时启用", () => {
  assert.equal(terminalColorsEnabled({ isTTY: true }, {}), true);
  assert.equal(terminalColorsEnabled({ isTTY: false }, {}), false);
  assert.equal(terminalColorsEnabled({ isTTY: true }, { NO_COLOR: "" }), false);
});

test("Runtime 输出按调试、Action 和 Observation 分类着色", () => {
  const styleRuntimeLine = (terminalStyle as Record<string, unknown>)
    .styleRuntimeLine;
  assert.equal(typeof styleRuntimeLine, "function");
  if (typeof styleRuntimeLine !== "function") return;

  const debug = String(styleRuntimeLine("[Step 1/10] → 请求模型", true));
  const action = String(styleRuntimeLine("  [Tool 1/1] Action: read_file({})", true));
  const observation = String(styleRuntimeLine("  [Tool 1/1] Observation: ok", true));

  assert.notEqual(debug.match(ANSI_PATTERN)?.[0], action.match(ANSI_PATTERN)?.[0]);
  assert.notEqual(action.match(ANSI_PATTERN)?.[0], observation.match(ANSI_PATTERN)?.[0]);
  assert.equal(debug.replaceAll(ANSI_PATTERN, ""), "[Step 1/10] → 请求模型");
  assert.equal(styleRuntimeLine("plain", false), "plain");
});
