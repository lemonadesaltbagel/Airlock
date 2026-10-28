/** Lower-case and collapse whitespace so reformatting doesn't hide a copied fragment. */
export function normalizeForFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * Import and include lines (Python, JS/TS, Java/Kotlin, Go, Rust, C). They name libraries, not
 * project content, and project module names in them are caught by the identifier rule; indexed,
 * they made generic questions match crown-jewel files on lines like `from typing import Optional`.
 */
const IMPORT_LINE =
  /^[ \t]*(?:from[ \t]+[\w.]+[ \t]+import\b.*|import[ \t]+[\w.,* \t]+(?:as[ \t]+\w+)?;?|import\b.*\bfrom[ \t]*["'][^"']+["'];?|import[ \t]*["'][^"']+["'];?|(?:const|let|var)[ \t]+[\w{}, \t]+=[ \t]*require\(["'][^"']+["']\);?|#include[ \t]*[<"][^>"]+[>"]|use[ \t]+[\w:{}, \t*]+;|package[ \t]+[\w.]+;?)[ \t]*$/gm;

export function stripImportLines(text: string): string {
  return text.replace(IMPORT_LINE, "");
}

/** Language keywords and built-in type names: a window made only of these carries no content. */
const STRUCTURAL = new Set(
  (
    "self cls def class return if elif else for while in not and or is none true false null undefined pass break continue " +
    "try except finally raise with as lambda yield async await import from global nonlocal del assert " +
    "dict list str int float bool bytes tuple set frozenset object type any optional union callable iterable iterator sequence mapping " +
    "init new repr eq hash len range print super property staticmethod classmethod dataclass field typing " +
    "const let var function new this void string number boolean array promise export default interface extends implements public private protected static final"
  ).split(" "),
);

/** True for a window with no digits whose whole words are all structural (partial words at the edges are ignored). */
export function isStructuralWindow(window: string, before: string, after: string): boolean {
  if (/[0-9]/.test(window)) return false;
  const words = [...window.matchAll(/[a-z_][a-z0-9_]*/g)];
  const whole = words.filter((m) => {
    const start = m.index!;
    const end = start + m[0].length;
    const cutStart = start === 0 && /[a-z0-9_]/.test(before);
    const cutEnd = end === window.length && /[a-z0-9_]/.test(after);
    return !cutStart && !cutEnd;
  });
  if (whole.length === 0) return false;
  return whole.every((m) => STRUCTURAL.has(m[0].replace(/^_+|_+$/g, "")));
}

export interface FragmentMatch {
  fragment: string;
  source: string;
}

/**
 * Detects verbatim reuse of indexed text. Windows of `window` normalized characters are
 * indexed every `stride` characters, so any shared fragment of at least
 * `window + stride - 1` characters is guaranteed to contain an indexed window.
 * (Same scheme as pi-oracle-delegate's confidential-file fingerprints.)
 */
export class FragmentIndex {
  private readonly windows = new Map<string, string>();

  constructor(
    readonly window: number,
    readonly stride: number,
  ) {
    if (window < 8 || stride < 1 || stride > window) throw new Error("invalid fragment index parameters");
  }

  /** Shortest verbatim fragment guaranteed to be detected. */
  get guaranteedLength(): number {
    return this.window + this.stride - 1;
  }

  get size(): number {
    return this.windows.size;
  }

  add(text: string, source: string): void {
    const norm = normalizeForFingerprint(stripImportLines(text));
    for (let i = 0; i + this.window <= norm.length; i += this.stride) {
      const w = norm.slice(i, i + this.window);
      // Windows that are mostly whitespace or punctuation are boilerplate, not content.
      if ((w.match(/[a-z0-9]/g)?.length ?? 0) < this.window / 2) continue;
      if (isStructuralWindow(w, norm[i - 1] ?? "", norm[i + this.window] ?? "")) continue;
      if (!this.windows.has(w)) this.windows.set(w, source);
    }
  }

  find(text: string, limit = 5): FragmentMatch[] {
    const norm = normalizeForFingerprint(text);
    const matches: FragmentMatch[] = [];
    for (let i = 0; i + this.window <= norm.length && matches.length < limit; i++) {
      const w = norm.slice(i, i + this.window);
      const source = this.windows.get(w);
      if (source !== undefined) {
        matches.push({ fragment: w, source });
        i += this.window - 1; // report non-overlapping fragments
      }
    }
    return matches;
  }
}
