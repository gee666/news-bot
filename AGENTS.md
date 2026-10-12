# Code quality bar

- Remove dead code, unused imports, and unused dependencies. Wire intended functionality into the application instead of leaving disconnected code.
- Keep module responsibilities and dependency boundaries clear. Follow existing project conventions and use TypeScript libraries and frameworks as intended.
- Avoid duplicated logic and unnecessary abstractions. Prefer simple, consistent solutions over one-off patterns.
- Fix root causes, not symptoms. Avoid brittle workarounds. Make deployment-specific values and operational settings configurable, and never hardcode secrets.
- Use strict TypeScript and types that model valid application states. Validate external data at runtime. Do not bypass type safety with `any`, unsafe assertions, or suppressed type errors.
- Keep functions and classes focused. Split files by responsibility before they exceed 350 lines. Exceed this limit only when splitting would clearly hurt readability or cohesion, and explain why.
- Remove stale or irrelevant comments and docs. Keep useful ones accurate, short, clear, and human-friendly. Explain non-obvious decisions rather than restating code. Apply the unslop and write-prompts skills when available.
- Add or update tests for changed behavior. Run the project's available type checks, lint checks, and relevant tests before considering work complete.
