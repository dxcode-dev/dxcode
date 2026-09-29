import { useId, useState } from "react";
import { DxWordmark } from "../../../shared/brand/dx-wordmark.js";
import { ArrowIcon } from "./arrow-icon.js";

export function Footer() {
  const [licenseOpen, setLicenseOpen] = useState(false);
  const noteId = useId();
  return (
    <footer>
      <DxWordmark />
      <span>Cloud agents, on your terms.</span>
      <nav className="footer-links" aria-label="Footer">
        <a
          href="https://github.com/dxcode-dev/dxcode"
          target="_blank"
          rel="noreferrer"
        >
          GitHub <ArrowIcon direction="up-right" />
        </a>
        <a href="https://x.com/dxcode_dev" target="_blank" rel="noreferrer">
          X / Twitter <ArrowIcon direction="up-right" />
        </a>
        <fieldset
          className="license-note"
          aria-label="License explanation"
          onMouseEnter={() => setLicenseOpen(true)}
          onMouseLeave={() => setLicenseOpen(false)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setLicenseOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setLicenseOpen(false);
              event.stopPropagation();
            }
          }}
        >
          <button
            type="button"
            aria-expanded={licenseOpen}
            aria-controls={noteId}
            onFocus={() => setLicenseOpen(true)}
            onClick={() => setLicenseOpen(true)}
          >
            Why FSL?
          </button>
          {licenseOpen && (
            <div id={noteId} className="license-note-panel">
              <strong>A little room to keep building.</strong>
              <p>
                I’m building dx on my own, alongside a full-time job, without
                funding. FSL gives me room to grow it into something I can work
                on full-time. An MIT license is something I may consider later.
              </p>
              <a href="https://fsl.software/" target="_blank" rel="noreferrer">
                About FSL <ArrowIcon direction="up-right" />
              </a>
              <button
                type="button"
                className="license-close"
                onClick={() => setLicenseOpen(false)}
                aria-label="Close license note"
              >
                ×
              </button>
            </div>
          )}
        </fieldset>
      </nav>
    </footer>
  );
}
