// Shared helpers for GraphQL resolver modules.

import { query } from '../db/index.js';
import { getRequestIp } from '../utils/requestContext.js';

/** Build an Error carrying an HTTP status code (surfaced by Mercurius). */
export function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** Best-effort audit log; never blocks the primary operation. */
export async function logActivity(actorId, action, entity, entityId, metadata = {}) {
  try {
    // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1 -> 127.0.0.1) for a clean inet value.
    let ip = getRequestIp();
    if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);
    await query(
      `INSERT INTO activity_logs (user_id, action, entity, entity_id, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5::inet, $6)`,
      [actorId ?? null, action, entity, entityId ?? null, ip ?? null, JSON.stringify(metadata)],
    );
  } catch {
    /* swallow */
  }
}

/** Normalise a DB DATE/timestamp to an ISO yyyy-mm-dd string. */
export function isoDate(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/** Coerce numeric/“null” DB values to a JS number or null. */
export function num(v) {
  return v == null ? null : Number(v);
}

// ── Human-readable errors ─────────────────────────────────────
// Raw Postgres / GraphQL coercion messages are translated here (called from the
// Mercurius errorFormatter in app.js) so forms show "SKU "X" already exists"
// instead of 'duplicate key value violates unique constraint "products_sku_key"'.

const WORDS = {
  sku: 'SKU', gst: 'GST', gstin: 'GSTIN', hsn: 'HSN', pan: 'PAN', mrp: 'MRP', uom: 'UOM',
  irn: 'IRN', ifsc: 'IFSC', upi: 'UPI', po: 'PO', grn: 'GRN', msme: 'MSME', id: 'ID',
  otp: 'OTP', igst: 'IGST', cgst: 'CGST', sgst: 'SGST', tds: 'TDS', tcs: 'TCS', no: 'number', qty: 'quantity',
};

/** "distributor_id" → "Distributor", "gstPercent" → "GST percent", "invoice_no" → "Invoice number". */
export function fieldLabel(name) {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.]+/)
    .filter(Boolean);
  if (words.length > 1 && words.at(-1) === 'id') words.pop();
  const s = words.map((w) => WORDS[w] ?? w).join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const clip = (v) => (String(v).length > 60 ? `${String(v).slice(0, 57)}...` : String(v));

// Find the (first) input variable whose key/value explains a bad DB value, so the
// message can name the form field: {input:{lines:[{productId:''}]}} → "Product (line 1)".
function findField(vars, test, key = null, line = null) {
  if (Array.isArray(vars)) {
    for (let i = 0; i < vars.length; i++) {
      const hit = findField(vars[i], test, key, i);
      if (hit) return hit;
    }
  } else if (vars && typeof vars === 'object') {
    for (const [k, v] of Object.entries(vars)) {
      const hit = findField(v, test, k, line);
      if (hit) return hit;
    }
  } else if (key != null && test(key, vars)) {
    return fieldLabel(key) + (line != null ? ` (line ${line + 1})` : '');
  }
  return null;
}

// "lower(email::text)" → "email"
const keyColumns = (cols) => cols.split(',').map((c) => c.replace(/::[\w ]+/g, '').replace(/^.*\(/, '').replace(/\).*$/, '').trim());

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

/**
 * Translate an error thrown by a resolver into `{ message, code }` for the client,
 * or return null to keep it unchanged (deliberate httpError/validation messages).
 * Pure: `variables` (the request's GraphQL variables) is only used to name the field.
 */
export function friendlyError(err, { isProd = false, variables = null } = {}) {
  if (!err || typeof err !== 'object' || err.statusCode) return null;
  const sqlState = typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null;
  const msg = String(err.message ?? '');
  const bad = (message) => ({ message, code: 'BAD_USER_INPUT' });

  if (!sqlState) {
    if (CONNECTION_CODES.has(err.code) || /Connection terminated|timeout exceeded when trying to connect/i.test(msg)) {
      return { message: 'Database is temporarily unavailable. Please try again in a moment.', code: 'SERVICE_UNAVAILABLE' };
    }
    if (err instanceof RangeError && /Invalid time value/.test(msg)) return bad('Invalid date.');
    if (isProd && (err instanceof TypeError || err instanceof ReferenceError)) {
      return { message: 'Something went wrong on the server. Please try again.', code: 'INTERNAL_SERVER_ERROR' };
    }
    return null;
  }

  const detail = String(err.detail ?? '');
  const table = err.table ?? '';
  switch (sqlState) {
    case '23505': {
      const m = detail.match(/Key \((.+?)\)=\((.*)\) already exists/);
      if (m) {
        const cols = keyColumns(m[1]);
        if (cols.length === 1) return { message: `${fieldLabel(cols[0])} "${clip(m[2])}" already exists.`, code: 'CONFLICT' };
        return { message: `A record with the same ${cols.map(fieldLabel).join(', ')} already exists.`, code: 'CONFLICT' };
      }
      return { message: 'This record already exists.', code: 'CONFLICT' };
    }
    case '23502': {
      const col = err.column ?? msg.match(/column "(\w+)"/)?.[1];
      return bad(col ? `${fieldLabel(col)} is required.` : 'A required field is missing.');
    }
    case '23503': {
      let m = detail.match(/Key \((.+?)\)=\(.*\) is not present in table "(\w+)"/);
      if (m) return bad(`The selected ${fieldLabel(keyColumns(m[1])[0])} does not exist (it may have been deleted).`);
      m = detail.match(/is still referenced from table "(\w+)"/);
      if (m) return { message: `This record is used in ${m[1].replace(/_/g, ' ')} and cannot be deleted.`, code: 'CONFLICT' };
      return bad('A linked record is missing or still in use.');
    }
    case '23514': {
      const c = String(err.constraint ?? '');
      const col = table && c.startsWith(`${table}_`) && c.endsWith('_check') ? c.slice(table.length + 1, -6) : '';
      if (!col) return bad('Some values are not valid together. Please review the form.');
      // ponytail: every column CHECK in database.sql today is "> 0"; other checks get the generic wording.
      if (/(quantity|qty|amount|points)$/.test(col)) return bad(`${fieldLabel(col)} must be greater than 0.`);
      return bad(`${fieldLabel(col)} has an invalid value.`);
    }
    case '22P02': {
      let m = msg.match(/invalid input value for enum (\w+): "(.*)"/);
      if (m) return bad(`"${clip(m[2])}" is not a valid ${fieldLabel(m[1]).toLowerCase()}.`);
      m = msg.match(/invalid input syntax for type (\w[\w ]*): "(.*)"/);
      if (!m) return bad('One of the values has an invalid format.');
      const [, type, value] = m;
      if (type === 'uuid') {
        const field = findField(variables, (k, v) => v === value && /id$/i.test(k));
        if (value === '') return bad(field ? `${field} is required.` : 'A required selection is empty. Please choose a value.');
        return bad(field ? `${field} is not valid.` : `"${clip(value)}" is not a valid ID.`);
      }
      if (/^(integer|bigint|smallint|numeric|real|double precision)$/.test(type)) {
        const field = findField(variables, (_k, v) => v === value);
        if (value === '') return bad(field ? `${field} is required.` : 'A number field is empty.');
        return bad(`${field ?? `"${clip(value)}"`} must be a number.`);
      }
      if (type === 'boolean') return bad(`"${clip(value)}" is not a valid yes/no value.`);
      if (/^jsonb?$/.test(type)) return bad('Invalid JSON data.');
      return bad(`"${clip(value)}" is not a valid ${type}.`);
    }
    case '22007':
    case '22008': {
      const value = msg.match(/: "(.*)"$/)?.[1];
      if (value == null) return bad('Invalid date.');
      const field = findField(variables, (_k, v) => v === value);
      if (value === '') return bad(field ? `${field} is required.` : 'A date field is empty.');
      return bad(`${field ? `${field}: ` : ''}"${clip(value)}" is not a valid date.`);
    }
    case '22003':
      return bad('A number is too large for its field.');
    case '22001': {
      const max = msg.match(/varying\((\d+)\)|character\((\d+)\)/);
      return bad(max ? `A text value is too long (max ${max[1] ?? max[2]} characters).` : 'A text value is too long.');
    }
    case '40001':
    case '40P01':
    case '55P03':
      return { message: 'This record was being changed by someone else. Please try again.', code: 'CONFLICT' };
    case '57014':
      return { message: 'The request took too long and was cancelled. Try a smaller date range or filter.', code: 'TIMEOUT' };
    default:
  }
  if (/^(08|53|57P)/.test(sqlState)) {
    return { message: 'Database is temporarily unavailable. Please try again in a moment.', code: 'SERVICE_UNAVAILABLE' };
  }
  if (/^(42P01|42703|42883)$/.test(sqlState) && isProd) {
    return { message: 'The server database is out of date. Please ask the administrator to run the database update.', code: 'INTERNAL_SERVER_ERROR' };
  }
  // Anything else is a server bug: never show SQL in production.
  return isProd ? { message: 'Something went wrong on the server. Please try again.', code: 'INTERNAL_SERVER_ERROR' } : null;
}

/**
 * Rewrite GraphQL variable-coercion messages (which dump the whole input object)
 * into one short sentence naming the field. Returns null when there is nothing to rewrite.
 */
export function friendlyGraphqlMessage(message) {
  const msg = String(message ?? '');
  const path = msg.match(/ at "([\w.]+)"; /)?.[1] ?? msg.match(/^Variable "\$(\w{2,})" got invalid value [^;]*; /)?.[1];
  let field = null;
  if (path) {
    const segs = path.split('.');
    const idx = segs.find((x) => /^\d+$/.test(x));
    field = fieldLabel(segs.findLast((x) => !/^\d+$/.test(x))) + (idx != null ? ` (line ${Number(idx) + 1})` : '');
  }
  let m = msg.match(/Field "(\w+)" of required type "[^"]+" was not provided/);
  if (m) return `${fieldLabel(m[1])} is required.`;
  m = msg.match(/Variable "\$(\w+)" of (?:required|non-null) type "[^"]+" (?:was not provided|must not be null)/);
  if (m) return `${fieldLabel(m[1])} is required.`;
  if (field && /Expected non-nullable type "[^"]+" not to be null/.test(msg)) return `${field} is required.`;
  m = msg.match(/(Int|Float) cannot represent non[- ](?:integer|numeric) value: (.*)$/);
  if (m) {
    const what = field ?? 'A value';
    if (m[1] === 'Float') return `${what} must be a number.`;
    return /^-?[\d.]+$/.test(m[2]) ? `${what} must be a whole number (got ${m[2]}).` : `${what} must be a whole number.`;
  }
  m = msg.match(/Value "?([^"]*)"? does not exist in "(\w+)" enum/);
  if (m) return `${field ? `${field}: ` : ''}"${clip(m[1])}" is not a valid ${fieldLabel(m[2]).toLowerCase()}.`;
  m = msg.match(/; Field "(\w+)" is not defined by type "(\w+)"/);
  if (m) return `Unknown field "${m[1]}" for ${m[2]}.`;
  return null;
}
