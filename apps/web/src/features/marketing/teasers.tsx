import { createRoot } from "react-dom/client";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/700-italic.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/dm-mono/400.css";
import "./teasers.css";

const navy = new URL(
  "../../../../../design/teasers/originals/navy-clouds.png",
  import.meta.url,
).href;
const ivory = new URL(
  "../../../../../design/teasers/originals/ivory-clouds.png",
  import.meta.url,
).href;
const cards = [
  {
    name: "01-something-in-the-clouds",
    theme: "navy",
    line: "Something is",
    accent: "taking shape.",
    label: "IN THE CLOUDS",
    caption: "A little glimpse of what I’ve been building. More soon.",
  },
  {
    name: "02-a-computer-for-every-agent",
    theme: "ivory",
    line: "A computer.",
    accent: "For every agent.",
    label: "A LITTLE MORE ROOM TO WORK",
    caption: "An agent needs somewhere to do the work. That’s where dx begins.",
  },
  {
    name: "03-on-your-terms",
    theme: "navy",
    line: "Your agents.",
    accent: "On your terms.",
    label: "DX / IN THE MAKING",
    caption: "Cloud agents, on your terms. That’s the idea behind dx.",
  },
  {
    name: "04-room-for-big-ideas",
    theme: "ivory",
    line: "Big ideas",
    accent: "need room.",
    label: "THE FOUNDATION IS TAKING SHAPE",
    caption: "Starting with cloud agents. Leaving room for what comes next.",
  },
  {
    name: "05-your-desk-is-optional",
    theme: "navy",
    line: "Your desk",
    accent: "is optional.",
    label: "A WINDOW FROM ANYWHERE",
    caption:
      "The work lives in the cloud. Your laptop doesn’t have to be the whole workspace.",
  },
  {
    name: "06-the-first-chapter",
    theme: "ivory",
    line: "Every big idea",
    accent: "starts somewhere.",
    label: "THIS IS OUR FIRST CHAPTER",
    caption:
      "Building dx on my own, alongside my day job. Getting the first version ready for people who like trying things early.",
  },
  {
    name: "07-meet-dx",
    theme: "navy",
    line: "A new workspace.",
    accent: "A little closer.",
    label: "STILL BUILDING. MORE SOON.",
    caption:
      "Getting closer to sharing dx. If you’re curious about cloud agents, keep an eye on this space.",
  },
] as const;
function Poster({
  card,
  index,
}: {
  readonly card: (typeof cards)[number];
  readonly index: number;
}) {
  return (
    <article className={`teaser ${card.theme} composition-${index}`}>
      <img
        className="teaser-clouds"
        src={card.theme === "navy" ? navy : ivory}
        alt=""
      />
      <header>
        <DxWordmark />
        <span>
          CLOUD AGENTS,
          <br />
          ON YOUR TERMS.
        </span>
      </header>
      <div className="teaser-message">
        <p>{card.label}</p>
        <h1>
          {card.line}
          <br />
          <em>{card.accent}</em>
        </h1>
      </div>
      <footer>
        <span>dxcode.dev</span>
        <span>IN THE MAKING</span>
      </footer>
    </article>
  );
}
const requested = new URLSearchParams(location.search).get("card");
const selected = cards.findIndex((card) => card.name === requested);
function Gallery() {
  return (
    <main className="teaser-gallery">
      <h1>Seven glimpses of dx.</h1>
      <p>A suggested posting order. No dates, countdowns, or mascot reveals.</p>
      {cards.map((card, index) => (
        <section key={card.name}>
          <div className="teaser-preview">
            <Poster card={card} index={index} />
          </div>
          <div className="teaser-detail">
            <h2>Day {index + 1}</h2>
            <p>{card.caption}</p>
            <a href={`?card=${card.name}`}>Open full-size poster ↗</a>
          </div>
        </section>
      ))}
    </main>
  );
}
const container = document.getElementById("root");
if (container)
  createRoot(container).render(
    selected >= 0 ? (
      <Poster card={cards[selected]} index={selected} />
    ) : (
      <Gallery />
    ),
  );
