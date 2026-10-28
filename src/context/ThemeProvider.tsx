import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import type { Theme } from "src/types/app";
import {
  readThemePreference,
  saveThemePreference,
  watchThemePreference,
} from "@/shared/ThemePreference";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/** Renders the theme provider component. */
export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(() =>
    readThemePreference(document.documentElement.dataset.themePreference)
  );

  useLayoutEffect(() => {
    const stopWatching = watchThemePreference(
      theme,
      document.documentElement,
      window.matchMedia("(prefers-color-scheme: dark)")
    );
    saveThemePreference(theme);
    return stopWatching;
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

/** Coordinates the use theme hook behavior. */
export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
