import { expect, test } from "bun:test";
import { publicAssetHref } from "../components/DocumentationLink";

test.each(["", "/baas-tauri", "/nested/baas-tauri"])(
  "static resource paths at %p retain their query and fragment",
  (prefix) => {
    expect(publicAssetHref("/benchmarks/native-transport-current.json", prefix)).toBe(
      prefix + "/benchmarks/native-transport-current.json"
    );
    expect(publicAssetHref("/benchmarks/device-current.json?download=1#record", prefix)).toBe(
      prefix + "/benchmarks/device-current.json?download=1#record"
    );
    expect(publicAssetHref("/developer/recognition-replay.json", prefix)).toBe(
      prefix + "/developer/recognition-replay.json"
    );
    expect(publicAssetHref("/media/image.png", prefix)).toBe(prefix + "/media/image.png");
  }
);

test.each([
  "/",
  "/docs",
  "/docs/",
  "/docs?language=en",
  "/docs/en/guide/install/",
  "/docs/zh/#start",
  "#section",
  "?query=1",
  "https://example.com/file.json",
  "//example.com/file.json",
  "mailto:example@example.com",
])("%s keeps the framework's document/external-link behavior", (href) => {
  expect(publicAssetHref(href, "/baas-tauri")).toBeUndefined();
});

test("dot segments are normalized before adding the deployment prefix", () => {
  expect(publicAssetHref("/docs/../../benchmarks/data.json", "/baas-tauri")).toBe(
    "/baas-tauri/benchmarks/data.json"
  );
});
