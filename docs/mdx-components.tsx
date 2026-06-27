import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocHomeIcon } from "@/components/DocHomeIcon";
import { Mermaid } from "@/components/Mermaid";
import { ReleaseDownloadPanel } from "@/components/ReleaseDownloadPanel";

export const mdxComponents = {
  ...defaultMdxComponents,
  DocHomeIcon,
  Mermaid,
  ReleaseDownloadPanel,
};

export function useMDXComponents(components: Record<string, unknown>) {
  return {
    ...mdxComponents,
    ...components,
  };
}
