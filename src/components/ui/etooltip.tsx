import React from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface EllipsisWithTooltipProps {
  text: string
  tooltip?: string
  className?: string
}

export const EllipsisWithTooltip: React.FC<EllipsisWithTooltipProps> = ({text, tooltip, className}) => {
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
        <TooltipContent>
          <p>{tooltip ? tooltip : text}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
