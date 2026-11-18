// Starts the stand-in on its own port for the flow tests and stops it after.

import { spawn, type ChildProcess } from 'node:child_process';

let standIn: ChildProcess | undefined;

export async function setup(): Promise<void> {
  standIn = spawn(process.execPath, ['stand-in/server.ts'], {
    env: { ...process.env, STAND_IN_PORT: '3311', APP_URL: 'http://127.0.0.1:9' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    const up = await fetch('http://127.0.0.1:3311/__control/state', { method: 'POST' }).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the stand-in did not start on port 3311');
}

export function teardown(): void {
  standIn?.kill();
}
