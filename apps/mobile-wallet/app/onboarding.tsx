import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ImageBackground,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { walletStore } from "../src/store/wallet-store";
import { getClient, getExternalUserId, invalidateClientCache } from "../src/utils/sdk";
import { createPasskeyWallet, createCustodialWallet, importExistingWallet } from "../src/services/turnkey";
import { Colors, Fonts, Radii } from "../constants/Theme";
import { ArchLogoIcon } from "../src/components/Icons";

type Step = "welcome" | "creating";

export default function OnboardingScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [walletName, setWalletName] = useState("");

  const buildClient = useCallback(async () => {
    invalidateClientCache();
    return getClient();
  }, []);

  const handleCreateWallet = useCallback(async () => {
    setStep("creating");
    setError(null);
    setStatusMessage("Preparing...");

    try {
      const client = await buildClient();
      const externalUserId = await getExternalUserId();

      const account = await createPasskeyWallet(
        client,
        externalUserId,
        walletName,
        { onStatus: setStatusMessage }
      );

      await walletStore.completeOnboarding(account);
      router.replace("/");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to create passkey wallet";
      setError(message);
      setStep("welcome");
    }
  }, [buildClient, walletName, router]);

  const handleCreateCustodial = useCallback(async () => {
    setStep("creating");
    setError(null);
    setStatusMessage("Creating wallet...");

    try {
      const client = await buildClient();
      const externalUserId = await getExternalUserId();

      const account = await createCustodialWallet(
        client,
        externalUserId,
        walletName,
        { onStatus: setStatusMessage }
      );

      await walletStore.completeOnboarding(account);
      router.replace("/");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to create wallet";
      setError(message);
      setStep("welcome");
    }
  }, [buildClient, walletName, router]);

  const handleImportWallet = useCallback(async () => {
    setStep("creating");
    setError(null);
    setStatusMessage("Searching for wallets...");

    try {
      const client = await buildClient();
      const externalUserId = await getExternalUserId();

      const account = await importExistingWallet(
        client,
        externalUserId,
        { onStatus: setStatusMessage }
      );

      await walletStore.completeOnboarding(account);
      router.replace("/");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to import wallet";
      setError(message);
      setStep("welcome");
    }
  }, [buildClient, router]);

  if (step === "creating") {
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
          <SafeAreaView style={styles.creatingContainer}>
            <ActivityIndicator size="large" color={Colors.accent} />
            <Text style={styles.statusText}>{statusMessage}</Text>
          </SafeAreaView>
        </LinearGradient>
      </ImageBackground>
    );
  }

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
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={{ flex: 1 }}
          >
            <ScrollView
              contentContainerStyle={styles.scroll}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.hero}>
                <ArchLogoIcon size={48} color={Colors.accent} />
                <Text style={styles.title}>Arch Wallet</Text>
                <Text style={styles.subtitle}>
                  A self-custodial wallet for Bitcoin, ARCH, and APL tokens on
                  the Arch Network.
                </Text>
              </View>

              {error && (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <View style={styles.section}>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Wallet Name</Text>
                  <TextInput
                    style={styles.input}
                    value={walletName}
                    onChangeText={setWalletName}
                    placeholder="My Wallet"
                    placeholderTextColor={Colors.textMuted}
                    autoCapitalize="words"
                    autoCorrect={false}
                  />
                </View>
              </View>

              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.btnPrimaryWrap}
                  onPress={handleCreateWallet}
                  activeOpacity={0.88}
                >
                  <LinearGradient
                    colors={[Colors.accentHover, Colors.accent, "#9a7840"]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[styles.btn, styles.btnPrimaryGradient]}
                  >
                    <Text style={styles.btnPrimaryText}>
                      Create Wallet with Passkey
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnSecondary]}
                  onPress={handleCreateCustodial}
                  activeOpacity={0.88}
                >
                  <Text style={styles.btnSecondaryText}>
                    Create Custodial Wallet
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnSecondary]}
                  onPress={handleImportWallet}
                  activeOpacity={0.88}
                >
                  <Text style={styles.btnSecondaryText}>
                    Import Existing Wallet
                  </Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </LinearGradient>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  bgImage: {
    flex: 1,
  },
  bgImageInner: {
    opacity: 0.15,
  },
  container: {
    flex: 1,
  },
  creatingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  statusText: {
    color: Colors.textSecondary,
    fontFamily: Fonts.body,
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
  },
  hero: {
    alignItems: "center",
    marginBottom: 32,
  },
  title: {
    fontSize: 24,
    fontFamily: Fonts.display,
    color: Colors.textPrimary,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: Fonts.body,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 21,
    paddingHorizontal: 12,
  },
  errorBanner: {
    backgroundColor: "rgba(220, 53, 69, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(220, 53, 69, 0.4)",
    borderRadius: Radii.sm,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: "#dc3545",
    fontFamily: Fonts.body,
    fontSize: 13,
    textAlign: "center",
  },
  section: {
    marginBottom: 16,
  },
  inputGroup: {
    marginBottom: 12,
  },
  inputLabel: {
    fontSize: 11,
    fontFamily: Fonts.bodySemiBold,
    color: Colors.accent,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  input: {
    backgroundColor: Colors.bgInput,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    borderRadius: Radii.sm,
    color: Colors.textPrimary,
    fontFamily: Fonts.body,
    padding: 12,
    fontSize: 14,
  },
  actions: {
    gap: 12,
    marginTop: 8,
  },
  btn: {
    padding: 14,
    borderRadius: Radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimaryWrap: {
    borderRadius: Radii.md,
    overflow: "hidden",
  },
  btnPrimaryGradient: {
    width: "100%",
  },
  btnPrimaryText: {
    color: Colors.bgPrimary,
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
  },
  btnSecondary: {
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    backgroundColor: "transparent",
  },
  btnSecondaryText: {
    color: Colors.accent,
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
  },
});
