import React from "react";

interface CornerBoxProps {
  size?: number;
  cornerSize?: number;
  borderWidth?: number;
  expand?: number;
  color?: string;
  className?: string;
  children?: React.ReactNode;
}

export const CornerBox = ({
  size = 200,
  cornerSize = 20,
  borderWidth = 3,
  expand = 10,
  color = "white",
  className = "",
  children,
}: CornerBoxProps) => {
  const commonStyle = {
    width: cornerSize,
    height: cornerSize,
    borderWidth: borderWidth,
    borderColor: color,
    transition: "transform 0.3s ease",
  };

  return (
    <div
      className={`relative group/inner flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      {children}

      {/* TL */}
      <span
        className="absolute top-0 left-0 border-b-0! border-r-0! border-t border-l corner-tl opacity-0"
        style={{
          ...commonStyle,
          transform: "translate(0,0)",
        }}
      />

      {/* TR */}
      <span
        className="absolute top-0 right-0 border-l-0! border-b-0! border-t border-r corner-tr opacity-0"
        style={{
          ...commonStyle,
          transform: "translate(0,0)",
        }}
      />

      {/* BL */}
      <span
        className="absolute bottom-0 left-0 border-r-0! border-t-0! border-b border-l corner-bl opacity-0"
        style={{
          ...commonStyle,
          transform: "translate(0,0)",
        }}
      />

      {/* BR */}
      <span
        className="absolute bottom-0 right-0 border-l-0! border-t-0! border-b border-r corner-br opacity-0"
        style={{
          ...commonStyle,
          transform: "translate(0,0)",
        }}
      />

      {/* hover 控制 */}
      <style>{`
        .group\\/inner:hover .corner-tl {
          transform: translate(-${expand}px, -${expand}px) !important;
          opacity: 1 !important;
        }
      
        .group\\/outer:hover .corner-tl {
          transform: translate(-${expand}px, -${expand}px) !important;
          opacity: 1 !important;
        }
      
        .group\\/inner:hover .corner-tr {
          transform: translate(${expand}px, -${expand}px) !important;
          opacity: 1 !important;
        }
        .group\\/outer:hover .corner-tr {
          transform: translate(${expand}px, -${expand}px) !important;
          opacity: 1 !important;
          
        }
      
        .group\\/inner:hover .corner-bl {
          transform: translate(-${expand}px, ${expand}px) !important;
          opacity: 1 !important;
          
        }
        .group\\/outer:hover .corner-bl {
          transform: translate(-${expand}px, ${expand}px) !important;
          opacity: 1 !important;
          
        }
      
        .group\\/inner:hover .corner-br {
          transform: translate(${expand}px, ${expand}px) !important;
          opacity: 1 !important;
          
        }
        .group\\/outer:hover .corner-br {
          transform: translate(${expand}px, ${expand}px) !important;
          opacity: 1 !important;
          
        }
      `}</style>
    </div>
  );
};
