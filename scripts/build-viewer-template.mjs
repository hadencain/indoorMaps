#!/usr/bin/env node
// Inlines the single-chunk viewer build (dist-viewer/, produced by
// `vite build --config vite.viewer.config.ts`) into one committed HTML
// template: src/generated/viewer-template.html. The main app imports that
// template as a raw string (`?raw`) and does a sentinel string-replace to
// embed the visitor-safe building JSON at export time (see src/store.ts
// exportViewer()). Zero deps — plain node fs/path.
//
// See docs/superpowers/plans/2026-07-16-pviewer-single-file.md (Task 3).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distViewer = join(root, "dist-viewer");
const outDir = join(root, "src", "generated");
const outFile = join(outDir, "viewer-template.html");

const htmlPath = join(distViewer, "viewer.html");
let html = readFileSync(htmlPath, "utf8");

// Locate the single referenced script and stylesheet. Anchor on `src="..."`/
// `href="..."` rather than a full tag match so attribute order/crossorigin
// don't matter, then match the WHOLE tag for replacement.
const scriptSrcMatch = html.match(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*><\/script>/);
if (!scriptSrcMatch) {
  throw new Error(`build-viewer-template: no <script src="*.js"> found in ${htmlPath}`);
}
const linkHrefMatch = html.match(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/);
if (!linkHrefMatch) {
  throw new Error(`build-viewer-template: no <link href="*.css"> found in ${htmlPath}`);
}

const scriptTag = scriptSrcMatch[0];
const scriptSrc = scriptSrcMatch[1];
const linkTag = linkHrefMatch[0];
const linkHref = linkHrefMatch[1];

// Guard against the packaging problem this build exists to avoid: if a
// second script/link (a vendor chunk, a modulepreload) shows up, the
// dedicated viewer config regressed and hand-inlining would silently drop
// code. Fail loudly instead.
const allScripts = html.match(/<script\b[^>]*\bsrc="[^"]+\.js"[^>]*><\/script>/g) ?? [];
const allLinks = html.match(/<link\b[^>]*\bhref="[^"]+\.css"[^>]*>/g) ?? [];
const modulepreloads = html.match(/<link\b[^>]*\brel="modulepreload"[^>]*>/g) ?? [];
if (allScripts.length !== 1 || allLinks.length !== 1 || modulepreloads.length !== 0) {
  throw new Error(
    `build-viewer-template: expected exactly 1 script + 1 stylesheet + 0 modulepreloads in ` +
      `${htmlPath}, found ${allScripts.length} script(s), ${allLinks.length} stylesheet(s), ` +
      `${modulepreloads.length} modulepreload(s). Is vite.viewer.config.ts still single-chunk?`,
  );
}

const jsPath = join(distViewer, scriptSrc.replace(/^\.\//, ""));
const cssPath = join(distViewer, linkHref.replace(/^\.\//, ""));
const js = readFileSync(jsPath, "utf8");
const css = readFileSync(cssPath, "utf8");

// Escape `</script` inside the inlined JS so it can't prematurely close the
// wrapping <script> tag. HTML's script-data-end-tag-open state matches on
// `</script` followed by whitespace/`/`/`>` (not just an exact `</script>`),
// so the regex is deliberately NOT `>`-strict — anchoring on the trailing
// `>` would miss e.g. `</script >` or `</script/`. This is a textual escape
// only — it does not touch `/*!`/`@license` comments (MapLibre's BSD-3
// notice must survive verbatim).
const safeJs = js.replace(/<\/script/gi, "<\\/script");

// Function replacers, NOT string replacers: a string replacement value gets
// `$&`/`$1`/`$$`-style pattern substitution applied even when the search
// value is a plain string, and minified bundles routinely contain literal
// `$&` sequences (e.g. inside React's key-escaping regex replace calls) —
// those would silently splice the matched tag text back into the bundle,
// corrupting it. A function replacer returns its value verbatim.
html = html.replace(scriptTag, () => `<script type="module">${safeJs}</script>`);
html = html.replace(linkTag, () => `<style>${css}</style>`);

// Ensure the building-data sentinel carries the placeholder the export step
// (src/store.ts exportViewer) string-replaces. Task 2 already ships the
// element empty; inject the placeholder if it isn't there yet (idempotent —
// re-running this script on an already-placeholdered template is a no-op).
const sentinelRe = /(<script id="building-data" type="application\/json">)([\s\S]*?)(<\/script>)/;
const sentinelMatch = html.match(sentinelRe);
if (!sentinelMatch) {
  throw new Error(`build-viewer-template: no #building-data sentinel found in ${htmlPath}`);
}
if (!sentinelMatch[2].includes("/*__BUILDING__*/")) {
  html = html.replace(sentinelRe, `$1/*__BUILDING__*/$3`);
}

// Insurance against a future sentinel collision: the export step (src/store.ts
// exportViewer) does a single string-replace on this exact sentinel, so if the
// inlined JS/CSS ever happens to contain a second literal occurrence, that
// replace would silently target the wrong one (String.replace only touches
// the first match). Fail the build loudly instead of shipping a broken template.
const sentinelCount = (html.match(/\/\*__BUILDING__\*\//g) ?? []).length;
if (sentinelCount !== 1) {
  throw new Error(
    `build-viewer-template: expected exactly 1 occurrence of the /*__BUILDING__*/ sentinel in ` +
      `the built template, found ${sentinelCount}. Check for a collision in the inlined JS/CSS.`,
  );
}

mkdirSync(outDir, { recursive: true });

// Inject a banner comment as the FIRST line, before the doctype.
const banner = `<!-- GENERATED by scripts/build-viewer-template.mjs — do NOT edit; regenerate with: npm run build:viewer -->\n`;
const htmlWithBanner = banner + html;

writeFileSync(outFile, htmlWithBanner, "utf8");

console.log(`build-viewer-template: wrote ${outFile} (${htmlWithBanner.length.toLocaleString()} bytes)`);
