const image = new URL("./workshop.png", import.meta.url).href;
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
        with your own model access. Source-available under the planned FSL
        release. You cover infrastructure and model usage.
      </p>
      <div className="facts">
        <span>Cloudflare + E2B</span>
        <span>Bring your keys</span>
        <span>Personal & internal use</span>
      </div>
      <details>
        <summary>Release status & license</summary>
        <p>
          Public package and deployment guide are being prepared. FSL restricts
          competing use for two years per release, then converts to MIT or
          Apache-2.0 according to the selected variant. MIT is the proposed
          conversion for dx; license files have not been changed.
        </p>
      </details>
    </section>
  );
}
