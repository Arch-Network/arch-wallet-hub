import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { copyToClipboard } from "../../src/utils/clipboard";
import QRCode from "react-native-qrcode-svg";
import { Colors, Radii } from "../../constants/Theme";
import { useWallet } from "../../src/hooks/useWallet";
import { truncateAddress } from "../../src/utils/format";
import { reEncodeTaprootAddress } from "../../src/utils/addressNetwork";
import { getClient } from "../../src/utils/sdk";

type AssetTab = "btc" | "arch";

export default function ReceiveScreen() {
  const { activeAccount, state } = useWallet();
  const [tab, setTab] = useState<AssetTab>("btc");
  const [archAddress, setArchAddress] = useState("");
  const [resolvingArch, setResolvingArch] = useState(false);
  const [copied, setCopied] = useState(false);

  const btcAddress = useMemo(
    () =>
      activeAccount
        ? reEncodeTaprootAddress(activeAccount.btcAddress, state.network)
        : "",
    [activeAccount, state.network]
  );

  useEffect(() => {
    if (!activeAccount) return;
    let cancelled = false;
    (async () => {
      setResolvingArch(true);
      try {
        const client = await getClient();
        const overview = await client.getWalletOverview(
          activeAccount.btcAddress,
          { archAddress: activeAccount.archAddress }
        );
        if (!cancelled) {
          const resolved =
            activeAccount.archAddress ?? overview.archAccountAddress ?? "";
          setArchAddress(resolved);
        }
      } catch {
        if (!cancelled) {
          setArchAddress(activeAccount.archAddress ?? "");
        }
      } finally {
        if (!cancelled) setResolvingArch(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAccount]);

  const displayAddress = tab === "btc" ? btcAddress : archAddress;
  const label = tab === "btc" ? "Bitcoin Address" : "Arch Address";

  const handleCopy = useCallback(async () => {
    if (!displayAddress) return;
    await copyToClipboard(displayAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [displayAddress]);

  if (!activeAccount) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.centered}>
          <Text style={styles.muted}>No wallet selected</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Receive</Text>
      </View>

      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, tab === "btc" && styles.tabActive]}
          onPress={() => setTab("btc")}
        >
          <Text style={[styles.tabText, tab === "btc" && styles.tabTextActive]}>
            ₿ Bitcoin
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, tab === "arch" && styles.tabActive]}
          onPress={() => setTab("arch")}
        >
          <Text
            style={[styles.tabText, tab === "arch" && styles.tabTextActive]}
          >
            A ARCH
          </Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        <View style={styles.qrContainer}>
          {displayAddress ? (
            <QRCode
              value={displayAddress}
              size={180}
              backgroundColor="#ffffff"
              color="#000000"
              quietZone={10}
            />
          ) : tab === "arch" && resolvingArch ? (
            <ActivityIndicator color={Colors.accent} size="large" />
          ) : (
            <Text style={styles.muted}>
              {tab === "arch"
                ? "Resolving Arch address…"
                : "No address available"}
            </Text>
          )}
        </View>

        <Text style={styles.fieldLabel}>{label}</Text>

        {displayAddress ? (
          <View style={styles.addressCard}>
            <Text selectable style={styles.addressFull}>
              {displayAddress}
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.copyBtn,
                pressed && styles.copyBtnPressed,
              ]}
              onPress={handleCopy}
            >
              <Text style={styles.copyBtnText}>
                {copied ? "Copied" : "Copy"}
              </Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.mutedSmall}>
            {tab === "arch"
              ? "Fund this account with an airdrop from the Dashboard to initialize your Arch address."
              : ""}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
  },
  header: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  tabs: {
    flexDirection: "row",
    marginHorizontal: 14,
    marginBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderPrimary,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: Colors.accent,
  },
  tabText: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.textMuted,
  },
  tabTextActive: {
    color: Colors.accent,
  },
  body: {
    paddingHorizontal: 14,
    alignItems: "stretch",
  },
  qrContainer: {
    width: 200,
    height: 200,
    alignSelf: "center",
    backgroundColor: "#ffffff",
    borderRadius: Radii.lg,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textSecondary,
    textAlign: "center",
    marginBottom: 10,
  },
  addressCard: {
    backgroundColor: Colors.bgCard,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    padding: 14,
  },
  addressFull: {
    fontSize: 13,
    lineHeight: 20,
    color: Colors.textPrimary,
    fontFamily: "monospace",
    textAlign: "center",
    marginBottom: 14,
  },
  copyBtn: {
    alignSelf: "center",
    backgroundColor: Colors.accentGlow,
    borderWidth: 1,
    borderColor: Colors.borderAccent,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: Radii.md,
  },
  copyBtnPressed: {
    backgroundColor: Colors.bgHover,
  },
  copyBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.accent,
  },
  muted: {
    color: Colors.textMuted,
    fontSize: 14,
    textAlign: "center",
  },
  mutedSmall: {
    color: Colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    lineHeight: 16,
    paddingHorizontal: 8,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
});
