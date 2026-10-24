/** Lower-case and collapse whitespace so reformatting doesn't hide a copied fragment. */
export function normalizeForFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
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
    const norm = normalizeForFingerprint(text);
    for (let i = 0; i + this.window <= norm.length; i += this.stride) {
      const w = norm.slice(i, i + this.window);
      // Windows that are mostly whitespace or punctuation are boilerplate, not content.
      if ((w.match(/[a-z0-9]/g)?.length ?? 0) < this.window / 2) continue;
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
