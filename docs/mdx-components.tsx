import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocHomeIcon } from "@/components/DocHomeIcon";
import { Mermaid } from "@/components/Mermaid";
import { ReleaseDownloadPanel } from "@/components/ReleaseDownloadPanel";
import { BenchmarkChart } from "@/components/BenchmarkChart";
import { NativeTransportBenchmark } from "@/components/NativeTransportBenchmark";
import { DeviceBenchmark } from "@/components/DeviceBenchmark";
import { MotionDemo } from "@/components/MotionDemo";
import { RecognitionReplay } from "@/components/RecognitionReplay";

export const mdxComponents = {
  ...defaultMdxComponents,
  DocHomeIcon,
  Mermaid,
  ReleaseDownloadPanel,
  BenchmarkChart,
  NativeTransportBenchmark,
  DeviceBenchmark,
  MotionDemo,
  RecognitionReplay,
};

/** Coordinates the use mdxcomponents hook behavior. */
export function useMDXComponents(components: Record<string, unknown>) {
  return {
    ...mdxComponents,
    ...components,
  };
}
