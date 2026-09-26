const artwork = new URL("./builders-workshops.webp", import.meta.url).href;

export function BuildersStory() {
  return (
    <section
      id="beyond"
      className="builders-story"
      aria-labelledby="builders-heading"
    >
      <h2 id="builders-heading">
        What will you build <em>on top?</em>
      </h2>
      <p className="builders-intro">
        A bot for your community. An agent for the chores. A team working
        through a bigger task. Different jobs, with a shared foundation
        underneath.
      </p>
      <figure>
        <img
          src={artwork}
          alt="A mechanical swallow at a dispatch station, a parrot tending a clockwork machine, and an owl and finch collaborating at a drafting table, all sharing one navy and brass foundation"
          width={1536}
          height={1024}
          loading="lazy"
          decoding="async"
        />
        <figcaption>
          We’re building the foundation. You might have something else in mind.
        </figcaption>
      </figure>
      <small className="builders-status">
        ON THE DRAWING BOARD. A GLIMPSE OF WHAT WE’RE WORKING TOWARD.
      </small>
    </section>
  );
}
