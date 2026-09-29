import { Access } from "./access.js";
import { Actions } from "./actions.js";
import { ArrowIcon } from "./arrow-icon.js";
import { Beyond } from "./beyond.js";
import { Footer } from "./footer.js";
import { Nav } from "./nav.js";
import { Product } from "./product.js";
import { SelfHost } from "./self-host.js";

export function VariantC() {
  return (
    <main className="concept c">
      <Nav />
      <section className="hero">
        <div className="mission-copy">
          <small>YOUR OWN CLOUD AGENT WORKSPACE</small>
          <h1>
            The cloud does
            <br />
            the heavy lifting.
            <br />
            <em>You stay in control.</em>
          </h1>
          <p>
            Code with agents in your own cloud workspace.
            <br />
            Your model access. Your files and terminal.
            <br />A browser is all you need to check in.
          </p>
          <Actions />
          <div
            className="device-line"
            role="img"
            aria-label="Laptop, desktop, and mobile, all connected"
          >
            LAPTOP <ArrowIcon direction="left-right" /> DESKTOP{" "}
            <ArrowIcon direction="left-right" /> MOBILE
          </div>
        </div>
        <div className="mission-product">
          <span className="orbit-label">ONE WORKSPACE / MANY WAYS IN</span>
          <Product compact />
          <div className="phone">
            <small>dx / MOBILE</small>
            <strong>Fix checkout timeout</strong>
            <p>Ready for your review</p>
            <span>
              2 files changed <b>+18 −6</b>
            </span>
          </div>
        </div>
      </section>
      <section id="work" className="manifesto">
        <small>BUILT FOR THE DEVELOPERS WHO WANT TO GO FURTHER</small>
        <h2>
          Use the workspace.
          <br />
          Understand the source.
          <br />
          <em>Make room for your ideas.</em>
        </h2>
      </section>
      <SelfHost />
      <Beyond />
      <Access />
      <Footer />
    </main>
  );
}
