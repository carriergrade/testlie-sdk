# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-21

### Fixed

- The `testlie` command is kept when the package is published with npm 11 (its `bin` path no
  longer starts with `./`). 0.1.0 was tagged but never published.

## [0.1.0] - 2026-10-21

First public release: `npx testlie` runs the CLI from `@testlie/sdk` 0.1.0.
