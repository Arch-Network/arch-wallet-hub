import { useEffect, useRef, useState } from "react";
import { NftArtwork } from "./NftArtwork";

interface NftImagePreviewProps {
  image: string;
  name: string;
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function NftImagePreview({ image, name }: NftImagePreviewProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="nft-image-preview"
        onClick={() => setOpen(true)}
        aria-label={`View full image of ${name}`}
        aria-haspopup="dialog"
      >
        <NftArtwork image={image} name={name} />
        <span className="nft-image-expand">
          <ExpandIcon />
        </span>
      </button>

      {open && (
        <div className="nft-image-lightbox" role="presentation" onMouseDown={close}>
          <div
            className="nft-image-lightbox-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nft-image-lightbox-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="nft-image-lightbox-header">
              <span id="nft-image-lightbox-title">{name}</span>
              <button type="button" onClick={close} aria-label="Close image viewer" autoFocus>
                ×
              </button>
            </div>
            <div className="nft-image-lightbox-content">
              <NftArtwork image={image} name={name} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
