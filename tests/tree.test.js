'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const vm = require('node:vm');

const executable = 'slate';
const workspace = path.resolve('project with spaces');
const buildDirectory = path.join(workspace, 'out', 'debug');
const target = (name, folder, files) => ({
  name, folder, manifest: path.join(workspace, folder, 'module.json'),
  kind: 'static', runnable: false, test: false, ...files,
});
const uri = fsPath => ({ fsPath, toString: () => fsPath });

test('loads the Slate graph and displays project directories and task files', async () => {
  const source = path.join(workspace, 'media', 'src', 'playback.c');
  const script = path.join(workspace, 'unicode', 'data', 'Download.cmake');
  const output = path.join(buildDirectory, 'unicode', 'UnicodeData.txt');
  const graph = {
    preset: 'debug', platform: 'native', compiler: 'clang', buildDirectory, inputs: [],
    targets: [
      target('playback', 'media/tests', { sources: [source] }),
      target('unicode', 'unicode', { taskInputs: [script], taskOutputs: [output] }),
      target('legacy', '', {}),
    ],
  };
  const vscode = {
    EventEmitter: class {},
    FileType: { File: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    TreeItem: class {
      constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); }
    },
    ThemeIcon: class { static Folder = 'folder'; },
    Uri: { file: uri, joinPath: (root, file) => uri(path.join(root.fsPath, file)) },
    workspace: {
      fs: { stat: async () => ({ type: 1 }) },
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
  };
  const execFile = () => assert.fail('Expected the promisified execFile API');
  execFile[promisify.custom] = async (program, args, options) => {
    assert.equal(program, executable);
    assert.deepEqual([...args], ['graph', '--format', 'json', '--root', workspace]);
    assert.equal(options.cwd, workspace);
    return { stdout: JSON.stringify(graph) };
  };
  const exports = {};
  const requires = { vscode, 'node:child_process': { execFile } };
  const code = readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  vm.runInNewContext(code + '\nexports.TargetTree = TargetTree;', {
    exports, process, require: name => requires[name] ?? require(name),
  });
  const tree = new exports.TargetTree({ appendLine: message => assert.fail(message) });
  const project = await tree.readProject({ name: 'project', uri: uri(workspace) });
  const [playback, unicode, legacy] = project.targets;
  const child = (node, label) => tree.getChildren(node).find(item => item.label === label);

  assert.deepEqual(Array.from(tree.getChildren(playback), item => item.label), ['src']);
  assert.equal(tree.getTreeItem(child(child(playback, 'src'), 'playback.c')).command.arguments[0].fsPath, source);
  assert.equal(child(child(unicode, 'data'), 'Download.cmake').file, script);
  assert.equal(child(child(child(unicode, 'Generated'), 'unicode'), 'UnicodeData.txt').file, output);
  assert.equal(tree.getTreeItem(legacy).collapsibleState, 0);
});
