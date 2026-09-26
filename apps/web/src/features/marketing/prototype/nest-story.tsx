const nests = new URL("./cloud-nests.webp", import.meta.url).href;

export function NestStory() {
  return (
    <section
      id="selfhost"
      className="nest-story"
      aria-labelledby="nest-heading"
    >
      <div className="nest-copy">
        <small>A HOME YOU CONTROL</small>
        <h2 id="nest-heading">
          Your agents.
          <br />
          Your data.
          <br />
          <em>Your nest.</em>
        </h2>
        <dl className="nest-choices">
          <div>
            <dt>Your infrastructure.</dt>
            <dd>A home for your agents in your cloud.</dd>
          </div>
          <div>
            <dt>Your models.</dt>
            <dd>Choose the provider. Bring your keys.</dd>
          </div>
          <div>
            <dt>Your data.</dt>
            <dd>Control where your code and conversations live.</dd>
          </div>
        </dl>
        <p className="nest-release">
          The first self-hosting target is Cloudflare + E2B.
        </p>
      </div>
      <figure className="nest-art">
        <img
          src={nests}
          alt="Navy and brass robotic parrots in separate cloud nests, with amber, blue, multicolor, and orange accents representing possible infrastructure homes"
          width={1254}
          height={1254}
          loading="lazy"
          decoding="async"
        />
        <figcaption>
          <span className="nest-providers">
            <span className="provider-cloudflare">
              Cloudflare + E2B · first target
            </span>
          </span>
          <span className="nest-providers nest-future">
            <span className="provider-aws">AWS</span>
            <span className="provider-gcp">GCP</span>
            <span className="provider-azure">Azure</span>
            <span>· future possibilities</span>
          </span>
        </figcaption>
      </figure>
    </section>
  );
}
