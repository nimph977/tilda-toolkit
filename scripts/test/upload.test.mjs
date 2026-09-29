import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateFile, toDataUrl, imageSpecFromUpload, upload, ALLOWED_TYPES } from '../upload.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('validateFile: тип и размер проверяются до обращения к CDN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tilda-upload-'));
  try {
    writeFileSync(join(dir, 'a.png'), PNG);
    writeFileSync(join(dir, 'b.exe'), PNG);
    writeFileSync(join(dir, 'empty.jpg'), Buffer.alloc(0));
    const f = validateFile(join(dir, 'a.png'));
    assert.deepEqual([f.name, f.bytes, f.mime], ['a.png', PNG.length, 'image/png']);
    assert.throws(() => validateFile(join(dir, 'b.exe')), (e) => e.code === 'FILE_TYPE_REJECTED');
    assert.throws(() => validateFile(join(dir, 'empty.jpg')), (e) => e.code === 'FILE_SIZE_REJECTED');
    assert.throws(() => validateFile(join(dir, 'a.png'), { maxBytes: 10 }), (e) => e.code === 'FILE_SIZE_REJECTED');
    assert.throws(() => validateFile(join(dir, 'нет.png')), (e) => e.code === 'FILE_NOT_FOUND');
    assert.ok(Object.keys(ALLOWED_TYPES).includes('.jpg'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toDataUrl и imageSpecFromUpload', () => {
  const url = toDataUrl(PNG, 'image/png');
  assert.ok(url.startsWith('data:image/png;base64,iVBOR'));
  assert.deepEqual(imageSpecFromUpload({ cdnUrl: 'https://static.tildacdn.com/tild1/x.png', width: 240, height: '160' }), { img: 'https://static.tildacdn.com/tild1/x.png', filewidth: '240', fileheight: '160' });
  assert.throws(() => imageSpecFromUpload({ cdnUrl: 'https://evil/x.png', width: 1, height: 1 }), /неожиданный адрес/);
  assert.throws(() => imageSpecFromUpload({ cdnUrl: 'https://static.tildacdn.com/t/x.png' }), /размеры не пришли/);
});

test('upload: Node читает файл, слой получает data:-адрес и имя, результат — image-spec', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tilda-upload-'));
  try {
    writeFileSync(join(dir, 'photo.png'), PNG);
    const calls = [];
    const driver = { async call(fn, args) { calls.push({ fn, args }); return { cdnUrl: 'https://static.tildacdn.com/tild9/photo.png', width: 1, height: 1, uuid: 'tild9' }; } };
    const r = await upload(driver, join(dir, 'photo.png'));
    assert.equal(calls[0].fn, 'uploadImageFromDataUrl');
    assert.ok(calls[0].args[0].startsWith('data:image/png;base64,'));
    assert.equal(calls[0].args[1], 'photo.png');
    assert.deepEqual(r.image, { img: 'https://static.tildacdn.com/tild9/photo.png', filewidth: '1', fileheight: '1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
