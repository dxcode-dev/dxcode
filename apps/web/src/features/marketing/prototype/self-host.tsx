const image = new URL("./workshop.webp", import.meta.url).href;
export function SelfHost({
  illustrated = false,
}: {
  readonly illustrated?: boolean;
}) {
  return (
    <section
      id="selfhost"
      className={`selfhost${illustrated ? " illustrated-selfhost" : ""}`}
    >
      {illustrated && (
        <img
          src={image}
          alt="The parrots’ own cloud workshop, with navy cabinets and brass tools"
          loading="lazy"
          width="1536"
          height="1024"
        />
      )}
      <small>THE FIRST RELEASE</small>
      <h2>A little cloud of your own.</h2>
      <p>
        The v0.1.0 self-hosting path targets your Cloudflare and E2B accounts,
        with your own model access. Source-available under FSL-1.1-ALv2. You
        cover infrastructure and model usage.
      </p>
      <div className="facts">
        <span>Cloudflare + E2B</span>
        <span>Bring your keys</span>
        <span>Personal & internal use</span>
      </div>
      <details>
        <summary>Release status & license</summary>
        <p>
          The source and a deployment guide are public. FSL restricts competing
          use for two years per release, then converts to Apache-2.0. dx uses
          FSL-1.1-ALv2.
        </p>
      </details>
    </section>
  );
}
