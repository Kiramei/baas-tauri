
import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export const Card: React.FC<CardProps> = ({ children, className = '', onClick }) => {
  const baseClasses = "bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl shadow-sm";
  const interactiveClasses = onClick ? "cursors-pointer hover:shadow-md hover:border-primary-300 dark:hover:border-primary-500 transition-all duration-200" : "";
  
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

export const CardHeader: React.FC<CardHeaderProps> = ({ children, className = '' }) => {
    return (
        <div className={`p-4 border-b border-slate-200 dark:border-slate-700 ${className}`}>
            {children}
        </div>
    );
};


interface CardContentProps {
  children: React.ReactNode;
  className?: string;
}

export const CardContent: React.FC<CardContentProps> = ({ children, className = '' }) => {
  return <div className={`p-4 ${className}`}>{children}</div>;
};

interface CardTitleProps {
  children: React.ReactNode;
  className?: string;
}

export const CardTitle: React.FC<CardTitleProps> = ({ children, className = '' }) => {
    return <h3 className={`text-lg font-semibold text-slate-800 dark:text-slate-100 ${className}`}>{children}</h3>
}

interface CardDescriptionProps {
    children: React.ReactNode;
    className?: string;
  }
  
  export const CardDescription: React.FC<CardDescriptionProps> = ({ children, className = '' }) => {
      return <p className={`text-sm text-slate-500 dark:text-slate-400 ${className}`}>{children}</p>
  }
