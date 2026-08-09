// 日志输出时省略这些大字段的原始内容，只显示长度。
export const OMITTED_LOG_FIELDS = new Set([
  "content",
  "stdin",
  "stdout",
  "stderr",
]);

function summarizeLogValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (OMITTED_LOG_FIELDS.has(key) && value.length > 0) {
      return `<省略 ${value.length} 字符>`;
    }
    return value.length > 200
      ? `${value.slice(0, 200)}…<共 ${value.length} 字符>`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => summarizeLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, item]) => [
        itemKey,
        summarizeLogValue(item, itemKey),
      ]),
    );
  }
  return value;
}

// 将工具调用的 JSON 参数转为可读的日志格式，大字段只显示长度。
export function summarizeLogJson(value: string): string {
  try {
    return JSON.stringify(summarizeLogValue(JSON.parse(value)));
  } catch {
    return value.length > 200
      ? `${value.slice(0, 200)}…<共 ${value.length} 字符>`
      : value;
  }
}

export function responseStatusSuffix(
  value: string | null | undefined,
): string {
  return value ? `，status=${value}` : "";
}
