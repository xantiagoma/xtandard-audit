// The site's information architecture: which repository Markdown becomes which page, the sidebar
// tree, and the package's entry points. scripts/sync.ts reads it to write src/content/docs/, and
// astro.config.ts reads it to build the sidebar and the API reference, so a page and its sidebar
// entry cannot drift.
//
// The Markdown in the repository (README.md, docs/*.md) stays the single source of truth: it is
// what GitHub and npm render. A page is one of:
//   - a whole repository file (`src`);
//   - some H2 sections of one (`src` + `sections`, optionally `intro` for the text above the first
//     H2) — how README.md is split into several pages. Every H2 of a split file other than the
//     README must land on exactly one page, so a new section cannot silently disappear;
//   - a page written for the site only (`site`, relative to site/content/).
// A page marked `pending` is a guide another branch is still writing: while its `src` is missing
// the page and its sidebar entry are left out and links to it point at GitHub, so the build does
// not fail; once the file lands on main it is an ordinary page with no manifest change.
// Plain Node APIs only: Astro loads this file through Vite.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const repoSlug = "xantiagoma/xtandard-audit";
export const repoUrl = `https://github.com/${repoSlug}`;
export const packageName = "@xtandard/audit";
export const npmUrl = "https://www.npmjs.com/package/@xtandard/audit";
export const branch = "main";
/**
 * Where the site is served: the project site of xantiagoma.github.io, under the account's custom
 * domain. pages.yml passes what actions/configure-pages reports (SITE_ORIGIN, SITE_BASE), so a
 * domain change needs no code change.
 */
// configure-pages reports the custom domain as http:// (HTTPS is served, but the reported origin is
// not upgraded); canonical URLs, the sitemap and og:image must be https.
export const siteOrigin = (process.env.SITE_ORIGIN || "https://me.xantiagoma.com").replace(
  /^http:\/\//,
  "https://",
);
export const siteBase = (process.env.SITE_BASE || "/xtandard-audit").replace(/\/+$/, "");

// ---- entry points ---------------------------------------------------------------------------

export type Entry = {
  /** The API reference module name (the `@module` tag of the entry file) and its route. */
  module: string;
  /** The import specifier users write. */
  importPath: string;
  /** The source file, relative to the repository root. */
  source: string;
};

/** The root import's module name: `@xtandard/audit` is documented at /api/audit/. */
export const rootModule = "audit";

/** Subpaths that are not TypeScript entry points (assets, the manifest). */
const nonCode = (key: string) =>
  key === "./package.json" || key.endsWith(".css") || key.includes("*");

/**
 * Every public entry point, in package.json `exports` order. The source file follows the build's
 * convention (vite.config.ts `pack.entry`): the root is src/index.ts, a few subpaths have their
 * own module (src/core.ts, src/react.tsx…), and the rest are src/entry-<path-with-dashes>.ts.
 */
export function entries(): Entry[] {
  const exportsMap = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
    .exports as Record<string, unknown>;
  return Object.keys(exportsMap)
    .filter((key) => !nonCode(key))
    .map((key) => {
      const sub = key.replace(/^\.\/?/, "");
      const entryFile = `src/entry-${sub.replaceAll("/", "-")}.ts`;
      const candidates =
        sub === ""
          ? ["src/index.ts"]
          : sub.includes("/")
            ? [entryFile]
            : [`src/${sub}.ts`, `src/${sub}.tsx`, entryFile];
      const source = candidates.find((f) => existsSync(join(repoRoot, f)));
      if (!source) throw new Error(`manifest.ts: no source entry for "${key}" in package.json`);
      return {
        module: sub === "" ? rootModule : sub,
        importPath: sub === "" ? packageName : `${packageName}/${sub}`,
        source,
      };
    });
}

// ---- pages ----------------------------------------------------------------------------------

export type Page = {
  /** Route without the base and without slashes; "" is the home page. */
  slug: string;
  /** Sidebar label; the page title when absent. */
  label?: string;
  /** Repository file the page is built from. */
  src?: string;
  /** Only these H2 sections of `src` (by heading text, in file order). */
  sections?: string[];
  /** With `sections`: also the H1 and the text above the first H2. */
  intro?: boolean;
  /** Page title when it does not come from the source's H1. */
  title?: string;
  /** Site-only page in site/content/ (.md or .mdx). */
  site?: string;
  /** Contributor-only material: a banner says so and search skips it. */
  internal?: boolean;
  /** A guide still being written on another branch: left out while `src` does not exist. */
  pending?: boolean;
};
export type Link = { label: string; link: string };
export type Group = { label: string; collapsed?: boolean; items: Item[] };
export type Item = Page | Link | Group;

export const home: Page = { slug: "", site: "index.mdx" };

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

function adrs(): Page[] {
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

const outline: Item[] = [
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
  // starlight-typedoc's "API reference" group is inserted here by astro.config.ts.
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
      { label: "npm", link: npmUrl },
    ],
  },
];

export const isPage = (i: Item): i is Page => "slug" in i;
export const isGroup = (i: Item): i is Group => "items" in i;

/** Whether a page is built: a pending guide only once its source exists. */
const present = (p: Page) => !p.pending || !p.src || existsSync(join(repoRoot, p.src));

function prune(items: Item[]): Item[] {
  return items.flatMap((i): Item[] => {
    if (isPage(i)) return present(i) ? [i] : [];
    if (isGroup(i)) {
      const kept = prune(i.items);
      return kept.length ? [{ ...i, items: kept }] : [];
    }
    return [i];
  });
}

function walk(items: Item[], out: Page[] = []): Page[] {
  for (const i of items) {
    if (isPage(i)) out.push(i);
    else if (isGroup(i)) walk(i.items, out);
  }
  return out;
}

/** The sidebar tree, without the pending guides that have not landed yet. */
export const sidebar: Item[] = prune(outline);

/** Every page, the home page first. */
export function pages(): Page[] {
  return [home, ...walk(sidebar)];
}

/** Pending guides whose source does not exist yet (links to them go to GitHub meanwhile). */
export function pendingPages(): Page[] {
  return walk(outline).filter((p) => !present(p));
}
