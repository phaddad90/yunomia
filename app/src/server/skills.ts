import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Logger } from 'pino';
import type { AgentAdapter } from './agent-adapter.js';
import type { SafetyModule } from './safety.js';
import type { TaskManager } from './tasks.js';

export interface SkillWorkerDef {
  role: string;
  model: string;
  focus: string;
}

export interface SkillConfigField {
  name: string;
  label: string;
  type: string;
  required: boolean;
}

export interface SkillDefinition {
  name: string;
  description: string;
  mode: 'ceo' | 'single-worker' | 'multi-worker';
  workerModel?: string;
  output: string;
  workers?: SkillWorkerDef[];
  configFields?: SkillConfigField[];
  promptTemplate: string;
}

export interface SkillRunResult {
  skillName: string;
  mode: string;
  status: 'completed' | 'failed' | 'running';
  outputPath?: string;
  workerCount?: number;
  error?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getSkillsDir(): string {
  const candidates = [
    join(__dirname, '..', '..', '..', 'skills'),
    join(__dirname, '..', '..', '..', '..', 'skills'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

export function listSkills(logger: Logger): SkillDefinition[] {
  const skillsDir = getSkillsDir();
  if (!existsSync(skillsDir)) {
    logger.warn({ skillsDir }, 'Skills directory not found');
    return [];
  }

  const skills: SkillDefinition[] = [];
  for (const name of readdirSync(skillsDir)) {
    const dir = join(skillsDir, name);
    const skillJsonPath = join(dir, 'skill.json');
    const promptPath = join(dir, 'prompt.md');

    if (!existsSync(skillJsonPath) || !existsSync(promptPath)) continue;

    try {
      const skillJson = JSON.parse(readFileSync(skillJsonPath, 'utf-8'));
      const promptTemplate = readFileSync(promptPath, 'utf-8');
      skills.push({ ...skillJson, promptTemplate });
    } catch {
      logger.warn({ skill: name }, 'Failed to load skill');
    }
  }

  return skills;
}

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => {
    // Support dotted keys like config.testCommand
    const parts = key.split('.');
    let val: unknown = vars;
    for (const part of parts) {
      val = (val as Record<string, unknown>)?.[part];
    }
    return typeof val === 'string' ? val : `{{${key}}}`;
  });
}

export async function runSkill(
  skill: SkillDefinition,
  projectPath: string,
  config: Record<string, string>,
  adapter: AgentAdapter,
  safety: SafetyModule,
  tasks: TaskManager,
  logger: Logger,
  onOutput?: (agentId: string) => (data: string) => void,
  onTasksChanged?: () => void,
): Promise<SkillRunResult> {
  const date = new Date().toISOString().split('T')[0];
  const outputPath = join(projectPath, skill.output.replace('{date}', date).replace('{skillName}', skill.name.toLowerCase().replace(/\s+/g, '-')));

  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });

  const baseVars: Record<string, string> = {
    projectPath,
    ...config,
  };

  try {
    if (skill.mode === 'ceo') {
      // Send the prompt directly to the CEO
      const ceo = adapter.getCeoSession();
      if (!ceo) {
        return { skillName: skill.name, mode: 'ceo', status: 'failed', error: 'CEO not running' };
      }

      const prompt = interpolateTemplate(skill.promptTemplate, baseVars);
      await adapter.sendMessage(ceo.id, `[Skill: ${skill.name}]\n\n${prompt}`);
      logger.info({ skill: skill.name, mode: 'ceo' }, 'Skill sent to CEO');

      return { skillName: skill.name, mode: 'ceo', status: 'running' };

    } else if (skill.mode === 'single-worker') {
      // Create a task and spawn a worker
      const task = await tasks.createTask({
        title: `[Skill] ${skill.name}`,
        description: interpolateTemplate(skill.promptTemplate, baseVars),
        model: (skill.workerModel as 'sonnet' | 'opus' | 'haiku') || 'sonnet',
        priority: 'high',
      });

      if (onTasksChanged) onTasksChanged();
      logger.info({ skill: skill.name, mode: 'single-worker', taskId: task.id }, 'Skill task created');

      return { skillName: skill.name, mode: 'single-worker', status: 'running', outputPath, workerCount: 1 };

    } else if (skill.mode === 'multi-worker') {
      // Create multiple tasks, one per worker definition
      const workers = skill.workers || [];
      for (const worker of workers) {
        const workerVars = { ...baseVars, role: worker.role, focus: worker.focus };
        const prompt = interpolateTemplate(skill.promptTemplate, workerVars);

        const task = await tasks.createTask({
          title: `[Skill] ${skill.name} - ${worker.role}`,
          description: prompt,
          model: (worker.model as 'sonnet' | 'opus' | 'haiku') || 'sonnet',
          priority: 'high',
        });

        logger.info({ skill: skill.name, role: worker.role, taskId: task.id }, 'Skill worker task created');
      }

      if (onTasksChanged) onTasksChanged();

      return { skillName: skill.name, mode: 'multi-worker', status: 'running', outputPath, workerCount: workers.length };
    }

    return { skillName: skill.name, mode: skill.mode, status: 'failed', error: 'Unknown skill mode' };
  } catch (err) {
    logger.error({ skill: skill.name, err }, 'Failed to run skill');
    return { skillName: skill.name, mode: skill.mode, status: 'failed', error: String(err) };
  }
}
