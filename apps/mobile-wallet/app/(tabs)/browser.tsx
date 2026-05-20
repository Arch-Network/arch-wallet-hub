import { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import type WebViewType from "react-native-webview";
import { Colors, Radii } from "../../constants/Theme";

const DEFAULT_URL = "https://explorer.arch.network";

export default function BrowserScreen() {
  const webViewRef = useRef<WebViewType>(null);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [inputUrl, setInputUrl] = useState(DEFAULT_URL);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);

  const navigate = () => {
    let target = inputUrl.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = "https://" + target;
    }
    // SECURITY: reject anything that isn't https. The in-app browser
    // is a signing surface; plain http would let any wifi attacker
    // MITM the dapp the user is about to approve a transaction for.
    try {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:") {
        setInputUrl(url);
        return;
      }
    } catch {
      setInputUrl(url);
      return;
    }
    setUrl(target);
  };

  // TODO: Inject provider bridge script here.
  // const injectedJavaScript = `
  //   window.archWallet = { ... };
  //   true;
  // `;

  return (
    <SafeAreaView style={styles.safe}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <TouchableOpacity
          onPress={() => webViewRef.current?.goBack()}
          disabled={!canGoBack}
          style={styles.navBtn}
        >
          <Text style={[styles.navIcon, !canGoBack && styles.disabled]}>‹</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => webViewRef.current?.goForward()}
          disabled={!canGoForward}
          style={styles.navBtn}
        >
          <Text style={[styles.navIcon, !canGoForward && styles.disabled]}>›</Text>
        </TouchableOpacity>

        <TextInput
          style={styles.urlInput}
          value={inputUrl}
          onChangeText={setInputUrl}
          onSubmitEditing={navigate}
          returnKeyType="go"
          autoCapitalize="none"
          autoCorrect={false}
          selectTextOnFocus
          placeholderTextColor={Colors.textMuted}
          placeholder="Enter URL"
        />

        <TouchableOpacity
          onPress={() => webViewRef.current?.reload()}
          style={styles.navBtn}
        >
          <Text style={styles.navIcon}>↻</Text>
        </TouchableOpacity>
      </View>

      {loading && (
        <View style={styles.loadingBar}>
          <ActivityIndicator size="small" color={Colors.accent} />
        </View>
      )}

      {/* WebView */}
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        style={styles.webview}
        // SECURITY:
        // - originWhitelist: only https URLs may load. about:, file:,
        //   data: and intent: are all blocked. This is the single most
        //   important hardening on a WebView signing surface.
        // - allowFileAccess / allowFileAccessFromFileURLs / allowUniversalAccessFromFileURLs:
        //   explicitly OFF so a malicious page can't escape via
        //   file:// sandbox quirks.
        // - mixedContentMode "never": Android-only; refuses to load
        //   http subresources on https pages.
        // - cacheEnabled true is fine; we don't store secrets in the
        //   WebView's storage and a cleared cache forces re-download.
        originWhitelist={["https://*"]}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        onNavigationStateChange={(navState) => {
          setCanGoBack(navState.canGoBack);
          setCanGoForward(navState.canGoForward);
          if (navState.url) setInputUrl(navState.url);
        }}
        onShouldStartLoadWithRequest={(req) => {
          try {
            const next = new URL(req.url);
            return next.protocol === "https:" || next.protocol === "about:";
          } catch {
            return false;
          }
        }}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        javaScriptEnabled
        domStorageEnabled={false}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.webviewLoader}>
            <ActivityIndicator size="large" color={Colors.accent} />
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgPrimary },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: Colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderPrimary,
    gap: 4,
  },
  navBtn: { padding: 8 },
  navIcon: { color: Colors.accent, fontSize: 22, fontWeight: "700" },
  disabled: { color: Colors.textMuted },
  urlInput: {
    flex: 1,
    backgroundColor: Colors.bgInput,
    color: Colors.textPrimary,
    borderWidth: 1,
    borderColor: Colors.borderPrimary,
    borderRadius: Radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
  },
  loadingBar: {
    height: 3,
    backgroundColor: Colors.bgSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  webview: { flex: 1 },
  webviewLoader: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.bgPrimary,
    justifyContent: "center",
    alignItems: "center",
  },
});
