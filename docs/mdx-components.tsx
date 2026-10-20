import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocHomeIcon } from "@/components/DocHomeIcon";
import { Mermaid } from "@/components/Mermaid";
import { ReleaseDownloadPanel } from "@/components/ReleaseDownloadPanel";
import { BenchmarkChart } from "@/components/BenchmarkChart";
import { MotionDemo } from "@/components/MotionDemo";

export const mdxComponents = {
  ...defaultMdxComponents,
  DocHomeIcon,
  Mermaid,
  ReleaseDownloadPanel,
  BenchmarkChart,
  MotionDemo,
};

/** Coordinates the use mdxcomponents hook behavior. */
export function useMDXComponents(components: Record<string, unknown>) {
  return {
    ...mdxComponents,
    ...components,
  };
}
