import { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Radii } from "../../constants/Theme";
import { useWallet } from "../../src/hooks/useWallet";
import { walletStore } from "../../src/store/wallet-store";
import { invalidateClientCache } from "../../src/utils/sdk";
import { truncateAddress } from "../../src/utils/format";

const APP_VERSION = "1.0.0";

export default function SettingsScreen() {
  const { state, activeAccount, setNetwork, lock } = useWallet();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current && state.apiBaseUrl) {
      setBaseUrl(state.apiBaseUrl);
      setApiKey(state.apiKey);
      initialized.current = true;
    }
  }, [state.apiBaseUrl, state.apiKey]);

  const isMainnet = state.network === "mainnet";

  const toggleNetwork = async () => {
    await setNetwork(isMainnet ? "testnet4" : "mainnet");
  };

  const saveApiConfig = async () => {
    await walletStore.setApiConfig(baseUrl, apiKey);
    invalidateClientCache();
    Alert.alert("Saved", "API configuration updated.");
  };

  const handleLock = async () => {
    await lock();
  };

  const handleReset = () => {
    Alert.alert(
      "Reset Wallet",
      "This will delete all wallet data. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            await walletStore.reset();
            invalidateClientCache();
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Settings</Text>

        {/* Network */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Network</Text>
          <View style={styles.row}>
            <Text style={styles.label}>
              {isMainnet ? "Mainnet" : "Testnet"}
            </Text>
            <Switch
              value={isMainnet}
              onValueChange={toggleNetwork}
              trackColor={{ false: Colors.bgHover, true: Colors.accent }}
              thumbColor={Colors.textPrimary}
            />
          </View>
        </View>

        {/* Active Wallet */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Active Wallet</Text>
          {activeAccount ? (
            <>
              <Text style={styles.value}>{activeAccount.label}</Text>
              <Text style={styles.mono}>
                BTC: {truncateAddress(activeAccount.btcAddress)}
              </Text>
              {activeAccount.archAddress && (
                <Text style={styles.mono}>
                  Arch: {truncateAddress(activeAccount.archAddress)}
                </Text>
              )}
            </>
          ) : (
            <Text style={styles.muted}>No wallet active</Text>
          )}
        </View>

        {/* API Configuration */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>API Configuration</Text>

          <Text style={styles.inputLabel}>Base URL</Text>
          <TextInput
            style={styles.input}
            value={baseUrl}
            onChangeText={setBaseUrl}
            placeholder="http://localhost:3005"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.inputLabel}>API Key</Text>
          <TextInput
            style={styles.input}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="Enter API key"
            placeholderTextColor={Colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <TouchableOpacity style={styles.secondaryBtn} onPress={saveApiConfig}>
            <Text style={styles.secondaryBtnText}>Save</Text>
          </TouchableOpacity>
        </View>

        {/* Actions */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Security</Text>

          <TouchableOpacity style={styles.actionRow} onPress={handleLock}>
            <Text style={styles.actionText}>Lock Wallet</Text>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionRow} onPress={handleReset}>
            <Text style={[styles.actionText, { color: Colors.danger }]}>
              Reset Wallet
            </Text>
            <Text style={[styles.chevron, { color: Colors.danger }]}>›</Text>
          </TouchableOpacity>
        </View>

        {/* Version */}
        <Text style={styles.version}>Arch Wallet v{APP_VERSION}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgPrimary },
  container: { padding: 14, paddingBottom: 40 },
  title: {
    color: Colors.textPrimary,
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 20,
  },
  card: {
    backgroundColor: Colors.bgCard,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    color: Colors.accent,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: { color: Colors.textPrimary, fontSize: 15 },
  value: { color: Colors.textPrimary, fontSize: 15, fontWeight: "600" },
  mono: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontFamily: "monospace",
    marginTop: 4,
  },
  muted: { color: Colors.textMuted, fontSize: 14 },
  inputLabel: {
    color: Colors.accent,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  input: {
    backgroundColor: Colors.bgInput,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    borderRadius: Radii.sm,
    padding: 12,
    fontSize: 14,
    marginBottom: 12,
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: Colors.accent,
    backgroundColor: "transparent",
    borderRadius: Radii.sm,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryBtnText: { color: Colors.accent, fontWeight: "600", fontSize: 14 },
  actionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderPrimary,
  },
  actionText: { color: Colors.textPrimary, fontSize: 15 },
  chevron: { color: Colors.textMuted, fontSize: 20 },
  version: {
    color: Colors.textMuted,
    fontSize: 12,
    textAlign: "center",
    marginTop: 24,
  },
});
