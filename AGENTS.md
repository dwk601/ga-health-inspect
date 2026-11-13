# ga-health-inspect

Community-driven, map-based web app for Georgia health inspections. People can rate and comment, with social-media-style participation. Not Google Maps or a general-purpose mapping product.

Intended stack: React + Vite; PocketBase (Go) handles the application backend. PostgreSQL supplies inspection data from an existing deployed server.

## Load-bearing gotchas

- Community scope is ratings and comments. “Like a social media” does not specify a likes feature, follows, feeds, or other social features. Keep community ratings distinct from inspection scores.
- Inspection data comes from the existing deployed ETL project at `/Users/dwk/Personal/etl/ga_health_inspect`. This is a local project path, not a database name or connection string. Reuse that server's data; do not recreate the ETL pipeline here.
- PocketBase owns application behavior; PostgreSQL is the inspection-data source, not PocketBase's backing store. Do not write community data to the source PostgreSQL database or alter its schema without explicit authorization.
- The data-access interface, schema, inspection score meanings, and refresh cadence still need verification in the ETL project before integration. Do not assume direct PostgreSQL access versus an API, or invent inspection facts.
- “Not Google Maps” describes product scope, not a selected or prohibited map provider. Map provider choice is unresolved.

## Standing rules

- Write clean code: clear names, small focused functions, no dead code or speculative abstractions.
- Never save docs or plans to the repo (no README additions, docs/, plan files, decision logs, or summaries) unless the user explicitly asks.
- Write as few tests as possible. Tests must not slow development. No unit tests for implementation details.
- Before adding a test, answer: What observable behavior or contract does it protect? What credible regression fails it? Why doesn't existing coverage already catch that? Does it need a production seam (export, flag, wrapper) no real caller needs? Any missing answer means don't add it.
- Each contract gets one test, at the strongest boundary. Extend an existing case or table instead of adding a near-duplicate. Never add: assertion-free coverage probes, mocks that implement the behavior under test, expected values computed by the code under test, copied fixtures or export lists, source or string greps, private-helper tests, or test-only exports.
- A test that breaks under a behavior-preserving refactor asserts implementation; rewrite it at the real boundary or delete it.
- Bug fix: one regression test at the owning boundary, and it must fail on the pre-fix code.
- While developing, run only the focused test for the change. Run the full suite once before handoff.

## Skill map

- [frontend-design](.agents/skills/frontend-design/SKILL.md): load when building new UI, reshaping existing UI, or choosing visual direction, typography, and layout.
- [ui-sdk](.agents/skills/ui-sdk/SKILL.md): before using ui-sdk (`@ui-sdk/react`, `@ui-sdk/core`), follow this skill and read `web/node_modules/@ui-sdk/react/docs/llms.txt`. To build a new component, also search `web/node_modules/@ui-sdk/react/docs/core.md` by heading and read `rendering.md` next to it.

## Maintain

Prune instead of append; point instead of copy. Keep each rule in one place. Add a domain skill only when concrete interfaces, pitfalls, or verification gates justify it.
