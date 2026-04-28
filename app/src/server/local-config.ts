import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { AgentCode } from './types.js';

/**
 * Local Mission Control config — persists across restarts, lives outside the
 * repo at ~/.printpepper/mission-control.json. Only fields that v0.1+ does
 * not already source from process env or the launch flag belong here.
 */
export interface LocalConfig {
  agentCode?: AgentCode;
}

const CONFIG_PATH = join(homedir(), '.printpepper', 'mission-control.json');

export function loadLocalConfig(): LocalConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as LocalConfig;
    return {};
  } catch {
    return {};
  }
}

export function saveLocalConfig(patch: LocalConfig): LocalConfig {
  const current = loadLocalConfig();
  const merged = { ...current, ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}
