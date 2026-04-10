---
inclusion: always
---

# Development Workflow

## Archon Config

The project uses `.archon/config.yaml` for repo-level configuration:

- `worktree.baseBranch: dev` — all worktrees branch from `dev`
- `docs.path: packages/docs-web/src/content/docs` — documentation directory

## Development Cookbooks (archon-dev)

The project follows a structured development flow with artifacts stored in `.claude/archon/`:

```
research → investigate → prd → plan → implement → commit → pr
                                          ↑              │
                         debug ───────────┘   review ◄───┘
```

Artifact directories:

```
.claude/archon/
├── prds/              # Product requirement documents
├── plans/             # Implementation plans (completed/ for archived)
├── reports/           # Implementation reports
├── issues/            # GitHub issue investigations (completed/ for archived)
├── reviews/           # PR review reports
├── debug/             # Root cause analysis
└── research/          # Research findings
```

## Plan-Driven Implementation

Plans are the core artifact. A plan file (`.plan.md`) contains:

- Mandatory reading list with file:line references
- Patterns to mirror from existing codebase
- Step-by-step tasks with validation commands
- Acceptance criteria

Implementation follows the plan sequentially with validation gates after each task. If stuck after 2 fix attempts, stop and ask the user.

## Commit Conventions

- Conventional commits: `{type}({scope}): {description}`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`, `perf`
- No AI attribution — no "Generated with Claude", no "Co-Authored-By: Claude"
- Subject line under 72 characters
- Body explains WHY, not WHAT

## Release Process

- Releases use the `/release` skill: compare `dev` to `main`, generate changelog, bump version, create PR
- Semantic versioning: patch (default), minor, major
- Changelog follows Keep a Changelog format in `CHANGELOG.md`
- Version is the single `version` field in root `package.json`
- After merge: tag, GitHub Release, Homebrew formula update (version + SHA256 atomically), tap sync
- Never update `homebrew/archon.rb` version without also updating SHA256 values

## Archon CLI Workflows

Archon runs AI workflows in isolated git worktrees. Key workflows:

- `archon-fix-github-issue` — fix issues
- `archon-comprehensive-pr-review` / `archon-smart-pr-review` — PR reviews
- `archon-validate-pr` — PR validation
- `archon-feature-development` / `archon-idea-to-pr` — feature development
- `archon-assist` — general fallback

Run with: `archon workflow run <name> --branch <branch-name> "<message>"`

Always use `--branch` for worktree isolation unless explicitly told otherwise.
