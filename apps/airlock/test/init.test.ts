import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COVER_SETTING_PREFIX, PERSONA_POOL } from "@airlock/broker";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/init.js";

const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "airlock-init-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("airlock init", () => {
  it("writes a profile with a cover setting from the pool and a jewels template", () => {
    const root = temp();
    const r = initProject({ root });
    expect(PERSONA_POOL).toContain(r.persona);
    expect(readFileSync(join(root, ".airlock/profile.md"), "utf8")).toContain(`${COVER_SETTING_PREFIX} ${r.persona}`);
    expect(JSON.parse(readFileSync(join(root, ".airlock/jewels.json"), "utf8"))).toEqual({ terms: [], files: [], descriptions: [] });
  });

  it("respects --no-persona, a custom persona, and an existing profile", () => {
    const root = temp();
    expect(initProject({ root, persona: false }).persona).toBeUndefined();
    expect(readFileSync(join(root, ".airlock/profile.md"), "utf8")).not.toContain(COVER_SETTING_PREFIX);
    writeFileSync(join(root, ".airlock/profile.md"), `A CLI tool.\n\n${COVER_SETTING_PREFIX} it runs a bakery.\n`);
    const kept = initProject({ root });
    expect(kept.wroteProfile).toBe(false);
    expect(kept.persona).toBe("it runs a bakery.");
    expect(initProject({ root, persona: "it tracks kites.", force: true }).persona).toBe("it tracks kites.");
  });
});
