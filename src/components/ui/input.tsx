import * as React from "react"
import {cn} from "@/lib/utils"
import {ChevronUp, ChevronDown} from "lucide-react"

function Input({className, type, ...props}: React.ComponentProps<"input">) {
  // 判断是否是数字输入
  if (type === "number") {
    return (
      <div className="relative w-full">
        <input
          type="number"
          data-slot="input"
          className={cn(
            // 先屏蔽原生箭头
            "appearance-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
            "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground " +
            "dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent pr-8 px-3 py-1 text-base shadow-xs " +
            "transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm " +
            "file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
            "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
            className
          )}
          {...props}
        />
        {/* 自定义上下箭头 */}
        <div className="absolute inset-y-0 right-1 flex flex-col justify-center">
          <button
            type="button"
            tabIndex={-1}
            className="hover:text-primary transition-colors"
            onClick={(e) => {
              const input = (e.currentTarget.parentElement?.previousSibling ||
                null) as HTMLInputElement | null
              if (input) input.stepUp()
              input?.dispatchEvent(new Event("input", {bubbles: true}))
            }}
          >
            <ChevronUp className="h-3 w-3"/>
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="hover:text-primary transition-colors"
            onClick={(e) => {
              const input = (e.currentTarget.parentElement?.previousSibling ||
                null) as HTMLInputElement | null
              if (input) input.stepDown()
              input?.dispatchEvent(new Event("input", {bubbles: true}))
            }}
          >
            <ChevronDown className="h-3 w-3"/>
          </button>
        </div>
      </div>
    )
  }

  // 其他类型保持不变
  return (
    <input
      type={type??"text"}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground " +
        "dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs " +
        "transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm " +
        "file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        "appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none",
        className
      )}
      {...props}
    />
  )
}

export {Input}
