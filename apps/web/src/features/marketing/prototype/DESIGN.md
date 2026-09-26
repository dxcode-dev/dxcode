# dx cloud workshop: landing story and mascot

Status: historical design exploration. Concept 1 was integrated into the homepage in `e514f802`. Earlier proposals below are preserved for context, not current instructions. Read the [canonical landing and release strategy](../../../../../../wiki/landing-release-strategy.md) for final decisions, licensing rationale, rejected options, and next work.

## Decisions to preserve

- Develop concept 1, Cloud workshop. Concepts 2 and 3 are comparison artifacts, not alternatives to keep developing.
- Lead with personally controlled cloud agents, accessible through a browser on desktop and mobile. Coding is the first useful experience; a broader agent foundation is the ambition.
- Keep the approved hero illustration and its navy enamel, golden brass, ivory paper, and engraved detail.
- Use the same family of robotic parrots throughout the story. They are the proposed mascot family; a name is not chosen.
- The parrots complement the existing dx wordmark. They do not replace the product's Orb or loading-state identity.
- Remove the starburst motif. No borrowed competitor symbols, names, or parity claims in the landing page.
- Put a working email-entry interaction in the hero. A submit button acts on that form without scrolling. Keep the second invitation at the bottom.
- Owner chose FSL. MIT conversion is proposed; actual license adoption and public distribution are separate release work.

## Who this page is for

Developers curious enough to try an early cloud-agent workspace, inspect its source, run it themselves, and give specific feedback. The intended first conversion is a hosted-preview request; the parallel path explains self-hosting readiness and requirements.

The useful promise is a place for agents to work that the developer can operate and adapt. Browser access supports that promise. Price comparisons, generic productivity claims, and a long list of speculative integrations do not establish it.

## Story sequence

| Chapter | Reader's question | Working headline | Illustration and evidence |
| --- | --- | --- | --- |
| Hero | What is this and why should I care? | Your agents. Your cloud. Anywhere you are. | Approved cloud workshop connected to laptop and phone; inline email field |
| Work | What can it do for me today? | Give the work a place to happen. | Two parrots building and inspecting; illustrative thread with files, commands, and changes |
| Access | How do I use it away from my desk? | A small screen. A full workspace. | One curious parrot; browser/device explanation, not a native-mobile-app claim |
| Ownership | What does running my own instance mean? | A little cloud of your own. | Workshop repeated at a quieter scale; exact Cloudflare + E2B release scope and running costs |
| Possibility | Where could this go? | What will you build on top of it? | Connected islands with different inventions; clearly exploratory, no dates |
| Invitation | How can I take part? | A place for your next idea. | Welcoming parrot vignette and a second email form |

Headlines are working copy, not frozen slogans. Each section needs one clear claim and one supporting visual or product proof. The final product demonstration should use a verified release workflow rather than the prototype's invented task transcript.

## Mascot appearance

The defining features are a curved brass beak, ivory circular eye surround with a dark optical lens, deep navy and cobalt feather plates, brass joints and feet, a small swept crest, and a segmented tail. Proportions should remain birdlike. Personality is curious, capable, attentive, and slightly eccentric.

The mascot acts with a purpose: welcome, carry a tool, inspect an assembly, connect a workspace, or build an invention. Use one parrot for a direct invitation and two or three for an illustrated scene. Avoid turning every heading into a mascot sticker.

Preserve fine etched linework, subtle hatch shading, restrained watercolor texture, and generous warm-paper margins. Golden brass should look aged and physical, not metallic gradient UI chrome. Navy is the principal mass; gold belongs to joints, mechanisms, and small accents.

The portrait is a candidate reference, not a finished small-size logo. Before app-wide use, develop a simplified version readable at small sizes and review silhouette, dark-background treatment, and accessible status semantics separately.

## Palette and composition

These are provisional UI values coordinated with the illustration, not measured image-wide colors:

- Paper: `#f5f2e9`
- Ink: `#172c3e`
- Navy action: `#233f59`
- Navy hover: `#315977`
- Brass label: `#7b643e`
- Muted text: `#636b6f`

Keep DM Sans for readable copy and Instrument Serif for a small number of expressive phrases. Use DM Mono for quiet chapter labels. Leave enough space for the images; avoid a repeated grid of cards.

Use the hero at full richness, then alternate quieter portraits and wider scenes. Text stays in the DOM. Images never carry essential instructions or availability claims. Decorative images may use empty alt text when adjacent copy already conveys everything; narrative images get concise descriptive alt text.

## Art inventory

| Asset | Intended use | Status |
| --- | --- | --- |
| [workshop.png](workshop.png) | Hero; secondary ownership vignette | Approved by owner |
| [mascot.png](mascot.png) | Identity reference, access chapter, closing invitation | Generated candidate for review |
| [work.png](work.png) | Task execution and inspection chapter | Generated candidate for review |
| [future.png](future.png) | Broader-workflow vision | Generated candidate for review |

All companion assets were generated with `workshop.png` as the image reference. Generation direction: preserve navy/cobalt feather plates, aged brass joints, curved beak, ivory eye ring, lens eye, crest and segmented tail; fine engraved linework and restrained paper texture; generous ivory margins; no lettering or logos. Scene-specific directions:

- Portrait: one parrot on a brass perch, three-quarter view, wing lifted inquisitively.
- Work: two parrots at a cloud workbench, one inspecting an assembly with a loupe and one adjusting it.
- Future: three cable-connected cloud islands; workshop, botanical invention, and telescope, all using the same parrot family.

Compare future generations to the approved hero and the selected portrait side by side. Reject changes in face shape, palette, rendering style, or anatomy that make them look like unrelated characters. Generated images are art candidates and do not prove product functionality.

## Signup behavior

Both forms require a syntactically valid email and respond in place. The hero input and closing input have unique labels and IDs. The navigation's Early access button focuses the hero email field in concept 1. No form scrolls to the footer on submit.

The current prototype sends no requests and stores no email. Its confirmation explicitly says nothing was submitted. Before launch, connect both forms to one waitlist operation with pending, confirmed, duplicate, and failure states. Preserve typed input on failure; only say the user joined after the service confirms it. Decide confirmation email and privacy copy as part of that work.

## Claim boundaries and next design pass

The v0.1.0 self-hosting target remains Cloudflare plus E2B. Broader compute portability, bots, and autonomous plugins are a direction, not current availability. Framework capabilities are not automatically dx features. FSL is source available; the selected conversion variant must be fixed before license copy is finalized.

Next review should choose the mascot reference and chapter sequence, refine copy against release evidence, and design each section's desktop/mobile composition. Only then promote the selected prototype into production. Keep Storybook and a wider theme migration outside this design pass.

## Header refinement and positioning discussion

2026-09-19: owner found the header too tall and asked for language broader than “Your cloud. Your agents.” The selected prototype now uses a 64px desktop header and 60px mobile header, retains 44px navigation hit areas, and reduces the hero's top gap to 48px desktop / 34px mobile. The divider stays a single hairline; there is no framed or pill-shaped header.

Trial descriptor: **A foundation for agent-powered work.** This is a copy proposal for review, not an approved final tagline or a claim of a released general-purpose platform.

Use three levels of language:

- What people can recognize today: a cloud workspace for coding agents.
- The broader direction: a foundation for agent-powered work.
- What could be built above it: specialized agents and coordinated workflows, potentially a software factory.

A Thread groups a conversation with tools, workspace access, and work results. Actual command execution belongs to its execution environment. Do not describe a thread as compute itself. Flue owns the agent runtime; dx composes it with the product workspace, identity, model connections, and user interface. See the current [runtime architecture](../../../../../../wiki/runtime-architecture.md).

Possible higher-level products, not release commitments:

| Product | Reuses the foundation | Additional work required |
| --- | --- | --- |
| Repository maintenance agent | Thread, repository, tools, file changes | Scheduled triggers, review/merge policy, reporting |
| Issue-to-change workflow | Task context, sandbox execution, diff review | Issue integration, approval steps, delivery orchestration |
| Internal operations assistant | Tools, connections, conversation | Scoped business-system access and human approvals |
| Chat-connected agent | Same underlying work and state | Channel adapters, identity mapping, permissions |
| Software factory | Multiple units of agent work | Planning, dependency coordination, evaluation, budgets, release governance |

Alternative descriptors to review: “The workspace behind your agents” is more concrete and product-focused; “The foundation for your software factory” is more specific but suggests orchestration capabilities that still need to be built. Prefer the broader foundation descriptor as a small header line while the hero and product evidence stay concrete.

## Hero interaction refinement

Keep the approved headline and italic last line. Supporting copy now introduces AI agents with a computer, both hosting paths, and continuing from another device. The early-access label says dx handles infrastructure. This is proposed launch copy; hosting availability still needs release verification before publishing.

The brass status dot pulses softly and is decorative. The original workshop illustration is restored, including its painted rooftop bird. There is no hover, click, or keyboard mascot interaction. Reduced-motion users get a static dot.

The hero signup has no prototype caveat in its copy. A valid email triggers an arrow departure/return animation, with no success claim. It sends and saves nothing until a real signup endpoint is connected. The footer form retains its existing preview disclosure. Header wording and other sections remain outside this refinement.

## Workbench and workspace section

Retain the navy/brass parrots working at their bench beside the introduction. Follow with a static capture of the actual DX UI, with an illustrative checkout transcript. Desktop shows project threads, chat, composer, and Changes. Mobile uses its own chat layout capture.

The landing page renders a lazy-loaded picture with desktop/mobile sources. It imports no product components, terminal, diff library, providers, or iframe. Screenshot controls are inert pixels. Product changes cannot change this section until the images are replaced.

To refresh: run the web Vite server and open `/workspace-demo.html`. This separate capture fixture composes actual product components with local dummy data in `src/prototypes/workspace-demo`; its testing entry supplies in-memory routing, theme, and query providers. No real account or sandbox is needed. Capture at 1240×720 desktop and 390×720 mobile at native resolution. Expand `payment.ts` in Changes before the desktop capture. Save to `workspace-desktop.png` and `workspace-mobile.png` beside `product.tsx`. Keep account menus closed and omit demo labels from the image. Inspect both sizes before replacing the assets.

The work section now centers its heading and numbered conversation → files/commands → review sequence. The workbench parrots sit centered immediately above the screenshot. A soft CSS cloud surround stays behind the frame so the product pixels remain unobscured. Mobile stacks the three steps and retains the perched workbench.

The work heading is now “A whole workspace. For every agent.” Remove the chapter label and numbered subtitle. Desktop uses floating parrot-voice notes with arrows toward threads, workspace tools, and the conversation. Mobile omits these annotations. Scroll-driven screenshot sequences remain a future design option, not part of this static pass.

Delivery assets use WebP quality 90 with method 6 and sharp YUV conversion at original dimensions. Keep the source captures for future exports. The picture selects desktop or mobile and lazy-loads only the selected asset. WebM is reserved for video, not these static captures.

## Foundation story

Replace the repeated mobile-access section with the platform direction. The new illustration shows a partly assembled physical foundation and unbuilt blueprint rooms above. Preserve `mascot.png` for future use. `foundation-blueprint.png` is the source; the section delivers the compressed WebP. Match the existing navy/brass parrots and ivory background.

Copy separates the current developer focus from possible plugins, connected bots, and autonomous workflows. These are directions, not a published roadmap or available features. The larger narrative is workspace evidence, foundation vision, user control, possibilities for builders, then early access. This pass changes only the foundation section; later sections await their own design review.

Approved foundation headline: “Cloud agents today. Room for what comes next.” Use italic serif for the second sentence. Remove the repeated coding eyebrow and Under construction block. Retain “The foundation is taking shape. The rest is possibility.” beneath the illustration, with broader edge fades to blend its paper background into the page.

## Cloud nests and control

Concept 1 replaces the repeated hero workshop in the control section with four cloud nests. Provider-inspired amber, blue, multicolor, and orange accents surround consistent navy/brass DX machinery. No logos. Caption marks Cloudflare + E2B as the first self-hosting target and AWS/GCP/Azure as future possibilities. The illustration is conceptual, not proof of provider compatibility. “Your nest. Your rules.” introduces infrastructure, model choice, and data location as the intended direction. Preserve existing workshop art. Deliver lazy-loaded `cloud-nests.webp`; keep the PNG source.

## Builders invitation

Concept 1 now invites builders with “What will you build on top?” and a wide illustration of a messenger swallow, clockwork parrot, and owl/finch drafting team on one shared foundation. These suggest community bots, recurring chores, and coordinated work. They are possibilities, not available plugins or release commitments. The centered section ends “We’re building the foundation. You might have something else in mind.” before early access.

Retain every generated source and replacement asset for future use. The previous `future.png` remains intact. New source is `builders-workshops.png`, delivered as lazy-loaded WebP.

## Closing invitation refinement

Compact early access uses “Your next task. Our first chapter.” with a small retained parrot above the signup. Both hero and closing placements render the same `WaitlistForm` implementation; future signup integration belongs there, not in separate forms. Unique input IDs remain. The prototype sends no emails or requests and never reports a successful signup. Hide the idle prototype caveat; a closing-form submission explains that it is not connected. Inputs use a visible brass inset focus border instead of the blue outline. Footer padding is reduced to 20px desktop and 16px mobile.

Approved header and footer tagline: “Cloud agents, on your terms.” This supersedes the earlier foundation descriptor proposal.
