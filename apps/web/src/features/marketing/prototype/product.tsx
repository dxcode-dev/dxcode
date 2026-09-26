const desktop = new URL("./workspace-desktop.webp", import.meta.url).href;
const mobile = new URL("./workspace-mobile.webp", import.meta.url).href;

export function Product({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`workspace-preview${compact ? " compact" : ""}`}>
      <div className="workspace-preview-label">
        <span>INSIDE DX</span>
        <span>A place for the whole task.</span>
      </div>
      <picture className="workspace-screenshot">
        <source
          media="(max-width: 760px)"
          srcSet={mobile}
          width={390}
          height={720}
        />
        <img
          src={desktop}
          width={1240}
          height={720}
          loading="lazy"
          decoding="async"
          alt="DX workspace showing a checkout fix: project threads, the agent conversation, and a reviewed payment code change."
        />
      </picture>
    </div>
  );
}
