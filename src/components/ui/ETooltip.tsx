import React from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/Tooltip";
import { cn } from "@/shared/cn";

interface EllipsisWithTooltipProps {
  text: string;
  tooltip?: string;
  className?: string;
}

/** Renders the ellipsis with tooltip component. */
export const EllipsisWithTooltip: React.FC<EllipsisWithTooltipProps> = ({
  text,
  tooltip,
  className,
}) => {
  const content = tooltip || text;
  const isCommitHash = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(content);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`overflow-hidden whitespace-nowrap text-ellipsis cursor-default ${className ?? ""}`}
          >
            {text}
          </div>
        </TooltipTrigger>
        <TooltipContent
          collisionPadding={12}
          data-content-kind={isCommitHash ? "commit" : undefined}
          className={cn(
            "max-w-[min(18rem,calc(100vw-24px),var(--radix-tooltip-content-available-width))] [overflow-wrap:anywhere]",
            isCommitHash &&
              "w-max max-w-[min(calc(100vw-24px),var(--radix-tooltip-content-available-width))] font-mono text-left text-xs text-wrap"
          )}
        >
          <p>{content}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
