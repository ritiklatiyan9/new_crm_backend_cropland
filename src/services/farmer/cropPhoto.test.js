import test from 'node:test';
import assert from 'node:assert/strict';
import { cropPhotoInput } from './cropPhoto.js';

test('camera photos reach vision without storing binary data in diagnosis history', () => {
  const image = 'data:image/jpeg;base64,dGVzdA==';
  assert.deepEqual(cropPhotoInput(image), { analysisImage: image, storedImage: null });
  assert.deepEqual(cropPhotoInput('uploads/leaf.jpg'), { analysisImage: 'uploads/leaf.jpg', storedImage: 'uploads/leaf.jpg' });
  assert.deepEqual(cropPhotoInput(null), { analysisImage: null, storedImage: null });
});

test('camera input rejects unsupported formats and oversized payloads', () => {
  assert.throws(() => cropPhotoInput('data:text/html;base64,dGVzdA=='), /JPG/);
  assert.throws(() => cropPhotoInput(`data:image/jpeg;base64,${Buffer.alloc(701 * 1024).toString('base64')}`), /too large/);
});
