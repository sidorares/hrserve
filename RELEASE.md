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

## Troubleshooting

- If publishing fails due to existing version, check that the Release PR properly bumped the version
- The workflow includes version conflict detection to prevent publishing duplicate versions
- Check the GitHub Actions logs for detailed information about each step 