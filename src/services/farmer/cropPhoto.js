// Inline camera photos go straight to vision. Never store base64 blobs in the DB.
// The compressed payload stays below Fastify's 1 MB JSON request limit.
export function cropPhotoInput(value) {
  if (!value?.startsWith('data:')) return { analysisImage: value, storedImage: value ?? null };
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('Use a clear JPG, PNG or WebP crop photo.');
  if (Buffer.byteLength(match[2], 'base64') > 700 * 1024) {
    throw new Error('Crop photo is too large. Please take a new photo.');
  }
  return { analysisImage: value, storedImage: null };
}
