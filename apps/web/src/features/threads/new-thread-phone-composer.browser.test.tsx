import type { ProjectData } from "@dx/api";
import type { ModeId, ProjectId, RunnerProfileId } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import "../../styles.css";
import { NewThreadConfigurationStrip } from "./new-thread-configuration-strip.js";

// The New Thread composer on a phone, with a coarse pointer:
// - #1119: at 360x740 the mode menu ran 42px past the bottom of the screen,
//   so "low" could not be chosen;
// - #1175: the Orb and mode chips shrank to bare icons, hiding the selected
//   Orb provider, size, and mode. The provider now shows as its logo.
// The strip sits where the phone /new page puts it: y=282 at 390x844 and
// y=269 at 360x740, measured on the local app.

const projectId = "prj_00000000-0000-4000-8000-000000001175" as ProjectId;
const projects = [
  { id: projectId, name: "qa-nt-scratch" },
] as unknown as ReadonlyArray<ProjectData>;
const providers = [
  {
    adapter: "cloudflare",
    displayName: "Cloudflare Containers",
    shortName: "Cloudflare",
    pauseResume: "filesystem",
  },
] as const;
const runnerProfiles = [
  {
    id: "cf.standard-2" as RunnerProfileId,
    label: "standard-2",
    adapter: "cloudflare",
    availability: "available",
    resources: { cpuCores: 1, memoryMb: 6144, diskGb: 12 },
  },
] as unknown as NonNullable<
  Parameters<typeof NewThreadConfigurationStrip>[0]["runnerProfiles"]
>;

const PHONES = [
  { width: 390, height: 844, stripTop: 282 },
  { width: 360, height: 740, stripTop: 269 },
] as const;

const box = (element: Element) => element.getBoundingClientRect();

async function mountPhoneStrip(
  { width, height, stripTop }: (typeof PHONES)[number],
  { model }: { readonly model?: string } = {},
) {
  await page.viewport(width, height);
  await cdp().send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  expect(matchMedia("(pointer: coarse)").matches).toBe(true);
  document.body.style.margin = "0";
  const container = document.body.appendChild(document.createElement("div"));
  container.className = "new-thread-dialog";
  Object.assign(container.style, {
    position: "fixed",
    top: `${stripTop}px`,
    left: "12px",
    right: "12px",
  });
  const root = createRoot(container);
  const profileChanged = vi.fn();
  function Harness() {
    const [profile, setProfile] = React.useState<ModeId>("medium");
    return (
      <NewThreadConfigurationStrip
        projects={projects}
        projectId={projectId}
        profile={profile}
        model={model}
        locked={false}
        submitting={false}
        ready
        retrying={false}
        onProjectChange={() => undefined}
        runnerProfiles={runnerProfiles}
        runnerProviders={providers}
        runnerOrbs={[
          {
            providerId: "cloudflare",
            scope: "deployment",
            account: null,
            status: "ready",
            unavailableSizes: [],
          },
        ]}
        runnerProfileId={"cf.standard-2" as RunnerProfileId}
        onRunnerProfileChange={() => undefined}
        onModelChange={() => undefined}
        onProfileChange={(next) => {
          profileChanged(next);
          setProfile(next);
        }}
      />
    );
  }
  await React.act(() => root.render(<Harness />));
  return { container, root, profileChanged };
}

afterEach(async () => {
  document.body.replaceChildren();
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.viewport(1280, 800);
});

describe.each(PHONES)(
  "the phone New Thread composer at $width x $height",
  (phone) => {
    it("keeps the mode menu on screen so every mode can be chosen (#1119)", async () => {
      const { container, root, profileChanged } = await mountPhoneStrip(phone);
      const trigger =
        container.querySelector<HTMLButtonElement>(".new-thread-mode");
      await React.act(() => trigger?.click());
      await React.act(() =>
        vi.waitFor(() =>
          expect(
            document
              .querySelector(".reasoning-positioner")
              ?.hasAttribute("data-side"),
          ).toBe(true),
        ),
      );
      await React.act(
        () => new Promise((resolve) => requestAnimationFrame(resolve)),
      );
      const popup = document.querySelector(".reasoning-popup") as HTMLElement;
      expect(box(popup).top).toBeGreaterThanOrEqual(0);
      expect(box(popup).bottom).toBeLessThanOrEqual(innerHeight);

      for (const mode of ["ultra", "high", "medium", "low"]) {
        const option = [
          ...document.querySelectorAll<HTMLElement>(".reasoning-option"),
        ].find((element) => element.textContent?.startsWith(mode));
        expect(option, mode).toBeDefined();
        option?.scrollIntoView({ block: "nearest" });
        const rect = box(option as HTMLElement);
        expect(rect.bottom, mode).toBeLessThanOrEqual(innerHeight);
        expect(
          option?.contains(
            document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            ),
          ),
          `${mode} is the element at its own center`,
        ).toBe(true);
      }

      const low = [
        ...document.querySelectorAll<HTMLElement>(".reasoning-option"),
      ].find((element) => element.textContent?.startsWith("low"));
      await React.act(() => low?.click());
      expect(profileChanged).toHaveBeenLastCalledWith("low");
      await React.act(() => root.unmount());
    });

    it("names the selected Orb and mode on the chips, with 44px touch targets (#1175)", async () => {
      const { container, root } = await mountPhoneStrip(phone);
      const strip = container.querySelector(".new-thread-config-strip");
      const orb = container.querySelector(
        ".new-thread-orb-size",
      ) as HTMLElement;
      const project = container.querySelector(
        ".new-thread-project",
      ) as HTMLElement;
      const mode = container.querySelector(".new-thread-mode") as HTMLElement;
      const submit = container.querySelector(
        ".new-thread-submit",
      ) as HTMLElement;

      // Visible text, not a screen-reader-only label behind an icon.
      const visibleLabel = (chip: HTMLElement, text: string) => {
        const label = [...chip.querySelectorAll("span")].find(
          (span) =>
            span.textContent === text &&
            getComputedStyle(span).clipPath === "none" &&
            getComputedStyle(span).position !== "absolute",
        );
        expect(label, `"${text}" shows on its chip`).toBeDefined();
        return label as HTMLElement;
      };
      // The provider shows as its logo beside the size (#1175 kept it named).
      const orbLabel = visibleLabel(orb, "standard-2");
      expect(box(orbLabel).width).toBeGreaterThanOrEqual(56);
      expect(orbLabel.scrollWidth).toBeLessThanOrEqual(orbLabel.clientWidth);
      const orbLogo = orb.querySelector(
        'img[data-orb-provider-logo="cloudflare"]',
      ) as HTMLElement;
      expect(getComputedStyle(orbLogo).display).not.toBe("none");
      expect(box(orbLogo).width).toBeGreaterThan(0);
      const modeLabel = visibleLabel(mode, "medium");
      expect(modeLabel.scrollWidth).toBeLessThanOrEqual(modeLabel.clientWidth);
      visibleLabel(project, "qa-nt-scratch");

      // Every chip and the send button stay inside the strip, side by side.
      const chips = [orb, project, mode, submit];
      for (const chip of chips) {
        expect(box(chip).left).toBeGreaterThanOrEqual(
          box(strip as Element).left,
        );
        expect(box(chip).right).toBeLessThanOrEqual(
          box(strip as Element).right,
        );
      }
      for (const [left, right] of [
        [orb, project],
        [project, mode],
        [mode, submit],
      ] as const)
        expect(box(left).right).toBeLessThanOrEqual(box(right).left);

      // A tap within 44px of each chip's center lands on the chip.
      for (const chip of [orb, project, mode]) {
        const rect = box(chip);
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        expect(rect.width).toBeGreaterThanOrEqual(44);
        for (const dy of [-21, 21])
          expect(
            chip.contains(document.elementFromPoint(x, y + dy)),
            `${chip.getAttribute("aria-label")} at ${dy}px`,
          ).toBe(true);
      }
      await React.act(() => root.unmount());
    });

    it("shortens a pinned model's long name instead of pushing send off the strip", async () => {
      const { container, root } = await mountPhoneStrip(phone, {
        model: "dx-byok/a-very-long-reasoning-model-name-preview-2026",
      });
      const strip = container.querySelector(
        ".new-thread-config-strip",
      ) as HTMLElement;
      const mode = container.querySelector(".new-thread-mode") as HTMLElement;
      const submit = container.querySelector(
        ".new-thread-submit",
      ) as HTMLElement;
      expect(mode.textContent).toMatch(/^Model: a very long/);
      expect(box(mode).right).toBeLessThanOrEqual(box(submit).left);
      expect(box(submit).right).toBeLessThanOrEqual(box(strip).right);
      await React.act(() => root.unmount());
    });
  },
);
