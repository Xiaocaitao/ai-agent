type Rgb = readonly [red: number, green: number, blue: number];

export type TerminalTone =
  | "muted"
  | "action"
  | "observation"
  | "warning"
  | "error"
  | "success"
  | "heading";

const COLORS: Record<TerminalTone, Rgb> = {
  muted: [105, 115, 130],
  action: [85, 160, 230],
  observation: [135, 145, 160],
  warning: [235, 180, 70],
  error: [240, 90, 90],
  success: [90, 205, 125],
  heading: [70, 195, 210],
};

const RESET = "\x1b[0m";

export function terminalColorsEnabled(
  output: { isTTY?: boolean },
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return output.isTTY === true && !("NO_COLOR" in environment);
}

export function styleText(
  text: string,
  tone: TerminalTone,
  colorsEnabled: boolean,
): string {
  if (!colorsEnabled) return text;
  const [red, green, blue] = COLORS[tone];
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

export function styleDiff(diff: string, colorsEnabled: boolean): string {
  if (!colorsEnabled) return diff;
  return diff
    .split("\n")
    .map((line) => {
      if (
        line.startsWith("@@") ||
        line.startsWith("---") ||
        line.startsWith("+++") ||
        line.startsWith("===")
      ) {
        return styleText(line, "heading", true);
      }
      if (line.startsWith("-")) return styleText(line, "error", true);
      if (line.startsWith("+")) return styleText(line, "success", true);
      return line;
    })
    .join("\n");
}

export function styleRuntimeLine(
  line: string,
  colorsEnabled: boolean,
): string {
  if (line.includes("Action:")) {
    return styleText(line, "action", colorsEnabled);
  }
  if (line.includes("Observation:")) {
    return styleText(line, "observation", colorsEnabled);
  }
  if (line.startsWith("[Context]")) {
    return styleText(line, "warning", colorsEnabled);
  }
  return styleText(line, "muted", colorsEnabled);
}
