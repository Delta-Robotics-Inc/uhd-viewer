# Contributing to the UHD Viewer

Thanks for your interest in **uhd-viewer**, the viewer for [UHD](https://github.com/Delta-Robotics-Inc/OpenUHD) systems: the diagram, the 3D view, the hierarchy and the inspector, as a React component library and a standalone app. It is part of Protoboard Stack and open source under the [Apache License 2.0](LICENSE). Contributions are welcome.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it. Report unacceptable behavior to **mark@deltaroboticsinc.com**.

## Ways to contribute

- **Report bugs**: open an issue with the bundle (or a reduced one), the view and a screenshot.
- **Propose a feature**: open an issue *before* opening a PR. The viewer knows only UHD and its neutral view contract; anything that needs a change to the UHD data model belongs in UHD first.
- **Fix bugs and add tests**: small PRs are welcome without prior discussion.
- **Improve docs**: corrections and clarifications in `docs/` and the README.

## Development setup

The viewer imports UHD from a sibling checkout (`../uhd`):

```bash
mkdir protoboard && cd protoboard
git clone https://github.com/Delta-Robotics-Inc/OpenUHD uhd
git clone https://github.com/Delta-Robotics-Inc/uhd-viewer
cd uhd-viewer
npm install
```

### Common commands

```bash
npm run dev          # the dev server, http://localhost:5178 (open it with ?bundle=<url> without a sibling protoboard-cli)
npm run type-check   # strict TypeScript, no emit
npm test             # vitest
npm run build        # type-check, then the app, the library, the components and the headless renderer into dist/
```

`scripts/check-render.mjs` renders the viewer in a headless browser and checks what it draws; run it for a change to drawing or interaction.

CI (`.github/workflows/ci.yml`) runs the type-check, the tests, the build and `npm pack --dry-run` on every pull request, against UHD at the release tag it names; the DCO check (`.github/workflows/dco.yml`) checks the sign-offs. The viewer builds against a UHD release: check out the same tag in `../uhd` (`git -C ../uhd checkout v0.3.0`) when your `main` of UHD has moved on.

## Pull request process

1. Fork the repo and create a feature branch off `main`.
2. Make your change. Keep PRs focused: one logical change per PR.
3. Add or update tests covering your change. For a visual change, include a screenshot of before and after.
4. Run `npm run type-check` and `npm test`; both must pass.
5. **Sign off every commit** (below).
6. Open a PR describing what it changes and why; link any related issue.
7. A maintainer reviews it.

## Sign your work: the Developer Certificate of Origin

We use the **Developer Certificate of Origin (DCO) 1.1**, as the Linux kernel and many other projects do, instead of a contributor licence agreement. There is no CLA to sign.

The DCO is a short statement, in the [DCO](DCO) file, that you wrote the contribution or otherwise have the right to submit it under the project's open-source licence. You agree to it by adding a `Signed-off-by` line to each commit message, with your real name and an email address you can be reached at:

```
Signed-off-by: Jane Smith <jane.smith@example.com>
```

Git adds the line for you with `-s`:

```bash
git commit -s -m "Keep the selection when the 3D view opens"
```

If you forgot, `git commit --amend -s` signs the last commit, and `git rebase --signoff main` signs every commit on your branch. A PR whose commits are not all signed off cannot be merged.

## Licence of contributions: inbound = outbound

Contributions are accepted under the same licence the project is distributed under: the **Apache License 2.0**. Section 5 of the licence says that any contribution you intentionally submit is under its terms unless you explicitly state otherwise, and the DCO sign-off records that you have the right to submit it. You keep the copyright in your contribution; you do not assign it to Delta Robotics.

Please do not submit code you copied from a project under a licence that is incompatible with Apache-2.0 (for example GPL or AGPL code), and say so in the PR when a change includes or adapts third-party code under a compatible licence, so its notice can be added to `NOTICE`.

## The name and logo

The code is yours to use, change and fork under Apache-2.0. The name "Protoboard", its logo and the "0" mark are trademarks of Delta Robotics, Inc., and the licence does not grant them. A fork you distribute needs its own name. [TRADEMARKS.md](TRADEMARKS.md) says what is fine and what needs permission.

## Style

- TypeScript, strict mode. Match the surrounding code; no formatter is enforced.
- The viewer stays domain-neutral: it knows UHD and the view contract, not Protoboard's types.
- Scrollbars are never the browser's default, and colours come from the theme tokens.

## Releasing

Maintainers only. A release is a commit of `main` tagged `v<version>`; nobody runs `npm publish` from a laptop or a branch.

1. In a pull request, set the version (`npm version <version> --no-git-tag-version`, which updates `package-lock.json` too) and move the entries under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) to a heading `## [<version>] — YYYY-MM-DD`.
2. Merge it, then tag the merged commit and push the tag: `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/release.yml` checks that the tag, `package.json` and the changelog agree, runs the type-check, the tests and the build, publishes the package to npmjs with provenance, and creates the GitHub release from the changelog's section.

`node .github/scripts/release.mjs version --tag v<version>`, `package` and `notes <version>` run the same checks locally.
