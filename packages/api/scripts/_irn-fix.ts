import { prisma } from '../src/lib/prisma.js';
const result = await prisma.$executeRaw`UPDATE invoices SET irn_status='success' WHERE invoice_number='INV-MPE5ZM628T4'`;
console.log('Rows updated:', result);
await prisma.$disconnect();
