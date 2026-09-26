const future = new URL("./future.png", import.meta.url).href;
export function Beyond({
  illustrated = false,
}: {
  readonly illustrated?: boolean;
}) {
  return (
    <section
      id="beyond"
      className={`beyond${illustrated ? " illustrated-beyond" : ""}`}
    >
      {illustrated && (
        <img
          src={future}
          alt="Robotic parrots building different inventions on connected cloud islands"
          loading="lazy"
          width="1536"
          height="1024"
        />
      )}
      <small>CODING FIRST. MORE TO EXPLORE.</small>
      <h2>
        What will you build
        <br />
        on top of it?
      </h2>
      <p>
        A thread brings an agent, its tools, and a workspace together. We're
        starting with the developer's day-to-day. The longer ambition is a
        foundation for your own workflows, bots, and teams of agents.
      </p>
      <div className="possibilities">
        <span>01 / Custom workflows</span>
        <span>02 / Connected bots</span>
        <span>03 / More places to run</span>
      </div>
      <small>EXPLORATIONS, NOT RELEASE COMMITMENTS.</small>
    </section>
  );
}
