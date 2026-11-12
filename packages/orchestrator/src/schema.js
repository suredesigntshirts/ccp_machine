// The JSON Schema subset the specs use: type, enum, required, properties, items, minItems, minLength,
// pattern, and $ref "#name" into the spec's meta.schemas. Returns the problems found; none means valid.
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const is = (v, type) => typeOf(v) === type || (type === 'number' && typeOf(v) === 'integer');

export const check = (schema, value, defs = {}, at = '$') => {
  if (schema.$ref) return check(defs[schema.$ref.slice(1)], value, defs, at);
  if (schema.type && !is(value, schema.type)) return [`${at} is ${typeOf(value)}, not ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at} is not one of ${schema.enum.join(', ')}`];
  if (schema.minLength != null && value.length < schema.minLength) return [`${at} is shorter than ${schema.minLength}`];
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return [`${at} does not match ${schema.pattern}`];
  if (schema.minItems != null && value.length < schema.minItems) return [`${at} has fewer than ${schema.minItems} items`];
  return [
    ...(schema.required ?? []).filter((k) => value?.[k] === undefined).map((k) => `${at}.${k} is missing`),
    ...Object.entries(schema.properties ?? {}).flatMap(([k, s]) => (value?.[k] === undefined ? [] : check(s, value[k], defs, `${at}.${k}`))),
    ...(schema.items && Array.isArray(value) ? value.flatMap((v, i) => check(schema.items, v, defs, `${at}[${i}]`)) : [])
  ];
};
