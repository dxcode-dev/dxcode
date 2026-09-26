import { WaitlistForm } from "./waitlist-form.js";

const mascot = new URL("./mascot.png", import.meta.url).href;
export function Access({
  illustrated = false,
}: {
  readonly illustrated?: boolean;
}) {
  return (
    <section
      id="access"
      className={`access${illustrated ? " illustrated-access" : ""}`}
    >
      <div className="access-copy">
        <small>EARLY ACCESS</small>
        <h2>
          Your next task.
          <br />
          <em>Our first chapter.</em>
        </h2>
        <p>Bring something you want to build. Help shape what dx becomes.</p>
      </div>
      <div className="access-signup">
        {illustrated && (
          <img
            src={mascot}
            className="invitation-parrot"
            alt="The navy and brass dx parrot lifting a wing in greeting"
            loading="lazy"
            width="1024"
            height="1024"
          />
        )}
        <WaitlistForm id="closing-email" />
      </div>
    </section>
  );
}
