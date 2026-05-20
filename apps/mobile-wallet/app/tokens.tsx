import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Colors, Radii } from "../constants/Theme";
import { useWallet } from "../src/hooks/useWallet";
import { getClient } from "../src/utils/sdk";
import { formatTokenAmount } from "../src/utils/format";

interface TokenRow {
  id: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  iconColor: string;
}

const PALETTE = [
  Colors.aplGold,
  Colors.archBlue,
  Colors.btcOrange,
  Colors.success,
  Colors.warning,
];

export default function TokensScreen() {
  const router = useRouter();
  const { activeAccount } = useWallet();

  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTokens = useCallback(async () => {
    if (!activeAccount) return;
    setLoading(true);
    try {
      const client = await getClient();
      const addr = activeAccount.btcAddress;
      const result = await client.getAccountTokens(addr);

      if (Array.isArray(result)) {
        setTokens(
          result.map((t: any, i: number) => ({
            id: t.mint ?? t.id ?? String(i),
            symbol: t.symbol ?? "???",
            name: t.name ?? t.symbol ?? "Unknown Token",
            balance: t.amount ?? t.balance ?? 0,
            decimals: t.decimals ?? 0,
            iconColor: PALETTE[i % PALETTE.length],
          }))
        );
      } else {
        setTokens([]);
      }
    } catch {
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, [activeAccount]);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const renderToken = ({ item }: { item: TokenRow }) => (
    <View style={styles.row}>
      <View style={[styles.icon, { backgroundColor: item.iconColor }]}>
        <Text style={styles.iconText}>{item.symbol.charAt(0)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.symbol}>{item.name}</Text>
        <Text style={styles.name}>
          {item.id.length > 10
            ? `${item.id.slice(0, 4)}..${item.id.slice(-4)}`
            : item.id}
        </Text>
      </View>
      <Text style={styles.balance}>
        {formatTokenAmount(item.balance, item.decimals)}
      </Text>
      <Text style={styles.chevron}>›</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={styles.backArrow}>←</Text>
          <Text style={styles.back}>Home</Text>
        </TouchableOpacity>
        <Text style={styles.title}>APL Tokens</Text>
        <View style={{ width: 70 }} />
      </View>

      {!loading && tokens.length > 0 && (
        <Text style={styles.countLabel}>{tokens.length} token{tokens.length !== 1 ? "s" : ""}</Text>
      )}

      {loading ? (
        <ActivityIndicator
          size="large"
          color={Colors.accent}
          style={{ marginTop: 40 }}
        />
      ) : tokens.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🪙</Text>
          <Text style={styles.emptyTitle}>No Tokens</Text>
          <Text style={styles.emptyText}>
            APL tokens you hold will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={tokens}
          keyExtractor={(item) => item.id}
          renderItem={renderToken}
          contentContainerStyle={{ padding: 16 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgPrimary },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 12,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 70,
  },
  backArrow: { color: Colors.accent, fontSize: 20, fontWeight: "600" },
  back: { color: Colors.accent, fontSize: 15, fontWeight: "600" },
  title: {
    color: Colors.textPrimary,
    fontSize: 18,
    fontWeight: "700",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.bgCard,
    borderRadius: Radii.md,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  iconText: { color: Colors.bgPrimary, fontWeight: "700", fontSize: 16 },
  symbol: { color: Colors.textPrimary, fontSize: 15, fontWeight: "600" },
  name: { color: Colors.textMuted, fontSize: 12, marginTop: 2 },
  balance: { color: Colors.accent, fontSize: 15, fontWeight: "600" },
  chevron: { color: Colors.textMuted, fontSize: 22, marginLeft: 8 },
  countLabel: {
    color: Colors.textMuted,
    fontSize: 12,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: {
    color: Colors.textPrimary,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 8,
  },
  emptyText: {
    color: Colors.textMuted,
    fontSize: 14,
    textAlign: "center",
  },
});
