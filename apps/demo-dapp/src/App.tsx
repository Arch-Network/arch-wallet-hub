import { useMemo, useState, useCallback } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import WizardFlow from "./components/wizard/WizardFlow";

function defaultEnv(key: string, fallback = ""): string {
  return (import.meta as any).env?.[key] ?? fallback;
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState(
    defaultEnv("VITE_WALLET_HUB_BASE_URL", "http://localhost:3005/v1")
  );
  const [apiKey, setApiKey] = useState(
    defaultEnv("VITE_WALLET_HUB_API_KEY", "")
  );
  const [externalUserId] = useState(
    defaultEnv("VITE_DEFAULT_EXTERNAL_USER_ID", "demo-user-1")
  );

  const client = useMemo(
    () => new WalletHubClient({ baseUrl, apiKey }),
    [baseUrl, apiKey]
  );

  const handleApiConfigChange = useCallback((newBaseUrl: string, newApiKey: string) => {
    setBaseUrl(newBaseUrl);
    setApiKey(newApiKey);
  }, []);

  return (
    <WizardFlow
      client={client}
      externalUserId={externalUserId}
      apiKey={apiKey}
      baseUrl={baseUrl}
      onApiConfigChange={handleApiConfigChange}
    />
  );
}
