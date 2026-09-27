---
"@minato-aqukin/autodl-cli": minor
---

Add dashboard SSH login with automatic instance-password authentication and terminal restoration, plus the `ssh --auto-auth` command option. Preserve ordinary OpenSSH mode for custom configuration and forwarding.

Add local/remote file browsing, direct path entry, multi-selection, directory creation, moves and confirmed permanent deletion. Add a persistent serial transfer queue with byte progress, conflict choices, cancellation, manual restart recovery and bounded transport reconnects. Transfers preserve existing targets using same-directory partial files, validate resumed prefixes, and support one-way size/mtime or SHA-256 synchronization without deleting destination-only files. Skip and report symbolic links and special files. Require explicit billing confirmation before powering on an instance and prevent concurrent processes from restoring the same queue.

Reuse one SFTP connection for all file-view browsing operations with transparent reconnect and release on exit; read directory entries with bundled readdir attributes instead of per-file stat round trips. Open the file view instantly with async power gating. Add `files ls/mkdir/mv/rm` and `queue add/ls/resume/cancel/resolve` CLI commands sharing the dashboard queue records.
