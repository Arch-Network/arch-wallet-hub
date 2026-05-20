import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Radii } from "../../constants/Theme";
import { useWallet } from "../../src/hooks/useWallet";
import { getClient } from "../../src/utils/sdk";
import { truncateAddress, formatTimestamp, btcTxTimestampMs } from "../../src/utils/format";

type TabId = "all" | "arch" | "btc";

interface TxRow {
  id: string;
  txid: string;
  direction: "in" | "out";
  timestamp: string;
  status: string;
  chain: "arch" | "btc";
}

const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "arch", label: "Arch" },
  { id: "btc", label: "BTC" },
];

export default function HistoryScreen() {
  const { activeAccount } = useWallet();

  const [tab, setTab] = useState<TabId>("all");
  const [rows, setRows] = useState<TxRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    if (!activeAccount) return;
    setLoading(true);
    try {
      const client = await getClient();
      const addr = activeAccount.btcAddress;
      const [archTxs, btcTxs] = await Promise.allSettled([
        client.getTransactionHistory(addr),
        client.getBtcTransactions(addr),
      ]);

      const combined: TxRow[] = [];

      if (archTxs.status === "fulfilled" && archTxs.value) {
        const archList =
          Array.isArray(archTxs.value)
            ? archTxs.value
            : Array.isArray((archTxs.value as any).transactions)
              ? (archTxs.value as any).transactions
              : [];

        for (const tx of archList) {
          const raw = tx as any;
          const statusObj = raw.status;
          let statusStr = "confirmed";
          if (typeof statusObj === "string") {
            statusStr = statusObj;
          } else if (typeof statusObj === "object" && statusObj !== null) {
            const keys = Object.keys(statusObj);
            if (keys.includes("Processing") || keys.includes("Pending")) {
              statusStr = "pending";
            } else if (keys.includes("Failed") || keys.includes("Rejected")) {
              statusStr = "failed";
            }
          }

          combined.push({
            id: raw.txid ?? String(Math.random()),
            txid: raw.txid ?? "",
            direction: raw.from_address === activeAccount?.btcAddress ? "out" : "in",
            timestamp: raw.confirmed_at ?? raw.created_at ?? "",
            status: statusStr,
            chain: "arch",
          });
        }
      }

      if (btcTxs.status === "fulfilled" && Array.isArray(btcTxs.value)) {
        const fullTxs = await Promise.all(
          btcTxs.value.map(async (entry: any) => {
            if (typeof entry === "object" && entry.txid) return entry;
            const txid = typeof entry === "string" ? entry : null;
            if (!txid) return null;
            try {
              return await client.getBtcTransaction(txid);
            } catch {
              return { txid };
            }
          })
        );

        for (const tx of fullTxs) {
          if (!tx) continue;
          const raw = tx as any;
          const statusObj = raw.status;
          const isConfirmed =
            typeof statusObj === "object" && statusObj !== null
              ? Boolean(statusObj.confirmed)
              : statusObj === "confirmed" || statusObj === "success";

          const ms = btcTxTimestampMs(raw);
          const timestampIso = ms != null ? new Date(ms).toISOString() : "";

          combined.push({
            id: raw.txid ?? String(Math.random()),
            txid: raw.txid ?? "",
            direction: raw.direction === "in" ? "in" : "out",
            timestamp: timestampIso,
            status: isConfirmed ? "confirmed" : "pending",
            chain: "btc",
          });
        }
      }

      combined.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      setRows(combined);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [activeAccount]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const filtered =
    tab === "all" ? rows : rows.filter((r) => r.chain === tab);

  const statusColor = (s: string) => {
    if (s === "confirmed" || s === "success") return Colors.success;
    if (s === "pending") return Colors.warning;
    if (s === "failed") return Colors.danger;
    return Colors.textMuted;
  };

  const renderRow = ({ item }: { item: TxRow }) => (
    <View style={styles.txRow}>
      <View style={styles.directionBadge}>
        <Text style={styles.directionIcon}>
          {item.direction === "in" ? "↓" : "↑"}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.txid}>{truncateAddress(item.txid, 8)}</Text>
        <Text style={styles.txTime}>{formatTimestamp(item.timestamp)}</Text>
      </View>
      <View style={[styles.statusBadge, { borderColor: statusColor(item.status) }]}>
        <Text style={[styles.statusText, { color: statusColor(item.status), textTransform: "uppercase" }]}>
          {item.status}
        </Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
      </View>

      <View style={styles.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[styles.tab, tab === t.id && styles.tabActive]}
            onPress={() => setTab(t.id)}
          >
            <Text
              style={[styles.tabLabel, tab === t.id && styles.tabLabelActive]}
            >
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator
          size="large"
          color={Colors.accent}
          style={{ marginTop: 40 }}
        />
      ) : filtered.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No transactions found</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={renderRow}
          contentContainerStyle={{ padding: 14 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgPrimary },
  header: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: {
    color: Colors.textPrimary,
    fontSize: 28,
    fontWeight: "700",
  },
  tabs: {
    flexDirection: "row",
    marginHorizontal: 14,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderPrimary,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: Colors.accent },
  tabLabel: { color: Colors.textMuted, fontSize: 13, fontWeight: "600" },
  tabLabelActive: { color: Colors.accent },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.bgCard,
    borderRadius: Radii.md,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
  },
  directionBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.bgHover,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  directionIcon: { color: Colors.accent, fontSize: 16, fontWeight: "700" },
  txid: { color: Colors.textPrimary, fontSize: 14, fontWeight: "600" },
  txTime: { color: Colors.textMuted, fontSize: 12, marginTop: 2 },
  statusBadge: {
    borderWidth: 1,
    borderRadius: Radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusText: { fontSize: 11, fontWeight: "600" },
  empty: { flex: 1, justifyContent: "center", alignItems: "center" },
  emptyText: { color: Colors.textMuted, fontSize: 15 },
});
