import { createAsyncCache } from '../../utils/asyncCache.js';

export function createCatalog(query) {
  const cache = createAsyncCache();
  return ({ search, category, limit = 100, offset = 0 } = {}) => {
    const size = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 24)));
    const skip = Math.max(0, Math.min(100000, Math.trunc(Number(offset) || 0)));
    const term = String(search || '').trim().slice(0, 120);
    const group = String(category || '').trim().slice(0, 100);
    return cache.get(JSON.stringify([term, group, size, skip]), async () => {
      const params = [];
      const where = ['is_active'];
      if (term) {
        params.push(term.replace(/[\\%_]/g, '\\$&'));
        const n = params.length;
        where.push(`(name ILIKE '%' || $${n} || '%' OR technical_name ILIKE '%' || $${n} || '%'
          OR category::text ILIKE '%' || $${n} || '%'
          OR EXISTS (SELECT 1 FROM unnest(target_crops || target_diseases) target WHERE target ILIKE '%' || $${n} || '%'))`);
      }
      if (group) { params.push(group); where.push(`category = $${params.length}`); }
      params.push(size, skip);
      const { rows } = await query(`SELECT id, name, category, technical_name, uom, packing_size,
        mrp, image_key, recommended_dosage, application_frequency, target_crops, target_diseases
        FROM products WHERE ${where.join(' AND ')} ORDER BY name, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return rows;
    }, 30_000);
  };
}
