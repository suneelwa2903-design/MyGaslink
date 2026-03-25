import { prisma } from '../lib/prisma.js';
import { afterAll } from 'vitest';

afterAll(async () => {
  await prisma.$disconnect();
});
