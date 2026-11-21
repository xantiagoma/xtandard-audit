// The documentation site, built with @xtandard/kit/site: Starlight over the repository's Markdown
// (scripts/sync.ts copies it into src/content/docs/ first), the header lockups, favicons and social
// card from docs/assets/, a TypeDoc API reference with one module per `exports` entry, Mermaid
// diagrams and the links validator (a broken internal link fails the build). manifest.ts holds the
// information architecture. `bun run build` writes dist/ here; .github/workflows/pages.yml
// publishes it.
import { defineXtandardSite } from "@xtandard/kit/site";
import { manifest } from "./manifest.ts";

export default await defineXtandardSite({
  manifest,
  description:
    "Self-hosted, embeddable, tamper-evident audit-log control plane for B2B SaaS: typed events, your storage, hash-chained and signed, with a customer portal, exports and SIEM streaming.",
  // The social card's tagline (docs/assets/social.svg), for its alt text.
  tagline: "Tamper-evident audit logs for B2B SaaS, as a library",
  // Symbols several entry points export are documented under the first owner TypeDoc meets: the
  // types on /api/schema/, the verifier's functions (hash chain, checkpoints, bundles) on
  // /api/verify/ — the page an auditor reads — and the core on /api/core/; the root
  // `@xtandard/audit` then owns what only it gathers (the recorder, transforms, streams, portal
  // tokens, the panel handler…).
  apiOwners: ["src/schema.ts", "src/verify.ts", "src/core.ts", "src/index.ts"],
  devPort: 4326,
});
