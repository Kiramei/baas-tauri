import React from "react";

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

/** Renders the card component. */
export const Card: React.FC<CardProps> = ({ children, className = "", onClick }) => {
  const baseClasses =
    "rounded-xl border border-border bg-card text-card-foreground";
  const interactiveClasses = onClick
    ? "cursor-pointer hover:bg-secondary/60 transition-colors duration-150"
    : "";

  return (
    <div className={`${baseClasses} ${interactiveClasses} ${className}`} onClick={onClick}>
      {children}
    </div>
  );
};

interface CardHeaderProps {
  children: React.ReactNode;
  className?: string;
}

/** Renders the card header component. */
export const CardHeader: React.FC<CardHeaderProps> = ({ children, className = "" }) => {
  return (
    <div className={`p-4 border-b border-border ${className}`}>
      {children}
    </div>
  );
};

interface CardContentProps {
  children: React.ReactNode;
  className?: string;
}

/** Renders the card content component. */
export const CardContent: React.FC<CardContentProps> = ({ children, className = "" }) => {
  return <div className={`p-4 ${className}`}>{children}</div>;
};

interface CardTitleProps {
  children: React.ReactNode;
  className?: string;
}

/** Renders the card title component. */
export const CardTitle: React.FC<CardTitleProps> = ({ children, className = "" }) => {
  return (
    <h3 className={`text-sm font-medium text-foreground ${className}`}>
      {children}
    </h3>
  );
};

interface CardDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

/** Renders the card description component. */
export const CardDescription: React.FC<CardDescriptionProps> = ({ children, className = "" }) => {
  return <p className={`text-sm text-muted-foreground ${className}`}>{children}</p>;
};
