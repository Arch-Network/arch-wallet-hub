import CopyButton from "./CopyButton";

type AddressDisplayProps = {
  address: string;
  label?: string;
  full?: boolean;
};

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export default function AddressDisplay({ address, label, full }: AddressDisplayProps) {
  return (
    <span className="address-display" title={address}>
      {label && <span className="address-label">{label}</span>}
      <code className="address-value">{full ? address : truncateAddress(address)}</code>
      <CopyButton text={address} />
    </span>
  );
}
