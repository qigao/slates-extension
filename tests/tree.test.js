'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const vm = require('node:vm');

const executable = 'slate';
const diagnosticCollection = { clear() {}, set() {} };
const workspace = path.resolve('project with spaces');
const buildDirectory = path.join(workspace, 'out', 'debug');
const target = (name, folder, files) => ({
  name, folder, manifest: path.join(workspace, folder, 'module.json'),
  kind: 'static', runnable: false, test: false, ...files,
});
const uri = fsPath => ({ fsPath, toString: () => fsPath });

test('loads the Slate graph and supports target actions and project preset selection', async () => {
  const source = path.join(workspace, 'media', 'src', 'playback.c');
  const script = path.join(workspace, 'unicode', 'data', 'Download.cmake');
  const output = path.join(buildDirectory, 'unicode', 'UnicodeData.txt');
  const graph = {
    preset: 'debug', platform: 'native', compiler: 'clang', buildDirectory, inputs: [],
    targets: [
      target('playback', 'media/tests', { sources: [source] }),
      target('unicode', 'unicode', { taskInputs: [script], taskOutputs: [output] }),
      target('legacy', '', {}),
      target('frame_test', 'media/tests', { kind: 'executable', runnable: true, test: true }),
      target('frame_data', 'media/tests/fixtures', { kind: 'header_only', runnable: true }),
      target('frame_static', 'media/tests/fixtures', { kind: 'static', runnable: true }),
      target('frame_plugin', 'media/tests/fixtures', { kind: 'shared', runnable: true }),
      target('frame_script', 'media/tests/scripts', { kind: 'header_only', runnable: true, test: true }),
      target('playback_example', 'media/examples', { kind: 'executable', runnable: true }),
    ],
  };
  const workspaceFolder = { name: 'project', uri: uri(workspace) };
  const manifests = new Map([
    ['slate.json', JSON.stringify({
      include: ['slates/presets.json', 'slates/base.json'],
      defaultPreset: 'debug',
      presets: { tests: { inherits: 'release', config: 'tests' } },
    })],
    [path.join('slates', 'presets.json'), [
      '{',
      '  // presets may use JSON comments and trailing commas',
      '  "include": ["base.json",],',
      '  "presets": {',
      '    "debug": { "inherits": "base", "config": "debug" },',
      '    "release": { "inherits": "base", "config": "release" },',
      '    "debug-msvc": { "inherits": "debug", "vsDevCmd": "missing" },',
      '  },',
      '}',
    ].join('\n')],
    [path.join('slates', 'base.json'), '\uFEFF{"presets":{"base":{"buildDir":"out//build,}"}}}'],
  ]);
  let pickLabel;
  let pickerItems;
  const vscode = {
    EventEmitter: class { fire() {} },
    ProgressLocation: { Notification: 1 },
    commands: { executeCommand: async () => {} },
    languages: { createDiagnosticCollection: () => diagnosticCollection },
    window: {
      withProgress: (_options, task) => task(undefined, {
        onCancellationRequested: () => ({ dispose() {} }),
      }),
      showQuickPick: async items => {
        pickerItems = Array.from(items, item => item.label);
        return items.find(item => item.label === pickLabel);
      },
    },
    FileType: { File: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItem: class {
      constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); }
    },
    ThemeIcon: class { static Folder = 'folder'; },
    RelativePattern: class {
      constructor(base, pattern) { Object.assign(this, { base, pattern }); }
    },
    Uri: { file: uri, joinPath: (root, file) => uri(path.join(root.fsPath, file)) },
    workspace: {
      isTrusted: true,
      workspaceFolders: [workspaceFolder],
      findFiles: async () => [],
      getWorkspaceFolder: () => workspaceFolder,
      fs: {
        stat: async () => ({ type: 1 }),
        readFile: async ({ fsPath }) => Buffer.from(manifests.get(path.relative(workspace, fsPath))),
      },
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
  };
  const execFile = () => assert.fail('Expected the promisified execFile API');
  let testsUnavailable = false;
  let expectedPreset;
  execFile[promisify.custom] = async (program, args, options) => {
    assert.equal(program, executable);
    const tests = args.includes('--tests');
    const selection = expectedPreset ? ['--preset', expectedPreset] : [];
    assert.deepEqual([...args], [
      'graph', '--format', 'json', ...(tests ? ['--tests'] : []), '--root', workspace, ...selection,
    ]);
    if (expectedPreset === 'debug-msvc') throw new Error('Missing MSVC setup');
    if (testsUnavailable && tests) throw new Error('Missing test dependency');
    if (!tests) {
      assert.equal(testsUnavailable, true);
      return { stdout: JSON.stringify({ ...graph, targets: graph.targets.filter(target => !target.test) }) };
    }
    assert.equal(options.cwd, workspace);
    return { stdout: JSON.stringify({ ...graph, preset: expectedPreset ?? graph.preset }) };
  };
  const exports = {};
  const requires = { vscode, 'node:child_process': { execFile } };
  const code = readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const launched = [];
  vm.runInNewContext(code + `
    exports.TargetTree = TargetTree;
    exports.executeAction = executeAction;
    exports.selectPreset = selectPreset;
    streamAction = async (_program, args) => { launched.push([...args]); return 0; };
  `, {
    exports, process, launched, AbortController, require: name => requires[name] ?? require(name),
  });
  const messages = [];
  const values = new Map();
  const workspaceState = {
    get: key => values.get(key),
    update: async (key, value) => values.set(key, value),
  };
  const tree = new exports.TargetTree({ appendLine: message => messages.push(message) }, workspaceState);
  const project = await tree.readProject(workspaceFolder);
  const [
    playback, unicode, legacy, frameTest, frameData, frameStatic, framePlugin, frameScript, example,
  ] = project.targets;
  const child = (node, label) => tree.getChildren(node).find(item => item.label === label);

  assert.deepEqual(Array.from(tree.getChildren(playback), item => item.label), ['src']);
  assert.equal(tree.getTreeItem(child(child(playback, 'src'), 'playback.c')).command.arguments[0].fsPath, source);
  assert.equal(child(child(unicode, 'data'), 'Download.cmake').file, script);
  assert.equal(child(child(child(unicode, 'Generated'), 'unicode'), 'UnicodeData.txt').file, output);
  assert.equal(tree.getTreeItem(legacy).collapsibleState, 0);
  assert.equal(tree.getTreeItem(frameTest).contextValue, 'slateTargetTest');
  const testFolder = child(child(child(project, 'Targets'), 'media'), 'tests');
  assert.equal(testFolder.children.includes(frameTest), true);
  assert.deepEqual(Array.from(tree.getChildren(child(testFolder, 'fixtures'))), [frameData, framePlugin, frameStatic]);
  assert.equal(child(child(testFolder, 'scripts'), 'frame_script'), frameScript);
  for (const fixture of [frameData, frameStatic, framePlugin]) {
    assert.equal(tree.getTreeItem(fixture).contextValue, 'slateTargetBuild');
  }
  assert.equal(tree.getTreeItem(frameScript).contextValue, 'slateTargetTest');
  assert.equal(tree.getTreeItem(example).contextValue, 'slateTargetRun');
  assert.deepEqual(messages, []);
  tree.projects = [project];
  const actionOutput = { show() {}, appendLine() {} };
  const diagnostics = new Map();
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'build', frameTest);
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'build', playback);
  assert.deepEqual(Array.from(launched[0]), ['build', '--root', workspace, '--tests', '--target', 'frame_test']);
  assert.deepEqual(Array.from(launched[1]), ['build', '--root', workspace, '--tests', '--target', 'playback']);

  for (const target of [frameData, frameStatic, framePlugin, frameScript]) {
    await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'run', target);
  }
  assert.equal(launched.length, 2);
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'test', frameScript);
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'run', example);
  assert.deepEqual(Array.from(launched[2]), ['test', '--root', workspace, '--target', 'frame_script']);
  assert.deepEqual(Array.from(launched[3]), ['run', '--root', workspace, '--target', 'playback_example']);

  testsUnavailable = true;
  const fallback = await tree.readProject({ name: 'project', uri: uri(workspace) });
  assert.deepEqual(Array.from(fallback.targets, node => node.target.name),
    ['playback', 'unicode', 'legacy', 'frame_data', 'frame_static', 'frame_plugin', 'playback_example']);
  assert.equal(child(fallback, 'Unable to load Slate tests').error, 'Missing test dependency');
  tree.projects = [fallback];
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'build', fallback.targets[0]);
  assert.deepEqual(Array.from(launched[4]), ['build', '--root', workspace, '--target', 'playback']);

  testsUnavailable = false;
  const refresh = () => tree.refresh();
  expectedPreset = pickLabel = 'tests';
  await exports.selectPreset(tree, refresh, fallback);
  assert.deepEqual(pickerItems, ['Use Configured Preset', 'debug', 'debug-msvc', 'release', 'tests']);
  assert.equal(tree.getTreeItem(tree.projects[0]).description, 'tests · native · clang');
  const selectedArgs = ['--root', workspace, '--preset', 'tests'];
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'gen', tree.projects[0]);
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'build', frameTest);
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'test', frameTest);
  await exports.executeAction(tree, new Map(), actionOutput, diagnostics, 'run', example);
  assert.deepEqual(Array.from(launched[5]), ['gen', ...selectedArgs]);
  assert.deepEqual(Array.from(launched[6]), ['build', ...selectedArgs, '--tests', '--target', 'frame_test']);
  assert.deepEqual(Array.from(launched[7]), ['test', ...selectedArgs, '--target', 'frame_test']);
  assert.deepEqual(Array.from(launched[8]), ['run', ...selectedArgs, '--target', 'playback_example']);

  const reloaded = new exports.TargetTree({ appendLine() {} }, workspaceState);
  assert.equal((await reloaded.readProject(workspaceFolder)).graph.preset, 'tests');

  expectedPreset = pickLabel = 'debug-msvc';
  await exports.selectPreset(tree, refresh);
  const failedProject = tree.projects[0];
  assert.equal(tree.getTreeItem(failedProject).contextValue, 'slateProjectUnavailable');
  assert.equal(tree.getTreeItem(failedProject).description, 'debug-msvc');
  expectedPreset = undefined;
  pickLabel = 'Use Configured Preset';
  await exports.selectPreset(tree, refresh, failedProject);
  assert.equal(tree.getTreeItem(tree.projects[0]).description, 'debug · native · clang');

  const nestedRoots = ['fetch', 'health-check'].map(name => path.join(workspace, 'apps', name));
  const sharedManifest = path.join(workspace, 'libs', 'http.json');
  vscode.workspace.findFiles = async pattern => {
    assert.equal(pattern.base, workspaceFolder);
    assert.equal(pattern.pattern, '**/slate.json');
    return [workspace, ...nestedRoots, nestedRoots[0]].map(root => uri(path.join(root, 'slate.json')));
  };
  vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'runArguments' ? {
    'apps/fetch/hello': ['tcp://127.0.0.1:8000', '127.0.0.1:8000', '/hello.c'],
    hello: ['argument with spaces'],
  } : fallback });
  execFile[promisify.custom] = async (_program, args, { cwd }) => {
    assert.deepEqual([...args], ['graph', '--format', 'json', '--tests', '--root', cwd]);
    return { stdout: JSON.stringify({ ...graph,
      buildDirectory: path.join(cwd, 'out'), inputs: [sharedManifest],
      targets: [
        target('hello', '', { kind: 'exec', runnable: true, manifest: path.join(cwd, 'module.json') }),
        target('salts_cnet', 'external', { kind: 'prebuilt', manifest: sharedManifest }),
      ],
    }) };
  };
  // Recreate the consumer so promisify sees the new project graphs.
  vm.runInNewContext(code + `
    exports.TargetTree = TargetTree;
    exports.executeAction = executeAction;
    streamAction = async (_program, args) => { launched.push([...args]); return 0; };
  `, { exports, process, launched, AbortController, require: name => requires[name] ?? require(name) });
  const nestedTree = new exports.TargetTree({ appendLine() {} }, workspaceState);
  await nestedTree.refresh();
  assert.deepEqual(Array.from(nestedTree.projects, node => node.label), ['project', 'apps/fetch', 'apps/health-check']);
  assert.deepEqual(Array.from(nestedTree.getChildren()), [nestedTree.projects[0]]);
  assert.equal(nestedTree.getTreeItem(nestedTree.projects[0]).collapsibleState, 2);
  const apps = child(nestedTree.projects[0], 'apps');
  assert.deepEqual(Array.from(nestedTree.getChildren(apps), node => nestedTree.getTreeItem(node).label),
    ['fetch', 'health-check']);
  assert.equal(nestedTree.getTreeItem(apps).contextValue, undefined);
  for (const [index, root] of nestedRoots.entries()) {
    const node = nestedTree.projects[index + 1];
    assert.equal(nestedTree.getTreeItem(node).collapsibleState, 1);
    const [hello, cnet] = node.targets;
    assert.equal(nestedTree.getTreeItem(hello).contextValue, 'slateTargetRun');
    assert.equal(nestedTree.getTreeItem(cnet).command.arguments[0].fsPath, sharedManifest);
    assert.equal(child(child(child(node, 'Targets'), 'external'), 'salts_cnet'), cnet);
    assert.equal(node.inputs.size, 3);
    await exports.executeAction(nestedTree, new Map(), actionOutput, diagnostics, 'run', hello);
    const values = index === 0 ? ['tcp://127.0.0.1:8000', '127.0.0.1:8000', '/hello.c'] : ['argument with spaces'];
    assert.deepEqual(Array.from(launched.at(-1)), ['run', '--root', root, '--target', 'hello', '--', ...values]);
  }
  const directoryId = apps.id;
  await nestedTree.refresh();
  assert.equal(child(nestedTree.projects[0], 'apps').id, directoryId);
  assert.equal(nestedTree.getChildren(child(nestedTree.projects[0], 'apps')).length, 2);
});

test('keeps project ancestors, directory branches and workspace roots distinct', () => {
  const exports = {};
  const vscode = {};
  const code = readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  vm.runInNewContext(code + '\nexports.buildWorkspaceTree = buildWorkspaceTree;', {
    exports, process, require: name => name === 'vscode' ? vscode : require(name),
  });
  const owner = { name: 'workspace', uri: uri(workspace) };
  const project = (owner, projectPath) => ({
    id: path.join(owner.uri.fsPath, projectPath), label: projectPath || owner.name,
    folder: { uri: uri(path.join(owner.uri.fsPath, projectPath)), workspaceFolder: owner, projectPath },
    children: [{ label: 'Targets', children: [] }],
  });
  const parent = project(owner, 'apps');
  const client = project(owner, 'apps/client');
  const demo = project(owner, 'apps/client/examples/demo');
  const library = project(owner, 'libs/common');
  const roots = exports.buildWorkspaceTree([demo, library, client, parent]);
  assert.equal(roots.length, 2);
  assert.equal(roots[0], parent);
  assert.equal(parent.children[1], client);
  assert.equal(client.children[1].label, 'examples');
  assert.equal(client.children[1].children[0], demo);
  assert.equal(roots[1].label, 'libs');
  assert.equal(roots[1].children[0], library);
  assert.equal(demo.treeLabel, 'demo');

  const otherOwner = { name: 'other', uri: uri(path.resolve('another workspace')) };
  const first = project(owner, 'apps/client');
  const second = project(otherOwner, 'apps/client');
  const workspaces = exports.buildWorkspaceTree([first, second]);
  assert.deepEqual(Array.from(workspaces, node => node.label), ['workspace', 'other']);
  assert.equal(workspaces[0].children[0].children[0], first);
  assert.equal(workspaces[1].children[0].children[0], second);
  assert.notEqual(workspaces[0].children[0].id, workspaces[1].children[0].id);

  vscode.workspace = { workspaceFolders: [owner, otherOwner] };
  const only = project(owner, 'apps/client');
  const partial = exports.buildWorkspaceTree([only]);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].label, 'workspace');
  assert.equal(partial[0].children[0].children[0], only);
});
