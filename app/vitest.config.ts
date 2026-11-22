// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';

// Unit tests only; e2e/ is Playwright's.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
