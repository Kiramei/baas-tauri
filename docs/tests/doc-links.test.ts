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

test("MDX leaves navigation prefixes to Next Link and prefixes plain media once", () => {
  const previous = process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.NEXT_PUBLIC_BASE_PATH = "/baas-tauri";
  try {
    const tree = {
      type: "root",
      children: [
        { type: "link", url: "./configuration", children: [] },
        { type: "definition", url: "#section" },
        { type: "link", url: "/docs/en/features/server/", children: [] },
        { type: "image", url: "/media/example.png" },
        { type: "image", url: "https://example.com/image.png" },
        { type: "image", url: "//example.com/image.png" },
        {
          type: "mdxJsxFlowElement",
          name: "a",
          attributes: [{ type: "mdxJsxAttribute", name: "href", value: "../features/script" }],
        },
        {
          type: "mdxJsxFlowElement",
          name: "video",
          attributes: [
            { type: "mdxJsxAttribute", name: "src", value: "/media/example.mp4" },
            { type: "mdxJsxAttribute", name: "poster", value: "/media/poster.png" },
          ],
        },
      ],
    };
    remarkDocLinks()(tree, { path: "/repo/docs/content/docs/en/guide/interface.mdx" });
    expect(tree.children[0].url).toBe("/docs/en/guide/configuration/");
    expect(tree.children[1].url).toBe("#section");
    expect(tree.children[2].url).toBe("/docs/en/features/server/");
    expect(tree.children[3].url).toBe("/baas-tauri/media/example.png");
    expect(tree.children[4].url).toBe("https://example.com/image.png");
    expect(tree.children[5].url).toBe("//example.com/image.png");
    expect(tree.children[6].attributes?.[0].value).toBe("/docs/en/features/script/");
    expect(tree.children[7].attributes?.map((attribute) => attribute.value)).toEqual([
      "/baas-tauri/media/example.mp4",
      "/baas-tauri/media/poster.png",
    ]);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
    else process.env.NEXT_PUBLIC_BASE_PATH = previous;
  }
});
