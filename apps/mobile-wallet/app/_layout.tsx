import { useEffect, useRef } from "react";
import {
  AppState,
  AppStateStatus,
  View,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { walletStore } from "../src/store/wallet-store";
import { useFonts } from "expo-font";
import {
  PlayfairDisplay_700Bold,
  PlayfairDisplay_800ExtraBold,
} from "@expo-google-fonts/playfair-display";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from "@expo-google-fonts/dm-sans";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from "@expo-google-fonts/jetbrains-mono";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useWallet } from "../src/hooks/useWallet";
import { Colors } from "../constants/Theme";

export { ErrorBoundary } from "expo-router";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
    PlayfairDisplay_700Bold,
    PlayfairDisplay_800ExtraBold,
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  useEffect(() => {
    if (fontError) throw fontError;
  }, [fontError]);

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return <RootNav />;
}

function RootNav() {
  const { state, loading } = useWallet();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    if (!state.initialized) {
      router.replace("/onboarding");
    } else if (state.locked) {
      router.replace("/unlock");
    } else {
      router.replace("/(tabs)");
    }
  }, [loading, state.initialized, state.locked]);

  // SECURITY: re-lock the wallet whenever the OS sends us to the
  // background. Without this, a stolen device with the wallet open
  // gives an attacker an unbounded signing window. We use a 30s grace
  // for the iOS "scroll up to app-switcher" + return case so the user
  // isn't re-prompted constantly during normal multitasking, but we
  // unconditionally lock on a real `background` (app sent to
  // background, screen locked, or task killed).
  const lastBgTs = useRef<number>(0);
  useEffect(() => {
    if (loading || !state.initialized || state.locked) return;
    const onChange = (next: AppStateStatus) => {
      if (next === "background") {
        lastBgTs.current = Date.now();
        walletStore.lock().catch(() => {});
      } else if (next === "inactive") {
        // Note: on iOS, transient inactive states (notifications,
        // control center pull) shouldn't lock the wallet. We snapshot
        // the timestamp so a follow-on `background` knows it was a
        // real backgrounding.
        lastBgTs.current = Date.now();
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => {
      sub.remove();
    };
  }, [loading, state.initialized, state.locked]);

  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color={Colors.accent} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: Colors.bgPrimary },
          animation: "fade",
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
        <Stack.Screen name="unlock" options={{ gestureEnabled: false }} />
        <Stack.Screen
          name="tokens"
          options={{ animation: "slide_from_right", gestureEnabled: true }}
        />
        <Stack.Screen name="approve" options={{ presentation: "modal" }} />
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  loader: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Colors.bgPrimary,
  },
});
