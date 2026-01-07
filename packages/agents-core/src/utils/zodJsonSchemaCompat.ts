import type { JsonObjectSchema, JsonSchemaDefinitionEntry } from '../types';
import type { ZodObjectLike } from './zodCompat';
import { readZodDefinition, readZodType } from './zodCompat';
import type * as ZodV4 from 'zod/v4';

/**
 * The JSON-schema helpers in openai/helpers/zod only emit complete schemas for
 * a subset of Zod constructs. In particular, Zod v4 (and several decorators in v3)
 * omit `type`, `properties`, or `required` metadata, which breaks tool execution
 * when a user relies on automatic schema extraction.
 *
 * This module provides a minimal, type-directed fallback converter that inspects
 * Zod internals and synthesises the missing JSON Schema bits on demand. The
 * converter only covers the constructs we actively depend on (objects, optionals,
 * unions, tuples, records, sets, etc.); anything more exotic simply returns
 * `undefined`, signalling to the caller that it should surface a user error.
 *
 * The implementation is intentionally explicit: helper functions isolate each
 * Zod shape, making the behaviour both testable and easier to trim back if the
 * upstream helper gains first-class support. See zodJsonSchemaCompat.test.ts for
 * the regression cases we guarantee.
 */

type LooseJsonObjectSchema = {
  type: 'object';
  properties: Record<string, JsonSchemaDefinitionEntry>;
  required?: string[];
  additionalProperties?: boolean;
  $schema?: string;
};

type ShapeCandidate = {
  shape?: Record<string, unknown> | (() => Record<string, unknown>);
};

const JSON_SCHEMA_DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const OPTIONAL_WRAPPERS = new Set(['optional']);
const DECORATOR_WRAPPERS = new Set([
  'brand',
  'branded',
  'catch',
  'default',
  'effects',
  'pipeline',
  'pipe',
  'prefault',
  'readonly',
  'refinement',
  'transform',
]);

// Primitive leaf nodes map 1:1 to JSON Schema types; everything else is handled
// by the specialised builders further down.
const SIMPLE_TYPE_MAPPING: Record<string, JsonSchemaDefinitionEntry> = {
  string: { type: 'string' },
  number: { type: 'number' },
  bigint: { type: 'integer' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
};

export function hasJsonSchemaObjectShape(
  value: unknown,
): value is LooseJsonObjectSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: string }).type === 'object' &&
    'properties' in value &&
    'additionalProperties' in value
  );
}

/**
 * Recursively finds all unrepresentable types in a Zod schema with their paths.
 *
 * Zod 4's native toJSONSchema cannot properly represent certain types (sets, maps,
 * dates, promises, functions, etc.) and converts them to empty objects {}.
 * This matches Zod's terminology: toJSONSchema uses `unrepresentable: 'any'` option.
 *
 * All of these types have JSON-compatible alternatives that developers should use.
 *
 * @param input - A Zod schema (at any nesting level)
 * @param path - Current path in the schema (for error messages)
 * @returns Array of { type, path } for all unrepresentable types found
 */
function findUnrepresentableTypes(
  input: unknown,
  path: string = '$',
): Array<{ type: string; path: string }> {
  const found: Array<{ type: string; path: string }> = [];

  function check(value: unknown, currentPath: string): void {
    if (!value || typeof value !== 'object') {
      return;
    }

    const type = readZodType(value);
    const def = readZodDefinition(value);

    // Types that Zod 4's toJSONSchema marks as 'unrepresentable'
    // All of these have JSON-compatible alternatives developers should use
    const unrepresentableTypes = [
      'set', // Use z.array() instead
      'map', // Use z.record() instead
      'date', // Use z.string().datetime() instead
      'promise', // Remove - promises aren't serializable
      'function', // Remove - functions aren't serializable
      'custom', // Use concrete types instead
      'nan', // Use z.number() instead
      'undefined', // Use .optional() instead
      'void', // Use z.null() or remove
      'symbol', // Use z.string() or z.enum() instead
    ];

    if (type && unrepresentableTypes.includes(type)) {
      found.push({ type, path: currentPath });
      return;
    }

    switch (type) {
      case 'object': {
        const shape = readShape(value);
        if (shape) {
          for (const [key, field] of Object.entries(shape)) {
            check(field, `${currentPath}.${key}`);
          }
        }
        break;
      }

      case 'array': {
        const items = def?.element || def?.items || def?.type;
        if (items) check(items, `${currentPath}[]`);
        break;
      }

      case 'tuple': {
        const items = def?.items || [];
        const itemsArray = Array.isArray(items) ? items : [items];
        itemsArray.forEach((item, i) => {
          check(item, `${currentPath}[${i}]`);
        });
        if (def?.rest) check(def.rest, `${currentPath}[...]`);
        break;
      }

      case 'union':
      case 'discriminatedunion': {
        const options = def?.options || def?.schemas || [];
        const optionsArray = Array.isArray(options) ? options : [options];
        optionsArray.forEach((option, i) => {
          check(option, `${currentPath}<union[${i}]>`);
        });
        break;
      }

      case 'intersection': {
        if (def?.left) check(def.left, `${currentPath}<left>`);
        if (def?.right) check(def.right, `${currentPath}<right>`);
        break;
      }

      case 'record': {
        const valueType = def?.valueType || def?.values;
        if (valueType) check(valueType, `${currentPath}<values>`);
        const keyType = def?.keyType || def?.keys;
        if (keyType) check(keyType, `${currentPath}<keys>`);
        break;
      }

      case 'nullable':
      case 'optional': {
        const inner = def?.innerType || def?.type;
        if (inner) check(inner, currentPath);
        break;
      }

      case 'transform':
      case 'effects':
      case 'refinement':
      case 'pipeline':
      case 'pipe':
      case 'brand':
      case 'branded':
      case 'catch':
      case 'default':
      case 'prefault':
      case 'readonly': {
        const underlying =
          def?.innerType ||
          def?.schema ||
          def?.base ||
          def?.type ||
          def?.wrapped ||
          def?.underlying;
        if (underlying) check(underlying, currentPath);
        break;
      }

      case 'lazy': {
        // Lazy types can't be fully checked without infinite recursion
        // Conservatively mark as unsupported
        found.push({ type: 'lazy', path: currentPath });
        break;
      }
    }
  }

  check(input, path);
  return found;
}

/**
 * Attempts to use Zod 4's native JSON Schema converter.
 *
 * This function detects Zod 4 schemas by checking for the `_zod` property.
 * If the schema contains unrepresentable types (sets, maps, dates, etc.), it throws
 * a descriptive error telling the developer how to fix their schema.
 *
 * All unrepresentable types have JSON-compatible alternatives, so this is always fixable.
 *
 * @param input - The Zod schema to convert
 * @returns JSON Schema object or undefined (for Zod 3, falls back to manual converter)
 * @throws Error if Zod 4 schema contains unrepresentable types
 */
function tryZod4NativeCompat(
  input: ZodObjectLike,
): JsonObjectSchema<any> | undefined {
  try {
    // Step 1: Check if this is a Zod 4 schema
    // Zod 4 schemas have a _zod property, Zod 3 schemas have _def
    const hasZod4Structure = '_zod' in input;
    if (!hasZod4Structure) {
      // This is Zod 3 - let manual converter handle it
      return undefined;
    }

    // Step 2: Check for unrepresentable types BEFORE attempting conversion
    const unrepresentableTypes = findUnrepresentableTypes(input);

    if (unrepresentableTypes.length > 0) {
      // Build a detailed error message with exact fixes for each issue
      const fixes = unrepresentableTypes
        .map(({ type, path }) => {
          switch (type) {
            case 'set':
              return `  • ${path}: Replace z.set(T) with z.array(T)
    Example: z.set(z.string()) → z.array(z.string())
    If uniqueness matters, add validation: .refine(arr => new Set(arr).size === arr.length, 'Must be unique')`;

            case 'map':
              return `  • ${path}: Replace z.map() with z.record()
    Example: z.map(z.string(), z.number()) → z.record(z.string(), z.number())`;

            case 'date':
              return `  • ${path}: Replace z.date() with z.string().datetime()
    Example: z.date() → z.string().datetime()
    Or use z.coerce.date() if you need automatic date parsing from strings`;

            case 'promise':
              return `  • ${path}: Remove z.promise() - promises cannot be serialized to JSON`;

            case 'function':
              return `  • ${path}: Remove z.function() - functions cannot be serialized to JSON`;

            case 'symbol':
              return `  • ${path}: Replace z.symbol() with z.string() or z.enum(['symbol1', 'symbol2'])`;

            case 'undefined':
              return `  • ${path}: Replace z.undefined() with .optional()
    Example: field: z.undefined() → field: z.string().optional()`;

            case 'void':
              return `  • ${path}: Replace z.void() with z.null() or remove the field`;

            case 'nan':
              return `  • ${path}: Replace z.nan() with z.number()`;

            case 'custom':
              return `  • ${path}: Replace z.custom() with a concrete type like z.string(), z.number(), or z.object({...})`;

            case 'lazy':
              return `  • ${path}: Lazy/recursive types may not be fully representable - consider flattening the structure`;

            default:
              return `  • ${path}: ${type} is not representable in JSON Schema`;
          }
        })
        .join('\n\n');

      throw new Error(
        `[@openai/agents] Cannot convert Zod 4 schema to JSON Schema.\n\n` +
          `Found ${unrepresentableTypes.length} unrepresentable type(s):\n\n${fixes}\n\n` +
          `All of these types have JSON-compatible alternatives. Please update your schema.\n` +
          `See: https://github.com/anthropics/openai-agents-js/blob/main/docs/zod-schemas.md`,
      );
    }

    // Step 3: Load Zod 4 dynamically
    let z: typeof ZodV4 | undefined;
    try {
      try {
        // accessing project runtime zod version
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        z = require('zod/v4') as typeof ZodV4;
      } catch {
        // accessing project runtime zod version
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        z = require('zod') as typeof ZodV4;
      }
    } catch (_error) {
      return undefined;
    }

    if (!z || typeof z.toJSONSchema !== 'function') {
      return undefined;
    }

    // Step 4: Use Zod 4's native converter
    const jsonSchema = z.toJSONSchema(input, {
      target: 'draft-7',
      unrepresentable: 'any',
      cycles: 'ref',
      reused: 'inline',
    });

    // Step 5: Validate the output structure
    if (!hasJsonSchemaObjectShape(jsonSchema)) {
      return undefined;
    }

    return jsonSchema as JsonObjectSchema<any>;
  } catch (error) {
    // If it's our descriptive error, rethrow it
    if (error instanceof Error && error.message.includes('[@openai/agents]')) {
      throw error;
    }
    // Other errors: fall back to manual converter
    return undefined;
  }
}

export function zodJsonSchemaCompat(
  input: ZodObjectLike,
): JsonObjectSchema<any> | undefined {
  // Attempt to use build schema using native conversion function from ZodV4
  // if found to be installed in the project's runtime environment. If this
  // fails, fallback to custom schema parsing below
  const nativeResult = tryZod4NativeCompat(input);
  if (nativeResult) {
    return nativeResult;
  }
  // Attempt to build an object schema from Zod's internal shape. If we cannot
  // understand the structure we return undefined, letting callers raise a
  // descriptive error instead of emitting an invalid schema.
  const schema = buildObjectSchema(input);
  if (!schema) {
    return undefined;
  }

  if (!Array.isArray(schema.required)) {
    schema.required = [];
  }

  if (typeof schema.additionalProperties === 'undefined') {
    schema.additionalProperties = false;
  }

  if (typeof schema.$schema !== 'string') {
    schema.$schema = JSON_SCHEMA_DRAFT_07;
  }

  return schema as JsonObjectSchema<Record<string, JsonSchemaDefinitionEntry>>;
}

function buildObjectSchema(value: unknown): LooseJsonObjectSchema | undefined {
  const shape = readShape(value);
  if (!shape) {
    return undefined;
  }

  const properties: Record<string, JsonSchemaDefinitionEntry> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const { schema, optional } = convertProperty(field);
    if (!schema) {
      return undefined;
    }

    properties[key] = schema;
    if (!optional) {
      required.push(key);
    }
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

function convertProperty(value: unknown): {
  schema?: JsonSchemaDefinitionEntry;
  optional: boolean;
} {
  // Remove wrapper decorators (brand, transform, etc.) before attempting to
  // classify the node, tracking whether we crossed an `optional` boundary so we
  // can populate the `required` array later.
  let current = unwrapDecorators(value);
  let optional = false;

  while (OPTIONAL_WRAPPERS.has(readZodType(current) ?? '')) {
    optional = true;
    const def = readZodDefinition(current);
    const next = unwrapDecorators(def?.innerType);
    if (!next || next === current) {
      break;
    }
    current = next;
  }

  return { schema: convertSchema(current), optional };
}

function convertSchema(value: unknown): JsonSchemaDefinitionEntry | undefined {
  if (value === undefined) {
    return undefined;
  }

  const unwrapped = unwrapDecorators(value);
  const type = readZodType(unwrapped);
  const def = readZodDefinition(unwrapped);

  if (!type) {
    return undefined;
  }

  if (type in SIMPLE_TYPE_MAPPING) {
    return SIMPLE_TYPE_MAPPING[type];
  }

  switch (type) {
    case 'object':
      return buildObjectSchema(unwrapped);
    case 'array':
      return buildArraySchema(def);
    case 'tuple':
      return buildTupleSchema(def);
    case 'union':
      return buildUnionSchema(def);
    case 'intersection':
      return buildIntersectionSchema(def);
    case 'literal':
      return buildLiteral(def);
    case 'enum':
    case 'nativeenum':
      return buildEnum(def);
    case 'record':
      return buildRecordSchema(def);
    case 'map':
      return buildMapSchema(def);
    case 'set':
      return buildSetSchema(def);
    case 'nullable':
      return buildNullableSchema(def);
    default:
      return undefined;
  }
}

// --- JSON Schema builders -------------------------------------------------

function buildArraySchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const items = convertSchema(extractFirst(def, 'element', 'items', 'type'));
  return items ? { type: 'array', items } : undefined;
}

function buildTupleSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const items = coerceArray(def?.items)
    .map((item) => convertSchema(item))
    .filter(Boolean) as JsonSchemaDefinitionEntry[];
  if (!items.length) {
    return undefined;
  }
  const schema: JsonSchemaDefinitionEntry = {
    type: 'array',
    items,
    minItems: items.length,
  };
  if (!def?.rest) {
    schema.maxItems = items.length;
  }
  return schema;
}

function buildUnionSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const options = coerceArray(def?.options ?? def?.schemas)
    .map((option) => convertSchema(option))
    .filter(Boolean) as JsonSchemaDefinitionEntry[];
  return options.length ? { anyOf: options } : undefined;
}

function buildIntersectionSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const left = convertSchema(def?.left);
  const right = convertSchema(def?.right);
  return left && right ? { allOf: [left, right] } : undefined;
}

function buildRecordSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType ?? def?.values);
  return valueSchema
    ? { type: 'object', additionalProperties: valueSchema }
    : undefined;
}

function buildMapSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType ?? def?.values);
  return valueSchema ? { type: 'array', items: valueSchema } : undefined;
}

function buildSetSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const valueSchema = convertSchema(def?.valueType);
  return valueSchema
    ? { type: 'array', items: valueSchema, uniqueItems: true }
    : undefined;
}

function buildNullableSchema(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  const inner = convertSchema(def?.innerType ?? def?.type);
  return inner ? { anyOf: [inner, { type: 'null' }] } : undefined;
}

function unwrapDecorators(value: unknown): unknown {
  let current = value;
  while (DECORATOR_WRAPPERS.has(readZodType(current) ?? '')) {
    const def = readZodDefinition(current);
    const next =
      def?.innerType ??
      def?.schema ??
      def?.base ??
      def?.type ??
      def?.wrapped ??
      def?.underlying;
    if (!next || next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function extractFirst(
  def: Record<string, unknown> | undefined,
  ...keys: string[]
): unknown {
  if (!def) {
    return undefined;
  }
  for (const key of keys) {
    if (key in def && def[key] !== undefined) {
      return (def as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

function buildLiteral(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  if (!def) {
    return undefined;
  }
  const literal = extractFirst(def, 'value', 'literal') as
    | string
    | number
    | boolean
    | null
    | undefined;
  if (literal === undefined) {
    return undefined;
  }
  return {
    const: literal,
    type: literal === null ? 'null' : typeof literal,
  };
}

function buildEnum(
  def: Record<string, unknown> | undefined,
): JsonSchemaDefinitionEntry | undefined {
  if (!def) {
    return undefined;
  }
  if (Array.isArray(def.values)) {
    return { enum: def.values as unknown[] };
  }
  if (Array.isArray(def.options)) {
    return { enum: def.options as unknown[] };
  }
  if (def.values && typeof def.values === 'object') {
    return { enum: Object.values(def.values as Record<string, unknown>) };
  }
  if (def.enum && typeof def.enum === 'object') {
    return { enum: Object.values(def.enum as Record<string, unknown>) };
  }
  return undefined;
}

function readShape(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const candidate = input as ShapeCandidate;
  if (candidate.shape && typeof candidate.shape === 'object') {
    return candidate.shape;
  }
  if (typeof candidate.shape === 'function') {
    try {
      return candidate.shape();
    } catch (_error) {
      return undefined;
    }
  }

  const def = readZodDefinition(candidate);
  const shape = def?.shape;
  if (shape && typeof shape === 'object') {
    return shape as Record<string, unknown>;
  }
  if (typeof shape === 'function') {
    try {
      return shape();
    } catch (_error) {
      return undefined;
    }
  }

  return undefined;
}
