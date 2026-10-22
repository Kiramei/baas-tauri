import { expect, test } from "bun:test";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExportServer } from "../scripts/static-export-server.mjs";

const publicDirectory = fileURLToPath(new URL("../public", import.meta.url));

test("the export fixture validates deployment prefixes", () => {
  for (const prefix of ["relative", "/bad/", "//bad", "/../escape", "/bad?query", "/bad\\path"]) {
    expect(() => createExportServer(publicDirectory, prefix)).toThrow();
  }
});

test.each(["", "/baas-tauri", "/nested/baas-tauri"])(
  "static host at %p does not hide broken resource paths",
  async (prefix) => {
    const server = createExportServer(publicDirectory, prefix);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing loopback port");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const image = await fetch(base + prefix + "/baas-icon.webp");
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/webp");
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
      expect((await fetch(base + prefix + "/missing-page/")).status).toBe(404);
      expect((await fetch(base + prefix + "/missing-resource.js")).status).toBe(404);
      expect((await fetch(base + prefix + "/missing-resource.txt")).status).toBe(404);
      expect((await fetch(base + prefix + "/baas-icon.webp", { method: "HEAD" })).status).toBe(200);
      expect((await fetch(base + prefix + "/baas-icon.webp", { method: "POST" })).status).toBe(405);
      expect((await fetch(base + prefix + "/%5c..%5cpackage.json")).status).toBe(400);
      expect((await fetch(base + prefix + "/%00")).status).toBe(400);
      expect((await fetch(base + prefix + "/%ZZ")).status).toBe(400);
      if (prefix) {
        expect((await fetch(base + "/baas-icon.webp")).status).toBe(404);
        expect((await fetch(base + prefix + "-other/baas-icon.webp")).status).toBe(404);
        const redirect = await fetch(base + prefix + "?lang=en", { redirect: "manual" });
        expect(redirect.status).toBe(308);
        expect(redirect.headers.get("location")).toBe(prefix + "/?lang=en");
      }
      expect(path.isAbsolute(publicDirectory)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  }
);
