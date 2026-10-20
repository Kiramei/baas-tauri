import { expect, test } from "bun:test";
import { remarkDocLinks, resolveDocLink } from "../lib/remark-doc-links.mjs";

test("source-relative navigation respects locale and static trailing slashes", () => {
  expect(resolveDocLink("./guide/install", "zh/index.mdx")).toBe("/docs/zh/guide/install/");
  expect(resolveDocLink("./configuration", "en/guide/interface.mdx")).toBe(
    "/docs/en/guide/configuration/"
  );
  expect(
    resolveDocLink("../features/profile#section", "zh/guide/interface.mdx", "/baas-tauri")
  ).toBe("/baas-tauri/docs/zh/features/profile/#section");
  expect(resolveDocLink("./team.mdx?example=1", "en/features/stages.mdx")).toBe(
    "/docs/en/features/team/?example=1"
  );
  expect(resolveDocLink("#local", "en/index.mdx")).toBe("#local");
  expect(resolveDocLink("https://example.com/", "en/index.mdx")).toBe("https://example.com/");
  expect(() => resolveDocLink("../../features/server", "en/guide/install.mdx")).toThrow(
    "escapes its locale"
  );
});

test("structured MDX nodes handle document anchors and public image assets", () => {
  const tree = {
    type: "root",
    children: [
      { type: "link", url: "./scheduler", children: [] },
      {
        type: "mdxJsxFlowElement",
        name: "a",
        attributes: [{ type: "mdxJsxAttribute", name: "href", value: "../features/script" }],
      },
      {
        type: "mdxJsxFlowElement",
        name: "img",
        attributes: [{ type: "mdxJsxAttribute", name: "src", value: "/media/example.png" }],
      },
    ],
  };
  remarkDocLinks()(tree, { path: "D:\\repo\\docs\\content\\docs\\en\\guide\\interface.mdx" });
  expect(tree.children[0].url).toBe("/docs/en/guide/scheduler/");
  expect(tree.children[1].attributes?.[0].value).toBe("/docs/en/features/script/");
  expect(tree.children[2].attributes?.[0].value).toBe("/media/example.png");
});
