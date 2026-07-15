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
  try {
    const value = window.localStorage.getItem("litehouse.theme");
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function getStoredMotion(): MotionPreference {
  try {
    const value = window.localStorage.getItem("litehouse.motion");
    return value === "reduced" || value === "off" ? value : "full";
  } catch {
    return "full";
  }
}

function themeColorFor(theme: ThemePreference): string {
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return isDark ? "#11100d" : "#f4f0e6";
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(getStoredTheme);
  const [motion, setMotion] = useState<MotionPreference>(getStoredMotion);

  useEffect(() => {
    try {
      window.localStorage.setItem("litehouse.theme", theme);
    } catch {
      // Storage may be blocked in privacy-hardened browsers.
    }
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!themeColor) {
      return;
    }
    themeColor.content = themeColorFor(theme);
    if (theme !== "system") {
      return;
    }
    // Track OS scheme changes while following the system preference.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      themeColor.content = themeColorFor("system");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem("litehouse.motion", motion);
    } catch {
      // Storage may be blocked in privacy-hardened browsers.
    }
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
