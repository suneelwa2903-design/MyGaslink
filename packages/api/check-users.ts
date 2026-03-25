import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const users = await p.user.findMany({ select: { email: true, role: true, status: true, distributorId: true } });
console.log('=== USERS ===');
users.forEach(u => console.log(`  ${u.email} | ${u.role} | ${u.status} | dist: ${u.distributorId || 'none'}`));
const dists = await p.distributor.findMany({ select: { id: true, businessName: true, status: true, gstMode: true } });
console.log('\n=== DISTRIBUTORS ===');
dists.forEach(d => console.log(`  ${d.id} | ${d.businessName} | ${d.status} | GST: ${d.gstMode}`));
await p.$disconnect();
