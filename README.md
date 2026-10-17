# Dim

**The editor for understanding code faster.**

Your agent writes code faster than you can read it. Dim lifts it up a level: every file opens as a plain summary and a diagram of how it fits together, so you see what the code does before you read how.

Dim is a fork of [VS Code](https://github.com/microsoft/vscode) with Claude built in. Your extensions, keybindings and themes come with you.

**[Download Dim](https://lewibs.github.io/dim/)** · [Releases](https://github.com/lewibs/dim_code/releases) · [Issues](https://github.com/lewibs/dim_code/issues)

## What it does

- **See what a file does before how.** Every file opens on a short summary of its purpose and a diagram of its shape: which classes exist and how they connect, which messages go where, or which states it moves through. The code is one click away.
- **Move through code by its design.** Every box, method and arrow in a diagram is a link. Click one to zoom into that piece, or follow it to the file where it lives.
- **Zoom out to the whole system.** Ask a question that spans many files, like "what happens when someone clicks Buy?", and Claude draws the flow across every component involved, then opens the files at the lines that matter.
- **Know what your tests prove.** Open a test file and Dim lists every test in plain words: what it checks, what it feeds in, what it expects and what it mocks.
- **Review the shape of a change, not just the diff.** Changes from the agent, a shell command or your own typing all wait for review. Changed nodes light up in the diagrams, and Accept All stages the whole change set.
- **Diagrams stay current.** A file's diagram is redrawn only when its contents change, so the picture never drifts from the code.

## Requirements

Dim runs Claude Code under the hood, so you need the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and signed in. Diagrams are generated with Claude Haiku through that CLI, at a few cents per changed file.

Summaries and diagrams are saved in a `.dim/` folder inside your project. Nothing is uploaded except the code sent to Claude.

## Install

Get the installer for your OS from the [landing page](https://lewibs.github.io/dim/) or the [latest release](https://github.com/lewibs/dim_code/releases/latest):

| OS | File |
| --- | --- |
| macOS (Apple silicon) | `Dim-darwin-arm64.zip` |
| Windows | `Dim-win32-x64-setup.exe` |
| Linux | `Dim-linux-x64.tar.gz` or `Dim-linux-x64.deb` |

The builds are not code signed yet:

- **macOS:** move `Dim.app` to Applications, then run `xattr -cr /Applications/Dim.app`.
- **Windows:** when SmartScreen appears, choose **More info → Run anyway**.

## Build from source

Use the Node version in [`.nvmrc`](.nvmrc).

```sh
npm ci
npm run watch          # keep running; rebuilds on change
./scripts/code.sh      # Linux and macOS
.\scripts\code.bat     # Windows
```

See VS Code's [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute) guide for platform prerequisites.

## Releasing

The [`Dim Release`](.github/workflows/dim-release.yml) workflow builds macOS, Windows and Linux installers and attaches them to a GitHub Release whenever a `v*` tag is pushed:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The release is published once all three builds succeed. The landing page links to `releases/latest/download/<file>`, so keep the asset names unchanged.

## License

Dim is based on [Code - OSS](https://github.com/microsoft/vscode) and is released under the [MIT license](LICENSE.txt).
