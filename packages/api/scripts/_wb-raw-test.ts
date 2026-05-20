import { prisma } from '../src/lib/prisma.js';
const cred = await prisma.gstCredential.findFirst({ where: { distributorId: 'dist-002', scope: 'einvoice' } });
console.log('clientId:', cred?.clientId);
console.log('email:', cred?.email);
const baseUrl = 'https://apisandbox.whitebooks.in';
const emailParam = encodeURIComponent(cred?.email || '');
const resp = await fetch(baseUrl + '/einvoice/authenticate?email=' + emailParam, {
  method: 'GET',
  headers: {
    username: cred?.username || '',
    password: cred?.password || '',
    ip_address: '127.0.0.1',
    client_id: cred?.clientId || '',
    client_secret: cred?.clientSecret || '',
    gstin: cred?.gstin || '',
    Accept: 'application/json',
  }
});
const json = await resp.json();
console.log('status_cd:', json.status_cd);
console.log('status_desc:', json.status_desc);
console.log('AuthToken (first 30):', json.data?.AuthToken?.substring(0,30));
console.log('TokenExpiry:', json.data?.TokenExpiry);
const nowIST = new Date(Date.now() + 5.5*3600000).toISOString().replace('T',' ').substring(0,19);
console.log('Now (IST):', nowIST);
await prisma.$disconnect();
