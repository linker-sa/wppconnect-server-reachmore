/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Fork: our suites are *.spec.ts; upstream's are *.test.ts.
  testMatch: ['**/src/**/*.test.ts', '**/src/**/*.spec.ts'],
  // The server refuses to run without a secret, so tests get one like a deploy does.
  setupFiles: ['<rootDir>/jest.setup.js'],
};
