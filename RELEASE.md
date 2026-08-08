# Release Process

This project uses [release-please](https://github.com/googleapis/release-please) to automate releases.

## How it works

1. **Make changes**: Commit your changes using [conventional commit messages](https://www.conventionalcommits.org/):
   - `feat: add new feature` (minor version bump)
   - `fix: resolve bug` (patch version bump)
   - `feat!: breaking change` or `fix!: breaking change` (major version bump)

2. **Release PR Creation**: When you push to `main`, release-please will:
   - Analyze your commits since the last release
   - Create or update a Release PR with:
     - Version bump in `package.json`
     - Updated `CHANGELOG.md`
     - Release notes

3. **Review and Merge**: Review the Release PR and merge it when ready

4. **Automatic Publication**: When the Release PR is merged:
   - A GitHub release is created
   - The package is automatically published to npm

## Configuration

The release-please configuration is minimal and defined in the GitHub workflow (`.github/workflows/cd-publish.yml`):
- **Release type**: `node` (for Node.js packages)
- **Package name**: Auto-detected from `package.json`
- **Changelog sections**: Uses release-please defaults (Features, Bug Fixes, etc.)

This simple configuration works well for most Node.js projects and avoids configuration file complexity.

## Publishing authentication (npm trusted publishing / OIDC)

The publish job authenticates to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) instead of a long-lived token: GitHub Actions mints a short-lived OIDC token (`permissions: id-token: write`) that npm exchanges for publish credentials. Provenance attestations are generated automatically — no `--provenance` flag, no `NODE_AUTH_TOKEN`.

One-time setup (npm package settings, requires npm CLI ≥ 11.5.1 in the workflow — Node 24 bundles it):

1. On npmjs.com → `hrserve` → Settings → **Trusted Publisher**, choose **GitHub Actions** and enter:
   - Organization or user: `sidorares`
   - Repository: `hrserve`
   - Workflow filename: `cd-publish.yml`
   - Environment: leave empty
2. Once a trusted-publisher release has gone through, delete the now-unused `NPM_TOKEN` repository secret and any npm automation tokens it belonged to.

## Troubleshooting

- If publishing fails due to existing version, check that the Release PR properly bumped the version
- The workflow includes version conflict detection to prevent publishing duplicate versions
- Check the GitHub Actions logs for detailed information about each step 