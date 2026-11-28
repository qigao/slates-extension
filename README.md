# Slate Build for VS Code

Browse, build, test, and run Slate targets from the VS Code sidebar.

## Quick start

1. Install [Slate Build from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=slates-build.slates-extension).
   For a manual install, get the [VSIX](https://github.com/qigao/slates-extension/releases/latest)
   and select **Extensions → Install from VSIX…**.
2. Install [the Slate CLI](https://github.com/qigao/slates-build), Ninja, and
   your project's compiler. Ensure `slate --version` works in a terminal, or
   set `slate.executable` to the full path of the CLI in VS Code settings.
3. Open the directory containing `slate.json` or a parent directory as a trusted workspace.
   Click **Slate** in the Activity Bar to open **Slate Targets**.
4. Expand a project and use **Select Preset** if needed. Next to a target, use
   **Build Target**, **Test Target**, or **Run Executable**.

Build and test logs appear in **Output → Slate Build**. Executable output
appears in **Output → Slate Run**.

## Browse projects and choose a preset

Projects follow their directories inside the workspace. For example,
`apps/fetch/slate.json` appears under **apps → fetch**. A directory containing
its own `slate.json` is a project node and can also contain nested projects.
Each project's **Targets** branch groups targets by their module directories.
In a multi-root workspace, projects stay under their owning workspace folder.

Each `slate.json` has its own target tree, preset, and build root, even when
two projects use the same target name. Expand a target to browse its sources,
headers, and task files. Project files start at the nearest shared directory
with the target's manifest. Task outputs appear under **Generated** and can be
opened after the task creates them. Click a target name to open its manifest.

Library targets loaded through `libraries` appear in each project that uses
them. Slate groups libraries outside the project root under `external`.
Saving a shared manifest in VS Code refreshes its projects.

The tree shows tests that the active preset and toolchain can admit, including
script tests. **Test** appears for host-runnable tests and **Run** for
host-runnable executables. Use a matching preset for targets gated by it.

Click the gear on a project row to **Generate Ninja Files** for its active
preset and toolchain. This runs `slate gen` and writes `build.ninja` and
`compile_commands.json` without compiling. Output appears in **Slate Build**.

To use a particular Slate installation, set `slate.executable` to the path of
the CLI in the archive's `bin/` directory on the workspace host.

```json
{
  "slate.executable": "C:/tools/slate/bin/slate.exe"
}
```

Click **Select Preset** next to the gear on the project row. The picker lists
presets from `slate.json` and its included files. Selecting a preset refreshes
the tree and applies it to Generate, Build, Test, and Run. The extension saves
the selection per Slate project. Choose **Use Configured Preset** to
return to the workspace setting or the project default.

Set `slate.preset`, `slate.platform`, `slate.compiler`, or
`slate.buildDirectory` as needed. Leaving a selector empty lets Slate pick
its value. The project row shows the resolved preset, target platform, and
compiler. Slate reads the project's `.env`. An MSVC preset can set `vsDevCmd`
to `"${envPath:VSDEVCMD_BAT}"` to initialize the developer environment from VS
Code. You can also start VS Code from the matching Visual Studio developer shell.

## Pass arguments to a target

Run arguments can be supplied per target.

```json
{
  "slate.runArguments": {
    "my_tool": ["--input", "default.txt"]
  }
}
```

Prefix a target with the project path relative to its workspace folder to
override its arguments. For `apps/fetch/slate.json`, this entry overrides the
unscoped `my_tool` arguments above.

```json
{
  "slate.runArguments": {
    "apps/fetch/my_tool": ["--input", "file with spaces.txt"]
  }
}
```

In path settings, `${workspaceFolder}` refers to the opened folder and
`${projectRoot}` refers to the selected Slate project. To run the repository's
[SDK walkthrough](https://qigao.github.io/slates-build/examples.html#export-and-consume-an-sdk),
install the SDK, expand **apps → consumer**, and run `stats-demo` with the
matching toolchain preset. That program needs no run arguments.

## Output and troubleshooting

Each new action resumes auto-scrolling. Use the Output toolbar's scroll lock
to pause it while reading earlier lines. The editor theme highlights errors,
warnings, and results, including TinyTest's case statuses and summary counts.
Compiler diagnostics with source locations also appear in **Problems**.
Use the progress notification to cancel an action. Run `slate run` from a
terminal for programs that need keyboard input. Use the view's refresh button
after changing files externally.
**Slate: Show Output** displays graph-loading diagnostics.

## Build a VSIX from this repository

Use a Slate CLI that supports `graph --format json` and `run`. The
[extension CI](.github/workflows/ci.yml) tests the graph consumer on Windows,
Linux x64 and ARM64, and macOS ARM64 before producing a single VSIX artifact.
To run the same checks and package the VSIX locally, use Node.js 24.

```sh
node --test
npx --yes @vscode/vsce@4.1.1 package --no-dependencies --out .
```

To develop from source, open a VS Code Extension Development Host with
`code --extensionDevelopmentPath=<absolute-path-to-this-repository>` and a
Slate workspace. The extension has no runtime npm dependencies.

## License

[Apache License 2.0](LICENSE).
