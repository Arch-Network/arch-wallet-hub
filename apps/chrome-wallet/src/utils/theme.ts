// Theme system: system-following by default with a manual Light/Dark/System
// override (a "locked decision" in the rebrand).
//
// WHY chrome.storage.local (not the encrypted keystore): the theme must be
// resolvable at app bootstrap and on the locked screens (Unlock / Onboarding),
// before any password is entered. The keystore is sealed at that point, so the
// preference lives in plaintext `chrome.storage.local` alongside other
// bootstrap-time hints (install id, last route). It carries no sensitive data.

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_KEY = "arch_wallet_theme";

function isThemePreference(v: unknown): v is ThemePreference {
  return v === "light" || v === "dark" || v === "system";
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Resolve a (possibly "system") preference into a concrete theme. */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

/** Paint the resolved theme onto <html> so the CSS token layer switches. */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

/** Read the stored preference (defaults to "system"). */
export async function getThemePreference(): Promise<ThemePreference> {
  try {
    const res = await chrome.storage.local.get(THEME_KEY);
    const value = res?.[THEME_KEY];
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

/** Persist a preference and apply it immediately in this realm. */
export async function setThemePreference(pref: ThemePreference): Promise<void> {
  applyResolvedTheme(resolveTheme(pref));
  try {
    await chrome.storage.local.set({ [THEME_KEY]: pref });
  } catch {
    /* best-effort; the in-memory apply above already took effect */
  }
}

/**
 * Synchronous first paint: apply the OS preference immediately so "system"
 * users (the default) never see a flash of the wrong theme while the async
 * stored-preference read is in flight.
 */
export function applySystemThemeImmediately(): void {
  applyResolvedTheme(systemPrefersDark() ? "dark" : "light");
}

let mediaListenerAttached = false;

/**
 * Bootstrap the theme: apply the stored preference, and — while the user is
 * on "system" — keep following live OS changes. Call once at app start, after
 * `applySystemThemeImmediately()`.
 */
export async function bootstrapTheme(): Promise<void> {
  const pref = await getThemePreference();
  applyResolvedTheme(resolveTheme(pref));

  if (
    !mediaListenerAttached &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    mediaListenerAttached = true;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", async () => {
      // Only auto-track the OS when the user hasn't pinned a theme.
      if ((await getThemePreference()) === "system") {
        applyResolvedTheme(systemPrefersDark() ? "dark" : "light");
      }
    });
  }
}
