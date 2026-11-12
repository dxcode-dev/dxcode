import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./plugin-icon.js";

// An SVG icon comes from an untrusted package. Ways it could be hostile or
// misread, each covered below:
// - <script> in any case or with a namespace prefix;
// - on* event attributes;
// - javascript:, data:, or outside URLs in href or xlink:href, including
//   ones spelled with character entities;
// - <foreignObject>, <image>, <a>, <animate>/<set> (which can rewrite an
//   href), and <style> elements or style attributes (@import, url());
// - url() paint references that leave the image;
// - DOCTYPE or ENTITY declarations (entity bombs, XXE), CDATA, and
//   processing instructions such as xml-stylesheet;
// - malformed markup a browser could read differently: unclosed tags,
//   unquoted attributes, mismatched tags, a bare `&`;
// - attribute values that break out of quotes when written back;
// - a root that is not <svg>, or content after </svg>.

const clean = (svg: string) => {
  const result = sanitizeSvg(svg);
  if (!result.ok) throw new Error(result.reason);
  return result.svg;
};

const refused = (svg: string) => expect(sanitizeSvg(svg).ok).toBe(false);

describe("sanitizeSvg", () => {
  it("keeps an ordinary icon, with its case-sensitive names", () => {
    const svg = clean(
      `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" width="24" height="24">
  <!-- logo -->
  <defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <title>Acme &amp; Co</title>
  <path d="M0 0h24v24H0z" fill="url(#g)"/>
  <radialGradient id="h" xlink:href="#g"/>
  <use href="#g"/>
</svg>`,
    );
    expect(svg).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"',
    );
    expect(svg).toContain(
      '<linearGradient id="g" gradientUnits="userSpaceOnUse">',
    );
    expect(svg).toContain('fill="url(#g)"');
    expect(svg).toContain('<radialGradient id="h" href="#g"/>');
    // Nested <use> can multiply into millions of shapes, so it is dropped.
    expect(svg).not.toContain("<use");
    expect(svg).toContain("<title>Acme &amp; Co</title>");
    expect(svg).not.toContain("logo");
    expect(svg).not.toContain("xlink");
  });

  it("drops scripts and everything inside them, in any spelling", () => {
    for (const script of [
      "<script>alert(1)</script>",
      "<SCRIPT>alert(1)</SCRIPT>",
      "<svg:script>alert(1)</svg:script>",
    ]) {
      const svg = clean(`<svg>${script}<path d="M0 0"/></svg>`);
      expect(svg.toLowerCase()).not.toContain("script");
      expect(svg).not.toContain("alert");
      expect(svg).toContain('<path d="M0 0"/>');
    }
  });

  it("drops event handlers", () => {
    const svg = clean(
      `<svg onload="alert(1)"><path ONCLICK='alert(2)' onmouseover = "x" d="M0 0"/></svg>`,
    );
    expect(svg).not.toMatch(/on\w+=/i);
    expect(svg).not.toContain("alert");
  });

  it("keeps only same-image references in href", () => {
    for (const href of [
      "javascript:alert(1)",
      "&#106;avascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "https://example.com/x.svg#a",
      "//example.com/x.svg",
      " #a",
    ]) {
      const svg = clean(
        `<svg><radialGradient href="${href}"/><radialGradient xlink:href="${href}"/></svg>`,
      );
      expect(svg).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg"><radialGradient/><radialGradient/></svg>',
      );
    }
  });

  it("drops elements that embed, link, animate, or style", () => {
    const svg = clean(
      `<svg>
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://x"/></div></foreignObject>
<image href="https://example.com/track.png"/>
<a href="javascript:alert(1)"><path d="M1 1"/></a>
<animate attributeName="href" to="javascript:alert(1)"/>
<set attributeName="href" to="javascript:alert(1)"/>
<style>@import url(https://example.com/x.css);</style>
<rect style="fill:url(https://example.com/x)" width="1"/>
</svg>`,
    );
    for (const gone of [
      "foreignObject",
      "iframe",
      "image",
      "<a",
      "animate",
      "<set",
      "style",
      "example.com",
      "javascript",
      "M1 1",
    ]) {
      expect(svg).not.toContain(gone);
    }
    expect(svg).toContain('<rect width="1"/>');
  });

  it("drops url() paint that leaves the image", () => {
    const svg = clean(
      `<svg><rect fill="url(https://example.com/p)" stroke="url( #ok )" mask="url(data:x)"/></svg>`,
    );
    expect(svg).not.toContain("example.com");
    expect(svg).not.toContain("data:");
  });

  it("refuses declarations, CDATA, and processing instructions", () => {
    refused(`<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>`);
    refused(`<svg><![CDATA[<script>alert(1)</script>]]></svg>`);
    refused(`<?xml-stylesheet href="https://example.com/x.css"?><svg/>`);
    refused(`<svg><?php echo 1 ?></svg>`);
    refused(`<svg><text>&unknown;</text></svg>`);
    refused(`<svg><text>&constructor;</text></svg>`);
  });

  it("refuses markup a browser could read differently", () => {
    refused(`<svg><path d="M0 0"></svg>`);
    refused(`<svg><path d=M0/></svg>`);
    refused(`<svg><path d="M0 0/></svg>`);
    refused(`<svg><g></path></svg>`);
    refused(`<svg><text>a & b</text></svg>`);
    refused(`<svg><!-- open </svg>`);
    refused(`<svg>`);
  });

  it("escapes values so they cannot break out of quotes", () => {
    const svg = clean(
      `<svg><path id='a"b&quot; onload=&quot;x' d="M0 0"/></svg>`,
    );
    expect(svg).toContain('id="a&quot;b&quot; onload=&quot;x"');
    expect(sanitizeSvg(svg).ok).toBe(true);
  });

  it("refuses a root that is not svg, and anything after it", () => {
    refused(`<html><svg/></html>`);
    refused(`<script>alert(1)</script><svg/>`);
    refused(`<svg/><script>alert(1)</script>`);
    refused(`<svg/>text`);
    refused(`not an svg`);
    expect(clean(`<svg/>\n<!-- end -->\n`)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
  });
});
