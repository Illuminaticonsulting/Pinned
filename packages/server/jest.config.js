/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['src'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@pinned/shared-types$': '<rootDir>/../shared-types/src',
  },
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 40,
      functions: 50,
      lines: 55,
      statements: -250,
    },
  },
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
};
