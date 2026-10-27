import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import * as tar from 'tar';
import {replay} from '../replay.js';

for (const [name, type, message] of [
  ['repository/link', 'SymbolicLink', /Unsupported archive entry/],
  ['repository/node_modules/link', 'SymbolicLink', /Unsupported archive entry/],
  ['repository/hard-link', 'Link', /Unsupported archive entry/],
  ['repository/../escape', 'File', /Unsafe archive path/],
]) {
  // Construct headers directly so this also exercises links on Windows without symlink privileges.
  const blocks = [];
  for (const [entryPath, entryType] of [['repository/valid.txt', 'File'], [name, type]]) {
    const header = new tar.Header({path: entryPath, type: entryType, size: 0, mode: 0o644,
      linkpath: entryType === 'File' ? '' : 'valid.txt'});
    header.encode();
    blocks.push(header.block);
  }
  const data = Buffer.concat([...blocks, Buffer.alloc(1024)]);
  const github = {rest: {repos: {downloadTarballArchive: async () => ({data})}}};
  await assert.rejects(replay({github, owner: 'Reviewable', repo: 'fixture', baseSha: 'base',
    plan: {lockfiles: {'yarn.lock': {}}}, expected: new Map()}), message);
  assert.deepEqual(await fs.readdir(os.tmpdir()), [], 'Replay left its temporary directory behind');
}
