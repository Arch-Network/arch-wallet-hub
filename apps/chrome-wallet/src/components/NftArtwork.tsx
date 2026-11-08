import { useEffect, useState } from "react";

interface NftArtworkProps {
  image?: string | null;
  name: string;
  className?: string;
  decorative?: boolean;
}

export function NftArtwork({
  image,
  name,
  className = "",
  decorative = false,
}: NftArtworkProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [image]);

  if (image && !failed) {
    return (
      <img
        className={className}
        src={image}
        alt={decorative ? "" : name}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className={`nft-artwork-placeholder ${className}`.trim()}
      role={decorative ? "presentation" : "img"}
      aria-label={decorative ? undefined : `${name} image unavailable`}
    >
      <svg viewBox="0 0 48 48" fill="none" aria-hidden>
        <rect x="7" y="8" width="34" height="32" rx="5" />
        <circle cx="18" cy="19" r="4" />
        <path d="m11 35 9-9 7 7 5-5 5 7" />
      </svg>
      {!decorative && <span>Image unavailable</span>}
    </div>
  );
}
