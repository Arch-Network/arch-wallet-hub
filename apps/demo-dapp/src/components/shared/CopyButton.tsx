import { useState, useCallback } from "react";

type CopyButtonProps = {
  text: string;
};

export default function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button className="copy-btn" onClick={handleCopy} title="Copy to clipboard">
      {copied ? "✓" : "⧉"}
    </button>
  );
}
