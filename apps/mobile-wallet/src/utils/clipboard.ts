import { Platform } from "react-native";

/**
 * Cross-platform clipboard write that doesn't crash if
 * the native ExpoClipboard module isn't linked.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fallback below
    }
  }

  try {
    const ExpoClipboard = require("expo-clipboard");
    await ExpoClipboard.setStringAsync(text);
  } catch {
    // expo-clipboard native module not available; try deprecated RN API
    try {
      const { Clipboard } = require("react-native");
      if (Clipboard?.setString) {
        Clipboard.setString(text);
      }
    } catch {
      // silently fail
    }
  }
}
