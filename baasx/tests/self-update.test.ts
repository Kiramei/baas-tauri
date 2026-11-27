import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import platforms from "../scripts/distribution-platforms.json";
import { tmpdir } from "node:os";
import {
  archiveTar,
  checkSelfUpdate,
  newerStable,
  packageManager,
  replaceNative,
} from "../src/self-update";

const platformLabels = platforms.map((p) => {
  const os = ({ linux: "Linux", darwin: "macOS", win32: "Windows" } as Record<string, string>)[
    p.os
  ];
  return { ...p, label: os + "-" + (p.assetCpu ?? p.cpu).toUpperCase() };
});

function mockFetch(handler: (input: Parameters<typeof fetch>[0]) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(handler, { preconnect: fetch.preconnect })
  );
}

test("registry installs use their owning manager and a pinned stable version", async () => {
  const registry = mockFetch(async () =>
    Response.json({ name: "@kiramei/baasx", version: "10.0.0" })
  );
  try {
    for (const [path, manager, command] of [
      ["/opt/bun/install/global/node_modules/@kiramei/baasx", "bun", "bun add -g"],
      ["C:\\pnpm\\global\\5\\node_modules\\.pnpm\\@kiramei+baasx", "pnpm", "pnpm add -g"],
      ["/fixture/.config/yarn/global/node_modules/@kiramei/baasx", "yarn", "yarn global add"],
      ["/usr/lib/node_modules/@kiramei/baasx", "npm", "npm install -g"],
      ["/cached/npm/registry.npmjs.org/@kiramei/baasx/0.1.0", "deno", "deno install -g -A --force"],
    ] as const) {
      const actual = packageManager(path, manager === "deno");
      expect(actual).toBe(manager);
      const update = await checkSelfUpdate({ kind: "package", manager: actual, archive: false });
      expect(update.command).toBe(
        `${command} ${manager === "deno" ? "npm:" : ""}@kiramei/baasx@10.0.0`
      );
      expect(update.available).toBe(true);
      expect(update.notes).toEndWith("/tag/baasx-10.0.0");
    }
  } finally {
    registry.mockRestore();
  }
  expect(newerStable("0.10.0", "0.9.9")).toBe(true);
  expect(newerStable("1.0.0", "1.0.0-rc.2")).toBe(true);
  expect(newerStable("1.0.0+2", "1.0.0+1")).toBe(false);
  expect(newerStable("9.0.0-rc", "1.0.0")).toBe(false);
});

test("standalone and Bun archive installs select the newest stable BAASX tag", async () => {
  const releases = mockFetch(async () =>
    Response.json([
      { tag_name: "v99.0.0" },
      { tag_name: "baasx-99.0.0", draft: true },
      { tag_name: "baasx-98.0.0", prerelease: true },
      { tag_name: "baasx-97.0.0-rc.1" },
      { tag_name: "baasx-v96.0.0" },
      { tag_name: "baasx-v0.1.5" },
      { tag_name: "baasx-0.1.6" },
    ])
  );
  try {
    const update = await checkSelfUpdate({ kind: "native" });
    expect(update.latest).toBe("0.1.6");
    expect(update.notes).toEndWith("/tag/baasx-0.1.6");
    const archive = await checkSelfUpdate({ kind: "package", manager: "bun", archive: true });
    expect(archive.command).toContain("/download/baasx-0.1.6/baasx-0.1.6-");
  } finally {
    releases.mockRestore();
  }
});

test.each([
  ["baasx-0.1.6", "0.1.6"],
  ["baasx-v0.1.5", "0.1.5"],
])("CNB uses the published tag %s when GitHub is unavailable", async (tag, version) => {
  const refs = ["baasx-v0.1.5", "baasx-0.1.6", "baasx-0.1.7", "baasx-9.0.0-rc.1"]
    .map((name) => "003f" + "a".repeat(40) + " refs/tags/" + name + "\n")
    .join("");
  const responses = mockFetch(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") throw new TypeError("connection reset");
    expect(url.hostname).toBe("cnb.cool");
    if (url.pathname.endsWith("/info/refs")) return new Response(refs);
    if (url.pathname.endsWith("/baasx-0.1.7/SHA256SUMS"))
      return new Response(null, { status: 404 });
    if (version === "0.1.5" && url.pathname.endsWith("/baasx-0.1.6/SHA256SUMS"))
      return new Response(null, { status: 404 });
    expect(url.pathname).toEndWith(`/${tag}/SHA256SUMS`);
    return new Response(
      platformLabels
        .map(({ label: os }) => "a".repeat(64) + `  baasx-${version}-${os}.tar.gz`)
        .join("\n")
    );
  });
  try {
    const update = await checkSelfUpdate({ kind: "native" });
    expect(update.latest).toBe(version);
    expect(update.source).toBe("cnb");
    expect(update.notes).toBe(`https://cnb.cool/kiramei/baas-tauri/-/releases/tag/${tag}`);
  } finally {
    responses.mockRestore();
  }
});

test("native updates verify the archive before replacing the executable and helper together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "baasx-upgrader-"));
  const win = process.platform === "win32";
  const exe = win ? "baasx.exe" : "baasx";
  const helper = "runtime/baas-cli-runtime" + (win ? ".exe" : "");
  const runtime = "runtime/baasx-runtime" + (win ? ".exe" : "");
  const stage = join(dir, "release");
  const install = join(dir, "install");
  const signal = new AbortController().signal;
  let checksum = "0".repeat(64);
  let archive: Buffer;
  const target = platformLabels.find((p) => p.os === process.platform && p.cpu === process.arch)!;
  const platform = target.label;
  const mock = mockFetch(async (input) => {
    expect(new URL(String(input)).pathname).toContain("/download/baasx-1.0.0/");
    if (new URL(String(input)).hostname === "github.com" && !String(input).endsWith("/SHA256SUMS"))
      throw new TypeError("TLS connection failed");
    return String(input).endsWith("/SHA256SUMS")
      ? new Response(`${checksum}  baasx-1.0.0-${platform}.tar.gz\n`)
      : new Response(new Uint8Array(archive));
  });
  try {
    for (const [location, content] of [
      [stage, "new"],
      [install, "old"],
    ]) {
      await mkdir(join(location, "runtime"), { recursive: true });
      await writeFile(join(location, exe), content);
      await writeFile(join(location, helper), content);
    }
    await writeFile(join(stage, runtime), "new");
    const paths = [exe, "runtime"];
    if (target.runtime === "node") {
      for (const dir of [stage, install]) await mkdir(join(dir, "dist"));
      await writeFile(join(stage, "runtime/node"), "new");
      await writeFile(join(stage, "dist/baasx-node.mjs"), "new");
      paths.push("dist");
    }
    execFileSync(archiveTar, ["-czf", join(dir, "release.tgz"), "-C", stage, ...paths]);
    archive = await readFile(join(dir, "release.tgz"));
    await expect(replaceNative("1.0.0", join(install, exe), signal)).rejects.toThrow(
      "checksum mismatch"
    );
    for (const member of [exe, helper])
      expect(await readFile(join(install, member), "utf8")).toBe("old");
    checksum = createHash("sha256").update(archive).digest("hex");
    await replaceNative("1.0.0", join(install, exe), signal);
    for (const member of [exe, helper, runtime])
      expect(await readFile(join(install, member), "utf8")).toBe("new");
  } finally {
    mock.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
