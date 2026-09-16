# Native Crates

Contributor map for Rust workspace members under `crates/`. They are implementation details behind `@zero2ai/natives` and its embedded shell; package consumers use JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` lists every crate under `crates/` explicitly in `workspace.members` — add new crates there. It also patches crates.io `brush-core` to the vendored copy.

## First-party crates

| Crate           | Path                                              | Role and consumers                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zero2ai-natives`    | [`crates/zero2ai-natives`](../crates/zero2ai-natives)       | Top-level N-API `cdylib`. It exposes the JS-visible API and depends on `zero2ai-ast`, `zero2ai-iso`, `zero2ai-shell`, `zero2ai-vcs`, `zero2ai-voice`, and `zero2ai-walker`.                    |
| `zero2ai-builtins`   | [`crates/zero2ai-builtins`](../crates/zero2ai-builtins)     | Every builtin the embedded shell installs: a patched fork of brush's POSIX/bash builtins, plus one module per in-process command-line utility (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `ps`, `top`, `kill`, the moreutils set, …). `src/host.rs` holds the `Utility` trait and the `Host` view of the shell (stdio, working directory, exported environment, cancellation) that the utilities run against. Ports of uutils coreutils/findutils/sed and jaq live here too; see the crate `LICENSE` for third-party notices. |
| `zero2ai-shell`      | [`crates/zero2ai-shell`](../crates/zero2ai-shell)           | Persistent embedded brush shell, command execution/minimization, process plumbing, filesystem walking, and in-process command integration used by `zero2ai-natives`. |
| `zero2ai-voice`      | [`crates/zero2ai-voice`](../crates/zero2ai-voice)           | Cross-platform microphone/playback and Opus/WebRTC support used by the `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` bindings.                          |
| `zero2ai-ast`        | [`crates/zero2ai-ast`](../crates/zero2ai-ast)               | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization support across the workspace grammar set.                           |
| `zero2ai-iso`        | [`crates/zero2ai-iso`](../crates/zero2ai-iso)               | Isolation backend implementations and diffing for APFS, Linux/Windows clone/reflink paths, overlayfs, ProjFS, and recursive copy fallback.                      |
| `zero2ai-walker`     | [`crates/zero2ai-walker`](../crates/zero2ai-walker)         | Parallel, cache-aware filesystem walker using ignore rules and globsets; shared by native grep/glob/workspace paths and shell commands.                         |
| `zero2ai-vcs`        | [`crates/zero2ai-vcs`](../crates/zero2ai-vcs)               | In-process version control: git on gitoxide (the git binary survives only for credential-bound network transfers and reftable repos) and Jujutsu on jj-lib; unified discovery and operations used by the `vcs*` native bindings. |

## Vendored workspace crates

| Group | Paths | Purpose |
| ----- | ----- | ------- |
| Brush | [`crates/vendor/brush-core`](../crates/vendor/brush-core) | Vendored shell engine consumed by `zero2ai-shell` and `zero2ai-builtins`. Its manifest retains upstream package metadata; a workspace patch selects this local fork. |

`zero2ai_builtins::utility_builtins()` and `zero2ai_builtins::process_builtins()` are the authoritative lists of the commands linked into the embedded shell; `zero2ai-shell` decides which of them to register. A directory being a workspace member does not by itself mean that `zero2ai-natives` exposes it as a JavaScript API.

## Boundary map

```text
@zero2ai/natives JS entrypoints
  -> zero2ai-natives (N-API conversion, platform bindings, task boundaries)
       -> zero2ai-ast / zero2ai-iso / zero2ai-vcs / zero2ai-voice / zero2ai-walker
       -> zero2ai-shell
            -> brush-core (parser, expansion, interpreter)
            -> zero2ai-builtins (bash builtins + utility builtins; host.rs: per-invocation I/O and cwd)
```

For the loader and JS boundary, see:

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

Subsystem details live in:

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## Documentation policy

These crates remain contributor-facing implementation details. Promote one to standalone user-facing documentation only when it gains a public API or executable consumed independently of `@zero2ai/natives`; see [`user-facing-packages.md`](./user-facing-packages.md).
