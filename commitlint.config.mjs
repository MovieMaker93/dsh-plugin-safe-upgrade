// Conventional Commits (https://www.conventionalcommits.org), checked in CI.
// Bodies and footers may hold long lines: release-please and Dependabot
// commits carry changelog links and URLs.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [1, 'always', 100],
  },
}
