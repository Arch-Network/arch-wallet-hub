import { useEffect, useMemo, useState } from "react";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import { Turnkey, SessionType } from "@turnkey/sdk-browser";
// @ts-ignore - sats-connect types may not be available until npm install
import { getAddress, signMessage, AddressPurpose, request } from "sats-connect";

type XverseAddress = {
  address: string;
  publicKey?: string;
  purpose?: string;
};

type XverseGetAddressResponse = {
  addresses: XverseAddress[];
};

// Type declarations for wallet browser extensions
declare global {
  interface Window {
    unisat?: {
      requestAccounts(): Promise<string[]>;
      getAccounts(): Promise<string[]>;
      signMessage(message: string, type?: string): Promise<string>;
      getPublicKey(): Promise<string>;
      signPsbt(psbtHex: string, options?: { autoFinalized?: boolean }): Promise<string>;
    };
  }
}

function safeJson(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

function makeIdempotencyKey() {
  // Wallet Hub requires Idempotency-Key for Turnkey wallet creation.
  // Use crypto.randomUUID when available; fallback to a simple random token.
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function defaultEnv(key: string, fallback = ""): string {
  return (import.meta as any).env?.[key] ?? fallback;
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState(defaultEnv("VITE_WALLET_HUB_BASE_URL", "http://localhost:3005/v1"));
  const [apiKey, setApiKey] = useState(defaultEnv("VITE_WALLET_HUB_API_KEY", ""));

  const client = useMemo(() => new WalletHubClient({ baseUrl, apiKey }), [baseUrl, apiKey]);

  const [portfolioAddress, setPortfolioAddress] = useState(defaultEnv("VITE_DEFAULT_PORTFOLIO_ADDRESS", ""));
  const [portfolioRes, setPortfolioRes] = useState<unknown | null>(null);
  const [portfolioErr, setPortfolioErr] = useState<string | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);

  const [externalUserId, setExternalUserId] = useState(defaultEnv("VITE_DEFAULT_EXTERNAL_USER_ID", "demo-user-1"));
  const [signerKind, setSignerKind] = useState<"turnkey" | "external">("turnkey");
  const [turnkeyResourceId, setTurnkeyResourceId] = useState(defaultEnv("VITE_DEFAULT_TURNKEY_RESOURCE_ID", ""));
  const [externalTaprootAddress, setExternalTaprootAddress] = useState("");
  
  // External wallet state
  const [externalWalletType, setExternalWalletType] = useState<"unisat" | "xverse" | null>(null);
  const [externalWalletConnecting, setExternalWalletConnecting] = useState(false);
  const [externalWalletErr, setExternalWalletErr] = useState<string | null>(null);
  const [externalWalletPublicKey, setExternalWalletPublicKey] = useState<string | null>(null);
  const [externalSignLoading, setExternalSignLoading] = useState(false);
  const [btcNetwork, setBtcNetwork] = useState<string>("Testnet4"); // Match your wallet's network

  const [actionType, setActionType] = useState<"arch.transfer" | "arch.anchor">("arch.transfer");
  const [toAddress, setToAddress] = useState(defaultEnv("VITE_DEFAULT_ARCH_TO_ADDRESS", ""));
  const [lamports, setLamports] = useState("1000");
  const [amountUnit, setAmountUnit] = useState<"lamports" | "arch">("lamports");
  const [archInputValue, setArchInputValue] = useState(""); // Separate input state for ARCH mode
  const [btcTxid, setBtcTxid] = useState("");
  const [btcVout, setBtcVout] = useState(0);

  const [createRes, setCreateRes] = useState<unknown | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);

  const [submitSig64Hex, setSubmitSig64Hex] = useState("");
  const [submitActivityId, setSubmitActivityId] = useState("");
  const [submitRes, setSubmitRes] = useState<unknown | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitLoading, setSubmitLoading] = useState(false);

  const [approveOpen, setApproveOpen] = useState(false);
  const [approveSigningRequestId, setApproveSigningRequestId] = useState<string>("");
  const [approveTurnkeyResourceId, setApproveTurnkeyResourceId] = useState<string>("");
  const [approveReq, setApproveReq] = useState<any | null>(null);
  const [approveErr, setApproveErr] = useState<string | null>(null);
  const [approveLoading, setApproveLoading] = useState(false);

  const [signingRequestId, setSigningRequestId] = useState("");
  const [getRes, setGetRes] = useState<unknown | null>(null);
  const [getErr, setGetErr] = useState<string | null>(null);
  const [getLoading, setGetLoading] = useState(false);

  const [turnkeyCreateRes, setTurnkeyCreateRes] = useState<unknown | null>(null);
  const [turnkeyCreateErr, setTurnkeyCreateErr] = useState<string | null>(null);
  const [turnkeyCreateLoading, setTurnkeyCreateLoading] = useState(false);
  const [turnkeyWallets, setTurnkeyWallets] = useState<any[]>([]);
  const [turnkeyWalletsErr, setTurnkeyWalletsErr] = useState<string | null>(null);
  const [turnkeyWalletsLoading, setTurnkeyWalletsLoading] = useState(false);
  const [walletName, setWalletName] = useState("");
  const [turnkeyPasskeyReady, setTurnkeyPasskeyReady] = useState(false);
  const [turnkeyPasskeyErr, setTurnkeyPasskeyErr] = useState<string | null>(null);
  const [turnkeyPasskeyLoginLoading, setTurnkeyPasskeyLoginLoading] = useState(false);
  const [turnkeySignLoading, setTurnkeySignLoading] = useState(false);
  const [turnkeySignRes, setTurnkeySignRes] = useState<unknown | null>(null);

  const [turnkeyApiBaseUrl, setTurnkeyApiBaseUrl] = useState(defaultEnv("VITE_TURNKEY_API_BASE_URL", "https://api.turnkey.com"));
  const [turnkeyRpId, setTurnkeyRpId] = useState(
    defaultEnv(
      "VITE_TURNKEY_RP_ID",
      window.location.hostname === "127.0.0.1" ? "localhost" : window.location.hostname
    )
  );

  const [polling, setPolling] = useState(false);
  const [pollEveryMs, setPollEveryMs] = useState(2000);
  const [showApiConfig, setShowApiConfig] = useState(false);

  async function onFetchPortfolio() {
    setPortfolioLoading(true);
    setPortfolioErr(null);
    setPortfolioRes(null);
    try {
      const res = await client.getPortfolio(portfolioAddress);
      setPortfolioRes(res);
    } catch (e: any) {
      setPortfolioErr(String(e?.message ?? e));
    } finally {
      setPortfolioLoading(false);
    }
  }

  // ===== External Wallet Functions =====
  
  async function connectUnisat() {
    setExternalWalletConnecting(true);
    setExternalWalletErr(null);
    try {
      if (!window.unisat) {
        throw new Error("Unisat wallet not installed. Please install the Unisat browser extension.");
      }
      const accounts = await window.unisat.requestAccounts();
      if (!accounts || accounts.length === 0) {
        throw new Error("No accounts returned from Unisat");
      }
      const address = accounts[0];
      // Only accept Taproot addresses
      if (!address.startsWith("bc1p") && !address.startsWith("tb1p") && !address.startsWith("bcrt1p")) {
        throw new Error("Please select a Taproot (P2TR) address in Unisat. Got: " + address);
      }
      // Try to get public key
      let pubKey: string | null = null;
      try {
        pubKey = await window.unisat.getPublicKey();
      } catch {
        // Some versions may not support this
      }
      setExternalTaprootAddress(address);
      setExternalWalletType("unisat");
      setExternalWalletPublicKey(pubKey);
      if (!portfolioAddress) setPortfolioAddress(address);
      // Auto-switch to external signer
      setSignerKind("external");
    } catch (e: any) {
      setExternalWalletErr(String(e?.message ?? e));
    } finally {
      setExternalWalletConnecting(false);
    }
  }

  async function connectXverse() {
    setExternalWalletConnecting(true);
    setExternalWalletErr(null);
    try {
      const response = await new Promise<XverseGetAddressResponse>((resolve, reject) => {
        getAddress({
          payload: {
            purposes: [AddressPurpose.Ordinals], // Ordinals uses Taproot
            message: "Connect to Arch Wallet Hub Demo",
            network: { type: btcNetwork }, // Match wallet's network setting
          } as any, // sats-connect type definitions may be incomplete
          onFinish: (response: XverseGetAddressResponse) => resolve(response),
          onCancel: () => reject(new Error("User cancelled Xverse connection")),
        });
      });
      
      // Find the Taproot address (Ordinals purpose)
      const taprootAddr = response.addresses.find(
        (a: XverseAddress) => a.purpose === AddressPurpose.Ordinals || 
               a.address.startsWith("bc1p") || 
               a.address.startsWith("tb1p")
      );
      
      if (!taprootAddr) {
        throw new Error("No Taproot address found in Xverse response");
      }
      
      setExternalTaprootAddress(taprootAddr.address);
      setExternalWalletType("xverse");
      setExternalWalletPublicKey(taprootAddr.publicKey || null);
      if (!portfolioAddress) setPortfolioAddress(taprootAddr.address);
      // Auto-switch to external signer
      setSignerKind("external");
    } catch (e: any) {
      setExternalWalletErr(String(e?.message ?? e));
    } finally {
      setExternalWalletConnecting(false);
    }
  }

  function disconnectExternalWallet() {
    setExternalTaprootAddress("");
    setExternalWalletType(null);
    setExternalWalletPublicKey(null);
    setExternalWalletErr(null);
  }

  // Helper to convert Uint8Array to hex string (browser-compatible)
  function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Helper to convert hex string to Uint8Array
  function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  // For Unisat: sign using PSBT (same as Xverse) for proper BIP-322 signature
  async function signWithUnisatWallet(psbtBase64: string): Promise<string> {
    if (!window.unisat) throw new Error("Unisat not available");
    console.log("[Unisat] Signing PSBT...");
    
    // Unisat uses hex PSBTs, not base64
    const psbtBytes = Uint8Array.from(atob(psbtBase64), c => c.charCodeAt(0));
    const psbtHex = bytesToHex(psbtBytes);
    console.log("[Unisat] PSBT hex length:", psbtHex.length);
    
    // Sign the PSBT - Unisat returns signed PSBT as hex
    const signedPsbtHex = await window.unisat.signPsbt(psbtHex, { autoFinalized: true });
    console.log("[Unisat] Signed PSBT hex length:", signedPsbtHex.length);
    
    // Convert hex back to bytes for parsing
    const signedPsbtBytes = hexToBytes(signedPsbtHex);
    console.log("[Unisat] Signed PSBT bytes:", signedPsbtBytes.length);
    
    // Extract the 64-byte Schnorr signature from the signed PSBT
    // Same parsing logic as Xverse
    let signatureHex: string | null = null;
    
    // Look for tapKeySig marker (0x01 0x13) followed by signature
    for (let i = 0; i < signedPsbtBytes.length - 65; i++) {
      if (signedPsbtBytes[i] === 0x01 && signedPsbtBytes[i + 1] === 0x13) {
        const sigLen = signedPsbtBytes[i + 2];
        if (sigLen === 64 || sigLen === 65) {
          const sig = signedPsbtBytes.slice(i + 3, i + 3 + 64);
          signatureHex = bytesToHex(sig);
          console.log("[Unisat] Found tapKeySig at offset", i, "len:", sigLen);
          break;
        }
      }
    }
    
    // If not found, look for finalScriptWitness marker (0x01 0x08)
    if (!signatureHex) {
      for (let i = 0; i < signedPsbtBytes.length - 70; i++) {
        if (signedPsbtBytes[i] === 0x01 && signedPsbtBytes[i + 1] === 0x08) {
          const witnessStart = i + 2;
          const witnessLen = signedPsbtBytes[witnessStart];
          if (witnessLen > 0) {
            const itemCount = signedPsbtBytes[witnessStart + 1];
            if (itemCount >= 1) {
              const firstItemLen = signedPsbtBytes[witnessStart + 2];
              if (firstItemLen === 64 || firstItemLen === 65) {
                const sig = signedPsbtBytes.slice(witnessStart + 3, witnessStart + 3 + 64);
                signatureHex = bytesToHex(sig);
                console.log("[Unisat] Found finalScriptWitness at offset", i);
                break;
              }
            }
          }
        }
      }
    }

    // Last resort: scan for any 64-byte sequence
    if (!signatureHex) {
      for (let i = 0; i < signedPsbtBytes.length - 65; i++) {
        if (signedPsbtBytes[i] === 0x40 || signedPsbtBytes[i] === 0x41) {
          const potentialSig = signedPsbtBytes.slice(i + 1, i + 65);
          const rPart = potentialSig.slice(0, 32);
          const isAllZeros = rPart.every(b => b === 0);
          if (!isAllZeros) {
            signatureHex = bytesToHex(potentialSig);
            console.log("[Unisat] Found potential signature at offset", i);
            break;
          }
        }
      }
    }
    
    if (!signatureHex || signatureHex.length !== 128) {
      console.error("[Unisat] PSBT hex dump:", signedPsbtHex.substring(0, 500));
      throw new Error(`Failed to extract 64-byte signature from Unisat. Got ${signatureHex?.length || 0} hex chars`);
    }
    
    console.log("[Unisat] Final signature hex:", signatureHex);
    return signatureHex;
  }

  // For Xverse: use signPsbt with the pre-computed BIP-322 PSBT
  // This is the only way to get a verifiable signature for Arch Network
  async function signWithXverseWallet(psbtBase64: string): Promise<string> {
    console.log("[Xverse] Signing PSBT, address:", externalTaprootAddress);
    
    // Use sats-connect request API for signPsbt
    const response: any = await request("signPsbt", {
      psbt: psbtBase64,
      signInputs: {
        [externalTaprootAddress]: [0]  // Sign input 0 with the Taproot address
      },
      broadcast: false  // Don't broadcast - we extract the sig for Arch
    });

    console.log("[Xverse] signPsbt response:", JSON.stringify(response, null, 2));

    if (response.status !== "success") {
      const errorMsg = response.error?.message || JSON.stringify(response.error) || "Xverse signing failed";
      throw new Error(errorMsg);
    }

    // Parse the signed PSBT to extract the 64-byte Schnorr signature
    const signedPsbtBase64 = response.result?.psbt;
    if (!signedPsbtBase64) throw new Error("No signed PSBT returned from Xverse");

    console.log("[Xverse] Signed PSBT base64:", signedPsbtBase64.substring(0, 100) + "...");

    // Decode the signed PSBT and look for the signature
    // The PSBT has the signature in tapKeySig or in the finalized witness
    const signedPsbtBytes = Uint8Array.from(atob(signedPsbtBase64), c => c.charCodeAt(0));
    
    // Parse PSBT manually to find the signature
    // PSBT format: magic (5 bytes) + global map + input maps + output maps
    // We need to find the tapKeySig (key type 0x13) or finalScriptWitness (key type 0x08)
    
    // For simplicity, let's search for a 64 or 65 byte sequence that looks like a Schnorr signature
    // Schnorr signatures have specific structure: 32-byte r, 32-byte s
    // We'll look for the signature after common PSBT markers
    
    let signatureHex: string | null = null;
    
    // Look for tapKeySig marker (0x01 0x13) followed by signature
    for (let i = 0; i < signedPsbtBytes.length - 65; i++) {
      // Check for key-value pair with key type 0x13 (TAP_KEY_SIG)
      if (signedPsbtBytes[i] === 0x01 && signedPsbtBytes[i + 1] === 0x13) {
        // Next byte should be the value length
        const sigLen = signedPsbtBytes[i + 2];
        if (sigLen === 64 || sigLen === 65) {
          const sig = signedPsbtBytes.slice(i + 3, i + 3 + 64);
          signatureHex = bytesToHex(sig);
          console.log("[Xverse] Found tapKeySig at offset", i, "len:", sigLen);
          break;
        }
      }
    }
    
    // If not found, look for finalScriptWitness marker (0x01 0x08)
    if (!signatureHex) {
      for (let i = 0; i < signedPsbtBytes.length - 70; i++) {
        if (signedPsbtBytes[i] === 0x01 && signedPsbtBytes[i + 1] === 0x08) {
          // Parse witness: varint count, then varint len + data for each item
          const witnessStart = i + 2;
          const witnessLen = signedPsbtBytes[witnessStart];
          if (witnessLen > 0) {
            const itemCount = signedPsbtBytes[witnessStart + 1];
            if (itemCount >= 1) {
              const firstItemLen = signedPsbtBytes[witnessStart + 2];
              if (firstItemLen === 64 || firstItemLen === 65) {
                const sig = signedPsbtBytes.slice(witnessStart + 3, witnessStart + 3 + 64);
                signatureHex = bytesToHex(sig);
                console.log("[Xverse] Found finalScriptWitness at offset", i);
                break;
              }
            }
          }
        }
      }
    }

    // Last resort: scan for any 64-byte sequence that could be a signature
    if (!signatureHex) {
      console.log("[Xverse] Searching for signature pattern in PSBT bytes...");
      // Look for length byte 0x40 (64) or 0x41 (65) followed by valid-looking data
      for (let i = 0; i < signedPsbtBytes.length - 65; i++) {
        if (signedPsbtBytes[i] === 0x40 || signedPsbtBytes[i] === 0x41) {
          const potentialSig = signedPsbtBytes.slice(i + 1, i + 65);
          // Basic sanity check: first 32 bytes (r) should not be all zeros
          const rPart = potentialSig.slice(0, 32);
          const isAllZeros = rPart.every(b => b === 0);
          if (!isAllZeros) {
            signatureHex = bytesToHex(potentialSig);
            console.log("[Xverse] Found potential signature at offset", i);
            break;
          }
        }
      }
    }

    if (!signatureHex || signatureHex.length !== 128) {
      console.error("[Xverse] PSBT hex dump:", bytesToHex(signedPsbtBytes));
      throw new Error(`Failed to extract 64-byte signature from signed PSBT. Got: ${signatureHex?.length || 0} hex chars`);
    }

    console.log("[Xverse] Final signature:", signatureHex);
    return signatureHex;
  }

  async function signWithExternalWallet(params: { psbtBase64: string }): Promise<string> {
    if (!externalWalletType) throw new Error("No external wallet connected");
    if (!params.psbtBase64) throw new Error("psbtBase64 required for signing");
    
    // Both Unisat and Xverse use PSBT signing for proper BIP-322 signatures
    if (externalWalletType === "unisat") {
      return signWithUnisatWallet(params.psbtBase64);
    } else if (externalWalletType === "xverse") {
      return signWithXverseWallet(params.psbtBase64);
    }
    
    throw new Error(`Unknown wallet type: ${externalWalletType}`);
  }

  async function onApproveWithExternalWallet() {
    if (!approveSigningRequestId) return;
    setExternalSignLoading(true);
    setSubmitErr(null);
    setSubmitRes(null);
    try {
      // Get signing request payload
      const sr = await client.getSigningRequest(approveSigningRequestId);
      const p: any = (sr as any).payloadToSign;
      
      // Both Xverse and Unisat use PSBT signing for proper BIP-322 signatures
      const psbtBase64 = String(p?.psbtBase64 ?? "");
      if (!psbtBase64) throw new Error("Missing payloadToSign.psbtBase64 for external wallet signing");
      
      const signature = await signWithExternalWallet({ psbtBase64 });
      
      // Submit the signature
      const submit = await client.submitSigningRequest(approveSigningRequestId, {
        externalUserId,
        signature64Hex: signature,
      });
      setSubmitRes(submit);
      await refreshApprove();
    } catch (e: any) {
      setSubmitErr(String(e?.message ?? e));
    } finally {
      setExternalSignLoading(false);
    }
  }

  async function onCreateTurnkeyWallet() {
    setTurnkeyCreateLoading(true);
    setTurnkeyCreateErr(null);
    setTurnkeyCreateRes(null);
    try {
      const idempotencyKey = makeIdempotencyKey();
      const res = await client.createTurnkeyWallet({
        idempotencyKey,
        body: {
          externalUserId,
          walletName: walletName || undefined
        }
      });
      setTurnkeyCreateRes(res);
      if (typeof (res as any)?.resourceId === "string") setTurnkeyResourceId((res as any).resourceId);
      const defaultAddr = (res as any)?.defaultAddress as string | null | undefined;
      if (defaultAddr && !portfolioAddress) setPortfolioAddress(defaultAddr);
      try {
        const listed = await client.listTurnkeyWallets(externalUserId);
        setTurnkeyWallets(listed.wallets ?? []);
      } catch {
        // ignore
      }
    } catch (e: any) {
      setTurnkeyCreateErr(String(e?.message ?? e));
    } finally {
      setTurnkeyCreateLoading(false);
    }
  }

  function getTurnkeyForOrg(organizationId: string) {
    if (!organizationId) throw new Error("Missing Turnkey organizationId for passkey session");
    return new Turnkey({
      apiBaseUrl: turnkeyApiBaseUrl,
      defaultOrganizationId: organizationId,
      rpId: turnkeyRpId
    });
  }

  async function getSelectedWalletOrgId(resourceIdOverride?: string): Promise<string> {
    const rid = resourceIdOverride ?? turnkeyResourceId;
    if (!rid) throw new Error("Select a Turnkey wallet (resourceId) first");
    const walletMeta = await client.getTurnkeyWallet({ resourceId: rid, externalUserId });
    if (!(walletMeta as any)?.turnkeyRootUserId) {
      throw new Error(
        "Selected Turnkey wallet is custodial (no passkey authenticator). Select a passkey wallet or create a passkey wallet."
      );
    }
    const orgId = String((walletMeta as any)?.organizationId ?? "");
    if (!orgId) throw new Error("Selected wallet is missing organizationId");
    return orgId;
  }

  async function onCreatePasskeyWallet() {
    setTurnkeyCreateLoading(true);
    setTurnkeyCreateErr(null);
    setTurnkeyCreateRes(null);
    setTurnkeyPasskeyErr(null);
    setTurnkeyPasskeyReady(false);
    try {
      // Creating a passkey wallet uses server-side Turnkey API keys (Wallet Hub), not the browser.
      // In the browser we only need Turnkey for passkey login/signing.
      const turnkeyForRp = new Turnkey({ apiBaseUrl: turnkeyApiBaseUrl, defaultOrganizationId: "00000000-0000-0000-0000-000000000000", rpId: turnkeyRpId });

      const passkeyClient = turnkeyForRp.passkeyClient();
      const { encodedChallenge, attestation } =
        (await passkeyClient.createUserPasskey({
          publicKey: {
            rp: { id: turnkeyRpId, name: "Wallet Hub Demo" },
            user: { name: externalUserId, displayName: externalUserId }
          }
        })) || ({} as any);

      if (!encodedChallenge || !attestation) throw new Error("Failed to create passkey attestation");

      const idempotencyKey = makeIdempotencyKey();
      const res = await client.createTurnkeyPasskeyWallet({
        idempotencyKey,
        body: {
          externalUserId,
          walletName: walletName || undefined,
          passkey: { challenge: encodedChallenge, attestation }
        }
      });

      setTurnkeyCreateRes(res);
      if (typeof (res as any)?.resourceId === "string") setTurnkeyResourceId((res as any).resourceId);
      const defaultAddr = (res as any)?.defaultAddress as string | null | undefined;
      if (defaultAddr && !portfolioAddress) setPortfolioAddress(defaultAddr);
      setTurnkeyPasskeyReady(true);
      try {
        const listed = await client.listTurnkeyWallets(externalUserId);
        setTurnkeyWallets(listed.wallets ?? []);
      } catch {
        // ignore
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("NotAllowedError")) {
        // User canceled passkey prompt; avoid stuck state.
        window.location.reload();
        return;
      }
      setTurnkeyCreateErr(msg);
    } finally {
      setTurnkeyCreateLoading(false);
    }
  }

  async function onLoadTurnkeyWallets() {
    setTurnkeyWalletsLoading(true);
    setTurnkeyWalletsErr(null);
    try {
      const listed = await client.listTurnkeyWallets(externalUserId);
      const wallets = Array.isArray((listed as any)?.wallets) ? (listed as any).wallets : [];
      setTurnkeyWallets(wallets);
      if (!turnkeyResourceId && wallets[0]?.id) setTurnkeyResourceId(String(wallets[0].id));
    } catch (e: any) {
      setTurnkeyWalletsErr(String(e?.message ?? e));
    } finally {
      setTurnkeyWalletsLoading(false);
    }
  }

  async function onPasskeyLogin() {
    setTurnkeyPasskeyErr(null);
    setTurnkeyPasskeyReady(false);
    if (turnkeyPasskeyLoginLoading) return;
    setTurnkeyPasskeyLoginLoading(true);
    try {
      const rid = approveOpen && approveTurnkeyResourceId ? approveTurnkeyResourceId : turnkeyResourceId;
      const organizationId = await getSelectedWalletOrgId(rid);
      const turnkey = getTurnkeyForOrg(organizationId);
      const passkeyClient = turnkey.passkeyClient();
      // This prompts the user and verifies the passkey authenticator exists for the sub-org.
      await (passkeyClient as any).getWhoami({ organizationId });
      setTurnkeyPasskeyReady(true);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.toLowerCase().includes("request is already pending")) {
        setTurnkeyPasskeyErr(
          "A passkey prompt is already open/pending. Complete or cancel the browser passkey prompt, then try again. If it’s stuck, refresh the page."
        );
      } else if (msg.includes("NotAllowedError")) {
        // User canceled passkey prompt; avoid stuck state.
        window.location.reload();
        return;
      } else {
        setTurnkeyPasskeyErr(msg);
      }
    } finally {
      setTurnkeyPasskeyLoginLoading(false);
    }
  }

  async function onTurnkeySignPayloadAndSubmit(signingRequestIdOverride?: string) {
    setTurnkeySignLoading(true);
    setTurnkeySignRes(null);
    setSubmitErr(null);
    try {
      const srId = signingRequestIdOverride ?? signingRequestId;
      if (!srId) throw new Error("Missing signingRequestId");
      const rid = approveOpen && approveTurnkeyResourceId ? approveTurnkeyResourceId : turnkeyResourceId;
      if (!rid) throw new Error("Missing Turnkey resourceId");

      // Fetch org id for this wallet resource (sub-org)
      const walletMeta = await client.getTurnkeyWallet({ resourceId: rid, externalUserId });
      const organizationId = walletMeta.organizationId;
      const turnkey = getTurnkeyForOrg(organizationId);

      // Get signing request payload
      const sr = await client.getSigningRequest(srId);
      const p: any = (sr as any).payloadToSign;
      if (p?.kind !== "taproot_sighash_hex") throw new Error(`Unexpected payloadToSign.kind: ${String(p?.kind)}`);

      // Ensure we have a passkey-backed session before signing.
      if (!turnkeyPasskeyReady) {
        await onPasskeyLogin();
      }

      // Sign directly via Passkey stamper in the sub-org (prompts user per action).
      // This avoids IndexedDB session key registration and voter/org mismatch issues.
      const passkeyClient = turnkey.passkeyClient();
      const resp: any = await (passkeyClient as any).signRawPayload({
        organizationId,
        signWith: String(p.signWith),
        payload: String(p.payloadHex),
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        hashFunction: "HASH_FUNCTION_NO_OP"
      });
      const r = resp?.activity?.result?.signRawPayloadResult?.r;
      const s = resp?.activity?.result?.signRawPayloadResult?.s;
      const activityId = resp?.activity?.id ?? null;
      if (!r || !s) throw new Error("Turnkey signRawPayload did not return r/s");

      const signature64Hex = `${r}${s}`;
      setTurnkeySignRes({ activityId, signature64Hex });

      const submit = await client.submitSigningRequest(srId, {
        externalUserId,
        signature64Hex,
        turnkeyActivityId: activityId ?? undefined
      });
      setSubmitRes(submit);
    } catch (e: any) {
      setSubmitErr(String(e?.message ?? e));
    } finally {
      setTurnkeySignLoading(false);
    }
  }

  async function onCreateSigningRequest() {
    setCreateLoading(true);
    setCreateErr(null);
    setCreateRes(null);
    try {
      const signer =
        signerKind === "turnkey"
          ? { kind: "turnkey" as const, resourceId: turnkeyResourceId }
          : { 
              kind: "external" as const, 
              taprootAddress: externalTaprootAddress,
              // Include the wallet's public key - this is the INTERNAL key (before BIP-86 tweaking)
              // which is needed for correct PSBT tapInternalKey and Arch account derivation
              publicKeyHex: externalWalletPublicKey || undefined
            };

      const action =
        actionType === "arch.transfer"
          ? { type: "arch.transfer" as const, toAddress, lamports }
          : { type: "arch.anchor" as const, btcTxid, vout: btcVout };

      const res = await client.createSigningRequest({ externalUserId, signer, action });
      setCreateRes(res);
      const id = (res as any)?.signingRequestId;
      if (typeof id === "string") {
        setSigningRequestId(id);
        setApproveSigningRequestId(id);
        if (signerKind === "turnkey") setApproveTurnkeyResourceId(turnkeyResourceId);
        // Clear previous modal state before opening
        setApproveErr(null);
        setSubmitErr(null);
        setSubmitRes(null);
        setApproveReq(null);
        setApproveOpen(true);
      }
    } catch (e: any) {
      setCreateErr(String(e?.message ?? e));
    } finally {
      setCreateLoading(false);
    }
  }

  async function refreshApprove() {
    if (!approveSigningRequestId) return;
    setApproveLoading(true);
    setApproveErr(null);
    try {
      const sr = await client.getSigningRequest(approveSigningRequestId);
      setApproveReq(sr as any);
    } catch (e: any) {
      setApproveErr(String(e?.message ?? e));
    } finally {
      setApproveLoading(false);
    }
  }

  useEffect(() => {
    if (!approveOpen || !approveSigningRequestId) return;
    void refreshApprove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveOpen, approveSigningRequestId]);

  useEffect(() => {
    if (!approveOpen || !approveSigningRequestId) return;
    const interval = window.setInterval(() => void refreshApprove(), 2000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveOpen, approveSigningRequestId]);

  async function onApproveWithPasskey() {
    if (!approveSigningRequestId) return;
    setSubmitErr(null);
    setSubmitRes(null);
    if (!turnkeyPasskeyReady) {
      await onPasskeyLogin();
    }
    await onTurnkeySignPayloadAndSubmit(approveSigningRequestId);
    await refreshApprove();
  }

  async function onAirdropApproveFromAccount() {
    setApproveErr(null);
    try {
      const fromArch = String((approveReq as any)?.display?.from?.archAccountAddress ?? "");
      if (!fromArch) throw new Error("Missing display.from.archAccountAddress");
      await client.airdropArchAccount({ archAccountAddress: fromArch });
      await refreshApprove();
    } catch (e: any) {
      setApproveErr(String(e?.message ?? e));
    }
  }

  async function onSubmitSignature() {
    setSubmitLoading(true);
    setSubmitErr(null);
    setSubmitRes(null);
    try {
      const res = await client.submitSigningRequest(signingRequestId, {
        externalUserId,
        signature64Hex: submitSig64Hex || undefined,
        turnkeyActivityId: submitActivityId || undefined
      });
      setSubmitRes(res);
    } catch (e: any) {
      setSubmitErr(String(e?.message ?? e));
    } finally {
      setSubmitLoading(false);
    }
  }

  async function onGetSigningRequest() {
    setGetLoading(true);
    setGetErr(null);
    setGetRes(null);
    try {
      const res = await client.getSigningRequest(signingRequestId);
      setGetRes(res);
    } catch (e: any) {
      setGetErr(String(e?.message ?? e));
    } finally {
      setGetLoading(false);
    }
  }

  async function onStartPolling() {
    if (!signingRequestId) return;
    setPolling(true);
    setGetErr(null);
    try {
      while (true) {
        const res = await client.getSigningRequest(signingRequestId);
        setGetRes(res);
        const status = String((res as any)?.readiness?.status ?? "");
        if (status === "ready") break;
        await new Promise((r) => setTimeout(r, Math.max(250, pollEveryMs)));
        if (!(globalThis as any).__walletHubPoll) break;
      }
    } catch (e: any) {
      setGetErr(String(e?.message ?? e));
    } finally {
      setPolling(false);
      (globalThis as any).__walletHubPoll = false;
    }
  }

  function onStopPolling() {
    (globalThis as any).__walletHubPoll = false;
    setPolling(false);
  }

  const readiness = (getRes as any)?.readiness as any;
  const readinessStatus = String(readiness?.status ?? "");
  const readinessClass =
    readinessStatus === "ready" ? "ok" : readinessStatus === "not_ready" ? "warn" : readinessStatus ? "bad" : "";

  const approveReadiness = (approveReq as any)?.readiness as any;
  const approveReadinessStatus = String(approveReadiness?.status ?? "");
  const approveReadinessClass =
    approveReadinessStatus === "ready"
      ? "ok"
      : approveReadinessStatus === "not_ready"
        ? "warn"
        : approveReadinessStatus
          ? "bad"
          : "";

  // Extract display data for clean preview
  const displayData = (approveReq as any)?.display ?? {};
  
  // Determine transaction type - handle both "kind" and "type" fields
  const isAnchor = displayData?.kind === "arch.anchor" || (approveReq as any)?.actionType === "arch.anchor";
  const txTypeRaw = displayData?.type ?? displayData?.kind ?? (approveReq as any)?.actionType ?? "Transaction";
  const txType = String(txTypeRaw).replace("arch.", "").toUpperCase();
  
  // Safely extract addresses - handle both transfer (from/to) and anchor (account) structures
  // For anchor, the account info is in displayData.account, not displayData.from
  const fromRaw = isAnchor ? displayData?.account : displayData?.from;
  const fromAddress = typeof fromRaw === "string" 
    ? fromRaw 
    : (fromRaw?.archAccountAddress ?? fromRaw?.archAccount ?? fromRaw?.taprootAddress ?? "—");
  
  // For anchor, the "to" is the BTC account address where the UTXO should be
  const btcAccountAddress = displayData?.account?.btcAccountAddress;
  const toRaw = displayData?.to;
  const toAddressDisplay = isAnchor 
    ? (btcAccountAddress && btcAccountAddress !== "unknown" ? `BTC: ${btcAccountAddress}` : null)
    : (typeof toRaw === "string"
        ? toRaw
        : (toRaw?.archAccountAddress ?? toRaw?.archAccount ?? toRaw?.input ?? "—"));
  
  const amountDisplay = displayData?.amount ?? displayData?.lamports ?? null;
  
  // Anchor-specific fields - UTXO being anchored
  const btcTxidDisplay = displayData?.btcTxid ?? displayData?.utxo?.txid ?? null;
  const btcVoutDisplay = displayData?.vout ?? displayData?.utxo?.vout ?? null;

  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="container">
      {approveOpen ? (
        <div
          className="modalOverlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setApproveOpen(false);
          }}
        >
          <div className="modal">
            {/* Modal Header */}
            <div className="modalHeader">
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <div style={{
                  width: 40,
                  height: 40,
                  background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20
                }}>
                  ⚡
                </div>
                <div>
                  <div className="modalTitle">Confirm Transaction</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>
                    Review and sign with your wallet
                  </div>
                </div>
              </div>
              <button className="closeBtn" onClick={() => setApproveOpen(false)}>
                ✕
              </button>
            </div>

            <div className="modalBody">
              {/* Success State */}
              {submitRes && (
                <div className="statusMessage success">
                  <div className="statusIcon">✓</div>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Transaction Submitted!</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>
                      Your transaction has been broadcast to the Arch Network.
                    </div>
                  </div>
                </div>
              )}

              {/* Error State */}
              {(approveErr || submitErr) && (
                <div className="statusMessage error">
                  <div className="statusIcon">✕</div>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Transaction Failed</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>
                      {approveErr || submitErr}
                    </div>
                  </div>
                </div>
              )}

              {/* Transaction Preview Card */}
              <div className="txPreview">
                <div className="txPreviewHeader">
                  <div className="txPreviewIcon">
                    {txType === "TRANSFER" ? "↗" : txType === "ANCHOR" ? "⚓" : "📝"}
                  </div>
                  <div>
                    <div className="txPreviewTitle">{txType}</div>
                    <div className="txPreviewSubtitle">Arch Network Transaction</div>
                  </div>
                  <div style={{ marginLeft: "auto" }}>
                    <div className={`pill ${approveReadinessClass || "warn"}`} style={{ margin: 0 }}>
                      {approveReadinessStatus === "ready" ? "✓ Ready" : 
                       approveReadinessStatus === "not_ready" ? "⏳ Pending" : 
                       approveReadinessStatus ? approveReadinessStatus :
                       approveReq ? "⏳ Checking..." : "Loading..."}
                    </div>
                  </div>
                </div>

                <div className="txDetail">
                  <span className="txDetailLabel">{isAnchor ? "Account" : "From"}</span>
                  <span className="txDetailValue mono">{fromAddress}</span>
                </div>
                {toAddressDisplay && toAddressDisplay !== "—" && (
                  <div className="txDetail">
                    <span className="txDetailLabel">{isAnchor ? "BTC Address" : "To"}</span>
                    <span className="txDetailValue mono">{toAddressDisplay}</span>
                  </div>
                )}
                {amountDisplay && (
                  <div className="txDetail">
                    <span className="txDetailLabel">Amount</span>
                    <span className="txDetailValue">
                      <span style={{ fontWeight: 600 }}>
                        {(parseInt(String(amountDisplay)) / 100000000).toFixed(8)} ARCH
                      </span>
                      <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 8 }}>
                        ({amountDisplay} lamports)
                      </span>
                    </span>
                  </div>
                )}
                {btcTxidDisplay && (
                  <div className="txDetail">
                    <span className="txDetailLabel">Anchoring UTXO</span>
                    <span className="txDetailValue mono" style={{ fontSize: 11 }}>
                      {btcTxidDisplay}:{btcVoutDisplay ?? 0}
                    </span>
                  </div>
                )}
                <div className="txDetail">
                  <span className="txDetailLabel">Network</span>
                  <span className="txDetailValue">Arch Testnet</span>
                </div>
                <div className="txDetail">
                  <span className="txDetailLabel">Request ID</span>
                  <span className="txDetailValue mono" style={{ fontSize: 11 }}>{approveSigningRequestId}</span>
                </div>
              </div>

              {/* Airdrop Button if Needed */}
              {String(approveReadiness?.reason ?? "") === "ArchAccountNotFound" && (
                <div className="statusMessage info" style={{ marginBottom: 16 }}>
                  <div className="statusIcon" style={{ background: "var(--info)" }}>💧</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Account Not Found</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>
                      This Arch account needs to be funded first.
                    </div>
                  </div>
                  <button 
                    onClick={() => void onAirdropApproveFromAccount()} 
                    disabled={!apiKey || approveLoading}
                    style={{ marginLeft: "auto" }}
                  >
                    {approveLoading ? "..." : "Request Airdrop"}
                  </button>
                </div>
              )}

              {/* Sign Section */}
              <div className="signSection">
                <div className="signSectionTitle">
                  <span style={{ color: "var(--accent-primary)" }}>🔐</span>
                  Select Wallet to Sign
                </div>

                {/* External Wallet Option */}
                {externalWalletType && externalTaprootAddress && (
                  <div className="walletOption">
                    <div className="walletInfo">
                      <div className={`walletIcon ${externalWalletType}`}>
                        {externalWalletType === "xverse" ? "X" : "U"}
                      </div>
                      <div>
                        <div className="walletName">{externalWalletType === "xverse" ? "Xverse" : "Unisat"}</div>
                        <div className="walletAddress">
                          {externalTaprootAddress.slice(0, 8)}...{externalTaprootAddress.slice(-6)}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => void onApproveWithExternalWallet()}
                      disabled={!approveSigningRequestId || !apiKey || externalSignLoading || approveLoading || approveReadinessStatus !== "ready"}
                      className="btn-primary"
                    >
                      {externalSignLoading ? (
                        <><span className="spinner"></span> Signing...</>
                      ) : (
                        `Sign with ${externalWalletType === "xverse" ? "Xverse" : "Unisat"}`
                      )}
                    </button>
                  </div>
                )}

                {/* Turnkey Wallet Option */}
                {turnkeyResourceId && (
                  <div className="walletOption">
                    <div className="walletInfo">
                      <div className="walletIcon turnkey">🔑</div>
                      <div>
                        <div className="walletName">Turnkey Wallet</div>
                        <div className="walletAddress">
                          {turnkeyPasskeyReady ? (
                            <span style={{ color: "var(--success-light)" }}>● Connected</span>
                          ) : (
                            <span style={{ color: "var(--warning-light)" }}>○ Not logged in</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {!turnkeyPasskeyReady && (
                        <button 
                          onClick={() => void onPasskeyLogin()} 
                          disabled={turnkeyPasskeyLoginLoading}
                        >
                          {turnkeyPasskeyLoginLoading ? "..." : "Login"}
                        </button>
                      )}
                      <button
                        onClick={() => void onApproveWithPasskey()}
                        disabled={!turnkeyResourceId || !approveSigningRequestId || !apiKey || turnkeySignLoading || approveLoading || approveReadinessStatus !== "ready"}
                        className="btn-primary"
                      >
                        {turnkeySignLoading ? (
                          <><span className="spinner"></span> Signing...</>
                        ) : (
                          "Sign with Passkey"
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* No Wallet */}
                {!externalWalletType && !turnkeyResourceId && (
                  <div style={{ 
                    textAlign: "center", 
                    padding: 24, 
                    color: "var(--text-muted)",
                    background: "rgba(0,0,0,0.2)",
                    borderRadius: 10
                  }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>🔗</div>
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>No Wallet Connected</div>
                    <div style={{ fontSize: 13 }}>
                      Connect an external wallet or select a Turnkey wallet first.
                    </div>
                  </div>
                )}
              </div>

              {/* Advanced / Technical Details (Collapsible) */}
              <div className="collapsible">
                <div 
                  className="collapsibleHeader"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  <span>🔧 Technical Details</span>
                  <span style={{ transform: showAdvanced ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
                    ▼
                  </span>
                </div>
                {showAdvanced && (
                  <div className="collapsibleContent">
                    <div className="split">
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-muted)" }}>
                          DISPLAY DATA
                        </div>
                        <pre style={{ 
                          fontSize: 11, 
                          background: "rgba(0,0,0,0.3)", 
                          padding: 12, 
                          borderRadius: 8,
                          overflow: "auto",
                          maxHeight: 200
                        }}>
                          {safeJson(displayData)}
                        </pre>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-muted)" }}>
                          PAYLOAD TO SIGN
                        </div>
                        <pre style={{ 
                          fontSize: 11, 
                          background: "rgba(0,0,0,0.3)", 
                          padding: 12, 
                          borderRadius: 8,
                          overflow: "auto",
                          maxHeight: 200
                        }}>
                          {safeJson((approveReq as any)?.payloadToSign ?? null)}
                        </pre>
                      </div>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <button 
                        onClick={() => void refreshApprove()} 
                        disabled={!approveSigningRequestId || approveLoading}
                        style={{ fontSize: 12 }}
                      >
                        {approveLoading ? "Refreshing..." : "↻ Refresh Status"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Transaction Result */}
              {submitRes && (
                <div className="collapsible" style={{ marginTop: 12 }}>
                  <div className="collapsibleHeader" style={{ background: "var(--success-bg)" }}>
                    <span style={{ color: "var(--success-light)" }}>✓ Transaction Result</span>
                  </div>
                  <div className="collapsibleContent">
                    <pre style={{ 
                      fontSize: 11, 
                      background: "rgba(0,0,0,0.3)", 
                      padding: 12, 
                      borderRadius: 8,
                      overflow: "auto",
                      maxHeight: 200
                    }}>
                      {safeJson(submitRes)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Top Bar with API Config */}
      <div style={{ 
        display: "flex", 
        alignItems: "center", 
        justifyContent: "space-between",
        marginBottom: 24
      }}>
        {/* Logo/Brand */}
        <div style={{ 
          display: "flex", 
          alignItems: "center", 
          gap: 12
        }}>
          <div style={{
            width: 36,
            height: 36,
            background: "var(--accent-gradient)",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18
          }}>⚡</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Wallet Hub</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Arch Network</div>
          </div>
        </div>

        {/* API Config - Top Right */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowApiConfig(!showApiConfig)}
            style={{ 
              display: "flex", 
              alignItems: "center", 
              gap: 8,
              padding: "8px 14px",
              background: showApiConfig ? "rgba(99, 102, 241, 0.15)" : "rgba(0,0,0,0.3)",
              borderRadius: 8,
              border: `1px solid ${showApiConfig ? "rgba(99, 102, 241, 0.3)" : "var(--border-default)"}`,
              cursor: "pointer",
              fontSize: 13,
              color: "var(--text-primary)"
            }}
          >
            <div style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: apiKey ? "var(--success)" : "var(--warning)"
            }} />
            <span>{apiKey ? "Connected" : "Configure API"}</span>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>⚙️</span>
          </button>
          
          {/* Dropdown Panel */}
          {showApiConfig && (
            <div style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 8,
              padding: 16,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-light)",
              borderRadius: 10,
              boxShadow: "var(--shadow-lg)",
              minWidth: 280,
              zIndex: 100
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: "var(--text-muted)" }}>
                API CONFIGURATION
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                  Endpoint URL
                </label>
                <input 
                  value={baseUrl} 
                  onChange={(e) => setBaseUrl(e.target.value)} 
                  placeholder="http://localhost:3005/v1"
                  style={{ width: "100%", fontSize: 12 }}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                  API Key
                </label>
                <input 
                  value={apiKey} 
                  onChange={(e) => setApiKey(e.target.value)} 
                  placeholder="Enter API key..."
                  style={{ width: "100%", fontSize: 12 }}
                />
              </div>
              <button 
                onClick={() => setShowApiConfig(false)}
                style={{ width: "100%", fontSize: 12 }}
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Hero Header */}
      <div className="header" style={{ paddingTop: 0 }}>
        <div className="title">Seamless Arch Integration</div>
        <div className="subtitle">
          Connect your Bitcoin wallet or use embedded Turnkey wallets to interact with the Arch Network.
        </div>
      </div>

      {/* Wallet Connection Cards */}
      <div style={{ 
        display: "grid", 
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", 
        gap: 24, 
        marginBottom: 24 
      }}>
        {/* External Wallet Card - Primary */}
        <div className="card" style={{ 
          background: externalTaprootAddress 
            ? "linear-gradient(135deg, rgba(238, 122, 48, 0.08), rgba(99, 102, 241, 0.05))" 
            : undefined,
          borderColor: externalTaprootAddress ? "rgba(238, 122, 48, 0.3)" : undefined
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
            <div style={{
              width: 56,
              height: 56,
              background: "linear-gradient(135deg, #ee7a30, #f7931a)",
              borderRadius: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
              fontWeight: 700
            }}>₿</div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ 
                  width: 0, 
                  height: 0, 
                  background: "none",
                  border: "none",
                  content: "''"
                }}></span>
                Bitcoin Wallets
                {externalTaprootAddress && (
                  <span style={{ 
                    background: "var(--success)", 
                    color: "white", 
                    fontSize: 11, 
                    padding: "2px 8px", 
                    borderRadius: 999,
                    fontWeight: 500
                  }}>Connected</span>
                )}
              </h2>
              <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
                Connect Xverse or Unisat wallet
              </div>
            </div>
          </div>
          
          {externalTaprootAddress ? (
            <div>
              <div style={{ 
                background: "rgba(0,0,0,0.2)", 
                borderRadius: 10, 
                padding: 16, 
                marginBottom: 16 
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <div style={{
                    width: 36,
                    height: 36,
                    background: externalWalletType === "xverse" 
                      ? "linear-gradient(135deg, #ee7a30, #f5a623)" 
                      : "linear-gradient(135deg, #f7931a, #ff6b00)",
                    borderRadius: 8,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700
                  }}>
                    {externalWalletType === "xverse" ? "X" : "U"}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {externalWalletType === "xverse" ? "Xverse Wallet" : "Unisat Wallet"}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {btcNetwork} Network
                    </div>
                  </div>
                </div>
                <div style={{ 
                  fontFamily: "var(--font-mono)", 
                  fontSize: 11, 
                  color: "var(--text-secondary)",
                  background: "rgba(0,0,0,0.2)",
                  padding: "8px 12px",
                  borderRadius: 6,
                  wordBreak: "break-all"
                }}>
                  {externalTaprootAddress}
                </div>
              </div>
              <button 
                onClick={disconnectExternalWallet}
                style={{ 
                  width: "100%",
                  background: "rgba(239, 68, 68, 0.1)", 
                  borderColor: "rgba(239, 68, 68, 0.3)",
                  color: "var(--error-light)"
                }}
              >
                Disconnect Wallet
              </button>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                  Select Network
                </label>
                <select 
                  value={btcNetwork} 
                  onChange={(e) => setBtcNetwork(e.target.value)}
                  style={{ width: "100%" }}
                >
                  <option value="Mainnet">Mainnet</option>
                  <option value="Testnet">Testnet (legacy)</option>
                  <option value="Testnet4">Testnet4</option>
                  <option value="Signet">Signet</option>
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <button 
                  onClick={connectXverse} 
                  disabled={externalWalletConnecting}
                  style={{ 
                    display: "flex", 
                    flexDirection: "column", 
                    alignItems: "center", 
                    gap: 8, 
                    padding: 16,
                    background: "rgba(238, 122, 48, 0.1)",
                    borderColor: "rgba(238, 122, 48, 0.3)"
                  }}
                >
                  <span style={{ 
                    width: 32, 
                    height: 32, 
                    background: "linear-gradient(135deg, #ee7a30, #f5a623)",
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700
                  }}>X</span>
                  <span>Xverse</span>
                </button>
                <button 
                  onClick={connectUnisat} 
                  disabled={externalWalletConnecting}
                  style={{ 
                    display: "flex", 
                    flexDirection: "column", 
                    alignItems: "center", 
                    gap: 8, 
                    padding: 16,
                    background: "rgba(247, 147, 26, 0.1)",
                    borderColor: "rgba(247, 147, 26, 0.3)"
                  }}
                >
                  <span style={{ 
                    width: 32, 
                    height: 32, 
                    background: "linear-gradient(135deg, #f7931a, #ff6b00)",
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700
                  }}>U</span>
                  <span>Unisat</span>
                </button>
              </div>
            </>
          )}
          
          {externalWalletErr && (
            <div className="statusMessage error" style={{ marginTop: 16 }}>
              <div className="statusIcon">✕</div>
              <div style={{ fontSize: 13 }}>{externalWalletErr}</div>
            </div>
          )}
        </div>

        {/* Turnkey Embedded Wallet Card */}
        <div className="card" style={{ 
          background: turnkeyPasskeyReady 
            ? "linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(139, 92, 246, 0.05))" 
            : undefined,
          borderColor: turnkeyPasskeyReady ? "rgba(99, 102, 241, 0.3)" : undefined
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
            <div style={{
              width: 56,
              height: 56,
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              borderRadius: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24
            }}>🔑</div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 0, height: 0 }}></span>
                Turnkey Wallet
                {turnkeyPasskeyReady && (
                  <span style={{ 
                    background: "var(--success)", 
                    color: "white", 
                    fontSize: 11, 
                    padding: "2px 8px", 
                    borderRadius: 999,
                    fontWeight: 500
                  }}>Ready</span>
                )}
              </h2>
              <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
                Embedded passkey-based wallet
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
              User ID
            </label>
            <input 
              value={externalUserId} 
              onChange={(e) => setExternalUserId(e.target.value)} 
              placeholder="Enter user identifier..."
            />
          </div>

          {turnkeyResourceId && (
            <div style={{ 
              background: "rgba(0,0,0,0.2)", 
              borderRadius: 10, 
              padding: 12, 
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              gap: 12
            }}>
              <div style={{ 
                width: 8, 
                height: 8, 
                borderRadius: "50%", 
                background: turnkeyPasskeyReady ? "var(--success)" : "var(--warning)" 
              }}></div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Resource ID</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {turnkeyResourceId.slice(0, 20)}...
                </div>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gap: 8 }}>
            <button 
              onClick={onCreatePasskeyWallet}
              disabled={turnkeyCreateLoading || !apiKey || !externalUserId}
              className="btn-primary"
              style={{ width: "100%" }}
            >
              {turnkeyCreateLoading ? "Creating..." : "Create New Wallet"}
            </button>
            {turnkeyResourceId && !turnkeyPasskeyReady && (
              <button 
                onClick={onPasskeyLogin} 
                disabled={turnkeyPasskeyLoginLoading}
                style={{ width: "100%" }}
              >
                {turnkeyPasskeyLoginLoading ? "Authenticating..." : "Login with Passkey"}
              </button>
            )}
          </div>

          {(turnkeyPasskeyErr || turnkeyCreateErr) && (
            <div className="statusMessage error" style={{ marginTop: 16 }}>
              <div className="statusIcon">✕</div>
              <div style={{ fontSize: 13 }}>{turnkeyPasskeyErr || turnkeyCreateErr}</div>
            </div>
          )}
        </div>
      </div>

      <div className="grid">

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{
              width: 40,
              height: 40,
              background: "linear-gradient(135deg, #22d3ee, #3b82f6)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18
            }}>📊</div>
            <h2 style={{ margin: 0 }}>Portfolio</h2>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
              Wallet Address
            </label>
            <input
              value={portfolioAddress}
              onChange={(e) => setPortfolioAddress(e.target.value)}
              placeholder="tb1p... or Arch base58 address"
            />
          </div>
          <button 
            onClick={onFetchPortfolio} 
            disabled={portfolioLoading || !portfolioAddress || !apiKey}
            style={{ width: "100%" }}
          >
            {portfolioLoading ? (
              <><span className="spinner"></span> Loading...</>
            ) : (
              "View Portfolio"
            )}
          </button>
          {portfolioErr && (
            <div className="statusMessage error" style={{ marginTop: 16 }}>
              <div className="statusIcon">✕</div>
              <div style={{ fontSize: 13 }}>{portfolioErr}</div>
            </div>
          )}
          {portfolioRes && (
            <div className="collapsible" style={{ marginTop: 16 }}>
              <div className="collapsibleHeader">
                <span>Portfolio Data</span>
              </div>
              <div className="collapsibleContent">
                <pre style={{ 
                  fontSize: 11, 
                  background: "rgba(0,0,0,0.3)", 
                  padding: 12, 
                  borderRadius: 8,
                  overflow: "auto",
                  maxHeight: 200,
                  margin: 0
                }}>
                  {safeJson(portfolioRes)}
                </pre>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <div style={{
              width: 40,
              height: 40,
              background: "linear-gradient(135deg, #10b981, #22c55e)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18
            }}>⚡</div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0 }}>New Transaction</h2>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                Create an Arch Network signing request
              </div>
            </div>
          </div>

          {/* Signer Selection */}
          <div style={{ 
            background: "rgba(0,0,0,0.2)", 
            borderRadius: 10, 
            padding: 16, 
            marginBottom: 20 
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 12 }}>
              SELECT SIGNER
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
              <button
                onClick={() => setSignerKind("external")}
                style={{
                  background: signerKind === "external" ? "rgba(238, 122, 48, 0.2)" : "rgba(0,0,0,0.2)",
                  borderColor: signerKind === "external" ? "rgba(238, 122, 48, 0.5)" : "var(--border-default)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: 12
                }}
              >
                <span style={{ fontSize: 16 }}>₿</span>
                <span>External Wallet</span>
                {signerKind === "external" && <span style={{ marginLeft: "auto", color: "var(--success)" }}>✓</span>}
              </button>
              <button
                onClick={() => setSignerKind("turnkey")}
                style={{
                  background: signerKind === "turnkey" ? "rgba(99, 102, 241, 0.2)" : "rgba(0,0,0,0.2)",
                  borderColor: signerKind === "turnkey" ? "rgba(99, 102, 241, 0.5)" : "var(--border-default)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: 12
                }}
              >
                <span style={{ fontSize: 16 }}>🔑</span>
                <span>Turnkey</span>
                {signerKind === "turnkey" && <span style={{ marginLeft: "auto", color: "var(--success)" }}>✓</span>}
              </button>
            </div>

            {signerKind === "external" && externalTaprootAddress && (
              <div style={{ 
                display: "flex", 
                alignItems: "center", 
                gap: 8,
                padding: "8px 12px",
                background: "var(--success-bg)",
                borderRadius: 6,
                fontSize: 12
              }}>
                <span style={{ color: "var(--success-light)" }}>●</span>
                <span style={{ color: "var(--success-light)" }}>
                  {externalWalletType}: {externalTaprootAddress.slice(0, 12)}...{externalTaprootAddress.slice(-6)}
                </span>
              </div>
            )}

            {signerKind === "turnkey" && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <button 
                    onClick={onLoadTurnkeyWallets} 
                    disabled={!apiKey || !externalUserId || turnkeyWalletsLoading}
                    style={{ flex: 1, fontSize: 12 }}
                  >
                    {turnkeyWalletsLoading ? "Loading..." : "Load Wallets"}
                  </button>
                  {turnkeyWallets.length > 0 && (
                    <div style={{ 
                      display: "flex", 
                      alignItems: "center", 
                      padding: "0 12px", 
                      background: "var(--success-bg)", 
                      borderRadius: 6,
                      fontSize: 12,
                      color: "var(--success-light)"
                    }}>
                      {turnkeyWallets.length} found
                    </div>
                  )}
                </div>
                <select 
                  value={turnkeyResourceId} 
                  onChange={(e) => setTurnkeyResourceId(e.target.value)}
                  style={{ width: "100%", fontSize: 13 }}
                >
                  <option value="">Select wallet...</option>
                  {turnkeyWallets.map((w: any) => (
                    <option key={String(w.id)} value={String(w.id)}>
                      {String(w.defaultAddress ?? w.walletId ?? w.id).slice(0, 24)}...
                      {w?.turnkeyRootUserId ? " (passkey)" : " (custodial)"}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Transaction Details */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 12 }}>
              TRANSACTION TYPE
            </div>
            <select 
              value={actionType} 
              onChange={(e) => setActionType(e.target.value as any)}
              style={{ width: "100%", marginBottom: 16 }}
            >
              <option value="arch.transfer">Transfer (send tokens)</option>
              <option value="arch.anchor">Anchor (link BTC UTXO)</option>
            </select>

            {actionType === "arch.transfer" ? (
              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
                    Recipient (Arch Address)
                  </label>
                  <input 
                    value={toAddress} 
                    onChange={(e) => setToAddress(e.target.value)} 
                    placeholder="Enter Arch account address..."
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
                    Amount
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input 
                      value={amountUnit === "arch" ? archInputValue : lamports} 
                      onChange={(e) => {
                        const val = e.target.value;
                        if (amountUnit === "arch") {
                          // Allow typing decimals freely
                          if (val === "" || /^[0-9]*\.?[0-9]*$/.test(val)) {
                            setArchInputValue(val);
                            // Convert to lamports for actual storage
                            const archVal = parseFloat(val) || 0;
                            setLamports(String(Math.floor(archVal * 100000000)));
                          }
                        } else {
                          // Lamports: integers only
                          const cleaned = val.replace(/[^0-9]/g, "");
                          setLamports(cleaned);
                        }
                      }}
                      placeholder={amountUnit === "arch" ? "0.555" : "1000"}
                      style={{ flex: 1 }}
                    />
                    <select 
                      value={amountUnit} 
                      onChange={(e) => {
                        const newUnit = e.target.value as "lamports" | "arch";
                        if (newUnit === "arch" && amountUnit === "lamports") {
                          // Switching to ARCH: initialize display value
                          setArchInputValue((parseInt(lamports || "0") / 100000000).toString());
                        }
                        setAmountUnit(newUnit);
                      }}
                      style={{ width: 110 }}
                    >
                      <option value="lamports">lamports</option>
                      <option value="arch">ARCH</option>
                    </select>
                  </div>
                  <div style={{ 
                    fontSize: 11, 
                    color: "var(--text-muted)", 
                    marginTop: 6,
                    fontFamily: "var(--font-mono)"
                  }}>
                    {amountUnit === "lamports" ? (
                      <>= {(parseInt(lamports || "0") / 100000000).toFixed(8)} ARCH</>
                    ) : (
                      <>= {lamports || "0"} lamports</>
                    )}
                    <span style={{ marginLeft: 8, opacity: 0.6 }}>(1 ARCH = 10⁸ lamports)</span>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
                    Bitcoin TxID
                  </label>
                  <input 
                    value={btcTxid} 
                    onChange={(e) => setBtcTxid(e.target.value)} 
                    placeholder="64-character hex..."
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
                    Output Index (vout)
                  </label>
                  <input
                    type="number"
                    value={btcVout}
                    onChange={(e) => setBtcVout(Number(e.target.value))}
                    min={0}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button
              onClick={onCreateSigningRequest}
              disabled={
                createLoading ||
                !apiKey ||
                !externalUserId ||
                (signerKind === "turnkey" ? !turnkeyResourceId : !externalTaprootAddress) ||
                (actionType === "arch.transfer" ? !toAddress || !lamports : !btcTxid)
              }
              className="btn-primary"
            >
              {createLoading ? (
                <><span className="spinner"></span> Creating...</>
              ) : (
                "Create Request"
              )}
            </button>
            <button
              onClick={() => {
                if (!signingRequestId) return;
                setApproveSigningRequestId(signingRequestId);
                if (signerKind === "turnkey") setApproveTurnkeyResourceId(turnkeyResourceId);
                // Clear previous modal state before opening
                setApproveErr(null);
                setSubmitErr(null);
                setSubmitRes(null);
                setApproveReq(null);
                setApproveOpen(true);
              }}
              disabled={!signingRequestId}
              style={{
                background: signingRequestId ? "rgba(16, 185, 129, 0.15)" : undefined,
                borderColor: signingRequestId ? "rgba(16, 185, 129, 0.3)" : undefined
              }}
            >
              Sign & Submit →
            </button>
          </div>

          {createErr && (
            <div className="statusMessage error" style={{ marginTop: 16 }}>
              <div className="statusIcon">✕</div>
              <div style={{ fontSize: 13, flex: 1 }}>{createErr}</div>
            </div>
          )}

          {signingRequestId && !createErr && (
            <div style={{ 
              marginTop: 16, 
              padding: 12, 
              background: "var(--success-bg)", 
              borderRadius: 8,
              border: "1px solid rgba(16, 185, 129, 0.2)"
            }}>
              <div style={{ fontSize: 12, color: "var(--success-light)", fontWeight: 500, marginBottom: 4 }}>
                ✓ Request Created
              </div>
              <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                {signingRequestId}
              </div>
            </div>
          )}
        </div>

        {/* Advanced: Manual Submission Card */}
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{
              width: 40,
              height: 40,
              background: "linear-gradient(135deg, #f59e0b, #d97706)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18
            }}>✍️</div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0 }}>Manual Submission</h2>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                Advanced: Submit a pre-signed transaction
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
              Signature (128 hex chars)
            </label>
            <input
              value={submitSig64Hex}
              onChange={(e) => setSubmitSig64Hex(e.target.value)}
              placeholder="r || s concatenated..."
              style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
          </div>

          <button
            onClick={onSubmitSignature}
            disabled={submitLoading || !apiKey || !signingRequestId || !externalUserId || submitSig64Hex.length !== 128}
            style={{ width: "100%" }}
          >
            {submitLoading ? (
              <><span className="spinner"></span> Submitting...</>
            ) : (
              "Submit Signature"
            )}
          </button>

          {submitErr && (
            <div className="statusMessage error" style={{ marginTop: 16 }}>
              <div className="statusIcon">✕</div>
              <div style={{ fontSize: 13 }}>{submitErr}</div>
            </div>
          )}
          {submitRes && (
            <div className="statusMessage success" style={{ marginTop: 16 }}>
              <div className="statusIcon">✓</div>
              <div>
                <div style={{ fontWeight: 600 }}>Success!</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Transaction submitted</div>
              </div>
            </div>
          )}
        </div>

        {/* Request Status Card */}
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{
              width: 40,
              height: 40,
              background: "linear-gradient(135deg, #8b5cf6, #6366f1)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18
            }}>🔄</div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0 }}>Request Status</h2>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                Monitor transaction progress
              </div>
            </div>
            {readinessStatus && (
              <div className={`pill ${readinessClass}`} style={{ margin: 0 }}>
                {readinessStatus === "ready" ? "✓ Ready" : 
                 readinessStatus === "not_ready" ? "⏳ Pending" : readinessStatus}
              </div>
            )}
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
              Request ID
            </label>
            <input 
              value={signingRequestId} 
              onChange={(e) => setSigningRequestId(e.target.value)} 
              placeholder="Signing request ID..."
              style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center" }}>
            <button 
              onClick={onGetSigningRequest} 
              disabled={getLoading || !apiKey || !signingRequestId}
            >
              {getLoading ? "..." : "Check Status"}
            </button>
            <button
              onClick={() => {
                (globalThis as any).__walletHubPoll = true;
                void onStartPolling();
              }}
              disabled={polling || !apiKey || !signingRequestId}
              style={{
                background: polling ? "var(--accent-primary)" : undefined,
                borderColor: polling ? "var(--accent-primary)" : undefined
              }}
            >
              {polling ? (
                <><span className="spinner"></span> Polling</>
              ) : (
                "Auto-Poll"
              )}
            </button>
            {polling && (
              <button 
                onClick={onStopPolling}
                style={{ 
                  padding: "12px",
                  background: "var(--error-bg)",
                  borderColor: "rgba(239, 68, 68, 0.3)"
                }}
              >
                ■
              </button>
            )}
          </div>

          {getErr && (
            <div className="statusMessage error" style={{ marginTop: 16 }}>
              <div className="statusIcon">✕</div>
              <div style={{ fontSize: 13 }}>{getErr}</div>
            </div>
          )}
          
          {getRes && (
            <div className="collapsible" style={{ marginTop: 16 }}>
              <div className="collapsibleHeader">
                <span>Response Details</span>
              </div>
              <div className="collapsibleContent">
                <pre style={{ 
                  fontSize: 11, 
                  background: "rgba(0,0,0,0.3)", 
                  padding: 12, 
                  borderRadius: 8,
                  overflow: "auto",
                  maxHeight: 200,
                  margin: 0
                }}>
                  {safeJson(getRes)}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{ 
        textAlign: "center", 
        padding: "32px 0", 
        color: "var(--text-muted)",
        fontSize: 12
      }}>
        <div style={{ marginBottom: 8 }}>
          Built with <span style={{ color: "var(--accent-primary-light)" }}>Wallet Hub</span>
        </div>
        <div style={{ fontSize: 11 }}>
          Powered by Turnkey | Xverse | Unisat
        </div>
      </div>
    </div>
  );
}
