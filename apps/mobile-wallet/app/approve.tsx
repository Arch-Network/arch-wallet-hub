import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as LocalAuthentication from "expo-local-authentication";
import { walletStore } from "../src/store/wallet-store";
import { Colors, Radii } from "../constants/Theme";

/**
 * Only origins that have completed a connect handshake (recorded in
 * `walletStore.connectedSites`) are allowed to drive this screen. Any
 * deep link from a sender we don't recognise is treated as a hijack
 * attempt -- show a hard error, never an "Approve" button.
 */
type SourceCheck =
  | { state: "checking" }
  | { state: "ok"; origin: string }
  | { state: "unknown_origin"; origin: string }
  | { state: "missing_origin" };

export default function ApproveScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    type?: string;
    origin?: string;
    details?: string;
  }>();

  const requestType = sanitize(params.type, "Unknown Request");
  const origin = typeof params.origin === "string" ? params.origin.trim() : "";
  const details = sanitize(params.details, "No details provided.");

  const [sourceCheck, setSourceCheck] = useState<SourceCheck>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!origin) {
        if (!cancelled) setSourceCheck({ state: "missing_origin" });
        return;
      }
      try {
        const state = await walletStore.getState();
        const known = origin in (state.connectedSites ?? {});
        if (cancelled) return;
        setSourceCheck(
          known ? { state: "ok", origin } : { state: "unknown_origin", origin },
        );
      } catch {
        if (!cancelled) setSourceCheck({ state: "unknown_origin", origin });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin]);

  const handleApprove = async () => {
    if (sourceCheck.state !== "ok") {
      Alert.alert(
        "Cannot approve",
        sourceCheck.state === "missing_origin"
          ? "Approval requests must include an origin."
          : "This site is not connected to your wallet.",
      );
      return;
    }
    try {
      // SECURITY: every signing approval is gated on a fresh OS-level
      // user-verification. A successful previous unlock is NOT enough
      // -- the user must demonstrate presence and consent right now.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Approve ${requestType} from ${sourceCheck.origin}`,
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      });
      if (!result.success) {
        Alert.alert("Approval cancelled", "Authentication was cancelled or denied.");
        return;
      }
      // TODO: forward approval result to the in-app browser bridge.
      // The bridge is intentionally a TODO until the connect/post-
      // message channel lands; until then, callers see a router.back()
      // but the approval is NOT considered complete on the dApp side.
      router.back();
    } catch (e: any) {
      Alert.alert("Approval failed", e?.message ?? "Authentication error");
    }
  };

  const handleReject = () => {
    router.back();
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.handle} />

        <Text style={styles.title}>Approval Request</Text>

        {sourceCheck.state === "unknown_origin" && (
          <Text style={styles.warning}>
            This request is from a site you have not connected to your wallet.
            The Approve button is disabled.
          </Text>
        )}
        {sourceCheck.state === "missing_origin" && (
          <Text style={styles.warning}>
            The deep link did not include an origin. The Approve button is disabled.
          </Text>
        )}

        <View style={styles.card}>
          <View style={styles.field}>
            <Text style={styles.label}>Type</Text>
            <Text style={styles.value}>{requestType}</Text>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Origin</Text>
            <Text style={styles.value}>{origin || "(missing)"}</Text>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Details</Text>
            <Text style={styles.details}>{details}</Text>
          </View>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, styles.rejectBtn]}
            onPress={handleReject}
          >
            <Text style={styles.rejectText}>Reject</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.btn,
              styles.approveBtn,
              sourceCheck.state !== "ok" && styles.btnDisabled,
            ]}
            onPress={handleApprove}
            disabled={sourceCheck.state !== "ok"}
          >
            <Text style={styles.approveText}>Approve</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

function sanitize(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // Strip ANSI / control chars and cap length. The deep-link layer
  // may pass arbitrary bytes; we render via <Text> which is safe from
  // markup injection but we still want a sane upper bound.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 4096 ? `${cleaned.slice(0, 4096)}...` : cleaned;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgPrimary },
  container: { flex: 1, padding: 20 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.textMuted,
    alignSelf: "center",
    marginBottom: 20,
  },
  title: {
    color: Colors.textPrimary,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 12,
  },
  warning: {
    color: Colors.danger,
    fontSize: 13,
    textAlign: "center",
    marginBottom: 16,
    lineHeight: 18,
  },
  card: {
    backgroundColor: Colors.bgCard,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    padding: 16,
  },
  field: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderPrimary,
  },
  label: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  value: { color: Colors.textPrimary, fontSize: 15, fontWeight: "600" },
  details: { color: Colors.textSecondary, fontSize: 14, lineHeight: 20 },
  actions: {
    flexDirection: "row",
    gap: 12,
    marginTop: "auto",
    paddingTop: 20,
  },
  btn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: Radii.md,
    alignItems: "center",
  },
  rejectBtn: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  rejectText: { color: Colors.danger, fontWeight: "700", fontSize: 16 },
  approveBtn: { backgroundColor: Colors.accent },
  btnDisabled: { opacity: 0.4 },
  approveText: {
    color: Colors.bgPrimary,
    fontWeight: "700",
    fontSize: 16,
  },
});
