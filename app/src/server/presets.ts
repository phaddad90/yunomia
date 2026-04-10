import { existsSync, readdirSync, readFileSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Logger } from 'pino';

export interface PresetConfig {
  recommendedModel: string;
  heartbeatIntervalMinutes: number;
  maxConcurrentWorkers: number;
  workerModel: string;
  description: string;
}

export interface Preset {
  name: string;
  config: PresetConfig;
  soulPath: string;
  goalsPath: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getPresetsDir(): string {
  // Look relative to the project root (two levels up from dist/server or src/server)
  const candidates = [
    join(__dirname, '..', '..', '..', 'presets'),      // from dist/server/
    join(__dirname, '..', '..', '..', '..', 'presets'), // from src/server/ via tsx
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

export function listPresets(logger: Logger): Preset[] {
  const presetsDir = getPresetsDir();
  if (!existsSync(presetsDir)) {
    logger.warn({ presetsDir }, 'Presets directory not found');
    return [];
  }

  const presets: Preset[] = [];
  for (const name of readdirSync(presetsDir)) {
    const dir = join(presetsDir, name);
    const configPath = join(dir, 'config.json');
    const soulPath = join(dir, 'SOUL.md');
    const goalsPath = join(dir, 'GOALS.md');

    if (!existsSync(configPath) || !existsSync(soulPath) || !existsSync(goalsPath)) continue;

    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as PresetConfig;
      presets.push({ name, config, soulPath, goalsPath });
    } catch {
      logger.warn({ preset: name }, 'Failed to load preset config');
    }
  }

  return presets.sort((a, b) => a.name.localeCompare(b.name));
}

export function applyPreset(presetName: string, projectPath: string, logger: Logger): PresetConfig | null {
  const presetsDir = getPresetsDir();
  const presetDir = join(presetsDir, presetName);

  if (!existsSync(presetDir)) {
    logger.error({ preset: presetName }, 'Preset not found');
    return null;
  }

  const configPath = join(presetDir, 'config.json');
  const soulPath = join(presetDir, 'SOUL.md');
  const goalsPath = join(presetDir, 'GOALS.md');

  if (!existsSync(configPath) || !existsSync(soulPath) || !existsSync(goalsPath)) {
    logger.error({ preset: presetName }, 'Preset missing required files');
    return null;
  }

  const ceoDir = join(projectPath, 'ceo');
  mkdirSync(ceoDir, { recursive: true });

  // Copy SOUL.md and GOALS.md to project ceo/ folder
  copyFileSync(soulPath, join(ceoDir, 'SOUL.md'));
  copyFileSync(goalsPath, join(ceoDir, 'GOALS.md'));

  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as PresetConfig;
  logger.info({ preset: presetName, model: config.recommendedModel }, 'Preset applied');

  return config;
}
