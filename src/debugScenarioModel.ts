import {z} from 'zod';
import {debugPlanSchema,watchSchema} from './debugModel';
import {navigationSettingsSchema} from './debugNavigation';
import {safeRelativePath} from './model';
export const scenarioSchema=z.object({version:z.literal(1),id:z.string().uuid(),name:z.string().trim().min(1).max(120),diagram:z.string().refine(safeRelativePath),entry:z.string().refine(safeRelativePath),instructions:z.string().max(12000),request:z.string(),plan:debugPlanSchema,navigationSettings:navigationSettingsSchema,watches:z.array(watchSchema)}).strict();
export type SavedScenario=z.infer<typeof scenarioSchema>;
export function uniqueScenarioName(name:string,names:string[]){const base=name.trim().slice(0,120)||'Debug scenario';const used=new Set(names.map(n=>n.toLocaleLowerCase()));let result=base,index=2;while(used.has(result.toLocaleLowerCase())){const suffix=' ('+index+++')';result=base.slice(0,120-suffix.length)+suffix;}return result;}
