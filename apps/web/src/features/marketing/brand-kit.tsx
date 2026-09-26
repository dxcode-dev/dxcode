import { createRoot } from "react-dom/client";
import { DxWordmark } from "../../shared/brand/dx-wordmark.js";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/700-italic.css";
import "@fontsource/instrument-serif/400.css";
import "./brand-kit.css";

const social = new URL(
  "../../../../../design/brand-kit/originals/social-workshop.png",
  import.meta.url,
).href;
const poster = new URL(
  "../../../../../design/brand-kit/originals/poster-foundation.png",
  import.meta.url,
).href;
const concepts = new URL(
  "../../../../../design/brand-kit/originals/logo-concepts-ivory.png",
  import.meta.url,
).href;
const prelaunch = new URL(
  "../../../../../design/teasers/originals/navy-clouds.png",
  import.meta.url,
).href;
const formats = {
  "x-prelaunch": [1500, 500],
  "x-header": [1500, 500],
  "github-social": [1280, 640],
  "social-card": [1200, 630],
  poster: [1200, 1800],
  presentation: [1920, 1080],
  "avatar-navy": [1024, 1024],
  "avatar-ivory": [1024, 1024],
  "logo-concepts": [1536, 1024],
} as const;
const asset = new URLSearchParams(location.search).get("asset") ?? "";
const selected = Object.keys(formats).find((key) => key === asset) as
  | keyof typeof formats
  | undefined;
function BrandAsset({ name }: { readonly name: keyof typeof formats }) {
  const [width, height] = formats[name];
  const avatar = name.startsWith("avatar");
  return (
    <div className={`brand-export ${name}`} style={{ width, height }}>
      {name === "logo-concepts" ? (
        <img
          className="background"
          src={concepts}
          alt="Six optional logo concepts"
        />
      ) : (
        <>
          {!avatar && (
            <img
              className="background"
              src={
                name === "x-prelaunch"
                  ? prelaunch
                  : name === "poster"
                    ? poster
                    : social
              }
              alt=""
            />
          )}
          <div className="brand-copy">
            <DxWordmark />
            {!avatar && (
              <>
                <h1>
                  Cloud agents,
                  <br />
                  <em>on your terms.</em>
                </h1>
                <p>
                  {name === "x-prelaunch"
                    ? "IN THE MAKING · dxcode.dev"
                    : "dxcode.dev"}
                </p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
function Gallery() {
  return (
    <main className="brand-gallery">
      <h1>dx brand kit</h1>
      <p>
        The current dx wordmark stays. The six symbols are optional directions.
      </p>
      {Object.keys(formats).map((name) => (
        <section key={name}>
          <a href={`?asset=${name}`}>{name} ↗</a>
          <div className="thumbnail">
            <BrandAsset name={name as keyof typeof formats} />
          </div>
        </section>
      ))}
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    selected ? <BrandAsset name={selected} /> : <Gallery />,
  );
