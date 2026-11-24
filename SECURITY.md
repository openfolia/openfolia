# Security policy

## Reporting a vulnerability

**Please don't report a vulnerability in a public issue, pull request or discussion.**

Report it privately through GitHub's private vulnerability reporting: on the repository's
**Security** tab, choose **Report a vulnerability**. Only the maintainers see the report, and it
becomes a draft security advisory where we can talk it through with you, fix it in a private
fork and credit you when the advisory is published.

If you can't use GitHub, write to `info@openfolia.com`.

A useful report says:

- what is affected (the component, such as the API, the editor or the PDF renderer, and the
  version or commit);
- how to reproduce it, step by step, with a minimal example if you have one;
- what an attacker gains (for example reading content they may not read, acting as another user,
  writing to Git, running code through a template);
- whether it is already known or exploited, as far as you know.

## What happens next

- We acknowledge the report within 5 working days.
- We assess it and tell you within 10 working days whether we accept it as a vulnerability, and
  how severe we think it is.
- We fix accepted vulnerabilities as fast as their severity calls for, and keep you informed.
- Once a fix is released, we publish a security advisory (with a CVE where one applies) and credit
  you, unless you'd rather not be named. The release's notes (the changelog) list the fix under
  **Security** with its severity and a link to the advisory, never how to exploit it.

Please give us a reasonable time to release a fix before you disclose the vulnerability publicly;
we will agree a date with you, by default within 90 days of the report.

## Supported versions

Security fixes go into the latest release, as a new patch release, and into `main`. Older
releases get them only when this section says so. While OpenFolia is at 0.0.x, upgrade to the
latest release to get a fix: the [changelog](https://docs.openfolia.com/changelog) lists them.

| Version                                                                          | Security fixes |
| -------------------------------------------------------------------------------- | -------------- |
| the latest release ([releases](https://github.com/openfolia/openfolia/releases)) | yes            |
| `main`                                                                           | yes            |
| any earlier release or commit                                                    | no             |

## Scope

In scope: the code in this repository (the API, the MCP server, the editor and the packages) as
it is meant to be deployed, in its default configuration. The `compose.yaml` at the root is for
local development only and binds to `127.0.0.1`.

Out of scope: a deployment's own configuration choices that this documentation warns against (for
example the shared API token or demo mode on a server reachable from outside), vulnerabilities in
third-party dependencies without a way to exploit them through this project (report those
upstream), and denial of service by sheer request volume.
