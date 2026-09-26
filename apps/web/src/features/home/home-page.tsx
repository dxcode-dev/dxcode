import { DxMark } from "../../shared/brand/dx-mark.js";

export function HomePage() {
  return (
    <section className="authenticated-home" aria-label="DX home">
      <DxMark state="idle" interactive />
    </section>
  );
}
