# Backdated Order — Verification

_Run: 2026-06-25T04:36:12.908Z against http://localhost:5000, dist-002 (Sharma Gas Distributors)._

**Headline:** 15 PASS · 0 PARTIAL · 0 FAIL · 0 SKIP (of 15)

## Scenarios

### A: Order number uses structured allocator (OSHD<FY><6>)

- **Status:** PASS
- **Expected:** orderNumber matches /^O[A-Z]{3}\d{4}\d{6}$/ (e.g. OSHD2627000748)
- **Actual:** HTTP 201; orderNumber=OSHD2627000777

### B: Payment recorded atomically with invoice allocation

- **Status:** PASS
- **Expected:** 1 PaymentTransaction, 1 PaymentAllocation, invoice.amountPaid=500, outstanding=total−500
- **Actual:** HTTP 201; PaymentTransaction count=1; PaymentTransaction[0]: amount=500, method=cash, ref=null, status=fully_allocated; PaymentAllocation: invoiceId=f46934e6, amount=500; invoice.amountPaid=500, outstanding=1300, total=1800

### C: IRN auto-fires post-commit (no manual click)

- **Status:** PASS
- **Expected:** irnStatus != not_attempted; IRN_GENERATE log row exists
- **Actual:** irnStatus=success; IRN log present=true (httpStatus=200, code=null, msg=null)

### D: EWB auto-fires when vehicle provided

- **Status:** PASS
- **Expected:** EWB_GENERATE log row exists
- **Actual:** ewbStatus=active; EWB log present=true (apiType=EWB_GENERATE_BY_IRN, httpStatus=200, code=null)

### E: EWB skipped when no vehicle provided

- **Status:** PASS
- **Expected:** No EWB_GENERATE log row
- **Actual:** ewbStatus=not_attempted; EWB log present=false (should be false)

### F: B2C backdated — zero NIC calls

- **Status:** PASS
- **Expected:** gst_api_logs.length=0 (no IRN, no EWB)
- **Actual:** irnStatus=not_attempted; ewbStatus=not_attempted; gst_api_logs count=0; apiTypes=[]

### G: Invoice date backdated; number is today's FY sequence

- **Status:** PASS
- **Expected:** issueDate=backdated; number matches ISHD<FY><6>; createdAt=today; issueDate!=createdAt
- **Actual:** issueDate=2026-06-01, expected=2026-06-01; invoiceNumber=ISHD2627026216; createdAt=2026-06-25

### H: No inventory events written for backdated order

- **Status:** PASS
- **Expected:** inventory_events.count=0
- **Actual:** inventory_events count=0; events=[]

### I: Revenue timestamps are historical; createdAt is now

- **Status:** PASS
- **Expected:** deliveredAt=orderDate=issueDate; createdAt=today
- **Actual:** deliveredAt=2026-06-22 (want 2026-06-22); orderDate=2026-06-22 (want 2026-06-22); createdAt=2026-06-25 (want 2026-06-25)

### J: Same-month guard enforced

- **Status:** PASS
- **Expected:** HTTP 400 with "current calendar month"
- **Actual:** HTTP 400; body={"success":false,"data":null,"error":"Validation failed","code":"VALIDATION_ERROR","details":{"issueDate":["Backdated date must be within the current calendar month"]}}

### K: Today's date rejected

- **Status:** PASS
- **Expected:** HTTP 400 with "before today"
- **Actual:** HTTP 400; body={"success":false,"data":null,"error":"Validation failed","code":"VALIDATION_ERROR","details":{"issueDate":["Backdated date must be before today"]}}

### L: Finance role blocked from POST /orders/backdated

- **Status:** PASS
- **Expected:** HTTP 403
- **Actual:** HTTP 403; code=AUTHORIZATION_ERROR

### M: Multi-tenant: dist-002 admin cannot create for dist-001 customer

- **Status:** PASS
- **Expected:** HTTP 404 "Customer not found"
- **Actual:** HTTP 404; body={"success":false,"data":null,"error":"Customer not found"}

### N: GET /orders/:id surfaces isBackdated=true

- **Status:** PASS
- **Expected:** isBackdated=true, isGodownPickup=false
- **Actual:** GET /orders/:id HTTP 200; isBackdated=true; isGodownPickup=false

### O: Normal order regression: isBackdated=false, inventory events written

- **Status:** PASS
- **Expected:** isBackdated=false; inventory_events.count>0
- **Actual:** order.isBackdated=false; isGodownPickup=false; inventory_events count=2

## Summary

| Scenario | Status | Notes |
|---|---|---|
| A | PASS |  |
| B | PASS |  |
| C | PASS |  |
| D | PASS |  |
| E | PASS |  |
| F | PASS |  |
| G | PASS |  |
| H | PASS |  |
| I | PASS |  |
| J | PASS |  |
| K | PASS |  |
| L | PASS |  |
| M | PASS |  |
| N | PASS |  |
| O | PASS |  |

## ✅ ALL CLEAR — Brief 3 verified end-to-end.
