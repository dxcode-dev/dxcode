// The browser tests that emulate a phone's touch screen, apart from the rest:
// see `touchScreenTests` in vitest.browser.config.ts.
import { createHash } from "node:crypto";
import { browserProject, touchScreenTests } from "./vitest.browser.config.js";

const port =
  49_000 +
  (createHash("sha256")
    .update(import.meta.dirname)
    .digest()
    .readUInt32BE(0) %
    8000);

export default browserProject({
  name: "web-browser-touch",
  include: touchScreenTests,
  port,
});
