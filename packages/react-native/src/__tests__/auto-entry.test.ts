import { describe, expect, test } from "bun:test";

describe("./auto entry in a fresh runtime", () => {
  test("keeps root inert, restores the native lease once, and re-exports the root API", async () => {
    const fixturePath = new URL(
      "./fixtures/auto-recovery-runtime.ts",
      import.meta.url
    ).pathname;
    const child = Bun.spawn(["bun", "run", fixturePath], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain("auto recovery fixture passed");
    expect(exitCode).toBe(0);
  });
});
