import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import protocol from "../evidence/service-protocol-validation.json";
import contracts from "../evidence/service-contract-tests.json";
import layout from "../evidence/service-layout-validation.json";

const read = (file: string) => readFileSync(new URL("../../" + file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const historicalClientSource = (file: string) => execFileSync(
  "git", ["show", `${protocol.clientRevision}:${file}`],
  { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8" }
).replaceAll("\r\n", "\n");

test("historical protocol interoperability preserves pinned production source, actual crypto and cleanup boundaries", () => {
  expect(protocol.backendRevision).toBe("d0a86a089068766ff53682b501b90bee99857a71");
  expect(protocol.clientRevision).toBe("55f11ec6f4e0dd2a075e7eead2d16378ad24ae8d");
  expect(protocol.backendSources).toHaveLength(69);
  expect(protocol.clientSources).toHaveLength(4);
  for (const source of [...protocol.backendSources, ...protocol.clientSources]) {
    expect(source.gitContentVerified).toBe(true);
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  // This evidence describes the explicitly recorded revision, rather than a new
  // interoperability run for each later change to the application store or framing.
  for (const source of protocol.clientSources)
    expect(hash(historicalClientSource(source.file))).toBe(source.sha256);
  for (const [file, expected] of Object.entries(protocol.harnessSources)) expect(hash(read(file))).toBe(expected);
  expect(protocol.cases).toBe(20);
  expect(protocol.results).toHaveLength(20);
  expect(new Set(protocol.results.map((result) => result.id)).size).toBe(20);
  expect(protocol.results.every((result) => result.passed)).toBe(true);
  for (const id of ["initialize-with-real-argon2", "provider-secretstream-initial-data", "stale-patch-rejected",
    "cookie-control-resume", "logout-does-not-revoke-active-session", "existing-business-stream-not-server-closed",
    "revoked-session-cannot-open-new-stream", "new-password-epoch-two"])
    expect(protocol.results.some((result) => result.id === id)).toBe(true);
  expect(protocol.crypto).toContain("Unmodified production");
  expect(protocol.scope).toContain("security limitation");
  expect(protocol.cleanup).toEqual({ browserClosed: true, fixtureExitCode: 0, temporaryAuthAndConfigRemoved: true });
  expect(protocol.pageErrors).toEqual([]);
  expect(protocol.gameOrDeviceAccessed).toBe(false);
  expect(protocol.sensitiveDataPublished).toBe(false);
  expect(JSON.stringify(protocol)).not.toMatch(/WorkSpace|\.codex_tmp|[A-Z]:\\|"password"\s*:|"resumeTicket"\s*:|"masterSecret"\s*:|"cookie"\s*:/i);
});

test("backend contract counts retain their Windows skip and test-source provenance", () => {
  expect(contracts.backendRevision).toBe(protocol.backendRevision);
  expect(contracts.publisherSha256).toBe(hash(read("docs/scripts/summarize-service-contracts.py")));
  expect(contracts.collected).toBe(44);
  expect(contracts.passed).toBe(43);
  expect(contracts.failed).toBe(0);
  expect(contracts.skipped).toEqual([{ test: "test_unix_pipe_channel_round_trip", reason: "Unix sockets are unavailable on Windows" }]);
  expect(contracts.testSources).toHaveLength(7);
  for (const source of contracts.testSources) expect(source.gitContentVerified).toBe(true);
  expect(contracts.cliSources).toHaveLength(3);
  expect(contracts.cli.helpExitCode).toBe(0);
  expect(contracts.cli.mutuallyExclusiveExitCode).toBe(2);
  expect(contracts.cli.noPidFileAfterCheck).toBe(true);
  expect(contracts.cli.supportedOptions).toHaveLength(8);
});

test("both service guides explain crypto, conflicts, local framing and deployment limitations", () => {
  const tokens = ["/auth/remember", "/auth/logout", "/system/logs", "X25519", "Ed25519", "Argon2id",
    "HKDF-SHA256", "ChaCha20-Poly1305", "SecretStream", "BAAS_SERVICE_SIGN_SEED_B64",
    "VITE_BAAS_SERVER_SIGN_PUBLIC_KEY_B64", "BAAS_REMEMBER_TTL_SECONDS", "BAAS_REMEMBER_COOKIE_SECURE",
    "BAAS_SERVICE_ALLOWED_ORIGINS", "BAAS_SERVICE_CORS_ORIGIN_REGEX", "resume_unavailable", "resume_mac",
    "server_header", "client_header", "stream_ready", "patch_conflict", "request_timestamp", "patch_ack",
    "logs_full", "is_all_data_initialized", "data.done=true", "decrypt=false", "BPIP", "BPRQ", "64 MiB", "4403", "4401", "1011"];
  for (const locale of ["zh", "en"]) {
    const content = read(`docs/content/docs/${locale}/reference/backend-service.mdx`);
    for (const token of tokens) expect(content).toContain(token);
    expect(content).toContain("--host 127.0.0.1");
    expect(content).toContain(protocol.clientRevision);
    expect(content).toContain(protocol.backendRevision);
    expect((content.match(/```mermaid/g) || []).length).toBe(2);
    expect(content).toContain(locale === "zh" ? "公开固定值" : "public, fixed source constant");
    expect(content).toContain(locale === "zh" ? "没有逐帧重新检查" : "do not recheck");
  }
});

test("CLI guides retain current arguments and warn about top-level task execution", () => {
  for (const locale of ["zh", "en"]) {
    const content = read(`docs/content/docs/${locale}/reference/cli-service.mdx`);
    for (const token of ["--host", "--port", "--reload", "--log-level", "--pipe-name", "--shm-name", "--ocr-update-check",
      "--no-ocr-update-check", "BAAS_SERVICE_HOST", "BAAS_SERVICE_PORT", "BAAS_SERVICE_OCR_UPDATE_CHECK", ".[service]",
      "asyncio.run(main())", "asyncio.gather()", "asyncio.to_thread()", "threading.Lock", "pdm run python cli.local.py", ".pid"])
      expect(content).toContain(token);
    expect(content).not.toMatch(/conda create|pip install -r requirements\.txt|pdm run cli\./);
    expect(content).toContain(locale === "zh" ? "导入它也会执行任务" : "importing it also executes tasks");
  }
});

test("service diagrams and search have source-bound bilingual presentation checks", () => {
  expect(layout.cases).toBe(20);
  expect(layout.diagramChecks).toBe(16);
  expect(layout.failures).toBe(0);
  for (const [file, expected] of Object.entries(layout.testedSources)) expect(hash(read(file))).toBe(expected);
  expect(layout.results.filter((result) => result.kind === "render")).toHaveLength(16);
  expect(layout.results.filter((result) => result.kind === "search-navigation")).toHaveLength(4);
  expect(layout.results.every((result) => result.passed)).toBe(true);
});
