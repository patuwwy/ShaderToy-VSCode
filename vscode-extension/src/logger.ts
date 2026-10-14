import * as fs from 'fs';
import * as path from 'path';

const logFilePath = 'c:\\github\\ShaderToyAI\\debug.log';

export function appendLog(source: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  let line = `[${timestamp}] [${source}] ${message}`;
  if (data !== undefined) {
    line += ` | ${typeof data === 'object' ? JSON.stringify(data) : data}`;
  }
  line += '\n';

  try {
    fs.appendFileSync(logFilePath, line, 'utf-8');
  } catch (err) {
    console.error('Failed to write to debug.log:', err);
  }
}
