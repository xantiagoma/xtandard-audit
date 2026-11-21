// The documentation site: Astro Starlight over the repository's Markdown (scripts/sync.ts copies it
// into src/content/docs/ first), a TypeDoc API reference generated from src/ (starlight-typedoc),
// and Mermaid diagrams. site/manifest.ts holds the information architecture and the entry points.
// `bun run build` writes dist/ here; .github/workflows/pages.yml publishes it.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { createStarlightTypeDocPlugin } from "starlight-typedoc";
import { apiOverviews } from "./scripts/api-overviews.ts";
import {
  entries,
  isGroup,
  isPage,
  npmUrl,
  packageName,
  repoRoot,
  repoUrl,
  sidebar,
  siteBase,
  siteOrigin,
  type Item,
} from "./manifest.ts";

type SidebarItem =
  | { slug: string; label?: string }
  | { label: string; link: string }
  | { label: string; collapsed?: boolean; items: SidebarItem[] };

const toSidebar = (items: Item[]): SidebarItem[] =>
  items.map((i) => {
    if (isPage(i)) return i.label ? { slug: i.slug, label: i.label } : { slug: i.slug };
    if (isGroup(i)) return { label: i.label, collapsed: i.collapsed, items: toSidebar(i.items) };
    return { label: i.label, link: i.link };
  });

/**
 * Entry points other entry points re-export from, in this order. TypeDoc documents a symbol
 * exported by several entry points under the first one it meets: the types on /api/schema/, the
 * verifier's functions (hash chain, checkpoints, bundles) on /api/verify/ — the page an auditor
 * reads — and the core on /api/core/; the root `@xtandard/audit` then owns what only it gathers
 * (the recorder, transforms, streams, portal tokens, the panel handler…).
 */
const apiOwners = ["src/schema.ts", "src/verify.ts", "src/core.ts", "src/index.ts"];
const entrySources = entries().map((e) => e.source);
for (const o of apiOwners)
  if (!entrySources.includes(o)) throw new Error(`astro.config.ts: ${o} is not an entry point`);

/** The social card (docs/assets/social.png, copied to public/ by scripts/sync.ts), by absolute URL. */
/** The social card's tagline (docs/assets/social.svg), for its alt text. */
const tagline = "Tamper-evident audit logs for B2B SaaS, as a library";
const socialImage = `${siteOrigin}${siteBase}/social.png`;

const typedocPlugin = new URL("./scripts/typedoc-plugin.ts", import.meta.url);

const [apiReference, apiSidebarGroup] = createStarlightTypeDocPlugin();

export default defineConfig({
  site: siteOrigin,
  base: siteBase,
  trailingSlash: "ignore",
  telemetry: false,
  integrations: [
    // Must come before Starlight.
    mermaid({ theme: "neutral", autoTheme: true, enableLog: false }),
    starlight({
      title: packageName,
      description:
        "Self-hosted, embeddable, tamper-evident audit-log control plane for B2B SaaS: typed events, your storage, hash-chained and signed, with a customer portal, exports and SIEM streaming.",
      // docs/BRAND.md: the horizontal lockup for each theme, in place of the text title.
      logo: {
        dark: "../docs/assets/lockup-horizontal-dark.svg",
        light: "../docs/assets/lockup-horizontal-light.svg",
        alt: packageName,
        replacesTitle: true,
      },
      // The favicon set (docs/assets/, copied to public/ by scripts/sync.ts): the SVG, which
      // modern browsers prefer, plus the ICO and the Apple touch icon.
      favicon: "/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: { rel: "icon", href: `${siteBase}/favicon.ico`, sizes: "16x16 32x32 48x48" },
        },
        {
          tag: "link",
          attrs: { rel: "apple-touch-icon", href: `${siteBase}/apple-touch-icon.png` },
        },
        { tag: "meta", attrs: { property: "og:image", content: socialImage } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1280" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "640" } },
        {
          tag: "meta",
          attrs: { property: "og:image:alt", content: `${packageName} — ${tagline}` },
        },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: socialImage } },
      ],
      social: [
        { icon: "github", label: "GitHub", href: repoUrl },
        { icon: "npm", label: "npm", href: npmUrl },
      ],
      editLink: { baseUrl: `${repoUrl}/edit/main/` },
      lastUpdated: false,
      customCss: ["./src/styles/brand.css"],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        ...toSidebar(sidebar).slice(0, -1),
        apiSidebarGroup,
        ...toSidebar(sidebar).slice(-1),
      ],
      plugins: [
        apiReference({
          // A fixed order: a symbol exported by several entry points is documented under the first
          // one TypeDoc meets, and a glob's order differs between file systems (macOS vs the Linux
          // CI). The modules that others re-export from come first; then the rest alphabetically.
          entryPoints: [
            ...apiOwners,
            ...entrySources.filter((f) => !apiOwners.includes(f)).sort(),
          ].map((f) => join(repoRoot, f)),
          // Solution-style: one program for every entry point under src/ (against Elysia 1) and
          // one for the Elysia 2 adapter with `elysia` resolved to Elysia 2 (as
          // tsconfig.elysia2.json checks it), so /api/elysia2/ shows Elysia 2's types.
          tsconfig: "./typedoc.tsconfig.json",
          output: "api",
          sidebar: { label: "API reference", collapsed: true },
          typeDoc: {
            // scripts/typedoc-plugin.ts: named return types as written, and the re-export list
            // scripts/api-overviews.ts puts on each module page.
            plugin: ["typedoc-plugin-missing-exports", fileURLToPath(typedocPlugin)],
            // @ts-expect-error -- typedoc-plugin-missing-exports options
            placeInternalsInOwningModule: true,
            excludePrivate: true,
            excludeInternal: true,
            excludeExternals: true,
            disableGit: true,
            // `bun run typecheck` (CI) type-checks the project, tests included. TypeDoc only reads
            // src/, and its own check of the whole program would trip on test-only imports.
            skipErrorChecking: true,
            // {path} is relative to src/ (the entry points' common directory).
            sourceLinkTemplate: `${repoUrl}/blob/main/src/{path}#L{line}`,
            useCodeBlocks: true,
            parametersFormat: "table",
            interfacePropertiesFormat: "table",
            classPropertiesFormat: "table",
            typeDeclarationFormat: "table",
            enumMembersFormat: "table",
          },
        }),
        // After starlight-typedoc (plugins run in order): the /api/ and /api/<module>/ pages.
        apiOverviews(),
        starlightLinksValidator({
          errorOnRelativeLinks: false,
          errorOnInvalidHashes: true,
          // The guides point at the local servers they start (http://localhost:3000).
          errorOnLocalLinks: false,
        }),
      ],
    }),
  ],
});
