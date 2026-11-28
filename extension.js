'use strict';

const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { promisify, TextDecoder } = require('node:util');
const vscode = require('vscode');

const execute = promisify(execFile);
const actions = {
  gen: 'Generate',
  build: 'Build',
  test: 'Test',
  run: 'Run',
};

function fileKey(file) {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function projectSettings(folder, selectedPreset) {
  const config = vscode.workspace.getConfiguration('slate', folder.uri);
  const root = folder.uri.fsPath;
  const workspace = folder.workspaceFolder?.uri.fsPath ?? root;
  const expand = value => value.replaceAll('${workspaceFolder}', workspace).replaceAll('${projectRoot}', root);
  let program = expand(config.get('executable', 'slate'));
  if (program.includes('/') || program.includes('\\')) {
    program = path.resolve(workspace, program);
  }
  const preset = expand(selectedPreset ?? config.get('preset', ''));
  const selectors = ['--root', root];
  for (const [key, flag] of [
    ['preset', '--preset'],
    ['platform', '--platform'],
    ['compiler', '--compiler'],
    ['buildDirectory', '--build-dir'],
  ]) {
    const value = key === 'preset' ? preset : expand(config.get(key, ''));
    if (value) selectors.push(flag, value);
  }
  return { program, selectors, preset };
}

function parsePresetFragment(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const uncommented = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    token => token.startsWith('"') ? token : ' ');
  return JSON.parse(uncommented.replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g,
    token => token.startsWith('"') ? token : ''));
}

async function readPresets(folder) {
  const root = folder.uri.fsPath;
  const presets = new Map();
  const loading = new Set();
  const loaded = new Set();
  let defaultPreset;
  async function load(file) {
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Preset include escapes the project: ' + file);
    }
    const key = fileKey(file);
    if (loading.has(key)) throw new Error('Preset include cycle: ' + file);
    if (loaded.has(key)) return;
    loading.add(key);
    const fragment = parsePresetFragment(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
    const includes = fragment.include ?? [];
    if (!Array.isArray(includes) || !includes.every(entry => typeof entry === 'string')) {
      throw new Error('Expected a list of preset includes in ' + file);
    }
    for (const entry of includes) await load(path.resolve(path.dirname(file), entry));
    if (fragment.defaultPreset !== undefined) {
      if (defaultPreset !== undefined) throw new Error('Duplicate defaultPreset in ' + file);
      defaultPreset = fragment.defaultPreset;
    }
    for (const [name, preset] of Object.entries(fragment.presets ?? {})) {
      if (presets.has(name)) throw new Error('Duplicate preset in ' + file + ': ' + name);
      presets.set(name, preset);
    }
    loading.delete(key);
    loaded.add(key);
  }
  await load(path.join(root, 'slate.json'));

  function configFor(name) {
    const visited = new Set();
    let config;
    for (let current = name; current !== undefined;) {
      const preset = presets.get(current);
      if (!preset || visited.has(current) || visited.size >= 128) return undefined;
      visited.add(current);
      if (config === undefined) config = preset.config;
      current = preset.inherits;
    }
    return typeof config === 'string' && config !== '.' && config !== '..' && /^[\w.-]+$/.test(config)
      ? config : undefined;
  }
  const choices = [...presets.keys()].sort((a, b) => a.localeCompare(b))
    .map(name => ({ name, config: configFor(name) })).filter(preset => preset.config);
  return { defaultPreset, choices };
}

function presetStateKey(projectId) {
  return 'slate.selectedPreset:' + projectId;
}

async function selectPreset(tree, refresh, item) {
  if (!vscode.workspace.isTrusted) return;
  const project = item
    ? tree.projects.find(candidate => candidate.id === item.id)
    : tree.projects.length === 1 ? tree.projects[0] : (await vscode.window.showQuickPick(
      tree.projects.map(project => ({ label: project.label, description: project.folder.uri.fsPath, project })),
      { placeHolder: 'Select a Slate project' }))?.project;
  if (!project) return;
  const { defaultPreset, choices } = await readPresets(project.folder);
  const configured = projectSettings(project.folder).preset || defaultPreset;
  const state = tree.workspaceState;
  const key = presetStateKey(project.id);
  const override = state.get(key);
  const items = [
    { label: 'Use Configured Preset', description: [configured, override === undefined && 'Active'].filter(Boolean).join(' · ') },
    ...choices.map(({ name, config }) => ({
      label: name,
      description: [config !== name && config, name === override && 'Active'].filter(Boolean).join(' · '),
      preset: name,
    })),
  ];
  const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select the Slate preset for ' + project.label });
  if (!selected || selected.preset === override) return;
  await state.update(key, selected.preset);
  await refresh();
}

function childFolder(parent, folders, id, label) {
  let node = folders.get(id);
  if (!node) {
    node = { id, label, children: [] };
    parent.children.push(node);
    folders.set(id, node);
  }
  return node;
}

function folderNode(root, folders, segments) {
  let parent = root;
  let id = `${root.id}:folder:`;
  for (const segment of segments) {
    id += `/${segment}`;
    parent = childFolder(parent, folders, id, segment);
  }
  return parent;
}

function containsPath(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function addTargetFiles(node, workspace, buildDirectory) {
  const { target } = node;
  const outputs = new Set(target.taskOutputs ?? []);
  const files = new Set([...(target.sources ?? []), ...(target.headers ?? []),
    ...(target.taskInputs ?? []), ...outputs]);
  const separateBuildDirectory = !containsPath(buildDirectory, workspace);
  const generated = file => containsPath(buildDirectory, file) &&
    (outputs.has(file) || separateBuildDirectory);
  const moduleDirectory = path.dirname(target.manifest);
  let sourceRoot = containsPath(workspace, moduleDirectory) ? moduleDirectory : workspace;
  for (const file of files) {
    if (!generated(file) && containsPath(workspace, file)) {
      while (!containsPath(sourceRoot, file)) sourceRoot = path.dirname(sourceRoot);
    }
  }

  const folders = new Map();
  for (const file of files) {
    const directory = path.dirname(path.normalize(file));
    let folder;
    if (generated(file)) {
      const group = childFolder(node, folders, `${node.id}:generated`, 'Generated');
      folder = folderNode(group, folders, path.relative(buildDirectory, directory).split(path.sep).filter(Boolean));
    } else if (containsPath(workspace, file)) {
      folder = folderNode(node, folders, path.relative(sourceRoot, directory).split(path.sep).filter(Boolean));
    } else {
      const group = childFolder(node, folders, `${node.id}:external`, 'External');
      folder = folderNode(group, folders, [directory]);
    }
    folder.children.push({ id: `${node.id}:file:${file}`, label: path.basename(file), file });
  }
}

function buildTree(project, targets) {
  if (!targets.length) return;
  const branch = { id: `${project.id}:targets`, label: 'Targets', children: [] };
  project.children.push(branch);
  const folders = new Map();
  for (const target of targets) {
    const parent = folderNode(branch, folders, target.folder.split('/').filter(Boolean));
    const id = `${project.id}:target:${target.name}`;
    const node = { id, label: target.name, target, project, children: [] };
    addTargetFiles(node, project.folder.uri.fsPath, project.graph.buildDirectory);
    parent.children.push(node);
    project.targets.push(node);
  }
}

function buildWorkspaceTree(projects) {
  const workspaces = new Map();
  for (const project of projects) {
    const owner = project.folder.workspaceFolder ?? project.folder;
    const workspaceId = owner.uri.toString();
    let workspace = workspaces.get(workspaceId);
    if (!workspace) {
      workspace = { id: `${workspaceId}:workspace`, label: owner.name, workspace: true, children: [], projects: [] };
      workspaces.set(workspaceId, workspace);
    }
    workspace.projects.push(project);
  }

  const multipleWorkspaces = (vscode.workspace?.workspaceFolders?.length ?? workspaces.size) > 1;
  const roots = [];
  for (const workspace of workspaces.values()) {
    const directories = new Map();
    const projects = workspace.projects.slice().sort((left, right) =>
      (left.folder.projectPath ?? '').split('/').filter(Boolean).length -
      (right.folder.projectPath ?? '').split('/').filter(Boolean).length);
    const root = projects.find(project => !project.folder.projectPath) ?? workspace;
    for (const project of projects) {
      if (project === root) continue;
      const segments = (project.folder.projectPath ?? '').split('/').filter(Boolean);
      project.treeLabel = segments.pop();
      const parent = folderNode(root, directories, segments);
      parent.children.push(project);
      directories.set(`${root.id}:folder:/${project.folder.projectPath}`, project);
    }
    if (root === workspace && !multipleWorkspaces) roots.push(...workspace.children);
    else roots.push(root);
  }
  return roots;
}

function readGraph(stdout) {
  const graph = JSON.parse(stdout);
  if (!graph || !Array.isArray(graph.inputs) || !graph.inputs.every(file => typeof file === 'string') ||
      !Array.isArray(graph.targets) || !graph.targets.every(target => target &&
        ['name', 'folder', 'manifest', 'kind'].every(key => typeof target[key] === 'string') &&
        ['sources', 'headers', 'taskInputs', 'taskOutputs'].every(key => target[key] === undefined ||
          (Array.isArray(target[key]) && target[key].every(file => typeof file === 'string'))) &&
        typeof target.runnable === 'boolean' && typeof target.test === 'boolean') ||
      !['preset', 'platform', 'compiler', 'buildDirectory'].every(key => typeof graph[key] === 'string')) {
    throw new Error('Unexpected target graph returned by Slate. Use the Slate executable built with this extension.');
  }
  return graph;
}

function canExecute(action, node) {
  if (action === 'build') return true;
  const { kind, runnable, test } = node.target;
  const executable = kind === 'executable' || kind === 'exec';
  if (action === 'test') return runnable && test && (executable || kind === 'header_only');
  return action === 'run' && executable && runnable && !test;
}

async function findProjectFolders() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const projects = new Map(folders.map(folder => [fileKey(folder.uri.fsPath),
    { ...folder, workspaceFolder: folder, projectPath: '' }]));
  const matches = await Promise.all(folders.map(async workspaceFolder => {
    const manifests = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, '**/slate.json'),
      '**/{.git,node_modules,out,build,target}/**');
    return manifests.map(manifest => ({ manifest, workspaceFolder }));
  }));
  for (const { manifest, workspaceFolder } of matches.flat()) {
    const directory = path.dirname(manifest.fsPath);
    const key = fileKey(directory);
    const owner = vscode.workspace.getWorkspaceFolder(manifest) ?? workspaceFolder;
    const projectPath = path.relative(owner.uri.fsPath, directory).split(path.sep).join('/');
    if (!projects.has(key)) {
      projects.set(key, { uri: vscode.Uri.file(directory), name: projectPath, workspaceFolder: owner, projectPath });
    }
  }
  return [...projects.values()];
}

class TargetTree {
  constructor(output, workspaceState) {
    this.output = output;
    this.workspaceState = workspaceState;
    this.projects = [];
    this.roots = [];
    this.revision = 0;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  async readProject(folder) {
    const id = folder.uri.toString();
    const project = {
      id,
      label: folder.name,
      folder,
      children: [],
      targets: [],
      inputs: new Set(['slate.json', '.env'].map(file => fileKey(path.join(folder.uri.fsPath, file)))),
    };
    try {
      const manifest = vscode.Uri.joinPath(folder.uri, 'slate.json');
      const stat = await vscode.workspace.fs.stat(manifest);
      if (!(stat.type & vscode.FileType.File)) return undefined;
    } catch (error) {
      if (error.code === 'FileNotFound') return undefined;
      return this.projectError(project, error);
    }
    try {
      project.settings = projectSettings(folder, this.workspaceState.get(presetStateKey(id)));
      const { program, selectors } = project.settings;
      const queryGraph = async flags => {
        const { stdout } = await execute(program, ['graph', '--format', 'json', ...flags, ...selectors], {
          cwd: folder.uri.fsPath,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        return readGraph(stdout);
      };
      let testError;
      try {
        project.graph = await queryGraph(['--tests']);
        project.includesTests = true;
      } catch (error) {
        testError = error;
        project.graph = await queryGraph([]);
      }
      for (const input of project.graph.inputs) project.inputs.add(fileKey(input));
      buildTree(project, project.graph.targets);
      if (testError) this.projectError(project, testError, 'Unable to load Slate tests');
    } catch (error) {
      return this.projectError(project, error);
    }
    return project;
  }

  projectError(project, error, label = 'Unable to load Slate targets') {
    const detail = error.stderr?.trim() || error.message;
    this.output.appendLine(`[${project.label}] ${detail}`);
    project.children.push({ id: `${project.id}:error`, label, error: detail });
    return project;
  }

  async refresh() {
    if (!vscode.workspace.isTrusted) return;
    const revision = ++this.revision;
    const folders = await findProjectFolders();
    if (revision !== this.revision) return;
    const projects = await Promise.all(folders.map(folder => this.readProject(folder)));
    if (revision !== this.revision) return;
    this.projects = projects.filter(Boolean);
    this.roots = buildWorkspaceTree(this.projects);
    this.changed.fire();
  }

  getChildren(node) {
    return (node ? node.children || [] : this.roots).slice().sort((left, right) =>
      Number(Boolean(left.target || left.file)) - Number(Boolean(right.target || right.file)) ||
      (left.treeLabel ?? left.label).localeCompare(right.treeLabel ?? right.label));
  }

  getTreeItem(node) {
    const state = node.children?.length
      ? node.workspace || (node.folder && !node.folder.projectPath)
        ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.treeLabel ?? node.label, state);
    item.id = node.id;
    if (node.target) {
      const { kind, manifest } = node.target;
      const testable = canExecute('test', node);
      const runnable = canExecute('run', node);
      item.contextValue = testable ? 'slateTargetTest' : runnable ? 'slateTargetRun' : 'slateTargetBuild';
      item.iconPath = new vscode.ThemeIcon(testable ? 'beaker' : runnable ? 'file-code' : 'package');
      item.description = kind;
      item.tooltip = manifest;
      item.command = { command: 'vscode.open', title: 'Open module manifest', arguments: [vscode.Uri.file(manifest)] };
    } else if (node.file) {
      item.resourceUri = vscode.Uri.file(node.file);
      item.tooltip = node.file;
      item.command = { command: 'vscode.open', title: 'Open file', arguments: [item.resourceUri] };
    } else if (node.error) {
      item.iconPath = new vscode.ThemeIcon('error');
      item.tooltip = node.error;
      item.command = { command: 'slate.showOutput', title: 'Show Slate output' };
    } else {
      item.iconPath = vscode.ThemeIcon.Folder;
      if (node.folder) item.contextValue = node.graph ? 'slateProject' : 'slateProjectUnavailable';
      if (node.graph) {
        item.description = `${node.graph.preset} · ${node.graph.platform} · ${node.graph.compiler}`;
        item.tooltip = node.graph.buildDirectory;
      } else if (node.settings?.preset) {
        item.description = node.settings.preset;
      }
    }
    return item;
  }

  dispose() {
    this.revision++;
    this.changed.dispose();
  }
}

function recordProblem(line, directory, problems) {
  const match = /^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning):\s*(.+)$/.exec(line) ??
    /^(.+?)\((\d+)(?:,\s*(\d+))?\)\s*:\s*(fatal error|error|warning)(?:\s+[A-Z]+\d+)?:\s*(.+)$/.exec(line);
  if (!match) return;
  const [, file, row, column = '1', severity, message] = match;
  const uri = vscode.Uri.file(path.resolve(directory, file.trim()));
  const position = new vscode.Position(Math.max(0, Number(row) - 1), Math.max(0, Number(column) - 1));
  const diagnostic = new vscode.Diagnostic(new vscode.Range(position, position), message,
    severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
  diagnostic.source = 'Slate';
  const entry = problems.get(uri.toString());
  if (entry) entry[1].push(diagnostic);
  else problems.set(uri.toString(), [uri, [diagnostic]]);
}

function streamAction(program, args, cwd, output, label, signal, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd, signal, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SLATE_CONSOLE: '1', NO_COLOR: '1', CLICOLOR_FORCE: '0' },
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8').on('data', chunk => output.append(chunk));
      if (onLine) createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine);
    }
    let error;
    child.on('error', failure => { error = failure; });
    child.once('close', (code, stopSignal) => {
      if (signal.aborted && code !== 0) {
        output.appendLine(`[Slate] ${label} cancelled.`);
      } else if (error) {
        output.appendLine(`[Slate] ${error.message}`);
        return reject(error);
      } else if (code !== 0) {
        return reject(new Error(stopSignal ? `Process stopped (${stopSignal}).` : `Process exited with code ${code}.`));
      }
      resolve(code);
    });
  });
}

async function executeAction(tree, active, output, diagnostics, action, item) {
  if (!vscode.workspace.isTrusted) return;
  const generate = action === 'gen';
  const candidates = generate ? tree.projects.filter(project => project.graph) :
    tree.projects.flatMap(project => project.targets).filter(node => canExecute(action, node));
  let node = item ? candidates.find(candidate => candidate.id === item.id) : undefined;
  if (!item) {
    const selection = await vscode.window.showQuickPick(candidates.map(candidate => ({
      label: candidate.label,
      description: generate ? candidate.folder.uri.fsPath :
        [candidate.project.label, candidate.target.folder].filter(Boolean).join(' / '),
      node: candidate,
    })), { placeHolder: generate ? 'Select a Slate project to generate' : `Select a Slate target to ${action}` });
    node = selection?.node;
  }
  if (!node) return;
  const { folder, settings, graph } = node.project ?? node;
  const buildDirectory = fileKey(graph.buildDirectory);
  const running = active.get(buildDirectory);
  if (running) {
    throw new Error(`Slate task '${running.title}' is still active in ${graph.buildDirectory}.`);
  }
  const args = [action, ...settings.selectors];
  if (action === 'build' && node.project.includesTests) args.push('--tests');
  if (node.target) args.push('--target', node.target.name);
  const title = `${actions[action]} ${node.label}`;
  const cwd = folder.uri.fsPath;
  if (action === 'run') {
    const runArguments = vscode.workspace.getConfiguration('slate', folder.uri).get('runArguments', {});
    const target = node.target.name;
    const scopedTarget = folder.projectPath ? `${folder.projectPath}/${target}` : target;
    const key = Object.hasOwn(runArguments, scopedTarget) ? scopedTarget : target;
    const values = Object.hasOwn(runArguments, key) ? runArguments[key] : [];
    if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) {
      throw new Error(`slate.runArguments for ${node.target.name} must be an array of strings.`);
    }
    if (values.length) args.push('--', ...values);
  }
  let collection;
  if (!generate) {
    collection = diagnostics.get(buildDirectory);
    if (!collection) {
      collection = vscode.languages.createDiagnosticCollection('Slate');
      diagnostics.set(buildDirectory, collection);
    }
    collection.clear();
  }
  const problems = new Map();
  const controller = new AbortController();
  const launch = { title, cancel: () => controller.abort() };
  active.set(buildDirectory, launch);
  try {
    output.show(true);
    launch.done = vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: `Slate ${title}`, cancellable: true,
    }, async (_, token) => {
      const cancellation = token.onCancellationRequested(launch.cancel);
      try {
        // The Output view keeps its scroll lock when switching channels.
        await vscode.commands.executeCommand('setContext', 'outputView.scrollLock', false);
        if (generate) output.appendLine(`[Slate] ${title}`);
        const code = await streamAction(settings.program, args, cwd, output, actions[action], controller.signal,
          collection && (line => recordProblem(line, graph.buildDirectory, problems)));
        if (generate && code === 0) output.appendLine('[Slate] Generate succeeded (exit 0)');
      } finally {
        cancellation.dispose();
        if (!controller.signal.aborted) collection?.set([...problems.values()]);
      }
    });
    await launch.done;
  } finally {
    active.delete(buildDirectory);
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Slate');
  const buildOutput = vscode.window.createOutputChannel('Slate Build', 'slate-log');
  const runOutput = vscode.window.createOutputChannel('Slate Run', 'slate-log');
  const tree = new TargetTree(output, context.workspaceState);
  const active = new Map();
  const diagnostics = new Map();
  const view = vscode.window.createTreeView('slate.targets', { treeDataProvider: tree });
  const refresh = () => vscode.window.withProgress({ location: { viewId: 'slate.targets' } }, async () => {
    try {
      await tree.refresh();
    } catch (error) {
      output.appendLine(`Unable to discover Slate projects: ${error.message}`);
    }
  });
  const manifests = vscode.workspace.createFileSystemWatcher('**/slate.json', false, true, false);
  context.subscriptions.push(output, tree, view, { dispose() {
    const pending = [...active.values()];
    for (const launch of pending) launch.cancel();
    void Promise.allSettled(pending.map(launch => launch.done)).then(() => {
      buildOutput.dispose();
      runOutput.dispose();
      for (const collection of diagnostics.values()) collection.dispose();
    });
  } },
    vscode.commands.registerCommand('slate.refreshTargets', refresh),
    vscode.commands.registerCommand('slate.selectPreset', async item => {
      try {
        await selectPreset(tree, refresh, item);
      } catch (error) {
        const message = 'Slate Select Preset: ' + error.message;
        output.appendLine(message);
        void vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand('slate.showOutput', () => output.show()),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh), manifests,
    manifests.onDidCreate(refresh), manifests.onDidDelete(refresh),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('slate')) void refresh();
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      const key = fileKey(document.uri.fsPath);
      if ((path.basename(key) === 'slate.json' && vscode.workspace.getWorkspaceFolder(document.uri)) ||
          tree.projects.some(project => project.inputs.has(key))) void refresh();
    }));
  for (const [action, label] of Object.entries(actions)) {
    const command = action === 'gen' ? 'slate.generate' : `slate.${action}Target`;
    context.subscriptions.push(vscode.commands.registerCommand(command, async item => {
      try {
        await executeAction(tree, active, action === 'run' ? runOutput : buildOutput, diagnostics, action, item);
      } catch (error) {
        const message = `Slate ${label}: ${error.message}`;
        output.appendLine(message);
        void vscode.window.showErrorMessage(message);
      }
    }));
  }
  void refresh();
}

exports.activate = activate;
