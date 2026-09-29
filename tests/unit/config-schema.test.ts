import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { scenarioSchema } from '../../src/config/config.js';
import { flowSchema } from '../../src/config/flow-schema.js';
import { brokenEnums } from '../../src/config/schema-guard.js';

describe('scenario schema', () => {
  it('every enum received its values (a missing constant would crash zod instead of reporting)', () => {
    expect(brokenEnums(scenarioSchema)).toEqual([]);
    expect(brokenEnums(flowSchema, 'flow')).toEqual([]);
  });

  it('names an enum built from a missing constant', () => {
    const missing = undefined as unknown as [string, ...string[]];
    const broken = z.object({ report: z.object({ language: z.enum(missing).default('en') }).default({}) });
    expect(brokenEnums(broken)).toEqual(['report.language']);
  });
});
