import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type MotionPreference = "full" | "reduced" | "off";

interface AppearanceValue {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  motion: MotionPreference;
  setMotion: (motion: MotionPreference) => void;
}

const AppearanceContext = createContext<AppearanceValue | null>(null);

function getStoredTheme(): ThemePreference {
  const value = window.localStorage.getItem("litehouse.theme");
  return value === "light" || value === "dark" ? value : "system";
}

function getStoredMotion(): MotionPreference {
  const value = window.localStorage.getItem("litehouse.motion");
  return value === "reduced" || value === "off" ? value : "full";
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(getStoredTheme);
  const [motion, setMotion] = useState<MotionPreference>(getStoredMotion);

  useEffect(() => {
    window.localStorage.setItem("litehouse.theme", theme);
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) {
      themeColor.content = theme === "dark" ? "#11100d" : "#f4f0e6";
    }
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("litehouse.motion", motion);
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  const value = useMemo(
    () => ({ theme, setTheme, motion, setMotion }),
    [motion, theme],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) {
    throw new Error("useAppearance must be used inside AppearanceProvider");
  }
  return value;
}
