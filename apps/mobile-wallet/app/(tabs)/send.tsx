import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Radii } from "../../constants/Theme";
import { useWallet } from "../../src/hooks/useWallet";
import { getClient, getExternalUserId } from "../../src/utils/sdk";
import { truncateAddress, formatBtc, formatArch } from "../../src/utils/format";

type Asset = "BTC" | "ARCH" | "APL";
type Step = "pick" | "details" | "review" | "result";

const ASSETS: { id: Asset; label: string; color: string }[] = [
  { id: "BTC", label: "Bitcoin", color: Colors.btcOrange },
  { id: "ARCH", label: "Arch", color: Colors.archBlue },
  { id: "APL", label: "APL Token", color: Colors.aplGold },
];

export default function SendScreen() {
  const { activeAccount, state } = useWallet();

  const [step, setStep] = useState<Step>("pick");
  const [asset, setAsset] = useState<Asset>("BTC");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [txResult, setTxResult] = useState<{
    success: boolean;
    txid?: string;
    error?: string;
  } | null>(null);

  const balanceLabel = useCallback(() => {
    if (!activeAccount) return "—";
    return asset === "BTC"
      ? formatBtc(0)
      : asset === "ARCH"
        ? formatArch(0)
        : "0 APL";
  }, [asset, activeAccount]);

  const goBack = () => {
    if (step === "details") setStep("pick");
    else if (step === "review") setStep("details");
    else if (step === "result") resetFlow();
  };

  const resetFlow = () => {
    setStep("pick");
    setAsset("BTC");
    setRecipient("");
    setAmount("");
    setTxResult(null);
  };

  const handleSend = async () => {
    if (!activeAccount) return;
    setSending(true);
    try {
      const client = await getClient();
      const externalUserId = await getExternalUserId();

      if (asset === "BTC") {
        const prep = await client.prepareBtcSend({
          externalUserId,
          recipientAddress: recipient,
          amountSats: Math.round(parseFloat(amount) * 1e8),
        });
        const result = await client.finalizeBtcTransaction({
          externalUserId,
          psbt: (prep as any).psbt,
          inputsToSign: (prep as any).inputsToSign ?? [],
        });
        setTxResult({ success: true, txid: (result as any).txid });
      } else {
        const req = await client.createSigningRequest({
          externalUserId,
          message: JSON.stringify({
            type: "transfer",
            asset,
            recipient,
            amount,
          }),
        });
        const signed = await client.signWithTurnkey({
          externalUserId,
          payload: (req as any).payload,
        });
        setTxResult({ success: true, txid: (signed as any).txid ?? "pending" });
      }
    } catch (err: any) {
      setTxResult({ success: false, error: err.message ?? "Unknown error" });
    } finally {
      setSending(false);
      setStep("result");
    }
  };

  const renderPick = () => (
    <View style={styles.section}>
      <Text style={styles.heading}>Select Asset</Text>
      {ASSETS.map((a) => (
        <TouchableOpacity
          key={a.id}
          style={[
            styles.assetRow,
            asset === a.id && { borderColor: a.color },
          ]}
          onPress={() => {
            setAsset(a.id);
            setStep("details");
          }}
        >
          <View style={[styles.assetDot, { backgroundColor: a.color }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.assetLabel}>{a.label}</Text>
            <Text style={styles.assetSub}>{a.id}</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const renderDetails = () => (
    <View style={styles.section}>
      <Text style={styles.heading}>Send {asset}</Text>
      <Text style={styles.balanceLabel}>Balance: {balanceLabel()}</Text>

      <Text style={styles.inputLabel}>Recipient Address</Text>
      <TextInput
        style={styles.input}
        value={recipient}
        onChangeText={setRecipient}
        placeholder={asset === "BTC" ? "bc1p... or tb1p..." : "Arch address"}
        placeholderTextColor={Colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.inputLabel}>Amount</Text>
      <TextInput
        style={styles.input}
        value={amount}
        onChangeText={setAmount}
        placeholder="0.00"
        placeholderTextColor={Colors.textMuted}
        keyboardType="decimal-pad"
      />

      <TouchableOpacity
        style={[styles.primaryBtn, !recipient || !amount ? styles.btnDisabled : null]}
        disabled={!recipient || !amount}
        onPress={() => setStep("review")}
      >
        <Text style={styles.primaryBtnText}>Review</Text>
      </TouchableOpacity>
    </View>
  );

  const renderReview = () => (
    <View style={styles.section}>
      <Text style={styles.heading}>Confirm Transaction</Text>

      <View style={styles.reviewRow}>
        <Text style={styles.reviewLabel}>Asset</Text>
        <Text style={styles.reviewValue}>{asset}</Text>
      </View>
      <View style={styles.reviewRow}>
        <Text style={styles.reviewLabel}>To</Text>
        <Text style={styles.reviewValue}>{truncateAddress(recipient, 8)}</Text>
      </View>
      <View style={styles.reviewRow}>
        <Text style={styles.reviewLabel}>Amount</Text>
        <Text style={styles.reviewValue}>
          {amount} {asset === "BTC" ? "BTC" : asset}
        </Text>
      </View>
      <View style={styles.reviewRow}>
        <Text style={styles.reviewLabel}>Network</Text>
        <Text style={styles.reviewValue}>{state.network}</Text>
      </View>

      <TouchableOpacity
        style={styles.primaryBtn}
        onPress={handleSend}
        disabled={sending}
      >
        {sending ? (
          <ActivityIndicator color={Colors.bgPrimary} />
        ) : (
          <Text style={styles.primaryBtnText}>Send</Text>
        )}
      </TouchableOpacity>
    </View>
  );

  const renderResult = () => (
    <View style={styles.section}>
      {txResult?.success ? (
        <>
          <Text style={styles.resultIcon}>✓</Text>
          <Text style={styles.heading}>Sent!</Text>
          {txResult.txid && (
            <Text style={styles.txid}>{truncateAddress(txResult.txid, 10)}</Text>
          )}
        </>
      ) : (
        <>
          <Text style={[styles.resultIcon, { color: Colors.danger }]}>✗</Text>
          <Text style={styles.heading}>Failed</Text>
          <Text style={styles.errorText}>{txResult?.error}</Text>
        </>
      )}
      <TouchableOpacity style={styles.primaryBtn} onPress={resetFlow}>
        <Text style={styles.primaryBtnText}>Done</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        {step !== "pick" && step !== "result" && (
          <TouchableOpacity onPress={goBack} style={styles.backBtn}>
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>
        )}

        {!activeAccount ? (
          <View style={styles.section}>
            <Text style={styles.heading}>No Wallet</Text>
            <Text style={styles.subtext}>
              Create or import a wallet to start sending.
            </Text>
          </View>
        ) : step === "pick" ? (
          renderPick()
        ) : step === "details" ? (
          renderDetails()
        ) : step === "review" ? (
          renderReview()
        ) : (
          renderResult()
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgPrimary },
  container: { padding: 14, paddingBottom: 40 },
  backBtn: { marginBottom: 12 },
  backText: { color: Colors.accent, fontSize: 16 },
  section: { marginTop: 8 },
  heading: {
    color: Colors.textPrimary,
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 16,
  },
  balanceLabel: { color: Colors.textSecondary, fontSize: 14, marginBottom: 20 },
  assetRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: Radii.md,
    backgroundColor: Colors.bgCard,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    marginBottom: 10,
  },
  assetDot: { width: 12, height: 12, borderRadius: 6, marginRight: 14 },
  assetLabel: { color: Colors.textPrimary, fontSize: 16, fontWeight: "600" },
  assetSub: { color: Colors.textMuted, fontSize: 12, marginTop: 2 },
  chevron: { color: Colors.textMuted, fontSize: 22 },
  inputLabel: {
    color: Colors.textSecondary,
    fontSize: 13,
    marginBottom: 6,
    fontWeight: "600",
  },
  input: {
    backgroundColor: Colors.bgInput,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    borderRadius: Radii.sm,
    padding: 14,
    fontSize: 15,
    marginBottom: 16,
  },
  primaryBtn: {
    backgroundColor: Colors.accent,
    borderRadius: Radii.md,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  btnDisabled: { opacity: 0.4 },
  primaryBtnText: {
    color: Colors.bgPrimary,
    fontWeight: "700",
    fontSize: 16,
  },
  reviewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderPrimary,
  },
  reviewLabel: { color: Colors.textSecondary, fontSize: 14 },
  reviewValue: { color: Colors.textPrimary, fontSize: 14, fontWeight: "600" },
  resultIcon: {
    fontSize: 48,
    color: Colors.success,
    textAlign: "center",
    marginBottom: 8,
  },
  txid: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: "center",
    marginBottom: 20,
  },
  errorText: {
    color: Colors.danger,
    fontSize: 14,
    textAlign: "center",
    marginBottom: 20,
  },
  subtext: { color: Colors.textSecondary, fontSize: 14 },
});
