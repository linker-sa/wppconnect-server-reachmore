/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Fork: our suites are *.spec.ts; upstream's are *.test.ts.
  testMatch: ['**/src/**/*.test.ts', '**/src/**/*.spec.ts'],
};
