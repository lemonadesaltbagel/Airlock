import { describe, expect, it } from "vitest";
import { FragmentIndex, isStructuralWindow, stripImportLines } from "../src/index.js";

// Window and stride of the crown-jewel index (guaranteed detection from 31 chars).
const jewelIndex = (text: string) => {
  const idx = new FragmentIndex(24, 8);
  idx.add(text, "pricing.py");
  return idx;
};

const JEWEL = `from __future__ import annotations
import heapq, itertools
from typing import Optional, Sequence
from datetime import datetime, timedelta

class ReadinessCurve:
    def __init__(self, decay: float) -> None:
        self.weights: dict[str, list[str]] = {}
        self.decay = decay

    def score(self, minutes: int) -> float:
        return math.exp(-0.0137 * minutes) * self.peak_factor(minutes)
`;

describe("crown-jewel fragments", () => {
  it("ignores import lines a generic question shares with a jewel file", () => {
    const idx = jewelIndex(JEWEL);
    for (const q of ["from typing import Optional, Sequence", "import heapq, itertools", "from datetime import datetime, timedelta"]) {
      expect(idx.find(`Here is my code:\n${q}\n\ndef f(): pass`), q).toEqual([]);
    }
  });

  it("ignores windows made only of keywords and built-in types", () => {
    expect(jewelIndex(JEWEL).find("cache: dict[str, list[str]] = {} at module level")).toEqual([]);
  });

  it("still catches copied logic, constants and domain names", () => {
    const idx = jewelIndex(JEWEL);
    expect(idx.find("return math.exp(-0.0137 * minutes) * self.peak_factor(minutes)").length).toBeGreaterThan(0);
    expect(idx.find("def score(self, minutes: int) -> float: return math").length).toBeGreaterThan(0);
  });

  it("strips imports across languages and keeps everything else", () => {
    const src = [
      "import os",
      "from a.b import (c)",
      'import { x } from "lib";',
      'import "side-effect";',
      'const fs = require("fs");',
      "#include <stdio.h>",
      "use std::collections::HashMap;",
      "package com.example;",
      "import java.util.List;",
      "value = compute(important_input)",
    ].join("\n");
    expect(stripImportLines(src).trim()).toBe("value = compute(important_input)");
  });

  it("treats edge-cut words as unknown and digits as content", () => {
    expect(isStructuralWindow(" dict[str, list[str]] = ", "x", "{")).toBe(true);
    expect(isStructuralWindow("self.decay = decay", " ", "\n")).toBe(false);
    expect(isStructuralWindow(" range(10) ", " ", " ")).toBe(false);
    // "str" here is the tail of a longer word cut by the window start: not evidence of structure.
    expect(isStructuralWindow("str, list", "y", " ")).toBe(true);
    expect(isStructuralWindow("str", "y", " ")).toBe(false);
  });
});
