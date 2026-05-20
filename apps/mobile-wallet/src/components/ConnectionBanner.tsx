import { View, Text, Pressable, StyleSheet } from "react-native";
import { Colors, Fonts, Radii } from "../../constants/Theme";
import type { NetworkStatus } from "../hooks/useApiStatus";

interface ConnectionBannerProps {
  status: NetworkStatus;
  onRetry: () => void;
}

function getBannerContent(status: NetworkStatus): { title: string; sub: string; variant: "error" | "warning" } | null {
  if (status.api === "checking") return null;
  if (status.api === "disconnected") {
    return { title: "API unavailable", sub: "Cannot connect to wallet services", variant: "error" };
  }
  if (status.bitcoin === "disconnected" && status.arch === "disconnected") {
    return { title: "Networks unavailable", sub: "Bitcoin and Arch networks are offline", variant: "error" };
  }
  if (status.arch === "disconnected") {
    return { title: "Arch Network unavailable", sub: "ARCH and token features may not work correctly", variant: "warning" };
  }
  if (status.bitcoin === "disconnected") {
    return { title: "Bitcoin unavailable", sub: "BTC features may not work correctly", variant: "warning" };
  }
  return null;
}

export default function ConnectionBanner({ status, onRetry }: ConnectionBannerProps) {
  const content = getBannerContent(status);
  if (!content) return null;

  const isWarning = content.variant === "warning";

  return (
    <View style={[styles.banner, isWarning && styles.bannerWarning]}>
      <View style={styles.content}>
        <Text style={[styles.icon, isWarning && styles.iconWarning]}>
          {isWarning ? "⚠" : "⊘"}
        </Text>
        <View style={styles.textWrap}>
          <Text style={[styles.title, isWarning && styles.titleWarning]}>{content.title}</Text>
          <Text style={styles.sub}>{content.sub}</Text>
        </View>
      </View>
      <Pressable
        style={[styles.retryBtn, isWarning && styles.retryBtnWarning]}
        onPress={onRetry}
      >
        <Text style={[styles.retryText, isWarning && styles.retryTextWarning]}>RETRY</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(217, 83, 79, 0.08)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(217, 83, 79, 0.2)",
  },
  bannerWarning: {
    backgroundColor: "rgba(230, 168, 23, 0.08)",
    borderBottomColor: "rgba(230, 168, 23, 0.2)",
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  icon: {
    fontSize: 16,
    color: Colors.danger,
  },
  iconWarning: {
    color: Colors.warning,
  },
  textWrap: {
    flex: 1,
    gap: 1,
  },
  title: {
    fontSize: 11,
    fontFamily: Fonts.bodySemiBold,
    color: Colors.danger,
  },
  titleWarning: {
    color: Colors.warning,
  },
  sub: {
    fontSize: 10,
    color: Colors.textMuted,
  },
  retryBtn: {
    paddingVertical: 4,
    paddingHorizontal: 12,
    backgroundColor: "rgba(217, 83, 79, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(217, 83, 79, 0.25)",
    borderRadius: Radii.sm,
  },
  retryBtnWarning: {
    backgroundColor: "rgba(230, 168, 23, 0.1)",
    borderColor: "rgba(230, 168, 23, 0.25)",
  },
  retryText: {
    fontSize: 10,
    fontFamily: Fonts.bodyBold,
    color: Colors.danger,
    letterSpacing: 0.4,
  },
  retryTextWarning: {
    color: Colors.warning,
  },
});
