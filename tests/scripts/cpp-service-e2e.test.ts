import { describe, expect, test } from "bun:test";
import { e2eCppService } from "../../scripts/e2e-cpp-service.mjs";

describe("C++ service websocket E2E gate", () => {
  test("cannot skip or fall back when the real service binary is missing", async () => {
    await expect(e2eCppService("", "")).rejects.toThrow(
      "BAAS_CPP_SERVICE_PATH is required for real websocket E2E"
    );
  });

  test("cannot start without the separately owned remote resource", async () => {
    await expect(e2eCppService(process.execPath, "")).rejects.toThrow(
      "BAAS_CPP_SERVICE_REMOTE_JAR is required for real websocket E2E"
    );
  });
});
