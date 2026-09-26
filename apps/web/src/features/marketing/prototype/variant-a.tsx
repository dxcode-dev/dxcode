import { Access } from "./access.js";
import { BuildersStory } from "./builders-story.js";
import { Footer } from "./footer.js";
import { Nav } from "./nav.js";
import { Product } from "./product.js";
import { NestStory } from "./nest-story.js";
import { Hero } from "./hero.js";

const workImage = new URL("./work.png", import.meta.url).href;
const foundation = new URL("./foundation-blueprint.webp", import.meta.url).href;
export function VariantA() {
  return (
    <main className="concept a">
      <Nav
        earlyAccessInputId="hero-email"
        tagline="Cloud agents, on your terms."
      />
      <Hero />
      <section id="work" className="work">
        <div className="work-heading">
          <h2>A personal computer for every agent.</h2>
        </div>
        <div className="cloud-workspace">
          <img
            className="workspace-parrots"
            src={workImage}
            alt="Two robotic parrots at their workbench, perched above the DX workspace"
            loading="lazy"
            width="1536"
            height="1024"
          />
          <div className="workspace-note threads-note">
            <p>
              “All your{" "}
              <span className="scribbled-word" aria-hidden="true">
                birds
                <svg viewBox="0 0 70 30" aria-hidden="true">
                  <path d="M3 20 L65 9 L8 15 L62 23 L6 8 L66 16" />
                </svg>
              </span>{" "}
              agents can work here.”
            </p>
            <span>Separate threads. Work in parallel.</span>
            <svg
              viewBox="0 0 100 85"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d="M80 3 Q18 8 22 75 M14 65 L22 77 L31 66" />
            </svg>
          </div>
          <div className="workspace-note tools-note">
            <p>“Files, changes, terminal. Right here.”</p>
            <span>Inspect the work as it happens.</span>
            <svg
              viewBox="0 0 100 85"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d="M15 3 Q80 9 77 75 M68 66 L77 77 L85 65" />
            </svg>
          </div>
          <Product />
          <div className="workspace-note conversation-note">
            <svg
              viewBox="0 0 100 65"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d="M75 60 Q22 54 26 9 M18 19 L26 7 L35 19" />
            </svg>
            <p>“Here’s what’s going on under the feathers.”</p>
            <span>
              Follow the work. Untangle a knot. Nudge your agent along.
            </span>
          </div>
        </div>
      </section>
      <section
        className="foundation-story"
        aria-labelledby="foundation-heading"
      >
        <div className="foundation-art">
          <img
            src={foundation}
            alt="Robotic parrots assembling a navy and brass foundation, with unbuilt rooms and connected workshops drawn as blueprints above it"
            loading="lazy"
            decoding="async"
            width="1254"
            height="1254"
          />
          <span className="foundation-caption">
            The foundation is taking shape. The rest is possibility.
          </span>
        </div>
        <div className="foundation-copy">
          <h2 id="foundation-heading">
            Cloud agents today.
            <br />
            <span className="foundation-next">
              <em>Room</em> for what comes next.
            </span>
          </h2>
          <p>
            An agent, its tools, and a computer to work on. We’re bringing these
            essentials together so each new idea doesn’t have to start from
            scratch.
          </p>
          <p>
            Plugins, connected bots, autonomous workflows. Different
            possibilities, built on the same base.
          </p>
        </div>
      </section>
      <NestStory />
      <BuildersStory />
      <Access illustrated />
      <Footer />
    </main>
  );
}
