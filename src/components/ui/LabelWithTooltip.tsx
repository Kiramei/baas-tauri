import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip.tsx";
import {BadgeQuestionMark} from "lucide-react";

interface LabelWithTooltipProps {
  label: string;
  tooltip: string;
  className?: string;
}

export const LabelWithTooltip = ({label, tooltip, className}: LabelWithTooltipProps) => {
  return (
    <label className={`text-sm font-medium mb-2 flex items-center ${className ?? ""}`}>
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="ml-1">
            <BadgeQuestionMark size={18}/>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-sm">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </label>
  )
}