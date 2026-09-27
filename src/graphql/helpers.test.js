// Unit tests for the pg / GraphQL error → human message mapping (helpers.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldLabel, friendlyError, friendlyGraphqlMessage, httpError } from './helpers.js';

const pg = (code, props) => Object.assign(new Error(props.message ?? 'pg error'), { code, ...props });
const msg = (err, opts) => friendlyError(err, opts)?.message;

test('fieldLabel turns column / input names into words', () => {
  assert.equal(fieldLabel('distributor_id'), 'Distributor');
  assert.equal(fieldLabel('gstPercent'), 'GST percent');
  assert.equal(fieldLabel('invoice_no'), 'Invoice number');
  assert.equal(fieldLabel('id'), 'ID');
});

test('23505 unique violation names the field and value', () => {
  const r = friendlyError(pg('23505', { detail: 'Key (sku)=(PST-001) already exists.', constraint: 'products_sku_key', table: 'products' }));
  assert.deepEqual(r, { message: 'SKU "PST-001" already exists.', code: 'CONFLICT' });
  assert.equal(msg(pg('23505', { detail: 'Key (lower(email::text))=(a@b.in) already exists.' })), 'Email "a@b.in" already exists.');
  assert.equal(
    msg(pg('23505', { detail: 'Key (product_id, batch_number)=(0f0e…, B1) already exists.' })),
    'A record with the same Product, Batch number already exists.',
  );
  assert.equal(msg(pg('23505', {})), 'This record already exists.');
});

test('23502 not-null names the missing field', () => {
  const e = pg('23502', { column: 'distributor_id', table: 'orders', message: 'null value in column "distributor_id" of relation "orders" violates not-null constraint' });
  assert.deepEqual(friendlyError(e), { message: 'Distributor is required.', code: 'BAD_USER_INPUT' });
  assert.equal(msg(pg('23502', { message: 'null value in column "invoice_date" violates not-null constraint' })), 'Invoice date is required.');
});

test('23503 foreign key: missing parent vs still referenced', () => {
  assert.equal(
    msg(pg('23503', { detail: 'Key (branch_id)=(00000000-0000-4000-8000-000000000000) is not present in table "branches".' })),
    'The selected Branch does not exist (it may have been deleted).',
  );
  const r = friendlyError(pg('23503', { detail: 'Key (id)=(abc) is still referenced from table "order_lines".' }));
  assert.deepEqual(r, { message: 'This record is used in order lines and cannot be deleted.', code: 'CONFLICT' });
});

test('23514 check constraint', () => {
  assert.equal(msg(pg('23514', { constraint: 'order_lines_quantity_check', table: 'order_lines' })), 'Quantity must be greater than 0.');
  assert.equal(msg(pg('23514', { constraint: 'party_sales_check', table: 'party_sales' })), 'Some values are not valid together. Please review the form.');
});

test('22P02 invalid text representation uses the request variables to name the field', () => {
  const uuidEmpty = pg('22P02', { message: 'invalid input syntax for type uuid: ""' });
  assert.equal(msg(uuidEmpty, { variables: { input: { lines: [{ productId: 'x' }, { productId: '' }] } } }), 'Product (line 2) is required.');
  assert.equal(msg(uuidEmpty), 'A required selection is empty. Please choose a value.');
  assert.equal(msg(pg('22P02', { message: 'invalid input syntax for type uuid: "abc"' }), { variables: { input: { branchId: 'abc' } } }), 'Branch is not valid.');
  assert.equal(msg(pg('22P02', { message: 'invalid input syntax for type numeric: "12a"' }), { variables: { input: { rate: '12a' } } }), 'Rate must be a number.');
  assert.equal(msg(pg('22P02', { message: 'invalid input value for enum order_status: "FOO"' })), '"FOO" is not a valid order status.');
});

test('dates, overflow, length, timeouts', () => {
  assert.equal(
    msg(pg('22008', { message: 'date/time field value out of range: "31/12/2025"' }), { variables: { input: { invoiceDate: '31/12/2025' } } }),
    'Invoice date: "31/12/2025" is not a valid date.',
  );
  assert.equal(msg(pg('22007', { message: 'invalid input syntax for type date: ""' }), { variables: { input: { dueDate: '' } } }), 'Due date is required.');
  assert.equal(msg(pg('22003', { message: 'numeric field overflow' })), 'A number is too large for its field.');
  assert.equal(msg(pg('22001', { message: 'value too long for type character varying(15)' })), 'A text value is too long (max 15 characters).');
  assert.equal(friendlyError(pg('57014', {})).code, 'TIMEOUT');
  assert.equal(friendlyError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).code, 'SERVICE_UNAVAILABLE');
});

test('deliberate errors are kept; unknown errors hide SQL only in production', () => {
  assert.equal(friendlyError(httpError('Warehouse name is required', 400)), null);
  assert.equal(friendlyError(new Error('Insufficient stock')), null);
  assert.equal(friendlyError(new Error('Insufficient stock'), { isProd: true }), null);
  const syntax = pg('42601', { message: 'syntax error at or near "FROM"' });
  assert.equal(friendlyError(syntax), null);
  assert.equal(friendlyError(syntax, { isProd: true }).code, 'INTERNAL_SERVER_ERROR');
  assert.equal(friendlyError(new TypeError("Cannot read properties of undefined (reading 'id')"), { isProd: true }).code, 'INTERNAL_SERVER_ERROR');
  assert.equal(friendlyError(undefined), null);
});

test('friendlyGraphqlMessage rewrites variable coercion errors', () => {
  assert.equal(
    friendlyGraphqlMessage('Variable "$input" got invalid value { code: "x" }; Field "name" of required type "String!" was not provided.'),
    'Name is required.',
  );
  assert.equal(friendlyGraphqlMessage('Variable "$id" of required type "ID!" was not provided.'), 'ID is required.');
  assert.equal(
    friendlyGraphqlMessage('Variable "$input" got invalid value "abc" at "input.lines.0.quantity"; Float cannot represent non numeric value: "abc"'),
    'Quantity (line 1) must be a number.',
  );
  assert.equal(
    friendlyGraphqlMessage('Variable "$limit" got invalid value 2.5; Int cannot represent non-integer value: 2.5'),
    'Limit must be a whole number (got 2.5).',
  );
  assert.equal(
    friendlyGraphqlMessage('Variable "$r" got invalid value "KING"; Value "KING" does not exist in "UserRole" enum.'),
    '"KING" is not a valid user role.',
  );
  assert.equal(friendlyGraphqlMessage('Cannot query field "foo" on type "Query".'), null);
});
