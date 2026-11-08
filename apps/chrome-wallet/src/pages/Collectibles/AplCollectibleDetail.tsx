import CopyButton from "../../components/CopyButton";
import { NftImagePreview } from "../../components/NftImagePreview";
import type { EnrichedToken } from "../../utils/enrich-token";

interface AplCollectibleDetailProps {
  token: EnrichedToken;
  onSend: () => void;
}

function truncMiddle(value: string, head = 12, tail = 10): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}\u2026${value.slice(-tail)}`;
}

export function AplCollectibleDetail({ token, onSend }: AplCollectibleDetailProps) {
  if (!token.image) return null;

  return (
    <div className="collectible-detail">
      <div className="collectible-detail-preview">
        <NftImagePreview image={token.image} name={token.name} />
      </div>
      <h2 className="collectible-detail-title">{token.name}</h2>

      <div className="collectible-detail-fields">
        <div className="collectible-detail-row">
          <span className="collectible-detail-key">Type</span>
          <span className="collectible-detail-val">APL NFT</span>
        </div>
        {token.symbol && (
          <div className="collectible-detail-row">
            <span className="collectible-detail-key">Symbol</span>
            <span className="collectible-detail-val">{token.symbol}</span>
          </div>
        )}
        <div className="collectible-detail-row">
          <span className="collectible-detail-key">Mint</span>
          <span className="collectible-detail-val mono">
            {truncMiddle(token.mint)}
            <CopyButton text={token.mint} />
          </span>
        </div>
      </div>

      <button className="btn btn-primary btn-full" onClick={onSend}>
        Send
      </button>
    </div>
  );
}
