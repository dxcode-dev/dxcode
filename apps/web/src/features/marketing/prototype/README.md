# Cloud-agent landing prototypes

Selected: concept 1, Cloud workshop. The owner approved the hero art and navy/brass robotic-parrot family.

Read [the design and mascot brief](DESIGN.md) for the story, asset inventory, decisions, and next design pass.

Run `pnpm --filter @dx/web exec vite --host 127.0.0.1 --port 3017`, then open `/landing-prototype.html?variant=1`. Variants 1–3 also switch with the bottom arrows or keyboard arrows while focus is within the prototype.

This uses a separate Vite HTML entry so reviewing marketing does not load the current authentication transition or require a backend. Production build inputs do not include this entry. No production routing, identity, auth behavior, or licensing files were changed.

- 1: Cloud workshop. Ownership and access from any device, with original illustrated cloud workshop.
- 2: The field guide. Editorial typography, founder story, product demonstration.
- 3: Mission control. Dark, product-first view with desktop/mobile framing.

All product data is illustrative. Forms do not transmit or persist data. Public distribution, BYOK, and self-host copy describe the intended v0.1.0 release, not verification of a shipped package. Bot channels and broader compute portability are exploratory direction, not dated commitments.

Owner selected FSL. FSL-1.1-MIT is a proposed fit for the stated future MIT preference: each version automatically converts after two years. Final licensing files and publication remain separate work.

Generated illustration: original cloud workshop with mechanical birds; imagegen source copied into `workshop.png`.
