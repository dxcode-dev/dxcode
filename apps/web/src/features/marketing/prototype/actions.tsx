import { ArrowIcon } from "./arrow-icon.js";

export function Actions() {
  return (
    <div className="actions">
      <a className="primary" href="#access">
        Get early access{" "}
        <span aria-hidden="true">
          <ArrowIcon direction="up-right" />
        </span>
      </a>
      <a href="#selfhost">
        Run it yourself{" "}
        <span aria-hidden="true">
          <ArrowIcon direction="down" />
        </span>
      </a>
    </div>
  );
}
