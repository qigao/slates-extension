'use strict';

const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { promisify } = require('node:util');
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

function projectSettings(folder) {
  const config = vscode.workspace.getConfiguration('slate', folder.uri);
  const root = folder.uri.fsPath;
  const expand = value => value.replaceAll('${workspaceFolder}', root);
  let program = expand(config.get('executable', 'slate'));
  if (program.includes('/') || program.includes('\\')) {
    program = path.resolve(root, program);
  }
  const selectors = ['--root', root];
  for (const [key, flag] of [
    ['preset', '--preset'],
    ['platform', '--platform'],
    ['compiler', '--compiler'],
    ['buildDirectory', '--build-dir'],
  ]) {
    const value = config.get(key, '');
    if (value) selectors.push(flag, expand(value));
  }
  return { program, selectors };
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
  const folders = new Map();
  for (const target of targets) {
    const parent = folderNode(project, folders, target.folder.split('/').filter(Boolean));
    const id = `${project.id}:target:${target.name}`;
    const node = { id, label: target.name, target, project, children: [] };
    addTargetFiles(node, project.folder.uri.fsPath, project.graph.buildDirectory);
    parent.children.push(node);
    project.targets.push(node);
  }
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
  return action === 'build' || (action === 'test' && node.target.test) ||
    (action === 'run' && node.target.runnable && !node.target.test);
}

class TargetTree {
  constructor(output) {
    this.output = output;
    this.projects = [];
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
      project.settings = projectSettings(folder);
      const { program, selectors } = project.settings;
      const { stdout } = await execute(program, ['graph', '--format', 'json', ...selectors], {
        cwd: folder.uri.fsPath,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      project.graph = readGraph(stdout);
      for (const input of project.graph.inputs) project.inputs.add(fileKey(input));
      buildTree(project, project.graph.targets);
    } catch (error) {
      return this.projectError(project, error);
    }
    return project;
  }

  projectError(project, error) {
    const detail = error.stderr?.trim() || error.message;
    this.output.appendLine(`[${project.label}] ${detail}`);
    project.children.push({ id: `${project.id}:error`, label: 'Unable to load Slate targets', error: detail });
    return project;
  }

  async refresh() {
    if (!vscode.workspace.isTrusted) return;
    const revision = ++this.revision;
    const projects = await Promise.all((vscode.workspace.workspaceFolders || []).map(folder => this.readProject(folder)));
    if (revision !== this.revision) return;
    this.projects = projects.filter(Boolean);
    this.changed.fire();
  }

  getChildren(node) {
    if (!node) return this.projects;
    return (node.children || []).slice().sort((left, right) =>
      Number(Boolean(left.target || left.file)) - Number(Boolean(right.target || right.file)) ||
      left.label.localeCompare(right.label));
  }

  getTreeItem(node) {
    const state = node.children?.length
      ? node.folder ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, state);
    item.id = node.id;
    if (node.target) {
      const { kind, manifest, runnable, test } = node.target;
      item.contextValue = test ? 'slateTargetTest' : runnable ? 'slateTargetRun' : 'slateTargetBuild';
      item.iconPath = new vscode.ThemeIcon(test ? 'beaker' : runnable ? 'file-code' : 'package');
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
      if (node.graph) {
        item.contextValue = 'slateProject';
        item.description = `${node.graph.preset} · ${node.graph.platform} · ${node.graph.compiler}`;
        item.tooltip = node.graph.buildDirectory;
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
  if (node.target) args.push('--target', node.target.name);
  const title = `${actions[action]} ${node.label}`;
  const cwd = folder.uri.fsPath;
  if (action === 'run') {
    const runArguments = vscode.workspace.getConfiguration('slate', folder.uri).get('runArguments', {});
    const values = Object.hasOwn(runArguments, node.target.name) ? runArguments[node.target.name] : [];
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
  const tree = new TargetTree(output);
  const active = new Map();
  const diagnostics = new Map();
  const view = vscode.window.createTreeView('slate.targets', { treeDataProvider: tree });
  const refresh = () => vscode.window.withProgress({ location: { viewId: 'slate.targets' } }, () => tree.refresh());
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
    vscode.commands.registerCommand('slate.showOutput', () => output.show()),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('slate')) void refresh();
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) return;
      const key = fileKey(document.uri.fsPath);
      if (key === fileKey(path.join(folder.uri.fsPath, 'slate.json')) ||
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
