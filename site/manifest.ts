// The site's information architecture: which repository Markdown becomes which page, and the
// sidebar tree (see `defineSiteManifest` in @xtandard/kit/site). scripts/sync.ts and
// astro.config.ts both read it, so a page and its sidebar entry cannot drift.
//
// The Markdown in the repository (README.md, docs/*.md) stays the single source of truth: it is
// what GitHub and npm render. A page is one of:
//   - a whole repository file (`src`);
//   - some H2 sections of one (`src` + `sections`, optionally `intro` for the text above the first
//     H2) — how README.md is split into several pages;
//   - a page written for the site only (`site`, relative to site/content/).
// A page marked `pending` is a guide another branch is still writing: while its `src` is missing
// the page and its sidebar entry are left out and links to it point at GitHub, so the build does
// not fail; once the file lands on main it is an ordinary page with no manifest change.
// The origin and base come from SITE_ORIGIN / SITE_BASE when pages.yml sets them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineSiteManifest, type SitePage } from "@xtandard/kit/site";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Sidebar labels for the architecture decision records, by number. Every `docs/ADR/NNNN-*.md` is a
 * page (an ADR missing here is labelled from its H1), so a new ADR needs no manifest change.
 */
const adrLabels: Record<string, string> = {
  "0001": "Subpath exports",
  "0002": "The record path never loses events",
  "0003": "Bundled SPA UI",
  "0004": "Hash chain & checkpoints",
  "0005": "Storage contract",
  "0006": "Portal tokens",
  "0007": "Query model & pagination",
  "0008": "Pull-based streaming",
  "0009": "drizzle-audit",
  "0010": "Time-sortable event ids",
  "0011": "Erasure vs immutability",
  "0012": "Typed actions",
  "0013": "Request context",
  "0014": "Panel handler deviations",
};

function adrs(): SitePage[] {
  const dir = join(repoRoot, "docs/ADR");
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .sort()
    .map((file) => {
      const n = file.slice(0, 4);
      const h1 = /^# (?:ADR \d+\s*[—-]\s*)?(.+)$/m.exec(readFileSync(join(dir, file), "utf8"));
      return {
        slug: `project/adr/${n}`,
        src: `docs/ADR/${file}`,
        label: `${n} · ${adrLabels[n] ?? h1?.[1]?.replaceAll("`", "") ?? file}`,
      };
    });
}

export const manifest = defineSiteManifest({
  repoRoot,
  repoSlug: "xantiagoma/xtandard-audit",
  packageName: "@xtandard/audit",
  // The root import's module name: `@xtandard/audit` is documented at /api/audit/.
  rootModule: "audit",
  base: "/xtandard-audit",
  home: { slug: "", site: "index.mdx" },
  sidebar: [
    {
      label: "Start here",
      items: [
        { slug: "getting-started", src: "docs/GETTING_STARTED.md", label: "Getting started" },
        {
          slug: "guides/why",
          src: "README.md",
          sections: ["Why another audit-log tool?", "How it works"],
          title: "Why @xtandard/audit",
          label: "Why & how it works",
        },
        {
          slug: "guides/quickstart",
          src: "README.md",
          sections: ["Quickstart", "Record your first events", "Typed actions"],
          title: "Quickstart: mount, record, type your actions",
          label: "Quickstart",
        },
        {
          slug: "guides/tour",
          src: "README.md",
          sections: [
            "Querying",
            "Tamper evidence",
            "The customer portal",
            "Exports and streaming",
            "Storage backends",
          ],
          title: "A tour of the features",
          label: "Feature tour",
        },
        {
          slug: "guides/subpath-exports",
          src: "README.md",
          sections: ["Subpath exports"],
          title: "Subpath exports",
          label: "Subpath exports",
        },
        {
          slug: "guides/examples",
          src: "README.md",
          sections: ["Examples"],
          title: "Examples",
          label: "Examples",
        },
      ],
    },
    {
      label: "Concepts",
      items: [
        { slug: "concepts/architecture", src: "docs/ARCHITECTURE.md", label: "Architecture" },
        { slug: "concepts/querying", src: "docs/QUERYING.md", label: "Querying & pagination" },
        { slug: "concepts/integrity", src: "docs/INTEGRITY.md", label: "Tamper evidence" },
        { slug: "concepts/streaming", src: "docs/STREAMING.md", label: "Exports & streaming" },
        { slug: "concepts/hooks", src: "docs/HOOKS.md", label: "Hooks" },
      ],
    },
    {
      label: "Storage & integrations",
      items: [
        { slug: "storage", src: "docs/STORAGE.md", label: "Storage" },
        { slug: "integrations/adapters", src: "docs/ADAPTERS.md", label: "Framework adapters" },
        { slug: "integrations/http-api", src: "docs/HTTP_API.md", label: "HTTP API" },
        {
          slug: "integrations/drizzle-audit",
          src: "docs/DRIZZLE_AUDIT.md",
          label: "drizzle-audit bridge",
        },
      ],
    },
    {
      label: "Access control",
      items: [
        { slug: "security/auth", src: "docs/AUTH.md", label: "Authentication" },
        { slug: "security/authorization", src: "docs/AUTHORIZATION.md", label: "Authorization" },
      ],
    },
    {
      label: "UI",
      items: [
        { slug: "ui/portal", src: "docs/PORTAL.md", label: "Customer portal" },
        { slug: "ui/admin", src: "docs/UI.md", label: "Admin UI & React embeds" },
      ],
    },
    {
      label: "Operations",
      items: [
        { slug: "operations/deployment", src: "docs/DEPLOYMENT.md", label: "Deployment" },
        {
          slug: "operations/cli",
          src: "README.md",
          sections: ["CLI"],
          title: "CLI",
          label: "CLI",
        },
        { slug: "operations/testing", src: "docs/TESTING.md", label: "Testing" },
      ],
    },
    // The "API reference" group (starlight-typedoc) goes here, before the last group.
    {
      label: "Project",
      items: [
        {
          slug: "project/ecosystem",
          src: "README.md",
          sections: ["The xtandard ecosystem"],
          title: "The xtandard ecosystem",
          label: "xtandard ecosystem",
        },
        // Written by changelogen on the first release.
        { slug: "project/changelog", src: "CHANGELOG.md", label: "Changelog", pending: true },
        {
          slug: "project/landscape",
          src: "docs/research/landscape.md",
          title: "The audit-log landscape",
          label: "Market landscape",
        },
        { label: "Architecture decisions", collapsed: true, items: adrs() },
        { slug: "project/brand", src: "docs/BRAND.md", label: "Brand" },
        { slug: "project/releases", src: "docs/RELEASES.md", label: "Releases", internal: true },
        { label: "npm", link: "https://www.npmjs.com/package/@xtandard/audit" },
      ],
    },
  ],
});
