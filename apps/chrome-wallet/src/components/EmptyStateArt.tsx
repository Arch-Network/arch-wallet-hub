/** Decorative artwork; the adjacent empty-state copy supplies its meaning. */
export default function EmptyStateArt({ kind }: { kind: "activity" | "collectibles" }) {
  return (
    <img
      className="empty-state-art"
      src={`/illustrations/${kind}.webp`}
      alt=""
      width={128}
      height={128}
      decoding="async"
    />
  );
}
