import { test, describe, beforeEach, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_DIR = '/tmp/economy-test';
const MODELS_FILE = join(TEST_DIR, 'models.json');
const TEMPLATE_FILE = join(TEST_DIR, 'ledger.template.json');

const TEST_MODELS = {
  quotas: {
    pool_a: { window: 'daily', limit: 10 },
    pool_b: { window: 'daily', limit: 5 },
    pool_inf: { window: 'daily', limit: 'inf' },
    pool_dead: { status: 'dead' }
  },
  models: [
    { id: 'm1', cli: 'cli1', tier: 'T1', intelligence: 90, role: 'deep', salary_dispatches: 2, quota_pool: 'pool_a', lane: 'l1', handover_to: ['m2', 'm3'] },
    { id: 'm2', cli: 'cli1', tier: 'T1', intelligence: 80, role: 'deep', salary_dispatches: 3, quota_pool: 'pool_a', lane: 'l1', handover_to: ['m3'] },
    { id: 'm3', cli: 'cli2', tier: 'T2', intelligence: 70, role: 'analysis', salary_dispatches: 5, quota_pool: 'pool_b', lane: 'l2', handover_to: ['m4'] },
    { id: 'm4', cli: 'cli2', tier: 'T2', intelligence: 60, role: 'analysis', salary_dispatches: 'inf', quota_pool: 'pool_inf', lane: 'l2', handover_to: [] },
    { id: 'm5', cli: 'cli3', tier: 'T3', intelligence: 50, role: 'code', salary_dispatches: 1, quota_pool: 'pool_b', lane: 'l3', handover_to: [] },
    { id: 'm6', cli: 'cli3', tier: 'DEAD', intelligence: 40, role: 'grind', salary_dispatches: 10, quota_pool: 'pool_a', lane: 'l4', handover_to: [] }
  ]
};

const TEMPLATE = {
  mission_id: '',
  started: '',
  objective: '',
  dispatches: {},
  pool_used: {},
  chokes: [],
  handovers: [],
  status: 'active'
};

function runEconomy(args, env = {}) {
  const result = spawnSync('node', ['/home/kali/.config/delegate-skills/economy.mjs', ...args], {
    cwd: TEST_DIR,
    env: { ...process.env, MODELS_FILE, TEMPLATE_FILE, CONFIG_DIR: TEST_DIR, ...env },
    encoding: 'utf8'
  });
  if (result.status !== 0 && result.stderr) {
    console.error('stderr:', result.stderr);
  }
  return result;
}

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(MODELS_FILE, JSON.stringify(TEST_MODELS, null, 2));
  writeFileSync(TEMPLATE_FILE, JSON.stringify(TEMPLATE, null, 2));
}

function teardown() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

describe('economy.mjs', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('pick returns top-intelligence eligible model for role', () => {
    const res = runEconomy(['pick', '--role', 'deep', '--mission', 'test1']);
    strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, 'm1');
    strictEqual(out.cli, 'cli1');
    strictEqual(out.salary_remaining, 2);
    strictEqual(out.pool_remaining, 10);
  });

  test('pick falls back to adjacent role when none eligible', () => {
    // Exhaust m1 and m2 salary
    runEconomy(['spend', '--model', 'm1', '--mission', 'test2']);
    runEconomy(['spend', '--model', 'm1', '--mission', 'test2']);
    runEconomy(['spend', '--model', 'm2', '--mission', 'test2']);
    runEconomy(['spend', '--model', 'm2', '--mission', 'test2']);
    runEconomy(['spend', '--model', 'm2', '--mission', 'test2']);

    const res = runEconomy(['pick', '--role', 'deep', '--mission', 'test2']);
    strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, 'm3');
  });

  test('spend increments dispatches and pool_used', () => {
    const res = runEconomy(['spend', '--role', 'deep', '--mission', 'test3']);
    strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, 'm1');
    strictEqual(out.salary_remaining, 1);

    const ledger = JSON.parse(readFileSync(join(TEST_DIR, 'ledger.test3.json'), 'utf8'));
    strictEqual(ledger.dispatches.m1, 1);
    strictEqual(ledger.pool_used.pool_a, 1);
  });

  test('after salary_dispatches spends, pick moves to next model', () => {
    runEconomy(['spend', '--model', 'm1', '--mission', 'test4']);
    runEconomy(['spend', '--model', 'm1', '--mission', 'test4']);

    const res = runEconomy(['pick', '--role', 'deep', '--mission', 'test4']);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, 'm2');
  });

  test('choke adds to chokes and computes handover', () => {
    const res = runEconomy(['choke', '--model', 'm1', '--mission', 'test5', '--why', 'rate limited']);
    strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.handover_to, 'm2');

    const ledger = JSON.parse(readFileSync(join(TEST_DIR, 'ledger.test5.json'), 'utf8'));
    ok(ledger.chokes.includes('m1'));
    strictEqual(ledger.handovers.length, 1);
    strictEqual(ledger.handovers[0].from, 'm1');
    strictEqual(ledger.handovers[0].to, 'm2');
    strictEqual(ledger.handovers[0].why, 'rate limited');
  });

  test('choke skips choked/over-budget models in handover_to', () => {
    // Choke m1, then choke m2
    runEconomy(['choke', '--model', 'm1', '--mission', 'test6']);
    runEconomy(['choke', '--model', 'm2', '--mission', 'test6']);

    const res = runEconomy(['pick', '--role', 'deep', '--mission', 'test6']);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, 'm3');
  });

  test('pool cap makes models in that pool ineligible', () => {
    // Use up pool_b limit (5)
    for (let i = 0; i < 5; i++) {
      runEconomy(['spend', '--model', 'm3', '--mission', 'test7']);
    }

    const res = runEconomy(['pick', '--role', 'analysis', '--mission', 'test7']);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, 'm4');
    strictEqual(out.quota_pool, 'pool_inf');
  });

  test('spend with --model works directly', () => {
    const res = runEconomy(['spend', '--model', 'm4', '--mission', 'test8']);
    strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, 'm4');
    strictEqual(out.salary_remaining, 'inf');
  });

  test('status returns compact mission summary', () => {
    runEconomy(['spend', '--model', 'm1', '--mission', 'test9']);
    runEconomy(['spend', '--model', 'm3', '--mission', 'test9']);
    runEconomy(['choke', '--model', 'm2', '--mission', 'test9']);

    const res = runEconomy(['status', '--mission', 'test9']);
    strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.mission, 'test9');
    ok(out.lanes.some(l => l.pool === 'pool_a' && l.used === 1));
    ok(out.lanes.some(l => l.pool === 'pool_b' && l.used === 1));
    strictEqual(out.spent.m1, 1);
    strictEqual(out.spent.m3, 1);
    ok(out.chokes.includes('m2'));
  });

  test('DEAD tier models are never eligible', () => {
    const res = runEconomy(['pick', '--role', 'grind', '--mission', 'test10']);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, null);
  });

  test('choke with --pool adds all models from same quota_pool to chokes', () => {
    const res = runEconomy(['choke', '--model', 'm1', '--mission', 'test11', '--pool']);
    strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout.trim());
    // m2 is in m1's pool (pool_a) so --pool chokes it -> handover skips it -> m3 (pool_b)
    strictEqual(out.handover_to, 'm3');

    const ledger = JSON.parse(readFileSync(join(TEST_DIR, 'ledger.test11.json'), 'utf8'));
    ok(ledger.chokes.includes('m1'));
    ok(ledger.chokes.includes('m2'));
    ok(ledger.chokes.includes('m6')); // m6 also pool_a
    strictEqual(ledger.chokes.length, 3);
    strictEqual(ledger.handovers.length, 1);
    strictEqual(ledger.handovers[0].from, 'm1');
    strictEqual(ledger.handovers[0].to, 'm3');
  });

  test('infinite salary_dispatches never exhausts', () => {
    // Exhaust m3 first (salary 5)
    for (let i = 0; i < 5; i++) {
      runEconomy(['spend', '--model', 'm3', '--mission', 'test11']);
    }
    // Spend many times on m4 (infinite salary)
    for (let i = 0; i < 100; i++) {
      runEconomy(['spend', '--model', 'm4', '--mission', 'test11']);
    }
    const res = runEconomy(['pick', '--role', 'analysis', '--mission', 'test11']);
    const out = JSON.parse(res.stdout.trim());
    strictEqual(out.model, 'm4');
    strictEqual(out.salary_remaining, 'inf');
  });
});