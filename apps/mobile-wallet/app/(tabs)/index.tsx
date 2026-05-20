import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Colors, Fonts, Radii } from "../../constants/Theme";
import { useWallet } from "../../src/hooks/useWallet";
import { useApiStatus } from "../../src/hooks/useApiStatus";
import { getClient } from "../../src/utils/sdk";
import Header from "../../src/components/Header";
import ConnectionBanner from "../../src/components/ConnectionBanner";
import {
  ArchLogoIcon,
  SendIcon,
  ReceiveIcon,
  AirdropIcon,
  SpinnerIcon,
  TokensIcon,
} from "../../src/components/Icons";
import {
  formatArch,
  formatArchId,
  formatBtc,
  formatTimestamp,
  formatTokenAmount,
  truncateAddress,
  btcTxTimestampMs,
} from "../../src/utils/format";

interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
}

interface RecentTx {
  txid: string;
  type: "arch" | "btc";
  direction: "in" | "out" | "unknown";
  timestamp?: string;
  status: string;
}

function usePulseOpacity() {
  const opacity = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.9,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 700,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return opacity;
}

function SkeletonBox({
  style,
  pulse,
}: {
  style?: StyleProp<ViewStyle>;
  pulse: Animated.Value;
}) {
  return <Animated.View style={[style, { opacity: pulse }]} />;
}

function PortfolioRowSkeleton({ pulse }: { pulse: Animated.Value }) {
  return (
    <View style={styles.assetRow}>
      <SkeletonBox pulse={pulse} style={[styles.skel, styles.skelIcon]} />
      <View style={styles.assetInfo}>
        <SkeletonBox
          pulse={pulse}
          style={[styles.skel, styles.skelBar, { width: "55%", marginBottom: 6 }]}
        />
        <SkeletonBox
          pulse={pulse}
          style={[styles.skel, styles.skelBar, { width: "35%", height: 10 }]}
        />
      </View>
      <SkeletonBox
        pulse={pulse}
        style={[styles.skel, { width: 72, height: 16, borderRadius: 4 }]}
      />
    </View>
  );
}

function TxRowSkeleton({ pulse }: { pulse: Animated.Value }) {
  return (
    <View style={styles.txRow}>
      <SkeletonBox pulse={pulse} style={[styles.skel, styles.skelTxIcon]} />
      <View style={styles.txInfo}>
        <SkeletonBox
          pulse={pulse}
          style={[styles.skel, styles.skelBar, { width: "65%", marginBottom: 6 }]}
        />
        <SkeletonBox
          pulse={pulse}
          style={[styles.skel, styles.skelBar, { width: "40%", height: 10 }]}
        />
      </View>
      <SkeletonBox
        pulse={pulse}
        style={[styles.skel, { width: 64, height: 22, borderRadius: Radii.sm }]}
      />
    </View>
  );
}

function parseBtcSats(btcSummary: unknown): { confirmed: number; pending: number } {
  const s = btcSummary as Record<string, unknown> | null | undefined;
  if (!s) return { confirmed: 0, pending: 0 };

  const chain = s.chain_stats as Record<string, number> | undefined;
  if (chain) {
    const mempool = s.mempool_stats as Record<string, number> | undefined;
    const confirmed =
      (chain.funded_txo_sum ?? 0) - (chain.spent_txo_sum ?? 0);
    const pending =
      (mempool?.funded_txo_sum ?? 0) - (mempool?.spent_txo_sum ?? 0);
    return { confirmed, pending };
  }

  const outputs = s.outputs as Array<{
    value?: number;
    spent?: { spent?: boolean };
    status?: { confirmed?: boolean };
  }> | undefined;
  if (Array.isArray(outputs)) {
    let confirmed = 0;
    let pending = 0;
    for (const utxo of outputs) {
      const val = Number(utxo.value ?? 0);
      if (utxo.spent?.spent) continue;
      if (utxo.status?.confirmed) confirmed += val;
      else pending += val;
    }
    return { confirmed, pending };
  }

  if (typeof s.value === "number") {
    return { confirmed: s.value, pending: 0 };
  }

  return { confirmed: 0, pending: 0 };
}

export default function DashboardScreen() {
  const router = useRouter();
  const { activeAccount, state, lock } = useWallet();
  const pulse = usePulseOpacity();
  const { status: networkStatus, retry: retryApi } = useApiStatus();

  const [btcBalance, setBtcBalance] = useState<number | null>(null);
  const [btcPending, setBtcPending] = useState(0);
  const [archLamports, setArchLamports] = useState<number | null>(null);
  const [archAddress, setArchAddress] = useState("");
  const [tokens, setTokens] = useState<TokenBalance[] | null>(null);
  const [recentTxs, setRecentTxs] = useState<RecentTx[] | null>(null);

  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [tokensLoaded, setTokensLoaded] = useState(false);
  const [txsLoaded, setTxsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [airdropLoading, setAirdropLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const isTestnet = state.network === "testnet4";
  const balancesReady = overviewLoaded;

  const fetchAll = useCallback(
    async (opts?: { noCache?: boolean }) => {
      if (!activeAccount) return;
      const addr = activeAccount.btcAddress;
      if (!addr) {
        setOverviewLoaded(true);
        setTokensLoaded(true);
        setTxsLoaded(true);
        setBtcBalance(0);
        setArchLamports(0);
        setTokens([]);
        setRecentTxs([]);
        return;
      }
      setError(null);

      const client = await getClient();

      const overviewPromise = client
        .getWalletOverview(addr, {
          noCache: opts?.noCache,
          archAddress: activeAccount.archAddress,
        })
        .then((overview) => {
          const btcSummary = overview?.btc?.summary;
          const { confirmed, pending } = parseBtcSats(btcSummary);
          const acc = overview?.arch?.account as
            | { lamports_balance?: number; balance?: string }
            | null
            | undefined;
          const lamports =
            acc?.lamports_balance ??
            (acc?.balance != null ? parseInt(String(acc.balance), 10) : 0) ??
            0;
          const archAddr =
            activeAccount.archAddress ?? overview?.archAccountAddress ?? "";

          setBtcBalance(confirmed);
          setBtcPending(pending);
          setArchLamports(Number.isFinite(lamports) ? lamports : 0);
          setArchAddress(archAddr);
          setOverviewLoaded(true);

          const btcTxItems: RecentTx[] = [];
          const outputs = Array.isArray((btcSummary as any)?.outputs)
            ? (btcSummary as any).outputs
            : [];
          const seen = new Set<string>();
          for (const o of outputs) {
            const txid = o?.txid;
            if (!txid || seen.has(txid)) continue;
            seen.add(txid);
            const oTime = btcTxTimestampMs(o);
            btcTxItems.push({
              txid,
              type: "btc",
              direction: "in",
              timestamp: oTime != null ? String(oTime) : undefined,
              status: o.status?.confirmed ? "confirmed" : "pending",
            });
          }

          const archTxItems: RecentTx[] = (
            (overview?.arch as any)?.recentTransactions?.transactions ?? []
          )
            .slice(0, 5)
            .map((raw: any) => {
              const st = raw.status as Record<string, unknown> | undefined;
              return {
                txid: String(raw.txid ?? ""),
                type: "arch" as const,
                direction: "unknown" as const,
                timestamp: raw.created_at as string | undefined,
                status: String(
                  st?.type ?? (raw.block_height ? "confirmed" : "pending")
                ),
              };
            });

          const merged = [...archTxItems, ...btcTxItems];
          merged.sort((a, b) => {
            const ta = a.timestamp
              ? new Date(Number(a.timestamp) || a.timestamp).getTime()
              : 0;
            const tb = b.timestamp
              ? new Date(Number(b.timestamp) || b.timestamp).getTime()
              : 0;
            return tb - ta;
          });
          setRecentTxs(merged.slice(0, 5));
          setTxsLoaded(true);
        })
        .catch((e: Error) => {
          const msg = e?.message || "Failed to load balances";
          const isNetworkError = /fetch|network|ECONNREFUSED|abort/i.test(msg);
          if (!isNetworkError) setError(msg);
          setOverviewLoaded(true);
          setTxsLoaded(true);
        });

      const tokensPromise = client
        .getAccountTokens(addr)
        .then((res) => {
          const list = (res as { tokens?: unknown[] })?.tokens ?? [];
          setTokens(
            list.map((raw) => {
              const t = raw as Record<string, unknown>;
              return {
                mint: String(t.mint_address ?? ""),
                symbol: String(t.symbol || "APL"),
                name: String(t.name || "Token"),
                balance: Number(t.amount ?? 0),
                decimals: Number(t.decimals ?? 0),
              };
            })
          );
          setTokensLoaded(true);
        })
        .catch(() => {
          setTokens([]);
          setTokensLoaded(true);
        });

      await Promise.allSettled([overviewPromise, tokensPromise]);
    },
    [activeAccount]
  );

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setOverviewLoaded(false);
    setTokensLoaded(false);
    setTxsLoaded(false);
    await fetchAll({ noCache: true });
    setRefreshing(false);
  }, [fetchAll]);

  const handleAirdrop = useCallback(async () => {
    if (!archAddress || !activeAccount) return;
    setAirdropLoading(true);
    try {
      const client = await getClient();
      await client.requestFaucetAirdrop(archAddress);
      const prevLamports = archLamports ?? 0;
      const MAX_ATTEMPTS = 12;
      const POLL_INTERVAL = 500;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        try {
          const fresh = (await client.getArchAccount(
            activeAccount.btcAddress
          )) as { lamports_balance?: number; lamports?: number };
          const newLamports = fresh?.lamports_balance ?? fresh?.lamports ?? 0;
          if (newLamports !== prevLamports) {
            setArchLamports(newLamports);
            break;
          }
        } catch {
          /* ignore */
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Airdrop failed";
      setError(msg);
    } finally {
      setAirdropLoading(false);
    }
  }, [archAddress, archLamports, activeAccount]);

  const emptyAccount = useMemo(
    () => (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No wallet selected</Text>
          <Text style={styles.emptySub}>
            Add or unlock a wallet in Settings to view your dashboard.
          </Text>
        </View>
      </SafeAreaView>
    ),
    []
  );

  if (!activeAccount) {
    return emptyAccount;
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Header account={activeAccount} network={state.network} networkStatus={networkStatus} onLock={lock} />
      <ConnectionBanner status={networkStatus} onRetry={retryApi} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.accent}
            colors={[Colors.accent]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={() => setError(null)} hitSlop={12}>
              <Text style={styles.errorDismiss}>Dismiss</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.heroBg}>
          <Image
            source={require("../../assets/images/hero-bg.jpg")}
            style={styles.heroBgImage}
            resizeMode="cover"
          />
          <LinearGradient
            colors={[
              "rgba(14,12,10,0.25)",
              "rgba(14,12,10,0.05)",
              "rgba(14,12,10,0.45)",
              Colors.bgPrimary,
            ]}
            locations={[0, 0.3, 0.7, 1]}
            style={styles.heroOverlay}
          >
            {balancesReady ? (
              <>
                <Text style={styles.heroAmount}>{formatArch(archLamports ?? 0)}</Text>
                <View style={styles.heroLabelRow}>
                  <Text style={styles.heroLabel}>Total ARCH Balance</Text>
                  <Pressable
                    onPress={onRefresh}
                    disabled={refreshing}
                    style={styles.refreshBtn}
                    hitSlop={8}
                  >
                    <Text style={[styles.refreshIcon, refreshing && styles.refreshSpin]}>
                      ↻
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <SkeletonBox
                  pulse={pulse}
                  style={[
                    styles.skel,
                    { width: 200, height: 42, marginBottom: 10, borderRadius: Radii.sm },
                  ]}
                />
                <SkeletonBox
                  pulse={pulse}
                  style={[styles.skel, { width: 160, height: 16, borderRadius: Radii.sm }]}
                />
              </>
            )}

            {balancesReady ? (
              <View style={styles.actionBar}>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionBtn,
                    pressed && styles.actionBtnPressed,
                  ]}
                  onPress={() => router.push("/send")}
                >
                  <View style={styles.actionIconWrap}>
                    <SendIcon size={22} color={Colors.accent} />
                  </View>
                  <Text style={styles.actionLabel}>Send</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionBtn,
                    pressed && styles.actionBtnPressed,
                  ]}
                  onPress={() => router.push("/receive")}
                >
                  <View style={styles.actionIconWrap}>
                    <ReceiveIcon size={22} color={Colors.accent} />
                  </View>
                  <Text style={styles.actionLabel}>Receive</Text>
                </Pressable>
                {isTestnet ? (
                  <Pressable
                    style={({ pressed }) => [
                      styles.actionBtn,
                      pressed && styles.actionBtnPressed,
                      airdropLoading && styles.actionBtnDisabled,
                    ]}
                    onPress={handleAirdrop}
                    disabled={airdropLoading}
                  >
                    <View style={styles.actionIconWrap}>
                      {airdropLoading ? (
                        <SpinnerIcon size={22} color={Colors.accent} />
                      ) : (
                        <AirdropIcon size={22} color={Colors.accent} />
                      )}
                    </View>
                    <Text style={styles.actionLabel}>Airdrop</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={({ pressed }) => [
                    styles.actionBtn,
                    pressed && styles.actionBtnPressed,
                  ]}
                  onPress={() => router.push("/tokens")}
                >
                  <View style={styles.actionIconWrap}>
                    <TokensIcon size={22} color={Colors.accent} />
                  </View>
                  <Text style={styles.actionLabel}>Tokens</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.actionBar}>
                {[1, 2, 3, 4].map((i) => (
                  <SkeletonBox
                    key={i}
                    pulse={pulse}
                    style={[styles.skel, styles.skelAction]}
                  />
                ))}
              </View>
            )}
          </LinearGradient>
        </View>

        <Text style={styles.sectionTitle}>Portfolio</Text>
        <View style={styles.card}>
          {balancesReady ? (
            <View
              style={[
                styles.assetRow,
                btcPending !== 0 && styles.assetRowPending,
              ]}
            >
              <View style={[styles.assetIcon, styles.assetIconBtc]}>
                <Text style={styles.assetIconBtcText}>₿</Text>
              </View>
              <View style={styles.assetInfo}>
                <Text style={styles.assetName} numberOfLines={1}>Bitcoin</Text>
                <Text style={styles.assetSub} numberOfLines={1}>BTC</Text>
              </View>
              <View style={styles.assetBalanceCol}>
                {btcPending !== 0 ? (
                  <>
                    <Text style={styles.assetBalance} numberOfLines={1}>
                      {formatBtc((btcBalance ?? 0) + btcPending)}
                    </Text>
                    <Text style={styles.assetConfirmed} numberOfLines={1}>
                      {formatBtc(btcBalance ?? 0)} confirmed
                    </Text>
                    <Text
                      style={[
                        styles.assetPending,
                        btcPending > 0 ? styles.pendingIn : styles.pendingOut,
                      ]}
                      numberOfLines={1}
                    >
                      {btcPending > 0 ? "+" : ""}
                      {(btcPending / 1e8).toFixed(8)} pending
                    </Text>
                  </>
                ) : (
                  <Text style={styles.assetBalance}>
                    {formatBtc(btcBalance ?? 0)}
                  </Text>
                )}
              </View>
            </View>
          ) : (
            <PortfolioRowSkeleton pulse={pulse} />
          )}

          {balancesReady ? (
            <View style={styles.assetRow}>
              <View style={[styles.assetIcon, styles.assetIconArch]}>
                <ArchLogoIcon size={18} color={Colors.archBlue} />
              </View>
              <View style={styles.assetInfo}>
                <Text style={styles.assetName}>Arch</Text>
                <Text style={styles.assetSub}>ARCH</Text>
              </View>
              <Text style={styles.assetBalance}>
                {formatArch(archLamports ?? 0)}
              </Text>
            </View>
          ) : (
            <PortfolioRowSkeleton pulse={pulse} />
          )}

          {tokensLoaded
            ? (tokens ?? []).map((tk) => (
                <View style={styles.assetRow} key={tk.mint}>
                  <View style={[styles.assetIcon, styles.assetIconToken]}>
                    <ArchLogoIcon size={18} color="#7b68ee" />
                  </View>
                  <View style={styles.assetInfo}>
                    <Text style={styles.assetName}>{tk.symbol}</Text>
                    <Text style={styles.assetSub}>{tk.name}</Text>
                  </View>
                  <Text style={styles.assetBalance}>
                    {formatTokenAmount(tk.balance, tk.decimals)}
                  </Text>
                </View>
              ))
            : <PortfolioRowSkeleton pulse={pulse} />}
        </View>

        <View style={styles.activityHeader}>
          <Text style={[styles.sectionTitle, styles.sectionTitleRow]}>Recent Activity</Text>
          <Pressable onPress={() => router.push("/history")} hitSlop={8}>
            <Text style={styles.viewAll}>View all</Text>
          </Pressable>
        </View>
        <View style={styles.card}>
          {txsLoaded ? (
            (recentTxs ?? []).length > 0 ? (
              recentTxs!.map((tx) => (
                <View style={styles.txRow} key={`${tx.type}-${tx.txid}`}>
                  <View
                    style={[
                      styles.txDir,
                      tx.type === "btc" && styles.txDirIn,
                      tx.type === "arch" && tx.direction === "out" && styles.txDirOut,
                      tx.type === "arch" && tx.direction === "in" && styles.txDirIn,
                    ]}
                  >
                    <Text
                      style={[
                        styles.txDirText,
                        tx.type === "btc" && styles.txDirTextIn,
                        tx.type === "arch" && tx.direction === "out" && styles.txDirTextOut,
                        tx.type === "arch" && tx.direction === "in" && styles.txDirTextIn,
                      ]}
                    >
                      {tx.type === "btc" ? "₿" : tx.direction === "out" ? "↗" : tx.direction === "in" ? "↙" : "↔"}
                    </Text>
                  </View>
                  <View style={styles.txInfo}>
                    <Text style={styles.txLabel} numberOfLines={1}>
                      {truncateAddress(tx.type === "arch" ? formatArchId(tx.txid) : tx.txid, 8)}
                    </Text>
                    <Text style={styles.txTime}>
                      {tx.timestamp
                        ? formatTimestamp(tx.timestamp)
                        : "Just now"}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.badge,
                      tx.status === "confirmed" || tx.status === "processed"
                        ? styles.badgeOk
                        : tx.status === "failed"
                          ? styles.badgeFail
                          : styles.badgePending,
                    ]}
                  >
                    <Text style={styles.badgeText}>{tx.status}</Text>
                  </View>
                </View>
              ))
            ) : (
              <Text style={styles.noTx}>No recent transactions</Text>
            )
          ) : (
            <>
              {[1, 2, 3].map((i) => (
                <TxRowSkeleton key={i} pulse={pulse} />
              ))}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 14,
    paddingBottom: 32,
  },
  emptyWrap: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  emptyTitle: {
    color: Colors.textPrimary,
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 8,
  },
  emptySub: {
    color: Colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(217, 83, 79, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(217, 83, 79, 0.35)",
    borderRadius: Radii.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  errorText: {
    color: Colors.danger,
    fontSize: 13,
    flex: 1,
    marginRight: 12,
  },
  errorDismiss: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  heroBg: {
    marginBottom: 14,
    marginHorizontal: -14,
    marginTop: -14,
    overflow: "hidden",
    position: "relative",
    backgroundColor: Colors.bgPrimary,
  },
  heroBgImage: {
    position: "absolute",
    top: "-20%",
    left: 0,
    right: 0,
    width: "100%",
    height: "140%",
    opacity: 0.45,
  },
  heroOverlay: {
    alignItems: "center",
    paddingTop: 28,
    paddingBottom: 18,
    paddingHorizontal: 14,
  },
  heroAmount: {
    fontSize: 32,
    fontFamily: Fonts.display,
    color: Colors.textPrimary,
    letterSpacing: -0.3,
  },
  heroLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    gap: 8,
  },
  heroLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    fontFamily: Fonts.bodyMedium,
    letterSpacing: 0.2,
  },
  refreshBtn: {
    padding: 4,
  },
  refreshIcon: {
    fontSize: 20,
    color: Colors.accent,
  },
  refreshSpin: {
    opacity: 0.5,
  },
  skel: {
    backgroundColor: "rgba(193, 154, 91, 0.08)",
  },
  skelBar: {
    height: 14,
    borderRadius: 4,
  },
  skelIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: 12,
  },
  skelTxIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: 12,
  },
  actionBar: {
    flexDirection: "row",
    gap: 8,
    marginTop: 18,
    width: "100%",
  },
  actionBtn: {
    flex: 1,
    backgroundColor: "rgba(22, 19, 15, 0.65)",
    borderWidth: 1,
    borderColor: "rgba(193, 154, 91, 0.2)",
    borderRadius: Radii.md,
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: "center",
    gap: 6,
  },
  actionBtnPressed: {
    backgroundColor: "rgba(193, 154, 91, 0.15)",
    borderColor: Colors.borderAccent,
  },
  actionBtnDisabled: {
    opacity: 0.55,
  },
  actionIconWrap: {
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: {
    fontSize: 11,
    fontFamily: Fonts.bodySemiBold,
    color: Colors.textPrimary,
  },
  skelAction: {
    width: "22%",
    flexGrow: 1,
    height: 72,
    borderRadius: Radii.lg,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: Fonts.bodySemiBold,
    color: Colors.accent,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  sectionTitleRow: {
    marginBottom: 0,
  },
  card: {
    backgroundColor: Colors.bgCard,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    overflow: "hidden",
    marginBottom: 14,
    padding: 14,
  },
  assetRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 0,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(193, 154, 91, 0.08)",
  },
  assetRowPending: {
    alignItems: "center",
  },
  assetIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
    borderWidth: 1,
  },
  assetIconBtc: {
    backgroundColor: Colors.btcIconBg,
    borderColor: Colors.btcIconBorder,
  },
  assetIconArch: {
    backgroundColor: Colors.archIconBg,
    borderColor: Colors.archIconBorder,
  },
  assetIconToken: {
    backgroundColor: Colors.aplIconBg,
    borderColor: Colors.aplIconBorder,
  },
  assetIconBtcText: {
    fontSize: 17,
    color: Colors.btcOrange,
    fontFamily: Fonts.bodyBold,
  },
  assetInfo: {
    flex: 1,
    minWidth: 0,
  },
  assetName: {
    fontSize: 14,
    fontFamily: Fonts.bodySemiBold,
    color: Colors.textPrimary,
  },
  assetSub: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 1,
  },
  assetBalanceCol: {
    alignItems: "flex-end",
    flexShrink: 0,
  },
  assetBalance: {
    fontSize: 13,
    fontFamily: Fonts.mono,
    color: Colors.accent,
    textAlign: "right",
  },
  assetConfirmed: {
    fontSize: 10,
    color: Colors.textMuted,
    textAlign: "right",
    marginTop: 2,
  },
  assetPending: {
    fontSize: 10,
    textAlign: "right",
    marginTop: 1,
  },
  pendingIn: {
    color: Colors.success,
  },
  pendingOut: {
    color: Colors.warning,
  },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  viewAll: {
    fontSize: 11,
    fontFamily: Fonts.bodySemiBold,
    color: Colors.accent,
  },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 0,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(193, 154, 91, 0.08)",
  },
  txDir: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(247, 147, 26, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(247, 147, 26, 0.18)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  txDirOut: {
    backgroundColor: Colors.outboundBg,
    borderColor: Colors.outboundBorder,
  },
  txDirIn: {
    backgroundColor: Colors.inboundBg,
    borderColor: Colors.inboundBorder,
  },
  txDirText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  txDirTextOut: {
    color: Colors.danger,
  },
  txDirTextIn: {
    color: Colors.success,
  },
  txInfo: {
    flex: 1,
    minWidth: 0,
  },
  txLabel: {
    fontSize: 13,
    fontFamily: Fonts.bodyMedium,
    color: Colors.textPrimary,
  },
  txTime: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    borderWidth: 1,
    marginLeft: 8,
  },
  badgeOk: {
    backgroundColor: Colors.successBg,
    borderColor: Colors.successBorder,
  },
  badgeFail: {
    backgroundColor: Colors.dangerBg,
    borderColor: Colors.dangerBorder,
  },
  badgePending: {
    backgroundColor: Colors.warningBg,
    borderColor: Colors.warningBorder,
  },
  badgeText: {
    fontSize: 9,
    fontFamily: Fonts.bodyBold,
    color: Colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  noTx: {
    textAlign: "center",
    color: Colors.textMuted,
    fontSize: 13,
    paddingVertical: 20,
    paddingHorizontal: 12,
  },
});
