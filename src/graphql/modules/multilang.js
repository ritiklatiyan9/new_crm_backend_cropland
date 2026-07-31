// GraphQL module: Multi-Language Management (PRD §9.2).
// Manage supported languages and the UI translation-string catalog.

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity } from '../helpers.js';

export const langTypeDefs = /* GraphQL */ `
  type Language {
    code: String!
    name: String!
    nativeName: String
    isActive: Boolean!
    isDefault: Boolean!
    sortOrder: Int!
  }

  type TranslationValue { langCode: String!, value: String! }

  type TranslationKey {
    key: String!
    values: [TranslationValue!]!
    translatedCount: Int!
  }

  type LanguageStats { languages: Int!, activeLanguages: Int!, keys: Int!, coverage: Float! }

  extend type Query {
    languages(activeOnly: Boolean): [Language!]!
    translationKeys(search: String): [TranslationKey!]!
    languageStats: LanguageStats!
  }

  extend type Mutation {
    setLanguageActive(code: String!, isActive: Boolean!): Language!
    setDefaultLanguage(code: String!): Language!
    addTranslationKey(key: String!): Boolean!
    upsertTranslation(strKey: String!, langCode: String!, value: String!): Boolean!
    deleteTranslationKey(key: String!): Boolean!
  }
`;

const mapLang = (r) => ({
  code: r.code, name: r.name, nativeName: r.native_name,
  isActive: r.is_active, isDefault: r.is_default, sortOrder: r.sort_order,
});

export function langResolvers() {
  return {
    Query: {
      languages: async (_p, { activeOnly }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM app_languages WHERE ($1::bool IS NULL OR is_active = $1) ORDER BY sort_order`,
          [activeOnly ?? null],
        );
        return rows.map(mapLang);
      },
      translationKeys: async (_p, { search }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const keys = await query(
          `SELECT DISTINCT str_key FROM translations
           WHERE ($1::text IS NULL OR str_key ILIKE '%' || $1 || '%')
           ORDER BY str_key`,
          [search ?? null],
        );
        const vals = await query('SELECT str_key, lang_code, value FROM translations');
        const byKey = new Map();
        for (const r of vals.rows) {
          if (!byKey.has(r.str_key)) byKey.set(r.str_key, []);
          byKey.get(r.str_key).push({ langCode: r.lang_code, value: r.value });
        }
        return keys.rows.map((k) => {
          const values = byKey.get(k.str_key) ?? [];
          return { key: k.str_key, values, translatedCount: values.filter((v) => v.value.trim() !== '').length };
        });
      },
      languageStats: async (_p, _a, ctx) => {
        assertAuth(ctx);
        const l = await query('SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE is_active)::int active FROM app_languages');
        const k = await query('SELECT COUNT(DISTINCT str_key)::int keys FROM translations');
        const cov = await query(
          `SELECT CASE WHEN COUNT(*) = 0 THEN 0
                  ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE value <> '') / COUNT(*), 1) END coverage
           FROM translations t JOIN app_languages a ON a.code = t.lang_code WHERE a.is_active`,
        );
        return {
          languages: l.rows[0].total, activeLanguages: l.rows[0].active,
          keys: k.rows[0].keys, coverage: Number(cov.rows[0].coverage),
        };
      },
    },

    Mutation: {
      setLanguageActive: async (_p, { code, isActive }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query('UPDATE app_languages SET is_active = $2 WHERE code = $1 RETURNING *', [code, isActive]);
        if (!rows[0]) throw httpError('Language not found', 404);
        await logActivity(actor.sub, 'SET_LANGUAGE_ACTIVE', 'language', null, { code, isActive });
        return mapLang(rows[0]);
      },
      setDefaultLanguage: async (_p, { code }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        await query('UPDATE app_languages SET is_default = (code = $1)', [code]);
        const { rows } = await query('SELECT * FROM app_languages WHERE code = $1', [code]);
        if (!rows[0]) throw httpError('Language not found', 404);
        await logActivity(actor.sub, 'SET_DEFAULT_LANGUAGE', 'language', null, { code });
        return mapLang(rows[0]);
      },
      addTranslationKey: async (_p, { key }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const k = key.trim();
        if (!k) throw httpError('Key is required', 400);
        const exists = await query('SELECT 1 FROM translations WHERE str_key = $1 LIMIT 1', [k]);
        if (exists.rows[0]) throw httpError('That key already exists', 409);
        // Create a blank row for the default language so the key appears.
        const def = await query("SELECT code FROM app_languages WHERE is_default LIMIT 1");
        const lang = def.rows[0]?.code ?? 'en';
        await query('INSERT INTO translations (str_key, lang_code, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [k, lang, '']);
        await logActivity(actor.sub, 'ADD_TRANSLATION_KEY', 'translation', null, { key: k });
        return true;
      },
      upsertTranslation: async (_p, { strKey, langCode, value }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        await query(
          `INSERT INTO translations (str_key, lang_code, value) VALUES ($1,$2,$3)
           ON CONFLICT (str_key, lang_code) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [strKey, langCode, value],
        );
        await logActivity(actor.sub, 'UPSERT_TRANSLATION', 'translation', null, { strKey, langCode });
        return true;
      },
      deleteTranslationKey: async (_p, { key }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM translations WHERE str_key = $1', [key]);
        if (!rowCount) throw httpError('Key not found', 404);
        await logActivity(actor.sub, 'DELETE_TRANSLATION_KEY', 'translation', null, { key });
        return true;
      },
    },
  };
}
