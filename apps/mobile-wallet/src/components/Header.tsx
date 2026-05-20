import { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { copyToClipboard } from "../utils/clipboard";
import { Colors, Fonts, Radii } from "../../constants/Theme";
import type { WalletAccount, NetworkId } from "../store/types";
import type { NetworkStatus } from "../hooks/useApiStatus";
import { truncateAddress } from "../utils/format";
import { reEncodeTaprootAddress } from "../utils/addressNetwork";
import { ArchLogoIcon } from "./Icons";

interface HeaderProps {
  account: WalletAccount | null;
  network: NetworkId;
  networkStatus: NetworkStatus;
  onLock: () => void;
}

function NetworkDot({ status }: { status: NetworkStatus }) {
  let color = Colors.success;
  if (status.api === "checking") color = Colors.warning;
  else if (status.api === "disconnected") color = Colors.danger;
  else if (status.bitcoin === "disconnected" && status.arch === "disconnected") color = Colors.danger;
  else if (status.bitcoin === "disconnected" || status.arch === "disconnected") color = Colors.warning;

  return <View style={[styles.networkDot, { backgroundColor: color, shadowColor: color }]} />;
}

export default function Header({ account, network, networkStatus, onLock }: HeaderProps) {
  const [copied, setCopied] = useState(false);

  const displayAddress = useMemo(
    () => (account ? reEncodeTaprootAddress(account.btcAddress, network) : ""),
    [account, network]
  );

  const handleCopy = async () => {
    if (!displayAddress) return;
    await copyToClipboard(displayAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const pillBorderColor =
    networkStatus.api === "disconnected"
      ? "rgba(217, 83, 79, 0.25)"
      : networkStatus.bitcoin === "disconnected" || networkStatus.arch === "disconnected"
        ? "rgba(230, 168, 23, 0.25)"
        : "rgba(193, 154, 91, 0.12)";

  return (
    <View style={styles.header}>
      <View style={styles.headerInner}>
        {/* Brand */}
        <View style={styles.brand}>
          <ArchLogoIcon size={24} color={Colors.accent} />
          <Text style={styles.brandText}>{"Arch\nNetwork"}</Text>
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          {/* Network pill */}
          <View style={[styles.networkPill, { borderColor: pillBorderColor }]}>
            <NetworkDot status={networkStatus} />
            <Text style={styles.networkPillText}>
              {network === "testnet4" ? "TESTNET" : "MAINNET"}
            </Text>
          </View>

          {/* Address chip */}
          {account && displayAddress ? (
            <Pressable style={styles.addressChip} onPress={handleCopy}>
              <Text style={styles.addressText}>
                {copied ? "Copied!" : truncateAddress(displayAddress, 4)}
              </Text>
              <Text style={styles.copyIcon}>📋</Text>
            </Pressable>
          ) : null}

          {/* Lock button */}
          <Pressable style={styles.lockBtn} onPress={onLock}>
            <Text style={styles.lockIcon}>🔒</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 10,
    paddingTop: 4,
    paddingBottom: 8,
    backgroundColor: Colors.bgPrimary,
  },
  headerInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: "rgba(22, 20, 18, 0.7)",
    borderWidth: 1,
    borderColor: "rgba(193, 154, 91, 0.15)",
    borderRadius: Radii.lg,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  brandText: {
    fontSize: 11,
    fontFamily: Fonts.bodyBold,
    color: Colors.textPrimary,
    lineHeight: 13,
    letterSpacing: 0.2,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginLeft: "auto",
  },
  networkPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: "rgba(30, 28, 26, 0.8)",
    borderWidth: 1,
  },
  networkDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  networkPillText: {
    fontSize: 9,
    fontFamily: Fonts.bodyBold,
    color: Colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  addressChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    backgroundColor: "rgba(30, 28, 26, 0.8)",
    borderWidth: 1,
    borderColor: "rgba(193, 154, 91, 0.12)",
    borderRadius: 20,
  },
  addressText: {
    fontFamily: Fonts.mono,
    fontSize: 10,
    color: Colors.textSecondary,
    letterSpacing: 0.2,
  },
  copyIcon: {
    fontSize: 10,
  },
  lockBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: "rgba(92, 184, 92, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(92, 184, 92, 0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  lockIcon: {
    fontSize: 12,
  },
});
