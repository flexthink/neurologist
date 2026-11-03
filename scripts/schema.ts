import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { architectureSchema } from '../src/model';
writeFileSync('dist/neuro.schema.json', JSON.stringify(z.toJSONSchema(architectureSchema),null,2) + '\n');
