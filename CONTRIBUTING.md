# Contributing

```sh
bun install --frozen-lockfile
bun run check   # tsc + oxlint + oxfmt --check
bun test
bun run smoke   # packs the package, installs the tarball into an empty project, starts it
```

## Commits and pull requests

Pull requests are squash-merged and the **PR title becomes the commit message**. It must follow
[Conventional Commits](https://www.conventionalcommits.org/) (a check enforces this). The title decides
the next version:

| Title                                                    | Release                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `fix: ...`                                               | patch                                                       |
| `feat: ...`                                              | minor (while below 1.0.0, breaking changes also bump minor) |
| `feat!: ...` or a `BREAKING CHANGE:` footer              | major (minor while below 1.0.0)                             |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `build:` | no release                                                  |

## Releasing

Nobody edits the version or creates tags by hand.

1. Merging to `main` updates the **release PR** (`chore: release x.y.z`) with the new version and `CHANGELOG.md`.
2. Merge the release PR when you want to ship. That is the whole release: the workflow creates the tag and the
   GitHub release, runs `bun run check`, `bun test` and `bun run smoke` on the tag, and publishes to npm
   (OIDC, with provenance, no stored token).

The checks on the release PR may show `action_required` because a bot opened it. Ignore them: the publish job runs
the same checks before it publishes, and nothing requires them to merge.

To force a version, put `Release-As: x.y.z` in the body of a commit on `main`.

If the workflow fails after the tag exists, fix the cause and re-run the failed run. Do not move or
delete tags: release tags are immutable.

## One-time setup (already done)

- npm trusted publisher: repository `timootten/jmap-mcp`, workflow `release.yml`, environment `npm`.
- GitHub environment `npm`: deployments only from `main`.
- GitHub repository: squash merge only, immutable releases on, Actions may create pull requests.
