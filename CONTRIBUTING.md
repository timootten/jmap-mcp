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
2. Merge the release PR when you want to ship. This creates the tag and the GitHub release.
3. The same workflow stages the package on npm (`npm stage publish`, OIDC, with provenance). It waits for
   approval of the `npm` environment, then runs `bun run check`, `bun test` and `bun run smoke` on the tag.
4. Approve the staged version with 2FA on npmjs.com (Staged Packages) or with `npm stage list` and
   `npm stage approve <id>`. Only then is it installable.

To force a version, put `Release-As: x.y.z` in the body of a commit on `main`.

If the workflow fails after the tag exists, fix the cause and re-run the failed run. Do not move or
delete tags: release tags are immutable.

## One-time setup (already done)

- npm trusted publisher: repository `timootten/jmap-mcp`, workflow `release.yml`, environment `npm`.
- GitHub environment `npm`: deployments only from `main`, required reviewer.
- GitHub repository: squash merge only, immutable releases on, Actions may create pull requests.
