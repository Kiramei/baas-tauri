import defaultMdxComponents from "fumadocs-ui/mdx";
import { Popup, PopupContent, PopupTrigger } from "fumadocs-twoslash/ui";
import { DocHomeIcon } from "@/components/DocHomeIcon";
import { Mermaid } from "@/components/Mermaid";
import { ReleaseDownloadPanel } from "@/components/ReleaseDownloadPanel";
import { BenchmarkChart } from "@/components/BenchmarkChart";
import { NativeTransportBenchmark } from "@/components/NativeTransportBenchmark";
import { NativePayloadBenchmark } from "@/components/NativePayloadBenchmark";
import { AndroidLocalBenchmark } from "@/components/AndroidLocalBenchmark";
import { DeviceBenchmark } from "@/components/DeviceBenchmark";
import { MotionDemo } from "@/components/MotionDemo";
import { AndroidGameDemo } from "@/components/AndroidGameDemo";
import { RecognitionReplay } from "@/components/RecognitionReplay";
import { DocumentationLink } from "@/components/DocumentationLink";

export const mdxComponents = {
  ...defaultMdxComponents,
  Popup,
  PopupContent,
  PopupTrigger,
  a: DocumentationLink,
  DocHomeIcon,
  Mermaid,
  ReleaseDownloadPanel,
  BenchmarkChart,
  NativeTransportBenchmark,
  NativePayloadBenchmark,
  AndroidLocalBenchmark,
  DeviceBenchmark,
  MotionDemo,
  AndroidGameDemo,
  RecognitionReplay,
};

/** Coordinates the use mdxcomponents hook behavior. */
export function useMDXComponents(components: Record<string, unknown>) {
  return {
    ...mdxComponents,
    ...components,
  };
}
