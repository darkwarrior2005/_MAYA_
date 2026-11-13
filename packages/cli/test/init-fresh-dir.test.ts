import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Found by installing Maya in a Linux container and following the README:
 * `maya init ~/demo` on a directory that did not exist failed with "Cannot
 * use simple-git on a directory that does not exist", and `maya doctor` on
 * the same path reported "git is not usable — install git and make sure it is
 * on PATH". Git was fine. The folder was missing, and neither message said
 * so.
 *
 * These drive the built CLI rather than the functions inside it, because the
 * bug was in what someone typed at a shell getting an answer about the wrong
 * thing.
 */
const cli = join(import.meta.dirname, "..", "dist", "main.js");
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "maya-init-"));
  made.push(dir);
  return dir;
}

const run = (args: string[]): { out: string; code: number } => {
  try {
    return { out: execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }), code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { out: `${failure.stdout ?? ""}${failure.stderr ?? ""}`, code: failure.status ?? 1 };
  }
};

describe("maya init on a directory that is not there yet", () => {
  it("creates it, because that is what preparing a project means", () => {
    const target = join(scratch(), "nested", "project");
    expect(existsSync(target)).toBe(false);

    const { out, code } = run(["init", target]);

    expect(code).toBe(0);
    expect(out).toContain("Maya initialized");
    expect(existsSync(join(target, ".maya"))).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(true);
  });
});

describe("maya doctor on a directory that is not there", () => {
  it("says the directory is missing rather than blaming git", () => {
    const target = join(scratch(), "no-such-project");

    const { out, code } = run(["doctor", "-d", target]);

    expect(code).toBe(1);
    expect(out).toContain("does not exist");
    expect(out).toContain("maya init");
    // The old message sent people to reinstall a git that was working.
    expect(out).not.toContain("git is not usable");
    expect(out).not.toContain("simple-git");
  });
});
