import { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ImageBackground,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import * as LocalAuthentication from "expo-local-authentication";
import { walletStore } from "../src/store/wallet-store";
import { Colors, Fonts, Radii } from "../constants/Theme";
import { ArchLogoIcon } from "../src/components/Icons";

type UnlockSupport =
  | { state: "unknown" }
  | { state: "supported"; types: LocalAuthentication.AuthenticationType[] }
  | { state: "not_supported"; reason: string };

export default function UnlockScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [support, setSupport] = useState<UnlockSupport>({ state: "unknown" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (cancelled) return;
      if (!hasHardware) {
        setSupport({ state: "not_supported", reason: "No biometric hardware on this device" });
        return;
      }
      if (!enrolled) {
        setSupport({
          state: "not_supported",
          reason: "No biometric / device PIN enrolled. Enable one in system Settings.",
        });
        return;
      }
      const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
      setSupport({ state: "supported", types });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUnlock() {
    if (support.state === "not_supported") {
      Alert.alert("Unlock unavailable", support.reason);
      return;
    }
    setLoading(true);
    try {
      // SECURITY: previously this screen called `walletStore.unlock()`
      // unconditionally on any tap. Anyone with the phone could open
      // the wallet. We now require an OS-backed user-verification
      // step (Face ID / Touch ID / device PIN) BEFORE flipping the
      // store to unlocked.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock Arch Wallet",
        cancelLabel: "Cancel",
        // We accept device passcode as a fallback so users without
        // biometrics enrolled (e.g. fingerprint sensor turned off
        // due to too many failed attempts) can still unlock.
        disableDeviceFallback: false,
        // On Android: keep biometric prompt strong (Class 3 only)
        // so weak face recognition can't bypass the gate.
        requireConfirmation: Platform.OS === "android",
      });
      if (!result.success) {
        Alert.alert("Unlock failed", "Authentication was cancelled or denied.");
        return;
      }
      await walletStore.unlock();
      router.replace("/");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Could not unlock wallet";
      Alert.alert("Unlock failed", message);
    } finally {
      setLoading(false);
    }
  }

  const supportNotice =
    support.state === "not_supported" ? (
      <Text style={styles.warning}>{support.reason}</Text>
    ) : null;

  return (
    <ImageBackground
      source={require("../assets/images/hero-bg.jpg")}
      style={styles.bgImage}
      imageStyle={styles.bgImageInner}
      resizeMode="cover"
    >
      <LinearGradient
        colors={[
          "rgba(14,12,10,0.6)",
          "rgba(14,12,10,0.3)",
          "rgba(14,12,10,0.6)",
          Colors.bgPrimary,
        ]}
        locations={[0, 0.3, 0.7, 1]}
        style={{ flex: 1 }}
      >
        <SafeAreaView style={styles.container}>
          <View style={styles.content}>
            <ArchLogoIcon size={64} color={Colors.accent} />
            <Text style={styles.title}>Arch Wallet</Text>
            <Text style={styles.subtitle}>Wallet is locked</Text>
            {supportNotice}
            <TouchableOpacity
              style={[
                styles.unlockBtn,
                support.state === "not_supported" && styles.unlockBtnDisabled,
              ]}
              onPress={handleUnlock}
              disabled={loading || support.state === "not_supported"}
            >
              {loading ? (
                <ActivityIndicator color={Colors.bgPrimary} />
              ) : (
                <Text style={styles.unlockBtnText}>Unlock with biometrics</Text>
              )}
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </LinearGradient>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  bgImage: { flex: 1 },
  bgImageInner: { opacity: 0.15 },
  container: { flex: 1 },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  logo: { marginBottom: 16 },
  title: {
    fontSize: 28,
    fontFamily: Fonts.display,
    color: Colors.textPrimary,
    marginBottom: 8,
    marginTop: 16,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: Fonts.body,
    color: Colors.textMuted,
    marginBottom: 16,
  },
  warning: {
    color: Colors.danger,
    fontSize: 13,
    textAlign: "center",
    marginBottom: 24,
    maxWidth: 280,
    lineHeight: 18,
  },
  unlockBtn: {
    backgroundColor: Colors.accent,
    paddingVertical: 14,
    paddingHorizontal: 48,
    borderRadius: Radii.md,
    alignItems: "center",
  },
  unlockBtnDisabled: {
    opacity: 0.4,
  },
  unlockBtnText: {
    color: Colors.bgPrimary,
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
  },
});
