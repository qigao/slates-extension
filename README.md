# Slate Build for VS Code

**Slate Targets** in the Slate sidebar shows the targets from each workspace folder
that contains `slate.json`. The tree follows the module directories. Expand a
target to browse its sources, headers, and task files by directory for the
active preset and toolchain. Project files start at the nearest shared directory
with the target's manifest. Task outputs appear under **Generated** and can be
opened after the task creates them.
Click a file to open it, or click the target name to open its manifest.
Use the target's inline **Build**, **Test**, or **Run** action. Test appears for
declared host-runnable tests. Run appears for other host-runnable executables
and builds the selected target before starting it.

## Use the extension

1. Build or install [Slate](https://github.com/qigao/slates-build). Make that `slate` executable
   available on `PATH`, or set `slate.executable` in VS Code settings.
2. Install the extension VSIX using **Extensions → Install from VSIX…**.
3. Open a trusted workspace folder containing `slate.json`. Select the
   **Slate** icon in the Activity Bar to open **Slate Targets**.

Click the gear on a project row to **Generate Ninja Files** for its active
preset and toolchain. This runs `slate gen` and writes `build.ninja` and
`compile_commands.json` without compiling. Output appears in **Slate Build**.

For the Windows bootstrap built in `out/bootstrap`, this workspace setting
can point VS Code to the executable in this checkout.

```json
{
  "slate.executable": "${workspaceFolder}/out/bootstrap/slate.exe",
  "slate.compiler": "llvm-mingw"
}
```

Set `slate.preset`, `slate.platform`, `slate.compiler`, or
`slate.buildDirectory` as needed. Leaving a selector empty lets Slate pick
its value. The project row shows the resolved preset, target platform, and
compiler. Slate reads the project's `.env`. An MSVC preset can set `vsDevCmd`
to `"${envPath:VSDEVCMD_BAT}"` to initialize the developer environment from VS
Code. You can also start VS Code from the matching Visual Studio developer shell.

Run arguments can be supplied per target.

```json
{
  "slate.runArguments": {
    "my_tool": ["--input", "file with spaces.txt"]
  }
}
```

Build and Test stream logs and results to **Output → Slate Build**.
**Run Executable** builds the target if needed, then streams its output to
**Output → Slate Run**. Each new action resumes auto-scrolling. Use the Output
toolbar's scroll lock to pause it while reading earlier lines. The editor
theme highlights errors, warnings, and
results, including TinyTest's case statuses and summary counts. Compiler
diagnostics with source locations also appear in **Problems**.
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
npx --yes @vscode/vsce@4.1.1 package --no-dependencies --skip-license --out slate-vscode.vsix
```

To develop from source, open a VS Code Extension Development Host with
`code --extensionDevelopmentPath=<absolute-path-to-this-repository>` and a
Slate workspace. The extension has no runtime npm dependencies.
