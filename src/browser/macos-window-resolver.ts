import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RESOLVE_EXACT_WINDOW_SWIFT = String.raw`
import Foundation
import CoreGraphics

let pid = pid_t(CommandLine.arguments.dropFirst().first.flatMap(Int32.init) ?? 0)
guard pid > 0 else { exit(2) }
let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let ids = rows.compactMap { info -> UInt32? in
  guard let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
        owner.int32Value == pid,
        let layer = info[kCGWindowLayer as String] as? NSNumber,
        layer.intValue == 0,
        let number = info[kCGWindowNumber as String] as? NSNumber,
        number.uint32Value > 0,
        let bounds = info[kCGWindowBounds as String] as? [String: Any],
        let width = bounds["Width"] as? NSNumber,
        let height = bounds["Height"] as? NSNumber,
        width.doubleValue >= 160,
        height.doubleValue >= 120 else { return nil }
  return number.uint32Value
}
let unique = Array(Set(ids)).sorted()
if unique.count == 1 { print(unique[0]); exit(0) }
fputs("eligible_window_count=\(unique.count)\n", stderr)
exit(3)
`;

export function parseExactMacOSWindowId(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d{1,10}$/.test(trimmed)) return undefined;
  const windowId = Number(trimmed);
  return Number.isSafeInteger(windowId) && windowId > 0 && windowId <= 0xffff_ffff ? windowId : undefined;
}

/** Resolve exactly one visible layer-0 macOS window owned by the dedicated Chrome process. */
export async function resolveExactMacOSWindowId(processId: number): Promise<number> {
  if (process.platform !== "darwin") throw new Error("macOS exact-window resolution is unavailable on this platform");
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error("Cinema Handoff requires a positive Chrome process id");
  try {
    const { stdout } = await execFileAsync("/usr/bin/xcrun", ["swift", "-e", RESOLVE_EXACT_WINDOW_SWIFT, String(processId)], {
      timeout: 8_000,
      maxBuffer: 4_096,
      encoding: "utf8"
    });
    const windowId = parseExactMacOSWindowId(stdout);
    if (!windowId) throw new Error("resolver returned an invalid window id");
    return windowId;
  } catch {
    throw new Error("Cinema Handoff could not resolve exactly one visible layer-0 window for the dedicated Chrome process");
  }
}
