import defaultMdxComponents from "fumadocs-ui/mdx";
import { Mermaid } from "@/components/Mermaid";
import { ReleaseDownloadPanel } from "@/components/ReleaseDownloadPanel";

export const mdxComponents = {
  ...defaultMdxComponents,
  Mermaid,
  ReleaseDownloadPanel,
};

export function useMDXComponents(components: Record<string, unknown>) {
  return {
    ...mdxComponents,
    ...components,
  };
}
