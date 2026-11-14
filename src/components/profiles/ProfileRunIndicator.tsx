import { CircleAlert, Loader2 } from "lucide-react";
import { IconTooltip } from "@/components/ui/Tooltip";
import { cn } from "@/shared/cn";
import type { ExecutionOutcome } from "@/shared/ExecutionOutcome";

/** One execution outcome drives the compact strip and the sidebar's action slot. */
export function ProfileRunIndicator({
  outcome,
  label,
  className,
  tooltip = false,
}: {
  outcome: ExecutionOutcome;
  label: string;
  className?: string;
  tooltip?: boolean;
}) {
  if (outcome === "idle") return null;
  const Icon = outcome === "failed" ? CircleAlert : Loader2;
  const indicator = (
    <span
      role="img"
      aria-label={label}
      data-profile-run-indicator={outcome}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        outcome === "failed" && "text-[#e25d5a]",
        className
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.8}
        className={cn("size-4", outcome === "running" && "animate-spin")}
      />
    </span>
  );
  return tooltip ? (
    <IconTooltip content={label} side="bottom">
      {indicator}
    </IconTooltip>
  ) : (
    indicator
  );
}
