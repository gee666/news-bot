import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConfiguration, testEnvironment } from './test-db.mjs';

test('database wrapper creates a separate URL without changing source configuration', () => {
  const file = { POSTGRES_PASSWORD: 'synthetic-password', POSTGRES_DB: 'newsbot', DB_PORT: '55432' };
  const result = databaseConfiguration(file, {});
  assert.equal(result.testUrl.pathname, '/newsbot_test');
  assert.equal(result.adminUrl.pathname, '/newsbot');
  assert.equal(result.testUrl.port, '55432');
  assert.equal(file.POSTGRES_DB, 'newsbot');
});

test('explicit private test URL needs no admin database creation', () => {
  const result = databaseConfiguration({}, { TEST_DATABASE_URL: 'postgresql://tester:synthetic@127.0.0.1/custom_test' });
  assert.equal(result.adminUrl, null);
  assert.equal(result.testUrl.pathname, '/custom_test');
});

test('database wrapper rejects production targets and SQL-unsafe names', () => {
  assert.throws(() => databaseConfiguration({ POSTGRES_PASSWORD: 'synthetic' }, { DB_TEST_NAME: 'newsbot' }));
  assert.throws(() => databaseConfiguration({ POSTGRES_PASSWORD: 'synthetic' }, { DB_TEST_NAME: 'bad;name' }));
  assert.throws(() => databaseConfiguration({}, { TEST_DATABASE_URL: 'postgresql://localhost/newsbot' }));
  assert.throws(() => databaseConfiguration({ POSTGRES_PASSWORD: 'synthetic', DB_PORT: '0' }, {}));
});

test('test children receive only database configuration and basic process environment', () => {
  const url = new URL('postgresql://tester:synthetic@127.0.0.1/test_database');
  const env = testEnvironment(url, { PATH: '/bin', TELEGRAM_BOT_TOKEN: 'synthetic',
    JEV_API_KEY: 'synthetic', PI_AUTH_PATH: '/private/auth.json', NODE_OPTIONS: '--import malicious',
    ALLOW_PRIVATE_INFERENCE: 'true', DATABASE_URL: 'unrelated' });
  assert.equal(env.DATABASE_URL, url.toString());
  assert.equal(env.TEST_DATABASE_URL, url.toString());
  assert.equal(env.PATH, '/bin');
  assert.equal(Object.keys(env).length, 3);
});
