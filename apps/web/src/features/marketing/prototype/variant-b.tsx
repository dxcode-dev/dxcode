import { Access } from "./access.js";
import { Actions } from "./actions.js";
import { Beyond } from "./beyond.js";
import { Footer } from "./footer.js";
import { Nav } from "./nav.js";
import { Product } from "./product.js";
import { SelfHost } from "./self-host.js";

const image = new URL("./workshop.png", import.meta.url).href;
export function VariantB() {
  return (
    <main className="concept b">
      <Nav />
      <section className="hero">
        <div className="editorial-top">
          <small>FIELD NOTES / 001</small>
          <span>A PERSONAL CLOUD FOR YOUR AGENTS</span>
        </div>
        <h1>
          Big ideas.
          <br />
          Small screen.
          <br />
          <em>Your cloud.</em>
        </h1>
        <div className="editorial-bottom">
          <p>
            Your agents live in a cloud workspace.
            <br />
            You drop in from wherever you are.
            <br />
            dx starts with coding. You decide what comes next.
          </p>
          <Actions />
        </div>
        <img
          className="editorial-art"
          src={image}
          alt="An illustrated floating workshop for cloud agents"
        />
      </section>
      <section id="work" className="editorial-work">
        <div>
          <small>01 / START WITH SOMETHING REAL</small>
          <h2>
            That bug you've
            <br />
            been meaning
            <br />
            to fix.
          </h2>
          <p>
            Give it a thread. Follow the work.
            <br />
            Review the result.
          </p>
          <p className="footnote">
            A developer workspace, accessible through your browser.
          </p>
        </div>
        <Product compact />
      </section>
      <SelfHost />
      <section className="founder">
        <small>A NOTE FROM THE BUILDER</small>
        <p>
          “I'm building the cloud workspace I want for my own agents. It's
          early. I'd rather put it in your hands and learn from real work than
          keep building behind closed doors.”
        </p>
        <span>Small releases. Real tasks. Direct feedback.</span>
      </section>
      <Beyond />
      <Access />
      <Footer />
    </main>
  );
}
