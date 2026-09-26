import { WaitlistForm } from "./waitlist-form.js";

const workshop = new URL("./workshop.png", import.meta.url).href;

export function Hero() {
  return (
    <section className="hero">
      <div className="eyebrow hero-eyebrow">
        <span className="hero-status-dot" aria-hidden="true" />
        IN THE MAKING / v0.1.0
      </div>
      <h1>
        Your agents.
        <br />
        Your cloud.
        <br />
        <em>Anywhere you are.</em>
      </h1>
      <p>
        Give your AI agents a computer of their own.
        <br />
        Start with dx hosting, or run it in your cloud.
        <br />
        Pick up the work from your laptop, desktop, or phone.
      </p>
      <WaitlistForm id="hero-email" hero />
      <a className="hero-selfhost" href="#selfhost">
        Prefer to run it yourself? <span aria-hidden="true">↓</span>
      </a>
      <div className="hero-art hero-scene">
        <img
          src={workshop}
          width="1536"
          height="1024"
          alt="A floating cloud workshop connected to a laptop and phone, tended by mechanical parrots"
        />
      </div>
      <div className="art-caption">
        A WORKSPACE IN THE CLOUD. A WINDOW FROM ANYWHERE.
      </div>
    </section>
  );
}
