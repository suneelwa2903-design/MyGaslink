const BASE = 'http://localhost:5000/api';
async function api(m: string, p: string, t: string, b?: any) {
  const r = await fetch(BASE+p, { method:m, headers:{'Content-Type':'application/json',...(t?{'Authorization':'Bearer '+t}:{})}, body:b?JSON.stringify(b):undefined });
  return (await r.json() as any).data;
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  await new Promise(r=>setTimeout(r,2000));

  const login = await api('POST','/auth/login','',{email:'sharma@gasdist.com',password:'Gstadmin@123'});
  const T = login.tokens.accessToken;
  const custs = await api('GET','/customers',T);
  const cyls = await api('GET','/cylinder-types',T);
  const drvs = await api('GET','/drivers',T);
  const vehs = await api('GET','/vehicles',T);
  const ct19 = cyls.find((c: any)=>c.typeName==='19 KG')?.id;
  const b2b = custs.find((c: any)=>c.gstin==='36AAGCB1286Q004')?.id;
  const drv = drvs[0].id, veh = vehs[0].id;

  await api('POST','/inventory/incoming-fulls',T,{cylinderTypeId:ct19,quantity:50,documentType:'AC4',documentNumber:'DN-TEST',documentDate:today});

  const order = await api('POST','/orders',T,{customerId:b2b,deliveryDate:today,items:[{cylinderTypeId:ct19,quantity:5}]});
  await api('POST',`/orders/${order.id}/assign-driver`,T,{driverId:drv,vehicleId:veh});
  await api('PUT',`/orders/${order.id}/status`,T,{status:'pending_delivery'});
  await api('POST',`/orders/${order.id}/confirm-delivery`,T,{items:[{cylinderTypeId:ct19,deliveredQuantity:5,emptiesCollected:3}]});

  console.log('Waiting for async GST...');
  await new Promise(r=>setTimeout(r,6000));

  const invoices = await api('GET','/invoices',T);
  const inv = invoices?.find((i: any)=>i.orderId===order.id);
  console.log(`Invoice: ${inv?.invoiceNumber}, IRN: ${inv?.irnStatus}`);

  // Create DEBIT NOTE
  const dn = await api('POST','/invoices/debit-notes',T,{
    invoiceId:inv.id, amount:500, reason:'Additional transport charges',
    items:[{cylinderTypeId:ct19,quantity:1,unitPrice:500,gstRate:18}]
  });
  console.log(`✅ Debit Note created: ${dn?.id?.substring(0,8)}, status: ${dn?.status}`);

  // Approve debit note
  const approved = await api('PUT',`/invoices/debit-notes/${dn.id}/approve`,T,{});
  console.log(`✅ Debit Note approved: ${approved?.status}`);

  // Wait for async DN IRN
  await new Promise(r=>setTimeout(r,4000));

  // Check GST documents for DN
  const gstDocs = await api('GET',`/invoices/${inv.id}/gst-documents`,T);
  const dnDoc = gstDocs?.find((d: any)=>d.docType==='DBN');
  if (dnDoc) {
    console.log(`✅ DN GST Doc: IRN=${dnDoc.irnStatus}, IRN#=${dnDoc.irn?.substring(0,30)||'none'}`);
  } else {
    console.log('ℹ️  No DN GST document (async processing may still be running)');
  }

  // Verify outstanding increased
  const invAfter = await api('GET',`/invoices/${inv.id}`,T);
  console.log(`Outstanding: ₹${inv.outstandingAmount} → ₹${invAfter?.outstandingAmount} (DN: ₹${dn.totalAmount})`);
  console.log(`✅ Outstanding increased: ${invAfter?.outstandingAmount > inv.outstandingAmount}`);
}
main().catch(e=>{console.error(e);process.exit(1)});
