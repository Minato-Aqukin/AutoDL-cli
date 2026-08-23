# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/Minato-Aqukin/AutoDL-cli/security/advisories/new)
rather than in a public issue.

## If you leaked your AutoDL token

Rotate it immediately in the AutoDL console (设置 → 开发者 Token), then run
`autodl logout` and `autodl login` with the new one. A developer token can create
instances, which costs money — treat it like a payment credential.

## How this tool handles your credentials

- The token is stored at `~/.config/autodl-cli/config.json` with `0600` permissions,
  in a directory created with `0700`. It is never written anywhere else.
- Debug output (`--verbose`) redacts the token to `abcd…wxyz`. It is never logged in full.
- Instance root passwords are redacted by default in `autodl info` and in every MCP
  response. Showing them requires `--show-password` / `reveal_password: true`.
- `AUTODL_TOKEN` takes precedence over the config file, so CI can pass a token without
  ever writing it to disk.

## Known, deliberate trade-offs

**SSH host key checking is disabled** (`StrictHostKeyChecking=no`,
`UserKnownHostsFile=/dev/null`). AutoDL's proxy hosts recycle addresses across instances,
so strict checking would produce a host key warning on essentially every new rental and
train users to click through them. This means the SSH connection is not protected against
an active man-in-the-middle on the path to AutoDL's proxy. If that's unacceptable for your
threat model, use `autodl ssh <id> --print` to get the connection details and dial in with
your own hardened SSH configuration.

## Scope

This is an unofficial client. Vulnerabilities in AutoDL's own platform or API should be
reported to AutoDL directly, not here.
