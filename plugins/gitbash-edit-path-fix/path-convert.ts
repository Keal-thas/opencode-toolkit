// Pure path helpers for gitbash-edit-path-fix. Kept in a separate module so the
// plugin entry file exports only the plugin itself: opencode 1.19.x calls every
// exported function of a plugin module as a plugin factory, so an exported
// helper here would be invoked with no arguments and break plugin loading.

const PATCH_HEADERS = ["*** Add File:", "*** Delete File:", "*** Update File:", "*** Move to:"];

/**
 * Converts a Git-Bash/MSYS/Cygwin/WSL-style drive-rooted absolute path into a
 * real Windows path, e.g. "/c/Users/x" -> "C:/Users/x". Returns undefined when
 * `value` doesn't match any of the recognized forms (including when it's
 * already an ordinary Windows or POSIX path) - the caller treats that as "leave
 * it alone".
 *
 * Mirrors anomalyco/opencode's packages/core/src/fs-util.ts `windowsPath()`
 * exactly: same four patterns, same order (order matters - each pattern's
 * anchoring keeps them mutually exclusive, so "/cygdrive/c/..." can't be
 * mis-caught by the plainer "/c/..." pattern).
 */
export function toWindowsPath(value: string): string | undefined {
  const converted = value
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`);
  return converted === value ? undefined : converted;
}

/**
 * Rewrites the file-path headers of an apply_patch patch text, returning the
 * text unchanged when none of them need converting. Only the header line's
 * path is touched; hunk content is left byte-for-byte intact.
 */
export function rewritePatchText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      for (const header of PATCH_HEADERS) {
        if (!line.startsWith(header)) continue;
        const raw = line.slice(header.length).trim();
        const converted = toWindowsPath(raw);
        if (converted === undefined) return line;
        return `${header} ${converted}`;
      }
      return line;
    })
    .join("\n");
}
