import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { zodJsonSchemaCompat } from '../../src/utils/zodJsonSchemaCompat';

describe('utils/zodJsonSchemaCompat', () => {
  it('builds schema for basic object with optional property', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema).toMatchObject({
      type: 'object',
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    });
    expect(jsonSchema?.required).toEqual(['name']);
  });

  it('unwraps decorators and nullable types', () => {
    const schema = z.object({
      branded: z.string().brand('Tagged'),
      readonly: z.string().readonly(),
      nullable: z.string().nullable(),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.branded).toEqual({ type: 'string' });
    expect(jsonSchema?.properties.readonly).toEqual({ type: 'string' });
    expect(jsonSchema?.properties.nullable).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('handles compound schemas such as tuples and unions', () => {
    const schema = z.object({
      tuple: z.tuple([z.string(), z.number()]),
      union: z.union([z.string(), z.number()]),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.tuple).toMatchObject({
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: [{ type: 'string' }, { type: 'number' }],
    });
    expect(jsonSchema?.properties.union).toMatchObject({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('converts nested record and array structures', () => {
    const schema = z.object({
      record: z.record(z.number()),
      list: z.array(z.object({ id: z.string() })),
    });

    const jsonSchema = zodJsonSchemaCompat(schema);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.record).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
    expect(jsonSchema?.properties.list).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    });
  });

  it('supports Zod v4 objects', () => {
    const schema = z4.object({
      title: z4.string(),
      score: z4.number().optional(),
      tags: z4.array(z4.string()), // Changed from z4.set() - sets aren't supported
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);
    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.title).toEqual({ type: 'string' });
    expect(jsonSchema?.properties.score).toEqual({ type: 'number' });
    expect(jsonSchema?.properties.tags).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(jsonSchema?.required).toEqual(['title', 'tags']);
  });
});

describe('Zod 4 native converter', () => {
  it('uses native toJSONSchema for simple Zod 4 schemas', () => {
    const schema = z4.object({
      name: z4.string(),
      count: z4.number(),
      tags: z4.array(z4.string()),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.type).toBe('object');
    expect(jsonSchema?.properties.name).toEqual({ type: 'string' });
    expect(jsonSchema?.properties.count).toEqual({ type: 'number' });
    expect(jsonSchema?.properties.tags).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
    expect(jsonSchema?.required).toEqual(['name', 'count', 'tags']);
  });

  it('handles optional fields correctly', () => {
    const schema = z4.object({
      required: z4.string(),
      optional: z4.string().optional(),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.required).toContain('required');
    expect(jsonSchema?.required).not.toContain('optional');
    expect(jsonSchema?.properties.optional).toEqual({ type: 'string' });
  });

  it('handles complex nested Zod 4 schemas', () => {
    // This mimics the structure that was failing in UIFoundry
    const schema = z4.object({
      features: z4.array(
        z4.object({
          title: z4.string(),
          description: z4.string(),
          items: z4.array(z4.string()),
          metadata: z4.record(z4.string(), z4.any()).optional(),
        }),
      ),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.features).toBeDefined();
    expect(jsonSchema?.properties.features).toMatchObject({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          items: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    });
  });

  it('handles deeply nested arrays with objects', () => {
    const schema = z4.object({
      level1: z4.array(
        z4.object({
          level2: z4.array(
            z4.object({
              id: z4.string(),
              value: z4.number(),
            }),
          ),
        }),
      ),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.level1).toBeDefined();
  });

  it('handles records (maps) correctly', () => {
    const schema = z4.object({
      metadata: z4.record(z4.string(), z4.string()),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.metadata).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
  });

  it('handles unions correctly', () => {
    const schema = z4.object({
      value: z4.union([z4.string(), z4.number()]),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.value).toHaveProperty('anyOf');
  });

  it('handles enums correctly', () => {
    const schema = z4.object({
      status: z4.enum(['pending', 'active', 'completed']),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.status).toHaveProperty('enum');
  });

  it('throws descriptive error for unrepresentable Zod 4 types', () => {
    const schemaWithSet = z4.object({
      tags: z4.set(z4.string()),
    });

    expect(() => zodJsonSchemaCompat(schemaWithSet as any)).toThrow(
      /Cannot convert Zod 4 schema to JSON Schema/,
    );
    expect(() => zodJsonSchemaCompat(schemaWithSet as any)).toThrow(
      /Replace z\.set\(T\) with z\.array\(T\)/,
    );
  });

  it('throws error for nested unrepresentable types', () => {
    const schemaWithNestedDate = z4.object({
      user: z4.object({
        createdAt: z4.date(),
      }),
    });

    expect(() => zodJsonSchemaCompat(schemaWithNestedDate as any)).toThrow(
      /Cannot convert Zod 4 schema to JSON Schema/,
    );
    expect(() => zodJsonSchemaCompat(schemaWithNestedDate as any)).toThrow(
      /Replace z\.date\(\) with z\.string\(\)\.datetime\(\)/,
    );
  });

  it('falls back to manual converter for Zod 3 schemas', () => {
    // This ensures we didn't break Zod 3 compatibility
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.type).toBe('object');
    expect(jsonSchema?.properties.name).toEqual({ type: 'string' });
    expect(jsonSchema?.properties.age).toEqual({ type: 'number' });
    expect(jsonSchema?.required).toEqual(['name']);
  });

  it('handles nullable fields', () => {
    const schema = z4.object({
      name: z4.string().nullable(),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.name).toHaveProperty('anyOf');
  });

  it('handles literal types', () => {
    const schema = z4.object({
      type: z4.literal('user'),
      role: z4.literal('admin'),
    });

    const jsonSchema = zodJsonSchemaCompat(schema as any);

    expect(jsonSchema).toBeDefined();
    expect(jsonSchema?.properties.type).toHaveProperty('const', 'user');
    expect(jsonSchema?.properties.role).toHaveProperty('const', 'admin');
  });
});
