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
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    TreeItem: class {
      constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); }
    },
    ThemeIcon: class { static Folder = 'folder'; },
    Uri: { file: uri, joinPath: (root, file) => uri(path.join(root.fsPath, file)) },
    workspace: {
      isTrusted: true,
      workspaceFolders: [workspaceFolder],
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
  const testFolder = child(child(project, 'media'), 'tests');
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
});
